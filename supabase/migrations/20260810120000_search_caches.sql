-- Shared, durable caches for the two slowest stages of product matching.
--
-- Both already had in-process Maps in front of them, and both lost everything
-- on every deploy and every cold isolate. The work they cache is expensive in
-- money as well as time — a Google Lens search is a paid API call and a look
-- verdict is a vision model call — and, crucially, neither depends on WHO is
-- asking: the same image cropped the same way returns the same products for
-- everyone, and whether a retailer's photo shows the same product as a pin's
-- object is a fact about two images.
--
-- The practical effect of not having these: re-opening a pin, a second user
-- scanning the same popular pin, or a board flow touching products that
-- already appeared elsewhere all paid full price and made someone watch the
-- scanner again for an answer already computed.
--
-- Both tables are written by the service-role client and never read from the
-- browser. RLS is enabled with no policy on purpose (a client key reaching
-- them sees nothing), matching image_detections.

-- Raw Google Lens results, keyed by exactly what identifies a search: the
-- image and the crop region within it ('' = whole image).
create table if not exists public.lens_searches (
  image_url text not null,
  -- SearchAPI `crop` parameter, "left;top;right;bottom" normalised 0-1, or ''
  -- for the whole-image search that every component also draws on.
  crop_region text not null default '',
  -- The full filtered match list as returned, before ranking/gating — those
  -- steps are deterministic, so replaying them over a cached list reproduces
  -- the same final result exactly.
  matches jsonb not null default '[]'::jsonb,
  searched_at timestamptz not null default now(),
  primary key (image_url, crop_region)
);

alter table public.lens_searches enable row level security;

create index if not exists lens_searches_searched_at_idx
  on public.lens_searches (searched_at);

-- One "does this product look like that object" verdict.
create table if not exists public.look_verdicts (
  -- The candidate product photo that was judged.
  image_url text not null,
  -- What it was judged against: the detected object's label and appearance
  -- signature, joined. Two pins that detect the same-looking object share the
  -- row; a different-looking object is a different question and a different key.
  target text not null,
  -- 'same' | 'close' | 'different'. Verdicts that failed to resolve are NOT
  -- stored — those are retried, not remembered.
  verdict text not null,
  judged_at timestamptz not null default now(),
  primary key (image_url, target)
);

alter table public.look_verdicts enable row level security;

create index if not exists look_verdicts_judged_at_idx
  on public.look_verdicts (judged_at);
