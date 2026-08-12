// Low-level Pinterest API v5 client. Server-only — every export here is only
// ever called from inside `createServerFn` handlers, never from client code,
// so the app secret and access tokens never reach the browser bundle.
//
// Uses only Web Crypto / TextEncoder (no `node:crypto`, no `Buffer`) so this
// module runs unmodified whether the app is deployed on a Node server or an
// edge/Workers runtime.

const AUTHORIZE_URL = "https://www.pinterest.com/oauth/";
// Trial access can only call the Sandbox environment (separate, private,
// per-creator test boards/pins) — see PINTEREST_API_BASE_URL in .env. Flip
// that env var to https://api.pinterest.com/v5 once Standard access is
// granted; nothing else here needs to change.
const SCOPES = "boards:read,boards:write,pins:read,pins:write,user_accounts:read";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const KNOWN_API_HOSTS = ["https://api.pinterest.com/v5", "https://api-sandbox.pinterest.com/v5"];

function apiBase(): string {
  const base = requireEnv("PINTEREST_API_BASE_URL").replace(/\/+$/, "");
  if (!KNOWN_API_HOSTS.includes(base)) {
    throw new Error(
      `PINTEREST_API_BASE_URL is set to "${base}", which isn't a recognized Pinterest API host. ` +
        `Expected one of: ${KNOWN_API_HOSTS.join(" or ")}`,
    );
  }
  return base;
}

// Pinterest error bodies are usually `{ code, message }`; fall back to raw text
// when the response isn't valid JSON so nothing gets silently swallowed.
function describePinterestError(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { message?: string; code?: number };
    if (body?.message) return `${body.message}${body.code != null ? ` (code ${body.code})` : ""}`;
  } catch {
    /* not JSON — fall through to raw text */
  }
  return text.slice(0, 500) || `HTTP ${status}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function toBase64Standard(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function basicAuthHeader(): string {
  const id = requireEnv("PINTEREST_APP_ID");
  const secret = requireEnv("PINTEREST_APP_SECRET");
  return `Basic ${toBase64Standard(new TextEncoder().encode(`${id}:${secret}`))}`;
}

async function hmacSign(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(requireEnv("PINTEREST_APP_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(sig));
}

// ---------------------------------------------------------------
// Signed, stateless OAuth `state` — binds the callback to the user and
// request that started it, without needing a server-side session store.
// ---------------------------------------------------------------

// `redirectUri` rides along because OAuth requires the token exchange to present
// the SAME redirect_uri the authorize call used. Deriving it twice from the
// environment looked equivalent but wasn't: a dev server that starts on :8081
// because :8080 is taken silently changes the origin between the two calls, and
// Pinterest answers the exchange with an opaque invalid_grant. Signing it into
// the state makes the pair provably identical.
type OAuthState = {
  uid: string;
  nonce: string;
  exp: number;
  returnTo: string;
  redirectUri?: string;
};

export async function signOAuthState(payload: Omit<OAuthState, "nonce" | "exp">): Promise<string> {
  const state: OAuthState = {
    ...payload,
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(12))),
    exp: Date.now() + 10 * 60_000, // 10 minutes to complete the OAuth round-trip
  };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(state)));
  const sig = await hmacSign(body);
  return `${body}.${sig}`;
}

export async function verifyOAuthState(state: string, expectedUid: string): Promise<OAuthState> {
  const [body, sig] = state.split(".");
  if (!body || !sig) throw new Error("Malformed OAuth state");
  const expectedSig = await hmacSign(body);
  if (sig !== expectedSig) throw new Error("OAuth state signature mismatch");
  const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as OAuthState;
  if (Date.now() > parsed.exp) throw new Error("OAuth state expired — please try connecting again");
  if (parsed.uid !== expectedUid) throw new Error("OAuth state does not match the signed-in user");
  return parsed;
}

export function buildAuthorizeUrl(state: string, redirectUri?: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", requireEnv("PINTEREST_APP_ID"));
  url.searchParams.set("redirect_uri", redirectUri || requireEnv("PINTEREST_REDIRECT_URI"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * The redirect URI to use for THIS round-trip.
 *
 * Pinterest matches redirect_uri against the exact strings registered in the app
 * dashboard, so the environment variable stays the default. The one case it gets
 * wrong is local development: the dev server picks another port when its usual
 * one is busy, and every OAuth attempt then bounces to a port nothing is
 * listening on. For a localhost origin, trust the origin the request actually
 * came from and let the caller warn when that differs from the registered URI —
 * a loud, fixable error beats a silent dead end.
 */
export function resolveRedirectUri(requestOrigin: string | null): {
  redirectUri: string;
  configured: string;
  mismatch: boolean;
} {
  const configured = requireEnv("PINTEREST_REDIRECT_URI");
  if (!requestOrigin) return { redirectUri: configured, configured, mismatch: false };

  let origin: URL;
  let configuredUrl: URL;
  try {
    origin = new URL(requestOrigin);
    configuredUrl = new URL(configured);
  } catch {
    return { redirectUri: configured, configured, mismatch: false };
  }

  if (origin.origin === configuredUrl.origin) {
    return { redirectUri: configured, configured, mismatch: false };
  }

  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (!isLocal) return { redirectUri: configured, configured, mismatch: true };

  return {
    redirectUri: `${origin.origin}${configuredUrl.pathname}`,
    configured,
    mismatch: true,
  };
}

// ---------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------

export type PinterestTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  scope?: string;
};

async function tokenRequest(body: URLSearchParams): Promise<PinterestTokens> {
  const res = await fetch(`${apiBase()}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Pinterest token request failed (${res.status}): ${describePinterestError(res.status, text)}`,
    );
  }
  return res.json() as Promise<PinterestTokens>;
}

export function exchangeCode(code: string, redirectUri?: string): Promise<PinterestTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      // Must be byte-identical to the authorize call's — see OAuthState.redirectUri.
      redirect_uri: redirectUri || requireEnv("PINTEREST_REDIRECT_URI"),
    }),
  );
}

export function refreshAccessToken(refreshToken: string): Promise<PinterestTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

// ---------------------------------------------------------------
// Authenticated REST calls
// ---------------------------------------------------------------

// Thrown for the one failure class where retrying with the SAME token can
// never help: Pinterest rejected it (401). Callers (see withPinterestToken in
// pinterest-oauth.functions.ts) catch this specifically to force a refresh
// and retry once — every other error type is left alone.
export class PinterestAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinterestAuthError";
  }
}

async function pinterestFetch(accessToken: string, path: string, init?: RequestInit) {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = describePinterestError(res.status, text);
    if (res.status === 401) {
      throw new PinterestAuthError(
        `Pinterest rejected the access token calling ${path} (401 unauthorized: ${detail}). ` +
          `The token is likely expired, revoked, or missing a required scope — reconnect Pinterest.`,
      );
    }
    throw new Error(`Pinterest API ${path} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

// Pinterest returns timestamps like "2022-12-25T18:08:51" with no timezone
// designator; its docs describe these as UTC, so pin down the offset
// explicitly rather than letting each consumer (JS Date, Postgres) guess.
function toUtcIso(value: string | null | undefined): string | null {
  if (!value) return null;
  return /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
}

export type PinterestBoard = {
  id: string;
  name: string;
  description?: string | null;
  createdAt: string | null;
};

function toBoard(b: {
  id: string;
  name: string;
  description?: string | null;
  created_at?: string | null;
}): PinterestBoard {
  return {
    id: b.id,
    name: b.name,
    description: b.description ?? null,
    createdAt: toUtcIso(b.created_at),
  };
}

export async function listBoards(accessToken: string): Promise<PinterestBoard[]> {
  const boards: PinterestBoard[] = [];
  let bookmark: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (bookmark) qs.set("bookmark", bookmark);
    const data = await pinterestFetch(accessToken, `/boards?${qs.toString()}`);
    for (const b of data.items ?? []) boards.push(toBoard(b));
    bookmark = data.bookmark || undefined;
  } while (bookmark);
  return boards;
}

/**
 * One board by id.
 *
 * Needed because `GET /boards` is not a complete list of the account's boards.
 * Verified against a live account: a board holding three pins the creator had
 * just made never appeared in the listing, yet fetching it by id returns it
 * normally (privacy PUBLIC, nothing unusual about it). Any board id we learn
 * about some other way — from a pin's `board_id` — can therefore still be
 * resolved, which is what keeps those pins from vanishing.
 */
export async function getBoard(
  accessToken: string,
  boardId: string,
): Promise<PinterestBoard | null> {
  try {
    const b = await pinterestFetch(accessToken, `/boards/${boardId}`);
    return b?.id ? toBoard(b) : null;
  } catch (e) {
    if (e instanceof PinterestAuthError) throw e;
    return null;
  }
}

export type PinterestPin = {
  id: string;
  title: string | null;
  description: string | null;
  link: string | null;
  imageUrl: string | null;
  createdAt: string | null;
  /** Which board Pinterest says this pin lives on — the only reliable way to
   * place pins found through the account-wide listing. */
  boardId: string | null;
  // Pinterest's own "authored by this account" flag — false means this pin
  // was saved/repinned from someone else's content, not created by the
  // creator. Confirmed against the real API: is_owner tracks parent_pin_id
  // exactly (non-null parent_pin_id <=> is_owner === false).
  isOwner: boolean;
};

// Pinterest v5 returns `images` as a map keyed by size, e.g. `originals`,
// `600x`, `1200x`, `400x300`, `150x150` (no guaranteed key or order) — pick
// whichever variant has the largest reported width/height, preferring
// `originals` when present.
function largestImage(media: unknown): string | null {
  const images = (
    media as
      { images?: Record<string, { url?: string; width?: number; height?: number }> } | undefined
  )?.images;
  if (!images) return null;
  if (images.originals?.url) return images.originals.url;

  let best: { url: string; area: number } | null = null;
  for (const [key, v] of Object.entries(images)) {
    if (!v?.url) continue;
    const dims = key.match(/^(\d+)x(\d+)?$/);
    const area =
      v.width && v.height
        ? v.width * v.height
        : dims
          ? Number(dims[1]) * Number(dims[2] || dims[1])
          : 0;
    if (!best || area > best.area) best = { url: v.url, area };
  }
  return best?.url ?? null;
}

function toPin(p: Record<string, unknown>, fallbackBoardId: string | null): PinterestPin {
  return {
    id: p.id as string,
    title: (p.title as string) ?? null,
    description: (p.description as string) ?? null,
    link: (p.link as string) ?? null,
    imageUrl: largestImage(p.media),
    createdAt: toUtcIso(p.created_at as string),
    boardId: ((p.board_id as string) ?? null) || fallbackBoardId,
    isOwner: p.is_owner !== false,
  };
}

export async function listBoardPins(accessToken: string, boardId: string): Promise<PinterestPin[]> {
  const pins: PinterestPin[] = [];
  let bookmark: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (bookmark) qs.set("bookmark", bookmark);
    const data = await pinterestFetch(accessToken, `/boards/${boardId}/pins?${qs.toString()}`);
    for (const p of data.items ?? []) pins.push(toPin(p, boardId));
    bookmark = data.bookmark || undefined;
  } while (bookmark);
  return pins;
}

/**
 * Every pin on the account, walking Pinterest's own pin listing rather than the
 * boards.
 *
 * `include_protected_pins` is the whole point. Without it this endpoint returned
 * 19 pins for a live account — all of them saves — and hid the 3 pins the creator
 * had actually made. With it, all 22 come back. Those 3 are also the ones that
 * never appear under any board `GET /boards` lists, so walking boards alone can
 * never find them: "connected Pinterest, imported 0 pins" was exactly this.
 */
export async function listUserPins(accessToken: string): Promise<PinterestPin[]> {
  const pins: PinterestPin[] = [];
  let bookmark: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100", include_protected_pins: "true" });
    if (bookmark) qs.set("bookmark", bookmark);
    const data = await pinterestFetch(accessToken, `/pins?${qs.toString()}`);
    for (const p of data.items ?? []) pins.push(toPin(p, null));
    bookmark = data.bookmark || undefined;
  } while (bookmark);
  return pins;
}

export type PinterestAccount = {
  username: string | null;
  accountId: string | null;
  // The profile fields the health score reads. Pinterest owns them — ShopMyPin can
  // only report what's set and send the creator to the right settings page.
  about: string | null;
  websiteUrl: string | null;
  profileImage: string | null;
  businessName: string | null;
  accountType: string | null;
  pinCount: number;
  boardCount: number;
  followerCount: number;
  followingCount: number;
  monthlyViews: number;
};

/** Empty strings come back from Pinterest for unset text fields; normalise them
 * to null so "set" is a single check everywhere downstream. */
function nullIfBlank(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

export async function getUserAccount(accessToken: string): Promise<PinterestAccount> {
  const data = await pinterestFetch(accessToken, "/user_account");
  return {
    username: data.username ?? null,
    accountId: data.id ?? null,
    about: nullIfBlank(data.about),
    websiteUrl: nullIfBlank(data.website_url),
    profileImage: nullIfBlank(data.profile_image),
    businessName: nullIfBlank(data.business_name),
    accountType: nullIfBlank(data.account_type),
    pinCount: Number(data.pin_count ?? 0),
    boardCount: Number(data.board_count ?? 0),
    followerCount: Number(data.follower_count ?? 0),
    followingCount: Number(data.following_count ?? 0),
    monthlyViews: Number(data.monthly_views ?? 0),
  };
}

// Account-wide traffic for a date range (max 90 days back — Pinterest rejects
// anything older with "You can only get data from the last 90 days").
export type PinterestAccountAnalytics = {
  impressions: number;
  pinClicks: number;
  outboundClicks: number;
  saves: number;
  engagement: number;
};

const ANALYTICS_METRIC_TYPES = "IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE,ENGAGEMENT";

function toAnalyticsMetrics(
  summary: Record<string, number> | undefined,
): PinterestAccountAnalytics {
  return {
    impressions: Number(summary?.IMPRESSION ?? 0),
    pinClicks: Number(summary?.PIN_CLICK ?? 0),
    outboundClicks: Number(summary?.OUTBOUND_CLICK ?? 0),
    saves: Number(summary?.SAVE ?? 0),
    engagement: Number(summary?.ENGAGEMENT ?? 0),
  };
}

export async function getAccountAnalytics(
  accessToken: string,
  range: { startDate: Date; endDate: Date },
): Promise<PinterestAccountAnalytics> {
  const qs = new URLSearchParams({
    start_date: range.startDate.toISOString().slice(0, 10),
    end_date: range.endDate.toISOString().slice(0, 10),
    metric_types: ANALYTICS_METRIC_TYPES,
  });
  const data = await pinterestFetch(accessToken, `/user_account/analytics?${qs.toString()}`);
  return toAnalyticsMetrics(data?.all?.summary_metrics);
}

export type PinterestTopPin = { pinId: string } & PinterestAccountAnalytics;

export async function getTopPinsAnalytics(
  accessToken: string,
  range: { startDate: Date; endDate: Date; limit?: number },
): Promise<PinterestTopPin[]> {
  const qs = new URLSearchParams({
    start_date: range.startDate.toISOString().slice(0, 10),
    end_date: range.endDate.toISOString().slice(0, 10),
    metric_types: ANALYTICS_METRIC_TYPES,
    sort_by: "IMPRESSION",
  });
  const data = await pinterestFetch(
    accessToken,
    `/user_account/analytics/top_pins?${qs.toString()}`,
  );
  const items = (data?.pins ?? []) as Array<{ pin_id: string; metrics: Record<string, number> }>;
  return items
    .slice(0, range.limit ?? 500)
    .map((p) => ({ pinId: p.pin_id, ...toAnalyticsMetrics(p.metrics) }));
}

export async function createPin(
  accessToken: string,
  input: { boardId: string; title: string; description?: string; link?: string; imageUrl: string },
): Promise<PinterestPin> {
  const data = await pinterestFetch(accessToken, "/pins", {
    method: "POST",
    body: JSON.stringify({
      board_id: input.boardId,
      title: input.title,
      description: input.description || undefined,
      link: input.link || undefined,
      media_source: { source_type: "image_url", url: input.imageUrl },
    }),
  });
  return {
    id: data.id,
    title: data.title ?? null,
    description: data.description ?? null,
    link: data.link ?? null,
    imageUrl: largestImage(data.media),
    createdAt: toUtcIso(data.created_at),
    boardId: data.board_id ?? null,
    // Just published through our own create-pin flow — always owned.
    isOwner: true,
  };
}

export async function getPinAnalytics(
  accessToken: string,
  pinId: string,
  range?: { startDate: Date; endDate: Date },
): Promise<PinterestAccountAnalytics> {
  const endDate = range?.endDate ?? new Date();
  const startDate = range?.startDate ?? new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
  const qs = new URLSearchParams({
    start_date: startDate.toISOString().slice(0, 10),
    end_date: endDate.toISOString().slice(0, 10),
    metric_types: ANALYTICS_METRIC_TYPES,
  });
  try {
    const data = await pinterestFetch(accessToken, `/pins/${pinId}/analytics?${qs.toString()}`);
    return toAnalyticsMetrics(data?.all?.summary_metrics ?? data?.summary_metrics);
  } catch (e) {
    // A rejected token must propagate — swallowing it here made a dead token
    // look like "every pin has 0 impressions" and OVERWROTE real synced
    // numbers with zeros. The caller's token-refresh layer handles it.
    if (e instanceof PinterestAuthError) throw e;
    // Analytics can lag behind a freshly-created Pin, or be unavailable in
    // Sandbox — don't fail the whole sync over one Pin's metrics.
    return { impressions: 0, pinClicks: 0, outboundClicks: 0, saves: 0, engagement: 0 };
  }
}
