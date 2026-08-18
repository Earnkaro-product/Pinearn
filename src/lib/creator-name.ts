/**
 * Telling a creator's real name apart from the phone number we signed them up
 * with.
 *
 * Sign-up seeds `profiles.display_name` with the phone number (see auth.tsx:
 * `options: { data: { display_name: phone } }`), so a non-empty display_name is
 * NOT the same as a name the person chose — every brand-new account has one. Any
 * code that derives something user-visible from display_name has to make this
 * distinction, and until now three places didn't: the storefront's name, its
 * description, and its public slug all ended up as "+917777777777".
 */

/** A real name contains at least one letter; "+918619596704" doesn't. */
export function hasRealName(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length >= 2 && /\p{L}/u.test(v);
}

/** The inverse, named for the thing we're guarding against at call sites. */
export function looksLikePhone(value: string | null | undefined): boolean {
  return !hasRealName(value);
}

/** The storefront name to show, never a phone number. */
export function storefrontNameFor(displayName: string | null | undefined): string {
  return hasRealName(displayName) ? displayName!.trim() : "My Shop";
}

/**
 * A short opaque id, letters only.
 *
 * Hex would be simpler, but the rule is that no number appears in a public path
 * at all — so the digits of the uuid are mapped onto letters rather than kept.
 * Still unguessable, still stable per user, and now indistinguishable from a word.
 * Mirrors the `translate()` in 20260818130000_storefront_name_never_phone.sql.
 */
export function opaqueHandle(userId: string, len = 8): string {
  const hex = userId.replace(/-/g, "").slice(0, len);
  const DIGITS = "0123456789";
  const LETTERS = "ghijklmnop";
  return hex.replace(/[0-9]/g, (d) => LETTERS[DIGITS.indexOf(d)]);
}

/**
 * A URL-safe slug for a storefront.
 *
 * Digits are stripped rather than escaped: the whole point is that a phone
 * number must never appear in a public path, and a slug built from digits alone
 * is a phone number with the punctuation removed. A name that reduces to nothing
 * falls back to a short opaque id, which is unguessable but also not personal.
 */
export function storefrontSlugFor(displayName: string | null | undefined, userId: string): string {
  const base = hasRealName(displayName)
    ? displayName!
        .trim()
        .toLowerCase()
        .replace(/[^a-z\s-]+/g, "")
        .replace(/[\s-]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40)
    : "";
  return base || `shop-${opaqueHandle(userId)}`;
}
