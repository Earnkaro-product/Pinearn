import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { notifyDone } from "@/lib/notify";

import { tagFromPlanned, toProductTagInput, type PendingProductTag } from "@/lib/product-tag-data";
import type { ProductTagPlan } from "@/lib/product-tags.functions";
import { MAX_PRODUCT_TAGS_PER_PIN } from "@/lib/product-tagging";

import type { BoardCandidate } from "./pinterest.functions";

// A single "monetise the whole board" background job. It is deliberately held
// at MODULE scope (not in React state) so it keeps running — and stays
// observable — after the user leaves the review screen and heads home. This is
// what powers the Swiggy/Zomato-style activity floater: the work lives here,
// the floater is just a live view onto it.
export type MonetizationJob = {
  // The collection/board id — also the job's identity (one live job per board).
  id: string;
  boardName: string;
  // Pin cover images, used for the floater thumbnail collage.
  covers: string[];
  total: number;
  // Pins whose product match has resolved so far (the long phase).
  matched: number;
  // Pins that actually went live (known once the attach call returns).
  approved: number;
  // "matching" → resolving product matches; "publishing" → all matched, the
  // single attach call is in flight; "done"/"error" → terminal.
  status: "matching" | "publishing" | "done" | "error";
  startedAt: number;
  // Seed estimate (seconds) used to render a friendly, moving ETA.
  etaSeconds: number;
};

type Listener = () => void;

let jobs: MonetizationJob[] = [];
const listeners = new Set<Listener>();

function patch(id: string, changes: Partial<MonetizationJob>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...changes } : j));
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): MonetizationJob[] {
  return jobs;
}

// SSR + first client render both start with no jobs, so a stable empty array
// keeps hydration in sync (a fresh [] each call would loop useSyncExternalStore).
const EMPTY: MonetizationJob[] = [];
function getServerSnapshot(): MonetizationJob[] {
  return EMPTY;
}

/** Live view of every tracked job. */
export function useMonetizationJobs(): MonetizationJob[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Live view of one board's job, or undefined if none is tracked. */
export function useMonetizationJob(id: string | undefined): MonetizationJob | undefined {
  const all = useMonetizationJobs();
  return id ? all.find((j) => j.id === id) : undefined;
}

/** Drop a job from the tracker (used by the floater's dismiss + auto-clear). */
export function dismissMonetizationJob(id: string) {
  jobs = jobs.filter((j) => j.id !== id);
  for (const l of listeners) l();
}

// The bound server functions the job needs. They're captured from the
// component (via useServerFn) at kickoff and then called from here — plain
// functions, so surviving unmount is safe, exactly like the old in-component
// promise chain did.
type RunPlan = (args: { data: { pinId: string } }) => Promise<ProductTagPlan>;
type RunApprove = (args: {
  data: {
    origin: string;
    approvals: Array<{
      pinId: string;
      productTags: Array<ReturnType<typeof toProductTagInput>>;
    }>;
  };
}) => Promise<{ approved: number; failed: string[] }>;

export type StartBoardMonetizationOptions = {
  collectionId: string;
  boardName: string;
  covers: string[];
  targets: BoardCandidate[];
  origin: string;
  qc: QueryClient;
  runPlan: RunPlan;
  runApprove: RunApprove;
};

// Kick off (or no-op if one is already live for this board) the whole-board
// monetisation. Returns immediately — the deck can clear to its "going live"
// screen and the user can navigate away; progress streams into the store.
export function startBoardMonetization(opts: StartBoardMonetizationOptions): void {
  const { collectionId, targets } = opts;
  if (targets.length === 0) return;
  // One live job per board — a second tap while it's running is ignored.
  if (jobs.some((j) => j.id === collectionId && j.status !== "done" && j.status !== "error")) {
    return;
  }

  const job: MonetizationJob = {
    id: collectionId,
    boardName: opts.boardName,
    covers: opts.covers,
    total: targets.length,
    matched: 0,
    approved: 0,
    status: "matching",
    startedAt: Date.now(),
    // Matching runs 4-wide at ~7s/pin, plus a short attach tail — mirrors the
    // old in-screen estimate so the ETA feels the same.
    etaSeconds: Math.max(15, Math.ceil(targets.length / 4) * 7 + 6),
  };
  jobs = [...jobs.filter((j) => j.id !== collectionId), job];
  for (const l of listeners) l();

  void runJob(opts);
}

async function runJob(opts: StartBoardMonetizationOptions): Promise<void> {
  const { collectionId, targets, qc, runPlan, runApprove, origin } = opts;
  try {
    const resolved: Array<{ candidate: BoardCandidate; tags: PendingProductTag[] }> = new Array(
      targets.length,
    );
    let nextIndex = 0;
    const CONCURRENCY = 4;
    const worker = async () => {
      while (nextIndex < targets.length) {
        const i = nextIndex++;
        const c = targets[i];
        try {
          // The backend's product tags for this pin — the same plan the
          // interactive deck and the single-pin dialog attach by default, so a
          // board monetised unattended reads exactly as one reviewed by hand.
          // A pin the backend can't tag confidently stays in the queue.
          const result = await qc.fetchQuery({
            queryKey: ["product-tag-plan", c.pinId],
            queryFn: () => runPlan({ data: { pinId: c.pinId } }),
            staleTime: Infinity,
            // One try — a failure just counts as "unmatched", never a silent
            // 3× re-run of the whole reverse-image + CK pipeline.
            retry: false,
          });
          resolved[i] = { candidate: c, tags: result.tags.map((t) => tagFromPlanned(t)) };
        } catch {
          resolved[i] = { candidate: c, tags: [] };
        }
        const matchedSoFar = resolved.filter(Boolean).filter((r) => r.tags.length > 0).length;
        patch(collectionId, { matched: matchedSoFar });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

    const matched = resolved.filter((r) => r.tags.length > 0);
    patch(collectionId, { status: "publishing" });

    let approved = 0;
    if (matched.length > 0) {
      const res = await runApprove({
        data: {
          origin,
          approvals: matched.map((r) => ({
            pinId: r.candidate.pinId,
            productTags: r.tags.slice(0, MAX_PRODUCT_TAGS_PER_PIN).map(toProductTagInput),
          })),
        },
      });
      approved = res.approved;
      // Each approved pin's plan now leads with its saved tags.
      for (const r of matched)
        void qc.invalidateQueries({ queryKey: ["product-tag-plan", r.candidate.pinId] });
    }

    patch(collectionId, { approved, status: "done" });
    announceMonetizeDone(collectionId, approved);
  } catch {
    patch(collectionId, { status: "error" });
  }
}

// The "we'll ping you" promise, kept even when the user is on another screen.
function announceMonetizeDone(id: string, approved: number) {
  const job = jobs.find((j) => j.id === id);
  const name = job?.boardName ? `“${job.boardName}”` : "your board";
  notifyDone(
    approved > 0
      ? `${approved} pin${approved === 1 ? "" : "s"} in ${name} are now live 🎉`
      : `Finished monetising ${name}`,
  );
}
