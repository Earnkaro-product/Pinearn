-- Public read was leaking every creator's data to every other creator.
--
-- Six tables carried a "public read" policy written as `USING (true)` and
-- granted `TO anon, authenticated`. Two separate problems came out of that:
--
--   1. `authenticated` was in the policy, so ANY logged-in user could read ANY
--      other user's rows. The owner-only policies sat right next to these ones
--      and did nothing — RLS is permissive, so the widest policy wins. Every
--      in-app query that forgot `.eq("user_id", …)` silently returned the whole
--      table instead of erroring, and several did (fixed in the same change:
--      pins.tsx, pins_.attach.tsx, pins_.create.tsx, pins_.monetize-board.tsx,
--      analytics.tsx, pins_.preview.tsx, collections_.$id.attach.tsx,
--      storefront.tsx, affiliate-link-dialog.tsx, new-user-cta.tsx).
--
--   2. `anon` got whole rows, all columns. The publishable key ships in the
--      client bundle, so "readable by anon" means readable by anyone on the
--      internet with curl — including columns no public page renders:
--      storefront_products.commission_pct, pins.impressions/clicks/
--      earnings_cents/external_url, storefronts.is_published.
--
-- The public storefront page (src/routes/s.$slug.tsx) is the ONLY anon reader,
-- it runs server-side with the publishable key, and it reads a known, fixed set
-- of columns. So each policy below is narrowed to `TO anon` alone and each anon
-- GRANT is narrowed to exactly the columns that page selects, filters or orders
-- by. `authenticated` keeps its full table GRANT and falls back to the existing
-- owner-only policies, so in-app queries are unchanged for a user's own rows.

/* ---------------- storefront_products: no public read at all ---------------- */

-- The storefront page never touches this table — it renders pins and their
-- product_id, and resolves nothing further. So this GRANT bought nothing and
-- published every creator's affiliate URLs, prices and commission rates.
DROP POLICY IF EXISTS "storefront_products public read" ON public.storefront_products;
REVOKE SELECT ON public.storefront_products FROM anon;

/* ---------------- storefronts ---------------- */

-- A storefront stays anonymously resolvable by slug — that is the product. What
-- changes: only the seven columns the page renders, and `authenticated` no
-- longer reads other creators' storefronts.
DROP POLICY IF EXISTS "storefronts public read" ON public.storefronts;
CREATE POLICY "storefronts public read" ON public.storefronts
  FOR SELECT TO anon USING (true);

REVOKE SELECT ON public.storefronts FROM anon;
GRANT SELECT (id, user_id, name, slug, description, brand_color, background_image_url)
  ON public.storefronts TO anon;

/* ---------------- collections ---------------- */

-- hidden_from_storefront_at was enforced only in the query layer, so a hidden
-- collection was still one hand-written request away. Now the policy enforces it.
DROP POLICY IF EXISTS "collections public read" ON public.collections;
CREATE POLICY "collections public read" ON public.collections
  FOR SELECT TO anon USING (hidden_from_storefront_at IS NULL);

REVOKE SELECT ON public.collections FROM anon;
GRANT SELECT (
  id, name, slug, description, cover_color, cover_image_url, position,
  storefront_id, hidden_from_storefront_at
) ON public.collections TO anon;

/* ---------------- boards ---------------- */

DROP POLICY IF EXISTS "boards public read" ON public.boards;
CREATE POLICY "boards public read" ON public.boards
  FOR SELECT TO anon USING (hidden_from_storefront_at IS NULL);

REVOKE SELECT ON public.boards FROM anon;
GRANT SELECT (id, name, cover_image_url, position, storefront_id, hidden_from_storefront_at)
  ON public.boards TO anon;

/* ---------------- board_collections ---------------- */

-- Pure join table, but it should not outlive the board it links: a hidden board
-- must not leak its collection membership.
DROP POLICY IF EXISTS "board_collections public read" ON public.board_collections;
CREATE POLICY "board_collections public read" ON public.board_collections
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.boards b
     WHERE b.id = board_collections.board_id
       AND b.hidden_from_storefront_at IS NULL
  ));

REVOKE SELECT ON public.board_collections FROM anon;
GRANT SELECT (board_id, collection_id) ON public.board_collections TO anon;

/* ---------------- pins ---------------- */

-- `status = 'live'` alone still meant every logged-in creator could read every
-- other creator's live pins in full — impressions, clicks, earnings_cents and
-- the raw affiliate external_url included. is_owner is added to match what the
-- storefront page actually asks for (a repin the creator did not author is
-- never rendered), and the column GRANT keeps the metrics private.
DROP POLICY IF EXISTS "pins public read live" ON public.pins;
CREATE POLICY "pins public read live" ON public.pins
  FOR SELECT TO anon USING (status = 'live' AND is_owner = true);

REVOKE SELECT ON public.pins FROM anon;
GRANT SELECT (
  id, title, image_url, collection_id, product_id,
  storefront_id, status, is_owner, created_at
) ON public.pins TO anon;
