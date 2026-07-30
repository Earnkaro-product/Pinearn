import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  BarChart3,
  Check,
  CheckCheck,
  Eye,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Loader2,
  MousePointerClick,
  Pencil,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Trophy,
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
import { useFixFlow, type BaseFixCard, type FixField } from "@/hooks/use-fix-flow";
import { useAiRewrites, type AiRewriteState } from "@/hooks/use-ai-rewrites";
import {
  resolvePinSeoSuggestion,
  suggestPinSeo,
  type SuggestSeoResult,
} from "@/lib/pin-seo.functions";
import type { HealthData } from "@/hooks/use-health-score";
import {
  byIssueCountDesc,
  PIN_DESC_MAX,
  PIN_DESC_MIN,
  PIN_TITLE_MAX,
  PIN_TITLE_MIN,
  pinSeoIssues,
  SCORE_CRITERIA,
} from "@/lib/health-score";

// How to drive the deck — surfaced any time via the header's "How it works".
const PIN_GUIDE_STEPS = [
  "Tap Apply fix to accept the suggested rewrite for the current pin.",
  "Tap Skip to leave a pin untouched and move on.",
  "Tap Edit to adjust the wording before you apply it.",
  "Jump between pins from the strip up top — and undo any fix anytime.",
];

// Filmstrip sizing — mirrors the board review navigator so the two flows feel
// like one product.
const NAV_SLOT = 72; // px per pin slot (56px pin + spacing + room to enlarge)
const NAV_VISIBLE = 4; // whole pins visible at once
const PIN_PICKER_PREVIEW_COUNT = 5;

export const Route = createFileRoute("/_authenticated/boost_/pins")({
  component: FixPinSeoPage,
});

type PinFixCard = BaseFixCard & {
  image_url: string | null;
  impressions: number;
  clicks: number;
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
  return byIssueCountDesc(data.pins, pinSeoIssues).map((p) => ({
    id: p.id,
    title: p.title?.trim() || "Untitled pin",
    issues: pinSeoIssues(p),
    image_url: p.image_url,
    impressions: p.impressions ?? 0,
    clicks: p.clicks ?? 0,
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

  const flow = useFixFlow<PinFixCard>({
    scoreKey: "pinSeo",
    buildDeck,
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

  // Bulk approve has the same hazard, times N. Generate everything first, then
  // apply. flowRef keeps us on the LATEST approveAll — the one captured at
  // click time closes over a pre-generation deck.
  const [preparingBulk, setPreparingBulk] = useState(false);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const remainingIds = remaining.map((c) => c.id);
  const bulkReady = ai.settledCount(remainingIds);

  const approveAllWithAi = async () => {
    const ids = flowRef.current.cards.slice(flowRef.current.index).map((c) => c.id);
    setPreparingBulk(true);
    await ai.ensure(ids);
    setPreparingBulk(false);
    // Only apply pins that actually produced copy. Anything that failed is
    // marked skipped rather than written blank — see approveAll's filter.
    await flowRef.current.approveAll(hasCopy);
  };

  const startPin = (card: PinFixCard) => {
    const targetIndex = flow.cards.findIndex((c) => c.id === card.id);
    if (targetIndex >= 0) flow.goTo(targetIndex);
    setLaunchCard(card);
    setMode("launching");
    window.setTimeout(() => {
      setMode("review");
      setLaunchCard(null);
    }, 1150);
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
      // Same gate as the Apply button — → must never commit an empty card.
      if (e.key === "ArrowRight" && !currentPending && currentReady)
        flow.decide(current, "approved");
      else if (e.key === "ArrowLeft") flow.decide(current, "skipped");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewing, paused, current, currentPending, currentReady, flow.canUndo]);

  return (
    <AppShell title="Pin Boost" backButton backTo="/boost" hideBottomNav>
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
            onRevertOne={(c) => flow.revertOne(c as PinFixCard)}
            onUndoAll={flow.undoAll}
            onBack={backToScore}
            busy={flow.bulkApplying || flow.pendingIds.size > 0}
          />
        ) : mode === "picker" ? (
          <PinBoostPicker cards={flow.cards} score={flow.score} onSelect={startPin} />
        ) : mode === "launching" ? (
          <PinLaunch card={launchCard ?? flow.current ?? flow.cards[0]} />
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

            {/* Sets the expectation that this is a full pass, not a triage
                queue — every pin gets a keyword-grounded rewrite offered. */}
            <p className="shrink-0 pb-2 text-center text-[11px] text-muted-foreground">
              Rewriting <span className="font-semibold text-foreground">every</span> pin title &amp;
              description — strongest gains first
            </p>

            {/* Live Pin SEO score + how-it-works — the feedback loop, always on. */}
            <div className="flex shrink-0 items-center justify-center gap-3 pb-2">
              <LiveScorePill label="Pin SEO" score={flow.score} />
              <button
                type="button"
                onClick={() => setGuide(true)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary transition hover:underline"
              >
                <Info className="h-3 w-3" /> How it works
              </button>
            </div>

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
            unitLabel="pins"
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

function metricLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return value.toLocaleString();
}

function pinOpportunityScore(card: PinFixCard): number {
  const issueWeight = Math.max(1, card.issues.length) * 100_000;
  return issueWeight + card.impressions * 2 + card.clicks * 25;
}

function PinBoostPicker({
  cards,
  score,
  onSelect,
}: {
  cards: PinFixCard[];
  score: number;
  onSelect: (card: PinFixCard) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const ranked = useMemo(
    () => [...cards].sort((a, b) => pinOpportunityScore(b) - pinOpportunityScore(a)),
    [cards],
  );
  const visible = showAll ? ranked : ranked.slice(0, PIN_PICKER_PREVIEW_COUNT);
  const top = ranked[0];
  const totalImpressions = ranked.reduce((sum, p) => sum + p.impressions, 0);
  const totalClicks = ranked.reduce((sum, p) => sum + p.clicks, 0);

  return (
    <motion.div
      key="pin-picker"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
      className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-3"
    >
      <div className="relative overflow-hidden rounded-3xl border border-primary/15 bg-surface p-4 shadow-elevate">
        <div
          aria-hidden
          className="absolute -right-16 -top-20 h-44 w-44 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="relative flex items-start gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Trophy className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-wide text-primary">
              Suggested pins to boost
            </p>
            <h2 className="mt-1 font-display text-2xl font-bold leading-tight">
              Pick your first win
            </h2>
            <p className="mt-1 text-sm leading-snug text-muted-foreground">
              We ranked your pins by SEO gaps and real engagement. Choose one to start the rewrite
              run.
            </p>
          </div>
        </div>

        <div className="relative mt-4 grid grid-cols-3 gap-2">
          <PickerStat icon={BarChart3} label="SEO score" value={`${score}%`} />
          <PickerStat icon={Eye} label="Impressions" value={metricLabel(totalImpressions)} />
          <PickerStat icon={MousePointerClick} label="Clicks" value={metricLabel(totalClicks)} />
        </div>
      </div>

      {top && (
        <button
          type="button"
          onClick={() => onSelect(top)}
          className="group mt-3 block w-full overflow-hidden rounded-3xl border-2 border-primary bg-surface text-left shadow-elevate transition active:scale-[0.99]"
        >
          <div className="relative aspect-[16/10] bg-surface-2">
            {top.image_url ? (
              <img
                src={top.image_url}
                alt=""
                className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted-foreground">
                <ImageIcon className="h-10 w-10" />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
            <div className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[11px] font-extrabold text-primary-foreground shadow">
              <Trophy className="h-3 w-3" /> Best first
            </div>
            <div className="absolute bottom-3 left-3 right-3">
              <p className="line-clamp-2 font-display text-xl font-bold leading-tight text-white">
                {top.title}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <MetricPill icon={Eye} value={metricLabel(top.impressions)} label="impressions" />
                <MetricPill
                  icon={MousePointerClick}
                  value={metricLabel(top.clicks)}
                  label="clicks"
                />
                <span className="rounded-full bg-white/90 px-2 py-1 text-[10px] font-bold text-foreground">
                  {top.issues.length || 1} boost {top.issues.length === 1 ? "move" : "moves"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Start here
              </p>
              <p className="line-clamp-1 text-sm font-semibold">
                {top.issues[0] ?? "Keyword rewrite opportunity"}
              </p>
            </div>
            <span className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full bg-primary px-3 text-xs font-extrabold text-primary-foreground">
              Boost <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </div>
        </button>
      )}

      <div className="mt-3 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Boost queue
        </p>
        {ranked.length > PIN_PICKER_PREVIEW_COUNT && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="inline-flex min-h-8 items-center gap-1 rounded-full bg-surface px-3 text-[11px] font-bold text-primary ring-1 ring-primary/20 transition hover:bg-primary/10"
          >
            {showAll ? "Show less" : `Show all ${ranked.length}`}
          </button>
        )}
      </div>

      <div className="mt-2 space-y-2">
        {visible.map((card, i) => (
          <SuggestedPinRow key={card.id} card={card} rank={i + 1} onSelect={() => onSelect(card)} />
        ))}
      </div>
    </motion.div>
  );
}

function PickerStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Sparkles;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl bg-surface-2/70 p-2.5 ring-1 ring-border/70">
      <Icon className="h-3.5 w-3.5 text-primary" />
      <p className="mt-1 text-[10px] font-medium text-muted-foreground">{label}</p>
      <p className="text-sm font-extrabold tabular-nums">{value}</p>
    </div>
  );
}

function MetricPill({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Eye;
  value: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-1 text-[10px] font-bold text-foreground">
      <Icon className="h-3 w-3 text-primary" /> {value} {label}
    </span>
  );
}

function SuggestedPinRow({
  card,
  rank,
  onSelect,
}: {
  card: PinFixCard;
  rank: number;
  onSelect: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(rank * 0.035, 0.22), duration: 0.28 }}
      className="group flex w-full items-center gap-3 rounded-2xl border border-border bg-surface p-2 text-left shadow-sm transition hover:border-primary/40 hover:bg-primary/[0.03] active:scale-[0.99]"
    >
      <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-xl bg-surface-2">
        {card.image_url ? (
          <img src={card.image_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-muted-foreground">
            <ImageIcon className="h-4 w-4" />
          </div>
        )}
        <span className="absolute left-1 top-1 grid h-5 min-w-5 place-items-center rounded-full bg-black/65 px-1 text-[10px] font-extrabold text-white">
          {rank}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-sm font-bold">{card.title}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {(card.issues.length ? card.issues : ["Keyword upgrade"]).slice(0, 2).map((issue) => (
            <span
              key={issue}
              className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
            >
              {issue}
            </span>
          ))}
        </div>
        <div className="mt-1.5 flex gap-2 text-[11px] font-semibold text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Eye className="h-3 w-3" /> {metricLabel(card.impressions)}
          </span>
          <span className="inline-flex items-center gap-1">
            <MousePointerClick className="h-3 w-3" /> {metricLabel(card.clicks)}
          </span>
        </div>
      </div>

      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-primary ring-1 ring-border transition group-hover:bg-primary group-hover:text-primary-foreground">
        <ArrowRight className="h-4 w-4" />
      </span>
    </motion.button>
  );
}

function PinLaunch({ card }: { card: PinFixCard }) {
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
          <h2 className="mt-2 font-display text-2xl font-bold">Locking onto this pin</h2>
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
