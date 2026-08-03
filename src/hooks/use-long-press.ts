import { useCallback, useEffect, useRef } from "react";

/** Press-and-hold, without swallowing taps or fighting the scroller: the timer
 * dies the moment the finger travels, so holding still is the only thing that
 * flips a card. `fired` lets the click handler tell a hold from a tap. */
export function useLongPress(onLongPress: () => void, ms = 350) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      origin.current = { x: e.clientX, y: e.clientY };
      fired.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(8);
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = origin.current;
      if (o && (Math.abs(e.clientX - o.x) > 8 || Math.abs(e.clientY - o.y) > 8)) clear();
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };

  return { fired, handlers };
}
