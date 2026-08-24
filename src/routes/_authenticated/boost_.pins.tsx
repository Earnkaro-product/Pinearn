import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { notifyBlocked, notifyProblem } from "@/lib/notify";
import {
  Check,
  CheckCheck,
  ChevronDown,
  Clock3,
  Coins,
  Eye,
  EyeOff,
  Flame,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  MousePointerClick,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { GRADIENTS } from "./pins";
import { AppShell } from "@/components/app-shell";
import {
  LaunchScreen,
  PickerHeader,
  QueueToolbar,
  ReviewProgressHeader,
  SelectDot,
  SelectionBar,
} from "@/components/boost-picker-kit";
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
import {
  ANALYTICS_WINDOW_DAYS,
  buildImpactContext,
  ctrLabel,
  DIAGNOSIS_META,
  GROUP_META,
  IMPACT_CRITERIA,
  reachLabel,
  scorePins,
  type PinImpact,
} from "@/lib/pin-impact";

// How to drive the deck — surfaced any time via the header's info button. Each
// step is one action, not a sentence explaining it: the reader is mid-flow with
// the controls in front of them, so naming the control is the whole instruction.
const PIN_GUIDE_STEPS = [
  "Start with High impact — that's where the reach is.",
  "Tap pins to queue them, then Boost.",
  "Apply keeps the rewrite, Skip moves on.",
  "Edit the wording, or undo, anytime.",
];

// Filmstrip sizing — mirrors the board review navigator so the two flows feel
// like one product.
const NAV_SLOT = 72; // px per pin slot (56px pin + spacing + room to enlarge)
const NAV_VISIBLE = 4; // whole pins visible at once

// Picker sizing. The deck can be hundreds of pins, so every section reveals a
// page at a time instead of mounting all of them the moment the screen opens —
// a 300-card grid built in one commit is a visible jank on a phone. The
// shortlist needs no cap here: pin-impact.ts caps the high tier itself.
const PIN_GRID_PAGE_SIZE = 14;
const BOARD_LIST_PAGE_SIZE = 8;

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
  /** Why this pin is worth rewriting, and how much. Computed once at deck
   * build so the picker, the ranking and the review header all read the same
   * verdict — see lib/pin-impact.ts. */
  impact: PinImpact;
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
  // ONLY the failing pins. A pin that already passes has no points to give,
  // and offering to "fix" it reads as noise (or worse, as an invitation to
  // break something that's working) — so it simply isn't on this screen. When
  // nothing fails, the deck is empty and the page shows the optimized state.
  const boardNames = new Map(data.boards.map((b) => [b.id, b.name]));

  // Context comes from EVERY pin, not just the failing ones. The yardsticks are
  // "what does reach look like on this account" and "what does a pin on this
  // board get when it lands" — and the pins that answer those questions best
  // are precisely the healthy ones this deck excludes.
  const impactPins = data.pins.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    impressions: p.impressions ?? 0,
    clicks: p.clicks ?? 0,
    boardId: boardIdOf(p),
    createdAt: p.created_at,
  }));
  const impacts = scorePins(impactPins, buildImpactContext(impactPins));

  // Ranked by opportunity, not by how broken the copy is. Issue count was the
  // old sort and it's the wrong signal on its own: three failing checks on a
  // pin nobody sees is worth less than one on a pin with 5K views behind it,
  // and a pin that's already converting belongs at the BOTTOM however many
  // bands it technically misses. Ties break newest-first (the array arrives
  // sorted that way) so a run always opens on the freshest of equals.
  return data.pins
    .filter((p) => pinSeoIssues(p).length > 0)
    .map((p) => ({
      id: p.id,
      title: p.title?.trim() || "Untitled pin",
      issues: pinSeoIssues(p),
      image_url: p.image_url,
      impressions: p.impressions ?? 0,
      clicks: p.clicks ?? 0,
      boardId: boardIdOf(p),
      boardName: boardIdOf(p) ? (boardNames.get(boardIdOf(p) as string) ?? null) : null,
      createdAt: p.created_at,
      impact: impacts.get(p.id)!,
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
    }))
    .sort((a, b) => b.impact.score - a.impact.score);
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
      else notifyProblem("Rewrite saved, but the coin couldn't be charged");
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
  // Analytics sync in batches and `impressions` defaults to 0, so an all-zero
  // account means "not synced yet", not "nobody looked". The picker has to say
  // which, because without reach the ranking is copy quality alone.
  const hasAnalytics = useMemo(
    () => (flow.data?.pins ?? []).some((p) => (p.impressions ?? 0) > 0),
    [flow.data],
  );
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
      // A run that stopped short has to stay on screen: the pins it couldn't
      // reach are still sitting in the deck, and a creator who missed a 2.5s
      // toast reads that as the bulk button having half-failed.
      notifyBlocked(
        `Boosted ${covered.length} of ${queued.length} pins`,
        "That's every pin this week's coins cover. The rest stay queued until the refill.",
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
          notifyProblem("You're out of coins — boosting a pin costs 1 coin");
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
            totalPins={flow.data?.pins.length ?? flow.cards.length}
            score={flow.score}
            statusById={flow.statusById}
            hasAnalytics={hasAnalytics}
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
            // Passing the check is one thing; being worth a rewrite is another,
            // and the ranking on this page is the second one. It has to be
            // auditable or the order reads as arbitrary.
            extra={{
              title: "How we rank them",
              body: `Every failing pin gets an impact score out of 100. Views are from the last ${ANALYTICS_WINDOW_DAYS} days.`,
              bullets: IMPACT_CRITERIA,
            }}
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

/* ------------------------------------------------------------------ *
 * The picker — where a run gets built.
 *
 * The job of this screen is one decision: which pins get a coin and a rewrite.
 * So the page is exactly three blocks, in the order a first-time visitor
 * should think about them:
 *
 *   1. Fix these first — the top handful by modelled impact (lib/pin-impact.ts
 *      caps the tier at HIGH_IMPACT_COUNT, so it is a real shortlist, never
 *      277 of 289). Full-width rows, each stating its own reason.
 *   2. All pins — the full inventory as a grid, with search and sort for
 *      anyone hunting a specific pin.
 *   3. Already working — collapsed, hands-off: these convert above the
 *      account's own median, and rewriting them risks resetting that.
 *
 * A previous iteration added a three-tile summary, six diagnosis filter
 * chips, and four collapsible tiers on top of this. All of it was navigation
 * for a decision the ranking had already made — six rows of chrome before the
 * first pin. Tap to queue, one CTA at the bottom. That's the page.
 * ------------------------------------------------------------------ */

// Fixing one failing pin moves Pin SEO by 1/total of its 100 points, and Pin
// SEO is worth SUB_SCORE_WEIGHTS.pinSeo of the overall score. `totalPins` is
// ALL pins on the account, not just the failing ones on this screen — the
// pass rate is measured against everything, so the denominator must be too.
//
// Note this is deliberately FLAT per pin: the Boost Score is a pass rate, so
// every pin that flips from fail to pass is worth exactly as much as any other.
// The thing that varies pin to pin is the traffic, which is what the impact
// score and the modelled reach lift are for. Presenting the pts as if they
// varied would be the easy lie; showing both numbers is the honest version.
function overallPointsFor(failingCount: number, totalPins: number): number {
  if (totalPins === 0) return 0;
  return SUB_SCORE_WEIGHTS.pinSeo * (failingCount / totalPins) * 100;
}

/** Reach a rewrite is modelled to unlock across a set of pins. Null when the
 * account has no analytics at all, so the UI can stay quiet instead of
 * printing a confident zero. */
function liftOf(cards: PinFixCard[]): number | null {
  const known = cards.filter((c) => c.impact.reachLift !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, c) => sum + (c.impact.reachLift ?? 0), 0);
}

type SortKey = "impact" | "reach" | "impressions" | "clicks" | "newest";

const SORT_OPTIONS: {
  key: SortKey;
  label: string;
  compare: (a: PinFixCard, b: PinFixCard) => number;
}[] = [
  {
    key: "impact",
    label: "Biggest win",
    compare: (a, b) => b.impact.score - a.impact.score,
  },
  {
    key: "reach",
    label: "Most views to gain",
    compare: (a, b) => (b.impact.reachLift ?? -1) - (a.impact.reachLift ?? -1),
  },
  {
    key: "impressions",
    label: "Most views today",
    compare: (a, b) => b.impressions - a.impressions,
  },
  { key: "clicks", label: "Most clicks", compare: (a, b) => b.clicks - a.clicks },
  {
    key: "newest",
    label: "Newest first",
    compare: (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  },
];

const DIAGNOSIS_ICON: Record<PinImpact["diagnosis"], typeof Eye> = {
  untapped: TrendingUp,
  audition: Clock3,
  invisible: EyeOff,
  working: ShieldCheck,
};

/** Every pin grouped under the board it actually lives on, best opportunity
 * first. Queueing a board is the shortest path from "this board is a mess" to a
 * run that fixes it end to end. */
type BoardLane = {
  id: string;
  name: string;
  cards: PinFixCard[];
  fixes: number;
  impressions: number;
  /** Pins in this board's queue that are the account's top opportunities. */
  highCount: number;
  /** Modelled reach a full-board rewrite unlocks. */
  lift: number | null;
  images: string[];
};

function buildBoardLanes(cards: PinFixCard[]): BoardLane[] {
  const byId = new Map<string, PinFixCard[]>();
  for (const c of cards) {
    if (!c.boardId || !c.boardName) continue;
    const bucket = byId.get(c.boardId);
    if (bucket) bucket.push(c);
    else byId.set(c.boardId, [c]);
  }
  return (
    [...byId.entries()]
      .map(([id, group]) => ({
        id,
        name: group[0].boardName as string,
        cards: group,
        fixes: group.reduce((n, c) => n + c.issues.length, 0),
        impressions: group.reduce((n, c) => n + c.impressions, 0),
        highCount: group.filter((c) => c.impact.group === "high").length,
        lift: liftOf(group),
        images: group
          .map((c) => c.image_url)
          .filter(Boolean)
          .slice(0, 3) as string[],
      }))
      // Boards where the wins are, not boards with the most broken fields.
      .sort(
        (a, b) =>
          b.highCount - a.highCount ||
          (b.lift ?? 0) - (a.lift ?? 0) ||
          b.impressions - a.impressions,
      )
  );
}

function PinBoostPicker({
  cards,
  totalPins,
  score,
  statusById,
  hasAnalytics,
  onStart,
  onGuide,
}: {
  cards: PinFixCard[];
  /** Every pin on the account — the denominator the pass rate is scored on.
   * `cards` is only the failing subset. */
  totalPins: number;
  score: number;
  statusById: Record<string, "approved" | "skipped">;
  /** False when no pin carries a reach reading, i.e. analytics haven't synced.
   * The page says so rather than presenting default zeros as measurements. */
  hasAnalytics: boolean;
  onStart: (ids: string[]) => void;
  onGuide: () => void;
}) {
  // Read-only here: the picker prices a run but never charges one. Coins are
  // debited per pin as its rewrite is applied, inside the run.
  const { balance } = useWallet();
  const [tab, setTab] = useState<"pins" | "boards">("pins");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [sort, setSort] = useState<SortKey>("impact");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PIN_GRID_PAGE_SIZE);
  const [boardLimit, setBoardLimit] = useState(BOARD_LIST_PAGE_SIZE);
  const [workingOpen, setWorkingOpen] = useState(false);

  // Ranked once — the run order for everything on this screen, so "biggest win
  // first" holds whether the creator queued the shortlist, a search result, a
  // board, or a mix.
  const ranked = useMemo(() => [...cards].sort((a, b) => b.impact.score - a.impact.score), [cards]);
  const lanes = useMemo(() => buildBoardLanes(ranked), [ranked]);

  // The three blocks. `rest` keeps the shortlist pins too — "All pins" is the
  // inventory, and an inventory with silent holes reads as a bug.
  const best = useMemo(() => ranked.filter((c) => c.impact.group === "high"), [ranked]);
  const working = useMemo(() => ranked.filter((c) => c.impact.protect), [ranked]);
  const rest = useMemo(() => ranked.filter((c) => !c.impact.protect), [ranked]);

  const searching = query.trim().length > 0;

  const visible = useMemo(() => {
    const compare = SORT_OPTIONS.find((o) => o.key === sort)!.compare;
    const q = query.trim().toLowerCase();
    return rest
      .filter(
        (c) =>
          !q ||
          (c.original.title ?? "").toLowerCase().includes(q) ||
          (c.boardName ?? "").toLowerCase().includes(q),
      )
      .sort(compare);
  }, [rest, sort, query]);

  const shown = visible.slice(0, limit);
  const hidden = visible.length - shown.length;

  // Selection is a set of ids; every list on the page reads and writes it, and
  // the run is always played back in impact order regardless of how it was
  // built.
  const selectedIds = useMemo(
    () => ranked.filter((c) => selected.has(c.id)).map((c) => c.id),
    [ranked, selected],
  );
  const selectedCards = useMemo(() => ranked.filter((c) => selected.has(c.id)), [ranked, selected]);
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

  const perPinPoints = overallPointsFor(1, totalPins);

  // The queue's own summary, which is what the bottom bar and its caption say.
  const selectedLift = liftOf(selectedCards);
  const protectedInQueue = selectedCards.filter((c) => c.impact.protect).length;

  // The empty CTA is an ACTION, not a label. "Select pins" told a creator
  // staring at 289 thumbnails to make the exact decision they'd opened the
  // page unable to make; this makes it for them, off the same ranking the page
  // is sorted by, and they can still unpick it.
  const headlineIds = best.map((c) => c.id);

  return (
    <motion.div
      key="pin-picker"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="no-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto px-1 pb-2">
        <PickerHeader
          heading="Pick pins to boost"
          points={pointsEarned("pinSeo", score)}
          maxPoints={maxPointsFor("pinSeo")}
          gainPoints={overallPointsFor(ranked.length, totalPins)}
          onGuide={onGuide}
          note={
            best.length > 0 ? (
              <>
                Pinterest finds pins by their words, and {ranked.length} of your {totalPins}{" "}
                aren&apos;t giving it enough. Start with the {best.length} below — they&apos;re
                where the reach is.
              </>
            ) : undefined
          }
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
              className="space-y-5"
            >
              {!hasAnalytics && <NoAnalyticsNote />}

              {/* 1 — the shortlist. Hidden while searching: a search means the
                  creator knows what they want, and the shortlist reshuffling
                  above their results is noise. */}
              {best.length > 0 && !searching && (
                <section
                  aria-label={GROUP_META.high.label}
                  className="overflow-hidden rounded-3xl border-2 border-primary/40 bg-gradient-to-b from-primary/[0.06] to-surface p-3.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="flex items-center gap-1.5 font-display text-[17px] font-bold leading-tight tracking-tight">
                        <Flame className="h-4 w-4 text-primary" strokeWidth={2.5} />
                        {GROUP_META.high.label}
                      </h3>
                      <p className="mt-0.5 text-mini text-muted-foreground">
                        {GROUP_META.high.blurb}
                      </p>
                    </div>
                    <QueueAllButton
                      ids={headlineIds}
                      selected={selected}
                      onQueueMany={setMany}
                      hero
                    />
                  </div>
                  <div className="mt-3 space-y-2">
                    {best.map((card, i) => (
                      <ImpactRow
                        key={card.id}
                        card={card}
                        index={i}
                        selected={selected.has(card.id)}
                        boosted={statusById[card.id] === "approved"}
                        points={perPinPoints}
                        onToggle={() => toggleOne(card.id)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* 2 — the inventory. */}
              <section aria-label="All pins">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-lead font-bold tracking-tight">
                    {searching ? "Results" : "All pins"}{" "}
                    <span className="text-mini font-semibold text-muted-foreground tabular-nums">
                      {visible.length}
                    </span>
                  </h3>
                  <QueueAllButton
                    ids={visible.map((c) => c.id)}
                    selected={selected}
                    onQueueMany={setMany}
                  />
                </div>

                <div className="mb-3">
                  <QueueToolbar
                    query={query}
                    onQuery={(v) => {
                      setQuery(v);
                      setLimit(PIN_GRID_PAGE_SIZE);
                    }}
                    placeholder="Search pins…"
                    sort={sort}
                    onSort={(v) => {
                      setSort(v);
                      setLimit(PIN_GRID_PAGE_SIZE);
                    }}
                    options={SORT_OPTIONS}
                    neutralSort="impact"
                  />
                </div>

                {shown.length === 0 ? (
                  <EmptyNote>No pins match that.</EmptyNote>
                ) : (
                  <PinGrid
                    cards={shown}
                    selected={selected}
                    statusById={statusById}
                    perPinPoints={perPinPoints}
                    onToggle={toggleOne}
                  />
                )}

                <ShowMore
                  hidden={hidden}
                  expanded={limit > PIN_GRID_PAGE_SIZE}
                  onMore={() => setLimit((l) => l + PIN_GRID_PAGE_SIZE * 2)}
                  onCollapse={() => setLimit(PIN_GRID_PAGE_SIZE)}
                />
              </section>

              {/* 3 — hands-off. Collapsed, and with no queue-all: the whole
                  point of the group is that we're advising against it. */}
              {working.length > 0 && !searching && (
                <section aria-label={GROUP_META.working.label}>
                  <button
                    type="button"
                    onClick={() => setWorkingOpen((v) => !v)}
                    aria-expanded={workingOpen}
                    className="flex w-full items-center gap-2 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3 text-left"
                  >
                    <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-700" strokeWidth={2.5} />
                    <div className="min-w-0 flex-1">
                      <p className="text-body font-bold text-emerald-900">
                        {GROUP_META.working.label}{" "}
                        <span className="font-semibold tabular-nums opacity-70">
                          {working.length}
                        </span>
                      </p>
                      <p className="text-mini text-emerald-900/70">{GROUP_META.working.blurb}</p>
                    </div>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-emerald-700 transition-transform ${
                        workingOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {workingOpen && (
                      <motion.div
                        key="working-grid"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="pt-3">
                          <PinGrid
                            cards={working}
                            selected={selected}
                            statusById={statusById}
                            perPinPoints={perPinPoints}
                            onToggle={toggleOne}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="tab-boards"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-3"
            >
              {lanes.length === 0 ? (
                <EmptyNote>No boards to fix.</EmptyNote>
              ) : (
                <>
                  <p className="text-mini leading-snug text-muted-foreground">
                    One tap queues every pin on a board. Best boards first.
                  </p>
                  <div className="space-y-2">
                    {lanes.slice(0, boardLimit).map((lane, i) => {
                      const ids = lane.cards.map((c) => c.id);
                      const queued = ids.every((id) => selected.has(id));
                      return (
                        <BoardLaneRow
                          key={lane.id}
                          lane={lane}
                          index={i}
                          queued={queued}
                          onToggle={() => setMany(ids, !queued)}
                        />
                      );
                    })}
                  </div>
                  <ShowMore
                    hidden={lanes.length - Math.min(lanes.length, boardLimit)}
                    expanded={boardLimit > BOARD_LIST_PAGE_SIZE}
                    onMore={() => setBoardLimit((l) => l + BOARD_LIST_PAGE_SIZE * 2)}
                    onCollapse={() => setBoardLimit(BOARD_LIST_PAGE_SIZE)}
                  />
                </>
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
        selectedPoints={overallPointsFor(selectedIds.length, totalPins)}
        coins={boostCost(selectedIds.length)}
        // The run's headline win rides the button itself: it's the answer to
        // "why tap this", so it can't be a caption two lines away.
        reward={
          selectedLift !== null && selectedLift > 0
            ? `≈ +${reachLabel(selectedLift)} views`
            : undefined
        }
        emptyAction={
          headlineIds.length > 0
            ? {
                label: `Boost my top ${headlineIds.length}`,
                onClick: () => setMany(headlineIds, true),
              }
            : undefined
        }
        onStart={() => selectedIds.length > 0 && onStart(selectedIds)}
        onClear={() => setSelected(new Set())}
      />

      {/* Below the button, ONLY what the creator might change their mind over:
          a warning, never a restatement. The wins and the price are already on
          the button. */}
      {selectedIds.length > 0 && (protectedInQueue > 0 || selectedIds.length > balance) && (
        <div className="shrink-0 space-y-0.5 pb-1 text-center">
          {protectedInQueue > 0 && (
            <p className="text-micro font-semibold text-emerald-700">
              {protectedInQueue} of these {protectedInQueue === 1 ? "is" : "are"} already working —
              we&apos;d leave {protectedInQueue === 1 ? "it" : "them"} out
            </p>
          )}
          {selectedIds.length > balance && (
            <p className="text-micro font-semibold text-amber-700">
              Only {balance} coins left — covers {balance} of {selectedIds.length} · refills{" "}
              {resetCountdown()}
            </p>
          )}
        </div>
      )}
    </motion.div>
  );
}

/** The one queue-many affordance, shared by the shortlist and the inventory so
 * the page has a single vocabulary for "take all of these". */
function QueueAllButton({
  ids,
  selected,
  onQueueMany,
  hero,
}: {
  ids: string[];
  selected: Set<string>;
  onQueueMany: (ids: string[], on: boolean) => void;
  hero?: boolean;
}) {
  if (ids.length === 0) return null;
  const allQueued = ids.every((id) => selected.has(id));
  return (
    <button
      type="button"
      onClick={() => onQueueMany(ids, !allQueued)}
      className={`shrink-0 rounded-full px-3 py-1.5 text-mini font-bold transition active:scale-[0.97] ${
        allQueued
          ? "bg-surface-2 text-muted-foreground ring-1 ring-border"
          : hero
            ? "bg-gradient-primary text-primary-foreground shadow-glow"
            : "bg-primary/10 text-primary hover:bg-primary/15"
      }`}
    >
      {allQueued ? "Clear" : `Queue all ${ids.length}`}
    </button>
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

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-border py-10 text-center text-mini font-medium text-muted-foreground">
      {children}
    </p>
  );
}

/** Analytics sync in batches and the impressions column defaults to zero, so
 * "every pin has no reach" is ambiguous between "not synced yet" and "nobody
 * looked". Saying which one it is matters here more than anywhere else on the
 * page: without reach, the ranking is copy quality alone, and a creator who
 * doesn't know that will read the order as a claim about their traffic. */
function NoAnalyticsNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <Eye className="mt-px h-4 w-4 shrink-0 text-amber-700" />
      <p className="text-mini leading-snug text-amber-900/85">
        <span className="font-bold">No view counts yet.</span> Until Pinterest analytics sync, these
        are ranked on copy quality alone — reach and click rates will sharpen the order once they
        land.
      </p>
    </div>
  );
}

/**
 * A shortlist pin, as a row that argues its own case.
 *
 * Everything on it is a number the creator can check against Pinterest: views
 * in the window, click rate when there's enough traffic to mean anything, the
 * diagnosis that put it in this tier, and what a rewrite is modelled to buy.
 */
function ImpactRow({
  card,
  index,
  selected,
  boosted,
  points,
  onToggle,
}: {
  card: PinFixCard;
  index: number;
  selected: boolean;
  boosted: boolean;
  points: number;
  onToggle: () => void;
}) {
  const { impact } = card;
  const DiagIcon = DIAGNOSIS_ICON[impact.diagnosis];
  return (
    <motion.button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={`${selected ? "Remove" : "Queue"} ${card.title}`}
      whileTap={{ scale: 0.985 }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 6) * 0.04, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className={`flex w-full items-stretch gap-3 rounded-2xl border-2 bg-surface p-2 text-left transition ${
        selected ? "border-primary shadow-sm" : "border-transparent ring-1 ring-border/70"
      }`}
    >
      <div className="relative h-[86px] w-[68px] shrink-0 overflow-hidden rounded-xl bg-surface-2">
        <PinImage card={card} />
        {boosted && (
          <span className="absolute inset-0 grid place-items-center bg-emerald-500/75 text-white">
            <Check className="h-5 w-5" strokeWidth={3.5} />
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
        <div className="min-w-0">
          <p className="line-clamp-1 text-body font-bold leading-tight">
            {card.title?.trim() || <span className="text-muted-foreground">Untitled pin</span>}
          </p>
          {/* The measurement, then the reason. Two lines, and they are the
              whole argument for spending a coin here. */}
          <p className="mt-1 inline-flex items-center gap-1 text-mini font-bold text-foreground/80">
            <DiagIcon className="h-3 w-3 shrink-0 text-primary" strokeWidth={2.5} />
            <span className="truncate">{impact.headline}</span>
          </p>
          <p className="mt-0.5 line-clamp-2 text-micro leading-snug text-muted-foreground">
            {impact.detail}
          </p>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {impact.reachLift !== null && impact.reachLift > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-micro font-bold text-primary">
              <TrendingUp className="h-2.5 w-2.5" /> ≈ +{reachLabel(impact.reachLift)} views
            </span>
          )}
          <span className="text-micro font-semibold text-muted-foreground tabular-nums">
            +{pointsLabel(points)} pts
          </span>
          <span className="ml-auto shrink-0">
            <SelectDot on={selected} small />
          </span>
        </div>
      </div>
    </motion.button>
  );
}

function PinGrid({
  cards,
  selected,
  statusById,
  perPinPoints,
  onToggle,
}: {
  cards: PinFixCard[];
  selected: Set<string>;
  statusById: Record<string, string | undefined>;
  perPinPoints: number;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
      {cards.map((card, i) => (
        <PinPickCard
          key={card.id}
          card={card}
          index={i}
          selected={selected.has(card.id)}
          boosted={statusById[card.id] === "approved"}
          points={perPinPoints}
          onToggle={() => onToggle(card.id)}
        />
      ))}
    </div>
  );
}

function ShowMore({
  hidden,
  expanded,
  onMore,
  onCollapse,
}: {
  hidden: number;
  expanded: boolean;
  onMore: () => void;
  onCollapse: () => void;
}) {
  if (hidden <= 0 && !expanded) return null;
  return (
    <div className="mt-2.5 flex gap-2">
      {hidden > 0 && (
        <button
          type="button"
          onClick={onMore}
          className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border bg-surface/70 text-mini font-bold text-primary transition hover:bg-primary/[0.04]"
        >
          Show
          <span className="font-semibold tabular-nums text-muted-foreground">{hidden} more</span>
        </button>
      )}
      {expanded && (
        <button
          type="button"
          onClick={onCollapse}
          className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface px-3.5 text-mini font-bold text-muted-foreground transition hover:text-foreground"
        >
          Collapse
        </button>
      )}
    </div>
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

/**
 * One pin in a grid — the compact form, for the inventory where the decision
 * is "sweep it or don't".
 *
 * The badge carries the diagnosis in two words, the metrics ride the photo's
 * bottom edge, and the value of the fix is printed under the title. No hidden
 * gestures — everything the ranking knows is on the card.
 */
function PinPickCard({
  card,
  index,
  selected,
  boosted,
  points,
  onToggle,
}: {
  card: PinFixCard;
  index: number;
  selected: boolean;
  boosted: boolean;
  /** Pts fixing this one pin adds to the overall score. Every card here is a
   * failing pin, so this is never zero. */
  points: number;
  onToggle: () => void;
}) {
  const { impact } = card;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.03, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selected ? "Remove" : "Queue"} ${card.title} — ${impact.headline}`}
        onClick={onToggle}
        className={`relative aspect-[3/4] w-full touch-manipulation select-none overflow-hidden rounded-xl bg-surface-2 text-left transition ${
          selected ? "shadow-elevate ring-2 ring-primary" : "ring-1 ring-border/60"
        }`}
      >
        <PinImage card={card} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />

        <span className="absolute right-2 top-2">
          <SelectDot on={selected} />
        </span>

        <div className="absolute left-2 top-2">
          {boosted ? (
            <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white shadow">
              <Check className="h-3.5 w-3.5" strokeWidth={3.5} />
            </span>
          ) : (
            <span className="inline-flex max-w-[110px] items-center rounded-full bg-black/50 px-2 py-0.5 text-nano font-bold text-white backdrop-blur-sm">
              <span className="truncate">{DIAGNOSIS_META[impact.diagnosis].label}</span>
            </span>
          )}
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

      {/* Title, then what the fix is worth. Both under the photo rather than
          over it: half these images have text baked in, so an overlay was never
          going to be legible. `h-4` on the value line keeps the grid on a
          rhythm whether or not a reach estimate exists. */}
      <div className="mt-1.5 px-0.5">
        <p className="line-clamp-2 h-8 text-mini font-semibold leading-[1.35] text-foreground/90">
          {card.title?.trim() || <span className="text-muted-foreground">Untitled pin</span>}
        </p>
        <p className="mt-0.5 flex h-4 items-center gap-1.5 text-micro font-bold tabular-nums">
          {impact.reachLift !== null && impact.reachLift > 0 ? (
            <span className="text-primary">≈ +{reachLabel(impact.reachLift)} views</span>
          ) : (
            <span className="text-muted-foreground">+{pointsLabel(points)} pts</span>
          )}
        </p>
      </div>
    </motion.div>
  );
}

/** A board as a full-width row: cover collage, then the two numbers that decide
 * whether to queue it — how many of the account's best opportunities live on
 * it, and the reach a whole-board rewrite is modelled to unlock. */
function BoardLaneRow({
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
      aria-label={`${queued ? "Remove" : "Queue"} board ${lane.name}`}
      whileTap={{ scale: 0.985 }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.035, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className={`flex w-full items-center gap-3 rounded-2xl border-2 bg-surface p-2 text-left transition ${
        queued ? "border-primary shadow-sm" : "border-transparent ring-1 ring-border/70"
      }`}
    >
      <div className="flex h-16 w-[68px] shrink-0 gap-0.5 overflow-hidden rounded-xl">
        <div className={`relative flex-[2] bg-gradient-to-br ${grad}`}>
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

      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-body font-bold leading-tight">{lane.name}</p>
        <p className="mt-0.5 text-mini font-semibold text-muted-foreground">
          {lane.cards.length} to rewrite
          {lane.impressions > 0 && <> · {metricLabel(lane.impressions)} views</>}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {lane.highCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-micro font-bold text-primary">
              <Flame className="h-2.5 w-2.5" /> {lane.highCount} top pick
              {lane.highCount === 1 ? "" : "s"}
            </span>
          )}
          {lane.lift !== null && lane.lift > 0 && (
            <span className="text-micro font-bold text-primary tabular-nums">
              ≈ +{reachLabel(lane.lift)} views
            </span>
          )}
        </div>
      </div>

      <span className="shrink-0 pr-0.5">
        <SelectDot on={queued} />
      </span>
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

/** The one-line case for rewriting THIS pin, carried from the picker into the
 * run: the diagnosis, the measurement behind it, and what a rewrite is
 * modelled to unlock. A working pin gets the amber treatment instead — the run
 * doesn't block it, but it says out loud that this one was fine. */
function ImpactStrip({ impact }: { impact: PinImpact }) {
  const Icon = DIAGNOSIS_ICON[impact.diagnosis];
  const meta = DIAGNOSIS_META[impact.diagnosis];
  return (
    <div
      className={`rounded-2xl p-2.5 ring-1 ${
        impact.protect ? "bg-amber-500/[0.07] ring-amber-500/25" : "bg-surface-2/70 ring-border/70"
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${impact.protect ? "text-amber-700" : "text-primary"}`}
          strokeWidth={2.5}
        />
        <p
          className={`min-w-0 flex-1 truncate text-mini font-bold ${
            impact.protect ? "text-amber-900" : "text-foreground"
          }`}
        >
          {meta.label} · {impact.headline}
        </p>
        {impact.reachLift !== null && impact.reachLift > 0 && !impact.protect && (
          <span className="shrink-0 text-mini font-bold tabular-nums text-primary">
            ≈ +{reachLabel(impact.reachLift)} views
          </span>
        )}
      </div>
      <p
        className={`mt-1 text-micro leading-snug ${
          impact.protect ? "text-amber-900/80" : "text-muted-foreground"
        }`}
      >
        {impact.detail}
      </p>
    </div>
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
      {/* Why this pin is in the run at all. The picker made the argument; the
          review surface has to repeat it, because by the time a creator is
          three cards deep they've lost the tier they queued from — and a
          rewrite you can't remember the reason for is one you skip. */}
      <ImpactStrip impact={card.impact} />

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
