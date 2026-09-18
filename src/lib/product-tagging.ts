// Product tagging — the pure half.
//
// A "product tag" is Pinterest's unit of shopping: one product, attached to one
// Pin, that a shopper can tap through to buy. This module owns everything about
// tags that needs NO network and NO database: the per-Pin limit, the exactness
// scoring that turns the match pipeline's candidates into ranked tag
// proposals, the confidence bands, and the slot allocation that decides which
// detected objects earn one of the limited tags.
//
// It is deliberately a no-network module (like pin-seo.ts and health-score.ts)
// so the SAME code runs in the browser — the create-Pin wizard scores the
// streamed matches as they land — and on the server, where the monetise path
// scores the finished pipeline output before writing tags. Two copies of this
// logic would drift, and a drifted copy fails silently: the wizard would
// auto-tag one product and Go Live a different one.
//
// The match pipeline (pinterest.functions.ts) is unchanged by this. It already
// finds, gates and verifies candidates per detected object; this module only
// reads what it emits — RawVisualMatch (link, title, tag, lookMatch, score) —
// plus the component it was found under, and decides.

import { categoriesAgree, categoryOfTitle, type ProductCategory } from "@/lib/product-category";

/**
 * The most products one Pin may carry.
 *
 * Pinterest's creator-facing "Tag products in your Pins" help article
 * (help.pinterest.com/en/article/tag-products-in-your-pins, read 2026-09-15)
 * says: "You can add up to 20 products in your Pin. However, if you tag
 * products with stickers, you can only tag up to five products." The business
 * article for collections-style tagging says 24, and the v5 API's bulk-add
 * accepts at most 24 product pins per request. The app is built for the
 * creator flow — product tags, not stickers, not collections ads — so 20 is
 * the number, and it sits under the API's 24 either way.
 *
 * The whole app enforces this one value: the wizard stops offering slots here,
 * `createPinterestPin` / `goLivePin` / `addPinProductTag` reject a payload past
 * it, and the `pin_product_tags` trigger in
 * `supabase/migrations/20260915120000_pin_product_tags.sql` is the last line
 * — it mirrors this value and MUST be changed in step with it.
 *
 * This is the only place the number is spelled in TypeScript. Everything else
 * imports it.
 */
export const MAX_PRODUCT_TAGS_PER_PIN = 20;

/** How many of each detected object's best matches lead the "All" grid as a
 * contiguous block, before the remainder is interleaved tier by tier. Three
 * is a shortlist a shopper can take in per thing in the picture without the
 * first object's matches filling the fold. See selectProductTags. */
export const ALL_TAB_LEAD_PER_COMPONENT = 3;

/** How sure the matcher is that a tag's product IS the object in the Pin. */
export type TagConfidence = "high" | "medium" | "low";

/** Where a tag came from. `auto` = the matcher picked it without a human;
 * everything else is a deliberate choice the creator made. */
export type TagSource = "auto" | "suggested" | "search" | "url" | "collection" | "manual";

/** A normalised 0-1 box (same space as the detector's), kept on a tag so a UI
 * can draw the dot where the product sits. */
export type TagBox = { x: number; y: number; w: number; h: number };

/** One candidate the scorer reads — the shape RawVisualMatch already has,
 * named locally so this module never imports from a `*.functions.ts` file
 * (which would drag the server-function machinery into a pure module). */
export type TagCandidateInput = {
  title: string;
  link: string;
  source: string;
  thumbnail: string | null;
  price: { value: string; extractedValue: number; currency: string } | null;
  lookMatch?: "same" | "close";
  /** Rank within its tab, lower = better, as emitted by the pipeline. */
  score?: number;
};

/** The detected object a candidate was found under. */
export type TagComponentInput = {
  key: number;
  label: string;
  category: ProductCategory;
  /** The detector's look description ("white leather low-top, gum sole") when
   * known — it is where colour and material come from. */
  signature?: string;
  box?: TagBox | null;
};

/** What the retailer's live page said, when the CK lookup has settled.
 * `undefined` = not looked up (yet); `null` = looked up and unusable. */
export type TagAvailability = { available: boolean } | null | undefined;

/** A scored, explainable proposal: "tag THIS product for THAT object". */
export type ProductTagProposal = {
  component: TagComponentInput;
  candidate: TagCandidateInput;
  /** 0–1, higher = more exact. Deterministic for the same inputs. */
  score: number;
  confidence: TagConfidence;
  /** The individual signals, so a debug panel (or a test) can say WHY. */
  signals: TagSignals;
};

export type TagSignals = {
  look: number;
  rank: number;
  label: number;
  category: number;
  attributes: number;
  copy: number;
  identifier: number;
  quality: number;
};

// -----------------------------------------------------------------------------
// Scoring.
//
// The weights sum to 1.0 for a candidate that is perfect on every axis. They
// are tuned so that:
//
//   - a look-gate "same" verdict on a well-ranked, category-agreeing card is
//     HIGH on its own (this is the exact product, the model looked at both);
//   - a "close" verdict, or a card the gate never judged, is MEDIUM unless the
//     Pin's own copy corroborates it (brand / model words in the title) — a
//     lookalike with no other evidence is a suggestion, never an auto-tag;
//   - a category conflict, or a dead retailer page, can never be auto-tagged
//     whatever else it scores.
//
// The pipeline's own `score` (Lens position, keyword overlap, niche, label
// hits — lower is better) is folded in as RANK: it is already the best
// combined proxy this stack has for image similarity, and re-deriving it here
// would be a second, drifting ranker.
// -----------------------------------------------------------------------------

const W = {
  look: 0.38,
  rank: 0.1,
  label: 0.1,
  category: 0.08,
  attributes: 0.06,
  copy: 0.16,
  identifier: 0.08,
  quality: 0.04,
} as const;

/** Auto-tag at or above this. */
export const HIGH_CONFIDENCE_MIN = 0.55;
/** Suggest (but do not attach) at or above this; below is browse-only. */
export const MEDIUM_CONFIDENCE_MIN = 0.35;

export function confidenceFor(score: number): TagConfidence {
  if (score >= HIGH_CONFIDENCE_MIN) return "high";
  if (score >= MEDIUM_CONFIDENCE_MIN) return "medium";
  return "low";
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "buy",
  "online",
  "best",
  "price",
  "india",
  "men",
  "mens",
  "women",
  "womens",
  "girls",
  "boys",
  "kids",
  "pack",
  "set",
  "pcs",
  "com",
  "new",
  "shop",
  "sale",
  "free",
  "off",
  "your",
  "this",
  "that",
  "from",
  "look",
  "outfit",
  "style",
  "ideas",
  "aesthetic",
  "inspo",
  "pin",
  "pinterest",
]);

/** Lowercased word set, punctuation stripped, stopwords and 1–2 letter words
 * dropped. Mirrors the pipeline's `extractKeywords` so both halves see the
 * same tokens. */
export function tagWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function overlapRatio(needles: Set<string>, haystack: Set<string>): number {
  if (needles.size === 0) return 0;
  let hits = 0;
  for (const w of needles) if (haystack.has(w)) hits++;
  return hits / needles.size;
}

/** Words that read as an exact product identifier: a bare number ("Air Force
 * 1", "AirPods Pro 2" — ordinals fold to the number, so "2nd Generation" is
 * "2"), a token mixing letters and digits ("af1", "990v6", "iphone15"), or an
 * all-caps model code. These are the tokens that separate "AirPods Pro 2nd
 * Generation" from "AirPods", so a hit is weighted as a distinct signal rather
 * than as one more overlapping word. */
export function identifierWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/[^a-z0-9]/gi, "");
    if (!w) continue;
    const ordinal = w.match(/^(\d+)(st|nd|rd|th)$/i);
    if (ordinal) out.add(ordinal[1]);
    else if (/^\d{1,4}$/.test(w)) out.add(w);
    else if (/\d/.test(w) && /[a-z]/i.test(w)) out.add(w.toLowerCase());
    else if (/^[A-Z]{2,6}$/.test(w) && w !== "OFF" && w !== "NEW") out.add(w.toLowerCase());
  }
  return out;
}

/** Score one candidate against the object it was found under.
 *
 * `rankInTab` is the candidate's 0-based position in its tab's pipeline order
 * — the pipeline has already sorted "same" ahead of "close" ahead of unjudged,
 * then by its own score, so position is the cleanest way to read that order
 * without re-implementing it. `pinCopy` is the Pin's own title + description.
 */
export function scoreTagCandidate(
  candidate: TagCandidateInput,
  component: TagComponentInput,
  rankInTab: number,
  pinCopy: string,
  availability?: TagAvailability,
): ProductTagProposal {
  const titleWords = tagWords(candidate.title);

  // LOOK — the only signal that saw both the Pin and the product.
  const look = candidate.lookMatch === "same" ? 1 : candidate.lookMatch === "close" ? 0.3 : 0.25;

  // RANK — top card full marks, decaying to nothing by the sixth.
  const rank = Math.max(0, 1 - Math.min(rankInTab, 5) / 5);

  // LABEL — does the retailer title name what the detector called the object?
  // ("White Sneakers" vs "Nike Air Force 1 '07 White Sneakers")
  const label = overlapRatio(tagWords(component.label), titleWords);

  // CATEGORY — read from the title with the shared vocabulary. A conflict is
  // fatal below; "other" (unreadable title) is neutral, never a penalty.
  const titleCategory = categoryOfTitle(candidate.title);
  let category = 0.5;
  let conflict = false;
  if (component.category === "other" || titleCategory === "other") category = 0.5;
  else if (titleCategory === component.category) category = 1;
  else if (categoriesAgree(component.category, titleCategory)) category = 0.7;
  else {
    category = 0;
    conflict = true;
  }

  // ATTRIBUTES — colour / material / pattern words from the detector's own
  // description of THIS object, found in the retailer title.
  const attributes = component.signature
    ? overlapRatio(tagWords(component.signature), titleWords)
    : 0;

  // COPY — how much of what the creator wrote about the Pin the title repeats:
  // brand, model, colour. A ratio, not a count, so "White Sneakers" scores two
  // words of "Nike Air Force 1 white sneakers" and "Nike Air Force 1 '07 White
  // Sneakers" scores all five — that difference IS exactness. Capped at six
  // words so a long description doesn't dilute a title that names the product.
  const copyWords = tagWords(pinCopy);
  let copyHits = 0;
  for (const w of copyWords) if (titleWords.has(w)) copyHits++;
  const copy =
    copyWords.size > 0 ? Math.min(1, copyHits / Math.min(6, Math.max(2, copyWords.size))) : 0;

  // IDENTIFIER — a model code shared by the Pin copy and the title.
  const ids = identifierWords(pinCopy);
  const titleIds = identifierWords(candidate.title);
  let idHits = 0;
  for (const w of ids) if (titleIds.has(w)) idHits++;
  const identifier = ids.size > 0 ? Math.min(1, idHits) : 0;

  // QUALITY — is this a listing a shopper can actually use?
  let quality = 0;
  if (candidate.thumbnail) quality += 0.4;
  if (candidate.price) quality += 0.6;
  if (availability === null)
    quality = 0; // dead page
  else if (availability && !availability.available) quality *= 0.5;

  const signals: TagSignals = {
    look,
    rank,
    label,
    category,
    attributes,
    copy,
    identifier,
    quality,
  };
  let score =
    W.look * look +
    W.rank * rank +
    W.label * label +
    W.category * category +
    W.attributes * attributes +
    W.copy * copy +
    W.identifier * identifier +
    W.quality * quality;

  // Hard floors: a product from a different aisle, or a listing whose page is
  // gone, is never auto-tagged no matter how the soft signals add up.
  if (conflict || availability === null) score = Math.min(score, MEDIUM_CONFIDENCE_MIN - 0.01);

  score = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
  return { component, candidate, score, confidence: confidenceFor(score), signals };
}

// -----------------------------------------------------------------------------
// Selection — from every tab's ranked candidates to the tags a Pin gets.
// -----------------------------------------------------------------------------

export type TagSelectionInput = {
  /** One entry per detected object, in detection (prominence) order, each with
   * its candidates in pipeline order. */
  tabs: Array<{ component: TagComponentInput; candidates: TagCandidateInput[] }>;
  pinCopy: string;
  /** Per-link availability from the CK lookups that have settled so far. */
  availability?: Map<string, TagAvailability>;
  /** Links (or product ids mapped to links) the creator has already tagged or
   * explicitly removed — never proposed again. */
  excludeLinks?: Set<string>;
  /** Slots still open on the Pin. Defaults to the full limit. */
  slots?: number;
};

export type TagSelection = {
  /** High-confidence, one per object, best first, within the slot budget. */
  auto: ProductTagProposal[];
  /** Medium-confidence best-per-object, plus high ones that missed the budget.
   * Offered, never attached without a tap. */
  suggested: ProductTagProposal[];
  /** Objects for which nothing reached medium — the "we couldn't find this
   * one" list the UI can name. */
  unmatched: TagComponentInput[];
  /** Every scored candidate in the order the "All" grid renders: each
   * object's top ALL_TAB_LEAD_PER_COMPONENT as a contiguous block, in
   * detection order, then everything remaining interleaved tier by tier. */
  all: ProductTagProposal[];
};

/** Rank every candidate, pick the best per detected object, and allocate the
 * Pin's limited slots to the strongest objects.
 *
 * ONE tag per object: Pinterest tags a product per thing in the picture, and
 * two sneakers listings for the same pair of shoes is a duplicate to the
 * shopper even though they are different URLs. The other candidates stay
 * reachable through "Change product".
 *
 * Deterministic: same inputs → same output, so the wizard and the server agree.
 */
export function selectProductTags(input: TagSelectionInput): TagSelection {
  const slots = Math.max(
    0,
    Math.min(input.slots ?? MAX_PRODUCT_TAGS_PER_PIN, MAX_PRODUCT_TAGS_PER_PIN),
  );
  const excluded = input.excludeLinks ?? new Set<string>();

  // One scored list PER detected object, each best-first. Kept separate so
  // `all` can be interleaved by tier below — a flat score sort would let one
  // object's whole run of matches sit above another's.
  const perComponent: ProductTagProposal[][] = [];
  const bestPerComponent: ProductTagProposal[] = [];
  const unmatched: TagComponentInput[] = [];

  for (const tab of input.tabs) {
    const scored: ProductTagProposal[] = [];
    let best: ProductTagProposal | null = null;
    for (const [i, c] of tab.candidates.entries()) {
      const proposal = scoreTagCandidate(
        c,
        tab.component,
        i,
        input.pinCopy,
        input.availability?.get(c.link),
      );
      scored.push(proposal);
      if (excluded.has(c.link)) continue;
      if (!best || proposal.score > best.score) best = proposal;
    }
    scored.sort((a, b) => b.score - a.score);
    perComponent.push(scored);
    if (best && best.confidence !== "low") bestPerComponent.push(best);
    else unmatched.push(tab.component);
  }

  // The "All" sequence, in two parts.
  //
  // FIRST: each object's top few as a contiguous BLOCK, one object after
  // another in detection order — the vest's best three, then the pants' best
  // three, then the footwear's. The head of the grid reads as a shortlist per
  // thing in the picture, which is what a shopper scanning "All" is after.
  //
  // THEN: everything left over, interleaved tier by tier (every object's 4th,
  // then every object's 5th, ...) so no single object's long tail buries
  // another's.
  //
  // Sorting `all` flat by score instead (what this did originally) made the
  // grid read as one object's entire run, then the next object's, because
  // scores cluster hard within an object: the crop, the query and the
  // retailer set are all shared, so ten candidates for the same vest score
  // within a whisker of each other and far from anything for the pants.
  const all: ProductTagProposal[] = [];
  for (const scored of perComponent) {
    all.push(...scored.slice(0, ALL_TAB_LEAD_PER_COMPONENT));
  }
  const deepest = perComponent.reduce((n, c) => Math.max(n, c.length), 0);
  for (let tier = ALL_TAB_LEAD_PER_COMPONENT; tier < deepest; tier++) {
    for (const scored of perComponent) {
      if (tier < scored.length) all.push(scored[tier]);
    }
  }

  // The same product can be the best for two objects (two crops of one dress).
  // Keep it once, under the object it scores highest for.
  const seen = new Set<string>();
  const unique = bestPerComponent
    .sort((a, b) => b.score - a.score)
    .filter((p) => {
      if (seen.has(p.candidate.link)) return false;
      seen.add(p.candidate.link);
      return true;
    });

  const auto: ProductTagProposal[] = [];
  const suggested: ProductTagProposal[] = [];
  for (const p of unique) {
    if (p.confidence === "high" && auto.length < slots) auto.push(p);
    else suggested.push(p);
  }

  return { auto, suggested, unmatched, all };
}

/** Strip tracking noise and normalise so the same listing reached by two URLs
 * counts as one tag. Mirrors the pipeline's canonicaliser closely enough for
 * duplicate detection on the client; the server re-derives its own. */
export function canonicalTagLink(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const drop = [
      /^utm_/i,
      /^fbclid$/i,
      /^gclid$/i,
      /^ref$/i,
      /^tag$/i,
      /^srsltid$/i,
      /^mc_/i,
      /^_ga$/i,
    ];
    for (const key of [...u.searchParams.keys()]) {
      if (drop.some((re) => re.test(key))) u.searchParams.delete(key);
    }
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    return u.toString().replace(/\/+$/, "");
  } catch {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, "");
  }
}
