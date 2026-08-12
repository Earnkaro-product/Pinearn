import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { ArrowRight, BadgeCheck, TrendingUp } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ShopMyPin — Your Pins already get clicks. Now make them pay." },
      {
        name: "description",
        content:
          "Connect Pinterest and ShopMyPin auto-detects the products in your Pins, attaches your affiliate links, and turns a whole board into income in about a minute.",
      },
      {
        property: "og:title",
        content: "ShopMyPin — Your Pins already get clicks. Now make them pay.",
      },
      {
        property: "og:description",
        content:
          "Auto-detect products in your pins, attach affiliate links, and monetize a whole board in about a minute.",
      },
    ],
  }),
  component: Landing,
});

/* ------------------------------------------------------------------ */
/* Real pin imagery — Unsplash CDN over a brand-gradient underlay, so  */
/* a failed load can never leave a blank tile.                          */
/* ------------------------------------------------------------------ */
const img = (id: string, w = 480) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=70`;

const IMG = {
  chair: img("photo-1586023492125-27b2c045efd7"),
  livingRoom: img("photo-1522708323590-d24dbb6b0267"),
  modelPink: img("photo-1515886657613-9f3515b0c78f"),
  shoppingBags: img("photo-1483985988355-763728e1935b"),
  clothesRail: img("photo-1434389677669-e08b4cac3105"),
  foodTable: img("photo-1504674900247-0877df9cc836"),
  salad: img("photo-1512621776951-a57141f2eefd"),
  makeup: img("photo-1596462502278-27bfdc403348"),
  watch: img("photo-1523275335684-37898b6baf30"),
  sneakerRed: img("photo-1542291026-7eec264c27ff"),
  handbag: img("photo-1584917865442-de89df76afd3"),
  plants: img("photo-1463320726281-696a485928c7"),
  slipDress: img("photo-1490481651871-ab68de25d43d"),
  skincare: img("photo-1556228720-195a672e8a03"),
  suitcase: img("photo-1553062407-98eeb64c6a62"),
  pendantLamp: img("photo-1524758631624-e2822e304c36"),
  skillet: img("photo-1544025162-d76694265947"),
  homeDecor: img("photo-1441984904996-e0b6ba687e04"),
};

function PinImg({ src, g }: { src: string; g: string }) {
  return (
    <span className={`absolute inset-0 block bg-gradient-to-br ${g}`} aria-hidden>
      <img
        src={src}
        alt=""
        draggable={false}
        loading="eager"
        decoding="async"
        className="h-full w-full object-cover"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Landing = splash → welcome. One viewport each, zero scroll.         */
/* ------------------------------------------------------------------ */
function Landing() {
  const reduce = useReducedMotion();
  const [splash, setSplash] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setSplash(false), reduce ? 600 : 2000);
    return () => clearTimeout(t);
  }, [reduce]);

  return (
    <div className="h-dvh overflow-hidden bg-background text-foreground">
      <AnimatePresence mode="wait">
        {splash ? (
          <Splash key="splash" onDone={() => setSplash(false)} />
        ) : (
          <Welcome key="welcome" />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Splash — full-bleed brand red, breathing logo mark, tap to skip.    */
/* ------------------------------------------------------------------ */
function Splash({ onDone }: { onDone: () => void }) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      aria-label="Continue"
      onClick={onDone}
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.04 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="relative flex h-dvh w-full cursor-default flex-col items-center justify-center overflow-hidden bg-gradient-primary text-primary-foreground"
    >
      {/* Drifting light blobs */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="animate-blob absolute -left-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-[90px]" />
        <div className="animate-blob-delay-2 absolute -bottom-28 -right-20 h-96 w-96 rounded-full bg-black/15 blur-[90px]" />
      </div>

      {/* Logo mark — springs in, then breathes */}
      <motion.div
        initial={reduce ? undefined : { scale: 0.6, opacity: 0 }}
        animate={reduce ? { opacity: 1 } : { scale: [0.6, 1.06, 1], opacity: 1 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      >
        <motion.img
          src="/shopmypin-logo.png"
          alt="ShopMyPin"
          draggable={false}
          animate={reduce ? undefined : { scale: [1, 1.04, 1] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut", delay: 0.7 }}
          className="h-28 w-28"
        />
      </motion.div>

      <motion.p
        initial={reduce ? undefined : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reduce ? 0 : 0.35, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="mt-5 font-display text-3xl font-semibold tracking-tight"
      >
        ShopMyPin
      </motion.p>

      {/* Bottom tagline + progress shimmer */}
      <div className="safe-bottom absolute inset-x-0 bottom-6 flex flex-col items-center gap-3">
        <motion.p
          initial={reduce ? undefined : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: reduce ? 0 : 0.7 }}
          className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-foreground/80"
        >
          Pins → payouts
        </motion.p>
        <div className="h-1 w-24 overflow-hidden rounded-full bg-white/20">
          <motion.div
            className="h-full w-1/3 rounded-full bg-white/90"
            animate={reduce ? { x: 64 } : { x: [-32, 96] }}
            transition={reduce ? undefined : { duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
      </div>
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/* Welcome — one screen, no scroll: pin collage up top fading into the */
/* canvas, one loud claim, thumb-reach CTAs pinned at the bottom.      */
/* ------------------------------------------------------------------ */
const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } },
};
const rise: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
};

type WallPin = { src: string; g: string; a: string };
type WallColumn = { dir: "up" | "down"; dur: number; pins: WallPin[] };

// The pre-login wall — three columns of real pin imagery that drift endlessly
// (outer columns up, middle down) for a living Pinterest-board feel. Aspect
// ratios are mixed per tile so the columns read as an organic masonry, not a grid.
const WALL: WallColumn[] = [
  {
    dir: "up",
    dur: 42,
    pins: [
      { src: IMG.chair, g: "from-rose-400 to-pink-600", a: "3 / 4" },
      { src: IMG.salad, g: "from-amber-400 to-orange-600", a: "1 / 1" },
      { src: IMG.slipDress, g: "from-fuchsia-500 to-purple-600", a: "3 / 4" },
      { src: IMG.suitcase, g: "from-sky-400 to-indigo-600", a: "4 / 5" },
      { src: IMG.skillet, g: "from-orange-400 to-red-500", a: "1 / 1" },
      { src: IMG.plants, g: "from-emerald-400 to-teal-600", a: "3 / 4" },
    ],
  },
  {
    dir: "down",
    dur: 52,
    pins: [
      { src: IMG.modelPink, g: "from-emerald-400 to-teal-600", a: "4 / 5" },
      { src: IMG.livingRoom, g: "from-red-500 to-rose-700", a: "1 / 1" },
      { src: IMG.makeup, g: "from-teal-400 to-cyan-600", a: "3 / 4" },
      { src: IMG.handbag, g: "from-fuchsia-500 to-purple-600", a: "3 / 4" },
      { src: IMG.foodTable, g: "from-amber-400 to-orange-600", a: "4 / 5" },
      { src: IMG.pendantLamp, g: "from-indigo-400 to-violet-600", a: "3 / 4" },
    ],
  },
  {
    dir: "up",
    dur: 62,
    pins: [
      { src: IMG.clothesRail, g: "from-sky-400 to-indigo-600", a: "3 / 4" },
      { src: IMG.watch, g: "from-fuchsia-500 to-purple-600", a: "1 / 1" },
      { src: IMG.sneakerRed, g: "from-orange-400 to-red-500", a: "4 / 5" },
      { src: IMG.skincare, g: "from-teal-400 to-cyan-600", a: "3 / 4" },
      { src: IMG.shoppingBags, g: "from-indigo-400 to-violet-600", a: "3 / 4" },
      { src: IMG.homeDecor, g: "from-rose-400 to-pink-600", a: "1 / 1" },
    ],
  },
];

// Headline animates in word by word; "money" carries the brand gradient.
const HEADLINE = ["Don't", "leave", "money", "on", "your", "boards."];

function Welcome() {
  const reduce = useReducedMotion();
  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative mx-auto grid h-dvh w-full max-w-lg grid-rows-[minmax(0,1fr)_auto_auto] overflow-hidden"
    >
      {/* ---- Living pin wall (fades into the canvas) ---- */}
      <div className="relative min-h-0 overflow-hidden">
        <div
          className="absolute inset-0 flex gap-2.5 px-2.5 pt-2.5"
          style={{
            maskImage: "linear-gradient(180deg, black 58%, transparent 93%)",
            WebkitMaskImage: "linear-gradient(180deg, black 58%, transparent 93%)",
          }}
        >
          {WALL.map((col, ci) => (
            <motion.div
              key={ci}
              initial={reduce ? undefined : { opacity: 0, y: 32 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.1 + ci * 0.12 }}
              className="min-h-0 flex-1"
            >
              {/* Endless track — tiles rendered twice; -50% lands on the copy. */}
              <div
                className={`flex flex-col will-change-transform ${ci === 1 ? "mt-8" : ""} ${
                  reduce ? "" : col.dir === "up" ? "animate-wall-up" : "animate-wall-down"
                }`}
                style={reduce ? undefined : { animationDuration: `${col.dur}s` }}
              >
                {[...col.pins, ...col.pins].map((p, pi) => (
                  <div
                    key={pi}
                    className="relative mb-2.5 overflow-hidden rounded-2xl shadow-sm ring-1 ring-black/[0.04]"
                    style={{ aspectRatio: p.a }}
                  >
                    <PinImg src={p.src} g={p.g} />
                  </div>
                ))}
              </div>
            </motion.div>
          ))}
        </div>

        {/* Floating money proof — springs in, then drifts over the moving wall */}
        <motion.div
          initial={reduce ? undefined : { opacity: 0, scale: 0.8, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ delay: 0.65, type: "spring", stiffness: 320, damping: 20 }}
          className="animate-float absolute right-3 top-[24%] z-10"
        >
          <div className="glass flex items-center gap-1.5 rounded-2xl px-3 py-2 text-xs font-bold shadow-elevate">
            <TrendingUp className="h-3.5 w-3.5 text-success" /> +₹214 today
          </div>
        </motion.div>
        <motion.div
          initial={reduce ? undefined : { opacity: 0, scale: 0.8, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ delay: 0.85, type: "spring", stiffness: 320, damping: 20 }}
          className="animate-float-delay absolute left-3 top-[48%] z-10"
        >
          <div className="glass flex items-center gap-1.5 rounded-2xl px-3 py-2 text-xs font-bold shadow-elevate">
            <BadgeCheck className="h-3.5 w-3.5 text-primary" /> 3 pins linked
          </div>
        </motion.div>
      </div>

      {/* ---- Claim ---- */}
      <div className="relative z-10 -mt-3 px-6 text-center">
        <motion.img
          initial={reduce ? undefined : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          src="/shopmypin-logo.png"
          alt=""
          draggable={false}
          className="mx-auto h-14 w-14"
        />
        <motion.h1
          variants={stagger}
          initial="hidden"
          animate="show"
          className="mx-auto mt-3 flex max-w-[16ch] flex-wrap justify-center gap-x-[0.28em] font-display text-[clamp(2rem,8.5vw,2.9rem)] font-semibold leading-[1.04] tracking-tight"
        >
          {HEADLINE.map((w, i) => (
            <motion.span
              key={i}
              variants={rise}
              className={`inline-block ${i === 2 ? "text-gradient" : ""}`}
            >
              {w}
            </motion.span>
          ))}
        </motion.h1>
        <motion.p
          initial={reduce ? undefined : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.55, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-2.5 max-w-[27ch] text-sm text-muted-foreground"
        >
          Turn the Pins you've already posted into income.
        </motion.p>
      </div>

      {/* ---- CTAs pinned at the thumb ---- */}
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="safe-bottom relative z-10 px-5 pb-4 pt-5"
      >
        <motion.div variants={rise}>
          <Link
            to="/auth"
            className="group flex min-h-[54px] w-full items-center justify-center gap-2 rounded-full bg-primary text-[16px] font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
          >
            Start earning now
            <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </Link>
        </motion.div>
        <motion.div variants={rise} className="mt-2.5">
          <Link
            to="/auth"
            className="flex min-h-[54px] w-full items-center justify-center rounded-full bg-surface-2 text-[16px] font-semibold text-foreground ring-1 ring-border transition active:scale-[0.98]"
          >
            Log in
          </Link>
        </motion.div>
        <motion.p
          variants={rise}
          className="mt-3 text-center text-mini leading-relaxed text-muted-foreground"
        >
          Free to start · Works on boards you already have
          <br />
          Not affiliated with Pinterest ·{" "}
          <Link to="/privacy" className="underline underline-offset-2 hover:text-foreground">
            Privacy
          </Link>
        </motion.p>
      </motion.div>
    </motion.main>
  );
}
