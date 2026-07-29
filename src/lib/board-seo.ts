// Board SEO — the copy contract for renaming and describing a board.
//
// Pure module, the board-level counterpart to pin-seo.ts, and deliberately
// separate because a board is not a big pin:
//
//   - A board name is a CATEGORY, not a product. "Mid Century Living Room
//     Decor" is a board; "Mustard Yellow Accent Chair" is a pin. The name has
//     to describe the whole collection, so it's built from what the pins have
//     in common rather than from any single one.
//   - Pinterest caps a board title at 50 characters and shows far fewer in the
//     grid, so the bands are much tighter than a pin title's.
//   - The rename is destructive in a way a pin rewrite isn't: it changes a URL
//     users may have saved. So a suggestion that isn't a genuine improvement
//     on the current name is rejected rather than applied — see
//     validateBoardSuggestion's no-op check, which is the specific bug this
//     module was written to kill (the old heuristic happily "suggested" the
//     board's existing name back to itself).

import { isPlaceholderText } from "@/lib/health-score";
import { describePlan, planTargets, tokenize, type KeywordPlan } from "@/lib/pin-keywords";
import { GENERIC_PHRASES } from "@/lib/pin-seo";

/* ---------------- Bands ---------------- */

// Pinterest's own limit is 50; below ~15 a name is too vague to rank.
export const BOARD_NAME_MIN = 15;
export const BOARD_NAME_MAX = 50;
// Board descriptions allow 500. A useful floor is a couple of real sentences.
export const BOARD_DESC_MIN = 120;
export const BOARD_DESC_MAX = 500;

/* ---------------- Context ---------------- */

export type BoardPinSummary = {
  title: string;
};

export type BoardSuggestionContext = {
  board: { id: string; name: string; description: string };
  /** Up to ~12 pins, whatever the board actually holds. */
  pins: BoardPinSummary[];
  pinCount: number;
  /** Creator's niche, from their storefront name + description. */
  niche: string | null;
  /** What the whole board is about, aggregated across its pins. */
  theme: string;
  plan: KeywordPlan;
};

export type BoardSuggestionCandidate = { name: string; description: string };

/* ---------------- Prompt ---------------- */

export function buildBoardPrompt(context: BoardSuggestionContext): string {
  const { board, plan } = context;
  const supporting = [...plan.secondary, ...plan.longTail];

  const lines: string[] = [
    "You are a Pinterest SEO strategist. Rename one board and write its description.",
    "",
    `WHAT IS ON THIS BOARD (${context.pinCount} ${context.pinCount === 1 ? "pin" : "pins"}):`,
    `- Overall theme: ${context.theme}`,
  ];

  // Pin titles, as a compact list. The model also receives the newest pin's
  // image, so this is the board's written vocabulary rather than its look.
  const titles = context.pins
    .slice(0, 12)
    .map((p) => p.title.trim())
    .filter(Boolean);
  if (titles.length > 0) {
    lines.push(`- Pins include: ${titles.map((t) => `"${t}"`).join(", ")}`);
  }

  lines.push(
    "",
    `Current name: "${board.name}"${isPlaceholderText(board.name) ? " — this is a placeholder, it says nothing about the content" : ""}`,
    board.description.trim()
      ? `Current description: "${board.description.trim()}"`
      : "Current description: (empty)",
    "",
    "WHAT THIS BOARD MUST RANK FOR (real Pinterest search data):",
    ...describePlan(plan),
    "",
    "HOW PINTEREST RANKS A BOARD — follow all of these:",
    `- The board name is the strongest signal. It MUST contain the primary keyword verbatim and be ${BOARD_NAME_MIN}-${BOARD_NAME_MAX} characters. Pinterest truncates past 50.`,
    "- Name the CATEGORY the board collects, not one product in it. This is a shelf label, not a price tag.",
    `- The name must be genuinely different from and better than the current one. Returning the current name back is a failure — if it is already good, sharpen it with the keyword and a qualifier.`,
    `- Description: ${BOARD_DESC_MIN}-${BOARD_DESC_MAX} characters, using the primary keyword verbatim in the first sentence, plus at least two supporting phrases woven in naturally.`,
    "- Write for a person deciding whether to follow: say what they will find here and why it is worth saving. Complete sentences, not a keyword list.",
    "- Title Case or Sentence case for the name. No hashtags, no emoji, no ALL-CAPS, no quotation marks.",
    "- Describe only what the pins above actually show. Never invent a brand, a price, or a product that isn't listed.",
    "",
    `NEVER use these filler phrases: ${GENERIC_PHRASES.map((p) => `"${p}"`).join(", ")}.`,
  );

  if (context.niche) {
    lines.push("", `Creator's niche: ${context.niche}. Reflect it in tone.`);
  }
  if (supporting.length > 0) {
    lines.push("", `Supporting phrases available: ${supporting.map((s) => `"${s}"`).join(", ")}.`);
  }

  // Output contract last, nothing after it — the text model has no structured
  // output mode, so this is the only thing keeping the response parseable.
  lines.push(
    "",
    "Count your characters before answering and confirm every rule above is satisfied.",
    "",
    "OUTPUT FORMAT — reply with a single raw JSON object and NOTHING else. No preamble, no markdown fences:",
    `{"name": "...", "description": "..."}`,
  );
  return lines.join("\n");
}

export function boardRetryFeedback(issues: string[], attempt: number): string {
  return [
    "",
    `ATTEMPT ${attempt} WAS REJECTED for these reasons:`,
    ...issues.map((i) => `- ${i}`),
    "Fix every one. Count characters literally before you answer.",
  ].join("\n");
}

/* ---------------- Validation ---------------- */

const EMOJI = /\p{Extended_Pictographic}/u;
const ALL_CAPS_WORD = /\b[A-Z]{4,}\b/;

function clean(text: string): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();
}

function matchNormalize(text: string): string {
  return (text ?? "").replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").toLowerCase();
}

function includesPhrase(haystack: string, needle: string): boolean {
  return matchNormalize(haystack).includes(matchNormalize(needle));
}

/** Loose match for supporting phrases — exact, or every content word present.
 * Same rationale as the pin validator: forcing four exact phrases produces
 * copy that reads like a checklist. */
function coversPhrase(text: string, phrase: string): boolean {
  if (includesPhrase(text, phrase)) return true;
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

/** How much two names share, 0–1 by token overlap. Used to reject a "rename"
 * that just echoes the current name — the exact failure that made the old
 * heuristic useless on a board called "Pin collection". */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

export function validateBoardSuggestion(
  candidate: BoardSuggestionCandidate,
  context: { plan: KeywordPlan; currentName: string },
): string[] {
  const issues: string[] = [];
  const name = clean(candidate.name ?? "");
  const desc = clean(candidate.description ?? "");
  const { primary } = context.plan;
  const supporting = [...context.plan.secondary, ...context.plan.longTail];

  if (name.length < BOARD_NAME_MIN)
    issues.push(`Board name is ${name.length} chars — needs at least ${BOARD_NAME_MIN}.`);
  if (name.length > BOARD_NAME_MAX)
    issues.push(
      `Board name is ${name.length} chars — Pinterest's hard limit is ${BOARD_NAME_MAX}.`,
    );
  if (desc.length < BOARD_DESC_MIN)
    issues.push(`Description is ${desc.length} chars — needs at least ${BOARD_DESC_MIN}.`);
  if (desc.length > BOARD_DESC_MAX)
    issues.push(`Description is ${desc.length} chars — the hard maximum is ${BOARD_DESC_MAX}.`);

  if (isPlaceholderText(name)) issues.push("Board name is placeholder text.");

  if (!includesPhrase(name, primary))
    issues.push(
      `Board name is missing the primary keyword "${primary}" — it must appear verbatim.`,
    );
  if (!includesPhrase(desc, primary))
    issues.push(`Description is missing the primary keyword "${primary}".`);

  // The whole point of the rename.
  if (matchNormalize(name) === matchNormalize(context.currentName)) {
    issues.push(
      `The suggested name is identical to the current one ("${context.currentName}"). Write a genuinely different, more specific name.`,
    );
  } else if (
    nameSimilarity(name, context.currentName) >= 0.99 &&
    name.length < BOARD_NAME_MIN + 5
  ) {
    issues.push(
      `The suggested name is barely different from "${context.currentName}". Add the category and a qualifier that says what makes this board worth following.`,
    );
  }

  const hits = supporting.filter((s) => coversPhrase(desc, s));
  if (supporting.length > 0 && hits.length < Math.min(2, supporting.length)) {
    issues.push(
      `Description uses ${hits.length} supporting phrase(s) — weave in at least ${Math.min(2, supporting.length)} of: ${supporting.map((s) => `"${s}"`).join(", ")}.`,
    );
  }

  if (sentences(desc).length < 2)
    issues.push("The description needs at least two complete sentences.");

  const combined = `${name} ${desc}`;
  const lower = combined.toLowerCase();
  for (const phrase of GENERIC_PHRASES) {
    if (lower.includes(phrase)) issues.push(`Remove the filler phrase "${phrase}".`);
  }
  if (combined.includes("#")) issues.push("Remove hashtags — Pinterest no longer indexes them.");
  if (EMOJI.test(combined)) issues.push("Remove emoji.");
  if (ALL_CAPS_WORD.test(combined)) issues.push("Remove ALL-CAPS words.");

  return issues;
}

/* ---------------- Scoring ---------------- */

export type BoardSeoScore = {
  total: number;
  breakdown: {
    keyword: number;
    coverage: number;
    length: number;
    readability: number;
    demand: number;
  };
};

export function scoreBoardSuggestion(
  candidate: BoardSuggestionCandidate,
  plan: KeywordPlan,
): BoardSeoScore {
  const name = clean(candidate.name);
  const desc = clean(candidate.description);
  const combined = `${name} ${desc}`;
  const targets = planTargets(plan);

  let keyword = 0;
  const nameIdx = matchNormalize(name).indexOf(matchNormalize(plan.primary));
  if (nameIdx !== -1) keyword += 20;
  // A board name is short; the keyword should be at or near its start.
  if (nameIdx === 0) keyword += 10;
  else if (nameIdx > 0 && nameIdx <= 12) keyword += 6;
  if (includesPhrase(desc.slice(0, 160), plan.primary)) keyword += 5;

  const hit = targets.filter((t) => coversPhrase(combined, t)).length;
  const coverage = targets.length === 0 ? 25 : Math.round((hit / targets.length) * 25);

  let length = 0;
  if (name.length >= BOARD_NAME_MIN && name.length <= BOARD_NAME_MAX) length += 10;
  if (desc.length >= BOARD_DESC_MIN && desc.length <= BOARD_DESC_MAX) length += 10;

  const sents = sentences(desc);
  let readability = 0;
  if (sents.length >= 2) readability += 5;
  const avgWords = sents.length ? tokenize(desc).length / sents.length : 0;
  if (avgWords >= 8 && avgWords <= 24) readability += 5;

  const volumes = plan.ranked
    .filter((k) => k.volume != null && coversPhrase(combined, k.term))
    .map((k) => k.volume as number);
  const demand = volumes.length
    ? Math.round(Math.min(1, volumes.reduce((a, b) => a + b, 0) / volumes.length / 100) * 10)
    : 0;

  const breakdown = { keyword, coverage, length, readability, demand };
  return { total: Math.min(100, keyword + coverage + length + readability + demand), breakdown };
}

/* ---------------- Deterministic repair + fallback ---------------- */

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function titleCase(text: string): string {
  const small = new Set(["and", "or", "the", "for", "with", "of", "in", "on", "a", "an", "to"]);
  return text
    .split(" ")
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : capitalize(w)))
    .join(" ");
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

/** Mechanical fixes only — length, keyword presence, banned characters. */
export function repairBoardSuggestion(
  candidate: BoardSuggestionCandidate,
  context: BoardSuggestionContext,
): BoardSuggestionCandidate {
  const { plan } = context;
  let name = clean(candidate.name)
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

  if (!includesPhrase(name, plan.primary)) {
    name = name ? `${titleCase(plan.primary)} ${name}` : titleCase(plan.primary);
  }
  if (name.length > BOARD_NAME_MAX) name = trimToWord(name, BOARD_NAME_MAX);
  if (name.length < BOARD_NAME_MIN) {
    for (const tail of [plan.secondary[0], context.theme, "Ideas"]) {
      if (name.length >= BOARD_NAME_MIN) break;
      if (!tail || includesPhrase(name, tail)) continue;
      const next = `${name} ${titleCase(tail)}`;
      if (next.length <= BOARD_NAME_MAX) name = next;
    }
  }

  if (!includesPhrase(desc, plan.primary)) {
    desc = desc ? `${capitalize(plan.primary)} — ${desc}` : capitalize(plan.primary);
  }
  if (desc.length < BOARD_DESC_MIN) {
    const filler = [
      plan.longTail[0] ? `Expect ${plan.longTail[0]} alongside the rest of the picks.` : "",
      plan.secondary[0] ? `Useful if ${plan.secondary[0]} is what you're planning around.` : "",
      `${context.pinCount} ${context.pinCount === 1 ? "pin" : "pins"} so far, added to regularly.`,
      "Follow the board to catch new finds as they land.",
    ].filter(Boolean);
    for (const sentence of filler) {
      if (desc.length >= BOARD_DESC_MIN) break;
      if (includesPhrase(desc, sentence)) continue;
      const next = `${desc} ${sentence}`.trim();
      if (next.length <= BOARD_DESC_MAX) desc = next;
    }
  }
  if (desc.length > BOARD_DESC_MAX) desc = trimToSentence(desc, BOARD_DESC_MAX);

  return { name: name.trim(), description: desc.trim() };
}

/** Written with no model at all, from the keyword plan and the board's theme.
 * Keeps the flow usable when the text model is unreachable. */
export function composeBoardFallback(context: BoardSuggestionContext): BoardSuggestionCandidate {
  const { plan } = context;
  const name = titleCase([plan.primary, plan.secondary[0] ?? "Ideas"].join(" "));
  const description = [
    `${capitalize(plan.primary)} collected in one place, curated from ${context.pinCount} ${context.pinCount === 1 ? "pin" : "pins"}.`,
    context.theme ? `Everything here centres on ${context.theme}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return repairBoardSuggestion({ name, description }, context);
}
