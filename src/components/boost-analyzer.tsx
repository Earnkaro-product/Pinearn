import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CalendarClock,
  LayoutGrid,
  Loader2,
  ScanSearch,
  Type,
  UserCheck,
  type LucideIcon,
} from "lucide-react";

// The theatrical "analysing your Pinterest" sequence shown before the Boost
// score reveals. Pure choreography — the real scoring is synchronous and
// instant, but landing straight on a number reads like a static audit. This
// walks through what the engine actually checks, with live counts, so the
// score that follows feels earned.
//
// Shape: ONE focal scanner, not a checklist. The previous version stacked five
// bordered rows, each with its own icon, spinner, tick and sub-label, plus a
// progress bar underneath — five things animating at once, and the eye had
// nowhere to rest. Everything now resolves to a single centre: the current
// check's icon sits inside a rotating sweep, its name reads underneath, and
// progress lives in the ring itself rather than a separate bar. Same five
// checks, same live counts, one thing to look at.

type Step = {
  icon: LucideIcon;
  label: string;
  // Resolves the live sub-label ("142 pins scanned") once data is in hand.
  detail: (counts: AnalyzerCounts) => string;
};

export type AnalyzerCounts = { pins: number; boards: number };

const STEPS: Step[] = [
  {
    icon: ScanSearch,
    label: "Scanning your Pinterest",
    detail: (c) => `${c.pins} pins · ${c.boards} boards`,
  },
  {
    icon: Type,
    label: "Reading titles",
    detail: (c) => `${c.pins} pins`,
  },
  {
    icon: LayoutGrid,
    label: "Auditing boards",
    detail: (c) => `${c.boards} boards`,
  },
  {
    icon: UserCheck,
    label: "Checking your profile",
    detail: () => "Bio · photo · website",
  },
  {
    icon: CalendarClock,
    label: "Measuring activity",
    detail: () => "Last 30 days",
  },
];

const STEP_MS = 750;

// Once per session — returning from a fix flow must land straight on the
// climbing score, not sit through the scan again.
const SEEN_KEY = "pinearn.boost.analyzed";

export function hasAnalyzedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAnalyzedThisSession() {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode — worst case the scan replays */
  }
}

export function BoostAnalyzer({
  counts,
  ready,
  onDone,
}: {
  counts: AnalyzerCounts | null;
  // Data + report are in hand — the reveal may fire once choreography ends.
  ready: boolean;
  onDone: () => void;
}) {
  const reduce = useReducedMotion();
  // How many steps have completed. Steps tick on a timer; the final reveal
  // additionally waits for real data so we never reveal a skeleton.
  const [completed, setCompleted] = useState(0);

  useEffect(() => {
    if (completed >= STEPS.length) return;
    const t = setTimeout(() => setCompleted((n) => n + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [completed]);

  const allStepsDone = completed >= STEPS.length;
  useEffect(() => {
    if (!allStepsDone || !ready) return;
    const t = setTimeout(onDone, 500);
    return () => clearTimeout(t);
  }, [allStepsDone, ready, onDone]);

  // Reduced motion: no theatrical wait — reveal the moment data is ready.
  useEffect(() => {
    if (!reduce) return;
    if (ready) {
      const t = setTimeout(onDone, 200);
      return () => clearTimeout(t);
    }
  }, [reduce, ready, onDone]);

  if (reduce) {
    return (
      <div role="status" aria-live="polite" className="mx-auto max-w-md py-16 text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
        <p className="mt-3 text-sm font-semibold">Analysing your Pinterest…</p>
      </div>
    );
  }

  // The check being narrated: the active one, or the last while we wait on data.
  const at = Math.min(completed, STEPS.length - 1);
  const step = STEPS[at];
  const Icon = step.icon;
  const progress = Math.min(1, completed / STEPS.length);

  // Ring geometry. The stroke doubles as the progress read-out, so there is no
  // separate bar competing with it.
  const R = 62;
  const CIRC = 2 * Math.PI * R;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.25 } }}
      className="relative mx-auto max-w-md overflow-hidden px-4 py-10"
    >
      {/* Ambient aurora — the same drifting brand glow the scan overlay uses,
          so the two waits in this app feel like one product. */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="animate-blob absolute left-2 top-6 h-48 w-48 rounded-full bg-primary/15 blur-3xl" />
        <div className="animate-blob-delay-2 absolute -right-6 top-24 h-40 w-40 rounded-full bg-rose-400/15 blur-3xl" />
        <div className="animate-blob-delay-4 absolute bottom-0 left-1/3 h-40 w-40 rounded-full bg-amber-300/15 blur-3xl" />
      </div>

      <div className="relative mx-auto grid h-44 w-44 place-items-center">
        {/* Rotating conic sweep — the radar. Masked to a ring so it reads as a
            beam travelling the rim rather than a spinning disc. */}
        <div
          className="animate-sweep absolute inset-0 rounded-full opacity-70"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg, transparent 250deg, var(--color-primary) 340deg, transparent 360deg)",
            maskImage:
              "radial-gradient(circle, transparent 58%, #000 61%, #000 76%, transparent 79%)",
            WebkitMaskImage:
              "radial-gradient(circle, transparent 58%, #000 61%, #000 76%, transparent 79%)",
          }}
        />
        <div
          className="animate-sweep-slow absolute inset-3 rounded-full opacity-40"
          style={{
            background:
              "conic-gradient(from 180deg, transparent 0deg, transparent 300deg, var(--color-primary) 350deg, transparent 360deg)",
            maskImage:
              "radial-gradient(circle, transparent 62%, #000 65%, #000 72%, transparent 75%)",
            WebkitMaskImage:
              "radial-gradient(circle, transparent 62%, #000 65%, #000 72%, transparent 75%)",
          }}
        />

        {/* Progress ring — one stroke, five checks. */}
        <svg viewBox="0 0 144 144" className="absolute inset-0 h-full w-full -rotate-90">
          <circle cx="72" cy="72" r={R} fill="none" strokeWidth="3" className="stroke-border/60" />
          <motion.circle
            cx="72"
            cy="72"
            r={R}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            className="stroke-primary"
            strokeDasharray={CIRC}
            initial={{ strokeDashoffset: CIRC }}
            animate={{ strokeDashoffset: CIRC * (1 - progress) }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          />
        </svg>

        {/* Specks drifting inside the ring — depth, no motion the eye tracks. */}
        {[
          { c: "left-6 top-10", d: "0s" },
          { c: "right-7 top-16", d: "1.2s" },
          { c: "left-12 bottom-8", d: "2.4s" },
          { c: "right-12 bottom-12", d: "3.1s" },
        ].map((s) => (
          <span
            key={s.c}
            className={`animate-drift absolute h-1.5 w-1.5 rounded-full bg-primary/70 ${s.c}`}
            style={{ animationDelay: s.d }}
          />
        ))}

        {/* Centre: the check currently running. Morphs between icons rather
            than listing all five, which is what keeps the eye still. */}
        <div className="relative grid h-24 w-24 place-items-center rounded-full bg-gradient-primary text-primary-foreground shadow-glow">
          <AnimatePresence mode="wait">
            <motion.span
              key={step.label}
              initial={{ scale: 0.5, opacity: 0, rotate: -25 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              exit={{ scale: 0.5, opacity: 0, rotate: 25 }}
              transition={{ type: "spring", stiffness: 420, damping: 26 }}
              className="absolute"
            >
              <Icon className="h-10 w-10" />
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      {/* The narration. One line that changes, not five that accumulate. */}
      <div role="status" aria-live="polite" className="mt-7 text-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={step.label}
            initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <h2 className="font-display text-xl font-bold leading-tight">{step.label}</h2>
            {/* The count only appears once real data is in — never "0 pins". */}
            <p className="mt-1 min-h-[1.25rem] text-xs text-muted-foreground">
              {counts ? step.detail(counts) : " "}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Which of the five, as segments. Replaces the old five-row checklist
          and the separate progress bar with one glanceable strip. */}
      <div className="mt-6 flex items-center justify-center gap-1.5">
        {STEPS.map((s, i) => (
          <motion.span
            key={s.label}
            className={`h-1 rounded-full ${i < completed ? "bg-primary" : "bg-border"}`}
            animate={{ width: i === at ? 28 : 14, opacity: i <= completed ? 1 : 0.5 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          />
        ))}
      </div>

      {/* Only the honest wait gets a word. "This only takes a few seconds" was
          a caption on a screen that is already visibly working. */}
      <div className="mt-4 flex items-center justify-center gap-3">
        {allStepsDone && !ready && (
          <p className="text-mini font-medium text-muted-foreground">Scoring…</p>
        )}
        <button
          type="button"
          onClick={onDone}
          className="text-mini font-bold text-primary hover:underline"
        >
          Skip
        </button>
      </div>
    </motion.div>
  );
}
