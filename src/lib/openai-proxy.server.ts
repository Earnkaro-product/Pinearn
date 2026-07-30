// The ONLY model call in the pin/board SEO pipeline.
//
// The proxy exposes two endpoints, and which one a request goes to depends
// entirely on whether we have an image:
//
//   VISION   POST $OPENAI_PROXY_IMAGE_URL      (…/api/public/openai-image)
//            body: { prompt, image_url }        image_url is REQUIRED and must
//            be a non-empty string — an empty one is a 400, not a text-only
//            fallback. Verified vision: it reports the actual contents and
//            colours of images it has never plausibly been trained on.
//
//   TEXT     POST $OPENAI_PROXY_API_URL         (…/api/openai)
//            body: { prompt }                   For pins with no image at all,
//            for boards with no cover, and as the degrade path when the vision
//            endpoint cannot fetch the image.
//
//   both →  200 { "success": true,  "response": "…" }
//        →  4xx { "success": false, "error": "…" }
//
// One pin = one request. The image goes to the model directly, so there is no
// separate vision stage and no object-detection provider in front of this.
//
// Two things the proxy does NOT give us, both of which shape this module:
//
//   1. NO SCHEMA ENFORCEMENT. There's no response_format, so the prompt asks
//      for raw JSON and extractJsonObject() parses defensively. One format
//      retry, then the caller falls back to LLM-free composed copy — a second
//      retry costs real money and almost never lands when the first didn't.
//   2. THE VISION ENDPOINT FETCHES THE IMAGE SERVER-SIDE, and some hosts
//      refuse it (upload.wikimedia.org 400s; picsum, unsplash and imgur are
//      fine). That failure is a 400 carrying a "download" error, which is
//      indistinguishable from a bad request unless you read the message — so
//      isImageFetchFailure() below classifies it and the request is retried
//      against the TEXT endpoint instead of being thrown away. The pin still
//      gets keyword-correct copy; it's just recorded as metadata-derived.

import { requireEnv } from "@/lib/pinterest-api";
import { logNet } from "@/lib/net-logger";
import {
  buildCopyPrompt,
  retryFeedback,
  type PinSuggestionContext,
  type SuggestionCandidate,
} from "@/lib/pin-seo";

const REQUEST_TIMEOUT_MS = 90_000;
// Transport-level retries only (429, 5xx, dropped connection) — these cost no
// tokens because no completion was produced. Content problems are handled by
// the pipeline's validation loop, which is deliberately much stingier.
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 800;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential with full jitter, so concurrent callers don't retry in lockstep. */
function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000;
  return Math.random() * BACKOFF_BASE_MS * 2 ** attempt;
}

type ProxyResponse = { success?: boolean; response?: string; error?: string };

/** The vision endpoint fetches the image itself, and a host that refuses it
 * comes back as a 400 whose message mentions downloading. Classified rather
 * than lumped in with "bad request" so the caller can degrade to text instead
 * of losing the suggestion. */
function isImageFetchFailure(status: number, error: string): boolean {
  return status === 400 && /download|fetch|image_url|unsupported|invalid url/i.test(error);
}

type PostResult = { ok: true; text: string } | { ok: false; error: string; status: number };

/** One POST with transport-level retries. Returns rather than throws, so the
 * caller can decide whether a failure is worth degrading or giving up on. */
async function post(
  url: string,
  body: string,
  label: string,
  startedAt: number,
): Promise<PostResult> {
  const apiKey = requireEnv("OPENAI_PROXY_API_KEY");
  let lastError = "";
  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.round(backoffDelayMs(attempt - 1, null));
      logNet("openai_proxy.retrying", { label, attempt, maxAttempts: MAX_RETRIES, delayMs });
      await sleep(delayMs);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-api-key": apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body,
      });
    } catch (e) {
      // Network-level: timeout, DNS, reset. Always worth another go.
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }

    const bodyText = await res.text();
    let parsed: ProxyResponse | null = null;
    try {
      parsed = JSON.parse(bodyText) as ProxyResponse;
    } catch {
      /* the proxy always answers JSON; a non-JSON body means an edge error page */
    }

    if (res.ok && parsed?.success && typeof parsed.response === "string") {
      return { ok: true, text: parsed.response };
    }

    lastStatus = res.status;
    lastError = parsed?.error ?? bodyText.slice(0, 300) ?? `HTTP ${res.status}`;

    // A bad request or a rejected key is settled — retrying burns time and
    // changes nothing. Everything else gets another attempt.
    //
    // 403 is deliberately NOT treated as permanent: the proxy sits behind a WAF
    // that answers 403 to clients it doesn't like (an identical request differs
    // only by User-Agent), so a 403 here is far more often an edge rejection
    // than a real authorization failure. Retrying costs no tokens, because a
    // rejected request never produced a completion.
    const permanent = res.status === 400 || res.status === 401;
    logNet("openai_proxy.error", {
      label,
      status: res.status,
      permanent,
      durationMs: Date.now() - startedAt,
      error: lastError.slice(0, 160),
    });
    if (permanent) break;
  }

  return { ok: false, error: lastError, status: lastStatus };
}

export type GenerateInput = {
  prompt: string;
  /** When set and non-empty, the request goes to the vision endpoint. */
  imageUrl?: string | null;
  /** Appears in logs so a bad batch can be traced to a stage. */
  label: string;
};

export type GenerateResult = {
  text: string;
  /** True only when the model actually received and read the image. */
  sawImage: boolean;
};

/**
 * Thrown when the vision endpoint accepted the request but could not download
 * the image.
 *
 * Deliberately a distinct type rather than a silent text-only retry inside this
 * module. The prompt is built ONE layer up, and a prompt written for a request
 * that carries an image ("ground the copy in what you can see") becomes an
 * instruction to hallucinate the moment the image goes missing. Only the caller
 * can rebuild the prompt correctly, so only the caller gets to decide to degrade.
 */
export class ImageUnfetchable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUnfetchable";
  }
}

/**
 * One prompt (+ optional image) → one string.
 *
 * Routes to the vision endpoint when an image is supplied and to the text
 * endpoint when one isn't. Throws ImageUnfetchable when the image itself was
 * the problem, so the caller can rebuild a no-image prompt and retry.
 */
export async function generateText({
  prompt,
  imageUrl,
  label,
}: GenerateInput): Promise<GenerateResult> {
  const startedAt = Date.now();
  const trimmedImage = imageUrl?.trim() || null;

  if (trimmedImage) {
    const result = await post(
      requireEnv("OPENAI_PROXY_IMAGE_URL"),
      JSON.stringify({ prompt, image_url: trimmedImage }),
      `${label}:vision`,
      startedAt,
    );

    if (result.ok) {
      logNet("openai_proxy.ok", {
        label,
        durationMs: Date.now() - startedAt,
        chars: result.text.length,
        sawImage: true,
      });
      return { text: result.text, sawImage: true };
    }

    if (isImageFetchFailure(result.status, result.error)) {
      logNet("openai_proxy.image_unfetchable", {
        label,
        error: result.error.slice(0, 160),
        imageUrl: trimmedImage.slice(0, 120),
      });
      throw new ImageUnfetchable(result.error);
    }
    throw new Error(`OpenAI proxy failed: ${result.error}`);
  }

  const result = await post(
    requireEnv("OPENAI_PROXY_API_URL"),
    JSON.stringify({ prompt }),
    `${label}:text`,
    startedAt,
  );
  if (!result.ok) throw new Error(`OpenAI proxy failed: ${result.error}`);

  logNet("openai_proxy.ok", {
    label,
    durationMs: Date.now() - startedAt,
    chars: result.text.length,
    sawImage: false,
  });
  return { text: result.text, sawImage: false };
}

/* ---------------- Did the model actually read the image? ---------------- */

// Belt-and-braces: the explicit refusal a NON-vision model gives when handed an
// image. The current vision endpoint reads images correctly and errors honestly
// when it can't, so this should never fire — it's kept because it costs one
// regex and it is the only thing that would catch a silent downgrade of the
// upstream model to a text-only one.
const CANNOT_SEE_IMAGE =
  /\b(?:can(?:'|’)?t|cannot|unable to|don(?:'|’)?t have the ability to)\s+(?:actually\s+)?(?:view|see|access|process|analyz|open)/i;

export function refusedImage(text: string): boolean {
  return CANNOT_SEE_IMAGE.test(text);
}

/* ---------------- JSON extraction ---------------- */

/** Pull the first balanced {...} out of a text response. Brace counting is
 * string- and escape-aware, so a `{` inside the description can't end the scan
 * early. Tolerates a ```json fence or a "Sure, here you go:" preamble. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: the whole body is JSON, or a lone fenced block.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const direct = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(direct);
  } catch {
    /* fall through to the scan */
  }

  const start = direct.indexOf("{");
  if (start === -1) throw new Error("response contained no JSON object");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < direct.length; i++) {
    const ch = direct[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(direct.slice(start, i + 1));
    }
  }
  throw new Error("response contained an unterminated JSON object");
}

/* ---------------- Copy generation ---------------- */

// Appended when the first attempt came back as something other than JSON.
// Blunt and short — a long lecture produces more prose, not less.
const JSON_ONLY_REMINDER = [
  "",
  "Your previous reply could not be parsed. Reply with the raw JSON object ONLY:",
  '{"title":"...","description":"..."}',
].join("\n");

export type CopyResult = {
  candidate: SuggestionCandidate;
  model: string;
  /** False when no image was sent, the image couldn't be fetched, or the model
   * said it couldn't read one. The suggestion is still usable — it's grounded in
   * the pin's metadata and trend data — but the caller records it as
   * metadata-derived rather than image-derived. */
  sawImage: boolean;
  /** True when the image was found to be unfetchable during this call. The
   * caller should pass `skipImage` on any further attempt for this pin so the
   * doomed vision request isn't paid for twice. */
  imageUnfetchable: boolean;
};

/**
 * Generate one title/description candidate from the image plus the keyword plan.
 *
 * `previousIssues` is set on a validation-failure retry and appends the
 * "attempt N was rejected because…" feedback to the same prompt, which is
 * cheaper than rebuilding a longer prompt from scratch.
 *
 * Cost per call: normally 1 request. 2 if the response is unparseable (one
 * format retry) or the image is unfetchable (one text-only retry).
 */
export async function generateCopy(
  context: PinSuggestionContext,
  previousIssues?: { issues: string[]; attempt: number },
  opts?: { skipImage?: boolean },
): Promise<CopyResult> {
  const model = "openai-proxy";
  const feedback =
    previousIssues && previousIssues.issues.length > 0
      ? retryFeedback(previousIssues.issues, previousIssues.attempt)
      : "";

  // Set to false once we learn the image can't be fetched, which switches the
  // prompt to its no-image wording. Rebuilding matters: the with-image prompt
  // tells the model to write from what it can see, so reusing it without an
  // image is what makes one invent "aged cherry shelves" out of nothing.
  let withImage = Boolean(context.pin.imageUrl?.trim()) && !opts?.skipImage;
  let degraded = false;

  // Two shots at well-formed JSON: the plain prompt, then the same prompt with
  // an explicit reminder. FORMAT retry only — copy that parses but reads badly
  // is the validation loop's problem.
  let lastParseError = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      buildCopyPrompt(context, { hasImage: withImage }) +
      feedback +
      (attempt === 1 ? "" : JSON_ONLY_REMINDER);

    let text: string;
    let sawImage: boolean;
    try {
      const result = await generateText({
        prompt,
        imageUrl: withImage ? context.pin.imageUrl : null,
        label: "copy",
      });
      text = result.text;
      sawImage = result.sawImage;
    } catch (e) {
      // The image is unusable, but the pin isn't. Rebuild without it and retry
      // — this costs one extra call and doesn't consume a format-retry, because
      // nothing was wrong with the previous attempt's formatting.
      if (e instanceof ImageUnfetchable && !degraded) {
        degraded = true;
        withImage = false;
        attempt--;
        continue;
      }
      throw e;
    }

    if (sawImage && refusedImage(text)) {
      sawImage = false;
      logNet("openai_proxy.image_ignored", { label: "copy", attempt });
    }

    // snake_case as the model emits it, mapped to the camelCase contract below.
    let raw: {
      title?: unknown;
      description?: unknown;
      image_subject?: unknown;
      fits_keywords?: unknown;
    };
    try {
      raw = extractJsonObject(text) as typeof raw;
    } catch (e) {
      lastParseError = e instanceof Error ? e.message : String(e);
      logNet("openai_proxy.unparseable", { label: "copy", attempt, error: lastParseError });
      continue;
    }

    if (typeof raw?.title !== "string" || typeof raw?.description !== "string") {
      lastParseError = "JSON was missing string title/description";
      logNet("openai_proxy.unparseable", { label: "copy", attempt, error: lastParseError });
      continue;
    }

    // Only trust the coherence verdict when an image was genuinely read. With
    // no image the model has nothing to compare the keywords against, so a
    // `false` from it would be a guess — and a guess that would wrongly park
    // the suggestion in needs_review.
    const fitsKeywords =
      sawImage && typeof raw.fits_keywords === "boolean" ? raw.fits_keywords : undefined;
    if (fitsKeywords === false) {
      logNet("copy.keyword_mismatch", {
        label: "copy",
        imageSubject: String(raw.image_subject ?? "").slice(0, 80),
      });
    }

    return {
      candidate: {
        title: raw.title.trim(),
        description: raw.description.trim(),
        imageSubject:
          sawImage && typeof raw.image_subject === "string"
            ? raw.image_subject.trim().slice(0, 120)
            : undefined,
        fitsKeywords,
      },
      model,
      sawImage,
      imageUnfetchable: degraded,
    };
  }

  throw new Error(`OpenAI proxy returned unusable copy: ${lastParseError}`);
}
