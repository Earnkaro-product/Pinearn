import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

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
    return {
      store,
      collections: collections ?? [],
      pins: pins ?? [],
      boards: boards ?? [],
      boardCollections,
      profile: profile ?? null,
    };
  });

export const Route = createFileRoute("/s/$slug")({
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
    profile,
  } = Route.useLoaderData();
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
                return (
                  <CoverCard
                    key={c.id}
                    name={c.name}
                    subtitle={`${cPins.length} pin${cPins.length === 1 ? "" : "s"}`}
                    coverUrl={cover}
                    coverColor={c.cover_color}
                    brand={brand}
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
}: {
  name: string;
  subtitle: string;
  coverUrl: string | null;
  coverColor: string | null;
  brand: string;
  mosaic?: string[];
}) {
  const showMosaic = !coverUrl && mosaic && mosaic.length >= 2;
  return (
    <div className="group overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">
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
