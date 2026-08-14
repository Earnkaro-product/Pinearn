import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  Check,
  CheckCheck,
  Coins,
  Eye,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  MousePointerClick,
  Pencil,
  RefreshCw,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import { GRADIENTS } from "./pins";
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
  maxPointsFor,
  PIN_DESC_MAX,
  PIN_DESC_MIN,
  PIN_TITLE_MAX,
  PIN_TITLE_MIN,
  pinSeoIssues,
  pointsEarned,
  pointsLabel,
  SCORE_CRITERIA,
  SUB_SCORE_WEIGHTS,
} from "@/lib/health-score";

// How to drive the deck — surfaced any time via the header's info button. Each
// step is one action, not a sentence explaining it: the reader is mid-flow with
// the controls in front of them, so naming the control is the whole instruction.
const PIN_GUIDE_STEPS = [
  "Tap pins to queue them, then Boost.",
  "Hold a pin to see what it's worth.",
  "Apply keeps the rewrite, Skip moves on.",
  "Edit the wording, or undo, anytime.",
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
            points={pointsEarned("pinSeo", flow.score)}
            maxPoints={maxPointsFor("pinSeo")}
            gained={pointsEarned("pinSeo", flow.gained)}
            approvedCount={flow.approvedCount}
            skippedCount={flow.skippedCount}
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
              label="Pin SEO"
              points={pointsEarned("pinSeo", flow.score)}
              maxPoints={maxPointsFor("pinSeo")}
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
              <div className="relative z-20 shrink-0 rounded-t-3xl bg-surface-2 px-4 pb-1.5 pt-4">
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
                  selected pin tab above. The card scrolls with its bar hidden,
                  so a fade over the last few pixels is the only thing telling
                  you there's more copy below the fold — without it the
                  description just looks truncated. */}
              <div className="relative z-10 min-h-0 flex-1">
                <div className="no-scrollbar h-full overflow-y-auto rounded-3xl border-2 border-primary bg-surface p-4 shadow-sm">
                  {current && (
                    <RewriteCard
                      card={current}
                      ai={currentAi}
                      onEdit={() => setEditing(true)}
                      onRegenerate={() => regenerate(current.id)}
                    />
                  )}
                </div>
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-[3px] bottom-[3px] h-7 rounded-b-[1.4rem] bg-gradient-to-t from-surface via-surface/85 to-transparent"
                />
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
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-4 py-3.5 text-lead font-extrabold text-primary-foreground shadow-glow transition disabled:opacity-60"
                >
                  {currentPending || currentGenerating ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Check className="h-5 w-5" strokeWidth={3} />
                  )}
                  {currentGenerating ? "Writing…" : !canAffordOne ? "Out of coins" : "Apply"}
                  {/* The price rides the button, so the cost of the tap is
                      visible at the moment of tapping rather than only in the
                      header balance. */}
                  {showCoinCost && canAffordOne && !currentGenerating && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-mini font-bold tabular-nums">
                      <Coins className="h-3 w-3" /> {COINS_PER_PIN_BOOST}
                    </span>
                  )}
                </motion.button>
              </div>

              {/* "Apply all 1" is the Apply button with extra
                  steps — a confirm sheet in front of the same single write. The
                  bulk path only earns its row once there's more than one left. */}
              {remaining.length > 1 && (
                <motion.button
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setConfirming(true)}
                  disabled={
                    flow.bulkApplying ||
                    preparingBulk ||
                    remaining.length === 0 ||
                    bulkCovered === 0
                  }
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-primary bg-surface px-3 py-3 text-body font-bold text-primary transition disabled:opacity-40"
                >
                  {preparingBulk ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Writing {bulkReady}/
                      {remaining.length}
                    </>
                  ) : (
                    <>
                      <CheckCheck className="h-4 w-4" />
                      {bulkCovered === 0
                        ? "Out of coins"
                        : bulkTrimmed
                          ? `Apply ${bulkCovered} of ${remaining.length}`
                          : `Apply all ${remaining.length}`}
                      {/* One coin per pin the batch will actually apply — the same
                        number the confirm sheet charges. */}
                      {showCoinCost && bulkCovered > 0 && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-mini font-bold tabular-nums ${
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
          heading="Pick pins to boost"
          points={pointsEarned("pinSeo", score)}
          maxPoints={maxPointsFor("pinSeo")}
          gainPoints={overallPointsFor(failingTotal, ranked.length)}
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
                <SuggestedRail
                  cards={suggested}
                  selected={selected}
                  onToggle={toggleOne}
                  onQueueAll={setMany}
                  flippedId={flippedId}
                  onFlip={(id) => setFlippedId((cur) => (cur === id ? null : id))}
                  statusById={statusById}
                  perPinPoints={perPinPoints}
                  score={score}
                />
              )}

              <QueueToolbar
                query={query}
                onQuery={(v) => {
                  setQuery(v);
                  setLimit(PIN_GRID_PAGE_SIZE);
                }}
                placeholder="Search pins…"
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
                  setLimit(PIN_GRID_PAGE_SIZE);
                }}
                allSelected={allVisibleSelected}
                onToggleAll={() => setMany(visibleIds, !allVisibleSelected)}
                toggleDisabled={visible.length === 0}
              />

              {/* The grid was unlabelled, which left the suggested rail and 300
                  more cards running together as one undifferentiated scroll.
                  Naming it is what makes the rail above read as a shortcut. */}
              {/* The count sat on the right of this row, but the filter chip
                  directly above already carries it — same number, twice. */}
              {shown.length > 0 && (
                <h3 className="pt-1 font-display text-lead font-bold tracking-tight">
                  {filter === "all"
                    ? "All pins"
                    : QUEUE_FILTERS.find((f) => f.key === filter)?.label}
                </h3>
              )}

              {shown.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
                  No pins match that.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-x-2.5 gap-y-1">
                  {shown.map((card, i) => (
                    <PinPickCard
                      key={card.id}
                      card={card}
                      index={i}
                      selected={selected.has(card.id)}
                      flipped={flippedId === card.id}
                      boosted={statusById[card.id] === "approved"}
                      points={card.issues.length > 0 ? perPinPoints : 0}
                      pointsNow={pointsEarned("pinSeo", score)}
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
                      className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border bg-surface/70 text-xs font-bold text-primary transition hover:bg-primary/[0.04]"
                    >
                      Show
                      <span className="font-semibold tabular-nums text-muted-foreground">
                        {hidden} more
                      </span>
                    </button>
                  )}
                  {limit > PIN_GRID_PAGE_SIZE && (
                    <button
                      type="button"
                      onClick={() => setLimit(PIN_GRID_PAGE_SIZE)}
                      className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface px-3.5 text-xs font-bold text-muted-foreground transition hover:text-foreground"
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
                <p className="rounded-2xl border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
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
                    <h3 className="mb-2 pt-1 font-display text-lead font-bold tracking-tight">
                      All boards
                    </h3>
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
        unit="pin"
        unitPlural="pins"
        emptyLabel="Select pins"
        selectedPoints={overallPointsFor(selectedFailing, ranked.length)}
        coins={boostCost(selectedIds.length)}
        onStart={() => selectedIds.length > 0 && onStart(selectedIds)}
        onClear={() => setSelected(new Set())}
      />
      {/* Cost of the selection, one line, under the CTA — enough to price the tap
          without turning the bar into a receipt. The coin count already rides
          the CTA, so this line only has to say what's left afterwards. */}
      {selectedIds.length > 0 && (
        <p
          className={`shrink-0 pb-1 text-center text-micro font-semibold ${
            selectedIds.length > balance ? "text-amber-700" : "text-muted-foreground/80"
          }`}
        >
          {selectedIds.length > balance ? (
            <>
              Only {balance} coins left · refills {resetCountdown()}
            </>
          ) : (
            <>{balance - selectedIds.length} coins left after this</>
          )}
        </p>
      )}
    </motion.div>
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
      className={`relative -mb-px px-1 pb-2.5 pt-1 text-lead font-semibold transition ${
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

/** The best wins, as a quiet rail of pictures. Rank #1 wears the trophy, and
 * each thumb carries the numbers it was ranked by — fixes and reach. Tapping
 * queues, the same gesture as everywhere else on the page. */
/** The shortcut, dressed as one. These are the pins worth fixing first, so the
 * rail is the page's primary action and now looks like it: a bordered, tinted
 * panel with a live pulse on the label and a one-tap "Queue top N".
 *
 * It used to be an unframed row of 78px thumbnails under a muted grey caption —
 * indistinguishable from a decorative carousel, and smaller than the grid it
 * was meant to shortcut past. Same cards as the grid now, at the same size, so
 * the eye reads them as "the same thing, pre-picked for you". */
function SuggestedRail({
  cards,
  selected,
  onToggle,
  onQueueAll,
  flippedId,
  onFlip,
  statusById,
  perPinPoints,
  score,
}: {
  cards: PinFixCard[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onQueueAll: (ids: string[], on: boolean) => void;
  flippedId: string | null;
  onFlip: (id: string) => void;
  statusById: Record<string, string | undefined>;
  perPinPoints: number;
  score: number;
}) {
  const ids = cards.map((c) => c.id);
  const allQueued = ids.length > 0 && ids.every((id) => selected.has(id));

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Suggested pins"
      className="relative overflow-hidden rounded-3xl border-2 border-primary/45 bg-gradient-to-b from-primary/[0.07] via-surface to-surface p-3.5 shadow-glow"
    >
      {/* Breathing border — the one ambient motion on the page, and it sits on
          the thing we want tapped. Slow and low-contrast on purpose: a hard
          blink next to 300 thumbnails would read as an error state. */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-3xl border-2 border-primary"
        animate={{ opacity: [0.35, 0.05, 0.35] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="relative mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-micro font-bold uppercase tracking-[0.14em] text-primary">
            <span className="relative grid h-1.5 w-1.5 place-items-center">
              <span className="absolute h-full w-full animate-ping rounded-full bg-primary/70" />
              <span className="h-full w-full rounded-full bg-primary" />
            </span>
            Start here
          </p>
          {/* The fix count lived here too, but every card in the rail already
              wears its own fix badge — this line was the same tally again. */}
          <h3 className="mt-1 font-display text-[17px] font-bold leading-tight tracking-tight">
            Your {cards.length} biggest wins
          </h3>
        </div>
        <button
          type="button"
          onClick={() => onQueueAll(ids, !allQueued)}
          className={`relative shrink-0 overflow-hidden rounded-full px-3.5 py-2 text-mini font-bold transition active:scale-[0.97] ${
            allQueued
              ? "bg-surface-2 text-muted-foreground ring-1 ring-border"
              : "bg-gradient-primary text-primary-foreground shadow-glow"
          }`}
        >
          {!allQueued && (
            <span
              aria-hidden
              className="animate-sheen pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/30 to-transparent"
            />
          )}
          {allQueued ? "Clear" : "Queue all"}
        </button>
      </div>

      {/* Same card, same size as the grid — just laid on a horizontal track.
          The width tracks the grid's own column width so the two never drift. */}
      <div className="no-scrollbar -mx-1 flex snap-x gap-2.5 overflow-x-auto px-1 pb-1">
        {cards.map((card, i) => (
          <div
            key={card.id}
            className="w-[calc((100vw-5rem)/2.4)] min-w-[124px] max-w-[162px] shrink-0 snap-start"
          >
            <PinPickCard
              card={card}
              index={i}
              rank={i + 1}
              selected={selected.has(card.id)}
              flipped={flippedId === card.id}
              boosted={statusById[card.id] === "approved"}
              points={card.issues.length > 0 ? perPinPoints : 0}
              pointsNow={pointsEarned("pinSeo", score)}
              onToggle={() => onToggle(card.id)}
              onFlip={() => onFlip(card.id)}
            />
          </div>
        ))}
      </div>
    </motion.section>
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
  const allIds = lanes.flatMap((l) => l.cards.map((c) => c.id));
  const allQueued = allIds.length > 0 && allIds.every((id) => selected.has(id));

  return (
    // Same panel as the pins rail. Two tabs of the same page cannot present
    // their shortcut two different ways — one bold and bordered, one a grey
    // caption — without the quieter one reading as broken.
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Suggested boards"
      className="relative overflow-hidden rounded-3xl border-2 border-primary/45 bg-gradient-to-b from-primary/[0.07] via-surface to-surface p-3.5 shadow-glow"
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-3xl border-2 border-primary"
        animate={{ opacity: [0.35, 0.05, 0.35] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="relative mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-micro font-bold uppercase tracking-[0.14em] text-primary">
            <span className="relative grid h-1.5 w-1.5 place-items-center">
              <span className="absolute h-full w-full animate-ping rounded-full bg-primary/70" />
              <span className="h-full w-full rounded-full bg-primary" />
            </span>
            Start here
          </p>
          <h3 className="mt-1 font-display text-[17px] font-bold leading-tight tracking-tight">
            Your {lanes.length} messiest {lanes.length === 1 ? "board" : "boards"}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => onToggleMany(allIds, !allQueued)}
          className={`relative shrink-0 overflow-hidden rounded-full px-3.5 py-2 text-mini font-bold transition active:scale-[0.97] ${
            allQueued
              ? "bg-surface-2 text-muted-foreground ring-1 ring-border"
              : "bg-gradient-primary text-primary-foreground shadow-glow"
          }`}
        >
          {!allQueued && (
            <span
              aria-hidden
              className="animate-sheen pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/30 to-transparent"
            />
          )}
          {allQueued ? "Clear" : "Queue all"}
        </button>
      </div>

      <div className="no-scrollbar -mx-1 flex snap-x gap-2.5 overflow-x-auto px-1 pb-1">
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
              className="w-[calc((100vw-5rem)/2.4)] min-w-[124px] max-w-[162px] shrink-0 snap-start text-left"
            >
              <div
                className={`relative overflow-hidden rounded-xl transition ${
                  on ? "ring-2 ring-primary" : "ring-1 ring-border/60"
                }`}
              >
                <div className="flex h-[104px] gap-0.5">
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
                <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded-full bg-black/45 px-1.5 py-0.5 text-nano font-bold text-white backdrop-blur-sm">
                  <Sparkles className="h-2 w-2 text-amber-300" /> {lane.fixes}
                </span>
                <span className="absolute right-1 top-1">
                  <SelectDot on={on} small />
                </span>
              </div>
              <p className="mt-1.5 line-clamp-2 px-0.5 text-mini font-semibold leading-[1.35]">
                {lane.name}
              </p>
              {/* The fix count is already the badge on the cover, so the caption
                  only carries what the picture can't: how big the board is. */}
              <p className="mt-0.5 px-0.5 text-micro font-semibold text-muted-foreground">
                {lane.cards.length} {lane.cards.length === 1 ? "pin" : "pins"}
              </p>
            </motion.button>
          );
        })}
      </div>
    </motion.section>
  );
}

/** One pin card — used BOTH in the suggested rail and in the grid below, which
 * is the point: the same pin was previously a 78px thumbnail up top and a
 * half-width card underneath, so the two read as different kinds of object and
 * the rail looked like decoration rather than the shortcut it is. One
 * component, one size, one set of affordances.
 *
 * Image-first, but no longer wordless: the title sits UNDER the photo where it
 * is always legible, rather than being the thing a shopper has to infer from a
 * cropped image. Overlaying it was never an option — half these pins are
 * photographs with text baked in.
 *
 * Hold it and the image flips to what fixing it adds to the health score. */
function PinPickCard({
  card,
  index,
  selected,
  flipped,
  boosted,
  points,
  pointsNow,
  onToggle,
  onFlip,
  rank,
}: {
  card: PinFixCard;
  index: number;
  selected: boolean;
  flipped: boolean;
  boosted: boolean;
  /** Pts fixing this one pin adds to the overall score. Zero when it already
   * passes — the rewrite is then a keyword play, not a score play. */
  points: number;
  /** Pin SEO's banked pts right now, so the flip side can show the move. */
  pointsNow: number;
  onToggle: () => void;
  onFlip: () => void;
  /** 1-based position in the suggested rail; adds the rank pip and, at 1, the
   * trophy. Absent in the grid, which has no meaningful order to advertise. */
  rank?: number;
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

          <div className="absolute left-2 top-2 flex items-center gap-1.5">
            {rank !== undefined &&
              (rank === 1 ? (
                <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground shadow">
                  <Trophy className="h-3 w-3" />
                </span>
              ) : (
                <span className="grid h-6 w-6 place-items-center rounded-full bg-black/50 text-micro font-bold text-white backdrop-blur-sm">
                  {rank}
                </span>
              ))}
            {boosted ? (
              <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white shadow">
                <Check className="h-3.5 w-3.5" strokeWidth={3.5} />
              </span>
            ) : fixes > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-micro font-bold text-white backdrop-blur-sm">
                <Sparkles className="h-3 w-3 text-amber-300" /> {fixes}{" "}
                {fixes === 1 ? "fix" : "fixes"}
              </span>
            ) : null}
          </div>

          <div className="absolute inset-x-2 bottom-2 flex items-center gap-2.5 text-mini font-bold text-white/95">
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
          {/* The unit rides the number instead of a caption line under it —
              three lines of text on a card read in half a second was one too
              many. */}
          <span className="font-display text-[28px] font-bold leading-none tabular-nums text-primary">
            {points > 0 ? `+${pointsLabel(points)}` : "+0"}
            <span className="ml-1 text-mini font-bold uppercase tracking-wide text-muted-foreground">
              pts
            </span>
          </span>
          <span className="text-mini font-semibold leading-snug text-muted-foreground">
            {points > 0 ? (
              <>
                {pointsLabel(pointsNow)} →{" "}
                <span className="text-emerald-600">
                  {pointsLabel(Math.min(maxPointsFor("pinSeo"), pointsNow + points))}
                </span>
              </>
            ) : (
              "Already passing"
            )}
          </span>
          {fixes > 0 && (
            <span className="line-clamp-2 px-1 text-micro font-medium leading-snug text-foreground/70">
              {card.issues.slice(0, 2).join(" · ")}
            </span>
          )}
        </button>
      </motion.div>

      {/* The copy, under the photo rather than over it. A pin's title is the
          thing being fixed, so hiding it behind a crop made the user pick
          blind — and half these images already have text baked in, which is
          why an overlay was never going to be legible. `h-8` reserves two
          lines whether or not the title fills them, so the grid stays on a
          rhythm instead of jostling row to row. */}
      <div className="mt-2 h-8 px-0.5">
        <p className="line-clamp-2 text-mini font-semibold leading-[1.35] text-foreground/90">
          {card.title?.trim() || <span className="text-muted-foreground">Untitled pin</span>}
        </p>
      </div>
      {/* What's actually weak about it — the reason it is in this list at all. */}
      <p className="mt-0.5 line-clamp-1 px-0.5 text-micro font-semibold text-amber-600/90">
        {fixes > 0 ? card.issues.slice(0, 2).join(" · ") : " "}
      </p>
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
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-nano font-bold text-white backdrop-blur-sm">
            <Eye className="h-2.5 w-2.5" /> {metricLabel(lane.impressions)}
          </span>
        )}
      </div>
      <div className="px-0.5 pt-1.5">
        <h4 className="line-clamp-1 text-xs font-bold">{lane.name}</h4>
        <p className="text-micro font-medium text-muted-foreground">
          {lane.cards.length} {lane.cards.length === 1 ? "pin" : "pins"}
          {lane.fixes > 0 && <> · {lane.fixes} fixes</>}
        </p>
      </div>
    </motion.button>
  );
}

/* The run is whatever the creator queued — the launch beat says its size, so
 * the transition confirms the selection landed. */
function PinLaunch({ card, count }: { card: PinFixCard; count: number }) {
  return (
    <LaunchScreen title={`${count} ${count === 1 ? "pin" : "pins"} queued`}>
      {card.image_url ? (
        <img src={card.image_url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center text-muted-foreground">
          <ImageIcon className="h-12 w-12" />
        </div>
      )}
    </LaunchScreen>
  );
}

/** The hero of the pin fix flow: what the copy is optimized for, then a
 * Now → AI comparison for the Title and Description. */
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

      {/* The keyword receipt sits under the copy it explains — the rewrite is
          what's being judged, so it leads; the trends behind it follow. While
          the pipeline runs, the same slot carries the progress ticker. */}
      {generating ? (
        <GeneratingNotice />
      ) : ai.status === "error" ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-mini font-semibold text-amber-800">Couldn&apos;t write this one</p>
          <p className="mt-0.5 text-mini leading-snug text-amber-700/80">Your pin is untouched.</p>
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
      <span className="absolute inset-x-0 bottom-0 grid place-items-center bg-black/55 py-0.5 text-nano font-bold uppercase tracking-wide text-white backdrop-blur-sm">
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
          <h3 className="truncate font-display text-lg font-bold leading-tight">Your pins</h3>
          <p className="text-xs text-muted-foreground">
            {cards.length} {cards.length === 1 ? "pin" : "pins"}
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
                <span className="absolute inset-x-0 bottom-0 line-clamp-1 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6 text-left text-mini font-semibold text-white">
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
