import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  Coins,
  Eye,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Loader2,
  MousePointerClick,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import { GRADIENTS } from "./pins";
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
import { useFixFlow, type BaseFixCard, type FixField } from "@/hooks/use-fix-flow";
import { useAiRewrites, type AiRewriteState } from "@/hooks/use-ai-rewrites";
import { useWallet } from "@/hooks/use-wallet";
import { boostCost, coinLabel, COINS_PER_PIN_BOOST, resetCountdown } from "@/lib/coins";
import {
  resolvePinSeoSuggestion,
  suggestPinSeo,
  type SuggestSeoResult,
} from "@/lib/pin-seo.functions";
import type { HealthData } from "@/hooks/use-health-score";
import {
  boardIdOf,
  byIssueCountDesc,
  PIN_DESC_MAX,
  PIN_DESC_MIN,
  PIN_TITLE_MAX,
  PIN_TITLE_MIN,
  pinSeoIssues,
  SCORE_CRITERIA,
  SUB_SCORE_WEIGHTS,
} from "@/lib/health-score";

// How to drive the deck — surfaced any time via the header's "How it works".
const PIN_GUIDE_STEPS = [
  "Queue pins one by one, by board, or Select all — then start the run.",
  "Hold any pin to flip it and see what fixing it adds to your score.",
  "In the run, Apply fix accepts a rewrite; Skip leaves the pin untouched.",
  "Tap Edit to adjust wording first — and undo any fix anytime.",
];

// Filmstrip sizing — mirrors the board review navigator so the two flows feel
// like one product.
const NAV_SLOT = 72; // px per pin slot (56px pin + spacing + room to enlarge)
const NAV_VISIBLE = 4; // whole pins visible at once

// Picker sizing. The deck can be hundreds of pins, so the grid reveals a page
// at a time instead of mounting every card the moment the screen opens — a
// 300-card grid built in one commit is a visible jank on a phone. The Suggested
// rail is deliberately short: it's a shortcut, not another backlog.
const SUGGESTED_COUNT = 10;
const SUGGESTED_BOARDS_COUNT = 6;
const PIN_GRID_PAGE_SIZE = 15;

export const Route = createFileRoute("/_authenticated/boost_/pins")({
  component: FixPinSeoPage,
});

type PinFixCard = BaseFixCard & {
  image_url: string | null;
  impressions: number;
  clicks: number;
  // The real board this pin lives on — powers the "boost a whole board" lane
  // and the board name shown on every pin card.
  boardId: string | null;
  boardName: string | null;
  createdAt: string;
};

/** A card is applyable only once every field holds real copy. Cards start
 * empty and are filled by the pipeline, so this is the single gate that keeps
 * a blank title from ever reaching the database. */
function hasCopy(card: BaseFixCard): boolean {
  return card.fields.every((f) => f.value.trim().length > 0);
}

/** Cards start with EMPTY copy and are filled by the real pipeline (Pinterest
 * Trends → keyword plan → one image-aware copy call) as each one returns.
 *
 * There is deliberately no offline template fallback here. Pre-filling with
 * health-score.ts's heuristic rewrite meant the card showed finished-looking
 * copy that was about to be thrown away — indistinguishable from the real
 * suggestion, and applyable before the real one arrived. A card with nothing
 * in it can't be mistaken for a result, and Apply stays disabled until there
 * genuinely is one. */
function buildDeck(data: HealthData): PinFixCard[] {
  // EVERY pin, not just the failing ones. A title inside the length bands can
  // still be ranking for nothing, so the deck offers a keyword-grounded rewrite
  // for all of them — with the worst first so the biggest wins come first, and
  // a before/after score on each card so an already-good pin is never
  // "improved" into something weaker.
  const boardNames = new Map(data.boards.map((b) => [b.id, b.name]));
  return byIssueCountDesc(data.pins, pinSeoIssues).map((p) => ({
    id: p.id,
    title: p.title?.trim() || "Untitled pin",
    issues: pinSeoIssues(p),
    image_url: p.image_url,
    impressions: p.impressions ?? 0,
    clicks: p.clicks ?? 0,
    boardId: boardIdOf(p),
    boardName: boardIdOf(p) ? (boardNames.get(boardIdOf(p) as string) ?? null) : null,
    createdAt: p.created_at,
    fields: [
      { key: "title", label: "Title", value: "", min: PIN_TITLE_MIN, max: PIN_TITLE_MAX },
      {
        key: "description",
        label: "Description",
        value: "",
        min: PIN_DESC_MIN,
        max: PIN_DESC_MAX,
        multiline: true,
      },
    ],
    original: { title: p.title, description: p.description },
  }));
}

function FixPinSeoPage() {
  const navigate = useNavigate();

  // pinId → the history row the currently-shown copy came from. Populated as
  // each suggestion lands, and used to close that row out when the creator
  // acts on it. Without this the row sits 'pending' forever, which both keeps
  // the 24h dedup window from releasing and starves the "phrasings the creator
  // already turned down" feedback the next generation reads.
  const suggestionIds = useRef(new Map<string, string>());
  const resolveSuggestion = useServerFn(resolvePinSeoSuggestion);

  // Fire-and-forget: bookkeeping must never block or fail the swipe the
  // creator just made, and the pipeline degrades fine if a row stays pending.
  const markSuggestion = useCallback(
    (pinId: string, decision: "approved" | "rejected") => {
      const suggestionId = suggestionIds.current.get(pinId);
      if (!suggestionId) return;
      void resolveSuggestion({ data: { suggestionId, decision } }).catch(() => {});
    },
    [resolveSuggestion],
  );

  // Coins are charged per boosted pin, and refunded when a boost is undone. The
  // debit rides onApplied rather than persist because revertFix writes through
  // the same persist call — billing there would charge for the undo too.
  const wallet = useWallet();
  const [coinsSpent, setCoinsSpent] = useState(0);

  const flow = useFixFlow<PinFixCard>({
    scoreKey: "pinSeo",
    buildDeck,
    onApplied: async (id) => {
      const charged = await wallet.spendForPin(id);
      if (charged) setCoinsSpent((n) => n + COINS_PER_PIN_BOOST);
      // The rewrite is already live on the pin, so a billing failure is a
      // bookkeeping problem, not a reason to roll the creator's fix back.
      else toast.error("Rewrite saved, but the coin couldn't be charged");
    },
    onReverted: async (id) => {
      const refunded = await wallet.refundForPin(id);
      if (refunded) setCoinsSpent((n) => Math.max(0, n - COINS_PER_PIN_BOOST));
    },
    persist: async (id, values) => {
      // values is a dynamic {title, description} map — cast past the generated
      // row type's excess-property check (keys are ours, not user input).
      const { error } = await supabase
        .from("pins")
        .update(values as never)
        .eq("id", id);
      if (!error) markSuggestion(id, "approved");
      return { error };
    },
    applyToCache: (data, id, values) => ({
      ...data,
      pins: data.pins.map((p) => (p.id === id ? { ...p, ...values } : p)),
    }),
    invalidateKeys: [["dashboard-unmonetized-pins"]],
  });

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [guide, setGuide] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [mode, setMode] = useState<"picker" | "launching" | "review">("picker");
  const [launchCard, setLaunchCard] = useState<PinFixCard | null>(null);
  const [runSize, setRunSize] = useState(0);

  // Stable across renders so the rewrite scheduler doesn't re-evaluate its
  // fetch window on every keystroke — the deck itself is frozen after build.
  // The picker is intentionally API-quiet: generation starts only after the
  // creator chooses a pin and enters the work surface.
  const pinIds = useMemo(
    () => (mode === "review" ? (flow.deck?.map((c) => c.id) ?? null) : null),
    [flow.deck, mode],
  );
  const patchCard = flow.patchCard;
  const runSuggest = useServerFn(suggestPinSeo);
  const ai = useAiRewrites<SuggestSeoResult>({
    ids: pinIds,
    index: flow.index,
    generate: useCallback((pinId, force) => runSuggest({ data: { pinId, force } }), [runSuggest]),
    onResult: useCallback(
      (pinId, result) => {
        suggestionIds.current.set(pinId, result.suggestionId);
        patchCard(pinId, { title: result.title, description: result.description });
      },
      [patchCard],
    ),
  });

  // "Redo" is the one unambiguous rejection signal in the deck: the creator saw
  // this copy and wants different copy. Marking it rejected before regenerating
  // is what puts it on the next prompt's "don't repeat these" list, so the
  // retry comes back with a genuinely different angle instead of a paraphrase.
  const regenerate = useCallback(
    (pinId: string) => {
      markSuggestion(pinId, "rejected");
      ai.regenerate(pinId);
    },
    [markSuggestion, ai],
  );

  const backToScore = () => navigate({ to: "/boost" });
  const paused = editing || confirming;
  const remaining = flow.cards.slice(flow.index);
  const current = flow.current;
  const currentPending = !!current && flow.pendingIds.has(current.id);

  // There is no template fallback any more, so a card has nothing to apply
  // until the pipeline returns. Gate Apply on the fields actually having copy
  // rather than on the request status: that blocks both the still-loading case
  // and the failed one (which would otherwise blank the pin's title), while
  // still allowing a card the user has typed into themselves after a failure.
  const currentAi: AiRewriteState<SuggestSeoResult> | undefined = current
    ? ai.byId[current.id]
    : undefined;
  const currentGenerating = !!current && (!currentAi || currentAi.status === "loading");
  const currentReady = !!current && hasCopy(current);

  // Coin gates, priced off the weekly allowance in the header.
  const canAffordOne = wallet.canAfford(COINS_PER_PIN_BOOST);
  const showCoinCost = wallet.available;

  // Bulk approve has the same hazard, times N. Generate everything first, then
  // apply. flowRef keeps us on the LATEST approveAll — the one captured at
  // click time closes over a pre-generation deck.
  const [preparingBulk, setPreparingBulk] = useState(false);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const remainingIds = remaining.map((c) => c.id);
  const bulkReady = ai.settledCount(remainingIds);
  // What bulk will actually charge: the whole queue, or as much of it as this
  // week's coins cover.
  const bulkCovered = Math.min(remaining.length, wallet.balance);
  const bulkCost = boostCost(bulkCovered);
  const bulkTrimmed = bulkCovered < remaining.length;

  const approveAllWithAi = async () => {
    // A weekly allowance is smaller than a full deck, so bulk covers as many pins
    // as there are coins and leaves the rest queued. Capping BEFORE generation
    // matters twice over: it stops the run charging for pins it can't pay for, and
    // it stops us paying the model for rewrites that were never going to be
    // applied.
    const queued = flowRef.current.cards.slice(flowRef.current.index);
    const covered = queued.slice(0, Math.max(0, wallet.balance));
    const ids = covered.map((c) => c.id);
    if (ids.length === 0) return;
    setPreparingBulk(true);
    await ai.ensure(ids);
    setPreparingBulk(false);
    const inBudget = new Set(ids);
    // Only apply pins that actually produced copy AND are inside the budget.
    // Everything else is marked skipped rather than written blank or written free.
    await flowRef.current.approveAll((c) => inBudget.has(c.id) && hasCopy(c));
    if (covered.length < queued.length) {
      toast.info(
        `Boosted ${covered.length} of ${queued.length} — you're out of coins until the weekly refill`,
      );
    }
  };

  // Start a run over exactly the pins the creator queued, in the order they
  // were ranked. The deck is narrowed to that set, so the filmstrip, the
  // progress bar, "approve all remaining" and — most importantly — the rewrite
  // generation all cover the chosen pins and nothing else.
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

  // Back out of a run to re-pick. Decisions already made are keyed by pin id,
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

  // Keyboard parity with the rest of the app: → apply, ← skip, ⌘/Ctrl+Z undo —
  // never while a sheet is open or focus is in a field.
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
      // Same gates as the Apply button — → must never commit an empty card, and
      // never spend a coin the wallet doesn't have.
      if (e.key === "ArrowRight" && !currentPending && currentReady) {
        if (!canAffordOne) {
          toast.error("You're out of coins — boosting a pin costs 1 coin");
          return;
        }
        flow.decide(current, "approved");
      } else if (e.key === "ArrowLeft") flow.decide(current, "skipped");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewing, paused, current, currentPending, currentReady, canAffordOne, flow.canUndo]);

  return (
    <AppShell
      title="Pin Boost"
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
          <OptimizedState onBack={backToScore} unitLabel="pins" />
        ) : flow.done ? (
          <DoneState
            scoreLabel="Pin SEO"
            score={flow.score}
            gained={flow.gained}
            approvedCount={flow.approvedCount}
            skippedCount={flow.skippedCount}
            total={flow.total}
            appliedCards={flow.appliedCards}
            coinsSpent={showCoinCost ? coinsSpent : undefined}
            onRevertOne={(c) => flow.revertOne(c as PinFixCard)}
            onUndoAll={flow.undoAll}
            onBack={backToScore}
            busy={flow.bulkApplying || flow.pendingIds.size > 0}
          />
        ) : mode === "picker" ? (
          <PinBoostPicker
            cards={flow.cards}
            score={flow.score}
            statusById={flow.statusById}
            onStart={startRun}
            onGuide={() => setGuide(true)}
          />
        ) : mode === "launching" ? (
          <PinLaunch card={launchCard ?? flow.current ?? flow.cards[0]} count={runSize} />
        ) : (
          <>
            {/* One compact status bar instead of three stacked centered lines:
                live score, position in the run, a segmented progress track, and
                the applied/skipped split — the same information in a third of
                the height, which is space the rewrite card gets instead. */}
            <ReviewProgressHeader
              score={flow.score}
              index={flow.index}
              total={flow.total}
              approvedCount={flow.approvedCount}
              skippedCount={flow.skippedCount}
              onGuide={() => setGuide(true)}
            />

            {/* Navigator (neutral grey panel) whose selected pin becomes a white
                red-bordered tab that pokes down into the red rewrite card — the
                selected pin sits inside the card's boundary, like the board
                review screen. */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="relative z-20 shrink-0 rounded-t-3xl bg-surface-2 px-6 pb-2 pt-6">
                <PinFilmstrip
                  cards={flow.cards}
                  currentIndex={flow.index}
                  statusById={flow.statusById}
                  pendingIds={flow.pendingIds}
                  onJump={flow.goTo}
                  onOpenBoard={() => setBoardOpen(true)}
                />
              </div>

              {/* The rewrite — the hero, in a red-bordered card that echoes the
                  selected pin tab above. */}
              <div className="no-scrollbar relative z-10 min-h-0 flex-1 overflow-y-auto rounded-3xl border-2 border-primary bg-surface p-4 shadow-sm">
                {current && (
                  <RewriteCard
                    card={current}
                    ai={currentAi}
                    onEdit={() => setEditing(true)}
                    onRegenerate={() => regenerate(current.id)}
                  />
                )}
              </div>
            </div>

            {/* Fixed action zone — Skip (small) + Apply (dominant), bulk beneath. */}
            <div className="shrink-0 space-y-2.5 pt-3">
              <div className="flex items-stretch gap-2.5">
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={() => current && flow.decide(current, "skipped")}
                  disabled={!current || paused}
                  aria-label="Skip this suggestion"
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-2xl border-2 border-border bg-surface px-5 py-3.5 text-sm font-bold text-muted-foreground transition hover:text-foreground disabled:opacity-40"
                >
                  <X className="h-4 w-4" strokeWidth={2.5} /> Skip
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={() => current && flow.decide(current, "approved")}
                  disabled={!current || currentPending || !currentReady || paused || !canAffordOne}
                  aria-label={
                    canAffordOne
                      ? `Apply fix — costs ${coinLabel(COINS_PER_PIN_BOOST)}`
                      : "Out of coins"
                  }
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-4 py-3.5 text-[15px] font-extrabold text-primary-foreground shadow-glow transition disabled:opacity-60"
                >
                  {currentPending || currentGenerating ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Check className="h-5 w-5" strokeWidth={3} />
                  )}
                  {currentGenerating
                    ? "Writing…"
                    : !canAffordOne
                      ? "Out of coins this week"
                      : "Apply fix"}
                  {/* The price rides the button, so the cost of the tap is
                      visible at the moment of tapping rather than only in the
                      header balance. */}
                  {showCoinCost && canAffordOne && !currentGenerating && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-bold tabular-nums">
                      <Coins className="h-3 w-3" /> {COINS_PER_PIN_BOOST}
                    </span>
                  )}
                </motion.button>
              </div>

              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={() => setConfirming(true)}
                disabled={
                  flow.bulkApplying || preparingBulk || remaining.length === 0 || bulkCovered === 0
                }
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-primary bg-surface px-3 py-3 text-[13px] font-bold text-primary transition disabled:opacity-40"
              >
                {preparingBulk ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Writing rewrites… {bulkReady}/
                    {remaining.length}
                  </>
                ) : (
                  <>
                    <CheckCheck className="h-4 w-4" />
                    {bulkCovered === 0
                      ? "Out of coins this week"
                      : bulkTrimmed
                        ? `Approve next ${bulkCovered} of ${remaining.length}`
                        : `Approve all remaining (${remaining.length})`}
                    {/* One coin per pin the batch will actually apply — the same
                        number the confirm sheet charges. */}
                    {showCoinCost && bulkCovered > 0 && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${
                          bulkTrimmed
                            ? "bg-amber-500/15 text-amber-800"
                            : "bg-primary/10 text-primary"
                        }`}
                      >
                        <Coins className="h-3 w-3" /> {bulkCost}
                      </span>
                    )}
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
            unitLabel="pins"
            costCoins={showCoinCost ? bulkCost : undefined}
            balance={wallet.balance}
            onConfirm={approveAllWithAi}
            onCancel={() => setConfirming(false)}
          />
        )}
        {guide && (
          <GuideSheet
            title="What makes a good pin"
            criteria={SCORE_CRITERIA.pinSeo}
            steps={PIN_GUIDE_STEPS}
            onClose={() => setGuide(false)}
          />
        )}
        {boardOpen && (
          <PinGridSheet
            cards={flow.cards}
            currentIndex={flow.index}
            statusById={flow.statusById}
            pendingIds={flow.pendingIds}
            onJump={flow.goTo}
            onClose={() => setBoardOpen(false)}
          />
        )}
      </AnimatePresence>
    </AppShell>
  );
}

/** Compact status bar for the review surface. Score, position, a segmented
 * progress track (applied vs skipped vs remaining) and the run's promise, in one
 * band — the three centred rows this replaced cost ~70px of the card's height on
 * a small phone and read as three unrelated captions. */
function ReviewProgressHeader({
  score,
  index,
  total,
  approvedCount,
  skippedCount,
  onGuide,
}: {
  score: number;
  index: number;
  total: number;
  approvedCount: number;
  skippedCount: number;
  onGuide: () => void;
}) {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className="shrink-0 pb-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <LiveScorePill label="Pin SEO" score={score} />
          <p className="min-w-0 text-[11px] font-semibold leading-tight text-muted-foreground">
            <span className="tabular-nums text-foreground">
              {Math.min(index + 1, total)}/{total}
            </span>{" "}
            in queue
            <span className="block text-[10px] font-medium text-muted-foreground/80">
              Strongest gains first
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onGuide}
          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 text-[11px] font-bold text-primary ring-1 ring-primary/20 transition hover:bg-primary/10"
        >
          <Info className="h-3 w-3" /> How it works
        </button>
      </div>

      {/* Segmented track: applied (green) → skipped (grey) → remaining. */}
      <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-border/60">
        <motion.div
          className="h-full bg-emerald-500"
          animate={{ width: `${pct(approvedCount)}%` }}
          transition={{ type: "spring", stiffness: 220, damping: 30 }}
        />
        <motion.div
          className="h-full bg-muted-foreground/35"
          animate={{ width: `${pct(skippedCount)}%` }}
          transition={{ type: "spring", stiffness: 220, damping: 30 }}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[10px] font-semibold tabular-nums">
        <span className="inline-flex items-center gap-1 text-emerald-600">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {approvedCount} applied
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
          {skippedCount} skipped
        </span>
        <span className="text-muted-foreground/70">
          {Math.max(total - approvedCount - skippedCount, 0)} left
        </span>
      </div>
    </div>
  );
}

function metricLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return value.toLocaleString();
}

function pinOpportunityScore(card: PinFixCard): number {
  const issueWeight = Math.max(1, card.issues.length) * 100_000;
  return issueWeight + card.impressions * 2 + card.clicks * 25;
}

/* ------------------------------------------------------------------ *
 * The picker — where a run gets built.
 *
 * One interaction model, everywhere: tap anything to queue it, hold a pin
 * to flip it over and see what it's worth, then launch from the bottom bar.
 * Two tabs mirror the Select-pin screen — Pins (a compact selectable grid,
 * with a Suggested rail on top) and Boards (queue a whole board per tap).
 * The screen stays almost wordless; the CTA carries the instruction.
 * ------------------------------------------------------------------ */

// Fixing one failing pin moves Pin SEO by 1/total of its 100 points, and Pin
// SEO is worth SUB_SCORE_WEIGHTS.pinSeo of the overall score. A pin that
// already passes is worth zero points — its rewrite is a keyword play, not a
// score play, and the flip side says exactly that instead of inventing a number.
function overallPointsFor(failingCount: number, totalPins: number): number {
  if (totalPins === 0) return 0;
  return SUB_SCORE_WEIGHTS.pinSeo * (failingCount / totalPins) * 100;
}

/** Points as the creator should read them: never a rounded-up "0.0", never
 * more precision than the number deserves. */
function pointsLabel(points: number): string {
  if (points <= 0) return "0";
  if (points < 0.1) return "<0.1";
  return points.toFixed(points < 10 ? 1 : 0);
}

type SortKey = "opportunity" | "impressions" | "clicks" | "fixes" | "newest";

const SORT_OPTIONS: {
  key: SortKey;
  label: string;
  compare: (a: PinFixCard, b: PinFixCard) => number;
}[] = [
  {
    key: "opportunity",
    label: "Biggest win",
    compare: (a, b) => pinOpportunityScore(b) - pinOpportunityScore(a),
  },
  {
    key: "impressions",
    label: "Most impressions",
    compare: (a, b) => b.impressions - a.impressions,
  },
  { key: "clicks", label: "Most clicks", compare: (a, b) => b.clicks - a.clicks },
  { key: "fixes", label: "Most to fix", compare: (a, b) => b.issues.length - a.issues.length },
  {
    key: "newest",
    label: "Newest first",
    compare: (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  },
];

/** Lenses over the grid — "the ones with no description", "the ones already
 * getting traffic" — one tap instead of scrolling 300 cards. Counts live on
 * the chips so an empty bucket is obvious before it's tapped. */
type QueueFilter = "all" | "title" | "description" | "traffic";

const QUEUE_FILTERS: { key: QueueFilter; label: string; match: (c: PinFixCard) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "title", label: "Weak title", match: (c) => c.issues.some((i) => /title/i.test(i)) },
  {
    key: "description",
    label: "Weak description",
    match: (c) => c.issues.some((i) => /description/i.test(i)),
  },
  { key: "traffic", label: "Getting traffic", match: (c) => c.impressions > 0 || c.clicks > 0 },
];

/** Every pin grouped under the board it actually lives on, worst board first.
 * Queueing a board is the shortest path from "this board is a mess" to a run
 * that fixes it end to end. */
type BoardLane = {
  id: string;
  name: string;
  cards: PinFixCard[];
  fixes: number;
  impressions: number;
  images: string[];
};

function buildBoardLanes(cards: PinFixCard[]): BoardLane[] {
  const byId = new Map<string, BoardLane>();
  for (const c of cards) {
    if (!c.boardId || !c.boardName) continue;
    let lane = byId.get(c.boardId);
    if (!lane) {
      lane = { id: c.boardId, name: c.boardName, cards: [], fixes: 0, impressions: 0, images: [] };
      byId.set(c.boardId, lane);
    }
    lane.cards.push(c);
    lane.fixes += c.issues.length;
    lane.impressions += c.impressions;
    if (c.image_url && lane.images.length < 3) lane.images.push(c.image_url);
  }
  return [...byId.values()].sort((a, b) => b.fixes - a.fixes || b.impressions - a.impressions);
}

/** Press-and-hold, without swallowing taps or fighting the scroller: the timer
 * dies the moment the finger travels, so holding still is the only thing that
 * flips a card. `fired` lets the click handler tell a hold from a tap. */
function useLongPress(onLongPress: () => void, ms = 350) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      origin.current = { x: e.clientX, y: e.clientY };
      fired.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(8);
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = origin.current;
      if (o && (Math.abs(e.clientX - o.x) > 8 || Math.abs(e.clientY - o.y) > 8)) clear();
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };

  return { fired, handlers };
}

function PinBoostPicker({
  cards,
  score,
  statusById,
  onStart,
  onGuide,
}: {
  cards: PinFixCard[];
  score: number;
  statusById: Record<string, "approved" | "skipped">;
  onStart: (ids: string[]) => void;
  onGuide: () => void;
}) {
  // Read-only here: the picker prices a run but never charges one. Coins are
  // debited per pin as its rewrite is applied, inside the run.
  const { balance } = useWallet();
  const [tab, setTab] = useState<"pins" | "boards">("pins");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [flippedId, setFlippedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("opportunity");
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PIN_GRID_PAGE_SIZE);

  // Ranked once — the run order for everything on this screen, so "biggest
  // win first" holds whether the creator queued a board, a lens, or the lot.
  const ranked = useMemo(
    () => [...cards].sort((a, b) => pinOpportunityScore(b) - pinOpportunityScore(a)),
    [cards],
  );
  const failingTotal = useMemo(() => ranked.filter((p) => p.issues.length > 0).length, [ranked]);
  const lanes = useMemo(() => buildBoardLanes(ranked), [ranked]);
  const suggested = useMemo(() => {
    const failing = ranked.filter((c) => c.issues.length > 0);
    return (failing.length > 0 ? failing : ranked).slice(0, SUGGESTED_COUNT);
  }, [ranked]);
  // Boards worth suggesting = the ones with something to fix, worst first
  // (lanes already sort that way). The full list lives in the Boards tab.
  const suggestedLanes = useMemo(
    () => lanes.filter((l) => l.fixes > 0).slice(0, SUGGESTED_BOARDS_COUNT),
    [lanes],
  );

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
          (c.original.title ?? "").toLowerCase().includes(q) ||
          (c.boardName ?? "").toLowerCase().includes(q),
      )
      .sort(compare);
  }, [ranked, filter, sort, query]);

  const shown = visible.slice(0, limit);
  const hidden = visible.length - shown.length;

  // Selection is a set of ids; every list on the page reads and writes it, and
  // the run is always played back in ranked order regardless of how it was
  // built (grid order, board order, or a mix).
  const selectedIds = useMemo(
    () => ranked.filter((c) => selected.has(c.id)).map((c) => c.id),
    [ranked, selected],
  );
  const selectedFailing = useMemo(
    () => ranked.filter((c) => selected.has(c.id) && c.issues.length > 0).length,
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
  const perPinPoints = overallPointsFor(1, ranked.length);

  return (
    <motion.div
      key="pin-picker"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="no-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-2">
        <PickerHeader
          score={score}
          points={overallPointsFor(failingTotal, ranked.length)}
          onGuide={onGuide}
        />

        {/* Pinterest-style tabs — same pattern as the Select pin screen. */}
        <div className="flex items-center justify-center gap-8 border-b border-border/60">
          <PickerTab active={tab === "pins"} onClick={() => setTab("pins")}>
            Pins
          </PickerTab>
          <PickerTab active={tab === "boards"} onClick={() => setTab("boards")}>
            Boards
          </PickerTab>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {tab === "pins" ? (
            <motion.div
              key="tab-pins"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-4"
            >
              {suggested.length > 0 && (
                <SuggestedRail cards={suggested} selected={selected} onToggle={toggleOne} />
              )}

              <QueueToolbar
                query={query}
                onQuery={(v) => {
                  setQuery(v);
                  setLimit(PIN_GRID_PAGE_SIZE);
                }}
                sort={sort}
                onSort={setSort}
              />

              <div className="flex items-center gap-2">
                <div className="no-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
                  {QUEUE_FILTERS.map((f) => {
                    const active = f.key === filter;
                    const n = counts[f.key];
                    return (
                      <button
                        key={f.key}
                        type="button"
                        aria-pressed={active}
                        disabled={n === 0}
                        onClick={() => {
                          setFilter(f.key);
                          setLimit(PIN_GRID_PAGE_SIZE);
                        }}
                        className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] font-bold transition disabled:opacity-35 ${
                          active
                            ? "bg-foreground text-background shadow-sm"
                            : "bg-surface text-muted-foreground ring-1 ring-border hover:text-foreground"
                        }`}
                      >
                        {f.label}
                        <span className={`tabular-nums ${active ? "opacity-70" : "opacity-55"}`}>
                          {n}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => setMany(visibleIds, !allVisibleSelected)}
                  disabled={visible.length === 0}
                  className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-bold transition disabled:opacity-40 ${
                    allVisibleSelected
                      ? "bg-foreground text-background"
                      : "bg-surface text-primary ring-1 ring-primary/25 hover:bg-primary/10"
                  }`}
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  {allVisibleSelected ? "Clear" : "Select all"}
                </button>
              </div>

              {shown.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border py-10 text-center text-[12px] text-muted-foreground">
                  No pins match that.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2.5">
                  {shown.map((card, i) => (
                    <PinPickCard
                      key={card.id}
                      card={card}
                      index={i}
                      selected={selected.has(card.id)}
                      flipped={flippedId === card.id}
                      boosted={statusById[card.id] === "approved"}
                      points={card.issues.length > 0 ? perPinPoints : 0}
                      seoNow={score}
                      seoDelta={card.issues.length > 0 ? 100 / Math.max(1, ranked.length) : 0}
                      onToggle={() => toggleOne(card.id)}
                      onFlip={() => setFlippedId((cur) => (cur === card.id ? null : card.id))}
                    />
                  ))}
                </div>
              )}

              {(hidden > 0 || limit > PIN_GRID_PAGE_SIZE) && (
                <div className="flex gap-2">
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => setLimit((l) => l + PIN_GRID_PAGE_SIZE)}
                      className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border bg-surface/70 text-[12px] font-bold text-primary transition hover:bg-primary/[0.04]"
                    >
                      Show more
                      <span className="font-semibold tabular-nums text-muted-foreground">
                        · {hidden} left
                      </span>
                    </button>
                  )}
                  {limit > PIN_GRID_PAGE_SIZE && (
                    <button
                      type="button"
                      onClick={() => setLimit(PIN_GRID_PAGE_SIZE)}
                      className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface px-3.5 text-[12px] font-bold text-muted-foreground transition hover:text-foreground"
                    >
                      Collapse
                    </button>
                  )}
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="tab-boards"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              {lanes.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border py-10 text-center text-[12px] text-muted-foreground">
                  No boards yet.
                </p>
              ) : (
                <div className="space-y-4">
                  {suggestedLanes.length > 0 && (
                    <SuggestedBoardsRail
                      lanes={suggestedLanes}
                      selected={selected}
                      onToggleMany={setMany}
                    />
                  )}
                  <div>
                    {suggestedLanes.length > 0 && (
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                        All boards
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      {lanes.map((lane, i) => {
                        const ids = lane.cards.map((c) => c.id);
                        const queued = ids.every((id) => selected.has(id));
                        return (
                          <BoardPickCard
                            key={lane.id}
                            lane={lane}
                            index={i}
                            queued={queued}
                            onToggle={() => setMany(ids, !queued)}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <SelectionBar
        selectedCount={selectedIds.length}
        selectedPoints={overallPointsFor(selectedFailing, ranked.length)}
        onStart={() => selectedIds.length > 0 && onStart(selectedIds)}
        onClear={() => setSelected(new Set())}
      />
      {/* Cost of the selection, one line, under the CTA — enough to price the tap
          without turning the bar into a receipt. */}
      {selectedIds.length > 0 && (
        <p
          className={`shrink-0 pb-1 text-center text-[10.5px] font-semibold ${
            selectedIds.length > balance ? "text-amber-700" : "text-muted-foreground/80"
          }`}
        >
          {selectedIds.length > balance ? (
            <>
              {coinLabel(selectedIds.length)} needed · {balance} left this week, refills{" "}
              {resetCountdown()}
            </>
          ) : (
            <>
              {coinLabel(selectedIds.length)} · {balance - selectedIds.length} left this week
            </>
          )}
        </p>
      )}
    </motion.div>
  );
}

/** The whole briefing in one slim band: where the score stands, what's on the
 * table, and the page's only instruction — everything else is pictures. */
function PickerHeader({
  score,
  points,
  onGuide,
}: {
  score: number;
  points: number;
  onGuide: () => void;
}) {
  return (
    <header className="flex items-center gap-3 rounded-3xl border border-border bg-surface p-3.5 shadow-sm">
      <ScoreRing score={score} />
      <div className="min-w-0 flex-1">
        <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Pin SEO
        </p>
        <h2 className="font-display text-[19px] font-bold leading-tight tracking-tight">
          Pick pins to boost
        </h2>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-display text-[17px] font-bold leading-none text-primary">
          +{pointsLabel(points)}
        </p>
        <p className="mt-0.5 text-[9.5px] font-semibold text-muted-foreground">pts available</p>
      </div>
      <button
        type="button"
        onClick={onGuide}
        aria-label="How boosting works"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted-foreground ring-1 ring-border transition hover:text-primary"
      >
        <Info className="h-4 w-4" />
      </button>
    </header>
  );
}

/** Animated progress ring — the score as a shape, not another sentence. */
function ScoreRing({ score }: { score: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative grid h-12 w-12 shrink-0 place-items-center">
      <svg viewBox="0 0 48 48" className="h-12 w-12 -rotate-90">
        <circle cx="24" cy="24" r={r} fill="none" strokeWidth="4.5" className="stroke-border/70" />
        <motion.circle
          cx="24"
          cy="24"
          r={r}
          fill="none"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - Math.min(100, Math.max(2, score)) / 100) }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          className="stroke-primary"
        />
      </svg>
      <span className="absolute text-[11px] font-bold tabular-nums">{score}%</span>
    </div>
  );
}

function PickerTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative -mb-px px-1 pb-2.5 pt-1 text-[15px] font-semibold transition ${
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
      {active && (
        <motion.span
          layoutId="picker-tab-underline"
          className="absolute inset-x-0 bottom-0 h-[3px] rounded-full bg-foreground"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        />
      )}
    </button>
  );
}

function PinImage({ card, className }: { card: PinFixCard; className?: string }) {
  if (!card.image_url) {
    return (
      <div className="grid h-full w-full place-items-center bg-surface-2 text-muted-foreground">
        <ImageIcon className="h-5 w-5" />
      </div>
    );
  }
  return (
    <img
      src={card.image_url}
      alt=""
      draggable={false}
      loading="lazy"
      className={`h-full w-full object-cover ${className ?? ""}`}
    />
  );
}

/** The check dot every selectable thing on this page wears — one visual verb
 * ("this is queued") shared by the rail, the grid and the board cards. */
function SelectDot({ on, small }: { on: boolean; small?: boolean }) {
  return (
    <span
      className={`grid place-items-center rounded-full border-2 transition ${
        small ? "h-5 w-5" : "h-6 w-6"
      } ${
        on
          ? "border-primary bg-primary text-primary-foreground"
          : "border-white/80 bg-black/25 text-transparent backdrop-blur-sm"
      }`}
    >
      <motion.span
        initial={false}
        animate={{ scale: on ? 1 : 0.4, opacity: on ? 1 : 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 24 }}
      >
        <Check className={small ? "h-3 w-3" : "h-3.5 w-3.5"} strokeWidth={3.5} />
      </motion.span>
    </span>
  );
}

/** Tiny uppercase rail label with its ranking rule on the right — the whole
 * "why these" answer in five muted words. */
function RailLabel({ text, metric }: { text: string; metric: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {text}
      </p>
      <p className="text-[9.5px] font-semibold text-muted-foreground/70">{metric}</p>
    </div>
  );
}

/** The best wins, as a quiet rail of pictures. Rank #1 wears the trophy, and
 * each thumb carries the numbers it was ranked by — fixes and reach. Tapping
 * queues, the same gesture as everywhere else on the page. */
function SuggestedRail({
  cards,
  selected,
  onToggle,
}: {
  cards: PinFixCard[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <RailLabel text="Suggested pins" metric="most fixes · most reach" />
      <div className="no-scrollbar -mx-1 flex snap-x gap-2 overflow-x-auto px-1">
        {cards.map((card, i) => {
          const on = selected.has(card.id);
          return (
            <motion.button
              key={card.id}
              type="button"
              onClick={() => onToggle(card.id)}
              aria-pressed={on}
              aria-label={`${on ? "Remove" : "Queue"} ${card.title}`}
              whileTap={{ scale: 0.94 }}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{
                delay: Math.min(i, 6) * 0.04,
                duration: 0.28,
                ease: [0.22, 1, 0.36, 1],
              }}
              className={`relative h-[104px] w-[78px] shrink-0 snap-start overflow-hidden rounded-xl transition ${
                on ? "ring-2 ring-primary" : "ring-1 ring-border/60"
              }`}
            >
              <PinImage card={card} />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/65 to-transparent" />
              {i === 0 ? (
                <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground shadow">
                  <Trophy className="h-2.5 w-2.5" />
                </span>
              ) : (
                <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/45 text-[9px] font-bold text-white backdrop-blur-sm">
                  {i + 1}
                </span>
              )}
              <span className="absolute right-1 top-1">
                <SelectDot on={on} small />
              </span>
              {/* Why it's here: the two numbers the ranking reads. */}
              <span className="absolute inset-x-1 bottom-1 flex items-center justify-between text-[8.5px] font-bold text-white/95">
                {card.issues.length > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <Sparkles className="h-2 w-2 text-amber-300" /> {card.issues.length}
                  </span>
                )}
                {card.impressions > 0 && (
                  <span className="ml-auto inline-flex items-center gap-0.5">
                    <Eye className="h-2 w-2 opacity-80" />
                    <span className="tabular-nums">{metricLabel(card.impressions)}</span>
                  </span>
                )}
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

/** The messiest boards, one tap from being queued whole — each card carries
 * the fix count it was ranked by. */
function SuggestedBoardsRail({
  lanes,
  selected,
  onToggleMany,
}: {
  lanes: BoardLane[];
  selected: Set<string>;
  onToggleMany: (ids: string[], on: boolean) => void;
}) {
  return (
    <div>
      <RailLabel text="Suggested boards" metric="most fixes first" />
      <div className="no-scrollbar -mx-1 flex snap-x gap-2 overflow-x-auto px-1">
        {lanes.map((lane, i) => {
          const ids = lane.cards.map((c) => c.id);
          const on = ids.every((id) => selected.has(id));
          const [cover, ...restImgs] = lane.images;
          const side = restImgs.slice(0, 2);
          return (
            <motion.button
              key={lane.id}
              type="button"
              onClick={() => onToggleMany(ids, !on)}
              aria-pressed={on}
              aria-label={`${on ? "Remove" : "Queue"} board ${lane.name}`}
              whileTap={{ scale: 0.96 }}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{
                delay: Math.min(i, 5) * 0.04,
                duration: 0.28,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="w-36 shrink-0 snap-start text-left"
            >
              <div
                className={`relative overflow-hidden rounded-xl transition ${
                  on ? "ring-2 ring-primary" : "ring-1 ring-border/60"
                }`}
              >
                <div className="flex h-[72px] gap-0.5">
                  <div
                    className={`relative flex-[2] bg-gradient-to-br ${GRADIENTS[i % GRADIENTS.length]}`}
                  >
                    {cover && (
                      <img
                        src={cover}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-0.5">
                    {[0, 1].map((j) => (
                      <div
                        key={j}
                        className={`relative flex-1 bg-gradient-to-br ${GRADIENTS[(i + j + 1) % GRADIENTS.length]}`}
                      >
                        {side[j] && (
                          <img
                            src={side[j]}
                            alt=""
                            loading="lazy"
                            draggable={false}
                            className="h-full w-full object-cover"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded-full bg-black/45 px-1.5 py-0.5 text-[8.5px] font-bold text-white backdrop-blur-sm">
                  <Sparkles className="h-2 w-2 text-amber-300" /> {lane.fixes}
                </span>
                <span className="absolute right-1 top-1">
                  <SelectDot on={on} small />
                </span>
              </div>
              <p className="mt-1 line-clamp-1 px-0.5 text-[10.5px] font-bold">{lane.name}</p>
              <p className="px-0.5 text-[9px] font-medium text-muted-foreground">
                {lane.cards.length} {lane.cards.length === 1 ? "pin" : "pins"}
              </p>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

/** Search + sort, in the language of the Select pin screen so the two picking
 * surfaces feel like one product. */
function QueueToolbar({
  query,
  onQuery,
  sort,
  onSort,
}: {
  query: string;
  onQuery: (v: string) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const active = SORT_OPTIONS.find((o) => o.key === sort)!;

  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-1 items-center gap-2.5 rounded-full bg-surface-2 px-4 py-2.5 transition focus-within:bg-surface focus-within:ring-2 focus-within:ring-foreground">
        <Search className="h-[17px] w-[17px] shrink-0 text-foreground/60" strokeWidth={2.4} />
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search pins…"
          className="w-full bg-transparent text-[13px] font-medium outline-none placeholder:text-foreground/45"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground/10 text-foreground/70 transition hover:bg-foreground/20"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div ref={ref} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`flex h-[42px] items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[13px] font-bold transition ${
            sort !== "opportunity"
              ? "bg-foreground text-background"
              : "bg-surface-2 text-foreground hover:bg-surface-2/70"
          }`}
        >
          {sort === "opportunity" ? "Sort" : active.label}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="absolute right-0 top-[calc(100%+8px)] z-30 w-48 overflow-hidden rounded-2xl border border-border bg-surface p-1.5 shadow-elevate"
            >
              {SORT_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => {
                    onSort(o.key);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold transition hover:bg-surface-2 ${
                    o.key === sort ? "text-primary" : "text-foreground"
                  }`}
                >
                  {o.label}
                  {o.key === sort && <Check className="h-4 w-4" />}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** One grid card, image-first and near-wordless: metrics in the corner, a fix
 * count, a check dot. Hold it and it flips to the one sentence that matters —
 * what fixing it adds to the health score. */
function PinPickCard({
  card,
  index,
  selected,
  flipped,
  boosted,
  points,
  seoNow,
  seoDelta,
  onToggle,
  onFlip,
}: {
  card: PinFixCard;
  index: number;
  selected: boolean;
  flipped: boolean;
  boosted: boolean;
  points: number;
  seoNow: number;
  seoDelta: number;
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
        animate={{ rotateY: flipped ? 180 : 0, scale: selected ? 0.96 : 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        style={{ transformStyle: "preserve-3d" }}
        className="relative aspect-[3/4] w-full"
      >
        {/* Front */}
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`${selected ? "Remove" : "Queue"} ${card.title}`}
          onClick={() => {
            if (fired.current) {
              fired.current = false;
              return;
            }
            onToggle();
          }}
          {...handlers}
          style={{ backfaceVisibility: "hidden", pointerEvents: flipped ? "none" : "auto" }}
          className={`absolute inset-0 touch-manipulation select-none overflow-hidden rounded-xl bg-surface-2 text-left transition-shadow ${
            selected ? "shadow-elevate ring-2 ring-primary" : "ring-1 ring-border/60"
          }`}
        >
          <PinImage card={card} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />

          <span className="absolute right-2 top-2">
            <SelectDot on={selected} />
          </span>

          {boosted ? (
            <span className="absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white shadow">
              <Check className="h-3.5 w-3.5" strokeWidth={3.5} />
            </span>
          ) : fixes > 0 ? (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
              <Sparkles className="h-3 w-3 text-amber-300" /> {fixes}{" "}
              {fixes === 1 ? "fix" : "fixes"}
            </span>
          ) : null}

          <div className="absolute inset-x-2 bottom-2 flex items-center gap-2.5 text-[11px] font-bold text-white/95">
            <span className="inline-flex items-center gap-1">
              <Eye className="h-3 w-3 opacity-80" />
              <span className="tabular-nums">{metricLabel(card.impressions)}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <MousePointerClick className="h-3 w-3 opacity-80" />
              <span className="tabular-nums">{metricLabel(card.clicks)}</span>
            </span>
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
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border-2 border-primary/40 bg-surface p-2 text-center"
        >
          <span className="font-display text-[28px] font-bold leading-none tabular-nums text-primary">
            {points > 0 ? `+${pointsLabel(points)}` : "+0"}
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            health pts
          </span>
          <span className="text-[11px] font-semibold leading-snug text-muted-foreground">
            {points > 0 ? (
              <>
                SEO {seoNow}% →{" "}
                <span className="text-emerald-600">
                  {Math.min(100, Math.round(seoNow + seoDelta))}%
                </span>
              </>
            ) : (
              "Already passing"
            )}
          </span>
          {fixes > 0 && (
            <span className="line-clamp-2 px-1 text-[10px] font-medium leading-snug text-foreground/70">
              {card.issues.slice(0, 2).join(" · ")}
            </span>
          )}
        </button>
      </motion.div>
    </motion.div>
  );
}

/** A board as a tap-to-queue card — the same cover collage boards wear on the
 * dashboard, with the same check dot the pins wear here. */
function BoardPickCard({
  lane,
  index,
  queued,
  onToggle,
}: {
  lane: BoardLane;
  index: number;
  queued: boolean;
  onToggle: () => void;
}) {
  const [cover, ...rest] = lane.images;
  const side = rest.slice(0, 2);
  const grad = GRADIENTS[index % GRADIENTS.length];
  return (
    <motion.button
      type="button"
      onClick={onToggle}
      aria-pressed={queued}
      whileTap={{ scale: 0.97 }}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.04, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="group text-left"
    >
      <div
        className={`relative overflow-hidden rounded-2xl transition ${
          queued ? "ring-2 ring-primary" : "ring-1 ring-border/60"
        }`}
      >
        <div className="flex h-28 gap-0.5">
          <div className={`relative flex-[2] bg-gradient-to-br ${grad}`}>
            {cover && (
              <img
                src={cover}
                alt=""
                loading="lazy"
                draggable={false}
                className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
              />
            )}
          </div>
          <div className="flex flex-1 flex-col gap-0.5">
            {[0, 1].map((i) => (
              <div
                key={i}
                className={`relative flex-1 bg-gradient-to-br ${GRADIENTS[(index + i + 1) % GRADIENTS.length]}`}
              >
                {side[i] && (
                  <img
                    src={side[i]}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
        <span className="absolute right-1.5 top-1.5">
          <SelectDot on={queued} />
        </span>
        {lane.impressions > 0 && (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[9px] font-bold text-white backdrop-blur-sm">
            <Eye className="h-2.5 w-2.5" /> {metricLabel(lane.impressions)}
          </span>
        )}
      </div>
      <div className="px-0.5 pt-1.5">
        <h4 className="line-clamp-1 text-[12px] font-bold">{lane.name}</h4>
        <p className="text-[10px] font-medium text-muted-foreground">
          {lane.cards.length} {lane.cards.length === 1 ? "pin" : "pins"}
          {lane.fixes > 0 && <> · {lane.fixes} fixes</>}
        </p>
      </div>
    </motion.button>
  );
}

/** The run launcher — and, until something is queued, the page's instruction.
 * Everything it needs to say fits inside the button. */
function SelectionBar({
  selectedCount,
  selectedPoints,
  onStart,
  onClear,
}: {
  selectedCount: number;
  selectedPoints: number;
  onStart: () => void;
  onClear: () => void;
}) {
  const has = selectedCount > 0;
  return (
    <div className="shrink-0">
      <div
        aria-hidden
        className="pointer-events-none h-5 bg-gradient-to-t from-background to-transparent"
      />
      <div className="flex items-stretch gap-2 pb-1">
        <AnimatePresence initial={false}>
          {has && (
            <motion.button
              key="clear"
              type="button"
              onClick={onClear}
              initial={{ opacity: 0, scale: 0.8, width: 0 }}
              animate={{ opacity: 1, scale: 1, width: 48 }}
              exit={{ opacity: 0, scale: 0.8, width: 0 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
              aria-label="Clear selection"
              className="grid shrink-0 place-items-center rounded-2xl border-2 border-border bg-surface text-muted-foreground transition hover:text-foreground"
            >
              <X className="h-4 w-4" strokeWidth={2.5} />
            </motion.button>
          )}
        </AnimatePresence>

        <motion.button
          type="button"
          whileTap={has ? { scale: 0.98 } : undefined}
          onClick={onStart}
          disabled={!has}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-[15px] font-extrabold transition ${
            has
              ? "bg-gradient-primary text-primary-foreground shadow-glow"
              : "bg-surface-2 text-muted-foreground ring-1 ring-inset ring-border"
          }`}
        >
          {has ? (
            <>
              <Sparkles className="h-4 w-4" />
              Boost{" "}
              <motion.span
                key={selectedCount}
                initial={{ y: -6, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.18 }}
                className="tabular-nums"
              >
                {selectedCount}
              </motion.span>{" "}
              {selectedCount === 1 ? "pin" : "pins"}
              {selectedPoints > 0 && (
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-bold">
                  +{pointsLabel(selectedPoints)} pts
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-bold tabular-nums">
                <Coins className="h-3 w-3" /> {boostCost(selectedCount)}
              </span>
              <ArrowRight className="h-4 w-4" strokeWidth={2.75} />
            </>
          ) : (
            <>Select pins to boost</>
          )}
        </motion.button>
      </div>
    </div>
  );
}

function PinLaunch({ card, count }: { card: PinFixCard; count: number }) {
  return (
    <motion.div
      key="pin-launch"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-3xl border border-primary/15 bg-surface"
    >
      <motion.div
        aria-hidden
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1.8, opacity: [0, 0.18, 0] }}
        transition={{ duration: 1.05, ease: [0.22, 1, 0.36, 1] }}
        className="absolute h-72 w-72 rounded-full border-2 border-primary"
      />
      <motion.div
        aria-hidden
        initial={{ y: 120, opacity: 0 }}
        animate={{ y: -120, opacity: [0, 1, 0] }}
        transition={{ duration: 1.05, ease: "easeInOut" }}
        className="absolute h-24 w-full bg-gradient-to-b from-transparent via-primary/20 to-transparent"
      />
      <motion.div
        initial={{ y: 18, scale: 0.9, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
        className="relative w-full max-w-[18rem] px-6 text-center"
      >
        <div className="mx-auto overflow-hidden rounded-[1.75rem] border-4 border-primary bg-surface shadow-elevate">
          <div className="aspect-[4/5] bg-surface-2">
            {card.image_url ? (
              <img src={card.image_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted-foreground">
                <ImageIcon className="h-12 w-12" />
              </div>
            )}
          </div>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22, duration: 0.32 }}
          className="mt-5"
        >
          <p className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-[11px] font-extrabold uppercase tracking-wide text-primary">
            <Sparkles className="h-3 w-3" /> Loading boost run
          </p>
          {/* The run is whatever the creator queued — say its size, so the
              transition confirms the selection landed. */}
          <h2 className="mt-2 font-display text-2xl font-bold">
            {count > 1 ? `Queuing ${count} pins` : "Locking onto this pin"}
          </h2>
          <div className="mx-auto mt-3 h-1.5 w-44 overflow-hidden rounded-full bg-surface-2">
            <div className="animate-indeterminate h-full w-1/3 rounded-full bg-primary" />
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

/** The hero of the pin fix flow: what the copy is optimized for, then a
 * Without AI → AI suggested comparison for the Title and Description. */
function RewriteCard({
  card,
  ai,
  onEdit,
  onRegenerate,
}: {
  card: PinFixCard;
  ai: AiRewriteState<SuggestSeoResult> | undefined;
  onEdit: () => void;
  onRegenerate: () => void;
}) {
  const [titleField, descField] = card.fields;
  const nowTitle = card.original.title?.toString().trim();
  const nowDesc = card.original.description?.toString().trim();
  const generating = !ai || ai.status === "loading";
  const titleLoading = generating || (ai.status === "ready" && !titleField.value.trim());
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
      {/* What the health check says about this pin as it stands. */}
      <div className="flex flex-wrap gap-1">
        <IssueChips issues={card.issues} />
      </div>

      {/* AI rewrite header + Edit / Regenerate. */}
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
            Tap Redo to try again, or Skip to move on. Nothing was changed on your pin.
          </p>
        </div>
      ) : (
        <KeywordProof result={ai.result} />
      )}

      <FieldDiff
        heading="Title"
        now={nowTitle}
        field={titleField}
        loading={titleLoading}
        lines={1}
      />
      {descField && (
        <FieldDiff
          heading="Description"
          now={nowDesc}
          field={descField}
          loading={descLoading}
          lines={4}
        />
      )}
    </motion.div>
  );
}

/** Horizontal pin strip. The selected pin grows from its bottom edge into a
 * white red-bordered tab whose open bottom pokes down into the rewrite card, so
 * its border joins the card boundary — the connected tab from the board review
 * screen. A paged window (overflow-x-clip, not native scroll) keeps the vertical
 * poke from being clipped. */
function PinFilmstrip({
  cards,
  currentIndex,
  statusById,
  pendingIds,
  onJump,
  onOpenBoard,
}: {
  cards: PinFixCard[];
  currentIndex: number;
  statusById: Record<string, "approved" | "skipped">;
  pendingIds: Set<string>;
  onJump: (i: number) => void;
  onOpenBoard: () => void;
}) {
  const total = cards.length;
  const visible = Math.min(NAV_VISIBLE, total);
  const maxStart = Math.max(0, total - visible);

  // The window's own scroll position, independent of the selection — browse the
  // strip a pin at a time without changing which pin you're reviewing.
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
                  aria-label={active ? "Current pin" : "Go to this pin"}
                  animate={{ scale: active ? 1.32 : 0.8 }}
                  transition={{ type: "spring", stiffness: 420, damping: 24 }}
                  className={`relative h-14 w-14 origin-bottom overflow-hidden will-change-transform ${
                    active
                      ? "z-30 -mb-4 rounded-2xl rounded-b-none border-2 border-b-0 border-primary bg-surface p-[3px] shadow-[0_-3px_10px_rgba(0,0,0,0.08)]"
                      : "rounded-2xl bg-gradient-to-br from-rose-500 to-pink-600 opacity-90 shadow-sm hover:opacity-100"
                  }`}
                >
                  {cand.image_url ? (
                    <img
                      src={cand.image_url}
                      alt=""
                      draggable={false}
                      className={`h-full w-full object-cover ${active ? "rounded-t-lg" : ""} ${
                        status === "skipped" ? "opacity-30 grayscale" : ""
                      }`}
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center bg-surface-2 text-muted-foreground">
                      <ImageIcon className="h-4 w-4" />
                    </div>
                  )}
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

      {/* Board cover — a mini collage of the deck's pins; opens the full board. */}
      <BoardCoverButton cards={cards} onClick={onOpenBoard} />
    </div>
  );
}

/** The board this deck belongs to, rendered as a Pinterest-style cover collage
 * (one large pin + two stacked) so it reads as a real board, not a button. */
function BoardCoverButton({ cards, onClick }: { cards: PinFixCard[]; onClick: () => void }) {
  const covers = cards
    .map((c) => c.image_url)
    .filter(Boolean)
    .slice(0, 3) as string[];
  const [big, ...rest] = covers;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open board — see all pins"
      className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-border transition hover:ring-2 hover:ring-primary/50"
    >
      <div className="flex h-full w-full gap-px">
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
                <img
                  src={rest[i]}
                  alt=""
                  draggable={false}
                  className="h-full w-full object-cover"
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <span className="absolute inset-x-0 bottom-0 grid place-items-center bg-black/55 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
        Board
      </span>
    </button>
  );
}

/** Full-screen board view of every pin in the deck — a Pinterest-style grid
 * that reads like opening a board, with each pin's fix status. Tapping a pin
 * selects it and returns to the review flow. */
function PinGridSheet({
  cards,
  currentIndex,
  statusById,
  pendingIds,
  onJump,
  onClose,
}: {
  cards: PinFixCard[];
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
      aria-label="Board — all pins"
      className="fixed inset-0 z-[70] flex flex-col bg-background"
    >
      {/* Sticky board header. */}
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
          <h3 className="truncate font-display text-lg font-bold leading-tight">Your board</h3>
          <p className="text-xs text-muted-foreground">
            {cards.length} {cards.length === 1 ? "pin" : "pins"} to fix
            {fixedCount > 0 && (
              <span className="font-semibold text-emerald-600"> · {fixedCount} done</span>
            )}
          </p>
        </div>
      </div>

      {/* Pinterest-style pin grid. */}
      <div className="no-scrollbar flex-1 overflow-y-auto px-3 py-4">
        <div className="masonry-2 sm:masonry-3">
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
                aria-label={active ? "Current pin" : "Go to this pin"}
                className={`relative w-full overflow-hidden rounded-2xl transition active:scale-[0.98] ${
                  active
                    ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                    : "ring-1 ring-border"
                }`}
              >
                {cand.image_url ? (
                  <img
                    src={cand.image_url}
                    alt=""
                    draggable={false}
                    className={`w-full object-cover ${
                      status === "skipped" ? "opacity-40 grayscale" : ""
                    }`}
                  />
                ) : (
                  <div className="grid aspect-[3/4] w-full place-items-center bg-surface-2 text-muted-foreground">
                    <ImageIcon className="h-6 w-6" />
                  </div>
                )}

                {/* Title caption. */}
                <span className="absolute inset-x-0 bottom-0 line-clamp-1 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6 text-left text-[11px] font-semibold text-white">
                  {cand.title}
                </span>

                {/* Status badge. */}
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
