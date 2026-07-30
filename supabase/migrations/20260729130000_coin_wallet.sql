-- Coin wallet — the spend side of Boost.
--
-- Boosting a pin (applying an AI rewrite to it) costs 1 coin, and every creator
-- gets a WEEKLY ALLOWANCE of 100 coins: the balance resets to 100 at the start of
-- each ISO week (Monday 00:00 UTC, per date_trunc('week', …)) rather than
-- accumulating. Unspent coins do not roll over — the allowance is a weekly budget,
-- not a stored balance, so the reset is a set-to-100, not a top-up.
--
-- The reset is lazy: it happens inside the wallet functions on first touch of a
-- new week, which means no cron job and no drift between "what the UI shows" and
-- "what a spend charges".
--
-- The balance is server-owned: `authenticated` may SELECT its own wallet and
-- ledger but has no INSERT/UPDATE/DELETE grant on either table, so the only way a
-- balance moves is through the SECURITY DEFINER functions below. A client that
-- calls spend twice, or refunds something it never paid for, gets an exception
-- instead of coins.
--
-- Every object is created IF NOT EXISTS / OR REPLACE, so the file is safe to
-- re-run. The app treats the whole feature as optional: until this migration is
-- applied the wallet reads as unavailable and boosting is never blocked (see
-- src/hooks/use-wallet.ts), so shipping the client ahead of the migration
-- degrades rather than breaks.

/* ---------------- Tables ---------------- */

-- One row per user, created on first read. `week_start` is the Monday of the week
-- the current balance belongs to — the marker the lazy reset compares against.
CREATE TABLE IF NOT EXISTS public.user_wallets (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 100 CHECK (balance >= 0),
  week_start date NOT NULL DEFAULT (date_trunc('week', now() AT TIME ZONE 'utc'))::date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Re-runnable upgrade path for a database that already has the pre-allowance
-- draft of this table (balance defaulted to 500, no week marker).
ALTER TABLE public.user_wallets
  ADD COLUMN IF NOT EXISTS week_start date NOT NULL
  DEFAULT (date_trunc('week', now() AT TIME ZONE 'utc'))::date;
ALTER TABLE public.user_wallets ALTER COLUMN balance SET DEFAULT 100;

-- Append-only ledger. `balance_after` makes each row self-describing (no need to
-- replay the whole history to render "you had 312 left"), and ref_type/ref_id tie
-- a spend to the exact pin it bought so a refund can be verified rather than
-- trusted.
CREATE TABLE IF NOT EXISTS public.coin_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Negative = spend, positive = grant/refund. Never 0.
  delta integer NOT NULL CHECK (delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  -- 'pin_boost' | 'pin_boost_refund' | 'weekly_reset' | 'signup_grant'
  -- | 'topup' | 'adjustment'
  reason text NOT NULL,
  ref_type text,
  ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The wallet sheet reads "my newest transactions"; refund verification reads
-- "everything for this pin".
CREATE INDEX IF NOT EXISTS coin_transactions_user_created_idx
  ON public.coin_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS coin_transactions_ref_idx
  ON public.coin_transactions (user_id, ref_id) WHERE ref_id IS NOT NULL;

/* ---------------- Grants + RLS ---------------- */

-- Read-only for the client. Writes go through the functions, which run as owner.
GRANT SELECT ON public.user_wallets TO authenticated;
GRANT SELECT ON public.coin_transactions TO authenticated;
GRANT ALL ON public.user_wallets TO service_role;
GRANT ALL ON public.coin_transactions TO service_role;

ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_wallets owner read" ON public.user_wallets;
CREATE POLICY "user_wallets owner read" ON public.user_wallets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "coin_transactions owner read" ON public.coin_transactions;
CREATE POLICY "coin_transactions owner read" ON public.coin_transactions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

/* ---------------- Ledger bookkeeping ---------------- */

-- The signup grant is a real ledger entry, so balance always equals the sum of
-- deltas. Without it the wallet sheet would open on "500 coins" with an empty
-- history, which reads as a bug.
CREATE OR REPLACE FUNCTION public.log_wallet_signup_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.balance > 0 THEN
    INSERT INTO public.coin_transactions (user_id, delta, balance_after, reason)
    VALUES (NEW.user_id, NEW.balance, NEW.balance, 'signup_grant');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_wallets_signup_grant ON public.user_wallets;
CREATE TRIGGER user_wallets_signup_grant
  AFTER INSERT ON public.user_wallets
  FOR EACH ROW EXECUTE FUNCTION public.log_wallet_signup_grant();

/* ---------------- Functions ---------------- */

-- The weekly budget, in one place so the reset, the column default and the client
-- can't disagree about what a week is worth.
CREATE OR REPLACE FUNCTION public.wallet_weekly_allowance()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 100 $$;

-- Create the wallet if it's missing, roll it over if it belongs to a past week,
-- and return the balance that's actually spendable right now. Every entry point
-- goes through this, so a creator who leaves the app open across the week boundary
-- gets the new allowance on their next action rather than a stale balance.
CREATE OR REPLACE FUNCTION public.ensure_wallet_period(uid uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur_week date := (date_trunc('week', now() AT TIME ZONE 'utc'))::date;
  allowance integer := public.wallet_weekly_allowance();
  bal integer;
  wk date;
BEGIN
  INSERT INTO public.user_wallets (user_id, balance, week_start)
  VALUES (uid, allowance, cur_week)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance, week_start INTO bal, wk
    FROM public.user_wallets WHERE user_id = uid FOR UPDATE;

  IF wk IS DISTINCT FROM cur_week THEN
    UPDATE public.user_wallets
       SET balance = allowance, week_start = cur_week, updated_at = now()
     WHERE user_id = uid;

    -- A reset that changes nothing (an untouched allowance) gets no ledger row —
    -- delta is CHECK'd non-zero, and "refilled 0" is noise either way.
    IF allowance <> bal THEN
      INSERT INTO public.coin_transactions (user_id, delta, balance_after, reason)
      VALUES (uid, allowance - bal, allowance, 'weekly_reset');
    END IF;

    bal := allowance;
  END IF;

  RETURN bal;
END;
$$;

-- Read (and lazily create / roll over) the caller's balance. Used by the wallet.
CREATE OR REPLACE FUNCTION public.wallet_balance()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  RETURN public.ensure_wallet_period(uid);
END;
$$;

-- When the current allowance runs out and when it refills. Returned together so
-- the wallet can render "37 of 100 left · resets Monday" from one round trip.
CREATE OR REPLACE FUNCTION public.wallet_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bal integer;
  wk date;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  bal := public.ensure_wallet_period(uid);
  SELECT week_start INTO wk FROM public.user_wallets WHERE user_id = uid;
  RETURN jsonb_build_object(
    'balance', bal,
    'allowance', public.wallet_weekly_allowance(),
    'week_start', wk,
    'resets_at', (wk + 7)::timestamptz
  );
END;
$$;

-- Debit the caller and log it. The balance guard lives in the UPDATE's WHERE
-- clause, so the check and the write are one atomic statement — two concurrent
-- spends of the last coin can't both succeed.
CREATE OR REPLACE FUNCTION public.spend_coins(
  p_amount integer,
  p_reason text DEFAULT 'pin_boost',
  p_ref_type text DEFAULT NULL,
  p_ref_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bal integer;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  -- Roll the week over first: a spend on Monday morning must charge against the
  -- fresh allowance, not against last week's leftovers.
  PERFORM public.ensure_wallet_period(uid);

  UPDATE public.user_wallets
     SET balance = balance - p_amount, updated_at = now()
   WHERE user_id = uid AND balance >= p_amount
  RETURNING balance INTO bal;

  IF bal IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_COINS';
  END IF;

  INSERT INTO public.coin_transactions (user_id, delta, balance_after, reason, ref_type, ref_id)
  VALUES (uid, -p_amount, bal, COALESCE(p_reason, 'pin_boost'), p_ref_type, p_ref_id);

  RETURN bal;
END;
$$;

-- Credit back a spend the caller actually made — undoing a boost returns its
-- coin. A ref is mandatory and the refund is capped both by what was spent
-- against that ref and by the weekly allowance, so it can neither mint coins nor
-- carry last week's spend into this week's budget.
CREATE OR REPLACE FUNCTION public.refund_coins(
  p_amount integer,
  p_reason text DEFAULT 'pin_boost_refund',
  p_ref_type text DEFAULT NULL,
  p_ref_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  allowance integer := public.wallet_weekly_allowance();
  wk date;
  spent integer;
  refunded integer;
  bal integer;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_ref_id IS NULL THEN
    RAISE EXCEPTION 'REFUND_REQUIRES_REF';
  END IF;

  bal := public.ensure_wallet_period(uid);
  SELECT week_start INTO wk FROM public.user_wallets WHERE user_id = uid;

  -- Anti-mint check over the ref's whole history.
  SELECT COALESCE(SUM(-delta), 0) INTO spent
    FROM public.coin_transactions
   WHERE user_id = uid AND ref_id = p_ref_id AND delta < 0;

  SELECT COALESCE(SUM(delta), 0) INTO refunded
    FROM public.coin_transactions
   WHERE user_id = uid AND ref_id = p_ref_id AND delta > 0;

  IF refunded + p_amount > spent THEN
    RAISE EXCEPTION 'NOTHING_TO_REFUND';
  END IF;

  -- Undoing a boost that was paid for out of a PREVIOUS week's allowance is a
  -- no-op, not a credit: that week's budget is already gone, and crediting it
  -- here would let a Sunday spend fund a Monday boost. Same for any refund that
  -- would push the balance past the allowance.
  IF NOT EXISTS (
    SELECT 1 FROM public.coin_transactions
     WHERE user_id = uid AND ref_id = p_ref_id AND delta < 0 AND created_at >= wk
  ) OR bal + p_amount > allowance THEN
    RETURN bal;
  END IF;

  UPDATE public.user_wallets
     SET balance = balance + p_amount, updated_at = now()
   WHERE user_id = uid
  RETURNING balance INTO bal;

  INSERT INTO public.coin_transactions (user_id, delta, balance_after, reason, ref_type, ref_id)
  VALUES (uid, p_amount, bal, COALESCE(p_reason, 'pin_boost_refund'), p_ref_type, p_ref_id);

  RETURN bal;
END;
$$;

-- ensure_wallet_period is internal: it moves money, so only the definer-run
-- functions above may call it, never a client.
REVOKE ALL ON FUNCTION public.ensure_wallet_period(uuid) FROM public;
REVOKE ALL ON FUNCTION public.wallet_balance() FROM public;
REVOKE ALL ON FUNCTION public.wallet_summary() FROM public;
REVOKE ALL ON FUNCTION public.spend_coins(integer, text, text, uuid) FROM public;
REVOKE ALL ON FUNCTION public.refund_coins(integer, text, text, uuid) FROM public;

GRANT EXECUTE ON FUNCTION public.wallet_weekly_allowance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_balance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.spend_coins(integer, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_coins(integer, text, text, uuid) TO authenticated;
