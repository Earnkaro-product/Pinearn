import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { notifyDone, notifyProblem } from "@/lib/notify";
import {
  getPinterestSyncState,
  syncPinterestAccount,
  type PinterestSyncResult,
  type PinterestSyncState,
} from "@/lib/pinterest-sync.functions";
import { HEALTH_SCORE_QUERY_KEY, PINTEREST_PROFILE_QUERY_KEY } from "@/hooks/use-health-score";

export const PINTEREST_SYNC_STATE_KEY = ["pinterest-sync-state"];

// How old the last sync can be before the app quietly refreshes itself. Pinterest
// edits should show up without anyone pressing a button, but a sync walks every
// board and pin — so this is minutes, not seconds, and one run per staleness
// window rather than one per mount.
const STALE_AFTER_MS = 10 * 60_000;

// Module-level, not a ref: the banner, the storefront and the layout each mount
// their own copy of this hook, and a per-component guard let them all fire at
// once.
let autoSyncInFlight = false;

const LOCAL_SYNC_STAMP_KEY = "pinearn.pinterest.lastAutoSync";

function readLocalSyncStamp(): number {
  if (typeof window === "undefined") return 0;
  const raw = Number(window.localStorage.getItem(LOCAL_SYNC_STAMP_KEY));
  return Number.isFinite(raw) ? raw : 0;
}

function writeLocalSyncStamp(at: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_SYNC_STAMP_KEY, String(at));
  } catch {
    // Storage refused (private mode). The in-flight flag still prevents a storm
    // within this tab; the worst case is one extra sync after a reload.
  }
}

// Every cached surface that shows Pinterest-derived data. Listed once here so a
// sync can't leave one screen stale while the rest update.
const DEPENDENT_QUERY_KEYS: unknown[][] = [
  HEALTH_SCORE_QUERY_KEY,
  PINTEREST_PROFILE_QUERY_KEY,
  ["pinterest-analytics"],
  ["analytics-live-pins"],
  ["dashboard-unmonetized-pins"],
  ["dashboard-boards-collections"],
  ["collections"],
  ["pins"],
  ["storefront"],
  ["me-shell"],
];

export function usePinterestSyncState() {
  const load = useServerFn(getPinterestSyncState);
  return useQuery({
    queryKey: PINTEREST_SYNC_STATE_KEY,
    queryFn: () => load({ data: undefined as unknown as never }),
    staleTime: 60_000,
    // One retry, not zero: every Pinterest gate in the app reads this answer,
    // and a single hiccup used to leave a connected account looking
    // unconnected until something else forced a refetch.
    retry: 1,
  });
}

/**
 * The one way to pull fresh Pinterest data into the app.
 *
 * Owns three things the old flow left to chance: running a sync at all (it used
 * to happen only on the onboarding screen), invalidating everything that renders
 * the result, and noticing when the connection has died so the UI can ask for a
 * reconnect instead of showing an empty dashboard.
 */
export function usePinterestSync() {
  const qc = useQueryClient();
  const run = useServerFn(syncPinterestAccount);
  const state = usePinterestSyncState();

  const invalidateAll = useCallback(() => {
    for (const key of DEPENDENT_QUERY_KEYS) void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: PINTEREST_SYNC_STATE_KEY });
  }, [qc]);

  const mutation = useMutation({
    mutationFn: (opts?: { analytics?: boolean }) =>
      run({ data: { analytics: opts?.analytics !== false } }),
    // Invalidate on every settled sync, including a partial one — half-updated
    // data still needs to reach the screen. Stamping here too means a manual
    // "Sync now" also satisfies the staleness check, instead of being followed
    // moments later by an automatic one.
    onSettled: () => {
      writeLocalSyncStamp(Date.now());
      invalidateAll();
    },
  });

  return {
    state: state.data ?? null,
    isLoadingState: state.isPending,
    sync: mutation.mutateAsync,
    isSyncing: mutation.isPending,
    lastResult: mutation.data ?? null,
    invalidateAll,
  };
}

/**
 * Mount once, app-wide: keeps the data honest without anyone asking.
 *
 * Runs a sync when the last one is older than STALE_AFTER_MS, and again when the
 * tab regains focus after being away that long — which is exactly when someone
 * has been off editing their boards on pinterest.com and comes back expecting to
 * see it here. Analytics are skipped on these background runs: they're the slow,
 * rate-limited half, and the Analytics page backfills them on its own.
 */
export function usePinterestAutoSync(enabled = true) {
  const { state, sync, isSyncing } = usePinterestSync();

  const maybeSync = useCallback(
    async (reason: string) => {
      if (!enabled || autoSyncInFlight || isSyncing) return;
      if (!state?.connected || state.needsReconnect) return;
      // Two clocks, and the LATER one wins. The server's `last_synced_at` lives
      // behind an optional migration, so on a database without it every check
      // saw "never synced" and re-ran the whole import on every mount and every
      // focus — the repeated "[pinterest-sync] recovered 1 board(s)" storm. The
      // local stamp is always written, so the throttle holds either way.
      const serverLast = state.lastSyncedAt ? new Date(state.lastSyncedAt).getTime() : 0;
      const last = Math.max(serverLast, readLocalSyncStamp());
      if (Date.now() - last < STALE_AFTER_MS) return;
      autoSyncInFlight = true;
      // Stamped BEFORE the run, not after: a sync that takes 20s (or fails)
      // must still hold the gate shut against the next mount.
      writeLocalSyncStamp(Date.now());
      try {
        await sync({ analytics: false });
      } catch (e) {
        console.error(`[pinterest-auto-sync] ${reason} sync failed`, e);
      } finally {
        autoSyncInFlight = false;
      }
    },
    [enabled, isSyncing, state, sync],
  );

  useEffect(() => {
    void maybeSync("startup");
  }, [maybeSync]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void maybeSync("focus");
    // Only on the way BACK in — visibilitychange also fires when the tab is
    // hidden, and syncing a tab nobody is looking at is pure waste.
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, maybeSync]);
}

/** Human "Synced 4m ago" for the sync controls. */
export function lastSyncedLabel(state: PinterestSyncState | null): string {
  if (!state?.lastSyncedAt) return "Not synced yet";
  const mins = Math.round((Date.now() - new Date(state.lastSyncedAt).getTime()) / 60_000);
  if (mins < 1) return "Synced just now";
  if (mins < 60) return `Synced ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Synced ${hrs}h ago`;
  return `Synced ${Math.round(hrs / 24)}d ago`;
}

/**
 * What a manual "Sync now" reports back.
 *
 * Only the things that are true *because the creator just pressed the button*
 * get a toast. The two conditions that used to be announced here — a dead
 * connection, and an account holding nothing but saved Pins — are standing
 * facts about the account, and {@link PinterestSyncBanner} states both of them
 * for as long as they hold. Toasting them as well meant the same sentence
 * appeared twice and then half of it disappeared.
 */
export function reportSyncResult(result: PinterestSyncResult) {
  // Silence is correct here: the banner this button sits in re-renders into its
  // "Pinterest needs reconnecting" state, with the Reconnect action attached.
  if (result.needsReconnect) return;
  if (!result.ok) {
    notifyProblem(result.error ?? "Pinterest sync failed");
    return;
  }
  const bits: string[] = [];
  const { pins, boards } = result;
  // Nothing imported and the account is all saves — the banner explains that in
  // full, and it will still be explaining it after a toast would have gone.
  if (pins.created + pins.updated + pins.rehomed === 0 && pins.savedSkipped > 0) return;
  if (pins.created) bits.push(`${pins.created} new ${pins.created === 1 ? "pin" : "pins"}`);
  if (pins.updated) bits.push(`${pins.updated} updated`);
  if (pins.removed) bits.push(`${pins.removed} removed`);
  if (boards.created)
    bits.push(`${boards.created} new ${boards.created === 1 ? "board" : "boards"}`);
  if (boards.updated)
    bits.push(`${boards.updated} board ${boards.updated === 1 ? "edit" : "edits"}`);
  notifyDone(bits.length ? `Pinterest synced — ${bits.join(", ")}` : "Pinterest is up to date");
}
