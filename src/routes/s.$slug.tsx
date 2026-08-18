import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ChevronLeft, Image as ImageIcon } from "lucide-react";
import { z } from "zod";

import { hostBrand } from "@/lib/brands";
import { productPriceParts } from "@/lib/product-price";

const DEFAULT_BACKGROUND =
  "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1600&q=80&auto=format&fit=crop";

export const getPublicStorefront = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => z.object({ slug: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });
    const { data: store } = await sb
      .from("storefronts")
      .select("id,user_id,name,slug,description,brand_color,background_image_url")
      .eq("slug", data.slug)
      .maybeSingle();
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
  const [tab, setTab] = useState<"collections" | "boards">("collections");

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

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Background band */}
      <div className="relative h-48 w-full overflow-hidden sm:h-64">
        <img src={backgroundUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-background" />
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
        {/* Tabs */}
        {boards.length > 0 && (
          <div className="mx-auto mb-6 flex max-w-xs items-center justify-center gap-1 rounded-full border border-border bg-surface p-1">
            <button
              onClick={() => setTab("collections")}
              className={`flex-1 rounded-full px-4 py-2 text-sm font-semibold transition ${
                tab === "collections"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Collections
            </button>
            <button
              onClick={() => setTab("boards")}
              className={`flex-1 rounded-full px-4 py-2 text-sm font-semibold transition ${
                tab === "boards"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Boards
            </button>
          </div>
        )}

        {tab === "collections" ? (
          collections.length > 0 ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {collections.map((c: C) => {
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
          )
        ) : boards.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {boards.map((b: B) => {
              const memberIds = collectionsByBoard.get(b.id) ?? [];
              const memberCollections = collections.filter((c: C) => memberIds.includes(c.id));
              const mosaic: string[] = [];
              for (const mc of memberCollections) {
                const img =
                  mc.cover_image_url ??
                  pins.find((p: P) => p.collection_id === mc.id && p.image_url)?.image_url ??
                  null;
                if (img) mosaic.push(img);
                if (mosaic.length >= 4) break;
              }
              const cover = b.cover_image_url ?? mosaic[0] ?? null;
              return (
                <CoverCard
                  key={b.id}
                  name={b.name}
                  subtitle={`${memberCollections.length} collection${memberCollections.length === 1 ? "" : "s"}`}
                  coverUrl={cover}
                  coverColor={null}
                  brand={brand}
                  mosaic={mosaic}
                />
              );
            })}
          </div>
        ) : (
          <EmptyState text="No boards yet." />
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

function CoverCard({
  name,
  subtitle,
  coverUrl,
  coverColor,
  brand,
  mosaic,
  to,
}: {
  name: string;
  subtitle: string;
  coverUrl: string | null;
  coverColor: string | null;
  brand: string;
  mosaic?: string[];
  /** When present the whole card becomes a link. Boards have no destination
   * yet, so they stay inert rather than pretending to be tappable. */
  to?: { to: string; params: { slug: string }; search: { c: string } };
}) {
  const showMosaic = !coverUrl && mosaic && mosaic.length >= 2;
  const Wrapper = to
    ? ({ children }: { children: React.ReactNode }) => (
        <Link
          to={to.to}
          params={to.params}
          search={to.search}
          className="group block overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"
        >
          {children}
        </Link>
      )
    : ({ children }: { children: React.ReactNode }) => (
        <div className="group overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          {children}
        </div>
      );
  return (
    <Wrapper>
      <div
        className="relative aspect-square w-full"
        style={{
          background:
            coverUrl || showMosaic
              ? undefined
              : `linear-gradient(135deg, ${coverColor ?? brand}, transparent)`,
        }}
      >
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        ) : showMosaic ? (
          <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-0.5">
            {mosaic!.slice(0, 4).map((src, i) => (
              <img key={i} src={src} alt="" className="h-full w-full object-cover" />
            ))}
          </div>
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
        <div className="absolute inset-x-3 bottom-3 text-white">
          <div className="truncate text-sm font-semibold drop-shadow">{name}</div>
          <div className="text-micro opacity-80">{subtitle}</div>
        </div>
      </div>
    </Wrapper>
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

function CollectionView({
  store,
  collection,
  products,
  pins,
  brand,
  backgroundUrl,
}: {
  store: { name: string; slug: string };
  collection: { name: string; description: string | null };
  products: Array<{
    id: string;
    title: string;
    image_url: string | null;
    affiliate_url: string;
    price_cents: number | null;
    currency: string | null;
  }>;
  pins: Array<{ id: string; image_url: string | null }>;
  brand: string;
  backgroundUrl: string;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="relative h-36 w-full overflow-hidden sm:h-48">
        <img src={backgroundUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-background" />
      </div>

      <header className="mx-auto max-w-5xl px-6 pt-4">
        <Link
          to="/s/$slug"
          params={{ slug: store.slug }}
          search={{ c: undefined }}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> {store.name}
        </Link>
        <h1 className="mt-3 font-display text-2xl font-semibold sm:text-3xl">{collection.name}</h1>
        {collection.description && (
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">{collection.description}</p>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          {products.length} product{products.length === 1 ? "" : "s"}
        </p>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        {products.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {products.map((p) => {
              // Same helper the in-app SuggestionCard uses, so the struck-through
              // "was" price a visitor sees is the same number the creator sees.
              const parts = productPriceParts(p.price_cents, currencySymbol(p.currency));
              return (
                <article
                  key={p.id}
                  className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-sm transition hover:-translate-y-1 hover:border-primary/50 hover:shadow-elevate"
                >
                  <div className="relative aspect-square w-full overflow-hidden bg-surface-2">
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
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
                  </div>

                  <div className="flex flex-1 flex-col gap-2 p-3">
                    <span className="truncate text-micro font-bold uppercase tracking-wide text-muted-foreground">
                      {hostBrand(p.affiliate_url)}
                    </span>
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
                        {parts.discountPct != null && parts.discountPct > 0 && (
                          <span className="text-mini font-bold text-amber-600">
                            ({parts.discountPct}% OFF)
                          </span>
                        )}
                      </div>
                    )}

                    {/* The ONLY call to action. No compare, no details, no
                        secondary link — and deliberately no earnings pill: the
                        commission is the creator's business, never the shopper's.
                        rel="sponsored nofollow" because this is a paid affiliate
                        link; noopener/noreferrer so the retailer's page gets no
                        handle on this tab. */}
                    <a
                      href={p.affiliate_url}
                      target="_blank"
                      rel="sponsored nofollow noopener noreferrer"
                      className="mt-auto flex items-center justify-center rounded-xl px-3 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.99]"
                      style={{ background: brand }}
                    >
                      Buy now
                    </a>
                  </div>
                </article>
              );
            })}
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
