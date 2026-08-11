import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, Sparkles, Check, Link2, ArrowRight, PackageSearch } from "lucide-react";

// What's happening, rotated while the reverse-image search runs — a mix of
// "what we're doing right now" and the value behind it, so the wait teaches
// instead of stalling. On-brand voice, kept short enough to read at a glance.
//
// Two sets, because after detection lands we know something we didn't before:
// WHAT is in the pin. Saying "matching your shoes" beats a generic spinner
// line, and it is true — that is the stage actually running.
const SCAN_MESSAGES = [
  "Reading your pin for shoppable products…",
  "Matching only retailers that pay you commission…",
  "Pulling live prices & stock from each store…",
  "Ranking the closest visual matches…",
];

const MATCHING_MESSAGES = [
  "Finding the closest visual matches…",
  "Comparing colour, pattern and shape…",
  "Checking live prices & stock…",
  "Keeping only retailers that pay you…",
];

/** The phases, in order. `useScanPhase` (hooks/use-scan-phase.ts) owns the
 * timing that moves between them. */
export type ScanPhase = "scanning" | "found" | "empty";

/**
 * Full-screen, on-brand scanning experience shown the moment a pin is opened
 * to attach products. It plays while the visual search runs, then resolves to
 * one of two ends:
 *   - `found`  → a quick success beat, then the parent dismisses it and reveals
 *                the matched products on the attach screen.
 *   - `empty`  → "no matching products found", with a clear next step (add a
 *                link manually / pick from a collection) before continuing to
 *                the attach screen.
 * Interactive throughout: a Skip lets impatient users jump straight to manual
 * entry without waiting for the scan to finish.
 */
export function PinScanOverlay({
  imageUrl,
  phase,
  found = [],
  onContinue,
  onSkip,
}: {
  imageUrl: string | null;
  phase: ScanPhase;
  /** The products detection named, in order — rendered as chips the moment
   * they are known, which is several seconds before their matches arrive.
   * This is the difference between a wait that looks stuck and one that
   * visibly got somewhere: the user reads back the items from their own pin
   * while the searches for them are still running. */
  found?: string[];
  // Advance to the attach screen — from the empty-state "Continue" button.
  onContinue: () => void;
  // Bail out of the scan early, straight to manual entry.
  onSkip: () => void;
}) {
  const matching = found.length > 0;
  const lines = matching ? MATCHING_MESSAGES : SCAN_MESSAGES;

  const [msg, setMsg] = useState(0);
  useEffect(() => {
    if (phase !== "scanning") return;
    const t = setInterval(() => setMsg((m) => (m + 1) % lines.length), 2200);
    return () => clearInterval(t);
  }, [phase, lines.length]);

  // Restart the rotation when the copy switches sets, so the first line of the
  // new set is the one that gets read rather than whatever index carried over.
  useEffect(() => setMsg(0), [matching]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-rose-50 via-background to-background px-6"
      style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
    >
      {/* Soft drifting brand glow behind everything */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob absolute -left-16 top-10 h-64 w-64 rounded-full bg-primary/20 blur-3xl" />
        <div className="animate-blob-delay-2 absolute -right-12 top-1/3 h-56 w-56 rounded-full bg-rose-400/20 blur-3xl" />
        <div className="animate-blob-delay-4 absolute bottom-10 left-1/3 h-56 w-56 rounded-full bg-amber-300/20 blur-3xl" />
      </div>

      <div className="relative flex w-full max-w-sm flex-col items-center">
        {/* ---- Hero: the pin being scanned ---- */}
        <div className="relative">
          {/* Pulsing halo */}
          <AnimatePresence>
            {phase === "scanning" && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="pointer-events-none absolute inset-0"
              >
                <span className="absolute inset-0 -m-3 animate-ping rounded-[2rem] border-2 border-primary/30" />
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            animate={
              phase === "empty"
                ? { rotate: [0, -2, 2, -1, 0] }
                : { scale: phase === "found" ? [1, 1.04, 1] : 1 }
            }
            transition={{ duration: phase === "empty" ? 0.5 : 0.6 }}
            className="relative h-60 w-48 overflow-hidden rounded-[1.75rem] border border-white/60 bg-gradient-to-br from-rose-500 to-pink-600 shadow-elevate ring-1 ring-primary/20"
          >
            {imageUrl && <img src={imageUrl} alt="" className="h-full w-full object-cover" />}
            {/* Dim + scan sweep only while scanning */}
            {phase === "scanning" && (
              <>
                <div className="absolute inset-0 bg-black/25" />
                <span className="pointer-events-none absolute inset-x-0 top-0 h-16 animate-scan bg-gradient-to-b from-primary/70 via-primary/25 to-transparent" />
              </>
            )}

            {/* Scanner viewfinder corner brackets */}
            {phase === "scanning" && <ViewfinderCorners />}

            {/* Success wash */}
            {phase === "found" && <div className="absolute inset-0 bg-emerald-500/25" />}
          </motion.div>

          {/* Floating badge over the pin — magnifier / check / empty */}
          <motion.div
            key={phase}
            initial={{ scale: 0.4, opacity: 0, y: 6 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 22 }}
            className="absolute -right-3 -top-3"
          >
            <div
              className={`grid h-14 w-14 place-items-center rounded-2xl text-white shadow-glow ring-4 ring-background ${
                phase === "found"
                  ? "bg-emerald-500"
                  : phase === "empty"
                    ? "bg-amber-500"
                    : "bg-gradient-primary"
              }`}
            >
              {phase === "found" ? (
                <Check className="h-7 w-7" strokeWidth={3} />
              ) : phase === "empty" ? (
                <PackageSearch className="h-6 w-6" />
              ) : (
                <motion.span
                  animate={{ y: [0, -3, 0], rotate: [0, -8, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                >
                  <Search className="h-6 w-6" strokeWidth={2.5} />
                </motion.span>
              )}
            </div>
          </motion.div>

          {/* Twinkling sparkles around the hero (scanning only) */}
          {phase === "scanning" && (
            <>
              <Twinkle className="-left-4 top-4" delay={0} />
              <Twinkle className="-right-5 bottom-10" delay={0.6} />
              <Twinkle className="left-6 -bottom-3" delay={1.1} />
            </>
          )}
        </div>

        {/* ---- Copy + status ---- */}
        <div className="mt-9 w-full text-center">
          <AnimatePresence mode="wait">
            {phase === "scanning" && (
              <motion.div
                key="scanning"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                <h2 className="font-display text-2xl font-bold tracking-tight text-foreground">
                  {matching
                    ? `Matching ${found.length} ${found.length === 1 ? "product" : "products"}`
                    : "Finding your products"}
                </h2>
                {/* What detection actually found, as soon as it knows. Each
                    chip is one tab that is about to appear. */}
                {matching && (
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                    {found.map((label, i) => (
                      <motion.span
                        key={`${label}-${i}`}
                        initial={{ opacity: 0, scale: 0.8, y: 4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{
                          delay: i * 0.08,
                          type: "spring",
                          stiffness: 420,
                          damping: 24,
                        }}
                        className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary"
                      >
                        <Check className="h-3 w-3" strokeWidth={3} />
                        {label}
                      </motion.span>
                    ))}
                  </div>
                )}
                {/* Rotating status line */}
                <div className="mt-2 flex min-h-[2.5em] items-start justify-center">
                  <p
                    key={msg}
                    className="animate-hint-in max-w-xs text-sm leading-snug text-muted-foreground"
                  >
                    {lines[msg]}
                  </p>
                </div>
                {/* Indeterminate progress sweep */}
                <div className="mx-auto mt-4 h-1.5 w-44 overflow-hidden rounded-full bg-primary/10">
                  <div className="h-full w-1/3 animate-indeterminate rounded-full bg-gradient-primary" />
                </div>
              </motion.div>
            )}

            {phase === "found" && (
              <motion.div
                key="found"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                <h2 className="font-display text-2xl font-bold tracking-tight text-foreground">
                  Matches found
                </h2>
                <p className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                  <Sparkles className="h-4 w-4" /> Opening your matches…
                </p>
              </motion.div>
            )}

            {phase === "empty" && (
              <motion.div
                key="empty"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                <h2 className="font-display text-2xl font-bold tracking-tight text-foreground">
                  No matching products found
                </h2>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-snug text-muted-foreground">
                  No worries — paste your own affiliate product link on the next screen and attach
                  it in a tap.
                </p>
                <button
                  onClick={onContinue}
                  className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
                >
                  <Link2 className="h-4 w-4" /> Add a link manually
                  <ArrowRight className="h-4 w-4" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Skip — always available while scanning so no one is ever trapped. */}
      {phase === "scanning" && (
        <button
          onClick={onSkip}
          className="absolute inset-x-0 bottom-8 mx-auto inline-flex w-fit items-center justify-center gap-1.5 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-semibold text-muted-foreground shadow-sm transition hover:text-foreground active:scale-[0.98]"
          style={{ bottom: "max(2rem, env(safe-area-inset-bottom))" }}
        >
          Skip & add manually <ArrowRight className="h-4 w-4" />
        </button>
      )}
    </motion.div>
  );
}

function ViewfinderCorners() {
  const base = "absolute h-6 w-6 border-primary";
  return (
    <>
      <span className={`${base} left-2 top-2 rounded-tl-lg border-l-[3px] border-t-[3px]`} />
      <span className={`${base} right-2 top-2 rounded-tr-lg border-r-[3px] border-t-[3px]`} />
      <span className={`${base} bottom-2 left-2 rounded-bl-lg border-b-[3px] border-l-[3px]`} />
      <span className={`${base} bottom-2 right-2 rounded-br-lg border-b-[3px] border-r-[3px]`} />
    </>
  );
}

function Twinkle({ className, delay }: { className: string; delay: number }) {
  return (
    <motion.span
      className={`absolute text-primary ${className}`}
      animate={{ scale: [0, 1, 0], opacity: [0, 1, 0], rotate: [0, 90, 180] }}
      transition={{ duration: 1.8, repeat: Infinity, delay, ease: "easeInOut" }}
    >
      <Sparkles className="h-5 w-5" fill="currentColor" />
    </motion.span>
  );
}
