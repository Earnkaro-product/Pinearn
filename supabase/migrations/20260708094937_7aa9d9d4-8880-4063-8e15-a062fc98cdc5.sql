

GRANT SELECT, INSERT, UPDATE, DELETE ON public.boards TO authenticated;
GRANT ALL ON public.boards TO service_role;
GRANT SELECT ON public.boards TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.board_collections TO authenticated;
GRANT ALL ON public.board_collections TO service_role;
GRANT SELECT ON public.board_collections TO anon;