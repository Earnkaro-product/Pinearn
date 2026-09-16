import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Heart,
  Loader2,
  MessageCircle,
  RefreshCw,
  Share,
  Sparkles,
} from "lucide-react";
import { SuggestionCard } from "@/components/suggestion-card";
import type { PendingProductTag } from "@/lib/product-tag-data";

/**
 * The buyer's view of a pin — what Preview shows in BOTH flows.
 *
 * Modelled on Pinterest's own closeup: the image, the action row with the
 * pin's destination ("Visit website", the creator's storefront collection —
 * never a single product) beside Save, who made it, title and description,
 * then "Shop the look" — every product tag on the pin as a horizontal,
 * swipeable carousel.
 *
 * Deliberately NOT an editor: nothing here selects, reorders or scores. The
 * sequence it renders is the backend's (see planProductTags /
 * sequenceProductTags), and internal signals — match score, confidence, how a
 * product was found — never reach this surface. Attach Products is where the
 * creator changes what's on the pin; this is where they see what a shopper
 * will.
 *
 * The carousel is a native scroll container, not a slider library: a shopper
 * swipes on a phone, two-finger scrolls on a trackpad, or uses the arrows
 * with a mouse, and all three just work — a JS slider answers only to drag.
 */
export function ShopTheLookPreview({
  imageUrl,
  title,
  description,
  creatorName,
  creatorAvatarUrl,
  products,
  websiteUrl,
  loading = false,
  failed = false,
  onRetry,
}: {
  imageUrl: string | null;
  title: string;
  description?: string | null;
  creatorName?: string | null;
  creatorAvatarUrl?: string | null;
  /** Already in canonical order and within the limit. */
  products: PendingProductTag[];
  /** The full destination URL — where Visit website goes. Falls back to the
   * first product's page when the storefront URL isn't known yet, so the
   * button is never dead while products exist. */
  websiteUrl: string | null;
  /** The backend is still deciding the products. */
  loading?: boolean;
  failed?: boolean;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [imgLoaded, setImgLoaded] = useState(false);
  const destination = websiteUrl ?? products[0]?.link ?? null;
  const host = destination ? safeHost(destination) : null;

  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-surface shadow-sm">
      {/* The pin itself. */}
      <div className="relative bg-gradient-to-br from-rose-500/80 to-pink-600/80">
        {imageUrl && (
          <img
            key={imageUrl}
            src={imageUrl}
            alt=""
            onLoad={() => setImgLoaded(true)}
            className={`max-h-[520px] w-full object-cover transition-opacity duration-300 ${
              imgLoaded ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
      </div>

      {/* Action row — as the pin reads on Pinterest. The reactions are
          decorative here; Visit website is the real destination link. */}
      <div className="flex items-center gap-4 px-4 pt-4">
        <span className="flex items-center gap-4" aria-hidden>
          <Heart className="h-6 w-6 text-foreground/80" strokeWidth={1.75} />
          <MessageCircle className="h-6 w-6 text-foreground/80" strokeWidth={1.75} />
          <Share className="h-6 w-6 text-foreground/80" strokeWidth={1.75} />
        </span>
        <span className="ml-auto flex items-center gap-2">
          {destination ? (
            <a
              href={destination}
              target="_blank"
              rel="noopener noreferrer"
              title={host ?? undefined}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-2.5 text-sm font-bold text-primary transition hover:bg-primary/15 active:scale-[0.98]"
            >
              Visit website <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-4 py-2.5 text-sm font-bold text-muted-foreground/60">
              Visit website
            </span>
          )}
          <span
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground shadow-glow"
            aria-hidden
          >
            Save
          </span>
        </span>
      </div>

      <div className="space-y-1.5 px-4 pt-4">
        {creatorName && (
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-micro font-bold text-muted-foreground">
              {creatorAvatarUrl ? (
                <img src={creatorAvatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                creatorName.charAt(0).toUpperCase()
              )}
            </span>
            <span className="text-xs font-semibold">{creatorName}</span>
          </div>
        )}
        <h3 className="font-display text-lg font-bold leading-tight">{title || "Untitled pin"}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {products.length > 0 && <p className="text-xs text-muted-foreground">Paid link</p>}
      </div>

      {/* Shop the look — every tagged product, in the backend's sequence. */}
      <section aria-labelledby="shop-the-look" className="pb-5 pt-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between px-4"
        >
          <h4 id="shop-the-look" className="font-display text-base font-bold">
            Shop the look
            {products.length > 0 && (
              <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-mini font-semibold text-muted-foreground">
                {products.length}
              </span>
            )}
          </h4>
          <ChevronDown
            className={`h-5 w-5 text-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div className="mt-3">
            {loading && products.length === 0 ? (
              <div className="mx-4 flex items-center gap-2 rounded-2xl border border-dashed border-border p-4 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Finding the best product matches…
              </div>
            ) : failed && products.length === 0 ? (
              <div className="mx-4 flex items-center justify-between gap-3 rounded-2xl border border-rose-300/60 bg-rose-500/5 p-3 text-xs">
                <span className="text-rose-600">We couldn't identify products in this Pin.</span>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="inline-flex items-center gap-1 rounded-full bg-surface px-3 py-1.5 font-bold text-foreground shadow-sm"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Retry
                  </button>
                )}
              </div>
            ) : products.length === 0 ? (
              <div className="mx-4 flex items-center gap-2 rounded-2xl border border-dashed border-border p-4 text-xs text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                No products on this Pin yet.
              </div>
            ) : (
              <ProductRail products={products} />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The horizontal product rail. Native `overflow-x-auto` with scroll-snap:
 * touch swipe, trackpad and shift+wheel all scroll it; the arrows (pointer
 * devices, shown only when there is somewhere to go) scroll by a page.
 */
function ProductRail({ products }: { products: PendingProductTag[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const update = () => {
      setCanBack(el.scrollLeft > 4);
      setCanForward(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [products.length]);

  const page = (dir: 1 | -1) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.8), behavior: "smooth" });
  };

  return (
    <div className="relative">
      <div
        ref={railRef}
        role="list"
        aria-label="Products in this Pin"
        className="no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {products.map((p) => (
          <div
            key={p.key}
            role="listitem"
            className="w-[62%] shrink-0 snap-start sm:w-[46%] md:w-[38%]"
          >
            <SuggestionCard
              title={p.title}
              thumbnail={p.thumbnail}
              source={p.retailer}
              link={p.link}
              price={p.price}
              showEarnings={false}
            />
          </div>
        ))}
      </div>
      {canBack && (
        <button
          type="button"
          onClick={() => page(-1)}
          aria-label="Previous products"
          className="absolute left-1 top-1/2 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-border bg-background/95 text-foreground shadow-elevate sm:grid"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {canForward && (
        <button
          type="button"
          onClick={() => page(1)}
          aria-label="More products"
          className="absolute right-1 top-1/2 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-border bg-background/95 text-foreground shadow-elevate sm:grid"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
