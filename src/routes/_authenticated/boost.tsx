import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Hand,
  ImagePlus,
  Info,
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
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber, scoreTone } from "@/components/health-widgets";
import {
  BoostAnalyzer,
  hasAnalyzedThisSession,
  markAnalyzedThisSession,
} from "@/components/boost-analyzer";
import { useHealthScore, type HealthData } from "@/hooks/use-health-score";
import type { PinterestProfileSnapshot } from "@/lib/pinterest-profile.functions";
import {
  boardIssues,
  boardPassesStructure,
  pinPassesSeo,
  pinSeoIssues,
  recordScore,
  saveLastSeenScore,
  SCORE_CRITERIA,
  staleBoards,
  SUB_SCORE_WEIGHTS,
  takeLastSeenScore,
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

  // A fix flow stashes the score the user last saw; climb from it so the
  // improvement is felt the moment they land back here.
  const animateFrom = useMemo(() => takeLastSeenScore(), []);

  // Which area's fix briefing is open. Every entry into a fix flow goes through
  // this intermediate step first — it shows what's wrong and what we'll do,
  // rather than dumping the user straight into the deck.
  const [briefingKey, setBriefingKey] = useState<SubScoreKey | null>(null);

  // The "analysing your Pinterest" choreography — once per session, and never
  // when returning from a fix flow (the climbing score IS that moment).
  const [analyzing, setAnalyzing] = useState(
    () => animateFrom == null && !hasAnalyzedThisSession(),
  );

  // Record the score for the dashboard's "since last visit" delta — once the
  // real number is on screen.
  const recorded = useMemo(() => ({ done: false }), []);
  useEffect(() => {
    if (report && !analyzing && !recorded.done) {
      recorded.done = true;
      recordScore(report.overall);
    }
  }, [report, analyzing, recorded]);

  // Profile Completeness scores the Pinterest profile, so its fix can't be a
  // route inside Pinearn — the bio, photo and website all live on pinterest.com.
  // The sheet shows what Pinterest currently has and hands over a link per field.
  const [profileSheet, setProfileSheet] = useState(false);
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
    <AppShell
      title="Boost Pins"
      subtitle="One score. Everything holding your reach back."
      backButton
      backTo="/dashboard"
    >
      <div className="mx-auto max-w-2xl">
        <AnimatePresence mode="wait">
          {analyzing ? (
            <BoostAnalyzer
              key="analyzer"
              counts={data ? { pins: data.pins.length, boards: data.boards.length } : null}
              ready={!!report}
              onDone={() => {
                markAnalyzedThisSession();
                setAnalyzing(false);
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
                {/* Quiet, icon-only recheck — kept out of the main composition. */}
                <button
                  type="button"
                  onClick={() => refetch()}
                  aria-label="Recheck score"
                  className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full text-muted-foreground/60 transition hover:bg-surface-2 hover:text-primary"
                >
                  <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
                </button>

                <div className="relative flex flex-col items-center text-center">
                  <ScoreRing score={report.overall} from={animateFrom} />
                </div>
              </div>

              <HowScoringWorks />

              {/* ---- One prioritized plan (grid + list merged) ---- */}
              <div className="mt-6">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="font-display text-lg font-semibold">Your boost plan</h2>
                  <span className="text-[11px] text-muted-foreground">Biggest wins first</span>
                </div>
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

      {/* Intermediate briefing — what's wrong + how we'll fix it, before the flow. */}
      <AnimatePresence>
        {briefingKey && report && data && (
          <FixBriefing
            sub={report.subScores.find((s) => s.key === briefingKey)!}
            data={data}
            profileItems={report.profileItems}
            onStart={() => goFix(briefingKey)}
            onClose={() => setBriefingKey(null)}
          />
        )}
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

// The fix flow shown as three glanceable icon steps instead of sentences.
type HowStep = { icon: typeof Sparkles; label: string };
const HOW_STEPS: Record<SubScoreKey, HowStep[]> = {
  pinSeo: [
    { icon: Sparkles, label: "AI drafts titles & descriptions" },
    { icon: Hand, label: "Swipe to apply" },
    { icon: TrendingUp, label: "Grow reach & rank" },
  ],
  boardStructure: [
    { icon: Sparkles, label: "We suggest" },
    { icon: Hand, label: "Swipe to apply" },
    { icon: Undo2, label: "Undo anytime" },
  ],
  profile: [
    { icon: MousePointerClick, label: "See your Pinterest profile" },
    { icon: PencilLine, label: "Fix it on Pinterest" },
    { icon: TrendingUp, label: "Recheck — score climbs" },
  ],
  freshness: [
    { icon: Compass, label: "Find quiet boards" },
    { icon: ImagePlus, label: "Add a pin" },
    { icon: TrendingUp, label: "Reach grows" },
  ],
};

function FixBriefing({
  sub,
  data,
  profileItems,
  onStart,
  onClose,
}: {
  sub: SubScore;
  data: HealthData;
  profileItems: ProfileItem[];
  onStart: () => void;
  onClose: () => void;
}) {
  const tone = scoreTone(sub.score);
  const Icon = SUB_ICONS[sub.key];
  const items = missingItemsFor(sub.key, data, profileItems);
  const shown = items.slice(0, 6);
  const more = items.length - shown.length;

  // Collapse the repetitive per-item notes into a ranked tally of problem
  // types, so the same information reads as a visual breakdown, not a list.
  const topIssues = useMemo(() => {
    const tally = new Map<string, number>();
    for (const it of items) {
      for (const tag of it.note ? it.note.split(" · ") : []) {
        tally.set(tag, (tally.get(tag) ?? 0) + 1);
      }
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [items]);
  // Bars only make sense when a problem actually repeats; otherwise (freshness,
  // profile — every note unique) fall back to titled chips.
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
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="briefing-title"
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 48, opacity: 0.5 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 48, opacity: 0 }}
        transition={{ type: "spring", stiffness: 360, damping: 34 }}
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-border bg-surface p-6 shadow-elevate sm:rounded-3xl"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-border sm:hidden" />

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
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <span className={`font-bold ${tone.text}`}>{sub.score}%</span> now ·{" "}
                  <span className="font-bold text-emerald-600">+{sub.potentialGain} pts</span> to
                  gain
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          </motion.div>

          {/* What's holding it back — a hero count + visual problem breakdown. */}
          <motion.p
            variants={item}
            className="mt-6 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"
          >
            What's holding it back
          </motion.p>
          <motion.div variants={item} className="mt-2 flex items-end gap-2">
            <span className={`font-display text-4xl font-black leading-none ${tone.text}`}>
              {sub.failing}
            </span>
            <span className="pb-0.5 text-sm font-semibold text-muted-foreground">
              {sub.unit} need attention
            </span>
          </motion.div>

          {useBars ? (
            <motion.div variants={container} className="mt-4 space-y-2.5">
              {topIssues.map(([label, count]) => (
                <motion.div key={label} variants={item}>
                  <div className="mb-1 flex items-center justify-between text-[11px] font-semibold">
                    <span className="text-foreground/80">{label}</span>
                    <span className="text-muted-foreground">{count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <motion.div
                      className="h-full rounded-full bg-amber-400"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(6, (count / sub.failing) * 100)}%` }}
                      transition={{ duration: 0.6, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </div>
                </motion.div>
              ))}
            </motion.div>
          ) : (
            <motion.div variants={container} className="mt-3 flex flex-wrap gap-1.5">
              {shown.map((m) => (
                <motion.span
                  key={m.id}
                  variants={item}
                  className="max-w-full truncate rounded-full bg-surface-2/70 px-3 py-1.5 text-xs font-medium"
                >
                  {m.title}
                </motion.span>
              ))}
              {more > 0 && (
                <motion.span
                  variants={item}
                  className="rounded-full px-2 py-1.5 text-xs text-muted-foreground"
                >
                  +{more} more
                </motion.span>
              )}
            </motion.div>
          )}

          {/* How we'll fix it — three glanceable steps, connected left to right. */}
          <motion.p
            variants={item}
            className="mt-6 text-[11px] font-bold uppercase tracking-wide text-muted-foreground"
          >
            How we'll fix it
          </motion.p>
          <motion.div variants={container} className="mt-2.5 flex items-stretch gap-1">
            {HOW_STEPS[sub.key].map((step, i) => (
              <Fragment key={i}>
                <motion.div
                  variants={item}
                  className="flex flex-1 flex-col items-center gap-1.5 rounded-2xl bg-surface-2/50 px-1.5 py-3 text-center"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary">
                    <step.icon className="h-4 w-4" />
                  </span>
                  <span className="text-[11px] font-semibold leading-tight text-foreground/85">
                    {step.label}
                  </span>
                </motion.div>
                {i < HOW_STEPS[sub.key].length - 1 && (
                  <ChevronRight className="h-4 w-4 shrink-0 self-center text-muted-foreground/40" />
                )}
              </Fragment>
            ))}
          </motion.div>

          <motion.div variants={item} className="mt-6 flex flex-col gap-1.5">
            <button
              type="button"
              onClick={onStart}
              className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-5 text-sm font-extrabold text-primary-foreground shadow-glow transition hover:opacity-95 active:scale-[0.99]"
            >
              <Sparkles className="h-4 w-4" /> Start fixing <ArrowRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] w-full text-xs font-semibold text-muted-foreground transition hover:text-foreground"
            >
              Maybe later
            </button>
          </motion.div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

/* ---------------- Profile fix: the creator's Pinterest profile ---------------- */

// Where each field is actually edited. Pinterest keeps the profile fields on the
// public-profile settings page and domain claiming on its own page, so a single
// "open Pinterest" link would land the creator one or two clicks short of the
// thing they came to fix.
const PINTEREST_SETTINGS = "https://www.pinterest.com/settings/profile/";
const PINTEREST_CLAIM = "https://www.pinterest.com/settings/claim/";

type ProfileRow = {
  key: ProfileItemKey;
  label: string;
  ok: boolean;
  /** What Pinterest currently has, shown verbatim so it's obvious what to change. */
  value: string | null;
  hint: string;
  href: string | null;
  cta: string;
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

  const rows: ProfileRow[] = [
    {
      key: "avatar",
      label: "Profile photo",
      ok: okOf("avatar"),
      value: snapshot?.profileImage ? "Shown above" : null,
      hint: "A face or logo — profiles without one convert far fewer followers.",
      href: PINTEREST_SETTINGS,
      cta: "Fix on Pinterest",
    },
    {
      key: "bio",
      label: "About / bio",
      ok: okOf("bio"),
      value: snapshot?.about ?? null,
      hint: "Say who you are and what you pin — this is indexed by Pinterest search.",
      href: PINTEREST_SETTINGS,
      cta: "Fix on Pinterest",
    },
    {
      key: "website",
      label: "Website URL",
      ok: okOf("website"),
      value: snapshot?.websiteUrl ?? null,
      hint: "The link on your profile. Claim it too, so every pin from your site is credited to you.",
      href: okOf("website") ? PINTEREST_CLAIM : PINTEREST_SETTINGS,
      cta: okOf("website") ? "Claim it on Pinterest" : "Fix on Pinterest",
    },
    {
      key: "social",
      label: "Pinterest connected",
      ok: okOf("social"),
      value: snapshot?.username ? `@${snapshot.username}` : null,
      hint: "Connect the account so Pinearn can read your profile and pins.",
      href: null,
      cta: "Connect in Settings",
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
      className="fixed inset-0 z-[65] flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pinterest-profile-title"
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 48, opacity: 0.5 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 48, opacity: 0 }}
        transition={{ type: "spring", stiffness: 360, damping: 34 }}
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-border bg-surface p-5 shadow-elevate sm:rounded-3xl"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-border sm:hidden" />

        {/* The profile as Pinterest has it — avatar, name, real counts. */}
        <div className="flex items-start gap-3">
          <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-surface-2 ring-1 ring-border">
            {snapshot?.profileImage ? (
              <img src={snapshot.profileImage} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted-foreground">
                <UserCheck className="h-6 w-6" />
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
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              <span className={`font-bold ${tone.text}`}>{score}%</span> complete
              {connected && (
                <>
                  {" · "}
                  {snapshot!.followerCount.toLocaleString()} followers ·{" "}
                  {snapshot!.pinCount.toLocaleString()} pins
                </>
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

        {/* This is read-only on purpose — say so once, at the top. */}
        <p className="mt-3 rounded-2xl bg-surface-2/70 p-3 text-[12px] leading-snug text-muted-foreground ring-1 ring-inset ring-border/70">
          {connected ? (
            <>
              This is your live Pinterest profile — the page anyone who taps a pin lands on. Pinearn
              can&apos;t edit it, so each fix opens the exact Pinterest setting. Come back and hit
              recheck when you&apos;re done.
            </>
          ) : (
            <>
              {snapshot?.reason ?? "Pinterest isn't connected"} — so these checks fall back to what
              Pinearn knows locally. Connect Pinterest in Settings to score the real profile.
            </>
          )}
        </p>

        <div className="mt-3 space-y-2">
          {rows.map((row) => (
            <div
              key={row.key}
              className={`rounded-2xl border p-3 ${
                row.ok ? "border-border bg-surface" : "border-amber-500/30 bg-amber-500/[0.06]"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <span
                  className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                    row.ok ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/20 text-amber-700"
                  }`}
                >
                  {row.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <X className="h-3 w-3" strokeWidth={3} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold">{row.label}</p>
                  {row.value ? (
                    <p className="mt-0.5 line-clamp-2 break-words text-[12px] text-foreground/75">
                      {row.value}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[12px] italic text-muted-foreground">
                      Not set on Pinterest
                    </p>
                  )}
                  {!row.ok && (
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      {row.hint}
                    </p>
                  )}
                </div>

                {row.href ? (
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-bold transition ${
                      row.ok
                        ? "bg-surface-2 text-muted-foreground ring-1 ring-border hover:text-foreground"
                        : "bg-gradient-primary text-primary-foreground shadow-glow"
                    }`}
                  >
                    {row.ok ? "Edit" : row.cta} <ArrowRight className="h-3 w-3" />
                  </a>
                ) : (
                  <Link
                    to="/profile"
                    search={{ focus: "pinterest" }}
                    className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-bold transition ${
                      row.ok
                        ? "bg-surface-2 text-muted-foreground ring-1 ring-border hover:text-foreground"
                        : "bg-gradient-primary text-primary-foreground shadow-glow"
                    }`}
                  >
                    {row.ok ? "Manage" : row.cta} <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onRecheck}
            disabled={refreshing}
            className="inline-flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 border-primary bg-surface text-[13px] font-bold text-primary transition disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Rechecking…" : "Recheck profile"}
          </button>
          {connected && snapshot?.username && (
            <a
              href={`https://www.pinterest.com/${snapshot.username}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[48px] shrink-0 items-center justify-center gap-1.5 rounded-2xl bg-surface-2 px-4 text-[13px] font-bold text-muted-foreground ring-1 ring-border transition hover:text-foreground"
            >
              <Link2 className="h-4 w-4" /> View
            </a>
          )}
        </div>
      </motion.div>
    </motion.div>
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
  const Icon = SUB_ICONS[sub.key];
  const optimized = sub.score >= 100;

  // Show points earned out of this area's max contribution to the overall
  // score (its weight as points), e.g. Pin SEO at 20% → "7/35". The bar itself
  // stays proportional to the raw percentage.
  const totalPts = Math.round(SUB_SCORE_WEIGHTS[sub.key] * 100);
  const earnedPts = Math.round(SUB_SCORE_WEIGHTS[sub.key] * sub.score);

  if (optimized) {
    return (
      <div className="flex items-center gap-3.5 rounded-2xl border border-border bg-surface/60 px-4 py-4">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-500">
          <Icon className="h-5 w-5" />
        </div>
        <p className="min-w-0 flex-1 truncate text-[15px] font-semibold">{sub.label}</p>
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
      <div
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tone.bg} ${tone.text}`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold">{sub.label}</p>
        <div className="mt-2 flex items-center gap-2.5">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
            <motion.div
              className={`h-full rounded-full ${tone.bar}`}
              initial={false}
              animate={{ width: `${sub.score}%` }}
              transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <span className={`shrink-0 text-right text-xs font-extrabold tabular-nums ${tone.text}`}>
            {earnedPts}/{totalPts} pts
          </span>
        </div>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
    </motion.button>
  );
}

/* ---------------- "How your score works" explainer ---------------- */

function HowScoringWorks() {
  const [open, setOpen] = useState(false);
  const keys: SubScoreKey[] = ["pinSeo", "boardStructure", "profile", "freshness"];
  return (
    <div className="mt-3 rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-xs font-semibold">How your score works</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 px-4 pb-4">
              {keys.map((k) => (
                <div key={k} className="border-t border-border/60 pt-3">
                  <p className="flex items-center justify-between text-sm font-semibold">
                    {
                      {
                        pinSeo: "Pin SEO",
                        boardStructure: "Board Structure",
                        profile: "Profile Completeness",
                        freshness: "Content Freshness",
                      }[k]
                    }
                    <span className="text-[11px] font-bold text-muted-foreground">
                      {Math.round(SUB_SCORE_WEIGHTS[k] * 100)}% of score
                    </span>
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {SCORE_CRITERIA[k]}
                  </p>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
      <h2 className="mt-4 font-display text-2xl font-bold">Your Boost Score starts here</h2>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
        Once you have pins and boards, we'll score your Pinterest SEO and show you exactly what to
        fix. Add your first pin to begin.
      </p>
      <div className="mt-6 flex flex-col justify-center gap-2.5 sm:flex-row">
        <Link
          to="/pins/create"
          search={{ board: undefined }}
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-gradient-primary px-5 py-3 text-sm font-bold text-primary-foreground shadow-glow"
        >
          <ImagePlus className="h-4 w-4" /> Create your first pin
        </Link>
        <Link
          to="/pins/attach"
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-surface px-5 py-3 text-sm font-semibold text-foreground transition hover:bg-surface-2"
        >
          <Link2 className="h-4 w-4" /> Import from Pinterest
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
