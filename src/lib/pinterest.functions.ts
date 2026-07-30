import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
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
  // "Sunglasses"), used to group products into tabs. Absent when the match
  // came from the whole-image search (detection not ready / no crops).
  tag?: string;
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
const CK_CONCURRENCY = 6;
const LENS_CONCURRENCY = 6;
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
// RETRY_BACKOFFS_MS[0], attempt 3 (if reached) waits RETRY_BACKOFFS_MS[1].
const RETRY_BACKOFFS_MS = [250, 500];
// Default timeout-retry budget (CK still uses this): one retry, since a fast
// service that times out under its budget is usually a transient blip worth a
// single re-try. LENS overrides this to 0 — its budget is now wide enough that
// a timeout means a genuine hang, and re-running a 16s query is pure waste.
// A transient 429/502/503/504 gets up to two retries, since those usually
// clear within a couple hundred ms.
const TIMEOUT_MAX_RETRIES = 1;
const RETRYABLE_STATUS_MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

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

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
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

      const backoff = RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)];
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
    thumbnail: item.thumbnail ?? item.image?.link ?? null,
    price: parseLensPrice(item),
    position: item.position ?? index + 1,
    inStockHint: !/out of stock/i.test(item.stock_information ?? ""),
  };
}

// Short-lived cache + in-flight de-dup for the Google Lens reverse-image
// search, keyed by the pin's image URL. Lens is BOTH the slowest single call
// in the pipeline AND non-deterministic — the same image returns a different
// set (and count) of visual matches on every call, which is exactly why a pin
// re-scanned moments later showed different products and a different final
// count. Caching the raw match list makes a given image resolve to ONE stable
// set: re-opening/re-scanning a pin returns the identical products instantly
// with no second API call. The downstream filter/rank/dedupe steps are
// deterministic, so a cache hit reproduces the same final result byte-for-byte.
// A found result is stable for hours; an empty result gets a short TTL so a
// transient Lens hiccup doesn't pin "no matches" for the rest of the day.
const LENS_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const LENS_EMPTY_TTL_MS = 2 * 60 * 1000;
const lensCache = new Map<string, { expires: number; matches: LensMatch[] }>();
const lensInFlight = new Map<string, Promise<LensMatch[]>>();

async function searchGoogleLens(imageUrl: string): Promise<LensMatch[]> {
  const cached = lensCache.get(imageUrl);
  if (cached && cached.expires > Date.now()) {
    logNet("LENS", { outcome: "cache_hit", results: cached.matches.length });
    return cached.matches;
  }

  // Concurrent callers for the same image (e.g. the board prefetch window and
  // a swipe landing on the same pin) share one API call instead of racing two
  // non-deterministic scans that would disagree.
  const existing = lensInFlight.get(imageUrl);
  if (existing) {
    logNet("LENS", { outcome: "dedup_suppressed" });
    return existing;
  }

  const promise = searchGoogleLensLive(imageUrl)
    .then((matches) => {
      lensCache.set(imageUrl, {
        expires: Date.now() + (matches.length > 0 ? LENS_SUCCESS_TTL_MS : LENS_EMPTY_TTL_MS),
        matches,
      });
      return matches;
    })
    .finally(() => {
      lensInFlight.delete(imageUrl);
    });
  lensInFlight.set(imageUrl, promise);
  return promise;
}

async function searchGoogleLensLive(imageUrl: string): Promise<LensMatch[]> {
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
    active: lensLimit.activeCount(),
    queued: lensLimit.pendingCount(),
  });
  return results.map(toLensMatch);
}

// -------------------------------------------------------------
// STEP (pre-Lens, OFF the critical path): object detection → component crops.
//
// The vision model isolates each product in a busy pin (e.g. shoes + bag) and
// returns a cropped image per component. Running Lens on a tight crop instead
// of the whole scene gives far more accurate matches. But the detector is SLOW
// (~30s) and Lens needs a public URL (it can't take the base64 crops), so this
// NEVER runs synchronously in the match: the first time an image is seen the
// match uses the fast full-image Lens (today's behaviour) and detection is
// fired in the BACKGROUND, hosting the crops in Supabase Storage and caching
// their URLs. Later matches reuse those crops. Net: match latency is never
// affected; accuracy improves as crops become available. Every failure falls
// back to the full image.
// -------------------------------------------------------------

const DETECT_URL =
  process.env.VISION_DETECT_API_URL || "https://automation.ekarostats.com/vision/detect-objects";
// Master switch. Verified working for real product/fashion pins (returns
// component crops in ~27–50s); the earlier "no_objects" cases were text/quote/
// painting pins that genuinely have nothing to detect. It runs entirely off
// the match path, so it's ON by default; set VISION_DETECT_ENABLED=false to
// disable (e.g. if the vision service is down).
const DETECT_ENABLED = process.env.VISION_DETECT_ENABLED !== "false";
// Detector runs ~27–50s. 55s stays just under its own ~60s gateway timeout, so
// we don't abandon a call that's about to succeed (the old 45s cap was cutting
// those off). Off-path, so a long ceiling costs nothing on the match.
const DETECT_TIMEOUT_MS = 55_000;
const DETECT_CONCURRENCY = 2;
const detectLimit = createLimiter(DETECT_CONCURRENCY);
const CROP_BUCKET = "pin-crops";
const CROP_MAX = 6; // cap crops per image → bounds Lens fan-out + storage
const CROP_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const CROP_EMPTY_TTL_MS = 60 * 60 * 1000; // genuine "no products in image"
// Transient failures (502/504/timeout/fetch) — retry soon so we recover the
// moment the (flaky) vision service comes back, instead of blocking for an hour.
const CROP_ERROR_TTL_MS = 5 * 60 * 1000;
// Max products shown per detected component tag. Once every tag is full, the
// pipeline emits nothing more — this cap IS the hard stop.
const PER_TAG_MAX = 8;
// Max products in the whole-image fallback (no detection tags). Capping here
// means only this many cards render, so only this many CK price lookups ever
// fire — a hard stop so we never waste calls on a long tail.
const FULL_IMAGE_MAX = 10;

type Crop = { url: string; label: string };

// imageUrl -> hosted crops (URL + detection label). An empty array means
// "detected, nothing usable" (so we don't re-detect); absent = not attempted.
const cropCache = new Map<string, { expires: number; crops: Crop[] }>();
const cropInFlight = new Map<string, Promise<Crop[]>>();

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

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
function getCrops(imageUrl: string): Crop[] | undefined {
  const c = cropCache.get(imageUrl);
  if (c && c.expires > Date.now()) return c.crops;
  return undefined;
}

type DetectResponse = {
  // Bounding boxes the model found (present even when it didn't return crops).
  objects?: Array<{ id?: string; label?: string; confidence?: number }>;
  extracted_objects?: Array<{
    id?: string;
    label?: string;
    confidence?: number;
    image_base64?: string;
  }>;
};

// Background-only. Fetches the image, runs object detection, hosts each crop in
// Supabase Storage, and caches the public URLs. Never throws — any failure
// caches an empty result so the match path just keeps using the full image.
async function detectAndHostCrops(imageUrl: string): Promise<Crop[]> {
  const existing = cropInFlight.get(imageUrl);
  if (existing) return existing;

  const run = (async (): Promise<Crop[]> => {
    const startedAt = Date.now();
    try {
      // 1. Fetch the pin image and base64-encode it for the detector. Pinterest
      //    (and other) CDNs often reject a bare Node fetch, so send a real
      //    browser UA + Accept, and bound it with a timeout so a stuck fetch
      //    never wedges detection. Logged distinctly so image-fetch failures
      //    are obvious vs. detector failures.
      let b64: string;
      try {
        const imgController = new AbortController();
        const imgTimer = setTimeout(() => imgController.abort(), 15_000);
        const imgRes = await fetch(imageUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          },
          signal: imgController.signal,
        }).finally(() => clearTimeout(imgTimer));
        if (!imgRes.ok) {
          cropCache.set(imageUrl, { expires: Date.now() + CROP_ERROR_TTL_MS, crops: [] });
          logNet("DETECT", { outcome: "image_http_error", status: imgRes.status });
          return [];
        }
        b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
      } catch (e) {
        cropCache.set(imageUrl, { expires: Date.now() + CROP_ERROR_TTL_MS, crops: [] });
        logNet("DETECT", {
          outcome: "image_fetch_error",
          reason: e instanceof Error ? e.message : String(e),
        });
        return [];
      }

      // 2. Object detection (slow; long timeout, no retry — re-running a ~30s
      //    call never helps).
      const data = await detectLimit(() =>
        withRetry(
          async (signal) => {
            const res = await fetch(DETECT_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                image_base64: b64,
                custom_labels: [],
                min_box_area: 0.001,
                image_name: `${shortHash(imageUrl)}.jpg`,
                output_folder: "output",
              }),
              signal,
            });
            if (RETRYABLE_STATUSES.has(res.status)) throw new RetryableHttpError(res.status);
            if (!res.ok) {
              logNet("DETECT", { outcome: "http_error", status: res.status });
              return {} as DetectResponse;
            }
            return (await res.json()) as DetectResponse;
          },
          { timeoutMs: DETECT_TIMEOUT_MS, label: "DETECT", timeoutMaxRetries: 0 },
        ),
      );

      // Keep the highest-confidence components only.
      const objs = (data.extracted_objects ?? [])
        .filter((o) => o.image_base64)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, CROP_MAX);

      if (objs.length === 0) {
        cropCache.set(imageUrl, { expires: Date.now() + CROP_EMPTY_TTL_MS, crops: [] });
        // Log both counts + top labels so we can tell "model found nothing" from
        // "model found boxes but returned no crops".
        logNet("DETECT", {
          outcome: "no_objects",
          durationMs: Date.now() - startedAt,
          boxes: data.objects?.length ?? 0,
          extracted: data.extracted_objects?.length ?? 0,
          labels: (data.objects ?? [])
            .slice(0, 5)
            .map((o) => o.label ?? "?")
            .join(","),
        });
        return [];
      }

      // 3. Host each crop so Lens (URL-only) can read it. Service-role client
      //    (bypasses RLS); dynamic import keeps it out of the client bundle.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const dir = shortHash(imageUrl);
      const crops: Crop[] = [];
      for (const o of objs) {
        const path = `${dir}/${o.id ?? crops.length}.png`;
        const { error } = await supabaseAdmin.storage
          .from(CROP_BUCKET)
          .upload(path, Buffer.from(o.image_base64!, "base64"), {
            contentType: "image/png",
            upsert: true,
          });
        if (error) {
          logNet("DETECT", { outcome: "upload_error", reason: error.message });
          continue;
        }
        const pub = supabaseAdmin.storage.from(CROP_BUCKET).getPublicUrl(path).data.publicUrl;
        if (pub) crops.push({ url: pub, label: normalizeLabel(o.label) });
      }

      cropCache.set(imageUrl, {
        expires: Date.now() + (crops.length ? CROP_SUCCESS_TTL_MS : CROP_EMPTY_TTL_MS),
        crops,
      });
      logNet("DETECT", {
        outcome: "completed",
        durationMs: Date.now() - startedAt,
        objects: objs.length,
        hosted: crops.length,
        tags: [...new Set(crops.map((c) => c.label))].join(","),
      });
      return crops;
    } catch (e) {
      // Cache empty briefly (error TTL) so we neither hammer a failing detector
      // nor block the match, and recover fast once the service is back.
      cropCache.set(imageUrl, { expires: Date.now() + CROP_ERROR_TTL_MS, crops: [] });
      logNet("DETECT", { outcome: "error", reason: e instanceof Error ? e.message : String(e) });
      return [];
    } finally {
      cropInFlight.delete(imageUrl);
    }
  })();

  cropInFlight.set(imageUrl, run);
  return run;
}

// -------------------------------------------------------------
// STEP: Filter to supported retailers only (Set-based, O(depth) not O(N) —
// see `isSupportedRetailerLink` in brands.ts) — a match from anywhere else
// must never reach CK, a paid per-request API.
// -------------------------------------------------------------

function filterSupportedRetailers(matches: LensMatch[]): LensMatch[] {
  const before = matches.length;
  const filtered = matches.filter((m) => isSupportedRetailerLink(m.link));
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

const NICHES: Niche[] = [
  {
    key: "fashion",
    keywords: [
      "dress",
      "jeans",
      "denim",
      "shirt",
      "tshirt",
      "top",
      "kurta",
      "kurti",
      "saree",
      "lehenga",
      "jacket",
      "hoodie",
      "sweater",
      "trousers",
      "pants",
      "skirt",
      "shorts",
      "shoes",
      "sneakers",
      "heels",
      "sandals",
      "footwear",
      "boots",
      "bag",
      "handbag",
      "backpack",
      "watch",
      "sunglasses",
      "belt",
      "apparel",
      "outfit",
      "ethnic",
      "fit",
      "clothing",
      "wear",
    ],
    retailers: ["myntra", "ajio", "nykaa fashion", "tatacliq", "flipkart", "amazon"],
  },
  {
    key: "beauty",
    keywords: [
      "lipstick",
      "makeup",
      "skincare",
      "serum",
      "foundation",
      "concealer",
      "mascara",
      "kajal",
      "perfume",
      "fragrance",
      "cream",
      "moisturizer",
      "shampoo",
      "conditioner",
      "cosmetic",
      "lip",
      "blush",
      "sunscreen",
    ],
    retailers: ["nykaa", "purplle", "tira", "amazon", "flipkart"],
  },
  {
    key: "home",
    keywords: [
      "decor",
      "cushion",
      "pillow",
      "curtain",
      "lamp",
      "vase",
      "furniture",
      "sofa",
      "table",
      "chair",
      "rug",
      "carpet",
      "bedsheet",
      "planter",
      "shelf",
      "clock",
      "mirror",
      "candle",
      "throw",
      "bedding",
      "home",
    ],
    retailers: ["pepperfry", "urbanladder", "ikea", "homecentre", "amazon", "flipkart"],
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
      "wall art",
      "sketch",
      "illustration",
      "mural",
      "portrait",
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
      "phone",
      "smartphone",
      "laptop",
      "tablet",
      "camera",
      "speaker",
      "charger",
      "smartwatch",
      "monitor",
      "keyboard",
      "mouse",
      "gadget",
    ],
    retailers: ["croma", "reliancedigital", "amazon", "flipkart"],
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
    .map((m) => {
      const titleWords = extractKeywords(m.title);
      const overlap = queryWords.size > 0 ? keywordOverlap(titleWords, queryWords) : 0;
      // Niche fit is the strongest signal after direct title overlap: a match
      // whose own title belongs to the detected niche is almost certainly the
      // right object; its retailer selling that niche is a lighter confirm.
      const nicheHits = niche ? countNicheHits(titleWords, niche) : 0;
      const nicheBoost = niche
        ? Math.min(nicheHits, 2) * 3 + (retailerMatchesNiche(m.source, niche) ? 1 : 0)
        : 0;
      const score = m.position - overlap * 5 - nicheBoost - (m.inStockHint ? 0.5 : 0);
      return { m, score };
    })
    .sort((a, b) => a.score - b.score)
    .map((s) => s.m);
}

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

// Composes every stage above, in the fixed order: Lens → filter → rank →
// dedupe → project to the public shape. This is the fast half of
// the pipeline (one external call, no CK wait) and is what the UI renders
// immediately: image/title/source/link for every kept match, so cards paint
// before a single CK request has even been sent. `validateMatches` (below)
// is the slow half, run independently per card by the client.
async function searchByImageRaw(
  imageUrl: string,
  title = "",
  description = "",
): Promise<RawVisualMatch[]> {
  const totalStart = Date.now();
  const crops = getCrops(imageUrl);

  // COMPONENT-TAGGED PATH: detection done + usable crops. Run Lens per crop in
  // parallel, keep results grouped by their detection tag, and cap each tag at
  // PER_TAG_MAX. Once every tag is full nothing more is emitted — that cap is
  // the pipeline's hard stop.
  if (crops && crops.length > 0) {
    const perCrop = await Promise.all(
      crops.map(async (c) => {
        const raw = await searchGoogleLens(c.url).catch(() => [] as LensMatch[]);
        const ranked = rankMatches(filterSupportedRetailers(raw), { title, description });
        return { label: c.label, matches: dedupeMatches(ranked) };
      }),
    );
    // Merge crops that share a tag (e.g. two "Purse" boxes), globally dedupe by
    // link, and enforce the per-tag ceiling.
    const seen = new Set<string>();
    const perTag = new Map<string, number>();
    const out: RawVisualMatch[] = [];
    for (const g of perCrop) {
      for (const m of g.matches) {
        const link = canonicalizeProductUrl(m.link);
        if (seen.has(link)) continue;
        const n = perTag.get(g.label) ?? 0;
        if (n >= PER_TAG_MAX) continue; // tag is full → stop adding to it
        seen.add(link);
        perTag.set(g.label, n + 1);
        out.push({ ...toRawVisualMatch(m), tag: g.label });
      }
    }
    logNet("TOTAL", {
      durationMs: Date.now() - totalStart,
      source: `crops:${crops.length}`,
      tags: [...perTag.keys()].join(","),
      final: out.length,
    });
    return out;
  }

  // WHOLE-IMAGE PATH: detection not ready (or nothing usable). Today's fast
  // path, unchanged latency. When not attempted yet, kick off background
  // detection so LATER matches get tabs.
  const raw = await searchGoogleLens(imageUrl);
  if (crops === undefined && DETECT_ENABLED) void detectAndHostCrops(imageUrl);
  const filtered = filterSupportedRetailers(raw);
  const ranked = rankMatches(filtered, { title, description });
  const deduped = dedupeMatches(ranked);
  // Hard cap at FULL_IMAGE_MAX, preferring matches that already carry a price
  // so the shown set resolves fully. We render (and therefore CK-price) only
  // these — nothing beyond the cap, so no wasted calls on the long tail.
  const top = [...deduped.filter((m) => m.price), ...deduped.filter((m) => !m.price)].slice(
    0,
    FULL_IMAGE_MAX,
  );
  logNet("TOTAL", {
    durationMs: Date.now() - totalStart,
    lensResults: raw.length,
    final: top.length,
    source: crops === undefined ? "full" : "full_no_crops",
  });
  return top.map(toRawVisualMatch);
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
      return { ...m, mrp: null, price: m.price };
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
