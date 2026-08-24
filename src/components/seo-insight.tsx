import { motion } from "framer-motion";
import {
  AlignLeft,
  CalendarClock,
  Check,
  ChevronRight,
  FolderTree,
  Layers,
  Lightbulb,
  Link2,
  PencilLine,
  Repeat,
  Search,
  TrendingUp,
  Type,
  UserCheck,
  X,
} from "lucide-react";
import { AppSheet } from "@/components/app-sheet";
import {
  maxPointsFor,
  PIN_DESC_MAX,
  PIN_DESC_MIN,
  PIN_TITLE_MAX,
  PIN_TITLE_MIN,
  FRESH_DAYS,
  SUB_SCORE_LABELS,
  type SubScoreKey,
} from "@/lib/health-score";
import { IMPACT_FACTORS } from "@/lib/pin-impact";

/* ============================================================================
   The bulb — one sheet per area of the Boost Score.

   This used to be two surfaces a tap apart: a "How it works" sheet (pass
   criteria, ranking, four numbered steps) and a bulb (why Pinterest cares).
   Two buttons in one app bar, both answering "what is this screen", and
   between them about three hundred words. So they're one sheet now, and the
   merge was the moment to cut: every part that was a sentence is a chip, the
   numbered list is a single flow line, and only the promise gets to be prose.

   Reading order, top to bottom: what it is → what passes → what drives it →
   what to tap. Nothing here is longer than a phone line.
   ========================================================================== */

type Driver = { icon: typeof Type; label: string; line: string };

type SeoInsight = {
  /** The one-line promise, under the heading. The only prose on the sheet. */
  promise: string;
  /** What this area buys them on Pinterest, in half a line. */
  matters: string;
  /** Pass criteria as chips, not a sentence — the specs, in the fewest words
   * that stay exact. Built from the scoring constants so copy can't drift. */
  checks: string[];
  drivers: Driver[];
  /** What decides queue order, labels only. Omitted where nothing ranks. */
  ranking?: readonly string[];
  /** The taps that drive the flow, rendered as one chevroned line. Omitted for
   * areas with no fix deck behind them. */
  steps?: readonly string[];
};

export const SEO_INSIGHTS: Record<SubScoreKey, SeoInsight> = {
  pinSeo: {
    promise: "Pinterest reads your words before it shows your picture.",
    matters: "Every pin is a search result. Text is what gets indexed.",
    checks: [
      `Title ${PIN_TITLE_MIN}–${PIN_TITLE_MAX} chars`,
      `Description ${PIN_DESC_MIN}–${PIN_DESC_MAX}`,
      "Nothing generic",
    ],
    drivers: [
      {
        icon: Type,
        label: "Titles that say the thing",
        line: "“IMG_2043” tells Pinterest nothing to rank you for.",
      },
      {
        icon: AlignLeft,
        label: "Descriptions with substance",
        line: "Enough context to match you to a real search.",
      },
      {
        icon: Search,
        label: "Words people type",
        line: "“Linen midi dress” beats “summer feels”.",
      },
    ],
    ranking: IMPACT_FACTORS,
    steps: ["Tap pins to queue", "Boost", "Apply or skip"],
  },
  boardStructure: {
    promise: "Boards are the categories Pinterest files your pins under.",
    matters: "A good board name pushes all of its pins into the right feeds.",
    checks: ["A real name", "A description", "One topic"],
    drivers: [
      {
        icon: FolderTree,
        label: "Specific board names",
        line: "“Autumn Knitwear” can rank. “My Pins” is a folder.",
      },
      {
        icon: AlignLeft,
        label: "A real description",
        line: "What everything inside has in common.",
      },
      {
        icon: Layers,
        label: "One topic per board",
        line: "Tight boards build authority; catch-alls dilute.",
      },
    ],
    steps: ["Tap boards to queue", "Boost", "Apply or skip"],
  },
  freshness: {
    promise: "Pinterest distributes accounts that are still publishing.",
    matters: "Quiet boards drop out of feeds quietly — no penalty, just silence.",
    checks: [`Pinned in ${FRESH_DAYS} days`, "Every board", "A steady rhythm"],
    drivers: [
      {
        icon: CalendarClock,
        label: "Something from this month",
        line: "A pin in the last 30 days reads as active.",
      },
      {
        icon: Repeat,
        label: "A steady rhythm",
        line: "A few a week travels further than fifty at once.",
      },
      {
        icon: TrendingUp,
        label: "New pins first",
        line: "Fresh pins get tested, then earn for months.",
      },
    ],
  },
  profile: {
    promise: "Your profile is where a pin's traffic lands and decides to stay.",
    matters: "You earn the visit with a pin. An empty profile loses the follow.",
    checks: ["Bio + photo", "Website claimed", "Account connected"],
    drivers: [
      {
        icon: UserCheck,
        label: "Photo and name",
        line: "The first thing seen after tapping through.",
      },
      {
        icon: PencilLine,
        label: "A bio with keywords",
        line: "Your About text is indexed too.",
      },
      {
        icon: Link2,
        label: "A claimed website",
        line: "Puts your name on every pin from your site.",
      },
    ],
  },
};

/** The bulb. Sits next to an area's name anywhere the area is named — white,
 * like every other bulb in the app, so all of them read as one control. */
export function SeoInsightButton({
  label,
  onClick,
  className = "",
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`How ${label} works`}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-muted-foreground shadow-sm transition hover:text-foreground active:scale-95 ${className}`}
    >
      <Lightbulb className="h-[18px] w-[18px]" strokeWidth={2.25} />
    </button>
  );
}

/**
 * The sheet. Opens over whatever named the area — including over another sheet,
 * which AppSheet handles (Escape closes the top one only).
 */
export function SeoInsightSheet({ subKey, onClose }: { subKey: SubScoreKey; onClose: () => void }) {
  const insight = SEO_INSIGHTS[subKey];
  const label = SUB_SCORE_LABELS[subKey];
  const max = maxPointsFor(subKey);

  return (
    <AppSheet onClose={onClose} labelledBy="seo-insight-title">
      {/* Amber, not primary: this is the one surface in Boost that teaches
          rather than asks, and the colour is how a returning creator knows a
          bulb never costs them anything. */}
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 left-6 h-40 w-40 rounded-full bg-amber-400/20 blur-3xl"
        />

        <div className="relative flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-amber-400/20 text-amber-600 ring-1 ring-inset ring-amber-500/25">
              <Lightbulb className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-micro font-bold uppercase tracking-[0.14em] text-amber-600">
                How it works
              </p>
              <h2
                id="seo-insight-title"
                className="truncate font-display text-lg font-bold leading-tight"
              >
                {label}
              </h2>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* The pts badge rides the header now: it's the answer to "why this
                screen", so it belongs beside the title, not in a footer box. */}
            <span className="rounded-full bg-primary/10 px-2 py-1 text-micro font-bold tabular-nums text-primary">
              {max} pts
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <p className="relative mt-4 font-display text-[19px] font-bold leading-snug tracking-tight">
          {insight.promise}
        </p>
        <p className="relative mt-1 text-mini leading-relaxed text-muted-foreground">
          {insight.matters}
        </p>

        {/* Passes when — chips. The old sheet spent a boxed paragraph on the
            same three numbers; a spec reads faster than a sentence about it. */}
        <div className="relative mt-4 flex flex-wrap gap-1.5">
          {insight.checks.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-micro font-bold text-emerald-700 ring-1 ring-inset ring-emerald-500/20"
            >
              <Check className="h-3 w-3" strokeWidth={3} /> {c}
            </span>
          ))}
        </div>

        {/* Three drivers on one rail — the rail is what makes them read as the
            recipe for one number rather than three unrelated tips. */}
        <div className="relative mt-5 pl-1">
          <span
            aria-hidden
            className="absolute bottom-4 left-[21px] top-4 w-px bg-gradient-to-b from-amber-400/50 via-amber-400/25 to-transparent"
          />
          <div className="space-y-3.5">
            {insight.drivers.map((d, i) => (
              <motion.div
                key={d.label}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.06 + i * 0.07, duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                className="relative flex gap-3"
              >
                <span className="relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface text-amber-600 ring-1 ring-border">
                  <d.icon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-body font-bold leading-tight">{d.label}</p>
                  <p className="mt-0.5 text-mini leading-relaxed text-muted-foreground">{d.line}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Queue order, if this flow ranks. Four labels instead of four
            sentences: the point is that the order is auditable, and naming the
            factors does that as well as explaining each one did. */}
        {insight.ranking && (
          <div className="relative mt-5">
            <p className="inline-flex items-center gap-1.5 text-micro font-bold uppercase tracking-[0.12em] text-muted-foreground">
              <TrendingUp className="h-3 w-3 text-amber-500" /> What we queue first
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {insight.ranking.map((r) => (
                <span
                  key={r}
                  className="rounded-full bg-surface-2 px-2.5 py-1 text-micro font-semibold text-foreground/75 ring-1 ring-inset ring-border/70"
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* The old numbered list of four, as one line you can read at a glance
            with the controls it names already on screen behind the sheet. */}
        {insight.steps && (
          <div className="relative mt-4 flex flex-wrap items-center gap-x-1 gap-y-1.5 rounded-2xl bg-surface-2/60 px-3 py-2.5 ring-1 ring-inset ring-border/60">
            {insight.steps.map((s, i) => (
              <span key={s} className="inline-flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
                <span className="text-mini font-bold text-foreground/80">{s}</span>
              </span>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="relative mt-4 min-h-[48px] w-full rounded-2xl bg-surface-2 text-body font-bold text-foreground transition hover:bg-surface-2/70"
        >
          Got it
        </button>
      </div>
    </AppSheet>
  );
}
