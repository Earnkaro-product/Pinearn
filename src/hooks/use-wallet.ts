import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { COINS_PER_PIN_BOOST, nextResetAt, weekKeyOf, WEEKLY_COIN_ALLOWANCE } from "@/lib/coins";

export const WALLET_QUERY_KEY = ["coin-wallet"] as const;
export const COIN_LEDGER_QUERY_KEY = ["coin-ledger"] as const;

export type CoinTransaction = {
  id: string;
  delta: number;
  balance_after: number;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  created_at: string;
};

type PgError = { message: string; code?: string } | null;

// The wallet's RPCs and tables ship in 20260729130000_coin_wallet.sql, which
// isn't in the generated Database types yet — types.ts is regenerated from the
// remote schema, and this hook has to compile before that happens. Both casts
// live here rather than as `as never` at every call site.
const rpc = supabase.rpc as unknown as (
  fn: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: PgError }>;

const ledgerTable = supabase.from as unknown as (name: string) => {
  select: (cols: string) => {
    order: (
      col: string,
      opts: { ascending: boolean },
    ) => { limit: (n: number) => PromiseLike<{ data: CoinTransaction[] | null; error: PgError }> };
  };
};

/** True when the failure is "this database doesn't have the wallet yet" rather
 * than a real error. PostgREST answers an unknown function with PGRST202 and a
 * missing table with 42P01 — both mean the migration hasn't been applied, and
 * both have to leave Boost fully usable rather than locking a creator out of
 * their own pins over a feature that isn't provisioned. */
function isWalletMissing(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42P01" || error.code === "42883") return true;
  return /could not find the (function|table)|does not exist|schema cache/i.test(error.message);
}

/* ---------------- Local fallback ---------------- */

// Until the coin migration is applied the RPCs don't exist, and a wallet that
// renders nothing is indistinguishable from a wallet that was never built. So an
// un-provisioned database gets a device-local balance instead: the pill, the
// prices and the spend/refund loop all work, the sheet says plainly that the
// balance is local, and the moment `wallet_balance` starts answering, the server
// ledger takes over and this is never read again.
const LOCAL_KEY = "pinearn.wallet.local.v2";

type LocalWallet = { balance: number; weekKey: string; ledger: CoinTransaction[] };

/** Read the local wallet, refilling it first if it belongs to a past week — the
 * same lazy rollover ensure_wallet_period() does server-side, on the same Monday
 * boundary, so the two behave identically. */
function readLocal(): LocalWallet {
  const weekKey = weekKeyOf();
  if (typeof window === "undefined") return { balance: WEEKLY_COIN_ALLOWANCE, weekKey, ledger: [] };

  let stored: LocalWallet | null = null;
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LocalWallet;
      if (typeof parsed?.balance === "number" && typeof parsed?.weekKey === "string") {
        stored = { balance: parsed.balance, weekKey: parsed.weekKey, ledger: parsed.ledger ?? [] };
      }
    }
  } catch {
    // Corrupt or unavailable storage — fall through to a fresh week.
  }

  if (stored && stored.weekKey === weekKey) return stored;

  // New week (or no wallet yet): set — not add — the allowance.
  const refilled: LocalWallet = {
    balance: WEEKLY_COIN_ALLOWANCE,
    weekKey,
    ledger: [
      {
        id: `refill-${weekKey}`,
        delta: WEEKLY_COIN_ALLOWANCE - (stored?.balance ?? 0),
        balance_after: WEEKLY_COIN_ALLOWANCE,
        reason: stored ? "weekly_reset" : "signup_grant",
        ref_type: null,
        ref_id: null,
        created_at: new Date().toISOString(),
      },
      ...(stored?.ledger ?? []),
    ],
  };
  writeLocal(refilled);
  return refilled;
}

function writeLocal(w: LocalWallet) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...w, ledger: w.ledger.slice(0, 20) }));
  } catch {
    // Private-mode storage refusals must not break a boost run.
  }
}

function moveLocal(delta: number, reason: string, pinId: string): number {
  const w = readLocal();
  // Clamped to the allowance at the top end for the same reason refund_coins is:
  // a refund must never lift the balance above the week's budget.
  const next = Math.min(WEEKLY_COIN_ALLOWANCE, Math.max(0, w.balance + delta));
  if (next === w.balance) return next;
  const entry: CoinTransaction = {
    id: `${reason}-${pinId}-${w.ledger.length}`,
    delta: next - w.balance,
    balance_after: next,
    reason,
    ref_type: "pin",
    ref_id: pinId,
    created_at: new Date().toISOString(),
  };
  writeLocal({ ...w, balance: next, ledger: [entry, ...w.ledger] });
  return next;
}

/* ---------------- Hook ---------------- */

type WalletData = {
  balance: number;
  allowance: number;
  /** ISO timestamp of the next weekly refill. */
  resetsAt: string;
  source: "server" | "local";
};

export type WalletState = {
  /** Coins available. Never null — an un-provisioned wallet falls back to local. */
  balance: number;
  /** Coins this week started with — the balance resets to it every Monday. */
  allowance: number;
  /** Coins already spent this week. */
  spentThisWeek: number;
  /** When the allowance refills. */
  resetsAt: Date;
  /** True once the balance is known (server or local). */
  available: boolean;
  /** False until the coin migration is applied — the balance is device-local. */
  provisioned: boolean;
  isLoading: boolean;
  /** Can this many coins be spent right now? */
  canAfford: (coins: number) => boolean;
  /** Debit for one pin. Resolves false only when the wallet actively refused. */
  spendForPin: (pinId: string, coins?: number) => Promise<boolean>;
  /** Credit a pin's boost back after an undo. Best-effort. */
  refundForPin: (pinId: string, coins?: number) => Promise<boolean>;
  refetch: () => void;
};

export function useWallet(): WalletState {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: WALLET_QUERY_KEY,
    queryFn: async (): Promise<WalletData> => {
      const local = (): WalletData => ({
        balance: readLocal().balance,
        allowance: WEEKLY_COIN_ALLOWANCE,
        resetsAt: nextResetAt().toISOString(),
        source: "local",
      });
      // wallet_summary returns balance + allowance + reset date in one call, so
      // the pill can render "37 of 100 · resets Monday" without a second read.
      const { data, error } = await rpc("wallet_summary");
      if (error) {
        if (isWalletMissing(error)) return local();
        throw new Error(error.message);
      }
      const row = (data ?? {}) as { balance?: number; allowance?: number; resets_at?: string };
      return {
        balance: Number(row.balance ?? 0),
        allowance: Number(row.allowance ?? WEEKLY_COIN_ALLOWANCE),
        resetsAt: row.resets_at ?? nextResetAt().toISOString(),
        source: "server",
      };
    },
    staleTime: 30_000,
    retry: 1,
  });

  const source = query.data?.source ?? "local";
  const balance = query.data?.balance ?? readLocal().balance;
  const allowance = query.data?.allowance ?? WEEKLY_COIN_ALLOWANCE;

  const move = useCallback(
    async (fn: "spend_coins" | "refund_coins", coins: number, pinId: string) => {
      if (coins <= 0) return true;
      const reason = fn === "spend_coins" ? "pin_boost" : "pin_boost_refund";
      const delta = fn === "spend_coins" ? -coins : coins;

      const patch = (next: number, src: WalletData["source"]) =>
        qc.setQueryData<WalletData>(WALLET_QUERY_KEY, (prev) => ({
          balance: next,
          allowance: prev?.allowance ?? WEEKLY_COIN_ALLOWANCE,
          resetsAt: prev?.resetsAt ?? nextResetAt().toISOString(),
          source: src,
        }));

      const applyLocally = () => {
        patch(moveLocal(delta, reason, pinId), "local");
        void qc.invalidateQueries({ queryKey: COIN_LEDGER_QUERY_KEY });
        return true;
      };

      if (source === "local") return applyLocally();

      const { data, error } = await rpc(fn, {
        p_amount: coins,
        p_reason: reason,
        p_ref_type: "pin",
        p_ref_id: pinId,
      });
      if (error) {
        // A wallet that disappears mid-session (migration rolled back) drops to
        // the local balance rather than blocking the run.
        if (isWalletMissing(error)) return applyLocally();
        return false;
      }
      if (typeof data === "number") patch(data, "server");
      void qc.invalidateQueries({ queryKey: COIN_LEDGER_QUERY_KEY });
      return true;
    },
    [source, qc],
  );

  return {
    balance,
    allowance,
    spentThisWeek: Math.max(0, allowance - balance),
    resetsAt: new Date(query.data?.resetsAt ?? nextResetAt().toISOString()),
    available: !!query.data || typeof window !== "undefined",
    provisioned: source === "server",
    isLoading: query.isPending,
    canAfford: useCallback((coins: number) => balance >= coins, [balance]),
    spendForPin: useCallback(
      (pinId: string, coins = COINS_PER_PIN_BOOST) => move("spend_coins", coins, pinId),
      [move],
    ),
    refundForPin: useCallback(
      (pinId: string, coins = COINS_PER_PIN_BOOST) => move("refund_coins", coins, pinId),
      [move],
    ),
    refetch: () => void query.refetch(),
  };
}

/** The wallet sheet's history. Separate from the balance query so opening the
 * sheet doesn't re-read the balance, and so the header pill stays cheap. */
export function useCoinLedger(enabled: boolean) {
  return useQuery({
    queryKey: COIN_LEDGER_QUERY_KEY,
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<CoinTransaction[]> => {
      const { data, error } = await ledgerTable("coin_transactions")
        .select("id, delta, balance_after, reason, ref_type, ref_id, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) {
        if (isWalletMissing(error)) return readLocal().ledger;
        throw new Error(error.message);
      }
      return data ?? [];
    },
  });
}
