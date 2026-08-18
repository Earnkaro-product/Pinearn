import { useEffect, useRef } from "react";
import { Check, ExternalLink, Image as ImageIcon, Loader2 } from "lucide-react";
import { estimateCommissionPct } from "@/lib/brands";
import { computeMrp, formatMoney } from "@/lib/product-price";
import { useProductDetails } from "@/hooks/use-product-details";
import type { CkResult, RawVisualMatch } from "@/lib/pinterest.functions";

export type SuggestionPrice = { value: string; extractedValue: number; currency: string } | null;

// Converts a stored product's real price (cents) into the same shape a
// visual-search match uses, so every product card in the app — real or
// AI-suggested — can render through this one component.
export function realProductPrice(priceCents: number | null | undefined): SuggestionPrice {
  if (priceCents == null) return null;
  const amount = priceCents / 100;
  return { value: `₹${amount.toLocaleString("en-IN")}`, extractedValue: amount, currency: "₹" };
}

// computeMrp/formatMoney moved to @/lib/product-price so the public storefront
// renders the identical "was" price for the same product — see the note there.

/**
 * The one product card used everywhere a product is shown anywhere in the
 * app — a visual-search match or a real stored product (attach-to-pin,
 * create-pin, attach-to-collection, go-live preview, storefront) — picture,
 * brand, struck-through MRP + real price, discount badge, and a bright-green
 * earnings pill. Pass `onToggle` for an interactive pick/select card; omit it
 * for a static display-only card.
 */
export function SuggestionCard({
  title,
  thumbnail,
  source,
  link,
  price,
  mrp: realMrp,
  priceUnverified,
  selected,
  pending,
  onToggle,
  commissionPct,
}: {
  title: string;
  thumbnail: string | null;
  source: string;
  link: string;
  price: SuggestionPrice;
  // Real MRP from the retailer's product page (CK Product Details API) when
  // known — omit it to fall back to a synthesized "was" price, which only
  // applies to real stored products that have no MRP field of their own.
  mrp?: number | null;
  // The retailer's product page couldn't be reached, so this price is Google
  // Lens's snapshot rather than a confirmed live figure. Deliberately invisible
  // — no badge, no styling difference — but it still suppresses the synthesized
  // "was" price below, because inventing a discount on top of a number nobody
  // verified would be a fabricated claim, not a display choice.
  priceUnverified?: boolean;
  selected?: boolean;
  // Image/title/source are already known (progressive rendering) but price/
  // stock/earning are still being confirmed — shows shimmer placeholders in
  // their place instead of omitting them outright, so the card looks
  // "populated" from the first frame rather than half-empty.
  pending?: boolean;
  onToggle?: () => void;
  // Pass the product's real stored commission rate when known (an actual
  // product) — omit it to fall back to the retailer-name estimate (an
  // AI visual-search match, which has no real commission on file yet).
  commissionPct?: number | null;
}) {
  const pct = commissionPct ?? estimateCommissionPct(source);
  const earning = price ? Math.round(price.extractedValue * (pct / 100)) : null;
  const mrp = realMrp ?? (price && !priceUnverified ? computeMrp(price.extractedValue) : null);
  const hasDiscount = !!(price && mrp && mrp > price.extractedValue);
  const discountPct = hasDiscount ? Math.round((1 - price!.extractedValue / mrp!) * 100) : null;
  const effectiveOnToggle = onToggle;
  const effectiveSelected = selected;

  const body = (
    <>
      <div className="relative aspect-square w-full overflow-hidden bg-surface-2">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={title}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.06]"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
        {/* Only this button opens the product page — tapping anywhere else on
            the card selects/deselects it. */}
        <span
          role="button"
          aria-label="Open product page"
          onClick={(e) => {
            e.stopPropagation();
            window.open(link, "_blank", "noopener,noreferrer");
          }}
          className="absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/45 text-white shadow backdrop-blur transition hover:bg-black/65"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </span>
        {pending ? (
          <span className="absolute bottom-2 right-2 grid h-7 w-7 place-items-center rounded-full bg-primary/90 text-primary-foreground shadow">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </span>
        ) : effectiveSelected ? (
          <span
            role={effectiveOnToggle ? "button" : undefined}
            aria-label={effectiveOnToggle ? "Deselect" : undefined}
            onClick={
              effectiveOnToggle
                ? (e) => {
                    e.stopPropagation();
                    effectiveOnToggle();
                  }
                : undefined
            }
            className="absolute bottom-2 right-2 grid h-7 w-7 place-items-center rounded-full bg-primary text-primary-foreground shadow-glow"
          >
            <Check className="h-4 w-4" strokeWidth={3} />
          </span>
        ) : effectiveOnToggle ? (
          <span
            role="button"
            aria-label="Select"
            onClick={(e) => {
              e.stopPropagation();
              effectiveOnToggle();
            }}
            className="absolute bottom-2 right-2 grid h-7 w-7 place-items-center rounded-full border-2 border-white/80 bg-black/30 text-transparent shadow backdrop-blur transition hover:border-white hover:text-white"
          >
            <Check className="h-4 w-4" strokeWidth={3} />
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <span className="truncate text-micro font-bold uppercase tracking-wide text-muted-foreground">
          {source}
        </span>
        <h3 className="line-clamp-2 min-h-[2.4em] text-xs font-semibold leading-snug text-foreground">
          {title}
        </h3>

        {pending ? (
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="h-[15px] w-16 animate-pulse rounded bg-surface-2" />
          </div>
        ) : (
          price && (
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="text-lead font-extrabold tracking-tight text-foreground">
                {price.value}
              </span>
              {hasDiscount && (
                <span className="text-mini font-medium text-muted-foreground line-through">
                  {formatMoney(mrp!, price.currency)}
                </span>
              )}
              {discountPct != null && discountPct > 0 && (
                <span className="text-mini font-bold text-amber-600">({discountPct}% OFF)</span>
              )}
            </div>
          )
        )}

        {pending ? (
          <span className="inline-flex h-6 w-24 animate-pulse rounded-full bg-surface-2" />
        ) : (
          earning != null && (
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-1 text-mini font-bold text-white shadow-sm shadow-emerald-500/40">
              Earn upto ₹{earning} per sale
            </span>
          )
        )}
      </div>
    </>
  );

  const cardClass = `group relative flex h-full flex-col overflow-hidden rounded-2xl border bg-surface text-left shadow-sm transition hover:-translate-y-1 hover:shadow-elevate ${
    effectiveSelected
      ? "border-primary ring-2 ring-primary"
      : "border-border hover:border-primary/50"
  }`;

  if (!effectiveOnToggle) {
    return <div className={cardClass}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={effectiveOnToggle}
      disabled={pending}
      className={`${cardClass} disabled:opacity-70`}
    >
      {body}
    </button>
  );
}

/**
 * The card's silhouette, shown while a pill's products are still being
 * searched. It exists so a tab the user has just tapped answers instantly with
 * the right SHAPE — the grid it is about to fill — instead of a spinner or, far
 * worse, an empty panel that reads as "no products found".
 */
export function SuggestionCardSkeleton() {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="aspect-square w-full animate-pulse bg-surface-2" />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <span className="h-[10px] w-12 animate-pulse rounded bg-surface-2" />
        <span className="h-[12px] w-full animate-pulse rounded bg-surface-2" />
        <span className="h-[12px] w-2/3 animate-pulse rounded bg-surface-2" />
        <span className="mt-1 h-[15px] w-16 animate-pulse rounded bg-surface-2" />
        <span className="inline-flex h-6 w-24 animate-pulse rounded-full bg-surface-2" />
      </div>
    </div>
  );
}

// A visual-search match always carries whatever price Google Lens reported.
// Turn that into the same CkResult shape a live CK lookup produces, so a card
// can show a real price the instant it paints and stay fully attachable even
// when CK never resolves. MRP equals the price (no invented discount) and it
// counts as available — Lens listings are live shopping results.
function lensFallbackResult(match: RawVisualMatch): CkResult {
  if (!match.price) return null;
  return {
    mrp: match.price.extractedValue,
    discountedPrice: match.price.extractedValue,
    available: true,
  };
}

/**
 * Progressive-rendering wrapper around SuggestionCard. Image/title/source
 * paint immediately from the raw match; the price shows a brief shimmer while
 * the one CK lookup for this URL is in flight, then resolves to a SINGLE final
 * value that never changes and never triggers another request. That resolved
 * price is the live CK figure, or the Google Lens price as a fallback when CK
 * can't confirm — so there is no "unavailable" dead end (every card stays
 * priced and attachable) and, critically, no flicker from a provisional price
 * to a final one. React Query's `staleTime: Infinity` + `retry: false` freezes
 * each card the instant it settles: once a price is on screen, it is fixed for
 * the session and no API is hit for it again.
 *
 * `onSettled` fires exactly once per mount, reporting the effective result
 * (live CK figure when available, otherwise the Lens fallback). Callers use
 * it to auto-attach priced matches and to track pipeline-completion timing.
 */
export function ProgressiveSuggestionCard({
  match,
  selected,
  onToggle,
  onSettled,
}: {
  match: RawVisualMatch;
  selected?: boolean;
  onToggle?: () => void;
  onSettled?: (link: string, details: CkResult) => void;
}) {
  const query = useProductDetails(match.link);
  const settledRef = useRef(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const fallback = lensFallbackResult(match);
  const ckDetails = query.isSuccess ? (query.data?.details ?? null) : null;
  // Live CK price wins; otherwise keep whatever Lens gave us.
  const details = ckDetails ?? fallback;
  // Showing the Lens price is the right call — a real listing shouldn't
  // disappear because a pricing service is down — but the card has to admit
  // which number it's showing.
  const priceUnverified = !ckDetails && !!fallback;

  useEffect(() => {
    if (settledRef.current || query.isLoading) return;
    settledRef.current = true;
    onSettledRef.current?.(match.link, ckDetails ?? fallback);
    // fallback/ckDetails are derived synchronously from these deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isLoading, query.isSuccess, query.data, match.link]);

  // Show the shimmer only until CK settles, then paint the price once and keep
  // it fixed — no provisional-then-final swap. This is what guarantees a card
  // never visibly changes (and never re-hits an API) after its price appears.
  if (query.isLoading) {
    return (
      <SuggestionCard
        title={match.title}
        thumbnail={match.thumbnail}
        source={match.source}
        link={match.link}
        price={null}
        pending
      />
    );
  }

  return (
    <SuggestionCard
      title={match.title}
      thumbnail={match.thumbnail}
      source={match.source}
      link={match.link}
      price={
        details
          ? {
              value: `₹${details.discountedPrice.toLocaleString("en-IN")}`,
              extractedValue: details.discountedPrice,
              currency: "₹",
            }
          : null
      }
      mrp={priceUnverified ? null : (details?.mrp ?? null)}
      priceUnverified={priceUnverified}
      selected={selected}
      onToggle={onToggle}
    />
  );
}
