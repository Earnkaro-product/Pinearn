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
//      image, so cropping happens at the URL layer (see cropUrl) rather than
//      in-process — this app deploys to Cloudflare Workers, where there is no
//      sharp/canvas to crop with anyway.
//   2. Cropping in pixels needs the image's real dimensions, and the model's
//      boxes are normalised 0–1. probeImageSize reads them out of the file
//      header (first 64 KB) instead of downloading and decoding the whole
//      image the way the old path did.
//   3. Both the model AND the cropper read the image through the same public
//      image proxy. Retailer and Pinterest CDNs routinely 403 a server-side
//      fetch — the raw ajio and i.pinimg.com URLs both fail against the
//      OpenAI proxy directly and both succeed through the image proxy.
//
// Everything here is best-effort: every failure path returns an empty result
// so the caller falls back to whole-image Lens.

import { logNet } from "@/lib/net-logger";
import { extractJsonObject, generateText, ImageUnfetchable } from "@/lib/openai-proxy.server";
import { getServiceSupabase } from "@/integrations/supabase/service-client";
import type { Json } from "@/integrations/supabase/types";

/** Public image proxy used both to make CDN images fetchable by the model and
 * to render crops. Overridable so a self-hosted imgproxy can be swapped in
 * without touching this file. */
const IMAGE_PROXY = process.env.VISION_IMAGE_PROXY_URL || "https://images.weserv.nl/";

/** Boxes smaller than this fraction of the image are noise — a crop that small
 * carries too few pixels for Lens to match on. Mirrors the old detector's
 * `min_box_area`. */
const MIN_BOX_AREA = 0.001;
/** A box this close to the whole frame IS the whole frame. Such a crop is
 * served as the original image URL so it shares Lens's cache entry. */
const FULL_FRAME_AREA = 0.9;
/** Two boxes overlapping this much are the same object counted twice. Set high
 * on purpose: a genuinely nested product (t-shirt under an open shirt) scores
 * ~0.2 and must survive. */
const DUPLICATE_IOU = 0.6;

/** Four is a deliberate cut from six. Every extra object is another Lens call
 * on a paid API and another slot in the shared concurrency limiter, and past
 * the fourth "most prominent" item a pin is into earrings-in-the-background
 * territory. Fewer, better-grounded objects beat a long tail. */
const MAX_OBJECTS = 4;

/** The categories the model must classify each object into. Downstream this is
 * the ONLY thing that decides whether a Lens match is allowed to appear under
 * an object's tab (see `matchesCategory` in pinterest.functions.ts), so it is a
 * closed enum the model picks from rather than free text we'd have to
 * re-interpret with keyword guessing. */
export const PRODUCT_CATEGORIES = [
  "top",
  "outerwear",
  "dress",
  "bottom",
  "footwear",
  "bag",
  "watch",
  "jewellery",
  "eyewear",
  "headwear",
  "beauty",
  "electronics",
  "furniture",
  "decor",
  "other",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

// Compact by design. Every token in this prompt is paid on every pin, and the
// reply is parsed by machine — short keys ("o", "l", "c", "b") cost a fraction
// of {"objects":[{"label":...,"bounding_box":...}]} across a whole board.
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
  '{"o":[{"l":"short product name","c":"category","b":[left,top,right,bottom]}]}',
  "b = INTEGERS on a 0-1000 grid over the image: left/right 0 at the left edge, 1000 at the right edge; top/bottom 0 at the top edge, 1000 at the bottom edge.",
  "top = the product's topmost visible pixel, bottom = its lowest. Trace the outline; never infer it from the pose.",
  `c = exactly one of: ${PRODUCT_CATEGORIES.join(", ")}`,
  "One entry per item a shopper could buy. Ignore people, faces, skin, hair, background, walls, floors, text.",
  `Max ${MAX_OBJECTS}, most prominent first. Nothing to buy -> {"o":[]}`,
].join("\n");

export type Box = { x: number; y: number; w: number; h: number };
export type DetectedObject = { label: string; category: ProductCategory; box: Box };
export type ImageSize = { width: number; height: number };
/** One image's detection result — what gets cached, in memory and in the DB. */
export type Detection = { objects: DetectedObject[]; size: ImageSize | null };

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

/** A URL that renders just `box` of `imageUrl`. Coordinates must be pixels, so
 * the caller has to have resolved the image's size first. Boxes covering
 * essentially the whole frame return the original URL — the crop would be a
 * copy of the full image, and reusing the URL means Lens serves it from cache
 * instead of running a second identical search. */
export function cropUrl(imageUrl: string, box: Box, size: ImageSize): string {
  if (box.w * box.h >= FULL_FRAME_AREA) return imageUrl;

  const px = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v * max)));
  const cx = px(box.x, size.width);
  const cy = px(box.y, size.height);
  const cw = Math.max(1, Math.min(size.width - cx, Math.round(box.w * size.width)));
  const ch = Math.max(1, Math.min(size.height - cy, Math.round(box.h * size.height)));

  // output=jpg keeps the crop small for whatever fetches it next; the proxy
  // applies cx/cy/cw/ch before any other transform.
  return proxied(imageUrl, { cx, cy, cw, ch, output: "jpg" });
}

/* ---------------- Image dimensions ---------------- */

/** Reads up to `limit` bytes of the response and abandons the rest, so a large
 * image costs one connection and a few packets rather than a full download. */
async function readHead(url: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      // Bare server fetches get 403'd by most CDNs; a browser UA does not.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      Range: `bytes=0-${limit - 1}`,
    },
    signal,
  });
  if (!res.ok && res.status !== 206) throw new Error(`image HTTP ${res.status}`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    // Servers that ignore Range would otherwise keep streaming the whole file.
    await reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Pull width/height out of a JPEG/PNG/WebP/GIF header. Returns null for a
 * format (or a truncated header) it can't read. */
export function parseImageSize(b: Uint8Array): ImageSize | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const le32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

  // PNG: IHDR is always the first chunk, at a fixed offset.
  if (b.length > 24 && u32(0) === 0x89504e47) return { width: u32(16), height: u32(20) };

  // GIF: logical screen descriptor, little-endian.
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return { width: le16(6), height: le16(8) };

  // WebP: RIFF container with three possible payload encodings.
  if (b.length > 30 && u32(0) === 0x52494646 && u32(8) === 0x57454250) {
    const fourcc = u32(12);
    if (fourcc === 0x56503858)
      // VP8X: 24-bit canvas size, minus one.
      return {
        width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    if (fourcc === 0x56503820)
      // VP8 (lossy): dimensions follow the 3-byte start code.
      return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (fourcc === 0x5650384c) {
      // VP8L (lossless): 14 bits each, bit-packed after the signature byte.
      const bits = le32(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  // JPEG: walk the segment chain to the frame header. SOF0–SOF15 carry the
  // dimensions, except SOF4/SOF8/SOF12 which are Huffman/arithmetic tables.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break; // scan data — no header left
      const length = u16(i + 2);
      if (length < 2) break;
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: u16(i + 5), width: u16(i + 7) };
      i += 2 + length;
    }
  }

  return null;
}

/** How long one header read gets. Reading 64 KB off a CDN is a sub-second job;
 * anything still outstanding at 4s is a host that isn't going to answer. The
 * old 8s-each-in-turn arrangement could spend 16s discovering that, and every
 * one of those seconds delayed the crops. */
const PROBE_TIMEOUT_MS = 4_000;

/** Image dimensions, read from the header.
 *
 * The origin and the image proxy are raced rather than tried in turn. They fail
 * independently — plenty of retailer CDNs 403 a direct server fetch and answer
 * happily through the proxy, and the proxy occasionally stalls on an image the
 * origin serves instantly — so whichever answers first is the one we wanted.
 * Null when neither does, which degrades the caller to the whole-image path. */
export async function probeImageSize(imageUrl: string): Promise<ImageSize | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  const attempt = async (url: string): Promise<ImageSize> => {
    const size = parseImageSize(await readHead(url, 65_536, controller.signal));
    if (!size || size.width <= 0 || size.height <= 0) throw new Error("unreadable header");
    return size;
  };

  try {
    return await Promise.any([attempt(imageUrl), attempt(proxied(imageUrl))]);
  } catch {
    return null;
  } finally {
    // Whoever lost the race is still streaming — hang up on them.
    controller.abort();
    clearTimeout(timer);
  }
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

const CATEGORY_SET = new Set<string>(PRODUCT_CATEGORIES);

function toCategory(raw: unknown): ProductCategory {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return CATEGORY_SET.has(s) ? (s as ProductCategory) : "other";
}

type DetectReply = { o?: Array<{ l?: unknown; c?: unknown; b?: unknown }> };

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
        imageUrl: proxied(imageUrl, { output: "jpg" }),
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

/* ---------------- Shared, durable detection cache ---------------- */

// Detection is the same answer for the same image no matter who asks, and it
// costs a model call plus a header read to compute. The in-process Map that
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

type DetectionRow = {
  image_url: string;
  width: number | null;
  height: number | null;
  objects: Json;
  detected_at: string;
};

/** Rehydrate a stored row, rejecting anything that doesn't still parse into the
 * current shape — a row written by an older prompt whose boxes were normalised
 * differently must not silently produce wrong crops. */
function rowToDetection(row: DetectionRow): Detection | null {
  if (!Array.isArray(row.objects)) return null;
  const objects: DetectedObject[] = [];
  for (const raw of row.objects) {
    const o = raw as { l?: unknown; c?: unknown; b?: unknown };
    const b = o?.b;
    if (!Array.isArray(b) || b.length < 4) return null;
    const [x, y, w, h] = b.map(Number);
    if ([x, y, w, h].some((v) => !Number.isFinite(v)) || w <= 0 || h <= 0) return null;
    objects.push({
      label: typeof o.l === "string" ? o.l : "",
      category: toCategory(o.c),
      box: { x, y, w, h },
    });
  }
  const size =
    row.width && row.height && row.width > 0 && row.height > 0
      ? { width: row.width, height: row.height }
      : null;
  return { objects, size };
}

async function loadDetection(imageUrl: string): Promise<Detection | null> {
  try {
    const { data, error } = await getServiceSupabase()
      .from("image_detections")
      .select("image_url, width, height, objects, detected_at")
      .eq("image_url", imageUrl)
      .maybeSingle();
    if (error || !data) {
      if (error) logNet("DETECT", { outcome: "cache_read_failed", reason: error.message });
      return null;
    }
    if (Date.now() - new Date(data.detected_at).getTime() > DETECTION_TTL_MS) return null;
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
          width: detection.size?.width ?? null,
          height: detection.size?.height ?? null,
          objects: detection.objects.map((o) => ({
            l: o.label,
            c: o.category,
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
 * Everything the crop builder needs for one image: the objects and the pixel
 * dimensions their normalised boxes have to be resolved against.
 *
 * The model call and the header read are independent and run together — the
 * model dominates (~6s) and the header read (a few hundred ms) disappears
 * inside it. A hit on the shared cache skips both.
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

  const [objects, size] = await Promise.all([detectObjects(imageUrl), probeImageSize(imageUrl)]);
  const detection = { objects, size };
  // Only worth storing once it's usable: a run that found objects but no
  // dimensions can't be cropped, and re-running it later may resolve the size.
  if (objects.length === 0 || size) void saveDetection(imageUrl, detection);
  return detection;
}
