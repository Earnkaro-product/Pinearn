import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { hostBrand } from "@/lib/brands";
import { categoryOfTitle, type ProductCategory } from "@/lib/product-category";
import {
  MAX_PRODUCT_TAGS_PER_PIN,
  canonicalTagLink,
  scoreTagCandidate,
  selectProductTags,
  type ProductTagProposal,
  type TagBox,
  type TagConfidence,
  type TagSource,
} from "@/lib/product-tagging";
import {
  listTagsForPin,
  pushTagsToPinterest,
  readPinterestProductTags,
  toTagDto,
} from "@/lib/product-tags.server";
import { rankedComponentsForImage, type RawVisualMatch } from "@/lib/pinterest.functions";

export type { ProductTagDto, PinterestTaggedProduct } from "@/lib/product-tags.server";

// -------------------------------------------------------------
// Product tags — the buyer-facing "Shop the look" on a pin.
//
// The BACKEND decides which products a pin is tagged with and in what order.
// `planProductTags` below is that decision: it runs the real match pipeline
// over the pin image (every detected object, verified stage), scores every
// candidate for exactness with the product-tagging engine, keeps the best
// product per object, drops anything the engine isn't sure of, caps the set
// at Pinterest's limit and returns it RANKED. Both previews — the create-pin
// wizard's step 4 and the monetise flow's /pins/preview — render that plan as
// "Shop the look"; the Attach Products screens use it only to pre-select what
// the creator will attach. Nothing is written until publish / Go Live, when
// writePinProductTags persists the ordered set.
//
// There is deliberately no add/update/remove/search endpoint: tagging is not
// a manual editing feature. The creator attaches products; the plan orders.
// -------------------------------------------------------------

async function ownPin(
  supabase: Parameters<typeof listTagsForPin>[0],
  userId: string,
  pinId: string,
) {
  const { data: pin, error } = await supabase
    .from("pins")
    .select("id,title,description,image_url,storefront_id,collection_id,status,pinterest_pin_id")
    .eq("id", pinId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!pin) throw new Error("Pin not found");
  return pin;
}

export const listPinProductTags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { pinId: string }) => z.object({ pinId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await ownPin(supabase, userId, data.pinId);
    const tags = await listTagsForPin(supabase, data.pinId);
    return { tags: tags.map(toTagDto), limit: MAX_PRODUCT_TAGS_PER_PIN };
  });

/** One planned tag — a product the backend has decided belongs on the pin, in
 * rank order, with what the match pipeline knows about it. The score and
 * confidence are for the writer's audit columns; no buyer surface shows them. */
export type PlannedTag = {
  /** 1-based position in the canonical sequence. */
  rank: number;
  score: number;
  confidence: TagConfidence;
  source: TagSource;
  category: ProductCategory;
  /** The detected object this product was matched to ("Teddy Bear"). */
  label: string | null;
  componentKey: number | null;
  box: TagBox | null;
  match: RawVisualMatch;
  /** Set when this is one of the creator's own product pins, read off
   * Pinterest — the id a later push needs. */
  pinterestProductPinId: string | null;
  /** Set when the pin already carries this tag (a live pin re-planned). */
  productId: string | null;
};

export type ProductTagPlan = {
  imageUrl: string | null;
  limit: number;
  /** The detector found nothing purchasable in the image. */
  noProducts: boolean;
  /** The canonical, ranked, capped set. */
  tags: PlannedTag[];
  /** Every candidate the pipeline emitted, best first, so a screen listing
   * all matches can show them in the backend's order and know each one's
   * rank when the creator attaches it by hand. Unbounded by the limit. */
  ranked: PlannedTag[];
};

function planned(
  p: ProductTagProposal,
  rank: number,
  source: TagSource,
  extra: Partial<Pick<PlannedTag, "pinterestProductPinId" | "productId">> = {},
): PlannedTag {
  return {
    rank,
    score: p.score,
    confidence: p.confidence,
    source,
    category: p.component.category,
    label: p.component.label || null,
    componentKey: p.component.key >= 0 ? p.component.key : null,
    box: p.component.box ?? null,
    match: p.candidate as RawVisualMatch,
    pinterestProductPinId: extra.pinterestProductPinId ?? null,
    productId: extra.productId ?? null,
  };
}

/** The decision. Shared by the pinId and imageUrl entry points below. */
async function buildPlan(
  imageUrl: string | null,
  title: string,
  description: string,
  preset: Array<{
    match: RawVisualMatch;
    productId: string | null;
    pinterestProductPinId: string | null;
    category: ProductCategory;
    label: string | null;
  }>,
): Promise<ProductTagPlan> {
  const empty: ProductTagPlan = {
    imageUrl,
    limit: MAX_PRODUCT_TAGS_PER_PIN,
    noProducts: false,
    tags: [],
    ranked: [],
  };
  if (!imageUrl) return empty;

  const ranked = await rankedComponentsForImage(imageUrl, title, description);
  const pinCopy = `${title} ${description}`;

  // Products the creator has ALREADY committed to — the pin's saved tags and
  // what they tagged in the Pinterest app — lead the sequence. They are the
  // creator's call, not a candidate to be re-judged; the engine only orders
  // them among themselves by how well they fit.
  const lead: PlannedTag[] = [];
  const held = new Set<string>();
  for (const p of preset) {
    const key = canonicalTagLink(p.match.link);
    if (held.has(key)) continue;
    held.add(key);
    const proposal = scoreTagCandidate(
      p.match,
      { key: -1, label: p.label ?? "", category: p.category },
      0,
      pinCopy,
    );
    lead.push(
      planned(proposal, 0, "manual", {
        productId: p.productId,
        pinterestProductPinId: p.pinterestProductPinId,
      }),
    );
  }
  lead.sort((a, b) => b.score - a.score);
  // Saved tags and Pinterest-read tags can together exceed the limit; the
  // sequence never does.
  lead.splice(MAX_PRODUCT_TAGS_PER_PIN);

  const selection = selectProductTags({
    tabs: ranked.components.map((c) => ({
      component: {
        key: c.key,
        label: c.label,
        category: c.category,
        signature: c.signature,
        box: c.box,
      },
      candidates: c.matches,
    })),
    pinCopy,
    excludeLinks: new Set(
      ranked.components
        .flatMap((c) => c.matches.map((m) => m.link))
        .filter((l) => held.has(canonicalTagLink(l))),
    ),
    slots: Math.max(0, MAX_PRODUCT_TAGS_PER_PIN - lead.length),
  });

  // Automatic tags: the engine's confident pick per object, then its likely
  // ones — never a low-confidence product, whatever slots are left. "Poor
  // match" means an empty slot, not a wrong product.
  const chosen = [
    ...selection.auto,
    ...selection.suggested.filter((p) => p.confidence !== "low"),
  ].sort((a, b) => b.score - a.score);
  const tags: PlannedTag[] = [...lead];
  for (const p of chosen) {
    if (tags.length >= MAX_PRODUCT_TAGS_PER_PIN) break;
    const key = canonicalTagLink(p.candidate.link);
    if (held.has(key)) continue;
    held.add(key);
    tags.push(planned(p, 0, p.confidence === "high" ? "auto" : "suggested"));
  }
  tags.forEach((t, i) => (t.rank = i + 1));

  // Everything scored, best first, for the "All" grid's order. Planned tags
  // keep their rank; the rest continue the numbering below them.
  const inPlan = new Map(tags.map((t) => [canonicalTagLink(t.match.link), t]));
  const rest = selection.all
    .filter((p) => !inPlan.has(canonicalTagLink(p.candidate.link)))
    .map((p, i) => planned(p, tags.length + i + 1, p.confidence === "high" ? "auto" : "suggested"));
  const seen = new Set<string>();
  const all = [...tags, ...rest].filter((t) => {
    const key = canonicalTagLink(t.match.link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    imageUrl,
    limit: MAX_PRODUCT_TAGS_PER_PIN,
    noProducts: ranked.noProducts,
    tags,
    ranked: all,
  };
}

function matchFromProductRow(p: {
  title: string;
  affiliate_url: string;
  image_url: string | null;
  price_cents: number | null;
}): RawVisualMatch {
  const amount = p.price_cents != null ? p.price_cents / 100 : null;
  return {
    title: p.title,
    link: p.affiliate_url,
    source: hostBrand(p.affiliate_url),
    thumbnail: p.image_url,
    price:
      amount != null
        ? { value: `₹${amount.toLocaleString("en-IN")}`, extractedValue: amount, currency: "₹" }
        : null,
  };
}

/**
 * The canonical product tags for a pin (by id) or for an image that isn't a
 * pin yet (the create-pin wizard). One call, verified stage — it joins the
 * work the streamed screens already started, so by the time a creator reaches
 * Preview the answer is usually in hand.
 */
export const planProductTags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { pinId?: string; imageUrl?: string; title?: string; description?: string }) =>
    z
      .object({
        pinId: z.string().uuid().optional(),
        imageUrl: z.string().url().optional(),
        title: z.string().max(500).optional().default(""),
        description: z.string().max(2000).optional().default(""),
      })
      .refine((v) => !!v.pinId || !!v.imageUrl, "pinId or imageUrl is required")
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<ProductTagPlan> => {
    const { supabase, userId } = context;

    if (!data.pinId) {
      try {
        return await buildPlan(data.imageUrl!, data.title, data.description, []);
      } catch (e) {
        console.error("[planProductTags] pipeline failed", e);
        throw new Error("We couldn't scan this image right now. Try again in a moment.");
      }
    }

    const pin = await ownPin(supabase, userId, data.pinId);
    const preset: Parameters<typeof buildPlan>[3] = [];

    // Saved tags first (a live pin being re-monetised keeps its products).
    for (const t of (await listTagsForPin(supabase, data.pinId)).map(toTagDto)) {
      if (!t.product) continue;
      preset.push({
        match: matchFromProductRow(t.product),
        productId: t.productId,
        pinterestProductPinId: t.pinterestProductPinId,
        category: t.category,
        label: t.detectedLabel,
      });
    }
    // Then what the creator tagged in the Pinterest app itself (official v5
    // product_tags, best-effort — unavailable reads as none).
    if (pin.pinterest_pin_id) {
      const remote = await readPinterestProductTags(userId, pin.pinterest_pin_id);
      for (const p of remote.products) {
        if (!p.link) continue;
        preset.push({
          match: {
            title: p.title || hostBrand(p.link),
            link: p.link,
            source: hostBrand(p.link),
            thumbnail: p.imageUrl,
            price: null,
          },
          productId: null,
          pinterestProductPinId: p.pinterestPinId,
          category: categoryOfTitle(p.title ?? ""),
          label: null,
        });
      }
    }

    try {
      return await buildPlan(pin.image_url, pin.title, pin.description ?? "", preset);
    } catch (e) {
      console.error("[planProductTags] pipeline failed", e);
      throw new Error("We couldn't scan this Pin right now. Try again in a moment.");
    }
  });

/** Push the tags that reference one of the creator's own Pinterest product
 * pins back to Pinterest. Everything else stays app-side by necessity. */
export const syncPinProductTagsToPinterest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { pinId: string }) => z.object({ pinId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await ownPin(supabase, userId, data.pinId);
    return pushTagsToPinterest(supabase, userId, data.pinId);
  });
