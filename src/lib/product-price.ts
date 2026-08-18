/**
 * How a product's price is presented, shared by the in-app card and the public
 * storefront.
 *
 * These two screens show the SAME product to two different audiences, and the
 * "was" price is synthesized rather than stored (see computeMrp) — so if each
 * screen computed it locally, a creator could see ₹1,250 struck through in the
 * app while a visitor saw ₹1,200 on the shared link, for the same row. Same
 * input, one function, one answer.
 */

export type PriceParts = {
  /** Formatted selling price, e.g. "₹1,099". */
  price: string;
  /** Formatted struck-through "was" price, or null when there's no discount. */
  mrp: string | null;
  /** Whole-number discount percentage, or null. */
  discountPct: number | null;
};

/**
 * Real stored products have no MRP field of their own (just one selling price),
 * so synthesize a plausible struck-through "was" price the way most shopping
 * apps do: a fixed markup, rounded to a clean number, and deterministic — never
 * random — so it is stable across re-renders and identical on every screen.
 *
 * Visual-search matches skip this: they carry a REAL mrp from the CK Product
 * Details lookup, which is always preferred when present.
 */
export function computeMrp(extractedValue: number): number {
  const inflated = extractedValue * 1.25;
  const step = inflated >= 1000 ? 50 : 10;
  return Math.ceil(inflated / step) * step;
}

export function formatMoney(n: number, currency: string): string {
  return `${currency}${n.toLocaleString("en-IN")}`;
}

/**
 * Price, "was" price and discount for one stored product.
 *
 * `realMrp` wins when known. Pass `unverified` for a price nobody confirmed —
 * it suppresses the synthesized "was" price entirely, because inventing a
 * discount on top of an unverified number is a fabricated claim, not a display
 * choice.
 */
export function productPriceParts(
  priceCents: number | null | undefined,
  currency: string = "₹",
  opts: { realMrp?: number | null; unverified?: boolean } = {},
): PriceParts | null {
  if (priceCents == null) return null;
  const amount = priceCents / 100;
  const mrp = opts.realMrp ?? (opts.unverified ? null : computeMrp(amount));
  const hasDiscount = mrp != null && mrp > amount;
  return {
    price: formatMoney(amount, currency),
    mrp: hasDiscount ? formatMoney(mrp, currency) : null,
    discountPct: hasDiscount ? Math.round((1 - amount / mrp) * 100) : null,
  };
}
