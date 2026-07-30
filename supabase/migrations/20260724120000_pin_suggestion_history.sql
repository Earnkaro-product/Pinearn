-- SEO suggestion history for pins. Every AI-generated title/description lands
-- here regardless of outcome, so the pipeline can (a) return a fresh pending
-- suggestion instead of paying for another model call within 24h, and (b) feed
-- previously rejected phrasings back into the prompt as "avoid these".
CREATE TABLE IF NOT EXISTS public.pin_suggestion_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pin_id uuid NOT NULL REFERENCES public.pins(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  suggested_title text NOT NULL,
  suggested_description text NOT NULL,
  -- Which of the five framing angles produced this suggestion — rotated per
  -- pin so a batch doesn't read like one template (see src/lib/pin-seo.ts).
  angle text,
  -- pending → awaiting swipe-approval; approved → written onto the pin;
  -- rejected → kept as a "don't repeat this phrasing" signal;
  -- needs_review → failed validation twice, parked for a human.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'needs_review')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedup lookup ("pending suggestion < 24h old?") and rejected-history fetch
-- both filter by pin and want newest-first.
CREATE INDEX IF NOT EXISTS pin_suggestion_history_pin_id_created_at_idx
  ON public.pin_suggestion_history (pin_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pin_suggestion_history TO authenticated;
GRANT ALL ON public.pin_suggestion_history TO service_role;

ALTER TABLE public.pin_suggestion_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pin_suggestion_history owner all" ON public.pin_suggestion_history
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
