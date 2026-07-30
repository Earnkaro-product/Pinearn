// The pin copy contract.
//
// Pure module (no network, no Supabase), holding four things that must stay in
// lockstep and are therefore deliberately in one file:
//   1. buildCopyPrompt    — what we ask the model for
//   2. validateSuggestion — what we accept back
//   3. repairSuggestion   — deterministic fixes for the mechanical failures,
//                           so a paid retry is only ever spent on failures
//                           that need judgement
//   4. composeFallback    — copy written without any model call at all, so the
//                           pipeline still returns something usable when the
//                           proxy is down
//
// Keeping all four here is what lets the prompt stay short: every rule dropped
// from the prompt to save tokens must still be enforced below, and a rule that
// exists in only one of the two places is a bug waiting to happen.
//
// The validation bands mirror health-score.ts exactly, so an approved
// suggestion is guaranteed to raise the pin's Boost score rather than land it
// in a different flavour of failing.

import {
  PIN_TITLE_MIN,
  PIN_TITLE_MAX,
  PIN_DESC_MIN,
  PIN_DESC_MAX,
  isPlaceholderText,
} from "@/lib/health-score";
import { describePlan, planTargets, tokenize, type KeywordPlan } from "@/lib/pin-keywords";
import type { PinSubject } from "@/lib/pin-subject";

/* ---------------- Pinterest pin-level SEO rules ---------------- */

// These are the mechanics the whole module enforces. They're stated once here
// and reused verbatim in the prompt so the instructions the model gets and the
// checks it's graded against can never drift apart.
//
// Why each one:
//   Front-loaded title  — the pin grid truncates titles around 30–40 chars on
//                         mobile, so anything after that is invisible to a
//                         scroller even though it's still indexed.
//   Keyword early in
//   the description     — only VISIBLE_SPAN chars show before "more", and that
//                         span is what earns the save.
//   Natural sentences   — Pinterest's ranking reads the description as
//                         language; a comma-separated keyword list reads as
//                         spam and suppresses distribution.
//   No hashtags         — Pinterest retired hashtag search; they now only
//                         consume characters that could hold real keywords.
//   Save-oriented CTA   — saves are a first-order ranking signal, so the copy
//                         should ask for the save, not for the click.

/** How far into the title the primary keyword may start. */
export const TITLE_KEYWORD_HEAD = 40;
/** How far into the description the primary keyword may start. */
export const DESC_KEYWORD_HEAD = 120;
/** Supporting keywords the description must land, out of the plan's 4–6. */
export const MIN_SUPPORTING_HITS = 2;
/** More than this many mentions of the primary keyword reads as stuffing. */
export const MAX_PRIMARY_MENTIONS = 3;

/** Characters of the description visible before Pinterest's "more" cut.
 * Everything that has to earn the save must fit inside this. */
export const VISIBLE_SPAN = 100;

// Titles are legal from PIN_TITLE_MIN to PIN_TITLE_MAX, but the band that
// actually reads as a search result rather than a truncated sentence is
// narrower. Scored as a bonus, never a hard failure, so a good 95-char title
// isn't rejected for being long.
export const TITLE_SWEET_MIN = 45;
export const TITLE_SWEET_MAX = 70;

// Descriptions are legal from PIN_DESC_MIN, but the whole field is indexed and
// the supporting keywords need somewhere to live. Asking only for the minimum
// got 240-char descriptions that front-loaded the hook and then stopped, which
// cost coverage — the band below is where there's room for the supporting
// phrases without padding.
export const DESC_SWEET_MIN = 280;
export const DESC_SWEET_MAX = 450;

// Pinterest queries carry intent, not just nouns: people search "small bedroom
// IDEAS", "banana bread RECIPE", "capsule wardrobe CHECKLIST". A title holding
// one of these matches a whole family of long-tail queries the bare noun
// misses, so its presence is rewarded.
const INTENT_MODIFIERS = [
  "ideas",
  "idea",
  "inspiration",
  "inspo",
  "aesthetic",
  "recipe",
  "recipes",
  "guide",
  "tips",
  "tutorial",
  "how to",
  "checklist",
  "diy",
  "outfit",
  "outfits",
  "decor",
  "design",
  "styling",
  "on a budget",
  "for beginners",
  "for small",
  "step by step",
];

// Save-oriented closings. Pinterest ranks on saves, so copy that never asks for
// one is leaving the strongest engagement signal on the table.
const SAVE_CTA =
  /\b(save|pin|bookmark|keep)\b[^.!?]{0,60}(later|reference|inspiration|board|list|planning|revisit|hand|ready)?/i;

/* ---------------- Framing angles ---------------- */

// Rotated across a batch, and across regenerations of the same pin, so a board
// of suggestions doesn't read like one template with the nouns swapped.
export const SEO_ANGLES = [
  "use-case-led",
  "aesthetic-led",
  "question-led",
  "detail-led",
  "occasion-led",
] as const;

export type SeoAngle = (typeof SEO_ANGLES)[number];

// One clause each. These ship on every request, so a paragraph of craft advice
// per angle is 150 tokens per pin buying what a sharp phrase buys.
const ANGLE_INSTRUCTIONS: Record<SeoAngle, string> = {
  "use-case-led":
    "Name the concrete situation this belongs in (the commute, the small flat, the Monday meeting); the description puts the reader inside it.",
  "aesthetic-led":
    "Lead with the visual mood actually visible — colours, textures, styling — and name an aesthetic people search by, but only one the image supports.",
  "question-led":
    "Open the description with the question the viewer is already asking, then answer it. The title stays declarative.",
  "detail-led":
    "Lead with the single most distinctive thing you can see — material, cut, finish, proportion. Sensory and specific.",
  "occasion-led":
    "Frame it around when to reach for this — the season or event people plan ahead for. Use the seasonality in the keyword data if it points somewhere.",
};

/** Deterministic angle for a pin: cycles through all five as `salt` grows
 * (batch index, or the pin's prior-suggestion count, so regenerating after a
 * rejection naturally tries the next framing rather than the same one). */
export function pickAngle(pinId: string, salt: number): SeoAngle {
  let h = 0;
  for (let i = 0; i < pinId.length; i++) h = (h * 31 + pinId.charCodeAt(i)) >>> 0;
  return SEO_ANGLES[(h + salt) % SEO_ANGLES.length];
}

/* ---------------- Context ---------------- */

export type SuggestionProduct = {
  name: string;
  category: string | null;
  /** Pre-formatted for the prompt, e.g. "₹1,299" / "$24.99". */
  priceLabel: string | null;
};

export type PinSuggestionContext = {
  pin: { id: string; title: string; description: string; imageUrl: string | null };
  board: { id: string; name: string } | null;
  siblingPinTitles: string[];
  /** Creator's niche, from their storefront name + description. */
  niche: string | null;
  product: SuggestionProduct | null;
  /** Previously rejected suggestions for this pin — phrasings to avoid. */
  rejectedSuggestions: Array<{ title: string; description: string }>;
  angle: SeoAngle;
  /** Metadata-derived subject — seeds the keyword plan and backs the LLM-free
   * fallback. NOT a description of the image: the model sees the image itself. */
  subject: PinSubject;
  /** What the copy has to rank for. */
  plan: KeywordPlan;
};

export type SuggestionCandidate = {
  title: string;
  description: string;
  /**
   * 3–6 words for what the image LITERALLY shows, as reported by the model.
   *
   * Costs a handful of output tokens and buys two things nothing else can: a
   * real (not metadata-guessed) subject to seed the next generation's trend
   * lookup, and the raw material for the coherence check below.
   */
  imageSubject?: string;
  /**
   * The model's own judgement that the target keywords actually describe this
   * image.
   *
   * The keyword plan is built from metadata — board name, pin title, niche —
   * before anything sees the picture. When those disagree with the image, the
   * mechanical checks all still pass while the copy is nonsense: a spa photo on
   * a board called "Easy Weeknight Dinners" scored 99/100 for the title "Easy
   * Weeknight Dinners After a Steamy Blue Lagoon Soak". The model is the only
   * component that sees both sides, so it's the only one that can catch this.
   */
  fitsKeywords?: boolean;
};

/* ---------------- Banned language ---------------- */

// The padding phrases health-score.ts's heuristic fixer leans on, plus the
// classic AI-listing tells. Banned in the prompt AND checked post-hoc, because
// models reliably reach for them under a character-count floor.
export const GENERIC_PHRASES = [
  "must-have",
  "must have",
  "perfect for any occasion",
  "look no further",
  "elevate your",
  "game-changer",
  "game changer",
  "you'll love",
  "shop now",
  "limited time",
  "best ever",
  "take your",
  "whether you're",
  "in today's world",
  "the perfect blend",
  "unleash",
  "dive into",
];

/* ---------------- Prompt ---------------- */

/**
 * The single prompt sent per pin, alongside the image itself.
 *
 * Written tight on purpose. This text ships on every request, so its length is
 * a recurring cost, not a one-off — every rule here had to earn its tokens by
 * being one the validator actually enforces. Anything the validator can fix
 * mechanically (trimming, front-loading) is left out of the prompt entirely and
 * handled in repairSuggestion() for free.
 *
 * The model sees the pin image directly, so there is no textual description of
 * it here — describing an image to a model that can see it is pure waste, and
 * describing one to a model that can't is how you get invented detail.
 */
export function buildCopyPrompt(
  context: PinSuggestionContext,
  /** Whether an image is genuinely being sent with THIS request.
   *
   * Defaults to "the pin has an image URL", but the caller must override it to
   * false when the image turned out to be unfetchable. Getting this wrong is
   * the exact bug that produces invented visual detail: a prompt that says
   * "ground the copy in what you can see" with no image attached is an
   * instruction to make something up. */
  opts?: { hasImage?: boolean },
): string {
  const hasImage = opts?.hasImage ?? Boolean(context.pin.imageUrl);

  const lines: string[] = [
    hasImage
      ? "You are a Pinterest SEO copywriter. Look at the image and write ONE pin title and description for it."
      : "You are a Pinterest SEO copywriter. Write ONE pin title and description from the details below.",
    "",
    "TARGET KEYWORDS:",
    ...describePlan(context.plan),
    "",
    // Ordered by ranking weight, strongest first, because the model front-loads
    // its own attention the same way a reader does.
    "HOW PINTEREST RANKS THIS PIN:",
    `- TITLE is the strongest signal, and it is a SEARCH QUERY not a caption. Primary keyword verbatim inside the first ${TITLE_KEYWORD_HEAD} chars — the mobile grid truncates there. Lead with the noun people type, flourish after. ${PIN_TITLE_MIN}-${PIN_TITLE_MAX} chars, aim ${TITLE_SWEET_MIN}-${TITLE_SWEET_MAX}, no trailing punctuation.`,
    // Two separate jobs, previously conflated into one instruction: the visible
    // span carries the HOOK, and the save ask closes. Saying "put the reason to
    // save in the first 100 chars" produced descriptions that opened with the
    // CTA and then stopped early, costing the supporting-keyword coverage that
    // the rest of the budget exists to buy.
    `- DESCRIPTION ${PIN_DESC_MIN}-${PIN_DESC_MAX} chars — aim ${DESC_SWEET_MIN}-${DESC_SWEET_MAX}, because all of it is indexed and the extra room is where the supporting phrases fit.`,
    `- FIRST SENTENCE: a complete thought, under ${VISIBLE_SPAN} characters, containing the primary keyword. That is the only part shown before "more", so it has to stand alone as the reason to save. Ask for the save in the LAST sentence, never the first.`,
    `- Be SPECIFIC: name colour, material, cut, setting, style. Specific pins get saved; generic ones get scrolled past, and saves are what rank a pin.`,
    `- Work in ${MIN_SUPPORTING_HITS}+ supporting phrases — all the words of a phrase spread across a sentence counts, so write the sentence first and fit the words in.`,
    `- Primary keyword at most ${MAX_PRIMARY_MENTIONS} times total; more reads as stuffing.`,
    "- Capitalise normally; matching ignores case, so never lowercase a first word to reproduce a keyword.",
    "- Prose, 2+ sentences, not a keyword list. No hashtags (Pinterest dropped hashtag search), emoji, ALL-CAPS or wrapping quotes.",
    // Split by whether an image is actually attached. Telling a model with no
    // image to "describe what the image shows" is how it starts inventing one;
    // telling a model that HAS one to name concrete visible detail is the whole
    // reason the copy beats a template.
    hasImage
      ? "- Describe only what is genuinely visible. Never invent a brand, measurement, price, discount, or who it's for."
      : "- You have NO image. Write only from the keywords and context below; never describe visual detail you weren't given, and never invent a brand, measurement, price or discount.",
    `- Banned filler: ${GENERIC_PHRASES.join(", ")}.`,
    "",
    `ANGLE — ${context.angle}: ${ANGLE_INSTRUCTIONS[context.angle]}`,
  ];

  // Context is appended only when it exists and is real — a placeholder title
  // is worse than no title, since it invites the model to preserve it.
  const ctx: string[] = [];
  if (context.pin.title && !isPlaceholderText(context.pin.title)) {
    ctx.push(`Current title (being replaced): "${context.pin.title}"`);
  }
  if (context.product) {
    ctx.push(
      [`Product: "${context.product.name}"`, context.product.category, context.product.priceLabel]
        .filter(Boolean)
        .join(", "),
    );
  }
  if (context.board) ctx.push(`Board: "${context.board.name}" — fit its theme.`);
  if (context.niche) ctx.push(`Creator niche: ${context.niche}.`);
  if (context.siblingPinTitles.length > 0) {
    ctx.push(
      `Nearby pins (match register, don't copy): ${context.siblingPinTitles.map((t) => `"${t}"`).join("; ")}`,
    );
  }
  if (ctx.length > 0) lines.push("", "CONTEXT:", ...ctx.map((c) => `- ${c}`));

  if (context.rejectedSuggestions.length > 0) {
    lines.push(
      "",
      "The creator rejected these — take a genuinely different angle, not a rephrase:",
      ...context.rejectedSuggestions.map((r) => `- "${r.title}"`),
    );
  }

  // The output contract goes LAST and nothing follows it. There's no structured
  // output mode on the proxy, so this instruction is the only thing standing
  // between us and a parse failure — it has to be the freshest thing in context.
  lines.push("", "Reply with raw JSON only, no fences, no preamble:");
  if (hasImage) {
    lines.push(
      '{"title":"...","description":"...","image_subject":"3-6 words for what the image literally shows","fits_keywords":true}',
      "- Set fits_keywords to false if the target keywords above do not actually describe this image. Do NOT bend the copy to fit keywords that belong to a different subject; say they do not fit and write the best honest copy for what you can see.",
    );
  } else {
    lines.push('{"title":"...","description":"..."}');
  }
  return lines.join("\n");
}

/** Appended to the prompt on a validation-failure retry. The issue strings are
 * already written as instructions by validateSuggestion(), so this only has to
 * frame them. */
export function retryFeedback(issues: string[], attempt: number): string {
  return [
    "",
    `ATTEMPT ${attempt} WAS REJECTED:`,
    ...issues.map((i) => `- ${i}`),
    "Fix every one. Count characters literally. Add real detail from the image rather than padding with filler.",
  ].join("\n");
}

/* ---------------- Text helpers ---------------- */

const EMOJI = /\p{Extended_Pictographic}/u;
const ALL_CAPS_WORD = /\b[A-Z]{4,}\b/;

function clean(text: string): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();
}

/** Fold the differences that shouldn't decide a keyword match: case, curly vs
 * straight apostrophes, and repeated whitespace. Without this, a plan built
 * from Pinterest's "men’s hairstyles" could never be satisfied by copy a
 * model writes with a straight apostrophe. */
function matchNormalize(text: string): string {
  return (text ?? "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function indexOfPhrase(haystack: string, needle: string): number {
  return matchNormalize(haystack).indexOf(matchNormalize(needle));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = matchNormalize(haystack);
  const n = matchNormalize(needle);
  let count = 0;
  let i = h.indexOf(n);
  while (i !== -1) {
    count++;
    i = h.indexOf(n, i + n.length);
  }
  return count;
}

/** Whether the copy actually targets a supporting keyword. Looser than the
 * verbatim rule the PRIMARY keyword gets: an exact phrase match counts, and so
 * does having every content word present, because Pinterest matches on tokens
 * too and forcing exact phrasing on four separate keywords produces copy that
 * reads like it was assembled from a checklist. */
function coversPhrase(text: string, phrase: string): boolean {
  if (indexOfPhrase(text, phrase) !== -1) return true;
  const needed = tokenize(phrase);
  if (needed.length === 0) return false;
  const present = new Set(tokenize(text));
  return needed.every((t) => present.has(t));
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Comma-separated keyword dumps disguised as prose — the single most common
 * way an LLM "hits the length" without writing anything. */
function readsAsKeywordList(desc: string): boolean {
  const fragments = desc
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (fragments.length < 4) return false;
  const shortFragments = fragments.filter((f) => f.split(/\s+/).length <= 3).length;
  return shortFragments >= 4 && shortFragments / fragments.length >= 0.6;
}

function jaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/* ---------------- Validation ---------------- */

export type ValidationInput = {
  plan: KeywordPlan;
  rejectedSuggestions?: Array<{ title: string; description: string }>;
  /** Other pins on the same board, to catch a rewrite that would compete with
   * the creator's own existing pin for one query. */
  siblingPinTitles?: string[];
};

/** Empty array = the suggestion is publishable. Each message is written to be
 * fed straight back to the model as retry feedback, so they state the fix, not
 * just the fault. */
export function validateSuggestion(
  candidate: SuggestionCandidate,
  input: ValidationInput,
): string[] {
  const issues: string[] = [];
  const title = clean(candidate.title ?? "");
  const desc = clean(candidate.description ?? "");
  const { primary } = input.plan;
  const supporting = [...input.plan.secondary, ...input.plan.longTail];

  /* length */
  if (title.length < PIN_TITLE_MIN)
    issues.push(`Title is ${title.length} chars — needs at least ${PIN_TITLE_MIN}.`);
  if (title.length > PIN_TITLE_MAX)
    issues.push(`Title is ${title.length} chars — the hard maximum is ${PIN_TITLE_MAX}.`);
  if (desc.length < PIN_DESC_MIN)
    issues.push(`Description is ${desc.length} chars — needs at least ${PIN_DESC_MIN}.`);
  if (desc.length > PIN_DESC_MAX)
    issues.push(`Description is ${desc.length} chars — the hard maximum is ${PIN_DESC_MAX}.`);

  /* placeholder */
  if (isPlaceholderText(title)) issues.push("Title is placeholder text.");

  /* primary keyword placement */
  const titleIdx = indexOfPhrase(title, primary);
  if (titleIdx === -1) {
    issues.push(`Title is missing the primary keyword "${primary}" — it must appear verbatim.`);
  } else if (titleIdx > TITLE_KEYWORD_HEAD) {
    issues.push(
      `The primary keyword "${primary}" starts at character ${titleIdx} of the title — move it into the first ${TITLE_KEYWORD_HEAD}.`,
    );
  }

  const descIdx = indexOfPhrase(desc, primary);
  if (descIdx === -1) {
    issues.push(
      `Description is missing the primary keyword "${primary}" — it must appear verbatim.`,
    );
  } else if (descIdx > DESC_KEYWORD_HEAD) {
    issues.push(
      `The primary keyword "${primary}" starts at character ${descIdx} of the description — move it into the first ${DESC_KEYWORD_HEAD}.`,
    );
  }

  /* supporting coverage */
  const hits = supporting.filter((s) => coversPhrase(desc, s));
  if (supporting.length > 0 && hits.length < Math.min(MIN_SUPPORTING_HITS, supporting.length)) {
    issues.push(
      `Description uses ${hits.length} supporting phrase(s) — weave in at least ${Math.min(
        MIN_SUPPORTING_HITS,
        supporting.length,
      )} of: ${supporting.map((s) => `"${s}"`).join(", ")}.`,
    );
  }

  /* stuffing */
  const mentions = countOccurrences(title, primary) + countOccurrences(desc, primary);
  if (mentions > MAX_PRIMARY_MENTIONS) {
    issues.push(
      `"${primary}" appears ${mentions} times — keep it to ${MAX_PRIMARY_MENTIONS} or fewer across title and description.`,
    );
  }

  /* language quality */
  const combined = `${title} ${desc}`;
  const lower = combined.toLowerCase();
  for (const phrase of GENERIC_PHRASES) {
    if (lower.includes(phrase)) issues.push(`Remove the filler phrase "${phrase}".`);
  }
  if (combined.includes("#")) issues.push("Remove hashtags — Pinterest no longer indexes them.");
  if (EMOJI.test(combined)) issues.push("Remove emoji.");
  if (ALL_CAPS_WORD.test(combined)) issues.push("Remove ALL-CAPS words.");
  if (readsAsKeywordList(desc))
    issues.push(
      "The description reads as a comma-separated keyword list — rewrite it as sentences.",
    );
  if (sentences(desc).length < 2)
    issues.push("The description needs at least two complete sentences.");

  /* repetition of a rejected suggestion */
  for (const r of input.rejectedSuggestions ?? []) {
    if (jaccard(title, r.title) > 0.7 || jaccard(desc, r.description) > 0.7) {
      issues.push(
        `This is too close to a suggestion the creator already rejected ("${r.title}") — change the angle, not just the wording.`,
      );
      break;
    }
  }

  /* cannibalizing the creator's own pins.
   * Two near-identical titles on one board compete with each other for the same
   * query instead of covering two, and Pinterest surfaces only one of them. */
  for (const sibling of input.siblingPinTitles ?? []) {
    if (sibling.trim() && jaccard(title, sibling) > 0.75) {
      issues.push(
        `The title is nearly identical to another pin on this board ("${sibling}") — they would compete for the same search. Target a different angle or long-tail phrase.`,
      );
      break;
    }
  }

  /* the model told us the keyword plan doesn't match the image.
   * Reported as an issue so the suggestion lands in 'needs_review' rather than
   * being applied silently: the mechanics can all be perfect while the copy is
   * about a different subject entirely. */
  if (candidate.fitsKeywords === false) {
    issues.push(
      `The target keywords don't describe this image — the plan came from the board and pin metadata, which disagree with the picture${
        candidate.imageSubject ? ` (the image shows: ${candidate.imageSubject})` : ""
      }. Needs a human decision about which is wrong.`,
    );
  }

  return issues;
}

/* ---------------- Deterministic scoring ---------------- */

export type SeoScore = {
  total: number;
  breakdown: {
    keywordPlacement: number;
    coverage: number;
    visibleSpan: number;
    specificity: number;
    readability: number;
    length: number;
    saveIntent: number;
    demand: number;
  };
};

// Weights, summing to 100. Tuned so the score DISCRIMINATES rather than
// saturating: the previous split handed out 90+ to anything that put the keyword
// in the right place, which made it useless as a quality signal — every
// candidate looked equally good, including one whose copy was about a different
// subject than the image.
//
// What earns points now is what actually moves a pin in search: the keyword
// where it's visible, the supporting phrases genuinely covered, the visible span
// carrying its weight, and concrete language over filler. Mechanics that
// repairSuggestion can fix for free (raw length) are worth the least, because
// they cost nothing to satisfy and therefore prove nothing.
const W = {
  keywordPlacement: 22,
  coverage: 18,
  visibleSpan: 14,
  specificity: 16,
  readability: 12,
  length: 8,
  saveIntent: 5,
  demand: 5,
} as const;

/** How much of the copy is concrete rather than filler. A rough but honest
 * proxy: distinct content words, penalised for the vague intensifiers that pad
 * copy without describing anything. */
function concreteness(text: string): number {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0;
  const VAGUE = new Set([
    "beautiful",
    "amazing",
    "stunning",
    "lovely",
    "great",
    "wonderful",
    "special",
    "unique",
    "quality",
    "style",
    "stylish",
    "modern",
    "trendy",
    "chic",
    "cute",
    "charm",
    "charming",
    "vibe",
    "vibes",
    "effortless",
    "timeless",
    "curated",
  ]);
  const distinct = new Set(tokens);
  const vague = [...distinct].filter((t) => VAGUE.has(t)).length;
  // Ratio of distinct non-vague words to total words: dense, varied, concrete
  // copy scores high; repetitive or adjective-stuffed copy scores low.
  return Math.max(0, (distinct.size - vague * 2) / tokens.length);
}

/** 0–100, computed from the finished copy alone. Shown next to a suggestion so
 * a creator can see WHY it's better than what they had, and recorded on the
 * history row so regressions are visible over time.
 *
 * Deliberately NOT a measure of whether the copy is about the right subject —
 * nothing deterministic can tell that. validateSuggestion's coherence check
 * covers it, using the model's own fitsKeywords verdict. */
export function scoreSuggestion(candidate: SuggestionCandidate, plan: KeywordPlan): SeoScore {
  const title = clean(candidate.title);
  const desc = clean(candidate.description);
  const targets = planTargets(plan);
  const supporting = [...plan.secondary, ...plan.longTail];
  const combined = `${title} ${desc}`;
  const pct = (n: number, of: number) => Math.round(n * of);

  /* keyword placement — the title is the strongest ranking field */
  const titleIdx = indexOfPhrase(title, plan.primary);
  const descIdx = indexOfPhrase(desc, plan.primary);
  let placeFrac = 0;
  if (titleIdx !== -1) {
    placeFrac += 0.5;
    // Full credit at position 0, tapering to zero at the truncation edge.
    if (titleIdx <= TITLE_KEYWORD_HEAD) {
      placeFrac += 0.3 * (1 - titleIdx / TITLE_KEYWORD_HEAD);
    }
  }
  if (descIdx !== -1 && descIdx <= DESC_KEYWORD_HEAD) placeFrac += 0.2;
  const keywordPlacement = pct(placeFrac, W.keywordPlacement);

  /* coverage — supporting phrases actually landed, not just the primary */
  const hit = supporting.filter((t) => coversPhrase(combined, t)).length;
  const coverage =
    supporting.length === 0
      ? W.coverage
      : pct(Math.min(1, hit / Math.max(2, Math.min(3, supporting.length))), W.coverage);

  /* visible span — the ~100 chars that actually show before "more" */
  const head = desc.slice(0, VISIBLE_SPAN);
  let spanFrac = 0;
  const headIdx = indexOfPhrase(head, plan.primary);
  if (headIdx !== -1) spanFrac += 0.6;
  // A visible span that also lands a supporting phrase is doing double duty.
  if (supporting.some((s) => coversPhrase(head, s))) spanFrac += 0.2;
  // And one that is a complete thought reads as a reason to save rather than a
  // sentence cut mid-clause.
  if (/[.!?]/.test(head)) spanFrac += 0.2;
  const visibleSpan = pct(spanFrac, W.visibleSpan);

  /* specificity — concrete language, and a long-tail phrase rather than only
   * broad head terms. This is what separates a pin that gets saved from one
   * that reads like every other pin in the category. */
  const longTailHit = plan.longTail.some((t) => coversPhrase(combined, t));
  const hasIntent = INTENT_MODIFIERS.some((m) => matchNormalize(combined).includes(m));
  const specFrac =
    0.5 * Math.min(1, concreteness(desc) / 0.6) + (longTailHit ? 0.3 : 0) + (hasIntent ? 0.2 : 0);
  const specificity = pct(Math.min(1, specFrac), W.specificity);

  /* readability */
  const sents = sentences(desc);
  let readFrac = 0;
  if (sents.length >= 2) readFrac += 0.34;
  if (!readsAsKeywordList(desc)) readFrac += 0.33;
  const avgWords = sents.length ? tokenize(desc).length / sents.length : 0;
  // 8–22 content words per sentence is the band that reads as written prose
  // rather than either a fragment list or an unbroken wall.
  if (avgWords >= 8 && avgWords <= 22) readFrac += 0.33;
  const readability = pct(readFrac, W.readability);

  /* length — cheap to satisfy, so weighted low; the sweet spot earns the rest */
  const inBand = (n: number, min: number, max: number) => n >= min && n <= max;
  let lenFrac = 0;
  if (inBand(title.length, PIN_TITLE_MIN, PIN_TITLE_MAX)) lenFrac += 0.25;
  if (inBand(title.length, TITLE_SWEET_MIN, TITLE_SWEET_MAX)) lenFrac += 0.25;
  if (inBand(desc.length, PIN_DESC_MIN, PIN_DESC_MAX)) lenFrac += 0.25;
  // A description that only clears the floor has no room left for the
  // supporting phrases, so the sweet spot is worth as much as the band itself.
  if (inBand(desc.length, DESC_SWEET_MIN, DESC_SWEET_MAX)) lenFrac += 0.25;
  const length = pct(lenFrac, W.length);

  /* save intent — saves are the ranking signal, so asking for one counts */
  const saveIntent = SAVE_CTA.test(desc) ? W.saveIntent : 0;

  /* demand — how much real search volume the covered terms carry */
  const volumes = plan.ranked
    .filter((k) => k.volume != null && coversPhrase(combined, k.term))
    .map((k) => k.volume as number);
  const demand = volumes.length ? pct(Math.min(1, Math.max(...volumes) / 100), W.demand) : 0;

  const breakdown = {
    keywordPlacement,
    coverage,
    visibleSpan,
    specificity,
    readability,
    length,
    saveIntent,
    demand,
  };
  return {
    total: Math.min(
      100,
      Object.values(breakdown).reduce((a, b) => a + b, 0),
    ),
    breakdown,
  };
}

/* ---------------- Deterministic repair ---------------- */

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function trimToWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/, "");
}

function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept: string[] = [];
  let total = 0;
  for (const s of sentences(text)) {
    if (total + s.length + 1 > max) break;
    kept.push(s);
    total += s.length + 1;
  }
  return kept.length > 0 ? kept.join(" ") : `${trimToWord(text, max - 1)}.`;
}

/** Sentences built from the keyword plan and the pin's own metadata, used to
 * lengthen thin copy with real content instead of filler. Ordered
 * most-to-least specific.
 *
 * Everything here is drawn from data we hold rather than from the image, since
 * this runs after the model has already answered — a repair pass must never
 * assert a visual detail nothing verified. */
function fillerSentences(context: PinSuggestionContext): string[] {
  const { plan, subject } = context;
  const out: string[] = [];
  const supporting = [...plan.longTail, ...plan.secondary];

  if (supporting[0]) out.push(`It works just as well if you're searching for ${supporting[0]}.`);
  if (subject.category) out.push(`Filed under ${subject.category}, and it earns the spot.`);
  if (supporting[1])
    out.push(`Worth a look too if ${supporting[1]} is what you're planning around.`);
  if (context.product?.priceLabel) out.push(`Currently listed at ${context.product.priceLabel}.`);
  if (context.board) out.push(`Saved to ${context.board.name} alongside the rest of the picks.`);
  out.push("Save this pin so it's waiting for you when you're ready to put the look together.");
  return out;
}

/** Mechanical fixes only — length, placement, banned characters. Anything
 * needing judgement (a boring title, a missing supporting phrase) is left for
 * the model retry. Returns copy that is strictly no worse than the input. */
export function repairSuggestion(
  candidate: SuggestionCandidate,
  context: PinSuggestionContext,
): SuggestionCandidate {
  const { plan } = context;
  let title = clean(candidate.title)
    .replace(/#/g, "")
    .replace(new RegExp(EMOJI.source, "gu"), "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:\s]+$/, "")
    .trim();
  let desc = clean(candidate.description)
    .replace(/#/g, "")
    .replace(new RegExp(EMOJI.source, "gu"), "")
    .replace(/\s+/g, " ")
    .trim();

  // When the model has told us the keyword plan doesn't describe this image,
  // forcing the keyword in is the WORST thing repair can do. It takes honest
  // copy about what's actually pictured and welds a foreign keyword onto the
  // front — "Easy weeknight dinners — Blue Lagoon geothermal spa day trip" —
  // which reads as spam to a shopper and to Pinterest, and it also disguises
  // the problem by making the mechanical checks pass. The suggestion is already
  // headed for needs_review; leave the copy truthful so a human can judge it.
  const forceKeyword = candidate.fitsKeywords !== false;

  /* title: primary keyword present and front-loaded */
  if (forceKeyword) {
    const titleIdx = indexOfPhrase(title, plan.primary);
    if (titleIdx === -1) {
      title = title ? `${capitalize(plan.primary)}: ${title}` : capitalize(plan.primary);
    } else if (titleIdx > TITLE_KEYWORD_HEAD) {
      // Lift the keyword to the front rather than rewriting around it.
      title = `${capitalize(plan.primary)} — ${title}`;
    }
  }

  /* title: length */
  if (title.length > PIN_TITLE_MAX) title = trimToWord(title, PIN_TITLE_MAX);
  if (title.length < PIN_TITLE_MIN) {
    // Longest usable tail first: clearing the floor in one append reads as a
    // written title, while three short ones chained with dashes read as a tag
    // list ("Man Portrait — T Shirts — Mens White Tee").
    const tails = [
      plan.longTail[0],
      plan.secondary[0],
      context.board?.name,
      context.subject.category,
    ]
      .filter((t): t is string => !!t && indexOfPhrase(title, t) === -1)
      .sort((a, b) => b.length - a.length);
    for (const tail of tails) {
      if (title.length >= PIN_TITLE_MIN) break;
      const next = `${title} — ${capitalize(tail)}`;
      if (next.length <= PIN_TITLE_MAX) title = next;
    }
  }

  /* description: primary keyword present and early */
  if (forceKeyword) {
    const descIdx = indexOfPhrase(desc, plan.primary);
    if (descIdx === -1 || descIdx > DESC_KEYWORD_HEAD) {
      // Front the keyword onto the copy the model already wrote rather than
      // bolting a stock sentence in front of it — an em-dash lead reads as
      // deliberate, where "This X is the kind of find worth…" reads as filler.
      if (descIdx > DESC_KEYWORD_HEAD) {
        // Drop the deeper mention so the repair can't breach the stuffing cap.
        desc = removeOneOccurrence(desc, plan.primary);
      }
      desc = desc ? `${capitalize(plan.primary)} — ${desc}` : capitalize(plan.primary);
    }
  }

  /* description: length */
  if (desc.length < PIN_DESC_MIN) {
    for (const sentence of fillerSentences(context)) {
      if (desc.length >= PIN_DESC_MIN) break;
      if (indexOfPhrase(desc, sentence) !== -1) continue;
      const next = `${desc} ${sentence}`.trim();
      if (next.length <= PIN_DESC_MAX) desc = next;
    }
  }
  if (desc.length > PIN_DESC_MAX) desc = trimToSentence(desc, PIN_DESC_MAX);

  // Sentence-initial capital, always.
  //
  // Models lowercase the opening word to reproduce a keyword "verbatim" —
  // "iceland travel guide to Milky-Blue Geothermal Hot Springs" — no matter how
  // firmly the prompt says matching is case-insensitive. It's a presentation
  // detail with a deterministic fix, so it's fixed here for free instead of
  // being spent on a paid retry. Keyword matching folds case, so this can never
  // break the verbatim contract.
  title = capitalize(title.trim());
  desc = capitalize(desc.trim());

  // imageSubject/fitsKeywords are the model's report about the IMAGE, not about
  // the copy, so mechanical repair must carry them through untouched — dropping
  // fitsKeywords here would silently discard the coherence warning.
  return {
    title,
    description: desc,
    imageSubject: candidate.imageSubject,
    fitsKeywords: candidate.fitsKeywords,
  };
}

/** Delete the LAST occurrence of a phrase, healing the surrounding spacing.
 * Used to bring an over-stuffed description back under the mention cap. */
function removeOneOccurrence(text: string, phrase: string): string {
  const idx = text.toLowerCase().lastIndexOf(phrase.toLowerCase());
  if (idx === -1) return text;
  return `${text.slice(0, idx)}${text.slice(idx + phrase.length)}`
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/* ---------------- LLM-free fallback ---------------- */

/** Copy written entirely from the keyword plan and the pin's metadata, with no
 * model call at all. Used when the proxy is unreachable or every attempt
 * failed, so the pipeline degrades to "keyword-correct, honest copy" instead of
 * an error. Runs through repairSuggestion() so it satisfies the same length and
 * placement rules everything else does.
 *
 * Deliberately makes no claim about what the image looks like — nothing here
 * has seen it. */
export function composeFallback(context: PinSuggestionContext): SuggestionCandidate {
  const { plan, subject } = context;
  const anchor = plan.secondary[0] ?? subject.category ?? context.board?.name ?? "";
  const title = [capitalize(plan.primary), anchor ? capitalize(anchor) : null]
    .filter(Boolean)
    .join(" — ");

  const opening = `This ${plan.primary} is the kind of find worth planning a whole look around.`;
  const detail = plan.longTail[0]
    ? `A good match if ${plan.longTail[0]} is what you're after.`
    : "";

  return repairSuggestion(
    { title, description: [opening, detail].filter(Boolean).join(" ") },
    context,
  );
}
