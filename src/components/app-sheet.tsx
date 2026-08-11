import { useEffect, useRef, type ReactNode } from "react";
import { motion } from "framer-motion";

/* ============================================================================
   The app's one modal surface.

   Every overlay in the app used to hand-roll this shell, and they drifted: one
   closed on Escape and five didn't, two stopped the page scrolling underneath
   and four let it slide under your thumb, one moved focus and the rest left it
   on whatever was behind. None of that is a design decision — it's the same
   behaviour copied badly — so it lives here once, where a new sheet can't be
   born missing half of it.

   Stacking order, so overlays can't fight:
     40  page-level floaters (monetisation floater, banners)
     60  sheets and dialogs (this file)
     80  full-screen takeovers (collection picker)
    100  blocking first-run prompts that must be answered
   ========================================================================== */

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
} as const;

/** Focusables inside the panel, in DOM order — used for the tab wrap. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Escape-to-close, a page that stays put behind the overlay, and focus that
 * comes back where it started. Exported on its own for full-screen takeovers
 * that aren't sheets but owe the user the same manners.
 *
 * `dismissible: false` keeps the lock and the focus handling but drops Escape —
 * for a prompt that has to be answered rather than waved away.
 */
export function useOverlayChrome({
  onClose,
  dismissible = true,
  ref,
}: {
  onClose: () => void;
  dismissible?: boolean;
  /** The panel to move focus into. Omit to leave focus alone. */
  ref?: React.RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    // Captured once: by cleanup time the ref may already have been detached,
    // and the focus-restore check below needs the node we actually opened.
    const panel = ref?.current ?? null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        // Capture + stop: a sheet opened from another sheet closes itself only.
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      // Keep tabbing inside the panel — outside it there's nothing the user can
      // act on until this closes.
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const returnTo = document.activeElement as HTMLElement | null;
    panel?.focus({ preventScroll: true });

    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      // Only take focus back if the overlay still holds it — a sheet that
      // navigated somewhere shouldn't yank focus off the new screen.
      if (returnTo && panel?.contains(document.activeElement)) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, [onClose, dismissible, ref]);
}

/**
 * Bottom sheet on a phone, centred dialog from `sm` up.
 *
 * `layout="block"` (the default) is the simple case: the panel scrolls as one
 * padded block. `layout="panel"` hands the scrolling to you — pair it with
 * `SheetBody` and `SheetFoot` when the sheet has a header or an action bar that
 * must stay put while the middle scrolls.
 */
export function AppSheet({
  onClose,
  children,
  labelledBy,
  label,
  dismissible = true,
  size = "md",
  layout = "block",
  grabber = true,
  className = "",
}: {
  onClose: () => void;
  children: ReactNode;
  /** id of the heading inside the sheet — preferred over `label`. */
  labelledBy?: string;
  /** Literal accessible name, when there's no visible heading to point at. */
  label?: string;
  dismissible?: boolean;
  size?: keyof typeof SIZES;
  layout?: "block" | "panel";
  grabber?: boolean;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayChrome({ onClose, dismissible, ref: panel });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={dismissible ? onClose : undefined}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <motion.div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 44, opacity: 0.5 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 44, opacity: 0 }}
        transition={{ type: "spring", stiffness: 370, damping: 34 }}
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-border bg-surface shadow-elevate outline-none sm:rounded-3xl ${SIZES[size]} ${
          layout === "block" ? "overflow-y-auto px-5 pt-3" : ""
        } ${className}`}
        style={
          layout === "block"
            ? { paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }
            : undefined
        }
      >
        {grabber && (
          <div className="mx-auto mb-3 h-1.5 w-10 shrink-0 rounded-full bg-border sm:hidden" />
        )}
        {children}
      </motion.div>
    </motion.div>
  );
}

/** The scrolling middle of a `layout="panel"` sheet. */
export function SheetBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-3 ${className}`}>
      {children}
    </div>
  );
}

/** A pinned action bar that clears the home indicator. */
export function SheetFoot({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`shrink-0 border-t border-border/70 bg-surface px-5 pt-3 ${className}`}
      style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      {children}
    </div>
  );
}
