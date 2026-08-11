import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { RotateCcw, X } from "lucide-react";
import { AppSheet } from "@/components/app-sheet";
import { AnimatedNumber } from "@/components/health-widgets";
import { useCoinLedger, useWallet } from "@/hooks/use-wallet";
import { coinLabel, coinReasonLabel, resetCountdown } from "@/lib/coins";

// Below this the wallet turns rose and the sheet leads with the refill date — a
// creator about to run out mid-deck should find out before Apply goes dead.
const LOW_BALANCE = 10;

/** A gold coin. Drawn rather than iconified so it reads as currency at 16px — a
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
 * The coin, wearing what's left of the week as a ring around it.
 *
 * This replaces a hairline bar tucked along the bottom edge of a pill: the
 * balance and its limit were two separate objects a few pixels apart, and at
 * 2px tall the bar was decoration more than a gauge. One dial is legible at a
 * glance and reads as a single thing you can tap.
 */
function CoinDial({
  pct,
  low,
  size,
  coin,
  gradientId,
  spin,
}: {
  pct: number;
  low: boolean;
  /** Outer ring diameter in px. */
  size: number;
  /** Coin diameter in px — the ring needs the difference as breathing room. */
  coin: number;
  gradientId: string;
  /** Bumped on every balance change to flip the coin once. */
  spin?: number;
}) {
  const reduce = useReducedMotion();
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 -rotate-90"
        width={size}
        height={size}
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={low ? "#FB7185" : "#FDE9A9"} />
            <stop offset="100%" stopColor={low ? "#E11D48" : "#E9A825"} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth="2.5"
          className={low ? "stroke-rose-500/15" : "stroke-amber-500/15"}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - Math.max(0.03, pct / 100)) }}
          transition={{ type: "spring", stiffness: 90, damping: 18 }}
        />
      </svg>
      {/* A spent coin flips — the one bit of theatre, and it only fires on a
          real balance change rather than looping in the corner forever. */}
      <motion.span
        key={spin}
        animate={reduce || !spin ? undefined : { rotateY: [0, 360], scale: [1, 1.14, 1] }}
        transition={{ duration: 0.62, ease: [0.22, 1, 0.36, 1] }}
        className="relative grid place-items-center"
        // fontSize drives the embossed "P" (sized in em), so it has to track the
        // coin rather than inherit whatever the surrounding text happens to be.
        style={{ width: coin, height: coin, fontSize: coin, transformStyle: "preserve-3d" }}
      >
        <Coin className="h-full w-full" />
      </motion.span>
    </span>
  );
}

/**
 * The header wallet: a gold-rimmed capsule carrying the coin dial and the
 * balance. It used to be a miniature leather billfold — stitching, a card lip,
 * the lot — which was a lovely object and the wrong one: a dark skeuomorphic
 * block in a cream editorial app bar, sitting beside a flat avatar and flat
 * icons. Same information, same footprint, in the app's own material.
 */
export function WalletPill() {
  const { balance, allowance } = useWallet();
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();

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
  const pct = allowance > 0 ? Math.max(0, Math.min(100, (balance / allowance) * 100)) : 0;

  return (
    // The capsule clips its own shine, so the floating ±n has to live outside it
    // — as a child it was silently cropped away by `overflow-hidden` and never
    // actually appeared.
    <span className="relative shrink-0">
      <motion.button
        type="button"
        whileTap={{ scale: 0.95 }}
        whileHover={{ y: -1 }}
        onClick={() => setOpen(true)}
        aria-label={`Wallet — ${coinLabel(balance)} of ${allowance} left this week, refills ${resetCountdown()}. Open wallet`}
        className={`group relative flex h-9 shrink-0 items-center gap-1.5 overflow-hidden rounded-full pl-1 pr-2.5 ring-1 ring-inset transition-colors ${
          low
            ? "bg-gradient-to-br from-rose-50 to-surface ring-rose-400/40"
            : "bg-gradient-to-br from-amber-50 to-surface ring-amber-500/30"
        } shadow-[0_2px_10px_-4px_rgba(180,120,10,0.4)]`}
      >
        {/* A slow shine crossing the capsule — the wallet is the one gold thing
            on the screen, so it's allowed to catch the light. */}
        {!reduce && (
          <span
            aria-hidden
            className="animate-sheen pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent"
          />
        )}

        <CoinDial
          pct={pct}
          low={low}
          size={26}
          coin={16}
          gradientId="wallet-dial-pill"
          spin={flash?.id ?? 0}
        />

        <span className="relative flex items-baseline gap-[2px] leading-none">
          <span
            className={`font-display text-body font-extrabold tabular-nums ${
              low ? "text-rose-700" : "text-foreground"
            }`}
          >
            <AnimatedNumber value={balance} duration={0.5} />
          </span>
          <span className={`text-nano font-bold ${low ? "text-rose-500/70" : "text-amber-700/50"}`}>
            /{allowance}
          </span>
        </span>
      </motion.button>

      {/* Floating ±n on every balance change — a coin leaving the wallet should
          be visible from wherever it was spent. */}
      <AnimatePresence>
        {flash && (
          <motion.span
            key={flash.id}
            initial={{ opacity: 0, y: 4, scale: 0.85 }}
            animate={{ opacity: [0, 1, 1, 0], y: -22, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.15, ease: "easeOut" }}
            onAnimationComplete={() => setFlash(null)}
            className={`pointer-events-none absolute -top-1 right-1.5 rounded-full bg-surface/90 px-1.5 text-mini font-extrabold tabular-nums shadow-sm ${
              flash.n < 0 ? "text-primary" : "text-emerald-600"
            }`}
          >
            {flash.n > 0 ? `+${flash.n}` : flash.n}
          </motion.span>
        )}
      </AnimatePresence>

      <AnimatePresence>{open && <WalletSheet onClose={() => setOpen(false)} />}</AnimatePresence>
    </span>
  );
}

/** The wallet, open: the card with this week's balance, how much of the allowance
 * is gone, when it refills, and the receipts underneath. */
function WalletSheet({ onClose }: { onClose: () => void }) {
  const { balance, allowance, spentThisWeek, provisioned } = useWallet();
  const ledger = useCoinLedger(true);
  const low = balance < LOW_BALANCE;
  const pct = allowance > 0 ? Math.round((balance / allowance) * 100) : 0;

  return (
    <AppSheet onClose={onClose} labelledBy="wallet-title">
      <>
        {/* The wallet, open. Same gold-on-cream material as the header capsule,
            scaled up — the dial becomes the hero and carries the week's balance
            in its middle, so the card needs no separate meter. It keeps its own
            close button: a sheet header on top of a card that already says
            "wallet" was 44px of pure duplication. */}
        <div className="relative overflow-hidden rounded-[22px] bg-gradient-to-br from-amber-50 via-surface to-surface p-4 ring-1 ring-inset ring-amber-500/25">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-amber-300/25 blur-3xl"
          />
          <div className="relative flex items-center gap-4">
            <CoinDial pct={pct} low={low} size={70} coin={46} gradientId="wallet-dial-card" />

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p
                  id="wallet-title"
                  className="text-micro font-bold uppercase tracking-[0.18em] text-amber-700/70"
                >
                  Wallet · this week
                </p>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close wallet"
                  className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-amber-800/50 transition hover:bg-amber-500/10 hover:text-amber-900"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <p className="mt-1 flex items-baseline gap-1.5">
                <span
                  className={`font-display text-[34px] font-extrabold leading-none tabular-nums ${
                    low ? "text-rose-700" : "text-foreground"
                  }`}
                >
                  {balance.toLocaleString()}
                </span>
                <span className="text-body font-bold text-amber-700/55">
                  / {allowance.toLocaleString()}
                </span>
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-[3px] text-micro font-bold text-amber-800/80 ring-1 ring-inset ring-amber-500/25">
                  <RotateCcw className="h-2.5 w-2.5" /> Refills {resetCountdown()}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-[3px] text-micro font-bold tabular-nums text-muted-foreground ring-1 ring-inset ring-border">
                  {spentThisWeek.toLocaleString()} spent
                </span>
              </div>
            </div>
          </div>

          <p className="relative mt-3 text-micro font-semibold text-muted-foreground">
            1 coin per pin boost · undo refunds it
          </p>
        </div>

        {low && (
          <p className="mt-2.5 rounded-2xl bg-rose-500/10 px-3 py-2 text-mini font-semibold leading-snug text-rose-800 ring-1 ring-inset ring-rose-500/20">
            Only {coinLabel(balance)} left — your next {allowance} arrive {resetCountdown()}.
          </p>
        )}

        {/* Says which wallet this is. A local balance is real and spendable but
            lives on this device only, so it must never be mistaken for the
            account-level one. */}
        {!provisioned && (
          <p className="mt-2.5 rounded-2xl bg-surface-2 px-3 py-2 text-micro leading-snug text-muted-foreground ring-1 ring-inset ring-border/70">
            <span className="font-bold text-foreground">On this device only</span> — apply{" "}
            <code className="text-micro">20260729130000_coin_wallet.sql</code> to sync it to your
            account.
          </p>
        )}

        <p className="mt-3.5 text-micro font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Receipts
        </p>

        {ledger.isPending ? (
          <div className="mt-2 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-2xl bg-surface-2" />
            ))}
          </div>
        ) : (ledger.data?.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nothing spent yet. Your first boost will show up here.
          </p>
        ) : (
          <ul className="mt-1.5 divide-y divide-border/60">
            {ledger.data!.map((t) => (
              <li key={t.id} className="flex items-center gap-2.5 py-2">
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-mini font-extrabold leading-none ${
                    t.delta < 0
                      ? "bg-primary/10 text-primary"
                      : "bg-emerald-500/10 text-emerald-700"
                  }`}
                >
                  {t.delta < 0 ? "−" : "+"}
                </span>
                <p className="min-w-0 flex-1 truncate text-xs font-semibold">
                  {coinReasonLabel(t.reason)}
                  <span className="ml-1.5 font-medium text-muted-foreground">
                    {relativeTime(t.created_at)}
                  </span>
                </p>
                <span
                  className={`shrink-0 text-xs font-extrabold tabular-nums ${
                    t.delta < 0 ? "text-primary" : "text-emerald-700"
                  }`}
                >
                  {t.delta > 0 ? `+${t.delta}` : t.delta}
                </span>
                <span className="w-9 shrink-0 text-right text-micro tabular-nums text-muted-foreground">
                  {t.balance_after.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </>
    </AppSheet>
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
