// Pinterest Health Score — pure heuristic scoring, no external API.
// Everything here is deterministic and synchronous so the dashboard can
// re-run it instantly after a fix flow and animate the number climbing.

/* ---------------- Input shapes ---------------- */

export type HealthPin = {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  collection_id: string | null;
  impressions?: number | null;
  clicks?: number | null;
  /** The real board a pin came from. Going live re-homes a pin into its own
   * per-pin collection, so `collection_id` stops pointing at a board and this
   * is the only remaining link back to one. */
  origin_collection_id?: string | null;
  created_at: string;
};

/** Which board a pin actually belongs to for scoring purposes. Always prefer
 * the origin: a live pin's `collection_id` points at a per-pin container that
 * isn't a board at all, so counting it there makes its real board look empty
 * and stale. */
export function boardIdOf(pin: Pick<HealthPin, "collection_id" | "origin_collection_id">) {
  return pin.origin_collection_id ?? pin.collection_id;
}

export type HealthBoard = {
  id: string;
  name: string;
  description: string | null;
  cover_image_url: string | null;
};

/**
 * The PINTEREST profile, which is what this score is about.
 *
 * Profile SEO used to be scored from the ShopMyPin storefront — storefront description as
 * "bio", `is_published` as "website claimed". That measured the wrong profile: a
 * creator with a perfect storefront and an empty Pinterest bio scored 100 while
 * every visitor who tapped through from a pin landed on a blank page. These flags
 * now come from Pinterest's /user_account (see pinterest-profile.functions.ts),
 * so the score moves only when the profile people actually see improves.
 */
export type HealthProfile = {
  // bio filled → the Pinterest profile's `about` text
  bioFilled: boolean;
  // avatar set → the Pinterest profile photo
  avatarSet: boolean;
  // website set → the Pinterest profile's website_url
  websiteClaimed: boolean;
  // account connected → we can read (and the creator can fix) the profile at all
  socialLinked: boolean;
  // False when Pinterest couldn't be read and the flags fall back to what ShopMyPin
  // knows locally — the UI says so rather than presenting a guess as fact.
  fromPinterest?: boolean;
};

/* ---------------- Generic/placeholder detection ---------------- */

// Camera dumps ("IMG_0231", "DSC1234"), Pinterest defaults ("Pin 12"),
// numeric-only, "untitled"/"new board" style names, or effectively-empty text.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^\s*$/,
  /^(img|dsc|dcim|photo|image|screenshot)[-_ ]?\d*\s*$/i,
  /^pin\s*\d*$/i,
  /^\d+$/,
  /^(untitled|new board|new pin|my board|board \d+|no title|none|n\/a)$/i,
  // Names WE generate, which are therefore placeholders by definition: the
  // Pinterest import falls back to "Pin collection" for any pin without a
  // title (see pinterest.functions.ts). Leaving this out was a real bug — the
  // score never flagged such a board as generically named, so Board Boost only
  // ever reported "No description" and then "suggested" the same useless name
  // straight back. Anchored so a real name like "Denim Collection" is safe.
  /^(pin collection|new collection|my (pins|collection|boards?)|collections?|boards?|pins)$/i,
];

export function isPlaceholderText(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return PLACEHOLDER_PATTERNS.some((re) => re.test(t));
}

/* ---------------- Per-item checks ---------------- */

export const PIN_TITLE_MIN = 40;
export const PIN_TITLE_MAX = 100;
export const PIN_DESC_MIN = 200;
export const PIN_DESC_MAX = 500;
export const FRESH_DAYS = 30;

export function pinSeoIssues(pin: Pick<HealthPin, "title" | "description">): string[] {
  const issues: string[] = [];
  const title = (pin.title ?? "").trim();
  const desc = (pin.description ?? "").trim();
  if (isPlaceholderText(title)) issues.push("Generic title");
  else if (title.length < PIN_TITLE_MIN) issues.push("Title too short");
  else if (title.length > PIN_TITLE_MAX) issues.push("Title too long");
  if (isPlaceholderText(desc)) issues.push("Missing description");
  else if (desc.length < PIN_DESC_MIN) issues.push("Description too short");
  else if (desc.length > PIN_DESC_MAX) issues.push("Description too long");
  return issues;
}

export function pinPassesSeo(pin: Pick<HealthPin, "title" | "description">): boolean {
  return pinSeoIssues(pin).length === 0;
}

export function boardIssues(board: Pick<HealthBoard, "name" | "description">): string[] {
  const issues: string[] = [];
  if (isPlaceholderText(board.name)) issues.push("Generic name");
  const desc = (board.description ?? "").trim();
  if (desc.length === 0) issues.push("No description");
  return issues;
}

export function boardPassesStructure(board: Pick<HealthBoard, "name" | "description">): boolean {
  return boardIssues(board).length === 0;
}

/**
 * Order a Boost deck so the worst items come first.
 *
 * The decks review EVERY pin and board, not only the ones failing the health
 * check — a title that technically passes the length bands can still be losing
 * to a better keyword. But "review everything" only works if the genuinely
 * broken items are still at the front; otherwise a creator spends their first
 * ten swipes on copy that was already fine and quits before reaching the
 * placeholders. Sorted by issue count descending, and stable within a group so
 * the caller's own ordering (newest first) survives.
 */
export function byIssueCountDesc<T>(items: T[], issuesOf: (item: T) => string[]): T[] {
  return items
    .map((item, i) => ({ item, i, n: issuesOf(item).length }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.item);
}

/* ---------------- Sub-scores + overall ---------------- */

export type SubScoreKey = "pinSeo" | "boardStructure" | "profile" | "freshness";

export type SubScore = {
  key: SubScoreKey;
  label: string;
  score: number; // 0–100
  // Items failing the check — what the fix flow acts on. Empty at 100%.
  failing: number;
  total: number;
  // Noun for the failing count, e.g. "3 pins", "2 boards".
  unit: string;
  // Points this area could add to the OVERALL score if fully fixed —
  // weight × (100 − score), rounded. This is what makes "biggest win" honest:
  // a low-weight area with a low raw score can still be worth fewer points.
  potentialGain: number;
};

export type ProfileItemKey = "bio" | "avatar" | "website" | "social";

export type ProfileItem = { key: ProfileItemKey; label: string; ok: boolean };

export type HealthReport = {
  overall: number;
  subScores: SubScore[];
  // The weakest area by recoverable points — drives the hero CTA and the
  // "biggest win" badge. Null when everything is already at 100.
  worstKey: SubScoreKey | null;
  // The diagnosis sentence ALONE (no score prefix) — rendered directly, never
  // string-parsed. `summary` keeps the "62/100 — …" form for compact surfaces.
  diagnosis: string;
  summary: string;
  // The four profile checks, each individually deep-linkable.
  profileItems: ProfileItem[];
  // A brand-new account with nothing to score — the UI shows onboarding
  // instead of a hollow 100/100.
  isEmpty: boolean;
};

// Pin SEO drives reach hardest, so it carries the most weight. Revisit once
// real usage data shows which sub-score correlates with impressions/saves.
//
// Profile SEO is deliberately the lightest of the four. It's four one-off
// switches on a profile ShopMyPin can't edit — the creator fixes them once, on
// pinterest.com, and never touches them again. At its old 0.20 it could swing
// the headline number by 20 points for work that has nothing to do with the pins
// and boards the product actually improves, which made the score jump for reasons
// the creator couldn't act on inside the app. Must sum to 1.
//
// The weights ARE the points: the score is out of 100 pts and each area's weight
// is its slice of them (0.4 → 40 pts). Read them through `maxPointsFor` /
// `pointsEarned` rather than multiplying by 100 at each call site — the whole
// feature speaks in pts, never percentages.
export const SUB_SCORE_WEIGHTS: Record<SubScoreKey, number> = {
  pinSeo: 0.4,
  boardStructure: 0.28,
  profile: 0.1,
  freshness: 0.22,
};

export const SUB_SCORE_LABELS: Record<SubScoreKey, string> = {
  pinSeo: "Pin SEO",
  boardStructure: "Board SEO",
  profile: "Profile SEO",
  freshness: "Content SEO",
};

/** The most points this area can put on the 100-point score. */
export function maxPointsFor(key: SubScoreKey): number {
  return Math.round(SUB_SCORE_WEIGHTS[key] * 100);
}

/**
 * An area's internal 0–100 pass rate expressed as points banked on the overall
 * score. Deliberately unrounded — a run applies one fix at a time and the
 * fraction is what makes the live number visibly move; round (or `pointsLabel`)
 * only at the point of display.
 */
export function pointsEarned(key: SubScoreKey, score: number): number {
  return SUB_SCORE_WEIGHTS[key] * score;
}

/** Points as the creator should read them: never a rounded-up "0.0", never
 * more precision than the number deserves. */
export function pointsLabel(points: number): string {
  if (points <= 0) return "0";
  if (points < 0.1) return "<0.1";
  return points.toFixed(points < 10 ? 1 : 0);
}

// Plain-language pass criteria, surfaced in the "How your score works"
// explainer so the heuristics are auditable rather than a black box. Built
// from the exported constants so copy and logic can't drift apart.
export const SCORE_CRITERIA: Record<SubScoreKey, string> = {
  pinSeo: `Title ${PIN_TITLE_MIN}–${PIN_TITLE_MAX} chars, description ${PIN_DESC_MIN}–${PIN_DESC_MAX}, neither generic.`,
  boardStructure: "A real name, not a placeholder — plus a description.",
  profile: "Bio, photo, website, connected account. Equal weight, all on Pinterest.",
  freshness: `Every board pinned to in the last ${FRESH_DAYS} days.`,
};

// Named after the fields as Pinterest labels them, so the sheet's rows and the
// settings page the creator lands on say the same words.
const PROFILE_ITEM_LABELS: Record<ProfileItemKey, string> = {
  bio: "About / bio",
  avatar: "Profile photo",
  website: "Website URL",
  social: "Pinterest connected",
};

// The one-line diagnosis under the big number, keyed by whichever area is
// dragging the total down the most. No score prefix — the caller renders the
// number separately (a past "62/100 — {sentence}" split was fragile because
// the freshness sentence itself contains an em dash).
const DIAGNOSES: Record<SubScoreKey, string> = {
  pinSeo: "Your titles are costing you reach.",
  boardStructure: "Your boards confuse Pinterest.",
  profile: "Your profile is holding you back.",
  freshness: "Your boards have gone quiet.",
};

function pct(passing: number, total: number): number {
  // An empty set can't fail anything — count it as fully optimized so a brand
  // new account isn't greeted with a wall of zeros it can't act on.
  if (total === 0) return 100;
  return Math.round((passing / total) * 100);
}

// Points an area could add to the overall score if fully fixed.
export function pointsRecoverable(sub: Pick<SubScore, "key" | "score">): number {
  return Math.round(SUB_SCORE_WEIGHTS[sub.key] * (100 - sub.score));
}

export function computeHealthReport(
  pins: HealthPin[],
  boards: HealthBoard[],
  profile: HealthProfile,
  now: Date = new Date(),
): HealthReport {
  const pinsPassing = pins.filter(pinPassesSeo).length;
  const boardsPassing = boards.filter(boardPassesStructure).length;

  const profileItems: ProfileItem[] = [
    { key: "bio", label: PROFILE_ITEM_LABELS.bio, ok: profile.bioFilled },
    { key: "avatar", label: PROFILE_ITEM_LABELS.avatar, ok: profile.avatarSet },
    { key: "website", label: PROFILE_ITEM_LABELS.website, ok: profile.websiteClaimed },
    { key: "social", label: PROFILE_ITEM_LABELS.social, ok: profile.socialLinked },
  ];
  const profileScore = profileItems.filter((i) => i.ok).length * 25;
  const profileFailing = profileItems.filter((i) => !i.ok).length;

  // Freshness: % of boards with at least one pin created in the last 30 days.
  const cutoff = now.getTime() - FRESH_DAYS * 86400000;
  const freshBoardIds = new Set(
    pins
      .filter((p) => boardIdOf(p) && new Date(p.created_at).getTime() >= cutoff)
      .map((p) => boardIdOf(p) as string),
  );
  const boardsFresh = boards.filter((b) => freshBoardIds.has(b.id)).length;

  const plural = (n: number, noun: string) => `${noun}${n === 1 ? "" : "s"}`;
  const base: Array<Omit<SubScore, "unit" | "potentialGain">> = [
    {
      key: "pinSeo",
      label: SUB_SCORE_LABELS.pinSeo,
      score: pct(pinsPassing, pins.length),
      failing: pins.length - pinsPassing,
      total: pins.length,
    },
    {
      key: "boardStructure",
      label: SUB_SCORE_LABELS.boardStructure,
      score: pct(boardsPassing, boards.length),
      failing: boards.length - boardsPassing,
      total: boards.length,
    },
    {
      key: "profile",
      label: SUB_SCORE_LABELS.profile,
      score: profileScore,
      failing: profileFailing,
      total: 4,
    },
    {
      key: "freshness",
      label: SUB_SCORE_LABELS.freshness,
      score: pct(boardsFresh, boards.length),
      failing: boards.length - boardsFresh,
      total: boards.length,
    },
  ];
  const UNITS: Record<SubScoreKey, (n: number) => string> = {
    pinSeo: (n) => plural(n, "pin"),
    boardStructure: (n) => plural(n, "board"),
    profile: (n) => plural(n, "item"),
    freshness: (n) => `quiet ${plural(n, "board")}`,
  };
  const subScores: SubScore[] = base.map((s) => ({
    ...s,
    unit: UNITS[s.key](s.failing),
    potentialGain: pointsRecoverable(s),
  }));

  const overall = Math.round(
    subScores.reduce((sum, s) => sum + s.score * SUB_SCORE_WEIGHTS[s.key], 0),
  );

  // Weakest = most recoverable points (an honest "biggest win"), breaking ties
  // toward the heavier-weighted area.
  const worst =
    [...subScores]
      .filter((s) => s.score < 100)
      .sort(
        (a, b) =>
          b.potentialGain - a.potentialGain || SUB_SCORE_WEIGHTS[b.key] - SUB_SCORE_WEIGHTS[a.key],
      )[0] ?? null;

  const isEmpty = pins.length === 0 && boards.length === 0;
  const diagnosis = worst ? DIAGNOSES[worst.key] : "You're fully optimized. Keep it up.";
  const summary = `${overall}/100 — ${diagnosis.charAt(0).toLowerCase() + diagnosis.slice(1)}`;

  return {
    overall,
    subScores,
    worstKey: worst?.key ?? null,
    diagnosis,
    summary,
    profileItems,
    isEmpty,
  };
}

/** Boards with no pin in the fresh window, stalest first — powers the
 * freshness fix list. `daysSinceLastPin` is null when a board has no pins. */
export function staleBoards(
  pins: HealthPin[],
  boards: HealthBoard[],
  now: Date = new Date(),
): Array<{ id: string; name: string; daysSinceLastPin: number | null }> {
  const latestByBoard = new Map<string, number>();
  for (const p of pins) {
    const boardId = boardIdOf(p);
    if (!boardId) continue;
    const t = new Date(p.created_at).getTime();
    if (t > (latestByBoard.get(boardId) ?? 0)) latestByBoard.set(boardId, t);
  }
  const cutoff = now.getTime() - FRESH_DAYS * 86400000;
  return boards
    .map((b) => {
      const latest = latestByBoard.get(b.id) ?? 0;
      return {
        id: b.id,
        name: b.name,
        latest,
        daysSinceLastPin: latest ? Math.floor((now.getTime() - latest) / 86400000) : null,
      };
    })
    .filter((b) => b.latest < cutoff)
    .sort((a, b) => a.latest - b.latest)
    .map((b) => ({ id: b.id, name: b.name, daysSinceLastPin: b.daysSinceLastPin }));
}

/* ---------------- Heuristic rewrite suggestions ---------------- */

// Filler phrases used to pad thin titles/descriptions into the ideal length
// band. Rotated deterministically by a cheap hash of the pin id so a board of
// fixes doesn't read like one copy-pasted sentence.
const TITLE_SUFFIXES = [
  "Ideas & Inspiration You'll Love",
  "Style Guide & Shopping Picks",
  "Must-See Finds for Your Board",
  "Curated Looks Worth Saving",
];

const DESC_OPENERS = [
  "Discover handpicked",
  "Explore our favourite",
  "Save these curated",
  "Browse standout",
];

const DESC_CLOSERS = [
  "Tap through to shop the look, compare prices and grab the best deals before they're gone. Save this pin to revisit these picks anytime and follow for fresh finds every week.",
  "Every pick is chosen for quality and value — tap to see prices, availability and similar styles. Save this pin so these finds are always one tap away on your board.",
  "Shop the full selection with one tap, from budget-friendly picks to premium favourites. Pin it now and come back whenever you need inspiration for your next find.",
];

function hashIdx(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % mod;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Strip placeholder junk; keep whatever real words survive as the topic seed.
function usableTopic(raw: string | null | undefined, fallback: string): string {
  const t = clean(raw ?? "");
  if (!t || isPlaceholderText(t)) return fallback;
  return t;
}

/** Heuristic title rewrite: strip generic text, pad to the 40–100 char band
 * using the pin's board (collection) name as the category anchor. */
export function suggestPinTitle(pin: HealthPin, boardName: string | null): string {
  const anchor = usableTopic(boardName, "Trending Picks");
  let title = usableTopic(pin.title, anchor);
  // If the topic IS the anchor (placeholder title), lead with the anchor.
  if (title.length > PIN_TITLE_MAX)
    return (
      clean(title)
        .slice(0, PIN_TITLE_MAX - 1)
        .trimEnd() + "…"
    );
  if (title.length < PIN_TITLE_MIN) {
    const suffix = TITLE_SUFFIXES[hashIdx(pin.id, TITLE_SUFFIXES.length)];
    const withAnchor = title.toLowerCase().includes(anchor.toLowerCase())
      ? title
      : `${title} — ${anchor}`;
    title = `${withAnchor}: ${suffix}`;
    // Guarantee we clear the floor even for very short anchors (e.g. "Art:
    // Curated Looks Worth Saving" is only 27 chars) by appending more rotating
    // suffixes — otherwise applying the fix leaves the pin still failing.
    let n = 1;
    while (title.length < PIN_TITLE_MIN && n <= TITLE_SUFFIXES.length) {
      title = `${title} · ${TITLE_SUFFIXES[(hashIdx(pin.id, TITLE_SUFFIXES.length) + n) % TITLE_SUFFIXES.length]}`;
      n++;
    }
    if (title.length > PIN_TITLE_MAX) title = title.slice(0, PIN_TITLE_MAX - 1).trimEnd() + "…";
  }
  return title;
}

/** Heuristic description rewrite: keep any real copy, pad into the 200–500
 * char band with topic + board name + a rotating call-to-action closer. */
export function suggestPinDescription(pin: HealthPin, boardName: string | null): string {
  const anchor = usableTopic(boardName, "your collection");
  const topic = usableTopic(pin.title, anchor);
  const existing = clean(pin.description ?? "");
  const base = !existing || isPlaceholderText(existing) ? "" : existing;

  if (base.length > PIN_DESC_MAX) return base.slice(0, PIN_DESC_MAX - 1).trimEnd() + "…";
  if (base.length >= PIN_DESC_MIN) return base;

  const opener = DESC_OPENERS[hashIdx(pin.id, DESC_OPENERS.length)];
  const closer = DESC_CLOSERS[hashIdx(pin.id + "c", DESC_CLOSERS.length)];
  const lead = `${opener} ${topic.toLowerCase() === anchor.toLowerCase() ? topic : `${topic} picks for ${anchor}`}.`;
  let desc = clean([base, lead, closer].filter(Boolean).join(" "));
  // Some opener/closer combinations land just under 200 chars — keep appending
  // rotating closers until we clear the floor, or the applied fix wouldn't
  // actually pass the Pin SEO check.
  let g = 1;
  while (desc.length < PIN_DESC_MIN && g <= DESC_CLOSERS.length) {
    desc = clean(
      `${desc} ${DESC_CLOSERS[(hashIdx(pin.id + "c", DESC_CLOSERS.length) + g) % DESC_CLOSERS.length]}`,
    );
    g++;
  }
  if (desc.length > PIN_DESC_MAX) desc = desc.slice(0, PIN_DESC_MAX - 1).trimEnd() + "…";
  return desc;
}

/* ---------------- Score-animation handoff + history ---------------- */

// The fix flows stash the score the user last saw here; the dashboard reads
// it and animates the big number climbing from that value to the fresh one.
// sessionStorage (not state) so it survives the route change.
const LAST_SCORE_KEY = "pinearn.health.lastScore";

export function saveLastSeenScore(score: number) {
  try {
    sessionStorage.setItem(LAST_SCORE_KEY, String(score));
  } catch {
    /* private mode — animation just starts from 0 */
  }
}

export function takeLastSeenScore(): number | null {
  try {
    const raw = sessionStorage.getItem(LAST_SCORE_KEY);
    sessionStorage.removeItem(LAST_SCORE_KEY);
    return raw == null ? null : Number(raw);
  } catch {
    return null;
  }
}

// A tiny score history (localStorage) so the dashboard can show "+N since your
// last visit" — the pull that turns a one-off audit into a weekly habit. We
// keep the last handful of {score, at} samples, recording at most one per day
// so a burst of visits doesn't wipe the meaningful delta.
const HISTORY_KEY = "pinearn.boost.history";
const MAX_HISTORY = 12;

export type ScoreSample = { score: number; at: number };

export function readScoreHistory(): ScoreSample[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScoreSample[]) : [];
  } catch {
    return [];
  }
}

/** Record today's score (coalescing same-day samples) and return the previous
 * sample from a different day, i.e. what to diff "since last visit" against. */
export function recordScore(score: number, now: number = Date.now()): ScoreSample | null {
  const history = readScoreHistory();
  const prior = [...history].reverse().find((s) => !isSameDay(s.at, now)) ?? null;
  const last = history[history.length - 1];
  let next: ScoreSample[];
  if (last && isSameDay(last.at, now)) {
    next = [...history.slice(0, -1), { score, at: now }];
  } else {
    next = [...history, { score, at: now }];
  }
  next = next.slice(-MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* private mode — the delta just won't persist */
  }
  return prior;
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}
