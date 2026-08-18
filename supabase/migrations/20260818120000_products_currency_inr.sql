-- `storefront_products.currency` has been lying since day one.
--
-- The column was created as `currency TEXT DEFAULT 'USD'`
-- (20260706061832_8bbb920c…sql) and NOTHING in the codebase has ever written to
-- it. So every one of the 109 rows says 'USD' by default while the amount beside
-- it is a rupee figure: these are Indian retailers (the CK allowlist is all .in
-- domains), Google Lens returns ₹ prices for them, and the parser in
-- pinterest.functions.ts stamps `currency: "₹"` on what it reads.
--
-- Nothing noticed until the public storefront started rendering prices, because
-- the in-app card never reads this column — `realProductPrice` hardcodes ₹. The
-- public page did read it, and printed "$2,199" for a ₹2,199 Myntra product.
--
-- Two fixes, so the data stops contradicting the amounts:
--   1. The default becomes 'INR', which is what every row created so far
--      actually is.
--   2. Existing rows are corrected. Every current row is Indian, so this is a
--      straight relabel of mislabelled data, not a conversion — no amount is
--      touched.
--
-- The app tolerates a stale 'USD' either way (see currencySymbol in
-- src/routes/s.$slug.tsx, which treats it as the unset default it is), so
-- applying this late is safe and applying it never is merely untidy.

ALTER TABLE public.storefront_products ALTER COLUMN currency SET DEFAULT 'INR';

UPDATE public.storefront_products
   SET currency = 'INR'
 WHERE currency IS NULL OR upper(currency) IN ('USD', '₹');
