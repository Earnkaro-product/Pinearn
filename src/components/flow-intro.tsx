import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Coins,
  EyeOff,
  Gauge,
  ImagePlus,
  IndianRupee,
  LayoutGrid,
  Link2,
  MousePointerClick,
  PencilLine,
  Pin,
  Search,
  Share2,
  Sparkles,
  Store,
  Tags,
  TrendingUp,
  Type,
  Unlink,
  Upload,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";

// The contextual education that runs at the top of every major flow, in place
// of the single activation modal that used to fire straight after onboarding.
// That modal said the same thing whichever flow you were headed into, and it
// pushed an action before the creator had seen anything.
//
// Each flow is a short run of screens as a phone-format page rather than a card
// or a dialog: one idea per screen, an animated picture doing most of the
// explaining, and Skip always reachable in the top-right. Screens are inert;
// nothing is committed until the last one.
//
// Most flows run three screens — the value, the workflow, then the ask.
// monetize-pin runs four, one per step of the flow it explains (select a pin →
// AI finds products → review them → make the pin live), because that flow is
// the one creators arrive at first and the one where "what happens to my Pin"
// has to be answered before they start.
//
// The shell here owns all the chrome (dots, back, skip, the advance button,
// the ambient aurora) so the flows can't drift apart visually. A flow
// contributes only its screens and the label on its final button.
//
// Gating differs by flow on purpose:
//   - monetize-pin / create-pin / store  -> once per browser, via useFlowIntro
//   - pinterest-seo                      -> once per session, because the
//     score scan it leads into is itself session-gated (see boost.tsx)

/* ================================================================ shared == */

const EASE = [0.22, 1, 0.36, 1] as const;

// Staggered child reveal, shared by every screen's copy block.
const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.2 } },
};
const rise: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
};

/**
 * Index that walks 0..steps-1 on a loop, for the art that demonstrates itself.
 * Frozen at the final step under reduced motion, so those screens still show
 * their finished state rather than an empty one.
 */
function useLoop(steps: number, ms: number, reduce: boolean) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setI((n) => (n + 1) % steps), ms);
    return () => clearInterval(t);
  }, [steps, ms, reduce]);
  return reduce ? steps - 1 : i;
}

/** A number that counts up to `to` once, on mount. */
function CountUp({ to, prefix = "", reduce }: { to: number; prefix?: string; reduce: boolean }) {
  const [n, setN] = useState(reduce ? to : 0);
  useEffect(() => {
    if (reduce) return setN(to);
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 1100);
      // Ease-out so it decelerates into the final number instead of stopping.
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, reduce]);
  return (
    <>
      {prefix}
      {n.toLocaleString("en-IN")}
    </>
  );
}

/** The mini Pin used as a prop across several screens. */
function PinCard({
  className = "",
  tint = "from-rose-200/80 via-amber-100 to-rose-100",
  dim = false,
}: {
  className?: string;
  tint?: string;
  dim?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-border bg-surface shadow-elevate ${className}`}
    >
      <div className={`h-2/3 bg-gradient-to-br ${tint}`} />
      <div className="space-y-1.5 p-2.5">
        <div className="h-2 w-4/5 rounded-full bg-border" />
        <div className="h-2 w-3/5 rounded-full bg-border/70" />
      </div>
      {dim && <div className="absolute inset-0 bg-background/50 backdrop-blur-[1px]" />}
    </div>
  );
}

/** A small labelled chip standing in for a product. */
function ProductChip({ label, tint }: { label: string; tint: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-2.5 py-2 shadow-sm">
      <span className={`h-6 w-6 shrink-0 rounded-md bg-gradient-to-br ${tint}`} />
      <span className="text-mini font-semibold leading-none">{label}</span>
    </div>
  );
}

/** Chip row used under the copy on several screens. */
function ChipGrid({
  items,
  cols,
  lit,
}: {
  items: { icon: LucideIcon; label: string; tint?: string }[];
  cols: 2 | 3;
  /** Count of chips lit from the left; omit to light them all. */
  lit?: number;
}) {
  return (
    <div
      className={`mx-auto mt-6 grid max-w-xs gap-2 ${cols === 2 ? "grid-cols-2" : "grid-cols-3"}`}
    >
      {items.map((it, i) => {
        const on = lit === undefined || i < lit;
        return cols === 2 ? (
          <div
            key={it.label}
            className="flex items-center gap-2 rounded-2xl border border-border bg-surface/80 px-3 py-2.5 text-left"
          >
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${it.tint ?? "bg-primary/10 text-primary"}`}
            >
              <it.icon className="h-3.5 w-3.5" />
            </span>
            <span className="text-xs font-semibold leading-tight">{it.label}</span>
          </div>
        ) : (
          <div
            key={it.label}
            className={`flex flex-col items-center gap-1.5 rounded-2xl border px-2 py-3 transition-all duration-500 ${
              on
                ? "border-primary/30 bg-primary/5 shadow-[0_0_16px_-6px_var(--color-primary)]"
                : "border-border bg-surface/80"
            }`}
          >
            <it.icon
              className={`h-4 w-4 transition-colors duration-500 ${on ? "text-primary" : "text-muted-foreground/60"}`}
            />
            <span
              className={`text-mini font-semibold transition-colors duration-500 ${on ? "text-foreground" : "text-muted-foreground"}`}
            >
              {it.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ======================================================= monetize a Pin == */

// Screen 1 — the Pins already earn attention; the attention has nowhere to go.
function MonetizeReachArt({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative mx-auto h-44 w-56">
      <PinCard className="absolute left-1/2 top-2 h-40 w-28 -translate-x-1/2" />

      {/* Impressions, climbing — the value that already exists. */}
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 0.5, duration: 0.5, ease: EASE }}
        className="absolute -right-1 top-5 flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1.5 shadow-elevate"
      >
        <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
        <span className="text-mini font-bold tabular-nums">
          <CountUp to={2480} reduce={reduce} />
        </span>
      </motion.div>

      {/* …and the dead end it runs into. */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.9, duration: 0.5, ease: EASE }}
        className="absolute -left-2 bottom-4 flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1.5 shadow-elevate"
      >
        <span className="relative grid h-4 w-4 place-items-center">
          {!reduce && (
            <span className="absolute inset-0 animate-ping rounded-full bg-muted-foreground/20 [animation-duration:2.2s]" />
          )}
          <Unlink className="relative h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <span className="text-mini font-bold text-muted-foreground">No link</span>
      </motion.div>
    </div>
  );
}

// Screen 2 — the whole job, on a loop: pick, attach, done.
function MonetizeAttachArt({ reduce }: { reduce: boolean }) {
  // 0 apart · 1 linking · 2 linked
  const step = useLoop(3, 1100, reduce);
  return (
    <div className="relative mx-auto flex h-44 w-64 items-center justify-between px-1">
      <motion.div
        animate={{ x: step === 0 ? 0 : 6 }}
        transition={{ duration: 0.6, ease: EASE }}
        className="relative"
      >
        <PinCard className="h-36 w-24" />
        {step === 0 && (
          <motion.span
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute -right-2 -top-2 grid h-7 w-7 place-items-center rounded-full bg-foreground text-background shadow-elevate"
          >
            <MousePointerClick className="h-3.5 w-3.5" />
          </motion.span>
        )}
      </motion.div>

      {/* The link forming. The dots travel only while it's being made. */}
      <div className="relative mx-1 h-10 flex-1">
        <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 border-t border-dashed border-border" />
        <AnimatePresence>
          {step >= 1 && (
            <motion.span
              key="badge"
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.4 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="absolute left-1/2 top-1/2 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-gradient-primary text-primary-foreground shadow-glow"
            >
              {step === 2 ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <motion.div
        animate={{ x: step === 0 ? 0 : -6 }}
        transition={{ duration: 0.6, ease: EASE }}
        className="w-[5.5rem] space-y-1.5"
      >
        <ProductChip label="Kurta" tint="from-rose-300 to-orange-200" />
        <ProductChip label="Lamp" tint="from-amber-300 to-rose-200" />
      </motion.div>
    </div>
  );
}

// Screen 3 — the review beat. Each match is judged one at a time, and one of
// them is dropped: that rejection is the point of the picture. Nothing reaches
// the Pin that the creator hasn't kept.
function MonetizeVerifyArt({ reduce }: { reduce: boolean }) {
  const rows = [
    { label: "Kurta", tint: "from-rose-300 to-orange-200", keep: true },
    { label: "Mug", tint: "from-sky-300 to-indigo-200", keep: false },
    { label: "Lamp", tint: "from-amber-300 to-rose-200", keep: true },
  ];
  // How many rows have been judged. Reduced motion shows the settled result
  // rather than animating through it.
  const judged = useLoop(rows.length + 1, 900, reduce);

  return (
    <div className="relative mx-auto grid h-44 w-56 content-center gap-2">
      {rows.map((r, i) => {
        const done = reduce || i < judged;
        return (
          <motion.div
            key={r.label}
            animate={{ opacity: done && !r.keep ? 0.45 : 1, x: done && !r.keep ? -8 : 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="flex items-center gap-2.5 rounded-2xl border border-border bg-surface px-3 py-2.5 shadow-sm"
          >
            <span className={`h-7 w-7 shrink-0 rounded-lg bg-gradient-to-br ${r.tint}`} />
            <span className="text-xs font-semibold leading-none">{r.label}</span>
            <AnimatePresence>
              {done && (
                <motion.span
                  key="verdict"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 420, damping: 18 }}
                  className={`ml-auto grid h-6 w-6 place-items-center rounded-full ${
                    r.keep
                      ? "bg-emerald-500 text-white"
                      : "bg-surface-2 text-muted-foreground ring-1 ring-border"
                  }`}
                >
                  {r.keep ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}

// Screen 4 — where the shoppable link actually lands, drawn rather than
// screenshotted so it stays correct in both themes and at any width. The
// earnings badge alongside is the payoff the link buys.
function MonetizeLinkArt({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative mx-auto w-full max-w-[13rem]">
      <div className="overflow-hidden rounded-3xl border border-border bg-surface shadow-elevate">
        <div className="relative aspect-[4/5] bg-gradient-to-br from-rose-400 via-rose-300 to-amber-200">
          {/* Stand-in for the Pin's own image — deliberately abstract, so it
              reads as "your Pin" rather than as one specific Pin. */}
          <div className="absolute inset-x-4 top-4 space-y-1.5">
            <div className="h-1.5 w-2/3 rounded-full bg-white/50" />
            <div className="h-1.5 w-1/3 rounded-full bg-white/35" />
          </div>

          {/* The shoppable link, exactly where it appears on a live Pin. */}
          <div className="absolute inset-x-3 bottom-3">
            <div className="relative">
              {!reduce && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 animate-ping rounded-full bg-white/40"
                />
              )}
              <div className="relative flex items-center gap-2 rounded-full bg-white/95 px-3 py-2 shadow-glow ring-2 ring-primary">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Link2 className="h-3 w-3" />
                </span>
                <span className="truncate text-mini font-bold text-neutral-900">
                  Shop this look
                </span>
                <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />
              </div>
            </div>
          </div>
        </div>

        {/* Pin title/board rows, greyed — context for the chip above. */}
        <div className="space-y-1.5 px-3 py-3">
          <div className="h-2 w-3/4 rounded-full bg-surface-2" />
          <div className="h-2 w-1/2 rounded-full bg-surface-2" />
        </div>
      </div>

      {/* Earnings, counting up beside the Pin that produced them. */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8, x: 10 }}
        animate={{ opacity: 1, scale: 1, x: 0 }}
        transition={{ delay: 0.7, duration: 0.5, ease: EASE }}
        className="absolute -right-3 top-6 flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1.5 shadow-elevate"
      >
        <IndianRupee className="h-3 w-3 text-emerald-600" strokeWidth={3} />
        <span className="text-mini font-bold tabular-nums">
          <CountUp to={4820} reduce={reduce} />
        </span>
      </motion.div>
    </div>
  );
}

/* ========================================================= create a Pin == */

// Screen 1 — it starts with one photo, and that's the only thing you supply.
function CreateImageArt({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative mx-auto grid h-44 w-56 place-items-center">
      {/* The drop target, which the photo then lands into. */}
      <div className="absolute inset-x-10 inset-y-2 rounded-3xl border-2 border-dashed border-border" />
      <motion.div
        initial={{ opacity: 0, y: -28, rotate: -6, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
        transition={{ delay: 0.35, duration: 0.7, ease: EASE }}
        className="relative h-40 w-28 overflow-hidden rounded-2xl border border-border shadow-elevate"
      >
        <div className="h-full w-full bg-gradient-to-br from-rose-300 via-amber-200 to-orange-200" />
        {/* Sheen sweeping across — reads as "processing", not decoration. */}
        {!reduce && (
          <motion.span
            className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/55 to-transparent"
            initial={{ x: "-150%" }}
            animate={{ x: "250%" }}
            transition={{ duration: 1.9, repeat: Infinity, repeatDelay: 1.1, ease: "easeInOut" }}
          />
        )}
      </motion.div>

      <motion.span
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.95, duration: 0.45, ease: EASE }}
        className="absolute bottom-3 right-6 grid h-10 w-10 place-items-center rounded-full bg-gradient-primary text-primary-foreground shadow-glow"
      >
        <Upload className="h-4 w-4" />
      </motion.span>
    </div>
  );
}

// Screen 2 — the AI writing the Pin. Lines fill in, then keywords land.
function CreateCopyArt({ reduce }: { reduce: boolean }) {
  // 0 blank · 1 title · 2 description · 3 keywords
  const step = useLoop(4, 900, reduce);
  const LINES = ["72%", "94%", "60%"];
  return (
    <div className="relative mx-auto grid h-44 w-56 place-items-center">
      <div className="w-52 rounded-2xl border border-border bg-surface p-4 shadow-elevate">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-primary text-primary-foreground shadow-glow">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          {/* The title line, typing itself. */}
          <motion.span
            className="h-2.5 rounded-full bg-foreground/80"
            animate={{ width: step >= 1 ? "70%" : "0%" }}
            transition={{ duration: 0.55, ease: EASE }}
          />
        </div>

        <div className="mt-3 space-y-2">
          {LINES.map((w, i) => (
            <motion.span
              key={i}
              className="block h-2 rounded-full bg-border"
              animate={{ width: step >= 2 ? w : "0%" }}
              transition={{ duration: 0.5, delay: i * 0.12, ease: EASE }}
            />
          ))}
        </div>

        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {["#decor", "#festive", "#gifting"].map((k, i) => (
            <motion.span
              key={k}
              className="rounded-full bg-primary/10 px-2 py-1 text-micro font-bold text-primary"
              animate={{
                opacity: step >= 3 ? 1 : 0,
                scale: step >= 3 ? 1 : 0.7,
              }}
              transition={{ duration: 0.32, delay: i * 0.09, ease: EASE }}
            >
              {k}
            </motion.span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Screen 3 — products dock to the Pin before it is published, not after.
function CreateShoppableArt({ reduce }: { reduce: boolean }) {
  // 0 bare · 1-3 chips docking · 4 live
  const step = useLoop(5, 700, reduce);
  return (
    <div className="relative mx-auto h-44 w-60">
      <PinCard className="absolute left-3 top-2 h-40 w-28" />

      <div className="absolute right-0 top-5 w-[6.5rem] space-y-1.5">
        {[
          { label: "Saree", tint: "from-rose-300 to-pink-200" },
          { label: "Diya set", tint: "from-amber-300 to-orange-200" },
          { label: "Vase", tint: "from-orange-300 to-rose-200" },
        ].map((p, i) => (
          <motion.div
            key={p.label}
            animate={{
              opacity: step >= i + 1 ? 1 : 0.25,
              x: step >= i + 1 ? 0 : 18,
            }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            <ProductChip label={p.label} tint={p.tint} />
          </motion.div>
        ))}
      </div>

      <AnimatePresence>
        {step === 4 && (
          <motion.span
            initial={{ opacity: 0, scale: 0.6, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="absolute bottom-1 left-1 flex items-center gap-1.5 rounded-full bg-gradient-primary px-3 py-1.5 text-micro font-bold uppercase tracking-wide text-primary-foreground shadow-glow"
          >
            <Check className="h-3 w-3" strokeWidth={3} /> Live
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ============================================================== my store == */

/** The phone the store screens are staged inside. */
function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-44 w-[6.75rem] overflow-hidden rounded-[1.4rem] border-[3px] border-foreground/85 bg-surface shadow-elevate">
      <span className="absolute left-1/2 top-1.5 z-10 h-1 w-8 -translate-x-1/2 rounded-full bg-foreground/85" />
      <div className="h-full w-full px-1.5 pb-1.5 pt-4">{children}</div>
    </div>
  );
}

// Screen 1 — scattered links collecting themselves into one page.
function StoreCollectArt({ reduce }: { reduce: boolean }) {
  const TILES = [
    "from-rose-300 to-orange-200",
    "from-amber-300 to-rose-200",
    "from-orange-300 to-pink-200",
    "from-pink-300 to-rose-200",
    "from-rose-400 to-amber-200",
    "from-amber-400 to-orange-200",
  ];
  // Where each tile flies in from — outside the phone, all four directions.
  const FROM = [
    { x: -70, y: -30 },
    { x: 70, y: -34 },
    { x: -78, y: 10 },
    { x: 76, y: 16 },
    { x: -60, y: 48 },
    { x: 66, y: 52 },
  ];
  return (
    <div className="relative mx-auto grid h-44 w-56 place-items-center">
      <PhoneFrame>
        <div className="grid grid-cols-2 gap-1.5">
          {TILES.map((t, i) => (
            <motion.span
              key={i}
              className={`block h-9 rounded-lg bg-gradient-to-br ${t}`}
              initial={reduce ? { opacity: 1 } : { opacity: 0, ...FROM[i], scale: 0.6 }}
              animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
              transition={{ delay: 0.3 + i * 0.11, duration: 0.62, ease: EASE }}
            />
          ))}
        </div>
      </PhoneFrame>
    </div>
  );
}

// Screen 2 — the same tiles, sorted. Collections are the organising idea.
function StoreCollectionsArt({ reduce }: { reduce: boolean }) {
  const lit = useLoop(4, 850, reduce);
  const GROUPS = [
    { name: "Festive", tints: ["from-rose-300 to-orange-200", "from-amber-300 to-rose-200"] },
    { name: "Home", tints: ["from-orange-300 to-pink-200", "from-pink-300 to-rose-200"] },
    { name: "Beauty", tints: ["from-rose-400 to-amber-200", "from-amber-400 to-orange-200"] },
  ];
  return (
    <div className="mx-auto flex h-44 w-60 flex-col justify-center gap-2">
      {GROUPS.map((g, i) => {
        const on = lit > i;
        return (
          <motion.div
            key={g.name}
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.25 + i * 0.12, duration: 0.5, ease: EASE }}
            className={`flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 transition-colors duration-500 ${
              on ? "border-primary/30 bg-primary/5" : "border-border bg-surface/80"
            }`}
          >
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors duration-500 ${
                on ? "bg-primary text-primary-foreground" : "bg-surface-2 text-muted-foreground"
              }`}
            >
              <Tags className="h-3.5 w-3.5" />
            </span>
            <span className="text-xs font-semibold">{g.name}</span>
            <span className="ml-auto flex gap-1">
              {g.tints.map((t, j) => (
                <motion.span
                  key={j}
                  className={`block h-6 w-6 rounded-md bg-gradient-to-br ${t}`}
                  animate={{ scale: on ? 1 : 0.72, opacity: on ? 1 : 0.4 }}
                  transition={{ duration: 0.4, delay: j * 0.07, ease: EASE }}
                />
              ))}
            </span>
          </motion.div>
        );
      })}
    </div>
  );
}

// Screen 3 — one link, out in the world, with taps coming back.
function StoreShareArt({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative mx-auto grid h-44 w-56 place-items-center">
      {!reduce && (
        <>
          <span className="absolute inset-x-8 inset-y-3 animate-ping rounded-[2rem] bg-primary/10 [animation-duration:2.6s]" />
          <span className="absolute inset-x-14 inset-y-10 animate-ping rounded-[2rem] bg-primary/15 [animation-duration:2.6s] [animation-delay:0.8s]" />
        </>
      )}

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.55, ease: EASE }}
        className="relative"
      >
        <PhoneFrame>
          <div className="flex h-full flex-col items-center">
            <span className="h-7 w-7 rounded-full bg-gradient-primary" />
            <span className="mt-1.5 h-1.5 w-12 rounded-full bg-border" />
            <div className="mt-2 grid w-full grid-cols-2 gap-1">
              {["from-rose-300 to-orange-200", "from-amber-300 to-rose-200"].map((t, i) => (
                <span key={i} className={`block h-8 rounded-md bg-gradient-to-br ${t}`} />
              ))}
            </div>
            <span className="mt-auto flex w-full items-center justify-center gap-1 rounded-full bg-foreground py-1 text-micro font-bold text-background">
              <Share2 className="h-2.5 w-2.5" /> Share
            </span>
          </div>
        </PhoneFrame>
      </motion.div>

      {/* The single link, floating alongside. */}
      <motion.div
        initial={{ opacity: 0, y: 10, x: 8 }}
        animate={{ opacity: 1, y: 0, x: 0 }}
        transition={{ delay: 0.6, duration: 0.5, ease: EASE }}
        className="absolute right-0 top-6 flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1.5 shadow-elevate"
      >
        <Link2 className="h-3.5 w-3.5 text-primary" />
        <span className="text-micro font-bold">one link</span>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: -10, x: -8 }}
        animate={{ opacity: 1, y: 0, x: 0 }}
        transition={{ delay: 0.85, duration: 0.5, ease: EASE }}
        className="absolute bottom-6 left-0 flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1.5 shadow-elevate"
      >
        <MousePointerClick className="h-3.5 w-3.5 text-emerald-600" />
        <span className="text-micro font-bold tabular-nums">
          <CountUp to={318} reduce={reduce} /> taps
        </span>
      </motion.div>
    </div>
  );
}

/* ========================================================= Pinterest SEO == */

// Screen 1 — a good Pin, buried. Two ghost cards behind it read as "the
// thousands it competes with"; the eye-off badge says what happens.
function SeoBuriedArt() {
  return (
    <div className="relative mx-auto h-44 w-32">
      <div className="absolute inset-x-0 top-2 h-40 -rotate-6 rounded-2xl border border-border bg-surface-2/80" />
      <div className="absolute inset-x-0 top-2 h-40 rotate-3 rounded-2xl border border-border bg-surface-2" />
      <PinCard
        className="absolute inset-x-0 top-2 h-40"
        dim
        tint="from-rose-200/80 via-amber-100 to-rose-100"
      />
      <div className="absolute -right-3 top-0 grid h-9 w-9 place-items-center rounded-full border border-border bg-surface text-muted-foreground shadow-elevate">
        <EyeOff className="h-4 w-4" />
      </div>
    </div>
  );
}

// The funnel the creator is leaking: each stage names what better SEO buys.
const SEO_FUNNEL = [
  { icon: Search, label: "Better discovery", tint: "bg-primary/10 text-primary" },
  { icon: TrendingUp, label: "More reach", tint: "bg-amber-500/10 text-amber-600" },
  { icon: MousePointerClick, label: "More clicks", tint: "bg-rose-500/10 text-rose-600" },
  { icon: IndianRupee, label: "More earnings", tint: "bg-emerald-500/10 text-emerald-600" },
];

// Screen 2 — the engine. Breathing rings around a sparkle, matching the
// analyzer's centre badge so the scan feels like this, running.
function SeoAiArt({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative mx-auto grid h-44 w-32 place-items-center">
      {!reduce && (
        <>
          <span className="absolute inset-x-0 inset-y-6 animate-ping rounded-full bg-primary/10 [animation-duration:2.6s]" />
          <span className="absolute inset-x-4 inset-y-10 animate-ping rounded-full bg-primary/15 [animation-duration:2.6s] [animation-delay:0.6s]" />
        </>
      )}
      <span className="absolute inset-x-7 inset-y-13 rounded-full border border-primary/20" />
      <div className="relative grid h-16 w-16 place-items-center rounded-full bg-gradient-primary text-primary-foreground shadow-glow">
        <Sparkles className="h-7 w-7" />
      </div>
    </div>
  );
}

// Everything the engine touches, lighting up in sequence.
const SEO_TARGETS = [
  { icon: Pin, label: "Pins" },
  { icon: LayoutGrid, label: "Boards" },
  { icon: UserCheck, label: "Profile" },
  { icon: Type, label: "Titles" },
  { icon: PencilLine, label: "Descriptions" },
  { icon: Tags, label: "Keywords" },
];

function SeoTargets({ reduce }: { reduce: boolean }) {
  // Two extra steps so the row rests fully lit before starting over.
  const lit = useLoop(SEO_TARGETS.length + 2, 700, reduce);
  return <ChipGrid items={SEO_TARGETS} cols={3} lit={reduce ? SEO_TARGETS.length : lit} />;
}

// Screen 3 — a gauge with no number yet. The score exists; they haven't looked.
function SeoGaugeArt() {
  const R = 62;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative mx-auto grid h-44 w-36 place-items-center">
      <svg viewBox="0 0 144 144" className="absolute inset-x-0 h-36 w-36 -rotate-90">
        <circle cx="72" cy="72" r={R} fill="none" strokeWidth="8" className="stroke-border/50" />
        <motion.circle
          cx="72"
          cy="72"
          r={R}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={C}
          initial={{ strokeDashoffset: C }}
          animate={{ strokeDashoffset: C * 0.35 }}
          transition={{ duration: 1.1, ease: EASE, delay: 0.4 }}
        />
      </svg>
      <div className="grid place-items-center">
        <Gauge className="h-7 w-7 text-primary" />
        <span className="mt-1 font-display text-2xl font-bold text-muted-foreground/50">?</span>
      </div>
    </div>
  );
}

/* ============================================================== registry == */

export type IntroFlow = "monetize-pin" | "create-pin" | "store" | "pinterest-seo";

type Screen = {
  /**
   * Rendered as a COMPONENT (`<Art reduce={…} />`), never called as a function.
   * Most arts run a `useLoop` and screen 1's arts don't, so calling them inline
   * registered a different number of hooks on FlowIntro per screen and React
   * threw on the first Next. As components they own their own hooks and reset
   * cleanly each time a screen mounts.
   */
  art: (p: { reduce: boolean }) => ReactNode;
  headline: string;
  body: string;
  /** Optional block under the copy — a chip row that expands on the body. */
  extra?: (p: { reduce: boolean }) => ReactNode;
};

type FlowDef = {
  /** Label on the final screen's button — always a verb, never "Done". */
  ctaLabel: string;
  /** Three for most flows, four for monetize-pin (one per step). */
  screens: Screen[];
};

const FLOWS: Record<IntroFlow, FlowDef> = {
  // Four screens, one per step of the flow, in the order the creator will meet
  // them — so the education is a map of what is about to happen rather than a
  // pitch for it. The last screen is the one that matters most: it shows where
  // the shoppable link ends up on the Pin.
  "monetize-pin": {
    ctaLabel: "Let's go",
    screens: [
      {
        art: MonetizeReachArt,
        headline: "1. Select a pin",
        body: "Start with a Pin you've already posted. The ones already getting views have the most to gain — they just have nowhere to send anyone yet.",
      },
      {
        art: MonetizeAttachArt,
        headline: "2. AI finds relevant products",
        body: "We read the image and match real products from stores that pay you a commission. No searching, no pasting links.",
      },
      {
        art: MonetizeVerifyArt,
        headline: "3. Review and verify products",
        body: "Keep the matches that fit, drop the ones that don't. Nothing is attached to your Pin until you've approved it.",
      },
      {
        art: MonetizeLinkArt,
        headline: "4. Make the pin live",
        body: "The Pin gains a shoppable link — one tap takes a shopper to the product, and you earn when they buy. Nothing is re-published, and nothing is deleted.",
        extra: () => (
          <ChipGrid
            cols={2}
            items={[
              { icon: MousePointerClick, label: "Tracked clicks" },
              {
                icon: Coins,
                label: "Live earnings",
                tint: "bg-emerald-500/10 text-emerald-600",
              },
            ]}
          />
        ),
      },
    ],
  },

  "create-pin": {
    ctaLabel: "Start my Pin",
    screens: [
      {
        art: CreateImageArt,
        headline: "You bring one image",
        body: "A photo or a reel is the whole input. Everything a Pin needs after that gets drafted for you.",
      },
      {
        art: CreateCopyArt,
        headline: "The AI writes the rest",
        body: "Title, description and keywords, tuned for Pinterest search. You see all of it before anything is published.",
      },
      {
        art: CreateShoppableArt,
        headline: "Shoppable before it's live",
        body: "Attach your products in the same run, so the Pin can earn from its very first impression.",
        extra: () => (
          <ChipGrid
            cols={3}
            items={[
              { icon: ImagePlus, label: "Image" },
              { icon: Sparkles, label: "AI copy" },
              { icon: Link2, label: "Products" },
            ]}
          />
        ),
      },
    ],
  },

  store: {
    ctaLabel: "Open my store",
    screens: [
      {
        art: StoreCollectArt,
        headline: "My Store is your digital shop",
        body: "It's your own shop on the internet, at your own link. Each product you link lands in it automatically — nothing to re-add, nothing to keep in a notes app.",
      },
      {
        art: StoreCollectionsArt,
        headline: "Grouped how you shop",
        body: "Sort products into collections so a follower looking for one thing isn't scrolling past everything else.",
      },
      {
        art: StoreShareArt,
        headline: "Share one link, anywhere",
        body: "Your Pinterest bio, a story, a DM. One address that always shows your latest picks — and counts every tap.",
        extra: () => (
          <ChipGrid
            cols={2}
            items={[
              { icon: Store, label: "Always current" },
              {
                icon: MousePointerClick,
                label: "Tap tracking",
                tint: "bg-emerald-500/10 text-emerald-600",
              },
            ]}
          />
        ),
      },
    ],
  },

  "pinterest-seo": {
    ctaLabel: "Check my SEO score",
    screens: [
      {
        art: SeoBuriedArt,
        headline: "Great Pins get buried",
        body: "Weak titles, keywords and boards keep your best Pins out of Pinterest search.",
        extra: () => <ChipGrid items={SEO_FUNNEL} cols={2} />,
      },
      {
        art: SeoAiArt,
        headline: "AI that tunes everything",
        body: "It rewrites, re-keywords and reorganizes your whole Pinterest — automatically.",
        extra: SeoTargets,
      },
      {
        art: SeoGaugeArt,
        headline: "Your score is waiting",
        body: "See exactly what's holding your Pinterest growth back.",
      },
    ],
  },
};

/* ================================================================= shell == */

/**
 * The three-screen intro itself, laid out as a phone-width column. Layout
 * neutral on purpose: `boost` renders it inline where its own content would
 * go, while the other flows hand it to `FlowIntroGate` to fill the screen.
 *
 * Always visible while mounted — the caller decides whether it should be.
 * `onDone` fires on Skip and on the final button alike; the two are the same
 * action, so nothing is committed by reaching the end.
 */
export function FlowIntro({ flow, onDone }: { flow: IntroFlow; onDone: () => void }) {
  const reduce = !!useReducedMotion();
  const [step, setStep] = useState(0);
  const def = FLOWS[flow];
  const screen = def.screens[step];
  const last = step === def.screens.length - 1;
  // Capitalised so JSX treats them as components — see the `Screen.art` docs.
  const Art = screen.art;
  const Extra = screen.extra;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.25 } }}
      className="relative mx-auto w-full max-w-[26rem] px-5 pb-8 pt-6"
    >
      {/* Ambient aurora — the same three blobs the analyzer uses, so the
          education and the work it leads into look like one place. */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="animate-blob absolute left-2 top-6 h-48 w-48 rounded-full bg-primary/15 blur-3xl" />
        <div className="animate-blob-delay-2 absolute -right-6 top-24 h-40 w-40 rounded-full bg-rose-400/15 blur-3xl" />
        <div className="animate-blob-delay-4 absolute bottom-0 left-1/3 h-40 w-40 rounded-full bg-amber-300/15 blur-3xl" />
      </div>

      {/* Back · dots · skip. Back is icon-only and absent on the first screen
          (the dots already say where you are); Skip is absent on the last,
          where the primary button does the same thing. */}
      <div className="relative mb-6 flex h-9 items-center justify-center">
        {step > 0 && (
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            aria-label="Back"
            className="absolute left-0 grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <div className="flex items-center gap-1.5">
          {def.screens.map((_, i) => (
            <motion.span
              key={i}
              className={`h-1.5 rounded-full ${i <= step ? "bg-primary" : "bg-border"}`}
              animate={{ width: i === step ? 24 : 6 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            />
          ))}
        </div>
        {!last && (
          <button
            type="button"
            onClick={onDone}
            className="absolute right-0 rounded-full px-2 py-1 text-mini font-bold text-muted-foreground transition hover:text-primary"
          >
            Skip
          </button>
        )}
      </div>

      {/* Fixed floor so the footer button doesn't hop between screens. */}
      <div className="min-h-[25rem]">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: -40 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <motion.div variants={stagger} initial="hidden" animate="show" className="text-center">
              <motion.div variants={rise}>
                <Art reduce={reduce} />
              </motion.div>
              <motion.h2
                variants={rise}
                className="mt-6 font-display text-2xl font-bold leading-tight"
              >
                {screen.headline}
              </motion.h2>
              <motion.p
                variants={rise}
                className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground"
              >
                {screen.body}
              </motion.p>
              {Extra && (
                <motion.div variants={rise}>
                  <Extra reduce={reduce} />
                </motion.div>
              )}
            </motion.div>
          </motion.div>
        </AnimatePresence>
      </div>

      <button
        type="button"
        onClick={last ? onDone : () => setStep((s) => s + 1)}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-5 py-4 text-base font-semibold text-primary-foreground shadow-glow transition hover:opacity-95 active:scale-[0.99]"
      >
        {last ? def.ctaLabel : "Next"}
        <ArrowRight className="h-5 w-5" />
      </button>
    </motion.div>
  );
}

/* ================================================================== gate == */

const KEY_PREFIX = "pinearn.intro.";

/**
 * `?intro=1` on any URL replays that page's intro, whatever localStorage says.
 *
 * Once-per-browser gating has no way back by design, which makes the education
 * unreachable the moment it has been skipped — including for anyone trying to
 * review it. Read straight off `window.location` rather than through the router
 * because each route's `validateSearch` drops params it doesn't declare, and no
 * route declares this one.
 */
export function introForcedByUrl() {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("intro") === "1";
  } catch {
    return false;
  }
}

/** True once this flow's intro has been finished or skipped on this browser. */
export function hasSeenIntro(flow: IntroFlow) {
  try {
    return localStorage.getItem(KEY_PREFIX + flow) === "1";
  } catch {
    // Private-mode Safari throws on localStorage. Fail *closed*: an intro that
    // never appears is a smaller problem than one that appears every visit.
    return true;
  }
}

/** Records that this flow's intro is done, so it doesn't return next visit. */
export function markIntroSeen(flow: IntroFlow) {
  try {
    localStorage.setItem(KEY_PREFIX + flow, "1");
  } catch {
    /* ignore quota/availability errors — the intro just returns next visit */
  }
}

/**
 * Shows a flow's intro over the whole viewport, once per browser.
 *
 * Drop it at the top of a route and it handles the rest — the flow underneath
 * needs no state of its own. It mounts only after the client-side storage
 * check, so there is no server/client markup to disagree about, and it holds
 * body scroll while it's up so the page behind can't be scrolled blind.
 */
export function FlowIntroGate({ flow }: { flow: IntroFlow }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (introForcedByUrl() || !hasSeenIntro(flow)) setOpen(true);
  }, [flow]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  function dismiss() {
    setOpen(false);
    markIntroSeen(flow);
  }

  // Escape skips, matching the Skip button rather than trapping the creator.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="How this works"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-background"
        >
          <div className="flex min-h-full items-center justify-center py-2">
            <FlowIntro flow={flow} onDone={dismiss} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
