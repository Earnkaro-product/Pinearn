// What a pin is about, derived from data we already hold.
//
// Replaces the old vision stage (RapidAPI object detection + a second model
// call to interpret the labels). That stage existed because the copy model was
// text-only and needed the image described to it in words. It no longer is —
// the proxy receives `image_url` and the model looks at the pin directly — so
// the only thing still needed BEFORE the model call is a set of seed terms for
// the Pinterest Trends lookup, and a bag of vocabulary to score trend
// relevance against.
//
// Both come from the pin's own metadata: title, board name, tagged product,
// creator niche. That is free, unlimited, and never wrong about the pin in the
// way a guess would be — it just isn't a reading of the pixels, which is why
// nothing here is ever put in front of the model as a description of the
// image. The model does that part itself.

import { isPlaceholderText } from "@/lib/health-score";

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "your",
  "you",
  "this",
  "that",
  "from",
  "our",
  "new",
  "best",
  "top",
  "pin",
  "pins",
  "board",
  "collection",
  "shop",
  "buy",
  "sale",
  "off",
]);

/** Longest-first so "summer dress" beats "dress" as a trend seed. */
const MAX_SEEDS = 3;
const MAX_DESCRIPTORS = 12;

export type PinSubject = {
  /** Best available noun phrase for what the pin shows. May be "". */
  subject: string;
  /** Tagged product's category, when there is one. */
  category: string | null;
  /** Seeds for the Pinterest Trends keyword expansion, best first. */
  seedTerms: string[];
  /** Extra vocabulary describing this pin, used only for relevance scoring. */
  descriptors: string[];
  /** True when the subject came from a model that actually looked at the image,
   * rather than from metadata. Recorded so a thin keyword plan can be explained
   * ("we've never seen this pin's image") instead of just looking wrong. */
  observed: boolean;
};

export type SubjectInput = {
  /**
   * What a previous generation's model actually SAW in this image, if any.
   *
   * Outranks every metadata field because it's the only signal here that came
   * from the picture rather than from whatever the creator happened to type.
   * This is what closes the loop: the first suggestion for a pin seeds trends
   * from metadata, and every one after it seeds from the real subject — so a pin
   * titled "IMG_4821" on a board called "Stuff" still ends up with an on-topic
   * keyword plan the second time around.
   */
  observedImageSubject?: string | null;
  pinTitle?: string | null;
  pinDescription?: string | null;
  boardName?: string | null;
  productName?: string | null;
  productCategory?: string | null;
  niche?: string | null;
};

/** Placeholder text is dropped HERE rather than only at the call sites.
 *
 * "IMG_4821" as a trend seed expands to noise, and once it reaches the keyword
 * plan it reaches the copy — a generated description genuinely came back reading
 * "This img 4821 setup…". Every caller filtering it independently is one caller
 * away from that bug, so the filter lives at the source. */
function usable(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  return t && !isPlaceholderText(t) ? t : "";
}

function words(text: string | null | undefined): string[] {
  return usable(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** A short, seed-shaped phrase: the first few content words of a text, in
 * order, so "Linen Co-ord Set for Summer Brunch" yields "linen co-ord set"
 * rather than a bag of unordered tokens Pinterest can't expand. */
function phrase(text: string | null | undefined, maxWords = 3): string {
  const w = words(text);
  return w.slice(0, maxWords).join(" ");
}

/**
 * Build the pin's subject from metadata alone.
 *
 * Ordering is deliberate: a tagged product names the thing being sold more
 * reliably than a title the creator may never have written, and the board name
 * is the weakest signal because it describes a whole collection.
 */
export function buildPinSubject(input: SubjectInput): PinSubject {
  const observedPhrase = phrase(input.observedImageSubject, 4);
  const productPhrase = phrase(input.productName);
  const titlePhrase = phrase(input.pinTitle);
  const boardPhrase = phrase(input.boardName, 2);

  const subject = observedPhrase || productPhrase || titlePhrase || boardPhrase || "";

  // Seeds drive the Trends call, and each one costs an Apify run on a cache
  // miss, so keep the list short and distinct rather than exhaustive.
  const seedTerms: string[] = [];
  for (const candidate of [
    observedPhrase,
    productPhrase,
    titlePhrase,
    boardPhrase,
    phrase(input.niche, 2),
  ]) {
    if (!candidate) continue;
    if (seedTerms.some((s) => s === candidate || s.includes(candidate))) continue;
    seedTerms.push(candidate);
    if (seedTerms.length >= MAX_SEEDS) break;
  }

  const descriptors = [
    ...new Set([
      ...words(input.observedImageSubject),
      ...words(input.pinTitle),
      ...words(input.productName),
      ...words(input.productCategory),
      ...words(input.boardName),
      ...words(input.niche),
      // The existing description is vocabulary about this pin even when it's
      // poor copy, which is exactly what relevance scoring wants.
      ...words(input.pinDescription).slice(0, 8),
    ]),
  ].slice(0, MAX_DESCRIPTORS);

  return {
    subject,
    category: usable(input.productCategory) || null,
    seedTerms,
    descriptors,
    observed: Boolean(observedPhrase),
  };
}

/** True when metadata gave us essentially nothing to seed trends with — the
 * caller skips the Trends call rather than expanding a meaningless seed. */
export function isSubjectEmpty(subject: PinSubject): boolean {
  return subject.seedTerms.length === 0 && subject.descriptors.length === 0;
}
