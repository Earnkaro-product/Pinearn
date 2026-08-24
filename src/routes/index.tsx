import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  Link2,
  Rocket,
  Search,
  ShoppingBag,
  Sparkles,
  Store,
  TrendingUp,
  Wand2,
  type LucideIcon,
} from "lucide-react";

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

/* The whole claim block leaving and arriving as one object. Sliding the words
   out individually read as the headline falling apart. */
const swap: Variants = {
  hidden: { opacity: 0, x: 24 },
  show: { opacity: 1, x: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
  out: { opacity: 0, x: -24, transition: { duration: 0.22, ease: "easeOut" } },
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

/* ------------------------------------------------------------------ */
/* The pre-login story — five slides, auto-advancing.                  */
/*                                                                     */
/* One creator arriving cold has to learn four things before signup is  */
/* a decision rather than a guess: that their existing pins are the     */
/* asset, that matching + linking is one tap, that the storefront is a  */
/* shop, and that the SEO work is done for them. A single static screen */
/* could only ever carry the first. Each slide keeps the same frame —   */
/* drifting pin wall, one claim, CTAs under the thumb — so only the     */
/* claim moves and the signup button is never more than a tap away.     */
/*                                                                     */
/* The wall itself does NOT reset between slides: it is the one         */
/* continuous element, which is what stops five slides reading as five  */
/* different screens. Slide 5 is terminal — auto-advance stops there    */
/* rather than looping back, so the sequence ends pointing at signup.   */
/* ------------------------------------------------------------------ */

type Chip = { icon: LucideIcon; text: string; tone: string };
type Slide = {
  /** Headline, one word per entry — they rise in staggered. */
  words: string[];
  /** Index of the word carrying the brand gradient. */
  accent: number;
  body: string;
  /** Two proof chips floating over the wall. Kept concrete, never a
      statistic we can't stand behind. */
  chips: [Chip, Chip];
};

const SLIDES: Slide[] = [
  {
    words: ["Don't", "leave", "money", "on", "your", "boards."],
    accent: 2,
    body: "Turn every pin you post into income.",
    chips: [
      { icon: TrendingUp, text: "+₹214 today", tone: "text-success" },
      { icon: BadgeCheck, text: "3 pins linked", tone: "text-primary" },
    ],
  },
  {
    words: ["One", "tap", "monetises", "a", "pin."],
    accent: 2,
    body: "AI spots the real product inside pins you've already posted, then attaches your affiliate link.",
    chips: [
      { icon: Wand2, text: "Product matched", tone: "text-primary" },
      { icon: Link2, text: "Link attached", tone: "text-success" },
    ],
  },
  {
    words: ["Your", "own", "digital", "shop."],
    accent: 2,
    body: "A storefront that collects everything you recommend behind one shoppable link.",
    chips: [
      { icon: Store, text: "Storefront live", tone: "text-primary" },
      { icon: ShoppingBag, text: "Shoppable links", tone: "text-success" },
    ],
  },
  {
    words: ["AI", "writes", "your", "Pinterest", "SEO."],
    accent: 4,
    body: "Titles, boards and pin descriptions tuned so more people find what you post.",
    chips: [
      { icon: Sparkles, text: "Title rewritten", tone: "text-primary" },
      { icon: Search, text: "Board tuned", tone: "text-accent" },
    ],
  },
  {
    words: ["Everything", "a", "Pinterest", "creator", "needs."],
    accent: 3,
    body: "Monetise, sell and grow — one app, built for Pinterest alone.",
    chips: [
      { icon: Rocket, text: "Pins → payouts", tone: "text-primary" },
      { icon: BadgeCheck, text: "All in one place", tone: "text-success" },
    ],
  },
];

/** How long each slide holds. Long enough to read the body line twice. */
const SLIDE_MS = 4800;

function Welcome() {
  const reduce = useReducedMotion();
  const [idx, setIdx] = useState(0);
  // Bumped on every manual move so the auto-advance timer restarts from that
  // slide instead of firing straight after the tap.
  const [tick, setTick] = useState(0);
  const last = SLIDES.length - 1;

  useEffect(() => {
    if (idx >= last) return; // terminal slide — hold on the signup pitch
    const t = setTimeout(() => setIdx((i) => i + 1), SLIDE_MS);
    return () => clearTimeout(t);
  }, [idx, tick, last]);

  const goTo = (next: number) => {
    setIdx(Math.max(0, Math.min(last, next)));
    setTick((n) => n + 1);
  };

  const slide = SLIDES[idx];

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      aria-roledescription="carousel"
      className="relative mx-auto grid h-dvh w-full max-w-lg grid-rows-[minmax(0,1fr)_auto] overflow-hidden"
    >
      {/* Wall + claim swipe together; the CTAs below never move. */}
      <motion.div
        drag={reduce ? false : "x"}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.12}
        onDragEnd={(_, info) => {
          if (info.offset.x < -48) goTo(idx + 1);
          else if (info.offset.x > 48) goTo(idx - 1);
        }}
        className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
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

          {/* Floating proof — the pair swaps with the slide, the positions don't,
              so the eye tracks one moving story instead of two new objects. */}
          <AnimatePresence mode="popLayout">
            {slide.chips.map((chip, i) => (
              <motion.div
                key={`${idx}-${i}`}
                initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                transition={{ delay: i * 0.12, type: "spring", stiffness: 320, damping: 22 }}
                className={
                  i === 0
                    ? "animate-float absolute right-3 top-[24%] z-10"
                    : "animate-float-delay absolute left-3 top-[48%] z-10"
                }
              >
                <div className="glass flex items-center gap-1.5 rounded-2xl px-3 py-2 text-xs font-bold shadow-elevate">
                  <chip.icon className={`h-3.5 w-3.5 ${chip.tone}`} /> {chip.text}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
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
          {/* Fixed min-height: the headlines are 4–5 words and the bodies one or
              two lines, so without it the logo and the CTAs jump on every
              advance. */}
          <div className="min-h-[10.5rem] sm:min-h-[11.5rem]">
            <AnimatePresence mode="wait">
              <motion.div key={idx} initial="hidden" animate="show" exit="out" variants={swap}>
                <motion.h1
                  variants={stagger}
                  className="mx-auto mt-3 flex max-w-[16ch] flex-wrap justify-center gap-x-[0.28em] font-display text-[clamp(1.75rem,7.5vw,2.6rem)] font-semibold leading-[1.06] tracking-tight"
                >
                  {slide.words.map((w, i) => (
                    <motion.span
                      key={i}
                      variants={rise}
                      className={`inline-block ${i === slide.accent ? "text-gradient" : ""}`}
                    >
                      {w}
                    </motion.span>
                  ))}
                </motion.h1>
                <motion.p
                  variants={rise}
                  className="mx-auto mt-2.5 max-w-[30ch] text-sm text-muted-foreground"
                >
                  {slide.body}
                </motion.p>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>

      {/* ---- Progress + CTAs pinned at the thumb ---- */}
      <div className="safe-bottom relative z-10 px-5 pb-4 pt-4">
        {/* Segments, not dots: a dot row says "there are five", a filling bar
            also says "this one ends, and how soon". */}
        <div className="mx-auto mb-4 flex max-w-[13rem] items-center gap-1.5">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Slide ${i + 1} of ${SLIDES.length}`}
              aria-current={i === idx}
              // The bar is 6px tall; the padding gives it a thumb-sized target
              // without adding 6px of visible height.
              className="-my-2 flex-1 py-2"
            >
              <span className="block h-1.5 overflow-hidden rounded-full bg-foreground/15">
                <motion.span
                  key={`${i}-${tick}`}
                  className="block h-full rounded-full bg-primary"
                  initial={{ width: i < idx ? "100%" : "0%" }}
                  animate={{ width: i <= idx ? "100%" : "0%" }}
                  transition={
                    i === idx && idx < last && !reduce
                      ? { duration: SLIDE_MS / 1000, ease: "linear" }
                      : { duration: 0.3, ease: "easeOut" }
                  }
                />
              </span>
            </button>
          ))}
        </div>

        <motion.div variants={stagger} initial="hidden" animate="show">
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
            <Link to="/privacy" className="underline underline-offset-2 hover:text-foreground">
              Privacy Policy
            </Link>{" "}
            ·{" "}
            <Link to="/terms" className="underline underline-offset-2 hover:text-foreground">
              Terms and Conditions
            </Link>
          </motion.p>
        </motion.div>
      </div>
    </motion.main>
  );
}
