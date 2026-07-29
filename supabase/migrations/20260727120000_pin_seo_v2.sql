-- Pin SEO pipeline v2 — Pinterest Trends keyword grounding + richer suggestion
-- records.
--
-- Every object here is a pure optimization or an analytics column: the pipeline
-- reads/writes them best-effort and degrades to a live call (or to no trend
-- data at all) if any of it is missing, so applying this migration late never
-- breaks a running deployment.
--
-- Fully idempotent — safe to re-run against a database that already has an
-- earlier draft of it applied.

/* ---------------- Removed: the vision cache ---------------- */

-- The pipeline used to analyse each pin image with an object detector and then
-- interpret the labels with a second model call, caching the result here
-- because the detector's free plan allowed only 25 calls a month.
--
-- Both steps are gone. The copy model now receives the image URL directly and
-- reads the pin itself, so there is nothing left to cache: the one remaining
-- model call is the one that writes the copy. Dropped rather than left behind,
-- since a stale table that nothing writes is worse than no table.
DROP TABLE IF EXISTS public.pin_vision_cache;

/* ---------------- Pinterest Trends cache ---------------- */

-- Deliberately NOT user-scoped. Pinterest Trends data is public, identical for
-- everyone in a country, and refreshes weekly (`as_of`), so one creator's
-- lookup of "blazer outfit" should serve every other creator's too — that's
-- what keeps the Apify call count near zero at scale.
CREATE TABLE IF NOT EXISTS public.pinterest_trend_cache (
  -- 'keyword:IN:blazer outfit' | 'trending:IN'
  cache_key text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('keyword', 'trending')),
  country text NOT NULL,
  seed text,
  -- Array of TrendTerm (see src/lib/pinterest-trends.server.ts). The 52-week
  -- weeklySeries is stripped before caching — we only keep the scalars the
  -- ranker uses, so a row stays ~1KB instead of ~6KB.
  terms jsonb NOT NULL,
  as_of date,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pinterest_trend_cache_fetched_at_idx
  ON public.pinterest_trend_cache (fetched_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pinterest_trend_cache TO authenticated;
GRANT ALL ON public.pinterest_trend_cache TO service_role;

ALTER TABLE public.pinterest_trend_cache ENABLE ROW LEVEL SECURITY;

-- Public trend data: any signed-in user may read and refresh any row.
DROP POLICY IF EXISTS "pinterest_trend_cache shared read" ON public.pinterest_trend_cache;
CREATE POLICY "pinterest_trend_cache shared read" ON public.pinterest_trend_cache
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "pinterest_trend_cache shared write" ON public.pinterest_trend_cache;
CREATE POLICY "pinterest_trend_cache shared write" ON public.pinterest_trend_cache
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "pinterest_trend_cache shared update" ON public.pinterest_trend_cache;
CREATE POLICY "pinterest_trend_cache shared update" ON public.pinterest_trend_cache
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

/* ---------------- Richer suggestion records ---------------- */

-- What the copy was actually optimized for, so the UI can explain a suggestion
-- ("ranking for 'smart casual' — 54/100 volume, rising") instead of presenting
-- an opaque blob, and so a rejection tells us which keyword plan failed.
ALTER TABLE public.pin_suggestion_history
  ADD COLUMN IF NOT EXISTS primary_keyword text,
  -- { primary, secondary[], longTail[], ranked[] } — see KeywordSummary.
  ADD COLUMN IF NOT EXISTS keywords jsonb,
  -- 0–100 deterministic pin-SEO score for this exact title/description.
  ADD COLUMN IF NOT EXISTS seo_score integer,
  -- Remaining validation issues; empty for a clean 'pending' suggestion.
  ADD COLUMN IF NOT EXISTS issues jsonb,
  ADD COLUMN IF NOT EXISTS model text;

-- An earlier draft of this migration shipped a `vision` column holding the old
-- detector output. Nothing reads it now; drop it so the table doesn't carry a
-- column whose name implies a capability the pipeline no longer has.
ALTER TABLE public.pin_suggestion_history
  DROP COLUMN IF EXISTS vision;
