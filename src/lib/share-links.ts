/**
 * The visitor-facing links a creator shares.
 *
 * Both are built from `window.location.origin` rather than a configured domain,
 * so a link copied from a preview or staging host points back at the host the
 * creator is actually looking at. A hard-coded production domain would hand
 * someone testing on a preview build a link to a storefront that doesn't exist
 * there yet.
 */

/** The whole storefront: `/s/:slug`. */
export function storeShareUrl(storeSlug: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/s/${storeSlug}`;
}

/**
 * One collection: `/s/:slug?c=:collectionSlug`.
 *
 * A search param rather than a nested path, so every storefront link already in
 * the wild stays valid and a collection is simply a deeper entry point into the
 * same page — see `validateSearch` in src/routes/s.$slug.tsx.
 */
export function collectionShareUrl(storeSlug: string, collectionSlug: string): string {
  return `${storeShareUrl(storeSlug)}?c=${encodeURIComponent(collectionSlug)}`;
}
