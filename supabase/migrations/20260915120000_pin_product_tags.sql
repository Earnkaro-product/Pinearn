-- Product tags — the first-class "this product is in this Pin" record.
--
-- Until now the ONLY link between a pin and the products on it was
-- `storefront_products.pin_id`, a single nullable column on the product row.
-- That works for "which products does this pin's storefront collection show",
-- and it is kept (and kept in step, below) because the storefront, the
-- analytics pin breakdown and take-down all read it. What it cannot hold is
-- anything about the TAG itself:
--
--   - which object in the image the product was matched to, and where it sits
--     (the detector's category, label and box),
--   - how sure the matcher was, and why (score, look-gate verdict, source),
--   - whether the creator wants this product's link monetised or left plain,
--   - an order (`pins.product_id` remembers one "primary" product and nothing
--     about the rest).
--
-- Nor can it stop a pin from carrying sixty products: the match pipeline emits
-- up to 6 objects × 10 candidates, every one was selected by default, and every
-- one went live. Pinterest allows 20 tagged products per Pin in its creator
-- tagging flow (help.pinterest.com/en/article/tag-products-in-your-pins), and
-- that number is now enforced at three depths — wizard, server function, and
-- the trigger at the bottom of this file, which is the one a bug in either of
-- the others cannot get past.
--
-- One row per (pin, product). A product row still belongs to at most one pin
-- (`storefront_products.pin_id` is a single column), so this is 1:1 with the
-- old link today; the table exists for the metadata and the constraint, not to
-- change that shape.

CREATE TABLE IF NOT EXISTS public.pin_product_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pin_id uuid NOT NULL REFERENCES public.pins(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.storefront_products(id) ON DELETE CASCADE,

  -- Display order on the pin; 0 is the primary product (`pins.product_id`).
  position integer NOT NULL DEFAULT 0,

  -- What the matcher saw. `category` is the shared closed vocabulary in
  -- src/lib/product-category.ts ('footwear', 'bag', … 'other'); `detected_label`
  -- is the detector's short name for the object ("White Sneakers");
  -- `component_key` indexes the detector's object list for the image and `box`
  -- is that object's normalised 0-1 rectangle {x,y,w,h} — the same shape
  -- image_detections stores — so a UI can place the tag on the picture. All
  -- nullable: a product the creator pasted by hand was matched to nothing.
  category text NOT NULL DEFAULT 'other',
  detected_label text,
  component_key integer,
  box jsonb,

  -- The product as it was when tagged, so the tag stays explainable after the
  -- product row is edited: the retailer title and the canonical (tracking-
  -- stripped) product URL.
  matched_title text NOT NULL,
  product_url text NOT NULL,

  -- Exactness: 0-1 score from src/lib/product-tagging.ts, its confidence band,
  -- the look gate's verdict when there was one, and how the tag came to be.
  match_score numeric(4,3) CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 1)),
  confidence text CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  look_match text CHECK (look_match IS NULL OR look_match IN ('same', 'close')),
  match_source text NOT NULL DEFAULT 'manual'
    CHECK (match_source IN ('auto', 'suggested', 'search', 'url', 'collection', 'manual')),

  -- When this tag mirrors a product pin on Pinterest itself (the creator tagged
  -- it in the Pinterest app, or the app pushed one of their own product pins
  -- through POST /pins/{id}/product_tags), the product pin's Pinterest id.
  -- Null for the common case: a retailer listing Pinterest's API cannot tag.
  pinterest_product_pin_id text,

  -- Monetisation. `affiliate_enabled` is OUR toggle — Pinterest exposes no such
  -- switch through its API and the tag on Pinterest's side is unaffected by it.
  -- Off means the storefront shows the product with `product_url` (a plain
  -- retailer link) instead of `affiliate_url`, and it is excluded from earnings.
  -- `affiliate_url` is what the storefront links to when enabled: today the
  -- retailer URL the product row carries, later a network deep link.
  affiliate_enabled boolean NOT NULL DEFAULT true,
  affiliate_url text,
  monetisation_status text NOT NULL DEFAULT 'pending'
    CHECK (monetisation_status IN ('pending', 'monetised', 'disabled', 'failed')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- The same product tagged twice on one pin is a duplicate, never two tags.
  CONSTRAINT pin_product_tags_pin_product_unique UNIQUE (pin_id, product_id)
);

-- Every read is "the tags on this pin, in order" or "this user's tags".
CREATE INDEX IF NOT EXISTS pin_product_tags_pin_position_idx
  ON public.pin_product_tags (pin_id, position);
CREATE INDEX IF NOT EXISTS pin_product_tags_user_idx
  ON public.pin_product_tags (user_id);
CREATE INDEX IF NOT EXISTS pin_product_tags_product_idx
  ON public.pin_product_tags (product_id);

DROP TRIGGER IF EXISTS set_pin_product_tags_updated_at ON public.pin_product_tags;
CREATE TRIGGER set_pin_product_tags_updated_at
  BEFORE UPDATE ON public.pin_product_tags
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

/* ---------------- The per-pin limit ---------------- */

-- MIRRORS `MAX_PRODUCT_TAGS_PER_PIN` in src/lib/product-tagging.ts. The two
-- must move together: the TypeScript constant is what the UI and the server
-- functions enforce and explain to the creator; this is the backstop that makes
-- the database refuse a twenty-first tag even if both of those are bypassed. Kept as a
-- function rather than a literal inside the trigger so the number is spelled
-- exactly once on this side too.
CREATE OR REPLACE FUNCTION public.pin_product_tag_limit() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 20 $$;

/* ---------------- Backfill ---------------- */

-- Every product already routed to a pin becomes a tag, so pins monetised before
-- this table existed read the same way as new ones. Nothing is known about how
-- they were matched, so they are honest 'manual' tags with the pin's primary
-- product first. Runs BEFORE the limit trigger exists, and keeps only the first
-- `pin_product_tag_limit()` products per pin: the old flows attached up to
-- sixty, and a migration that aborts on the first over-full pin helps nobody.
-- The products past the limit keep their `pin_id` and stay on the storefront
-- exactly as before — they simply carry no tag. Idempotent through the unique
-- constraint.
INSERT INTO public.pin_product_tags
  (user_id, pin_id, product_id, position, matched_title, product_url, affiliate_url, match_source, monetisation_status)
SELECT user_id, pin_id, product_id, rn - 1, title, affiliate_url, affiliate_url, 'manual', status
FROM (
  SELECT
    sp.user_id,
    sp.pin_id,
    sp.id AS product_id,
    sp.title,
    sp.affiliate_url,
    CASE WHEN p.status = 'live' THEN 'monetised' ELSE 'pending' END AS status,
    -- Primary product first (position 0), then the storefront's own order.
    row_number() OVER (
      PARTITION BY sp.pin_id
      ORDER BY (p.product_id = sp.id) DESC NULLS LAST, sp.position, sp.created_at
    ) AS rn
  FROM public.storefront_products sp
  JOIN public.pins p ON p.id = sp.pin_id
  WHERE sp.pin_id IS NOT NULL
) ranked
WHERE rn <= public.pin_product_tag_limit()
  -- Re-runnable even once the limit trigger below exists: a BEFORE INSERT
  -- trigger fires ahead of ON CONFLICT, so already-tagged rows must be kept
  -- out of the INSERT itself, not left to the conflict clause.
  AND NOT EXISTS (
    SELECT 1 FROM public.pin_product_tags t
     WHERE t.pin_id = ranked.pin_id AND t.product_id = ranked.product_id
  )
ON CONFLICT (pin_id, product_id) DO NOTHING;

/* ---------------- Enforcement triggers ---------------- */

CREATE OR REPLACE FUNCTION public.tg_enforce_pin_product_tag_limit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  -- Serialise concurrent inserts for the same pin: two requests racing past a
  -- count one below the limit would otherwise both succeed.
  PERFORM pg_advisory_xact_lock(hashtext('pin_product_tags:' || NEW.pin_id::text));
  SELECT count(*) INTO n FROM public.pin_product_tags WHERE pin_id = NEW.pin_id;
  IF n >= public.pin_product_tag_limit() THEN
    RAISE EXCEPTION 'A Pin can have at most % tagged products', public.pin_product_tag_limit()
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_pin_product_tag_limit ON public.pin_product_tags;
CREATE TRIGGER enforce_pin_product_tag_limit
  BEFORE INSERT ON public.pin_product_tags
  FOR EACH ROW EXECUTE FUNCTION public.tg_enforce_pin_product_tag_limit();

/* ---------------- Keep the legacy link in step ---------------- */

-- `storefront_products.pin_id` stays the column the storefront page, the
-- analytics breakdown and take-down read. A tag INSERT stamps it; a tag DELETE
-- clears it unless another tag on the same product still exists (it cannot,
-- given the single column, but the guard costs nothing and survives a future
-- widening). Take-down deletes product rows by pin_id, which cascades to the
-- tags — so that path needs no change.
CREATE OR REPLACE FUNCTION public.tg_pin_product_tag_sync_product() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.storefront_products SET pin_id = NEW.pin_id
      WHERE id = NEW.product_id AND (pin_id IS DISTINCT FROM NEW.pin_id);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.storefront_products SET pin_id = NULL
      WHERE id = OLD.product_id AND pin_id = OLD.pin_id
        AND NOT EXISTS (
          SELECT 1 FROM public.pin_product_tags t
           WHERE t.product_id = OLD.product_id AND t.id <> OLD.id
        );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pin_product_tag_sync_product ON public.pin_product_tags;
CREATE TRIGGER pin_product_tag_sync_product
  AFTER INSERT OR DELETE ON public.pin_product_tags
  FOR EACH ROW EXECUTE FUNCTION public.tg_pin_product_tag_sync_product();

/* ---------------- Grants + RLS ---------------- */

ALTER TABLE public.pin_product_tags ENABLE ROW LEVEL SECURITY;

-- Owner-only, exactly like pins and storefront_products. No anon grant: the
-- public storefront reads tags server-side with the service role (s.$slug.tsx),
-- the same way it already reads products, so nothing here is queryable off
-- PostgREST with the publishable key.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pin_product_tags TO authenticated;
GRANT ALL ON public.pin_product_tags TO service_role;

DROP POLICY IF EXISTS "pin_product_tags owner all" ON public.pin_product_tags;
CREATE POLICY "pin_product_tags owner all" ON public.pin_product_tags
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
