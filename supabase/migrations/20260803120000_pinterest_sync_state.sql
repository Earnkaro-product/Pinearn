-- Pinterest sync state — what makes a re-sync a RECONCILE instead of an import.
--
-- The original importer was insert-only: it created boards and pins it hadn't
-- seen and did nothing else. So a creator who renamed a board, rewrote a pin
-- description or deleted a pin on pinterest.com saw none of it in Pinearn, ever.
-- Re-running the sync was a no-op for everything that already existed.
--
-- Pulling those edits in needs one thing the schema didn't have: a record of what
-- Pinterest last said. With it, a re-sync can tell the two cases apart —
--
--   local value == last-seen Pinterest value  → nobody edited it here, adopt
--                                                Pinterest's new copy
--   local value != last-seen Pinterest value  → the creator (or Boost) rewrote
--                                                it here, keep theirs
--
-- — instead of either ignoring Pinterest forever or clobbering every AI rewrite
-- on the next sync.
--
-- Everything is additive and IF NOT EXISTS, and every column is optional to the
-- code: src/lib/pinterest-sync.functions.ts detects a database without these
-- columns (PGRST204) and falls back to insert-only behaviour, so the app keeps
-- working if this migration hasn't been applied yet.

/* ---------------- Pins: the last-seen Pinterest snapshot ---------------- */

ALTER TABLE public.pins
  -- What Pinterest had at the last sync. NOT a duplicate of title/description:
  -- these are the comparison baseline that decides adopt-vs-keep above.
  ADD COLUMN IF NOT EXISTS pinterest_title text,
  ADD COLUMN IF NOT EXISTS pinterest_description text,
  ADD COLUMN IF NOT EXISTS pinterest_synced_at timestamptz,
  -- Set when a pin we imported is no longer returned by Pinterest (deleted or
  -- made secret there). Soft, not a DELETE: the pin may carry attached products,
  -- earnings and history that shouldn't vanish because of one API response.
  ADD COLUMN IF NOT EXISTS pinterest_removed_at timestamptz;

-- The sync reads "my pins by Pinterest id" on every run.
CREATE INDEX IF NOT EXISTS pins_user_pinterest_pin_idx
  ON public.pins (user_id, pinterest_pin_id) WHERE pinterest_pin_id IS NOT NULL;

-- Every surface that lists pins filters the removed ones out.
CREATE INDEX IF NOT EXISTS pins_user_live_idx
  ON public.pins (user_id) WHERE pinterest_removed_at IS NULL;

/* ---------------- Collections + boards: same idea, board-level ---------------- */

ALTER TABLE public.collections
  ADD COLUMN IF NOT EXISTS pinterest_name text,
  ADD COLUMN IF NOT EXISTS pinterest_description text,
  ADD COLUMN IF NOT EXISTS pinterest_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinterest_removed_at timestamptz;

ALTER TABLE public.boards
  ADD COLUMN IF NOT EXISTS pinterest_name text,
  ADD COLUMN IF NOT EXISTS pinterest_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinterest_removed_at timestamptz;

/* ---------------- Connection: sync state + reconnect signal ---------------- */

ALTER TABLE public.pinterest_connections
  -- Drives "Synced 4m ago" and the staleness check that triggers a background
  -- re-sync, so freshness never depends on the user remembering to press a button.
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  -- Analytics run on their own, slower cadence than boards/pins (Pinterest
  -- rate-limits per-pin analytics hard), so they get their own high-water mark.
  ADD COLUMN IF NOT EXISTS last_analytics_sync_at timestamptz,
  -- Cursor into the pin list for the analytics backfill, so consecutive runs
  -- keep moving through a 578-pin account instead of re-syncing the same batch.
  ADD COLUMN IF NOT EXISTS analytics_cursor timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_error text,
  -- Set when Pinterest rejects the token and a refresh can't recover it (revoked
  -- access, changed password, app permissions removed). The UI reads this to show
  -- "reconnect Pinterest" instead of an empty dashboard that looks like a bug.
  ADD COLUMN IF NOT EXISTS needs_reauth boolean NOT NULL DEFAULT false,
  -- Rolling counts from the last run, for the sync summary.
  ADD COLUMN IF NOT EXISTS last_sync_summary jsonb;

/* ---------------- Backfill ---------------- */

-- Everything already imported was, by definition, Pinterest's copy at import
-- time. Seeding the baseline with the current values means the FIRST reconcile
-- treats untouched rows as untouched (adopt Pinterest's edits) rather than
-- mistaking them for local edits and freezing them forever.
UPDATE public.pins
   SET pinterest_title = title,
       pinterest_description = description,
       pinterest_synced_at = now()
 WHERE pinterest_pin_id IS NOT NULL
   AND pinterest_synced_at IS NULL;

UPDATE public.collections
   SET pinterest_name = name,
       pinterest_description = description,
       pinterest_synced_at = now()
 WHERE pinterest_board_id IS NOT NULL
   AND pinterest_synced_at IS NULL;

UPDATE public.boards
   SET pinterest_name = name,
       pinterest_synced_at = now()
 WHERE pinterest_board_id IS NOT NULL
   AND pinterest_synced_at IS NULL;
