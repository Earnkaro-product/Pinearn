import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";
import { Check, Loader2, RotateCcw, X } from "lucide-react";

export type SwipeDecision = "approved" | "skipped";

/**
 * The card-stack swipe UI shared by the Boost fix flows (Pin Boost, Board
 * Boost). It is fully CONTROLLED: the parent (via useFixFlow) owns the cursor,
 * so there is exactly one source of truth for "which card is on top" — the
 * deck never advances on its own. Swipe right (or →) = approve, left (or ←) =
 * skip; undo (button / shake / ⌘Z) steps the cursor back and reverts the write.
 *
 * Accessibility: an aria-live region narrates every transition, arrow keys are
 * ignored while a sheet/dialog is open or focus is in a field, motion collapses
 * to a fade under prefers-reduced-motion, and the deck exposes its stack for
 * screen readers via the current card's label.
 */
export function SwipeDeck<T extends { id: string }>({
  items,
  index,
  renderCard,
  onDecide,
  onUndo,
  canUndo,
  cardLabel,
  approveLabel = "Approve",
  pendingIds,
  paused,
}: {
  items: T[];
  // Controlled cursor — the card at items[index] is on top.
  index: number;
  renderCard: (item: T) => ReactNode;
  onDecide: (item: T, decision: SwipeDecision) => void;
  onUndo: () => void;
  canUndo: boolean;
  // Accessible label for the current card, e.g. 'IMG_0231'.
  cardLabel?: (item: T) => string;
  approveLabel?: string;
  // Cards whose persistence is still in flight — approve is disabled for them.
  pendingIds?: Set<string>;
  // True while an edit sheet / confirm dialog is open — suspends gestures+keys.
  paused?: boolean;
}) {
  const reduce = useReducedMotion();
  const [exitDir, setExitDir] = useState<1 | -1>(1);
  const [announcement, setAnnouncement] = useState("");

  const current = items[index] ?? null;
  const under1 = items[index + 1] ?? null;
  const under2 = items[index + 2] ?? null;
  const total = items.length;

  const decide = (decision: SwipeDecision) => {
    if (!current || paused) return;
    if (decision === "approved" && pendingIds?.has(current.id)) return;
    setExitDir(decision === "approved" ? 1 : -1);
    const label = cardLabel?.(current) ?? "item";
    const left = total - index - 1;
    setAnnouncement(
      `${decision === "approved" ? "Applied fix to" : "Skipped"} ${label}. ${left} of ${total} left.`,
    );
    onDecide(current, decision);
  };

  const undo = () => {
    if (!canUndo || paused) return;
    setAnnouncement("Reverted the last change.");
    onUndo();
  };

  // Keyboard: → approve, ← skip, ⌘/Ctrl+Z undo — but never while typing in a
  // field or with a sheet/dialog open (those own the keyboard).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (paused) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (!current) return;
      if (e.key === "ArrowRight") decide("approved");
      else if (e.key === "ArrowLeft") decide("skipped");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // Rebinds per card / pause change so it never closes over a stale cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, paused, canUndo]);

  // Shake to undo — accelerometer spike with a cooldown. Inert where
  // devicemotion is unavailable/not permitted (desktop, iOS without the grant).
  const lastShakeRef = useRef(0);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  useEffect(() => {
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      const magnitude = Math.sqrt((a.x ?? 0) ** 2 + (a.y ?? 0) ** 2 + (a.z ?? 0) ** 2);
      const now = Date.now();
      if (magnitude > 28 && now - lastShakeRef.current > 1200) {
        lastShakeRef.current = now;
        undoRef.current();
      }
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, []);

  const currentPending = !!current && !!pendingIds?.has(current.id);
  const reviewed = Math.min(index, total);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Visually-hidden live region — narrates every transition. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {/* Progress: a real bar, not a whisper. */}
      <div className="flex shrink-0 items-center gap-3 pb-2.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <motion.div
            className="h-full rounded-full bg-gradient-primary"
            initial={false}
            animate={{ width: `${total ? (reviewed / total) * 100 : 0}%` }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
          {reviewed}/{total}
        </span>
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-xs font-bold text-muted-foreground transition hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Undo
        </button>
      </div>

      {/* Card stack — two cards peek behind for depth. */}
      <div className="relative min-h-0 flex-1">
        {[under2, under1].map((u, i) =>
          u ? (
            <motion.div
              key={`under-${u.id}`}
              className="absolute inset-0 overflow-hidden rounded-3xl border border-border bg-surface"
              initial={false}
              animate={{
                scale: i === 0 ? 0.92 : 0.96,
                y: i === 0 ? 20 : 10,
                opacity: i === 0 ? 0.5 : 0.75,
              }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              style={{ zIndex: i + 8 }}
            >
              {renderCard(u)}
            </motion.div>
          ) : null,
        )}
        <AnimatePresence mode="popLayout" custom={exitDir}>
          {current && (
            <DraggableCard
              key={current.id}
              exitDir={exitDir}
              reduce={!!reduce}
              disabled={!!paused}
              label={cardLabel?.(current)}
              onSwipe={(dir) => decide(dir === 1 ? "approved" : "skipped")}
            >
              {renderCard(current)}
            </DraggableCard>
          )}
        </AnimatePresence>
      </div>

      {/* Fixed action zone — Skip (small) + Approve (dominant). */}
      <div className="shrink-0 pt-3">
        <div className="flex items-stretch gap-2.5">
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={() => decide("skipped")}
            disabled={!current || paused}
            aria-label="Skip this suggestion"
            className="inline-flex min-h-[52px] shrink-0 items-center justify-center gap-1.5 rounded-2xl border-2 border-border bg-surface px-5 text-sm font-bold text-muted-foreground transition hover:text-foreground disabled:opacity-40"
          >
            <X className="h-4 w-4" strokeWidth={2.5} /> Skip
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => decide("approved")}
            disabled={!current || currentPending || paused}
            aria-label={approveLabel}
            className="inline-flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-4 text-lead font-extrabold text-primary-foreground shadow-glow transition disabled:opacity-60"
          >
            {currentPending ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Check className="h-5 w-5" strokeWidth={3} />
            )}
            {approveLabel}
          </motion.button>
        </div>
        <DeckHint />
      </div>
    </div>
  );
}

// Modality-aware hint: touch users get gesture copy, pointer users get the
// keyboard shortcuts that actually exist, with the correct modifier symbol.
function DeckHint() {
  const [coarse, setCoarse] = useState(true);
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setCoarse(window.matchMedia?.("(pointer: coarse)").matches ?? false);
    setMac(/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent));
  }, []);
  return (
    <p className="mt-2 text-center text-mini text-muted-foreground">
      {coarse ? (
        "Swipe right to apply · left to skip"
      ) : (
        <>
          <Kbd>→</Kbd> apply · <Kbd>←</Kbd> skip · <Kbd>{mac ? "⌘Z" : "Ctrl+Z"}</Kbd> undo
        </>
      )}
    </p>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-2 px-1 font-sans text-micro font-bold text-foreground">
      {children}
    </kbd>
  );
}

function DraggableCard({
  children,
  exitDir,
  reduce,
  disabled,
  label,
  onSwipe,
}: {
  children: ReactNode;
  exitDir: 1 | -1;
  reduce: boolean;
  disabled: boolean;
  label?: string;
  onSwipe: (dir: 1 | -1) => void;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 240], reduce ? [0, 0] : [-12, 12]);
  // Stamps reach full opacity exactly at the commit threshold (110px), so the
  // stamp reads "committed" at the moment the release actually commits.
  const approveOpacity = useTransform(x, [40, 110], [0, 1]);
  const skipOpacity = useTransform(x, [-110, -40], [1, 0]);
  // Haptic tick the first time a drag crosses the threshold each gesture.
  const buzzedRef = useRef(false);
  const exitX =
    (reduce ? 1 : 1) * exitDir * (typeof window !== "undefined" ? window.innerWidth : 480);

  return (
    <motion.div
      role="group"
      aria-roledescription="suggestion card"
      aria-label={label ? `Suggestion: ${label}` : undefined}
      className="absolute inset-0 z-20 cursor-grab overflow-hidden rounded-3xl border-2 border-primary bg-surface shadow-elevate active:cursor-grabbing"
      style={{ x, rotate }}
      drag={disabled ? false : "x"}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.55}
      onDrag={(_, info) => {
        if (!buzzedRef.current && Math.abs(info.offset.x) > 110) {
          buzzedRef.current = true;
          if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(10);
        }
      }}
      onDragEnd={(_, info) => {
        buzzedRef.current = false;
        const commit = Math.abs(info.offset.x) > 110 || Math.abs(info.velocity.x) > 600;
        if (commit) onSwipe(info.offset.x > 0 ? 1 : -1);
      }}
      initial={{ opacity: 0, scale: 0.96, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={
        reduce
          ? { opacity: 0, transition: { duration: 0.15 } }
          : {
              x: exitX,
              opacity: 0,
              rotate: exitDir * 14,
              transition: { duration: 0.32, ease: "easeOut" },
            }
      }
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
    >
      {children}
      {/* Decision stamps */}
      <motion.div
        style={{ opacity: approveOpacity }}
        className="pointer-events-none absolute inset-0 grid place-items-center bg-emerald-500/15"
      >
        <span className="-rotate-12 rounded-2xl border-4 border-emerald-500 px-4 py-2 text-lg font-extrabold uppercase tracking-wider text-emerald-600">
          Apply
        </span>
      </motion.div>
      <motion.div
        style={{ opacity: skipOpacity }}
        className="pointer-events-none absolute inset-0 grid place-items-center bg-foreground/10"
      >
        <span className="rotate-12 rounded-2xl border-4 border-foreground px-4 py-2 text-lg font-extrabold uppercase tracking-wider text-foreground">
          Skip
        </span>
      </motion.div>
    </motion.div>
  );
}
