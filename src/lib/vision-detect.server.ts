// Multi-object product detection for pin images.
//
// Replaces the old self-hosted detector (POST /vision/detect-objects, ~27–50s,
// returned base64 crops we then had to upload to Supabase Storage) with the
// OpenAI vision proxy this app already uses for SEO copy. Same job — isolate
// each purchasable product in a busy pin so Google Lens can be run on a tight
// region instead of the whole scene — at roughly a fifth of the latency and
// with no storage writes at all.
//
// Three things changed shape, and they're the reason this module exists:
//
//   1. The model returns BOXES, not pixels. It cannot hand back a cropped
//      image, and nothing ever needs one: SearchAPI's `crop` parameter takes
//      the region alongside the image URL (normalised 0–1 corners — the same
//      coordinate space the model already answers in) and Google crops the
//      image itself, at full original resolution. See lensCropParam.
//   2. Because the crop is expressed in normalised coordinates end to end,
//      the image's pixel dimensions are never needed. The old path had to
//      probe them out of the file header to build a pixel crop URL, and
//      "found objects but couldn't measure the frame" was a dead end that
//      produced no crops at all; that failure mode no longer exists.
//   3. The MODEL reads the image through a public image proxy. Retailer and
//      Pinterest CDNs routinely 403 a server-side fetch — the raw ajio and
//      i.pinimg.com URLs both fail against the OpenAI proxy directly and both
//      succeed through the image proxy. Lens is unaffected: Google's crawler
//      fetches the original URL and is not refused the way our servers are.
//
// Everything here is best-effort: every failure path returns an empty result
// so the caller falls back to whole-image Lens.

import { logNet } from "@/lib/net-logger";
import { PRODUCT_CATEGORIES, toCategory, type ProductCategory } from "@/lib/product-category";
import { extractJsonObject, generateText, ImageUnfetchable } from "@/lib/openai-proxy.server";
import { getServiceSupabase } from "@/integrations/supabase/service-client";
import type { Json } from "@/integrations/supabase/types";

/** Public image proxy used to make CDN images fetchable by the model (its
 * server-side fetch is 403'd by most CDNs). Overridable so a self-hosted
 * imgproxy can be swapped in without touching this file. */
const IMAGE_PROXY = process.env.VISION_IMAGE_PROXY_URL || "https://images.weserv.nl/";

/** Boxes smaller than this fraction of the image are noise — a crop that small
 * carries too few pixels for Lens to match on. Mirrors the old detector's
 * `min_box_area`. */
const MIN_BOX_AREA = 0.001;
/** A box this close to the whole frame IS the whole frame. Such a box gets no
 * crop parameter at all, so its search shares the whole-image Lens cache entry
 * instead of running a second, near-identical search. */
const FULL_FRAME_AREA = 0.9;
/** Two boxes overlapping this much are the same object counted twice. Set high
 * on purpose: a genuinely nested product (t-shirt under an open shirt) scores
 * ~0.2 and must survive. */
const DUPLICATE_IOU = 0.6;

/** Six, back up from four, because coverage is now the thing being optimised:
 * an outfit pin genuinely carries six shoppable items (top, bottom, shoes, bag,
 * belt, sunglasses) and a cap of four decided which two the shopper never got
 * to see. The old comment called items five and six
 * "earrings-in-the-background territory" — with the accessory/jewellery
 * vocabulary widened, those ARE the products, not noise.
 *
 * The cost is real and worth stating: each extra object is another Lens call on
 * a paid API, another slot in the shared concurrency limiter, and a share of
 * the per-pin verification budget (VERIFY_BUDGET_PER_PIN in
 * pinterest.functions.ts) that is now split six ways instead of four. Lower
 * this first if spend or scan latency becomes the complaint. */
const MAX_OBJECTS = 6;

/** Width the pin is resized to before the model sees it.
 *
 * Detection is the first thing that happens and nothing — not even the product
 * pills — can be shown until it returns, so its latency is the floor on the
 * whole experience. A pin arrives from Pinterest at 1200px or more, and
 * handing the model all of it costs seconds of download for detail no box
 * needs: measured across real pins, 768px cut detection from 7.9s to 5.3s and
 * from 5.6s to 3.0s while returning THE SAME objects, same labels, same
 * categories.
 *
 * 768 rather than smaller because that is where the tradeoff turns: at 512 the
 * same pins came back a third faster again but a wristwatch stopped being
 * detected at all, and an object that is never detected can never be matched.
 * Boxes are normalised 0-1, so this changes what the model can SEE, never the
 * coordinate space it answers in. */
const DETECT_IMAGE_WIDTH = 768;

/** The categories the model must classify each object into. Downstream this is
 * the ONLY thing that decides whether a Lens match is allowed to appear under
 * an object's tab (see `categoriesAgree` in product-category.ts), so it is a
 * closed enum the model picks from rather than free text we'd have to
 * re-interpret with keyword guessing.
 *
 * The list itself lives in product-category.ts, next to the title regexes that
 * have to name the SAME categories — a detector enum that drifts from the title
 * vocabulary doesn't error, it just silently stops gating. Re-exported here
 * because this module is where the rest of the app has always imported it. */
export { PRODUCT_CATEGORIES, toCategory, type ProductCategory } from "@/lib/product-category";

// Compact by design. Every token in this prompt is paid on every pin, and the
// reply is parsed by machine — short keys ("o", "l", "c", "d", "b") cost a
// fraction of {"objects":[{"label":...,"bounding_box":...}]} across a board.
//
// Two details are measured, not stylistic:
//
//   CORNERS ON A 0-1000 INTEGER GRID, not [x,y,w,h] floats. The old [x,y,w,h]
//   form was ambiguous — the model drifted into emitting corners, and a corner
//   pair in the top-left half of the frame is indistinguishable from a valid
//   width/height pair, so it was silently read as a box of the wrong size in
//   the wrong place. Naming the four edges removes the ambiguity outright, and
//   on a sample of real pins it also measured better: boxes that had been
//   landing on the wall beside a blazer or the floor below a pair of shoes now
//   overlap the product they name.
//
//   "TRACE THE OUTLINE, NEVER INFER FROM THE POSE" is there because the failure
//   mode is specific: asked for a garment on a standing person, the model
//   returns where that garment usually sits on a body rather than where it is
//   in THIS frame.
const DETECT_PROMPT = [
  "Find every distinct purchasable product in this image.",
  "Reply with ONLY this JSON, nothing else:",
  '{"o":[{"l":"short product name","c":"category","d":"look","b":[left,top,right,bottom]}]}',
  "b = INTEGERS on a 0-1000 grid over the image: left/right 0 at the left edge, 1000 at the right edge; top/bottom 0 at the top edge, 1000 at the bottom edge.",
  "top = the product's topmost visible pixel, bottom = its lowest. Trace the outline; never infer it from the pose.",
  `c = exactly one of: ${PRODUCT_CATEGORIES.join(", ")}`,
  "d = this exact item's look in at most 8 words: main colour(s), pattern/print, material or finish. Describe what is VISIBLE, never a guess.",
  // Explicitly naming the small stuff is what gets it reported: asked only for
  // "every distinct purchasable product", the model returns the two or three
  // garments and stops, leaving the belt, the earrings and the mug on the table
  // — the exact items the widened title vocabulary now knows how to match.
  "One entry per item a shopper could buy, INCLUDING small and secondary ones: accessories (belt, scarf, socks, gloves), jewellery, eyewear, watches, headwear, bags, and any homeware, kitchenware, stationery, toys or pet items in frame.",
  "Ignore people, faces, skin, hair, background, walls, floors, text.",
  `Max ${MAX_OBJECTS}, most prominent first. Nothing to buy -> {"o":[]}`,
].join("\n");

export type Box = { x: number; y: number; w: number; h: number };
export type DetectedObject = {
  label: string;
  category: ProductCategory;
  /** The object's LOOK — "white leather low-top, gum sole" — straight from the
   * detection pass, which is the only stage that ever sees the pin itself. It
   * is the target that `verifyProductLook` holds candidate thumbnails against,
   * and (lowercased) part of the Lens `q` steer. Empty on rows detected before
   * the prompt asked for it; everything downstream treats that as "label only". */
  signature: string;
  box: Box;
};
/** One image's detection result — what gets cached, in memory and in the DB. */
export type Detection = { objects: DetectedObject[] };

/* ---------------- Image proxy ---------------- */

/** The proxy takes the source without its scheme. Anything already pointing at
 * the proxy is passed through untouched so we never double-wrap. */
function proxied(imageUrl: string, params?: Record<string, string | number>): string {
  if (imageUrl.startsWith(IMAGE_PROXY)) return imageUrl;
  const url = new URL(IMAGE_PROXY);
  url.searchParams.set("url", imageUrl.replace(/^https?:\/\//, ""));
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  return url.toString();
}

/** `box` as SearchAPI's `crop` parameter (`left;top;right;bottom`, each 0–1),
 * or null for a box that should search the whole image instead.
 *
 * This is the whole cropping story: no third-party image proxy renders a crop,
 * no pixel dimensions are ever resolved — Google fetches the ORIGINAL image and
 * applies the region itself, at full resolution, inside the one Lens call that
 * was being made anyway. Null in two cases, both deliberate:
 *
 *   - a near-full-frame box (the crop would be a copy of the whole image, and
 *     no parameter means the search shares the whole-image cache entry), and
 *   - a degenerate box that rounding collapsed below the API's `left < right`,
 *     `top < bottom` contract — better the whole frame than a 400.
 *
 * Three decimals: precise to 0.1% of the image (finer than any detector box),
 * while keeping the string stable for use inside cache keys. */
/** `box` grown by `factor` about its own centre, clamped to the frame.
 *
 * The rescue for a small object. Measured on a real outfit pin: the tight
 * crop of a pair of glasses returned 5 results and ZERO from a supported
 * retailer, while the same box at 2× returned 60 results, 22 of them
 * eyewear at supported retailers. A crop that small gives Lens too few
 * pixels and no context to place them, and it answers about the texture it
 * can see rather than the product. Widening costs precision — the category
 * and look gates downstream are what take that back. */
export function widenBox(box: Box, factor: number): Box {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const w = Math.min(1, box.w * factor);
  const h = Math.min(1, box.h * factor);
  return {
    x: Math.max(0, Math.min(1 - w, cx - w / 2)),
    y: Math.max(0, Math.min(1 - h, cy - h / 2)),
    w,
    h,
  };
}

export function lensCropParam(box: Box): string | null {
  if (box.w * box.h >= FULL_FRAME_AREA) return null;

  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const r = (v: number) => Math.round(clamp(v) * 1000) / 1000;
  const left = r(box.x);
  const top = r(box.y);
  const right = r(box.x + box.w);
  const bottom = r(box.y + box.h);
  if (left >= right || top >= bottom) return null;

  return `${left};${top};${right};${bottom}`;
}

/* ---------------- Detection ---------------- */

function intersectionOverUnion(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const overlap = w * h;
  const union = a.w * a.h + b.w * b.h - overlap;
  return union > 0 ? overlap / union : 0;
}

/** Breathing room around a box, as a fraction of the frame.
 *
 * Scaled to the object rather than fixed, because the two ends of the size
 * range fail in opposite directions and a single constant can't serve both.
 * Measured against Lens on real pins: a hand-perfect crop of just a pair of
 * shoes on a tiled floor returns FEWER and worse matches than a looser one —
 * with nothing but the product in frame, Lens has no context to place it and
 * starts matching on texture. A large garment needs the opposite treatment:
 * padding it further only drags the neighbouring product into the crop.
 *
 * Small objects therefore get the floor (a real margin relative to their size),
 * big ones the ceiling. Contamination that this lets in is cheap to undo — the
 * category gate downstream drops a match that doesn't belong to the tag — while
 * a product shaved off at the crop edge is unrecoverable. */
function paddingFor(w: number, h: number): number {
  return Math.min(0.09, Math.max(0.045, 0.25 * Math.max(w, h)));
}

/** Coerce one model-emitted box into a validated, padded Box, or null.
 *
 * The prompt asks for `[left, top, right, bottom]` on a 0-1000 integer grid.
 * Both of the other forms the model has been seen to drift into are accepted
 * rather than discarded, because each is unambiguous on its own terms:
 *   - normalised 0-1 corners (every value <= 1), and
 *   - width/height instead of right/bottom (`right` <= `left`, which no valid
 *     corner pair can be).
 * The old code had to GUESS between corners and width/height because the two
 * were genuinely indistinguishable in the 0-1 float form it asked for; naming
 * the edges in the prompt is what made this parse deterministic. */
function toBox(raw: unknown): Box | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  let n = raw.slice(0, 4).map(Number);
  if (n.some((v) => !Number.isFinite(v) || v < 0)) return null;

  // 0-1000 grid unless every value already fits in 0-1.
  if (n.some((v) => v > 1)) n = n.map((v) => v / 1000);
  if (n.some((v) => v > 1.001)) return null;

  const [x, y] = n;
  const w = n[2] > x ? n[2] - x : n[2];
  const h = n[3] > y ? n[3] - y : n[3];
  if (w <= 0 || h <= 0) return null;

  const pad = paddingFor(w, h);
  const px = Math.max(0, x - pad);
  const py = Math.max(0, y - pad);
  const box = {
    x: px,
    y: py,
    w: Math.min(1 - px, w + pad * 2),
    h: Math.min(1 - py, h + pad * 2),
  };
  return box.w * box.h >= MIN_BOX_AREA ? box : null;
}

type DetectReply = { o?: Array<{ l?: unknown; c?: unknown; d?: unknown; b?: unknown }> };

/**
 * Detect the purchasable products in an image.
 *
 * One model call. Returns [] for "nothing to buy here" (text pins, quotes,
 * artwork) and throws only when the call itself failed, so the caller can tell
 * a genuine empty result from an outage and cache the two differently.
 */
export async function detectObjects(imageUrl: string): Promise<DetectedObject[]> {
  const startedAt = Date.now();

  // Always via the proxy: the model's server-side fetch is refused outright by
  // Pinterest and most retailer CDNs.
  let text: string;
  try {
    text = (
      await generateText({
        prompt: DETECT_PROMPT,
        imageUrl: proxied(imageUrl, { output: "jpg", w: DETECT_IMAGE_WIDTH }),
        label: "detect",
      })
    ).text;
  } catch (e) {
    // The proxy could not read the image at all. Nothing to detect and nothing
    // to retry — report it as empty rather than as a failure.
    if (e instanceof ImageUnfetchable) {
      logNet("DETECT", { outcome: "image_unfetchable", durationMs: Date.now() - startedAt });
      return [];
    }
    throw e;
  }

  let reply: DetectReply;
  try {
    reply = extractJsonObject(text) as DetectReply;
  } catch (e) {
    logNet("DETECT", {
      outcome: "unparseable",
      durationMs: Date.now() - startedAt,
      reason: e instanceof Error ? e.message : String(e),
    });
    return [];
  }

  const kept: DetectedObject[] = [];
  for (const entry of Array.isArray(reply?.o) ? reply.o : []) {
    if (kept.length >= MAX_OBJECTS) break;
    const box = toBox(entry?.b);
    if (!box) continue;
    // The model sometimes lists one product twice (e.g. "shopping bags" for
    // each of a pair). Near-identical boxes are dropped; a nested but distinct
    // product scores well below the threshold and is kept.
    if (kept.some((k) => intersectionOverUnion(k.box, box) > DUPLICATE_IOU)) continue;
    kept.push({
      label: typeof entry?.l === "string" ? entry.l : "",
      category: toCategory(entry?.c),
      signature: typeof entry?.d === "string" ? entry.d.trim().slice(0, 120) : "",
      box,
    });
  }

  logNet("DETECT", {
    outcome: kept.length ? "detected" : "no_objects",
    durationMs: Date.now() - startedAt,
    objects: kept.length,
    labels: kept
      .slice(0, 5)
      .map((o) => o.label || "?")
      .join(","),
  });
  return kept;
}

/* ---------------- Look verification ---------------- */

// The last line of defence for "the product on the card must LOOK like the
// product in the pin". Everything before it — the crop, the Lens `q` steer,
// the category gate — narrows by KIND; only this stage ever compares
// appearance, because only a vision call can. One call per candidate: the
// proxy takes a single image_url, so the candidate's own thumbnail is the
// image and the pin-side object travels as text (the `d` signature captured
// during detection, the one pass that actually saw the pin).
//
// It is a filter, not an oracle. The model can be wrong in both directions,
// so the verdict is graded rather than binary — measured on real pins, a
// binary "same or not" rejected a near-identical shirt in a neighbouring
// colourway AND accepted a plain shirt whose title happened to rhyme with the
// target. The grades put both right: "close" keeps the first, the explicit
// pattern rule rejects the second.
//
//   "same"      the same product, or the same design in the same colourway
//   "close"     the same kind of item, visibly similar colour and pattern —
//               shown, but ranked after "same" and never presented as exact
//   "different" visibly not this product — dropped
//   null        no usable verdict (image unfetchable, proxy down, bad reply)
//               — callers treat it as "keep": a broken verifier must degrade
//               to the unverified behaviour, never to empty tabs.

export type LookVerdict = "same" | "close" | "different";

function verifyPrompt(label: string, signature: string, matchTitle: string): string {
  const target = signature ? `${label} — ${signature}` : label;
  return [
    "This image is a retailer's product photo. Compare the product in it to this target:",
    `Target: ${target}.`,
    matchTitle
      ? `Retailer's title for this listing: "${matchTitle.slice(0, 160)}" (context only — judge from the image).`
      : "",
    "Decide in this order:",
    "1. KIND: is it the same kind of item? If not -> different.",
    "2. PATTERN: look at the image. Is the pattern the same type (solid/plain vs striped vs checked vs floral vs graphic)? A plain item never matches a patterned target -> different.",
    "3. COLOUR: same colourway -> same. Similar colour family, same pattern -> close. Clearly different colours -> different.",
    "Ignore angle, lighting, background, and whether the item is worn or laid flat.",
    'Reply with ONLY this JSON: {"match":"same"} or {"match":"close"} or {"match":"different"}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Hosts that refuse the image proxy and must be handed to the model raw.
 *
 * Amazon's CDN 404s every weserv request while serving the identical URL
 * directly; every other retailer measured (Myntra, Flipkart/flixcart, Ajio)
 * is the other way round or works either way. Routing per host matters for
 * LATENCY, not just success: the alternative — try proxied, catch, retry raw
 * — pays two sequential model calls for every Amazon card on the page. */
const PROXY_HOSTILE_HOSTS = /(^|\.)media-amazon\.com$|(^|\.)ssl-images-amazon\.com$/i;

/** Amazon encodes the rendition it should serve in the filename
 * (`..._AC_UY1100_.jpg`). Since the proxy can't resize these, ask Amazon for a
 * small one directly: the full-size shot measured 15.5s through the model
 * against 1.5s for the 400px rendition of the same photo, with an identical
 * reading of what it shows. Ten times the wait for detail no verdict uses. */
const AMAZON_RENDITION = /\._[A-Z0-9_,]+_\.(jpe?g|png)$/i;

function visionImageUrl(imageUrl: string): string {
  try {
    if (PROXY_HOSTILE_HOSTS.test(new URL(imageUrl).hostname)) {
      return imageUrl.replace(AMAZON_RENDITION, "._AC_UY400_.$1");
    }
  } catch {
    return imageUrl;
  }
  // Everywhere else the proxy is both more reliable AND faster than the raw
  // URL — w=640 means the model downloads a fraction of a 1400px product
  // shot, measured at ~2s against ~4-6s raw. A verdict needs no more detail.
  return proxied(imageUrl, { output: "jpg", w: 640 });
}

/** How closely `imageUrl` (a candidate product photo) matches the detected
 * object. `matchTitle` is the listing's own title, passed as context.
 *
 * The image is never downloaded here — only its URL is handed to the vision
 * endpoint, which fetches it itself (see visionImageUrl for which form).
 * A host that refuses that form once is retried in the other form rather
 * than giving up, since an unverified card is a lookalike shown.
 *
 * Never throws; null means "no usable verdict". */
export async function verifyProductLook(
  label: string,
  signature: string,
  imageUrl: string,
  matchTitle = "",
): Promise<LookVerdict | null> {
  const startedAt = Date.now();
  const prompt = verifyPrompt(label, signature, matchTitle);
  const primary = visionImageUrl(imageUrl);
  try {
    let result;
    try {
      result = await generateText({ prompt, imageUrl: primary, label: "verify-look" });
    } catch (e) {
      if (!(e instanceof ImageUnfetchable)) throw e;
      const fallback =
        primary === imageUrl ? proxied(imageUrl, { output: "jpg", w: 640 }) : imageUrl;
      result = await generateText({ prompt, imageUrl: fallback, label: "verify-look-alt" });
    }
    if (!result.sawImage) return null;
    const reply = extractJsonObject(result.text) as { match?: unknown };
    const verdict =
      reply?.match === "same" || reply?.match === "close" || reply?.match === "different"
        ? (reply.match as LookVerdict)
        : null;
    logNet("VERIFY", {
      outcome: verdict ?? "unparseable",
      durationMs: Date.now() - startedAt,
    });
    return verdict;
  } catch (e) {
    logNet("VERIFY", {
      outcome: e instanceof ImageUnfetchable ? "image_unfetchable" : "error",
      durationMs: Date.now() - startedAt,
      reason: e instanceof Error ? e.message.slice(0, 120) : String(e),
    });
    return null;
  }
}

/* ---------------- Shared, durable detection cache ---------------- */

// Detection is the same answer for the same image no matter who asks, and it
// costs a model call to compute. The in-process Map that
// used to hold it is per-ISOLATE: this app runs on Cloudflare Workers, where an
// isolate lasts minutes and a deploy or a cold region drops the lot. The
// practical effect was that a pin re-detected itself over and over, and the
// user watched the same ~40s "scanning" wait they had already paid once —
// sometimes landing on a different set of products, because a re-detection
// isn't bit-identical.
//
// The `image_detections` table makes it survive. Every operation is
// best-effort: a missing table (migration not applied), a rejected write or a
// slow read all degrade to detecting live, exactly as before. Caching must
// never be load-bearing.

/** Detections are re-run after this long — long enough that a pin is normally
 * detected once in its life, short enough that a prompt change reaches old
 * pins without a manual purge. */
const DETECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows written before this are ignored and the pin re-detects once.
 *
 * They parse cleanly into the current shape — same normalised boxes, same
 * categories — so nothing would reject them, but they were produced by the
 * pre-signature prompt: no `d` field, which leaves the look gate grounding on
 * the bare label ("Top") instead of the object's actual appearance for up to
 * a month. Cheaper and more honest than a migration: bump this whenever the
 * detect prompt changes in a way that invalidates or impoverishes its output.
 *
 * Bumped again for the wider vocabulary: cached rows were produced when the
 * model could only pick from fifteen categories and was capped at four objects,
 * so a belt came back as "other" (or not at all) on every pin already scanned.
 * They would keep serving that thinner answer for the rest of the TTL. */
const DETECTION_EPOCH_MS = Date.parse("2026-08-10T11:00:00Z");

type DetectionRow = {
  image_url: string;
  objects: Json;
  detected_at: string;
};

/** Rehydrate a stored row, rejecting anything that doesn't still parse into the
 * current shape — a row written by an older prompt whose boxes were normalised
 * differently must not silently produce wrong crops. The width/height columns
 * older rows carry are simply not read: boxes are normalised 0–1 and the crop
 * is expressed to Lens in the same coordinates, so pixel dimensions no longer
 * participate at all. */
function rowToDetection(row: DetectionRow): Detection | null {
  if (!Array.isArray(row.objects)) return null;
  const objects: DetectedObject[] = [];
  for (const raw of row.objects) {
    const o = raw as { l?: unknown; c?: unknown; d?: unknown; b?: unknown };
    const b = o?.b;
    if (!Array.isArray(b) || b.length < 4) return null;
    const [x, y, w, h] = b.map(Number);
    if ([x, y, w, h].some((v) => !Number.isFinite(v)) || w <= 0 || h <= 0) return null;
    objects.push({
      label: typeof o.l === "string" ? o.l : "",
      category: toCategory(o.c),
      // Rows detected before the prompt asked for a look signature have no
      // `d`; empty means the verifier grounds on the label alone.
      signature: typeof o.d === "string" ? o.d : "",
      box: { x, y, w, h },
    });
  }
  return { objects };
}

async function loadDetection(imageUrl: string): Promise<Detection | null> {
  try {
    const { data, error } = await getServiceSupabase()
      .from("image_detections")
      .select("image_url, objects, detected_at")
      .eq("image_url", imageUrl)
      .maybeSingle();
    if (error || !data) {
      if (error) logNet("DETECT", { outcome: "cache_read_failed", reason: error.message });
      return null;
    }
    const detectedAt = new Date(data.detected_at).getTime();
    if (Date.now() - detectedAt > DETECTION_TTL_MS) return null;
    if (detectedAt < DETECTION_EPOCH_MS) return null;
    return rowToDetection(data as DetectionRow);
  } catch {
    return null;
  }
}

async function saveDetection(imageUrl: string, detection: Detection): Promise<void> {
  try {
    const { error } = await getServiceSupabase()
      .from("image_detections")
      .upsert(
        {
          image_url: imageUrl,
          objects: detection.objects.map((o) => ({
            l: o.label,
            c: o.category,
            d: o.signature,
            b: [o.box.x, o.box.y, o.box.w, o.box.h],
          })) as unknown as Json,
          detected_at: new Date().toISOString(),
        },
        { onConflict: "image_url" },
      );
    if (error) logNet("DETECT", { outcome: "cache_write_failed", reason: error.message });
  } catch {
    /* best-effort */
  }
}

/**
 * The detected objects for one image — one model call, or a hit on the shared
 * cache. Their normalised boxes are handed to Lens as-is (see lensCropParam),
 * so this is the entire detection story: no dimension probe runs beside it and
 * no result is ever unusable for lack of one.
 *
 * Throws only if detection itself failed, so the caller can distinguish "this
 * pin has nothing to buy" from "the detector is down" and cache them apart.
 */
export async function detectImage(imageUrl: string): Promise<Detection> {
  const cached = await loadDetection(imageUrl);
  if (cached) {
    logNet("DETECT", { outcome: "cache_hit", objects: cached.objects.length });
    return cached;
  }

  const detection = { objects: await detectObjects(imageUrl) };
  void saveDetection(imageUrl, detection);
  return detection;
}
