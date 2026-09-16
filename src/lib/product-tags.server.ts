// Product tags — the server half shared by every writer.
//
// Three paths create tags: publishing a new Pin (createPinterestPin), taking an
// existing Pin live (performGoLive — single-pin preview AND board bulk approve),
// and the tag endpoints in product-tags.functions.ts. They all funnel through
// `writePinProductTags` below so the limit, the duplicate rule, the product
// resolution and the `pins.product_id` mirror are decided in exactly one place.
//
// Server-only: imported at module top by *.functions.ts files the same way
// vision-detect.server.ts is — the handler bodies never ship to the client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import { PRODUCT_CATEGORIES, type ProductCategory } from "@/lib/product-category";
import {
  MAX_PRODUCT_TAGS_PER_PIN,
  canonicalTagLink,
  type TagBox,
  type TagConfidence,
  type TagSource,
} from "@/lib/product-tagging";

/** One tag as a client is allowed to describe it.
 *
 * Either an existing `productId` (must be the caller's own row) or a `product`
 * to create — never both. Everything else is metadata about HOW the product was
 * chosen; it is stored for display and audit, clamped to its domain, and never
 * used to grant anything: a client cannot promote a tag by reporting a higher
 * score, it can only describe what it saw. */
export const productTagInputSchema = z
  .object({
    productId: z.string().uuid().optional(),
    product: z
      .object({
        title: z.string().trim().min(1).max(300),
        affiliateUrl: z.string().url().max(2048),
        imageUrl: z.string().url().max(2048).nullable().optional(),
        priceCents: z.number().int().nonnegative().nullable().optional(),
      })
      .optional(),
    category: z.enum(PRODUCT_CATEGORIES).optional().default("other"),
    detectedLabel: z.string().trim().max(80).nullable().optional(),
    componentKey: z.number().int().min(-1).max(31).nullable().optional(),
    box: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        w: z.number().min(0).max(1),
        h: z.number().min(0).max(1),
      })
      .nullable()
      .optional(),
    matchScore: z.number().min(0).max(1).nullable().optional(),
    confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
    lookMatch: z.enum(["same", "close"]).nullable().optional(),
    source: z
      .enum(["auto", "suggested", "search", "url", "collection", "manual"])
      .optional()
      .default("manual"),
    affiliateEnabled: z.boolean().optional().default(true),
    /** Pinterest's id for the product pin this tag mirrors, when the product
     * came from the creator's own tags on Pinterest (read into the plan by
     * planProductTags). Opaque numeric string. */
    pinterestProductPinId: z
      .string()
      .regex(/^\d{1,32}$/)
      .nullable()
      .optional(),
  })
  .refine((t) => !!t.productId !== !!t.product, {
    message: "A tag names either an existing product or a new one, not both",
  })
  .refine((t) => !t.product || /^https?:$/.test(safeProtocol(t.product.affiliateUrl)), {
    message: "Product links must be http(s) URLs",
  });

export type ProductTagInput = z.infer<typeof productTagInputSchema>;

/** The array form every bulk writer validates with — the limit lives here, so
 * an over-long payload is rejected before a single row is touched. */
export const productTagListSchema = z.array(productTagInputSchema).max(MAX_PRODUCT_TAGS_PER_PIN, {
  message: `A Pin can have at most ${MAX_PRODUCT_TAGS_PER_PIN} tagged products`,
});

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

/** A tag as the app reads it back: the row plus the product it points at. */
export type PinProductTagRow = Database["public"]["Tables"]["pin_product_tags"]["Row"] & {
  product: {
    id: string;
    title: string;
    affiliate_url: string;
    image_url: string | null;
    price_cents: number | null;
    currency: string | null;
    commission_pct: number | null;
    storefront_id: string;
    collection_id: string | null;
  } | null;
};

export const TAG_SELECT =
  "*, product:storefront_products(id,title,affiliate_url,image_url,price_cents,currency,commission_pct,storefront_id,collection_id)";

export async function listTagsForPin(
  supabase: SupabaseClient<Database>,
  pinId: string,
): Promise<PinProductTagRow[]> {
  const { data, error } = await supabase
    .from("pin_product_tags")
    .select(TAG_SELECT)
    .eq("pin_id", pinId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PinProductTagRow[];
}

export class ProductTagLimitError extends Error {
  constructor() {
    super(`You can tag up to ${MAX_PRODUCT_TAGS_PER_PIN} products on a Pin`);
    this.name = "ProductTagLimitError";
  }
}

/** The Postgres trigger raises with this text when it is the one that catches
 * an over-limit insert; translate it so the creator reads the same sentence
 * whichever layer refused. */
export function friendlyTagError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/at most \d+ tagged products/i.test(msg)) return new ProductTagLimitError();
  if (/pin_product_tags_pin_product_unique/i.test(msg))
    return new Error("That product is already tagged on this Pin");
  return e instanceof Error ? e : new Error(msg);
}

export type WriteTagsResult = {
  tags: PinProductTagRow[];
  /** Product ids in the order they were tagged — position order. */
  productIds: string[];
  /** Product ids that were created by this write (vs reused/existing). */
  createdProductIds: string[];
};

export type WriteTagsOptions = {
  /** `inputs` is the COMPLETE desired set: tags on the pin that it doesn't
   * name are removed first (their product rows detached — see
   * detachUntaggedProducts). Off by default: an add is an add. */
  replace?: boolean;
  /** The pin is live, so enabled tags are `monetised` rather than `pending`. */
  live?: boolean;
};

/** Which existing tag an input refers to, if any: by product id, else by the
 * listing's canonical URL. */
export function matchesExisting(input: ProductTagInput, tag: PinProductTagRow): boolean {
  if (input.productId) return input.productId === tag.product_id;
  if (input.product) {
    const key = canonicalTagLink(input.product.affiliateUrl);
    return (
      canonicalTagLink(tag.product_url) === key ||
      (!!tag.product && canonicalTagLink(tag.product.affiliate_url) === key)
    );
  }
  return false;
}

/**
 * Product rows that exist only to be on this pin — created by a match or a
 * pasted link, filed under nothing or under the pin's own per-pin collection —
 * are deleted when their tag goes; a product from one of the creator's real
 * collections is left where it is. Without this, a removed tag left a row with
 * `pin_id` null but `collection_id` still pointing at the per-pin collection,
 * which take-down could no longer reach and cleanup then refused to delete.
 */
export async function detachUntaggedProducts(
  supabase: SupabaseClient<Database>,
  pin: { id: string; collection_id?: string | null },
  productIds: string[],
): Promise<void> {
  if (productIds.length === 0) return;
  const { data: rows } = await supabase
    .from("storefront_products")
    .select("id,collection_id,pin_id")
    .in("id", productIds);
  const { data: stillTagged } = await supabase
    .from("pin_product_tags")
    .select("product_id")
    .in("product_id", productIds);
  const keep = new Set((stillTagged ?? []).map((t) => t.product_id));
  let perPin: Set<string> | null = null;
  const toDelete: string[] = [];
  for (const r of rows ?? []) {
    if (keep.has(r.id)) continue;
    if (r.collection_id == null) {
      toDelete.push(r.id);
      continue;
    }
    if (!perPin) {
      // The collection Go Live created for this pin (source 'manual', and not
      // the board it came from) only ever held this pin's products.
      const { data: pinRow } = await supabase
        .from("pins")
        .select("collection_id,origin_collection_id")
        .eq("id", pin.id)
        .maybeSingle();
      perPin = new Set<string>();
      const cid = pinRow?.collection_id ?? pin.collection_id ?? null;
      if (cid && cid !== pinRow?.origin_collection_id) {
        const { data: coll } = await supabase
          .from("collections")
          .select("id,source")
          .eq("id", cid)
          .maybeSingle();
        if (coll?.source === "manual") perPin.add(coll.id);
      }
    }
    if (perPin.has(r.collection_id)) toDelete.push(r.id);
  }
  if (toDelete.length > 0) {
    await supabase.from("storefront_products").delete().in("id", toDelete);
  }
}

/**
 * Attach `inputs` to `pin` as product tags, creating product rows as needed.
 *
 * - Existing tags on the pin are kept (or, with `replace`, the ones the input
 *   doesn't name are removed first); a product already tagged is not tagged
 *   twice — its metadata is refreshed instead, so re-running a match updates
 *   the score rather than erroring.
 * - `existing + new` must fit inside MAX_PRODUCT_TAGS_PER_PIN or NOTHING is
 *   written — a partial tag list is worse than an error the caller can show.
 * - New products reuse a row with the same canonical URL on the storefront
 *   ONLY if that row is free or already this pin's. A row that belongs to
 *   another pin is never re-homed: `storefront_products.pin_id` is a single
 *   column, so "reusing" it would silently take the product off the other pin
 *   (and a take-down of this pin would then cascade the other pin's tag away).
 *   The same rule applies to an existing `productId` — a product on another
 *   pin is cloned, not stolen.
 * - `pins.product_id` is set to the position-0 product when the pin has none,
 *   because every legacy reader (analytics, storefront, take-down) keys on it.
 *
 * `collectionId` is where NEW product rows are filed; pass the pin's per-pin
 * collection from go-live, or null from the create flow where none exists yet.
 */
export async function writePinProductTags(
  supabase: SupabaseClient<Database>,
  userId: string,
  pin: { id: string; image_url: string | null },
  storefrontId: string,
  collectionId: string | null,
  inputs: ProductTagInput[],
  options: WriteTagsOptions = {},
): Promise<WriteTagsResult> {
  let existing = await listTagsForPin(supabase, pin.id);

  // REPLACE: drop only what the desired set no longer names. Done before the
  // write so the slots are free, and only for tags the creator chose to remove
  // — a failure later loses nothing they wanted kept.
  if (options.replace) {
    const gone = existing.filter((t) => !inputs.some((i) => matchesExisting(i, t)));
    if (gone.length > 0) {
      const { error } = await supabase
        .from("pin_product_tags")
        .delete()
        .in(
          "id",
          gone.map((t) => t.id),
        );
      if (error) throw new Error(error.message);
      await detachUntaggedProducts(
        supabase,
        pin,
        gone.map((t) => t.product_id),
      );
      existing = existing.filter((t) => !gone.includes(t));
    }
  }
  const existingByProduct = new Map(existing.map((t) => [t.product_id, t]));

  // Resolve every input to a product row id, in order, de-duplicating by the
  // canonical URL so two inputs for the same listing become one product.
  const resolved: Array<{ input: ProductTagInput; productId: string; created: boolean }> = [];
  const seenProducts = new Set<string>();
  const createdProductIds: string[] = [];

  type OwnRow = {
    id: string;
    affiliate_url: string;
    title: string;
    image_url: string | null;
    price_cents: number | null;
    pin_id: string | null;
  };
  const existingIds = inputs.map((i) => i.productId).filter((id): id is string => !!id);
  const ownRows = new Map<string, OwnRow>();
  if (existingIds.length > 0) {
    // Scoped to the caller: a forged id for another creator's product resolves
    // to nothing and the tag is refused, RLS or no RLS.
    const { data, error } = await supabase
      .from("storefront_products")
      .select("id,affiliate_url,title,image_url,price_cents,pin_id")
      .eq("user_id", userId)
      .in("id", existingIds);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) ownRows.set(r.id, r);
  }

  const newProductInputs = inputs.filter((i) => i.product);
  const byUrl = new Map<string, string>();
  if (newProductInputs.length > 0) {
    // Any FREE row on this storefront whose URL canonicalises to the same
    // listing. PostgREST can't canonicalise for us, so read the candidates by
    // raw URL first (the common exact-match case), then compare canonically.
    const { data, error } = await supabase
      .from("storefront_products")
      .select("id,affiliate_url,pin_id")
      .eq("storefront_id", storefrontId)
      .eq("user_id", userId)
      .or(`pin_id.is.null,pin_id.eq.${pin.id}`)
      .in(
        "affiliate_url",
        newProductInputs.map((i) => i.product!.affiliateUrl),
      );
    if (error) throw new Error(error.message);
    for (const r of data ?? []) byUrl.set(canonicalTagLink(r.affiliate_url), r.id);
  }

  const insertProduct = async (p: {
    title: string;
    affiliateUrl: string;
    imageUrl: string | null;
    priceCents: number | null;
  }): Promise<string> => {
    const { data: inserted, error } = await supabase
      .from("storefront_products")
      .insert({
        user_id: userId,
        storefront_id: storefrontId,
        collection_id: collectionId,
        pin_id: pin.id,
        title: p.title,
        affiliate_url: p.affiliateUrl,
        image_url: p.imageUrl ?? pin.image_url,
        price_cents: p.priceCents,
        // See 20260818120000_products_currency_inr.sql — every price this
        // pipeline produces is a rupee figure.
        currency: "INR",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    createdProductIds.push(inserted.id);
    return inserted.id;
  };

  for (const input of inputs) {
    let productId: string | null = null;
    let created = false;
    if (input.productId) {
      const own = ownRows.get(input.productId);
      if (!own) throw new Error("That product isn't in your store");
      if (own.pin_id && own.pin_id !== pin.id) {
        // On another pin: clone rather than steal (see the docblock).
        const key = canonicalTagLink(own.affiliate_url);
        productId = byUrl.get(key) ?? null;
        if (!productId) {
          productId = await insertProduct({
            title: own.title,
            affiliateUrl: own.affiliate_url,
            imageUrl: own.image_url,
            priceCents: own.price_cents,
          });
          created = true;
          byUrl.set(key, productId);
        }
      } else {
        productId = input.productId;
      }
    } else if (input.product) {
      const key = canonicalTagLink(input.product.affiliateUrl);
      productId = byUrl.get(key) ?? null;
      if (!productId) {
        productId = await insertProduct({
          title: input.product.title,
          affiliateUrl: input.product.affiliateUrl,
          imageUrl: input.product.imageUrl ?? null,
          priceCents: input.product.priceCents ?? null,
        });
        created = true;
        byUrl.set(key, productId);
      }
    }
    if (!productId || seenProducts.has(productId)) continue;
    seenProducts.add(productId);
    resolved.push({ input, productId, created });
  }

  const additions = resolved.filter((r) => !existingByProduct.has(r.productId));
  if (existing.length + additions.length > MAX_PRODUCT_TAGS_PER_PIN) {
    // Roll back the product rows this call created — they were only ever for
    // tags that are now not going to exist.
    if (createdProductIds.length > 0) {
      await supabase.from("storefront_products").delete().in("id", createdProductIds);
    }
    throw new ProductTagLimitError();
  }

  const status = (enabled: boolean) =>
    enabled ? (options.live ? "monetised" : "pending") : "disabled";

  let nextPosition = existing.reduce((m, t) => Math.max(m, t.position + 1), 0);
  const rows = additions.map(({ input, productId }) => {
    const own = input.productId ? ownRows.get(input.productId) : undefined;
    const title = input.product?.title ?? own?.title ?? "";
    const url = input.product?.affiliateUrl ?? own?.affiliate_url ?? "";
    return {
      user_id: userId,
      pin_id: pin.id,
      product_id: productId,
      position: nextPosition++,
      category: input.category as ProductCategory,
      detected_label: input.detectedLabel ?? null,
      component_key: input.componentKey ?? null,
      box: (input.box ?? null) as Json,
      matched_title: title,
      product_url: canonicalTagLink(url),
      match_score: input.matchScore ?? null,
      confidence: input.confidence ?? null,
      look_match: input.lookMatch ?? null,
      match_source: input.source,
      affiliate_enabled: input.affiliateEnabled,
      affiliate_url: url,
      monetisation_status: status(input.affiliateEnabled),
      pinterest_product_pin_id: input.pinterestProductPinId ?? null,
    };
  });

  if (rows.length > 0) {
    const { error } = await supabase.from("pin_product_tags").insert(rows);
    if (error) throw friendlyTagError(new Error(error.message));
  }

  // A re-tag of an already-tagged product refreshes what the matcher now knows
  // — and, in replace mode, the creator's affiliate choice for it.
  for (const r of resolved) {
    const held = existingByProduct.get(r.productId);
    if (!held) continue;
    const patch: Database["public"]["Tables"]["pin_product_tags"]["Update"] = {};
    if (r.input.matchScore != null) patch.match_score = r.input.matchScore;
    if (r.input.confidence) patch.confidence = r.input.confidence;
    if (r.input.lookMatch) patch.look_match = r.input.lookMatch;
    if (r.input.detectedLabel) patch.detected_label = r.input.detectedLabel;
    if (r.input.category && r.input.category !== "other") patch.category = r.input.category;
    if (options.replace && r.input.affiliateEnabled !== held.affiliate_enabled) {
      patch.affiliate_enabled = r.input.affiliateEnabled;
      patch.monetisation_status = status(r.input.affiliateEnabled);
    }
    if (Object.keys(patch).length > 0) {
      await supabase.from("pin_product_tags").update(patch).eq("id", held.id);
    }
  }

  let tags = await listTagsForPin(supabase, pin.id);
  // In replace mode the payload's order is the order.
  if (options.replace) {
    const order = resolved.map((r) => tags.find((t) => t.product_id === r.productId)?.id ?? "");
    tags = await reorderTags(supabase, pin.id, order.filter(Boolean));
  }
  const productIds = tags.map((t) => t.product_id);

  // Mirror the primary onto the pin row for every reader that predates tags.
  if (productIds.length > 0) {
    const { data: pinRow } = await supabase
      .from("pins")
      .select("product_id")
      .eq("id", pin.id)
      .maybeSingle();
    if (!pinRow?.product_id || !productIds.includes(pinRow.product_id)) {
      await supabase.from("pins").update({ product_id: productIds[0] }).eq("id", pin.id);
    }
  }

  return { tags, productIds, createdProductIds };
}

/** Re-number positions to match `orderedTagIds`; tags not named keep their
 * relative order after the named ones. */
export async function reorderTags(
  supabase: SupabaseClient<Database>,
  pinId: string,
  orderedTagIds: string[],
): Promise<PinProductTagRow[]> {
  const current = await listTagsForPin(supabase, pinId);
  const rank = new Map(orderedTagIds.map((id, i) => [id, i]));
  const ordered = [...current].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
  await Promise.all(
    ordered.map((t, i) =>
      t.position === i
        ? Promise.resolve()
        : supabase.from("pin_product_tags").update({ position: i }).eq("id", t.id),
    ),
  );
  if (ordered[0]) {
    await supabase.from("pins").update({ product_id: ordered[0].product_id }).eq("id", pinId);
  }
  return listTagsForPin(supabase, pinId);
}

/** Wire shape for a tag — what the client renders. Kept flat and JSON-safe. */
export type ProductTagDto = {
  id: string;
  pinId: string;
  productId: string;
  position: number;
  category: ProductCategory;
  detectedLabel: string | null;
  componentKey: number | null;
  box: TagBox | null;
  matchedTitle: string;
  productUrl: string;
  matchScore: number | null;
  confidence: TagConfidence | null;
  lookMatch: "same" | "close" | null;
  source: TagSource;
  affiliateEnabled: boolean;
  affiliateUrl: string | null;
  monetisationStatus: "pending" | "monetised" | "disabled" | "failed";
  pinterestProductPinId: string | null;
  product: PinProductTagRow["product"];
};

export function toTagDto(row: PinProductTagRow): ProductTagDto {
  const box = row.box as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
  const validBox =
    box &&
    typeof box.x === "number" &&
    typeof box.y === "number" &&
    typeof box.w === "number" &&
    typeof box.h === "number"
      ? { x: box.x, y: box.y, w: box.w, h: box.h }
      : null;
  return {
    id: row.id,
    pinId: row.pin_id,
    productId: row.product_id,
    position: row.position,
    category: (PRODUCT_CATEGORIES as readonly string[]).includes(row.category)
      ? (row.category as ProductCategory)
      : "other",
    detectedLabel: row.detected_label,
    componentKey: row.component_key,
    box: validBox,
    matchedTitle: row.matched_title,
    productUrl: row.product_url,
    matchScore: row.match_score == null ? null : Number(row.match_score),
    confidence: (row.confidence as TagConfidence | null) ?? null,
    lookMatch: (row.look_match as "same" | "close" | null) ?? null,
    source: row.match_source as TagSource,
    affiliateEnabled: row.affiliate_enabled,
    affiliateUrl: row.affiliate_url,
    monetisationStatus: row.monetisation_status as ProductTagDto["monetisationStatus"],
    pinterestProductPinId: row.pinterest_product_pin_id,
    product: row.product,
  };
}

// -----------------------------------------------------------------------------
// The Pinterest mirror.
//
// Pinterest's v5 API (5.28.0) can list and add product tags on a pin, but a tag
// there is a reference to one of the creator's OWN product pins — not a
// retailer URL. Almost every tag this app makes points at a Myntra/Amazon/
// Flipkart listing, which Pinterest's API cannot represent. So the mirror is
// deliberately narrow and never load-bearing:
//
//   - `readPinterestProductTags` reads what the creator tagged in the Pinterest
//     app and resolves each product pin to something showable, so the monetise
//     flow can offer those products as tags here.
//   - `pushTagsToPinterest` sends back the subset of our tags that carry a
//     `pinterest_product_pin_id` (i.e. came from that read). Idempotent on
//     Pinterest's side.
//
// Both are best-effort: sandbox-disabled endpoints, closed-beta gating and a
// stale token all read as "unavailable", never as a failed publish or go-live.
// -----------------------------------------------------------------------------

export type PinterestTaggedProduct = {
  pinterestPinId: string;
  title: string | null;
  link: string | null;
  imageUrl: string | null;
  isProduct: boolean;
};

export async function readPinterestProductTags(
  userId: string,
  pinterestPinId: string,
): Promise<{ available: boolean; products: PinterestTaggedProduct[]; reason?: string }> {
  const { withPinterestToken } = await import("@/lib/pinterest-oauth.functions");
  const { getPin, listPinProductTags } = await import("@/lib/pinterest-api");
  try {
    const ids = await withPinterestToken(userId, (t) => listPinProductTags(t, pinterestPinId));
    const resolved = await Promise.all(
      ids.slice(0, MAX_PRODUCT_TAGS_PER_PIN).map(async (id) => {
        try {
          const p = await withPinterestToken(userId, (t) => getPin(t, id));
          return {
            pinterestPinId: id,
            title: p.title,
            link: p.link,
            imageUrl: p.imageUrl,
            isProduct: p.isProduct,
          };
        } catch {
          return { pinterestPinId: id, title: null, link: null, imageUrl: null, isProduct: false };
        }
      }),
    );
    return { available: true, products: resolved };
  } catch (e) {
    return {
      available: false,
      products: [],
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function pushTagsToPinterest(
  supabase: SupabaseClient<Database>,
  userId: string,
  pinId: string,
): Promise<{ pushed: number; error: string | null }> {
  const { data: pin } = await supabase
    .from("pins")
    .select("pinterest_pin_id")
    .eq("id", pinId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!pin?.pinterest_pin_id) return { pushed: 0, error: null };

  const { data: tags } = await supabase
    .from("pin_product_tags")
    .select("pinterest_product_pin_id")
    .eq("pin_id", pinId)
    .not("pinterest_product_pin_id", "is", null);
  const ids = (tags ?? [])
    .map((t) => t.pinterest_product_pin_id)
    .filter((id): id is string => !!id);
  if (ids.length === 0) return { pushed: 0, error: null };

  const { withPinterestToken } = await import("@/lib/pinterest-oauth.functions");
  const { addPinProductTags } = await import("@/lib/pinterest-api");
  try {
    await withPinterestToken(userId, (t) => addPinProductTags(t, pin.pinterest_pin_id!, ids));
    return { pushed: ids.length, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[pushTagsToPinterest] failed", error);
    return { pushed: 0, error };
  }
}
