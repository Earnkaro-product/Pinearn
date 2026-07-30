// Stage 2 of the pin SEO pipeline — real Pinterest search demand.
//
// Wraps the free "Pinterest Trends & Keyword Scraper" Apify actor
// (DysWRZsZMUiSDvHoU), which reads trends.pinterest.com directly. Two modes:
//   keyword   — expand seed terms into the related searches Pinterest itself
//               surfaces, each with search volume, trend direction and a
//               52-week history.
//   trending  — the top searches in a country right now (seasonal backdrop).
//
// Two properties this module guarantees, because the SEO pipeline depends on
// them:
//   1. It NEVER throws. Every failure path — missing token, actor error,
//      timeout, malformed payload, absent cache table — returns empty data and
//      logs. Trends are an enrichment signal; losing them must degrade the
//      suggestion, not fail the pin.
//   2. It is aggressively cached in a SHARED table. Pinterest Trends data is
//      public and identical for every user in a country, and only refreshes
//      weekly, so the second creator to analyze a blazer pin pays nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { logNet } from "@/lib/net-logger";
import { createLimiter } from "@/lib/concurrency-limiter";

type Supabase = SupabaseClient<Database>;

const ACTOR_ID = "DysWRZsZMUiSDvHoU";
const APIFY_BASE = "https://api.apify.com/v2";

// Serializes Apify runs process-wide. The actor is free but Pinterest
// rate-limits ~57 requests per window per IP and the actor auto-paces when it
// hits that; overlapping runs from our side would just push it into pacing.
const apifyLimit = createLimiter(1);

// Actor-side run budget, and our own client-side ceiling a little above it so
// a wedged connection can't hold a request open indefinitely. A 3-seed
// expansion measures ~5s, so 90s is generous headroom, not a normal wait.
const ACTOR_TIMEOUT_SECS = 90;
const CLIENT_TIMEOUT_MS = 100_000;
const ACTOR_MEMORY_MB = 1024;

// Pinterest publishes Trends weekly (`asOf`), so a 7-day TTL never serves data
// from a different snapshot than a live call would return. Country-wide
// trending shifts faster and is cheap, so it refreshes daily.
const KEYWORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRENDING_TTL_MS = 24 * 60 * 60 * 1000;

// Pinterest only publishes Trends for these markets; anything else falls back
// to US, which is the largest corpus and the best generic proxy.
export const TREND_COUNTRIES = [
  "US",
  "GB",
  "CA",
  "DE",
  "FR",
  "IT",
  "ES",
  "BR",
  "MX",
  "AR",
  "IN",
] as const;
export type TrendCountry = (typeof TREND_COUNTRIES)[number];
export const DEFAULT_TREND_COUNTRY: TrendCountry = "US";

const CURRENCY_TO_COUNTRY: Record<string, TrendCountry> = {
  USD: "US",
  GBP: "GB",
  CAD: "CA",
  EUR: "DE",
  BRL: "BR",
  MXN: "MX",
  ARS: "AR",
  INR: "IN",
};

/** Best guess at which market's search data to use, from whatever locale
 * signal the pin carries. Unsupported currencies fall back to US. */
export function resolveTrendCountry(currency?: string | null): TrendCountry {
  const explicit = (process.env.PINTEREST_TRENDS_COUNTRY ?? "").toUpperCase();
  if ((TREND_COUNTRIES as readonly string[]).includes(explicit)) return explicit as TrendCountry;
  const mapped = currency ? CURRENCY_TO_COUNTRY[currency.toUpperCase()] : undefined;
  return mapped ?? DEFAULT_TREND_COUNTRY;
}

/* ---------------- Shape ---------------- */

export type TrendDirection = "rising" | "falling" | "flat";

export type TrendTerm = {
  term: string;
  /** Which seed produced it; null for country-wide trending terms. */
  seed: string | null;
  /** 0–100 relative Pinterest search interest. */
  searchVolume: number;
  peakVolume: number;
  avgVolume: number;
  trend: TrendDirection;
  /** Percent change week over week. */
  weekChange: number;
  /** Pinterest's own "about to take off" flag. */
  predictedRising: boolean;
  /**
   * Derived from the 52-week series: mean of the last 4 weeks over the mean of
   * the 8 before them. >1 means demand is building right now. 1 when there
   * isn't enough history to tell. This is what separates a keyword that's
   * genuinely heating up from one with a noisy single-week spike.
   */
  recentMomentum: number;
  /** 0–1 seasonality, trending mode only. */
  seasonality: number | null;
  country: string;
  /** Pinterest's data snapshot date, e.g. "2026-07-21". */
  asOf: string | null;
};

/* ---------------- Actor payload parsing ---------------- */

type RawItem = Record<string, unknown>;

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function direction(value: unknown): TrendDirection {
  return value === "rising" || value === "falling" ? value : "flat";
}

/** Mean of the last `count` weekly counts, or null when the series is too
 * short to be meaningful. */
function tailMean(series: Array<{ count: number }>, from: number, to: number): number | null {
  const slice = series.slice(from, to);
  if (slice.length === 0) return null;
  return slice.reduce((sum, p) => sum + p.count, 0) / slice.length;
}

function recentMomentum(raw: unknown): number {
  if (!Array.isArray(raw) || raw.length < 12) return 1;
  const series = raw
    .map((p) => ({ count: num((p as RawItem)?.count, NaN) }))
    .filter((p) => Number.isFinite(p.count));
  if (series.length < 12) return 1;
  // Newest week is last in the actor's output.
  const last4 = tailMean(series, series.length - 4, series.length);
  const prev8 = tailMean(series, series.length - 12, series.length - 4);
  if (last4 == null || prev8 == null || prev8 <= 0) return 1;
  // Clamped: a term coming off a near-zero base would otherwise produce an
  // absurd ratio and dominate the ranking on noise alone.
  return Math.min(3, Math.max(0.25, last4 / prev8));
}

/** Pinterest emits curly apostrophes ("men’s hairstyles"). Everything
 * downstream matches keywords verbatim against LLM-written copy, which uses
 * straight ones — so normalize at the boundary, once. */
function normalizeTerm(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim().toLowerCase()
    : "";
}

function toTrendTerm(item: RawItem, country: string): TrendTerm | null {
  const term = normalizeTerm(item.term);
  if (!term) return null;
  const seedRaw = normalizeTerm(item.seed);
  const searchVolume = num(item.searchVolume);
  return {
    term,
    seed: seedRaw || null,
    searchVolume,
    peakVolume: num(item.peakVolume, searchVolume),
    avgVolume: num(item.avgVolume, searchVolume),
    trend: direction(item.trend),
    weekChange: num(item.weekChange),
    predictedRising: item.predictedRising === true,
    recentMomentum: recentMomentum(item.weeklySeries),
    seasonality: item.seasonality == null ? null : num(item.seasonality),
    country: typeof item.country === "string" ? item.country : country,
    asOf: typeof item.asOf === "string" ? item.asOf : null,
  };
}

/* ---------------- Actor call ---------------- */

type ActorInput = {
  mode: "keyword" | "trending";
  country: string;
  terms?: string[];
  numTerms?: number;
  proxyConfiguration: { useApifyProxy: boolean };
};

/** One run-sync call. Returns null (never throws) on any failure so callers
 * can distinguish "no data" from "cache miss". */
async function runActor(input: ActorInput): Promise<TrendTerm[] | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    logNet("trends.skipped", { reason: "APIFY_TOKEN not set" });
    return null;
  }

  const url =
    `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${ACTOR_TIMEOUT_SECS}&memory=${ACTOR_MEMORY_MB}`;
  const startedAt = Date.now();

  try {
    const res = await apifyLimit(() =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      }),
    );

    if (!res.ok) {
      logNet("trends.http_error", {
        mode: input.mode,
        status: res.status,
        durationMs: Date.now() - startedAt,
        body: (await res.text().catch(() => "")).slice(0, 200),
      });
      return null;
    }

    const payload: unknown = await res.json();
    if (!Array.isArray(payload)) {
      logNet("trends.bad_payload", { mode: input.mode, type: typeof payload });
      return null;
    }

    const terms = payload
      .map((item) => toTrendTerm((item ?? {}) as RawItem, input.country))
      .filter((t): t is TrendTerm => t !== null);

    logNet("trends.ok", {
      mode: input.mode,
      country: input.country,
      seeds: input.terms?.length ?? 0,
      terms: terms.length,
      durationMs: Date.now() - startedAt,
    });
    return terms;
  } catch (e) {
    logNet("trends.failed", {
      mode: input.mode,
      durationMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/* ---------------- Shared cache ---------------- */

// Every cache operation is best-effort: if the pinterest_trend_cache table
// doesn't exist yet (migration not applied) or RLS rejects the write, we log
// once and carry on with a live call. Caching must never be load-bearing.

type CacheRow = { cache_key: string; terms: unknown; as_of: string | null; fetched_at: string };

function keywordCacheKey(country: string, seed: string): string {
  return `keyword:${country}:${seed}`;
}

function trendingCacheKey(country: string): string {
  return `trending:${country}`;
}

function isFresh(fetchedAt: string, ttlMs: number): boolean {
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) && Date.now() - t < ttlMs;
}

async function readCache(
  supabase: Supabase,
  keys: string[],
  ttlMs: number,
): Promise<Map<string, TrendTerm[]>> {
  const hits = new Map<string, TrendTerm[]>();
  if (keys.length === 0) return hits;
  try {
    const { data, error } = await supabase
      .from("pinterest_trend_cache")
      .select("cache_key, terms, as_of, fetched_at")
      .in("cache_key", keys);
    if (error) {
      logNet("trends.cache_read_failed", { error: error.message });
      return hits;
    }
    for (const row of (data ?? []) as CacheRow[]) {
      if (!isFresh(row.fetched_at, ttlMs)) continue;
      if (Array.isArray(row.terms)) hits.set(row.cache_key, row.terms as TrendTerm[]);
    }
  } catch (e) {
    logNet("trends.cache_read_failed", { error: e instanceof Error ? e.message : String(e) });
  }
  return hits;
}

async function writeCache(
  supabase: Supabase,
  rows: Array<{
    cache_key: string;
    mode: "keyword" | "trending";
    country: string;
    seed: string | null;
    terms: TrendTerm[];
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const { error } = await supabase.from("pinterest_trend_cache").upsert(
      rows.map((r) => ({
        ...r,
        terms:
          r.terms as unknown as Database["public"]["Tables"]["pinterest_trend_cache"]["Insert"]["terms"],
        as_of: r.terms[0]?.asOf ?? null,
        fetched_at: new Date().toISOString(),
      })),
      { onConflict: "cache_key" },
    );
    if (error) logNet("trends.cache_write_failed", { error: error.message });
  } catch (e) {
    logNet("trends.cache_write_failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

/* ---------------- Public API ---------------- */

function normalizeSeed(seed: string): string {
  return seed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join(" ");
}

/** Apify's own guidance: a handful of seeds returns instantly, 40+ auto-paces.
 * Five is well inside the fast path and already yields ~25 candidate terms. */
const MAX_SEEDS_PER_RUN = 5;

export type KeywordTrendResult = {
  terms: TrendTerm[];
  /** Seeds served from the shared cache vs. expanded live this call. */
  cachedSeeds: string[];
  fetchedSeeds: string[];
  /** True when at least one seed produced data. */
  ok: boolean;
};

/** Expand seed terms into Pinterest's own related searches with volume and
 * momentum. Cache-first, per seed, so a partial cache hit only pays for the
 * seeds it's actually missing. */
export async function fetchKeywordTrends(
  supabase: Supabase,
  rawSeeds: string[],
  country: TrendCountry,
): Promise<KeywordTrendResult> {
  const seeds = Array.from(new Set(rawSeeds.map(normalizeSeed).filter((s) => s.length >= 3))).slice(
    0,
    MAX_SEEDS_PER_RUN,
  );
  if (seeds.length === 0) return { terms: [], cachedSeeds: [], fetchedSeeds: [], ok: false };

  const cache = await readCache(
    supabase,
    seeds.map((s) => keywordCacheKey(country, s)),
    KEYWORD_TTL_MS,
  );

  const terms: TrendTerm[] = [];
  const cachedSeeds: string[] = [];
  const missing: string[] = [];
  for (const seed of seeds) {
    const hit = cache.get(keywordCacheKey(country, seed));
    if (hit) {
      cachedSeeds.push(seed);
      terms.push(...hit);
    } else {
      missing.push(seed);
    }
  }

  const fetchedSeeds: string[] = [];
  if (missing.length > 0) {
    const fresh = await runActor({
      mode: "keyword",
      country,
      terms: missing,
      proxyConfiguration: { useApifyProxy: false },
    });
    if (fresh) {
      // Group by the seed the actor echoes back, so each seed caches
      // independently and an unrelated seed's miss doesn't invalidate the rest.
      const bySeed = new Map<string, TrendTerm[]>();
      for (const seed of missing) bySeed.set(seed, []);
      for (const t of fresh) {
        const bucket = t.seed && bySeed.has(t.seed) ? t.seed : missing[0];
        bySeed.get(bucket)?.push(t);
      }
      for (const [seed, seedTerms] of bySeed) {
        fetchedSeeds.push(seed);
        terms.push(...seedTerms);
      }
      await writeCache(
        supabase,
        [...bySeed].map(([seed, seedTerms]) => ({
          cache_key: keywordCacheKey(country, seed),
          mode: "keyword" as const,
          country,
          seed,
          terms: seedTerms,
        })),
      );
    }
  }

  // The same term is commonly surfaced by several seeds — keep the highest
  // volume reading so one seed's stale echo can't understate demand.
  const byTerm = new Map<string, TrendTerm>();
  for (const t of terms) {
    const existing = byTerm.get(t.term);
    if (!existing || t.searchVolume > existing.searchVolume) byTerm.set(t.term, t);
  }

  return {
    terms: [...byTerm.values()],
    cachedSeeds,
    fetchedSeeds,
    ok: byTerm.size > 0,
  };
}

/** Country-wide trending searches — the seasonal backdrop, used only to break
 * ties between otherwise equally good keywords. Refreshed daily, shared. */
export async function fetchTrendingNow(
  supabase: Supabase,
  country: TrendCountry,
  numTerms = 25,
): Promise<TrendTerm[]> {
  const key = trendingCacheKey(country);
  const cache = await readCache(supabase, [key], TRENDING_TTL_MS);
  const hit = cache.get(key);
  if (hit) return hit;

  const fresh = await runActor({
    mode: "trending",
    country,
    numTerms,
    proxyConfiguration: { useApifyProxy: false },
  });
  if (!fresh) return [];

  await writeCache(supabase, [
    { cache_key: key, mode: "trending", country, seed: null, terms: fresh },
  ]);
  return fresh;
}
