-- Pinterest idempotency keys are per USER, not global.
--
-- The import keys were created as globally unique partial indexes:
--
--   collections_pinterest_board_id_key  UNIQUE (pinterest_board_id)
--   boards_pinterest_board_id_key       UNIQUE (pinterest_board_id)
--   pins_pinterest_pin_id_key           UNIQUE (pinterest_pin_id)
--
-- which encodes "a Pinterest board/pin may exist in Pinearn at most once, ever,
-- across every account". That isn't true. Two Pinearn users connecting the same
-- Pinterest account is ordinary — it's how the product gets tested, and it
-- happens in the wild with shared brand accounts and agencies managing a client's
-- profile.
--
-- The consequence was silent and total: the second user's board insert failed
-- with `duplicate key value violates unique constraint`, so the sync had no
-- collection id for that board and skipped every pin on it. The account imported
-- nothing and reported "0 pins and boards found" — indistinguishable from the
-- Pinterest connection being broken.
--
-- Scoping each key to (user_id, …) keeps the idempotency the import relies on —
-- re-syncing still updates rather than duplicates — while letting two accounts
-- hold their own copy of the same Pinterest object.

/* ---------------- Collections ---------------- */

DROP INDEX IF EXISTS public.collections_pinterest_board_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS collections_user_pinterest_board_id_key
  ON public.collections (user_id, pinterest_board_id)
  WHERE pinterest_board_id IS NOT NULL;

/* ---------------- Boards ---------------- */

DROP INDEX IF EXISTS public.boards_pinterest_board_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS boards_user_pinterest_board_id_key
  ON public.boards (user_id, pinterest_board_id)
  WHERE pinterest_board_id IS NOT NULL;

/* ---------------- Pins ---------------- */

-- Same story one level down: a pin saved to two users' Pinearn accounts could
-- only ever be stored once, so the second user's whole insert batch failed and
-- none of their pins landed.
DROP INDEX IF EXISTS public.pins_pinterest_pin_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS pins_user_pinterest_pin_id_key
  ON public.pins (user_id, pinterest_pin_id)
  WHERE pinterest_pin_id IS NOT NULL;
