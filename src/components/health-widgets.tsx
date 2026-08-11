import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";

/** Score → semantic colour. Red until it's genuinely healthy — this is a
 * diagnosis, not a participation trophy. */
export function scoreTone(score: number): { text: string; bar: string; bg: string } {
  if (score >= 80)
    return { text: "text-emerald-600", bar: "bg-emerald-500", bg: "bg-emerald-500/10" };
  if (score >= 55) return { text: "text-amber-600", bar: "bg-amber-500", bg: "bg-amber-500/10" };
  return { text: "text-primary", bar: "bg-primary", bg: "bg-primary/10" };
}

/**
 * A number that visibly climbs (or falls) to its value — the moment that makes
 * the score feel alive instead of a static audit. Re-animates from the
 * previous value on every change, or from `from` on first mount (used by the
 * dashboard to climb from the score the user saw before a fix flow). Respects
 * prefers-reduced-motion: the value simply snaps to its target.
 */
export function AnimatedNumber({
  value,
  from,
  className,
  duration = 1.1,
}: {
  value: number;
  from?: number | null;
  className?: string;
  duration?: number;
}) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(from ?? value);
  const rounded = useTransform(mv, (v) => Math.round(v));
  const first = useRef(true);
  useEffect(() => {
    // Reduced motion, or first render with no explicit start point: show the
    // value immediately rather than animating on every page visit.
    if (reduce || (first.current && from == null)) {
      first.current = false;
      mv.set(value);
      return;
    }
    first.current = false;
    const controls = animate(mv, value, { duration, ease: [0.22, 1, 0.36, 1] });
    return controls.stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce]);
  return <motion.span className={className}>{rounded}</motion.span>;
}

/** One horizontal sub-score progress bar. Tappable when `onClick` is set. */
export function SubScoreBar({
  label,
  score,
  detail,
  onClick,
}: {
  label: string;
  score: number;
  detail?: string;
  onClick?: () => void;
}) {
  const tone = scoreTone(score);
  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{label}</span>
        <span className={`text-sm font-extrabold tabular-nums ${tone.text}`}>
          <AnimatedNumber value={score} />%
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
        <motion.div
          className={`h-full rounded-full ${tone.bar}`}
          initial={false}
          animate={{ width: `${score}%` }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      {detail && <p className="mt-1.5 text-mini text-muted-foreground">{detail}</p>}
    </>
  );
  if (!onClick) {
    return <div className="rounded-2xl border border-border bg-surface p-4">{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl border border-border bg-surface p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-elevate"
    >
      {inner}
    </button>
  );
}

/**
 * The live score pill shown inside the fix flows — bigger and louder than a
 * label now, because it IS the reward. Every time the integer score rises, a
 * "+N" chip springs out of it and the pill gives a quick scale pulse, so the
 * payoff registers even though the user's eyes are on the card. aria-live keeps
 * screen-reader users in the loop.
 */
export function LiveScorePill({ label, score }: { label: string; score: number }) {
  const reduce = useReducedMotion();
  const tone = scoreTone(score);
  const prev = useRef(score);
  const [delta, setDelta] = useState<{ n: number; id: number } | null>(null);
  const pulse = useRef(0);

  useEffect(() => {
    const d = score - prev.current;
    prev.current = score;
    if (d > 0) {
      pulse.current += 1;
      setDelta({ n: d, id: pulse.current });
    }
  }, [score]);

  return (
    <div className="relative inline-flex flex-col items-center">
      <motion.div
        key={pulse.current}
        animate={reduce ? undefined : { scale: [1, 1.08, 1] }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className={`inline-flex items-center gap-2 rounded-full px-4 py-2 ring-1 ring-inset ring-border/50 ${tone.bg}`}
      >
        <span className="text-xs font-semibold text-muted-foreground">{label}</span>
        <span
          className={`text-lg font-extrabold tabular-nums ${tone.text}`}
          aria-live="polite"
          aria-label={`${label} ${score} percent`}
        >
          <AnimatedNumber value={score} duration={0.6} />%
        </span>
      </motion.div>
      <AnimatePresence>
        {delta && (
          <motion.span
            key={delta.id}
            initial={{ opacity: 0, y: 4, scale: 0.7 }}
            animate={{ opacity: 1, y: -22, scale: 1 }}
            exit={{ opacity: 0, y: -34 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
            onAnimationComplete={() => setDelta(null)}
            className="pointer-events-none absolute -top-1 right-1 rounded-full bg-emerald-500 px-2 py-0.5 text-mini font-extrabold text-white shadow"
          >
            +{delta.n}%
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
