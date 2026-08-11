import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  visualSearchComponent,
  visualSearchComponents,
  type RawVisualMatch,
  type VisualComponent,
} from "@/lib/pinterest.functions";

export type VisualSearchTab = {
  key: number;
  /** Empty for the whole-image search (nothing detected), which renders no pill. */
  label: string;
  matches: RawVisualMatch[];
  loading: boolean;
  /** The cards are real and final in number; the look gate is still running
   * over them, and may reorder or drop one. A UI can show this as a quiet
   * "checking matches" hint — never as a spinner over the grid, which would
   * hide the products this stage exists to reveal early. */
  refining: boolean;
};

/**
 * The visual search, streamed.
 *
 * THREE stages, deliberately not one, because they cost wildly different
 * amounts and only the first two are worth waiting for:
 *
 *   1. detection    ~6s cold, instant on a seen pin → the product pills.
 *   2. fast tab     Lens + the category gate → the CARDS. This is what the
 *                   screen is waiting for.
 *   3. verified tab the same tab with the look gate applied → a reorder, a
 *                   badge, and the occasional lookalike removed.
 *
 * Stage 3 used to be inside stage 2, which meant the grid stayed empty for the
 * 10-30s the vision proxy took to judge every card — the slowest, least urgent
 * work in the pipeline sitting directly in front of the most useful. Now the
 * grid fills at stage 2 and refines under the shopper's eyes at stage 3.
 *
 * The verified query is CHAINED behind its fast one rather than fired
 * alongside it. Both would be answered from the same server-side work either
 * way, and chaining keeps the request count halved until the cards are up —
 * the server has already started verifying by then (it begins the moment the
 * fast stage resolves), so the chain costs nothing it doesn't recover.
 *
 * Every stage is frozen once settled (`staleTime: Infinity`, no retry, no
 * refetch on focus): both halves cost real money upstream, and a card whose
 * price re-resolves under the user is worse than one that took a moment.
 */
export function useVisualSearch({
  pinId,
  imageUrl,
  title = "",
  description = "",
  enabled = true,
}: {
  pinId?: string;
  imageUrl?: string | null;
  title?: string;
  description?: string;
  enabled?: boolean;
}) {
  const runComponents = useServerFn(visualSearchComponents);
  const runComponent = useServerFn(visualSearchComponent);

  const subject = pinId ?? imageUrl ?? null;
  const detection = useQuery({
    queryKey: ["visual-components", subject],
    queryFn: ({ signal }) =>
      runComponents({
        // Sent even though this call answers with pills only: the server warms
        // every tab behind this response, and a tab is cached under the same
        // ranking context the per-tab requests will ask for. Withholding them
        // here warmed one key and read another.
        data: pinId ? { pinId, title, description } : { imageUrl: imageUrl!, title, description },
        signal,
      }),
    enabled: enabled && !!subject,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const resolvedImageUrl = detection.data?.imageUrl ?? imageUrl ?? null;
  // The pin's own copy beats whatever the caller passed — the server read it
  // from the row and it's what the ranking was computed against.
  const ctxTitle = detection.data?.title || title;
  const ctxDescription = detection.data?.description || description;
  const components: VisualComponent[] = useMemo(
    () => detection.data?.components ?? [],
    [detection.data],
  );
  const noProducts = detection.data?.noProducts ?? false;

  // Nothing detected → one whole-image search under the sentinel key -1. This
  // is the ONLY path that produces untagged results, and it means the pin has
  // no identifiable products, not that detection was too slow or failed.
  const keys = useMemo(
    () =>
      detection.isSuccess
        ? components.length
          ? components.map((c) => c.key)
          : noProducts
            ? [-1]
            : []
        : [],
    [detection.isSuccess, components, noProducts],
  );

  const fast = useQueries({
    queries: keys.map((key) => ({
      queryKey: ["visual-component", resolvedImageUrl, key, "fast"],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        runComponent({
          data: {
            imageUrl: resolvedImageUrl!,
            componentKey: key,
            title: ctxTitle,
            description: ctxDescription,
            stage: "fast" as const,
          },
          signal,
        }),
      enabled: !!resolvedImageUrl,
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });

  const verified = useQueries({
    queries: keys.map((key, i) => ({
      queryKey: ["visual-component", resolvedImageUrl, key, "verified"],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        runComponent({
          data: {
            imageUrl: resolvedImageUrl!,
            componentKey: key,
            title: ctxTitle,
            description: ctxDescription,
            stage: "verified" as const,
          },
          signal,
        }),
      // Chained behind the fast stage, and gated on it having ANSWERED rather
      // than on it having found anything. An empty fast tab is exactly the
      // case that most needs the verified one: the look gate runs over the
      // complete candidate pool, so a tab the fast stage had nothing for can
      // still fill. Keying this on `matches.length` stranded those tabs empty
      // for good. Key -1 is the whole-image fallback, which has no detected
      // object to verify against and whose two stages are the same answer.
      enabled: !!resolvedImageUrl && key >= 0 && (fast[i]?.isSuccess ?? false),
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });

  // One string per stage that changes whenever any tab's data does — the memo
  // below re-runs on that rather than on the query arrays, which are new
  // objects on every render.
  const fastStamps = fast.map((r) => r.dataUpdatedAt).join(",");
  const verifiedStamps = verified.map((r) => r.dataUpdatedAt).join(",");

  // A product can qualify for two pills (two crops of compatible categories).
  // Award it to the one it scores best under, exactly as the batch path does,
  // so the grid doesn't depend on which search happened to return first.
  const { matches, tabs } = useMemo(() => {
    // The verified list replaces its fast one WHOLE, never merges with it: the
    // two disagree by design (a rejected lookalike is missing from the second),
    // and blending them would resurrect exactly the cards the look gate just
    // removed.
    const effective = keys.map(
      (_, i) => verified[i]?.data?.matches ?? fast[i]?.data?.matches ?? [],
    );

    const best = new Map<string, RawVisualMatch>();
    effective.forEach((list) => {
      for (const m of list) {
        const held = best.get(m.link);
        if (!held || (m.score ?? 0) < (held.score ?? 0)) best.set(m.link, m);
      }
    });
    const kept = new Set(best.values());

    const tabList: VisualSearchTab[] = keys.map((key, i) => {
      const component = components.find((c) => c.key === key);
      return {
        key,
        label: component?.label ?? "",
        matches: effective[i].filter((m) => kept.has(m)),
        loading: fast[i]?.isPending ?? true,
        refining: key >= 0 && (fast[i]?.isSuccess ?? false) && (verified[i]?.isPending ?? false),
      };
    });

    // Flat list in pill order, each pill best-first — what the "All" grid and
    // every downstream selection list read.
    return { matches: tabList.flatMap((t) => t.matches), tabs: tabList };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components, keys, fastStamps, verifiedStamps]);

  return {
    /** Detection is still running — nothing to show yet, not even pills. */
    isDetecting: detection.isPending && enabled && !!subject,
    /** True until every pill has its CARDS. Deliberately not tied to the look
     * gate: the screen is usable, and should be treated as loaded, the moment
     * the products are on it. */
    isLoading: detection.isPending || fast.some((r) => r.isPending),
    /** Every card is on screen; the look gate is still finishing on at least
     * one tab. */
    isRefining: verified.some((r) => r.isPending && r.fetchStatus !== "idle"),
    detectionFailed: detection.isError,
    components,
    tabs,
    matches,
    imageUrl: resolvedImageUrl,
    refetch: () => {
      void detection.refetch();
      for (const r of fast) void r.refetch();
      for (const r of verified) void r.refetch();
    },
  };
}
