// Streams real SEO suggestions into a fix deck. Shared by the Pin Boost and
// Board Boost screens — both have the same shape of problem, so the scheduling
// lives here once and each route supplies its own `generate` function.
//
// A deck renders immediately with empty suggestion fields, then each card is
// filled in place as the pipeline returns for it. That ordering is deliberate:
// generation takes tens of seconds per uncached item, and the UI should stay
// usable without showing template copy that looks final.
//
// Fetching is LAZY and cursor-driven — only the card being reviewed plus a
// small lookahead are requested. A 40-item deck therefore costs a handful of
// model calls unless the user actually works through all forty. `ensure()`
// exists for the one case that legitimately needs the rest up front: bulk
// approve, which must not apply placeholder copy.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createLimiter } from "@/lib/concurrency-limiter";

/** Cards ahead of the cursor to warm up, so the next pin is usually ready by
 * the time the user swipes to it. Two hides typical latency without
 * speculatively generating copy nobody looks at. */
const LOOKAHEAD = 2;
/** Concurrent requests from this screen. The server has its own module-level
 * provider limiters; this keeps the browser from opening a socket per pin and
 * keeps the visible card ahead of the lookahead in the queue. */
const MAX_IN_FLIGHT = 2;

export type AiRewriteState<R> =
  { status: "loading" } | { status: "ready"; result: R } | { status: "error"; message: string };

export type UseAiRewrites<R> = {
  /** Keyed by card id. Absent means "not requested yet". */
  byId: Record<string, AiRewriteState<R>>;
  /** Generate for these ids if not already done; resolves when all settle.
   * Never rejects — a failed item resolves as an error entry. */
  ensure: (ids: string[]) => Promise<void>;
  /** Force a fresh generation, bypassing any server-side dedup or cache. */
  regenerate: (id: string) => void;
  /** How many of the given ids have settled (ready or failed). */
  settledCount: (ids: string[]) => number;
};

export function useAiRewrites<R>({
  ids,
  index,
  generate,
  onResult,
}: {
  /** Deck order. Memoize it — this drives the fetch window. Null while the
   * deck is still building. */
  ids: string[] | null;
  /** Index of the card being reviewed. */
  index: number;
  /** Route-supplied generator. `force` skips server-side dedup/caches. */
  generate: (id: string, force: boolean) => Promise<R>;
  /** Called with the generated copy so the caller can patch its deck. */
  onResult: (id: string, result: R) => void;
}): UseAiRewrites<R> {
  const [byId, setById] = useState<Record<string, AiRewriteState<R>>>({});

  // One limiter for the lifetime of the screen: it bounds TOTAL in-flight
  // requests, including the ones ensure() queues, so bulk approve can't
  // stampede past the cap the lookahead respects.
  const limit = useMemo(() => createLimiter(MAX_IN_FLIGHT), []);
  // pin id → the request for it. Doubles as the "already asked" set and as
  // what ensure() awaits.
  const requests = useRef(new Map<string, Promise<void>>());
  // Latest callbacks without making them dependencies — a route recreates both
  // every render, and re-running the scheduler on that would be pointless.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const generateRef = useRef(generate);
  generateRef.current = generate;
  // Guards a late response from setting state on an unmounted screen.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Start (or reuse) the request for one pin. Never rejects. */
  const request = useCallback(
    (id: string, force: boolean): Promise<void> => {
      const existing = requests.current.get(id);
      if (existing && !force) return existing;

      const p = limit(async () => {
        if (!alive.current) return;
        setById((s) => ({ ...s, [id]: { status: "loading" } }));
        try {
          const result = await generateRef.current(id, force);
          if (!alive.current) return;
          setById((s) => ({ ...s, [id]: { status: "ready", result } }));
          onResultRef.current(id, result);
        } catch (e) {
          if (!alive.current) return;
          // The pipelines degrade internally rather than throwing, so getting
          // here means auth, network, or a deleted row. The card stays empty
          // until the user retries or skips; no template copy is applyable.
          setById((s) => ({
            ...s,
            [id]: { status: "error", message: e instanceof Error ? e.message : String(e) },
          }));
        }
      });
      requests.current.set(id, p);
      return p;
    },
    [limit],
  );

  // Keep the window [index, index + LOOKAHEAD] requested, nearest first. The
  // limiter queues anything over the cap, so this can fire freely.
  useEffect(() => {
    if (!ids || ids.length === 0) return;
    const from = Math.max(0, index);
    for (const id of ids.slice(from, from + 1 + LOOKAHEAD)) void request(id, false);
    // `byId` is a dependency purely as the "a slot freed up" tick — the guards
    // inside request() make re-entry a no-op when there's nothing new to start.
  }, [ids, index, byId, request]);

  const ensure = useCallback(
    async (ids: string[]) => {
      await Promise.all(ids.map((id) => request(id, false)));
    },
    [request],
  );

  const regenerate = useCallback(
    (id: string) => {
      void request(id, true);
    },
    [request],
  );

  const settledCount = useCallback(
    (ids: string[]) => ids.filter((id) => byId[id] && byId[id].status !== "loading").length,
    [byId],
  );

  return { byId, ensure, regenerate, settledCount };
}
