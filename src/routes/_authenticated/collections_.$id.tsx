import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  GripVertical,
  Image as ImageIcon,
  Link2,
  Loader2,
  Plus,
  Share2,
  ShoppingBag,
  Trash2,
  X,
} from "lucide-react";
import { Reorder, motion } from "framer-motion";
import { AppShell } from "@/components/app-shell";
import { SharePopover } from "@/components/share-popover";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { estimateCommissionPct, hostBrand } from "@/lib/brands";
import { collectionShareUrl } from "@/lib/share-links";
import { getFriendlyMessage } from "@/lib/friendly-error";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { productPriceParts } from "@/lib/product-price";
import { takeDownPin } from "@/lib/pinterest.functions";

/**
 * One collection, full page.
 *
 * This replaced a bottom-sheet dialog on My Store that could only list what was
 * inside. A collection is the unit a creator actually merchandises — it is the
 * thing they share, the thing a shopper lands on — so it gets a page of its
 * own, with the same three edits the public page implies: add a product, remove
 * one, and decide what order they appear in.
 *
 * Every row carries its money, because that is the question being asked when a
 * creator opens a collection: what does this sell for now, and what do I make
 * on it. The two numbers come from the shared price helper, so this page, the
 * product cards and the public storefront can't disagree about the same row.
 */
export const Route = createFileRoute("/_authenticated/collections_/$id")({
  component: CollectionDetailPage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-destructive">{getFriendlyMessage(error)}</div>
  ),
  notFoundComponent: () => (
    <div className="p-6 text-sm text-muted-foreground">Collection not found.</div>
  ),
});

type CollectionRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  cover_image_url: string | null;
  cover_color: string | null;
  storefront_id: string;
};

type ProductRow = {
  id: string;
  title: string;
  image_url: string | null;
  affiliate_url: string;
  price_cents: number | null;
  commission_pct: number | null;
  position: number;
  pin_id: string | null;
};

type PinRow = {
  id: string;
  title: string;
  image_url: string | null;
  external_url: string | null;
  status: string;
};

/**
 * A line on this page. Products routed straight at the collection and products
 * routed through one of its pins are the same thing to a creator, so they are
 * flattened into one list — `pinId` only decides how "remove" is spelled.
 */
type Item = {
  /** `storefront_products.id`, or null for a pin with nothing attached yet. */
  productId: string | null;
  pinId: string | null;
  title: string;
  imageUrl: string | null;
  link: string;
  priceCents: number | null;
  commissionPct: number | null;
};

type PageData = {
  collection: CollectionRow;
  store: { name: string; slug: string; brand_color: string | null };
  items: Item[];
  /** Pins in the collection that have no product on them — not shoppable yet. */
  unattached: PinRow[];
};

function CollectionDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [reordering, setReordering] = useState(false);
  const [order, setOrder] = useState<string[]>([]);

  const { data, isPending } = useQuery({
    queryKey: ["collection-page", id],
    queryFn: async (): Promise<PageData | null> => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return null;

      const { data: collection, error: cErr } = await supabase
        .from("collections")
        .select("id,name,slug,description,cover_image_url,cover_color,storefront_id")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (cErr) throw cErr;
      if (!collection) return null;
      const col = collection as CollectionRow;

      const [{ data: store }, { data: pins, error: pErr }, { data: direct, error: dErr }] =
        await Promise.all([
          supabase
            .from("storefronts")
            .select("name,slug,brand_color")
            .eq("id", col.storefront_id)
            .maybeSingle(),
          supabase
            .from("pins")
            .select("id,title,image_url,external_url,status")
            .eq("collection_id", col.id)
            .eq("user_id", userId)
            .order("created_at", { ascending: false }),
          supabase
            .from("storefront_products")
            .select("id,title,image_url,affiliate_url,price_cents,commission_pct,position,pin_id")
            .eq("collection_id", col.id)
            .eq("user_id", userId)
            .order("position", { ascending: true }),
        ]);
      if (pErr) throw pErr;
      if (dErr) throw dErr;

      const pinRows = (pins ?? []) as PinRow[];
      const pinIds = pinRows.map((p) => p.id);

      // Products attached through a pin carry the pin, not the collection (see
      // 20260720120000_pin_product_routing.sql), so a collection's real product
      // list is the union of both routes.
      let viaPins: ProductRow[] = [];
      if (pinIds.length > 0) {
        const { data: byPin, error: bpErr } = await supabase
          .from("storefront_products")
          .select("id,title,image_url,affiliate_url,price_cents,commission_pct,position,pin_id")
          .in("pin_id", pinIds)
          .eq("user_id", userId)
          .order("position", { ascending: true });
        if (bpErr) throw bpErr;
        viaPins = (byPin ?? []) as ProductRow[];
      }

      const seen = new Set<string>();
      const products: ProductRow[] = [];
      for (const row of [...((direct ?? []) as ProductRow[]), ...viaPins]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        products.push(row);
      }
      products.sort((a, b) => a.position - b.position);

      const pinById = new Map(pinRows.map((p) => [p.id, p]));
      const items: Item[] = products.map((row) => {
        const pin = row.pin_id ? pinById.get(row.pin_id) : undefined;
        return {
          productId: row.id,
          pinId: row.pin_id,
          // A pin-routed product's own title is a generated "Collection — host"
          // string; the pin's title is what the creator actually wrote.
          title: pin?.title || row.title,
          imageUrl: pin?.image_url ?? row.image_url,
          link: row.affiliate_url,
          priceCents: row.price_cents,
          commissionPct: row.commission_pct,
        };
      });

      const monetizedPinIds = new Set(products.map((p) => p.pin_id).filter(Boolean) as string[]);
      const unattached = pinRows.filter((p) => !monetizedPinIds.has(p.id));

      return {
        collection: col,
        store: (store ?? { name: "My store", slug: "", brand_color: null }) as PageData["store"],
        items,
        unattached,
      };
    },
  });

  const items = data?.items ?? [];

  // The draft order is seeded from the saved one every time edit mode opens, so
  // a cancelled reorder leaves nothing behind.
  useEffect(() => {
    if (reordering) setOrder(items.map((i) => i.productId!).filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reordering]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["collection-page", id] });
    qc.invalidateQueries({ queryKey: ["collection-products", id] });
    qc.invalidateQueries({ queryKey: ["collections"] });
    qc.invalidateQueries({ queryKey: ["storefront-products"] });
    qc.invalidateQueries({ queryKey: ["storefront-pins"] });
  };

  const runTakeDownPin = useServerFn(takeDownPin);

  /**
   * Removing a row means two different things depending on how the product got
   * here. A product pasted straight onto the collection only exists as this
   * row, so it is deleted. A product attached to a pin is that pin's
   * monetization — deleting the row alone would leave the pin pointing at
   * nothing — so it goes through the same take-down the pin flows use, which
   * detaches the product and returns the pin to available-to-attach.
   */
  const removeItem = useMutation({
    mutationFn: async (item: Item) => {
      if (item.pinId) {
        await runTakeDownPin({ data: { pinId: item.pinId } });
        return;
      }
      if (!item.productId) return;
      const { error } = await supabase
        .from("storefront_products")
        .delete()
        .eq("id", item.productId);
      if (error) throw error;
    },
    onSuccess: (_r, item) => {
      invalidate();
      notifyDone(
        item.pinId ? "Pin taken down — it's back in available to attach" : "Product removed",
      );
      // Taking down the last pin can retire the collection itself (an empty
      // per-pin collection is cleaned up server-side), so there would be no
      // page left to stand on.
      if (items.length <= 1) navigate({ to: "/storefront" });
    },
    onError: (e: Error) => notifyProblem(getFriendlyMessage(e)),
  });

  const saveOrder = useMutation({
    mutationFn: async (ids: string[]) => {
      // One UPDATE per row: there is no unique key to upsert against, and
      // `position` is renumbered 0..n-1 within THIS collection — the same
      // convention the public storefront reads back.
      const results = await Promise.all(
        ids.map((pid, idx) =>
          supabase.from("storefront_products").update({ position: idx }).eq("id", pid),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    },
    onSuccess: () => {
      invalidate();
      setReordering(false);
      notifyDone("Order saved — this is what shoppers see");
    },
    onError: (e: Error) => notifyProblem(getFriendlyMessage(e)),
  });

  if (isPending) {
    return (
      <AppShell title="Collection" backButton backTo="/storefront" hideWallet>
        <div className="mx-auto max-w-2xl space-y-6">
          <div className="flex items-end gap-4">
            <Skeleton className="h-28 w-28 shrink-0 rounded-3xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-6 w-40 rounded-full" />
              <Skeleton className="h-4 w-24 rounded-full" />
            </div>
          </div>
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-2xl" />
            ))}
          </div>
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell title="Collection" backButton backTo="/storefront" hideWallet>
        <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-12 text-center">
          <p className="text-sm text-muted-foreground">
            This collection is no longer in your store.
          </p>
          <Link
            to="/storefront"
            className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow"
          >
            Back to My Store
          </Link>
        </div>
      </AppShell>
    );
  }

  const { collection, store, unattached } = data;
  const brandColor = store.brand_color ?? "#E60023";
  const thumbUrl = collection.cover_image_url ?? items.find((i) => i.imageUrl)?.imageUrl ?? null;
  const shareUrl = collectionShareUrl(store.slug, collection.slug);
  const byId = new Map(items.map((i) => [i.productId!, i]));
  const dirty = order.some((pid, i) => items[i]?.productId !== pid);

  return (
    <AppShell
      title={collection.name}
      subtitle="Collection"
      backButton
      backTo="/storefront"
      hideWallet
      inlineActions
      actions={
        <SharePopover
          url={shareUrl}
          title={collection.name}
          text={`${collection.name} — from ${store.name}`}
        >
          <button className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-2">
            <Share2 className="h-3.5 w-3.5" /> Share
          </button>
        </SharePopover>
      }
    >
      <div className="mx-auto max-w-2xl space-y-6 pb-28">
        {/* Thumbnail first — a creator recognises a collection by its picture
            long before they read its name. */}
        <div className="flex items-end gap-4">
          <div
            className="relative h-28 w-28 shrink-0 overflow-hidden rounded-3xl border border-border bg-surface-2 shadow-elevate"
            style={
              thumbUrl
                ? undefined
                : {
                    background: `linear-gradient(135deg, ${collection.cover_color ?? brandColor}, #F5E1D5)`,
                  }
            }
          >
            {thumbUrl ? (
              <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="grid h-full w-full place-items-center text-white/80">
                <ImageIcon className="h-7 w-7" />
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <h2 className="font-display text-xl font-semibold leading-tight">{collection.name}</h2>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold">
                <ShoppingBag className="h-3.5 w-3.5" style={{ color: brandColor }} />
                {items.length} product{items.length === 1 ? "" : "s"}
              </span>
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                <ExternalLink className="h-3 w-3" /> View public page
              </a>
            </p>
            {collection.description && (
              <p className="mt-2 text-sm text-muted-foreground">{collection.description}</p>
            )}
          </div>
        </div>

        {/* Edit controls. Reorder is a mode rather than a dialog, so the rows
            being reordered are the rows already on screen. */}
        <div className="flex flex-wrap items-center gap-2">
          {reordering ? (
            <>
              <button
                type="button"
                onClick={() => saveOrder.mutate(order)}
                disabled={!dirty || saveOrder.isPending}
                className="inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-50"
              >
                {saveOrder.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Save order
              </button>
              <button
                type="button"
                onClick={() => setReordering(false)}
                disabled={saveOrder.isPending}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
            </>
          ) : (
            <>
              <Link
                to="/collections/$id/attach"
                params={{ id: collection.id }}
                className="inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow"
              >
                <Plus className="h-3.5 w-3.5" /> Add products
              </Link>
              {items.length >= 2 && (
                <button
                  type="button"
                  onClick={() => setReordering(true)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-2"
                >
                  <GripVertical className="h-3.5 w-3.5" /> Reorder
                </button>
              )}
            </>
          )}
        </div>

        {/* Products */}
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-10 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
              <Link2 className="h-6 w-6 text-primary-foreground" />
            </div>
            <h4 className="mt-4 font-display text-base font-semibold">No products yet</h4>
            <p className="mx-auto mt-2 max-w-xs text-sm text-muted-foreground">
              Paste a product link and it shows up here — and on the public page shoppers see.
            </p>
          </div>
        ) : reordering ? (
          <Reorder.Group axis="y" values={order} onReorder={setOrder} className="space-y-3">
            {order.map((pid, idx) => {
              const item = byId.get(pid);
              if (!item) return null;
              return (
                <Reorder.Item
                  key={pid}
                  value={pid}
                  whileDrag={{ scale: 1.02, boxShadow: "0 20px 40px -12px rgba(0,0,0,0.35)" }}
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  className="touch-none select-none active:cursor-grabbing"
                >
                  <ProductRowCard
                    item={item}
                    index={idx}
                    total={order.length}
                    onMove={(dir) =>
                      setOrder((prev) => {
                        const i = prev.indexOf(pid);
                        const j = i + dir;
                        if (i < 0 || j < 0 || j >= prev.length) return prev;
                        const next = [...prev];
                        next[i] = prev[j];
                        next[j] = prev[i];
                        return next;
                      })
                    }
                  />
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <ProductRowCard
                key={item.productId ?? item.pinId}
                item={item}
                onRemove={() => {
                  const label = item.pinId
                    ? `Remove "${item.title}"? The pin goes back to available-to-attach and its product is detached.`
                    : `Remove "${item.title}" from this collection?`;
                  if (confirm(label)) removeItem.mutate(item);
                }}
                removing={
                  removeItem.isPending && removeItem.variables?.productId === item.productId
                }
              />
            ))}
          </div>
        )}

        {/* Pins sitting in this collection with nothing attached. They are not
            on the public page, so they are listed apart from the products
            rather than mixed into them. */}
        {unattached.length > 0 && !reordering && (
          <section>
            <h3 className="text-sm font-semibold">Not earning yet</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {unattached.length} pin{unattached.length === 1 ? "" : "s"} in this collection with no
              product attached — shoppers don&apos;t see {unattached.length === 1 ? "it" : "them"}.
            </p>
            <div className="mt-3 space-y-2">
              {unattached.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-2xl border border-dashed border-border bg-surface/40 p-2.5"
                >
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-surface-2">
                    {p.image_url ? (
                      <img src={p.image_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="grid h-full w-full place-items-center text-muted-foreground">
                        <ImageIcon className="h-5 w-5" />
                      </span>
                    )}
                  </div>
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{p.title}</p>
                  <Link
                    to="/pins/attach"
                    search={{ pinId: p.id } as never}
                    className="shrink-0 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/15"
                  >
                    Attach
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}

/**
 * One product, as a row.
 *
 * Rows rather than a grid because the two numbers are the point — a grid of
 * squares puts the picture first and pushes price and earnings into a caption.
 * Both numbers come from `productPriceParts`, so the struck-through MRP here is
 * the same figure the public page shows for the same product.
 */
function ProductRowCard({
  item,
  index,
  total,
  onMove,
  onRemove,
  removing,
}: {
  item: Item;
  /** Set in reorder mode: renders the live position and the arrow controls. */
  index?: number;
  total?: number;
  onMove?: (dir: -1 | 1) => void;
  onRemove?: () => void;
  removing?: boolean;
}) {
  const source = hostBrand(item.link);
  const parts = useMemo(() => productPriceParts(item.priceCents), [item.priceCents]);
  const pct = item.commissionPct ?? estimateCommissionPct(source);
  const earning =
    item.priceCents != null ? Math.round((item.priceCents / 100) * (pct / 100)) : null;
  const ordering = index != null;

  return (
    <article className="flex items-start gap-3 rounded-2xl border border-border bg-surface p-2.5 shadow-sm">
      {ordering && (
        <motion.span
          whileHover={{ scale: 1.1 }}
          className="mt-5 grid h-8 w-8 shrink-0 cursor-grab place-items-center rounded-full text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </motion.span>
      )}

      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-surface-2">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center text-muted-foreground">
            <ImageIcon className="h-6 w-6" />
          </span>
        )}
        {ordering && (
          <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-foreground/85 text-mini font-bold text-background">
            {index + 1}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-semibold leading-snug">{item.title}</p>
        <p className="mt-0.5 text-mini font-medium uppercase tracking-wide text-muted-foreground">
          {source}
        </p>

        {parts ? (
          <>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5">
              <span className="text-base font-extrabold tracking-tight">{parts.price}</span>
              {parts.mrp && (
                <span className="text-mini font-medium text-muted-foreground">
                  MRP <span className="line-through">{parts.mrp}</span>
                </span>
              )}
              {parts.discountPct != null && parts.discountPct > 0 && (
                <span className="text-mini font-bold text-amber-600">
                  ({parts.discountPct}% OFF)
                </span>
              )}
            </div>
            {earning != null && (
              <span className="mt-1.5 inline-flex w-fit items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-1 text-mini font-bold text-white shadow-sm shadow-emerald-500/40">
                You earn ₹{earning.toLocaleString("en-IN")} per sale
              </span>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">
            No price on file yet — earnings show once the retailer reports one.
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-1">
        {ordering ? (
          <>
            <button
              type="button"
              onClick={() => onMove?.(-1)}
              disabled={index === 0}
              aria-label="Move up"
              className="grid h-8 w-8 place-items-center rounded-full border border-border text-muted-foreground transition hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onMove?.(1)}
              disabled={total != null && index === total - 1}
              aria-label="Move down"
              className="grid h-8 w-8 place-items-center rounded-full border border-border text-muted-foreground transition hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <>
            <a
              href={item.link}
              target="_blank"
              rel="noreferrer"
              aria-label="Open product page"
              className="grid h-8 w-8 place-items-center rounded-full border border-border text-muted-foreground transition hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={onRemove}
              disabled={removing}
              aria-label={`Remove ${item.title}`}
              className="grid h-8 w-8 place-items-center rounded-full border border-border text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
            >
              {removing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
