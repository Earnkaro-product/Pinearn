-- Shared, durable cache for pin-image object detection.
--
-- Detecting the products in an image (src/lib/vision-detect.server.ts) costs a
-- vision model call and returns the same answer for the same image no matter
-- which user asks. It used to be held only in an in-process Map, which on
-- Cloudflare Workers lives and dies with the isolate — so the same pin was
-- re-detected repeatedly, each time making the user wait through the scan again
-- and each time possibly landing on a slightly different set of products.
--
-- Rows are keyed by the image URL and written by the service-role client. There
-- is no RLS policy on purpose: this is a server-side cache of public image
-- metadata, never read from the browser (RLS stays enabled, so a client key
-- reaching it sees nothing).
create table if not exists public.image_detections (
  image_url text primary key,
  -- Pixel dimensions of the source image; the stored boxes are normalised 0-1
  -- and can only be turned into a pixel crop against these.
  width integer,
  height integer,
  -- [{ l: label, c: category, b: [x, y, w, h] }] — the same compact shape the
  -- model replies in, boxes already validated, padded and de-duplicated.
  objects jsonb not null default '[]'::jsonb,
  detected_at timestamptz not null default now()
);

alter table public.image_detections enable row level security;

-- Sweeping stale rows is a maintenance job, not a query path, but the index
-- keeps it cheap and costs nothing to carry.
create index if not exists image_detections_detected_at_idx
  on public.image_detections (detected_at);
