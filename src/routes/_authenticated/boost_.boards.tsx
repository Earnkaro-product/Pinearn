import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCheck,
  Eye,
  LayoutGrid,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import {
  FilterChipRow,
  LaunchScreen,
  PickerHeader,
  QueueToolbar,
  ReviewProgressHeader,
  SelectDot,
  SelectionBar,
} from "@/components/boost-picker-kit";
import { useLongPress } from "@/hooks/use-long-press";
import { metricLabel } from "@/lib/boost-picker";
import {
  ApproveAllSheet,
  DeckSkeleton,
  DoneState,
  FieldDiff,
  FixEditSheet,
  GeneratingNotice,
  GuideSheet,
  IssueChips,
  KeywordProof,
  OptimizedState,
} from "@/components/boost-fix-kit";
import { supabase } from "@/integrations/supabase/client";
import { useFixFlow, type BaseFixCard } from "@/hooks/use-fix-flow";
import { useAiRewrites, type AiRewriteState } from "@/hooks/use-ai-rewrites";
import { suggestBoardSeo, type SuggestBoardSeoResult } from "@/lib/board-seo.functions";
import { BOARD_DESC_MAX, BOARD_DESC_MIN, BOARD_NAME_MAX, BOARD_NAME_MIN } from "@/lib/board-seo";
import type { HealthData } from "@/hooks/use-health-score";
import {
  boardIdOf,
  boardIssues,
  byIssueCountDesc,
  maxPointsFor,
  pointsEarned,
  pointsLabel,
  SCORE_CRITERIA,
  SUB_SCORE_WEIGHTS,
} from "@/lib/health-score";

// How to drive the deck — surfaced any time via the header's info button. One
// action per step; the controls are on screen while this is read.
const BOARD_GUIDE_STEPS = [
  "Tap boards to queue them, then Boost.",
  "Hold a board to see what it's worth.",
  "Apply keeps the rewrite, Skip moves on.",
  "Edit the wording, or undo, anytime.",
];

// Filmstrip sizing — mirrors the pin review navigator so the two flows feel
// like one product.
const NAV_SLOT = 72;
const NAV_VISIBLE = 4;

// The picker reveals a page of boards at a time — same reasoning as the pin
// grid, and the Suggested rail stays short because it's a shortcut, not
// another backlog.
const SUGGESTED_BOARDS_COUNT = 8;
const BOARD_GRID_PAGE_SIZE = 12;

export const Route = createFileRoute("/_authenticated/boost_/boards")({
  component: FixBoardsPage,
});

type BoardFixCard = BaseFixCard & {
  covers: string[];
  pinCount: number;
  // Reach of everything on the board — the picker ranks by it, so a messy
  // board that people actually see outranks a messy board nobody lands on.
  impressions: number;
};

/** A card is applyable only once every field holds real copy. Cards start
 * empty and are filled by the pipeline, so this is the single gate that keeps
 * a blank board name from ever reaching the database. */
function hasCopy(card: BaseFixCard): boolean {
  return card.fields.every((f) => f.value.trim().length > 0);
}

/**
 * Cards start with EMPTY copy and are filled by the real pipeline as each board
 * returns.
 *
 * An earlier deck pre-filled these from a local heuristic that returned the
 * board's CURRENT name unchanged whenever that name wasn't a recognized
 * placeholder. On a board called "Pin collection" — not a placeholder by those
 * patterns, just useless — the card cheerfully offered "Pin collection" as the
 * suggested improvement. Starting empty makes that class of no-op impossible to
 * render, and validateBoardSuggestion rejects a rename that merely echoes the
 * current name.
 */
function buildDeck(data: HealthData): BoardFixCard[] {
  // Group pins by the board they actually belong to. boardIdOf() follows a
  // live pin back through origin_collection_id — matching on collection_id
  // alone left every board whose pins had gone live looking empty, which is
  // why board thumbnails were blank.
  const pinsByBoard = new Map<string, typeof data.pins>();
  for (const p of data.pins) {
    const boardId = boardIdOf(p);
    if (!boardId) continue;
    const list = pinsByBoard.get(boardId);
    if (list) list.push(p);
    else pinsByBoard.set(boardId, [p]);
  }

  // ONLY the failing boards — same reasoning as the pin deck: a board that
  // already passes has no points to give, so it isn't on this screen.
  return byIssueCountDesc(
    data.boards.filter((b) => boardIssues(b).length > 0),
    boardIssues,
  ).map((b) => {
    const boardPins = pinsByBoard.get(b.id) ?? [];
    return {
      id: b.id,
      title: b.name?.trim() || "Unnamed board",
      issues: boardIssues(b),
      pinCount: boardPins.length,
      impressions: boardPins.reduce((sum, p) => sum + (p.impressions ?? 0), 0),
      // The board's own cover leads when it has one — that's the image the
      // creator (or Pinterest) chose to represent it.
      covers: [
        ...(b.cover_image_url ? [b.cover_image_url] : []),
        ...boardPins.map((p) => p.image_url).filter((u): u is string => !!u),
      ]
        .filter((u, i, a) => a.indexOf(u) === i)
        .slice(0, 4),
      fields: [
        { key: "name", label: "Board name", value: "", min: BOARD_NAME_MIN, max: BOARD_NAME_MAX },
        {
          key: "description",
          label: "Description",
          value: "",
          min: BOARD_DESC_MIN,
          max: BOARD_DESC_MAX,
          multiline: true,
        },
      ],
      original: { name: b.name, description: b.description },
    };
  });
}

function FixBoardsPage() {
  const navigate = useNavigate();
  const flow = useFixFlow<BoardFixCard>({
    scoreKey: "boardStructure",
    buildDeck,
    persist: async (id, values) => {
      // values is a dynamic {name, description} map — cast past the generated
      // row type's excess-property check (keys are ours, not user input).
      const { error } = await supabase
        .from("collections")
        .update(values as never)
        .eq("id", id);
      return { error };
    },
    applyToCache: (data, id, values) => ({
      ...data,
      boards: data.boards.map((b) => (b.id === id ? { ...b, ...values } : b)),
    }),
    invalidateKeys: [["dashboard-boards-collections"], ["collections"]],
  });

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [guide, setGuide] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const [mode, setMode] = useState<"picker" | "launching" | "review">("picker");
  const [launchCard, setLaunchCard] = useState<BoardFixCard | null>(null);
  const [runSize, setRunSize] = useState(0);

  // Stable across renders so the rewrite scheduler doesn't re-evaluate its
  // fetch window on every keystroke — the deck itself is frozen after build.
  // The picker is intentionally API-quiet: generation starts only once the
  // creator has chosen boards and entered the work surface.
  const boardIds = useMemo(
    () => (mode === "review" ? (flow.deck?.map((c) => c.id) ?? null) : null),
    [flow.deck, mode],
  );
  const patchCard = flow.patchCard;
  const runSuggest = useServerFn(suggestBoardSeo);
  const ai = useAiRewrites<SuggestBoardSeoResult>({
    ids: boardIds,
    index: flow.index,
    generate: useCallback((boardId) => runSuggest({ data: { boardId } }), [runSuggest]),
    onResult: useCallback(
      (boardId, result) =>
        patchCard(boardId, { name: result.name, description: result.description }),
      [patchCard],
    ),
  });

  const backToScore = () => navigate({ to: "/boost" });
  const paused = editing || confirming;
  const remaining = flow.cards.slice(flow.index);
  const current = flow.current;
  const currentPending = !!current && flow.pendingIds.has(current.id);

  const currentAi: AiRewriteState<SuggestBoardSeoResult> | undefined = current
    ? ai.byId[current.id]
    : undefined;
  const currentGenerating = !!current && (!currentAi || currentAi.status === "loading");
  const currentReady = !!current && hasCopy(current);

  // Bulk approve must not write empty names, so generate everything first.
  // flowRef keeps us on the LATEST approveAll — the one captured at click time
  // closes over a pre-generation deck.
  const [preparingBulk, setPreparingBulk] = useState(false);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const bulkReady = ai.settledCount(remaining.map((c) => c.id));

  const approveAllWithAi = async () => {
    const ids = flowRef.current.cards.slice(flowRef.current.index).map((c) => c.id);
    setPreparingBulk(true);
    await ai.ensure(ids);
    setPreparingBulk(false);
    await flowRef.current.approveAll(hasCopy);
  };

  // Start a run over exactly the boards the creator queued, in the order they
  // were ranked. The deck is narrowed to that set, so the filmstrip, the
  // progress bar, "approve all remaining" and the rewrite generation all cover
  // the chosen boards and nothing else.
  const launchTimer = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(launchTimer.current ?? undefined), []);

  const startRun = (ids: string[]) => {
    if (ids.length === 0) return;
    setRunSize(ids.length);
    setLaunchCard(flow.cards.find((c) => c.id === ids[0]) ?? null);
    flow.focusDeck(ids);
    setMode("launching");
    launchTimer.current = window.setTimeout(() => {
      setMode("review");
      setLaunchCard(null);
    }, 1150);
  };

  // Back out of a run to re-pick. Decisions already made are keyed by board id,
  // so anything applied stays applied and shows as done when it reappears.
  const backToPicker = () => {
    window.clearTimeout(launchTimer.current ?? undefined);
    flow.focusDeck(null);
    setLaunchCard(null);
    setMode("picker");
  };

  const reviewing =
    mode === "review" &&
    !flow.isLoading &&
    flow.deck !== null &&
    flow.deck.length > 0 &&
    !flow.done;

  // Keyboard parity with the pin deck: → apply, ← skip, ⌘/Ctrl+Z undo.
  useEffect(() => {
    if (!reviewing) return;
    const handler = (e: KeyboardEvent) => {
      if (paused) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (flow.canUndo) flow.undo();
        return;
      }
      if (!current) return;
      if (e.key === "ArrowRight" && !currentPending && currentReady)
        flow.decide(current, "approved");
      else if (e.key === "ArrowLeft") flow.decide(current, "skipped");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewing, paused, current, currentPending, currentReady, flow.canUndo]);

  return (
    <AppShell
      title="Board Boost"
      backButton
      backTo="/boost"
      // Mid-run, back means "back to the queue", not "leave Boost" — the run is
      // a sub-view of the picker, so it shouldn't cost the whole page to exit.
      onBack={mode !== "picker" && !flow.done ? backToPicker : undefined}
      hideBottomNav
    >
      <div className="mx-auto flex h-[calc(100dvh-6.5rem)] max-w-md flex-col px-1">
        {flow.isLoading || flow.deck === null ? (
          <DeckSkeleton />
        ) : flow.deck.length === 0 ? (
          <OptimizedState onBack={backToScore} unitLabel="boards" />
        ) : flow.done ? (
          <DoneState
            scoreLabel="Board SEO"
            points={pointsEarned("boardStructure", flow.score)}
            maxPoints={maxPointsFor("boardStructure")}
            gained={pointsEarned("boardStructure", flow.gained)}
            approvedCount={flow.approvedCount}
            skippedCount={flow.skippedCount}
            appliedCards={flow.appliedCards}
            onRevertOne={(c) => flow.revertOne(c as BoardFixCard)}
            onUndoAll={flow.undoAll}
            onBack={backToScore}
            busy={flow.bulkApplying || flow.pendingIds.size > 0}
          />
        ) : mode === "picker" ? (
          <BoardBoostPicker
            cards={flow.cards}
            totalBoards={flow.data?.boards.length ?? flow.cards.length}
            score={flow.score}
            statusById={flow.statusById}
            onStart={startRun}
            onGuide={() => setGuide(true)}
          />
        ) : mode === "launching" ? (
          <BoardLaunch card={launchCard ?? flow.current ?? flow.cards[0]} count={runSize} />
        ) : (
          <>
            {/* One compact status bar: live score, position in the run, a
                segmented progress track, and the applied/skipped split. */}
            <ReviewProgressHeader
              label="Board SEO"
              points={pointsEarned("boardStructure", flow.score)}
              maxPoints={maxPointsFor("boardStructure")}
              index={flow.index}
              total={flow.total}
              approvedCount={flow.approvedCount}
              skippedCount={flow.skippedCount}
              onGuide={() => setGuide(true)}
            />

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="relative z-20 shrink-0 rounded-t-3xl bg-surface-2 px-4 pb-1.5 pt-4">
                <BoardFilmstrip
                  cards={flow.cards}
                  currentIndex={flow.index}
                  statusById={flow.statusById}
                  pendingIds={flow.pendingIds}
                  onJump={flow.goTo}
                  onOpenGrid={() => setGridOpen(true)}
                />
              </div>

              {/* Scrolls with its bar hidden, so the fade over the last few
                  pixels is the only signal that there's more below the fold —
                  same as the pin deck. */}
              <div className="relative z-10 min-h-0 flex-1">
                <div className="no-scrollbar h-full overflow-y-auto rounded-3xl border-2 border-primary bg-surface p-4 shadow-sm">
                  {current && (
                    <BoardRewriteCard
                      card={current}
                      ai={currentAi}
                      onEdit={() => setEditing(true)}
                      onRegenerate={() => ai.regenerate(current.id)}
                    />
                  )}
                </div>
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-[3px] bottom-[3px] h-7 rounded-b-[1.4rem] bg-gradient-to-t from-surface via-surface/85 to-transparent"
                />
              </div>
            </div>

            <div className="shrink-0 space-y-2.5 pt-3">
              <div className="flex items-stretch gap-2.5">
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={() => current && flow.decide(current, "skipped")}
                  disabled={!current || paused}
                  aria-label="Skip this board"
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-2xl border-2 border-border bg-surface px-5 py-3.5 text-sm font-bold text-muted-foreground transition hover:text-foreground disabled:opacity-40"
                >
                  <X className="h-4 w-4" strokeWidth={2.5} /> Skip
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={() => current && flow.decide(current, "approved")}
                  disabled={!current || currentPending || !currentReady || paused}
                  aria-label="Apply fix"
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-4 py-3.5 text-lead font-extrabold text-primary-foreground shadow-glow transition disabled:opacity-60"
                >
                  {currentPending || currentGenerating ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Check className="h-5 w-5" strokeWidth={3} />
                  )}
                  {currentGenerating ? "Writing…" : "Apply"}
                </motion.button>
              </div>

              {/* "Apply all 1" is the Apply button with a confirm
                  sheet in front of the same single write — the bulk path only
                  earns its row once there's more than one left. */}
              {remaining.length > 1 && (
                <motion.button
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setConfirming(true)}
                  disabled={flow.bulkApplying || preparingBulk || remaining.length === 0}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-primary bg-surface px-3 py-3 text-body font-bold text-primary transition disabled:opacity-40"
                >
                  {preparingBulk ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Writing {bulkReady}/
                      {remaining.length}
                    </>
                  ) : (
                    <>
                      <CheckCheck className="h-4 w-4" /> Apply all {remaining.length}
                    </>
                  )}
                </motion.button>
              )}
            </div>
          </>
        )}
      </div>

      <AnimatePresence>
        {editing && flow.current && (
          <FixEditSheet
            fields={flow.current.fields}
            onSave={flow.editCurrent}
            onClose={() => setEditing(false)}
          />
        )}
        {confirming && (
          <ApproveAllSheet
            cards={remaining}
            unitLabel="boards"
            onConfirm={approveAllWithAi}
            onCancel={() => setConfirming(false)}
          />
        )}
        {guide && (
          <GuideSheet
            title="What makes a good board"
            criteria={SCORE_CRITERIA.boardStructure}
            steps={BOARD_GUIDE_STEPS}
            onClose={() => setGuide(false)}
          />
        )}
        {gridOpen && (
          <BoardGridSheet
            cards={flow.cards}
            currentIndex={flow.index}
            statusById={flow.statusById}
            pendingIds={flow.pendingIds}
            onJump={flow.goTo}
            onClose={() => setGridOpen(false)}
          />
        )}
      </AnimatePresence>
    </AppShell>
  );
}

/* ---------------- Board cover ---------------- */

/** A board rendered as a Pinterest-style cover collage — one large pin plus two
 * stacked — so a board thumbnail reads as a board and not as a single pin.
 * `flat` drops the rounding for use inside an already-rounded tab. */
function BoardCover({
  covers,
  className = "",
  flat = false,
}: {
  covers: string[];
  className?: string;
  flat?: boolean;
}) {
  const [big, ...rest] = covers;
  const radius = flat ? "" : "rounded-2xl";
  return (
    <div
      className={`flex h-full w-full gap-px overflow-hidden ${radius} bg-surface-2 ${className}`}
    >
      <div className="relative flex-[2] bg-surface-2">
        {big ? (
          <img src={big} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-muted-foreground">
            <LayoutGrid className="h-4 w-4" />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-px">
        {[0, 1].map((i) => (
          <div key={i} className="relative flex-1 bg-surface-2">
            {rest[i] && (
              <img src={rest[i]} alt="" draggable={false} className="h-full w-full object-cover" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The picker — where a run gets built.
 *
 * Same interaction model as the pin picker: tap a board to queue it, hold it
 * to flip it over and see what it's worth, then launch from the bottom bar.
 * The screen stays almost wordless; the CTA carries the instruction.
 * ------------------------------------------------------------------ */

// Fixing one failing board moves Board SEO by 1/total of its 100 points,
// and Board SEO is worth SUB_SCORE_WEIGHTS.boardStructure of the overall
// score. A board that already passes is worth zero points — its rewrite is a
// keyword play, not a score play, and the flip side says exactly that instead
// of inventing a number.
// `totalBoards` is ALL boards on the account, not just the failing subset on
// this screen — the pass rate is measured against everything.
function overallPointsFor(failingCount: number, totalBoards: number): number {
  if (totalBoards === 0) return 0;
  return SUB_SCORE_WEIGHTS.boardStructure * (failingCount / totalBoards) * 100;
}

/** Worst first, reach as the tie-breaker: a board with a generic name and no
 * description outranks a merely nameless one, and between two equally messy
 * boards the one people actually see comes first. */
function boardOpportunityScore(card: BoardFixCard): number {
  const issueWeight = Math.max(1, card.issues.length) * 100_000;
  return issueWeight + card.impressions * 2 + card.pinCount * 50;
}

type SortKey = "opportunity" | "impressions" | "pins" | "fixes" | "name";

const SORT_OPTIONS: {
  key: SortKey;
  label: string;
  compare: (a: BoardFixCard, b: BoardFixCard) => number;
}[] = [
  {
    key: "opportunity",
    label: "Biggest win",
    compare: (a, b) => boardOpportunityScore(b) - boardOpportunityScore(a),
  },
  {
    key: "impressions",
    label: "Most impressions",
    compare: (a, b) => b.impressions - a.impressions,
  },
  { key: "pins", label: "Most pins", compare: (a, b) => b.pinCount - a.pinCount },
  { key: "fixes", label: "Most to fix", compare: (a, b) => b.issues.length - a.issues.length },
  { key: "name", label: "A–Z", compare: (a, b) => a.title.localeCompare(b.title) },
];

/** Lenses over the grid — "the ones with no description", "the ones already
 * getting traffic" — one tap instead of scrolling the whole library. Counts
 * live on the chips so an empty bucket is obvious before it's tapped. */
type QueueFilter = "all" | "name" | "description" | "traffic";

const QUEUE_FILTERS: { key: QueueFilter; label: string; match: (c: BoardFixCard) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "name", label: "Generic name", match: (c) => c.issues.some((i) => /name/i.test(i)) },
  {
    key: "description",
    label: "No description",
    match: (c) => c.issues.some((i) => /description/i.test(i)),
  },
  { key: "traffic", label: "Getting traffic", match: (c) => c.impressions > 0 },
];

function BoardBoostPicker({
  cards,
  totalBoards,
  score,
  statusById,
  onStart,
  onGuide,
}: {
  cards: BoardFixCard[];
  /** Every board on the account — the denominator the pass rate is scored on.
   * `cards` is only the failing subset. */
  totalBoards: number;
  score: number;
  statusById: Record<string, "approved" | "skipped">;
  onStart: (ids: string[]) => void;
  onGuide: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [flippedId, setFlippedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("opportunity");
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(BOARD_GRID_PAGE_SIZE);

  // Ranked once — the run order for everything on this screen, so "biggest
  // win first" holds whether the creator queued the rail, a lens, or the lot.
  const ranked = useMemo(
    () => [...cards].sort((a, b) => boardOpportunityScore(b) - boardOpportunityScore(a)),
    [cards],
  );
  const suggested = useMemo(() => ranked.slice(0, SUGGESTED_BOARDS_COUNT), [ranked]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        QUEUE_FILTERS.map((f) => [f.key, ranked.filter(f.match).length]),
      ) as Record<QueueFilter, number>,
    [ranked],
  );

  const visible = useMemo(() => {
    const match = QUEUE_FILTERS.find((f) => f.key === filter)!.match;
    const compare = SORT_OPTIONS.find((o) => o.key === sort)!.compare;
    const q = query.trim().toLowerCase();
    return ranked
      .filter(match)
      .filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          (c.original.description?.toString() ?? "").toLowerCase().includes(q),
      )
      .sort(compare);
  }, [ranked, filter, sort, query]);

  const shown = visible.slice(0, limit);
  const hidden = visible.length - shown.length;

  // Selection is a set of ids; every list on the page reads and writes it, and
  // the run is always played back in ranked order regardless of how it was
  // built (rail order, grid order, or a mix).
  const selectedIds = useMemo(
    () => ranked.filter((c) => selected.has(c.id)).map((c) => c.id),
    [ranked, selected],
  );
  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const visibleIds = visible.map((c) => c.id);
  const allVisibleSelected = visible.length > 0 && visibleIds.every((id) => selected.has(id));
  const perBoardPoints = overallPointsFor(1, totalBoards);

  return (
    <motion.div
      key="board-picker"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="no-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-2">
        <PickerHeader
          heading="Pick boards to boost"
          points={pointsEarned("boardStructure", score)}
          maxPoints={maxPointsFor("boardStructure")}
          gainPoints={overallPointsFor(ranked.length, totalBoards)}
          onGuide={onGuide}
        />

        {suggested.length > 0 && (
          <SuggestedBoardsRail
            cards={suggested}
            selected={selected}
            onToggle={toggleOne}
            onQueueAll={setMany}
          />
        )}

        <QueueToolbar
          query={query}
          onQuery={(v) => {
            setQuery(v);
            setLimit(BOARD_GRID_PAGE_SIZE);
          }}
          placeholder="Search boards…"
          sort={sort}
          onSort={setSort}
          options={SORT_OPTIONS}
          neutralSort="opportunity"
        />

        <FilterChipRow
          filters={QUEUE_FILTERS}
          active={filter}
          counts={counts}
          onFilter={(key) => {
            setFilter(key);
            setLimit(BOARD_GRID_PAGE_SIZE);
          }}
          allSelected={allVisibleSelected}
          onToggleAll={() => setMany(visibleIds, !allVisibleSelected)}
          toggleDisabled={visible.length === 0}
        />

        {shown.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
            No boards match that.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {shown.map((card, i) => (
              <BoardPickCard
                key={card.id}
                card={card}
                index={i}
                selected={selected.has(card.id)}
                flipped={flippedId === card.id}
                boosted={statusById[card.id] === "approved"}
                points={perBoardPoints}
                pointsNow={pointsEarned("boardStructure", score)}
                onToggle={() => toggleOne(card.id)}
                onFlip={() => setFlippedId((cur) => (cur === card.id ? null : card.id))}
              />
            ))}
          </div>
        )}

        {(hidden > 0 || limit > BOARD_GRID_PAGE_SIZE) && (
          <div className="flex gap-2">
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setLimit((l) => l + BOARD_GRID_PAGE_SIZE)}
                className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border bg-surface/70 text-xs font-bold text-primary transition hover:bg-primary/[0.04]"
              >
                Show
                <span className="font-semibold tabular-nums text-muted-foreground">
                  {hidden} more
                </span>
              </button>
            )}
            {limit > BOARD_GRID_PAGE_SIZE && (
              <button
                type="button"
                onClick={() => setLimit(BOARD_GRID_PAGE_SIZE)}
                className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface px-3.5 text-xs font-bold text-muted-foreground transition hover:text-foreground"
              >
                Collapse
              </button>
            )}
          </div>
        )}
      </div>

      <SelectionBar
        selectedCount={selectedIds.length}
        unit="board"
        unitPlural="boards"
        emptyLabel="Select boards"
        selectedPoints={overallPointsFor(selectedIds.length, totalBoards)}
        onStart={() => selectedIds.length > 0 && onStart(selectedIds)}
        onClear={() => setSelected(new Set())}
      />
    </motion.div>
  );
}

/** The messiest boards, presented the same quiet way as the pin picker's
 * "Fix these first" rail: a plain section header with a Queue-all pill.
 * Two screens of one product present their shortcut identically. */
function SuggestedBoardsRail({
  cards,
  selected,
  onToggle,
  onQueueAll,
}: {
  cards: BoardFixCard[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onQueueAll: (ids: string[], on: boolean) => void;
}) {
  const ids = cards.map((c) => c.id);
  const allQueued = ids.length > 0 && ids.every((id) => selected.has(id));

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Suggested boards"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 font-display text-lead font-bold tracking-tight">Fix these first</h3>
        <button
          type="button"
          onClick={() => onQueueAll(ids, !allQueued)}
          className={`shrink-0 rounded-full px-3 py-1.5 text-mini font-bold transition active:scale-[0.97] ${
            allQueued
              ? "bg-surface-2 text-muted-foreground ring-1 ring-border"
              : "bg-primary/10 text-primary hover:bg-primary/15"
          }`}
        >
          {allQueued ? "Clear" : `Queue all ${ids.length}`}
        </button>
      </div>

      {/* Same card width as the pin rail, so the two rails scroll alike. */}
      <div className="no-scrollbar -mx-1 flex snap-x gap-2.5 overflow-x-auto px-1 pb-1">
        {cards.map((card, i) => {
          const on = selected.has(card.id);
          return (
            <motion.button
              key={card.id}
              type="button"
              onClick={() => onToggle(card.id)}
              aria-pressed={on}
              aria-label={`${on ? "Remove" : "Queue"} board ${card.title}`}
              whileTap={{ scale: 0.96 }}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{
                delay: Math.min(i, 6) * 0.04,
                duration: 0.28,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="w-[calc((100vw-5rem)/2.4)] min-w-[124px] max-w-[162px] shrink-0 snap-start text-left"
            >
              <div
                className={`relative h-[86px] overflow-hidden rounded-xl transition ${
                  on ? "ring-2 ring-primary" : "ring-1 ring-border/60"
                }`}
              >
                <BoardCover covers={card.covers} flat />
                <span className="absolute left-1 top-1 inline-flex items-center rounded-full bg-black/45 px-1.5 py-0.5 text-nano font-bold text-white backdrop-blur-sm">
                  {card.issues.length} {card.issues.length === 1 ? "fix" : "fixes"}
                </span>
                <span className="absolute right-1 top-1">
                  <SelectDot on={on} small />
                </span>
              </div>
              <p className="mt-1 line-clamp-1 px-0.5 text-mini font-bold">{card.title}</p>
              <p className="px-0.5 text-micro font-medium text-muted-foreground">
                {card.pinCount} {card.pinCount === 1 ? "pin" : "pins"}
                {card.impressions > 0 && <> · {metricLabel(card.impressions)}</>}
              </p>
            </motion.button>
          );
        })}
      </div>
    </motion.section>
  );
}

/** One grid card: the board as its cover collage, with what's wrong with it in
 * the corner and a check dot. Hold it and it flips to the one sentence that
 * matters — the pts fixing it adds to the Boost Score. */
function BoardPickCard({
  card,
  index,
  selected,
  flipped,
  boosted,
  points,
  pointsNow,
  onToggle,
  onFlip,
}: {
  card: BoardFixCard;
  index: number;
  selected: boolean;
  flipped: boolean;
  boosted: boolean;
  /** Pts fixing this one board adds to the overall score. */
  points: number;
  /** Board SEO's banked pts right now, so the flip side shows the move. */
  pointsNow: number;
  onToggle: () => void;
  onFlip: () => void;
}) {
  const { fired, handlers } = useLongPress(onFlip);
  const fixes = card.issues.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.03, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      style={{ perspective: 800 }}
    >
      <motion.div
        animate={{ rotateY: flipped ? 180 : 0, scale: selected ? 0.97 : 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        style={{ transformStyle: "preserve-3d" }}
        className="relative aspect-[4/3] w-full"
      >
        {/* Front */}
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`${selected ? "Remove" : "Queue"} board ${card.title}`}
          onClick={() => {
            if (fired.current) {
              fired.current = false;
              return;
            }
            onToggle();
          }}
          {...handlers}
          style={{ backfaceVisibility: "hidden", pointerEvents: flipped ? "none" : "auto" }}
          className={`absolute inset-0 touch-manipulation select-none overflow-hidden rounded-2xl bg-surface-2 text-left transition-shadow ${
            selected ? "shadow-elevate ring-2 ring-primary" : "ring-1 ring-border/60"
          }`}
        >
          <BoardCover covers={card.covers} flat />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />

          <span className="absolute right-1.5 top-1.5">
            <SelectDot on={selected} />
          </span>

          {boosted ? (
            <span className="absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white shadow">
              <Check className="h-3.5 w-3.5" strokeWidth={3.5} />
            </span>
          ) : fixes > 0 ? (
            <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-micro font-bold text-white backdrop-blur-sm">
              <Sparkles className="h-3 w-3 text-amber-300" /> {fixes}{" "}
              {fixes === 1 ? "fix" : "fixes"}
            </span>
          ) : null}

          <div className="absolute inset-x-2 bottom-1.5">
            <p className="line-clamp-1 text-xs font-bold text-white">{card.title}</p>
            <p className="flex items-center gap-2 text-micro font-bold text-white/85">
              <span className="inline-flex items-center gap-1">
                <LayoutGrid className="h-2.5 w-2.5 opacity-80" />
                <span className="tabular-nums">{card.pinCount}</span>
              </span>
              {card.impressions > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Eye className="h-2.5 w-2.5 opacity-80" />
                  <span className="tabular-nums">{metricLabel(card.impressions)}</span>
                </span>
              )}
            </p>
          </div>
        </button>

        {/* Back — the score story, one glance long. */}
        <button
          type="button"
          onClick={onFlip}
          aria-label="Hide score impact"
          style={{
            backfaceVisibility: "hidden",
            transform: "rotateY(180deg)",
            pointerEvents: flipped ? "auto" : "none",
          }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border-2 border-primary/40 bg-surface p-2 text-center"
        >
          {/* Unit on the number, not a caption under it — same as the pin card. */}
          <span className="font-display text-[26px] font-bold leading-none tabular-nums text-primary">
            +{pointsLabel(points)}
            <span className="ml-1 text-mini font-bold uppercase tracking-wide text-muted-foreground">
              pts
            </span>
          </span>
          <span className="text-mini font-semibold leading-snug text-muted-foreground">
            {pointsLabel(pointsNow)} →{" "}
            <span className="text-emerald-600">
              {pointsLabel(Math.min(maxPointsFor("boardStructure"), pointsNow + points))}
            </span>
          </span>
          {fixes > 0 && (
            <span className="line-clamp-2 px-1 text-micro font-medium leading-snug text-foreground/70">
              {card.issues.join(" · ")}
            </span>
          )}
        </button>
      </motion.div>
    </motion.div>
  );
}

/* The run is whatever the creator queued — the launch beat says its size, so
 * the transition confirms the selection landed. */
function BoardLaunch({ card, count }: { card: BoardFixCard; count: number }) {
  return (
    <LaunchScreen title={`${count} ${count === 1 ? "board" : "boards"} queued`}>
      <BoardCover covers={card?.covers ?? []} flat />
    </LaunchScreen>
  );
}

/* ---------------- The card ---------------- */

/** The hero of the board fix flow: the board's own cover, what the copy is
 * optimized for, then a Now → Suggested comparison for name and description. */
function BoardRewriteCard({
  card,
  ai,
  onEdit,
  onRegenerate,
}: {
  card: BoardFixCard;
  ai: AiRewriteState<SuggestBoardSeoResult> | undefined;
  onEdit: () => void;
  onRegenerate: () => void;
}) {
  const [nameField, descField] = card.fields;
  const nowName = card.original.name?.toString().trim();
  const nowDesc = card.original.description?.toString().trim();
  const generating = !ai || ai.status === "loading";
  const theme = ai?.status === "ready" ? ai.result.theme : null;
  // A ready result with an empty field is still being filled in — keep the
  // shimmer rather than flashing a blank bold line, same rule as the pin deck.
  const nameLoading = generating || (ai.status === "ready" && !nameField.value.trim());
  const descLoading =
    generating || (ai.status === "ready" && !!descField && !descField.value.trim());

  return (
    <motion.div
      key={card.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-3"
    >
      {/* The board itself — cover collage plus what's in it. */}
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-2/40 p-2.5">
        <div className="h-16 w-16 shrink-0">
          <BoardCover covers={card.covers} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-foreground">{card.title}</p>
          <p className="text-mini text-muted-foreground">
            {card.pinCount} {card.pinCount === 1 ? "pin" : "pins"}
            {theme && <span> · mostly {theme}</span>}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <IssueChips issues={card.issues} />
          </div>
        </div>
      </div>

      {/* AI rewrite header + Edit. */}
      <div className="flex items-center justify-between">
        <p className="inline-flex items-center gap-1.5 text-body font-extrabold text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> AI rewrite
        </p>
        <button
          type="button"
          onClick={onEdit}
          disabled={generating}
          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-surface px-3 text-mini font-bold text-primary ring-1 ring-primary/25 transition hover:bg-primary/10 disabled:opacity-40"
        >
          <Pencil className="h-3 w-3" /> Edit
        </button>
      </div>

      <FieldDiff
        heading="Board name"
        now={nowName}
        field={nameField}
        loading={nameLoading}
        lines={1}
      />
      {descField && (
        <FieldDiff
          heading="Description"
          now={nowDesc}
          field={descField}
          loading={descLoading}
          lines={3}
        />
      )}

      {/* The keyword receipt sits under the copy it explains — the rewrite is
          what's being judged, so it leads; the trends behind it follow. While
          the pipeline runs, the same slot carries the progress ticker. */}
      {generating ? (
        <GeneratingNotice />
      ) : ai.status === "error" ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-mini font-semibold text-amber-800">Couldn&apos;t write this one</p>
          <p className="mt-0.5 text-mini leading-snug text-amber-700/80">
            Your board is untouched.
          </p>
          {/* The only retry path now that the always-on Redo chip is gone — it
              belongs with the failure, not on top of every healthy rewrite. */}
          <button
            type="button"
            onClick={onRegenerate}
            className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-full bg-surface px-3 text-mini font-bold text-amber-800 ring-1 ring-amber-500/30 transition hover:bg-amber-500/10"
          >
            <RefreshCw className="h-3 w-3" /> Try again
          </button>
        </div>
      ) : (
        <KeywordProof result={ai.result} />
      )}
    </motion.div>
  );
}

/* ---------------- Filmstrip ---------------- */

/** Horizontal strip of board covers. The selected board grows into a white
 * red-bordered tab whose open bottom pokes into the rewrite card below, so its
 * border joins the card boundary — the same connected tab as the pin deck. */
function BoardFilmstrip({
  cards,
  currentIndex,
  statusById,
  pendingIds,
  onJump,
  onOpenGrid,
}: {
  cards: BoardFixCard[];
  currentIndex: number;
  statusById: Record<string, "approved" | "skipped">;
  pendingIds: Set<string>;
  onJump: (i: number) => void;
  onOpenGrid: () => void;
}) {
  const total = cards.length;
  const visible = Math.min(NAV_VISIBLE, total);
  const maxStart = Math.max(0, total - visible);

  const [start, setStart] = useState(() => Math.min(Math.max(currentIndex - 1, 0), maxStart));
  const clampStart = (s: number) => Math.min(Math.max(s, 0), maxStart);

  useEffect(() => {
    setStart((s) => {
      if (currentIndex < s) return clampStart(currentIndex);
      if (currentIndex > s + visible - 1) return clampStart(currentIndex - visible + 1);
      return clampStart(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, visible, maxStart]);

  const movedRef = useRef(false);
  const downXRef = useRef<number | null>(null);
  const lastStepRef = useRef(0);
  const step = (dir: number) => setStart((s) => clampStart(s + dir));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    downXRef.current = e.clientX;
    movedRef.current = false;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (downXRef.current != null && Math.abs(e.clientX - downXRef.current) > 6)
      movedRef.current = true;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (downXRef.current == null) return;
    const dx = e.clientX - downXRef.current;
    downXRef.current = null;
    if (Math.abs(dx) > 30) step(dx < 0 ? 1 : -1);
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 8) return;
    const now = Date.now();
    if (now - lastStepRef.current < 260) return;
    lastStepRef.current = now;
    step(d > 0 ? 1 : -1);
  };

  return (
    <div className="flex items-center justify-center gap-1.5">
      <div
        className="relative overflow-x-clip"
        style={{ width: visible * NAV_SLOT }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <motion.div
          className="flex items-end"
          animate={{ x: -start * NAV_SLOT }}
          transition={{ type: "spring", stiffness: 380, damping: 34 }}
        >
          {cards.map((cand, i) => {
            const status = statusById[cand.id];
            const active = i === currentIndex;
            const pending = pendingIds.has(cand.id);
            return (
              <div
                key={cand.id}
                className="flex shrink-0 justify-center"
                style={{ width: NAV_SLOT }}
              >
                <motion.button
                  onClick={() => {
                    if (!movedRef.current) onJump(i);
                  }}
                  aria-label={active ? "Current board" : "Go to this board"}
                  animate={{ scale: active ? 1.32 : 0.8 }}
                  transition={{ type: "spring", stiffness: 420, damping: 24 }}
                  className={`relative h-14 w-14 origin-bottom overflow-hidden will-change-transform ${
                    active
                      ? "z-30 -mb-4 rounded-2xl rounded-b-none border-2 border-b-0 border-primary bg-surface p-[3px] shadow-[0_-3px_10px_rgba(0,0,0,0.08)]"
                      : "rounded-2xl opacity-90 shadow-sm hover:opacity-100"
                  }`}
                >
                  <div
                    className={
                      status === "skipped" ? "h-full w-full opacity-30 grayscale" : "h-full w-full"
                    }
                  >
                    <BoardCover covers={cand.covers} flat={active} />
                  </div>
                  {pending ? (
                    <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/50 text-white">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </span>
                  ) : status === "approved" ? (
                    <span className="absolute inset-0 grid place-items-center rounded-lg bg-emerald-500/70 text-white">
                      <Check className="h-4 w-4" strokeWidth={3} />
                    </span>
                  ) : status === "skipped" ? (
                    <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/55 text-white">
                      <X className="h-4 w-4" strokeWidth={3} />
                    </span>
                  ) : null}
                </motion.button>
              </div>
            );
          })}
        </motion.div>
      </div>

      {/* All-boards view. */}
      <button
        type="button"
        onClick={onOpenGrid}
        aria-label="See all boards"
        className="group grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-surface-2 text-muted-foreground ring-1 ring-border transition hover:text-primary hover:ring-2 hover:ring-primary/50"
      >
        <LayoutGrid className="h-5 w-5" />
        <span className="text-nano font-bold uppercase tracking-wide">All</span>
      </button>
    </div>
  );
}

/* ---------------- All-boards sheet ---------------- */

function BoardGridSheet({
  cards,
  currentIndex,
  statusById,
  pendingIds,
  onJump,
  onClose,
}: {
  cards: BoardFixCard[];
  currentIndex: number;
  statusById: Record<string, "approved" | "skipped">;
  pendingIds: Set<string>;
  onJump: (i: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const fixedCount = cards.filter((c) => statusById[c.id] === "approved").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      role="dialog"
      aria-modal="true"
      aria-label="All boards"
      className="fixed inset-0 z-[70] flex flex-col bg-background"
    >
      <div className="glass sticky top-0 z-10 flex items-center gap-3 border-b border-border px-4 py-3 safe-top">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to review"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface ring-1 ring-border transition hover:text-primary"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-lg font-bold leading-tight">Your boards</h3>
          <p className="text-xs text-muted-foreground">
            {cards.length} {cards.length === 1 ? "board" : "boards"}
            {fixedCount > 0 && (
              <span className="font-semibold text-emerald-600"> · {fixedCount} done</span>
            )}
          </p>
        </div>
      </div>

      <div className="no-scrollbar flex-1 overflow-y-auto px-3 py-4">
        <div className="grid grid-cols-2 gap-3">
          {cards.map((cand, i) => {
            const status = statusById[cand.id];
            const active = i === currentIndex;
            const pending = pendingIds.has(cand.id);
            return (
              <button
                key={cand.id}
                type="button"
                onClick={() => {
                  onJump(i);
                  onClose();
                }}
                aria-label={active ? "Current board" : "Go to this board"}
                className={`relative overflow-hidden rounded-2xl text-left transition active:scale-[0.98] ${
                  active
                    ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                    : "ring-1 ring-border"
                }`}
              >
                <div
                  className={`aspect-[4/3] w-full ${status === "skipped" ? "opacity-40 grayscale" : ""}`}
                >
                  <BoardCover covers={cand.covers} flat />
                </div>
                <div className="bg-surface px-2.5 py-2">
                  <p className="truncate text-xs font-bold">{cand.title}</p>
                  <p className="text-micro text-muted-foreground">
                    {cand.pinCount} {cand.pinCount === 1 ? "pin" : "pins"}
                  </p>
                </div>

                {pending ? (
                  <span className="absolute inset-0 grid place-items-center bg-black/45 text-white">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </span>
                ) : status === "approved" ? (
                  <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white shadow">
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                ) : status === "skipped" ? (
                  <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white shadow">
                    <X className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                ) : active ? (
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-primary px-2 py-0.5 text-micro font-bold text-primary-foreground shadow">
                    Editing
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
