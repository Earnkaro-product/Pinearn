import { useCallback, useEffect, useState } from "react";
import type { ScanPhase } from "@/components/pin-scan-overlay";

/** The floor on how long the scan animation plays, measured from the moment the
 * search starts.
 *
 * A pin that has been opened before answers from cache in ~100ms. Without a
 * floor, that either skipped the overlay entirely or flashed it for two frames,
 * which reads as a glitch rather than as work — and the jump straight into a
 * finished grid gives the user nothing to follow. Long enough to register the
 * hero, the products it found and a status line, short enough that nobody is
 * waiting on it: the product searches run underneath it either way, so this
 * spends time the screen was going to spend anyway.
 *
 * Cut from 2.6s once the cards stopped waiting on the look gate (see the
 * staged search in use-visual-search.ts). That change moved the products
 * forward by ten seconds and more, which left this floor as the largest
 * remaining delay on a pin that was already scanned — the screen sat finished
 * behind an animation playing out its minimum. 1.5s still reads as work
 * rather than as a flash. */
const MIN_SCAN_MS = 1_200;

/** How long the animation will additionally wait for the first tab's PRODUCTS,
 * once detection has named them.
 *
 * Detection lands in ~300ms on a seen pin, and the overlay used to leave on
 * that — dropping the user onto a screen of empty skeletons for the many
 * seconds the product searches took. Holding here spends part of that wait on
 * the animation instead, and the reveal lands on a grid with real products in
 * it.
 *
 * Cut from 7s, which is what "Matching 4 products" sitting on screen for seven
 * seconds actually was: a cap, reached in full every time detection was cached
 * and the searches were not. The hold is worth having when products are nearly
 * in and worth nothing when they are not, and there is no way to tell the two
 * apart in advance — so it is now short enough that the wrong guess costs
 * almost nothing. The screen behind it opens with its pills and its skeletons
 * and fills in underneath; Skip remains available throughout. */
const PRODUCT_WAIT_MAX_MS = 2_200;

/** The success beat between "found" and revealing the matches.
 *
 * Shorter than it was, because it now means something different. It used to
 * land while the product searches were still running, so the extra beat cost
 * nothing real — the screen behind it wasn't ready anyway. Now the overlay
 * waits for the first tab's products, so every millisecond here is one the
 * user spends looking at a tick instead of at the matches. Long enough to
 * read as success, short enough not to be a toll. */
const FOUND_HOLD_MS = 400;

/**
 * The scan overlay's phase, and the one-way switch that dismisses it.
 *
 * Shared by every screen that scans, because the timing IS the behaviour: get
 * the floor or the hold wrong on one screen and the same pin feels like a
 * different product on the other.
 *
 * `searching` tracks DETECTION. `productsReady` then holds the animation a
 * little longer, until the first tab's products are actually in — the two are
 * separate because they answer at completely different speeds, and the phase
 * the user should be watching is whichever one is still running.
 */
export function useScanPhase({
  searching,
  hasResults,
  productsReady = true,
  active = true,
}: {
  /** Detection is still running. */
  searching: boolean;
  /** Detection found something to search for. Read only once `searching` is
   * false, and it decides `found` vs `empty`. */
  hasResults: boolean;
  /** At least one tab has finished loading its products, so the screen behind
   * the overlay has something real on it. Defaults true, which reproduces the
   * old detection-only timing for any caller that doesn't track it. */
  productsReady?: boolean;
  /** False when there is nothing to scan (no image yet), which shows no overlay
   * at all rather than an empty state the user has to dismiss. */
  active?: boolean;
}): { phase: ScanPhase | null; dismiss: () => void } {
  const [dismissed, setDismissed] = useState(false);
  const [floorElapsed, setFloorElapsed] = useState(false);
  const [productWaitOver, setProductWaitOver] = useState(false);

  useEffect(() => {
    if (!active) return;
    setFloorElapsed(false);
    setProductWaitOver(false);
    const floor = setTimeout(() => setFloorElapsed(true), MIN_SCAN_MS);
    const cap = setTimeout(() => setProductWaitOver(true), PRODUCT_WAIT_MAX_MS);
    return () => {
      clearTimeout(floor);
      clearTimeout(cap);
    };
  }, [active]);

  // Still scanning while any of three things is true: detection is running,
  // the floor hasn't elapsed, or the products haven't arrived and the cap
  // hasn't expired. `hasResults` is what separates the two endings, and it is
  // only consulted once the scanning conditions are all clear.
  const stillScanning =
    searching || !floorElapsed || (hasResults && !productsReady && !productWaitOver);

  const phase: ScanPhase | null =
    !active || dismissed ? null : stillScanning ? "scanning" : hasResults ? "found" : "empty";

  // `empty` is deliberately NOT auto-dismissed: it carries the "add a link
  // manually" next step, so the user has to be the one to leave it.
  useEffect(() => {
    if (phase !== "found") return;
    const t = setTimeout(() => setDismissed(true), FOUND_HOLD_MS);
    return () => clearTimeout(t);
  }, [phase]);

  return { phase, dismiss: useCallback(() => setDismissed(true), []) };
}
