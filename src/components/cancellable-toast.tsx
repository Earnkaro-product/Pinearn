import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * The body of a cancellable toast: what is about to happen, a way to call it
 * off, and how long the offer stands.
 *
 * Scheduled by {@link notifyCancellable} in src/lib/notify.tsx, which owns the
 * timer and the commit — this only renders the offer.
 */
export function CancellableToast({
  message,
  cancelLabel,
  graceMs,
  onCancel,
  onCommit,
}: {
  message: string;
  cancelLabel: string;
  graceMs: number;
  onCancel: () => void;
  onCommit: () => void;
}) {
  // A countdown, not a spinner: the creator needs to know how long the offer
  // stands, and a bar that empties silently doesn't say that in a screen reader.
  const [left, setLeft] = useState(Math.ceil(graceMs / 1000));
  const endsAt = useRef(0);

  useEffect(() => {
    endsAt.current = Date.now() + graceMs;
    const t = setInterval(() => {
      setLeft(Math.max(0, Math.ceil((endsAt.current - Date.now()) / 1000)));
    }, 250);
    return () => clearInterval(t);
  }, [graceMs]);

  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3 shadow-elevate">
      <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{message}</p>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-full bg-surface-2 px-3 py-1.5 text-xs font-bold text-foreground transition hover:bg-surface-2/70"
      >
        {cancelLabel}
        <span aria-hidden className="ml-1 tabular-nums text-muted-foreground">
          {left}s
        </span>
      </button>
      {/* Dismissing an undo offer means "get on with it", not "forget it" —
          the same reading Gmail's undo bar has. */}
      <button
        type="button"
        onClick={onCommit}
        aria-label="Dismiss and continue"
        className="shrink-0 text-muted-foreground transition hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
