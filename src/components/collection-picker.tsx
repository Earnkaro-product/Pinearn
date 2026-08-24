import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, Image as ImageIcon, Loader2, Plus, Store } from "lucide-react";
import { notifyProblem } from "@/lib/notify";

import { useOverlayChrome } from "@/components/app-sheet";
import { supabase } from "@/integrations/supabase/client";
import { brandForUrl, brandLogoUrl, estimateCommissionPct, hostBrand } from "@/lib/brands";
import { getFriendlyMessage } from "@/lib/friendly-error";

export type PickableProduct = {
  id: string;
  title: string;
  image_url: string | null;
  affiliate_url: string;
  price_cents: number | null;
  commission_pct: number | null;
  collection_id: string | null;
};

type Bucket = { id: string; name: string; items: PickableProduct[] };

const NO_COLLECTION = "__none__";

// Same "was" price synthesis SuggestionCard uses for real stored products
// (which only carry one selling price, no MRP field) — deterministic, not
// random, so a card's discount badge never flickers across re-renders.
function computeMrp(price: number): number {
  const inflated = price * 1.25;
  const step = inflated >= 1000 ? 50 : 10;
  return Math.ceil(inflated / step) * step;
}

function money(n: number) {
  return `₹${n.toLocaleString("en-IN")}`;
}

/**
 * The full "Add from Collection" sub-flow — a self-contained two-step,
 * full-screen picker (collections grid, then that collection's products)
 * used identically by both places a pin's products get manually picked from
 * an existing collection: the single-pin attach dialog and the
 * monetize-a-whole-board reviewer. Keeping one shared implementation is what
 * guarantees the two flows stay pixel-identical.
 */
export function CollectionAddFlow({
  products,
  pickedIds,
  onTogglePicked,
  onExit,
}: {
  products: PickableProduct[];
  pickedIds: Set<string>;
  onTogglePicked: (id: string) => void;
  onExit: () => void;
}) {
  const qc = useQueryClient();
  const { data: collections = [] } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("collections")
        .select("id,name,slug")
        .eq("user_id", userId)
        .order("position", { ascending: true });
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const buckets = useMemo<Bucket[]>(() => {
    const byCollection = new Map<string, PickableProduct[]>();
    for (const p of products) {
      const key = p.collection_id ?? NO_COLLECTION;
      const list = byCollection.get(key);
      if (list) list.push(p);
      else byCollection.set(key, [p]);
    }
    const named = collections
      .filter((c) => byCollection.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, items: byCollection.get(c.id)! }));
    const loose = byCollection.get(NO_COLLECTION);
    if (loose?.length) named.push({ id: NO_COLLECTION, name: "Other products", items: loose });
    return named;
  }, [products, collections]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const active = buckets.find((b) => b.id === activeId) ?? null;

  if (active) {
    return (
      <CollectionProductsScreen
        bucket={active}
        pickedIds={pickedIds}
        onToggle={onTogglePicked}
        onBack={() => setActiveId(null)}
        onDone={onExit}
      />
    );
  }

  return (
    <CollectionsScreen
      buckets={buckets}
      onBack={onExit}
      onSelect={setActiveId}
      onCreated={(id) => {
        qc.invalidateQueries({ queryKey: ["collections"] });
        setActiveId(id);
      }}
    />
  );
}

function CollectionsScreen({
  buckets,
  onBack,
  onSelect,
  onCreated,
}: {
  buckets: Bucket[];
  onBack: () => void;
  onSelect: (id: string) => void;
  onCreated: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  // A full-screen takeover is still a modal: Escape backs out and the page it
  // covers doesn't scroll underneath.
  useOverlayChrome({ onClose: onBack });

  const { data: storefrontId } = useQuery({
    queryKey: ["my-storefront-id"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return null;
      const { data } = await supabase
        .from("storefronts")
        .select("id")
        .eq("user_id", userId)
        .order("is_default", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.id ?? null;
    },
  });

  const createCollection = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Give the collection a name first");
      if (!storefrontId) throw new Error("Set up your storefront first");
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) throw new Error("Not signed in");
      const slug = `${trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
      const { data, error } = await supabase
        .from("collections")
        .insert({
          user_id: userId,
          storefront_id: storefrontId,
          name: trimmed,
          slug,
          source: "manual",
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      setCreating(false);
      setName("");
      onCreated(id);
    },
    onError: (e: Error) => notifyProblem(getFriendlyMessage(e)),
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="collections-title"
      className="fixed inset-0 z-[80] flex flex-col bg-background"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 id="collections-title" className="flex-1 font-display text-xl font-bold">
          Collections
        </h2>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-sm font-bold text-primary transition hover:bg-primary/10"
        >
          <Plus className="h-4 w-4" /> New Collection
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {creating && (
          <div className="mb-4 rounded-2xl border border-border bg-surface p-3.5 shadow-sm">
            <label className="text-mini font-semibold uppercase tracking-wide text-muted-foreground">
              Collection name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Kurtis under ₹2000"
              className="mt-1.5 w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-2.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setName("");
                }}
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!name.trim() || createCollection.isPending}
                onClick={() => createCollection.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-60"
              >
                {createCollection.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        )}

        {buckets.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-dashed border-border bg-surface-2/40 p-6 text-center text-sm text-muted-foreground">
            No products in your collections yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {buckets.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => onSelect(b.id)}
                className="group text-left"
              >
                <CollectionCoverGrid images={b.items.map((p) => p.image_url)} />
                <div className="px-0.5 pt-2">
                  <h3 className="truncate text-sm font-semibold">{b.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {b.items.length} product{b.items.length === 1 ? "" : "s"}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CollectionCoverGrid({ images }: { images: (string | null)[] }) {
  const quads = [images[0] ?? null, images[1] ?? null, images[2] ?? null, images[3] ?? null];
  return (
    <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-2xl bg-surface ring-1 ring-border/60 transition group-hover:shadow-elevate">
      {quads.map((src, i) => (
        <div key={i} className="relative overflow-hidden bg-surface-2">
          {src ? (
            <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="grid h-full w-full place-items-center text-muted-foreground/40">
              <ImageIcon className="h-4 w-4" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CollectionProductsScreen({
  bucket,
  pickedIds,
  onToggle,
  onBack,
  onDone,
}: {
  bucket: Bucket;
  pickedIds: Set<string>;
  onToggle: (id: string) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const selectedCount = bucket.items.filter((p) => pickedIds.has(p.id)).length;
  const allSelected = bucket.items.length > 0 && selectedCount === bucket.items.length;
  // Escape steps back one level, matching the header's back arrow.
  useOverlayChrome({ onClose: onBack });

  const toggleAll = () => {
    if (allSelected) {
      bucket.items.forEach((p) => {
        if (pickedIds.has(p.id)) onToggle(p.id);
      });
    } else {
      bucket.items.forEach((p) => {
        if (!pickedIds.has(p.id)) onToggle(p.id);
      });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="collection-products-title"
      className="fixed inset-0 z-[80] flex flex-col bg-background"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2
          id="collection-products-title"
          className="flex-1 truncate font-display text-lg font-bold"
        >
          {bucket.name}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24">
        <div className="mb-4 flex items-center justify-between rounded-2xl bg-gradient-to-r from-amber-200/60 to-orange-200/40 px-4 py-3">
          <p className="truncate text-sm font-bold">{bucket.name}</p>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-semibold">
            Select all
            <span
              onClick={(e) => {
                e.preventDefault();
                toggleAll();
              }}
              className={`grid h-5 w-5 place-items-center rounded-md border-2 transition ${
                allSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-foreground/30 bg-white/70"
              }`}
            >
              {allSelected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
            </span>
          </label>
        </div>

        {bucket.items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-surface-2/40 p-6 text-center text-sm text-muted-foreground">
            No products in this collection yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {bucket.items.map((p) => (
              <PickableProductCard
                key={p.id}
                product={p}
                selected={pickedIds.has(p.id)}
                onToggle={() => onToggle(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div
        className="fixed inset-x-0 bottom-0 border-t border-border/60 bg-background/95 px-4 py-3 backdrop-blur-xl"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={onDone}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
        >
          Done{selectedCount > 0 ? ` (${selectedCount} selected)` : ""}
        </button>
      </div>
    </div>
  );
}

function PickableProductCard({
  product,
  selected,
  onToggle,
}: {
  product: PickableProduct;
  selected: boolean;
  onToggle: () => void;
}) {
  const source = hostBrand(product.affiliate_url);
  const brand = brandForUrl(product.affiliate_url);
  const logo = brand ? brandLogoUrl(brand) : null;
  const [logoFailed, setLogoFailed] = useState(false);

  const price = product.price_cents != null ? product.price_cents / 100 : null;
  const pct = product.commission_pct ?? estimateCommissionPct(source);
  const mrp = price != null ? computeMrp(price) : null;
  const hasDiscount = !!(price != null && mrp && mrp > price);
  const discountPct = hasDiscount ? Math.round((1 - price! / mrp!) * 100) : null;
  const earning = price != null ? Math.round(price * (pct / 100)) : null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`group flex flex-col overflow-hidden rounded-2xl border bg-surface text-left shadow-sm transition ${
        selected ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/50"
      }`}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-surface-2">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
        {logo && !logoFailed ? (
          <img
            src={logo}
            alt={source}
            onError={() => setLogoFailed(true)}
            className="absolute bottom-2 left-2 h-5 max-w-[60%] rounded bg-white/90 object-contain px-1 py-0.5 shadow"
          />
        ) : (
          <span className="absolute bottom-2 left-2 max-w-[70%] truncate rounded-full bg-black/60 px-2 py-0.5 text-nano font-bold uppercase tracking-wide text-white backdrop-blur">
            {source}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <h3 className="line-clamp-1 text-xs font-semibold leading-snug text-foreground">
          {product.title}
        </h3>

        <div className="flex items-center justify-between gap-1.5">
          <div className="min-w-0">
            {price != null && (
              <div className="flex flex-wrap items-baseline gap-1">
                <span className="text-body font-extrabold tracking-tight">{money(price)}</span>
                {hasDiscount && (
                  <span className="text-micro font-medium text-muted-foreground line-through">
                    {money(mrp!)}
                  </span>
                )}
                {discountPct != null && discountPct > 0 && (
                  <span className="text-micro font-bold text-amber-600">{discountPct}% OFF</span>
                )}
              </div>
            )}
            {earning != null && (
              <p className="text-mini font-bold text-emerald-600">Earn / sale ₹{earning}</p>
            )}
          </div>

          <span
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition ${
              selected
                ? "bg-primary text-primary-foreground"
                : "bg-emerald-500 text-white shadow-sm shadow-emerald-500/40"
            }`}
          >
            {selected ? (
              <Check className="h-4 w-4" strokeWidth={3} />
            ) : (
              <Plus className="h-4 w-4" strokeWidth={3} />
            )}
          </span>
        </div>
      </div>
    </button>
  );
}

// The button that opens this flow — identical trigger in both places.
export function AddFromCollectionButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl border border-border bg-surface px-4 py-3 text-sm font-bold text-foreground transition hover:bg-surface-2 active:scale-[0.98]"
    >
      <Store className="h-4 w-4 text-primary" /> Add from Collection
    </button>
  );
}
