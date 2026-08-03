import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getServiceSupabase } from "@/integrations/supabase/service-client";
import {
  getBoard,
  getPinAnalytics,
  getUserAccount,
  listBoardPins,
  listBoards,
  listUserPins,
  PinterestAuthError,
  type PinterestBoard,
  type PinterestPin,
} from "@/lib/pinterest-api";
import { withPinterestToken } from "@/lib/pinterest-oauth.functions";

/**
 * The one Pinterest sync.
 *
 * What made the old importer feel broken wasn't the API — boards, pins, profile
 * and analytics all answer fine (verified against the live account). It was that
 * `importPinterestBoards` only ever INSERTED. Anything already in the database
 * was skipped forever, so:
 *
 *   - renaming a board or rewriting a pin on pinterest.com changed nothing here
 *   - deleting a pin there left it in Pinearn permanently
 *   - a connection made from Settings (rather than onboarding) never synced at
 *     all, because the only caller was the onboarding screen
 *   - analytics were never part of the connect flow — impressions and clicks
 *     stayed at 0 until someone happened to open the Analytics page
 *
 * This module replaces that with a reconcile: fetch the account as it is now,
 * then make our copy match it — creating what's new, UPDATING what changed,
 * flagging what disappeared, and backfilling analytics within a time budget.
 *
 * It never throws for an expired or revoked connection. That case sets
 * `needsReconnect` on the result and flips the connection's `needs_reauth`, so
 * the UI can show "reconnect Pinterest" instead of an empty dashboard that looks
 * like a bug — which is exactly what three of the stored connections need today.
 */

/* ---------------- Result shape ---------------- */

export type PinterestSyncResult = {
  ok: boolean;
  /** The token is dead and only a fresh OAuth round-trip can fix it. */
  needsReconnect: boolean;
  error: string | null;
  username: string | null;
  boards: { created: number; updated: number; removed: number };
  pins: {
    created: number;
    updated: number;
    rehomed: number;
    removed: number;
    /** Pins on the account that were saved from someone else, not authored — not
     * imported (this is a creator app), but reported so "0 pins imported" can
     * explain itself instead of looking like a failure. */
    savedSkipped: number;
  };
  analytics: { updated: number; remaining: number };
  syncedAt: string;
};

function emptyResult(): PinterestSyncResult {
  return {
    ok: true,
    needsReconnect: false,
    error: null,
    username: null,
    boards: { created: 0, updated: 0, removed: 0 },
    pins: { created: 0, updated: 0, rehomed: 0, removed: 0, savedSkipped: 0 },
    analytics: { updated: 0, remaining: 0 },
    syncedAt: new Date().toISOString(),
  };
}

/* ---------------- Tunables ---------------- */

// Per-pin analytics is Pinterest's most aggressively rate-limited endpoint, so
// the backfill is time-boxed rather than count-boxed: a 578-pin account gets
// through it over several syncs instead of stalling one request for minutes.
const ANALYTICS_BUDGET_MS = 12_000;
const ANALYTICS_DELAY_MS = 260;
const ANALYTICS_MAX_PINS = 60;
// Rows per write. Postgres handles far more, but this keeps any single failure
// small enough to report precisely.
const CHUNK = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** PostgREST's "you asked for a column this database doesn't have" (PGRST204) —
 * i.e. 20260803120000_pinterest_sync_state.sql hasn't been applied. Everything
 * that column enables degrades instead of failing: the sync still creates and
 * re-homes, it just can't tell a local edit from an untouched row, so it leaves
 * existing copy alone. */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    /could not find the .* column|column .* does not exist/i.test(error.message ?? "")
  );
}

type Supa = ReturnType<typeof getServiceSupabase>;

/** Postgres 23505 — the row is already there under some unique key. */
function isDuplicateKey(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "23505" || /duplicate key value/i.test(error.message ?? "");
}

/** Re-read a collection this user owns for a Pinterest board id. Used only after
 * an insert lost a race (or hit the pre-migration global unique index) — a plain
 * lookup is cheaper than reasoning about which of the two it was. */
async function findOwnCollection(
  supabase: Supa,
  userId: string,
  boardId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("collections")
    .select("id")
    .eq("user_id", userId)
    .eq("pinterest_board_id", boardId)
    .maybeSingle();
  return data?.id ?? null;
}

/** One probe per run instead of guessing per write. */
async function hasSyncColumns(supabase: Supa): Promise<boolean> {
  const { error } = await supabase.from("pins").select("pinterest_synced_at").limit(1);
  return !isMissingColumn(error as { code?: string; message?: string } | null);
}

async function hasConnectionStateColumns(supabase: Supa): Promise<boolean> {
  const { error } = await supabase.from("pinterest_connections").select("last_synced_at").limit(1);
  return !isMissingColumn(error as { code?: string; message?: string } | null);
}

/* ---------------- Adopt-or-keep ---------------- */

/**
 * The rule that lets a re-sync pull Pinterest's edits in without wiping the
 * creator's (or Boost's) work.
 *
 * `baseline` is what Pinterest said last time. If the local value still equals it,
 * nobody has touched this field here — Pinterest is the authority, adopt the new
 * value. If it differs, someone rewrote it in Pinearn and that wins. With no
 * baseline (pre-migration rows, or a database without the columns) the safe
 * assumption is "locally owned", except when the local value is empty — an empty
 * field can only be improved by Pinterest's copy.
 */
function resolveField(
  local: string | null | undefined,
  baseline: string | null | undefined,
  incoming: string | null | undefined,
  hasBaseline: boolean,
): string | null {
  const l = (local ?? "").trim();
  const b = (baseline ?? "").trim();
  const i = (incoming ?? "").trim();
  if (!l) return i || null;
  if (!hasBaseline) return local ?? null;
  return l === b ? i || null : (local ?? null);
}

/* ---------------- The sync ---------------- */

async function runSync(userId: string, opts: { analytics: boolean }): Promise<PinterestSyncResult> {
  const result = emptyResult();
  const supabase = getServiceSupabase();
  const syncColumns = await hasSyncColumns(supabase);
  const stateColumns = await hasConnectionStateColumns(supabase);
  const now = new Date().toISOString();

  // ---- Storefront. Missing used to be a hard "No storefront found for user"
  // that aborted the whole connect flow; create it instead.
  let storefrontId: string | null = null;
  {
    const { data } = await supabase
      .from("storefronts")
      .select("id")
      .eq("user_id", userId)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();
    storefrontId = data?.id ?? null;
  }
  if (!storefrontId) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();
    const name = profile?.display_name?.trim() || "My storefront";
    const slug = `store-${userId.slice(0, 8)}`;
    const { data: created, error } = await supabase
      .from("storefronts")
      .insert({ user_id: userId, name, slug, is_default: true })
      .select("id")
      .single();
    if (error) throw new Error(`Couldn't create a storefront to sync into: ${error.message}`);
    storefrontId = created.id;
  }

  // ---- Account: keeps the profile (and the Profile Completeness score) honest.
  const account = await withPinterestToken(userId, (t) => getUserAccount(t));
  result.username = account.username;
  await supabase
    .from("profiles")
    .update({
      pinterest_connected: true,
      pinterest_username: account.username,
      source_platform: "pinterest",
    })
    .eq("id", userId);

  // ---- What the account actually contains.
  //
  // Two sources, because neither is complete on its own:
  //
  //   GET /boards            — misses boards (a live account has a perfectly
  //                            ordinary PUBLIC board holding three freshly
  //                            created pins that this listing never returns)
  //   GET /pins              — misses pins unless include_protected_pins is set,
  //                            and those hidden ones are exactly the authored
  //                            pins this app exists to work on
  //
  // Walking boards alone is what produced "connected Pinterest, found 0 pins".
  const [listedBoards, accountPins] = await Promise.all([
    withPinterestToken(userId, (t) => listBoards(t)),
    withPinterestToken(userId, (t) => listUserPins(t)).catch((e) => {
      if (e instanceof PinterestAuthError) throw e;
      console.error("[pinterest-sync] account pin listing failed", e);
      return [] as PinterestPin[];
    }),
  ]);

  // Any board a pin claims to live on, that the listing didn't mention, is
  // fetched by id — that's how the unlisted board gets picked up.
  const known = new Set(listedBoards.map((b) => b.id));
  const missing = [
    ...new Set(
      accountPins
        .filter((p) => p.isOwner && p.boardId && !known.has(p.boardId))
        .map((p) => p.boardId as string),
    ),
  ];
  const recovered: PinterestBoard[] = [];
  for (const boardId of missing) {
    const board = await withPinterestToken(userId, (t) => getBoard(t, boardId));
    if (board) recovered.push(board);
  }
  if (recovered.length > 0) {
    console.info(
      `[pinterest-sync] recovered ${recovered.length} board(s) that GET /boards didn't list`,
    );
  }

  const boards = [...listedBoards, ...recovered].sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bt - at;
  });

  const collectionIdByBoard = await reconcileBoards({
    supabase,
    userId,
    storefrontId,
    boards,
    syncColumns,
    now,
    result,
  });

  // ---- Pins, board by board.
  await reconcilePins({
    supabase,
    userId,
    storefrontId,
    boards,
    accountPins,
    collectionIdByBoard,
    syncColumns,
    now,
    result,
  });

  // ---- Analytics: impressions/clicks for as many pins as the budget allows.
  if (opts.analytics) {
    result.analytics = await backfillAnalytics(supabase, userId, stateColumns);
  }

  // ---- Sync state, for "Synced 4m ago" and the staleness check.
  if (stateColumns) {
    await supabase
      .from("pinterest_connections")
      .update({
        last_synced_at: now,
        last_sync_error: null,
        needs_reauth: false,
        last_sync_summary: {
          boards: result.boards,
          pins: result.pins,
          analytics: result.analytics,
        },
      } as never)
      .eq("user_id", userId);
  }

  result.syncedAt = now;
  return result;
}

/** Boards → collections + board rows. Creates what's new, adopts renames and
 * description edits, and flags boards that disappeared from Pinterest. */
async function reconcileBoards({
  supabase,
  userId,
  storefrontId,
  boards,
  syncColumns,
  now,
  result,
}: {
  supabase: Supa;
  userId: string;
  storefrontId: string;
  boards: PinterestBoard[];
  syncColumns: boolean;
  now: string;
  result: PinterestSyncResult;
}): Promise<Map<string, string>> {
  const collectionIdByBoard = new Map<string, string>();

  const { data: existingCollections } = await supabase
    .from("collections")
    .select("id, pinterest_board_id, name, description, slug")
    .eq("user_id", userId)
    .not("pinterest_board_id", "is", null);

  // The baseline columns are selected separately so a database without them
  // doesn't fail the main read.
  const baselines = new Map<string, { name: string | null; description: string | null }>();
  if (syncColumns) {
    const { data } = await supabase
      .from("collections")
      .select("pinterest_board_id, pinterest_name, pinterest_description")
      .eq("user_id", userId)
      .not("pinterest_board_id", "is", null);
    for (const row of (data ?? []) as unknown as Array<{
      pinterest_board_id: string;
      pinterest_name: string | null;
      pinterest_description: string | null;
    }>) {
      baselines.set(row.pinterest_board_id, {
        name: row.pinterest_name,
        description: row.pinterest_description,
      });
    }
  }

  const existingByBoardId = new Map(
    (existingCollections ?? []).map((c) => [c.pinterest_board_id as string, c]),
  );

  const { data: positions } = await supabase
    .from("collections")
    .select("position")
    .eq("storefront_id", storefrontId)
    .order("position", { ascending: false })
    .limit(1);
  let nextPosition = (positions?.[0]?.position ?? -1) + 1;

  const { data: slugRows } = await supabase
    .from("collections")
    .select("slug")
    .eq("storefront_id", storefrontId);
  const usedSlugs = new Set((slugRows ?? []).map((c) => c.slug as string));
  const uniqueSlug = (name: string) => {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "board";
    if (!usedSlugs.has(base)) {
      usedSlugs.add(base);
      return base;
    }
    let n = 2;
    while (usedSlugs.has(`${base}-${n}`)) n++;
    usedSlugs.add(`${base}-${n}`);
    return `${base}-${n}`;
  };

  // Board rows (the storefront's Boards tab reads these, not collections).
  const { data: existingBoardRows } = await supabase
    .from("boards")
    .select("id, pinterest_board_id, name")
    .eq("user_id", userId)
    .not("pinterest_board_id", "is", null);
  const boardRowByBoardId = new Map(
    (existingBoardRows ?? []).map((b) => [b.pinterest_board_id as string, b]),
  );
  const { data: boardPositions } = await supabase
    .from("boards")
    .select("position")
    .eq("storefront_id", storefrontId)
    .order("position", { ascending: false })
    .limit(1);
  let nextBoardPosition = (boardPositions?.[0]?.position ?? -1) + 1;

  for (const board of boards) {
    const existing = existingByBoardId.get(board.id);

    if (!existing) {
      const { data: created, error } = await supabase
        .from("collections")
        .insert({
          user_id: userId,
          storefront_id: storefrontId,
          name: board.name,
          slug: uniqueSlug(board.name),
          description: board.description ?? null,
          source: "pinterest",
          pinterest_board_id: board.id,
          position: nextPosition++,
          ...(syncColumns
            ? {
                pinterest_name: board.name,
                pinterest_description: board.description ?? null,
                pinterest_synced_at: now,
              }
            : {}),
        } as never)
        .select("id")
        .single();
      if (error) {
        // The board id is spoken for. Either this user already has the row and
        // the lookup above missed it, or — before
        // 20260803140000_pinterest_ids_per_user.sql — another Pinearn account
        // connected to the same Pinterest account claimed it globally.
        // Recovering the row here is what keeps the board's pins from being
        // skipped, which is how "0 pins and boards found" happened.
        const recoveredId = isDuplicateKey(error)
          ? await findOwnCollection(supabase, userId, board.id)
          : null;
        if (recoveredId) {
          collectionIdByBoard.set(board.id, recoveredId);
          continue;
        }
        console.error(
          "[pinterest-sync] collection insert failed",
          board.id,
          error.message,
          isDuplicateKey(error)
            ? "— this Pinterest board is already imported under a DIFFERENT Pinearn account. Apply supabase/migrations/20260803140000_pinterest_ids_per_user.sql to allow per-user copies."
            : "",
        );
        continue;
      }
      collectionIdByBoard.set(board.id, created.id);
      result.boards.created++;
    } else {
      collectionIdByBoard.set(board.id, existing.id);
      const baseline = baselines.get(board.id);
      const name =
        resolveField(existing.name, baseline?.name, board.name, syncColumns) || existing.name;
      const description = resolveField(
        existing.description,
        baseline?.description,
        board.description,
        syncColumns,
      );
      const changed = name !== existing.name || description !== existing.description;
      const { error } = await supabase
        .from("collections")
        .update({
          name,
          description,
          ...(syncColumns
            ? {
                pinterest_name: board.name,
                pinterest_description: board.description ?? null,
                pinterest_synced_at: now,
                pinterest_removed_at: null,
              }
            : {}),
        } as never)
        .eq("id", existing.id);
      if (!error && changed) result.boards.updated++;
    }

    // Mirror onto `boards` + membership.
    const collectionId = collectionIdByBoard.get(board.id);
    if (!collectionId) continue;
    let boardRow = boardRowByBoardId.get(board.id);
    if (!boardRow) {
      const { data: createdBoard, error } = await supabase
        .from("boards")
        .insert({
          user_id: userId,
          storefront_id: storefrontId,
          name: board.name,
          source: "pinterest",
          pinterest_board_id: board.id,
          position: nextBoardPosition++,
          ...(syncColumns ? { pinterest_name: board.name, pinterest_synced_at: now } : {}),
        } as never)
        .select("id, pinterest_board_id, name")
        .single();
      if (!error && createdBoard) {
        const row = { ...createdBoard, pinterest_board_id: board.id };
        boardRow = row;
        boardRowByBoardId.set(board.id, row);
      }
    } else if (boardRow.name !== board.name) {
      // Board rows carry no local editing surface, so Pinterest's name always wins.
      await supabase
        .from("boards")
        .update({
          name: board.name,
          ...(syncColumns
            ? { pinterest_name: board.name, pinterest_synced_at: now, pinterest_removed_at: null }
            : {}),
        } as never)
        .eq("id", boardRow.id);
    }
    if (boardRow) {
      await supabase
        .from("board_collections")
        .upsert(
          { board_id: boardRow.id, collection_id: collectionId, user_id: userId, position: 0 },
          { onConflict: "board_id,collection_id" },
        );
    }
  }

  // Boards that vanished from Pinterest. Soft-flagged, never deleted — they may
  // hold monetized pins, and one bad API response shouldn't destroy a storefront.
  if (syncColumns) {
    const liveIds = new Set(boards.map((b) => b.id));
    const goneCollections = (existingCollections ?? [])
      .map((c) => c.pinterest_board_id as string)
      .filter((id) => !liveIds.has(id));
    if (goneCollections.length > 0) {
      for (const batch of chunked(goneCollections)) {
        await supabase
          .from("collections")
          .update({ pinterest_removed_at: now } as never)
          .eq("user_id", userId)
          .in("pinterest_board_id", batch);
        await supabase
          .from("boards")
          .update({ pinterest_removed_at: now } as never)
          .eq("user_id", userId)
          .in("pinterest_board_id", batch);
      }
      result.boards.removed = goneCollections.length;
    }
  }

  return collectionIdByBoard;
}

/** Pins, board by board: insert new, adopt Pinterest's edits on untouched copy,
 * always refresh image/link, re-home moved pins, flag deleted ones. */
async function reconcilePins({
  supabase,
  userId,
  storefrontId,
  boards,
  accountPins,
  collectionIdByBoard,
  syncColumns,
  now,
  result,
}: {
  supabase: Supa;
  userId: string;
  storefrontId: string;
  boards: PinterestBoard[];
  /** The account-wide listing, including protected pins — the safety net for
   * anything the per-board walk can't see. */
  accountPins: PinterestPin[];
  collectionIdByBoard: Map<string, string>;
  syncColumns: boolean;
  now: string;
  result: PinterestSyncResult;
}) {
  type ExistingPin = {
    id: string;
    pinterest_pin_id: string;
    title: string;
    description: string | null;
    image_url: string | null;
    external_url: string | null;
    status: string;
    collection_id: string | null;
    pinterest_title?: string | null;
    pinterest_description?: string | null;
  };

  const columns = syncColumns
    ? "id, pinterest_pin_id, title, description, image_url, external_url, status, collection_id, pinterest_title, pinterest_description"
    : "id, pinterest_pin_id, title, description, image_url, external_url, status, collection_id";
  const { data: existingRows } = await supabase
    .from("pins")
    .select(columns)
    .eq("user_id", userId)
    .not("pinterest_pin_id", "is", null);
  const existingByPinId = new Map<string, ExistingPin>(
    ((existingRows ?? []) as unknown as ExistingPin[]).map((p) => [p.pinterest_pin_id, p]),
  );

  const seen = new Set<string>();

  // Merge both discovery passes into one board → pins map before writing
  // anything, so a pin found only in the account-wide listing still lands on its
  // real board, and a pin seen twice is written once.
  const pinsByBoard = new Map<string, Map<string, PinterestPin>>();
  const addPin = (boardId: string, pin: PinterestPin) => {
    let bucket = pinsByBoard.get(boardId);
    if (!bucket) {
      bucket = new Map();
      pinsByBoard.set(boardId, bucket);
    }
    // The per-board record wins on conflict: same pin, more complete payload.
    if (!bucket.has(pin.id)) bucket.set(pin.id, pin);
  };

  for (const board of boards) {
    if (!collectionIdByBoard.get(board.id)) continue;
    try {
      for (const p of await withPinterestToken(userId, (t) => listBoardPins(t, board.id))) {
        addPin(board.id, p);
      }
    } catch (e) {
      if (e instanceof PinterestAuthError) throw e;
      console.error("[pinterest-sync] board pins failed", board.id, e);
    }
  }
  for (const p of accountPins) {
    if (p.boardId && collectionIdByBoard.has(p.boardId)) addPin(p.boardId, p);
  }

  let skippedSaves = 0;

  for (const board of boards) {
    const collectionId = collectionIdByBoard.get(board.id);
    if (!collectionId) continue;

    const pins = [...(pinsByBoard.get(board.id)?.values() ?? [])];

    // Creator app: only pins the user authored, never repins of other people's
    // content. Counted rather than silently dropped — an account whose boards are
    // all saves would otherwise import nothing with no explanation, which is
    // indistinguishable from the sync being broken.
    const ownerPins = pins.filter((p) => p.isOwner);
    skippedSaves += pins.length - ownerPins.length;
    const inserts: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];

    for (const p of ownerPins) {
      seen.add(p.id);
      const existing = existingByPinId.get(p.id);

      if (!existing) {
        inserts.push({
          user_id: userId,
          storefront_id: storefrontId,
          collection_id: collectionId,
          title: p.title || "Untitled pin",
          description: p.description,
          image_url: p.imageUrl,
          external_url: p.link,
          source: "pinterest",
          status: "new",
          pinterest_pin_id: p.id,
          is_owner: true,
          ...(p.createdAt ? { created_at: p.createdAt } : {}),
          ...(syncColumns
            ? {
                pinterest_title: p.title,
                pinterest_description: p.description,
                pinterest_synced_at: now,
              }
            : {}),
        });
        existingByPinId.set(p.id, {
          id: "pending",
          pinterest_pin_id: p.id,
          title: p.title || "Untitled pin",
          description: p.description,
          image_url: p.imageUrl,
          external_url: p.link,
          status: "new",
          collection_id: collectionId,
        });
        continue;
      }
      if (existing.id === "pending") continue; // inserted earlier in this same run

      const title =
        resolveField(existing.title, existing.pinterest_title, p.title, syncColumns) ||
        existing.title;
      const description = resolveField(
        existing.description,
        existing.pinterest_description,
        p.description,
        syncColumns,
      );
      // A live pin sits in its own monetized collection on purpose — never drag
      // it back to the board's collection.
      const rehome = existing.status !== "live" && existing.collection_id !== collectionId;
      const changed =
        title !== existing.title ||
        description !== existing.description ||
        p.imageUrl !== existing.image_url ||
        p.link !== existing.external_url;

      if (changed || rehome || syncColumns) {
        updates.push({
          id: existing.id,
          user_id: userId,
          title,
          description,
          // Image and link are Pinterest's alone — nothing in Pinearn edits them,
          // so they track the source unconditionally.
          image_url: p.imageUrl,
          external_url: p.link,
          is_owner: true,
          ...(rehome ? { collection_id: collectionId, storefront_id: storefrontId } : {}),
          ...(syncColumns
            ? {
                pinterest_title: p.title,
                pinterest_description: p.description,
                pinterest_synced_at: now,
                pinterest_removed_at: null,
              }
            : {}),
        });
        if (changed) result.pins.updated++;
        if (rehome) result.pins.rehomed++;
      }
    }

    for (const batch of chunked(inserts)) {
      const { error } = await supabase.from("pins").insert(batch as never);
      if (!error) {
        result.pins.created += batch.length;
        continue;
      }
      if (!isDuplicateKey(error)) {
        console.error("[pinterest-sync] pin insert failed", board.id, error.message);
        continue;
      }
      // One already-claimed pin id used to take its entire batch down with it —
      // a single collision meant a whole board imported zero pins. Retry the rows
      // one at a time so the collision costs exactly one pin.
      let landed = 0;
      let blocked = 0;
      for (const row of batch) {
        const { error: rowErr } = await supabase.from("pins").insert(row as never);
        if (!rowErr) landed++;
        else if (isDuplicateKey(rowErr)) blocked++;
        else console.error("[pinterest-sync] pin insert failed", board.id, rowErr.message);
      }
      result.pins.created += landed;
      if (blocked > 0) {
        console.warn(
          `[pinterest-sync] ${blocked} pin(s) on board ${board.id} are already imported under a different Pinearn account — apply 20260803140000_pinterest_ids_per_user.sql to allow per-user copies`,
        );
      }
    }

    // Two shapes (re-homed rows carry collection_id, the rest don't) and
    // PostgREST requires every row in one upsert to have identical keys.
    const withHome = updates.filter((u) => "collection_id" in u);
    const withoutHome = updates.filter((u) => !("collection_id" in u));
    for (const group of [withHome, withoutHome]) {
      for (const batch of chunked(group)) {
        const { error } = await supabase.from("pins").upsert(batch as never, { onConflict: "id" });
        if (error) console.error("[pinterest-sync] pin update failed", board.id, error.message);
      }
    }
  }

  result.pins.savedSkipped = skippedSaves;
  if (skippedSaves > 0 && result.pins.created + result.pins.updated === 0) {
    console.info(
      `[pinterest-sync] every pin on this account (${skippedSaves}) is a save/repin — nothing to import for a creator app`,
    );
  }

  // Pins that no longer exist on Pinterest (deleted, or made secret). Flagged,
  // not deleted — they may carry attached products and earnings history.
  if (syncColumns) {
    const gone = [...existingByPinId.values()]
      .filter((p) => p.id !== "pending" && !seen.has(p.pinterest_pin_id))
      .map((p) => p.id);
    for (const batch of chunked(gone)) {
      const { error } = await supabase
        .from("pins")
        .update({ pinterest_removed_at: now } as never)
        .in("id", batch);
      if (!error) result.pins.removed += batch.length;
    }
  }
}

/** Impressions and clicks, oldest-synced first, inside a wall-clock budget.
 * Pinterest rate-limits per-pin analytics hard, so this deliberately doesn't try
 * to finish in one call — it reports what's left and the next sync continues. */
async function backfillAnalytics(
  supabase: Supa,
  userId: string,
  stateColumns: boolean,
): Promise<{ updated: number; remaining: number }> {
  const started = Date.now();

  const { count: total } = await supabase
    .from("pins")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_owner", true)
    .not("pinterest_pin_id", "is", null);

  const { data: pins } = await supabase
    .from("pins")
    .select("id, pinterest_pin_id")
    .eq("user_id", userId)
    .eq("is_owner", true)
    .not("pinterest_pin_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(ANALYTICS_MAX_PINS);

  let updated = 0;
  for (const p of pins ?? []) {
    if (Date.now() - started > ANALYTICS_BUDGET_MS) break;
    try {
      const stats = await withPinterestToken(userId, (t) =>
        getPinAnalytics(t, p.pinterest_pin_id as string),
      );
      const { error } = await supabase
        .from("pins")
        .update({ impressions: stats.impressions, clicks: stats.pinClicks })
        .eq("id", p.id);
      if (!error) updated++;
    } catch (e) {
      if (e instanceof PinterestAuthError) throw e;
      // A single pin's analytics 404ing or rate-limiting must not end the run.
      console.error("[pinterest-sync] pin analytics failed", p.id, e);
    }
    await sleep(ANALYTICS_DELAY_MS);
  }

  if (stateColumns) {
    await supabase
      .from("pinterest_connections")
      .update({ last_analytics_sync_at: new Date().toISOString() } as never)
      .eq("user_id", userId);
  }

  return { updated, remaining: Math.max((total ?? 0) - updated, 0) };
}

/**
 * Record a dead connection so every surface can say "reconnect" with one voice.
 *
 * Deliberately does NOT clear `profiles.pinterest_connected`: the `_authenticated`
 * route guard redirects to onboarding when that flag is false, so flipping it
 * would eject someone mid-session — possibly over a transient failure — and drop
 * them into the name-and-connect flow with no explanation. The banner asks them
 * to reconnect and they keep their place.
 */
async function markNeedsReconnect(userId: string, message: string) {
  const supabase = getServiceSupabase();
  await supabase
    .from("pinterest_connections")
    .update({ needs_reauth: true, last_sync_error: message } as never)
    .eq("user_id", userId)
    .then(undefined, () => undefined);
}

/* ---------------- Server functions ---------------- */

/**
 * Bring everything in line with Pinterest: profile, boards, pins, and (unless
 * turned off) analytics. Safe to call repeatedly — that's the point.
 */
export const syncPinterestAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { analytics?: boolean } | undefined) =>
    z
      .object({ analytics: z.boolean().optional() })
      .optional()
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<PinterestSyncResult> => {
    const analytics = data?.analytics !== false;
    try {
      return await runSync(context.userId, { analytics });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Pinterest sync failed";
      if (e instanceof PinterestAuthError) {
        await markNeedsReconnect(context.userId, message);
        return {
          ...emptyResult(),
          ok: false,
          needsReconnect: true,
          error:
            "Pinterest needs reconnecting — its access to your account expired or was revoked.",
        };
      }
      console.error("[syncPinterestAccount] failed", e);
      const supabase = getServiceSupabase();
      await supabase
        .from("pinterest_connections")
        .update({ last_sync_error: message } as never)
        .eq("user_id", context.userId)
        .then(undefined, () => undefined);
      return { ...emptyResult(), ok: false, error: message };
    }
  });

export type PinterestSyncState = {
  connected: boolean;
  needsReconnect: boolean;
  username: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  counts: { boards: number; pins: number };
};

/** What the UI needs to decide between "Synced 4m ago", "Syncing…", and
 * "Reconnect Pinterest" — one read, no Pinterest round-trip. */
export const getPinterestSyncState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PinterestSyncState> => {
    const supabase = getServiceSupabase();
    const userId = context.userId;

    const [{ data: conn }, { count: boardCount }, { count: pinCount }] = await Promise.all([
      supabase
        .from("pinterest_connections")
        .select("username, created_at")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("collections")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .not("pinterest_board_id", "is", null),
      supabase
        .from("pins")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .not("pinterest_pin_id", "is", null),
    ]);

    // The state columns are optional (see the migration), so they're read
    // separately and their absence just means "never synced yet".
    let lastSyncedAt: string | null = null;
    let needsReconnect = false;
    let lastError: string | null = null;
    const { data: state } = await supabase
      .from("pinterest_connections")
      .select("last_synced_at, needs_reauth, last_sync_error")
      .eq("user_id", userId)
      .maybeSingle();
    if (state) {
      const s = state as unknown as {
        last_synced_at: string | null;
        needs_reauth: boolean | null;
        last_sync_error: string | null;
      };
      lastSyncedAt = s.last_synced_at ?? null;
      needsReconnect = !!s.needs_reauth;
      lastError = s.last_sync_error ?? null;
    }

    return {
      connected: !!conn,
      needsReconnect,
      username: conn?.username ?? null,
      lastSyncedAt,
      lastError,
      counts: { boards: boardCount ?? 0, pins: pinCount ?? 0 },
    };
  });
