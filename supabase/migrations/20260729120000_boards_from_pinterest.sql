-- Pinterest sync wrote every real board into `collections` (source 'pinterest',
-- pinterest_board_id set) and never touched `boards` — so the Boards tab on the
-- storefront (and the public page) was empty for creators who had synced boards
-- like "mirror". Give `boards` the same Pinterest identity `collections` has,
-- then backfill one board per already-synced Pinterest board, linked to the
-- collection that holds its pins.

ALTER TABLE public.boards ADD COLUMN IF NOT EXISTS pinterest_board_id text;
ALTER TABLE public.boards ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- Idempotency key for board import — mirrors collections_pinterest_board_id_key.
CREATE UNIQUE INDEX IF NOT EXISTS boards_pinterest_board_id_key
  ON public.boards (pinterest_board_id) WHERE pinterest_board_id IS NOT NULL;

-- Backfill: every synced Pinterest collection gets its board + membership row.
WITH inserted AS (
  INSERT INTO public.boards (
    user_id, storefront_id, name, cover_image_url, position, source, pinterest_board_id
  )
  SELECT c.user_id, c.storefront_id, c.name, c.cover_image_url, c.position,
         'pinterest', c.pinterest_board_id
  FROM public.collections c
  WHERE c.pinterest_board_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.boards b WHERE b.pinterest_board_id = c.pinterest_board_id
    )
  RETURNING id, user_id, pinterest_board_id
)
INSERT INTO public.board_collections (board_id, collection_id, user_id, position)
SELECT i.id, c.id, c.user_id, c.position
FROM inserted i
JOIN public.collections c ON c.pinterest_board_id = i.pinterest_board_id
ON CONFLICT DO NOTHING;
