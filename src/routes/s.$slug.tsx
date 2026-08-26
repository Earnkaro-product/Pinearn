import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Reorder } from "framer-motion";
import {
  ArrowUpDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  GripVertical,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  ShoppingBag,
  X,
} from "lucide-react";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { brandForUrl, brandLogoUrl, hostBrand } from "@/lib/brands";
import { productPriceParts } from "@/lib/product-price";
import { categoryOfTitle, type ProductCategory } from "@/lib/product-category";

const DEFAULT_BACKGROUND =
  "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1600&q=80&auto=format&fit=crop";

/** True once mounted if the visitor arrived here from another page in this
 * tab — i.e. the storefront is being previewed from the app. A cold public
 * visit has no history to go back to, so the button stays hidden there. */
function useCanGoBack() {
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    setCanGoBack(window.history.length > 1);
  }, []);
  return canGoBack;
}

const CHIP_CLASS =
  "absolute left-4 top-4 z-20 inline-flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-2 text-sm font-medium text-white backdrop-blur-sm transition hover:bg-black/60";

/**
 * Back chip floating over the background band. Sits on the image, so it carries
 * its own translucent backdrop to stay readable on any cover.
 *
 * For the CREATOR this is a fixed link to My Store, not `history.back()`.
 * History was one step wrong the moment the preview stopped being a single
 * page: preview the store → open a collection → back to the store root, and now
 * the previous entry is that collection, so the chip walked back INTO the
 * preview instead of leaving it. There is exactly one place this chip means to
 * go, so it names it.
 *
 * A visitor who is not the owner has no My Store to return to, so they keep the
 * history step — and only when there is history to step through.
 */
function PreviewBackButton({ ownerId }: { ownerId: string }) {
  const isOwner = useIsOwner(ownerId);
  const canGoBack = useCanGoBack();
  if (isOwner) {
    return (
      <Link to="/storefront" className={CHIP_CLASS}>
        <ChevronLeft className="h-4 w-4" /> My Store
      </Link>
    );
  }
  if (!canGoBack) return null;
  return (
    <button
      type="button"
      onClick={() => history.back()}
      aria-label="Go back"
      className={CHIP_CLASS}
    >
      <ChevronLeft className="h-4 w-4" /> Back
    </button>
  );
}

export const getPublicStorefront = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => z.object({ slug: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });
    // NOT maybeSingle(). `storefronts.slug` carries no unique constraint — only
    // user_id does (20260706071512) — and uniqueness was merely attempted in
    // application code, which a set-based backfill and concurrent sign-ups both
    // defeat. Three storefronts ended up sharing the slug "dua", and maybeSingle
    // treats "more than one row" as an error: the page 404'd with "Storefront not
    // found" for every one of them, including from a link the creator had just
    // copied.
    //
    // Ordered by `id`, not `created_at`: anon holds a COLUMN-level GRANT on this
    // table (20260803150000_scope_public_read.sql) and created_at is not in it, so
    // ordering by it is a 42501 that takes the whole page down — the same trap as
    // the pins query above. `id` is granted, stable, and gives a deterministic
    // winner, so a given link always resolves to the same storefront rather than
    // flipping between owners. The duplicates are
    // being cleaned up and a unique index added in
    // 20260818140000_storefront_slug_unique.sql; this stays as the guard that
    // keeps a public page from 500ing over a data problem.
    const { data: stores } = await sb
      .from("storefronts")
      .select("id,user_id,name,slug,description,brand_color,background_image_url")
      .eq("slug", data.slug)
      .order("id", { ascending: true })
      .limit(1);
    const store = stores?.[0];
    if (!store) return null;
    const [{ data: collections }, { data: pins }, { data: boards }, { data: profile }] =
      await Promise.all([
        sb
          .from("collections")
          .select("id,name,slug,description,cover_color,cover_image_url,position")
          .eq("storefront_id", store.id)
          .is("hidden_from_storefront_at", null)
          .order("position", { ascending: true }),
        sb
          .from("pins")
          .select("id,title,image_url,collection_id,product_id")
          .eq("storefront_id", store.id)
          .eq("status", "live")
          .eq("is_owner", true)
          // NOTE: no `.is("pinterest_removed_at", null)` here, deliberately, even
          // though every other pin read has one. This is the anon path, and anon
          // holds a COLUMN-level GRANT on `pins` that doesn't include that column
          // (20260803150000_scope_public_read.sql) — filtering on it is a hard
          // 42501 "permission denied for table pins", which takes the whole
          // public storefront down rather than hiding a row.
          //
          // Removed pins are excluded for anon by the RLS policy instead
          // (20260817120000_pins_public_read_excludes_removed.sql). A policy
          // expression isn't subject to the caller's column privileges, so it can
          // test the column this query cannot — and it applies to every anon
          // reader, including one that forgets to ask.
          .order("created_at", { ascending: false })
          .limit(200),
        sb
          .from("boards")
          .select("id,name,cover_image_url,position")
          .eq("storefront_id", store.id)
          .is("hidden_from_storefront_at", null)
          .order("position", { ascending: true }),
        sb.from("profiles").select("avatar_url,display_name").eq("id", store.user_id).maybeSingle(),
      ]);
    const boardIds = (boards ?? []).map((b) => b.id);
    let boardCollections: { board_id: string; collection_id: string }[] = [];
    if (boardIds.length > 0) {
      const { data: bc } = await sb
        .from("board_collections")
        .select("board_id,collection_id")
        .in("board_id", boardIds);
      boardCollections = bc ?? [];
    }

    // ---- Products, read with the SERVICE ROLE and hand-scoped.
    //
    // `anon` has no access to storefront_products at all, and that is on
    // purpose: 20260803150000_scope_public_read.sql revoked it because a
    // table-wide GRANT "published every creator's affiliate URLs, prices and
    // commission rates" to anybody holding the publishable key, queryable
    // straight off PostgREST.
    //
    // Re-granting it would reopen exactly that. So the read happens here
    // instead — server-side, one storefront, and an explicit column list. The
    // difference that matters: `commission_pct` and `user_id` are never
    // selected, so the creator's rate cannot leave the server even by accident,
    // and no visitor can enumerate anyone else's products.
    //
    // Scoped to the collections this page already decided are visible, so a
    // collection hidden from the storefront takes its products with it.
    const visibleCollectionIds = (collections ?? []).map((c) => c.id);
    const livePinIds = (pins ?? []).map((p) => p.id);
    let products: Array<{
      id: string;
      title: string;
      image_url: string | null;
      affiliate_url: string;
      price_cents: number | null;
      currency: string | null;
      collection_id: string | null;
      pin_id: string | null;
      position: number;
    }> = [];
    if (visibleCollectionIds.length > 0 || livePinIds.length > 0) {
      const admin = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        {
          auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        },
      );
      const filters = [
        visibleCollectionIds.length > 0
          ? `collection_id.in.(${visibleCollectionIds.join(",")})`
          : null,
        livePinIds.length > 0 ? `pin_id.in.(${livePinIds.join(",")})` : null,
      ].filter(Boolean);
      const { data: prod } = await admin
        .from("storefront_products")
        .select(
          "id,title,image_url,affiliate_url,price_cents,currency,collection_id,pin_id,position",
        )
        .eq("storefront_id", store.id)
        .or(filters.join(","))
        .order("position", { ascending: true })
        .limit(500);
      products = prod ?? [];
    }

    return {
      store,
      collections: collections ?? [],
      pins: pins ?? [],
      boards: boards ?? [],
      boardCollections,
      products,
      profile: profile ?? null,
    };
  });

export const Route = createFileRoute("/s/$slug")({
  // `?c=<collection slug>` is the shareable deep link a creator sends out. It is
  // a search param rather than a nested route so every storefront URL already in
  // the wild keeps working, and the collection is simply a deeper entry point
  // into the same page.
  validateSearch: (s: Record<string, unknown>): { c?: string } => ({
    c: typeof s.c === "string" && s.c.length > 0 ? s.c : undefined,
  }),
  loader: async ({ params }) => {
    const result = await getPublicStorefront({ data: { slug: params.slug } });
    if (!result) throw notFound();
    return result;
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.store.name} · ShopMyPin` },
          {
            name: "description",
            content: loaderData.store.description ?? `Shop ${loaderData.store.name}`,
          },
          { property: "og:title", content: loaderData.store.name },
          {
            property: "og:description",
            content: loaderData.store.description ?? `Shop ${loaderData.store.name}`,
          },
        ]
      : [],
  }),
  component: PublicStorefront,
  notFoundComponent: NotFound,
  errorComponent: ErrorBoundary,
});

function PublicStorefront() {
  const {
    store,
    collections: allCollections,
    pins,
    boards,
    boardCollections,
    products,
    profile,
  } = Route.useLoaderData();
  const { c: openSlug } = Route.useSearch();
  type C = (typeof allCollections)[number];
  type P = (typeof pins)[number];
  type B = (typeof boards)[number];
  const brand = store.brand_color ?? "#E60023";
  const backgroundUrl = store.background_image_url ?? DEFAULT_BACKGROUND;
  // Which board is filtering the grid — null is "All". Boards are a filter
  // rather than a second tab: a board is a collection of collections, so it
  // narrows the same grid instead of owning one of its own.
  const [activeBoard, setActiveBoard] = useState<string | null>(null);

  // `pins` only contains live pins (see the loader) — a pin only goes live
  // via the explicit Go Live action, so a collection (synced Pinterest
  // board) only shows up publicly once it has at least one live pin.
  const collectionIdsWithProduct = new Set(pins.map((p) => p.collection_id));
  const collections = allCollections.filter((c) => collectionIdsWithProduct.has(c.id));

  // Which collection each product belongs to. A product is routed either
  // directly (collection_id) or through the pin it was attached to — see
  // 20260720120000_pin_product_routing.sql — so resolve the pin's collection
  // when the direct link is absent.
  const collectionIdByPin = new Map(pins.map((p: P) => [p.id, p.collection_id]));
  const productsByCollection = new Map<string, typeof products>();
  for (const prod of products) {
    const cid = prod.collection_id ?? (prod.pin_id ? collectionIdByPin.get(prod.pin_id) : null);
    if (!cid) continue;
    const arr = productsByCollection.get(cid) ?? [];
    arr.push(prod);
    productsByCollection.set(cid, arr);
  }

  const openCollection = openSlug ? collections.find((c: C) => c.slug === openSlug) : undefined;

  // A shared link whose collection is gone (removed from the storefront, or its
  // last pin taken down) lands on the storefront rather than on an error — the
  // visitor still gets somewhere useful, which a 404 would not give them.
  if (openCollection) {
    return (
      <CollectionView
        store={store}
        collection={openCollection}
        products={productsByCollection.get(openCollection.id) ?? []}
        pins={pins.filter((p: P) => p.collection_id === openCollection.id)}
        brand={brand}
        backgroundUrl={backgroundUrl}
      />
    );
  }

  const collectionsByBoard = new Map<string, string[]>();
  for (const bc of boardCollections) {
    const arr = collectionsByBoard.get(bc.board_id) ?? [];
    arr.push(bc.collection_id);
    collectionsByBoard.set(bc.board_id, arr);
  }

  // A board is only worth a tile once one of its collections is actually shown
  // here — `collections` is already filtered to the monetized ones. An imported
  // board whose pins were never monetized would otherwise render as a card
  // saying "0 collections", and a whole tab of those (or an empty state where
  // boards should be) tells a visitor the store is broken rather than young.
  const visibleBoards = boards.filter((b: B) =>
    (collectionsByBoard.get(b.id) ?? []).some((cid) => collections.some((c: C) => c.id === cid)),
  );

  // Per-board: how many of its collections are actually shown, and a cover for
  // its pill (its own, else the first collection's, else that collection's pin).
  const boardCollectionCount = new Map<string, number>();
  const boardThumb = new Map<string, string | null>();
  for (const b of visibleBoards) {
    const members = collections.filter((c: C) =>
      (collectionsByBoard.get(b.id) ?? []).includes(c.id),
    );
    boardCollectionCount.set(b.id, members.length);
    boardThumb.set(
      b.id,
      b.cover_image_url ??
        members
          .map(
            (mc: C) =>
              mc.cover_image_url ??
              pins.find((p: P) => p.collection_id === mc.id && p.image_url)?.image_url ??
              null,
          )
          .find((img): img is string => !!img) ??
        null,
    );
  }

  // A board pill that no longer exists (its last collection came down between
  // renders) must not leave the grid empty — fall back to All.
  const activeBoardIds = activeBoard ? (collectionsByBoard.get(activeBoard) ?? []) : null;
  const shownCollections =
    activeBoardIds && visibleBoards.some((b: B) => b.id === activeBoard)
      ? collections.filter((c: C) => activeBoardIds.includes(c.id))
      : collections;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Background band */}
      <div className="relative h-48 w-full overflow-hidden sm:h-64">
        <img src={backgroundUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-background" />
        <PreviewBackButton ownerId={store.user_id} />
      </div>

      {/* Header card */}
      <header className="relative z-10 mx-auto -mt-12 max-w-5xl px-6 text-center">
        <div className="mx-auto flex flex-col items-center">
          {profile?.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt=""
              className="h-24 w-24 rounded-full border-4 border-background object-cover shadow-glow"
            />
          ) : (
            <div
              className="grid h-24 w-24 place-items-center rounded-full border-4 border-background text-3xl font-semibold text-white shadow-glow"
              style={{ background: brand }}
            >
              {store.name[0]?.toUpperCase()}
            </div>
          )}
          <h1 className="mt-4 font-display text-3xl font-semibold">{store.name}</h1>
          {store.description && (
            <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
              {store.description}
            </p>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* Board pills — same shape as the pills over matching products in the
            app: All first, one per board, each carrying its own count. A board
            used to be a second tab full of inert cards; as a filter it narrows
            the grid a visitor is already looking at, which is the only thing a
            "collection of collections" is actually for. */}
        {visibleBoards.length > 0 && (
          <div className="no-scrollbar -mx-1 mb-6 flex items-center gap-2 overflow-x-auto px-1">
            <FilterPill
              label="All"
              count={collections.length}
              active={activeBoard === null}
              onClick={() => setActiveBoard(null)}
            />
            {visibleBoards.map((b: B) => (
              <FilterPill
                key={b.id}
                label={b.name}
                count={boardCollectionCount.get(b.id) ?? 0}
                thumbUrl={boardThumb.get(b.id) ?? null}
                active={activeBoard === b.id}
                onClick={() => setActiveBoard(b.id)}
              />
            ))}
          </div>
        )}

        {shownCollections.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {shownCollections.map((c: C) => {
              const cPins = pins.filter((p: P) => p.collection_id === c.id);
              const cover =
                c.cover_image_url ?? cPins.find((p: P) => p.image_url)?.image_url ?? null;
              const count = (productsByCollection.get(c.id) ?? []).length || cPins.length;
              return (
                <CoverCard
                  key={c.id}
                  name={c.name}
                  subtitle={`${count} product${count === 1 ? "" : "s"}`}
                  coverUrl={cover}
                  coverColor={c.cover_color}
                  brand={brand}
                  to={{ to: "/s/$slug", params: { slug: store.slug }, search: { c: c.slug } }}
                />
              );
            })}
          </div>
        ) : (
          <EmptyState text="This storefront is still being set up." />
        )}
      </main>

      <footer className="px-6 py-8 text-center text-xs text-muted-foreground">
        Powered by{" "}
        <Link to="/" className="text-primary hover:underline">
          ShopMyPin
        </Link>
      </footer>
    </div>
  );
}

/**
 * One pill in a filter row — the same object as the pills over matching
 * products in the app (label + count, gradient when active), so a shopper who
 * has seen one row of pills has seen them all. Boards additionally carry their
 * cover as a thumb, which is the one thing a board has that a category doesn't.
 *
 * Deliberately re-declared here rather than imported from the pins route: this
 * page is server-rendered for anonymous visitors, and pulling in an
 * authenticated route module to reuse forty lines of markup would drag the
 * whole wizard's dependency graph onto a public page.
 */
function FilterPill({
  label,
  count,
  active,
  onClick,
  thumbUrl,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  thumbUrl?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full py-1.5 pr-3.5 text-xs font-bold transition ${
        thumbUrl ? "pl-1.5" : "pl-3.5"
      } ${
        active
          ? "bg-gradient-primary text-primary-foreground shadow-glow"
          : "bg-surface-2 text-muted-foreground hover:text-foreground"
      }`}
    >
      {thumbUrl && <img src={thumbUrl} alt="" className="h-5 w-5 rounded-full object-cover" />}
      <span className="max-w-[9rem] truncate">{label}</span>
      <span
        className={`grid min-w-[1.15rem] place-items-center rounded-full px-1.5 text-micro font-bold ${
          active ? "bg-white/25 text-primary-foreground" : "bg-foreground/10 text-foreground/70"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

/** One collection tile. Always a link — the boards grid that used to render
 * inert copies of this card is now the pill row above it. */
function CoverCard({
  name,
  subtitle,
  coverUrl,
  coverColor,
  brand,
  to,
}: {
  name: string;
  subtitle: string;
  coverUrl: string | null;
  coverColor: string | null;
  brand: string;
  to: { to: string; params: { slug: string }; search: { c: string } };
}) {
  return (
    <Link
      to={to.to}
      params={to.params}
      search={to.search}
      className="group block overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"
    >
      <div
        className="relative aspect-square w-full"
        style={{
          background: coverUrl
            ? undefined
            : `linear-gradient(135deg, ${coverColor ?? brand}, transparent)`,
        }}
      >
        {coverUrl && (
          <img
            src={coverUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
        <div className="absolute inset-x-3 bottom-3 text-white">
          <div className="truncate text-sm font-semibold drop-shadow">{name}</div>
          <div className="text-micro opacity-80">{subtitle}</div>
        </div>
      </div>
    </Link>
  );
}

/* ============================================================================
   One collection, as a visitor sees it — the destination of a shared link.

   Products carry exactly ONE call to action: Buy now. No price comparison, no
   "view details", no secondary link. A second button on a product card competes
   with the only tap that earns the creator anything, and every extra choice is
   a chance to not buy.
   ========================================================================== */

/**
 * The currency symbol to print in front of a stored price.
 *
 * Every price in this app is rupees: the retailer allowlist is Indian
 * (CK_SUPPORTED_RETAILER_DOMAINS), Lens prices are parsed as ₹, and the in-app
 * card's `realProductPrice` hardcodes ₹.
 *
 * The `storefront_products.currency` column, however, was created as
 * `TEXT DEFAULT 'USD'` (20260706061832) and NOTHING has ever written to it — so
 * a stored "USD" means "nobody set this", not "priced in dollars". Reading it
 * literally is what put a $ in front of ₹2,199 on the public page while the
 * in-app card showed ₹ for the same product. Treat it as the unset default it is.
 */
function currencySymbol(currency: string | null): string {
  const code = (currency ?? "").trim().toUpperCase();
  if (!code || code === "USD" || code === "INR" || code === "₹") return "₹";
  const map: Record<string, string> = { GBP: "£", EUR: "€" };
  return map[code] ?? currency!;
}

/**
 * True when the signed-in visitor is the creator who owns this storefront.
 *
 * Read from the LOCAL session (getSession, not getUser) so an anonymous shopper
 * pays no network round-trip for a check that is always going to come back
 * false. This gates UI only — every write still goes through the
 * `products owner all` RLS policy (20260706061832), which is the real
 * authority. Runs in an effect because the page is server-rendered: the server
 * has no session, so owner-only chrome must appear after hydration or the
 * markup would not match.
 */
function useIsOwner(ownerId: string): boolean {
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (alive) setIsOwner(data.session?.user?.id === ownerId);
      })
      .catch(() => {
        /* no session, no owner chrome — nothing to report to a shopper */
      });
    return () => {
      alive = false;
    };
  }, [ownerId]);
  return isOwner;
}

/**
 * Shopper-facing names for the internal category vocabulary
 * (`PRODUCT_CATEGORIES`). The enum is singular and lowercase because the
 * detector and the match gate compare against it; a pill is read by a person,
 * so it says "Dresses", not "dress". `other` becomes "More" — it means
 * "nothing recognisable", and no shopper needs to know that.
 */
const CATEGORY_LABEL: Record<ProductCategory, string> = {
  top: "Tops",
  outerwear: "Outerwear",
  dress: "Dresses",
  bottom: "Bottoms",
  innerwear: "Innerwear",
  footwear: "Footwear",
  bag: "Bags",
  accessory: "Accessories",
  watch: "Watches",
  jewellery: "Jewellery",
  eyewear: "Eyewear",
  headwear: "Headwear",
  beauty: "Beauty",
  electronics: "Electronics",
  furniture: "Furniture",
  decor: "Decor",
  kitchen: "Kitchen",
  fitness: "Fitness",
  toys: "Toys",
  stationery: "Stationery",
  pet: "Pet",
  other: "More",
};

type PublicProduct = {
  id: string;
  title: string;
  image_url: string | null;
  affiliate_url: string;
  price_cents: number | null;
  currency: string | null;
};

function CollectionView({
  store,
  collection,
  products,
  pins,
  brand,
  backgroundUrl,
}: {
  store: { name: string; slug: string; user_id: string };
  collection: {
    id: string;
    name: string;
    description: string | null;
    cover_image_url: string | null;
    cover_color: string | null;
  };
  products: PublicProduct[];
  pins: Array<{ id: string; image_url: string | null }>;
  brand: string;
  backgroundUrl: string;
}) {
  const router = useRouter();
  const isOwner = useIsOwner(store.user_id);
  const [reorderOpen, setReorderOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  /** Active category pill — null is "All". */
  const [activeCat, setActiveCat] = useState<ProductCategory | null>(null);
  /** Order the creator just saved. Held locally so the grid re-sorts on the
   * same tap that saves, instead of waiting for the loader to come back. */
  const [savedOrder, setSavedOrder] = useState<string[] | null>(null);

  // The pin this collection was built from is the visual anchor of the page —
  // a shopper who tapped a pin should see that pin here, not just its products.
  const thumbUrl =
    collection.cover_image_url ??
    pins.find((p) => p.image_url)?.image_url ??
    products.find((p) => p.image_url)?.image_url ??
    null;

  const ordered = useMemo(() => {
    if (!savedOrder) return products;
    const byId = new Map(products.map((p) => [p.id, p]));
    const seen = new Set(savedOrder);
    const list = savedOrder.map((id) => byId.get(id)).filter(Boolean) as PublicProduct[];
    // Anything the saved order doesn't know about (added from another tab
    // meanwhile) keeps its loader position at the end rather than vanishing.
    for (const p of products) if (!seen.has(p.id)) list.push(p);
    return list;
  }, [products, savedOrder]);

  // Category pills over the products, read off each title with the same
  // classifier the match pipeline uses — so a collection built from one pin
  // ("17 products") becomes browsable by what the things ARE rather than one
  // undifferentiated wall of cards.
  const catOf = useMemo(() => {
    const m = new Map<string, ProductCategory>();
    for (const p of ordered) m.set(p.id, categoryOfTitle(p.title));
    return m;
  }, [ordered]);

  // Ordered by size, "More" (the honest unknown) always last.
  const catPills = useMemo(() => {
    const counts = new Map<ProductCategory, number>();
    for (const p of ordered) {
      const c = catOf.get(p.id) ?? "other";
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => {
        if (a[0] === "other") return 1;
        if (b[0] === "other") return -1;
        return b[1] - a[1];
      })
      .map(([cat, count]) => ({ cat, count }));
  }, [ordered, catOf]);
  // One named category is enough — same rule as the pills over matching
  // products in the app, where a single detected component still gets "All"
  // plus its own pill. A collection built from a pin with one product is the
  // common case, and it was the one showing no pills at all.
  //
  // A lone "More" is still no row: "All 1 · More 1" tells a shopper nothing,
  // because `other` means "unrecognised", not a category to browse.
  const showCatPills = catPills.some((p) => p.cat !== "other");

  const shown = useMemo(
    () => (activeCat ? ordered.filter((p) => catOf.get(p.id) === activeCat) : ordered),
    [activeCat, ordered, catOf],
  );

  // The pill can disappear under a shopper standing on it (the creator removed
  // the last product in it, and the loader came back with one fewer category).
  useEffect(() => {
    if (activeCat && !catPills.some((p) => p.cat === activeCat)) setActiveCat(null);
  }, [activeCat, catPills]);

  async function saveOrder(ids: string[]) {
    setSaving(true);
    try {
      // One UPDATE per row: there is no unique key to upsert against, and an
      // upsert would have to resend every NOT NULL column of every product.
      //
      // `position` is renumbered 0..n-1 within THIS collection, so two
      // collections can hold the same numbers. That is fine — the loader
      // buckets products by collection before rendering, so positions are only
      // ever compared against siblings that appear on the same page.
      const results = await Promise.all(
        ids.map((id, idx) =>
          supabase.from("storefront_products").update({ position: idx }).eq("id", id),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
      setSavedOrder(ids);
      setReorderOpen(false);
      notifyDone("Order saved — this is what shoppers see");
      // Refetch the loader so a reload agrees with what's on screen.
      router.invalidate();
    } catch (e) {
      notifyProblem(e instanceof Error ? e.message : "Could not save the order");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="relative h-40 w-full overflow-hidden sm:h-52">
        <img src={backgroundUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/5 to-background" />
        {/* Back to the storefront. A chip on the cover rather than a line of
            text under it, so the header row below belongs to the collection. */}
        <Link
          to="/s/$slug"
          params={{ slug: store.slug }}
          search={{ c: undefined }}
          className="absolute left-4 top-4 z-20 inline-flex max-w-[70%] items-center gap-1.5 rounded-full bg-black/40 px-3 py-2 text-sm font-medium text-white backdrop-blur-sm transition hover:bg-black/60"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          <span className="truncate">{store.name}</span>
        </Link>
      </div>

      <header className="relative z-10 mx-auto max-w-5xl px-6">
        <div className="-mt-14 flex flex-col gap-4 sm:-mt-16 sm:flex-row sm:items-end sm:gap-5">
          {/* Pin thumbnail */}
          <button
            type="button"
            onClick={() => thumbUrl && setZoomed(true)}
            disabled={!thumbUrl}
            aria-label={thumbUrl ? "View pin image" : undefined}
            className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-3xl border-4 border-background bg-surface-2 shadow-elevate transition enabled:hover:-translate-y-0.5 sm:h-28 sm:w-28"
            style={
              thumbUrl
                ? undefined
                : {
                    background: `linear-gradient(135deg, ${collection.cover_color ?? brand}, transparent)`,
                  }
            }
          >
            {thumbUrl ? (
              <>
                <img
                  src={thumbUrl}
                  alt=""
                  className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                />
                <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                  <Maximize2 className="h-5 w-5 text-white" />
                </span>
              </>
            ) : (
              <span className="grid h-full w-full place-items-center text-white/80">
                <ImageIcon className="h-6 w-6" />
              </span>
            )}
          </button>

          <div className="min-w-0 flex-1 sm:pb-1">
            <h1 className="font-display text-2xl font-semibold leading-tight sm:text-3xl">
              {collection.name}
            </h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-foreground">
                <ShoppingBag className="h-3.5 w-3.5" style={{ color: brand }} />
                {ordered.length} product{ordered.length === 1 ? "" : "s"}
              </span>
              <span className="text-xs">from {store.name}</span>
            </p>
            {collection.description && (
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                {collection.description}
              </p>
            )}
          </div>

          {/* Owner-only. A shopper never sees it: order is the creator's
              merchandising decision, and RLS refuses the write anyway. */}
          {isOwner && ordered.length >= 2 && (
            <div className="flex items-center gap-2 sm:pb-1">
              <button
                type="button"
                onClick={() => setReorderOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-2 text-xs font-semibold shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-elevate"
              >
                <ArrowUpDown className="h-3.5 w-3.5" /> Reorder
              </button>
              <span className="hidden text-micro text-muted-foreground sm:inline">
                Only you
                <br />
                see this
              </span>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {showCatPills && (
          <div className="no-scrollbar -mx-1 mb-5 flex items-center gap-2 overflow-x-auto px-1">
            <FilterPill
              label="All"
              count={ordered.length}
              active={activeCat === null}
              onClick={() => setActiveCat(null)}
            />
            {catPills.map(({ cat, count }) => (
              <FilterPill
                key={cat}
                label={CATEGORY_LABEL[cat]}
                count={count}
                active={activeCat === cat}
                onClick={() => setActiveCat(cat)}
              />
            ))}
          </div>
        )}
        {ordered.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {shown.map((p) => (
              <ProductCard key={p.id} product={p} brand={brand} />
            ))}
          </div>
        ) : (
          <>
            {/* No products attached yet, but the collection's pins still show —
                an empty grid would make a shared link look broken. */}
            {pins.length > 0 && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {pins
                  .filter((p) => p.image_url)
                  .map((p) => (
                    <div
                      key={p.id}
                      className="overflow-hidden rounded-2xl border border-border bg-surface"
                    >
                      <img
                        src={p.image_url!}
                        alt=""
                        loading="lazy"
                        className="aspect-square w-full object-cover"
                      />
                    </div>
                  ))}
              </div>
            )}
            {pins.length === 0 && <EmptyState text="Nothing in this collection yet." />}
          </>
        )}
      </main>

      <footer className="px-6 py-8 text-center text-xs text-muted-foreground">
        Powered by{" "}
        <Link to="/" className="text-primary hover:underline">
          ShopMyPin
        </Link>
      </footer>

      {zoomed && thumbUrl && (
        <Lightbox src={thumbUrl} alt={collection.name} onClose={() => setZoomed(false)} />
      )}

      {reorderOpen && (
        <ReorderProductsDialog
          products={ordered}
          brand={brand}
          pending={saving}
          onSave={saveOrder}
          onClose={() => setReorderOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * One product.
 *
 * The WHOLE card is the affiliate link — one destination, one tap target, so a
 * thumb that lands anywhere on the card still earns. The "Buy now" pill is a
 * div, not a nested anchor: it exists to say where the tap goes, and nesting a
 * second <a> inside one is invalid markup that browsers un-nest unpredictably.
 *
 * Still exactly ONE call to action: no compare, no "view details", and
 * deliberately no earnings pill — the commission is the creator's business,
 * never the shopper's.
 */
function ProductCard({ product: p, brand }: { product: PublicProduct; brand: string }) {
  // Same helper the in-app SuggestionCard uses, so the struck-through "was"
  // price a visitor sees is the same number the creator sees.
  const parts = productPriceParts(p.price_cents, currencySymbol(p.currency));
  const retailer = brandForUrl(p.affiliate_url);
  const logo = retailer ? brandLogoUrl(retailer) : null;
  return (
    <a
      href={p.affiliate_url}
      target="_blank"
      /* rel="sponsored nofollow" because this is a paid affiliate link;
         noopener/noreferrer so the retailer's page gets no handle on this tab. */
      rel="sponsored nofollow noopener noreferrer"
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-sm transition hover:-translate-y-1 hover:border-primary/50 hover:shadow-elevate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-surface-2">
        {p.image_url ? (
          <img
            src={p.image_url}
            alt={p.title}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.06]"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent" />
        {parts?.discountPct != null && parts.discountPct > 0 && (
          <span className="absolute left-2 top-2 rounded-full bg-amber-500 px-2 py-0.5 text-micro font-bold text-white shadow-sm">
            {parts.discountPct}% OFF
          </span>
        )}
        {/* Retailer badge: a real logo when we know the domain, its name when
            we don't — a shopper decides partly on who they are buying from. */}
        <span className="absolute bottom-2 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-white/95 py-1 pl-1 pr-2.5 shadow-sm">
          {logo ? (
            <img src={logo} alt="" className="h-4 w-4 rounded-full object-contain" />
          ) : (
            <span
              className="h-4 w-4 shrink-0 rounded-full"
              style={{ background: retailer?.color ?? brand }}
            />
          )}
          <span className="truncate text-micro font-bold uppercase tracking-wide text-neutral-800">
            {retailer?.name ?? hostBrand(p.affiliate_url)}
          </span>
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 min-h-[2.4em] text-xs font-semibold leading-snug text-foreground">
          {p.title}
        </h3>

        {parts && (
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-lead font-extrabold tracking-tight text-foreground">
              {parts.price}
            </span>
            {parts.mrp && (
              <span className="text-mini font-medium text-muted-foreground line-through">
                {parts.mrp}
              </span>
            )}
          </div>
        )}

        <span
          className="mt-auto flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-semibold text-white transition group-hover:brightness-110 group-active:scale-[0.99]"
          style={{ background: brand }}
        >
          Buy now
          <ArrowUpRight className="h-4 w-4" />
        </span>
      </div>
    </a>
  );
}

/** The pin, full size. Tap anywhere (or Esc) to leave. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6 backdrop-blur-sm"
    >
      <img
        src={src}
        alt={alt}
        className="max-h-[85vh] max-w-full rounded-2xl object-contain shadow-elevate"
      />
      <button
        type="button"
        aria-label="Close"
        className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white backdrop-blur transition hover:bg-white/25"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * Reordering, for the creator standing on their own public page.
 *
 * Drag is the primary gesture, but every row also carries up/down buttons:
 * drag-and-drop is unusable with a keyboard, awkward on a long list on a phone,
 * and the arrows are the same operation with a guaranteed hit target. The
 * numbers renumber live, so "make this one first" is visibly done before the
 * save.
 *
 * Nothing is written until Save, and Save is disabled until the order actually
 * differs — a creator who opens this to look does not silently rewrite 20 rows.
 */
function ReorderProductsDialog({
  products,
  brand,
  pending,
  onSave,
  onClose,
}: {
  products: PublicProduct[];
  brand: string;
  pending: boolean;
  onSave: (order: string[]) => void;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<string[]>(() => products.map((p) => p.id));
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const dirty = order.some((id, i) => products[i]?.id !== id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  const move = (id: string, dir: -1 | 1) =>
    setOrder((prev) => {
      const i = prev.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      next[i] = prev[j];
      next[j] = prev[i];
      return next;
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 p-0 backdrop-blur sm:items-center sm:p-4"
      onClick={() => !pending && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Reorder products"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-border bg-surface shadow-elevate sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div>
            <h3 className="font-display text-base font-semibold">Reorder products</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Drag a row, or use the arrows. Top of the list shows first.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <Reorder.Group
          axis="y"
          values={order}
          onReorder={setOrder}
          className="flex flex-1 flex-col gap-2 overflow-y-auto p-3"
        >
          {order.map((id, idx) => {
            const p = byId.get(id);
            if (!p) return null;
            const parts = productPriceParts(p.price_cents, currencySymbol(p.currency));
            return (
              <Reorder.Item
                key={id}
                value={id}
                whileDrag={{
                  scale: 1.03,
                  boxShadow: "0 20px 40px -12px rgba(0,0,0,0.35)",
                  zIndex: 10,
                }}
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
                className="flex touch-none select-none items-center gap-2.5 rounded-2xl border border-border bg-surface p-2 shadow-sm active:cursor-grabbing"
              >
                <span className="grid h-7 w-7 shrink-0 cursor-grab place-items-center text-muted-foreground active:cursor-grabbing">
                  <GripVertical className="h-4 w-4" />
                </span>
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-micro font-bold text-white"
                  style={{ background: brand }}
                >
                  {idx + 1}
                </span>
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-surface-2">
                  {p.image_url ? (
                    <img src={p.image_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="grid h-full w-full place-items-center text-muted-foreground">
                      <ImageIcon className="h-4 w-4" />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold">{p.title}</p>
                  <p className="truncate text-micro uppercase tracking-wide text-muted-foreground">
                    {parts?.price ? `${parts.price} · ` : ""}
                    {brandForUrl(p.affiliate_url)?.name ?? hostBrand(p.affiliate_url)}
                  </p>
                </div>
                {/* Same move as a drag, with a target a thumb can hit and a
                    keyboard can reach. Pointer-down is stopped so pressing an
                    arrow never starts a drag instead. */}
                <div className="flex shrink-0 flex-col">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={idx === 0}
                    onPointerDownCapture={(e) => e.stopPropagation()}
                    onClick={() => move(id, -1)}
                    className="grid h-6 w-7 place-items-center rounded-t-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={idx === order.length - 1}
                    onPointerDownCapture={(e) => e.stopPropagation()}
                    onClick={() => move(id, 1)}
                    className="grid h-6 w-7 place-items-center rounded-b-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </div>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <span className="text-micro text-muted-foreground">
            {dirty ? "Unsaved changes" : "No changes yet"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending || !dirty}
              onClick={() => onSave(order)}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
              style={{ background: brand }}
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Save order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-12 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <h1 className="font-display text-2xl font-semibold">Storefront not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">This link may have been removed.</p>
        <Link to="/" className="mt-6 inline-block text-sm text-primary hover:underline">
          Back to ShopMyPin
        </Link>
      </div>
    </div>
  );
}

function ErrorBoundary() {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <h1 className="font-display text-2xl font-semibold">Something went wrong</h1>
        <Link to="/" className="mt-6 inline-block text-sm text-primary hover:underline">
          Back to ShopMyPin
        </Link>
      </div>
    </div>
  );
}
