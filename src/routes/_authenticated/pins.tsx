import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import { useScrollMorph } from "@/hooks/use-scroll-morph";
import { PinScanOverlay } from "@/components/pin-scan-overlay";
import { useScanPhase } from "@/hooks/use-scan-phase";
import {
  Plus,
  Link2,
  Trash2,
  Loader2,
  Pin as PinIcon,
  X,
  Sparkles,
  Upload,
  Image as ImageIcon,
  Pencil,
  ArrowUpDown,
  ClipboardPaste,
  ArrowRight,
  Grip,
} from "lucide-react";
import { toast } from "sonner";
import { takeDownPin, visualSearchComponents, type CkResult } from "@/lib/pinterest.functions";
import { useVisualSearch } from "@/hooks/use-visual-search";
import {
  SuggestionCard,
  ProgressiveSuggestionCard,
  SuggestionCardSkeleton,
  realProductPrice,
} from "@/components/suggestion-card";
import { EducationalLoader, HINTS } from "@/components/rotating-hint";
import { hostBrand, estimateCommissionPct } from "@/lib/brands";
import { CollectionAddFlow, AddFromCollectionButton } from "@/components/collection-picker";
import { unreviewMonetizeProgressPin } from "@/lib/monetize-progress";

type PinsSearch = { new?: 1; filter?: "drafts" };

export const Route = createFileRoute("/_authenticated/pins")({
  validateSearch: (s: Record<string, unknown>): PinsSearch => ({
    new: s.new === 1 || s.new === "1" ? 1 : undefined,
    filter: s.filter === "drafts" ? "drafts" : undefined,
  }),
  component: PinsPage,
});

export type Pin = {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  external_url: string | null;
  status: string;
  impressions: number;
  clicks: number;
  conversions: number;
  earnings_cents: number;
  storefront_id: string | null;
  product_id: string | null;
  collection_id: string | null;
  created_at: string;
};

export type Collection = { id: string; name: string; slug: string };
export type Storefront = { id: string; name: string; slug: string };
export type Product = {
  id: string;
  title: string;
  affiliate_url: string;
  image_url: string | null;
  price_cents: number | null;
  currency: string | null;
  commission_pct: number | null;
  storefront_id: string;
  collection_id: string | null;
};

export const GRADIENTS = [
  "from-rose-500 to-pink-600",
  "from-amber-400 to-orange-600",
  "from-emerald-400 to-teal-600",
  "from-sky-400 to-indigo-600",
  "from-fuchsia-500 to-purple-600",
  "from-lime-400 to-green-600",
  "from-cyan-400 to-blue-600",
  "from-red-500 to-rose-700",
];

export const RATIOS = [
  "aspect-[3/4]",
  "aspect-[3/5]",
  "aspect-square",
  "aspect-[4/5]",
  "aspect-[3/4]",
  "aspect-[2/3]",
];

export const CATEGORY_PILLS = ["Top", "Shirt", "Pants", "Art", "Books", "Accessories"] as const;

function PinsPage() {
  const qc = useQueryClient();
  const runComponents = useServerFn(visualSearchComponents);
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [collectionFilter, setCollectionFilter] = useState<string>("live");
  const [openPinId, setOpenPinId] = useState<string | null>(null);

  /** Start the scan on INTENT rather than on open.
   *
   * Detection is the one stage nothing can be shown before — the overlay has
   * no products, no chips, nothing to say until it answers — and on a pin
   * nobody has scanned yet it is a ~5s model call that only begins when the
   * dialog mounts. Hovering (or touching) a card starts it a beat, or several
   * seconds, earlier; by the time the dialog opens the answer is already in
   * the cache under the very key it is about to ask for.
   *
   * Costs nothing on a pin that is never opened after all: the result is
   * cached in Postgres and answers the next scan of that pin instantly, by
   * whoever runs it. Same key, same arguments, same staleTime as the dialog's
   * own query in useVisualSearch — a mismatch in any of the three would make
   * this a wasted call rather than a head start.
   */
  const warmScan = (pin: Pin) => {
    if (pin.status !== "draft" || !pin.image_url) return;
    void qc.prefetchQuery({
      queryKey: ["visual-components", pin.id],
      queryFn: () => runComponents({ data: { pinId: pin.id, title: "", description: "" } }),
      staleTime: Infinity,
      retry: false,
    });
  };

  // Sync the "Drafts" filter chip from ?filter=drafts (e.g. after clicking Save draft).
  useEffect(() => {
    if (search.filter === "drafts") {
      setCollectionFilter("drafts");
    } else if (search.filter === undefined) {
      setCollectionFilter("live");
    }
  }, [search.filter]);

  useEffect(() => {
    if (search.new === 1) {
      navigate({ to: "/pins/attach", replace: true });
    }
  }, [search.new, navigate]);

  const { data: pins = [], isLoading } = useQuery({
    queryKey: ["pins"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data, error } = await supabase
        .from("pins")
        .select("*")
        .eq("user_id", userId)
        .eq("is_owner", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Pin[];
    },
  });

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
      return (data ?? []) as Collection[];
    },
  });

  const { data: storefronts = [] } = useQuery({
    queryKey: ["storefronts"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("storefronts")
        .select("id,name,slug")
        .eq("user_id", userId);
      return (data ?? []) as Storefront[];
    },
  });

  const { data: products = [] } = useQuery({
    queryKey: ["all-products"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("storefront_products")
        .select(
          "id,title,affiliate_url,image_url,price_cents,currency,commission_pct,storefront_id,collection_id",
        )
        .eq("user_id", userId);
      return (data ?? []) as Product[];
    },
  });

  const runTakeDownPin = useServerFn(takeDownPin);
  // "Delete" a live pin = take it down: the pin row survives and returns to
  // the available-to-attach pool, its products detach, and it leaves the
  // storefront + analytics. No pin is ever lost.
  const remove = useMutation({
    mutationFn: async (pin: Pin) => {
      await runTakeDownPin({ data: { pinId: pin.id } });
      return pin;
    },
    onSuccess: (pin) => {
      qc.invalidateQueries({ queryKey: ["pins"] });
      qc.invalidateQueries({ queryKey: ["all-products"] });
      // The pin's product just detached, so it's un-reviewed again as far as
      // its board's "Continue monetising" progress is concerned.
      if (pin.collection_id) unreviewMonetizeProgressPin(pin.collection_id);
      toast.success("Pin taken down — back in available pins");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // "Delete all" = run the exact same take-down as the single-pin delete, once
  // per pin currently shown. Every pin survives and returns to the
  // available-to-attach pool; nothing is lost.
  const removeAll = useMutation({
    mutationFn: async (pinsToRemove: Pin[]) => {
      for (const pin of pinsToRemove) {
        await runTakeDownPin({ data: { pinId: pin.id } });
      }
      return pinsToRemove;
    },
    onSuccess: (removed) => {
      qc.invalidateQueries({ queryKey: ["pins"] });
      qc.invalidateQueries({ queryKey: ["all-products"] });
      for (const pin of removed) {
        if (pin.collection_id) unreviewMonetizeProgressPin(pin.collection_id);
      }
      toast.success(`${removed.length} pin${removed.length === 1 ? "" : "s"} taken down`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const visiblePins = useMemo(
    () => pins.filter((p) => p.status === "draft" || p.status === "live"),
    [pins],
  );

  const filtered = useMemo(() => {
    const base =
      collectionFilter === "drafts"
        ? visiblePins.filter((p) => p.status === "draft")
        : visiblePins.filter((p) => p.status === "live");
    return [...base].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [visiblePins, collectionFilter]);

  const openPin = pins.find((p) => p.id === openPinId) ?? null;

  const draftsCount = visiblePins.filter((p) => p.status === "draft").length;
  const liveCount = visiblePins.filter((p) => p.status === "live").length;

  return (
    <AppShell
      title="Pins"
      backButton
      backTo="/dashboard"
      actions={
        filtered.length > 0 &&
        (storefronts.length === 0 ? (
          <button
            disabled
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-gradient-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-glow opacity-50"
          >
            <Plus className="h-4 w-4" /> Attach products
          </button>
        ) : (
          <Link
            to="/pins/attach"
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-gradient-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-glow"
          >
            <Plus className="h-4 w-4" /> Attach products
          </Link>
        ))
      }
    >
      <div className="no-scrollbar mb-5 -mx-1 flex items-center gap-2 overflow-x-auto px-1">
        <FilterChip
          active={collectionFilter === "live"}
          onClick={() => setCollectionFilter("live")}
          label="Live"
          count={liveCount}
        />
        {draftsCount > 0 && (
          <FilterChip
            active={collectionFilter === "drafts"}
            onClick={() => setCollectionFilter("drafts")}
            label="Drafts"
            count={draftsCount}
          />
        )}
        {filtered.length > 0 && (
          <button
            onClick={() => {
              if (
                confirm(
                  `Take down all ${filtered.length} ${collectionFilter} pin${
                    filtered.length === 1 ? "" : "s"
                  }? They go back to your available pins and their products are detached.`,
                )
              )
                removeAll.mutate(filtered);
            }}
            disabled={removeAll.isPending}
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-red-500/40 bg-surface px-4 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-500/10 disabled:opacity-60"
          >
            {removeAll.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete all
          </button>
        )}
      </div>

      {openPin && (
        <PinDetailDialog
          pin={openPin}
          products={products}
          collections={collections}
          onClose={() => setOpenPinId(null)}
        />
      )}

      {isLoading ? (
        <div className="masonry-3 sm:masonry-4 lg:masonry-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className={`${RATIOS[i % RATIOS.length]} animate-pulse rounded-2xl border border-border bg-surface/60`}
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyPins canCreate={storefronts.length > 0} />
      ) : (
        <div className="masonry-3 sm:masonry-4 lg:masonry-4">
          {filtered.map((p, i) => {
            const grad = GRADIENTS[i % GRADIENTS.length];
            return (
              <article
                key={p.id}
                onClick={() => {
                  if (p.status === "draft") setOpenPinId(p.id);
                }}
                onPointerEnter={() => warmScan(p)}
                onPointerDown={() => warmScan(p)}
                className={`group overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-border/60 transition hover:shadow-elevate ${
                  p.status === "draft" ? "cursor-pointer" : ""
                }`}
              >
                {/* No forced aspect ratio — each pin renders at its own image's
                    real proportions, like native Pinterest masonry, instead of
                    being cropped into a standardized box. */}
                <div
                  className={`relative w-full bg-gradient-to-br ${grad} ${p.image_url ? "" : "aspect-square"}`}
                >
                  {p.image_url && (
                    <img src={p.image_url} alt="" className="block w-full h-auto" loading="lazy" />
                  )}
                  <span
                    className="absolute right-2 top-2 rounded-full px-2.5 py-1 text-micro font-semibold uppercase tracking-wide backdrop-blur"
                    style={{
                      background:
                        p.status === "live"
                          ? "oklch(0.72 0.16 45 / 0.95)"
                          : p.status === "scheduled"
                            ? "oklch(0.72 0.14 85 / 0.95)"
                            : "oklch(1 0 0 / 0.9)",
                      color: p.status === "draft" ? "oklch(0.28 0.015 45)" : "oklch(1 0 0)",
                    }}
                  >
                    {p.status}
                  </span>
                  <h3 className="sr-only">{p.title}</h3>

                  {/* Icon-only actions, transparent, always visible */}
                  <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1.5 bg-gradient-to-t from-black/40 to-transparent p-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenPinId(p.id);
                      }}
                      aria-label={p.status === "draft" ? "Attach product" : "Edit"}
                      className="grid h-8 w-8 place-items-center rounded-full bg-transparent text-white transition hover:bg-white/20"
                    >
                      {p.status === "draft" ? (
                        <Link2 className="h-3.5 w-3.5" />
                      ) : (
                        <Pencil className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          confirm(
                            `Take down "${p.title}"? It goes back to your available pins and its products are detached.`,
                          )
                        )
                          remove.mutate(p);
                      }}
                      aria-label="Delete"
                      className="grid h-8 w-8 place-items-center rounded-full bg-transparent text-white transition hover:bg-white/20 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full border px-4 py-1.5 text-sm capitalize transition ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-surface text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}{" "}
      <span className={`ml-1 text-xs ${active ? "opacity-80" : "opacity-60"}`}>{count}</span>
    </button>
  );
}

function EmptyPins({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-12 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
        <PinIcon className="h-6 w-6 text-primary-foreground" />
      </div>
      <h3 className="mt-4 font-display text-xl font-semibold">No pins here</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {canCreate
          ? "Attach a product to a pin and start earning."
          : "Add a storefront and a product first."}
      </p>
      {canCreate && (
        <Link
          to="/pins/attach"
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-base font-semibold text-primary-foreground shadow-glow"
        >
          <Plus className="h-5 w-5" /> Attach products
        </Link>
      )}
    </div>
  );
}

export function PinDetailDialog({
  pin,
  products,
  collections = [],
  onClose,
}: {
  pin: Pin;
  products: Product[];
  collections?: Collection[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Closing the dialog (the ✕, backdrop, go-live — any unmount) terminates the
  // matching pipeline: abort this pin's in-flight detection, every component
  // search it fanned out, and every product-details lookup its cards kicked
  // off, so nothing keeps running in the background once the user has left.
  useEffect(() => {
    return () => {
      void qc.cancelQueries({ queryKey: ["visual-components", pin.id] });
      void qc.cancelQueries({ queryKey: ["visual-component"] });
      void qc.cancelQueries({ queryKey: ["product-details"] });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Scroll-linked morph: the big pin preview shrinks into the top-left header
  // thumbnail as the results scroll down, and expands back on scroll up.
  const scanScrollRef = useRef<HTMLDivElement>(null);
  // Compact preview that shows the FULL pin (contain, not cropped). heroMaxHeight
  // matches the box height below so the collapse math stays in sync.
  const morph = useScrollMorph(scanScrollRef, { heroMaxHeight: 208 });

  // Suggested products from the same storefront/collection auto-checked.
  const storeProducts = useMemo(
    () => products.filter((p) => !pin.storefront_id || p.storefront_id === pin.storefront_id),
    [products, pin.storefront_id],
  );
  // Only pre-check the pin's already-linked product, if any. No collection auto-pick.
  const initialAutoChecked = useMemo(() => {
    const ids = new Set<string>();
    if (pin.product_id) ids.add(pin.product_id);
    return ids;
  }, [pin.product_id]);

  const [checked, setChecked] = useState<Set<string>>(initialAutoChecked);
  const [manualProductIds, setManualProductIds] = useState<Set<string>>(new Set());
  const [previewLoading, setPreviewLoading] = useState(false);
  // Manual entry lives in an "Add more" sheet now — never inline on the product
  // page. `showCollection` swaps in the full-screen Add-from-Collection flow.
  const [showAddMore, setShowAddMore] = useState(false);
  const [showCollection, setShowCollection] = useState(false);
  // Explicit display order for the selected products. Tokens: `a:<link>` for an
  // AI pick, `p:<productId>` for a picked product. Driven by the inline grid
  // drag; anything not listed keeps its natural order, appended after.
  const [selectionOrder, setSelectionOrder] = useState<string[]>([]);
  // Active product-tag tab (null = "All"). Tabs come from the object-detection
  // components returned with the matches.
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // Static category pills shown above the results — not wired to real
  // filtering yet — category pills removed (use real filters instead).
  const [manualUrl, setManualUrl] = useState(
    pin.external_url && !pin.product_id ? pin.external_url : "",
  );

  // The search, streamed in two stages — see useVisualSearch. `tabs` carry
  // their own loading state, so a pill can render (and be tapped) while its
  // products are still being found.
  const {
    tabs,
    matches: suggestions,
    isDetecting,
    isLoading: aiLoading,
    isRefining,
  } = useVisualSearch({ pinId: pin.id });

  // Full-screen scan experience. Detection names the products in well under a
  // second, so leaving on that alone dropped the user onto empty skeletons for
  // the many seconds the searches really take. It now shows what was found
  // straight away and holds briefly for the first tab's products (capped in
  // useScanPhase), so the reveal lands on a grid with something in it. Skip is
  // available the whole time.
  // A named component is a result in itself — it becomes a tab. The untagged
  // whole-image fallback has no label, so there it takes an actual match to
  // count, which is what keeps a pin with nothing to sell out of the "found"
  // ending and in the empty state that offers a manual link.
  const firstTabReady = tabs.some((t) => !t.loading);
  const { phase: scanPhase, dismiss: dismissScan } = useScanPhase({
    searching: isDetecting,
    hasResults: tabs.some((t) => !!t.label) || suggestions.length > 0,
    productsReady: firstTabReady,
  });

  // Progressive rendering: `suggestions` paints immediately (image/title/
  // source + Lens price, no CK wait) — each card resolves its own live
  // price/stock independently via ProgressiveSuggestionCard and reports back
  // here once settled. Never present in this map = still resolving; `null` =
  // no price from CK or Lens at all (rare). Every match that settled with a
  // price is pickable regardless of stock, and starts selected by default the
  // instant it resolves (absence from `deselectedAILinks` means selected).
  const [confirmedByLink, setConfirmedByLink] = useState<Map<string, CkResult>>(new Map());
  const [deselectedAILinks, setDeselectedAILinks] = useState<Set<string>>(new Set());
  const handleSuggestionSettled = (link: string, details: CkResult) => {
    setConfirmedByLink((prev) => {
      if (prev.has(link)) return prev;
      const next = new Map(prev);
      next.set(link, details);
      return next;
    });
  };

  const confirmedAIPicks = suggestions.flatMap((s) => {
    const details = confirmedByLink.get(s.link);
    if (!details || deselectedAILinks.has(s.link)) return [];
    return [
      {
        title: s.title,
        url: s.link,
        image: s.thumbnail,
        source: s.source,
        price: {
          value: `₹${details.discountedPrice.toLocaleString("en-IN")}`,
          extractedValue: details.discountedPrice,
          currency: "₹",
        },
      },
    ];
  });

  const toggleAI = (link: string) =>
    setDeselectedAILinks((prev) => {
      const next = new Set(prev);
      if (next.has(link)) next.delete(link);
      else next.add(link);
      return next;
    });

  // The single best earning rate across the matched retailers — headlines the
  // results ("earn up to Y% per sale") so the value is obvious at a glance.
  const topCommission = suggestions.length
    ? Math.max(...suggestions.map((s) => estimateCommissionPct(s.source)))
    : 0;

  // Everything currently selected, as one flat list the Reorder dialog and the
  // go-live payload both read from. AI picks first, then picked products — the
  // natural order — unless `selectionOrder` overrides it.
  const selectedItems = useMemo(() => {
    const aiItems = confirmedAIPicks.map((a) => {
      const pct = estimateCommissionPct(a.source);
      return {
        token: `a:${a.url}`,
        title: a.title,
        image: a.image,
        source: a.source,
        priceLabel: a.price.value,
        earn: Math.round(a.price.extractedValue * (pct / 100)),
      };
    });
    const prodItems = storeProducts
      .filter((p) => checked.has(p.id))
      .map((p) => {
        const amount = p.price_cents != null ? p.price_cents / 100 : null;
        const pct = p.commission_pct ?? estimateCommissionPct(hostBrand(p.affiliate_url));
        return {
          token: `p:${p.id}`,
          title: p.title,
          image: p.image_url,
          source: hostBrand(p.affiliate_url),
          priceLabel: amount != null ? `₹${amount.toLocaleString("en-IN")}` : null,
          earn: amount != null ? Math.round(amount * (pct / 100)) : null,
        };
      });
    return [...aiItems, ...prodItems];
  }, [confirmedAIPicks, storeProducts, checked]);

  const orderedSelection = useMemo(() => {
    const rank = new Map(selectionOrder.map((t, i) => [t, i]));
    // Stable sort: items with no explicit rank keep their natural relative order.
    return [...selectedItems].sort(
      (a, b) => (rank.get(a.token) ?? Infinity) - (rank.get(b.token) ?? Infinity),
    );
  }, [selectedItems, selectionOrder]);

  // What the "N picked" chip shows — every product currently ticked, both AI
  // matches (selected by default until deselected) and picked products, so it
  // matches the checkmarks on screen. `confirmedAIPicks` alone undercounts,
  // since it excludes matches still resolving their price and any picked
  // products.
  const pickedCount =
    suggestions.filter((s) => !deselectedAILinks.has(s.link)).length +
    storeProducts.filter((p) => checked.has(p.id)).length;

  // Inline drag-reorder of the found-products grid: the on-screen order of the
  // AI matches, driven by `selectionOrder`'s `a:` tokens. Dragging writes back
  // into `selectionOrder` so the go-live order follows the grid exactly.
  const orderedAiLinks = useMemo(() => {
    const rank = new Map(
      selectionOrder.filter((t) => t.startsWith("a:")).map((t, i) => [t.slice(2), i]),
    );
    return [...suggestions.map((s) => s.link)].sort(
      (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
    );
  }, [suggestions, selectionOrder]);
  const onAiReorder = (links: string[]) => {
    setSelectionOrder((prev) => [
      ...links.map((l) => `a:${l}`),
      ...prev.filter((t) => t.startsWith("p:")),
    ]);
  };

  // Product-tag tabs, one per detected component, in prominence order. They
  // come from `tabs` rather than from the matches, so a pill appears the
  // moment detection names it — with a count of "…" until its own search
  // lands. Deriving them from the matches (as this used to) meant no pill
  // could exist until its products did, which is exactly the wait we're
  // removing.
  const tagByLink = useMemo(
    () => new Map(suggestions.map((s) => [s.link, s.tag] as const)),
    [suggestions],
  );
  // A pill earns its place by having something to show. It appears while its
  // search is running (that's the point — the user sees what was found in the
  // pin immediately) and is withdrawn if that search settles empty, because a
  // tab that opens onto nothing is worse than a tab that was never offered.
  const namedTabs = useMemo(
    () => tabs.filter((t) => !!t.label && (t.loading || t.matches.length > 0)),
    [tabs],
  );
  const tags = useMemo(() => [...new Set(namedTabs.map((t) => t.label))], [namedTabs]);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of namedTabs) m.set(t.label, (m.get(t.label) ?? 0) + t.matches.length);
    return m;
  }, [namedTabs]);
  // A tab is still working while any component sharing its label is.
  const tagLoading = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const t of namedTabs) m.set(t.label, (m.get(t.label) ?? false) || t.loading);
    return m;
  }, [namedTabs]);
  // Keep the active tab valid as results change.
  useEffect(() => {
    if (activeTag && !tags.includes(activeTag)) setActiveTag(null);
  }, [activeTag, tags]);
  const visibleAiLinks = useMemo(
    () =>
      activeTag ? orderedAiLinks.filter((l) => tagByLink.get(l) === activeTag) : orderedAiLinks,
    [activeTag, orderedAiLinks, tagByLink],
  );
  // How many card silhouettes to hold open under the grid: one per pill still
  // searching, so the layout doesn't jump as each set of products drops in.
  const pendingCardCount = activeTag
    ? tagLoading.get(activeTag)
      ? 3
      : 0
    : Math.min(6, namedTabs.filter((t) => t.loading).length * 3);

  // Remove a product from the "Add more" selected-list — deselect an AI pick or
  // uncheck a picked product, keyed by its token.
  const removeSelected = (token: string) => {
    if (token.startsWith("a:")) {
      setDeselectedAILinks((prev) => new Set(prev).add(token.slice(2)));
    } else {
      const id = token.slice(2);
      setChecked((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Pick an existing collection product from the "Add more" sheet — mirror it
  // into `manualProductIds` so it surfaces in the main Products list, and
  // toggle its selection.
  const toggleCollectionProduct = (id: string) => {
    setManualProductIds((prev) => new Set(prev).add(id));
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setManualUrl(text.trim());
      else toast.error("Clipboard is empty");
    } catch {
      toast.error("Couldn't read clipboard — paste manually");
    }
  };

  const resolveExternal = () => {
    if (manualUrl.trim()) return manualUrl.trim();
    const firstProductId = Array.from(checked)[0];
    const firstProduct = firstProductId
      ? storeProducts.find((p) => p.id === firstProductId)
      : undefined;
    if (firstProduct?.affiliate_url) return firstProduct.affiliate_url;
    if (confirmedAIPicks[0]) return confirmedAIPicks[0].url;
    return pin.external_url ?? null;
  };

  const goToPreview = () => {
    if (checked.size === 0 && confirmedAIPicks.length === 0 && !manualUrl.trim()) {
      toast.error("Pick a product or paste a product link first.");
      return;
    }
    setPreviewLoading(true);
    // Honour the Reorder order: emit productIds and aiPicks in the sequence the
    // user arranged (falls back to natural order when never reordered).
    const orderedTokens = orderedSelection.map((s) => s.token);
    const productIds = orderedTokens.filter((t) => t.startsWith("p:")).map((t) => t.slice(2));
    const aiPicks = orderedTokens
      .filter((t) => t.startsWith("a:"))
      .map((t) => confirmedAIPicks.find((a) => `a:${a.url}` === t))
      .filter((a): a is (typeof confirmedAIPicks)[number] => !!a);
    try {
      sessionStorage.setItem(`pin-preview:${pin.id}`, JSON.stringify({ productIds, aiPicks }));
    } catch {
      /* ignore quota */
    }
    onClose();
    navigate({ to: "/pins/preview", search: { pinId: pin.id } });
  };

  const saveDraft = useMutation({
    mutationFn: async () => {
      const firstProductId = Array.from(checked)[0] ?? null;
      const external = resolveExternal();
      // "draft" means genuinely left midway — some product/link was picked
      // but Go Live was never hit. A pin nobody has touched yet (fresh from
      // Pinterest sync, nothing checked here) stays "new", not "draft".
      const hasSelection =
        checked.size > 0 || confirmedAIPicks.length > 0 || manualUrl.trim() !== "";
      // Closing/cancelling here is never the "Go Live" action — a pin only
      // goes live from the preview page's explicit Go Live button. Leaving
      // this dialog midway must never promote a pin to live; it also must
      // not silently unpublish a pin that's already live from a prior
      // Go Live click.
      const { error } = await supabase
        .from("pins")
        .update({
          status: pin.status === "live" ? "live" : hasSelection ? "draft" : "new",
          product_id: firstProductId,
          external_url: external ?? null,
        })
        .eq("id", pin.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pins"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addProduct = useMutation({
    mutationFn: async () => {
      const url = manualUrl.trim();
      if (!url) throw new Error("Paste a product link first");
      try {
        new URL(url);
      } catch {
        throw new Error("That doesn't look like a valid URL");
      }
      if (!pin.storefront_id) {
        throw new Error("This pin has no storefront yet.");
      }
      // If this URL already exists in the user's storefront, don't duplicate —
      // just reuse the existing product and let onSuccess auto-select it.
      const normalize = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
      const target = normalize(url);
      const existing = storeProducts.find((p) => normalize(p.affiliate_url) === target);
      if (existing) {
        return { id: existing.id, duplicate: true as const };
      }
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) throw new Error("Not signed in");
      let hostname = "New product";
      try {
        hostname = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        /* keep default */
      }
      const title = pin.title ? `${pin.title} — ${hostname}` : hostname;
      const { data: inserted, error } = await supabase
        .from("storefront_products")
        .insert({
          user_id: userId,
          storefront_id: pin.storefront_id,
          collection_id: pin.collection_id,
          title,
          affiliate_url: url,
          image_url: pin.image_url,
        })
        .select("id")
        .single();
      if (error) throw error;
      return { id: inserted.id as string, duplicate: false as const };
    },
    onSuccess: ({ id, duplicate }) => {
      qc.invalidateQueries({ queryKey: ["all-products"] });
      setChecked((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setManualProductIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setManualUrl("");
      toast.success(duplicate ? "Already selected" : "Added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleCancel = () => {
    saveDraft.mutate();
  };

  return (
    <>
      <AnimatePresence>
        {scanPhase && (
          <PinScanOverlay
            imageUrl={pin.image_url}
            phase={scanPhase}
            found={tabs.map((t) => t.label).filter(Boolean)}
            onContinue={() => {
              // No matches → land on the product page with the Add-more sheet
              // already open so they can paste a link or pick from a collection.
              dismissScan();
              setShowAddMore(true);
            }}
            onSkip={() => {
              dismissScan();
              setShowAddMore(true);
            }}
          />
        )}
      </AnimatePresence>

      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 backdrop-blur sm:items-center sm:p-4"
        onClick={handleCancel}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative flex h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-elevate sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:rounded-2xl"
        >
          {/* Compact header. The "Visual match" label fades out as you scroll
            into the results, while the pin fades/scales into the top-centre as
            the big preview below collapses — so the pin stays in view while
            freeing the space it used to take. */}
          <div className="relative flex items-center gap-3 border-b border-border/60 bg-surface px-4 py-3">
            <motion.div
              style={{ opacity: morph.heroOpacity }}
              className="flex min-w-0 items-center gap-1.5"
            >
              <Sparkles className="h-3 w-3 shrink-0 text-primary" />
              <span className="truncate text-micro font-semibold uppercase tracking-wide text-primary">
                {aiLoading && suggestions.length === 0 ? "Scanning pin…" : "Visual match"}
              </span>
            </motion.div>

            {pin.image_url && (
              <motion.div
                style={{ opacity: morph.thumbOpacity, scale: morph.thumbScale }}
                className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-gradient-to-br from-rose-500 to-pink-600 shadow-sm"
              >
                <img src={pin.image_url} alt="" className="h-full w-full object-cover" />
              </motion.div>
            )}

            <button
              onClick={handleCancel}
              className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Scrollable body */}
          <div
            ref={scanScrollRef}
            className="flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4"
          >
            {/* Visual scan preview (big pin with scanning bar). Its reserved
              height collapses and the image shrinks/fades/lifts as the user
              scrolls down — morphing into the top-left header thumbnail — and
              reverses on scroll up. */}
            {pin.image_url && (
              <motion.div
                style={{ height: morph.heroHeight, opacity: morph.heroOpacity }}
                className="flex items-start justify-center overflow-hidden"
              >
                {/* The box hugs the pin: image sets its own width from the box
                  height, so it fills edge-to-edge with no letterboxing. */}
                <motion.div
                  style={{ scale: morph.heroScale, y: morph.heroY }}
                  className="relative h-full origin-top overflow-hidden rounded-2xl border border-border shadow-sm"
                >
                  <img
                    src={pin.image_url}
                    alt=""
                    className="h-full w-auto max-w-full object-cover"
                  />
                  {aiLoading && suggestions.length === 0 && (
                    <>
                      <span className="pointer-events-none absolute inset-x-0 top-0 h-24 animate-scan bg-gradient-to-b from-primary/60 via-primary/20 to-transparent" />
                      <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary/50" />
                    </>
                  )}
                </motion.div>
              </motion.div>
            )}

            {/* Results — manual entry now lives in the "Add more" sheet, never
              inline here. The educational loader is now only for the detection
              stage: once the pills exist there is real structure to show, and
              showing it beats a spinner even while the grids are still
              filling. */}
            {isDetecting ? (
              <div className="mt-6">
                <EducationalLoader label="Finding products in your pin…" hints={HINTS.matching} />
              </div>
            ) : suggestions.length === 0 && !aiLoading ? (
              <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface-2/40 p-6 text-center">
                <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-amber-500/10 text-amber-600">
                  <Sparkles className="h-5 w-5" />
                </span>
                <p className="mt-3 text-sm font-semibold">No matching products found</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Tap <span className="font-semibold text-primary">Add more</span> below to paste a
                  link or pick from a collection.
                </p>
              </div>
            ) : (
              <>
                {/* Earnings-led header — centred and prominent. While pills are
                    still filling it names what was FOUND IN THE PIN, which is
                    already known and doesn't churn as counts arrive. */}
                <div className="mt-6 text-center">
                  <h5 className="font-display text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                    {aiLoading && namedTabs.length > 0
                      ? `Found ${namedTabs.length} item${namedTabs.length === 1 ? "" : "s"} in your pin`
                      : `Found ${suggestions.length} product${suggestions.length === 1 ? "" : "s"}`}
                  </h5>
                  <p className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5 text-base font-medium text-muted-foreground">
                    {aiLoading && suggestions.length === 0 ? (
                      "Matching them to stores…"
                    ) : (
                      <>
                        Earn upto
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-3 py-0.5 text-base font-extrabold text-emerald-600">
                          {topCommission}%
                        </span>
                        per sale
                      </>
                    )}
                  </p>
                  {/* The look gate finishes after the cards are already up (see
                      useVisualSearch), so it can reorder a grid the shopper is
                      reading and drop the occasional lookalike. Saying so turns
                      that from a glitch into the app visibly still working. */}
                  {isRefining && suggestions.length > 0 && (
                    <p className="mt-1 text-xs font-medium text-muted-foreground/70">
                      Checking each match…
                    </p>
                  )}
                </div>

                {/* Category pills removed — replaced by live filtering. */}

                {/* Product-tag tabs — one per detected component. Below the pin,
                    above the products. Shown whenever detection named at least
                    one component — a single category still gets "All" + its own
                    pill. These render as soon as detection names them; a tab
                    whose own search is still running shows a spinner where its
                    count will go, so the set of tabs never shifts under a
                    tapping finger. */}
                {tags.length >= 1 && (
                  <div className="no-scrollbar mt-4 -mx-1 flex items-center gap-2 overflow-x-auto px-1">
                    <TagTab
                      label="All"
                      count={suggestions.length}
                      pending={aiLoading}
                      active={activeTag === null}
                      onClick={() => setActiveTag(null)}
                    />
                    {tags.map((t) => (
                      <TagTab
                        key={t}
                        label={t}
                        count={tagCounts.get(t) ?? 0}
                        pending={tagLoading.get(t) ?? false}
                        active={activeTag === t}
                        onClick={() => setActiveTag(t)}
                      />
                    ))}
                  </div>
                )}

                {/* Drag any card by its ⠿ handle to rearrange (All tab only);
                    tapping elsewhere selects/deselects it. */}
                {activeTag === null ? (
                  <Reorder.Group
                    as="div"
                    axis="y"
                    values={orderedAiLinks}
                    onReorder={onAiReorder}
                    className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3"
                  >
                    {orderedAiLinks.map((link) => {
                      const s = suggestions.find((m) => m.link === link);
                      if (!s) return null;
                      return (
                        <ReorderableCard key={link} value={link}>
                          <ProgressiveSuggestionCard
                            match={s}
                            selected={!deselectedAILinks.has(link)}
                            onToggle={() => toggleAI(link)}
                            onSettled={handleSuggestionSettled}
                          />
                        </ReorderableCard>
                      );
                    })}
                    {/* Silhouettes for the pills still searching — the grid
                        grows into them instead of jumping. */}
                    {Array.from({ length: pendingCardCount }).map((_, i) => (
                      <SuggestionCardSkeleton key={`skeleton-${i}`} />
                    ))}
                  </Reorder.Group>
                ) : (
                  <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    {visibleAiLinks.map((link) => {
                      const s = suggestions.find((m) => m.link === link);
                      if (!s) return null;
                      return (
                        <ProgressiveSuggestionCard
                          key={link}
                          match={s}
                          selected={!deselectedAILinks.has(link)}
                          onToggle={() => toggleAI(link)}
                          onSettled={handleSuggestionSettled}
                        />
                      );
                    })}
                    {Array.from({ length: pendingCardCount }).map((_, i) => (
                      <SuggestionCardSkeleton key={`skeleton-${i}`} />
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Manually-added products — no heading; they simply join the grid. */}
            {manualProductIds.size > 0 && (
              <div className="mt-4">
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {storeProducts
                    .filter((p) => manualProductIds.has(p.id))
                    .map((p) => (
                      <SuggestionCard
                        key={p.id}
                        title={p.title}
                        thumbnail={p.image_url}
                        source={hostBrand(p.affiliate_url)}
                        link={p.affiliate_url}
                        price={realProductPrice(p.price_cents)}
                        commissionPct={p.commission_pct}
                        selected={checked.has(p.id)}
                        onToggle={() =>
                          setChecked((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.id)) next.delete(p.id);
                            else next.add(p.id);
                            return next;
                          })
                        }
                      />
                    ))}
                </div>
              </div>
            )}
          </div>

          {/* Sticky footer — Add more (outline) + Next (filled) */}
          <div
            className="flex items-center gap-3 border-t border-border/60 bg-surface px-4 py-3"
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            <button
              onClick={() => {
                setShowCollection(false);
                setShowAddMore(true);
              }}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 border-primary bg-surface px-4 py-3 text-sm font-bold text-primary transition active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" /> Add more
            </button>
            <button
              onClick={goToPreview}
              disabled={saveDraft.isPending}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98] disabled:opacity-60"
            >
              Next{pickedCount > 0 ? ` (${pickedCount})` : ""} <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* "Add more" bottom sheet — paste a link manually, or pick from a
          collection. Opened from the footer or after a no-match scan. */}
        <AnimatePresence>
          {showAddMore && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[55] flex items-end justify-center bg-background/60 backdrop-blur-sm sm:items-center sm:p-4"
              onClick={(e) => {
                e.stopPropagation();
                setShowAddMore(false);
              }}
            >
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ y: 40, opacity: 0.6 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 40, opacity: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 34 }}
                className="w-full max-w-2xl rounded-t-3xl border border-border bg-surface p-5 shadow-elevate sm:rounded-3xl"
                style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
              >
                <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-border" />
                {/* The two inputs below — a paste field and a collection
                    picker — are the sentence this used to spell out. */}
                <h3 className="font-display text-lg font-bold">Add products</h3>

                {/* Paste a link */}
                <div className="mt-4 flex items-center gap-2">
                  <div className="flex flex-1 items-center gap-2 rounded-2xl border border-input bg-background px-3 py-3">
                    <Link2 className="h-4 w-4 shrink-0 text-primary" />
                    <input
                      type="url"
                      value={manualUrl}
                      onChange={(e) => setManualUrl(e.target.value)}
                      placeholder="Paste more links"
                      className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={pasteFromClipboard}
                    aria-label="Paste from clipboard"
                    className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-2xl bg-emerald-500 text-white shadow-sm transition active:scale-95"
                  >
                    <ClipboardPaste className="h-5 w-5" />
                  </button>
                </div>
                {/* Only appears once there's a link to add. */}
                {manualUrl.trim() && (
                  <button
                    type="button"
                    onClick={() => addProduct.mutate()}
                    disabled={addProduct.isPending}
                    className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98] disabled:opacity-50"
                  >
                    {addProduct.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    Add link
                  </button>
                )}

                {/* divider */}
                <div className="my-4 flex items-center gap-3 text-mini font-semibold uppercase tracking-wide text-muted-foreground/70">
                  <span className="h-px flex-1 bg-border" /> or{" "}
                  <span className="h-px flex-1 bg-border" />
                </div>

                {/* Add from collection — full-screen: a Collections grid,
                    then that collection's products. */}
                <AddFromCollectionButton onClick={() => setShowCollection(true)} />

                {showCollection && (
                  <CollectionAddFlow
                    products={storeProducts}
                    pickedIds={checked}
                    onTogglePicked={toggleCollectionProduct}
                    onExit={() => setShowCollection(false)}
                  />
                )}

                {/* Everything picked so far — reorder by dragging a row, or
                    remove with ✕. */}
                {orderedSelection.length > 0 && (
                  <div className="mt-5">
                    <p className="mb-2 text-xs font-semibold text-muted-foreground">
                      {orderedSelection.length} selected
                    </p>
                    <Reorder.Group
                      as="div"
                      axis="y"
                      values={orderedSelection.map((i) => i.token)}
                      onReorder={setSelectionOrder}
                      className="flex max-h-[34vh] flex-col gap-2 overflow-y-auto"
                    >
                      {orderedSelection.map((item) => (
                        <Reorder.Item
                          as="div"
                          key={item.token}
                          value={item.token}
                          whileDrag={{ scale: 1.02, zIndex: 10 }}
                          transition={{ type: "spring", stiffness: 500, damping: 40 }}
                          className="flex touch-none select-none items-center gap-2.5 rounded-2xl border border-border bg-surface p-2 shadow-sm active:cursor-grabbing"
                        >
                          <span className="grid h-7 w-6 shrink-0 cursor-grab place-items-center text-muted-foreground/60 active:cursor-grabbing">
                            <Grip className="h-4 w-4" />
                          </span>
                          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-surface-2">
                            {item.image ? (
                              <img src={item.image} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <div className="grid h-full w-full place-items-center text-muted-foreground">
                                <ImageIcon className="h-4 w-4" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-micro font-bold uppercase tracking-wide text-muted-foreground">
                              {item.source}
                            </p>
                            <p className="truncate text-sm font-semibold leading-tight">
                              {item.title}
                            </p>
                            <div className="mt-0.5 flex items-center gap-2">
                              {item.priceLabel && (
                                <span className="text-xs font-bold">{item.priceLabel}</span>
                              )}
                              {item.earn != null && (
                                <span className="text-mini font-bold text-emerald-600">
                                  Earn ₹{item.earn}/sale
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeSelected(item.token);
                            }}
                            aria-label="Remove"
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </Reorder.Item>
                      ))}
                    </Reorder.Group>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setShowAddMore(false);
                    goToPreview();
                  }}
                  className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
                >
                  Continue{pickedCount > 0 ? ` (${pickedCount})` : ""}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        {previewLoading && (
          <div className="absolute inset-0 z-[60] grid place-items-center rounded-t-2xl bg-surface/80 backdrop-blur sm:rounded-2xl">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="text-sm font-medium text-muted-foreground">Preparing preview…</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// One found-product card, made draggable in place. The ⠿ handle is the only
// drag trigger (dragListener off) so tapping the card still selects/deselects;
// pressing the handle starts the reorder.
export function TagTab({
  label,
  count,
  active,
  onClick,
  // This pill exists (detection named it) but its products are still being
  // searched. It stays tappable — tapping it shows the skeleton grid, which is
  // a truthful "coming" rather than a misleading empty state.
  pending,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  pending?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
        active
          ? "bg-gradient-primary text-primary-foreground shadow-glow"
          : "bg-surface-2 text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
      <span
        className={`grid min-w-[1.15rem] place-items-center rounded-full px-1.5 text-micro font-bold ${
          active ? "bg-white/25 text-primary-foreground" : "bg-foreground/10 text-foreground/70"
        }`}
      >
        {pending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : count}
      </span>
    </button>
  );
}

export function ReorderableCard({ value, children }: { value: string; children: React.ReactNode }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      as="div"
      value={value}
      dragListener={false}
      dragControls={controls}
      whileDrag={{ scale: 1.04, zIndex: 30 }}
      transition={{ type: "spring", stiffness: 500, damping: 40 }}
      className="relative"
    >
      {children}
      <span
        onPointerDown={(e) => {
          e.stopPropagation();
          controls.start(e);
        }}
        onClick={(e) => e.stopPropagation()}
        aria-label="Drag to reorder"
        className="absolute right-2 top-2 z-20 grid h-7 w-7 cursor-grab touch-none place-items-center rounded-full bg-black/45 text-white shadow backdrop-blur transition hover:bg-black/65 active:cursor-grabbing"
      >
        <Grip className="h-3.5 w-3.5" />
      </span>
    </Reorder.Item>
  );
}

function NewPinDialog({
  storefronts,
  collections,
  products,
  onClose,
}: {
  storefronts: Storefront[];
  collections: Collection[];
  products: Product[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [storefrontId, setStorefrontId] = useState(storefronts[0]?.id ?? "");
  const [collectionId, setCollectionId] = useState("");
  const [productId, setProductId] = useState("");
  const [status, setStatus] = useState("draft");

  const productsForStore = products.filter((p) => p.storefront_id === storefrontId);
  const activeStorefront = storefronts.find((s) => s.id === storefrontId);

  async function handleUpload(file: File) {
    if (!file.type.startsWith("image/")) {
      return toast.error("Please choose an image file");
    }
    if (file.size > 10 * 1024 * 1024) {
      return toast.error("Max file size is 10 MB");
    }
    setUploading(true);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes.user?.id;
      if (!uid) throw new Error("Not signed in");
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${uid}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("pin-images")
        .upload(path, file, { upsert: false, contentType: file.type });
      if (upErr) throw upErr;
      const { data: signed, error: signErr } = await supabase.storage
        .from("pin-images")
        .createSignedUrl(path, 60 * 60 * 24 * 365 * 10);
      if (signErr || !signed) throw signErr ?? new Error("Could not sign URL");
      setImageUrl(signed.signedUrl);
      toast.success("Image uploaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const product = products.find((p) => p.id === productId);
      const { error } = await supabase.from("pins").insert({
        user_id: userRes.user!.id,
        title: title.trim(),
        description: description.trim() || null,
        image_url: imageUrl.trim() || null,
        storefront_id: storefrontId || null,
        collection_id: collectionId || null,
        product_id: productId || null,
        external_url: product?.affiliate_url ?? null,
        status,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pins"] });
      toast.success("Pin created");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-background/70 p-4 backdrop-blur">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="my-8 w-full max-w-lg rounded-2xl border border-border bg-surface shadow-elevate"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h3 className="font-display text-lg font-semibold">New pin</h3>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Pin preview card (matches pins/preview) */}
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <div className="relative aspect-[4/5] w-full bg-gradient-to-br from-rose-500 to-pink-600">
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-primary-foreground/90">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <ImageIcon className="h-8 w-8 opacity-90" />
                    <span className="text-xs font-medium opacity-90">Upload or paste an image</span>
                  </div>
                </div>
              )}

              {/* Upload / replace overlay */}
              <label className="absolute bottom-3 right-3 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-background/90 px-3 py-1.5 text-xs font-semibold text-foreground shadow backdrop-blur hover:bg-background">
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {uploading ? "Uploading…" : imageUrl ? "Replace" : "Upload image"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUpload(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <div className="p-4">
              <h2 className="font-display text-lg font-semibold leading-tight">
                {title.trim() || "Untitled pin"}
              </h2>
              {activeStorefront && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Storefront ·{" "}
                  <span className="font-medium text-foreground">{activeStorefront.name}</span>
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Image URL</label>
            <input
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="Paste an image URL or upload above"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Title</label>
            <input
              required
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Autumn capsule wardrobe"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional pin caption"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Storefront</label>
              <select
                value={storefrontId}
                onChange={(e) => {
                  setStorefrontId(e.target.value);
                  setProductId("");
                }}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                {storefronts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Collection</label>
              <select
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— None —</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Product link (optional)</label>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">— None (add later from pin) —</option>
              {productsForStore.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Status</label>
            <div className="mt-1 flex gap-2">
              {["draft", "scheduled", "live"].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`rounded-lg border px-3 py-1.5 text-xs capitalize ${
                    status === s
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            disabled={create.isPending || uploading}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow disabled:opacity-60"
          >
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Create pin
          </button>
        </div>
      </form>
    </div>
  );
}
