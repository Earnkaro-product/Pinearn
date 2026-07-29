// Turn "what this pin is about" plus "what people search" into ONE keyword plan
// the copy has to hit.
//
// Pure and deterministic: same subject + same trend rows always produce the
// same plan. That matters because the plan is also the validation contract
// (validateSuggestion checks the copy against it) and the scoring basis, so it
// cannot be something the LLM improvises.
//
// The hard problem this module exists to solve: Pinterest's related-search
// expansion is noisy. Seeding "casual outfit" genuinely returns "zoo outfit"
// and "amusement park outfit" alongside "casual chic" and "smart casual".
// Ranking purely by search volume would happily optimize a blazer pin for
// "zoo outfit". So every candidate is scored on RELEVANCE first — measured
// against the pin's own vocabulary — and volume only ranks what survived.
//
// The reference vocabulary comes from metadata (title, board, product, niche),
// not from the image, because this runs BEFORE the model call. The model sees
// the image and writes the copy; this module decides what the copy must rank
// for. A pin with no usable metadata therefore gets a thinner plan — which is
// correct, since we genuinely know less about it at this point.

import type { TrendDirection, TrendTerm } from "@/lib/pinterest-trends.server";
import type { PinSubject } from "@/lib/pin-subject";

/* ---------------- Tokenization ---------------- */

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "for",
  "with",
  "your",
  "you",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "from",
  "is",
  "are",
  "be",
  "it",
  "this",
  "that",
  "these",
  "those",
  "my",
  "our",
  "or",
  "as",
  "best",
  "top",
  "new",
  "great",
  "good",
  "nice",
  "very",
  "more",
  "most",
  "some",
  "any",
]);

// Category head-nouns that appear in nearly every candidate in a vertical.
// They still count toward a match, but at reduced weight — otherwise "zoo
// outfit" and "smart casual outfit" look equally relevant to an outfit pin
// just because they share the word "outfit".
const GENERIC_TOKENS = new Set([
  "outfit",
  "outfits",
  "look",
  "looks",
  "style",
  "styles",
  "idea",
  "ideas",
  "inspo",
  "inspiration",
  "aesthetic",
  "decor",
  "design",
  "designs",
  "fashion",
  "trend",
  "trends",
  "wear",
  "photo",
  "photos",
  "picture",
  "pictures",
  "image",
  "images",
  "wallpaper",
  "recipe",
  "recipes",
  "tip",
  "tips",
  "guide",
  "hack",
  "hacks",
]);

const GENERIC_WEIGHT = 0.35;

/** Crude but stable stemmer — enough to make "outfits"/"outfit" and
 * "dresses"/"dress" match. Deliberately not a real Porter stemmer: over-
 * stemming creates false matches, which is the expensive failure here. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && (word.endsWith("ches") || word.endsWith("shes") || word.endsWith("ses")))
    return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

function tokenWeight(token: string): number {
  return GENERIC_TOKENS.has(token) ? GENERIC_WEIGHT : 1;
}

/* ---------------- Relevance ---------------- */

/** The bag of tokens that describes THIS pin. Deliberately wide, because a term
 * is only penalized for tokens that appear nowhere in the pin's own
 * vocabulary. */
export function buildReferenceTokens(input: {
  subject: PinSubject;
  productName?: string | null;
  boardName?: string | null;
  pinTitle?: string | null;
  niche?: string | null;
}): Set<string> {
  const { subject } = input;
  const sources: string[] = [
    subject.subject,
    subject.category ?? "",
    ...subject.seedTerms,
    ...subject.descriptors,
    input.productName ?? "",
    input.boardName ?? "",
    input.pinTitle ?? "",
    input.niche ?? "",
  ];
  const bag = new Set<string>();
  for (const s of sources) for (const t of tokenize(s)) bag.add(t);
  return bag;
}

// A phrase with this many words is a claim about a specific thing, and its
// head noun has to be that thing. Below it, compound searches like "meal prep"
// legitimately pair two words neither of which is a head noun on its own.
const HEAD_NOUN_CHECK_MIN_WORDS = 3;
// Applied when a long phrase's head noun is absent from the pin. Sized to drop
// a term from "borderline" to "below the floor" rather than to zero, so it's a
// strong signal and not a second, hidden filter.
const HEAD_NOUN_MISS_FACTOR = 0.6;

/** The noun a phrase is actually about: drop any trailing prepositional
 * phrase, then take the last token that isn't a category filler word.
 * "loft bed ideas for small rooms" → "bed"; "reading room ideas" → "room". */
function headNoun(tokens: string[], rawTerm: string): string | null {
  const beforePreposition = rawTerm.split(/\b(?:for|with|in|on|of|to)\b/)[0];
  const scope = tokenize(beforePreposition);
  const candidates = (scope.length > 0 ? scope : tokens).filter((t) => !GENERIC_TOKENS.has(t));
  return candidates[candidates.length - 1] ?? null;
}

/** 0–1: how much of a candidate's meaning is actually present in the pin.
 * Weighted so an unmatched SPECIFIC token ("zoo") costs far more than an
 * unmatched generic one ("ideas").
 *
 * The weighted average alone isn't enough for longer phrases: "small bedroom
 * ideas" scores 0.57 against a living-room pin purely on "small" and "ideas",
 * even though "bedroom" makes it about a different room entirely. So a long
 * phrase whose head noun is missing from the pin gets knocked below the floor. */
export function relevanceOf(term: string, reference: Set<string>): number {
  const tokens = tokenize(term);
  if (tokens.length === 0) return 0;
  let matched = 0;
  let total = 0;
  for (const t of tokens) {
    const w = tokenWeight(t);
    total += w;
    if (reference.has(t)) matched += w;
  }
  if (total === 0) return 0;
  const score = matched / total;

  if (term.trim().split(/\s+/).length < HEAD_NOUN_CHECK_MIN_WORDS) return score;
  const head = headNoun(tokens, term);
  return head && !reference.has(head) ? score * HEAD_NOUN_MISS_FACTOR : score;
}

/* ---------------- Scoring ---------------- */

export type KeywordSource = "trend" | "subject" | "product" | "board";

export type ScoredKeyword = {
  term: string;
  /** 0–100 composite used for ranking. */
  score: number;
  /** 0–1 semantic fit with the image. */
  relevance: number;
  /** 0–100 Pinterest search interest; null when we have no trend row. */
  volume: number | null;
  trend: TrendDirection | null;
  /** Last-4-weeks vs prior-8-weeks demand ratio; 1 when unknown. */
  momentum: number;
  rising: boolean;
  source: KeywordSource;
  wordCount: number;
};

// A keyword with no trend row isn't worthless — it just has unknown demand.
// Scoring it as slightly-below-median keeps vision keywords usable when the
// Trends call fails, without letting them outrank a proven high-volume term.
const UNKNOWN_VOLUME_PROXY = 0.35;

// Relevance dominates on purpose: a high-volume keyword the image doesn't
// support is worse than useless, because Pinterest will surface the pin to
// people who immediately bounce, and bounce is a ranking signal.
const W_RELEVANCE = 0.45;
const W_VOLUME = 0.3;
const W_MOMENTUM = 0.15;
const W_RISING = 0.1;

function momentumScore(k: {
  momentum: number;
  trend: TrendDirection | null;
  weekChange?: number;
}): number {
  // recentMomentum sits around 1.0 for a flat term; map 0.8→0 and 1.4→1.
  const fromSeries = Math.min(1, Math.max(0, (k.momentum - 0.8) / 0.6));
  const fromLabel = k.trend === "rising" ? 0.75 : k.trend === "falling" ? 0.15 : 0.4;
  return k.trend == null ? fromSeries : (fromSeries + fromLabel) / 2;
}

function scoreKeyword(k: Omit<ScoredKeyword, "score">): number {
  const volume = (k.volume ?? UNKNOWN_VOLUME_PROXY * 100) / 100;
  const raw =
    W_RELEVANCE * k.relevance +
    W_VOLUME * Math.min(1, volume) +
    W_MOMENTUM * momentumScore(k) +
    W_RISING * (k.rising ? 1 : 0);
  return Math.round(raw * 100);
}

/* ---------------- Plan ---------------- */

export type KeywordPlan = {
  /** Must appear verbatim, early, in the title AND in the description. */
  primary: string;
  /** 2–3 supporting head terms to weave into the description. */
  secondary: string[];
  /** 2–3 three-word-plus phrases that capture low-competition searches. */
  longTail: string[];
  /** Everything considered, best first — powers the "why this keyword" UI. */
  ranked: ScoredKeyword[];
  /** Trend terms dropped for failing the relevance floor, with their scores. */
  discarded: Array<{ term: string; relevance: number; volume: number | null }>;
  country: string;
  hasTrendData: boolean;
  /** Pinterest's data snapshot the volumes came from. */
  asOf: string | null;
};

// A trend term must clear this to be usable at all. Tuned against real actor
// output: "smart casual" / "business casual outfits" on a blazer pin land
// ~0.5–0.8, while "zoo outfit" and "amusement park outfit" land ~0.25.
const RELEVANCE_FLOOR = 0.5;
// The primary keyword is the one the whole pin is optimized around, so it has
// to be more than plausibly related.
const PRIMARY_RELEVANCE_FLOOR = 0.6;

// A one-word primary is too broad to rank for and reads like a tag; five-plus
// words can't be front-loaded inside a 100-char title. Two to four is the band
// where exact-match actually wins on Pinterest.
const PRIMARY_MIN_WORDS = 2;
const PRIMARY_MAX_WORDS = 4;
const PRIMARY_MAX_CHARS = 40;

// Search-box shorthand: real, high-volume Pinterest queries that read as
// inverted grammar in a sentence ("Outfit Men", "Dress Women"). Because the
// primary keyword has to appear VERBATIM in the title, picking one of these
// forces clumsy copy — so they're heavily discouraged from becoming the
// primary, while staying perfectly usable inside a description.
const TRAILING_DEMOGRAPHIC = /\b(women|womens|men|mens|girls|boys|kids|ladies)$/;
// …unless a preposition makes it grammatical: "outfits for men" is fine.
const PREPOSITIONAL_TAIL = /\b(for|of|with|in|on)\s+\w+$/;
const AWKWARD_PRIMARY_PENALTY = 22;
// A trend-verified keyword beats an equally-scored one we only inferred.
const TREND_VERIFIED_BONUS = 8;
// Supporting keywords should be about the PRODUCT, not the scene around it —
// on a t-shirt pin, "cute shirts" earns its slot and "mens haircuts" doesn't.
const PRODUCT_TOKEN_BONUS = 10;
// The same preference, weighted harder for the primary: it has to beat both
// the trend-verified bonus and a moderate volume gap for a broad category term
// ("furniture design") to displace the specific one ("accent chairs").
const ON_PRODUCT_PRIMARY_BONUS = 14;

function isAwkwardAsPrimary(term: string): boolean {
  return TRAILING_DEMOGRAPHIC.test(term) && !PREPOSITIONAL_TAIL.test(term);
}

// Raw detector labels for a human. They're accurate but useless as the head of
// a search phrase — nobody types "person for workday" — so a synthesized
// keyword is never allowed to start with one.
const PERSON_LABELS = new Set(["person", "people", "human", "man", "woman", "boy", "girl"]);

function titleCaseSafe(term: string): string {
  // Curly apostrophes come straight through from Pinterest ("men’s"), and a
  // verbatim-match contract can't survive two spellings of the same word.
  return term.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

/** True when two terms are effectively the same keyword — one's token set
 * contains the other's. Prevents "blazer" + "blazer outfits" both being
 * spent as if they were distinct targets. */
function overlaps(a: string, b: string): boolean {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return true;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return shared / small.size >= 0.8;
}

function pushDistinct(target: string[], candidates: ScoredKeyword[], taken: string[], max: number) {
  for (const c of candidates) {
    if (target.length >= max) break;
    if ([...taken, ...target].some((t) => overlaps(t, c.term))) continue;
    target.push(c.term);
  }
}

export type BuildPlanInput = {
  subject: PinSubject;
  trends: TrendTerm[];
  /** Country-wide trending terms — a tie-break nudge, never a source of truth. */
  trendingNow?: TrendTerm[];
  productName?: string | null;
  boardName?: string | null;
  pinTitle?: string | null;
  niche?: string | null;
  country: string;
};

export function buildKeywordPlan(input: BuildPlanInput): KeywordPlan {
  const reference = buildReferenceTokens(input);

  // Country-wide trending terms that happen to be relevant to THIS pin get a
  // small momentum nudge — a keyword that's both on-topic and hot right now is
  // worth more than the same keyword in a quiet week.
  const hotNow = new Set(
    (input.trendingNow ?? [])
      .filter((t) => relevanceOf(t.term, reference) >= RELEVANCE_FLOOR)
      .map((t) => t.term),
  );

  const discarded: KeywordPlan["discarded"] = [];
  const scored: ScoredKeyword[] = [];
  const seen = new Set<string>();

  for (const t of input.trends) {
    if (seen.has(t.term)) continue;
    const relevance = relevanceOf(t.term, reference);
    if (relevance < RELEVANCE_FLOOR) {
      discarded.push({
        term: t.term,
        relevance: Number(relevance.toFixed(2)),
        volume: t.searchVolume,
      });
      continue;
    }
    seen.add(t.term);
    const base: Omit<ScoredKeyword, "score"> = {
      term: titleCaseSafe(t.term),
      relevance,
      volume: t.searchVolume,
      trend: t.trend,
      momentum: hotNow.has(t.term) ? Math.min(3, t.recentMomentum * 1.15) : t.recentMomentum,
      rising: t.predictedRising || t.trend === "rising" || hotNow.has(t.term),
      source: "trend",
      wordCount: t.term.split(/\s+/).length,
    };
    scored.push({ ...base, score: scoreKeyword(base) });
  }

  // The pin's own vocabulary fills the gaps. On-topic by construction, but no
  // demand data — so it's usable when the Trends call returns nothing, without
  // ever outranking a proven high-volume term.
  const subjectCandidates = [input.subject.subject, ...input.subject.seedTerms];
  for (const raw of subjectCandidates) {
    const term = titleCaseSafe(raw).toLowerCase();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    const base: Omit<ScoredKeyword, "score"> = {
      term,
      // Self-referential by construction, so cap it below a genuine
      // trend-verified match rather than letting it score a perfect 1.0.
      relevance: Math.min(0.9, relevanceOf(term, reference)),
      volume: null,
      trend: null,
      momentum: hotNow.has(term) ? 1.2 : 1,
      rising: hotNow.has(term),
      source: "subject",
      wordCount: term.split(/\s+/).length,
    };
    scored.push({ ...base, score: scoreKeyword(base) });
  }

  scored.sort((a, b) => b.score - a.score || (b.volume ?? -1) - (a.volume ?? -1));

  /* ----- primary ----- */

  // Tokens naming the thing being sold. A keyword that shares one is about the
  // PRODUCT; one that doesn't is about the scene around it. On a yellow accent
  // chair pin, "furniture design" and "accent chairs" can score within a point
  // of each other on volume alone — but only one of them brings in someone who
  // wants to buy a chair.
  const productTokens = new Set([
    ...tokenize(input.subject.subject),
    ...tokenize(input.subject.category ?? ""),
    ...tokenize(input.productName ?? ""),
  ]);
  const aboutTheProduct = (term: string) => tokenize(term).some((t) => productTokens.has(t));

  const primaryPool = scored
    .filter(
      (k) =>
        k.wordCount >= PRIMARY_MIN_WORDS &&
        k.wordCount <= PRIMARY_MAX_WORDS &&
        k.term.length <= PRIMARY_MAX_CHARS &&
        k.relevance >= PRIMARY_RELEVANCE_FLOOR,
    )
    // Prefer keywords about the product itself, then trend-verified demand,
    // then penalize search-box shorthand that can't be written into a sentence.
    .map((k) => ({
      k,
      rank:
        k.score +
        (aboutTheProduct(k.term) ? ON_PRODUCT_PRIMARY_BONUS : 0) +
        (k.source === "trend" ? TREND_VERIFIED_BONUS : 0) -
        (isAwkwardAsPrimary(k.term) ? AWKWARD_PRIMARY_PENALTY : 0),
    }))
    .sort((a, b) => b.rank - a.rank);

  const primary =
    primaryPool[0]?.k.term ??
    // Progressive relaxation, then the pin's own vocabulary. Something always
    // wins, so the caller never has to handle a missing primary keyword.
    scored.find((k) => k.wordCount <= PRIMARY_MAX_WORDS && k.term.length <= PRIMARY_MAX_CHARS)
      ?.term ??
    firstUsable([
      input.subject.subject,
      input.subject.category,
      input.productName,
      input.pinTitle,
      input.boardName,
    ]) ??
    "trending finds";

  /* ----- secondary + long tail ----- */

  const rest = scored
    .filter((k) => !overlaps(k.term, primary))
    .map((k) => ({ k, rank: k.score + (aboutTheProduct(k.term) ? PRODUCT_TOKEN_BONUS : 0) }))
    .sort((a, b) => b.rank - a.rank)
    .map((r) => r.k);

  const secondary: string[] = [];
  pushDistinct(
    secondary,
    rest.filter((k) => k.wordCount <= 3),
    [primary],
    3,
  );
  // Backfill from anything left if the short-term pool was thin.
  pushDistinct(secondary, rest, [primary], 3);

  const longTail: string[] = [];
  pushDistinct(
    longTail,
    rest.filter((k) => k.wordCount >= 3),
    [primary, ...secondary],
    3,
  );
  // Last resort: synthesize from the pin's own words so the copy always has at
  // least one specific, low-competition phrase to hit.
  if (longTail.length === 0) {
    const subject = input.subject.subject;
    const synth = [
      [subject, input.subject.category].filter(Boolean).join(" "),
      [input.boardName, subject].filter(Boolean).join(" "),
      [subject, input.niche].filter(Boolean).join(" "),
    ]
      .map((s) => titleCaseSafe(s).toLowerCase())
      .filter((s) => s.split(" ").length >= 2)
      // Only worth forcing into the copy if it reads like something a person
      // would actually type — a phrase headed by a bare person noun doesn't.
      .filter((s) => !PERSON_LABELS.has(tokenize(s)[0] ?? ""));
    pushDistinct(
      longTail,
      synth.map((term) => ({
        term,
        score: 0,
        relevance: 1,
        volume: null,
        trend: null,
        momentum: 1,
        rising: false,
        source: "subject" as const,
        wordCount: term.split(" ").length,
      })),
      [primary, ...secondary],
      2,
    );
  }

  return {
    primary: titleCaseSafe(primary),
    secondary,
    longTail,
    ranked: scored.slice(0, 25),
    discarded: discarded.slice(0, 15),
    country: input.country,
    hasTrendData: input.trends.length > 0,
    asOf: input.trends[0]?.asOf ?? null,
  };
}

function firstUsable(values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const t = (v ?? "").replace(/\s+/g, " ").trim();
    if (t.length >= 3) return t.split(" ").slice(0, PRIMARY_MAX_WORDS).join(" ");
  }
  return null;
}

/** Every keyword the copy is allowed to claim credit for hitting. */
export function planTargets(plan: KeywordPlan): string[] {
  return [plan.primary, ...plan.secondary, ...plan.longTail];
}

/** Rendered into the copy prompt so the model sees the actual demand numbers
 * behind each target, not just a word list.
 *
 * Kept terse on purpose — this goes into every single request, so each word
 * here is a word we pay for on every pin. Demand is only annotated where we
 * actually have it; a term with no trend row is just listed. */
export function describePlan(plan: KeywordPlan): string[] {
  const byTerm = new Map(plan.ranked.map((k) => [k.term.toLowerCase(), k]));
  const annotate = (term: string) => {
    const k = byTerm.get(term.toLowerCase());
    if (!k || k.volume == null) return `"${term}"`;
    const rising = k.rising || k.trend === "rising" ? ", rising" : "";
    return `"${term}" (${k.volume}/100${rising})`;
  };

  const lines = [`- PRIMARY (must appear verbatim): ${annotate(plan.primary)}`];
  const supporting = [...plan.secondary, ...plan.longTail];
  if (supporting.length > 0) {
    lines.push(`- Supporting: ${supporting.map(annotate).join(", ")}`);
  }
  lines.push(
    plan.hasTrendData
      ? `- Numbers are live Pinterest Trends search interest for ${plan.country}${plan.asOf ? ` (week of ${plan.asOf})` : ""}.`
      : "- No live trend data for this pin; these targets come from its own metadata.",
  );
  return lines;
}
