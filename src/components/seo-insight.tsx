import { motion } from "framer-motion";
import {
  AlignLeft,
  CalendarClock,
  FolderTree,
  Layers,
  Lightbulb,
  Link2,
  PencilLine,
  Repeat,
  Search,
  Sparkles,
  TrendingUp,
  Type,
  UserCheck,
  X,
} from "lucide-react";
import { AppSheet } from "@/components/app-sheet";
import { maxPointsFor, SUB_SCORE_LABELS, type SubScoreKey } from "@/lib/health-score";

/* ============================================================================
   "What drives this SEO" — the bulb behind every area of the Boost Score.

   The score already tells a creator WHAT is wrong and the fix flows do the
   work; neither ever says why Pinterest cares. That gap is what makes the whole
   thing feel like a chore list instead of a lever, so it gets its own surface:
   three drivers, one line each, and one sentence on what the area buys you.

   Deliberately short. Everything here competes with the "Start fixing" button
   two taps away — a paragraph would win the screen and lose the session.
   ========================================================================== */

type Driver = { icon: typeof Type; label: string; line: string };

type SeoInsight = {
  /** The one-line promise, under the heading. */
  promise: string;
  drivers: Driver[];
  /** What this area buys them on Pinterest, in one sentence. */
  matters: string;
};

export const SEO_INSIGHTS: Record<SubScoreKey, SeoInsight> = {
  pinSeo: {
    promise: "Pinterest reads your words before it shows your picture.",
    drivers: [
      {
        icon: Type,
        label: "Titles that say the thing",
        line: "40–100 characters of real words. “IMG_2043” tells Pinterest nothing to rank you for.",
      },
      {
        icon: AlignLeft,
        label: "Descriptions with substance",
        line: "200–500 characters gives the algorithm enough context to match you to a search.",
      },
      {
        icon: Search,
        label: "Words people type",
        line: "Name the object, not the mood. “Linen midi dress” beats “summer feels”.",
      },
    ],
    matters:
      "Every pin is a search result. Text is what gets indexed — the image only decides who taps.",
  },
  boardStructure: {
    promise: "Boards are the categories Pinterest files your pins under.",
    drivers: [
      {
        icon: FolderTree,
        label: "Specific board names",
        line: "“Autumn Knitwear” is a topic that can rank. “My Pins” is a folder.",
      },
      {
        icon: AlignLeft,
        label: "A real description",
        line: "One or two lines telling Pinterest what everything inside has in common.",
      },
      {
        icon: Layers,
        label: "One topic per board",
        line: "Tight boards build authority. A catch-all board dilutes every pin in it.",
      },
    ],
    matters: "A well-named board pushes all of its pins into the right feeds at once.",
  },
  freshness: {
    promise: "Pinterest distributes accounts that are still publishing.",
    drivers: [
      {
        icon: CalendarClock,
        label: "Something from this month",
        line: "A board with a pin from the last 30 days reads as active.",
      },
      {
        icon: Repeat,
        label: "A steady rhythm",
        line: "A few pins a week travels further than fifty pins in one afternoon.",
      },
      {
        icon: TrendingUp,
        label: "New pins first",
        line: "Fresh pins get tested in feeds, then keep earning for months.",
      },
    ],
    matters:
      "Quiet boards quietly drop out of the feeds they used to reach — no penalty, just silence.",
  },
  profile: {
    promise: "Your profile is where a pin's traffic lands and decides to stay.",
    drivers: [
      {
        icon: UserCheck,
        label: "Photo and name",
        line: "The first thing anyone sees after tapping through from a pin.",
      },
      {
        icon: PencilLine,
        label: "A bio with keywords",
        line: "Your About text is indexed too. Say what you make and who it's for.",
      },
      {
        icon: Link2,
        label: "A claimed website",
        line: "Claiming proves the site is yours and puts your name on every pin from it.",
      },
    ],
    matters: "You earn the visit with a pin. An empty profile is where you lose the follow.",
  },
};

/** The bulb. Sits next to an area's name anywhere the area is named. */
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
      aria-label={`What drives ${label}`}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-400/15 text-amber-600 ring-1 ring-inset ring-amber-500/25 transition hover:bg-amber-400/25 active:scale-95 ${className}`}
    >
      <Lightbulb className="h-4 w-4" />
    </button>
  );
}

/**
 * The insight sheet itself. Opens over whatever named the area — including over
 * another sheet, which AppSheet handles (Escape closes the top one only).
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
                What drives it
              </p>
              <h2
                id="seo-insight-title"
                className="truncate font-display text-lg font-bold leading-tight"
              >
                {label}
              </h2>
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
        </div>

        <p className="relative mt-4 font-display text-[19px] font-bold leading-snug tracking-tight">
          {insight.promise}
        </p>

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

        {/* The payoff line, with the pts it's worth — the bulb's whole argument
            for why this area deserves the next ten minutes. */}
        <div className="relative mt-5 rounded-2xl bg-surface-2/60 p-3.5 ring-1 ring-inset ring-border/60">
          <div className="flex items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 text-micro font-bold uppercase tracking-[0.12em] text-muted-foreground">
              <Sparkles className="h-3 w-3 text-amber-500" /> Why it matters
            </p>
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-micro font-bold tabular-nums text-primary">
              {max} pts
            </span>
          </div>
          <p className="mt-1.5 text-mini leading-relaxed text-foreground/80">{insight.matters}</p>
        </div>

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
