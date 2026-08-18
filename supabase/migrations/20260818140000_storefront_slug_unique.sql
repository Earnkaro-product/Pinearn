-- `storefronts.slug` is a public URL and was never unique.
--
-- Only `user_id` ever carried a UNIQUE constraint (20260706071512). Slug
-- uniqueness was *attempted* in application code — a `WHILE EXISTS` loop in the
-- ensure_default_storefront trigger — which cannot hold against concurrent
-- sign-ups, and which a set-based backfill bypasses entirely. Three storefronts
-- ended up on the slug "dua".
--
-- What that broke, in order of severity:
--
--   1. WRONG STORE. /s/dua?c=<collection> resolved to whichever "dua" row the
--      query happened to pick. A creator copied a link to their own collection
--      and it opened a different creator's storefront.
--   2. HARD 404. The loader used maybeSingle(), which treats "more than one row"
--      as an error, so every one of the three storefronts answered "Storefront
--      not found" — from a link the creator had just copied.
--
-- The reader is now duplicate-tolerant (src/routes/s.$slug.tsx picks
-- deterministically instead of erroring), but tolerance is not a fix: an
-- ambiguous public URL cannot be resolved correctly by any amount of client
-- logic. The slug has to be unique, and the database has to be what enforces it.

/* ---------------- 1. Break the ties ---------------- */

-- Oldest row keeps the bare slug; every later claimant gets a letters-only
-- suffix derived from its owner id (see opaqueHandle in src/lib/creator-name.ts).
-- Deliberately NOT "whoever has the most content": oldest-wins is stable, so
-- re-running this can never reshuffle a slug that has already been shared.
DO $$
DECLARE
  r record;
  handle text;
  candidate text;
BEGIN
  FOR r IN
    SELECT id, user_id, slug,
           row_number() OVER (PARTITION BY slug ORDER BY created_at, id) AS rn
      FROM public.storefronts
     WHERE slug IN (SELECT slug FROM public.storefronts GROUP BY slug HAVING count(*) > 1)
  LOOP
    CONTINUE WHEN r.rn = 1;   -- the incumbent keeps its URL

    handle := translate(substr(replace(r.user_id::text, '-', ''), 1, 4),
                        '0123456789', 'ghijklmnop');
    candidate := r.slug || '-' || handle;

    IF EXISTS (SELECT 1 FROM public.storefronts o WHERE o.slug = candidate AND o.id <> r.id) THEN
      candidate := 'shop-' || translate(substr(replace(r.user_id::text, '-', ''), 1, 8),
                                        '0123456789', 'ghijklmnop');
    END IF;

    UPDATE public.storefronts SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

/* ---------------- 2. Make it impossible again ---------------- */

CREATE UNIQUE INDEX IF NOT EXISTS storefronts_slug_key ON public.storefronts (slug);

/* ---------------- 3. Stop the trigger relying on a racy pre-check ---------------- */

-- With the index in place, a lost race would raise 23505 and abort the profile
-- INSERT that fired this trigger — i.e. break sign-up. So the insert now catches
-- the violation and falls back to a slug that is unique by construction, because
-- it is derived from the user id.
CREATE OR REPLACE FUNCTION public.ensure_default_storefront()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  chosen_name text;
  base_slug text;
  fallback_slug text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.storefronts WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- A real name contains at least one letter; "+918619596704" does not. Same test
  -- as hasRealName() in src/lib/creator-name.ts — keep them in step.
  IF NEW.display_name ~ '\w*[[:alpha:]]' THEN
    chosen_name := btrim(NEW.display_name);
  ELSE
    chosen_name := 'My Shop';
  END IF;

  -- Letters only, so no digit of a phone number can survive into a path.
  base_slug := regexp_replace(lower(chosen_name), '[^a-z[:space:]-]+', '', 'g');
  base_slug := regexp_replace(base_slug, '[[:space:]-]+', '-', 'g');
  base_slug := regexp_replace(base_slug, '(^-|-$)', '', 'g');
  base_slug := left(base_slug, 40);

  fallback_slug := 'shop-' || translate(substr(replace(NEW.id::text, '-', ''), 1, 8),
                                        '0123456789', 'ghijklmnop');
  IF base_slug = '' OR base_slug = 'my-shop' THEN
    base_slug := fallback_slug;
  END IF;

  BEGIN
    INSERT INTO public.storefronts (user_id, name, slug, description, is_default)
    VALUES (NEW.id, chosen_name, base_slug,
            'Curated picks and affiliate links from ' || chosen_name, true);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO public.storefronts (user_id, name, slug, description, is_default)
    VALUES (NEW.id, chosen_name, fallback_slug,
            'Curated picks and affiliate links from ' || chosen_name, true);
  END;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_default_storefront() FROM PUBLIC, anon, authenticated;
