import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  Compass,
  ExternalLink,
  Hand,
  ImagePlus,
  LayoutGrid,
  Link2,
  MousePointerClick,
  PencilLine,
  RefreshCw,
  Rocket,
  Sparkles,
  TrendingUp,
  Type,
  Undo2,
  UserCheck,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AppSheet } from "@/components/app-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber, scoreTone } from "@/components/health-widgets";
import { SeoInsightButton, SeoInsightSheet } from "@/components/seo-insight";
import {
  BoostAnalyzer,
  hasAnalyzedThisSession,
  markAnalyzedThisSession,
} from "@/components/boost-analyzer";
import { FlowIntro } from "@/components/flow-intro";
import { PinterestConnectPanel } from "@/components/pinterest-gate";
import { usePinterestConnection } from "@/hooks/use-pinterest-connect";
import { useHealthScore, type HealthData } from "@/hooks/use-health-score";
import type { PinterestProfileSnapshot } from "@/lib/pinterest-profile.functions";
import {
  boardIssues,
  boardPassesStructure,
  maxPointsFor,
  pinPassesSeo,
  pinSeoIssues,
  pointsEarned,
  pointsLabel,
  recordScore,
  saveLastSeenScore,
  SCORE_CRITERIA,
  staleBoards,
  SUB_SCORE_LABELS,
  takeLastSeenScore,
  type HealthReport,
  type ProfileItem,
  type ProfileItemKey,
  type SubScore,
  type SubScoreKey,
} from "@/lib/health-score";

export const Route = createFileRoute("/_authenticated/boost")({
  component: BoostPinsPage,
});

const SUB_ICONS: Record<SubScoreKey, typeof Type> = {
  pinSeo: Type,
  boardStructure: LayoutGrid,
  profile: UserCheck,
  freshness: CalendarClock,
};

function BoostPinsPage() {
  const navigate = useNavigate();
  const { report, data, isLoading, refetch, isFetching } = useHealthScore();
  // Every input to this score — Pin copy, board structure, the Pinterest profile,
  // how recently anything was posted — is read from Pinterest. Without the
  // connection there is nothing to score, so the screen asks for it instead of
  // rendering a 0 and blaming the creator for it.
  const { usable: pinterestUsable, isLoading: connectionLoading } = usePinterestConnection();

  // A fix flow stashes the score the user last saw; climb from it so the
  // improvement is felt the moment they land back here.
  const animateFrom = useMemo(() => takeLastSeenScore(), []);

  // Which area's fix briefing is open. Every entry into a fix flow goes through
  // this intermediate step first — it shows what's wrong and what we'll do,
  // rather than dumping the user straight into the deck.
  const [briefingKey, setBriefingKey] = useState<SubScoreKey | null>(null);

  // The pre-score sequence: "intro" is the three education screens (the
  // problem, what the AI does, the CTA), "scan" is the analyzer choreography
  // the CTA triggers, null is the score itself. Once per session, and never
  // when returning from a fix flow (the climbing score IS that moment).
  const [introPhase, setIntroPhase] = useState<"intro" | "scan" | null>(() =>
    animateFrom == null && !hasAnalyzedThisSession() ? "intro" : null,
  );
  const analyzing = introPhase !== null;

  // Record the score for the dashboard's "since last visit" delta — once the
  // real number is on screen.
  const recorded = useMemo(() => ({ done: false }), []);
  useEffect(() => {
    if (report && !analyzing && !recorded.done) {
      recorded.done = true;
      recordScore(report.overall);
    }
  }, [report, analyzing, recorded]);

  // Profile SEO scores the Pinterest profile, so its fix can't be a route inside
  // ShopMyPin — the bio, photo and website all live on pinterest.com. The sheet
  // shows what Pinterest currently has and hands over a link per field.
  const [profileSheet, setProfileSheet] = useState(false);

  // The scoring explainer, and the per-area "what drives this" bulb. Both are
  // sheets so they can open over the plan (and, for the bulb, over a briefing)
  // without the page losing its place.
  const [scoringSheet, setScoringSheet] = useState(false);
  const [insightKey, setInsightKey] = useState<SubScoreKey | null>(null);
  const goFreshness = (boardId?: string) => {
    if (report) saveLastSeenScore(report.overall);
    navigate({ to: "/pins/create", search: { board: boardId } });
  };
  const goFix = (key: SubScoreKey) => {
    if (!data || !report) return;
    switch (key) {
      case "pinSeo":
        return navigate({ to: "/boost/pins" });
      case "boardStructure":
        return navigate({ to: "/boost/boards" });
      case "profile":
        // Swap the briefing for the profile sheet rather than stacking them.
        setBriefingKey(null);
        return setProfileSheet(true);
      case "freshness":
        return goFreshness(staleBoards(data.pins, data.boards)[0]?.id);
    }
  };

  const ranked = useMemo(
    () => (report ? [...report.subScores].sort((a, b) => b.potentialGain - a.potentialGain) : []),
    [report],
  );
  return (
    <AppShell title="Pinterest SEO" backButton backTo="/dashboard">
      <div className="mx-auto max-w-2xl">
        <AnimatePresence mode="wait">
          {/* `report.isEmpty` is the deciding half: a creator who connected once
              and later disconnected still has real imported Pins to score, and
              gating those behind a reconnect prompt would hide work they can
              still act on. Only an empty score AND no connection is a gate. */}
          {!connectionLoading && !pinterestUsable && (report?.isEmpty ?? true) ? (
            <PinterestConnectPanel
              key="gate"
              title="Connect Pinterest to get your SEO score"
              reason="Your score is built from your real Pins, boards and Pinterest profile — the titles, descriptions and how recently you posted. Without access to them there is nothing here to measure."
              bullets={[
                "Read-only to begin with: we score what's already on your account.",
                "Nothing on Pinterest is edited unless you apply a fix yourself.",
              ]}
            />
          ) : introPhase === "intro" ? (
            <FlowIntro key="intro" flow="pinterest-seo" onDone={() => setIntroPhase("scan")} />
          ) : introPhase === "scan" ? (
            <BoostAnalyzer
              key="analyzer"
              counts={data ? { pins: data.pins.length, boards: data.boards.length } : null}
              ready={!!report}
              onDone={() => {
                markAnalyzedThisSession();
                setIntroPhase(null);
              }}
            />
          ) : isLoading || !report ? (
            <BoostSkeleton key="skeleton" />
          ) : report.isEmpty ? (
            <EmptyState key="empty" />
          ) : (
            <motion.div
              key="score"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              {/* ---- Minimal hero: score · one line · one action ---- */}
              <div className="relative overflow-hidden rounded-[2rem] border border-border/70 bg-gradient-to-b from-rose-50/70 via-surface to-surface p-6 shadow-elevate sm:p-7">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -top-28 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
                />
                {/* Recheck stays an icon in the corner; the scoring explainer
                    moved to a small pill in the hero footer, where a label
                    reads clearer than an info glyph. */}
                <div className="absolute right-3 top-3 z-10">
                  <button
                    type="button"
                    onClick={() => refetch()}
                    aria-label="Recheck score"
                    className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground/60 transition hover:bg-surface-2 hover:text-primary"
                  >
                    <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
                  </button>
                </div>

                <div className="relative flex flex-col items-center text-center">
                  <ScoreRing score={report.overall} from={animateFrom} />
                  <button
                    type="button"
                    onClick={() => setScoringSheet(true)}
                    className="mt-4 inline-flex items-center gap-1 rounded-full border border-border/70 bg-surface/80 px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-primary"
                  >
                    How your score works
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* ---- One prioritized plan (grid + list merged) ---- */}
              <div className="mt-5">
                <h2 className="mb-3 font-display text-lg font-semibold">Fix your Pinterest now</h2>
                <div className="grid gap-2.5">
                  {ranked.map((s, i) => (
                    <BoostRow key={s.key} sub={s} rank={i} onFix={() => setBriefingKey(s.key)} />
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* The whole scoring model, on demand — a sheet rather than an accordion
          so it can be read properly without pushing the plan off screen. */}
      <AnimatePresence>
        {scoringSheet && report && (
          <HowScoringSheet
            report={report}
            onExplain={(key) => setInsightKey(key)}
            onClose={() => setScoringSheet(false)}
          />
        )}
      </AnimatePresence>

      {/* Intermediate briefing — what's wrong + how we'll fix it, before the flow. */}
      <AnimatePresence>
        {briefingKey && report && data && (
          <FixBriefing
            sub={report.subScores.find((s) => s.key === briefingKey)!}
            data={data}
            profileItems={report.profileItems}
            onStart={() => goFix(briefingKey)}
            onExplain={() => setInsightKey(briefingKey)}
            onClose={() => setBriefingKey(null)}
          />
        )}
      </AnimatePresence>

      {/* The bulb: what actually drives this area's pts. Opens over whichever
          sheet named it, and closes back to it. */}
      <AnimatePresence>
        {insightKey && <SeoInsightSheet subKey={insightKey} onClose={() => setInsightKey(null)} />}
      </AnimatePresence>

      {/* The profile fix itself: their live Pinterest profile, field by field. */}
      <AnimatePresence>
        {profileSheet && report && (
          <PinterestProfileSheet
            snapshot={data?.pinterestProfile ?? null}
            items={report.profileItems}
            score={report.subScores.find((s) => s.key === "profile")?.score ?? 0}
            refreshing={isFetching}
            onRecheck={() => {
              saveLastSeenScore(report.overall);
              void refetch();
            }}
            onClose={() => setProfileSheet(false)}
          />
        )}
      </AnimatePresence>
    </AppShell>
  );
}

/* ---------------- Fix briefing (intermediate step) ---------------- */

type MissingItem = { id: string; title: string; note: string };

// The concrete items dragging an area down — the same detail the old inline
// "what's missing" expander showed, now surfaced in the briefing.
function missingItemsFor(
  key: SubScoreKey,
  data: HealthData,
  profileItems: ProfileItem[],
): MissingItem[] {
  switch (key) {
    case "pinSeo":
      return data.pins
        .filter((p) => !pinPassesSeo(p))
        .map((p) => ({
          id: p.id,
          title: p.title?.trim() || "Untitled pin",
          note: pinSeoIssues(p).join(" · "),
        }));
    case "boardStructure":
      return data.boards
        .filter((b) => !boardPassesStructure(b))
        .map((b) => ({
          id: b.id,
          title: b.name?.trim() || "Unnamed board",
          note: boardIssues(b).join(" · "),
        }));
    case "profile":
      return profileItems
        .filter((i) => !i.ok)
        .map((i) => ({ id: i.key, title: i.label, note: "Missing on Pinterest" }));
    case "freshness":
      return staleBoards(data.pins, data.boards).map((b) => ({
        id: b.id,
        title: b.name,
        note: b.daysSinceLastPin == null ? "No pins yet" : `Last pin ${b.daysSinceLastPin}d ago`,
      }));
  }
}

// The fix flow, as three words and three icons on ONE line.
//
// These were sentences in boxes ("AI drafts titles & descriptions"), which made
// the how-it-works step the visually heaviest thing in a sheet whose job is to
// get one tap. Two or three words each is enough to convey the shape of the
// flow; the flow itself explains the rest.
type HowStep = { icon: typeof Sparkles; label: string };
const HOW_STEPS: Record<SubScoreKey, HowStep[]> = {
  pinSeo: [
    { icon: Sparkles, label: "AI drafts" },
    { icon: Hand, label: "You swipe" },
    { icon: TrendingUp, label: "Rank climbs" },
  ],
  boardStructure: [
    { icon: Sparkles, label: "AI drafts" },
    { icon: Hand, label: "You swipe" },
    { icon: Undo2, label: "Undo anytime" },
  ],
  profile: [
    { icon: MousePointerClick, label: "Open profile" },
    { icon: PencilLine, label: "Fix on Pinterest" },
    { icon: TrendingUp, label: "Score climbs" },
  ],
  freshness: [
    { icon: Compass, label: "Quiet boards" },
    { icon: ImagePlus, label: "Add a pin" },
    { icon: TrendingUp, label: "Reach grows" },
  ],
};

// Colours for the composition bar's segments, in rank order. Warm-to-cool
// rather than four shades of one hue, so the segments stay tellable apart at
// the 6px height the bar is drawn at.
const ISSUE_COLORS = ["bg-amber-400", "bg-rose-400", "bg-violet-400", "bg-sky-400"];

function FixBriefing({
  sub,
  data,
  profileItems,
  onStart,
  onExplain,
  onClose,
}: {
  sub: SubScore;
  data: HealthData;
  profileItems: ProfileItem[];
  onStart: () => void;
  /** Opens the bulb — what drives this area, and why Pinterest cares. */
  onExplain: () => void;
  onClose: () => void;
}) {
  const tone = scoreTone(sub.score);
  const Icon = SUB_ICONS[sub.key];
  // Everything the creator reads here is points on the 100-pt score: banked
  // now, and where the bar can get to.
  const maxPts = maxPointsFor(sub.key);
  const nowPts = pointsEarned(sub.key, sub.score);
  const items = missingItemsFor(sub.key, data, profileItems);
  const shown = items.slice(0, 6);

  // Collapse the repetitive per-item notes into a ranked tally of problem
  // types, so the same information reads as one visual breakdown, not a list.
  const topIssues = useMemo(() => {
    const tally = new Map<string, number>();
    for (const it of items) {
      for (const tag of it.note ? it.note.split(" · ") : []) {
        tally.set(tag, (tally.get(tag) ?? 0) + 1);
      }
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [items]);
  // Segments are shares of the tagged total, NOT of `sub.failing`. One pin
  // usually carries several tags (a short title AND no description), so the
  // counts sum past the pin count and scaling against it would overflow.
  const issueTotal = topIssues.reduce((n, [, count]) => n + count, 0) || 1;
  // The bar only makes sense when a problem actually repeats; otherwise
  // (freshness, profile — every note unique) fall back to titled chips.
  const useBars = topIssues.length > 0 && topIssues[0][1] >= 2;

  const container: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
  };
  const item: Variants = {
    hidden: { opacity: 0, y: 10 },
    // ease typed as a cubic-bezier tuple — a bare number[] isn't assignable to
    // framer-motion's Easing inside a Variants object (unlike inline transitions).
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
    },
  };

  return (
    <AppSheet onClose={onClose} labelledBy="briefing-title">
      <motion.div variants={container} initial="hidden" animate="show">
        {/* Header: which area, the score now, the points on the table. */}
        <motion.div variants={item} className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${tone.bg} ${tone.text}`}
            >
              <Icon className="h-6 w-6" />
            </div>
            <div>
              <h2 id="briefing-title" className="font-display text-lg font-bold leading-tight">
                {sub.label}
              </h2>
              {/* Where the pts go, not two separate figures to add up. The
                    destination is the motivating number, so show it — and in the
                    same unit as the plan row that was just tapped. */}
              <p className="mt-0.5 flex items-center gap-1.5 text-xs font-bold">
                <span className={tone.text}>{pointsLabel(nowPts)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground/50" />
                <span className="text-emerald-600">{maxPts} pts</span>
              </p>
            </div>
          </div>
          <div className="-mr-1 -mt-1 flex shrink-0 items-center gap-1">
            <SeoInsightButton label={sub.label} onClick={onExplain} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </motion.div>

        {/* The one number that matters, then ONE bar showing what it's made
              of. This replaced a stacked count-per-issue readout: with the hero
              already saying 379, three more bars each repeating a number very
              close to 379 added rows without adding information. The segments
              carry the same composition, and the names sit under them. */}
        <motion.div variants={item} className="mt-7 flex items-end gap-2">
          <span className={`font-display text-5xl font-black leading-none ${tone.text}`}>
            {sub.failing}
          </span>
          <span className="pb-1 text-sm font-semibold text-muted-foreground">
            {sub.unit} to fix
          </span>
        </motion.div>

        {useBars ? (
          <motion.div variants={item} className="mt-4">
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
              {topIssues.map(([label, count], i) => (
                <motion.span
                  key={label}
                  className={`${ISSUE_COLORS[i % ISSUE_COLORS.length]} first:rounded-l-full last:rounded-r-full`}
                  initial={{ width: 0 }}
                  animate={{ width: `${(count / issueTotal) * 100}%` }}
                  transition={{ duration: 0.7, delay: 0.2 + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
                />
              ))}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {topIssues.map(([label], i) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 text-mini font-semibold text-muted-foreground"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${ISSUE_COLORS[i % ISSUE_COLORS.length]}`}
                  />
                  {label}
                </span>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div variants={item} className="mt-3.5 flex flex-wrap gap-1.5">
            {shown.slice(0, 4).map((m) => (
              <span
                key={m.id}
                className="max-w-full truncate rounded-full bg-surface-2/70 px-3 py-1.5 text-xs font-medium"
              >
                {m.title}
              </span>
            ))}
            {items.length > 4 && (
              <span className="rounded-full px-2 py-1.5 text-xs text-muted-foreground">
                +{items.length - 4} more
              </span>
            )}
          </motion.div>
        )}

        {/* How it works — one line, three beats. No heading: the icons and the
              arrows between them say "sequence" faster than a label could. */}
        <motion.div
          variants={item}
          className="mt-7 flex items-center justify-between gap-1 rounded-2xl bg-surface-2/40 px-3 py-3"
        >
          {HOW_STEPS[sub.key].map((step, i) => (
            <Fragment key={i}>
              <div className="flex min-w-0 flex-col items-center gap-1.5 text-center">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-primary/10 text-primary">
                  <step.icon className="h-4 w-4" />
                </span>
                <span className="truncate text-mini font-semibold text-foreground/80">
                  {step.label}
                </span>
              </div>
              {i < HOW_STEPS[sub.key].length - 1 && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 self-start text-muted-foreground/35" />
              )}
            </Fragment>
          ))}
        </motion.div>

        {/* One way out is enough — the header's X already dismisses the sheet,
            so a "Maybe later" button under the CTA was a second word for the
            same gesture. */}
        <motion.div variants={item} className="mt-6">
          <button
            type="button"
            onClick={onStart}
            className="relative inline-flex min-h-[54px] w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-primary px-5 text-sm font-extrabold text-primary-foreground shadow-glow transition hover:opacity-95 active:scale-[0.99]"
          >
            {/* Travelling highlight — the one moving thing in the sheet, on
                  the one element we want tapped. */}
            <span
              aria-hidden
              className="animate-sheen pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent"
            />
            <Sparkles className="h-4 w-4" /> Start fixing <ArrowRight className="h-4 w-4" />
          </button>
        </motion.div>
      </motion.div>
    </AppSheet>
  );
}

/* ---------------- Profile fix: the creator's Pinterest profile ---------------- */

// Where each field is actually edited. Pinterest keeps the profile fields on the
// public-profile settings page and domain claiming on its own page, so a single
// "open Pinterest" link would land the creator one or two clicks short of the
// thing they came to fix.
const PINTEREST_SETTINGS = "https://www.pinterest.com/settings/profile/";
const PINTEREST_CLAIM = "https://www.pinterest.com/settings/claim/";

// The sheet is a checklist, not an article: an icon carries the field, one word
// carries the state, and one word carries the action. Anything longer is the
// creator reading instead of tapping — the fix itself is two taps away on
// Pinterest, so this screen's whole job is pointing at it.
type ProfileRow = {
  key: ProfileItemKey;
  /** One or two words — the field, not a sentence about it. */
  label: string;
  icon: typeof Type;
  ok: boolean;
  /** What Pinterest has, shown only when it's real content worth reading back. */
  value: string | null;
  href: string | null;
  /** One word while the check is failing. */
  cta: string;
  /** One word once it passes — usually "Edit", sometimes a real next step. */
  doneCta: string;
};

function PinterestProfileSheet({
  snapshot,
  items,
  score,
  refreshing,
  onRecheck,
  onClose,
}: {
  snapshot: PinterestProfileSnapshot | null;
  items: ProfileItem[];
  score: number;
  refreshing: boolean;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const connected = !!snapshot?.connected;
  const okOf = (key: ProfileItemKey) => items.find((i) => i.key === key)?.ok ?? false;
  const tone = scoreTone(score);
  // Points banked and points still on the table — the same maths the boost plan
  // ranks areas by, so the two never disagree.
  const maxPts = maxPointsFor("profile");
  const nowPts = pointsEarned("profile", score);
  const gainPts = maxPts - nowPts;

  const rows: ProfileRow[] = [
    {
      key: "avatar",
      label: "Photo",
      icon: ImagePlus,
      ok: okOf("avatar"),
      // Already visible at the top of the sheet — repeating it in words adds
      // nothing.
      value: null,
      href: PINTEREST_SETTINGS,
      cta: "Add",
      doneCta: "Edit",
    },
    {
      key: "bio",
      label: "Bio",
      icon: PencilLine,
      ok: okOf("bio"),
      value: snapshot?.about ?? null,
      href: PINTEREST_SETTINGS,
      cta: "Add",
      doneCta: "Edit",
    },
    {
      key: "website",
      label: "Website",
      icon: Link2,
      ok: okOf("website"),
      value: snapshot?.websiteUrl ?? null,
      // The check only asks whether a URL is set, so the two states need
      // different destinations: the settings page to add one, the claim page
      // once there's something to claim.
      href: okOf("website") ? PINTEREST_CLAIM : PINTEREST_SETTINGS,
      cta: "Add",
      doneCta: "Claim",
    },
    {
      key: "social",
      label: "Account",
      icon: UserCheck,
      ok: okOf("social"),
      value: snapshot?.username ? `@${snapshot.username}` : null,
      href: null,
      cta: "Connect",
      doneCta: "Manage",
    },
  ];

  // Open work first, done work below it — four one-line rows, so nothing needs
  // collapsing behind a "N checks passing" control.
  const ordered = [...rows].sort((a, b) => Number(a.ok) - Number(b.ok));
  const doneCount = rows.filter((r) => r.ok).length;
  const allDone = doneCount === rows.length;

  // Every fix happens in another tab, so a row has to hold the "your turn" state
  // until a recheck proves it landed. Without it, coming back from Pinterest
  // means re-reading the whole list to remember where you were.
  const [opened, setOpened] = useState<Set<ProfileItemKey>>(() => new Set());

  // A check that has since passed drops its waiting badge on the next recheck.
  useEffect(() => {
    setOpened((prev) => {
      if (prev.size === 0) return prev;
      const stillFailing = new Set(items.filter((i) => !i.ok).map((i) => i.key));
      const next = new Set([...prev].filter((k) => stillFailing.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const markOpened = (key: ProfileItemKey) =>
    setOpened((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));

  /** Shared button skin: loud while the check is failing, quiet once it passes. */
  const actionClass = (ok: boolean) =>
    `inline-flex min-h-9 shrink-0 items-center justify-center gap-1 rounded-full px-3 text-mini font-bold transition active:scale-[0.98] ${
      ok
        ? "bg-surface-2 text-muted-foreground ring-1 ring-border hover:text-foreground"
        : "bg-gradient-primary text-primary-foreground shadow-glow"
    }`;

  return (
    <AppSheet onClose={onClose} labelledBy="pinterest-profile-title" layout="panel" grabber={false}>
      <>
        {/* ---- Fixed head: who this is, and how complete ---- */}
        <div className="shrink-0 px-5 pb-3 pt-3">
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-border sm:hidden" />

          {/* The profile as Pinterest has it — avatar, name, real counts. */}
          <div className="flex items-start gap-3">
            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full bg-surface-2 ring-1 ring-border">
              {snapshot?.profileImage ? (
                <img src={snapshot.profileImage} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-muted-foreground">
                  <UserCheck className="h-5 w-5" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="pinterest-profile-title"
                className="truncate font-display text-lg font-bold leading-tight"
              >
                {snapshot?.businessName ??
                  (snapshot?.username ? `@${snapshot.username}` : "Your Pinterest profile")}
              </h2>
              <p className="mt-0.5 truncate text-mini text-muted-foreground">
                {connected ? (
                  <>
                    {snapshot!.followerCount.toLocaleString()} followers ·{" "}
                    {snapshot!.pinCount.toLocaleString()} pins
                  </>
                ) : (
                  "Not connected to Pinterest"
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* The gauge is the sentence: four segments, pts banked, pts left. */}
          <div className="mt-3.5 flex items-center gap-2.5">
            <div className="flex flex-1 gap-1" aria-hidden>
              {rows.map((row) => (
                <span
                  key={row.key}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    row.ok ? "bg-emerald-500" : "bg-surface-2 ring-1 ring-inset ring-border"
                  }`}
                />
              ))}
            </div>
            <span
              className={`font-display text-lead font-extrabold leading-none tabular-nums ${tone.text}`}
            >
              {pointsLabel(nowPts)}
              <span className="text-mini font-bold text-muted-foreground">/{maxPts} pts</span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-micro font-bold tabular-nums ${
                allDone ? "bg-emerald-500/12 text-emerald-700" : "bg-primary/10 text-primary"
              }`}
            >
              {allDone ? "Done" : `+${pointsLabel(gainPts)} pts`}
            </span>
          </div>
        </div>

        {/* ---- One tappable line per check, open work first ---- */}
        <div className="no-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto px-5 pb-3">
          {ordered.map((row) => {
            const waiting = !row.ok && opened.has(row.key);
            const Icon = row.icon;
            return (
              <motion.div
                key={row.key}
                layout
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className={`flex items-center gap-2.5 rounded-2xl border p-2.5 transition-colors ${
                  row.ok
                    ? "border-border bg-surface"
                    : waiting
                      ? "border-primary/35 bg-primary/[0.04]"
                      : "border-amber-500/30 bg-amber-500/[0.06]"
                }`}
              >
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
                    row.ok
                      ? "bg-emerald-500/12 text-emerald-600"
                      : waiting
                        ? "bg-primary/12 text-primary"
                        : "bg-amber-500/15 text-amber-700"
                  }`}
                >
                  {row.ok ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : waiting ? (
                    <Clock className="h-4 w-4" />
                  ) : (
                    <Icon className="h-4 w-4" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-bold leading-tight">{row.label}</p>
                  {/* Either the real value or a two-word state — never both, and
                      never a sentence. */}
                  <p className="truncate text-mini leading-tight text-muted-foreground">
                    {row.ok ? (row.value ?? "Set") : waiting ? "Waiting on you" : "Missing"}
                  </p>
                </div>

                {row.href ? (
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => !row.ok && markOpened(row.key)}
                    className={actionClass(row.ok)}
                  >
                    {row.ok ? row.doneCta : row.cta}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <Link
                    to="/profile"
                    search={{ focus: "pinterest" }}
                    className={actionClass(row.ok)}
                  >
                    {row.ok ? row.doneCta : row.cta}
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </motion.div>
            );
          })}
        </div>

        {/* ---- Fixed foot: the round trip's second half ---- */}
        <div
          className="shrink-0 border-t border-border/70 bg-surface px-5 pt-3"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          {connected ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onRecheck}
                disabled={refreshing}
                className={`inline-flex min-h-[46px] flex-1 items-center justify-center gap-1.5 rounded-2xl text-body font-bold transition disabled:opacity-50 ${
                  // Loud only once there's something to recheck — before that the
                  // work is on Pinterest, not in here.
                  opened.size > 0
                    ? "bg-gradient-primary text-primary-foreground shadow-glow"
                    : "border-2 border-primary bg-surface text-primary"
                }`}
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Rechecking…" : "Recheck"}
              </button>
              {snapshot?.username && (
                <a
                  href={`https://www.pinterest.com/${snapshot.username}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View profile on Pinterest"
                  className="inline-flex min-h-[46px] shrink-0 items-center justify-center gap-1.5 rounded-2xl bg-surface-2 px-4 text-body font-bold text-muted-foreground ring-1 ring-border transition hover:text-foreground"
                >
                  <Link2 className="h-4 w-4" /> View
                </a>
              )}
            </div>
          ) : (
            // Nothing in here can be scored until the account is connected, so
            // that's the only action worth offering.
            <Link
              to="/profile"
              search={{ focus: "pinterest" }}
              className="inline-flex min-h-[46px] w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary text-body font-bold text-primary-foreground shadow-glow"
            >
              <Link2 className="h-4 w-4" /> Connect Pinterest <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>
      </>
    </AppSheet>
  );
}

/* ---------------- Hero pieces ---------------- */

function ScoreRing({ score, from }: { score: number; from?: number | null }) {
  const R = 76;
  const C = 2 * Math.PI * R;
  const tone = scoreTone(score);
  return (
    <div className="relative grid h-48 w-48 shrink-0 place-items-center">
      <svg viewBox="0 0 176 176" className="absolute inset-0 h-full w-full -rotate-90">
        <defs>
          <linearGradient id="boost-ring" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="oklch(0.62 0.22 28)" />
            <stop offset="100%" stopColor="oklch(0.5 0.24 15)" />
          </linearGradient>
        </defs>
        <circle cx="88" cy="88" r={R} fill="none" strokeWidth="9" className="stroke-primary/10" />
        <motion.circle
          cx="88"
          cy="88"
          r={R}
          fill="none"
          stroke="url(#boost-ring)"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={C}
          initial={{ strokeDashoffset: C * (1 - (from ?? 0) / 100) }}
          animate={{ strokeDashoffset: C * (1 - score / 100) }}
          transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="flex flex-col items-center">
        <span
          className={`font-display text-6xl font-extrabold leading-none tracking-tight ${tone.text}`}
        >
          <AnimatedNumber value={score} from={from ?? 0} duration={1.4} />
        </span>
        <span className="mt-2 text-xs font-semibold tracking-wide text-muted-foreground">
          / 100
        </span>
      </div>
    </div>
  );
}

/* ---------------- Boost plan rows ---------------- */

function BoostRow({ sub, rank, onFix }: { sub: SubScore; rank: number; onFix: () => void }) {
  const tone = scoreTone(sub.score);
  const optimized = sub.score >= 100;

  // Points earned out of this area's max contribution to the overall score,
  // e.g. Pin SEO at a fifth of its checks passing → "8/40 pts". The bar length
  // is the same fraction, drawn rather than named.
  const totalPts = maxPointsFor(sub.key);
  const earnedPts = Math.round(pointsEarned(sub.key, sub.score));

  if (optimized) {
    return (
      <div className="flex items-center gap-3.5 rounded-2xl border border-border bg-surface/60 px-4 py-4">
        <div className="flex w-16 shrink-0 flex-col items-center">
          <span className="text-base font-extrabold tabular-nums leading-tight text-emerald-500">
            {totalPts}/{totalPts}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            pts
          </span>
        </div>
        <div className="h-9 w-px shrink-0 bg-border" />
        <p className="min-w-0 flex-1 truncate text-lead font-semibold">{sub.label}</p>
        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
      </div>
    );
  }

  // Whole card is the action — tap anywhere to open that area's fix flow.
  // Just the heading and its progress loader; ranking is shown by order and,
  // for the top win, a subtle primary tint.
  const isTop = rank === 0;
  return (
    <motion.button
      type="button"
      onClick={onFix}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 + rank * 0.06, duration: 0.3, ease: "easeOut" }}
      className={`group flex w-full items-center gap-3.5 rounded-2xl border p-4 text-left transition active:scale-[0.99] ${
        isTop
          ? "border-primary/40 bg-primary/5 hover:bg-primary/[0.08]"
          : "border-border bg-surface hover:bg-surface-2/60"
      }`}
    >
      <div className="flex w-16 shrink-0 flex-col items-center">
        <span className={`text-base font-extrabold tabular-nums leading-tight ${tone.text}`}>
          {earnedPts}/{totalPts}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          pts
        </span>
      </div>
      <div className="h-9 w-px shrink-0 bg-border" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-lead font-semibold">{sub.label}</p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
          <motion.div
            className={`h-full rounded-full ${tone.bar}`}
            initial={false}
            animate={{ width: `${sub.score}%` }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
    </motion.button>
  );
}

/* ---------------- "How your score works" explainer ---------------- */

// Ranked by weight, so the sheet reads in the order the pts actually matter.
const SCORING_ORDER: SubScoreKey[] = ["pinSeo", "boardStructure", "freshness", "profile"];

// One colour per area. Four distinct hues rather than four shades of one, so a
// 10-pt segment is still tellable apart from a 40-pt one at the height the bar
// is drawn at. `track` is the same hue unbanked, so a segment reads as
// "earned of held" on its own — which is what retired the text legend.
const WEIGHT_COLORS: { fill: string; track: string; dot: string }[] = [
  { fill: "bg-rose-500", track: "bg-rose-500/15", dot: "bg-rose-500" },
  { fill: "bg-violet-400", track: "bg-violet-400/15", dot: "bg-violet-400" },
  { fill: "bg-amber-400", track: "bg-amber-400/15", dot: "bg-amber-400" },
  { fill: "bg-sky-400", track: "bg-sky-400/15", dot: "bg-sky-400" },
];

/**
 * The scoring model, end to end: what the 100 pts are, how they're split, how
 * each slice is earned, and what moves it.
 *
 * Carried by one graphic rather than prose. The 100-pt bar shows both the split
 * (segment width = pts held) and the standing (solid = pts banked), which let
 * its text legend go; each area is then one row — number first, criteria as a
 * caption — so the sheet answers "where did MY 13 pts come from" at a glance
 * and only rewards reading if you're auditing a number you think is wrong.
 */
function HowScoringSheet({
  report,
  onExplain,
  onClose,
}: {
  report: HealthReport;
  onExplain: (key: SubScoreKey) => void;
  onClose: () => void;
}) {
  const subByKey = (key: SubScoreKey) => report.subScores.find((s) => s.key === key)!;

  return (
    <AppSheet onClose={onClose} labelledBy="scoring-title" layout="panel" grabber={false}>
      <>
        <div className="shrink-0 px-5 pb-3 pt-3">
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-border sm:hidden" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="scoring-title" className="font-display text-xl font-bold leading-tight">
                How your score works
              </h2>
              <p className="mt-1 text-mini font-semibold text-muted-foreground">
                <span className="font-bold text-foreground">{report.overall}</span> of 100 pts
                banked · <span className="font-bold text-foreground">{100 - report.overall}</span>{" "}
                still on the table
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* The whole model in one graphic: segment width is the pts an area
              holds, the solid part is what's banked. Naming the segments used
              to cost two wrapped lines of legend — the cards below carry the
              same colour as a dot, so the bar can stay wordless. */}
          <div className="mt-4 flex h-3 items-stretch gap-1">
            {SCORING_ORDER.map((k, i) => {
              const maxPts = maxPointsFor(k);
              const pct = Math.round((pointsEarned(k, subByKey(k).score) / maxPts) * 100);
              return (
                <div
                  key={k}
                  style={{ flex: `${maxPts} 1 0%` }}
                  className={`relative overflow-hidden rounded-full ${WEIGHT_COLORS[i].track}`}
                >
                  <motion.span
                    className={`absolute inset-y-0 left-0 rounded-full ${WEIGHT_COLORS[i].fill}`}
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.6, delay: 0.1 + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* One row per area, on the divided-list pattern rather than four
            bordered cards — the criteria line is a caption on its row, so the
            eye lands on "0.4 / 40" before it lands on any prose. */}
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-3">
          <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-surface">
            {SCORING_ORDER.map((k, i) => {
              const sub = subByKey(k);
              const Icon = SUB_ICONS[k];
              const maxPts = maxPointsFor(k);
              const nowPts = pointsEarned(k, sub.score);
              const tone = scoreTone(sub.score);
              return (
                <div key={k} className="flex items-center gap-3 p-3.5">
                  <span
                    className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-xl ${tone.bg} ${tone.text}`}
                  >
                    <Icon className="h-4 w-4" />
                    {/* The dot the bar above dropped its legend for. */}
                    <span
                      className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-surface ${WEIGHT_COLORS[i].dot}`}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-bold leading-tight">{SUB_SCORE_LABELS[k]}</p>
                    <p className="mt-0.5 text-micro leading-snug text-muted-foreground">
                      {SCORE_CRITERIA[k]}
                    </p>
                  </div>
                  <p className={`shrink-0 text-body font-bold tabular-nums ${tone.text}`}>
                    {pointsLabel(nowPts)}
                    <span className="text-mini font-semibold text-muted-foreground">/{maxPts}</span>
                  </p>
                  <SeoInsightButton label={SUB_SCORE_LABELS[k]} onClick={() => onExplain(k)} />
                </div>
              );
            })}
          </div>

          {/* The one rule that isn't per-area, and the one thing people get
              wrong: pts are a share, not a checklist you complete. Two
              paragraphs under a heading became two labelled lines. */}
          <div className="mt-2.5 space-y-2 rounded-2xl bg-surface-2/60 p-3.5 ring-1 ring-inset ring-border/60">
            <p className="text-mini leading-snug text-foreground/80">
              <span className="font-bold text-foreground">Pts are a share.</span> Half your pins
              passing banks half of Pin SEO&rsquo;s {maxPointsFor("pinSeo")}.
            </p>
            <p className="text-mini leading-snug text-foreground/80">
              <span className="font-bold text-foreground">Nothing is deducted.</span> Every fix is
              undoable.
            </p>
          </div>
        </div>

        <div
          className="shrink-0 border-t border-border/70 bg-surface px-5 pt-3"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="min-h-[48px] w-full rounded-2xl bg-gradient-primary text-body font-bold text-primary-foreground shadow-glow"
          >
            Got it
          </button>
        </div>
      </>
    </AppSheet>
  );
}

/* ---------------- Empty / loading ---------------- */

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-3xl border border-border bg-gradient-to-br from-rose-50 via-orange-50/60 to-surface p-8 text-center shadow-elevate"
    >
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Rocket className="h-8 w-8" />
      </div>
      <h2 className="mt-4 font-display text-2xl font-bold">Your score starts here</h2>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
        Add pins and we'll score your Pinterest SEO.
      </p>
      <div className="mt-6 flex flex-col justify-center gap-2.5 sm:flex-row">
        <Link
          to="/pins/create"
          search={{ board: undefined }}
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-gradient-primary px-5 py-3 text-sm font-bold text-primary-foreground shadow-glow"
        >
          <ImagePlus className="h-4 w-4" /> Create a pin
        </Link>
        <Link
          to="/pins/attach"
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-surface px-5 py-3 text-sm font-semibold text-foreground transition hover:bg-surface-2"
        >
          <Link2 className="h-4 w-4" /> Import pins
        </Link>
      </div>
    </motion.div>
  );
}

function BoostSkeleton() {
  return (
    <div>
      <div className="rounded-[2rem] border border-border bg-surface p-8 sm:p-10">
        <div className="flex flex-col items-center gap-6">
          <Skeleton className="h-48 w-48 rounded-full" />
          <Skeleton className="h-6 w-64 max-w-full rounded-full" />
          <Skeleton className="h-12 w-48 rounded-full" />
        </div>
      </div>
      <div className="mt-6 grid gap-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
