import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
} from "lucide-react";
import { notifyCancellable, notifyDone, notifyProblem } from "@/lib/notify";
import { takeDownPin, visualSearchComponents, type CkResult } from "@/lib/pinterest.functions";
import { planProductTags } from "@/lib/product-tags.functions";
import { useVisualSearch } from "@/hooks/use-visual-search";
import {
  ProgressiveSuggestionCard,
  SuggestionCard,
  SuggestionCardSkeleton,
  realProductPrice,
} from "@/components/suggestion-card";
import {
  EMPTY_ATTACHMENT,
  attachedLinkSet,
  composeAttachedTags,
  tagFromUrl,
  type AttachmentState,
  type PendingProductTag,
} from "@/lib/product-tag-data";
import { logPipeline } from "@/lib/pipeline-log";
import { MAX_PRODUCT_TAGS_PER_PIN, canonicalTagLink } from "@/lib/product-tagging";
import { EducationalLoader, HINTS } from "@/components/rotating-hint";
import { hostBrand, estimateCommissionPct } from "@/lib/brands";
import { CollectionAddFlow, AddFromCollectionButton } from "@/components/collection-picker";
import { unreviewMonetizeProgressPin } from "@/lib/monetize-progress";
import { PinterestSyncBanner } from "@/components/pinterest-sync-banner";
import { usePinterestConnection } from "@/hooks/use-pinterest-connect";

// `pinId` keeps the open pin dialog in the URL rather than in local state
// only, so leaving for /pins/preview and coming back reopens the pin the user
// was editing instead of dumping them on the bare grid.
type PinsSearch = { new?: 1; filter?: "drafts"; pinId?: string };

export const Route = createFileRoute("/_authenticated/pins")({
  validateSearch: (s: Record<string, unknown>): PinsSearch => ({
    new: s.new === 1 || s.new === "1" ? 1 : undefined,
    // "all" used to be a third value here. The chip it drove is gone (this
    // page is Live and Drafts — untouched imports belong to the attach flow),
    // so an old ?filter=all link now reads as "no filter" and lands on Live.
    filter: s.filter === "drafts" ? s.filter : undefined,
    pinId: typeof s.pinId === "string" ? s.pinId : undefined,
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
  /** Present on pins synced from (or published to) Pinterest; the monetise
   * dialog uses it to read the pin's own product tags off Pinterest. Optional
   * because not every caller selects it. */
  pinterest_pin_id?: string | null;
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
  // Only used to pick the right empty-state copy. Pins already imported stay
  // fully usable without a live connection.
  const { usable: pinterestUsable } = usePinterestConnection();
  const [collectionFilter, setCollectionFilter] = useState<string>("live");
  const [openPinId, setOpenPinId] = useState<string | null>(search.pinId ?? null);

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

  // Sync the filter chip from the URL: ?filter=drafts after Save draft,
  // nothing otherwise — the monetization success screens land on Live, which is
  // what their own button says ("see your live pins"), and a draft the run left
  // behind is one chip away.
  useEffect(() => {
    setCollectionFilter(search.filter === "drafts" ? "drafts" : "live");
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
        // Flagged gone from Pinterest — see pins_.attach.tsx for why these rows
        // survive and every read has to exclude them.
        .is("pinterest_removed_at", null)
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
      // Nothing announced on success: the cancellable toast that scheduled this
      // said "taken down" the moment the pin left the grid, and repeating it
      // when the write lands would be two toasts for one action.
    },
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
    },
  });

  /**
   * Pins the creator has taken down but whose write hasn't been committed yet.
   *
   * A take-down is reversible in principle — the pin returns to the available
   * pool — but there is no server call that puts its products back, so "undo"
   * has to mean "don't do it": the rows leave the grid immediately, the write
   * is held for the length of the toast, and cancelling puts them straight back.
   * That is why the confirm() dialog on the single-pin delete is gone; a modal
   * that asks before anything happens and a toast that offers to call it off
   * afterwards are the same guard, and only one of them interrupts.
   */
  const [pendingTakedown, setPendingTakedown] = useState<Set<string>>(new Set());
  const holdTakedown = (ids: string[], held: boolean) =>
    setPendingTakedown((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (held) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  /** Take a pin down after a grace window, or not at all. */
  const takeDown = (pin: Pin) => {
    holdTakedown([pin.id], true);
    notifyCancellable({
      message: `“${pin.title}” taken down`,
      run: () => remove.mutateAsync(pin),
      onCancel: () => holdTakedown([pin.id], false),
      onError: (e) => {
        holdTakedown([pin.id], false);
        notifyProblem(e instanceof Error ? e.message : "Couldn't take that pin down");
      },
    });
  };

  /** The same, for everything currently filtered into view. The confirm() stays
   *  here: an undo window is a fine safety net for one pin, but agreeing to
   *  clear a whole shelf is worth saying out loud first. */
  const takeDownAll = (pinsToRemove: Pin[]) => {
    const ids = pinsToRemove.map((p) => p.id);
    holdTakedown(ids, true);
    notifyCancellable({
      message: `${ids.length} pin${ids.length === 1 ? "" : "s"} taken down`,
      run: () => removeAll.mutateAsync(pinsToRemove),
      onCancel: () => holdTakedown(ids, false),
      onError: (e) => {
        holdTakedown(ids, false);
        notifyProblem(e instanceof Error ? e.message : "Couldn't take those pins down");
      },
    });
  };

  // "new" is a pin imported from Pinterest that nobody has touched yet, and it
  // used to be filtered out here — so a creator who had just connected, or just
  // created a Pin on Pinterest, opened Pins and saw nothing. The pins were in
  // the database and in the monetize picker the whole time, which makes the
  // empty tab read as a failed import. They belong on this screen; what they
  // don't get is the take-down controls below, which only mean something for a
  // pin that has been published or drafted.
  const visiblePins = useMemo(
    () =>
      pins.filter(
        (p) =>
          (p.status === "draft" || p.status === "live" || p.status === "new") &&
          !pendingTakedown.has(p.id),
      ),
    [pins, pendingTakedown],
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
      hideWallet
      actions={
        filtered.length > 0 &&
        (storefronts.length === 0 ? (
          <button
            disabled
            className="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-gradient-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-glow opacity-50"
          >
            <Plus className="h-4 w-4" /> Attach product links to pins
          </button>
        ) : (
          <Link
            to="/pins/attach"
            className="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-gradient-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-glow"
          >
            <Plus className="h-4 w-4" /> Attach product links to pins
          </Link>
        ))
      }
    >
      <div className="no-scrollbar mb-5 -mx-1 flex items-center gap-2 overflow-x-auto px-1">
        {/* No "All" chip. It counted every untouched Pinterest import too, so it
            read as "300 pins" on a page that manages 45 — those imports are the
            subject of the attach flow above, not of this grid. */}
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
                takeDownAll(filtered);
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
          onClose={() => {
            setOpenPinId(null);
            // Drop ?pinId so a later back/forward doesn't reopen a dialog the
            // user has already dismissed.
            if (search.pinId) {
              void navigate({
                search: ((s: Record<string, unknown>) => ({ ...s, pinId: undefined })) as never,
                replace: true,
              });
            }
          }}
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
        <EmptyPins canCreate={storefronts.length > 0} pinterestConnected={pinterestUsable} />
      ) : (
        <div className="masonry-3 sm:masonry-4 lg:masonry-4">
          {filtered.map((p, i) => {
            const grad = GRADIENTS[i % GRADIENTS.length];
            return (
              <article
                key={p.id}
                onClick={() => {
                  if (p.status === "draft" || p.status === "new") setOpenPinId(p.id);
                }}
                onPointerEnter={() => warmScan(p)}
                onPointerDown={() => warmScan(p)}
                className={`group overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-border/60 transition hover:shadow-elevate ${
                  p.status === "draft" || p.status === "new" ? "cursor-pointer" : ""
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
                      aria-label={p.status === "live" ? "Edit" : "Attach product"}
                      className="grid h-8 w-8 place-items-center rounded-full bg-transparent text-white transition hover:bg-white/20"
                    >
                      {p.status === "live" ? (
                        <Pencil className="h-3.5 w-3.5" />
                      ) : (
                        <Link2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                    {/* Take-down returns a published or drafted pin to the
                        available pool. An untouched import is already there, so
                        the control would be a no-op dressed as a delete. */}
                    {p.status !== "new" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          takeDown(p);
                        }}
                        aria-label="Delete"
                        className="grid h-8 w-8 place-items-center rounded-full bg-transparent text-white transition hover:bg-white/20 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
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

function EmptyPins({
  canCreate,
  pinterestConnected,
}: {
  canCreate: boolean;
  pinterestConnected: boolean;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-12 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
        <PinIcon className="h-6 w-6 text-primary-foreground" />
      </div>
      <h3 className="mt-4 font-display text-xl font-semibold">No pins here</h3>
      {/* Empty because nothing was ever imported is a different problem from
          empty because nothing is monetised yet, and it has a different fix.
          Saying "attach a product to a pin" to someone with no Pins at all sends
          them looking for a button that can't help them. */}
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {!pinterestConnected
          ? "Your Pins live on Pinterest. Connect it and we'll import them here — or create one from scratch."
          : canCreate
            ? "Attach a product to a pin and start earning."
            : "Add a storefront and a product first."}
      </p>
      {!pinterestConnected && (
        <div className="mx-auto mt-5 max-w-sm text-left">
          <PinterestSyncBanner />
        </div>
      )}
      {canCreate && (
        <Link
          to="/pins/attach"
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-base font-semibold text-primary-foreground shadow-glow"
        >
          <Plus className="h-5 w-5" /> Attach product links to pins
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

  // Products the creator already owns on this pin's storefront — what the
  // Add-from-Collection flow offers.
  const storeProducts = useMemo(
    () => products.filter((p) => !pin.storefront_id || p.storefront_id === pin.storefront_id),
    [products, pin.storefront_id],
  );

  const [previewLoading, setPreviewLoading] = useState(false);
  // Manual entry lives in an "Add more" sheet now — never inline on the product
  // page. `showCollection` swaps in the full-screen Add-from-Collection flow.
  const [showAddMore, setShowAddMore] = useState(false);
  const [showCollection, setShowCollection] = useState(false);
  // Active product-tag tab (null = "All"). Tabs come from the object-detection
  // components returned with the matches.
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState(
    pin.external_url && !pin.product_id ? pin.external_url : "",
  );
  // The creator's Attach Products choices on top of the backend's plan.
  const [attachment, setAttachment] = useState<AttachmentState>(EMPTY_ATTACHMENT);

  // The search, streamed in two stages — see useVisualSearch. `tabs` carry
  // their own loading state, so a pill can render (and be tapped) while its
  // products are still being found.
  const {
    tabs,
    components,
    matches: suggestions,
    isDetecting,
    isLoading: aiLoading,
    isRefining,
    detectionFailed,
  } = useVisualSearch({ pinId: pin.id });

  // The backend's product tags for this pin: its saved tags and anything the
  // creator tagged on Pinterest lead, then the engine's best match per detected
  // object, ranked and capped. This is what gets attached by default and the
  // order Preview shows; the creator's taps below are deltas on it.
  const runPlan = useServerFn(planProductTags);
  const plan = useQuery({
    queryKey: ["product-tag-plan", pin.id],
    queryFn: () => runPlan({ data: { pinId: pin.id } }),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Full-screen scan experience. Detection names the products in well under a
  // second, so leaving on that alone dropped the user onto empty skeletons for
  // the many seconds the searches really take. It now shows what was found
  // straight away and holds briefly for the first tab's products (capped in
  // useScanPhase), so the reveal lands on a grid with something in it. Skip is
  // available the whole time.
  const firstTabReady = tabs.some((t) => !t.loading);
  const { phase: scanPhase, dismiss: dismissScan } = useScanPhase({
    searching: isDetecting,
    hasResults: tabs.some((t) => !!t.label) || suggestions.length > 0,
    productsReady: firstTabReady,
  });

  // Progressive rendering: each card resolves its own live price/stock via
  // ProgressiveSuggestionCard and reports back once settled; the price rides
  // with the attachment so Preview shows the confirmed figure.
  const handleSuggestionSettled = (link: string, details: CkResult) => {
    setAttachment((a) => {
      if (a.confirmedByLink.has(link)) return a;
      const next = new Map(a.confirmedByLink);
      next.set(link, details);
      return { ...a, confirmedByLink: next };
    });
  };

  // What's attached, in the backend's sequence — the same derivation the
  // create-pin wizard and Preview use, so a checkmark here is a card there.
  const attached = useMemo(
    () => composeAttachedTags(plan.data, attachment, storeProducts),
    [plan.data, attachment, storeProducts],
  );
  const attachedLinks = useMemo(() => attachedLinkSet(attached), [attached]);
  const attachedProductIds = useMemo(
    () => new Set(attached.map((t) => t.productId).filter((id): id is string => !!id)),
    [attached],
  );
  const isSelected = (link: string) => attachedLinks.has(canonicalTagLink(link));
  const rankByLink = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of plan.data?.ranked ?? []) m.set(canonicalTagLink(t.match.link), t.rank);
    return m;
  }, [plan.data]);

  const detectingRef = useRef(false);
  useEffect(() => {
    if (isDetecting && !detectingRef.current) {
      detectingRef.current = true;
      logPipeline("product_detection_started", { pin: pin.id });
    } else if (!isDetecting && detectingRef.current) {
      detectingRef.current = false;
      logPipeline(detectionFailed ? "product_match_failed" : "product_detection_completed", {
        pin: pin.id,
        objects: components.length,
      });
    }
  }, [isDetecting, detectionFailed, components.length, pin.id]);

  const overLimit = () =>
    notifyProblem(
      `You can attach up to ${MAX_PRODUCT_TAGS_PER_PIN} products to a Pin`,
      "Remove one to add another.",
    );

  /** Tapping a card attaches it (or detaches it) — a plain product pick. */
  const toggleAI = (link: string) => {
    const on = isSelected(link);
    if (!on && attached.length >= MAX_PRODUCT_TAGS_PER_PIN) return overLimit();
    const match = suggestions.find((m) => m.link === link);
    if (!match) return;
    const key = canonicalTagLink(link);
    setAttachment((a) => {
      const overrides = new Map(a.overrides);
      overrides.set(link, { selected: !on, match });
      // Turning a listing off turns it off however it was attached.
      return on
        ? {
            ...a,
            overrides,
            pasted: a.pasted.filter((t) => canonicalTagLink(t.link) !== key),
            productIds: a.productIds.filter(
              (id) =>
                canonicalTagLink(storeProducts.find((p) => p.id === id)?.affiliate_url ?? "") !==
                key,
            ),
          }
        : { ...a, overrides };
    });
    logPipeline(on ? "product_tag_removed" : "product_tag_added", { source: "match" });
  };

  // The single best earning rate across the matched retailers — headlines the
  // results ("earn up to Y% per sale") so the value is obvious at a glance.
  const topCommission = suggestions.length
    ? Math.max(...suggestions.map((s) => estimateCommissionPct(s.source)))
    : 0;

  // Product-tag tabs, one per detected component, in prominence order. They
  // come from `tabs` rather than from the matches, so a pill appears the
  // moment detection names it — with a count of "…" until its own search
  // lands.
  const tagByLink = useMemo(
    () => new Map(suggestions.map((s) => [s.link, s.tag] as const)),
    [suggestions],
  );
  const namedTabs = useMemo(
    () => tabs.filter((t) => !!t.label && (t.loading || t.matches.length > 0)),
    [tabs],
  );
  const tabLabels = useMemo(() => [...new Set(namedTabs.map((t) => t.label))], [namedTabs]);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of namedTabs) m.set(t.label, (m.get(t.label) ?? 0) + t.matches.length);
    return m;
  }, [namedTabs]);
  const tagLoading = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const t of namedTabs) m.set(t.label, (m.get(t.label) ?? false) || t.loading);
    return m;
  }, [namedTabs]);
  useEffect(() => {
    if (activeTag && !tabLabels.includes(activeTag)) setActiveTag(null);
  }, [activeTag, tabLabels]);
  // "All" is the canonical sequence: the backend's ranked order across every
  // object, then whatever it hasn't ranked yet in stream order. One object's
  // tab keeps the pipeline order.
  const orderedLinks = useMemo(() => {
    const links = suggestions.map((s) => s.link);
    if (activeTag) return links.filter((l) => tagByLink.get(l) === activeTag);
    return [...links]
      .map((l, i) => ({ l, i, r: rankByLink.get(canonicalTagLink(l)) ?? Infinity }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.l);
  }, [suggestions, activeTag, tagByLink, rankByLink]);
  const pendingCardCount = activeTag
    ? tagLoading.get(activeTag)
      ? 3
      : 0
    : Math.min(6, namedTabs.filter((t) => t.loading).length * 3);

  // Pick an existing collection product from the "Add more" sheet.
  const toggleCollectionProduct = (id: string) => {
    const on = attachedProductIds.has(id);
    if (!on && attached.length >= MAX_PRODUCT_TAGS_PER_PIN) return overLimit();
    setAttachment((a) => ({
      ...a,
      productIds: on ? a.productIds.filter((x) => x !== id) : [...a.productIds, id],
    }));
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setManualUrl(text.trim());
      else notifyProblem("Clipboard is empty");
    } catch {
      notifyProblem("Couldn't read clipboard — paste manually");
    }
  };

  const resolveExternal = () => {
    if (manualUrl.trim()) return manualUrl.trim();
    return attached[0]?.link ?? pin.external_url ?? null;
  };

  const goToPreview = () => {
    if (attached.length === 0 && !manualUrl.trim()) {
      notifyProblem("Attach a product or paste a product link first.");
      return;
    }
    // Preview is a snapshot of the sequence; it can't be taken while the
    // backend is still deciding it.
    if (plan.isPending) {
      notifyProblem("Still choosing the best products — one moment.");
      return;
    }
    // The canonical sequence, as the backend ordered it — the preview page
    // renders it as Shop the look and hands it to Go Live as-is. A pasted-but-
    // not-added link rides along, after the ranked products.
    const stashTags: PendingProductTag[] = [...attached];
    const pasted = manualUrl.trim();
    if (pasted && !attachedLinks.has(canonicalTagLink(pasted))) {
      // Same check as "Add link": an invalid paste must fail here, where the
      // creator can fix it, not on the preview page where they can't.
      let host: string;
      try {
        const u = new URL(pasted);
        if (!/^https?:$/.test(u.protocol)) throw new Error("bad scheme");
        host = u.hostname.replace(/^www\./, "");
      } catch {
        notifyProblem("That doesn't look like a valid product link");
        return;
      }
      if (stashTags.length >= MAX_PRODUCT_TAGS_PER_PIN) return overLimit();
      stashTags.push(
        tagFromUrl(pasted, pin.title ? `${pin.title} — ${host}` : host, pin.image_url),
      );
    }
    setPreviewLoading(true);
    try {
      sessionStorage.setItem(`pin-preview:${pin.id}`, JSON.stringify({ tags: stashTags }));
    } catch {
      /* ignore quota */
    }
    // Record the open dialog on the CURRENT entry (replace, not push) before
    // pushing preview: back from preview then returns to whichever page the
    // user came from — /pins or /pins/attach — with this pin reopened.
    void navigate({
      search: (s: Record<string, unknown>) => ({ ...s, pinId: pin.id }),
      replace: true,
    } as never);
    // No onClose() here: leaving the route unmounts the dialog, and calling it
    // would strip the ?pinId stamp we just wrote.
    navigate({ to: "/pins/preview", search: { pinId: pin.id } });
  };

  const saveDraft = useMutation({
    mutationFn: async () => {
      // A live pin's primary product and destination were set by Go Live; a
      // dialog closed without going live must not re-point them.
      const firstProductId =
        pin.status === "live"
          ? pin.product_id
          : (attached.find((t) => t.productId)?.productId ?? pin.product_id ?? null);
      const external = pin.status === "live" ? pin.external_url : resolveExternal();
      // "draft" means genuinely left midway — some product/link was picked
      // but Go Live was never hit. A pin nobody has touched yet (fresh from
      // Pinterest sync, nothing attached here) stays "new", not "draft".
      const hasSelection = attached.length > 0 || manualUrl.trim() !== "";
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
    onError: (e: Error) => notifyProblem(e.message),
  });

  // A pasted link is attached now and becomes a product row at Go Live —
  // nothing is written for a dialog the creator closes without going live.
  const addPastedLink = () => {
    const url = manualUrl.trim();
    if (!url) return notifyProblem("Paste a product link first");
    let host: string;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error("bad scheme");
      host = u.hostname.replace(/^www\./, "");
    } catch {
      notifyProblem("That doesn't look like a valid URL");
      return;
    }
    const key = canonicalTagLink(url);
    if (attachedLinks.has(key)) {
      setManualUrl("");
      notifyDone("Already attached");
      return;
    }
    if (attached.length >= MAX_PRODUCT_TAGS_PER_PIN) return overLimit();
    const own = storeProducts.find((p) => canonicalTagLink(p.affiliate_url) === key);
    setAttachment((a) =>
      own
        ? { ...a, productIds: [...a.productIds, own.id] }
        : {
            ...a,
            pasted: [
              ...a.pasted,
              tagFromUrl(url, pin.title ? `${pin.title} — ${host}` : host, pin.image_url),
            ],
          },
    );
    setManualUrl("");
    notifyDone(own ? "Already in your products — attached" : "Product attached");
    logPipeline("product_tag_added", { source: own ? "collection" : "url" });
  };

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
          {/* Compact header. "Monetize pins" is the screen's name and stays put;
            the scan/match status above it fades out as you scroll into the
            results, while the pin fades/scales into the top-centre as the big
            preview below collapses — so the pin stays in view while freeing the
            space it used to take. */}
          <div className="relative flex items-center gap-3 border-b border-border/60 bg-surface px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <motion.span
                style={{ opacity: morph.heroOpacity }}
                className="flex min-w-0 items-center gap-1.5"
              >
                <Sparkles className="h-3 w-3 shrink-0 text-primary" />
                <span className="truncate text-micro font-semibold uppercase tracking-wide text-primary">
                  {aiLoading && suggestions.length === 0 ? "Scanning pin…" : "Visual match"}
                </span>
              </motion.span>
              <h2 className="truncate font-display text-sm font-bold leading-tight">
                Monetize pins
              </h2>
            </div>

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
                <p className="mt-3 text-sm font-semibold">
                  We couldn't identify any products in this Pin
                </p>
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
                  {(isRefining || plan.isPending) && suggestions.length > 0 ? (
                    <p className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground/70">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {plan.isPending ? "Choosing the best matches…" : "Checking each match…"}
                    </p>
                  ) : plan.data && plan.data.tags.length > 0 ? (
                    <p className="mt-1 text-xs font-medium text-muted-foreground/70">
                      {plan.data.tags.length} best match{plan.data.tags.length === 1 ? "" : "es"}{" "}
                      attached — tap any card to change
                    </p>
                  ) : null}
                </div>

                {/* Category pills removed — replaced by live filtering. */}

                {/* Product-tag tabs — one per detected component. Below the pin,
                    above the products. Shown whenever detection named at least
                    one component — a single category still gets "All" + its own
                    pill. These render as soon as detection names them; a tab
                    whose own search is still running shows a spinner where its
                    count will go, so the set of tabs never shifts under a
                    tapping finger. */}
                {tabLabels.length >= 1 && (
                  <div className="no-scrollbar mt-4 -mx-1 flex items-center gap-2 overflow-x-auto px-1">
                    <TagTab
                      label="All"
                      count={suggestions.length}
                      pending={aiLoading}
                      active={activeTag === null}
                      onClick={() => setActiveTag(null)}
                    />
                    {tabLabels.map((t) => (
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

                <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {orderedLinks.map((link) => {
                    const s = suggestions.find((m) => m.link === link);
                    if (!s) return null;
                    return (
                      <ProgressiveSuggestionCard
                        key={link}
                        match={s}
                        selected={isSelected(link)}
                        onToggle={() => toggleAI(link)}
                        onSettled={handleSuggestionSettled}
                      />
                    );
                  })}
                  {/* Silhouettes for the pills still searching — the grid
                      grows into them instead of jumping. */}
                  {Array.from({ length: pendingCardCount }).map((_, i) => (
                    <SuggestionCardSkeleton key={`skeleton-${i}`} />
                  ))}
                </div>

                {/* Products attached by hand — pasted links and collection
                    picks — join the grid below the matches. */}
                {(attachment.pasted.length > 0 || attachment.productIds.length > 0) && (
                  <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    {attachment.productIds.map((id) => {
                      const p = storeProducts.find((x) => x.id === id);
                      if (!p) return null;
                      return (
                        <SuggestionCard
                          key={p.id}
                          title={p.title}
                          thumbnail={p.image_url}
                          source={hostBrand(p.affiliate_url)}
                          link={p.affiliate_url}
                          price={realProductPrice(p.price_cents)}
                          commissionPct={p.commission_pct}
                          selected={attachedProductIds.has(p.id)}
                          onToggle={() => toggleCollectionProduct(p.id)}
                        />
                      );
                    })}
                    {attachment.pasted.map((t) => (
                      <SuggestionCard
                        key={t.key}
                        title={t.title}
                        thumbnail={t.thumbnail}
                        source={t.retailer}
                        link={t.link}
                        price={t.price}
                        selected={isSelected(t.link)}
                        onToggle={() =>
                          setAttachment((a) => ({
                            ...a,
                            pasted: a.pasted.filter((x) => x.key !== t.key),
                          }))
                        }
                      />
                    ))}
                  </div>
                )}
              </>
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
              Next{attached.length > 0 ? ` (${attached.length})` : ""}{" "}
              <ArrowRight className="h-4 w-4" />
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
                    onClick={addPastedLink}
                    className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
                  >
                    <Plus className="h-4 w-4" />
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
                    pickedIds={attachedProductIds}
                    onTogglePicked={toggleCollectionProduct}
                    onExit={() => setShowCollection(false)}
                  />
                )}

                <button
                  type="button"
                  onClick={() => {
                    setShowAddMore(false);
                    goToPreview();
                  }}
                  className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
                >
                  Continue{attached.length > 0 ? ` (${attached.length})` : ""}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        {previewLoading && (
          <div className="absolute inset-0 z-[70] grid place-items-center rounded-t-2xl bg-surface/80 backdrop-blur sm:rounded-2xl">
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
      return notifyProblem("Please choose an image file");
    }
    if (file.size > 10 * 1024 * 1024) {
      return notifyProblem("Max file size is 10 MB");
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
      notifyDone("Image uploaded");
    } catch (e) {
      notifyProblem(e instanceof Error ? e.message : "Upload failed");
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
      notifyDone("Pin created");
      onClose();
    },
    onError: (e: Error) => notifyProblem(e.message),
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
