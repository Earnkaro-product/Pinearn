import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  Clipboard,
  Info,
  Link as LinkIcon,
  Loader2,
  Sparkles,
  ChevronDown,
  X,
} from "lucide-react";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getBrand } from "@/lib/brands";
import { BrandLogo } from "@/components/brand-card";
import { useGoBack } from "@/hooks/use-go-back";
import {
  ShareSheet,
  CollectionPicker,
  copyToClipboard,
  type CreatedProduct,
} from "@/components/affiliate-link-dialog";
import { getFriendlyMessage } from "@/lib/friendly-error";

export const Route = createFileRoute("/_authenticated/brands_/$brandId")({
  loader: ({ params }) => {
    const brand = getBrand(params.brandId);
    if (!brand) throw notFound();
    return { brand };
  },
  component: BrandDetailPage,
  notFoundComponent: () => (
    <div className="mx-auto max-w-md p-6 text-center text-sm text-muted-foreground">
      Brand not found.{" "}
      <Link to="/brands" className="text-primary underline">
        Back to brands
      </Link>
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-md p-6 text-center text-sm text-muted-foreground">
      <h2 className="font-display text-lg font-semibold text-foreground">Something went wrong</h2>
      <p className="mt-2">{getFriendlyMessage(error)}</p>
      <Link to="/brands" className="mt-4 inline-block text-sm text-primary underline">
        Back to brands
      </Link>
    </div>
  ),
});

const CREATOR_TILES = [
  {
    handle: "@influencer1",
    img: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=400&q=70",
  },
  {
    handle: "@creator2",
    img: "https://images.unsplash.com/photo-1556228720-195a672e8a03?w=400&q=70",
  },
  {
    handle: "@style3",
    img: "https://images.unsplash.com/photo-1512496015851-a90fb38ba796?w=400&q=70",
  },
  {
    handle: "@beauty4",
    img: "https://images.unsplash.com/photo-1522335789203-aaa8bc7c7f3f?w=400&q=70",
  },
  {
    handle: "@glow5",
    img: "https://images.unsplash.com/photo-1526045478516-99145907023c?w=400&q=70",
  },
  {
    handle: "@shop6",
    img: "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=400&q=70",
  },
];

const TC_ITEMS = [
  "Commission rates are subject to change based on promotional periods.",
  "Earnings are calculated on the final sale price after all discounts.",
  "Payouts are processed within 30 days of order confirmation.",
  "Returns and cancellations will affect your commission earnings.",
  "Minimum payout threshold is ₹500.",
  "Fraudulent activities will result in immediate account termination.",
  "Content must comply with brand guidelines and community standards.",
  "Exclusive deals may have different commission structures.",
];

function BrandDetailPage() {
  const { brand } = Route.useLoaderData();
  const [tab, setTab] = useState<"tc">("tc");
  const [url, setUrl] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [createdProduct, setCreatedProduct] = useState<CreatedProduct | null>(null);
  const [pickingCollection, setPickingCollection] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const router = useRouter();
  // Brand pages open from Discover and from the dashboard's brand rail, so back
  // follows history and only falls back to Discover on a deep link.
  const goBack = useGoBack({ to: "/brands" });

  const description = useMemo(
    () =>
      brand.description ??
      `${brand.name} is one of India's leading brands known for quality products and excellent customer service. Partner with ${brand.name} to earn up to ${brand.commission}% commission on every sale you drive through your affiliate links. Share your unique link across social media, blogs, or with your community and start earning today.`,
    [brand],
  );

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

      const { data: inserted, error } = await supabase
        .from("storefront_products")
        .insert({
          user_id: userId,
          storefront_id: sf.id,
          title: brand.name,
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
    <div className="min-h-screen bg-background pb-24">
      {/* Header — just the back button, brand identity lives in the card below */}
      <div className="sticky top-0 z-20 flex items-center border-b border-border bg-surface px-4 py-4">
        <button
          type="button"
          onClick={goBack}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-2 text-foreground"
          aria-label="Back"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      </div>

      <div className="mx-auto max-w-md px-4 pt-5">
        {/* Brand identity */}
        <div className="flex items-start gap-4">
          <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-2xl bg-surface ring-1 ring-border">
            <BrandLogo brand={brand} size={92} />
          </div>
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <h2 className="font-display text-2xl font-bold text-foreground">{brand.name}</h2>
            <div className="inline-flex w-fit items-center rounded-full bg-surface-2 px-4 py-1.5 text-sm font-semibold text-foreground ring-1 ring-border/60">
              Upto {brand.commission}% Earning
            </div>
          </div>
        </div>

        {/* Earnings banner */}
        <div className="mt-5 overflow-hidden rounded-2xl bg-primary text-primary-foreground shadow-elevate">
          <div className="flex items-center justify-center gap-2 border-b border-primary-foreground/15 px-4 py-3 text-sm">
            <Sparkles className="h-4 w-4" />
            <span>
              Avg. Creator Earns{" "}
              <span className="font-bold">{brand.avgEarnings ?? "₹50,000/month"}</span>
            </span>
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="p-4">
            <div className="text-sm font-semibold">Create Your Affiliate Link Now</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
              className="mt-3"
            >
              <div className="flex items-center gap-2 rounded-full bg-surface pl-4 pr-1.5 py-1.5">
                <input
                  ref={urlInputRef}
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setUrlError(null);
                  }}
                  placeholder={`Paste any ${brand.name} product link here`}
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
                {create.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Creating link...
                  </>
                ) : (
                  "Create affiliate link"
                )}
              </button>
            </form>
          </div>
        </div>

        {/* Description */}
        <div className="mt-5">
          <p
            className={`text-sm leading-relaxed text-foreground/80 ${expanded ? "" : "line-clamp-2"}`}
          >
            {description}
          </p>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary"
          >
            {expanded ? "Show less" : "Read more"}
            <ChevronDown className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>

        <div className="mt-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-surface p-3 ring-1 ring-border">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                Tracking Time
                <Info className="h-3.5 w-3.5" />
              </div>
              <div className="mt-1 text-base font-bold text-foreground">
                {brand.tracking ?? "24 hours"}
              </div>
            </div>
            <div className="rounded-2xl bg-surface p-3 ring-1 ring-border">
              <div className="text-xs text-muted-foreground">Confirmation Time</div>
              <div className="mt-1 text-base font-bold text-foreground">
                {brand.confirmation ?? "30 days"}
              </div>
            </div>
          </div>
          <h3 className="mt-5 font-display text-base font-bold text-foreground">
            Terms &amp; Conditions
          </h3>
          <ol className="mt-3 space-y-3">
            {TC_ITEMS.map((t, i) => (
              <li key={i} className="flex gap-3 text-sm text-foreground/80">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-foreground">
                  {i + 1}
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/* Post-generation share sheet — same bottom-sheet/modal shell as the
          dashboard's "Create affiliate link" quick action. */}
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
                    router.navigate({
                      to: "/collections/$id",
                      params: { id: collectionId },
                    });
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
    </div>
  );
}
