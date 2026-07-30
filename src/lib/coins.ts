/**
 * Coin pricing for Boost.
 *
 * One coin buys one boost — applying an AI rewrite to one pin. The price lives
 * here rather than inline in the routes so the button label, the confirm sheet's
 * total, and the affordability gate can never disagree about what a run costs.
 */
export const COINS_PER_PIN_BOOST = 1;

/** Coins every creator gets each week. Mirrors wallet_weekly_allowance() in
 * 20260729130000_coin_wallet.sql — change both together. The balance RESETS to
 * this every Monday; unspent coins don't roll over. */
export const WEEKLY_COIN_ALLOWANCE = 100;

/** Cost of boosting `count` pins. */
export function boostCost(count: number): number {
  return Math.max(0, count) * COINS_PER_PIN_BOOST;
}

/** Monday 00:00 UTC of the week `at` falls in — the same boundary Postgres's
 * date_trunc('week', …) uses, so the local fallback and the server agree about
 * which week a balance belongs to. */
export function weekStartOf(at: Date = new Date()): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, 0, 0, 0));
  // getUTCDay(): 0 = Sunday, so Sunday is 6 days into the ISO week.
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
}

/** ISO date key ("2026-07-27") for the week `at` belongs to. */
export function weekKeyOf(at: Date = new Date()): string {
  return weekStartOf(at).toISOString().slice(0, 10);
}

/** When the current allowance refills. */
export function nextResetAt(at: Date = new Date()): Date {
  const next = weekStartOf(at);
  next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

/** "in 3 days" / "tomorrow" / "in 4 hours" — the countdown to the next refill. */
export function resetCountdown(at: Date = new Date()): string {
  const ms = nextResetAt(at).getTime() - at.getTime();
  const hours = Math.max(0, Math.round(ms / 3_600_000));
  if (hours < 1) return "within the hour";
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

/** "1 coin" / "12 coins" — grouped, so a five-figure balance stays readable. */
export function coinLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "coin" : "coins"}`;
}

/** Ledger reasons, matching the CHECK-free `reason` column in
 * 20260729130000_coin_wallet.sql. Kept as a union so the wallet sheet can label
 * a row without a lookup table on the server. */
export type CoinReason =
  "signup_grant" | "weekly_reset" | "pin_boost" | "pin_boost_refund" | "topup" | "adjustment";

export const COIN_REASON_LABELS: Record<CoinReason, string> = {
  signup_grant: "Welcome coins",
  weekly_reset: "Weekly refill",
  pin_boost: "Pin boosted",
  pin_boost_refund: "Boost undone — refunded",
  topup: "Top-up",
  adjustment: "Adjustment",
};

export function coinReasonLabel(reason: string): string {
  return COIN_REASON_LABELS[reason as CoinReason] ?? reason.replace(/_/g, " ");
}
