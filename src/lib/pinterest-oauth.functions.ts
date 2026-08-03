import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getServiceSupabase } from "@/integrations/supabase/service-client";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getUserAccount,
  PinterestAuthError,
  refreshAccessToken,
  resolveRedirectUri,
  signOAuthState,
  verifyOAuthState,
} from "@/lib/pinterest-api";

// -------------------------------------------------------------
// Kick off the real Pinterest OAuth authorize round-trip.
// -------------------------------------------------------------

export const startPinterestOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { returnTo: string }) => z.object({ returnTo: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    // Resolve the redirect URI against the origin this request actually came
    // from, then sign it into the state so the token exchange presents exactly
    // the same string (Pinterest compares them byte for byte).
    const request = getRequest();
    const origin = request?.headers?.get("origin") ?? originOf(request?.url);
    const { redirectUri, configured, mismatch } = resolveRedirectUri(origin);
    if (mismatch) {
      console.warn(
        `[pinterest-oauth] This app is being served from ${origin} but PINTEREST_REDIRECT_URI is ${configured}. ` +
          `Using ${redirectUri} for this round-trip — Pinterest will reject it unless that exact URL is registered ` +
          `as a redirect URI in the Pinterest app dashboard. Either start the app on ${configured} or add ${redirectUri} there.`,
      );
    }
    const state = await signOAuthState({
      uid: context.userId,
      returnTo: data.returnTo,
      redirectUri,
    });
    return { url: buildAuthorizeUrl(state, redirectUri), redirectUri, mismatch };
  });

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------
// Exchange the authorization code, store tokens, mark the profile connected.
// -------------------------------------------------------------

export const completePinterestOAuthCallback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { code: string; state: string }) =>
    z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const verified = await verifyOAuthState(data.state, context.userId).catch((e) => {
      throw new Error(
        `OAuth state check failed: ${e instanceof Error ? e.message : e}. Try connecting again from a fresh link — state tokens expire after 10 minutes.`,
      );
    });
    const tokens = await exchangeCode(data.code, verified.redirectUri).catch((e) => {
      throw new Error(
        `Pinterest token exchange failed: ${e instanceof Error ? e.message : e}. ` +
          `The redirect URI used was ${verified.redirectUri ?? "(from PINTEREST_REDIRECT_URI)"} — it must be registered ` +
          `verbatim in the Pinterest app dashboard, and PINTEREST_APP_ID/PINTEREST_APP_SECRET must match that same app.`,
      );
    });
    const account = await getUserAccount(tokens.access_token).catch((e) => {
      throw new Error(
        `Pinterest account lookup failed right after token exchange: ${e instanceof Error ? e.message : e}. This usually means the connecting Pinterest account isn't authorized for this app's current access tier.`,
      );
    });

    const service = getServiceSupabase();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const { error: connErr } = await service.from("pinterest_connections").upsert(
      {
        user_id: context.userId,
        pinterest_user_id: account.accountId,
        username: account.username,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        scopes: tokens.scope ?? null,
        token_expires_at: expiresAt,
      },
      { onConflict: "user_id" },
    );
    if (connErr) throw new Error(connErr.message);

    // A fresh token clears any "reconnect Pinterest" state from the dead one it
    // replaces. Optional columns (see 20260803120000_pinterest_sync_state.sql) —
    // ignore the failure when the migration hasn't been applied.
    await service
      .from("pinterest_connections")
      .update({ needs_reauth: false, last_sync_error: null } as never)
      .eq("user_id", context.userId)
      .then(undefined, () => undefined);

    const { error: profileErr } = await service
      .from("profiles")
      .update({
        pinterest_connected: true,
        pinterest_username: account.username,
        source_platform: "pinterest",
      })
      .eq("id", context.userId);
    if (profileErr) throw new Error(profileErr.message);

    return { username: account.username, returnTo: verified.returnTo };
  });

// -------------------------------------------------------------
// Disconnect: drop the stored token and clear the profile flags.
// -------------------------------------------------------------

export const disconnectPinterest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const service = getServiceSupabase();
    const { error: delErr } = await service
      .from("pinterest_connections")
      .delete()
      .eq("user_id", context.userId);
    if (delErr) throw new Error(delErr.message);

    const { error: profileErr } = await service
      .from("profiles")
      .update({ pinterest_connected: false, pinterest_username: null })
      .eq("id", context.userId);
    if (profileErr) throw new Error(profileErr.message);

    return { disconnected: true };
  });

// -------------------------------------------------------------
// Internal helper (not a serverFn) — used by pinterest.functions.ts to get a
// live, non-expired access token, refreshing and persisting it if needed.
// -------------------------------------------------------------

// The board bulk-approve flow can have several `getPinRecommendation` calls
// in flight for the same user at once, and each independently lands here —
// without de-duping, a token sitting near its expiry window would trigger
// several concurrent refresh calls to Pinterest for the same user, each
// racing to persist its own (all equally valid, but wastefully duplicated)
// result. Keyed in-flight cache so only the first caller actually refreshes;
// everyone else just awaits that same result.
const refreshInFlight = new Map<string, Promise<string>>();

export async function getValidPinterestToken(
  userId: string,
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  const service = getServiceSupabase();
  const { data: conn, error } = await service
    .from("pinterest_connections")
    .select("access_token, refresh_token, token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!conn) throw new PinterestAuthError("Pinterest is not connected for this account");

  const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  const nearlyExpired = expiresAt - Date.now() < 5 * 60_000; // refresh with 5 min to spare
  // `forceRefresh` bypasses the expiry check — used by withPinterestToken when
  // Pinterest 401s a token the DB still considers valid (revoked, scope
  // change, app-environment switch): the stored expiry can't be trusted then.
  if (!nearlyExpired && !opts?.forceRefresh) return conn.access_token;

  const existing = refreshInFlight.get(userId);
  if (existing) return existing;

  if (!conn.refresh_token) {
    throw new PinterestAuthError(
      "Pinterest access token expired and no refresh token is available — reconnect Pinterest",
    );
  }

  const promise = (async () => {
    const refreshed = await refreshAccessToken(conn.refresh_token!).catch((e) => {
      throw new PinterestAuthError(
        `Pinterest token refresh failed: ${e instanceof Error ? e.message : e}. Reconnect Pinterest from Settings.`,
      );
    });
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    const { error: updErr } = await service
      .from("pinterest_connections")
      .update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? conn.refresh_token,
        token_expires_at: newExpiresAt,
      })
      .eq("user_id", userId);
    if (updErr) throw new Error(updErr.message);

    return refreshed.access_token;
  })().finally(() => {
    refreshInFlight.delete(userId);
  });
  refreshInFlight.set(userId, promise);
  return promise;
}

// Run a Pinterest API call with a valid token, recovering from the one case
// getValidPinterestToken can't see coming: Pinterest rejecting a token BEFORE
// its recorded expiry (user revoked access, scope change, sandbox↔production
// switch). On a 401 the token is force-refreshed once and `fn` retried with
// the fresh one; a second 401 — or a failed/impossible refresh — propagates
// as a PinterestAuthError, at which point only reconnecting from Settings can
// help. Concurrent 401s for the same user (e.g. the analytics page's three
// parallel calls) coalesce into a single refresh via refreshInFlight above.
export async function withPinterestToken<T>(
  userId: string,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const token = await getValidPinterestToken(userId);
  try {
    return await fn(token);
  } catch (e) {
    if (!(e instanceof PinterestAuthError)) throw e;
    const fresh = await getValidPinterestToken(userId, { forceRefresh: true });
    // Refresh handed back the exact token Pinterest just rejected — retrying
    // with it would just 401 again.
    if (fresh === token) throw e;
    return fn(fresh);
  }
}
