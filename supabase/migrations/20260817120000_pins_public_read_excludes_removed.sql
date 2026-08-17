-- The public storefront was rendering pins that no longer exist on Pinterest.
--
-- The sync FLAGS a pin that has disappeared from Pinterest — deleted there, or
-- the board holding it was made secret — by setting `pinterest_removed_at`, and
-- deliberately does not delete the row: it can carry an attached product and
-- earnings history worth keeping. But nothing ever read the flag. 374 of 803
-- pin rows carry it, and every one of them was still being listed: in the pin
-- grid, in the "attach a product" picker, and on the public /s/:slug page.
--
-- The in-app readers now filter it themselves. The public page CANNOT: `anon`
-- holds a column-level GRANT on `public.pins` (see
-- 20260803150000_scope_public_read.sql) which does not include
-- `pinterest_removed_at`, so adding `pinterest_removed_at is null` to that query
-- fails the whole request with 42501 "permission denied for table pins" — a
-- storefront that 500s instead of a row that hides.
--
-- So the exclusion belongs in the policy. A RLS policy expression is evaluated
-- as part of the security barrier rather than as part of the caller's query, so
-- it can test a column the caller has no privilege to select. Two things follow,
-- both wanted:
--   1. No new column has to be exposed to anon to make this work.
--   2. It holds for EVERY anon reader, including a future query that forgets to
--      filter — which is exactly how this bug happened in the first place.
--
-- Deliberately not granting SELECT (pinterest_removed_at) TO anon: nothing on
-- the public page needs to read the value, only to be excluded by it.

DROP POLICY IF EXISTS "pins public read live" ON public.pins;
CREATE POLICY "pins public read live" ON public.pins
  FOR SELECT TO anon USING (
    status = 'live'
    AND is_owner = true
    AND pinterest_removed_at IS NULL
  );
