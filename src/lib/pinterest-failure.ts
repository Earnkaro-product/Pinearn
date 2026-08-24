/* ============================================================================
   Why a Pinterest connection attempt failed — and what the user can do next.

   Authorization can fail in half a dozen unrelated ways and, until this file
   existed, every one of them surfaced as the same `toast.error(e.message)`
   carrying raw server text ("Pinterest token exchange failed: ... the redirect
   URI used was ..."). Two problems with that: a toast disappears, leaving no
   next action on screen, and the text told the creator nothing they could act
   on.

   So each failure is classified once, here, into copy plus the ONE thing that
   actually helps: retry the same authorization, wait and retry, or stop asking
   because a retry cannot possibly work (an app misconfiguration). Every surface
   that connects Pinterest renders from this, so the same failure reads the same
   way wherever it happens.

   Classification is by pattern, not by exception type: these errors cross a
   server-function boundary, which flattens everything to `Error(message)`. The
   status code is preserved in that message by pinterest-api.ts, so it is read
   back out of the text rather than guessed at.
   ========================================================================== */

export type PinterestFailureKind =
  /** The creator pressed "Cancel" on Pinterest's own consent screen. */
  | "declined"
  /** The request never reached Pinterest (offline, DNS, dropped connection). */
  | "network"
  /** Pinterest rejected the token: expired, revoked, or scope withdrawn (401). */
  | "auth"
  /** Authenticated but not allowed — missing scope or a trial-tier app (403). */
  | "forbidden"
  /** Too many requests (429). Retrying immediately makes it worse. */
  | "rate_limit"
  /** Pinterest itself is failing (5xx). Not our bug and not the user's. */
  | "pinterest_down"
  /** The signed state token expired or didn't verify — start over from a fresh link. */
  | "state"
  /** This app is misconfigured (redirect URI / app id / secret). Retry can't fix it. */
  | "config"
  | "unknown";

export type PinterestFailure = {
  kind: PinterestFailureKind;
  /** Short heading — the failure, in the user's terms. */
  title: string;
  /** One or two sentences: what happened, and what happens if they retry. */
  message: string;
  /** False only when trying again genuinely cannot succeed. */
  canRetry: boolean;
  /** Label for the retry control, so "Try again" isn't used where "Refresh" reads better. */
  retryLabel: string;
  /** HTTP status behind it, when there was one — shown as a small technical hint. */
  status: number | null;
};

/** Pull the status code back out of the messages pinterest-api.ts composes:
 *  "Pinterest API /pins failed (429): ..." / "token request failed (400): ...". */
export function statusOf(raw: string): number | null {
  const m = /\((\d{3})(?:\s|\)|:)/.exec(raw) ?? /\b(?:status|HTTP)\s*(\d{3})\b/i.exec(raw);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 100 && n < 600 ? n : null;
}

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}

const BY_KIND: Record<PinterestFailureKind, Omit<PinterestFailure, "status" | "kind">> = {
  declined: {
    title: "Pinterest access wasn't granted",
    message:
      "You cancelled on Pinterest's permission screen, so nothing was connected. You can try again — or carry on without it and connect later.",
    canRetry: true,
    retryLabel: "Try again",
  },
  network: {
    title: "Couldn't reach Pinterest",
    message:
      "The connection dropped before Pinterest answered. Check your internet and try again — nothing was changed.",
    canRetry: true,
    retryLabel: "Try again",
  },
  auth: {
    title: "Pinterest wouldn't accept the access",
    message:
      "The permission Pinterest gave us was expired or has since been revoked. Authorizing again issues a fresh one.",
    canRetry: true,
    retryLabel: "Authorize again",
  },
  forbidden: {
    title: "Pinterest refused the permission",
    message:
      "Your Pinterest account is signed in, but it isn't allowed to grant one of the permissions this app asks for. Try again, and if it repeats, check that you're connecting a Pinterest business account.",
    canRetry: true,
    retryLabel: "Try again",
  },
  rate_limit: {
    title: "Pinterest is rate-limiting us",
    message:
      "Pinterest has had too many requests from this account for the moment. Give it a minute, then try again — nothing is lost.",
    canRetry: true,
    retryLabel: "Try again",
  },
  pinterest_down: {
    title: "Pinterest isn't responding",
    message:
      "Pinterest returned a server error, so this is on their side rather than yours. Trying again in a moment usually works.",
    canRetry: true,
    retryLabel: "Try again",
  },
  state: {
    title: "That authorization link expired",
    message:
      "Authorization links are only valid for a few minutes. Start the connection again to get a fresh one.",
    canRetry: true,
    retryLabel: "Start again",
  },
  config: {
    title: "Pinterest connection isn't set up correctly",
    message:
      "This app's Pinterest configuration was rejected, so retrying will fail the same way. Nothing you can do from here — please report it to support.",
    canRetry: false,
    retryLabel: "Try again",
  },
  unknown: {
    title: "Couldn't connect Pinterest",
    message: "Something went wrong partway through connecting. Trying again usually clears it.",
    canRetry: true,
    retryLabel: "Try again",
  },
};

/**
 * Classify anything thrown (or any OAuth `error` param Pinterest redirects back
 * with) into the failure the user should see.
 *
 * Order matters: the specific, actionable causes are tested before the generic
 * status-code buckets, because a message can match several patterns at once —
 * a 401 raised while verifying state is a state problem, not a token problem.
 */
export function describePinterestFailure(error: unknown): PinterestFailure {
  const raw = textOf(error);
  const status = statusOf(raw);
  const kind = classify(raw, status);
  return { kind, status, ...BY_KIND[kind] };
}

function classify(raw: string, status: number | null): PinterestFailureKind {
  if (!raw) return "unknown";

  // Pinterest's own OAuth error codes, arriving as ?error= on the callback.
  if (/access_denied|user_denied|cancel(l)?ed|denied the request/i.test(raw)) return "declined";
  if (/invalid_scope|unauthorized_client|invalid_client/i.test(raw)) return "config";

  // App misconfiguration — named explicitly so it isn't mistaken for a
  // transient failure the user should keep retrying.
  if (
    /PINTEREST_(APP_ID|APP_SECRET|REDIRECT_URI|API_BASE_URL)|isn't a recognized Pinterest API host|must be registered/i.test(
      raw,
    )
  ) {
    return "config";
  }
  if (/oauth state|state token|state check failed|expired after 10 minutes/i.test(raw)) {
    return "state";
  }
  if (
    /failed to fetch|networkerror|load failed|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network request failed/i.test(
      raw,
    )
  ) {
    return "network";
  }
  if (
    /not connected|reconnect pinterest|token refresh failed|no refresh token|revoked/i.test(raw)
  ) {
    return "auth";
  }

  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limit";
  if (status != null && status >= 500) return "pinterest_down";
  // A 400 from the token endpoint is nearly always a redirect-URI or client
  // mismatch — the one 4xx where telling the user to keep retrying is a lie.
  if (status === 400 && /token (exchange|request)/i.test(raw)) return "config";
  if (status === 404) return "config";

  return "unknown";
}

/** Failure straight from the callback's query string, where Pinterest sends a
 *  code and an optional human description rather than an exception. */
export function describeOAuthCallbackError(
  code: string | undefined,
  description: string | undefined,
): PinterestFailure {
  return describePinterestFailure([code, description].filter(Boolean).join(": "));
}
