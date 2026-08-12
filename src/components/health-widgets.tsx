import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";
import { pointsLabel } from "@/lib/health-score";

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
  decimals = 0,
}: {
  value: number;
  from?: number | null;
  className?: string;
  duration?: number;
  /** Decimal places to hold while climbing. One place is what makes a points
   * total move on a single fix when the area is worth 40 pts across 80 pins. */
  decimals?: number;
}) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(from ?? value);
  const rounded = useTransform(mv, (v) =>
    decimals > 0 ? v.toFixed(decimals) : String(Math.round(v)),
  );
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

/**
 * The live points pill shown inside the fix flows — bigger and louder than a
 * label now, because it IS the reward. Every time the total rises, a "+N pts"
 * chip springs out of it and the pill gives a quick scale pulse, so the payoff
 * registers even though the user's eyes are on the card. aria-live keeps
 * screen-reader users in the loop.
 *
 * Points, never a percentage: `points` is what this area has banked out of
 * `maxPoints` on the 100-point Boost Score, so the pill reads in the same unit
 * as the plan the creator came from. It carries one decimal on purpose — an
 * area worth 40 pts spread over 80 pins moves 0.5 pts per fix, and a whole
 * number would sit still through the first few swipes.
 */
export function LiveScorePill({
  label,
  points,
  maxPoints,
}: {
  label: string;
  points: number;
  maxPoints: number;
}) {
  const reduce = useReducedMotion();
  // Tone tracks the share earned, not the raw points — 8 pts is healthy out of
  // 10 and dire out of 40.
  const tone = scoreTone(maxPoints > 0 ? (points / maxPoints) * 100 : 0);
  const prev = useRef(points);
  const [delta, setDelta] = useState<{ n: number; id: number } | null>(null);
  const pulse = useRef(0);

  useEffect(() => {
    const d = points - prev.current;
    prev.current = points;
    if (d > 0) {
      pulse.current += 1;
      setDelta({ n: d, id: pulse.current });
    }
  }, [points]);

  return (
    <div className="relative inline-flex flex-col items-center">
      <motion.div
        key={pulse.current}
        animate={reduce ? undefined : { scale: [1, 1.08, 1] }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className={`inline-flex items-baseline gap-1.5 rounded-full px-3 py-2 ring-1 ring-inset ring-border/50 ${tone.bg}`}
      >
        <span className="text-mini font-semibold text-muted-foreground">{label}</span>
        <span
          className={`text-base font-extrabold tabular-nums ${tone.text}`}
          aria-live="polite"
          aria-label={`${label} ${pointsLabel(points)} of ${maxPoints} points`}
        >
          <AnimatedNumber value={points} duration={0.6} decimals={1} />
        </span>
        <span className="text-micro font-bold text-muted-foreground">/{maxPoints} pts</span>
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
            +{pointsLabel(delta.n)} pts
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
