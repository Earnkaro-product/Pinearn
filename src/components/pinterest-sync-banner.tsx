import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { startPinterestOAuth } from "@/lib/pinterest-oauth.functions";
import { lastSyncedLabel, reportSyncResult, usePinterestSync } from "@/hooks/use-pinterest-sync";

/**
 * The Pinterest connection, made visible.
 *
 * Two states matter and both used to be invisible: the connection has died (the
 * app then showed empty boards and zeroed analytics with no explanation — three
 * of the stored connections are in exactly this state), and the data is simply
 * older than the creator expects. One shows a reconnect button, the other a
 * timestamp and a manual re-sync.
 */
export function PinterestSyncBanner({ compact = false }: { compact?: boolean }) {
  const { state, sync, isSyncing } = usePinterestSync();
  const startOAuth = useServerFn(startPinterestOAuth);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [reconnecting, setReconnecting] = useState(false);

  if (!state?.connected) return null;

  async function reconnect() {
    setReconnecting(true);
    try {
      // Return to wherever the creator is standing, not a generic landing page.
      const { url } = await startOAuth({ data: { returnTo: pathname } });
      window.location.href = url;
    } catch (e) {
      setReconnecting(false);
      toast.error(e instanceof Error ? e.message : "Couldn't start the Pinterest connection");
    }
  }

  async function syncNow() {
    try {
      reportSyncResult(await sync({ analytics: true }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pinterest sync failed");
    }
  }

  if (state.needsReconnect) {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] p-3.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-700">
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body font-bold text-amber-900">Pinterest needs reconnecting</p>
          <p className="mt-0.5 text-xs leading-snug text-amber-800/85">
            Its access expired or was revoked, so nothing new can be imported. Your pins, boards and
            earnings in Pinearn are untouched.
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
