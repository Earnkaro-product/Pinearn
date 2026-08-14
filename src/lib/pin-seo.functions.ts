// Pin SEO suggestion pipeline — orchestration + server functions.
//
// The pipeline, end to end:
//
//   1. CONTEXT   Supabase reads: the pin, its board, sibling pin titles, the
//                creator's niche, the tagged product, prior suggestions.
//   2. SUBJECT   A pure, instant read of what the pin is about, from its own
//                metadata. Produces the seed terms for the Trends lookup and
//                the vocabulary trend relevance is scored against. No network.
//   3. TRENDS    Those seeds are expanded against real Pinterest Trends search
//                data via Apify. Cached and shared across all users, since the
//                data is public and weekly.
//   4. PLAN      A deterministic ranker scores every candidate on relevance to
//                the pin FIRST, then volume and momentum, and picks one primary
//                keyword plus supporting and long-tail phrases.
//   5. COPY      ONE model call: the pin image plus that plan go to the proxy,
//                and a title/description comes back. Validated, mechanically
//                repaired, and retried once with feedback.
//   6. SCORE     A deterministic 0-100 pin-SEO score is recorded alongside.
//
// Exactly one paid call per pin, and only in stage 5. Stage 3 is the only other
// network hop and it is cache-first, shared between users, and free of charge
// on a hit. Everything else is local computation.
//
// No stage after (1) can fail the request: no trend data -> the pin's own
// vocabulary carries the plan; no model -> deterministic copy composed from the
// plan. The only way this throws is a Supabase failure or a pin the caller
// doesn't own.
//
// "Board" here is the `collections` table — that's what the rest of the app
// (import, health score, storefront) treats as a Pinterest board.

import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { isPlaceholderText } from "@/lib/health-score";
import { logNet } from "@/lib/net-logger";
import { createLimiter } from "@/lib/concurrency-limiter";
import { generateCopy } from "@/lib/openai-proxy.server";
import {
  fetchKeywordTrends,
  fetchTrendingNow,
  resolveTrendCountry,
  type TrendCountry,
  type TrendTerm,
} from "@/lib/pinterest-trends.server";
import { buildPinSubject, type PinSubject } from "@/lib/pin-subject";
import { buildKeywordPlan, type KeywordPlan } from "@/lib/pin-keywords";
import {
  composeFallback,
  pickAngle,
  repairSuggestion,
  scoreSuggestion,
  validateSuggestion,
  type PinSuggestionContext,
  type SeoAngle,
  type SuggestionCandidate,
} from "@/lib/pin-seo";

type Supabase = SupabaseClient<Database>;

// Module-level limiter bounds TOTAL in-flight model calls process-wide, not
// per request — see concurrency-limiter.ts for why the cap has to live here.
const copyLimit = createLimiter(2);

// Reuse a pending suggestion younger than this instead of re-running the
// pipeline. This is the single biggest cost saver in the system: revisiting a
// deck, a lookahead prefetch, and a double-tap all collapse onto one call.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// One initial attempt plus ONE feedback-driven retry. Mechanical failures are
// fixed for free by repairSuggestion, so a retry is only ever spent on a
// judgement miss — and a model that missed twice on judgement will miss a
// third time too, at full price. The deterministic composer covers the rest.
const MAX_COPY_ATTEMPTS = 2;

/* ---------------- Stage instrumentation ---------------- */

export type PipelineStage = {
  stage: "context" | "subject" | "trends" | "plan" | "copy" | "persist";
  ok: boolean;
  ms: number;
  /** How the stage resolved: "cached", "generated", "fallback", an error… */
  detail: string;
};

async function timed<T>(
  stages: PipelineStage[],
  stage: PipelineStage["stage"],
  fn: () => Promise<{ value: T; detail: string }>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const { value, detail } = await fn();
    stages.push({ stage, ok: true, ms: Date.now() - startedAt, detail });
    return value;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    stages.push({ stage, ok: false, ms: Date.now() - startedAt, detail });
    throw e;
  }
}

/* ---------------- Stage 1: context ---------------- */

function formatPrice(priceCents: number | null, currency: string | null): string | null {
  if (priceCents == null) return null;
  const amount = (priceCents / 100).toFixed(2).replace(/\.00$/, "");
  const symbols: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£" };
  const cur = currency ?? "USD";
  return `${symbols[cur] ?? `${cur} `}${amount}`;
}

export type PinContext = {
  pin: { id: string; title: string; description: string; imageUrl: string | null };
  board: { id: string; name: string } | null;
  siblingPinTitles: string[];
  niche: string | null;
  product: { name: string; category: string | null; priceLabel: string | null } | null;
  /** Drives which country's Pinterest Trends data we look up. */
  currency: string | null;
  rejectedSuggestions: Array<{ title: string; description: string }>;
  priorSuggestionCount: number;
};

/** Everything the pipeline needs from the database, in one round of parallel
 * reads through the caller's RLS-scoped client. */
export async function getPinContext(
  supabase: Supabase,
  userId: string,
  pinId: string,
): Promise<PinContext> {
  const { data: pin, error: pinErr } = await supabase
    .from("pins")
    .select("id, title, description, image_url, collection_id, origin_collection_id, product_id")
    .eq("id", pinId)
    .eq("user_id", userId)
    .maybeSingle();
  if (pinErr) throw new Error(pinErr.message);
  if (!pin) throw new Error("Pin not found");

  // A live pin sits in its own per-pin collection; origin_collection_id
  // remembers the real board it came from (see the 20260720120000 migration).
  const boardId = pin.origin_collection_id ?? pin.collection_id;

  const [boardRes, siblingsRes, storefrontRes, taggedProductRes, historyRes] = await Promise.all([
    boardId
      ? supabase.from("collections").select("id, name").eq("id", boardId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    boardId
      ? supabase
          .from("pins")
          .select("title")
          // Either link — a live sibling's collection_id points at its own
          // per-pin collection, not at the board (see boardIdOf).
          .or(`collection_id.eq.${boardId},origin_collection_id.eq.${boardId}`)
          .neq("id", pinId)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("storefronts").select("name, description").eq("user_id", userId).maybeSingle(),
    supabase
      .from("storefront_products")
      .select("title, price_cents, currency")
      .eq("pin_id", pinId)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle(),
    // `*` rather than a column list, deliberately.
    //
    // The analytics columns on this table are ADDITIVE — the migration that adds
    // them is explicitly safe to apply late, and the pipeline is supposed to
    // degrade rather than fail when it hasn't been. A star select returns
    // whatever exists and cannot 400 on absent additive columns.
    supabase
      .from("pin_suggestion_history")
      .select("*")
      .eq("pin_id", pinId)
      .order("created_at", { ascending: false }),
  ]);
  for (const res of [boardRes, siblingsRes, storefrontRes, taggedProductRes, historyRes]) {
    if (res.error) throw new Error(res.error.message);
  }

  // Fall back to the pin's directly-linked product when nothing is tagged via
  // storefront_products.pin_id.
  let product = taggedProductRes.data;
  if (!product && pin.product_id) {
    const { data, error } = await supabase
      .from("storefront_products")
      .select("title, price_cents, currency")
      .eq("id", pin.product_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    product = data;
  }

  const board = boardRes.data ? { id: boardRes.data.id, name: boardRes.data.name } : null;
  const storefront = storefrontRes.data;
  const history = historyRes.data ?? [];

  return {
    pin: {
      id: pin.id,
      title: pin.title ?? "",
      description: pin.description ?? "",
      imageUrl: pin.image_url,
    },
    board,
    siblingPinTitles: (siblingsRes.data ?? []).map((p) => p.title).filter((t) => t.trim() !== ""),
    niche: storefront
      ? [storefront.name, storefront.description].filter(Boolean).join(" — ") || null
      : null,
    product: product
      ? {
          name: product.title,
          // No product-category column exists; the board name is the closest
          // category signal we have.
          category: board?.name ?? null,
          priceLabel: formatPrice(product.price_cents, product.currency),
        }
      : null,
    currency: product?.currency ?? null,
    rejectedSuggestions: history
      .filter((h) => h.status === "rejected")
      .slice(0, 5)
      .map((h) => ({ title: h.suggested_title, description: h.suggested_description })),
    priorSuggestionCount: history.length,
  };
}

/** Context for a pin that does not exist yet.
 *
 * The create wizard asks for copy at step 2, before anything is written to the
 * database, so `getPinContext`'s reads — which all hang off a `pins` row — have
 * nothing to hang off. This assembles the same shape from what the wizard has
 * in hand (the uploaded image, whatever the creator has typed, the board they
 * picked) plus the board-level reads that don't need a pin: the board name,
 * its existing pin titles, and the creator's niche. Those three are what stop
 * a new pin's copy from reading like it belongs to nobody's board.
 *
 * The two fields with no pre-publish equivalent degrade honestly: `product` is
 * null because products are attached at step 3, and `rejectedSuggestions` is
 * empty because a pin with no id has no history. `variant` stands in for the
 * history count so a "Regenerate" tap rotates to the next angle.
 */
async function getDraftContext(
  supabase: Supabase,
  userId: string,
  input: {
    imageUrl: string;
    title: string;
    description: string;
    collectionId: string | null;
    variant: number;
  },
): Promise<PinContext> {
  const [boardRes, siblingsRes, storefrontRes, currencyRes] = await Promise.all([
    input.collectionId
      ? supabase
          .from("collections")
          .select("id, name")
          .eq("id", input.collectionId)
          .eq("user_id", userId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    input.collectionId
      ? supabase
          .from("pins")
          .select("title")
          .or(
            `collection_id.eq.${input.collectionId},origin_collection_id.eq.${input.collectionId}`,
          )
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("storefronts").select("name, description").eq("user_id", userId).maybeSingle(),
    // Which market's Trends data to read. The deck takes this from the pin's
    // tagged product; nothing is tagged yet here, so the creator's own catalogue
    // is the next best signal for where they sell.
    supabase
      .from("storefront_products")
      .select("currency")
      .eq("user_id", userId)
      .not("currency", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);
  for (const res of [boardRes, siblingsRes, storefrontRes, currencyRes]) {
    if (res.error) throw new Error(res.error.message);
  }

  const storefront = storefrontRes.data;

  return {
    // A synthetic id: nothing persists against it, and the one place the id is
    // read (the copy stage's failure logging) only needs something stable.
    pin: {
      id: `draft:${input.imageUrl}`,
      title: input.title,
      description: input.description,
      imageUrl: input.imageUrl,
    },
    board: boardRes.data ? { id: boardRes.data.id, name: boardRes.data.name } : null,
    siblingPinTitles: (siblingsRes.data ?? []).map((p) => p.title).filter((t) => t.trim() !== ""),
    niche: storefront
      ? [storefront.name, storefront.description].filter(Boolean).join(" — ") || null
      : null,
    product: null,
    currency: currencyRes.data?.currency ?? null,
    rejectedSuggestions: [],
    priorSuggestionCount: input.variant,
  };
}

/* ---------------- Stage 2: subject ---------------- */

/** What the pin is about, from metadata alone. Pure and instant, so there's no
 * cache table behind it — recomputing is cheaper than a round trip. */
function runSubjectStage(ctx: PinContext): PinSubject {
  return buildPinSubject({
    // Placeholder titles ("IMG_4821", "Untitled") are worse than nothing here:
    // they'd seed the Trends call with noise and pollute the relevance
    // vocabulary, which is what decides whether a trend term survives.
    pinTitle: isPlaceholderText(ctx.pin.title) ? null : ctx.pin.title,
    pinDescription: isPlaceholderText(ctx.pin.description) ? null : ctx.pin.description,
    boardName: ctx.board?.name ?? null,
    productName: ctx.product?.name ?? null,
    productCategory: ctx.product?.category ?? null,
    niche: ctx.niche,
  });
}

/* ---------------- Stage 3: trends ---------------- */

type TrendStageResult = {
  terms: TrendTerm[];
  trendingNow: TrendTerm[];
  country: TrendCountry;
  cachedSeeds: string[];
  fetchedSeeds: string[];
  detail: string;
};

async function runTrendsStage(
  supabase: Supabase,
  subject: PinSubject,
  ctx: PinContext,
  /** Started before this stage — country-wide trending depends only on the
   * market, not on the pin, so waiting for anything else was dead time. */
  trendingNowPromise: Promise<TrendTerm[]>,
): Promise<TrendStageResult> {
  const country = resolveTrendCountry(ctx.currency);
  // Seeds are the scarce resource: each miss is an Apify run. The subject
  // builder already ordered them best-first and dropped duplicates.
  const seeds = subject.seedTerms.filter((s) => s.trim().length >= 3);

  // Both are independently cached and independently failure-tolerant.
  const [keywordResult, trendingNow] = await Promise.all([
    seeds.length > 0
      ? fetchKeywordTrends(supabase, seeds, country)
      : Promise.resolve({ terms: [], cachedSeeds: [], fetchedSeeds: [], ok: false }),
    trendingNowPromise,
  ]);

  return {
    terms: keywordResult.terms,
    trendingNow,
    country,
    cachedSeeds: keywordResult.cachedSeeds,
    fetchedSeeds: keywordResult.fetchedSeeds,
    detail:
      seeds.length === 0
        ? "skipped — no usable seed terms in this pin's metadata"
        : keywordResult.ok
          ? `${keywordResult.terms.length} terms (${keywordResult.cachedSeeds.length} cached / ${keywordResult.fetchedSeeds.length} fetched)`
          : "no trend data — using the pin's own vocabulary",
  };
}

/* ---------------- Stages 4+5: plan → copy ---------------- */

function buildPlan(subject: PinSubject, trends: TrendStageResult, ctx: PinContext): KeywordPlan {
  return buildKeywordPlan({
    subject,
    trends: trends.terms,
    trendingNow: trends.trendingNow,
    productName: ctx.product?.name ?? null,
    boardName: ctx.board?.name ?? null,
    pinTitle: ctx.pin.title,
    niche: ctx.niche,
    country: trends.country,
  });
}

type CopyStageResult = {
  candidate: SuggestionCandidate;
  issues: string[];
  attempts: number;
  model: string | null;
  /** False when there was no image, or the model told us it couldn't read one. */
  sawImage: boolean;
  detail: string;
};

/** The model's own report of what the image shows, when it read one. Stored so
 * the NEXT generation for this pin can seed its keyword plan from the picture
 * instead of from metadata. */
function observedSubjectOf(candidate: SuggestionCandidate): string | null {
  return candidate.imageSubject?.trim() || null;
}

/** Generate → repair → validate, retrying once with explicit feedback. Never
 * throws: if both attempts fail or the proxy is unreachable, the deterministic
 * composer produces keyword-correct copy from the plan alone. */
async function runCopyStage(context: PinSuggestionContext): Promise<CopyStageResult> {
  const validationInput = {
    plan: context.plan,
    rejectedSuggestions: context.rejectedSuggestions,
    siblingPinTitles: context.siblingPinTitles,
  };

  let best: { candidate: SuggestionCandidate; issues: string[] } | null = null;
  let model: string | null = null;
  let sawImage = false;
  let feedback: string[] = [];
  let lastError: string | null = null;
  let attempt = 0;
  // Learned once per pin, not once per attempt: re-attempting a vision request
  // for an image we already know can't be downloaded is a paid call with a
  // guaranteed 400 at the end of it.
  let skipImage = false;

  for (attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt++) {
    let candidate: SuggestionCandidate;
    try {
      const result = await copyLimit(() =>
        generateCopy(
          context,
          attempt > 1 ? { issues: feedback, attempt: attempt - 1 } : undefined,
          { skipImage },
        ),
      );
      candidate = result.candidate;
      model = result.model;
      sawImage = result.sawImage;
      if (result.imageUnfetchable) skipImage = true;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logNet("copy.failed", { pinId: context.pin.id, attempt, error: lastError });
      // The proxy client already retried the transient classes and re-prompted
      // for malformed JSON, so another identical roll won't help — go straight
      // to the deterministic fallback.
      break;
    }

    // Repair runs UNCONDITIONALLY, before validation.
    //
    // It only makes judgement-free mechanical fixes and is documented to return
    // copy no worse than its input, so there's no reason to withhold it from
    // copy that happens to pass. Gating it behind a validation failure meant
    // otherwise-clean output kept its cosmetic flaws: a model that lowercases
    // the opening word to match a keyword ("iceland travel guide to Milky-Blue
    // Geothermal Hot Springs") validated clean and shipped exactly like that.
    const repaired = repairSuggestion(candidate, context);
    const repairedIssues = validateSuggestion(repaired, validationInput);
    if (repairedIssues.length === 0) {
      const touched =
        repaired.title !== candidate.title || repaired.description !== candidate.description;
      return {
        candidate: repaired,
        issues: [],
        attempts: attempt,
        model,
        sawImage,
        detail: touched ? "repaired" : "clean",
      };
    }

    // Feed back what the MODEL got wrong, not what survived repair, so it learns
    // the real miss rather than the residue.
    const rawIssues = validateSuggestion(candidate, validationInput);

    if (!best || repairedIssues.length < best.issues.length) {
      best = { candidate: repaired, issues: repairedIssues };
    }
    feedback = rawIssues;
  }

  if (best) {
    const used = Math.min(attempt, MAX_COPY_ATTEMPTS);
    return {
      candidate: best.candidate,
      issues: best.issues,
      attempts: used,
      model,
      sawImage,
      detail: `best-effort after ${used} attempt${used === 1 ? "" : "s"}`,
    };
  }

  const fallback = composeFallback(context);
  return {
    candidate: fallback,
    issues: validateSuggestion(fallback, validationInput),
    attempts: attempt - 1,
    model: null,
    sawImage: false,
    detail: `deterministic fallback${lastError ? `: ${lastError.slice(0, 120)}` : ""}`,
  };
}

/* ---------------- Persistence ---------------- */

/** True for "that column doesn't exist" — i.e. the latest migration hasn't been
 * applied yet. The suggestion still saves; it just loses the extra analytics
 * columns rather than failing the whole pipeline. */
function isUnknownColumn(error: PostgrestError): boolean {
  return (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    /column .* does not exist|could not find the .* column/i.test(error.message)
  );
}

type SuggestionRow = {
  pin_id: string;
  user_id: string;
  suggested_title: string;
  suggested_description: string;
  angle: string;
  status: string;
};

type SuggestionExtras = {
  primary_keyword: string;
  keywords: unknown;
  seo_score: number;
  issues: unknown;
  model: string | null;
};

/**
 * Insert the suggestion with the analytics columns the live pipeline actually
 * uses. Do not try removed history layers first: on databases without those
 * columns they only cause noisy schema-cache misses before doing the same write
 * this function now does directly.
 */
async function insertSuggestion(
  supabase: Supabase,
  row: SuggestionRow,
  extras: SuggestionExtras,
): Promise<string> {
  // The cast keeps the generated Database types authoritative for the base row
  // while tolerating a pre-migration schema at runtime.
  const rich = await supabase
    .from("pin_suggestion_history")
    .insert({ ...row, ...extras } as never)
    .select("id")
    .single();
  if (!rich.error) return rich.data.id;
  if (!isUnknownColumn(rich.error)) throw new Error(rich.error.message);

  const base = await supabase.from("pin_suggestion_history").insert(row).select("id").single();
  if (base.error) throw new Error(base.error.message);
  return base.data.id;
}

/* ---------------- Result shape ---------------- */

export type KeywordSummary = {
  primary: string;
  secondary: string[];
  longTail: string[];
  /** Best-ranked candidates with their real Pinterest demand, for the UI. */
  ranked: Array<{
    term: string;
    score: number;
    volume: number | null;
    trend: string | null;
    rising: boolean;
  }>;
  country: string;
  hasTrendData: boolean;
  asOf: string | null;
};

export type SuggestSeoResult = {
  pinId: string;
  suggestionId: string;
  title: string;
  description: string;
  angle_used: SeoAngle | null;
  /** 'pending' = ready to swipe; 'needs_review' = still has open issues. */
  status: "pending" | "needs_review";
  /** True when a <24h-old pending suggestion was returned without re-running. */
  reused: boolean;
  /** Deterministic 0–100 pin-SEO score for this exact copy. */
  seoScore: number;
  seoBreakdown: ReturnType<typeof scoreSuggestion>["breakdown"] | null;
  /**
   * The SAME 0-100 score applied to the pin's EXISTING title/description.
   *
   * The deck offers a rewrite for every pin, including ones that already pass
   * the health check, so "is this actually better?" stops being obvious.
   * Scoring the current copy against the identical keyword plan makes the
   * comparison honest and lets the UI refuse to sell a downgrade.
   */
  currentScore: number;
  keywords: KeywordSummary | null;
  /**
   * Whether the copy was written from the pin's image.
   *
   * False means the model never read it — no image on the pin, or the upstream
   * model isn't vision-capable — and the copy is therefore grounded in the
   * pin's metadata and trend data only. Surfaced rather than hidden because
   * "written from your image" and "written from your board name" are very
   * different claims to make to a creator.
   */
  sawImage: boolean;
  /**
   * What the model reported seeing in the image, in its own words. Null when no
   * image was read. Doubles as the evidence behind a mismatch warning — "your
   * board says weeknight dinners; this image shows a geothermal spa".
   */
  imageSubject: string | null;
  /**
   * False when the model judged that the target keywords don't describe this
   * image.
   *
   * The suggestion is still returned, but lands in 'needs_review': the keyword
   * plan is built from board and pin metadata before anything sees the picture,
   * so when the two disagree every mechanical check still passes while the copy
   * is about the wrong subject entirely.
   */
  keywordsFitImage: boolean;
  /** Validation issues still open — empty for a 'pending' suggestion. */
  issues: string[];
  /** Per-stage timings and outcomes, for debugging a bad suggestion. */
  stages: PipelineStage[];
};

function summarizePlan(plan: KeywordPlan): KeywordSummary {
  return {
    primary: plan.primary,
    secondary: plan.secondary,
    longTail: plan.longTail,
    ranked: plan.ranked.slice(0, 12).map((k) => ({
      term: k.term,
      score: k.score,
      volume: k.volume,
      trend: k.trend,
      rising: k.rising,
    })),
    country: plan.country,
    hasTrendData: plan.hasTrendData,
    asOf: plan.asOf,
  };
}

/* ---------------- Pipeline core ---------------- */

/** Stages 2-6: subject → trends → plan → copy → score.
 *
 * Split out of `runSuggestionPipeline` because the create-pin wizard needs
 * exactly these stages and structurally cannot have the two either side of
 * them: there is no pin row yet, so stage 1 has nothing to read and the
 * persist has no `pin_id` to satisfy its foreign key. Everything that decides
 * what the copy SAYS lives in here, so the draft path is not a cheaper
 * imitation of the deck's pipeline — it is the same code with the two
 * database-bound ends removed.
 *
 * `angleSeed` is what `pickAngle` hashes to choose a framing: the deck passes
 * the pin id, the draft path passes the image URL, so re-drafting the same
 * image is stable while different images spread across the five angles.
 */
async function runCopyPipeline(
  supabase: Supabase,
  ctx: PinContext,
  angleSeed: string,
  stages: PipelineStage[],
) {
  // Country-wide trending needs only the market, so it starts here and is
  // awaited inside the trends stage. `fetchTrendingNow` never rejects.
  const trendingNowPromise = fetchTrendingNow(supabase, resolveTrendCountry(ctx.currency));

  /* 2 — subject */
  const subject = await timed(stages, "subject", async () => {
    const s = runSubjectStage(ctx);
    return {
      value: s,
      detail: s.seedTerms.length > 0 ? `seeds: ${s.seedTerms.join(", ")}` : "no usable metadata",
    };
  });

  /* 3 — trends */
  const trends = await timed(stages, "trends", async () => {
    const r = await runTrendsStage(supabase, subject, ctx, trendingNowPromise);
    return { value: r, detail: r.detail };
  });

  /* 4 — plan */
  const plan = await timed(stages, "plan", async () => {
    const p = buildPlan(subject, trends, ctx);
    return {
      value: p,
      detail: `primary="${p.primary}" +${p.secondary.length} supporting +${p.longTail.length} long-tail, ${p.discarded.length} off-topic dropped`,
    };
  });

  // Salting the angle with the prior-suggestion count both spreads the five
  // framings across a batch (different seeds hash apart) and guarantees a
  // regenerate-after-reject tries the next framing, not the same one again.
  const angle = pickAngle(angleSeed, ctx.priorSuggestionCount);
  const context: PinSuggestionContext = {
    pin: ctx.pin,
    board: ctx.board,
    siblingPinTitles: ctx.siblingPinTitles,
    niche: ctx.niche,
    product: ctx.product,
    rejectedSuggestions: ctx.rejectedSuggestions,
    angle,
    subject,
    plan,
  };

  /* 5 — copy: the one paid call */
  const copy = await timed(stages, "copy", async () => {
    const r = await runCopyStage(context);
    return {
      value: r,
      detail: `${r.detail} (${r.attempts} attempt${r.attempts === 1 ? "" : "s"}, image ${r.sawImage ? "read" : "not read"})`,
    };
  });

  /* 6 — score */
  const score = scoreSuggestion(copy.candidate, plan);
  // Baseline: what the pin scores as it stands today, judged against the very
  // same plan, so the two numbers are comparable.
  const currentScore = scoreSuggestion(
    { title: ctx.pin.title, description: ctx.pin.description },
    plan,
  );

  return {
    subject,
    trends,
    plan,
    angle,
    copy,
    score,
    currentScore,
    summary: summarizePlan(plan),
    status: (copy.issues.length > 0 ? "needs_review" : "pending") as SuggestSeoResult["status"],
  };
}

/* ---------------- The pipeline ---------------- */

async function runSuggestionPipeline(
  supabase: Supabase,
  userId: string,
  pinId: string,
  opts: { force?: boolean } = {},
): Promise<SuggestSeoResult> {
  const stages: PipelineStage[] = [];
  const startedAt = Date.now();

  // Dedup: an unanswered suggestion from the last 24h is returned as-is, for
  // zero model spend. This is checked before anything else for that reason.
  if (!opts.force) {
    const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: recent, error: recentErr } = await supabase
      .from("pin_suggestion_history")
      .select("id, suggested_title, suggested_description, angle")
      .eq("pin_id", pinId)
      .eq("status", "pending")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentErr) throw new Error(recentErr.message);
    if (recent) {
      // Star select for the same reason as getPinContext: naming an additive
      // column makes the whole read 400 on a schema that predates it. With `*`
      // each field is simply present or absent, so a database missing only the
      // newest columns still serves the ones it does have — the reuse path keeps
      // showing a real score instead of falling back to zero.
      const enriched = await supabase
        .from("pin_suggestion_history")
        .select("*")
        .eq("id", recent.id)
        .maybeSingle();
      const extra = (enriched.error ? null : enriched.data) as Partial<{
        keywords: KeywordSummary | null;
        seo_score: number | null;
        issues: string[] | null;
      }> | null;

      return {
        pinId,
        suggestionId: recent.id,
        title: recent.suggested_title,
        description: recent.suggested_description,
        angle_used: (recent.angle as SeoAngle | null) ?? null,
        status: "pending",
        reused: true,
        seoScore: extra?.seo_score ?? 0,
        seoBreakdown: null,
        currentScore: 0,
        keywords: extra?.keywords ?? null,
        imageSubject: null,
        keywordsFitImage: true,
        sawImage: false,
        issues: extra?.issues ?? [],
        stages: [{ stage: "context", ok: true, ms: Date.now() - startedAt, detail: "reused" }],
      };
    }
  }

  /* 1 — context */
  const ctx = await timed(stages, "context", async () => ({
    value: await getPinContext(supabase, userId, pinId),
    detail: "loaded",
  }));

  /* 2-6 — subject, trends, plan, copy, score */
  const { plan, angle, copy, score, currentScore, summary, status, trends } = await runCopyPipeline(
    supabase,
    ctx,
    pinId,
    stages,
  );

  /* 7 — persist */
  const suggestionId = await timed(stages, "persist", async () => ({
    value: await insertSuggestion(
      supabase,
      {
        pin_id: pinId,
        user_id: userId,
        suggested_title: copy.candidate.title,
        suggested_description: copy.candidate.description,
        angle,
        status,
      },
      {
        primary_keyword: plan.primary,
        keywords: summary,
        seo_score: score.total,
        issues: copy.issues,
        model: copy.model,
      },
    ),
    detail: status,
  }));

  logNet("pin_seo.done", {
    pinId,
    status,
    score: score.total,
    primary: plan.primary,
    trendTerms: trends.terms.length,
    sawImage: copy.sawImage,
    durationMs: Date.now() - startedAt,
  });

  return {
    pinId,
    suggestionId,
    title: copy.candidate.title,
    description: copy.candidate.description,
    angle_used: angle,
    status,
    reused: false,
    seoScore: score.total,
    seoBreakdown: score.breakdown,
    currentScore: currentScore.total,
    keywords: summary,
    imageSubject: observedSubjectOf(copy.candidate),
    keywordsFitImage: copy.candidate.fitsKeywords !== false,
    sawImage: copy.sawImage,
    issues: copy.issues,
    stages,
  };
}

/* ---------------- Server functions ---------------- */

/** POST — run the full pipeline for one pin. `force` skips the 24h dedup
 * window, for an explicit "regenerate". */
export const suggestPinSeo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { pinId: string; force?: boolean }) =>
    z.object({ pinId: z.string().uuid(), force: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    return runSuggestionPipeline(supabase, userId, data.pinId, { force: data.force });
  });

/** What a draft run returns. Deliberately a near-subset of `SuggestSeoResult`
 * rather than its own shape — the two paths run the same stages, so the fields
 * that survive without a pin row keep their exact names and meanings. Gone:
 * `pinId`/`suggestionId`/`reused`, all three of which only exist because the
 * deck persists and de-duplicates. */
export type DraftSeoResult = {
  title: string;
  description: string;
  angle_used: SeoAngle | null;
  status: "pending" | "needs_review";
  seoScore: number;
  seoBreakdown: ReturnType<typeof scoreSuggestion>["breakdown"] | null;
  /** The same score applied to whatever the creator has typed so far, so the UI
   * can decline to push a rewrite that is worse than their own words. */
  currentScore: number;
  keywords: KeywordSummary | null;
  sawImage: boolean;
  imageSubject: string | null;
  keywordsFitImage: boolean;
  issues: string[];
  stages: PipelineStage[];
};

/** POST — real SEO copy for a pin that hasn't been created yet.
 *
 * Same six stages as `suggestPinSeo`, minus the two that need a `pins` row:
 * there is no 24h dedup (nothing to dedup against) and no persist (no id to
 * write). The client is expected to call this on demand, not on every
 * keystroke — it costs one model call, exactly like the deck.
 */
export const draftPinSeo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: {
      imageUrl: string;
      title?: string;
      description?: string;
      collectionId?: string;
      variant?: number;
    }) =>
      z
        .object({
          imageUrl: z.string().url(),
          title: z.string().max(500).optional(),
          description: z.string().max(2000).optional(),
          collectionId: z.string().uuid().optional(),
          // Rotates the angle on a regenerate. Capped so a client cannot drive
          // an unbounded value into the angle hash.
          variant: z.number().int().min(0).max(50).optional(),
        })
        .parse(d),
  )
  .handler(async ({ context, data }): Promise<DraftSeoResult> => {
    const { supabase, userId } = context;
    const stages: PipelineStage[] = [];
    const startedAt = Date.now();

    const ctx = await timed(stages, "context", async () => ({
      value: await getDraftContext(supabase, userId, {
        imageUrl: data.imageUrl,
        title: data.title ?? "",
        description: data.description ?? "",
        collectionId: data.collectionId ?? null,
        variant: data.variant ?? 0,
      }),
      detail: "draft",
    }));

    const { plan, angle, copy, score, currentScore, summary, status, trends } =
      await runCopyPipeline(supabase, ctx, data.imageUrl, stages);

    logNet("pin_seo.draft", {
      status,
      score: score.total,
      primary: plan.primary,
      trendTerms: trends.terms.length,
      sawImage: copy.sawImage,
      durationMs: Date.now() - startedAt,
    });

    return {
      title: copy.candidate.title,
      description: copy.candidate.description,
      angle_used: angle,
      status,
      seoScore: score.total,
      seoBreakdown: score.breakdown,
      currentScore: currentScore.total,
      keywords: summary,
      sawImage: copy.sawImage,
      imageSubject: observedSubjectOf(copy.candidate),
      keywordsFitImage: copy.candidate.fitsKeywords !== false,
      issues: copy.issues,
      stages,
    };
  });

/** POST — record the creator's decision on a suggestion.
 *
 * The pin's own title/description are written by the deck's optimistic apply
 * path; this only moves the history row out of 'pending'. That matters for two
 * reasons beyond bookkeeping: a resolved row no longer satisfies the 24h dedup
 * lookup (so a later regenerate is honoured), and rejected phrasings feed the
 * "avoid these" list on the next generation, which is what stops a regenerate
 * from returning a near-identical rewrite.
 */
export const resolvePinSeoSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { suggestionId: string; decision: "approved" | "rejected" }) =>
    z
      .object({
        suggestionId: z.string().uuid(),
        decision: z.enum(["approved", "rejected"]),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    const { data: updated, error } = await supabase
      .from("pin_suggestion_history")
      .update({ status: data.decision })
      .eq("id", data.suggestionId)
      .eq("user_id", userId)
      .select("pin_id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("Suggestion not found");

    return { pinId: updated.pin_id, status: data.decision };
  });
