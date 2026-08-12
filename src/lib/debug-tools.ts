import { useEffect, useState } from "react";

/* ============================================================================
   Whether to offer the in-app debug affordances (currently the match-funnel
   panel on the product screens).

   Three ways in, in order of how they're meant to be used:
     - a dev server, where they're always on;
     - `?debug=1` on any URL, which LATCHES into localStorage so it survives the
       navigations the flow itself performs — the funnel is opened from a screen
       you arrive at three taps deep, and a param that washed out on the way
       would be unusable exactly where it's needed;
     - `?debug=0`, which clears the latch again.

   A shopper never encounters any of this, which is the point: the panel exposes
   scores, verdicts, rejected retailers and internal cap names, none of which
   belong on a customer's screen.
   ========================================================================== */

const KEY = "pinearn:debug-tools";

/** Read (and update) the latch. Client-only — it touches `window`. */
function readFlag(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("debug");
    if (param === "0" || param === "false") {
      localStorage.removeItem(KEY);
      return false;
    }
    if (param !== null) {
      localStorage.setItem(KEY, "1");
      return true;
    }
    return localStorage.getItem(KEY) === "1" || import.meta.env.DEV;
  } catch {
    // Private-mode Safari throws on localStorage. A dev server should still get
    // the tools; everyone else simply doesn't.
    return import.meta.env.DEV;
  }
}

/**
 * True when the debug tools should be offered.
 *
 * Deliberately false on the first render and resolved in an effect: this app
 * server-renders, and `window.location`/`localStorage` don't exist there.
 * Reading them during render would mismatch hydration on every page that shows
 * a debug button.
 */
export function useDebugTools(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(readFlag()), []);
  return on;
}
