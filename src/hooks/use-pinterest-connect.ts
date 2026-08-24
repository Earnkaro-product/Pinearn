import { useCallback, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { startPinterestOAuth } from "@/lib/pinterest-oauth.functions";
import { describePinterestFailure, type PinterestFailure } from "@/lib/pinterest-failure";
import { usePinterestSyncState } from "@/hooks/use-pinterest-sync";

/* ============================================================================
   Is Pinterest connected, and how do we ask for it?

   Pinterest authorization is optional at the door (it can be skipped during
   onboarding) but required for the handful of actions that genuinely talk to
   Pinterest. That makes "is it connected?" a question the whole app asks, so it
   is answered from one cached query rather than each screen re-reading the
   profile row.

   `getPinterestSyncState` is the source: it reports on the stored CONNECTION,
   not the `profiles.pinterest_connected` flag, so a token that has been revoked
   on Pinterest's side shows up as `needsReconnect` instead of a connection that
   silently returns nothing.
   ========================================================================== */

export type PinterestConnection = {
  /** A stored Pinterest connection exists. */
  connected: boolean;
  /** Connected, but the token is dead — only a fresh authorization revives it. */
  needsReconnect: boolean;
  /** Connected AND working: the bar every Pinterest-dependent action must clear. */
  usable: boolean;
  /**
   * The state is not known yet. Gates must not judge while this is true — and
   * "not known" includes a FAILED read, not just a pending one.
   *
   * This distinction is the whole point. `data` is undefined both before the
   * query lands and after it errors, so a gate that only waits on `isPending`
   * reads one failed call as "this creator has no Pinterest" and demands an
   * authorization they already granted. A connected account seeing "Connect
   * Pinterest" is a far worse failure than a screen that waits a moment
   * longer, so an errored read is reported as still-loading and the query is
   * left to retry.
   */
  isLoading: boolean;
  /** The read itself failed. For surfaces that want to offer a retry. */
  isError: boolean;
  username: string | null;
};

export function usePinterestConnection(): PinterestConnection {
  const { data, isPending, isError } = usePinterestSyncState();
  const connected = !!data?.connected;
  const needsReconnect = !!data?.needsReconnect;
  return {
    connected,
    needsReconnect,
    usable: connected && !needsReconnect,
    // No data means no verdict, whatever the reason. See the field docs above.
    isLoading: isPending || (isError && data === undefined),
    isError,
    username: data?.username ?? null,
  };
}

/**
 * Start (or restart) the Pinterest authorization round-trip, with the failure
 * kept on screen instead of thrown away in a toast.
 *
 * Every caller needs the same three things — a button that can't be
 * double-fired, a returnTo that brings the creator back where they were, and a
 * failure the surrounding UI can render a Retry against — so they live here
 * once. `connect` never throws: it resolves to the failure so a caller can
 * decide whether to also toast it.
 */
export function usePinterestConnect() {
  const start = useServerFn(startPinterestOAuth);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<PinterestFailure | null>(null);

  const connect = useCallback(
    async (returnTo?: string): Promise<PinterestFailure | null> => {
      setConnecting(true);
      setFailure(null);
      try {
        const { url } = await start({ data: { returnTo: returnTo ?? pathname } });
        // Deliberately a full page navigation, not a router push: we are
        // leaving the app for pinterest.com. `connecting` stays true so the
        // button can't be pressed twice while the browser unloads.
        window.location.href = url;
        return null;
      } catch (e) {
        const described = describePinterestFailure(e);
        setFailure(described);
        setConnecting(false);
        return described;
      }
    },
    [pathname, start],
  );

  return {
    connect,
    connecting,
    failure,
    /** Clear the failure — for a surface that closes and reopens. */
    reset: useCallback(() => setFailure(null), []),
    setFailure,
  };
}
