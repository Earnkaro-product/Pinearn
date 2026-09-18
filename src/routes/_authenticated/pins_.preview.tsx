import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, CheckCheck, Loader2, Rocket, Sparkles } from "lucide-react";
import { notifyProblem } from "@/lib/notify";
import type { SuggestionPrice } from "@/components/suggestion-card";
import { Skeleton } from "@/components/ui/skeleton";
import { getFriendlyMessage } from "@/lib/friendly-error";
import { goLivePin } from "@/lib/pinterest.functions";
import { ShopTheLookPreview } from "@/components/shop-the-look";
import {
  normalizeCollectionUrl,
  pinCollectionSlug,
  pinCollectionUrl,
  sequenceProductTags,
  tagFromProduct,
  tagFromUrl,
  toProductTagInput,
  type PendingProductTag,
} from "@/lib/product-tag-data";
import { logPipeline } from "@/lib/pipeline-log";

export const Route = createFileRoute("/_authenticated/pins_/preview")({
  validateSearch: (s: Record<string, unknown>) => ({
    pinId: typeof s.pinId === "string" ? s.pinId : "",
  }),
  component: PinPreviewPage,
});

type Pin = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  image_url: string | null;
  external_url: string | null;
  storefront_id: string | null;
  collection_id: string | null;
};
type Storefront = { id: string; name: string; slug: string };
type Product = {
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
type AIPick = {
  title: string;
  url: string;
  image: string | null;
  source: string;
  price: SuggestionPrice;
};
type StashedPreview = {
  productIds: string[];
  aiPicks: AIPick[];
  tags: PendingProductTag[];
};

const EMPTY_STASH: StashedPreview = { productIds: [], aiPicks: [], tags: [] };

/** What the monetise dialog handed over for this pin, straight out of
 * sessionStorage. A missing, half-written or unparseable entry reads as
 * nothing attached rather than throwing on a surface the creator can't fix.
 *
 * Returns nothing during SSR: this route renders on the server first, where
 * there is no sessionStorage. Touching it there throws a ReferenceError
 * mid-render, which is served as a blank page — the real tags are read on the
 * client immediately after hydration (see the effect in PinPreviewPage). */
function readStash(pinId: string): StashedPreview {
  if (!pinId || typeof window === "undefined") return EMPTY_STASH;
  try {
    const raw = sessionStorage.getItem(`pin-preview:${pinId}`);
    if (!raw) return EMPTY_STASH;
    const parsed = JSON.parse(raw);
    return {
      productIds: Array.isArray(parsed.productIds) ? parsed.productIds : [],
      aiPicks: Array.isArray(parsed.aiPicks) ? parsed.aiPicks : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch {
    return EMPTY_STASH;
  }
}

function PinPreviewPage() {
  const { pinId } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const runGoLive = useServerFn(goLivePin);
  // Once the pin is live we swap the whole page for a celebratory success
  // state instead of navigating straight away.
  const [liveDone, setLiveDone] = useState<null | { pinterestLinkUpdated: boolean }>(null);

  const { data: pin, isLoading: pinLoading } = useQuery({
    queryKey: ["pin", pinId],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return null;
      const { data, error } = await supabase
        .from("pins")
        .select("id,title,description,status,image_url,external_url,storefront_id,collection_id")
        .eq("id", pinId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data as Pin | null;
    },
    enabled: !!pinId,
  });

  const { data: storefront } = useQuery({
    queryKey: ["storefront", pin?.storefront_id],
    queryFn: async () => {
      if (!pin?.storefront_id) return null;
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return null;
      const { data } = await supabase
        .from("storefronts")
        .select("id,name,slug")
        .eq("id", pin.storefront_id)
        .eq("user_id", userId)
        .maybeSingle();
      return (data ?? null) as Storefront | null;
    },
    enabled: !!pin?.storefront_id,
  });

  // The monetise dialog hands over its PRODUCT TAGS — the complete desired
  // set, in order, each with how it was matched and its affiliate toggle. The
  // older `{ productIds, aiPicks }` stash is still read so a preview opened
  // before this deploy still goes live.
  //
  // Read into state rather than straight into a memo. The dialog writes the
  // stash and then navigates TWICE (it stamps ?pinId on the current entry
  // before pushing /pins/preview), so this component's first render can land
  // with pinId still empty — and a memo that resolved to "no tags" on that
  // render had no reason to re-read storage once the real pinId arrived. That
  // is the bug where Preview showed nothing until you refreshed the page: the
  // products were in sessionStorage the whole time, but nothing read them
  // again. Storage isn't reactive, so the re-read has to be explicit.
  const [stash, setStash] = useState<StashedPreview>(() => readStash(pinId));
  useEffect(() => {
    setStash(readStash(pinId));
  }, [pinId]);
  const usingTags = stash.tags.length > 0;

  const { data: selectedProducts = [] } = useQuery({
    queryKey: ["selected-products", stash.productIds.join(",")],
    queryFn: async () => {
      if (stash.productIds.length === 0) return [];
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("storefront_products")
        .select(
          "id,title,affiliate_url,image_url,price_cents,currency,commission_pct,storefront_id,collection_id",
        )
        .in("id", stash.productIds)
        .eq("user_id", userId);
      return (data ?? []) as Product[];
    },
  });

  const goLive = useMutation({
    mutationFn: async () => {
      // Only the pin is required. `storefront` is loaded for DISPLAY (the
      // creator name on the preview card) and its query is gated on
      // pin.storefront_id — gating the button on it meant a pin whose
      // storefront query hadn't resolved, or that has no storefront row to
      // load, failed here with a generic "Pin not ready" instead of reaching
      // the server, which resolves the storefront itself and reports exactly
      // what is missing.
      if (!pin) throw new Error("Pin not ready");
      // Real Go Live path, shared with board-level bulk monetization — see
      // performGoLive() in pinterest.functions.ts.
      if (usingTags) {
        return runGoLive({
          data: {
            pinId: pin.id,
            origin: window.location.origin,
            productTags: stash.tags.map(toProductTagInput),
            replaceTags: true,
          },
        });
      }
      return runGoLive({
        data: {
          pinId: pin.id,
          origin: window.location.origin,
          existingProductIds: stash.productIds,
          newProducts: stash.aiPicks.map((a) => ({
            title: a.title,
            affiliateUrl: a.url,
            imageUrl: a.image,
            // Carry the price through. The pick already holds the figure the
            // shopper saw, and the public storefront can only ever read a stored
            // price — it has no authenticated way to re-resolve one.
            priceCents: a.price ? Math.round(a.price.extractedValue * 100) : null,
          })),
        },
      });
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["pins"] });
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["all-products"] });
      // The plan for this pin now has different saved tags leading it.
      qc.invalidateQueries({ queryKey: ["product-tag-plan", pinId] });
      logPipeline("product_monetised", { pin: pinId, tags: productCount });
      try {
        sessionStorage.removeItem(`pin-preview:${pinId}`);
      } catch {
        /* ignore */
      }
      setLiveDone({ pinterestLinkUpdated: result.pinterestLinkUpdated });
    },
    onError: (e: Error) => notifyProblem(getFriendlyMessage(e)),
  });

  // What Shop the look shows — the dialog's canonical sequence, or the legacy
  // stash rendered through the same component so an old handoff still reads
  // as the buyer will see it.
  const displayTags = useMemo<PendingProductTag[]>(
    () =>
      usingTags
        ? sequenceProductTags(stash.tags)
        : sequenceProductTags([
            ...selectedProducts.map((p) => tagFromProduct(p, "collection")),
            ...stash.aiPicks.map((a) => ({
              ...tagFromUrl(a.url, a.title, a.image),
              retailer: a.source,
              price: a.price,
              priceCents: a.price ? Math.round(a.price.extractedValue * 100) : null,
            })),
          ]),
    [usingTags, stash, selectedProducts],
  );
  const productCount = displayTags.length;
  // Where Visit website goes: this pin's own storefront collection. For a live
  // pin that is its saved destination; for a pin about to go live it is the
  // collection Go Live WILL create — the slug is derived from the pin id, so
  // Preview and the real link agree (see pinCollectionSlug).
  // `origin` is empty during SSR (no window on the server) — reading it
  // unguarded threw mid-render and the route was served as a blank page. The
  // client render right after hydration fills it in.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const websiteUrl = pin
    ? pin.status === "live" && pin.external_url
      ? normalizeCollectionUrl(pin.external_url)
      : storefront && origin
        ? pinCollectionUrl(origin, storefront.slug, pinCollectionSlug(pin.title, pin.id))
        : null
    : null;

  if (!pinId) {
    return (
      <AppShell title="Preview" backButton backTo="/pins" hideBottomNav>
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No pin selected.
        </div>
      </AppShell>
    );
  }

  if (liveDone) {
    return (
      <AppShell title="Monetization started" hideBottomNav>
        <LiveSuccess
          imageUrl={pin?.image_url ?? null}
          count={productCount}
          pinterestLinkUpdated={liveDone.pinterestLinkUpdated}
          onSeePins={() => navigate({ to: "/pins", search: {} as never })}
        />
      </AppShell>
    );
  }

  return (
    // Back normally returns to the page the dialog was opened on (real
    // history). `backTo` is only the deep-link fallback: /pins with this pin
    // reopened, since a directly-opened preview has nowhere to go back to.
    <AppShell title="Preview" backButton backTo="/pins" backSearch={{ pinId }} hideBottomNav>
      {pinLoading || !pin ? (
        <div className="mx-auto max-w-xs pb-24 md:pb-8">
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <Skeleton className="aspect-[4/5] w-full rounded-none" />
            <div className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-36 rounded-full" />
                <Skeleton className="h-4 w-14 rounded-full" />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="overflow-hidden rounded-2xl border border-border bg-surface"
                  >
                    <Skeleton className="aspect-square w-full rounded-none" />
                    <div className="space-y-1.5 p-3">
                      <Skeleton className="h-3 w-full rounded-full" />
                      <Skeleton className="h-3 w-2/3 rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-sm pb-24 md:pb-8">
          {/* The buyer's view — the pin as a shopper will see it, with Shop the
              look in the sequence the backend decided. */}
          <ShopTheLookPreview
            imageUrl={pin.image_url}
            title={pin.title}
            description={pin.description}
            creatorName={storefront?.name}
            products={displayTags}
            websiteUrl={websiteUrl}
          />
        </div>
      )}

      {/* Sticky Go live button */}
      {pin && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 border-t border-border/60 bg-surface/95 px-4 pt-2.5 shadow-[0_-12px_30px_rgba(0,0,0,0.12)] backdrop-blur"
          style={{ paddingBottom: "max(0.6rem, env(safe-area-inset-bottom))" }}
        >
          {productCount === 0 && (
            <p className="mx-auto max-w-2xl pb-1.5 text-center text-mini text-muted-foreground">
              Attach a product to go live.
            </p>
          )}
          <div className="mx-auto flex max-w-2xl">
            <button
              onClick={() => goLive.mutate()}
              disabled={goLive.isPending || productCount === 0}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-primary px-3 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition disabled:opacity-50"
            >
              {goLive.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              <span>Go live</span>
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
}

// Confetti burst — fixed angles so it's deterministic (no layout jump on
// re-render), radiating out from the success badge on mount.
const CONFETTI = [
  { angle: -90, dist: 120, color: "bg-primary", delay: 0 },
  { angle: -50, dist: 140, color: "bg-emerald-500", delay: 0.05 },
  { angle: -20, dist: 110, color: "bg-amber-400", delay: 0.12 },
  { angle: 20, dist: 150, color: "bg-rose-400", delay: 0.03 },
  { angle: 55, dist: 120, color: "bg-primary", delay: 0.1 },
  { angle: 100, dist: 135, color: "bg-amber-400", delay: 0.07 },
  { angle: 140, dist: 115, color: "bg-emerald-500", delay: 0.14 },
  { angle: 200, dist: 130, color: "bg-rose-400", delay: 0.02 },
  { angle: 240, dist: 120, color: "bg-primary", delay: 0.11 },
  { angle: 290, dist: 145, color: "bg-amber-400", delay: 0.06 },
];

// Rain of cash — deterministic drops (fixed lanes/delays so there's no layout
// jump on re-render) that fall the full height of the screen and loop, to make
// the "you're earning now" moment land. A mix of ₹ notes and coins.
const CASH_DROPS = [
  { left: 6, kind: "note", delay: 0.0, dur: 2.8, size: 30, sway: 14, rot: -18 },
  { left: 16, kind: "coin", delay: 0.5, dur: 3.4, size: 22, sway: -12, rot: 30 },
  { left: 26, kind: "note", delay: 1.1, dur: 3.0, size: 26, sway: 10, rot: 12 },
  { left: 36, kind: "coin", delay: 0.2, dur: 3.7, size: 20, sway: -16, rot: -24 },
  { left: 45, kind: "note", delay: 0.8, dur: 2.6, size: 34, sway: 12, rot: 20 },
  { left: 55, kind: "coin", delay: 1.4, dur: 3.2, size: 24, sway: -10, rot: -16 },
  { left: 64, kind: "note", delay: 0.35, dur: 3.5, size: 28, sway: 16, rot: -12 },
  { left: 73, kind: "coin", delay: 0.95, dur: 2.9, size: 21, sway: -14, rot: 26 },
  { left: 82, kind: "note", delay: 0.15, dur: 3.3, size: 32, sway: 12, rot: 16 },
  { left: 90, kind: "coin", delay: 1.2, dur: 3.6, size: 23, sway: -12, rot: -22 },
  { left: 34, kind: "coin", delay: 1.7, dur: 3.1, size: 18, sway: 10, rot: 18 },
  { left: 60, kind: "note", delay: 1.9, dur: 2.7, size: 24, sway: -12, rot: -20 },
] as const;

function CashRain() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] overflow-hidden">
      {CASH_DROPS.map((d, i) => (
        <motion.span
          key={i}
          className="absolute -top-12"
          style={{ left: `${d.left}%` }}
          initial={{ y: "-15vh", opacity: 0, rotate: d.rot }}
          animate={{
            y: "115vh",
            x: [0, d.sway, -d.sway, 0],
            rotate: [d.rot, -d.rot, d.rot],
            opacity: [0, 1, 1, 0.9],
          }}
          transition={{
            duration: d.dur,
            delay: d.delay,
            repeat: Infinity,
            ease: "easeIn",
            x: { duration: d.dur, repeat: Infinity, ease: "easeInOut" },
            rotate: { duration: d.dur, repeat: Infinity, ease: "easeInOut" },
          }}
        >
          {d.kind === "note" ? (
            <span
              className="grid place-items-center rounded-md bg-gradient-to-br from-emerald-400 to-emerald-600 font-extrabold text-white shadow-lg ring-1 ring-emerald-300/50"
              style={{ width: d.size * 1.5, height: d.size, fontSize: d.size * 0.5 }}
            >
              ₹
            </span>
          ) : (
            <span
              className="grid place-items-center rounded-full bg-gradient-to-br from-amber-300 to-amber-500 font-extrabold text-amber-900 shadow-lg ring-2 ring-amber-200/70"
              style={{ width: d.size, height: d.size, fontSize: d.size * 0.55 }}
            >
              ₹
            </span>
          )}
        </motion.span>
      ))}
    </div>
  );
}

// Celebratory "you're live" state shown the moment a pin goes live.
function LiveSuccess({
  imageUrl,
  count,
  pinterestLinkUpdated,
  onSeePins,
}: {
  imageUrl: string | null;
  count: number;
  /** Whether Go Live managed to point the real Pinterest pin at the storefront.
   * When it couldn't (sandbox, expired connection) the copy says so instead of
   * promising a link that isn't there. */
  pinterestLinkUpdated: boolean;
  onSeePins: () => void;
}) {
  return (
    <div className="relative mx-auto flex min-h-[68vh] max-w-sm flex-col items-center justify-center overflow-hidden px-4 text-center">
      {/* Ambient brand glow */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob absolute -left-16 top-10 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="animate-blob-delay-2 absolute -right-14 bottom-16 h-52 w-52 rounded-full bg-emerald-400/15 blur-3xl" />
      </div>

      {/* Rain of cash — you're earning now */}
      <CashRain />

      <div className="relative z-10">
        {/* Confetti radiating from the badge */}
        {CONFETTI.map((c, i) => {
          const rad = (c.angle * Math.PI) / 180;
          return (
            <motion.span
              key={i}
              className={`absolute left-1/2 top-1/2 h-2 w-2 rounded-full ${c.color}`}
              initial={{ x: 0, y: 0, scale: 0, opacity: 0 }}
              animate={{
                x: Math.cos(rad) * c.dist,
                y: Math.sin(rad) * c.dist,
                scale: [0, 1, 0.8, 0],
                opacity: [0, 1, 1, 0],
              }}
              transition={{ duration: 1.1, delay: 0.15 + c.delay, ease: "easeOut" }}
            />
          );
        })}

        {/* Pulsing rings */}
        <span className="pointer-events-none absolute inset-0 -m-3 animate-ping rounded-full border-2 border-emerald-500/30" />

        {/* Pin thumbnail with a success check */}
        <motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 18 }}
          className="relative h-28 w-28 overflow-hidden rounded-3xl border border-white/60 bg-gradient-to-br from-rose-500 to-pink-600 shadow-glow"
        >
          {imageUrl ? (
            <img src={imageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-primary-foreground">
              <Sparkles className="h-9 w-9" />
            </div>
          )}
        </motion.div>
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 16, delay: 0.25 }}
          className="absolute -bottom-2 -right-2 grid h-11 w-11 place-items-center rounded-full bg-emerald-500 text-white shadow-glow ring-4 ring-background"
        >
          <CheckCheck className="h-6 w-6" strokeWidth={2.5} />
        </motion.span>
      </div>

      <motion.h2
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="relative z-10 mt-7 font-display text-2xl font-extrabold leading-tight tracking-tight"
      >
        Monetization started!
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="relative z-10 mx-auto mt-2 max-w-[17rem] text-sm font-medium text-muted-foreground"
      >
        {pinterestLinkUpdated
          ? "Your shoppable link is live on this pin"
          : "Your shoppable page is ready for this pin"}
        {count > 0 ? `, with ${count} product${count === 1 ? "" : "s"} tagged` : ""}
        {pinterestLinkUpdated
          ? " — every tap can now earn you a commission."
          : ". We couldn't update the pin's link on Pinterest just now — reconnect Pinterest and go live again to finish."}
      </motion.p>

      <motion.button
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        onClick={onSeePins}
        className="relative z-10 mt-8 inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-6 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.97]"
      >
        Check all the shoppable pins <ArrowRight className="h-4 w-4" />
      </motion.button>
    </div>
  );
}
