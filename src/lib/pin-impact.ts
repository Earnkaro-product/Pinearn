/**
 * Which pins are worth rewriting — and what each rewrite is actually worth.
 *
 * health-score.ts answers a different question: does this pin PASS the SEO
 * check. That's a binary, and it's the same binary for every pin, which is why
 * the old picker ranked a 5.8K-impression pin and a pin nobody has ever seen
 * as equally urgent and told both of them "+0.1 pts". Two problems with that,
 * and they're the two things a creator actually cares about:
 *
 *   1. Nobody rewrites a pin that's working. A pin pulling a strong click rate
 *      has earned its distribution; new copy resets the signal Pinterest has
 *      already learned about it. "Technically fails the length band" is not a
 *      reason to touch it, and a tool that nags you to is a tool you stop
 *      trusting.
 *   2. A pin with no reach isn't unlucky — it's unreadable. Pinterest's image
 *      models carry a pin only so far; past that, the title and description are
 *      the entire input to what it gets classified as and which searches it can
 *      surface in. So a pin sitting at ~zero views while its board-mates get
 *      thousands is the strongest possible signal that its COPY is the thing
 *      holding it back. That's the biggest opportunity on the page, and the old
 *      ranking put it dead last because it sorted on impressions.
 *
 * So this module scores opportunity, not compliance. It reads the four things
 * the creator can see on the card — impressions, clicks, title, description —
 * plus how the pin compares to its own board, and produces one 0–100 impact
 * score, a plain-language diagnosis, and a modelled reach lift.
 *
 * Everything here is deterministic, synchronous and pure, in the same spirit as
 * health-score.ts: the picker re-ranks instantly and the numbers on the cards
 * can always be re-derived from the row.
 */

import {
  isPlaceholderText,
  PIN_DESC_MAX,
  PIN_DESC_MIN,
  PIN_TITLE_MAX,
  PIN_TITLE_MIN,
} from "./health-score";

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export type ImpactPin = {
  id: string;
  /** RAW title — not the "Untitled pin" placeholder the UI substitutes. The
   * whole model turns on whether Pinterest has real words to read. */
  title: string | null;
  description: string | null;
  /** Impressions in the analytics window. */
  impressions: number;
  /** Pin clicks (closeups) in the analytics window — not outbound clicks. */
  clicks: number;
  boardId: string | null;
  createdAt: string;
};

/* ------------------------------------------------------------------ *
 * Tunables — every one of these is a heuristic, named so it can be argued
 * with. They're exported where the UI has to say the same number out loud.
 * ------------------------------------------------------------------ */

/** Pin analytics are pulled for a rolling 90 days (see `getPinAnalytics`), so
 * every reach figure on this surface means "in the last 90 days" and the UI
 * must say so rather than implying lifetime totals. */
export const ANALYTICS_WINDOW_DAYS = 90;

/** Under this many impressions Pinterest hasn't really tested the pin, so its
 * click rate is noise and must not be shown as a verdict. */
export const VISIBLE_IMPRESSIONS = 100;

/** Over this, a click rate is a real reading — and a good one is worth
 * protecting rather than overwriting. */
export const PROVEN_IMPRESSIONS = 250;

/** A pin's first weeks decide how far it ever travels. Inside this window a
 * weak title is still cheap to fix; outside it, the pin has already been
 * classified and is climbing out of a hole. */
export const AUDITION_DAYS = 21;

/** Click-rate benchmark for an account with too few measurable pins to have a
 * meaningful median of its own. */
const CTR_FALLBACK = 0.01;

/** How far past the account's OWN median click rate a pin must sit to count as
 * working. Relative on purpose: pin-click rates vary wildly by niche, and a
 * fixed "good CTR" constant would either protect everything or nothing. */
const WORKING_CTR_MULTIPLE = 1.15;

/** Share of the addressable reach a copy rewrite is modelled to recover.
 * Deliberately conservative — copy is one input to distribution, not all of
 * it, and an estimate that over-promises is worse than no estimate. */
const COPY_LIFT_CEILING = 0.45;

/** Pinterest reads the title first (it's the ranking surface and the visible
 * line in search); the description carries the long tail. */
const TITLE_WEIGHT = 0.6;

/** How many pins the high tier holds. A COUNT, not a score threshold, and
 * that's the point: on an account where every pin is missing its description,
 * 277 of 289 clear any absolute bar — and a "high impact" list of 277 is the
 * full list wearing a costume. "Fix these first" is only meaningful while it
 * names a first. Six is one coin-friendly sitting. */
export const HIGH_IMPACT_COUNT = 6;
/** Score at or above which a pin is still clearly worth the coin — the
 * medium/low split for everything outside the top handful. */
export const MEDIUM_IMPACT_SCORE = 34;

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[clamp(Math.round((p / 100) * (s.length - 1)), 0, s.length - 1)];
}

/* ------------------------------------------------------------------ *
 * Copy quality — how much of a pin's discoverability its own text throws away
 * ------------------------------------------------------------------ */

/** 0 = nothing Pinterest can index, 1 = inside the band it rewards. Graded
 * rather than pass/fail: a 38-character title is one word short, a "IMG_0231"
 * is a total loss, and treating those as the same failure is what made every
 * pin look equally broken. */
export function titleQuality(title: string | null | undefined): number {
  const t = (title ?? "").trim();
  if (isPlaceholderText(t)) return 0;
  if (t.length > PIN_TITLE_MAX) return 0.7; // real words, but truncated in feed
  if (t.length >= PIN_TITLE_MIN) return 1;
  return 0.15 + 0.6 * (t.length / PIN_TITLE_MIN);
}

/** Same grading for the description. A missing description scores zero: it's
 * the single biggest block of keyword surface a pin has, and leaving it empty
 * is the most common reason a good image never gets classified. */
export function descriptionQuality(description: string | null | undefined): number {
  const d = (description ?? "").trim();
  if (isPlaceholderText(d)) return 0;
  if (d.length > PIN_DESC_MAX) return 0.75;
  if (d.length >= PIN_DESC_MIN) return 1;
  return 0.1 + 0.55 * (d.length / PIN_DESC_MIN);
}

/** 0 = the copy is already doing everything it can, 1 = Pinterest has nothing
 * to read. This is the lever the rewrite actually pulls. */
export function copyGap(pin: Pick<ImpactPin, "title" | "description">): number {
  const quality =
    TITLE_WEIGHT * titleQuality(pin.title) +
    (1 - TITLE_WEIGHT) * descriptionQuality(pin.description);
  return clamp(1 - quality, 0, 1);
}

/* ------------------------------------------------------------------ *
 * Account context — the yardsticks every pin is measured against
 * ------------------------------------------------------------------ */

export type ImpactContext = {
  /** What "a lot of reach" means on THIS account (p75 of the pins that have
   * any reach at all). Relative, because 5K impressions is a rounding error on
   * one account and a career best on another. */
  reachYardstick: number;
  /** The account's own median pin-click rate among pins with enough
   * impressions to judge. */
  ctrBenchmark: number;
  /** boardId → what a pin on that board gets WHEN it gets seen (median of its
   * non-zero impressions). The gap between this and a pin's own reach is the
   * cleanest available read on "your copy, not your image, is the problem" —
   * same board, same audience, same visual style. */
  boardBaseline: Map<string, number>;
  /** The account-wide version of the above, used when a board has too little
   * history of its own. */
  accountBaseline: number;
  /** False when every pin reads zero impressions. Analytics are synced in
   * batches and the column defaults to 0, so an all-zero account means "we
   * don't know yet", NOT "nobody saw anything". The model drops to copy
   * quality alone and the UI has to say the reach numbers are missing rather
   * than present a default as a measurement. */
  hasAnalytics: boolean;
  /** How many pins carry a usable reach reading — drives that same disclosure. */
  measuredPins: number;
};

export function buildImpactContext(pins: ImpactPin[]): ImpactContext {
  const seen = pins.map((p) => Math.max(0, p.impressions || 0)).filter((n) => n > 0);
  const hasAnalytics = seen.length > 0;

  const judgeable = pins.filter((p) => (p.impressions || 0) >= VISIBLE_IMPRESSIONS);
  const ctrs = judgeable
    .map((p) => Math.max(0, p.clicks || 0) / p.impressions)
    .filter((n) => Number.isFinite(n));
  // Five readings is the fewest that makes a median mean anything; below that
  // the account borrows the flat fallback instead of over-fitting to one pin.
  const ctrBenchmark = ctrs.length >= 5 ? Math.max(median(ctrs), CTR_FALLBACK / 2) : CTR_FALLBACK;

  const perBoard = new Map<string, number[]>();
  for (const p of pins) {
    const reach = Math.max(0, p.impressions || 0);
    if (!p.boardId || reach <= 0) continue;
    const bucket = perBoard.get(p.boardId);
    if (bucket) bucket.push(reach);
    else perBoard.set(p.boardId, [reach]);
  }
  const accountBaseline = median(seen);
  const boardBaseline = new Map<string, number>();
  for (const [boardId, values] of perBoard) {
    // One data point isn't a baseline — it's the pin itself, or a fluke.
    if (values.length < 2) continue;
    boardBaseline.set(boardId, median(values));
  }

  return {
    reachYardstick: percentile(seen, 75),
    ctrBenchmark,
    boardBaseline,
    accountBaseline,
    hasAnalytics,
    measuredPins: seen.length,
  };
}

/* ------------------------------------------------------------------ *
 * The per-pin verdict
 * ------------------------------------------------------------------ */

/**
 * Why this pin is where it is in the ranking. These are diagnoses, not
 * severities — each one implies a different action, which is exactly what the
 * old "2 fixes" badge failed to say.
 *
 * - `untapped`  — Pinterest is already showing it and the clicks aren't
 *                 landing. The reach exists; the copy is the bottleneck.
 * - `audition`  — young enough that its distribution is still being decided.
 *                 The cheapest fix on the board, and it expires.
 * - `invisible` — real history, almost no reach, while its board-mates travel.
 *                 Pinterest can't tell what the image is and the text isn't
 *                 telling it.
 * - `working`   — converting above this account's own median. Leave it alone.
 */
export type PinDiagnosis = "untapped" | "audition" | "invisible" | "working";

/** What the picker groups by. `working` cross-cuts the tiers: a performing pin
 * is never a priority no matter how much reach is at stake. */
export type ImpactGroup = "high" | "medium" | "low" | "working";

export type PinImpact = {
  /** 0–100 opportunity score. The single number the whole page ranks by. */
  score: number;
  group: ImpactGroup;
  diagnosis: PinDiagnosis;
  /** Impressions in the analytics window. */
  reach: number;
  clicks: number;
  /** Pin-click rate, or null when there aren't enough impressions to judge. */
  ctr: number | null;
  /** What a well-described pin in this pin's own company plausibly reaches. */
  addressableReach: number;
  /** Modelled extra impressions a full rewrite unlocks. Null when the account
   * has no analytics at all — an invented number is worse than a blank. */
  reachLift: number | null;
  /** 0–1: the share of its own discoverability the current copy is wasting. */
  gap: number;
  /** True when the pin is converting and a rewrite risks what already works. */
  protect: boolean;
  ageDays: number;
  /** The measurement, in the creator's words. */
  headline: string;
  /** What to do about it, and why. One sentence. */
  detail: string;
};

/** Copy for each diagnosis. Kept beside the model so the words and the maths
 * can't drift — the sentence a card shows IS the rule that ranked it. */
function describe(
  diagnosis: PinDiagnosis,
  d: {
    reach: number;
    ctr: number | null;
    baseline: number;
    ageDays: number;
    gap: number;
    /** False when the account has no reach readings at all. A zero we haven't
     * measured must not be reported as a zero we have — "no views in 90 days"
     * is a finding, and asserting it off an unsynced default would be one we
     * made up. */
    measured: boolean;
  },
): { headline: string; detail: string } {
  const gapWord = d.gap >= 0.75 ? "barely any" : d.gap >= 0.45 ? "thin" : "incomplete";
  switch (diagnosis) {
    case "untapped":
      return {
        headline: `${reachLabel(d.reach)} views, ${ctrLabel(d.ctr)} click through`,
        detail:
          "Pinterest is already showing this pin. The views are there — the copy is what's not converting them.",
      };
    case "audition":
      return {
        headline: d.ageDays <= 1 ? "Posted today" : `${d.ageDays} days old`,
        detail: `Pinterest decides how far a pin travels in its first weeks, and right now it has ${gapWord} text to go on. Cheapest fix you'll make.`,
      };
    case "invisible":
      if (!d.measured) {
        return {
          headline: "No view data yet",
          detail: `Ranked on copy quality alone: Pinterest has ${gapWord} text to read on this pin, and the image can only carry it so far.`,
        };
      }
      return {
        headline:
          d.baseline > 0
            ? `${reachLabel(d.reach)} views vs ${reachLabel(d.baseline)} on this board`
            : `${reachLabel(d.reach)} views in ${ANALYTICS_WINDOW_DAYS} days`,
        detail:
          d.baseline > 0
            ? "Same board, same audience — this one isn't travelling. Pinterest can't read the image, and there's not enough text to classify it."
            : "No reach to speak of. With no keywords to read, Pinterest has nothing to match this pin to.",
      };
    case "working":
      return {
        headline: `${ctrLabel(d.ctr)} click through, ${reachLabel(d.reach)} views`,
        detail:
          "This one is performing. Rewriting resets what Pinterest has learned about it — skip it unless you have a reason.",
      };
  }
}

export function pinImpact(pin: ImpactPin, ctx: ImpactContext, now: number = Date.now()): PinImpact {
  const reach = Math.max(0, pin.impressions || 0);
  const clicks = Math.max(0, pin.clicks || 0);
  const gap = copyGap(pin);
  const ctr = reach >= VISIBLE_IMPRESSIONS ? clicks / reach : null;
  const created = new Date(pin.createdAt).getTime();
  const ageDays = Number.isFinite(created)
    ? Math.max(0, Math.floor((now - created) / 86400000))
    : 999;

  const baseline =
    (pin.boardId ? ctx.boardBaseline.get(pin.boardId) : undefined) ?? ctx.accountBaseline;
  const addressableReach = Math.max(reach, baseline);

  // Two distinct kinds of loss, and a pin can carry both:
  //   missing — reach its board-mates get and it doesn't
  //   wasted  — reach it already has, spent on copy that doesn't convert
  // Both are scaled by the copy gap, because copy is only credited for the
  // share of the problem copy can actually be.
  const missing = Math.max(0, baseline - reach);
  const wasted = reach * gap;
  const reachLift = ctx.hasAnalytics
    ? Math.round((missing * gap + wasted) * COPY_LIFT_CEILING)
    : null;

  const protect =
    ctr !== null && reach >= PROVEN_IMPRESSIONS && ctr >= ctx.ctrBenchmark * WORKING_CTR_MULTIPLE;

  const diagnosis: PinDiagnosis = protect
    ? "working"
    : reach >= VISIBLE_IMPRESSIONS
      ? "untapped"
      : ageDays <= AUDITION_DAYS
        ? "audition"
        : "invisible";

  // How much reach is on the table, log-scaled — the difference between 200 and
  // 2,000 views matters, the difference between 40,000 and 44,000 doesn't.
  const stake =
    ctx.hasAnalytics && ctx.reachYardstick > 0
      ? clamp(Math.log1p(addressableReach) / Math.log1p(ctx.reachYardstick), 0, 1)
      : 0.5; // no analytics: neutral, so the ranking falls back to copy quality
  // Already converting → less headroom to win and more to lose.
  const efficiency = ctr !== null ? clamp(ctr / (ctx.ctrBenchmark * 2), 0, 1) : 0.35;
  const timing = diagnosis === "audition" ? 1 : 0;

  // The copy gap MULTIPLIES rather than adds. Rewriting copy is the only lever
  // this flow pulls, so however much reach is at stake, a pin whose title and
  // description are already doing their job has nothing here to win — and an
  // additive score gave those pins a middling number off their reach alone,
  // which would have read as "worth fixing" for a pin that was fine.
  const upside = 0.5 + 0.34 * stake + 0.1 * timing + 0.06 * (1 - efficiency);
  const score = Math.round(100 * gap * upside * (protect ? 0.45 : 1));

  return {
    score,
    // Provisional — scorePins settles the final grouping, because "high" is a
    // rank (top handful on the account), not a property a pin can have alone.
    group: protect ? "working" : score >= MEDIUM_IMPACT_SCORE ? "medium" : "low",
    diagnosis,
    reach,
    clicks,
    ctr,
    addressableReach,
    reachLift,
    gap,
    protect,
    ageDays,
    ...describe(diagnosis, {
      reach,
      ctr,
      baseline,
      ageDays,
      gap,
      measured: ctx.hasAnalytics,
    }),
  };
}

/**
 * Score a whole deck and settle the groups.
 *
 * Grouping can't be done pin-by-pin: "high impact" is a RANK. The top
 * HIGH_IMPACT_COUNT actionable pins are the high tier, period — never a
 * threshold, because an account where every description is missing puts
 * hundreds of pins over any absolute bar, and a headline section holding 95%
 * of the deck communicates nothing. Working pins never rank high regardless
 * of score; the rest split medium/low on the absolute scale.
 */
export function scorePins(
  pins: ImpactPin[],
  ctx: ImpactContext,
  now: number = Date.now(),
): Map<string, PinImpact> {
  const impacts = pins.map((p) => [p.id, pinImpact(p, ctx, now)] as const);
  // score > 0 keeps already-perfect copy out of the shortlist: this function
  // is fed EVERY pin (the healthy ones set the baselines), and a zero-gap pin
  // ranking "high" would both waste a slot and read as advice to break it.
  const best = impacts
    .filter(([, i]) => !i.protect && i.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, HIGH_IMPACT_COUNT);
  for (const [, impact] of best) impact.group = "high";
  return new Map(impacts);
}

/* ------------------------------------------------------------------ *
 * Presentation helpers — the model owns its own vocabulary so every surface
 * says the same words about the same number.
 * ------------------------------------------------------------------ */

/** 12,400 → "12.4K", and 0 → "no" so a sentence reads ("no views in 90 days"). */
export function reachLabel(value: number): string {
  if (value <= 0) return "no";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

export function ctrLabel(ctr: number | null): string {
  if (ctr === null) return "—";
  return `${(ctr * 100).toFixed(ctr >= 0.1 ? 0 : 1)}%`;
}

// Copy is deliberately short and concrete — these lines sit on a phone screen
// next to photos, and every clause past the first goes unread.
export const GROUP_META: Record<
  ImpactGroup,
  { label: string; short: string; blurb: string; accent: string; dot: string }
> = {
  high: {
    label: "Fix these first",
    short: "Top picks",
    blurb: "Your biggest wins — the most reach for one rewrite.",
    accent: "text-primary",
    dot: "bg-primary",
  },
  medium: {
    label: "Worth fixing",
    short: "Worth it",
    blurb: "Real gains, smaller ceilings.",
    accent: "text-amber-700",
    dot: "bg-amber-500",
  },
  low: {
    label: "Low priority",
    short: "Later",
    blurb: "Little reach at stake — sweep up later.",
    accent: "text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
  working: {
    label: "Already working",
    short: "Working",
    blurb: "These convert above your average. Leave them be.",
    accent: "text-emerald-700",
    dot: "bg-emerald-500",
  },
};

// Badge-length labels. "Still being judged" read as a verdict about the
// creator; a diagnosis on a thumbnail has two words to land in.
export const DIAGNOSIS_META: Record<PinDiagnosis, { label: string; hint: string }> = {
  untapped: { label: "Views, no clicks", hint: "Seen a lot, clicked rarely" },
  audition: { label: "Brand new", hint: `Under ${AUDITION_DAYS} days old` },
  invisible: { label: "Not being seen", hint: "Little reach, nothing to read" },
  working: { label: "Doing well", hint: "Above your median click rate" },
};

/** What decides the order, as chips for the bulb sheet. Naming the factors is
 * what makes the ranking auditable; the old version spent a full sentence on
 * each and none of them were read on a phone. Same contract as SCORE_CRITERIA
 * in health-score.ts. */
export const IMPACT_FACTORS = [
  `Reach at stake (${ANALYTICS_WINDOW_DAYS}d)`,
  "Copy gap",
  "Under 3 weeks old",
  "Beats your click rate → last",
] as const;
