import { toast } from "sonner";
import { CancellableToast } from "@/components/cancellable-toast";

/**
 * The one place that decides what a toast is for, how long it lives, and
 * whether it can be dismissed.
 *
 * Toasts had drifted into being the app's only notification channel: successes,
 * failures, standing conditions and long-operation results all arrived the same
 * way, all faded after 2.5s, and all carried a close button nobody could reach
 * in time. There are exactly four kinds here, and a short list of things that
 * are deliberately not toasts at all.
 *
 * `done` — a confirmation of something the creator just did, whose result is
 *   already on screen. Auto-dismisses, and is NOT dismissible: there is nothing
 *   to act on, and a close button on a 2.5s toast is a target that vanishes
 *   while you reach for it.
 *
 * `blocked` — the action stopped short of what was asked, for a reason the
 *   creator can do something about (out of coins, a partial run). Stays until
 *   dismissed: a half-finished job that reported itself for 2.5s reads, later,
 *   as a job that never ran.
 *
 * `problem` — something failed. Stays until dismissed too, because a failure
 *   that faded before it was read is a failure the creator walks into again.
 *
 * `cancellable` — a destructive action, held for a grace window before it
 *   commits. The toast's lifetime IS the window, so it can't auto-dismiss
 *   early; Cancel calls the whole thing off and the close button commits now
 *   rather than waiting out the countdown.
 *
 * Not toasts, on purpose:
 *   · standing conditions — Pinterest disconnected, access expired, an account
 *     that holds nothing but saved Pins. Still true after the toast fades, so
 *     they live in {@link PinterestSyncBanner} or an empty state.
 *   · the outcome of a long operation the creator is watching — the sync sheet
 *     and the callback screen already report their own progress and counts.
 *   · state the UI itself displays — the active account, a saved setting.
 * There is no `notifyInfo`, and that absence is the point: "for your
 * information" is precisely the content that belongs somewhere it can be read
 * twice. Anything that doesn't fit one of the four kinds above isn't a toast.
 *
 * Dismissibility follows from the kind, not from the call site: `done` never
 * carries a close button, `blocked` and `problem` always do, and `cancellable`
 * turns its close button into "commit now". The `<Toaster>` therefore sets no
 * global `closeButton` — that decision belongs here.
 */

/** Long enough to notice and reach, short enough not to feel like a pending
 *  operation. Matches the visible countdown on the cancel button. */
const GRACE_MS = 6000;

/** A confirmation. Transient, not dismissible. */
export function notifyDone(message: string, description?: string) {
  toast.success(message, { description, duration: 2500, closeButton: false });
}

/** An action that stopped short. Persists until the creator dismisses it. */
export function notifyBlocked(message: string, description?: string) {
  toast.warning(message, { description, duration: Infinity, closeButton: true });
}

/** A failure. Persists until the creator dismisses it. */
export function notifyProblem(message: string, description?: string) {
  toast.error(message, { description, duration: Infinity, closeButton: true });
}

/**
 * Hold a destructive action for a grace window, then run it.
 *
 * The work does not start until the window closes, so Cancel is a real cancel
 * and not a compensating write — which matters here because nothing that calls
 * this has an inverse on the server. Callers that hide the affected rows while
 * the toast is up should restore them from `onCancel`.
 */
export function notifyCancellable({
  message,
  cancelLabel = "Undo",
  graceMs = GRACE_MS,
  run,
  onCancel,
  onError,
}: {
  message: string;
  cancelLabel?: string;
  graceMs?: number;
  run: () => Promise<unknown> | unknown;
  onCancel?: () => void;
  /** Defaults to a `problem` toast carrying the thrown message. */
  onError?: (error: unknown) => void;
}) {
  let cancelled = false;

  const commit = () => {
    if (cancelled) return;
    cancelled = true; // no double-commit if the timer and the close button race
    toast.dismiss(id);
    void (async () => {
      try {
        await run();
      } catch (e) {
        if (onError) onError(e);
        else notifyProblem(e instanceof Error ? e.message : "That didn't go through");
      }
    })();
  };

  const timer = setTimeout(commit, graceMs);

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timer);
    toast.dismiss(id);
    onCancel?.();
  };

  const id = toast.custom(
    () => (
      <CancellableToast
        message={message}
        cancelLabel={cancelLabel}
        graceMs={graceMs}
        onCancel={cancel}
        onCommit={commit}
      />
    ),
    // `unstyled` because the body above is the whole toast — sonner's default
    // chrome would draw a second border around it. Our timer owns the deadline,
    // so sonner must not retire the toast under it.
    { duration: Infinity, unstyled: true },
  );
}
