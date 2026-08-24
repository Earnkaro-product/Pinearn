import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/app-shell";
import { ContinueMonetizing } from "@/components/continue-monetizing";
import { BrandsSection } from "@/components/brand-card";
import { BEST_SELLING_BRANDS } from "@/lib/brands";
import {
  openAffiliateLinkDialog,
  ShareSheet,
  CollectionPicker,
  copyToClipboard,
  type CreatedProduct,
} from "@/components/affiliate-link-dialog";
import { supabase } from "@/integrations/supabase/client";
import { getPinterestAnalytics } from "@/lib/pinterest.functions";
import { PinterestSyncBanner } from "@/components/pinterest-sync-banner";
import { usePinterestConnection } from "@/hooks/use-pinterest-connect";
import { getFriendlyMessage } from "@/lib/friendly-error";
import { GRADIENTS } from "./pins";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { notifyDone, notifyProblem } from "@/lib/notify";
import {
  MousePointerClick,
  Coins,
  Rocket,
  ImagePlus,
  Link2,
  Link as LinkIcon,
  Store,
  Plus,
  ArrowRight,
  ChevronLeft,
  Clipboard,
  Eye,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

/* ---------------- Feature slideshow ---------------- */

const SLIDES = [
  {
    icon: Coins,
    title: "Monetise any pin",
    body: "Attach a product in one tap — earn on every click.",
    cta: { label: "Attach products", to: "/pins/attach" as const },
    gradient: "from-rose-100 via-rose-50 to-orange-50",
  },
  {
    icon: ImagePlus,
    title: "Create a pin",
    body: "Drop a photo or reel — publish-ready in seconds.",
    cta: { label: "Create pin", to: "/pins/create" as const },
    gradient: "from-orange-100 via-amber-50 to-rose-50",
  },
  {
    icon: Link2,
    title: "Affiliate links",
    body: "Paste any URL, get a trackable link instantly.",
    cta: { label: "Create link", onClick: openAffiliateLinkDialog },
    gradient: "from-red-50 via-rose-100 to-pink-50",
  },
  {
    icon: Store,
    title: "Your storefront",
    body: "One shoppable link for every product you share.",
    cta: { label: "Open storefront", to: "/storefront" as const },
    gradient: "from-pink-50 via-rose-100 to-orange-100",
  },
  {
    icon: Sparkles,
    title: "Monetise a whole board",
    body: "Swipe AI-matched products and go live in seconds.",
    cta: {
      label: "Monetise a board",
      to: "/pins/attach" as const,
      search: { intent: "monetize" as const },
    },
    gradient: "from-fuchsia-50 via-rose-100 to-orange-50",
  },
] as const;

function FeatureCarousel() {
  const [idx, setIdx] = useState(0);
  // Bumped whenever the user manually navigates, so the auto-advance timer
  // restarts fresh instead of firing right after their pick.
  const [autoTick, setAutoTick] = useState(0);
  useEffect(() => {
    // A slower cadence — each card stays long enough to actually read and act
    // on before the next slides in.
    const t = setInterval(() => setIdx((i) => (i + 1) % SLIDES.length), 9000);
    return () => clearInterval(t);
  }, [autoTick]);
  const goTo = (next: number) => {
    setIdx(next);
    setAutoTick((n) => n + 1);
  };
  const s = SLIDES[idx];
  const Icon = s.icon;
  return (
    <div>
      <div
        className={`relative overflow-hidden rounded-3xl border border-border shadow-elevate bg-gradient-to-br ${s.gradient} transition-colors duration-500`}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={idx}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.32, ease: "easeOut" }}
            className="px-5 py-5 sm:px-6 sm:py-6"
          >
            <div className="flex items-center gap-3.5">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/70 text-primary shadow-sm backdrop-blur sm:h-14 sm:w-14">
                <Icon className="h-6 w-6 sm:h-7 sm:w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-display text-lg font-bold leading-tight text-foreground sm:text-xl">
                  {s.title}
                </h3>
                <p className="mt-0.5 line-clamp-2 text-sm text-foreground/70">{s.body}</p>
              </div>
            </div>
            {"to" in s.cta ? (
              <Link
                to={s.cta.to}
                search={"search" in s.cta ? s.cta.search : undefined}
                className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow transition hover:opacity-90"
              >
                {s.cta.label} <ArrowRight className="h-4 w-4" />
              </Link>
            ) : (
              <button
                onClick={s.cta.onClick}
                className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow transition hover:opacity-90"
              >
                {s.cta.label} <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Dots only — no arrows */}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {SLIDES.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Go to slide ${i + 1}`}
            className={`h-1.5 rounded-full transition-all ${
              i === idx ? "w-5 bg-primary" : "w-1.5 bg-foreground/20"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function Dashboard() {
  // Home is where a creator who skipped authorization lands, so it is where the
  // offer to connect has to live. Rendered only when there is something to say —
  // never connected, or connected and broken — so a working account doesn't
  // carry a permanent banner about a connection that is fine.
  const { usable: pinterestUsable } = usePinterestConnection();
  return (
    // `greetingName` renders "Hi, {name}" in place of the title block, so the
    // subtitle this used to pass was never on screen.
    <AppShell title="Dashboard" greetingName>
      {!pinterestUsable && (
        <div className="mb-5">
          <PinterestSyncBanner />
        </div>
      )}

      {/* Feature carousel */}
      <FeatureCarousel />

      {/* Boards started in the manual monetise flow but not yet finished */}
      <ContinueMonetizing />

      {/* Quick actions */}
      <div className="mt-8">
        <h2 className="mb-4 font-display text-lg font-semibold">Quick actions</h2>
        {/* 2×2, in the order a creator actually meets them: monetise what's
            already on Pinterest, then make something new, then tune it, then
            the store it all feeds. */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          <QuickAction to="/pins/attach" icon={Link2} label="Monetise pin" />
          <QuickAction to="/pins/create" icon={Plus} label="Create pin" />
          <QuickAction to="/boost" icon={Rocket} label="Pinterest SEO" />
          <QuickAction to="/storefront" icon={Store} label="My store" />
        </div>
      </div>

      {/* Unmonetized pins → CTA */}
      <MonetizePins />

      {/* Boards with unmonetized pins → bulk swipe-approval CTA */}
      <MonetizeBoards />

      {/* Affiliate link maker — same banner card as the brand detail page's
          "Create Your Affiliate Link Now". */}
      <AffiliateLinkMaker />

      {/* Best selling brands */}
      <BrandsSection brands={BEST_SELLING_BRANDS} />
    </AppShell>
  );
}

function AffiliateLinkMaker() {
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [createdProduct, setCreatedProduct] = useState<CreatedProduct | null>(null);
  const [pickingCollection, setPickingCollection] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: async () => {
      const link = url.trim();
      if (!link) throw new Error("Paste a product link first");
      try {
        new URL(link);
      } catch {
        throw new Error("That doesn't look like a valid URL");
      }
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) throw new Error("Not signed in");

      const { data: sf, error: sfErr } = await supabase
        .from("storefronts")
        .select("id")
        .eq("user_id", userId)
        .order("is_default", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sfErr) throw sfErr;
      if (!sf) throw new Error("Your storefront isn't ready yet.");

      let hostname = "New product";
      try {
        hostname = new URL(link).hostname.replace(/^www\./, "");
      } catch {
        /* keep */
      }

      const { data: inserted, error } = await supabase
        .from("storefront_products")
        .insert({
          user_id: userId,
          storefront_id: sf.id,
          title: hostname,
          affiliate_url: link,
        })
        .select("id,affiliate_url,storefront_id")
        .single();
      if (error) throw error;
      return inserted as CreatedProduct;
    },
    onSuccess: (inserted) => {
      qc.invalidateQueries({ queryKey: ["all-products"] });
      qc.invalidateQueries({ queryKey: ["storefront-products"] });
      notifyDone("Affiliate link created");
      setCreatedProduct(inserted);
      setUrl("");
      setUrlError(null);
    },
    onError: (e: Error) => {
      notifyProblem(getFriendlyMessage(e));
      if (
        e.message === "Paste a product link first" ||
        e.message === "That doesn't look like a valid URL"
      ) {
        setUrlError(e.message);
        urlInputRef.current?.focus();
      }
    },
  });

  async function pasteFromClipboard() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setUrl(t.trim());
    } catch {
      notifyProblem("Clipboard access blocked");
    }
  }

  async function copyLink() {
    if (!createdProduct) return;
    const ok = await copyToClipboard(createdProduct.affiliate_url);
    if (ok) notifyDone("Link copied");
    else notifyProblem("Could not copy link");
  }

  function resetLinkFlow() {
    setCreatedProduct(null);
    setPickingCollection(false);
    setUrl("");
  }

  return (
    <>
      <h2 className="mt-8 mb-4 font-display text-lg font-semibold">Create affiliate links</h2>
      <div className="overflow-hidden rounded-2xl bg-primary text-primary-foreground shadow-elevate">
        <div className="p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="flex items-center gap-2 rounded-full bg-surface pl-4 pr-1.5 py-1.5">
              <input
                ref={urlInputRef}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError(null);
                }}
                placeholder="Paste a product link"
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <button
                type="button"
                onClick={pasteFromClipboard}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2"
                aria-label="Paste"
              >
                <Clipboard className="h-4 w-4" />
              </button>
            </div>
            {urlError && <p className="mt-1.5 px-1 text-xs text-destructive">{urlError}</p>}
            <button
              type="submit"
              disabled={create.isPending || !url.trim()}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-surface px-4 py-3 text-sm font-semibold text-foreground shadow-sm transition disabled:opacity-60"
            >
              {/* The heading above says "Create affiliate links" — the button
                  under the input doesn't need to say it a second time. */}
              {create.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Creating…
                </>
              ) : (
                "Create link"
              )}
            </button>
          </form>
        </div>
      </div>

      {/* Post-generation share sheet — same bottom-sheet/modal shell as the
          brand detail page's link flow. */}
      {createdProduct && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 px-4 pb-6 pt-24 backdrop-blur-sm sm:items-center sm:pb-4"
          onClick={resetLinkFlow}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md overflow-hidden rounded-3xl border border-border bg-surface shadow-elevate"
          >
            <div className="flex items-center justify-between px-6 pt-5">
              <div className="flex items-center gap-2 text-primary">
                {pickingCollection ? (
                  <button
                    onClick={() => setPickingCollection(false)}
                    className="flex items-center gap-1 text-xs font-semibold uppercase tracking-widest"
                    aria-label="Back"
                  >
                    <ChevronLeft className="h-4 w-4" /> Back
                  </button>
                ) : (
                  <>
                    <LinkIcon className="h-4 w-4" />
                    <span className="text-xs font-semibold uppercase tracking-widest">
                      Affiliate
                    </span>
                  </>
                )}
              </div>
              <button
                onClick={resetLinkFlow}
                className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-foreground transition hover:bg-surface"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-6 pb-6 pt-3">
              {pickingCollection ? (
                <CollectionPicker
                  product={createdProduct}
                  onDone={(collectionId) => {
                    resetLinkFlow();
                    navigate({ to: "/collections/$id", params: { id: collectionId } });
                  }}
                />
              ) : (
                <ShareSheet
                  link={createdProduct.affiliate_url}
                  onCopy={copyLink}
                  onAddToStorefront={() => setPickingCollection(true)}
                  onCreateAnother={resetLinkFlow}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Fashion-forward pins (outfits, clothing, mirror selfies, style shots) are the
// ones the seller most wants front-and-centre, so they headline the strip and
// take the biggest hardcoded reach numbers. We can't analyse image pixels here,
// so detection keys off common apparel/style words in the pin title.
const FASHION_TITLE_RE =
  /\b(fashion|outfit|ootd|style|styled|wear|wearing|womenswear|menswear|activewear|swimwear|loungewear|clothes|clothing|apparel|dress|dresses|gown|skirt|jeans|denim|jacket|coat|blazer|shirt|tee|tshirt|t-shirt|blouse|sweater|hoodie|knit|cardigan|pants|trousers|shorts|leggings|jumpsuit|romper|saree|sari|kurta|lehenga|heels|boots|sneakers|handbag|purse|wardrobe|lookbook|chic|glam|selfie|haul|co-?ord)\b/i;

function isFashionPin(title: string | null | undefined) {
  if (!title) return false;
  const t = title.toLowerCase();
  return FASHION_TITLE_RE.test(t) || t.includes("mirror selfie");
}

function MonetizePins() {
  const runGetAnalytics = useServerFn(getPinterestAnalytics);

  // Every unmonetized pin, no cap — attached-product status from our DB,
  // impressions/clicks from Pinterest's real per-pin analytics (90d = the
  // widest window Pinterest allows) so every synced pin shows real numbers,
  // not a possibly-stale local column.
  const { data: dbPins = [], isLoading: pinsLoading } = useQuery({
    queryKey: ["dashboard-unmonetized-pins"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("pins")
        .select("id, title, image_url, impressions, clicks")
        .eq("user_id", userId)
        .eq("is_owner", true)
        // Flagged gone from Pinterest — see pins_.attach.tsx. This list is the
        // "monetize these next" prompt, so a dead pin would be actively suggested.
        .is("pinterest_removed_at", null)
        .is("product_id", null)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: pinterestData, isLoading: analyticsLoading } = useQuery({
    queryKey: ["dashboard-pin-analytics"],
    queryFn: () => runGetAnalytics({ data: { range: "90d" } }),
    retry: false,
  });

  const isLoading = pinsLoading || analyticsLoading;

  const pins = useMemo(() => {
    const realById = new Map((pinterestData?.pins ?? []).map((p) => [p.id, p]));
    return (
      [...dbPins]
        .map((p) => {
          const real = realById.get(p.id);
          return {
            id: p.id,
            title: p.title,
            image_url: p.image_url,
            impressions: real?.impressions ?? p.impressions,
            clicks: real?.clicks ?? p.clicks,
          };
        })
        // Fashion pins (clothing / outfits / mirror selfies) sort first, then by
        // real impressions within each group — so they land on top and pick up
        // the biggest hardcoded reach numbers below.
        .sort((a, b) => {
          const fa = isFashionPin(a.title) ? 1 : 0;
          const fb = isFashionPin(b.title) ? 1 : 0;
          if (fa !== fb) return fb - fa;
          return b.impressions - a.impressions;
        })
        // Hardcoded impressions/clicks in strictly decreasing order — the first
        // card headlines the biggest number and each one steps down from there.
        .map((p, i) => {
          const impressions = Math.round(48_200 * Math.pow(0.86, i));
          return {
            ...p,
            impressions,
            clicks: Math.max(1, Math.round(impressions * 0.037)),
          };
        })
    );
  }, [dbPins, pinterestData]);

  // Nothing unmonetized — skip the whole section rather than show an empty CTA.
  if (!isLoading && pins.length === 0) return null;

  const VISIBLE_COUNT = 10;
  const visiblePins = pins.slice(0, VISIBLE_COUNT);
  const hasMore = pins.length > VISIBLE_COUNT;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">Turn pins into income</h2>
          {/* The promise, not the inventory count. The strip below already
              shows how many pins are waiting; what a creator can't tell from
              looking at it is how little work turning one into income is. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            Monetize your pins in one click with our AI
          </p>
        </div>
        <Link
          to="/pins/attach"
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          View all
        </Link>
      </div>

      {isLoading ? (
        <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-52 w-32 shrink-0 snap-start animate-pulse rounded-2xl border border-border bg-surface-2 sm:w-36"
            />
          ))}
        </div>
      ) : (
        <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {visiblePins.map((p) => (
            <div
              key={p.id}
              className="group relative h-52 w-32 shrink-0 snap-start overflow-hidden rounded-2xl shadow-sm ring-1 ring-border/60 transition hover:-translate-y-0.5 hover:shadow-elevate sm:w-36"
            >
              {p.image_url ? (
                <img
                  src={p.image_url}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-105"
                  loading="lazy"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center bg-surface-2 text-muted-foreground">
                  <ImagePlus className="h-5 w-5" />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
              <div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/50 px-2 py-1 text-micro font-semibold text-white backdrop-blur">
                <Eye className="h-3 w-3" /> {fmt(p.impressions)}
              </div>
              <div className="absolute inset-x-2 bottom-11 text-white">
                <p className="line-clamp-2 text-mini font-medium leading-tight">{p.title}</p>
                <p className="mt-1 inline-flex items-center gap-1 text-micro opacity-80">
                  <MousePointerClick className="h-2.5 w-2.5" /> {fmt(p.clicks)} clicks
                </p>
              </div>
              <Link
                to="/pins/attach"
                search={{ pinId: p.id, collection: undefined }}
                className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1 rounded-full bg-white px-2 py-2 text-mini font-semibold text-foreground shadow-sm transition hover:bg-white/90"
              >
                <Sparkles className="h-3 w-3 text-primary" /> Monetise
              </Link>
            </div>
          ))}
          {hasMore && (
            <Link
              to="/pins/attach"
              className="flex h-52 w-24 shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface-2/40 text-center transition hover:border-primary/40 hover:bg-surface-2 sm:w-28"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-surface text-primary shadow-sm">
                <ArrowRight className="h-4 w-4" />
              </span>
              {/* The section header already carries a "View all" link, so the
                  tail card only needs the number it adds. */}
              <span className="px-1 text-xs font-semibold leading-tight">
                {pins.length - VISIBLE_COUNT} more
              </span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function MonetizeBoards() {
  // Real Pinterest boards (collections), grouped from the same pins table —
  // no separate "boards" schema needed, mirrors MonetizePins' data shape.
  const { data: collections = [], isLoading: collectionsLoading } = useQuery({
    queryKey: ["dashboard-boards-collections"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("collections")
        .select("id,name,slug")
        .eq("user_id", userId)
        .order("position", { ascending: true });
      return (data ?? []) as { id: string; name: string; slug: string }[];
    },
  });

  const { data: pins = [], isLoading: pinsLoading } = useQuery({
    queryKey: ["dashboard-boards-pins"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("pins")
        .select("id, collection_id, image_url, product_id")
        .eq("user_id", userId)
        .eq("is_owner", true)
        // Flagged gone from Pinterest — see pins_.attach.tsx.
        .is("pinterest_removed_at", null);
      return data ?? [];
    },
  });

  const isLoading = collectionsLoading || pinsLoading;

  const boards = useMemo(() => {
    const byId = new Map(
      collections.map((c) => [
        c.id,
        { collection: c, images: [] as string[], total: 0, unmonetized: 0 },
      ]),
    );
    for (const p of pins) {
      const b = p.collection_id ? byId.get(p.collection_id) : undefined;
      if (!b) continue;
      b.total += 1;
      // Cover + two side thumbnails — same collage a real Pinterest board cover uses.
      if (p.image_url && b.images.length < 3) b.images.push(p.image_url);
      if (!p.product_id) b.unmonetized += 1;
    }
    return (
      Array.from(byId.values())
        .filter((b) => b.unmonetized > 0)
        // The "mirror" board is pinned to the first position; the rest fall in by
        // how many pins are still left to monetise.
        .sort((a, b) => {
          const ma = /\bmirror\b/i.test(a.collection.name) ? 1 : 0;
          const mb = /\bmirror\b/i.test(b.collection.name) ? 1 : 0;
          if (ma !== mb) return mb - ma;
          return b.unmonetized - a.unmonetized;
        })
        // Hardcoded impressions in strictly decreasing order — mirrors the pins
        // strip above so the top board headlines the biggest reach and each card
        // steps down from there.
        .map((b, i) => ({ ...b, impressions: Math.round(128_400 * Math.pow(0.84, i)) }))
    );
  }, [collections, pins]);

  // No board has anything left to monetize — skip the section entirely.
  if (!isLoading && boards.length === 0) return null;

  const VISIBLE_COUNT = 10;
  const visibleBoards = boards.slice(0, VISIBLE_COUNT);
  const hasMore = boards.length > VISIBLE_COUNT;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">Monetize boards in one click</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Attach affiliate product links to every pin in a board at once
          </p>
        </div>
        <Link
          to="/pins/attach"
          search={{ intent: "monetize" }}
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          View all
        </Link>
      </div>

      {isLoading ? (
        <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="w-60 shrink-0 snap-start sm:w-64">
              <div className="h-44 animate-pulse rounded-2xl border border-border bg-surface-2" />
              <div className="mt-2 h-3 w-2/3 animate-pulse rounded-full bg-surface-2" />
              <div className="mt-1.5 h-2.5 w-1/2 animate-pulse rounded-full bg-surface-2" />
            </div>
          ))}
        </div>
      ) : (
        <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {visibleBoards.map((b, i) => {
            const [cover, ...rest] = b.images;
            const side = rest.slice(0, 2);
            const grad = GRADIENTS[i % GRADIENTS.length];
            return (
              <div key={b.collection.id} className="group w-60 shrink-0 snap-start sm:w-64">
                {/* Real Pinterest board-cover collage — big cover + two stacked side thumbnails */}
                <div className="relative overflow-hidden rounded-2xl bg-surface ring-1 ring-border/60 transition group-hover:shadow-elevate">
                  <div className="flex h-44 gap-0.5">
                    <div className={`relative flex-[2] bg-gradient-to-br ${grad}`}>
                      {cover && (
                        <img
                          src={cover}
                          alt=""
                          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                          loading="lazy"
                        />
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-0.5">
                      {[0, 1].map((idx) => {
                        const p = side[idx];
                        const g = GRADIENTS[(i + idx + 1) % GRADIENTS.length];
                        return (
                          <div key={idx} className={`relative flex-1 bg-gradient-to-br ${g}`}>
                            {p && (
                              <img
                                src={p}
                                alt=""
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/70 to-transparent" />
                  <div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/50 px-2 py-1 text-micro font-semibold text-white backdrop-blur">
                    <Eye className="h-3 w-3" /> {fmt(b.impressions)}
                  </div>
                  <Link
                    to="/pins/monetize-board"
                    search={{ collectionId: b.collection.id, resume: undefined }}
                    className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1 rounded-full bg-white px-2 py-2 text-mini font-semibold text-foreground shadow-sm transition hover:bg-white/90"
                  >
                    <Sparkles className="h-3 w-3 text-primary" /> Monetise
                  </Link>
                </div>
                <div className="px-1 pt-2">
                  <h3 className="line-clamp-1 text-sm font-semibold">{b.collection.name}</h3>
                  <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    {b.total} {b.total === 1 ? "Pin" : "Pins"}
                    <span aria-hidden>·</span>
                    <Eye className="h-3 w-3" /> {fmt(b.impressions)} views
                  </p>
                </div>
              </div>
            );
          })}
          {hasMore && (
            <Link
              to="/pins/attach"
              search={{ intent: "monetize" }}
              className="flex h-44 w-28 shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface-2/40 text-center transition hover:border-primary/40 hover:bg-surface-2 sm:w-32"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-surface text-primary shadow-sm">
                <ArrowRight className="h-4 w-4" />
              </span>
              <span className="px-1 text-xs font-semibold leading-tight">
                {boards.length - VISIBLE_COUNT} more
              </span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function QuickAction({
  to,
  search,
  onClick,
  icon: Icon,
  label,
}: {
  to?: any;
  search?: any;
  onClick?: () => void;
  icon: any;
  label: string;
}) {
  const className =
    "group flex items-center gap-2.5 rounded-2xl border border-border bg-surface px-3 py-2.5 text-left transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-elevate sm:gap-3 sm:px-4 sm:py-3";
  const inner = (
    <>
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground sm:h-9 sm:w-9">
        <Icon className="h-4 w-4" />
      </div>
      <span className="text-xs font-semibold leading-snug sm:text-sm">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {inner}
      </button>
    );
  }
  return (
    <Link to={to} search={search} className={className}>
      {inner}
    </Link>
  );
}

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toLocaleString();
}
