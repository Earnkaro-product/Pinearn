import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCheck,
  Info,
  LayoutGrid,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { LiveScorePill } from "@/components/health-widgets";
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
import { boardIdOf, boardIssues, byIssueCountDesc, SCORE_CRITERIA } from "@/lib/health-score";

// How to drive the deck — surfaced any time via the header's "How it works".
const BOARD_GUIDE_STEPS = [
  "Tap Apply fix to accept the suggested name & description for this board.",
  "Tap Skip to leave a board untouched and move on.",
  "Tap Edit to adjust the wording, or Redo for a different angle.",
  "Jump between boards from the strip up top — and undo any fix anytime.",
];

// Filmstrip sizing — mirrors the pin review navigator so the two flows feel
// like one product.
const NAV_SLOT = 72;
const NAV_VISIBLE = 4;

export const Route = createFileRoute("/_authenticated/boost_/boards")({
  component: FixBoardsPage,
});

type BoardFixCard = BaseFixCard & { covers: string[]; pinCount: number };

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

  // EVERY board, not just the failing ones — same reasoning as the pin deck.
  return byIssueCountDesc(data.boards, boardIssues).map((b) => {
    const boardPins = pinsByBoard.get(b.id) ?? [];
    return {
      id: b.id,
      title: b.name?.trim() || "Unnamed board",
      issues: boardIssues(b),
      pinCount: boardPins.length,
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

  // Stable across renders so the rewrite scheduler doesn't re-evaluate its
  // fetch window on every keystroke — the deck itself is frozen after build.
  const boardIds = useMemo(() => flow.deck?.map((c) => c.id) ?? null, [flow.deck]);
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

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [guide, setGuide] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);

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

  const reviewing = !flow.isLoading && flow.deck !== null && flow.deck.length > 0 && !flow.done;

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
    <AppShell title="Board Boost" backButton backTo="/boost" hideBottomNav>
      <div className="mx-auto flex h-[calc(100dvh-6.5rem)] max-w-md flex-col px-1">
        {flow.isLoading || flow.deck === null ? (
          <DeckSkeleton />
        ) : flow.deck.length === 0 ? (
          <OptimizedState onBack={backToScore} unitLabel="boards" />
        ) : flow.done ? (
          <DoneState
            scoreLabel="Board Structure"
            score={flow.score}
            gained={flow.gained}
            approvedCount={flow.approvedCount}
            skippedCount={flow.skippedCount}
            total={flow.total}
            appliedCards={flow.appliedCards}
            onRevertOne={(c) => flow.revertOne(c as BoardFixCard)}
            onUndoAll={flow.undoAll}
            onBack={backToScore}
            busy={flow.bulkApplying || flow.pendingIds.size > 0}
          />
        ) : (
          <>
            {/* Progress summary — reviewed / applied / skipped. */}
            <div className="flex shrink-0 items-center justify-center gap-2 pb-2 text-[11px] font-medium text-muted-foreground">
              <span className="tabular-nums">
                Reviewed {flow.index}/{flow.total}
              </span>
              <span className="text-muted-foreground/40">•</span>
              <span className="font-semibold text-emerald-600">{flow.approvedCount} applied</span>
              <span className="text-muted-foreground/40">•</span>
              <span>{flow.skippedCount} skipped</span>
            </div>

            <p className="shrink-0 pb-2 text-center text-[11px] text-muted-foreground">
              Rewriting <span className="font-semibold text-foreground">every</span> board name
              &amp; description — strongest gains first
            </p>

            <div className="flex shrink-0 items-center justify-center gap-3 pb-2">
              <LiveScorePill label="Board Structure" score={flow.score} />
              <button
                type="button"
                onClick={() => setGuide(true)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary transition hover:underline"
              >
                <Info className="h-3 w-3" /> How it works
              </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="relative z-20 shrink-0 rounded-t-3xl bg-surface-2 px-6 pb-2 pt-6">
                <BoardFilmstrip
                  cards={flow.cards}
                  currentIndex={flow.index}
                  statusById={flow.statusById}
                  pendingIds={flow.pendingIds}
                  onJump={flow.goTo}
                  onOpenGrid={() => setGridOpen(true)}
                />
              </div>

              <div className="no-scrollbar relative z-10 min-h-0 flex-1 overflow-y-auto rounded-3xl border-2 border-primary bg-surface p-4 shadow-sm">
                {current && (
                  <BoardRewriteCard
                    card={current}
                    ai={currentAi}
                    onEdit={() => setEditing(true)}
                    onRegenerate={() => ai.regenerate(current.id)}
                  />
                )}
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
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-4 py-3.5 text-[15px] font-extrabold text-primary-foreground shadow-glow transition disabled:opacity-60"
                >
                  {currentPending || currentGenerating ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Check className="h-5 w-5" strokeWidth={3} />
                  )}
                  {currentGenerating ? "Writing…" : "Apply fix"}
                </motion.button>
              </div>

              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={() => setConfirming(true)}
                disabled={flow.bulkApplying || preparingBulk || remaining.length === 0}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-primary bg-surface px-3 py-3 text-[13px] font-bold text-primary transition disabled:opacity-40"
              >
                {preparingBulk ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Writing rewrites… {bulkReady}/
                    {remaining.length}
                  </>
                ) : (
                  <>
                    <CheckCheck className="h-4 w-4" /> Approve all remaining ({remaining.length})
                  </>
                )}
              </motion.button>
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
          <p className="text-[11px] text-muted-foreground">
            {card.pinCount} {card.pinCount === 1 ? "pin" : "pins"}
            {theme && <span> · mostly {theme}</span>}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <IssueChips issues={card.issues} />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="inline-flex items-center gap-1.5 text-[13px] font-extrabold text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> AI rewrite
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onRegenerate}
            disabled={generating}
            aria-label="Generate a different rewrite"
            className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-surface px-3 text-[11px] font-bold text-muted-foreground ring-1 ring-border transition hover:text-primary disabled:opacity-40"
          >
            <RefreshCw className={`h-3 w-3 ${generating ? "animate-spin" : ""}`} /> Redo
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={generating}
            className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-surface px-3 text-[11px] font-bold text-primary ring-1 ring-primary/25 transition hover:bg-primary/10 disabled:opacity-40"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        </div>
      </div>

      {generating ? (
        <GeneratingNotice />
      ) : ai.status === "error" ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-[11px] font-semibold text-amber-800">Couldn&apos;t write this one</p>
          <p className="mt-0.5 text-[11px] leading-snug text-amber-700/80">
            Tap Redo to try again, or Skip to move on. Nothing was changed on your board.
          </p>
        </div>
      ) : (
        <KeywordProof result={ai.result} />
      )}

      <FieldDiff
        heading="Board name"
        now={nowName}
        field={nameField}
        loading={generating}
        lines={1}
      />
      {descField && (
        <FieldDiff
          heading="Description"
          now={nowDesc}
          field={descField}
          loading={generating}
          lines={3}
        />
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
        <span className="text-[8px] font-bold uppercase tracking-wide">All</span>
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
            {cards.length} {cards.length === 1 ? "board" : "boards"} to fix
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
                  <p className="truncate text-[12px] font-bold">{cand.title}</p>
                  <p className="text-[10px] text-muted-foreground">
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
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground shadow">
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
