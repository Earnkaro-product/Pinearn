import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getServiceSupabase } from "@/integrations/supabase/service-client";
import type { Database, Json } from "@/integrations/supabase/types";
import { z } from "zod";
import {
  createPin as createPinterestPinRemote,
  getAccountAnalytics,
  getPinAnalytics,
  getTopPinsAnalytics,
  getUserAccount,
  listBoardPins,
  listBoards,
  PinterestAuthError,
  requireEnv,
} from "@/lib/pinterest-api";
import { withPinterestToken } from "@/lib/pinterest-oauth.functions";
import { isSupportedRetailerLink } from "@/lib/brands";
import { createLimiter } from "@/lib/concurrency-limiter";
import { logNet } from "@/lib/net-logger";
import { categoriesAgree, categoryOfTitle } from "@/lib/product-category";
import {
  detectImage,
  lensCropParam,
  verifyProductLook,
  widenBox,
  type Box,
  type LookVerdict,
  type ProductCategory,
} from "@/lib/vision-detect.server";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "board"
  );
}

// -------------------------------------------------------------
// Import real Pinterest boards + pins → Collections + Pins in the storefront.
// Idempotent: re-running only adds boards/pins not already synced, keyed on
// the real Pinterest board/pin id (see collections.pinterest_board_id and
// pins.pinterest_pin_id unique indexes).
// -------------------------------------------------------------

export const importPinterestBoards = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: storefront, error: sErr } = await supabase
      .from("storefronts")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!storefront) throw new Error("No storefront found for user");

    const boards = [...(await withPinterestToken(userId, (t) => listBoards(t)))].sort((a, b) => {
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at; // newest board first
    });

    let boardsCreated = 0;
    let pinsCreated = 0;

    const { data: existingCollections } = await supabase
      .from("collections")
      .select("id, pinterest_board_id")
      .eq("storefront_id", storefront.id)
      .not("pinterest_board_id", "is", null);
    const existingByBoardId = new Map(
      (existingCollections ?? []).map((c) => [c.pinterest_board_id as string, c.id]),
    );

    const { data: existingPositions } = await supabase
      .from("collections")
      .select("position")
      .eq("storefront_id", storefront.id)
      .order("position", { ascending: false })
      .limit(1);
    let nextPosition = (existingPositions?.[0]?.position ?? -1) + 1;

    // A Pinterest board is also a real board row, not just a collection: the
    // storefront's Boards tab (and the public page) read `boards`, so without
    // this every synced board — "mirror" and friends — was invisible there.
    const { data: existingBoardRows } = await supabase
      .from("boards")
      .select("id, pinterest_board_id")
      .eq("storefront_id", storefront.id)
      .not("pinterest_board_id", "is", null);
    const existingBoardByBoardId = new Map(
      (existingBoardRows ?? []).map((b) => [b.pinterest_board_id as string, b.id]),
    );

    const { data: existingBoardPositions } = await supabase
      .from("boards")
      .select("position")
      .eq("storefront_id", storefront.id)
      .order("position", { ascending: false })
      .limit(1);
    let nextBoardPosition = (existingBoardPositions?.[0]?.position ?? -1) + 1;

    // Board names can be emoji-only or otherwise collapse to the same slug
    // (e.g. "-🎵" and "_📝" both strip down to the "board" fallback) — track
    // every slug already used in this storefront and disambiguate collisions
    // with a numeric suffix, the same way the default-storefront trigger does.
    const { data: existingSlugRows } = await supabase
      .from("collections")
      .select("slug")
      .eq("storefront_id", storefront.id);
    const usedSlugs = new Set((existingSlugRows ?? []).map((c) => c.slug as string));

    function uniqueSlug(name: string): string {
      const base = slugify(name);
      if (!usedSlugs.has(base)) {
        usedSlugs.add(base);
        return base;
      }
      let n = 2;
      while (usedSlugs.has(`${base}-${n}`)) n++;
      const candidate = `${base}-${n}`;
      usedSlugs.add(candidate);
      return candidate;
    }

    const failedBoards: string[] = [];

    // `pins.pinterest_pin_id` is globally unique per user, but a pin can be
    // listed under a board it doesn't currently belong to in our DB (e.g. it
    // was detached by a reset, or moved into a per-pin collection when it went
    // live). Load every existing pin once, keyed by its Pinterest id, so we
    // can RE-HOME an already-synced pin into its board instead of trying to
    // insert a duplicate (which would fail the whole board's batch).
    const { data: allExistingPins } = await supabase
      .from("pins")
      .select("id, pinterest_pin_id, status, collection_id")
      .eq("user_id", userId)
      .not("pinterest_pin_id", "is", null);
    const existingPinByPinterestId = new Map(
      (allExistingPins ?? []).map((p) => [
        p.pinterest_pin_id as string,
        { status: p.status as string, collectionId: p.collection_id as string | null },
      ]),
    );
    let pinsRehomed = 0;

    for (const board of boards) {
      let collectionId = existingByBoardId.get(board.id);

      if (!collectionId) {
        const { data: coll, error: cErr } = await supabase
          .from("collections")
          .insert({
            user_id: userId,
            storefront_id: storefront.id,
            name: board.name,
            slug: uniqueSlug(board.name),
            description: board.description ?? null,
            source: "pinterest",
            pinterest_board_id: board.id,
            position: nextPosition++,
          })
          .select("id")
          .single();
        if (cErr) {
          // Don't let one bad board abort the whole sync — skip it and keep going.
          failedBoards.push(`${board.name || board.id}: ${cErr.message}`);
          continue;
        }
        collectionId = coll.id;
        boardsCreated++;
      }

      // Board row + membership, so the board shows up on the Boards tab with
      // its collection inside it. Keyed on pinterest_board_id, so re-running
      // the sync reuses the existing row rather than duplicating it.
      let boardRowId = existingBoardByBoardId.get(board.id);
      let boardRowIsNew = false;
      if (!boardRowId) {
        const { data: boardRow, error: bErr } = await supabase
          .from("boards")
          .insert({
            user_id: userId,
            storefront_id: storefront.id,
            name: board.name,
            source: "pinterest",
            pinterest_board_id: board.id,
            position: nextBoardPosition++,
          })
          .select("id")
          .single();
        if (bErr) {
          failedBoards.push(`${board.name || board.id} (board): ${bErr.message}`);
        } else {
          boardRowId = boardRow.id;
          boardRowIsNew = true;
          existingBoardByBoardId.set(board.id, boardRow.id);
        }
      }
      if (boardRowId) {
        await supabase
          .from("board_collections")
          .upsert(
            { board_id: boardRowId, collection_id: collectionId, user_id: userId, position: 0 },
            { onConflict: "board_id,collection_id" },
          );
      }

      const pins = await withPinterestToken(userId, (t) => listBoardPins(t, board.id));
      if (pins.length === 0) continue;

      // This is a creator app — only sync pins the user actually authored,
      // never pins they saved/repinned from someone else's content.
      const ownerPins = pins.filter((p) => p.isOwner);

      // Cover for a just-created board: its newest pin's image, so the Boards
      // tab isn't a wall of blank cards before anything is monetised. Only on
      // creation — a cover the user picked later is never overwritten.
      if (boardRowIsNew && boardRowId) {
        const cover = ownerPins.find((p) => p.imageUrl)?.imageUrl;
        if (cover)
          await supabase.from("boards").update({ cover_image_url: cover }).eq("id", boardRowId);
      }

      // Insert pins we've never seen; re-home pins that already exist but sit
      // in a different (or no) collection — unless they're already live, in
      // which case they stay in their monetized collection untouched.
      const newPinRows: Array<Database["public"]["Tables"]["pins"]["Insert"]> = [];
      const rehomePinterestIds: string[] = [];
      for (const p of ownerPins) {
        const existing = existingPinByPinterestId.get(p.id);
        if (!existing) {
          newPinRows.push({
            user_id: userId,
            storefront_id: storefront.id,
            collection_id: collectionId,
            title: p.title || "Untitled pin",
            description: p.description,
            image_url: p.imageUrl,
            external_url: p.link,
            source: "pinterest",
            // "new" = untouched, fresh from Pinterest sync. "draft" is reserved
            // for pins where the user actually started attaching a product and
            // left it unfinished — see PinDetailDialog in pins.tsx.
            status: "new",
            pinterest_pin_id: p.id,
            is_owner: true,
            // Preserve the pin's real Pinterest creation time so the pins list
            // (sorted by created_at) reflects actual posting order, not sync order.
            ...(p.createdAt ? { created_at: p.createdAt } : {}),
          });
          // Record it so the same pin listed under another board isn't
          // inserted twice in this run.
          existingPinByPinterestId.set(p.id, { status: "new", collectionId });
        } else if (existing.status !== "live" && existing.collectionId !== collectionId) {
          rehomePinterestIds.push(p.id);
          existing.collectionId = collectionId;
        }
      }

      if (newPinRows.length > 0) {
        const { error: pErr } = await supabase.from("pins").insert(newPinRows);
        if (pErr) {
          failedBoards.push(`${board.name || board.id} (pins): ${pErr.message}`);
          continue;
        }
        pinsCreated += newPinRows.length;
      }

      if (rehomePinterestIds.length > 0) {
        const { error: rhErr } = await supabase
          .from("pins")
          .update({ collection_id: collectionId, storefront_id: storefront.id, is_owner: true })
          .eq("user_id", userId)
          .in("pinterest_pin_id", rehomePinterestIds);
        if (rhErr) {
          failedBoards.push(`${board.name || board.id} (re-home): ${rhErr.message}`);
          continue;
        }
        pinsRehomed += rehomePinterestIds.length;
      }
    }

    if (failedBoards.length > 0) {
      console.error("[importPinterestBoards] skipped boards:", failedBoards);
    }

    // Report inserted + re-homed together as "pins synced" — after a reset
    // most pins already exist and are re-homed rather than freshly inserted,
    // and the user just wants to see that every pin landed under its board.
    return {
      boardsCreated,
      pinsCreated: pinsCreated + pinsRehomed,
      pinsRehomed,
      skipped: failedBoards.length,
    };
  });

// -------------------------------------------------------------
// Publish a real Pin to one of the user's synced Pinterest boards.
// -------------------------------------------------------------

export const createPinterestPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: {
      collectionId: string;
      title: string;
      description?: string;
      imageUrl: string;
      link?: string;
      productId?: string;
    }) =>
      z
        .object({
          collectionId: z.string().uuid(),
          title: z.string().min(1).max(100),
          description: z.string().max(500).optional(),
          imageUrl: z.string().url(),
          link: z.string().url().optional(),
          productId: z.string().uuid().optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: collection, error: cErr } = await supabase
      .from("collections")
      .select("id, storefront_id, pinterest_board_id")
      .eq("id", data.collectionId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!collection?.pinterest_board_id) {
      throw new Error("Pick a board that's synced from Pinterest first.");
    }

    const pin = await withPinterestToken(userId, (accessToken) =>
      createPinterestPinRemote(accessToken, {
        boardId: collection.pinterest_board_id!,
        title: data.title,
        description: data.description,
        link: data.link,
        imageUrl: data.imageUrl,
      }),
    );

    const { data: inserted, error: pErr } = await supabase
      .from("pins")
      .insert({
        user_id: userId,
        storefront_id: collection.storefront_id,
        collection_id: collection.id,
        product_id: data.productId ?? null,
        title: data.title,
        description: data.description || null,
        image_url: data.imageUrl,
        external_url: data.link || null,
        source: "pinterest",
        status: "live",
        pinterest_pin_id: pin.id,
      })
      .select("id")
      .single();
    if (pErr) throw new Error(pErr.message);

    return { id: inserted.id, pinterestPinId: pin.id };
  });

// -------------------------------------------------------------
// Refresh real impressions/clicks for already-published pins.
//
// Pinterest's per-pin analytics endpoint is rate-limited hard (confirmed: a
// burst of ~40 concurrent requests immediately gets 429 "You have exceeded
// your rate limit"). So this runs fully sequential with a pause between
// calls and a single retry-with-backoff on 429, and only processes a bounded
// batch per invocation (oldest-synced pins first) — call it again to work
// through the rest instead of trying to do all pins in one shot.
// -------------------------------------------------------------

const SYNC_BATCH_SIZE = 40;
const SYNC_DELAY_MS = 350;

export const syncPinterestAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { count: totalCount } = await supabase
      .from("pins")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_owner", true)
      .not("pinterest_pin_id", "is", null);

    const { data: pins, error } = await supabase
      .from("pins")
      .select("id, pinterest_pin_id")
      .eq("user_id", userId)
      .eq("is_owner", true)
      .not("pinterest_pin_id", "is", null)
      .order("updated_at", { ascending: true }) // least-recently-synced first
      .limit(SYNC_BATCH_SIZE);
    if (error) throw new Error(error.message);

    let updated = 0;
    for (const p of pins ?? []) {
      let stats = await withPinterestToken(userId, (t) =>
        getPinAnalytics(t, p.pinterest_pin_id as string),
      );
      if (stats.impressions === 0 && stats.pinClicks === 0) {
        // Could be a genuine zero or a swallowed 429 — a short backoff and
        // one retry disambiguates without risking another burst.
        await sleep(1500);
        stats = await withPinterestToken(userId, (t) =>
          getPinAnalytics(t, p.pinterest_pin_id as string),
        );
      }
      const { error: updErr } = await supabase
        .from("pins")
        .update({ impressions: stats.impressions, clicks: stats.pinClicks })
        .eq("id", p.id);
      if (!updErr) updated++;
      await sleep(SYNC_DELAY_MS);
    }

    return { updated, remaining: Math.max((totalCount ?? 0) - updated, 0) };
  });

// -------------------------------------------------------------
// Real Pinterest traffic analytics for the Analytics page. Every number here
// comes straight from Pinterest (account totals + Impressions/Pin clicks/
// Outbound clicks/Saves/Engagement) or from our own `pins`/`storefront_products`
// tables (which products are actually attached). There is no orders/sales/
// commission data anywhere in Pinterest's API — the Analytics page zeroes
// that out itself rather than this endpoint faking it.
//
// Per-pin numbers come from our own `pins.impressions`/`pins.clicks` columns
// (kept fresh by syncPinterestAnalytics, see above) rather than a live call
// per pin — Pinterest's per-pin analytics endpoint rate-limits hard, so
// fetching every pin live on every page load isn't viable. The one live call
// here (getTopPinsAnalytics) is a single request that overlays fresher
// numbers for whichever pins Pinterest currently considers "trending".
// -------------------------------------------------------------

const ANALYTICS_RANGES = ["7d", "30d", "90d", "12mo"] as const;
// Pinterest's analytics endpoints reject any start_date older than 90 days,
// so "12mo" just requests the max allowed window under the hood.
const ANALYTICS_RANGE_DAYS: Record<(typeof ANALYTICS_RANGES)[number], number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "12mo": 90,
};

export const getPinterestAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { range: "7d" | "30d" | "90d" | "12mo" }) =>
    z.object({ range: z.enum(ANALYTICS_RANGES) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - ANALYTICS_RANGE_DAYS[data.range] * 86400000);

    // Each live Pinterest call is independent of the others and of our own
    // synced pin data below — a rate-limit or blip on any one of them
    // shouldn't blank out the whole analytics page when the rest (including
    // our own DB-backed impressions/clicks) is perfectly fine to show.
    //
    // A PinterestAuthError is the one exception: withPinterestToken has
    // already force-refreshed and retried by the time it surfaces, so the
    // connection is genuinely dead — every call would zero out. Rethrow it
    // so the user sees "reconnect Pinterest" instead of a page of silent
    // zeros. The three concurrent refresh attempts coalesce into one real
    // refresh call (see refreshInFlight in pinterest-oauth.functions.ts).
    const [account, overview, topPins, { data: ourPins }] = await Promise.all([
      withPinterestToken(userId, (t) => getUserAccount(t)).catch((e) => {
        if (e instanceof PinterestAuthError) throw e;
        console.error("[getPinterestAnalytics] getUserAccount failed", e);
        return {
          username: null,
          accountId: null,
          pinCount: 0,
          boardCount: 0,
          followerCount: 0,
          followingCount: 0,
          monthlyViews: 0,
        };
      }),
      withPinterestToken(userId, (t) => getAccountAnalytics(t, { startDate, endDate })).catch(
        (e) => {
          if (e instanceof PinterestAuthError) throw e;
          console.error("[getPinterestAnalytics] getAccountAnalytics failed", e);
          return { impressions: 0, pinClicks: 0, outboundClicks: 0, saves: 0, engagement: 0 };
        },
      ),
      withPinterestToken(userId, (t) => getTopPinsAnalytics(t, { startDate, endDate })).catch(
        (e) => {
          if (e instanceof PinterestAuthError) throw e;
          console.error("[getPinterestAnalytics] getTopPinsAnalytics failed", e);
          return [] as Awaited<ReturnType<typeof getTopPinsAnalytics>>;
        },
      ),
      supabase
        .from("pins")
        .select("id, title, image_url, product_id, pinterest_pin_id, impressions, clicks")
        .eq("user_id", userId)
        .eq("status", "live") // only live pins (real product attached, Go Live hit) belong in pin analytics
        .eq("is_owner", true)
        .not("pinterest_pin_id", "is", null),
    ]);
    const topByPinterestId = new Map(topPins.map((p) => [p.pinId, p]));

    type AnalyticsProduct = {
      id: string;
      title: string;
      image_url: string | null;
      affiliate_url: string;
    };
    const livePinIds = (ourPins ?? []).map((p) => p.id);

    // Every product attached to each live pin (new routing tags products with
    // `pin_id`), so the pin breakdown shows all of a pin's products, not just
    // the one `pins.product_id` pointer.
    const productsByPin = new Map<string, AnalyticsProduct[]>();
    if (livePinIds.length) {
      const { data: tagged } = await supabase
        .from("storefront_products")
        .select("id, title, image_url, affiliate_url, pin_id")
        .in("pin_id", livePinIds);
      for (const pr of tagged ?? []) {
        if (!pr.pin_id) continue;
        const arr = productsByPin.get(pr.pin_id) ?? [];
        arr.push({
          id: pr.id,
          title: pr.title,
          image_url: pr.image_url,
          affiliate_url: pr.affiliate_url,
        });
        productsByPin.set(pr.pin_id, arr);
      }
    }

    // Legacy fallback: pins monetized before products were tagged with pin_id
    // still carry a single `product_id` — surface that so their breakdown
    // isn't suddenly empty.
    const legacyIds = (ourPins ?? [])
      .filter((p) => p.product_id && !productsByPin.get(p.id)?.length)
      .map((p) => p.product_id as string);
    if (legacyIds.length) {
      const { data: legacy } = await supabase
        .from("storefront_products")
        .select("id, title, image_url, affiliate_url")
        .in("id", legacyIds);
      const byId = new Map((legacy ?? []).map((p) => [p.id, p]));
      for (const p of ourPins ?? []) {
        if (p.product_id && !productsByPin.get(p.id)?.length) {
          const pr = byId.get(p.product_id);
          if (pr) productsByPin.set(p.id, [pr]);
        }
      }
    }

    const pins = (ourPins ?? []).map((p) => {
      // Prefer Pinterest's live "top pins" number when this pin is trending
      // right now; otherwise fall back to our last synced snapshot.
      const top = topByPinterestId.get(p.pinterest_pin_id as string);
      const products = productsByPin.get(p.id) ?? [];
      return {
        id: p.id,
        title: p.title,
        imageUrl: p.image_url,
        impressions: top?.impressions ?? p.impressions ?? 0,
        clicks: top?.pinClicks ?? p.clicks ?? 0,
        // First attached product — kept for callers that show a single brand
        // label per pin; `products` carries the full set.
        product: products[0] ?? null,
        products,
      };
    });

    return { account, overview, pins };
  });

// -------------------------------------------------------------
// Visual search pipeline: Pinterest image URL → Google Lens (SearchAPI) →
// normalize URLs → filter to supported retailers → rank → deduplicate →
// top 8 → CK cache lookup → CK Product Details. Each stage below is an
// independent, single-purpose function; `searchByImageRaw` just composes
// them in order. The external contract (exported types/functions) is
// unchanged — every caller keeps working exactly as before.
// -------------------------------------------------------------

export type VisualMatch = {
  title: string;
  link: string;
  source: string;
  thumbnail: string | null;
  price: { value: string; extractedValue: number; currency: string } | null;
  // Real MRP from the retailer's own product page (CK Product Details API),
  // once the match has been validated — see fetchCkProductDetails below.
  mrp: number | null;
  // True when CK never confirmed this listing and the price shown is Google
  // Lens's own snapshot instead of the retailer's live page.
  //
  // Keeping the match is right — a real, attachable listing shouldn't vanish
  // because a pricing service is down — but presenting it identically to a
  // verified one is not. When the product-details host is unreachable (it
  // answers nginx 502s for every URL), EVERY match arrives this way: stale
  // price, no MRP, unknown stock. The flag is what lets the UI say so instead
  // of showing an unchecked number as though it were confirmed.
  priceUnverified?: boolean;
};

// A visual-search hit before CK has confirmed it — real title/link/thumbnail/
// source (already retailer-filtered, ranked, deduped), plus whatever price
// Google Lens itself reported for the listing. This is what the UI renders
// *immediately* (progressive rendering): the card paints with everything
// already known — including the Lens price so it never looks empty — and CK
// upgrades that price/stock to the live retailer figure once it resolves for
// that one URL, independent of every other card. When CK can't resolve at
// all, this `price` is the fallback the card keeps showing instead of a dead
// "Not available" state.
export type RawVisualMatch = {
  title: string;
  link: string;
  source: string;
  thumbnail: string | null;
  price: { value: string; extractedValue: number; currency: string } | null;
  // The object-detection component this match belongs to (e.g. "Bag",
  // "Sunglasses"), used to group products into tabs. Absent only when the
  // detector found nothing to buy in the image and the search fell back to the
  // whole frame.
  tag?: string;
  // The look gate's verdict for this card: "same" (this product, or the same
  // design in the same colourway) or "close" (visibly similar, not exact).
  // Absent when the verifier had no usable verdict. "same" cards always rank
  // ahead of "close" cards within a tab; a UI can additionally badge the
  // difference so a close match is never presented as the exact product.
  lookMatch?: "same" | "close";
  // Rank within its component, lower being better. Present so a client
  // assembling several components as they stream in can resolve a product that
  // qualified for two tabs on merit rather than on arrival order — the same
  // rule the batch path applies server-side.
  score?: number;
};

// `null` = CK couldn't resolve any usable price data at all (dead link, bad
// response) — genuinely unusable, never shown as pickable. A resolved result
// with `available: false` means CK found real price/MRP but the retailer
// currently reports it out of stock — still worth showing (it may restock),
// just never auto-attached silently the way a confirmed-available match is.
export type CkResult = { mrp: number; discountedPrice: number; available: boolean } | null;

// Process-wide (not per-call) concurrency caps for outbound third-party HTTP
// calls, shared across every request this server handles. A per-call
// worker-pool alone only bounds fan-out *within* one call — if several
// server functions run concurrently (e.g. the board bulk "Approve all" flow)
// each spinning up its own capped loop still multiplies out to N × cap real
// connections. These module-level limiters are the actual ceiling.
// Raised with CROP_MAX: a six-component pin renders up to 60 cards, each of
// which fires its own CK lookup the moment it paints. At six in flight the
// queue behind a busy pin was deep enough that the last cards' prices arrived
// a full round trip late, which reads as a card that never finished loading.
const CK_CONCURRENCY = 8;
// One pin now fans out to as many as THIRTEEN Lens calls (six crops, up to six
// speculative widened regions, plus the whole image) and they are all issued at
// once. Sized above that so a single pin cannot fill the limiter and push the
// next user's search behind a full round trip — the failure this cap exists to
// prevent. Lens itself is the slow part (~8-14s), so a queued call is not a
// small delay; it is the whole latency of the stage, twice.
const LENS_CONCURRENCY = 16;
const ckLimit = createLimiter(CK_CONCURRENCY);
const lensLimit = createLimiter(LENS_CONCURRENCY);

// Google Lens genuinely takes ~13–15s for a real result — a tight 7s budget
// timed the first attempt out *before it could succeed*, then a retry ran the
// exact same query a second time and landed at ~13s: ~20s wall-clock and a
// duplicate upstream call even when the product WAS found. One generous
// attempt covers the real latency, so a found result returns on the first try
// with no retry, and a genuine hang stops after a single attempt (see
// LENS_TIMEOUT_MAX_RETRIES = 0 at the call site) instead of doubling the wait.
const LENS_TIMEOUT_MS = 16_000;
// CK product-page scrapes commonly take ~5–7s; a 5s budget timed the slow ones
// out just before they'd have succeeded, then re-ran the identical scrape (a
// duplicate ~10s round trip for one card). 8s covers the real latency so a
// resolvable product lands on the first attempt, and a genuinely dead link
// fails once and falls back to the Lens price (see CK call site: it also uses
// timeoutMaxRetries 0 — re-scraping an unresolvable URL never helps).
const CK_TIMEOUT_MS = 8_000;
// Exponential backoff sequence for a retried attempt — attempt 2 waits
// RETRY_BACKOFFS_MS[0], and so on.
//
// The old sequence was [250, 500], which spent its whole budget inside ~1.2s.
// That is shorter than the failures it exists for: a gateway restarting a worker
// (the nginx 502s from the product-details host) is out for seconds, not
// milliseconds, so every request in that window gave up and silently fell back
// to unverified data. Reaching ~4s gives a brief outage a real chance to clear
// while still failing fast enough for an interactive request.
const RETRY_BACKOFFS_MS = [400, 1200, 2500];
// Full jitter on top of the base delay. Without it, a batch of six product
// lookups that all 502 together retries in perfect lockstep — six simultaneous
// requests landing on a service that is already struggling, three times over.
// Spreading them across the interval is what turns a thundering herd back into
// ordinary traffic.
function backoffWithJitter(attempt: number): number {
  const base = RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)];
  return Math.round(base * (0.5 + Math.random() * 0.5));
}
// Default timeout-retry budget (CK still uses this): one retry, since a fast
// service that times out under its budget is usually a transient blip worth a
// single re-try. LENS overrides this to 0 — its budget is now wide enough that
// a timeout means a genuine hang, and re-running a 16s query is pure waste.
// A transient 429/502/503/504 gets up to three retries — with the backoffs
// above that spans ~4s of outage, enough to ride out a gateway blip.
const TIMEOUT_MAX_RETRIES = 1;
const RETRYABLE_STATUS_MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

// -------------------------------------------------------------
// Circuit breaker — stop retrying a service that is DOWN, as opposed to one
// that hiccupped.
//
// Retries are sized for a blip: a few hundred ms of gateway trouble, worth
// waiting out. They are exactly the wrong response to a sustained outage, where
// every attempt is guaranteed to fail — a batch of six product lookups against a
// host returning nginx 502s turns into 24 doomed requests and a wall of retry
// logs, which is what "the 502s have increased" looks like from the outside.
//
// After OPEN_AFTER consecutive retryable failures on a label, the breaker opens:
// subsequent calls fail immediately (still gracefully — callers already treat a
// throw as "no result") for COOLDOWN_MS, and one line is logged instead of
// dozens. The first call after the cooldown is a probe; if it succeeds the
// breaker closes and normal retrying resumes.
// -------------------------------------------------------------
const BREAKER_OPEN_AFTER = 4;
const BREAKER_COOLDOWN_MS = 60_000;

type BreakerState = { failures: number; openedAt: number | null };
const breakers = new Map<string, BreakerState>();

function breakerFor(label: string): BreakerState {
  let s = breakers.get(label);
  if (!s) {
    s = { failures: 0, openedAt: null };
    breakers.set(label, s);
  }
  return s;
}

/** True while the label is being given a rest. */
function breakerIsOpen(label: string): boolean {
  const s = breakerFor(label);
  if (s.openedAt == null) return false;
  if (Date.now() - s.openedAt < BREAKER_COOLDOWN_MS) return true;
  // Cooldown elapsed — let exactly one request through to test the water.
  s.openedAt = null;
  s.failures = 0;
  logNet(`${label}.breaker`, { outcome: "half_open" });
  return false;
}

function breakerRecordFailure(label: string): void {
  const s = breakerFor(label);
  s.failures++;
  if (s.openedAt == null && s.failures >= BREAKER_OPEN_AFTER) {
    s.openedAt = Date.now();
    logNet(`${label}.breaker`, {
      outcome: "open",
      afterFailures: s.failures,
      cooldownMs: BREAKER_COOLDOWN_MS,
    });
  }
}

function breakerRecordSuccess(label: string): void {
  const s = breakerFor(label);
  if (s.openedAt != null || s.failures > 0) logNet(`${label}.breaker`, { outcome: "closed" });
  s.failures = 0;
  s.openedAt = null;
}

// Thrown when the breaker is open — the request was never sent. Callers already
// collapse a throw into their graceful "no result" path, so an open breaker
// degrades exactly like a failed lookup, just instantly and quietly.
class ServiceDownError extends Error {
  constructor(label: string) {
    super(`${label} is unavailable (circuit breaker open)`);
    this.name = "ServiceDownError";
  }
}

// Thrown when `withRetry`'s own AbortController fires. EXPECTED behavior
// (the timeout doing its job), never a bug — callers catch this specifically
// to return a graceful fallback without re-logging it as an error.
class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

// Thrown only for the exact HTTP statuses worth retrying (429/502/503/504).
// Every other non-ok status (404, 400, other 5xx) is a terminal, non-retried
// outcome handled at the call site — this class existing at all is what lets
// `withRetry` tell "worth retrying" apart from "genuinely done".
class RetryableHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`retryable HTTP ${status}`);
    this.name = "RetryableHttpError";
    this.status = status;
  }
}

// Generic bounded-retry wrapper for a single outbound fetch attempt. Applies
// an AbortController timeout; retries ONLY a timeout or a `RetryableHttpError`
// (429/502/503/504), with exponential backoff. Any other thrown error, or a
// normal return value (including a caller-decided "no result" for a 404 or
// unresolvable response), is never retried — `fn` should return normally for
// those, not throw, so they resolve immediately.
async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: {
    timeoutMs: number;
    label: string;
    // Per-call override for how many times a timeout is retried. Defaults to
    // TIMEOUT_MAX_RETRIES; LENS passes 0 so a hung 16s query is never re-run.
    timeoutMaxRetries?: number;
  },
): Promise<T> {
  const { timeoutMs, label, timeoutMaxRetries = TIMEOUT_MAX_RETRIES } = opts;
  const overallStart = Date.now();

  // Don't queue work for a service that just told us, repeatedly, that it's down.
  if (breakerIsOpen(label)) throw new ServiceDownError(label);

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      breakerRecordSuccess(label);
      logNet(`${label}.request`, {
        outcome: "success",
        attempt: attempt + 1,
        durationMs: Date.now() - overallStart,
      });
      return result;
    } catch (e) {
      clearTimeout(timer);
      const isTimeout = e instanceof Error && e.name === "AbortError";
      const isRetryableHttp = e instanceof RetryableHttpError;
      const maxRetries = isTimeout
        ? timeoutMaxRetries
        : isRetryableHttp
          ? RETRYABLE_STATUS_MAX_RETRIES
          : 0;

      if (attempt >= maxRetries) {
        // Only a retryable failure counts toward the breaker. A 404 or a bad
        // request says the URL is wrong, not that the service is down.
        if (isTimeout || isRetryableHttp) breakerRecordFailure(label);
        if (isTimeout) {
          logNet(`${label}.request`, {
            outcome: "timeout",
            attempt: attempt + 1,
            timeoutMs,
            durationMs: Date.now() - overallStart,
          });
          throw new TimeoutError(label, timeoutMs);
        }
        logNet(`${label}.request`, {
          outcome: "error",
          attempt: attempt + 1,
          reason: isRetryableHttp ? `http_${e.status}` : describeFetchFailure(e),
          durationMs: Date.now() - overallStart,
        });
        throw e;
      }

      // A service already known to be failing gets its remaining retries
      // cancelled mid-flight: once the breaker trips, continuing to walk the
      // backoff ladder is just more doomed requests.
      // Peeked, not tested via breakerIsOpen(): that helper resets state when a
      // cooldown elapses, and consuming the half-open probe here would waste it.
      if ((isTimeout || isRetryableHttp) && breakerFor(label).openedAt != null) {
        logNet(`${label}.request`, {
          outcome: "error",
          attempt: attempt + 1,
          reason: "breaker_open",
          durationMs: Date.now() - overallStart,
        });
        throw e;
      }

      const backoff = backoffWithJitter(attempt);
      logNet(`${label}.retry`, {
        attempt: attempt + 1,
        backoffMs: backoff,
        reason: isTimeout ? "timeout" : `http_${(e as RetryableHttpError).status}`,
      });
      await sleep(backoff);
    }
  }
}

// Node's fetch wraps the real DNS/network failure inside `cause` (e.g.
// { code: 'ENOTFOUND', hostname: '...' }) — surface that instead of a bare
// "TypeError: fetch failed" so failures are diagnosable from logs alone.
function describeFetchFailure(e: unknown): string {
  if (e instanceof Error && e.name === "AbortError") return "timed out";
  const cause =
    e instanceof Error ? (e.cause as { code?: string; hostname?: string } | undefined) : undefined;
  if (cause?.code === "ENOTFOUND") {
    return `DNS lookup failed for ${cause.hostname ?? "the configured host"} (ENOTFOUND)`;
  }
  if (cause?.code) return `network error (${cause.code})`;
  return e instanceof Error ? e.message : String(e);
}

// -------------------------------------------------------------
// STEP: Normalize / canonicalize a product URL — used both as the CK cache
// key and as the link shown, so two URLs that are really the same product
// (different tracking params, different ref codes) collapse to one entry
// and are never scraped twice.
// -------------------------------------------------------------

const TRACKING_PARAM_PATTERNS = [
  /^utm_/i,
  /^ref/i, // Flipkart/Amazon "ref"/"ref_src"/"refRID" style params
  /^gclid$/i,
  /^fbclid$/i,
  /^_encoding$/i,
  /^psc$/i,
  /^spm$/i,
  /^pf_rd_/i,
  /^pd_rd_/i,
  /^linkCode$/i,
  /^camp$/i,
  /^creative$/i,
];

function canonicalizeProductUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return rawUrl.trim().toLowerCase();
  }
  u.hash = "";
  const hostname = u.hostname.toLowerCase().replace(/^www\./, "");

  // Amazon's real product identity is the ASIN in /dp/{ASIN} — the SEO
  // title slug and every tracking param around it are noise for both
  // dedup and CK, so truncate straight to the canonical product page.
  if (hostname === "amazon.in" || hostname.endsWith(".amazon.in")) {
    const asin = u.pathname.match(/\/dp\/([A-Za-z0-9]{10})/);
    if (asin) return `https://${hostname}/dp/${asin[1].toUpperCase()}`;
  }

  for (const key of Array.from(u.searchParams.keys())) {
    if (TRACKING_PARAM_PATTERNS.some((p) => p.test(key))) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  const path = u.pathname.replace(/\/+$/, "");
  const query = u.searchParams.toString();
  return `https://${hostname}${path}${query ? `?${query}` : ""}`;
}

// Short-lived cache + in-flight de-dup for CK lookups, keyed by the
// canonical product URL. CK is confirmed one-URL-per-request (no batching)
// and its own scrape is the dominant cost in this pipeline, so a cache hit
// skips CK entirely. Price/stock isn't a sub-daily-changing fact for most of
// these retailers, so a 24h TTL on a confirmed result is safe. Failures get
// a much shorter TTL so a transient CK hiccup doesn't block retries all day.
const CK_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const CK_FAILURE_TTL_MS = 60 * 1000;
const ckCache = new Map<string, { expires: number; result: CkResult }>();
const ckInFlight = new Map<string, Promise<CkResult>>();

async function fetchCkProductDetails(productUrl: string): Promise<CkResult> {
  const key = canonicalizeProductUrl(productUrl);
  const cached = ckCache.get(key);
  if (cached && cached.expires > Date.now()) {
    logNet("CK", { url: key, outcome: "cache_hit" });
    return cached.result;
  }

  // Only the caller that actually creates the in-flight entry attaches the
  // cache-fill/cleanup chain below — later concurrent callers just get the
  // same shared promise back, so the cache is always populated before the
  // entry is removed (no gap where a new request could slip through).
  const existing = ckInFlight.get(key);
  if (existing) {
    logNet("CK", { url: key, outcome: "dedup_suppressed" });
    return existing;
  }

  const startedAt = Date.now();
  const promise = ckLimit(() => fetchCkProductDetailsLive(productUrl))
    .then((result) => {
      ckCache.set(key, {
        expires: Date.now() + (result ? CK_SUCCESS_TTL_MS : CK_FAILURE_TTL_MS),
        result,
      });
      logNet("CK", {
        url: key,
        outcome: "cache_miss",
        durationMs: Date.now() - startedAt,
        resolved: !!result,
        active: ckLimit.activeCount(),
        queued: ckLimit.pendingCount(),
      });
      return result;
    })
    .finally(() => {
      ckInFlight.delete(key);
    });
  ckInFlight.set(key, promise);
  return promise;
}

// CK Product Details API — looks up a product URL directly on the retailer
// and returns its live MRP/price/stock. Never throws — every outcome
// (timeout, dead link, no price data, retailer error) collapses to `null` so
// one bad CK lookup can never fail the whole visual search; the caller marks
// that one card unavailable and moves on.
async function fetchCkProductDetailsLive(productUrl: string): Promise<CkResult> {
  const apiKey = requireEnv("CK_PRODUCT_API_KEY");
  const apiUrl =
    process.env.CK_PRODUCT_API_URL || "https://automation.ekarostats.com/fetchdata/product";

  try {
    return await withRetry(
      async (signal) => {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({ product_url: productUrl }),
          signal,
        });
        if (RETRYABLE_STATUSES.has(res.status)) throw new RetryableHttpError(res.status);
        if (!res.ok) {
          // 404 and every other non-retryable status (bad request, dead
          // link, unexpected 5xx) is terminal — "no result", never retried.
          logNet("CK", { url: productUrl, outcome: "http_error", status: res.status });
          return null;
        }

        const data = (await res.json()) as {
          status?: boolean;
          mrp?: number;
          discounted_price?: number;
          availability?: boolean;
          availability_status?: string;
        };
        if (!data.status || data.mrp == null || data.discounted_price == null) {
          logNet("CK", { url: productUrl, outcome: "no_price_data" });
          return null;
        }
        if (!data.availability) {
          // Real price data, just not purchasable right now — surface it
          // (the retailer may restock) rather than dropping it like a dead
          // link. Callers that auto-attach without human review filter this
          // out explicitly; interactive UI still shows it as pickable.
          return { mrp: data.mrp, discountedPrice: data.discounted_price, available: false };
        }
        return { mrp: data.mrp, discountedPrice: data.discounted_price, available: true };
      },
      { timeoutMs: CK_TIMEOUT_MS, label: "CK", timeoutMaxRetries: 0 },
    );
  } catch (e) {
    void e;
    return null;
  }
}

// -------------------------------------------------------------
// STEP: Google Lens (via SearchAPI.io) — the sole discovery call. Pinterest's
// image URL is passed straight through as the `url` param (Google's own
// crawler fetches it; we never download/re-upload the image ourselves,
// which is one fewer network hop than the old provider needed).
// `search_type=products` is purpose-built for shopping results — never
// `search_type=all`, which mixes in unrelated web/image results.
// -------------------------------------------------------------

type LensApiItem = {
  position?: number;
  title?: string;
  link?: string;
  source?: string;
  thumbnail?: string;
  image?: { link?: string };
  stock_information?: string;
  // Lens returns price either as a structured object or (older responses) a
  // bare display string — parseLensPrice handles both shapes.
  price?: { value?: string; extracted_value?: number; currency?: string } | string;
  extracted_price?: number;
};

type ParsedPrice = { value: string; extractedValue: number; currency: string };

// Best-effort parse of the price Google Lens attached to a shopping result
// into the same shape a CK price uses. Returns null when Lens gave nothing
// usable (many organic visual matches carry no price) — the card then simply
// waits for CK, or shows no price if CK also can't resolve. Never throws.
function parseLensPrice(item: LensApiItem): ParsedPrice | null {
  const raw = item.price;
  const currencyFrom = (s: string) => {
    const sym = s.match(/[₹$€£]/)?.[0];
    if (sym) return sym;
    if (/\bINR\b|\bRs\.?/i.test(s)) return "₹";
    return "₹";
  };
  const numberFrom = (s: string): number | null => {
    const digits = s.replace(/[^0-9.]/g, "");
    if (!digits) return null;
    const n = Number.parseFloat(digits);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  if (raw && typeof raw === "object") {
    const extracted =
      typeof raw.extracted_value === "number" && raw.extracted_value > 0
        ? raw.extracted_value
        : raw.value
          ? numberFrom(raw.value)
          : null;
    if (extracted == null) return null;
    const currency = raw.currency || (raw.value ? currencyFrom(raw.value) : "₹");
    return {
      value: raw.value || `${currency}${extracted.toLocaleString("en-IN")}`,
      extractedValue: extracted,
      currency,
    };
  }

  if (typeof item.extracted_price === "number" && item.extracted_price > 0) {
    return {
      value: `₹${item.extracted_price.toLocaleString("en-IN")}`,
      extractedValue: item.extracted_price,
      currency: "₹",
    };
  }

  if (typeof raw === "string" && raw.trim()) {
    const extracted = numberFrom(raw);
    if (extracted == null) return null;
    return { value: raw.trim(), extractedValue: extracted, currency: currencyFrom(raw) };
  }

  return null;
}

// Internal, ranking-ready shape — a superset of the public `RawVisualMatch`.
// `position` and `inStockHint` exist only to rank/tiebreak candidates before
// the top-8 cut; neither is ever shown to the user or sent to CK.
type LensMatch = {
  title: string;
  link: string;
  source: string;
  thumbnail: string | null;
  price: ParsedPrice | null;
  position: number;
  inStockHint: boolean;
};

function toLensMatch(item: LensApiItem, index: number): LensMatch {
  return {
    title: item.title!,
    link: item.link!,
    source: item.source ?? "Store",
    // The retailer's own image, not Lens's gstatic thumbnail. The tbn tokens
    // Lens hands out expire within minutes — measured 404 on a token from a
    // response fetched moments earlier — which broke card images AND blinded
    // the look gate. The retailer CDN URL is durable and higher-resolution.
    thumbnail: item.image?.link ?? item.thumbnail ?? null,
    price: parseLensPrice(item),
    position: item.position ?? index + 1,
    inStockHint: !/out of stock/i.test(item.stock_information ?? ""),
  };
}

// Short-lived cache + in-flight de-dup for the Google Lens reverse-image
// search, keyed by the pin's image URL plus the crop region (null crop =
// whole image; a near-full-frame box never produces a crop, so it lands on
// the whole-image entry — see lensCropParam). Lens is BOTH the slowest single
// call in the pipeline AND non-deterministic — the same image returns a
// different set (and count) of visual matches on every call, which is exactly
// why a pin re-scanned moments later showed different products and a
// different final count. Caching the raw match list makes a given image
// resolve to ONE stable set: re-opening/re-scanning a pin returns the
// identical products instantly with no second API call. The downstream
// filter/rank/dedupe steps are deterministic, so a cache hit reproduces the
// same final result byte-for-byte. A found result is stable for hours; an
// empty result gets a short TTL so a transient Lens hiccup doesn't pin "no
// matches" for the rest of the day.
//
// There is deliberately NO text query (`q`) here. SearchAPI accepts one, and
// it measured badly on real pins: a generic steer ("shirt") dropped supported-
// retailer results from 47 to ZERO, and a descriptive one pulled text matches
// in the wrong colours. Visual-only search plus the look gate beats steering.
const LENS_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const LENS_EMPTY_TTL_MS = 2 * 60 * 1000;
/** Where a cached entry's results originally came from. Carried purely so the
 * funnel debug trace can say "this tab's products came off a week-old row"
 * rather than leaving someone guessing why a re-scan changed nothing. Never
 * read on the match path. */
type LensOrigin = "db" | "live";
const lensCache = new Map<string, { expires: number; matches: LensMatch[]; origin: LensOrigin }>();
const lensInFlight = new Map<string, Promise<LensMatch[]>>();

// ...and the same list again in Postgres, because the Map above is per-process
// and a deploy or a cold isolate throws away every search anyone has paid for.
// A row read costs ~50ms against a live search's ~8s, so the DB is checked
// before spending the call — and a hit means a re-opened pin, a second user on
// the same popular pin, or a board flow re-touching an image resolves at once
// instead of scanning again. Rows outlive the in-memory TTL deliberately: a
// stored list is not stale in any way that matters (the products it names
// don't change hour to hour), and re-running the search would return a
// DIFFERENT set, which is the instability this cache exists to remove.
const LENS_ROW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Both durable caches are optional: the tables ship as a migration
// (supabase/migrations/..._search_caches.sql) and the code has to run whether
// or not it has been applied. PostgREST answers PGRST205 for a table that
// isn't there — once seen, that cache switches itself off for the life of the
// process, so an unapplied migration costs ONE failed request rather than a
// pointless round trip in front of every search and every verdict. Without
// this the "cache" would be a latency tax on exactly the path it exists to
// speed up.
const cacheDisabled = new Set<string>();

function noteCacheError(table: string, error: { code?: string } | null): void {
  if (error?.code === "PGRST205" && !cacheDisabled.has(table)) {
    cacheDisabled.add(table);
    logNet("CACHE", { table, outcome: "table_missing_disabled" });
  }
}

/** Best-effort. A missing table (migration not applied), a slow read or a
 * rejected write all degrade to searching live, exactly as before — caching
 * must never be load-bearing. */
async function loadLensRow(imageUrl: string, crop: string): Promise<LensMatch[] | null> {
  if (cacheDisabled.has("lens_searches")) return null;
  try {
    const { data, error } = await getServiceSupabase()
      .from("lens_searches")
      .select("matches, searched_at")
      .eq("image_url", imageUrl)
      .eq("crop_region", crop)
      .maybeSingle();
    noteCacheError("lens_searches", error);
    if (error || !data || !Array.isArray(data.matches)) return null;
    if (Date.now() - new Date(data.searched_at).getTime() > LENS_ROW_TTL_MS) return null;
    return data.matches as unknown as LensMatch[];
  } catch {
    return null;
  }
}

async function saveLensRow(imageUrl: string, crop: string, matches: LensMatch[]): Promise<void> {
  // An empty result is not worth a row: it is usually a transient Lens hiccup,
  // and persisting it would pin "no matches" on the image for a week.
  if (matches.length === 0 || cacheDisabled.has("lens_searches")) return;
  try {
    const { error } = await getServiceSupabase()
      .from("lens_searches")
      .upsert(
        {
          image_url: imageUrl,
          crop_region: crop,
          matches: matches as unknown as Json,
          searched_at: new Date().toISOString(),
        },
        { onConflict: "image_url,crop_region" },
      );
    noteCacheError("lens_searches", error);
  } catch {
    /* best-effort */
  }
}

/** `crop` is a SearchAPI region string (`left;top;right;bottom`, 0–1) from
 * `lensCropParam`, or null to search the whole image. */
async function searchGoogleLens(imageUrl: string, crop: string | null = null) {
  const region = crop ?? "";
  const cacheKey = JSON.stringify([imageUrl, region]);
  const cached = lensCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    logNet("LENS", { outcome: "cache_hit", results: cached.matches.length });
    return cached.matches;
  }

  // Concurrent callers for the same image (e.g. the board prefetch window and
  // a swipe landing on the same pin) share one API call instead of racing two
  // non-deterministic scans that would disagree.
  const existing = lensInFlight.get(cacheKey);
  if (existing) {
    logNet("LENS", { outcome: "dedup_suppressed" });
    return existing;
  }

  // The DB lookup joins the in-flight map too, so a slow read never lets a
  // second caller start the live search behind it.
  const promise = (async () => {
    const stored = await loadLensRow(imageUrl, region);
    if (stored) {
      logNet("LENS", { outcome: "db_hit", results: stored.length });
      return { matches: stored, fresh: false };
    }
    return { matches: await searchGoogleLensLive(imageUrl, crop), fresh: true };
  })()
    .then(({ matches, fresh }) => {
      lensCache.set(cacheKey, {
        expires: Date.now() + (matches.length > 0 ? LENS_SUCCESS_TTL_MS : LENS_EMPTY_TTL_MS),
        matches,
        origin: fresh ? "live" : "db",
      });
      if (fresh) void saveLensRow(imageUrl, region, matches);
      return matches;
    })
    .finally(() => {
      lensInFlight.delete(cacheKey);
    });
  lensInFlight.set(cacheKey, promise);
  return promise;
}

async function searchGoogleLensLive(imageUrl: string, crop: string | null): Promise<LensMatch[]> {
  const apiKey = requireEnv("VISUAL_SEARCH_API_KEY");
  const baseUrl = process.env.VISUAL_SEARCH_API_URL || "https://www.searchapi.io/api/v1/search";

  const startedAt = Date.now();
  const data = await lensLimit(() =>
    withRetry(
      async (signal) => {
        const url = new URL(baseUrl);
        url.searchParams.set("engine", "google_lens");
        url.searchParams.set("search_type", "products");
        url.searchParams.set("country", "in");
        url.searchParams.set("hl", "en");
        url.searchParams.set("device", "mobile");
        url.searchParams.set("url", imageUrl);
        // Google fetches the ORIGINAL image and applies this region itself —
        // full resolution, no image proxy in the path (see lensCropParam).
        if (crop) url.searchParams.set("crop", crop);
        url.searchParams.set("api_key", apiKey);

        const res = await fetch(url.toString(), { signal });
        if (RETRYABLE_STATUSES.has(res.status)) throw new RetryableHttpError(res.status);
        if (!res.ok) {
          // Never log the response body here — it can echo back the request
          // URL (api_key included). Status + outcome is all a structured
          // log needs.
          logNet("LENS", { outcome: "http_error", status: res.status });
          return { visual_matches: [] as LensApiItem[] };
        }
        return (await res.json()) as { visual_matches?: LensApiItem[] };
      },
      { timeoutMs: LENS_TIMEOUT_MS, label: "LENS", timeoutMaxRetries: 0 },
    ),
  );

  const results = (data.visual_matches ?? []).filter((m) => m.title && m.link);
  logNet("LENS", {
    outcome: "completed",
    durationMs: Date.now() - startedAt,
    results: results.length,
    cropped: !!crop,
    active: lensLimit.activeCount(),
    queued: lensLimit.pendingCount(),
  });
  return results.map(toLensMatch);
}

// -------------------------------------------------------------
// STEP (pre-Lens): object detection → component crops.
//
// The vision model isolates each product in a busy pin (e.g. shoes + bag) so
// Lens can run on a crop instead of the whole scene, and tells us what CATEGORY
// each one is and what it LOOKS like. Detection is the OpenAI vision proxy
// (see vision-detect.server.ts); it returns bounding boxes, and each box
// travels to Lens as SearchAPI's `crop` parameter (normalised 0–1 corners) —
// nothing is downloaded, encoded, uploaded or proxied, and no pixel dimensions
// are ever needed, so the old "found objects but couldn't measure the frame"
// dead end no longer exists.
//
// Timing, which is the whole game here:
//
//   - Detection now takes ~6s and Lens ~14s, so detection is started BEFORE the
//     whole-image Lens call rather than after it. It used to be kicked off on
//     the line after `await searchGoogleLens(...)`, which meant crops didn't
//     even begin until the search they exist to improve had finished.
//   - A cached detection (see `detectImage`) resolves in ~100ms, so the request
//     waits a beat for it — long enough to take the crop path when the answer
//     is already known, never long enough to hold up a cold pin.
//   - As soon as crops are built, their Lens searches are prefetched in the
//     background. The client polls for the tagged view; by the time it asks,
//     the searches are cache hits instead of a fresh 14s wave.
//
// Every failure falls back to the whole image.
// -------------------------------------------------------------

// Master switch. Set VISION_DETECT_ENABLED=false to disable component search.
const DETECT_ENABLED = process.env.VISION_DETECT_ENABLED !== "false";
const DETECT_CONCURRENCY = 2;
const detectLimit = createLimiter(DETECT_CONCURRENCY);
// Cap crops per image → bounds Lens fan-out. Must not sit below the detector's
// own MAX_OBJECTS or the extra objects are detected, paid for, and then
// silently truncated here — which is exactly what a stale 4 was doing to a
// detector that had been raised to 6.
const CROP_MAX = 6;
const CROP_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const CROP_EMPTY_TTL_MS = 60 * 60 * 1000; // genuine "no products in image"
// Transient failures (502/504/timeout/fetch) — retry soon so we recover the
// moment the (flaky) vision service comes back, instead of blocking for an hour.
const CROP_ERROR_TTL_MS = 5 * 60 * 1000;
// Max products shown per detected component tag. Once every tag is full, the
// pipeline emits nothing more — this cap IS the hard stop.
const PER_TAG_MAX = 10;
// Max products in the whole-image fallback (no detection tags). Capping here
// means only this many cards render, so only this many CK price lookups ever
// fire — a hard stop so we never waste calls on a long tail.
const FULL_IMAGE_MAX = 10;

// `crop` is the SearchAPI region string for this object (see lensCropParam),
// or null when its box covered essentially the whole frame — that component
// searches the whole image and shares its Lens cache entry. `signature` is the
// object's look as detection saw it ("white leather low-top, gum sole"): the
// target the verify pass holds every candidate thumbnail against.
type Crop = {
  crop: string | null;
  label: string;
  category: ProductCategory;
  signature: string;
  /** The normalised box, kept so a starved component can re-search a widened
   * region (see the widen retry in searchComponent). */
  box: Box;
};
type CropResult = { crops: Crop[]; noProducts: boolean };

// imageUrl -> crops (region + label + category + signature) plus whether an
// empty result means the detector literally found no products. Empty for any
// other reason must not trigger the whole-image Lens fallback.
const cropCache = new Map<string, { expires: number; result: CropResult }>();
const cropInFlight = new Map<string, Promise<CropResult>>();

// Turn a raw detector label ("shirt t - shirt", "shoes sneakers") into a clean,
// human tab title ("Shirt T Shirt"). Empty/unknown → "Product".
function normalizeLabel(raw?: string): string {
  const s = (raw ?? "")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "Product";
  return s
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Cached crops for this image, or undefined if detection hasn't run yet.
function getCrops(imageUrl: string): CropResult | undefined {
  const c = cropCache.get(imageUrl);
  if (c && c.expires > Date.now()) return c.result;
  return undefined;
}

// Runs object detection and turns each box into a Lens crop region. Never
// throws — any failure caches an empty non-fallback result, so it cannot be
// mistaken for a literal "no products in this image" answer. Concurrent
// callers for the same image share one run.
async function detectAndBuildCrops(imageUrl: string): Promise<CropResult> {
  const existing = cropInFlight.get(imageUrl);
  if (existing) return existing;

  const run = (async (): Promise<CropResult> => {
    const startedAt = Date.now();
    try {
      const { objects } = await detectLimit(() => detectImage(imageUrl));

      if (objects.length === 0) {
        const result = { crops: [], noProducts: true };
        cropCache.set(imageUrl, { expires: Date.now() + CROP_EMPTY_TTL_MS, result });
        return result;
      }

      const crops = objects.slice(0, CROP_MAX).map((o) => ({
        crop: lensCropParam(o.box),
        box: o.box,
        label: normalizeLabel(o.label),
        category: o.category,
        signature: o.signature,
      }));

      const result = { crops, noProducts: false };
      cropCache.set(imageUrl, { expires: Date.now() + CROP_SUCCESS_TTL_MS, result });
      logNet("DETECT", {
        outcome: "completed",
        durationMs: Date.now() - startedAt,
        objects: objects.length,
        crops: crops.length,
        tags: [...new Set(crops.map((c) => c.label))].join(","),
      });
      return result;
    } catch (e) {
      // Cache empty briefly (error TTL) so we neither hammer a failing detector
      // nor block the match, and recover fast once the service is back.
      const result = { crops: [], noProducts: false };
      cropCache.set(imageUrl, { expires: Date.now() + CROP_ERROR_TTL_MS, result });
      logNet("DETECT", { outcome: "error", reason: e instanceof Error ? e.message : String(e) });
      return result;
    } finally {
      cropInFlight.delete(imageUrl);
    }
  })();

  cropInFlight.set(imageUrl, run);
  return run;
}

/** This image's crop result, waiting for detection if it hasn't run yet.
 *
 * There is no timed bail-out and no "answer from the whole image while we
 * think about it": a pin's products are what the detector says they are, and
 * an answer that arrives sooner by not knowing them is the wrong answer. On a
 * cache hit (memory or DB) this is instant; otherwise it costs one ~6s model
 * call, which the crop searches then run behind.
 */
export async function cropResultFor(imageUrl: string): Promise<CropResult> {
  const cached = getCrops(imageUrl);
  if (cached) return cached;
  if (!DETECT_ENABLED) return { crops: [], noProducts: false };
  return detectAndBuildCrops(imageUrl);
}

// -------------------------------------------------------------
// STEP: Filter to supported retailers only (Set-based, O(depth) not O(N) —
// see `isSupportedRetailerLink` in brands.ts) — a match from anywhere else
// must never reach CK, a paid per-request API.
// -------------------------------------------------------------

/** `dropped`, when passed, collects the matches this filter rejected. Nothing on
 * the match path passes it — only the funnel debug trace, which is the one
 * consumer that needs the identities and not just the counts. The live pipeline
 * has never recorded them, so "why is this retailer missing" was unanswerable
 * from the logs alone. */
function filterSupportedRetailers(matches: LensMatch[], dropped?: LensMatch[]): LensMatch[] {
  const before = matches.length;
  const filtered = matches.filter((m) => {
    const ok = isSupportedRetailerLink(m.link);
    if (!ok) dropped?.push(m);
    return ok;
  });
  logNet("FILTER", { before, after: filtered.length });
  return filtered;
}

// -------------------------------------------------------------
// STEP: Rank — supported retailer is already guaranteed by the filter step
// above. Of the remaining signals, Google's own `position` is the closest
// proxy this API exposes to "image similarity" (it has no raw similarity
// score to give us); title-keyword overlap against the pin's own
// title/description is the next strongest signal, since brand/color/
// category words that matter tend to show up in both; an in-stock hint from
// Lens itself is a light tiebreak only (CK remains the real availability
// source of truth). Lower score = higher rank.
// -------------------------------------------------------------

const RANK_STOPWORDS = new Set([
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
  "women",
  "girls",
  "boys",
  "kids",
  "pack",
  "set",
  "pcs",
  "com",
]);

function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !RANK_STOPWORDS.has(w)),
  );
}

function keywordOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count++;
  return count;
}

// -------------------------------------------------------------
// Niche awareness. Google Lens returns whatever it visually matched, mixing
// niches when a Pin's image is busy (a fashion shot that also caught a lamp
// in frame, say). We can't run a vision model here (no key), but we can read
// the strongest signal we *do* have — the product titles Lens returned, plus
// the Pin's own title/description — decide the dominant niche, and rank the
// matches that actually belong to that niche above the incidental ones. Pure
// in-process scoring: no extra network call, so it costs nothing in latency.
// -------------------------------------------------------------

type Niche = {
  key: string;
  // Words that identify a product as belonging to this niche.
  keywords: string[];
  // Retailers that predominantly sell this niche — a light additional signal.
  retailers: string[];
};

// Keyword lists are long on purpose. A niche is scored by how many of its
// words a title contains, so a thin list mis-scores an entire batch: before
// this was widened, an accessories-heavy pin (belts, scarves, socks) matched
// almost nothing in "fashion" and the whole batch ranked as if it had no niche
// at all. Only single-word entries are ever tested against the tokenised title
// (see countNicheHits) — multi-word entries are documentation, not scoring.
const NICHES: Niche[] = [
  {
    key: "fashion",
    keywords: [
      // tops
      "dress",
      "dresses",
      "gown",
      "kurta",
      "kurti",
      "saree",
      "lehenga",
      "anarkali",
      "shirt",
      "tshirt",
      "tee",
      "top",
      "tops",
      "blouse",
      "tunic",
      "crop",
      "camisole",
      "hoodie",
      "sweatshirt",
      "sweater",
      "pullover",
      "jumper",
      "polo",
      "bodysuit",
      "jumpsuit",
      "romper",
      "playsuit",
      "kaftan",
      // outerwear
      "jacket",
      "blazer",
      "coat",
      "overcoat",
      "cardigan",
      "shrug",
      "parka",
      "poncho",
      "waistcoat",
      "sherwani",
      "bomber",
      "puffer",
      "windcheater",
      // bottoms
      "jeans",
      "denim",
      "denims",
      "trousers",
      "pants",
      "chinos",
      "joggers",
      "skirt",
      "shorts",
      "palazzo",
      "leggings",
      "jeggings",
      "tights",
      "cargo",
      "culottes",
      "capri",
      "dhoti",
      "salwar",
      "churidar",
      "dungarees",
      // innerwear / loungewear
      "lingerie",
      "bra",
      "briefs",
      "boxers",
      "shapewear",
      "nightwear",
      "nighty",
      "pyjamas",
      "pajamas",
      "sleepwear",
      "loungewear",
      "swimwear",
      "swimsuit",
      "bikini",
      "robe",
      "thermals",
      // footwear
      "shoes",
      "sneakers",
      "trainers",
      "heels",
      "sandals",
      "slippers",
      "chappals",
      "boots",
      "loafers",
      "mules",
      "flats",
      "wedges",
      "espadrilles",
      "juttis",
      "footwear",
      "sliders",
      // bags & accessories
      "bag",
      "handbag",
      "backpack",
      "tote",
      "clutch",
      "purse",
      "sling",
      "wallet",
      "satchel",
      "duffle",
      "luggage",
      "suitcase",
      "belt",
      "scarf",
      "scarves",
      "stole",
      "dupatta",
      "shawl",
      "muffler",
      "socks",
      "gloves",
      "tie",
      "bowtie",
      "cap",
      "hat",
      "beanie",
      "beret",
      "turban",
      "scrunchie",
      "bandana",
      "umbrella",
      // jewellery & eyewear
      "watch",
      "smartwatch",
      "earrings",
      "necklace",
      "pendant",
      "bracelet",
      "bangle",
      "ring",
      "anklet",
      "choker",
      "jhumka",
      "jewellery",
      "jewelry",
      "brooch",
      "sunglasses",
      "eyewear",
      "spectacles",
      "goggles",
      "aviators",
      // generic
      "apparel",
      "outfit",
      "ethnic",
      "fit",
      "clothing",
      "wear",
      "fashion",
      "style",
      "western",
      "casual",
      "formal",
      "party",
    ],
    retailers: ["myntra", "ajio", "nykaa fashion", "tatacliq", "flipkart", "amazon"],
  },
  {
    key: "beauty",
    keywords: [
      "lipstick",
      "lipbalm",
      "gloss",
      "liner",
      "eyeliner",
      "kajal",
      "kohl",
      "mascara",
      "eyeshadow",
      "palette",
      "makeup",
      "cosmetic",
      "cosmetics",
      "blush",
      "bronzer",
      "highlighter",
      "compact",
      "foundation",
      "concealer",
      "primer",
      "setting",
      "skincare",
      "serum",
      "moisturizer",
      "moisturiser",
      "cream",
      "lotion",
      "toner",
      "cleanser",
      "facewash",
      "scrub",
      "exfoliator",
      "mask",
      "sunscreen",
      "spf",
      "shampoo",
      "conditioner",
      "hairoil",
      "haircare",
      "keratin",
      "perfume",
      "fragrance",
      "attar",
      "deodorant",
      "mist",
      "cologne",
      "nail",
      "polish",
      "manicure",
      "soap",
      "bodywash",
      "razor",
      "trimmer",
      "mehendi",
      "henna",
      "beauty",
      "grooming",
    ],
    retailers: ["nykaa", "purplle", "tira", "sugar", "mamaearth", "amazon", "flipkart"],
  },
  {
    key: "home",
    keywords: [
      "decor",
      "cushion",
      "pillow",
      "bolster",
      "curtain",
      "blind",
      "lamp",
      "lantern",
      "chandelier",
      "vase",
      "planter",
      "furniture",
      "sofa",
      "couch",
      "sectional",
      "table",
      "desk",
      "chair",
      "stool",
      "bench",
      "ottoman",
      "recliner",
      "bed",
      "mattress",
      "wardrobe",
      "almirah",
      "shelf",
      "shelves",
      "bookshelf",
      "cabinet",
      "dresser",
      "nightstand",
      "rack",
      "rug",
      "carpet",
      "doormat",
      "bedsheet",
      "duvet",
      "comforter",
      "quilt",
      "blanket",
      "throw",
      "bedding",
      "clock",
      "mirror",
      "candle",
      "diya",
      "toran",
      "incense",
      "showpiece",
      "figurine",
      "sculpture",
      "tapestry",
      "macrame",
      "wallpaper",
      "coaster",
      "tray",
      "basket",
      "organizer",
      "organiser",
      "storage",
      "home",
      "interior",
    ],
    retailers: [
      "pepperfry",
      "urbanladder",
      "ikea",
      "homecentre",
      "wakefit",
      "nestasia",
      "amazon",
      "flipkart",
    ],
  },
  {
    key: "kitchen",
    keywords: [
      "cookware",
      "kadai",
      "pan",
      "saucepan",
      "cooker",
      "tawa",
      "casserole",
      "dinnerware",
      "crockery",
      "serveware",
      "plate",
      "bowl",
      "mug",
      "cup",
      "tumbler",
      "glassware",
      "bottle",
      "flask",
      "thermos",
      "lunchbox",
      "tiffin",
      "container",
      "jar",
      "cutlery",
      "spoon",
      "fork",
      "knife",
      "chopping",
      "kettle",
      "toaster",
      "airfryer",
      "microwave",
      "oven",
      "blender",
      "mixer",
      "grinder",
      "juicer",
      "coffee",
      "espresso",
      "induction",
      "refrigerator",
      "apron",
      "bakeware",
      "utensil",
      "kitchen",
      "dining",
    ],
    retailers: ["amazon", "flipkart", "tatacliq", "homecentre", "nestasia", "croma"],
  },
  {
    key: "art",
    keywords: [
      "painting",
      "poster",
      "print",
      "canvas",
      "frame",
      "artwork",
      "sketch",
      "illustration",
      "mural",
      "portrait",
      "wallart",
      "abstract",
      "calligraphy",
    ],
    retailers: ["amazon", "flipkart", "etsy"],
  },
  {
    key: "electronics",
    keywords: [
      "headphone",
      "headphones",
      "earbuds",
      "earphone",
      "airpods",
      "neckband",
      "speaker",
      "soundbar",
      "phone",
      "smartphone",
      "iphone",
      "laptop",
      "macbook",
      "tablet",
      "ipad",
      "camera",
      "dslr",
      "gopro",
      "drone",
      "charger",
      "powerbank",
      "smartwatch",
      "monitor",
      "keyboard",
      "mouse",
      "gadget",
      "console",
      "controller",
      "projector",
      "printer",
      "router",
      "webcam",
      "microphone",
      "tripod",
      "gimbal",
      "kindle",
      "ssd",
      "pendrive",
      "adapter",
      "cable",
      "purifier",
      "vacuum",
      "television",
      "electronics",
    ],
    retailers: ["croma", "reliancedigital", "vijaysales", "amazon", "flipkart"],
  },
  {
    key: "fitness",
    keywords: [
      "yoga",
      "mat",
      "dumbbell",
      "kettlebell",
      "barbell",
      "weights",
      "resistance",
      "treadmill",
      "cycle",
      "bicycle",
      "skipping",
      "roller",
      "gym",
      "workout",
      "fitness",
      "protein",
      "whey",
      "shaker",
      "cricket",
      "football",
      "basketball",
      "badminton",
      "racket",
      "shuttlecock",
      "sports",
      "activewear",
      "sportswear",
      "running",
      "training",
    ],
    retailers: ["decathlon", "amazon", "flipkart", "myntra", "healthkart"],
  },
  {
    key: "kids",
    keywords: [
      "toy",
      "toys",
      "plush",
      "teddy",
      "doll",
      "figure",
      "puzzle",
      "jigsaw",
      "lego",
      "blocks",
      "rattle",
      "stroller",
      "pram",
      "crib",
      "playset",
      "board",
      "game",
      "games",
      "baby",
      "infant",
      "toddler",
      "nursery",
    ],
    retailers: ["firstcry", "hamleys", "amazon", "flipkart"],
  },
  {
    key: "stationery",
    keywords: [
      "notebook",
      "notepad",
      "journal",
      "diary",
      "planner",
      "pen",
      "pens",
      "pencil",
      "crayon",
      "marker",
      "sticker",
      "stickers",
      "washi",
      "sketchbook",
      "sketch",
      "paint",
      "paints",
      "brush",
      "brushes",
      "watercolour",
      "watercolor",
      "folder",
      "stapler",
      "eraser",
      "sharpener",
      "bookmark",
      "calendar",
      "book",
      "books",
      "novel",
      "stationery",
    ],
    retailers: ["amazon", "flipkart", "doms", "classmate", "etsy"],
  },
  {
    key: "pet",
    keywords: [
      "pet",
      "pets",
      "dog",
      "cat",
      "puppy",
      "kitten",
      "leash",
      "collar",
      "harness",
      "kennel",
      "litter",
      "aquarium",
      "kibble",
      "chew",
      "grooming",
    ],
    retailers: ["heads up for tails", "supertails", "amazon", "flipkart"],
  },
];

function countNicheHits(words: Set<string>, niche: Niche): number {
  let hits = 0;
  for (const kw of niche.keywords) {
    // Multi-word keywords ("wall art") can't be in the tokenized set — skip
    // them here; single tokens are the common, cheap case.
    if (kw.includes(" ")) continue;
    if (words.has(kw)) hits++;
  }
  return hits;
}

// Pick the niche the batch is really about, or null if nothing dominates.
function detectNiche(
  matches: LensMatch[],
  context: { title?: string; description?: string },
): Niche | null {
  const corpus = extractKeywords(
    `${context.title ?? ""} ${context.description ?? ""} ${matches.map((m) => m.title).join(" ")}`,
  );
  let best: { niche: Niche; score: number } | null = null;
  for (const niche of NICHES) {
    const score = countNicheHits(corpus, niche);
    if (score > 0 && (!best || score > best.score)) best = { niche, score };
  }
  return best && best.score >= 1 ? best.niche : null;
}

function retailerMatchesNiche(source: string, niche: Niche): boolean {
  const s = source.toLowerCase();
  return niche.retailers.some((r) => s.includes(r));
}

function rankMatches(
  matches: LensMatch[],
  context: { title?: string; description?: string },
): LensMatch[] {
  const queryWords = extractKeywords(`${context.title ?? ""} ${context.description ?? ""}`);
  const niche = detectNiche(matches, context);
  return matches
    .map((m) => ({ m, score: baseScore(m, queryWords, niche) }))
    .sort((a, b) => a.score - b.score)
    .map((s) => s.m);
}

/** Rank score shared by both paths. Lower is better. */
function baseScore(m: LensMatch, queryWords: Set<string>, niche: Niche | null): number {
  const titleWords = extractKeywords(m.title);
  const overlap = queryWords.size > 0 ? keywordOverlap(titleWords, queryWords) : 0;
  // Niche fit is the strongest signal after direct title overlap: a match
  // whose own title belongs to the detected niche is almost certainly the
  // right object; its retailer selling that niche is a lighter confirm.
  const nicheHits = niche ? countNicheHits(titleWords, niche) : 0;
  const nicheBoost = niche
    ? Math.min(nicheHits, 2) * 3 + (retailerMatchesNiche(m.source, niche) ? 1 : 0)
    : 0;
  return m.position - overlap * 5 - nicheBoost - (m.inStockHint ? 0.5 : 0);
}

// -------------------------------------------------------------
// STEP: Category gate — the thing that keeps the product under a tab actually
// BEING the thing the tab is named after.
//
// A crop is a rectangle, not a cut-out. Whatever else falls inside it — the
// hem of the jeans above a pair of shoes, the wall beside a blazer — Lens sees
// too, and it answers with what IT considers the subject, which is not always
// the object we cropped for. That is the whole of the "labels are right but the
// products under them are sometimes wrong" complaint: a t-shirt and a pair of
// jeans coming back under a crop labelled "White Sneakers", because they really
// were in the picture.
//
// So the detector now also reports each object's CATEGORY, and a match is only
// allowed under that object's tab if its own title agrees. The rule is
// deliberately asymmetric: a match is dropped only when its category is known
// AND conflicts. Retailer titles are noisy ("BAESD Women Shrug 27764846") and
// an unrecognised one is far more likely to be a title we can't parse than a
// product from a different aisle — dropping those would cost real matches to
// catch few mistakes.
//
// It costs nothing in latency: one regex pass over titles we already have.
// -------------------------------------------------------------

// The category vocabulary — the regexes that read a retailer's title, the
// compatible-category pairs, and the enum itself — lives in
// product-category.ts, imported at the top of this file. It used to be COPIED
// here, and the copy had already drifted: this side had learned that
// outerwear and top blur into each other and the detector side never did. A
// drifted copy fails silently, because every disagreement it causes reads as
// "no opinion" and the gate simply stops gating.

// -------------------------------------------------------------
// STEP: Deduplicate by canonical URL, keeping each product's best-ranked
// occurrence (matches are already sorted by rank when this runs) — the same
// listing reached via two tracking-param variants collapses to one entry
// and is never scraped twice.
// -------------------------------------------------------------

function dedupeMatches(matches: LensMatch[]): LensMatch[] {
  const before = matches.length;
  const seen = new Set<string>();
  const deduped = matches.filter((m) => {
    const key = canonicalizeProductUrl(m.link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  logNet("DEDUPE", { before, after: deduped.length });
  return deduped;
}

function toRawVisualMatch(m: LensMatch): RawVisualMatch {
  return {
    title: m.title,
    link: canonicalizeProductUrl(m.link),
    source: m.source,
    thumbnail: m.thumbnail,
    price: m.price,
  };
}

// -------------------------------------------------------------
// STEP: Look gate — the category gate keeps a card the right KIND of thing;
// this keeps it the right-LOOKING thing. Each candidate's thumbnail goes to
// the vision proxy with the pin object's own appearance (the `d` signature
// captured at detection, the only stage that saw the pin) plus the retailer's
// title, and an explicit "different" drops the card.
//
// It verifies a POOL of the best-ranked candidates — twice the tab cap — and
// fills the tab from the survivors. Verifying only the top 8 meant every
// rejection left a hole in the tab while perfectly good candidates at ranks
// 9–16 were never looked at; now a rejection just promotes the next survivor.
// Verdicts are cached by thumbnail, so the steady-state cost stays close to
// one pass per product, not per scan.
//
// Fail-open on purpose: a verdict of null (no thumbnail, proxy down, reply
// unparseable) keeps the card. The model is a filter, not an oracle — it can
// be wrong in both directions, and a broken verifier must degrade to the
// unverified behaviour, never to empty tabs.
// -------------------------------------------------------------

// Master switch. Set VISION_VERIFY_ENABLED=false to skip look verification.
const VERIFY_ENABLED = process.env.VISION_VERIFY_ENABLED !== "false";
// How deep past the tab cap the verifier looks for replacements for rejected
// cards. Deep enough that a tab half-full of lookalikes still fills, shallow
// enough to bound spend — by this rank the candidates are no longer worth a
// vision call each.
const VERIFY_POOL_MAX = 15;
// Vision-proxy calls in flight across the whole process. A four-object pin
// is the ONE stage whose cost is not ours to optimise: benchmarked at 4, 8
// and 16 in flight, twelve calls took 36s, 72s and 25s — the proxy's own
// throughput dominates and pushing harder mostly moves the queue inside it
// (at 20, individual verdicts took over 70s). Kept modest deliberately; the
// lever that actually works is making FEWER calls (see VERIFY_BUDGET_PER_PIN).
// Nudged to 8 alongside the deeper budget and the sixth component: the same
// benchmark that warns against 20 measured 16 as the FASTEST of the three it
// tried, so the risk here is on the low side, and a queue this stage cannot
// drain is now the thing that makes a tab refine late rather than the thing
// that makes it appear late.
const VERIFY_CONCURRENCY = 8;
const verifyLimit = createLimiter(VERIFY_CONCURRENCY);
// A verdict is as stable as the image it judged — cache hard. Null verdicts
// get the short error TTL so a proxy blip is retried soon.
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const verifyCache = new Map<string, { expires: number; verdict: LookVerdict | null }>();
// The longest a component waits on its verify wave. This is a safety valve
// for a hung proxy, NOT a latency knob: it fails open, so every verdict it
// cuts short is a lookalike shown. It sits well above the measured worst
// case for a full pool (~12s per call, a few rounds deep) so it fires only
// when something is genuinely wrong. Crucially the abandoned calls are NOT
// cancelled — they finish in the background and fill verifyCache, so the
// next scan of the same products gets instant verdicts.
// Raised from 45s with the deeper budget and the sixth tab. It fails OPEN, so
// every verdict it cuts short is a lookalike shown — a straight accuracy loss
// — and the reason to keep it tight (a shopper waiting) no longer applies now
// that the cards are already on screen when this runs.
const VERIFY_DEADLINE_MS = 60_000;
// Roughly how many look-verifications one pin may spend, shared across its
// components. The vision proxy answers a verdict in ~2s at best and ~25s
// under load, so the cost of this stage is simply how many times it is
// called: verifying every card of a four-object pin meant 40 calls and a
// ~50s tail, against ~11s for a two-object pin doing 10.
//
// The budget is split evenly across the pin's components and spent on each
// tab's BEST-ranked cards — the ones a shopper actually looks at. Cards below
// the verified head are still returned and still ranked; they simply carry no
// lookMatch, exactly like a card the verifier couldn't reach. Nothing is
// dropped for want of budget, so this trades verification DEPTH for latency
// and never product count.
//
// Raised from 12 now that verification runs BEHIND the cards rather than in
// front of them (see ComponentStage). Depth was being rationed against a
// shopper watching an empty screen; it is now rationed against a shopper
// reading a full one, and depth is exactly what the look gate's accuracy is
// made of — every card it doesn't reach is a card shown on the category gate's
// word alone.
const VERIFY_BUDGET_PER_PIN = 18;
// Extra verdicts bought in the FIRST wave, past the head. Rejections are
// normal, and each one used to cost a whole sequential round trip to replace
// one card; this absorbs the usual one or two into the round already being
// paid for. Cheap in the long run — a verdict is cached by (thumbnail, target)
// and answers instantly on every later scan of the same product.
const VERIFY_OVERSHOOT = 2;
// ...but never fewer than this per component, or a four-object pin would
// verify too shallowly for the gate to mean anything.
const VERIFY_HEAD_MIN = 3;
// How many sequential verify rounds one component may run. Each round is a
// full round trip against the slowest service in the pipeline, so this bounds
// the worst case directly.
const VERIFY_MAX_WAVES = 2;
// Below this many supported-retailer results from its own region, a component
// re-searches a widened box (see the widen retry in searchComponent).
const WIDEN_RETRY_BELOW = 6;
// 2× measured best: it recovered a starved eyewear crop from 0 usable
// candidates to 22, while 3× drifted onto the neighbouring product.
const WIDEN_FACTOR = 2;
// Boxes below this share of the frame are the ones that starve — the eyewear
// (0.06), earrings (0.02) and bag (0.09) boxes measured on a real outfit pin
// all did, while the shirt that filled its tab did not. Used ONLY to warm the
// widened search speculatively during detection (see componentsForImage); the
// retry itself still fires on the measured result, never on this guess.
const WIDEN_SPECULATE_BELOW_AREA = 0.12;

// In-flight verdicts, so the same judgement is never bought twice. This is
// what makes speculative verification free: the head of a tab can be started
// early on a guess and, when the real assembly asks for the same verdict, it
// JOINS that call instead of issuing a second one. Without it, speculation
// would double the load on the one stage that can least afford it.
const verifyInFlight = new Map<string, Promise<LookVerdict | null>>();

// The durable half of the verdict cache. This is the one that matters most:
// verification is the slowest stage in the pipeline and the only one whose
// cost scales with the number of cards, so every verdict recovered from
// Postgres is a ~2-25s model call not made. "Does this retailer photo show the
// same product as that object" is a fact about two images — it is the same
// answer for every user and every pin, which is what makes it worth storing
// beyond one process.
const VERDICT_ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The stored question: what this image was judged against.
 *
 * Normalised (lowercased, whitespace collapsed) because this string is half of
 * the durable cache key, and the detector writes the same object's look with
 * incidental differences in case and spacing from one pin to the next. "White
 * leather low-top, gum sole" and "white leather low-top,  gum sole" are the
 * same question; keying them apart bought the same verdict twice — at ~2-25s a
 * call, on the slowest stage in the pipeline. */
function verdictTarget(crop: Crop): string {
  const raw = crop.signature ? `${crop.label} — ${crop.signature}` : crop.label;
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

async function loadVerdictRow(imageUrl: string, target: string): Promise<LookVerdict | null> {
  if (cacheDisabled.has("look_verdicts")) return null;
  try {
    const { data, error } = await getServiceSupabase()
      .from("look_verdicts")
      .select("verdict, judged_at")
      .eq("image_url", imageUrl)
      .eq("target", target)
      .maybeSingle();
    noteCacheError("look_verdicts", error);
    if (error || !data) return null;
    if (Date.now() - new Date(data.judged_at).getTime() > VERDICT_ROW_TTL_MS) return null;
    const v = data.verdict;
    return v === "same" || v === "close" || v === "different" ? v : null;
  } catch {
    return null;
  }
}

async function saveVerdictRow(imageUrl: string, target: string, verdict: LookVerdict) {
  if (cacheDisabled.has("look_verdicts")) return;
  try {
    const { error } = await getServiceSupabase()
      .from("look_verdicts")
      .upsert(
        { image_url: imageUrl, target, verdict, judged_at: new Date().toISOString() },
        { onConflict: "image_url,target" },
      );
    noteCacheError("look_verdicts", error);
  } catch {
    /* best-effort */
  }
}

function looksSame(
  crop: Crop,
  thumbnail: string | null,
  matchTitle: string,
): Promise<LookVerdict | null> {
  if (!thumbnail) return Promise.resolve(null);
  const target = verdictTarget(crop);
  const key = JSON.stringify([thumbnail, target]);
  const cached = verifyCache.get(key);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.verdict);

  const existing = verifyInFlight.get(key);
  if (existing) return existing;

  // The stored verdict is checked inside the in-flight entry (so a second
  // caller joins the lookup rather than racing it) but OUTSIDE the limiter —
  // a DB read must never wait behind the model calls it exists to avoid.
  const promise = (async () => {
    const stored = await loadVerdictRow(thumbnail, target);
    if (stored) {
      logNet("VERIFY", { outcome: "db_hit", verdict: stored });
      return { verdict: stored as LookVerdict | null, fresh: false };
    }
    const verdict = await verifyLimit(() =>
      verifyProductLook(crop.label, crop.signature, thumbnail, matchTitle),
    );
    return { verdict, fresh: true };
  })()
    .then(({ verdict, fresh }) => {
      verifyCache.set(key, {
        expires: Date.now() + (verdict === null ? CROP_ERROR_TTL_MS : VERIFY_TTL_MS),
        verdict,
      });
      // Only real verdicts are persisted. A null means the verifier could not
      // reach the image or parse its reply — that is a condition to retry, not
      // a fact about the product.
      if (fresh && verdict) void saveVerdictRow(thumbnail, target, verdict);
      return verdict;
    })
    .finally(() => {
      verifyInFlight.delete(key);
    });
  verifyInFlight.set(key, promise);
  return promise;
}

/** Rank of a look verdict when ordering a tab: exact first, then close, then
 * the cards the verifier couldn't judge. "different" never reaches sorting —
 * it's dropped outright. */
function verdictRank(v: LookVerdict | null): number {
  return v === "same" ? 0 : v === "close" ? 1 : 2;
}

/** Which half of a component's work a caller wants.
 *
 * The two halves have completely different costs and the split is the single
 * biggest thing standing between a scan and feeling live:
 *
 *   "fast"      Lens + the category gate + ranking. Bounded by Lens (~8-14s
 *               cold, ~0ms once cached) and nothing else. These are the cards.
 *   "verified"  the same tab with the look gate applied — one vision call per
 *               candidate against a fixed-throughput proxy, which is where the
 *               10-30s tail lived.
 *
 * Both were previously inside ONE response, so nothing rendered until the
 * slowest verdict landed: the shopper stared at skeletons while the server did
 * its most expensive, least urgent work. Now the client paints the fast stage
 * and swaps in the verified one when it arrives, and the verified stage costs
 * nothing in perceived time because the screen is already full.
 *
 * Accuracy is unchanged at rest — the same gate, the same verdicts, the same
 * final ordering. It only arrives second. */
export type ComponentStage = "fast" | "verified";

/** The candidate pool for one component: everything up to, and not including,
 * the look gate. Computed once per (image, component) and shared by both
 * stages, so asking for the verified tab after the fast one costs no Lens work,
 * no re-ranking and no second round of logs. */
type ComponentPool = {
  crop: Crop;
  pool: Array<{ m: LensMatch; score: number; fromCrop: boolean }>;
  /** Built before every Lens source had answered — a real answer, just not the
   * final one. Never cached, and never used for the verified stage. */
  partial: boolean;
  /** Did the region search return anything that reads as this crop's own
   * category? The fallback veto for crop-sourced candidates when the verifier
   * has nothing to say. */
  landed: boolean;
  widened: boolean;
  cropResults: number;
  wholeResults: number;
};

/** How long the fast stage waits for the SECOND of its two Lens sources once
 * the first has landed.
 *
 * Long enough that two searches finishing close together are both used, short
 * enough that it cannot re-introduce the wait it exists to remove. On a cold
 * pin the two sources are a whole detection apart and this simply expires, so
 * it is a straight cost there and is priced accordingly; on a warm one both
 * are cache hits and it never fires at all. Whatever misses it is not lost —
 * the verified stage waits for everything. */
const FAST_SOURCE_GRACE_MS = 1_200;

/** `p`'s value if it settles within `ms`, else null. The pending promise is
 * left running: it is a shared, cached Lens search, and the stage behind this
 * one is going to want it. */
function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms).unref?.();
    }),
  ]);
}

const POOL_TTL_MS = 10 * 60 * 1000;
const poolCache = new Map<string, { expires: number; result: ComponentPool | null }>();
const poolInFlight = new Map<string, Promise<ComponentPool | null>>();

/** Per-component result cache, keyed by stage.
 *
 * Two callers reach this for the same tab within moments of each other — the
 * warm-up started when detection resolved, and the client's own request
 * arriving a beat later — and without this the second one repeats the first's
 * work rather than joining it. That join is what makes warming worth anything:
 * by the time the client asks, the answer is either ready or already in
 * flight. */
const COMPONENT_TTL_MS = 10 * 60 * 1000;
/** A fast answer built before every Lens source landed is right but thin, so it
 * is held only long enough to serve the request it was warmed for. The next
 * caller rebuilds it from the complete set. */
const COMPONENT_PARTIAL_TTL_MS = 20 * 1000;
const componentCache = new Map<string, { expires: number; matches: RawVisualMatch[] }>();
const componentInFlight = new Map<string, Promise<RawVisualMatch[]>>();

function componentKey(imageUrl: string, index: number, stage: string, title: string): string {
  return JSON.stringify([imageUrl, index, stage, title]);
}

/** Search ONE detected component and return the products that belong to it.
 *
 * This is the unit the UI streams: every component is independent, so the tab
 * for the shoes can fill at 5s while the tab for the jacket is still running at
 * 13s. `componentIndex` of -1 means "no components were detected" and searches
 * the whole image instead, which is the only situation left in which an
 * untagged result is produced.
 *
 * `score` travels with each match so a caller merging several components can
 * settle a product that qualified for two tabs the same way the batch path
 * does — on merit, not on which search returned first.
 */
export async function searchComponent(
  imageUrl: string,
  crops: Crop[],
  componentIndex: number,
  title: string,
  description: string,
  stage: ComponentStage = "verified",
  trace?: ComponentTrace,
): Promise<RawVisualMatch[]> {
  const key = componentKey(imageUrl, componentIndex, stage, title);
  // As in `componentPool`: a traced run skips the memo and its result is never
  // written back, so the debug view can never be answered by (or pollute) the
  // cache the real screen reads.
  if (trace)
    return (
      await searchComponentUncached(
        imageUrl,
        crops,
        componentIndex,
        title,
        description,
        stage,
        trace,
      )
    ).matches;
  const cached = componentCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.matches;
  const existing = componentInFlight.get(key);
  if (existing) return existing;

  const run = searchComponentUncached(imageUrl, crops, componentIndex, title, description, stage)
    .then(({ matches, partial }) => {
      componentCache.set(key, {
        expires: Date.now() + (partial ? COMPONENT_PARTIAL_TTL_MS : COMPONENT_TTL_MS),
        matches,
      });
      return matches;
    })
    .finally(() => componentInFlight.delete(key));
  componentInFlight.set(key, run);
  return run;
}

type StagedResult = { matches: RawVisualMatch[]; partial: boolean };

async function searchComponentUncached(
  imageUrl: string,
  crops: Crop[],
  componentIndex: number,
  title: string,
  description: string,
  stage: ComponentStage,
  trace?: ComponentTrace,
): Promise<StagedResult> {
  const startedAt = Date.now();

  // No components: one whole-image search, untagged. Capped and price-first,
  // exactly as the old whole-image path was. There is no look gate on this
  // path — no detected object to hold a candidate against — so both stages
  // return the same thing and "fast" is simply the answer.
  if (componentIndex < 0) {
    const raw = await searchGoogleLens(imageUrl).catch(() => [] as LensMatch[]);
    const rejects: LensMatch[] = [];
    const supported = filterSupportedRetailers(raw, trace && rejects);
    const deduped = dedupeMatches(rankMatches(supported, { title, description }));
    const top = [...deduped.filter((m) => m.price), ...deduped.filter((m) => !m.price)].slice(
      0,
      FULL_IMAGE_MAX,
    );
    if (trace) {
      trace.searches.push({
        kind: "whole",
        cropParam: null,
        box: null,
        answered: true,
        rawCount: raw.length,
        keptCount: supported.length,
        unsupported: hostTally(rejects),
        origin: lensOrigin(imageUrl, null),
      });
      const kept = new Set(top);
      for (const m of deduped) {
        trace.gate.push({
          m,
          cat: categoryOfTitle(m.title),
          from: "whole",
          kept: kept.has(m),
          // The whole-image path has no category gate and no look gate; the only
          // thing that removes a card is the cap, after a price-first reorder.
          reason: kept.has(m) ? undefined : "full_image_cap",
        });
      }
      trace.final = top.map((m, i) => ({ m, rank: i, score: undefined, verdict: null }));
      trace.cropResults = 0;
      trace.wholeResults = supported.length;
      trace.landed = true;
      trace.durationMs = Date.now() - startedAt;
    }
    logNet("COMPONENT", {
      durationMs: Date.now() - startedAt,
      component: "whole_image",
      final: top.length,
    });
    return { matches: top.map(toRawVisualMatch), partial: false };
  }

  const built = await componentPool(
    imageUrl,
    crops,
    componentIndex,
    title,
    description,
    stage === "fast",
    trace,
  );
  if (!built) return { matches: [], partial: false };
  const { crop, pool, landed } = built;

  // FAST STAGE. The cards, as soon as Lens has spoken: category-gated, ranked,
  // and vetoed by `landed` exactly as an unverified tab has always been. What
  // it does NOT do is wait for the look gate.
  //
  // Verification for this same tab is started here, unawaited. It is not
  // speculation — the pool is settled, so these are precisely the verdicts the
  // verified stage will ask for, and `looksSame` dedupes in flight, so the
  // client's follow-up request JOINS this work instead of starting it. The
  // measured warning against speculative verification (34s → 48s on a
  // four-object pin) was about buying verdicts for a pool that had not been
  // decided yet; those calls were wasted and stole limiter slots from the
  // cards being shown. These are the same calls, only sooner.
  if (stage === "fast") {
    const project = (p: ComponentPool) => {
      const eligible = p.pool.filter((c) => {
        const ok = c.fromCrop ? p.landed : true;
        if (!ok) trace?.poolDrops.push({ m: c.m, score: c.score, reason: "landed_veto" });
        return ok;
      });
      const ranked = eligible.sort((a, b) => a.score - b.score);
      if (trace) {
        for (const c of ranked.slice(PER_TAG_MAX))
          trace.poolDrops.push({ m: c.m, score: c.score, reason: "tab_cap" });
        trace.final = ranked
          .slice(0, PER_TAG_MAX)
          .map((c, i) => ({ m: c.m, rank: i, score: c.score, verdict: null }));
      }
      return ranked
        .slice(0, PER_TAG_MAX)
        .map((c) => ({ ...toRawVisualMatch(c.m), tag: p.crop.label, score: c.score }));
    };

    let settled = built;
    let out = project(built);
    // "Nothing here" is the one answer never worth rushing. An empty tab built
    // from half the sources is indistinguishable, to the shopper, from a pin
    // with nothing to sell — and it is the only fast answer that a later
    // refinement cannot improve without looking broken. So when the impatient
    // build comes back empty, wait for the whole pool after all: this costs
    // time only on the tabs that had nothing to show for it.
    if (out.length === 0 && built.partial) {
      // The rebuild re-runs every gate over the complete sources, so it re-records
      // all of them. Without clearing first the trace would show each search and
      // each gate decision twice — once from the impatient build that was thrown
      // away, once from the one whose answer is actually returned.
      if (trace) {
        trace.searches = [];
        trace.gate = [];
        trace.poolDrops = [];
      }
      const full = await componentPool(
        imageUrl,
        crops,
        componentIndex,
        title,
        description,
        false,
        trace,
      );
      if (full) {
        settled = full;
        out = project(full);
      }
    }
    // A traced run must not fire the background verification the real fast stage
    // does: it would spend vision calls for a panel that reads verdicts from
    // cache, on a pool the shopper's own request has already verified.
    if (VERIFY_ENABLED && settled.pool.length > 0 && !trace) {
      void searchComponent(imageUrl, crops, componentIndex, title, description, "verified").catch(
        () => [],
      );
    }
    if (trace) {
      trace.pooled = settled.pool.length;
      trace.durationMs = Date.now() - startedAt;
    }
    logNet("COMPONENT", {
      durationMs: Date.now() - startedAt,
      component: crop.label,
      category: crop.category,
      stage: "fast",
      partial: settled.partial,
      pooled: settled.pool.length,
      final: out.length,
    });
    return { matches: out, partial: settled.partial };
  }

  let out: RawVisualMatch[];
  let lookRejected = 0;
  let verifierBlind = false;
  // How many of this tab's cards get a verdict. The pin's budget is split
  // across its components, so a lone product is verified deeply and a busy
  // six-object pin spends its calls across all six tabs instead of exhausting
  // them on the first.
  const headSize = Math.min(
    PER_TAG_MAX,
    Math.max(VERIFY_HEAD_MIN, Math.ceil(VERIFY_BUDGET_PER_PIN / Math.max(1, crops.length))),
  );

  if (VERIFY_ENABLED && pool.length > 0) {
    // Verify in WAVES, best-ranked first, and only until `headSize` cards
    // have survived. A wave costs one round trip against a proxy that answers
    // in ~2-25s, so the count is the cost: the common case (few rejections)
    // pays exactly one round, and only a tab full of lookalikes digs deeper.
    //
    // One shared deadline across all waves; a verdict that misses it counts
    // as null (kept, unverified) while its call keeps running into the cache.
    const deadline = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), VERIFY_DEADLINE_MS).unref?.(),
    );
    const judged: Array<{ c: Cand; v: LookVerdict | null }> = [];
    let seenAny = false;
    let at = 0;
    // Waves are SEQUENTIAL, so their count is a latency multiplier: a tab
    // whose candidates were all rejected used to walk the entire pool three
    // and four rounds deep, which is how one empty tab reached 44s. Two
    // rounds is the whole budget. Nothing is lost by stopping — a third round
    // only ever contained cards ranked below ones already judged "different".
    let spent = 0;
    // The first wave buys a small OVERSHOOT past the head. Rejections are the
    // normal case, not the exception, and every one of them used to cost a
    // second sequential round trip to replace a single card. Two spare
    // verdicts up front absorb that in the round already being paid for, and
    // a verdict is never wasted: it is cached by (thumbnail, target) and
    // answers instantly for every later scan of the same product.
    for (; at < pool.length && judged.length < headSize && spent < headSize * VERIFY_MAX_WAVES;) {
      const overshoot = spent === 0 ? VERIFY_OVERSHOOT : 0;
      const want = Math.min(
        headSize - judged.length + overshoot,
        headSize * VERIFY_MAX_WAVES - spent,
      );
      const wave = pool.slice(at, at + want);
      if (wave.length === 0) break;
      at += wave.length;
      spent += wave.length;
      const verdicts = await Promise.all(
        // A traced run reads verdicts from cache ONLY. The look gate is the one
        // stage that costs a model call per card, and opening a debug panel must
        // never buy any: by the time it opens, the head this pin actually
        // verified is in the cache, and anything outside it is honestly reported
        // as unjudged rather than paid for again.
        wave.map((c) =>
          trace
            ? lookVerdictCached(crop, c.m.thumbnail)
            : Promise.race([looksSame(crop, c.m.thumbnail, c.m.title), deadline]),
        ),
      );
      seenAny ||= verdicts.some((v) => v !== null);
      wave.forEach((c, i) => {
        const v = verdicts[i];
        trace?.verdicts.push({ link: canonicalizeProductUrl(c.m.link), verdict: v });
        if (v !== "different") judged.push({ c, v });
        else {
          lookRejected++;
          trace?.poolDrops.push({ m: c.m, score: c.score, reason: "look_different" });
        }
      });
    }
    // Everything past the verified head fills the rest of the tab unjudged —
    // still ranked, still real candidates, just without a lookMatch badge.
    // Spending the whole budget here is what made a four-object pin take ~50s;
    // dropping these instead would cost product count, which matters more.
    const tail = pool.slice(at).map((c) => ({ c, v: null as LookVerdict | null }));

    // Blind = not one candidate anywhere produced a real verdict. Only then
    // does the title-based `landed` heuristic get its old veto back — and
    // only over crop-sourced candidates, since whole-image candidates already
    // had to name this category in their title to enter the pool.
    verifierBlind = !seenAny;
    const all = [...judged, ...tail];
    const kept = verifierBlind && !landed ? all.filter(({ c }) => !c.fromCrop) : all;
    lookRejected += all.length - kept.length;
    if (trace) {
      const survived = new Set(kept.map(({ c }) => c));
      for (const { c } of all)
        if (!survived.has(c))
          // Distinct from `look_different`: the live pipeline folds both into one
          // `lookRejected` counter, which is why "the verifier was blind and the
          // box didn't land" has never been separable from a real rejection.
          trace.poolDrops.push({ m: c.m, score: c.score, reason: "verifier_blind_veto" });
    }
    const ordered = kept.sort(
      (a, b) => verdictRank(a.v) - verdictRank(b.v) || a.c.score - b.c.score,
    );
    if (trace) {
      for (const { c } of ordered.slice(PER_TAG_MAX))
        trace.poolDrops.push({ m: c.m, score: c.score, reason: "tab_cap" });
      trace.final = ordered
        .slice(0, PER_TAG_MAX)
        .map(({ c, v }, i) => ({ m: c.m, rank: i, score: c.score, verdict: v }));
      trace.verifierBlind = verifierBlind;
      trace.headSize = headSize;
    }
    out = ordered.slice(0, PER_TAG_MAX).map(({ c, v }) => ({
      ...toRawVisualMatch(c.m),
      tag: crop.label,
      score: c.score,
      ...(v ? { lookMatch: v as "same" | "close" } : {}),
    }));
  } else {
    const eligible = pool.filter((c) => {
      const ok = c.fromCrop ? landed : true;
      if (!ok) trace?.poolDrops.push({ m: c.m, score: c.score, reason: "landed_veto" });
      return ok;
    });
    const ordered = eligible.sort((a, b) => a.score - b.score);
    if (trace) {
      for (const c of ordered.slice(PER_TAG_MAX))
        trace.poolDrops.push({ m: c.m, score: c.score, reason: "tab_cap" });
      trace.final = ordered
        .slice(0, PER_TAG_MAX)
        .map((c, i) => ({ m: c.m, rank: i, score: c.score, verdict: null }));
      // This branch is also reached by an empty pool, which is not the same
      // thing as the gate being switched off — only claim the latter.
      trace.verifyDisabled = !VERIFY_ENABLED;
    }
    out = ordered
      .slice(0, PER_TAG_MAX)
      .map((c) => ({ ...toRawVisualMatch(c.m), tag: crop.label, score: c.score }));
  }

  if (trace) {
    trace.pooled = pool.length;
    trace.lookRejected = lookRejected;
    trace.durationMs = Date.now() - startedAt;
  }

  logNet("COMPONENT", {
    durationMs: Date.now() - startedAt,
    component: crop.label,
    category: crop.category,
    stage: "verified",
    cropResults: built.cropResults,
    widened: built.widened,
    wholeResults: built.wholeResults,
    pooled: pool.length,
    landed,
    verifierBlind,
    lookRejected,
    final: out.length,
  });
  return { matches: out, partial: false };
}

type Cand = { m: LensMatch; score: number; fromCrop: boolean };

/** Build (or join) the candidate pool for one component.
 *
 * Everything both stages share lives here: the two Lens sources, the widen
 * rescue, the category gate, the niche ranking and the dedupe. Memoised per
 * (image, component, title) because the verified stage runs seconds or minutes
 * after the fast one in the same process and must not repeat any of it.
 *
 * `impatient` is what the fast stage passes: build from whatever has landed
 * rather than waiting for the last source. A partial pool is never cached —
 * it would otherwise deny the next caller the full one.
 */
async function componentPool(
  imageUrl: string,
  crops: Crop[],
  componentIndex: number,
  title: string,
  description: string,
  impatient = false,
  trace?: ComponentTrace,
): Promise<ComponentPool | null> {
  const key = componentKey(imageUrl, componentIndex, "pool", title);
  // A traced build always runs the real thing: a cached pool would answer
  // correctly and record nothing, which is the one outcome a debug view cannot
  // use. Every expensive input (detection, each Lens region) is cached
  // underneath, and everything this repeats is deterministic, so the replay
  // costs no API calls and reaches the same pool.
  if (!trace) {
    const cached = poolCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
  }
  // An impatient build never joins (or becomes) the shared entry: the full
  // build it would join is precisely the wait it exists to skip.
  if (impatient)
    return buildComponentPool(imageUrl, crops, componentIndex, title, description, true, trace);
  if (trace)
    return buildComponentPool(imageUrl, crops, componentIndex, title, description, false, trace);
  const existing = poolInFlight.get(key);
  if (existing) return existing;

  const run = buildComponentPool(imageUrl, crops, componentIndex, title, description, false)
    .then((result) => {
      poolCache.set(key, { expires: Date.now() + POOL_TTL_MS, result });
      return result;
    })
    .finally(() => poolInFlight.delete(key));
  poolInFlight.set(key, run);
  return run;
}

async function buildComponentPool(
  imageUrl: string,
  crops: Crop[],
  componentIndex: number,
  title: string,
  description: string,
  impatient: boolean,
  /** Debug sink. Every `trace?.` call below is inert in production — nothing on
   * the match path passes one. See the funnel trace section further down. */
  trace?: ComponentTrace,
): Promise<ComponentPool | null> {
  if (!crops[componentIndex]) return null;
  const crop = crops[componentIndex];
  const queryWords = extractKeywords(`${title} ${description}`);

  // TWO candidate sources, searched in parallel and merged. Measured on real
  // pins, the whole-image search returns FAR more supported-retailer results
  // than the region search (47 vs 6 on the same pin) and its top results are
  // visually closer — Google anchors the dominant object with full context.
  // The region search is still what surfaces the secondary objects (the bag
  // beside the shirt) and is the only source when the object is small. And
  // when a detector box misses its object outright — boxes are estimates, and
  // a bad one returns literally zero results — the whole-image pool is what
  // keeps that component from rendering an empty tab.
  //
  // The whole-image call is ONE cache entry shared by every component of the
  // pin (and the no-detection sentinel path), so the marginal cost of the
  // second source is a single extra Lens call per pin, total.
  //
  // WIDEN SEARCH. A small object's tight crop starves: measured on a real
  // outfit pin, the glasses crop returned 5 results and ZERO from a supported
  // retailer, while the same box at 2× returned 60 with 22 eyewear listings.
  // For a box small enough to predict that, the widened search is ISSUED in
  // the same wave as the other two so it is already in flight if needed —
  // but it is deliberately NOT awaited with them. Awaiting it made every
  // small-object tab wait for a search that, most of the time, its own crop
  // results made unnecessary: a speculative call is only free if nothing
  // blocks on it.
  const wideCrop =
    crop.crop && crop.box.w * crop.box.h < WIDEN_SPECULATE_BELOW_AREA
      ? lensCropParam(widenBox(crop.box, WIDEN_FACTOR))
      : null;

  const cropSearch = crop.crop
    ? searchGoogleLens(imageUrl, crop.crop).catch(() => [] as LensMatch[])
    : Promise.resolve([] as LensMatch[]);
  const wholeSearch = searchGoogleLens(imageUrl).catch(() => [] as LensMatch[]);
  const wideSearch =
    wideCrop && wideCrop !== crop.crop
      ? searchGoogleLens(imageUrl, wideCrop).catch(() => [] as LensMatch[])
      : null;

  // WHICH SOURCE THE TAB WAITS FOR is the difference between a scan that feels
  // live and one that doesn't.
  //
  // The whole-image search starts at t=0 (before detection has even named the
  // objects); a region search cannot start until detection has produced its
  // box, so it lands the better part of a detection later — on a cold pin,
  // ~10s versus ~19s. Waiting for both means every tab pays the later of the
  // two before it can show anything.
  //
  // So the fast stage waits for the FIRST source to answer, gives the other a
  // short grace, and builds from what it has. The verified stage always waits
  // for everything, so nothing is lost — the missing source arrives as part of
  // the refinement the shopper is already going to see.
  let cropRaw: LensMatch[] | null;
  let wholeRaw: LensMatch[] | null;
  // A component whose box covered the whole frame has no region search of its
  // own (`crop.crop` is null and `cropSearch` is an empty placeholder), so
  // there is only one source to wait for and nothing to be impatient about.
  if (impatient && crop.crop) {
    await Promise.race([cropSearch, wholeSearch]);
    [cropRaw, wholeRaw] = await Promise.all([
      settledWithin(cropSearch, FAST_SOURCE_GRACE_MS),
      settledWithin(wholeSearch, FAST_SOURCE_GRACE_MS),
    ]);
  } else {
    [cropRaw, wholeRaw] = await Promise.all([cropSearch, wholeSearch]);
  }
  const partial = cropRaw === null || wholeRaw === null;
  const cropRejects: LensMatch[] = [];
  let cropOwn = filterSupportedRetailers(cropRaw ?? [], trace && cropRejects);
  trace?.searches.push({
    kind: "crop",
    cropParam: crop.crop,
    box: crop.box,
    answered: cropRaw !== null,
    rawCount: cropRaw?.length ?? 0,
    keptCount: cropOwn.length,
    unsupported: hostTally(cropRejects),
    origin: lensOrigin(imageUrl, crop.crop),
  });

  let widened = false;
  if (cropRaw !== null && cropOwn.length < WIDEN_RETRY_BELOW && crop.crop) {
    // Already in flight for a small box; for a larger one that starved anyway,
    // issue it now — except in the impatient build, which takes the widened
    // results only if they are already sitting there. Blocking on a third Lens
    // call is the opposite of what that stage is for.
    let wide: LensMatch[] | null = null;
    if (wideSearch) {
      wide = impatient ? await settledWithin(wideSearch, 0) : await wideSearch;
    } else if (!impatient) {
      const late = lensCropParam(widenBox(crop.box, WIDEN_FACTOR));
      if (late && late !== crop.crop) {
        wide = await searchGoogleLens(imageUrl, late).catch(() => [] as LensMatch[]);
      }
    }
    const wideRejects: LensMatch[] = [];
    const wideOwn = wide ? filterSupportedRetailers(wide, trace && wideRejects) : null;
    if (wideOwn && wideOwn.length > cropOwn.length) {
      // Merge rather than replace: the tight crop's few results are the
      // best-anchored ones there are, so they keep their lead.
      const held = new Set(cropOwn.map((m) => canonicalizeProductUrl(m.link)));
      cropOwn = [...cropOwn, ...wideOwn.filter((m) => !held.has(canonicalizeProductUrl(m.link)))];
      widened = true;
    }
    // Recorded whether or not the merge was taken: "the widen fired and was
    // rejected because it found no more than the tight crop" is a distinct
    // answer from "the widen never ran", and the live pipeline keeps neither.
    if (trace) {
      const wideParam = wideCrop ?? lensCropParam(widenBox(crop.box, WIDEN_FACTOR));
      trace.searches.push({
        kind: "widened",
        cropParam: wideParam,
        box: widenBox(crop.box, WIDEN_FACTOR),
        answered: wide !== null,
        rawCount: wide?.length ?? 0,
        keptCount: wideOwn?.length ?? 0,
        unsupported: hostTally(wideRejects),
        origin: lensOrigin(imageUrl, wideParam),
        merged: widened,
        speculated: !!wideCrop,
      });
    }
  }

  const wholeRejects: LensMatch[] = [];
  const wholeOwn = filterSupportedRetailers(wholeRaw ?? [], trace && wholeRejects);
  trace?.searches.push({
    kind: "whole",
    cropParam: null,
    box: null,
    answered: wholeRaw !== null,
    rawCount: wholeRaw?.length ?? 0,
    keptCount: wholeOwn.length,
    unsupported: hostTally(wholeRejects),
    origin: lensOrigin(imageUrl, null),
  });

  const niche = detectNiche([...cropOwn, ...wholeOwn], { title, description });
  const labelWords = extractKeywords(crop.label);

  // Did even one region-search title read as the crop's own category? This is
  // the evidence that the box landed on its object (a missed box once returned
  // a page of elevator control panels for a "top"). It used to be a hard gate
  // and killed whole components whose titles just didn't parse; now the look
  // gate is the primary evidence and this is only the fallback veto for
  // crop-sourced candidates when the verifier is blind.
  const cropCategorised = cropOwn.map((m) => ({ m, cat: categoryOfTitle(m.title) }));
  const landed = crop.category === "other" || cropCategorised.some((c) => c.cat === crop.category);

  // Gates differ by source. Crop results are lenient (an unparseable title is
  // more likely a bad title than a wrong product — the region already selected
  // for this object). Whole-image results contain EVERY object in the pin, so
  // an unparseable title there could be the jeans as easily as the shirt: they
  // must positively name this component's category to enter the pool. A crop
  // with no category ("other") takes only its own region's results.
  const cands: Cand[] = [];
  for (const { m, cat } of cropCategorised) {
    if (!categoriesAgree(crop.category, cat)) {
      trace?.gate.push({ m, cat, from: "crop", kept: false, reason: "category_conflict" });
      continue;
    }
    const labelHits = keywordOverlap(extractKeywords(m.title), labelWords);
    const score = baseScore(m, queryWords, niche) - labelHits * 6;
    trace?.gate.push({ m, cat, from: "crop", kept: true, score, labelHits });
    cands.push({ m, score, fromCrop: true });
  }
  if (crop.category !== "other") {
    for (const m of wholeOwn) {
      const cat = categoryOfTitle(m.title);
      if (cat === "other" || !categoriesAgree(crop.category, cat)) {
        trace?.gate.push({
          m,
          cat,
          from: "whole",
          kept: false,
          // Two different rules, and telling them apart is the point: an
          // unreadable title is a vocabulary gap, a conflict is the gate
          // working.
          reason: cat === "other" ? "whole_needs_category" : "category_conflict",
        });
        continue;
      }
      const labelHits = keywordOverlap(extractKeywords(m.title), labelWords);
      const score = baseScore(m, queryWords, niche) - labelHits * 6;
      trace?.gate.push({ m, cat, from: "whole", kept: true, score, labelHits });
      cands.push({ m, score, fromCrop: false });
    }
  } else if (trace) {
    // The whole-image source is skipped WHOLE for an "other" crop. Without this
    // the trace would look as though the search simply returned nothing usable.
    for (const m of wholeOwn) {
      trace.gate.push({
        m,
        cat: categoryOfTitle(m.title),
        from: "whole",
        kept: false,
        reason: "crop_category_other",
      });
    }
  }

  // Best first, one card per product (a product found by both sources keeps
  // its better-scoring occurrence, and counts as crop-confirmed if either
  // source was the crop), pooled for verification.
  const bySource = new Map<string, Cand>();
  for (const c of cands.sort((a, b) => a.score - b.score)) {
    const link = canonicalizeProductUrl(c.m.link);
    const held = bySource.get(link);
    if (!held) {
      if (bySource.size < VERIFY_POOL_MAX) bySource.set(link, c);
      else trace?.poolDrops.push({ m: c.m, score: c.score, reason: "pool_cap" });
    } else if (c.fromCrop && !held.fromCrop) {
      held.fromCrop = true;
      trace?.poolDrops.push({ m: c.m, score: c.score, reason: "duplicate_promoted_crop" });
    } else {
      trace?.poolDrops.push({ m: c.m, score: c.score, reason: "duplicate" });
    }
  }

  if (trace) {
    trace.niche = niche?.key ?? null;
    trace.landed = landed;
    trace.widened = widened;
    trace.partial = partial;
    trace.cropResults = cropOwn.length;
    trace.wholeResults = wholeOwn.length;
    trace.queryWords = [...queryWords];
    trace.labelWords = [...labelWords];
  }

  return {
    crop,
    pool: [...bySource.values()],
    partial,
    landed,
    widened,
    cropResults: cropOwn.length,
    wholeResults: wholeOwn.length,
  };
}

// =============================================================================
// FUNNEL DEBUG TRACE
//
// The pipeline above is eleven stages long, every one of them lossy, and until
// now it reported only COUNTS: `FILTER before=47 after=6` tells you forty-one
// results were thrown away and nothing about which, and the category gate — the
// stage most likely to be the reason a tab is wrong — logged nothing whatsoever.
// So "the products under this pill are wrong" was not a debuggable complaint.
// You could see the answer and the totals, never the decisions in between.
//
// This section is the answer to that. It is deliberately NOT a second copy of
// the funnel: every fact below is recorded by the real functions as they run
// (`trace?.push(...)` at each gate), because a re-implementation would drift
// from the thing it describes and then quietly lie — the exact failure the
// category-vocabulary comment further up this file warns about.
//
// Three rules keep it honest and free:
//   1. Nothing on the match path passes a trace, so every hook is inert in
//      production. No payload grows, no cache key changes.
//   2. A traced run BYPASSES the pool and component memos (a cached answer
//      records nothing) but still reads every underlying cache — detection,
//      each Lens region, each verdict — so the replay makes no paid API call
//      and, because every stage between them is deterministic, reproduces the
//      same tab the shopper is looking at.
//   3. The look gate is read CACHE-ONLY when tracing. Opening this panel must
//      never buy a vision call; a candidate the pin never verified is reported
//      as unjudged rather than judged now.
// =============================================================================

/** Where each gate's rejects came from, and why each one is not on screen. */
export type DropReason =
  | "category_conflict"
  | "whole_needs_category"
  | "crop_category_other"
  | "full_image_cap"
  | "pool_cap"
  | "duplicate"
  | "duplicate_promoted_crop"
  | "landed_veto"
  | "look_different"
  | "verifier_blind_veto"
  | "tab_cap";

/** The mutable sink the instrumented functions write into. Internal — it holds
 * `LensMatch` objects; `toWireComponent` projects it to the client shape. */
type ComponentTrace = {
  searches: Array<{
    kind: "crop" | "widened" | "whole";
    cropParam: string | null;
    box: Box | null;
    /** False when the fast stage's grace expired before this source landed. */
    answered: boolean;
    rawCount: number;
    keptCount: number;
    unsupported: Array<{ host: string; count: number }>;
    origin: LensOrigin | "memory" | "unknown";
    merged?: boolean;
    speculated?: boolean;
  }>;
  gate: Array<{
    m: LensMatch;
    cat: ProductCategory;
    from: "crop" | "whole";
    kept: boolean;
    reason?: DropReason;
    score?: number;
    labelHits?: number;
  }>;
  poolDrops: Array<{ m: LensMatch; score: number; reason: DropReason }>;
  verdicts: Array<{ link: string; verdict: LookVerdict | null }>;
  final: Array<{ m: LensMatch; rank: number; score?: number; verdict: LookVerdict | null }>;
  niche: string | null;
  landed: boolean;
  widened: boolean;
  partial: boolean;
  verifierBlind: boolean;
  verifyDisabled: boolean;
  cropResults: number;
  wholeResults: number;
  pooled: number;
  lookRejected: number;
  headSize: number;
  queryWords: string[];
  labelWords: string[];
  durationMs: number;
};

function newComponentTrace(): ComponentTrace {
  return {
    searches: [],
    gate: [],
    poolDrops: [],
    verdicts: [],
    final: [],
    niche: null,
    landed: false,
    widened: false,
    partial: false,
    verifierBlind: false,
    verifyDisabled: false,
    cropResults: 0,
    wholeResults: 0,
    pooled: 0,
    lookRejected: 0,
    headSize: 0,
    queryWords: [],
    labelWords: [],
    durationMs: 0,
  };
}

/** Rejected links grouped by host, commonest first — "42 dropped" is a number,
 * "38 from aliexpress.com" is a diagnosis. */
function hostTally(matches: LensMatch[]): Array<{ host: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of matches) {
    let host: string;
    try {
      host = new URL(m.link).hostname.replace(/^www\./, "");
    } catch {
      host = "(unparseable)";
    }
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count);
}

/** Whether this region's results are sitting in memory, and if so where they
 * originally came from. Answers "I re-scanned and nothing changed" — a week-old
 * `lens_searches` row is the usual reason. */
function lensOrigin(imageUrl: string, crop: string | null): LensOrigin | "memory" | "unknown" {
  const entry = lensCache.get(JSON.stringify([imageUrl, crop ?? ""]));
  if (!entry || entry.expires <= Date.now()) return "unknown";
  return entry.origin;
}

/** The look verdict for this candidate IF one is already known, without ever
 * calling the model. Checks the in-process cache, then the durable row. */
async function lookVerdictCached(
  crop: Crop,
  thumbnail: string | null,
): Promise<LookVerdict | null> {
  if (!thumbnail) return null;
  const target = verdictTarget(crop);
  const cached = verifyCache.get(JSON.stringify([thumbnail, target]));
  if (cached && cached.expires > Date.now()) return cached.verdict;
  return loadVerdictRow(thumbnail, target);
}

/* ---------------- The wire shape ---------------- */

/** One candidate as the debug panel sees it. */
export type FunnelCandidate = {
  title: string;
  link: string;
  source: string;
  thumbnail: string | null;
  price: string | null;
  /** Google's own result position within its search — the raw similarity proxy. */
  position: number;
  /** What `categoryOfTitle` read the RETAILER's title as. */
  titleCategory: ProductCategory;
  /** Which Lens search produced it. "both" means the region search and the
   * whole-image search independently found the same listing. */
  from: "crop" | "whole" | "both";
  /** Rank score, lower better. Absent for candidates dropped before scoring. */
  score?: number;
  /** How many of the pill's own label words appear in the title. */
  labelHits?: number;
  /** The look gate's verdict, when one was already known. */
  verdict?: LookVerdict | null;
  /** Absent when this candidate is on screen. */
  droppedAt?: DropReason;
  /** Its position in the tab, when it survived. */
  finalRank?: number;
};

export type FunnelSearch = ComponentTrace["searches"][number];

/** One detected object, all the way through to its tab. */
export type FunnelComponent = {
  key: number;
  label: string;
  category: ProductCategory;
  /** The object's look as detection described it — the look gate's target. */
  signature: string;
  /** Normalised 0-1, and PADDED (see `paddingFor`) — what was actually sent. */
  box: Box | null;
  /** SearchAPI's region string, or null when the box was near-full-frame and
   * this component shares the whole-image search instead. */
  cropParam: string | null;
  /** Share of the frame, 0-1. Under 0.12 warms a speculative widened search. */
  boxArea: number;
  searches: FunnelSearch[];
  candidates: FunnelCandidate[];
  niche: string | null;
  landed: boolean;
  widened: boolean;
  partial: boolean;
  verifierBlind: boolean;
  verifyDisabled: boolean;
  cropResults: number;
  wholeResults: number;
  pooled: number;
  headSize: number;
  queryWords: string[];
  labelWords: string[];
  durationMs: number;
};

export type FunnelTrace = {
  imageUrl: string;
  /** The title/description the RANKING used — the pin row's copy wins over the
   * caller's, and a mismatch here silently changes every cache key. */
  title: string;
  description: string;
  stage: ComponentStage;
  detection: {
    objects: number;
    /** True when the detector explicitly found nothing purchasable. Note this
     * is also what an unfetchable image collapses to. */
    noProducts: boolean;
    /** The component list is exactly `CROP_MAX` long, so the detector may have
     * found more objects and had them truncated. Deliberately a "maybe": the
     * only way to know is a second detection, and this panel is not allowed to
     * buy a model call. */
    atCropCap: boolean;
    durationMs: number;
  };
  components: FunnelComponent[];
  /** The limits every count above is measured against. */
  limits: {
    cropMax: number;
    perTagMax: number;
    fullImageMax: number;
    verifyPoolMax: number;
    widenRetryBelow: number;
    widenFactor: number;
    widenSpeculateBelowArea: number;
    verifyBudgetPerPin: number;
    verifyEnabled: boolean;
    detectEnabled: boolean;
  };
  durationMs: number;
};

function toWireCandidates(t: ComponentTrace): FunnelCandidate[] {
  const verdictByLink = new Map(t.verdicts.map((v) => [v.link, v.verdict]));
  const finalByLink = new Map(t.final.map((f) => [canonicalizeProductUrl(f.m.link), f] as const));
  const dropByLink = new Map(
    t.poolDrops.map((d) => [canonicalizeProductUrl(d.m.link), d] as const),
  );

  const base = (
    m: LensMatch,
    extra: Partial<FunnelCandidate> & Pick<FunnelCandidate, "from" | "titleCategory">,
  ): FunnelCandidate => {
    const link = canonicalizeProductUrl(m.link);
    const fin = finalByLink.get(link);
    const drop = fin ? undefined : dropByLink.get(link);
    return {
      title: m.title,
      link,
      source: m.source,
      thumbnail: m.thumbnail,
      price: m.price?.value ?? null,
      position: m.position,
      verdict: verdictByLink.get(link) ?? undefined,
      finalRank: fin?.rank,
      droppedAt: drop?.reason,
      ...extra,
    };
  };

  // Every candidate the gate SAW, kept or not, COLLAPSED BY PRODUCT — the same
  // listing legitimately reaches the gate from both the region and the
  // whole-image search, and the pool itself keeps one of the two. Reporting both
  // rows would show one card twice, sharing a rank it only holds once. The kept,
  // better-scoring row wins and its source becomes "both", which is worth
  // knowing: a product confirmed by both searches is the strongest signal the
  // pipeline has.
  const byLink = new Map<string, FunnelCandidate>();
  for (const { m, cat, from, kept, reason, score, labelHits } of t.gate) {
    const row = base(m, {
      from,
      titleCategory: cat,
      score,
      labelHits,
      ...(kept ? {} : { droppedAt: reason }),
    });
    const held = byLink.get(row.link);
    if (!held) {
      byLink.set(row.link, row);
      continue;
    }
    const heldKept = held.droppedAt == null;
    const rowWins = heldKept === kept ? (row.score ?? Infinity) < (held.score ?? Infinity) : kept;
    const winner = rowWins ? row : held;
    byLink.set(row.link, { ...winner, from: held.from === row.from ? winner.from : "both" });
  }

  // A tab's final cards must appear even on the whole-image path, which records
  // no per-candidate gate rows of its own.
  for (const f of t.final) {
    const link = canonicalizeProductUrl(f.m.link);
    if (byLink.has(link)) continue;
    byLink.set(
      link,
      base(f.m, { from: "whole", titleCategory: categoryOfTitle(f.m.title), score: f.score }),
    );
  }

  const out = [...byLink.values()];

  // Survivors first, in tab order; then everything that was dropped, best-
  // scoring first, because the near-misses are what you came to look at.
  return out.sort((a, b) => {
    if (a.finalRank != null && b.finalRank != null) return a.finalRank - b.finalRank;
    if (a.finalRank != null) return -1;
    if (b.finalRank != null) return 1;
    return (a.score ?? a.position) - (b.score ?? b.position);
  });
}

/**
 * Run the whole funnel for one image and report every decision it made.
 *
 * `stage` picks WHICH answer to explain: "fast" is the tab the shopper saw
 * first, "verified" is the one that replaced it. Tracing the fast stage is the
 * right choice when the complaint is "the wrong products appeared"; the
 * verified stage when it is "a product I wanted disappeared".
 */
export async function traceVisualFunnel(
  imageUrl: string,
  title = "",
  description = "",
  stage: ComponentStage = "verified",
): Promise<FunnelTrace> {
  const startedAt = Date.now();
  const detectStart = Date.now();
  const { crops, noProducts } = await cropResultFor(imageUrl);
  const detectMs = Date.now() - detectStart;

  // Keys exactly as the client asks for them: the detected components, or the
  // whole-image sentinel when the detector explicitly found nothing.
  const keys = crops.length ? crops.map((_, i) => i) : noProducts ? [-1] : [];

  const components = await Promise.all(
    keys.map(async (key): Promise<FunnelComponent> => {
      const trace = newComponentTrace();
      await searchComponent(imageUrl, crops, key, title, description, stage, trace).catch(() => []);
      const crop = crops[key];
      return {
        key,
        label: crop?.label ?? "Whole image",
        category: crop?.category ?? "other",
        signature: crop?.signature ?? "",
        box: crop?.box ?? null,
        cropParam: crop?.crop ?? null,
        boxArea: crop ? crop.box.w * crop.box.h : 1,
        searches: trace.searches,
        candidates: toWireCandidates(trace),
        niche: trace.niche,
        landed: trace.landed,
        widened: trace.widened,
        partial: trace.partial,
        verifierBlind: trace.verifierBlind,
        verifyDisabled: trace.verifyDisabled,
        cropResults: trace.cropResults,
        wholeResults: trace.wholeResults,
        pooled: trace.pooled,
        headSize: trace.headSize,
        queryWords: trace.queryWords,
        labelWords: trace.labelWords,
        durationMs: trace.durationMs,
      };
    }),
  );

  return {
    imageUrl,
    title,
    description,
    stage,
    detection: {
      objects: crops.length,
      noProducts,
      atCropCap: crops.length >= CROP_MAX,
      durationMs: detectMs,
    },
    components,
    limits: {
      cropMax: CROP_MAX,
      perTagMax: PER_TAG_MAX,
      fullImageMax: FULL_IMAGE_MAX,
      verifyPoolMax: VERIFY_POOL_MAX,
      widenRetryBelow: WIDEN_RETRY_BELOW,
      widenFactor: WIDEN_FACTOR,
      widenSpeculateBelowArea: WIDEN_SPECULATE_BELOW_AREA,
      verifyBudgetPerPin: VERIFY_BUDGET_PER_PIN,
      verifyEnabled: VERIFY_ENABLED,
      detectEnabled: DETECT_ENABLED,
    },
    durationMs: Date.now() - startedAt,
  };
}

// Composes every stage above: detect → per-component Lens → category gate →
// rank → dedupe across tabs → project to the public shape. This is the fast
// half of the pipeline (no CK wait); `validateMatches` (below) is the slow
// half, run independently per card by the client.
//
// Callers that render progressively should NOT use this — it resolves only
// once every component has, which is as slow as the slowest one. It exists for
// the batch consumers (board bulk approve) that need the complete set in one
// value. The interactive screens call `visualSearchComponents` and then one
// `visualSearchComponent` per tab, so each tab paints as it lands.
async function searchByImageRaw(
  imageUrl: string,
  title = "",
  description = "",
): Promise<RawVisualMatch[]> {
  const totalStart = Date.now();
  const { crops, noProducts } = await cropResultFor(imageUrl);

  if (noProducts) {
    const out = await searchComponent(imageUrl, crops, -1, title, description);
    logNet("TOTAL", {
      durationMs: Date.now() - totalStart,
      source: "no_objects",
      final: out.length,
    });
    return out;
  }

  if (crops.length === 0) {
    logNet("TOTAL", {
      durationMs: Date.now() - totalStart,
      source: "no_crops",
      final: 0,
    });
    return [];
  }

  const perComponent = await Promise.all(
    crops.map((_, i) => searchComponent(imageUrl, crops, i, title, description)),
  );

  // A product that qualified for two tabs belongs to the one it scores best
  // under, rather than to whichever component's search happened to finish
  // first — that ordering accident is how a bag ended up filed under
  // "Sneakers".
  const best = new Map<string, RawVisualMatch>();
  for (const m of perComponent.flat()) {
    const held = best.get(m.link);
    if (!held || (m.score ?? 0) < (held.score ?? 0)) best.set(m.link, m);
  }

  // Emit tab by tab in detection order (most prominent object first). Two crops
  // can share a label — merge them rather than repeating the tab.
  const out: RawVisualMatch[] = [];
  for (const label of [...new Set(crops.map((c) => c.label))]) {
    out.push(
      ...[...best.values()]
        .filter((m) => m.tag === label)
        .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
        .slice(0, PER_TAG_MAX),
    );
  }

  logNet("TOTAL", {
    durationMs: Date.now() - totalStart,
    source: `crops:${crops.length}`,
    tags: [...new Set(crops.map((c) => c.label))].join(","),
    final: out.length,
  });
  return out;
}

// Cross-check every match against the real retailer page for a live price,
// keeping every match that ends up with *any* usable price — CK's live figure
// when it resolves, otherwise the price Google Lens already reported. Only a
// match with no price from either source is dropped (nothing to show or
// attach). Stock status no longer gates inclusion: an out-of-stock item still
// carries a real price and stays attachable. `fetchCkProductDetails` already
// routes through the module-level `ckLimit`, so concurrency here is bounded
// process-wide. `Promise.allSettled` (not `Promise.all`) means one slow or
// failing retailer never blocks the rest of the batch — always returns
// whatever set of matches ended up priced. Used by callers that need the
// complete, resolved set synchronously (bulk board approve); the interactive
// UI instead validates each match independently client-side (see
// `getProductDetails` below) so cards can render before this finishes.
async function validateMatches(matches: RawVisualMatch[]): Promise<VisualMatch[]> {
  const settled = await Promise.allSettled(matches.map((m) => fetchCkProductDetails(m.link)));
  const validated: Array<VisualMatch | null> = settled.map((outcome, i) => {
    const m = matches[i];
    const details =
      outcome.status === "fulfilled"
        ? outcome.value
        : (console.error("[validateMatches] CK lookup threw unexpectedly", m.link, outcome.reason),
          null);
    // Prefer the live CK price/MRP; fall back to the price Lens gave us so a
    // dead or unresolvable CK lookup no longer wipes out an otherwise real,
    // attachable listing. Drop only when neither source has a price.
    if (details) {
      return {
        ...m,
        mrp: details.mrp,
        price: {
          value: `₹${details.discountedPrice.toLocaleString("en-IN")}`,
          extractedValue: details.discountedPrice,
          currency: "₹",
        },
      };
    }
    if (m.price) {
      return { ...m, mrp: null, price: m.price, priceUnverified: true };
    }
    return null;
  });

  return validated.filter((m): m is VisualMatch => m !== null);
}

async function searchByImage(
  imageUrl: string,
  title = "",
  description = "",
): Promise<VisualMatch[]> {
  return validateMatches(await searchByImageRaw(imageUrl, title, description));
}

// Returns raw matches immediately — no CK wait. This is the fast path the
// interactive UI calls for progressive rendering: cards paint the moment
// this resolves, and each card's price/stock fills in independently via
// `getProductDetails` below.
export const visualSearchPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { pinId: string }) => z.object({ pinId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: pin, error } = await supabase
      .from("pins")
      .select("id,title,description,image_url")
      .eq("id", data.pinId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!pin) throw new Error("Pin not found");
    if (!pin.image_url) return { suggestions: [] as RawVisualMatch[] };

    try {
      return {
        suggestions: await searchByImageRaw(pin.image_url, pin.title, pin.description ?? ""),
      };
    } catch (e) {
      // A timeout is expected behavior (already logged once, plainly,
      // inside withRetry) — only a genuinely unexpected failure gets a
      // stack trace here, and only once.
      if (!(e instanceof TimeoutError)) console.error("[visualSearchPin] failed", e);
      return { suggestions: [] as RawVisualMatch[] };
    }
  });

// Same visual search but takes a raw image URL — used by the Create-pin
// wizard where no pin row exists yet. Also raw/fast — see visualSearchPin.
export const visualSearchImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { imageUrl: string; title?: string; description?: string }) =>
    z
      .object({
        imageUrl: z.string().url(),
        title: z.string().optional().default(""),
        description: z.string().optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      return { suggestions: await searchByImageRaw(data.imageUrl, data.title, data.description) };
    } catch (e) {
      if (!(e instanceof TimeoutError)) console.error("[visualSearchImage] failed", e);
      return { suggestions: [] as RawVisualMatch[] };
    }
  });

// -------------------------------------------------------------
// Streaming pair. Together these are what the interactive screens call, and
// the reason a scan now feels fast: the two halves of the search have very
// different costs, so they are two requests instead of one.
//
//   visualSearchComponents  — WHAT is in this pin. One model call (~6s cold,
//                             instant once cached). Answers with the product
//                             pills and nothing else.
//   visualSearchComponent   — the products for ONE pill (~5-14s, varying a lot
//                             by pill). The client fires one per pill, in
//                             parallel, and each grid fills as its own search
//                             lands rather than every grid waiting for the
//                             slowest.
//
// The old single call could only resolve when the slowest component did, so
// the user watched a scanner for ~14s and then everything appeared at once.
// -------------------------------------------------------------

/** The detected products in an image, as pills to render immediately.
 *
 * `key` indexes into the server's crop list and is what
 * `visualSearchComponent` takes back. `noProducts` means the detector found
 * nothing purchasable, and only then should the client ask for component -1
 * (the whole image) instead. */
export type VisualComponent = { key: number; label: string; category: ProductCategory };

export async function componentsForImage(
  imageUrl: string,
  title = "",
  description = "",
): Promise<{ components: VisualComponent[]; noProducts: boolean }> {
  // The whole-image search needs no boxes, so it does NOT wait for detection
  // — it is started first and runs THROUGH it. Detection is ~5s and this
  // search ~8s; run in sequence that was 13s before any tab could resolve,
  // and every component draws on this one shared result. Started here it is
  // already finished (or nearly) by the time the first tab asks for it.
  void searchGoogleLens(imageUrl).catch(() => []);

  const { crops, noProducts } = await cropResultFor(imageUrl);
  // Start every component's region search now, without waiting to be asked.
  // By the time the client has rendered the pills and come back for their
  // contents, the searches are in flight and get joined rather than re-issued.
  for (const c of crops) if (c.crop) void searchGoogleLens(imageUrl, c.crop).catch(() => []);
  // A small object's region starves and will trigger the widen retry inside
  // the pool build; that retry is otherwise SEQUENTIAL after its region
  // search returns. Warming it here — only for the boxes small enough to
  // predict it — turns that second round trip into a cache hit.
  for (const c of crops) {
    if (c.crop && c.box.w * c.box.h < WIDEN_SPECULATE_BELOW_AREA) {
      const wide = lensCropParam(widenBox(c.box, WIDEN_FACTOR));
      if (wide && wide !== c.crop) void searchGoogleLens(imageUrl, wide).catch(() => []);
    }
  }
  // ...and go all the way: assemble each tab in FULL, not just its searches.
  // The client cannot ask for a tab until this response has crossed the wire
  // and React has re-rendered the pills, and it then asks for the fast stage
  // first — so the expensive half has a head start of seconds, not
  // milliseconds, and the request that eventually asks for it joins work
  // already finished or in flight (see the componentInFlight join in
  // searchComponent) instead of beginning it.
  //
  // Warming the VERIFIED stage rather than the fast one is deliberate. It
  // builds the complete candidate pool, which the fast stage then finds
  // already cached and answers from instantly, AND it starts the look gate —
  // the one stage slow enough to be worth starting before anyone has asked.
  // Warming the fast stage instead would warm the half that was never the
  // problem.
  for (let key = 0; key < crops.length; key++) {
    void searchComponent(imageUrl, crops, key, title, description, "verified").catch(() => []);
  }
  return {
    components: crops.map((c, key) => ({ key, label: c.label, category: c.category })),
    noProducts,
  };
}

export const visualSearchComponents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  // title/description matter here even though this call only returns pills:
  // they are part of the ranking context, and therefore part of the cache key
  // every warmed tab is stored under. A client that withheld them and then sent
  // them with its per-tab requests warmed one key and read another — every
  // second of head start thrown away on a mismatch invisible from either side.
  // The echo in the response is what keeps the two in step.
  .validator((d: { pinId?: string; imageUrl?: string; title?: string; description?: string }) =>
    z
      .object({
        pinId: z.string().uuid().optional(),
        imageUrl: z.string().url().optional(),
        title: z.string().optional().default(""),
        description: z.string().optional().default(""),
      })
      .refine((v) => !!v.pinId || !!v.imageUrl, "pinId or imageUrl is required")
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let imageUrl = data.imageUrl ?? null;
    // The pin row wins when there is one — it is the copy the ranking was
    // computed against — and the caller's own is used for an image with no row
    // behind it yet (the create-pin wizard).
    let title = data.title;
    let description = data.description;

    if (data.pinId) {
      const { data: pin, error } = await context.supabase
        .from("pins")
        .select("id,title,description,image_url")
        .eq("id", data.pinId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!pin) throw new Error("Pin not found");
      imageUrl = pin.image_url;
      title = pin.title ?? "";
      description = pin.description ?? "";
    }

    if (!imageUrl)
      return {
        imageUrl: null,
        title,
        description,
        components: [] as VisualComponent[],
        noProducts: false,
      };

    try {
      return {
        imageUrl,
        title,
        description,
        ...(await componentsForImage(imageUrl, title, description)),
      };
    } catch (e) {
      // Detection is the one thing with no broad fallback left, so a failure
      // here is worth a line in the log; the client gets no components and
      // does not run whole-image Lens unless the detector explicitly reported
      // no products.
      console.error("[visualSearchComponents] failed", e);
      return {
        imageUrl,
        title,
        description,
        components: [] as VisualComponent[],
        noProducts: false,
      };
    }
  });

export const visualSearchComponent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: {
      imageUrl: string;
      componentKey: number;
      title?: string;
      description?: string;
      stage?: ComponentStage;
    }) =>
      z
        .object({
          imageUrl: z.string().url(),
          componentKey: z
            .number()
            .int()
            .min(-1)
            .max(CROP_MAX - 1),
          title: z.string().optional().default(""),
          description: z.string().optional().default(""),
          // Defaults to the full answer so any caller that doesn't know about
          // staging (or a client mid-deploy) gets the verified tab it always
          // got, just slower — never an unverified one it can't tell apart.
          stage: z.enum(["fast", "verified"]).optional().default("verified"),
        })
        .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      // Detection is cached by now (the components call just ran), so this is a
      // lookup, not a second model call.
      const { crops, noProducts } = await cropResultFor(data.imageUrl);
      if (data.componentKey < 0 && !noProducts) return { matches: [] as RawVisualMatch[] };
      return {
        matches: await searchComponent(
          data.imageUrl,
          crops,
          data.componentKey,
          data.title,
          data.description,
          data.stage,
        ),
      };
    } catch (e) {
      if (!(e instanceof TimeoutError)) console.error("[visualSearchComponent] failed", e);
      return { matches: [] as RawVisualMatch[] };
    }
  });

/** The whole funnel for one pin or image, every stage and every dropped
 * candidate — what the "Debug funnel" button on the matching-products screens
 * reads.
 *
 * Behind the same auth as every other visual-search call, and it needs no more
 * privilege than they do: it explains a search the caller can already run, over
 * an image they can already see. It buys nothing — detection, Lens and the look
 * verdicts are all read from cache — so it is safe to open repeatedly on the
 * same pin. */
export const visualSearchDebug = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: {
      pinId?: string;
      imageUrl?: string;
      title?: string;
      description?: string;
      stage?: ComponentStage;
    }) =>
      z
        .object({
          pinId: z.string().uuid().optional(),
          imageUrl: z.string().url().optional(),
          title: z.string().optional().default(""),
          description: z.string().optional().default(""),
          stage: z.enum(["fast", "verified"]).optional().default("verified"),
        })
        .refine((v) => !!v.pinId || !!v.imageUrl, "pinId or imageUrl is required")
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    let imageUrl = data.imageUrl ?? null;
    let title = data.title;
    let description = data.description;

    // Resolved exactly as `visualSearchComponents` resolves it, or the trace
    // would explain a search run under a different ranking context (and a
    // different cache key) than the one on screen.
    if (data.pinId) {
      const { data: pin, error } = await context.supabase
        .from("pins")
        .select("id,title,description,image_url")
        .eq("id", data.pinId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!pin) throw new Error("Pin not found");
      imageUrl = pin.image_url;
      title = pin.title ?? "";
      description = pin.description ?? "";
    }

    if (!imageUrl) throw new Error("This pin has no image to trace");
    return traceVisualFunnel(imageUrl, title, description, data.stage);
  });

// Per-URL CK lookup, callable directly by the client — the other half of
// progressive rendering. Each card fires this independently for its own
// `link` the moment it paints, so N cards resolve in parallel instead of
// the client waiting for one combined response covering all of them.
// Re-validates the retailer allowlist server-side (never trust a URL
// handed back from the client — this must never become an open proxy to
// arbitrary URLs against a paid third-party API) even though every URL
// reaching the client already passed the same filter in searchByImageRaw.
export const getProductDetails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { productUrl: string }) => z.object({ productUrl: z.string().url() }).parse(d))
  .handler(async ({ data }) => {
    if (!isSupportedRetailerLink(data.productUrl)) {
      return { details: null as CkResult };
    }
    return { details: await fetchCkProductDetails(data.productUrl) };
  });

// -------------------------------------------------------------
// Go Live — the one real "attach product(s) and publish" mechanism. Creates
// a fresh collection for the pin, attaches the given product(s) into it,
// and marks the pin live with a real external_url pointing at that
// collection on the creator's public storefront. Shared by the single-pin
// preview flow (pins_.preview.tsx) and board-level bulk monetization below
// — one real code path, not two divergent ones.
// -------------------------------------------------------------

async function performGoLive(
  supabase: SupabaseClient<Database>,
  userId: string,
  origin: string,
  pin: { id: string; title: string; image_url: string | null },
  storefront: { id: string; slug: string },
  position: number,
  existingProductIds: string[],
  newProducts: Array<{ title: string; affiliateUrl: string; imageUrl: string | null }>,
): Promise<{ externalUrl: string; collectionId: string; productId: string | null }> {
  if (existingProductIds.length === 0 && newProducts.length === 0) {
    throw new Error("Attach at least one product before going live.");
  }

  // Remember where this pin lived before going live (its Pinterest board),
  // so a later take-down can return it there instead of orphaning it. Only
  // capture it the first time — a re-go-live must not overwrite the true
  // origin with the per-pin collection from a previous run.
  const { data: pinRow } = await supabase
    .from("pins")
    .select("collection_id, origin_collection_id")
    .eq("id", pin.id)
    .maybeSingle();
  const originCollectionId = pinRow?.origin_collection_id ?? pinRow?.collection_id ?? null;

  const name = (pin.title?.trim() || "Pin collection").slice(0, 60);
  const slug = `${slugify(name) || "collection"}-${Math.random().toString(36).slice(2, 6)}`;
  const { data: created, error: cErr } = await supabase
    .from("collections")
    .insert({
      user_id: userId,
      storefront_id: storefront.id,
      name,
      slug,
      source: "manual",
      position,
    })
    .select("id,slug")
    .single();
  if (cErr) throw new Error(cErr.message);
  const collectionId = created.id as string;
  const collectionSlug = created.slug as string;

  // Insert new (e.g. visual-search-matched) products into this collection,
  // reusing an existing row with the same affiliate URL if one exists. Every
  // product is tagged with `pin_id` so the analytics pin breakdown can show
  // all of a pin's products and a take-down can detach exactly this set.
  let newInsertedIds: string[] = [];
  const reusedExistingIds: string[] = [];
  if (newProducts.length > 0) {
    const urls = newProducts.map((p) => p.affiliateUrl);
    const { data: existingRows } = await supabase
      .from("storefront_products")
      .select("id, affiliate_url")
      .eq("storefront_id", storefront.id)
      .in("affiliate_url", urls);
    const existingByUrl = new Map((existingRows ?? []).map((r) => [r.affiliate_url, r.id]));
    const toInsert = newProducts
      .filter((p) => !existingByUrl.has(p.affiliateUrl))
      .map((p) => ({
        user_id: userId,
        storefront_id: storefront.id,
        collection_id: collectionId,
        pin_id: pin.id,
        title: p.title,
        affiliate_url: p.affiliateUrl,
        image_url: p.imageUrl ?? pin.image_url,
      }));
    if (toInsert.length > 0) {
      const { data: inserted, error: insErr } = await supabase
        .from("storefront_products")
        .insert(toInsert)
        .select("id");
      if (insErr) throw new Error(insErr.message);
      newInsertedIds = (inserted ?? []).map((r) => r.id);
    }
    reusedExistingIds.push(...(Array.from(existingByUrl.values()) as string[]));
  }

  // Move every reused/explicitly-selected existing product into this
  // collection and tag it with this pin.
  const moveIds = Array.from(new Set([...existingProductIds, ...reusedExistingIds]));
  if (moveIds.length > 0) {
    const { error: mvErr } = await supabase
      .from("storefront_products")
      .update({ collection_id: collectionId, pin_id: pin.id })
      .in("id", moveIds);
    if (mvErr) throw new Error(mvErr.message);
  }

  const externalUrl = `${origin}/s/${storefront.slug}#${collectionSlug}`;
  const productId = existingProductIds[0] ?? newInsertedIds[0] ?? reusedExistingIds[0] ?? null;

  const { error: pinErr } = await supabase
    .from("pins")
    .update({
      status: "live",
      collection_id: collectionId,
      origin_collection_id: originCollectionId,
      product_id: productId,
      external_url: externalUrl,
    })
    .eq("id", pin.id);
  if (pinErr) throw new Error(pinErr.message);

  return { externalUrl, collectionId, productId };
}

export const goLivePin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: {
      pinId: string;
      origin: string;
      existingProductIds?: string[];
      newProducts?: Array<{ title: string; affiliateUrl: string; imageUrl: string | null }>;
    }) =>
      z
        .object({
          pinId: z.string().uuid(),
          origin: z.string().url(),
          existingProductIds: z.array(z.string().uuid()).optional().default([]),
          newProducts: z
            .array(
              z.object({
                title: z.string(),
                affiliateUrl: z.string().url(),
                imageUrl: z.string().url().nullable(),
              }),
            )
            .optional()
            .default([]),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: pin, error: pinErr } = await supabase
      .from("pins")
      .select("id,title,image_url,storefront_id")
      .eq("id", data.pinId)
      .maybeSingle();
    if (pinErr) throw new Error(pinErr.message);
    if (!pin) throw new Error("Pin not found");
    if (!pin.storefront_id) throw new Error("Pin has no storefront");

    const { data: storefront, error: sfErr } = await supabase
      .from("storefronts")
      .select("id,slug")
      .eq("id", pin.storefront_id)
      .maybeSingle();
    if (sfErr) throw new Error(sfErr.message);
    if (!storefront) throw new Error("Storefront not found");

    const { count: collCount } = await supabase
      .from("collections")
      .select("*", { count: "exact", head: true })
      .eq("storefront_id", storefront.id);

    return performGoLive(
      supabase,
      userId,
      data.origin,
      pin,
      storefront,
      collCount ?? 0,
      data.existingProductIds,
      data.newProducts,
    );
  });

// -------------------------------------------------------------
// Take-down (the inverse of go-live). "Deleting" a live pin or a storefront
// collection must never destroy a pin or a board — it returns the pin to the
// available-to-attach pool (back under its original board), detaches its
// products, and removes the empty per-pin collection. The user's total set of
// pins and boards is invariant across go-live / take-down.
// -------------------------------------------------------------

// Delete a manual per-pin collection only once it holds no pins or products.
// Synced Pinterest boards (source !== "manual") are never deleted — they are
// the durable board list and must survive every take-down.
async function cleanupCollectionIfEmpty(
  supabase: SupabaseClient<Database>,
  collectionId: string,
): Promise<void> {
  const { data: coll } = await supabase
    .from("collections")
    .select("id, source")
    .eq("id", collectionId)
    .maybeSingle();
  if (!coll || coll.source !== "manual") return;
  const [{ count: pinCount }, { count: prodCount }] = await Promise.all([
    supabase
      .from("pins")
      .select("*", { count: "exact", head: true })
      .eq("collection_id", collectionId),
    supabase
      .from("storefront_products")
      .select("*", { count: "exact", head: true })
      .eq("collection_id", collectionId),
  ]);
  if ((pinCount ?? 0) === 0 && (prodCount ?? 0) === 0) {
    await supabase.from("collections").delete().eq("id", collectionId);
  }
}

// Revert one pin from "live" back to "available", detaching its products and
// returning it to its original board. RLS scopes every write to the owner.
async function revertPinToAvailable(
  supabase: SupabaseClient<Database>,
  pinId: string,
): Promise<void> {
  const { data: pin, error } = await supabase
    .from("pins")
    .select("id, collection_id, origin_collection_id")
    .eq("id", pinId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!pin) throw new Error("Pin not found");

  const perPinCollectionId = pin.collection_id;

  // Detach every product attached to this pin (removes it from the storefront
  // and the analytics pin breakdown).
  const { error: delErr } = await supabase.from("storefront_products").delete().eq("pin_id", pinId);
  if (delErr) throw new Error(delErr.message);

  // Return the pin to the available pool, back under the board it came from.
  const { error: upErr } = await supabase
    .from("pins")
    .update({
      status: "new",
      product_id: null,
      external_url: null,
      collection_id: pin.origin_collection_id ?? null,
      origin_collection_id: null,
    })
    .eq("id", pinId);
  if (upErr) throw new Error(upErr.message);

  // Drop the now-empty per-pin collection (never the origin board).
  if (perPinCollectionId && perPinCollectionId !== pin.origin_collection_id) {
    await cleanupCollectionIfEmpty(supabase, perPinCollectionId);
  }
}

// "Delete" a single live pin — reverts it to available. The pin row survives.
export const takeDownPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { pinId: string }) => z.object({ pinId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await revertPinToAvailable(context.supabase, data.pinId);
    return { ok: true as const };
  });

// "Delete" a storefront collection — reverts all its pins to available,
// detaches their products, and removes the collection. Pins and boards are
// preserved; only the per-pin/manual collection wrapper goes away.
export const takeDownCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { collectionId: string }) =>
    z.object({ collectionId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: pins, error } = await supabase
      .from("pins")
      .select("id")
      .eq("collection_id", data.collectionId);
    if (error) throw new Error(error.message);

    for (const p of pins ?? []) {
      await revertPinToAvailable(supabase, p.id as string);
    }
    // Remove any products left directly on the collection (manual collections
    // can hold products with no pin), then delete the empty collection.
    await supabase.from("storefront_products").delete().eq("collection_id", data.collectionId);
    await cleanupCollectionIfEmpty(supabase, data.collectionId);
    return { ok: true as const };
  });

// -------------------------------------------------------------
// Board-level bulk monetization: find every un-monetized pin in a board
// (a synced Pinterest board = a `collections` row), run each through the
// same real visual-search pipeline, and let the swipe UI approve/reject
// them — approvals go through the exact same performGoLive() path as the
// single-pin flow above, just looped.
// -------------------------------------------------------------

export type BoardCandidate = {
  pinId: string;
  title: string;
  imageUrl: string | null;
  impressions: number;
  clicks: number;
};

export const getBoardMonetizationCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { collectionId: string }) =>
    z.object({ collectionId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: collection, error: cErr } = await supabase
      .from("collections")
      .select("id,name,storefront_id")
      .eq("id", data.collectionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!collection) throw new Error("Board not found");

    // Deliberately no visual search here — that's the slow part (an
    // external API call per pin). Return the pin list instantly; the swipe
    // UI fetches each pin's recommendation on demand (current + next few),
    // so the user starts swiping in ~1 request instead of waiting on all of
    // them up front.
    const { data: pins, error: pErr } = await supabase
      .from("pins")
      .select("id,title,image_url,impressions,clicks")
      .eq("collection_id", data.collectionId)
      .eq("is_owner", true)
      .is("product_id", null)
      .order("created_at", { ascending: false });
    if (pErr) throw new Error(pErr.message);

    const candidates: BoardCandidate[] = (pins ?? []).map((p) => ({
      pinId: p.id,
      title: p.title,
      imageUrl: p.image_url,
      impressions: p.impressions ?? 0,
      clicks: p.clicks ?? 0,
    }));

    return { boardName: collection.name, candidates };
  });

// Fast path for the interactive swipe-review card: raw matches only, no CK
// wait — the card renders immediately and each match's price/stock fills in
// independently client-side via getProductDetails. The bulk "Approve all"
// flow still uses the full getPinRecommendation below, unchanged — it needs
// the complete CK-confirmed set synchronously to decide what's safe to
// auto-attach, so it isn't a candidate for progressive rendering.
export const getPinRecommendationPreview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { pinId: string }) => z.object({ pinId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: pin, error } = await supabase
      .from("pins")
      .select("id,title,description,image_url")
      .eq("id", data.pinId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!pin) throw new Error("Pin not found");
    if (!pin.image_url) return { matches: [] as RawVisualMatch[] };
    return { matches: await searchByImageRaw(pin.image_url, pin.title, pin.description ?? "") };
  });

export const getPinRecommendation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { pinId: string }) => z.object({ pinId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // RLS scopes this to the caller's own pin (see "pins owner all" policy) —
    // no explicit user_id check needed, matching goLivePin's lookup above.
    const { data: pin, error } = await supabase
      .from("pins")
      .select("id,title,description,image_url")
      .eq("id", data.pinId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!pin) throw new Error("Pin not found");
    if (!pin.image_url) return { recommendations: [] as VisualMatch[] };
    // Let real failures (bad API key, network error, non-"no results" 500s)
    // throw and surface to the client as a retryable error — searchByImage
    // already collapses a genuine "no results" response into `[]`, so an
    // empty array here always means "confirmed no match", never "broke".
    // Return every validated match, not just the top one, so the review UI
    // can offer all of them rather than forcing a single auto-pick.
    const matches = await searchByImage(pin.image_url, pin.title, pin.description ?? "");
    return { recommendations: matches };
  });

export const approveBoardPins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: {
      origin: string;
      approvals: Array<{
        pinId: string;
        products: Array<{ title: string; affiliateUrl: string; imageUrl: string | null }>;
      }>;
    }) =>
      z
        .object({
          origin: z.string().url(),
          approvals: z
            .array(
              z.object({
                pinId: z.string().uuid(),
                products: z
                  .array(
                    z.object({
                      title: z.string(),
                      affiliateUrl: z.string().url(),
                      imageUrl: z.string().url().nullable(),
                    }),
                  )
                  .min(1),
              }),
            )
            .min(1),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const pinIds = data.approvals.map((a) => a.pinId);
    const { data: pinRows, error: pErr } = await supabase
      .from("pins")
      .select("id,title,image_url,storefront_id")
      .in("id", pinIds);
    if (pErr) throw new Error(pErr.message);
    const pinById = new Map((pinRows ?? []).map((p: any) => [p.id as string, p]));

    const storefrontId = (pinRows ?? [])[0]?.storefront_id as string | undefined;
    if (!storefrontId) throw new Error("No storefront found for these pins");
    const { data: storefront, error: sfErr } = await supabase
      .from("storefronts")
      .select("id,slug")
      .eq("id", storefrontId)
      .maybeSingle();
    if (sfErr) throw new Error(sfErr.message);
    if (!storefront) throw new Error("Storefront not found");

    const { count: collCount } = await supabase
      .from("collections")
      .select("*", { count: "exact", head: true })
      .eq("storefront_id", storefront.id);
    let nextPosition = collCount ?? 0;

    let approved = 0;
    const failed: string[] = [];
    for (const a of data.approvals) {
      const pin = pinById.get(a.pinId);
      if (!pin) {
        failed.push(`${a.pinId}: pin not found`);
        continue;
      }
      try {
        await performGoLive(
          supabase,
          userId,
          data.origin,
          pin,
          storefront,
          nextPosition++,
          [],
          a.products,
        );
        approved++;
      } catch (e) {
        failed.push(`${pin.title || a.pinId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    return { approved, failed };
  });
