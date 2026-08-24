import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { RotateCcw, Sparkles } from "lucide-react";
import { AnimatedNumber } from "@/components/health-widgets";
import { useWallet } from "@/hooks/use-wallet";
import { coinLabel, resetCountdown } from "@/lib/coins";

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
  // Tapping the pill answers "how many left, when do they come back, what do they
  // buy" in a card the size of the pill itself — no modal, nothing deeper.
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();

  // Click-away and Escape — the card is a popover, not a modal, so it must never
  // trap the header behind it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
    <span ref={wrap} className="relative shrink-0">
      <motion.button
        type="button"
        whileTap={{ scale: 0.95 }}
        whileHover={{ y: -1 }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
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

      <AnimatePresence>{open && <WalletCard onClose={() => setOpen(false)} />}</AnimatePresence>
    </span>
  );
}

/**
 * The wallet, open — anchored under the pill rather than thrown up as a modal.
 *
 * Tapping a 90px capsule to darken the whole screen was the wrong weight for the
 * three facts a creator actually wants: how many coins are left, when they come
 * back, and what they buy. Those are one dial and two lines, so this is a small
 * card in the pill's own gold.
 */
function WalletCard({ onClose }: { onClose: () => void }) {
  const { balance, allowance, spentThisWeek } = useWallet();
  const low = balance < LOW_BALANCE;
  const pct = allowance > 0 ? Math.round((balance / allowance) * 100) : 0;

  return (
    <motion.div
      role="dialog"
      aria-label="Wallet"
      initial={{ opacity: 0, y: -6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className={`absolute right-0 top-[calc(100%+10px)] z-50 w-[236px] origin-top-right rounded-[20px] bg-gradient-to-br from-amber-50 via-surface to-surface p-3 shadow-elevate ring-1 ring-inset ${
        low ? "ring-rose-400/35" : "ring-amber-500/25"
      }`}
    >
      {/* A little beak pointing back at the pill, so the card is clearly this
          button's and not the avatar's next door. */}
      <span
        aria-hidden
        className={`absolute -top-[5px] right-5 h-2.5 w-2.5 rotate-45 rounded-[3px] border-l border-t bg-amber-50 ${
          low ? "border-rose-400/35" : "border-amber-500/25"
        }`}
      />

      <div className="flex items-center gap-3">
        <CoinDial pct={pct} low={low} size={46} coin={30} gradientId="wallet-dial-card-mini" />
        <div className="min-w-0">
          <p className="flex items-baseline gap-1 font-display leading-none">
            <span
              className={`text-[24px] font-extrabold tabular-nums ${
                low ? "text-rose-700" : "text-foreground"
              }`}
            >
              {balance.toLocaleString()}
            </span>
            <span className="text-mini font-bold text-amber-700/55">
              / {allowance.toLocaleString()}
            </span>
          </p>
          <p className="mt-1.5 text-micro font-bold uppercase tracking-[0.14em] text-amber-700/70">
            This week
            {spentThisWeek > 0 && (
              <span className="tabular-nums text-muted-foreground">
                {" · "}
                {spentThisWeek.toLocaleString()} spent
              </span>
            )}
          </p>
        </div>
      </div>

      {/* The two answers, one line each: when they come back, what they buy. */}
      <div className="mt-3 space-y-2 border-t border-amber-500/15 pt-2.5">
        <p
          className={`flex items-center gap-2 text-mini font-semibold ${
            low ? "text-rose-700" : "text-foreground/85"
          }`}
        >
          <RotateCcw
            className={`h-3.5 w-3.5 shrink-0 ${low ? "text-rose-500" : "text-amber-600"}`}
          />
          Refills {resetCountdown()}
        </p>
        <p className="flex items-center gap-2 text-mini font-semibold text-foreground/85">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-600" />1 coin = 1 pin boost
        </p>
      </div>

      {/* Reachable close for keyboards and screen readers; the visible affordance
          is tapping the pill again or anywhere else. */}
      <button type="button" onClick={onClose} className="sr-only">
        Close wallet
      </button>
    </motion.div>
  );
}
