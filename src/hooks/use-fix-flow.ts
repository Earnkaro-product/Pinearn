import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { HEALTH_SCORE_QUERY_KEY, useHealthScore, type HealthData } from "./use-health-score";
import { saveLastSeenScore, type SubScoreKey } from "@/lib/health-score";

// One editable field on a fix card (title/description/board name…), carrying
// the SEO band so the edit sheet can show a live in-range counter.
export type FixField = {
  key: string;
  label: string;
  value: string; // starts at the suggested rewrite; user may edit
  min?: number;
  max?: number;
  multiline?: boolean;
};

export type BaseFixCard = {
  id: string;
  title: string; // short label for the review list + a11y
  issues: string[];
  fields: FixField[];
  // Pre-fix values, keyed the same as fields — used to revert.
  original: Record<string, string | null>;
};

type FixValues = Record<string, string | null>;

export type SwipeDecision = "approved" | "skipped";

/**
 * The shared engine behind both Boost fix flows. Owns the single cursor the
 * deck renders, optimistic apply/revert against the health-score cache
 * (so the live score reacts instantly), inline edits, bulk approve, and
 * per-item + bulk undo. Live pins/boards are written to Supabase, so every
 * apply is individually reversible for the whole session — nothing here ships
 * irreversibly.
 */
export function useFixFlow<C extends BaseFixCard>(opts: {
  scoreKey: SubScoreKey;
  buildDeck: (data: HealthData) => C[];
  // Persist the given field values for one row (Supabase update).
  persist: (id: string, values: FixValues) => Promise<{ error: unknown }>;
  // Optimistically patch the health-score cache so the score moves live.
  applyToCache: (data: HealthData, id: string, values: FixValues) => HealthData;
  // Extra query keys to invalidate on exit (other surfaces showing this data).
  invalidateKeys: ReadonlyArray<ReadonlyArray<unknown>>;
  // Side effects that must happen once per SUCCESSFUL apply / revert, and never
  // on the other one. `persist` can't carry them: revertFix writes through the
  // same persist call with the original values, so a debit placed there would
  // charge again for an undo. Both are awaited but must not throw — a failed
  // side effect leaves the row written.
  onApplied?: (id: string) => void | Promise<void>;
  onReverted?: (id: string) => void | Promise<void>;
}) {
  const qc = useQueryClient();
  const { data, report, isLoading } = useHealthScore();

  // Frozen on first load — later cache patches update the live score but must
  // never reshuffle the deck out from under the cursor.
  const [deck, setDeck] = useState<C[] | null>(null);
  // The deck as first built, kept whole so a focused run (see focusDeck) can be
  // widened back out without rebuilding from data the flow has since patched.
  const fullDeckRef = useRef<C[] | null>(null);
  useEffect(() => {
    if (deck !== null || !data) return;
    const built = opts.buildDeck(data);
    fullDeckRef.current = built;
    setDeck(built);
    // Build once; opts is recreated each render but buildDeck is pure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, deck]);

  const [index, setIndex] = useState(0);
  const [statusById, setStatusById] = useState<Record<string, SwipeDecision>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [bulkApplying, setBulkApplying] = useState(false);
  // Original values of every currently-applied row, for undo. A ref (not state)
  // because it's write-through; re-renders are driven by the status/pending
  // state changes that accompany every mutation.
  const appliedRef = useRef<Map<string, FixValues>>(new Map());
  // Bumped on every apply/revert so derived "applied cards" recomputes.
  const [rev, setRev] = useState(0);

  // Stash the score the user walked in with — the dashboard climbs from the
  // overall; the done screen shows the gain in THIS sub-score.
  const baselineSaved = useRef(false);
  const startScoreRef = useRef(0);
  useEffect(() => {
    if (report && !baselineSaved.current) {
      baselineSaved.current = true;
      saveLastSeenScore(report.overall);
      startScoreRef.current = report.subScores.find((s) => s.key === opts.scoreKey)?.score ?? 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  // On exit, reconcile the optimistic cache with the truth.
  useEffect(() => {
    return () => {
      void qc.invalidateQueries({ queryKey: HEALTH_SCORE_QUERY_KEY });
      for (const key of opts.invalidateKeys)
        void qc.invalidateQueries({ queryKey: key as unknown[] });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards = deck ?? [];
  const total = cards.length;
  const done = deck !== null && total > 0 && index >= total;
  const approvedCount = cards.filter((c) => statusById[c.id] === "approved").length;
  const skippedCount = cards.filter((c) => statusById[c.id] === "skipped").length;
  const score = report?.subScores.find((s) => s.key === opts.scoreKey)?.score ?? 0;
  const current = cards[index] ?? null;

  const valuesOf = (card: C): FixValues =>
    Object.fromEntries(card.fields.map((f) => [f.key, f.value]));

  const patch = (id: string, values: FixValues) =>
    qc.setQueryData<HealthData>(HEALTH_SCORE_QUERY_KEY, (prev) =>
      prev ? opts.applyToCache(prev, id, values) : prev,
    );

  const applyFix = async (card: C) => {
    appliedRef.current.set(card.id, card.original);
    setRev((r) => r + 1);
    patch(card.id, valuesOf(card));
    setPendingIds((s) => new Set(s).add(card.id));
    const { error } = await opts.persist(card.id, valuesOf(card));
    setPendingIds((s) => {
      const n = new Set(s);
      n.delete(card.id);
      return n;
    });
    if (error) {
      // Roll back the optimistic patch and genuinely return the card to the
      // queue: rewind the cursor to its slot so it's re-presented (the cursor
      // had already advanced past it), and clear its decision.
      patch(card.id, card.original);
      appliedRef.current.delete(card.id);
      setRev((r) => r + 1);
      setStatusById((prev) => {
        const n = { ...prev };
        delete n[card.id];
        return n;
      });
      const slot = cards.findIndex((c) => c.id === card.id);
      if (slot >= 0) setIndex((i) => Math.min(i, slot));
      notifyProblem("Couldn't save that change — it's back in the queue");
      return;
    }
    await opts.onApplied?.(card.id);
  };

  const revertFix = async (card: C) => {
    const original = appliedRef.current.get(card.id);
    if (!original) return;
    appliedRef.current.delete(card.id);
    setRev((r) => r + 1);
    patch(card.id, original);
    const { error } = await opts.persist(card.id, original);
    if (error) {
      notifyProblem("Couldn't undo that change");
      return;
    }
    await opts.onReverted?.(card.id);
  };

  const decide = (card: C, decision: SwipeDecision) => {
    setStatusById((prev) => ({ ...prev, [card.id]: decision }));
    setIndex((i) => i + 1);
    if (decision === "approved") void applyFix(card);
  };

  // Move the cursor to any card without deciding it — powers a filmstrip
  // navigator where you can revisit pins. Decisions already made persist in
  // statusById, so a revisited pin can be re-applied/skipped from where it is.
  const goTo = (i: number) => {
    if (total === 0) return;
    setIndex(Math.min(Math.max(i, 0), total - 1));
  };

  const undo = () => {
    if (index === 0) return;
    const prev = cards[index - 1];
    // Don't undo a card whose apply is still in flight — the revert write
    // would race the apply write on the same row (order isn't guaranteed) and
    // could leave the "undone" change saved. It becomes undoable the instant
    // the apply settles.
    if (pendingIds.has(prev.id)) return;
    setIndex((i) => Math.max(0, i - 1));
    const dec = statusById[prev.id];
    setStatusById((s) => {
      const n = { ...s };
      delete n[prev.id];
      return n;
    });
    if (dec === "approved") void revertFix(prev);
  };

  /** Replace field values on any card in the deck, by id. Used both by the
   * edit sheet and by flows that fill a card in asynchronously (e.g. an AI
   * rewrite arriving after the deck has already rendered). Cards that have
   * already been applied are left alone — their value is what got written to
   * the database, and silently changing it would desync the undo snapshot. */
  const patchCard = (id: string, values: Record<string, string>) => {
    if (appliedRef.current.has(id)) return;
    const patchList = (list: C[]) =>
      list.map((c) =>
        c.id === id
          ? {
              ...c,
              fields: c.fields.map((f) => (f.key in values ? { ...f, value: values[f.key] } : f)),
            }
          : c,
      );
    // Both copies, or copy that arrived during a focused run would be lost the
    // moment the deck is widened again.
    if (fullDeckRef.current) fullDeckRef.current = patchList(fullDeckRef.current);
    setDeck((d) => (d ? patchList(d) : d));
  };

  /** Narrow the run to `ids`, in the order given — for a picker where the
   * creator chooses which items this pass covers. `null` restores the full
   * deck. Decisions already made are keyed by id, so they survive both ways. */
  const focusDeck = (ids: string[] | null) => {
    const full = fullDeckRef.current;
    if (!full) return;
    if (ids === null) {
      setDeck(full);
      setIndex(0);
      return;
    }
    const order = new Map(ids.map((id, i) => [id, i]));
    const next = full
      .filter((c) => order.has(c.id))
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    if (next.length === 0) return;
    setDeck(next);
    setIndex(0);
  };

  const editCurrent = (values: Record<string, string>) => {
    if (current) patchCard(current.id, values);
  };

  /** Apply every remaining card. `canApply` lets a flow exclude cards that have
   * nothing to write yet — e.g. an AI rewrite that failed to generate. Excluded
   * cards are marked skipped, not left undecided, so the deck still completes
   * and the approved/skipped counts add up to the total. */
  const approveAll = async (canApply?: (card: C) => boolean) => {
    const remaining = cards.slice(index);
    if (remaining.length === 0 || bulkApplying) return;
    const targets = canApply ? remaining.filter(canApply) : remaining;
    setBulkApplying(true);
    setStatusById((prev) => {
      const n = { ...prev };
      for (const c of remaining) n[c.id] = "skipped";
      for (const c of targets) n[c.id] = "approved";
      return n;
    });
    setIndex(total);
    await Promise.all(targets.map((c) => applyFix(c)));
    setBulkApplying(false);
  };

  const undoAll = async () => {
    const applied = cards.filter((c) => appliedRef.current.has(c.id));
    setStatusById({});
    // Stay on the done screen (done is derived from index >= total) — resetting
    // the cursor to 0 would eject the user back into the deck mid-celebration.
    await Promise.all(applied.map((c) => revertFix(c)));
    notifyDone("All changes reverted");
  };

  const revertOne = async (card: C) => {
    await revertFix(card);
    setStatusById((s) => {
      const n = { ...s };
      delete n[card.id];
      return n;
    });
  };

  // Cards still applied (recomputed whenever rev changes) — the done-screen
  // review list.
  void rev;
  const appliedCards = cards.filter((c) => appliedRef.current.has(c.id));

  return {
    data,
    report,
    isLoading,
    deck,
    cards,
    index,
    total,
    done,
    current,
    approvedCount,
    skippedCount,
    score,
    gained: Math.max(0, score - startScoreRef.current),
    statusById,
    pendingIds,
    bulkApplying,
    remainingCount: Math.max(0, total - index),
    canUndo: index > 0,
    appliedCards,
    decide,
    goTo,
    focusDeck,
    undo,
    editCurrent,
    patchCard,
    approveAll,
    undoAll,
    revertOne,
  };
}
