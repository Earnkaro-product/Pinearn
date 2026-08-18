-- Storefronts were being named after the creator's phone number, and the number
-- was ending up in the public URL.
--
-- The chain: sign-up seeds `profiles.display_name` with the phone number
-- (auth.tsx passes `options: { data: { display_name: phone } }`). The trigger
-- below fires AFTER INSERT ON profiles — i.e. before onboarding has had a chance
-- to ask the person their actual name — and derived all three of the storefront's
-- name, description and slug from that display_name. Result:
--
--   name        "+917777777777"
--   description "Curated picks and affiliate links from +917777777777"
--   slug        "917777777777"   ->  /s/917777777777
--
-- A phone number is personal data. Publishing it in a shareable URL, and on the
-- storefront a creator sends to their audience, is the part that matters here —
-- not the cosmetics.
--
-- Fix, in two halves:
--   1. The trigger stops trusting display_name unless it contains a letter. A
--      phone number does not, so it now yields the neutral 'My Shop' plus an
--      opaque `shop-<8 hex>` slug. Onboarding replaces both with the real name the
--      moment the creator types it (see renameStorefront in onboarding.tsx).
--   2. Existing rows are corrected: any storefront whose name or slug is
--      digit-only (with optional +) is renamed, and its slug replaced with the
--      same opaque form.
--
-- NOTE ON SLUGS: part 2 CHANGES PUBLIC URLS. A storefront currently reachable at
-- /s/917777777777 will answer 404 there afterwards, and any link already shared
-- pointing at the number will break. That is the intended trade — the number must
-- leave the path — but it is a one-way change, so apply it knowing that.

/* ---------------- 1. The trigger ---------------- */

CREATE OR REPLACE FUNCTION public.ensure_default_storefront()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  chosen_name text;
  base_slug text;
  final_slug text;
  n int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.storefronts WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- A real name contains at least one letter; "+918619596704" does not. This is
  -- the same test as hasRealName() in src/lib/creator-name.ts — keep them in step.
  IF NEW.display_name ~ '\w*[[:alpha:]]' THEN
    chosen_name := btrim(NEW.display_name);
  ELSE
    chosen_name := 'My Shop';
  END IF;

  -- Letters only, so digits from a phone number can never survive into a path.
  base_slug := regexp_replace(lower(chosen_name), '[^a-z[:space:]-]+', '', 'g');
  base_slug := regexp_replace(base_slug, '[[:space:]-]+', '-', 'g');
  base_slug := regexp_replace(base_slug, '(^-|-$)', '', 'g');
  IF base_slug = '' OR base_slug = 'my-shop' THEN
    base_slug := 'shop-' || translate(substr(replace(NEW.id::text, '-', ''), 1, 8), '0123456789', 'ghijklmnop');
  END IF;

  final_slug := base_slug;
  WHILE EXISTS (SELECT 1 FROM public.storefronts WHERE slug = final_slug) LOOP
    n := n + 1;
    final_slug := base_slug || '-' || n;
  END LOOP;

  INSERT INTO public.storefronts (user_id, name, slug, description, is_default)
  VALUES (
    NEW.id,
    chosen_name,
    final_slug,
    'Curated picks and affiliate links from ' || chosen_name,
    true
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_default_storefront() FROM PUBLIC, anon, authenticated;

/* ---------------- 2. Backfill existing rows ---------------- */

-- 67 of the 70 existing profiles ALREADY hold a real name — onboarding collected
-- it, nothing ever carried it onto the storefront. So the backfill reads
-- profiles.display_name rather than blanking everything to 'My Shop': a creator
-- who told us they were "dua" gets /s/dua, not /s/shop-32be2f75.
--
-- A loop rather than one UPDATE because slugs must stay unique and several
-- creators share a first name. Order of preference per row:
--   <name>            e.g. "dua"
--   <name>-<id4>      when that is taken
--   shop-<id8>        when the name yields no letters at all, or both collide
DO $$
DECLARE
  r record;
  candidate text;
  chosen text;
  new_name text;
BEGIN
  FOR r IN
    SELECT s.id, s.user_id, s.name, s.slug, p.display_name
      FROM public.storefronts s
      LEFT JOIN public.profiles p ON p.id = s.user_id
     WHERE s.name ~ '^\+?[0-9[:space:]()-]+$'
        OR s.slug ~ '^\+?[0-9-]+$'
  LOOP
    -- The name: the creator's own, else a neutral placeholder. Never the number.
    IF r.display_name ~ '\w*[[:alpha:]]' THEN
      new_name := btrim(r.display_name);
    ELSIF r.name ~ '\w*[[:alpha:]]' THEN
      new_name := r.name;          -- already a real name; keep it
    ELSE
      new_name := 'My Shop';
    END IF;

    -- The slug: letters only, so no digit of a phone number can survive.
    candidate := regexp_replace(lower(new_name), '[^a-z[:space:]-]+', '', 'g');
    candidate := regexp_replace(candidate, '[[:space:]-]+', '-', 'g');
    candidate := regexp_replace(candidate, '(^-|-$)', '', 'g');
    candidate := left(candidate, 40);

    IF candidate = '' OR candidate = 'my-shop' THEN
      chosen := 'shop-' || translate(substr(replace(r.user_id::text, '-', ''), 1, 8), '0123456789', 'ghijklmnop');
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.storefronts o WHERE o.slug = candidate AND o.id <> r.id
    ) THEN
      chosen := candidate;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.storefronts o
       WHERE o.slug = candidate || '-' || translate(substr(replace(r.user_id::text, '-', ''), 1, 4), '0123456789', 'ghijklmnop')
         AND o.id <> r.id
    ) THEN
      chosen := candidate || '-' || translate(substr(replace(r.user_id::text, '-', ''), 1, 4), '0123456789', 'ghijklmnop');
    ELSE
      chosen := 'shop-' || translate(substr(replace(r.user_id::text, '-', ''), 1, 8), '0123456789', 'ghijklmnop');
    END IF;

    UPDATE public.storefronts
       SET name = new_name,
           slug = chosen,
           description = 'Curated picks and affiliate links from ' || new_name
     WHERE id = r.id;
  END LOOP;
END $$;
