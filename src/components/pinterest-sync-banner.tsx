import { AlertTriangle, ArrowRight, Info, Loader2, RefreshCw } from "lucide-react";
import { notifyProblem } from "@/lib/notify";
import { lastSyncedLabel, reportSyncResult, usePinterestSync } from "@/hooks/use-pinterest-sync";
import { usePinterestConnect } from "@/hooks/use-pinterest-connect";
import { PinterestFailureNotice } from "@/components/pinterest-gate";

/**
 * The Pinterest connection, made visible.
 *
 * Three states matter and all three used to be invisible: never connected (a
 * creator who skipped authorization at the door — this banner is now how they
 * find their way to it later), the connection has died (the app then showed
 * empty boards and zeroed analytics with no explanation), and the data is simply
 * older than the creator expects. One offers to connect, one to reconnect, the
 * last a timestamp and a manual re-sync.
 */
export function PinterestSyncBanner({ compact = false }: { compact?: boolean }) {
  const { state, sync, isSyncing } = usePinterestSync();
  // `connect()` defaults to returning to the current path, so the creator lands
  // back on the screen they started from rather than a generic page.
  const { connect, connecting, failure } = usePinterestConnect();

  async function syncNow() {
    try {
      reportSyncResult(await sync({ analytics: true }));
    } catch (e) {
      notifyProblem(e instanceof Error ? e.message : "Pinterest sync failed");
    }
  }

  // Never connected. Not an error and not a nag — the offer, with the reason
  // attached, in the place that otherwise reports on the connection.
  if (state && !state.connected) {
    if (compact) {
      return (
        <button
          type="button"
          onClick={() => void connect()}
          disabled={connecting}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-mini font-semibold text-primary ring-1 ring-primary/25 transition hover:bg-primary/15 disabled:opacity-60"
        >
          {connecting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {connecting ? "Opening…" : "Connect Pinterest"}
        </button>
      );
    }
    return (
      <div className="rounded-2xl border border-primary/25 bg-primary/[0.06] p-3.5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
            <Info className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-body font-bold">Pinterest isn't connected</p>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              Connect it to import your boards and Pins and to see real impressions and clicks.
              Everything else in ShopMyPin works without it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void connect()}
            disabled={connecting}
            className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-gradient-primary px-3.5 text-xs font-bold text-primary-foreground shadow-glow disabled:opacity-60"
          >
            {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Connect
            {!connecting && <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        </div>
        {failure && (
          <PinterestFailureNotice
            className="mt-3"
            failure={failure}
            onRetry={() => void connect()}
            retrying={connecting}
          />
        )}
      </div>
    );
  }

  if (!state?.connected) return null;

  const reconnect = () => void connect();
  const reconnecting = connecting;

  if (state.needsReconnect) {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] p-3.5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-700">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-body font-bold text-amber-900">Pinterest needs reconnecting</p>
            <p className="mt-0.5 text-xs leading-snug text-amber-800/85">
              Its access expired or was revoked, so nothing new can be imported. Your Pins, boards
              and earnings in ShopMyPin are untouched.
            </p>
          </div>
          <button
            type="button"
            onClick={reconnect}
            disabled={reconnecting}
            className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-gradient-primary px-3.5 text-xs font-bold text-primary-foreground shadow-glow disabled:opacity-60"
          >
            {reconnecting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
            Reconnect
          </button>
        </div>
        {/* A reconnect that itself fails used to vanish into a toast, leaving an
          amber banner that looked exactly as it had a second earlier. */}
        {failure && (
          <PinterestFailureNotice
            className="mt-3"
            failure={failure}
            onRetry={reconnect}
            retrying={reconnecting}
          />
        )}
      </div>
    );
  }

  // Connected and synced, but almost everything on the account was saved from
  // someone else. Pinterest's own `pin_filter=exclude_repins` agrees there is
  // little or nothing to import, so this is not a failure; it just looks exactly
  // like one. Said plainly here rather than left as a near-empty grid.
  //
  // The trigger used to be `counts.pins === 0`, which is the one case that
  // needs no explanation least of all: an account with 199 saves and ONE
  // authored Pin imported that single Pin, suppressed this notice, and left the
  // creator staring at a grid of one wondering where the rest went. Saves
  // outnumbering imports is the real condition.
  const mostlySaves = !compact && state.savedSkipped > 0 && state.savedSkipped > state.counts.pins;
  if (mostlySaves) {
    const imported = state.counts.pins;
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-border bg-surface p-3.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Info className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body font-bold">
            {state.savedSkipped.toLocaleString()} saved {state.savedSkipped === 1 ? "Pin" : "Pins"}{" "}
            found,{" "}
            {imported === 0
              ? "none created by you"
              : `only ${imported.toLocaleString()} created by you`}
          </p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            ShopMyPin monetises Pins you made yourself — a Pin you saved from someone else keeps
            their creator's link, so there is nothing there to attach a product to. Pinterest marks
            those saves itself (they carry a parent Pin), and its own “created by you” filter agrees
            with the count above. Create a Pin on{" "}
            {state.username ? `@${state.username}` : "your account"} and it will appear on the next
            sync.
          </p>
        </div>
        <button
          type="button"
          onClick={syncNow}
          disabled={isSyncing}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-xs font-bold text-primary ring-1 ring-border transition hover:bg-primary/10 disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
          {isSyncing ? "Syncing…" : "Sync now"}
        </button>
      </div>
    );
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={syncNow}
        disabled={isSyncing}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-surface px-3 text-mini font-semibold text-muted-foreground ring-1 ring-border transition hover:text-foreground disabled:opacity-60"
      >
        <RefreshCw className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`} />
        {isSyncing ? "Syncing…" : lastSyncedLabel(state)}
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold">
          {state.username ? `@${state.username}` : "Pinterest"} ·{" "}
          <span className="font-medium text-muted-foreground">
            {state.counts.pins.toLocaleString()} pins, {state.counts.boards.toLocaleString()} boards
          </span>
        </p>
        <p className="text-mini text-muted-foreground">{lastSyncedLabel(state)}</p>
      </div>
      <button
        type="button"
        onClick={syncNow}
        disabled={isSyncing}
        className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-xs font-bold text-primary ring-1 ring-border transition hover:bg-primary/10 disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
        {isSyncing ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
