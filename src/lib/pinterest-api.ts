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

// Pinterest's three board privacy levels. PROTECTED and SECRET are both
// non-public: SECRET is the creator's private board, PROTECTED is a business
// board hidden from the profile (and what an ad-only board silently becomes).
// Only PUBLIC content may ever be imported — see isPublicBoard.
export type BoardPrivacy = "PUBLIC" | "PROTECTED" | "SECRET";

export type PinterestBoard = {
  id: string;
  name: string;
  description?: string | null;
  createdAt: string | null;
  /** What Pinterest said this board's privacy is, or null when the field was
   * absent or carried a value outside the documented enum. Null is NOT treated
   * as public — see isPublicBoard. */
  privacy: BoardPrivacy | null;
};

function toPrivacy(value: unknown): BoardPrivacy | null {
  return value === "PUBLIC" || value === "PROTECTED" || value === "SECRET" ? value : null;
}

/**
 * The single public/private gate, deliberately FAIL-CLOSED.
 *
 * Anything that isn't an explicit "PUBLIC" — PROTECTED, SECRET, an
 * undocumented value, or a missing field — reads as not public. The spec gives
 * `privacy` a default of PUBLIC, so defaulting an absent field the same way
 * would look reasonable; it is the wrong default here, because the cost of the
 * two mistakes is not symmetric. Dropping a public board is a board the creator
 * can ask about. Importing a secret one publishes something they chose to hide.
 *
 * The listing calls also pass `privacy=PUBLIC` so Pinterest filters server-side;
 * this is the second gate, and the only one covering boards resolved by id.
 */
export function isPublicBoard(board: Pick<PinterestBoard, "privacy">): boolean {
  return board.privacy === "PUBLIC";
}

function toBoard(b: {
  id: string;
  name: string;
  description?: string | null;
  created_at?: string | null;
  privacy?: unknown;
}): PinterestBoard {
  return {
    id: b.id,
    name: b.name,
    description: b.description ?? null,
    createdAt: toUtcIso(b.created_at),
    privacy: toPrivacy(b.privacy),
  };
}

/**
 * The account's PUBLIC boards only.
 *
 * `privacy=PUBLIC` is a documented `GET /boards` filter, so the exclusion
 * happens on Pinterest's side and secret boards never travel over the wire.
 * The local `isPublicBoard` pass behind it is not redundant: it also catches a
 * board whose `privacy` field is missing or unrecognised, which the server-side
 * filter would have let through as "PUBLIC by default".
 */
export type BoardListing = {
  boards: PinterestBoard[];
  /** Boards on the account that were left behind because they aren't public.
   * Returned rather than only logged: a creator whose boards are all secret sees
   * an empty app, and the only thing that distinguishes that from a broken sync
   * is this number reaching the screen. */
  nonPublicSkipped: number;
  /** Boards dropped because `privacy` was missing or unrecognised. Separate from
   * the above because it means Pinterest changed its payload, not that the
   * creator hid something. */
  unknownPrivacySkipped: number;
};

export async function listBoards(accessToken: string): Promise<BoardListing> {
  const boards: PinterestBoard[] = [];
  let droppedNonPublic = 0;
  let droppedUnknown = 0;
  let bookmark: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100", privacy: "PUBLIC" });
    if (bookmark) qs.set("bookmark", bookmark);
    const data = await pinterestFetch(accessToken, `/boards?${qs.toString()}`);
    for (const raw of data.items ?? []) {
      const board = toBoard(raw);
      if (isPublicBoard(board)) {
        boards.push(board);
        continue;
      }
      // Split the counters because the two causes need different responses: a
      // SECRET board here means the server-side filter was ignored, while a null
      // means Pinterest stopped sending `privacy` and this gate is now dropping
      // everything. Either way the log names it instead of leaving "imported 0
      // boards" to be guessed at.
      if (board.privacy === null) droppedUnknown++;
      else droppedNonPublic++;
    }
    bookmark = data.bookmark || undefined;
  } while (bookmark);

  if (droppedNonPublic > 0) {
    console.warn(
      `[pinterest-api] GET /boards?privacy=PUBLIC still returned ${droppedNonPublic} non-public board(s) — dropped locally`,
    );
  }
  if (droppedUnknown > 0) {
    console.warn(
      `[pinterest-api] dropped ${droppedUnknown} board(s) with no usable \`privacy\` field. ` +
        `If this is every board, Pinterest has stopped returning the field and the public-only gate is over-filtering.`,
    );
  }
  return {
    boards,
    nonPublicSkipped: droppedNonPublic,
    unknownPrivacySkipped: droppedUnknown,
  };
}

export async function createBoard(
  accessToken: string,
  input: { name: string; description?: string },
): Promise<PinterestBoard> {
  const data = await pinterestFetch(accessToken, "/boards", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      description: input.description || undefined,
      privacy: "PUBLIC",
    }),
  });
  return toBoard(data);
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
 *
 * This path takes no `privacy` filter, so the returned board carries its
 * privacy and the CALLER must gate on `isPublicBoard`. That is the whole reason
 * `privacy` is on the type rather than being consumed inside `listBoards`.
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
  // Pinterest's own "authored by this account" flag. Strict: only an explicit
  // `true` counts, so an absent field reads as not-owned rather than owned.
  //
  // NOT sufficient on its own to mean "created". An earlier comment here claimed
  // is_owner tracked parent_pin_id exactly; measuring a live account disproved
  // it (15 pins report is_owner: true while carrying a parent_pin_id). Use
  // isCreatedByUser, never this field alone.
  isOwner: boolean;
  /** Set when this pin was saved from another pin — Pinterest's second, and more
   * literal, "this is a repin" signal. Null for a pin the creator authored. */
  parentPinId: string | null;
};

/**
 * Created by this creator, not saved from someone else.
 *
 * Both of Pinterest's signals have to agree, and both are read fail-closed: a
 * pin counts as authored only when `is_owner` is explicitly true AND it has no
 * `parent_pin_id`.
 *
 * Requiring both is not belt-and-braces — the signals genuinely disagree.
 * Measured against a live account of 469 pins: 206 carry a `parent_pin_id` (all
 * saves), and 15 of those ALSO report `is_owner: true` — a pin the account saved
 * from someone else and now owns a copy of. `is_owner` alone therefore admitted
 * 278 pins where the truth is 263, and those 15 saves were being imported as
 * authored work. `parent_pin_id` is the signal that matches Pinterest's own
 * `pin_filter=exclude_repins` exactly (263 = 263 on that account).
 */
export function isCreatedByUser(pin: PinterestPin): boolean {
  return pin.isOwner && pin.parentPinId === null;
}

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
    isOwner: p.is_owner === true,
    parentPinId: (p.parent_pin_id as string) ?? null,
  };
}

/**
 * Running tally for one listing walk, so the reason pins were dropped survives
 * as something the caller can report — not just a log line.
 *
 * `savedIds` holds ids rather than a counter because the two discovery passes
 * overlap: the same save can be dropped by both the per-board walk and the
 * account-wide listing, and the sync reports one unique total.
 */
export type PinFilterStats = { savedIds: Set<string>; noOwnerFlag: number };

export function emptyPinFilterStats(): PinFilterStats {
  return { savedIds: new Set<string>(), noOwnerFlag: 0 };
}

/**
 * A listing walk's result: the pins that passed the authored-only gate, plus
 * what the gate rejected on the way.
 *
 * The stats travel WITH the pins deliberately. They used to be console-only,
 * which made `PinterestSyncResult.pins.savedSkipped` unreachable — it counted a
 * second, redundant filter pass over pins these functions had already dropped,
 * so it was structurally always 0. An account whose every pin is a repin then
 * imported nothing and said nothing, which is indistinguishable from a broken
 * integration. This is the number that explains the empty state.
 */
export type PinListing = { pins: PinterestPin[]; stats: PinFilterStats };

/** Convert raw items, keeping only authored pins. */
function pushCreatedPins(
  target: PinterestPin[],
  items: Array<Record<string, unknown>>,
  fallbackBoardId: string | null,
  stats: PinFilterStats,
) {
  for (const raw of items) {
    if (raw.is_owner === undefined) stats.noOwnerFlag++;
    const pin = toPin(raw, fallbackBoardId);
    if (isCreatedByUser(pin)) target.push(pin);
    else stats.savedIds.add(pin.id);
  }
}

function logPinFilterStats(source: string, kept: number, stats: PinFilterStats) {
  if (stats.savedIds.size > 0) {
    console.info(
      `[pinterest-api] ${source}: kept ${kept} authored pin(s), skipped ${stats.savedIds.size} save(s)`,
    );
  }
  // `is_owner` is documented and has always been present. If it ever stops
  // arriving, the strict gate drops every pin, and this is the line that says so
  // rather than leaving it to look like an account with no content.
  if (stats.noOwnerFlag > 0) {
    console.warn(
      `[pinterest-api] ${source}: ${stats.noOwnerFlag} pin(s) arrived with no \`is_owner\` field and were treated as saves. ` +
        `If this equals the total, Pinterest has stopped sending it and the created-only gate is over-filtering.`,
    );
  }
}

/**
 * The authored pins on one board.
 *
 * `GET /boards/{id}/pins` accepts neither `pin_filter` nor
 * `include_protected_pins` (verified against Pinterest's OpenAPI description),
 * so unlike the account-wide listing this cannot push the work server-side —
 * every item is fetched and the repins are dropped here.
 *
 * Pin-level privacy is not a thing on this endpoint either: a pin is as public
 * as the board holding it, so the caller's job is to only ever pass a board that
 * passed `isPublicBoard`.
 */
export async function listBoardPins(accessToken: string, boardId: string): Promise<PinListing> {
  const pins: PinterestPin[] = [];
  const stats = emptyPinFilterStats();
  let bookmark: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (bookmark) qs.set("bookmark", bookmark);
    const data = await pinterestFetch(accessToken, `/boards/${boardId}/pins?${qs.toString()}`);
    pushCreatedPins(pins, data.items ?? [], boardId, stats);
    bookmark = data.bookmark || undefined;
  } while (bookmark);
  logPinFilterStats(`board ${boardId}`, pins.length, stats);
  return { pins, stats };
}

/**
 * Every AUTHORED, PUBLIC pin on the account, walking Pinterest's own pin listing
 * rather than the boards. Still needed as a safety net: a live account has
 * authored pins on a board that `GET /boards` does not list, and walking boards
 * alone is what produced "connected Pinterest, imported 0 pins".
 *
 * Two filters, both server-side:
 *
 *   pin_filter=exclude_repins   Pinterest itself omits pins saved from someone
 *                               else, so saves never travel over the wire.
 *   include_protected_pins      LEFT OFF (its documented default is false).
 *
 * That second one used to be set to `true`, and the comment here explained why:
 * without it the endpoint returned 19 pins for a live account — all saves — and
 * hid the 3 the creator had made. Those 3 live on a PROTECTED board, which is
 * exactly the content that must not be imported now, so the flag has to go. The
 * consequence is deliberate and worth stating plainly: an account whose only
 * authored pins sit on secret or protected boards now imports nothing, and that
 * is the correct outcome rather than a regression. Making such a board public on
 * Pinterest is what brings its pins in.
 */
export async function listUserPins(accessToken: string): Promise<PinListing> {
  const pins: PinterestPin[] = [];
  const stats = emptyPinFilterStats();
  let bookmark: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100", pin_filter: "exclude_repins" });
    if (bookmark) qs.set("bookmark", bookmark);
    const data = await pinterestFetch(accessToken, `/pins?${qs.toString()}`);
    pushCreatedPins(pins, data.items ?? [], null, stats);
    bookmark = data.bookmark || undefined;
  } while (bookmark);
  logPinFilterStats("account listing", pins.length, stats);
  return { pins, stats };
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
    // Just published through our own create-pin flow — always owned, never a save.
    isOwner: true,
    parentPinId: null,
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
