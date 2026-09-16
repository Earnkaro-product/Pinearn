// Product tags on the client — the one shape both flows carry.
//
// The BACKEND decides which products a pin is tagged with and in what order
// (planProductTags in product-tags.functions.ts). What the client holds is a
// list of `PendingProductTag`s: the products the creator has attached, each
// stamped with the backend's rank and match metadata when the backend knows
// it. `sequenceProductTags` applies that rank — it sorts, it never scores —
// so the Attach Products grid, both Previews and the persisted rows all show
// the same sequence for the same pin.
//
// No network, no React: the monetise flow serialises these through
// sessionStorage between the dialog and /pins/preview.

import type { RawVisualMatch } from "@/lib/pinterest.functions";
import type { PlannedTag, ProductTagDto, ProductTagPlan } from "@/lib/product-tags.functions";
import { categoryOfTitle, type ProductCategory } from "@/lib/product-category";
import { hostBrand } from "@/lib/brands";
import type { SuggestionPrice } from "@/components/suggestion-card";
import type { CkResult } from "@/lib/pinterest.functions";
import {
  MAX_PRODUCT_TAGS_PER_PIN,
  canonicalTagLink,
  type TagBox,
  type TagConfidence,
  type TagSource,
} from "@/lib/product-tagging";

export type PendingProductTag = {
  /** Stable identity: `p:<productId>` for a product the creator already owns,
   * `u:<canonical url>` for a matched listing or pasted link. */
  key: string;
  productId: string | null;
  title: string;
  /** Retailer URL. */
  link: string;
  /** Retailer name as the card shows it ("Myntra"). */
  retailer: string;
  thumbnail: string | null;
  price: SuggestionPrice;
  priceCents: number | null;
  commissionPct: number | null;
  category: ProductCategory;
  detectedLabel: string | null;
  componentKey: number | null;
  box: TagBox | null;
  /** The backend's 1-based rank for this product on this pin; null when the
   * backend never scored it (a pasted link, a collection product). */
  rank: number | null;
  matchScore: number | null;
  confidence: TagConfidence | null;
  lookMatch: "same" | "close" | null;
  source: TagSource;
  /** The creator's own Pinterest product pin this tag mirrors, if any. */
  pinterestProductPinId: string | null;
  /** Set once the tag is persisted (existing pin being edited). */
  tagId: string | null;
};

/** The wire shape createPinterestPin / goLivePin / approveBoardPins accept.
 * Affiliate monetisation is decided by the backend (always on for a tag);
 * there is no creator-facing switch. */
export function toProductTagInput(t: PendingProductTag) {
  return {
    ...(t.productId
      ? { productId: t.productId }
      : {
          product: {
            title: t.title,
            affiliateUrl: t.link,
            imageUrl: t.thumbnail,
            priceCents: t.priceCents,
          },
        }),
    category: t.category,
    detectedLabel: t.detectedLabel,
    componentKey: t.componentKey,
    box: t.box,
    matchScore: t.matchScore,
    confidence: t.confidence,
    lookMatch: t.lookMatch,
    source: t.source,
    affiliateEnabled: true,
    pinterestProductPinId: t.pinterestProductPinId,
  };
}

function priceOf(details: CkResult | undefined, fallback: SuggestionPrice): SuggestionPrice {
  if (details) {
    return {
      value: `₹${details.discountedPrice.toLocaleString("en-IN")}`,
      extractedValue: details.discountedPrice,
      currency: "₹",
    };
  }
  return fallback;
}

function rupees(priceCents: number | null): SuggestionPrice {
  if (priceCents == null) return null;
  const amount = priceCents / 100;
  return { value: `₹${amount.toLocaleString("en-IN")}`, extractedValue: amount, currency: "₹" };
}

/** A tag the backend planned. `details` is the live CK price when the card
 * on screen has already confirmed one. */
export function tagFromPlanned(p: PlannedTag, details?: CkResult): PendingProductTag {
  const price = priceOf(details, p.match.price);
  return {
    key: p.productId ? `p:${p.productId}` : `u:${canonicalTagLink(p.match.link)}`,
    productId: p.productId,
    title: p.match.title,
    link: p.match.link,
    retailer: p.match.source,
    thumbnail: p.match.thumbnail,
    price,
    priceCents: price ? Math.round(price.extractedValue * 100) : null,
    commissionPct: null,
    category: p.category,
    detectedLabel: p.label,
    componentKey: p.componentKey,
    box: p.box,
    rank: p.rank,
    matchScore: p.score,
    confidence: p.confidence,
    lookMatch: p.match.lookMatch ?? null,
    source: p.source,
    pinterestProductPinId: p.pinterestProductPinId,
    tagId: null,
  };
}

/** A matched listing the creator attached before (or without) the backend
 * ranking it — a card tapped while the plan was still computing. */
export function tagFromMatch(match: RawVisualMatch, details?: CkResult): PendingProductTag {
  const price = priceOf(details, match.price);
  return {
    key: `u:${canonicalTagLink(match.link)}`,
    productId: null,
    title: match.title,
    link: match.link,
    retailer: match.source,
    thumbnail: match.thumbnail,
    price,
    priceCents: price ? Math.round(price.extractedValue * 100) : null,
    commissionPct: null,
    category: match.category ?? categoryOfTitle(match.title),
    detectedLabel: match.tag ?? null,
    componentKey: null,
    box: null,
    rank: null,
    matchScore: null,
    confidence: null,
    lookMatch: match.lookMatch ?? null,
    source: "manual",
    pinterestProductPinId: null,
    tagId: null,
  };
}

export function tagFromProduct(
  p: {
    id: string;
    title: string;
    affiliate_url: string;
    image_url: string | null;
    price_cents: number | null;
    commission_pct?: number | null;
  },
  source: TagSource,
): PendingProductTag {
  return {
    key: `p:${p.id}`,
    productId: p.id,
    title: p.title,
    link: p.affiliate_url,
    retailer: hostBrand(p.affiliate_url),
    thumbnail: p.image_url,
    price: rupees(p.price_cents),
    priceCents: p.price_cents,
    commissionPct: p.commission_pct ?? null,
    category: categoryOfTitle(p.title),
    detectedLabel: null,
    componentKey: null,
    box: null,
    rank: null,
    matchScore: null,
    confidence: null,
    lookMatch: null,
    source,
    pinterestProductPinId: null,
    tagId: null,
  };
}

/** A pasted link, not yet a product row anywhere. */
export function tagFromUrl(url: string, title: string, imageUrl: string | null): PendingProductTag {
  return {
    key: `u:${canonicalTagLink(url)}`,
    productId: null,
    title,
    link: url,
    retailer: hostBrand(url),
    thumbnail: imageUrl,
    price: null,
    priceCents: null,
    commissionPct: null,
    category: categoryOfTitle(title),
    detectedLabel: null,
    componentKey: null,
    box: null,
    rank: null,
    matchScore: null,
    confidence: null,
    lookMatch: null,
    source: "url",
    pinterestProductPinId: null,
    tagId: null,
  };
}

export function tagFromDto(t: ProductTagDto): PendingProductTag {
  const p = t.product;
  return {
    key: `p:${t.productId}`,
    productId: t.productId,
    title: p?.title ?? t.matchedTitle,
    link: p?.affiliate_url ?? t.productUrl,
    retailer: hostBrand(p?.affiliate_url ?? t.productUrl),
    thumbnail: p?.image_url ?? null,
    price: rupees(p?.price_cents ?? null),
    priceCents: p?.price_cents ?? null,
    commissionPct: p?.commission_pct ?? null,
    category: t.category,
    detectedLabel: t.detectedLabel,
    componentKey: t.componentKey,
    box: t.box,
    rank: t.position + 1,
    matchScore: t.matchScore,
    confidence: t.confidence,
    lookMatch: t.lookMatch,
    source: t.source,
    pinterestProductPinId: t.pinterestProductPinId,
    tagId: t.id,
  };
}

/** Two tags are the same product if they share a product row or a listing. */
export function sameProduct(a: PendingProductTag, b: PendingProductTag): boolean {
  if (a.productId && b.productId && a.productId === b.productId) return true;
  return canonicalTagLink(a.link) === canonicalTagLink(b.link);
}

/**
 * The canonical sequence for a set of attached products: the backend's rank
 * first (rank 1 leads), then everything the backend never scored in the order
 * it was attached, deduplicated, capped at the per-pin limit. This is the one
 * ordering rule — Attach Products, both Previews and the persisted rows all
 * go through it.
 */
export function sequenceProductTags(
  attached: PendingProductTag[],
  limit = MAX_PRODUCT_TAGS_PER_PIN,
): PendingProductTag[] {
  const out: PendingProductTag[] = [];
  for (const t of attached) if (!out.some((o) => sameProduct(o, t))) out.push(t);
  return out
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.rank ?? Infinity) - (b.t.rank ?? Infinity) || a.i - b.i)
    .map(({ t }) => t)
    .slice(0, limit);
}

/**
 * The creator's Attach Products choices. The backend's plan is the default;
 * these are the deltas on top of it: cards tapped on or off (kept with the
 * match they were tapped on, so Preview can render a card the backend never
 * ranked), owned products picked from a collection, pasted links, and the
 * live prices the cards on screen have confirmed.
 */
export type AttachmentState = {
  overrides: Map<string, { selected: boolean; match: RawVisualMatch }>;
  productIds: string[];
  pasted: PendingProductTag[];
  confirmedByLink: Map<string, CkResult>;
};

export const EMPTY_ATTACHMENT: AttachmentState = {
  overrides: new Map(),
  productIds: [],
  pasted: [],
  confirmedByLink: new Map(),
};

type OwnedProduct = {
  id: string;
  title: string;
  affiliate_url: string;
  image_url: string | null;
  price_cents: number | null;
  commission_pct?: number | null;
};

/**
 * Plan + creator's deltas → the attached products, in the backend's sequence.
 *
 * The plan's tags are attached unless tapped off; a card tapped on that the
 * plan didn't pick is attached with whatever rank the backend gave it (or
 * unranked, if the backend hasn't seen it); owned products and pasted links
 * are unranked. Then `sequenceProductTags` orders and caps the lot. This is the
 * ONE derivation both flows use, so the grid's checkmarks, Preview and the
 * persisted rows can never disagree.
 */
export function composeAttachedTags(
  plan: ProductTagPlan | undefined,
  a: AttachmentState,
  products: OwnedProduct[],
  lead: PendingProductTag[] = [],
): PendingProductTag[] {
  const planByLink = new Map<string, PlannedTag>();
  for (const t of plan?.ranked ?? []) planByLink.set(canonicalTagLink(t.match.link), t);

  const out: PendingProductTag[] = [...lead];
  const offed = new Set<string>();
  for (const [link, o] of a.overrides) if (!o.selected) offed.add(canonicalTagLink(link));

  for (const t of plan?.tags ?? []) {
    const key = canonicalTagLink(t.match.link);
    if (offed.has(key)) continue;
    out.push(tagFromPlanned(t, a.confirmedByLink.get(t.match.link)));
  }
  for (const [link, o] of a.overrides) {
    if (!o.selected) continue;
    const key = canonicalTagLink(link);
    const ranked = planByLink.get(key);
    out.push(
      ranked
        ? tagFromPlanned(ranked, a.confirmedByLink.get(link))
        : tagFromMatch(o.match, a.confirmedByLink.get(link)),
    );
  }
  for (const id of a.productIds) {
    const p = products.find((x) => x.id === id);
    if (p && !offed.has(canonicalTagLink(p.affiliate_url)))
      out.push(tagFromProduct(p, "collection"));
  }
  out.push(...a.pasted.filter((t) => !offed.has(canonicalTagLink(t.link))));
  return sequenceProductTags(out);
}

/** The set a grid reads its checkmarks from. */
export function attachedLinkSet(tags: PendingProductTag[]): Set<string> {
  return new Set(tags.map((t) => canonicalTagLink(t.link)));
}

/* ---------------- The pin's collection URL ---------------- */

/**
 * The slug of a pin's own storefront collection — the one Go Live (or publish,
 * for a wizard pin with products) files its products under. Derived from the
 * pin id, so it is known BEFORE the collection exists: Preview can show the
 * exact "Visit website" destination, and the Pinterest `link` can carry it,
 * for a pin that isn't live yet. Pins monetised before this rule keep their
 * old random-suffix slug (Go Live reuses their collection); only new
 * collections are named this way.
 */
export function pinCollectionSlug(title: string, pinId: string): string {
  const base =
    (title ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "collection";
  return `${base}-${pinId.replace(/-/g, "").slice(0, 6)}`;
}

/** Where a shopper lands from the pin: the storefront with that collection
 * open. `?c=` is the deep link the storefront page reads (s.$slug.tsx). */
export function pinCollectionUrl(
  origin: string,
  storefrontSlug: string,
  collectionSlug: string,
): string {
  return `${origin}/s/${storefrontSlug}?c=${encodeURIComponent(collectionSlug)}`;
}

/** Pins monetised before `pinCollectionUrl` carry `/s/slug#collection`, a form
 * the storefront page never read (it opens collections from `?c=`). Read them
 * as the link they meant. */
export function normalizeCollectionUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hash && !u.searchParams.has("c")) {
      u.searchParams.set("c", decodeURIComponent(u.hash.slice(1)));
      u.hash = "";
    }
    return u.toString();
  } catch {
    return url;
  }
}
