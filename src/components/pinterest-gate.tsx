import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Loader2, Lock, RefreshCw, ShieldCheck } from "lucide-react";
import { AppSheet } from "@/components/app-sheet";
import { usePinterestConnect, usePinterestConnection } from "@/hooks/use-pinterest-connect";
import type { PinterestFailure } from "@/lib/pinterest-failure";

/* ============================================================================
   Authorization, asked for at the moment it's actually needed.

   Pinterest access is skippable at the door — a new creator can look around the
   whole product without it — so the requirement has to be enforced per ACTION
   instead of per session. Two shapes cover everywhere it comes up:

     • usePinterestGate()      an action that needs Pinterest (publish a Pin,
                               import boards). Non-skippable: the prompt either
                               ends in an authorization or the action doesn't
                               happen. There is no "continue anyway".
     • PinterestConnectPanel   a whole screen that is nothing but Pinterest data
                               (SEO score, Pinterest analytics). Same demand,
                               rendered in place of the screen's content, with a
                               way back out so nobody is cornered.

   Both render their failures through PinterestFailureNotice, so a failed
   authorization always leaves a Retry on screen rather than a toast that fades.
   ========================================================================== */

function PinterestIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0a12 12 0 0 0-4.37 23.17c-.1-.94-.2-2.4.04-3.44.22-.94 1.4-6 1.4-6s-.36-.72-.36-1.78c0-1.67.97-2.92 2.17-2.92 1.02 0 1.52.77 1.52 1.7 0 1.03-.66 2.58-1 4.02-.28 1.2.6 2.18 1.79 2.18 2.15 0 3.8-2.27 3.8-5.54 0-2.9-2.08-4.93-5.05-4.93-3.44 0-5.46 2.58-5.46 5.25 0 1.04.4 2.15.9 2.76a.36.36 0 0 1 .08.35c-.09.36-.28 1.13-.32 1.29-.05.21-.17.26-.4.16-1.5-.7-2.44-2.88-2.44-4.64 0-3.78 2.75-7.25 7.92-7.25 4.16 0 7.38 2.96 7.38 6.92 0 4.13-2.6 7.46-6.22 7.46-1.22 0-2.36-.63-2.75-1.38 0 0-.6 2.3-.75 2.86-.27 1.04-1 2.35-1.5 3.14A12 12 0 1 0 12 0z" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Failure + retry                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A failed connection attempt, with its next action attached.
 *
 * The rule this exists to enforce: no authorization failure leaves the user
 * without something to press. `canRetry: false` is the one case with no retry —
 * an app misconfiguration, where the button would only fail again — and even
 * then `secondary` carries a way onward.
 */
export function PinterestFailureNotice({
  failure,
  onRetry,
  retrying,
  secondary,
  className = "",
}: {
  failure: PinterestFailure;
  onRetry: () => void;
  retrying?: boolean;
  /** A second way out — "Skip for now", "Back to Home". Optional but encouraged. */
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`rounded-2xl border border-destructive/30 bg-destructive/[0.06] p-4 ${className}`}
    >
      <div className="flex gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive">
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{failure.title}</p>
          <p className="mt-1 text-sm leading-snug text-muted-foreground">{failure.message}</p>
          {failure.status != null && (
            <p className="mt-1.5 text-mini text-muted-foreground/70">
              Pinterest returned status {failure.status}.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {failure.canRetry && (
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-bold text-primary-foreground shadow-glow transition hover:opacity-95 disabled:opacity-60"
              >
                {retrying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {retrying ? "Retrying…" : failure.retryLabel}
              </button>
            )}
            {secondary}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The secondary control inside a failure notice or connect panel. */
export function GateSecondaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-9 items-center rounded-full border border-border bg-surface px-4 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Whole-screen gate                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Stands in for a screen that can only be built from Pinterest data.
 *
 * Not an error state — the creator did nothing wrong by skipping — so it reads
 * as an offer with a reason attached, and always keeps a route out of the
 * screen (`backTo`) so a gated page can't become a dead end.
 */
export function PinterestConnectPanel({
  title = "Connect Pinterest to use this",
  reason,
  bullets,
  backTo = "/dashboard",
  backLabel = "Back to Home",
}: {
  title?: string;
  /** Why this particular screen needs the connection, in one sentence. */
  reason: string;
  bullets?: readonly string[];
  backTo?: string;
  backLabel?: string;
}) {
  const { needsReconnect } = usePinterestConnection();
  const { connect, connecting, failure } = usePinterestConnect();

  return (
    <div className="mx-auto max-w-md py-6 text-center">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-primary text-primary-foreground shadow-glow">
        <PinterestIcon className="h-8 w-8" />
      </div>
      <h2 className="mt-5 font-display text-xl font-semibold">
        {needsReconnect ? "Reconnect Pinterest to use this" : title}
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        {needsReconnect
          ? "Pinterest's access expired or was revoked, so this screen has nothing to read. Authorizing again brings it back."
          : reason}
      </p>

      {bullets && bullets.length > 0 && (
        <ul className="mx-auto mt-5 max-w-xs space-y-2 text-left">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span className="text-sm leading-snug text-muted-foreground">{b}</span>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void connect()}
        disabled={connecting}
        className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-glow transition hover:opacity-95 disabled:opacity-60"
      >
        {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PinterestIcon />}
        {connecting
          ? "Opening Pinterest…"
          : needsReconnect
            ? "Reconnect Pinterest"
            : "Connect Pinterest"}
        {!connecting && <ArrowRight className="h-4 w-4" />}
      </button>

      <Link
        to={backTo}
        className="mt-3 inline-flex min-h-10 items-center justify-center rounded-2xl px-5 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
      >
        {backLabel}
      </Link>

      {failure && (
        <PinterestFailureNotice
          className="mt-5 text-left"
          failure={failure}
          onRetry={() => void connect()}
          retrying={connecting}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-action gate                                                            */
/* -------------------------------------------------------------------------- */

export type GateReason = {
  /** What the user was trying to do — "Publish this Pin to Pinterest". */
  action: string;
  /** Why it can't happen without authorization. */
  reason: string;
};

type Pending = { reason: GateReason; run: () => void } | null;

/**
 * Run an action only if Pinterest is authorized; otherwise ask for it first.
 *
 *   const { run, gate } = usePinterestGate();
 *   <button onClick={() => run(REASON, () => publish.mutate())}>Publish</button>
 *   {gate}
 *
 * Three cases, and the middle one is the reason this is a callback rather than a
 * boolean check:
 *
 *   connected      the action runs immediately, no prompt, no flicker.
 *   still loading  the prompt opens in a "checking" state and the action fires
 *                  by itself the moment the state resolves as connected. Making
 *                  the creator press Publish twice because a cached query hadn't
 *                  landed yet is its own bug.
 *   not connected  the prompt asks for authorization. It is NON-SKIPPABLE: the
 *                  only ways out are authorizing (which returns here and the
 *                  action is retried by hand) or cancelling, which abandons the
 *                  action. There is no path that runs it unauthorized.
 */
export function usePinterestGate() {
  const { usable, needsReconnect, isLoading } = usePinterestConnection();
  const [pending, setPending] = useState<Pending>(null);

  const run = useCallback(
    (reason: GateReason, action: () => void) => {
      if (usable) {
        action();
        return true;
      }
      setPending({ reason, run: action });
      return false;
    },
    [usable],
  );

  // The connection state landed while the prompt was open and it turns out we
  // were authorized all along — go straight through instead of asking. Clearing
  // `pending` first is what stops this from re-firing.
  useEffect(() => {
    if (!usable || !pending) return;
    setPending(null);
    pending.run();
  }, [usable, pending]);

  const close = useCallback(() => setPending(null), []);

  const gate = pending ? (
    <PinterestRequiredSheet
      reason={pending.reason}
      checking={isLoading}
      needsReconnect={needsReconnect}
      onCancel={close}
    />
  ) : null;

  return { run, gate, close };
}

function PinterestRequiredSheet({
  reason,
  checking,
  needsReconnect,
  onCancel,
}: {
  reason: GateReason;
  checking: boolean;
  needsReconnect: boolean;
  onCancel: () => void;
}) {
  const { connect, connecting, failure } = usePinterestConnect();

  return (
    // `dismissible: false` — this prompt is answered, not waved away. Cancelling
    // is an explicit button, so "I pressed Escape and it published anyway" can't
    // happen.
    <AppSheet onClose={onCancel} dismissible={false} labelledBy="pinterest-gate-title" size="sm">
      <div className="pb-2 pt-1">
        <div className="flex items-start gap-3.5">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-glow">
            <PinterestIcon className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h2
              id="pinterest-gate-title"
              className="font-display text-lg font-semibold leading-tight"
            >
              {needsReconnect ? "Reconnect Pinterest to continue" : "Pinterest access needed"}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{reason.action}</p>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {needsReconnect
            ? "Pinterest's access expired or was revoked, so this can't reach your account. Authorizing again takes a few seconds and picks up right here."
            : reason.reason}
        </p>

        <div className="mt-4 flex items-start gap-2.5 rounded-2xl bg-surface-2/70 p-3.5">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-xs leading-snug text-muted-foreground">
            This one can't be skipped — it acts on your Pinterest account. Everything else in
            ShopMyPin stays open to you either way.
          </p>
        </div>

        {failure && (
          <PinterestFailureNotice
            className="mt-4"
            failure={failure}
            onRetry={() => void connect()}
            retrying={connecting}
            secondary={<GateSecondaryButton onClick={onCancel}>Cancel</GateSecondaryButton>}
          />
        )}

        <button
          type="button"
          onClick={() => void connect()}
          disabled={connecting || checking}
          className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-glow transition hover:opacity-95 disabled:opacity-60"
        >
          {connecting || checking ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PinterestIcon />
          )}
          {checking
            ? "Checking your connection…"
            : connecting
              ? "Opening Pinterest…"
              : needsReconnect
                ? "Reconnect Pinterest"
                : "Connect Pinterest"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="mt-2 flex min-h-11 w-full items-center justify-center rounded-2xl px-5 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
        >
          Not now
        </button>
      </div>
    </AppSheet>
  );
}
