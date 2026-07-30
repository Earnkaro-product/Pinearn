import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RotateCcw, X } from "lucide-react";
import { AnimatedNumber } from "@/components/health-widgets";
import { useCoinLedger, useWallet } from "@/hooks/use-wallet";
import { coinLabel, coinReasonLabel, resetCountdown } from "@/lib/coins";

// Below this the wallet turns amber and the sheet leads with the refill date — a
// creator about to run out mid-deck should find out before Apply goes dead.
const LOW_BALANCE = 10;

/** A gold coin. Drawn rather than iconified so it reads as currency at 20px — a
 * flat outline icon at this size is just a circle. */
function Coin({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`relative grid shrink-0 place-items-center rounded-full bg-[linear-gradient(145deg,#FDE9A9,#F0B429_52%,#B4740E)] shadow-[inset_0_1px_1.5px_rgba(255,255,255,0.75),inset_0_-1px_1.5px_rgba(120,53,15,0.35),0_1px_2px_rgba(146,64,14,0.3)] ${className}`}
    >
      <span className="font-display text-[0.58em] font-black leading-none text-amber-900/85">
        P
      </span>
      <span className="absolute inset-[15%] rounded-full ring-1 ring-inset ring-amber-900/15" />
    </span>
  );
}

/**
 * The header wallet — a closed billfold, shrunk to a single 30px line: dark
 * leather body, stitched edge, a gold card lip peeking over the top, and a
 * hairline meter along the bottom for what's left of the week. It reads as an
 * object you keep money in rather than as another status chip, while taking no
 * more room in the app bar than the avatar next to it.
 */
export function WalletPill() {
  const { balance, allowance } = useWallet();
  const [open, setOpen] = useState(false);

  // Flash the delta whenever the balance moves, so spending a coin is felt in the
  // header even though the tap happened at the bottom of the screen.
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<{ n: number; id: number } | null>(null);
  const flashId = useRef(0);
  useEffect(() => {
    const before = prev.current;
    prev.current = balance;
    if (before == null || before === balance) return;
    flashId.current += 1;
    setFlash({ n: balance - before, id: flashId.current });
  }, [balance]);

  const low = balance < LOW_BALANCE;
  const left = allowance > 0 ? Math.max(0, Math.min(100, (balance / allowance) * 100)) : 0;

  return (
    <>
      <motion.button
        type="button"
        whileTap={{ scale: 0.96 }}
        onClick={() => setOpen(true)}
        aria-label={`Wallet — ${coinLabel(balance)} of ${allowance} left this week, refills ${resetCountdown()}. Open wallet`}
        className="group relative h-[30px] shrink-0 overflow-hidden rounded-[10px] pl-1 pr-2 shadow-[0_2px_7px_-3px_rgba(60,32,14,0.55)]"
      >
        {/* Leather body, stitched edge, and a card lip over the top edge. */}
        <span
          aria-hidden
          className={`absolute inset-0 rounded-[10px] ${
            low
              ? "bg-[linear-gradient(160deg,#5A2A22,#33150F)]"
              : "bg-[linear-gradient(160deg,#413024,#211610)]"
          }`}
        />
        <span
          aria-hidden
          className="absolute inset-x-[7px] top-0 h-[3px] rounded-b-[2px] bg-[linear-gradient(90deg,#F6DFA4,#EFC96F_60%,#D9A83F)]"
        />
        <span
          aria-hidden
          className="absolute inset-[2.5px] rounded-[8px] border border-dashed border-amber-200/20"
        />
        {/* Hairline allowance meter. */}
        <span
          aria-hidden
          className="absolute inset-x-[6px] bottom-[3px] h-[2px] rounded-full bg-black/40"
        >
          <motion.span
            className={`block h-full rounded-full ${
              low ? "bg-[#F59E0B]" : "bg-[linear-gradient(90deg,#FDE9A9,#F0B429)]"
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(4, left)}%` }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        </span>

        <span className="relative flex h-full items-center gap-1.5">
          <Coin className="h-[17px] w-[17px]" />
          <span className="flex items-baseline gap-[2px] pb-[2px] text-[12.5px] font-extrabold leading-none tabular-nums text-amber-50">
            <AnimatedNumber value={balance} duration={0.5} />
            <span className="text-[8.5px] font-bold text-amber-200/50">/{allowance}</span>
          </span>
        </span>

        {/* Floating ±n on every balance change. */}
        <AnimatePresence>
          {flash && (
            <motion.span
              key={flash.id}
              initial={{ opacity: 0, y: 2, scale: 0.9 }}
              animate={{ opacity: [0, 1, 1, 0], y: -18, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.1, ease: "easeOut" }}
              onAnimationComplete={() => setFlash(null)}
              className={`pointer-events-none absolute -top-1 right-1 text-[11px] font-extrabold tabular-nums ${
                flash.n < 0 ? "text-primary" : "text-emerald-600"
              }`}
            >
              {flash.n > 0 ? `+${flash.n}` : flash.n}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      <AnimatePresence>{open && <WalletSheet onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

/** The wallet, open: the card with this week's balance, how much of the allowance
 * is gone, when it refills, and the receipts underneath. */
function WalletSheet({ onClose }: { onClose: () => void }) {
  const { balance, allowance, spentThisWeek, provisioned } = useWallet();
  const ledger = useCoinLedger(true);
  const low = balance < LOW_BALANCE;
  const pct = allowance > 0 ? Math.round((balance / allowance) * 100) : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-title"
    >
      <motion.div
        initial={{ y: 44, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 44, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="safe-bottom max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-4 shadow-elevate sm:rounded-3xl sm:p-5"
      >
        {/* The card inside the wallet: leather, stitching, embossed balance. It
            carries its own title and close button — a separate sheet header on top
            of a card that already says "wallet" was 44px of pure duplication. */}
        <div className="relative overflow-hidden rounded-[20px] bg-[linear-gradient(155deg,#4A3527,#241811_62%,#160D08)] p-3.5 shadow-[0_16px_36px_-18px_rgba(45,25,10,0.75)]">
          <div
            aria-hidden
            className="absolute inset-[5px] rounded-[15px] border border-dashed border-amber-200/20"
          />
          <div
            aria-hidden
            className="absolute -right-10 -top-14 h-40 w-40 rounded-full bg-amber-300/10 blur-2xl"
          />
          <div className="relative">
            <div className="flex items-center justify-between gap-2">
              <p
                id="wallet-title"
                className="text-[9.5px] font-bold uppercase tracking-[0.18em] text-amber-200/65"
              >
                Wallet · this week
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100/10 px-2 py-[3px] text-[9.5px] font-bold text-amber-100/80 ring-1 ring-inset ring-amber-200/20">
                  <RotateCcw className="h-2.5 w-2.5" /> Refills {resetCountdown()}
                </span>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close wallet"
                  className="grid h-7 w-7 place-items-center rounded-full bg-black/25 text-amber-100/70 ring-1 ring-inset ring-amber-200/15 transition hover:text-amber-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <p className="mt-2 flex items-end gap-2">
              <Coin className="mb-[3px] h-7 w-7" />
              <span className="font-display text-[38px] font-bold leading-none tabular-nums text-amber-50">
                {balance.toLocaleString()}
              </span>
              <span className="mb-[3px] text-[13px] font-bold text-amber-200/55">
                / {allowance.toLocaleString()} coins
              </span>
            </p>

            {/* How much of the allowance is left. */}
            <div className="mt-3 h-[6px] overflow-hidden rounded-full bg-black/35 ring-1 ring-inset ring-amber-200/10">
              <motion.div
                className={`h-full rounded-full ${
                  low
                    ? "bg-[linear-gradient(90deg,#F59E0B,#DC2626)]"
                    : "bg-[linear-gradient(90deg,#FDE9A9,#F0B429)]"
                }`}
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(2, pct)}%` }}
                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
            <p className="mt-1.5 text-[10px] font-semibold tabular-nums text-amber-200/65">
              {spentThisWeek.toLocaleString()} spent · 1 coin per pin boost · undo refunds
            </p>
          </div>
        </div>

        {low && (
          <p className="mt-2.5 rounded-2xl bg-amber-500/10 px-3 py-2 text-[11.5px] font-semibold leading-snug text-amber-800 ring-1 ring-inset ring-amber-500/20">
            Only {coinLabel(balance)} left — your next {allowance} arrive {resetCountdown()}.
          </p>
        )}

        {/* Says which wallet this is. A local balance is real and spendable but
            lives on this device only, so it must never be mistaken for the
            account-level one. */}
        {!provisioned && (
          <p className="mt-2.5 rounded-2xl bg-surface-2 px-3 py-2 text-[10.5px] leading-snug text-muted-foreground ring-1 ring-inset ring-border/70">
            <span className="font-bold text-foreground">On this device only</span> — apply{" "}
            <code className="text-[10px]">20260729130000_coin_wallet.sql</code> to sync it to your
            account.
          </p>
        )}

        <p className="mt-3.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Receipts
        </p>

        {ledger.isPending ? (
          <div className="mt-2 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-2xl bg-surface-2" />
            ))}
          </div>
        ) : (ledger.data?.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-[12px] text-muted-foreground">
            Nothing spent yet. Your first boost will show up here.
          </p>
        ) : (
          <ul className="mt-1.5 divide-y divide-border/60">
            {ledger.data!.map((t) => (
              <li key={t.id} className="flex items-center gap-2.5 py-2">
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-extrabold leading-none ${
                    t.delta < 0
                      ? "bg-primary/10 text-primary"
                      : "bg-emerald-500/10 text-emerald-700"
                  }`}
                >
                  {t.delta < 0 ? "−" : "+"}
                </span>
                <p className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                  {coinReasonLabel(t.reason)}
                  <span className="ml-1.5 font-medium text-muted-foreground">
                    {relativeTime(t.created_at)}
                  </span>
                </p>
                <span
                  className={`shrink-0 text-[12.5px] font-extrabold tabular-nums ${
                    t.delta < 0 ? "text-primary" : "text-emerald-700"
                  }`}
                >
                  {t.delta > 0 ? `+${t.delta}` : t.delta}
                </span>
                <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {t.balance_after.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </motion.div>
    </motion.div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
