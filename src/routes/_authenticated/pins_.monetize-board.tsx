import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AnimatePresence, motion } from "framer-motion";
import {
  Banknote,
  Check,
  CheckCheck,
  ChevronLeft,
  ClipboardPaste,
  Eye,
  Heart,
  Home,
  Image as ImageIcon,
  Link2,
  Loader2,
  Navigation,
  PartyPopper,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import {
  SuggestionCard,
  ProgressiveSuggestionCard,
  realProductPrice,
} from "@/components/suggestion-card";
import { CollectionAddFlow, AddFromCollectionButton } from "@/components/collection-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { hostBrand } from "@/lib/brands";
import { usePipelineTiming } from "@/hooks/use-pipeline-timing";
import { startBoardMonetization, useMonetizationJob } from "@/lib/monetization-jobs";
import { clearMonetizeProgress, saveMonetizeProgress } from "@/lib/monetize-progress";
import {
  approveBoardPins,
  getBoardMonetizationCandidates,
  getPinRecommendation,
  getPinRecommendationPreview,
  type BoardCandidate,
  type CkResult,
  type RawVisualMatch,
  type VisualMatch,
} from "@/lib/pinterest.functions";
import { CATEGORY_PILLS, type Product } from "./pins";

export const Route = createFileRoute("/_authenticated/pins_/monetize-board")({
  validateSearch: (s: Record<string, unknown>) => ({
    collectionId: typeof s.collectionId === "string" ? s.collectionId : "",
    // A pinId to resume at — set by the dashboard's "Continue monetising" card
    // so we drop the user back on the exact pin they left off. Optional: every
    // other entry point into this route omits it.
    resume: typeof s.resume === "string" ? s.resume : undefined,
  }),
  component: MonetizeBoardPage,
});

type ManualProduct = { id: string; title: string; url: string; selected: boolean };
type ManualDraft = { pasteUrl: string; products: ManualProduct[] };

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toLocaleString();
}

function deriveManualTitle(pinTitle: string, url: string): string {
  let hostname = "New product";
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* keep default */
  }
  return pinTitle ? `${pinTitle} — ${hostname}` : hostname;
}
// How many pins ahead of the current one we fetch a recommendation for in
// the background — big enough that swiping never has to wait, small enough
// not to hammer the visual-search API for a 40+ pin board.
const PREFETCH_WINDOW = 3;

function MonetizeBoardPage() {
  const { collectionId, resume } = Route.useSearch();
  const navigate = useNavigate();
  const runGetCandidates = useServerFn(getBoardMonetizationCandidates);
  // Fast path (no CK wait) for the interactive card below — each match's
  // price/stock then resolves independently via ProgressiveSuggestionCard.
  const runGetRecommendationPreview = useServerFn(getPinRecommendationPreview);
  // Full CK-validated path — only "Approve all" uses this: it needs the
  // complete confirmed set synchronously to decide what's safe to attach,
  // so it isn't a progressive-rendering candidate.
  const runGetRecommendation = useServerFn(getPinRecommendation);
  const runApprove = useServerFn(approveBoardPins);
  const qc = useQueryClient();

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["board-monetization-candidates", collectionId],
    queryFn: () => runGetCandidates({ data: { collectionId } }),
    enabled: !!collectionId,
    retry: 1,
  });

  const candidates = data?.candidates ?? [];
  const boardName = data?.boardName ?? "";
  const total = candidates.length;

  // The user's existing storefront products, for "Add from Collection" in the
  // per-pin "Add products" sheet — same query the attach-products screen uses,
  // so the two surfaces share React Query's cache instead of double-fetching.
  const { data: storeProducts = [] } = useQuery({
    queryKey: ["all-products"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("storefront_products")
        .select(
          "id,title,affiliate_url,image_url,price_cents,currency,commission_pct,storefront_id,collection_id",
        )
        .eq("user_id", userId);
      return (data ?? []) as Product[];
    },
  });

  const [currentIndex, setCurrentIndex] = useState(0);
  // Which surface is on screen. "review" = the one-by-one reviewer; "board" =
  // the full masonry overview. A pure in-memory view swap — no route change,
  // no refetch — so switching is instant and cache-warm.
  const [view, setView] = useState<"review" | "board">("review");
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  // Per-pin decision. "approved" = went live; "skipped" = user X'd it out and
  // it must never go live (blacked out in the filmstrip). No entry = still
  // awaiting a decision.
  const [statusById, setStatusById] = useState<Record<string, "approved" | "skipped">>({});
  // The manual paste field is hidden until "Add more" reveals it.
  const [showManualAdd, setShowManualAdd] = useState(false);
  const scanScrollRef = useRef<HTMLDivElement>(null);
  // "Approve all" is optimistic: the deck clears to the done screen instantly
  // and the match+attach runs in a MODULE-level background job (see
  // monetization-jobs) so it survives leaving this screen — that's what feeds
  // the persistent activity floater. `job` is undefined when nothing's running.
  const job = useMonetizationJob(collectionId);
  const bgRunning = !!job && job.status !== "done" && job.status !== "error";
  const [introDismissed, setIntroDismissed] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManualDraft>({ pasteUrl: "", products: [] });
  // Products picked from the user's existing collections in the "Add
  // products" sheet — same mechanism as the attach-products screen. Keyed by
  // storefront_products id, cleared alongside the rest of the per-pin draft.
  const [pickedProductIds, setPickedProductIds] = useState<Set<string>>(new Set());
  // Whether the "Add from Collection" picker grid is expanded in the sheet.
  const [showCollection, setShowCollection] = useState(false);
  // Every confirmed-available match is selected by default — this tracks
  // the ones the user has tapped to deselect, keyed by link (matches
  // resolve async, so "selected" can't be seeded as an initial Set).
  const [deselectedRecLinks, setDeselectedRecLinks] = useState<Set<string>>(new Set());
  // Active product-tag pill for the current pin (null = "All"). Pills come from
  // the object-detection components attached to each match — same as the pin
  // attach screen.
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // Active product-tag only; static category pills removed.
  // Populated progressively — one entry per match the instant its own CK
  // lookup settles (ProgressiveSuggestionCard's onSettled), independent of
  // every other match. `null` means CK confirmed it's unavailable/no-match;
  // never present means still resolving.
  const [confirmedByLink, setConfirmedByLink] = useState<Map<string, CkResult>>(new Map());
  // Manual "add your own link" state, lifted here so the footer's "Add more"
  // button can focus the input directly.
  const [manualUrlError, setManualUrlError] = useState<string | null>(null);
  const manualUrlInputRef = useRef<HTMLInputElement>(null);
  const reviewPanelRef = useRef<HTMLDivElement>(null);
  // Per-pin timestamp of when we first started polling for detection tags,
  // keyed by pinId — bounds the tag poll on the window queries below.
  const pollStartRef = useRef<Map<string, number>>(new Map());
  // The background approve keeps running after the user leaves this screen, so
  // guard state updates — a promise resolving post-unmount must never touch it.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Leaving the board terminates the matching pipeline: stop the eager
      // warm-up (mountedRef flips above) and abort every in-flight preview
      // search + product-details lookup. The "Approve all" bulk job uses a
      // different key (["pin-recommendation"]) and is meant to survive, so
      // it's deliberately left running.
      void qc.cancelQueries({ queryKey: ["pin-recommendation-preview"] });
      void qc.cancelQueries({ queryKey: ["product-details"] });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Eager whole-board warm-up. The instant the candidate list lands (while the
  // intro scan animation is still on screen), start the fast match search for
  // EVERY pin in index order, bounded concurrency. React Query caches each
  // result (staleTime: Infinity), so by the time the user swipes to pin 2–3
  // the matches are already in hand — only each card's live price is still
  // resolving. This is what makes the apparent latency near-zero.
  const warmedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || candidates.length === 0 || warmedRef.current === collectionId) return;
    warmedRef.current = collectionId;
    const targets = candidates.map((c) => c.pinId);
    let next = 0;
    const CONCURRENCY = 4;
    const worker = async () => {
      while (next < targets.length && mountedRef.current) {
        const pinId = targets[next++];
        try {
          // prefetchQuery no-ops when the key is already cached/in-flight, so
          // this never double-fetches the swipe-window queries below.
          await qc.prefetchQuery({
            queryKey: ["pin-recommendation-preview", pinId],
            queryFn: ({ signal }) => runGetRecommendationPreview({ data: { pinId }, signal }),
            staleTime: Infinity,
            retry: false,
          });
        } catch {
          /* a failed search just means "no auto-match" — surfaced per-pin */
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    // Runs once per board — candidates identity is stable within a collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, collectionId]);

  const current = candidates[currentIndex] ?? null;
  const reviewedCount = candidates.filter((c) => statusById[c.pinId]).length;
  const approvedCount = candidates.filter((c) => statusById[c.pinId] === "approved").length;
  const skippedCount = candidates.filter((c) => statusById[c.pinId] === "skipped").length;
  // Pins still awaiting a decision — what "Approve all remaining" acts on.
  const remaining = candidates.filter((c) => !statusById[c.pinId]);
  // A running bulk job flips the board to "done" optimistically.
  const done = (!!data && total > 0 && reviewedCount >= total) || !!job;
  const doneApprovedCount = job ? job.approved : approvedCount;

  // Resume: when the dashboard's "Continue monetising" card deep-links a pin,
  // jump straight to it (skipping the intro) the moment candidates land — but
  // only if it's still awaiting a decision. Runs once per resume target.
  const resumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!resume || candidates.length === 0 || resumedRef.current === resume) return;
    resumedRef.current = resume;
    const i = candidates.findIndex((c) => c.pinId === resume);
    if (i >= 0 && !statusById[candidates[i].pinId]) {
      setCurrentIndex(i);
      setIntroDismissed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, data]);

  // Persist "continue where you left off" progress. Only once the user has
  // actually made a decision on at least one pin — merely opening the board
  // shouldn't make it show up in the dashboard's Continue section, since
  // nothing has been "started" yet. Clear it the moment the board is done or
  // handed to the background job, so it drops off the dashboard again.
  useEffect(() => {
    if (!data || total === 0 || !collectionId) return;
    if (done) {
      clearMonetizeProgress(collectionId);
      return;
    }
    if (reviewedCount === 0) return;
    saveMonetizeProgress({
      collectionId,
      boardName,
      covers: candidates
        .map((c) => c.imageUrl)
        .filter((u): u is string => !!u)
        .slice(0, 3),
      lastPinId: current?.pinId ?? candidates[0]?.pinId ?? null,
      reviewedCount,
      total,
      updatedAt: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, done, currentIndex, reviewedCount, collectionId, total, boardName]);

  // The whole board is warmed eagerly above; these window queries just
  // subscribe reactively to the current pin + a small lookahead so the UI
  // re-renders when each result lands. They almost always read straight from
  // the warm cache (a hit), never re-fetching.
  const windowPins = candidates.slice(currentIndex, currentIndex + PREFETCH_WINDOW);
  const matchQueries = useQueries({
    queries: windowPins.map((c) => ({
      queryKey: ["pin-recommendation-preview", c.pinId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        runGetRecommendationPreview({ data: { pinId: c.pinId }, signal }),
      staleTime: Infinity,
      // A failure here means the reverse-image search itself blew up —
      // auto-retrying it silently would double real external traffic for
      // no benefit. The Retry button already gives the user an explicit,
      // deliberate way to re-run it once.
      retry: false,
      refetchOnWindowFocus: false,
      // The board flow asks for the complete set in one value (it prefetches a
      // window of pins ahead of the user, so a pin is normally already warm by
      // the time it is shown) and that response is tagged from the start —
      // detection is no longer something results arrive without. This poll is
      // now only a safety net for the case where detection found nothing
      // taggable; it stops on the first tagged response, or after ~80s.
      refetchInterval: (query: {
        state: { data?: { matches?: RawVisualMatch[] } };
        queryKey: unknown[];
      }) => {
        const matches = query.state.data?.matches;
        if (matches?.some((m) => m.tag)) return false;
        const key = String(query.queryKey[1]);
        let start = pollStartRef.current.get(key);
        if (start == null) {
          start = Date.now();
          pollStartRef.current.set(key, start);
        }
        if (Date.now() - start > 80_000) return false;
        return 7_000;
      },
    })),
  });
  const currentMatchQuery = current ? matchQueries[0] : undefined;
  const currentMatchesLoading = !!current && (!currentMatchQuery || currentMatchQuery.isLoading);

  // Read-only observers over EVERY pin's cached match search (enabled: false →
  // they never fetch; the eager warm-up above does). This keeps the
  // "Approve reviewed (N)" count live as results land, straight from cache.
  const allMatchQueries = useQueries({
    queries: candidates.map((c) => ({
      queryKey: ["pin-recommendation-preview", c.pinId],
      // Never called (enabled: false) — present so the observer is well-formed.
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        runGetRecommendationPreview({ data: { pinId: c.pinId }, signal }),
      staleTime: Infinity,
      enabled: false,
      retry: false,
    })),
  });
  // Pending pins whose product matches are already in hand — one tap approves
  // them all via the exact same recommendation → attach path.
  const readyRemaining = candidates.filter((c, i) => {
    if (statusById[c.pinId]) return false;
    const d = allMatchQueries[i]?.data as { matches?: RawVisualMatch[] } | undefined;
    return !!d?.matches && d.matches.length > 0;
  });
  // A failed search is treated exactly like a confirmed "no product found" —
  // both just mean there's nothing to auto-fill, so the manual fields show
  // either way instead of a dead-end error screen.
  const currentMatches: RawVisualMatch[] = currentMatchQuery?.data?.matches ?? [];

  // Product-tag pills (from object detection). Unique tags in first-seen order,
  // each with its match count. Pills show whenever detection produced at least
  // one named component.
  const tagByLink = useMemo(
    () => new Map(currentMatches.map((m) => [m.link, m.tag] as const)),
    [currentMatches],
  );
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of currentMatches) if (s.tag) m.set(s.tag, (m.get(s.tag) ?? 0) + 1);
    return m;
  }, [currentMatches]);
  const tags = useMemo(() => [...tagCounts.keys()], [tagCounts]);
  // Keep the active pill valid as results change (or the pin switches).
  useEffect(() => {
    if (activeTag && !tagCounts.has(activeTag)) setActiveTag(null);
  }, [activeTag, tagCounts]);
  const visibleMatches = useMemo(
    () =>
      activeTag
        ? currentMatches.filter((m) => tagByLink.get(m.link) === activeTag)
        : currentMatches,
    [activeTag, currentMatches, tagByLink],
  );

  const { reportResolved } = usePipelineTiming(
    current?.pinId ?? null,
    !currentMatchesLoading,
    currentMatches.length,
  );
  const handleMatchSettled = (link: string, details: CkResult) => {
    setConfirmedByLink((prev) => {
      if (prev.has(link)) return prev;
      const next = new Map(prev);
      next.set(link, details);
      return next;
    });
    reportResolved(link);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!current) return;
      if (e.key === "ArrowRight") handleApprove();
      else if (e.key === "ArrowLeft") handleSkip();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // Re-subscribe whenever what a keypress would act on changes, so the
    // handler never closes over a stale manual-entry draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, confirmedByLink, deselectedRecLinks, manualDraft]);

  const persistApproval = async (
    candidate: BoardCandidate,
    products: Array<{ title: string; affiliateUrl: string; imageUrl: string | null }>,
  ) => {
    setPendingIds((s) => new Set(s).add(candidate.pinId));
    // The pin was marked "approved" optimistically for an instant advance; if
    // the server can't attach/go-live, roll that decision back so the pin
    // returns to the queue instead of silently vanishing.
    const revert = () =>
      setStatusById((prev) => {
        const n = { ...prev };
        delete n[candidate.pinId];
        return n;
      });
    try {
      const { failed } = await runApprove({
        data: { origin: window.location.origin, approvals: [{ pinId: candidate.pinId, products }] },
      });
      if (failed.length > 0) {
        revert();
      }
    } catch {
      revert();
    } finally {
      setPendingIds((s) => {
        const next = new Set(s);
        next.delete(candidate.pinId);
        return next;
      });
    }
  };

  const resetPerPinDraft = () => {
    setManualDraft({ pasteUrl: "", products: [] });
    setPickedProductIds(new Set());
    setShowCollection(false);
    setDeselectedRecLinks(new Set());
    setConfirmedByLink(new Map());
    setManualUrlError(null);
    setShowManualAdd(false);
    setActiveTag(null);
  };

  // Toggle a product from the user's own collections on/off for this pin —
  // mirrors the attach-products screen's "Add from Collection".
  const toggleCollectionProduct = (id: string) => {
    setPickedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // After a decision, jump to the next pin still needing one — forward from
  // here, then wrapping to the front. If none remain, park past the end so the
  // "Board reviewed" screen (driven by reviewedCount) takes over.
  const goToNextUnreviewed = (status: Record<string, "approved" | "skipped">) => {
    for (let i = currentIndex + 1; i < total; i++) {
      if (!status[candidates[i].pinId]) return setCurrentIndex(i);
    }
    for (let i = 0; i < currentIndex; i++) {
      if (!status[candidates[i].pinId]) return setCurrentIndex(i);
    }
    setCurrentIndex(total);
  };

  const toggleRecSelection = (link: string) => {
    setDeselectedRecLinks((s) => {
      const next = new Set(s);
      if (next.has(link)) next.delete(link);
      else next.add(link);
      return next;
    });
  };

  // Approve — attaches every chosen recommendation + manual product and goes
  // live. Approval no longer waits on CK: whatever the user hasn't deselected
  // is taken as-is, the pin is marked approved and the deck advances right
  // away, and CK's price/availability check (needed to know which matches are
  // actually safe to attach) resolves in the background via the same full
  // CK-validated lookup "Approve reviewed" uses — keyed off
  // ["pin-recommendation"], which survives navigating to other pins (and even
  // leaving the screen) because it's deliberately excluded from the unmount
  // cleanup above.
  const handleApprove = () => {
    if (!current || pendingIds.has(current.pinId)) return;
    // Revisiting an already-approved pin from the filmstrip and hitting
    // Approve again re-runs it with whatever's selected now — performGoLive
    // is built to support a re-go-live (see its comments), so this must not
    // silently no-op.
    const selectedManual = manualDraft.products.filter((p) => p.selected);
    const selectedCollection = storeProducts.filter((p) => pickedProductIds.has(p.id));
    const chosenMatches = currentMatches.filter((m) => !deselectedRecLinks.has(m.link));
    if (
      chosenMatches.length === 0 &&
      selectedManual.length === 0 &&
      selectedCollection.length === 0
    ) {
      return;
    }
    const candidate = current;
    const manualAndCollectionProducts = [
      ...selectedManual.map((p) => ({ title: p.title, affiliateUrl: p.url, imageUrl: null })),
      ...selectedCollection.map((p) => ({
        title: p.title,
        affiliateUrl: p.affiliate_url,
        imageUrl: p.image_url,
      })),
    ];
    const next = { ...statusById, [candidate.pinId]: "approved" as const };
    setStatusById(next);
    resetPerPinDraft();
    goToNextUnreviewed(next);

    if (chosenMatches.length === 0) {
      // Nothing needs CK — attach the manual/collection picks right away.
      void persistApproval(candidate, manualAndCollectionProducts);
      return;
    }

    const chosenLinks = new Set(chosenMatches.map((m) => m.link));
    setPendingIds((s) => new Set(s).add(candidate.pinId));
    void (async () => {
      let recProducts: Array<{ title: string; affiliateUrl: string; imageUrl: string | null }> = [];
      try {
        const result = await qc.fetchQuery({
          queryKey: ["pin-recommendation", candidate.pinId],
          queryFn: () => runGetRecommendation({ data: { pinId: candidate.pinId } }),
          staleTime: Infinity,
          retry: false,
        });
        recProducts = result.recommendations
          .filter((r) => chosenLinks.has(r.link))
          .map((r) => ({ title: r.title, affiliateUrl: r.link, imageUrl: r.thumbnail }));
      } catch {
        // CK lookup failed — fall through with just the manual/collection picks.
      }
      if (!mountedRef.current) return;
      const products = [...recProducts, ...manualAndCollectionProducts];
      if (products.length === 0) {
        setPendingIds((s) => {
          const n = new Set(s);
          n.delete(candidate.pinId);
          return n;
        });
        setStatusById((prev) => {
          const n = { ...prev };
          delete n[candidate.pinId];
          return n;
        });
        return;
      }
      void persistApproval(candidate, products);
    })();
  };

  // Skip (the ✕) — this pin is blacked out and never goes live.
  const handleSkip = () => {
    if (!current) return;
    const next = { ...statusById, [current.pinId]: "skipped" as const };
    setStatusById(next);
    resetPerPinDraft();
    goToNextUnreviewed(next);
  };

  // Tap any pin in the filmstrip to review it — forward or back.
  const jumpTo = (i: number) => {
    if (i === currentIndex || i < 0 || i >= total) return;
    resetPerPinDraft();
    setCurrentIndex(i);
  };

  const handleAddMore = () => {
    setShowManualAdd(true);
    setTimeout(() => manualUrlInputRef.current?.focus(), 60);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setManualDraft((d) => ({ ...d, pasteUrl: text.trim() }));
        setManualUrlError(null);
      } else {
        setManualUrlError("Clipboard is empty");
      }
    } catch {
      setManualUrlError("Couldn't read clipboard — paste manually");
    }
  };

  const removeManualProduct = (id: string) => {
    setManualDraft((d) => ({ ...d, products: d.products.filter((p) => p.id !== id) }));
  };

  const addManualProduct = () => {
    if (!current) return;
    const url = manualDraft.pasteUrl.trim();
    if (!url) {
      setManualUrlError("Paste a product link first");
      manualUrlInputRef.current?.focus();
      return;
    }
    try {
      new URL(url);
    } catch {
      setManualUrlError("That doesn't look like a valid URL");
      manualUrlInputRef.current?.focus();
      return;
    }
    const normalize = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
    if (manualDraft.products.some((p) => normalize(p.url) === normalize(url))) {
      setManualUrlError("Already added");
      manualUrlInputRef.current?.focus();
      return;
    }
    setManualUrlError(null);
    setManualDraft({
      pasteUrl: "",
      products: [
        ...manualDraft.products,
        {
          id: crypto.randomUUID(),
          title: deriveManualTitle(current.title, url),
          url,
          selected: true,
        },
      ],
    });
  };

  const toggleManualProduct = (id: string) => {
    setManualDraft({
      ...manualDraft,
      products: manualDraft.products.map((p) =>
        p.id === id ? { ...p, selected: !p.selected } : p,
      ),
    });
  };

  const handleApproveAllClick = () => {
    if (remaining.length === 0 || job) return;
    // Optimistic: clear the deck to the "going live" screen right now. The heavy
    // work (matching every pin + attaching) is handed to a module-level job that
    // survives unmount, so the user is free to leave — the activity floater
    // tracks it from anywhere in the app and pings them when it's done.
    startBoardMonetization({
      collectionId,
      boardName,
      covers: candidates.map((c) => c.imageUrl).filter(Boolean) as string[],
      targets: remaining,
      origin: window.location.origin,
      qc,
      runGetRecommendation,
      runApprove,
    });
    setCurrentIndex(total);
  };

  // "Approve reviewed (N)" — approve, in the background, only the pending pins
  // whose matches are already in hand, without leaving the review screen
  // (unlike the full "Approve all" which flips to the going-live screen).
  // Reuses the exact same path as the bulk flow: full CK recommendation →
  // attach via approveBoardPins. Failures roll back to the queue.
  const handleApproveReviewed = () => {
    const targets = readyRemaining;
    if (targets.length === 0) return;
    // Optimistic: mark them approved now (navigator + board turn green).
    const nextStatus = { ...statusById };
    for (const c of targets) nextStatus[c.pinId] = "approved";
    setStatusById(nextStatus);
    // If we're sitting on one of them, spring to the next pending pin.
    if (current && nextStatus[current.pinId]) goToNextUnreviewed(nextStatus);
    void (async () => {
      const resolved: Array<{ candidate: BoardCandidate; products: VisualMatch[] }> = [];
      let i = 0;
      const CONCURRENCY = 4;
      const worker = async () => {
        while (i < targets.length) {
          const c = targets[i++];
          try {
            const result = await qc.fetchQuery({
              queryKey: ["pin-recommendation", c.pinId],
              queryFn: () => runGetRecommendation({ data: { pinId: c.pinId } }),
              staleTime: Infinity,
              retry: false,
            });
            resolved.push({ candidate: c, products: result.recommendations });
          } catch {
            resolved.push({ candidate: c, products: [] });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

      const matched = resolved.filter((r) => r.products.length > 0);
      const failed: BoardCandidate[] = resolved
        .filter((r) => r.products.length === 0)
        .map((r) => r.candidate);
      if (matched.length > 0) {
        try {
          const res = await runApprove({
            data: {
              origin: window.location.origin,
              approvals: matched.map((r) => ({
                pinId: r.candidate.pinId,
                products: r.products.map((rec) => ({
                  title: rec.title,
                  affiliateUrl: rec.link,
                  imageUrl: rec.thumbnail,
                })),
              })),
            },
          });
          failed.push(...matched.slice(res.approved).map((r) => r.candidate));
        } catch {
          failed.push(...matched.map((r) => r.candidate));
        }
      }
      if (mountedRef.current && failed.length > 0) {
        // Roll the failures back so they return to the queue for manual review.
        setStatusById((prev) => {
          const n = { ...prev };
          for (const c of failed) delete n[c.pinId];
          return n;
        });
      }
    })();
  };

  const backToBoard = () => navigate({ to: "/pins/attach", search: { collection: collectionId } });
  const seeLivePins = () => navigate({ to: "/pins" });

  if (!collectionId) {
    return (
      <AppShell title="Monetise board" backButton hideBottomNav>
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No board selected.
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Review pins"
      backButton
      hideBottomNav
      // In the board overview, the header back button returns to the reviewer
      // (in-memory view swap) instead of leaving the page.
      onBack={view === "board" && !done ? () => setView("review") : undefined}
    >
      {isError ? (
        <div className="rounded-2xl border border-dashed border-rose-300 bg-rose-50/50 p-10 text-center text-sm text-rose-700">
          <p>Couldn't load this board's pins.</p>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-60"
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Try again
          </button>
        </div>
      ) : done ? (
        bgRunning ? (
          <BoardApproving
            covers={candidates.map((c) => c.imageUrl).filter(Boolean) as string[]}
            matched={job!.matched}
            total={job!.total}
            onBack={backToBoard}
          />
        ) : (
          <BoardMonetized
            boardName={boardName}
            approvedCount={doneApprovedCount}
            onBack={seeLivePins}
          />
        )
      ) : !introDismissed && (isLoading || total > 0) ? (
        <MonetiseBoardIntro
          boardName={boardName}
          loading={isLoading}
          total={total}
          candidates={candidates}
          onReviewManually={() => setIntroDismissed(true)}
          onApproveAll={() => {
            // Leave the intro and kick off the optimistic bulk approve — the
            // deck clears straight to the "going live" screen.
            setIntroDismissed(true);
            handleApproveAllClick();
          }}
        />
      ) : isLoading ? (
        <div className="mx-auto max-w-sm pb-36">
          <div className="mb-5 flex items-center justify-center">
            <Skeleton className="h-7 w-40 rounded-full" />
          </div>
          <div className="relative">
            <div
              className="absolute inset-x-0 top-0 aspect-[4/3] overflow-hidden rounded-3xl border border-border bg-surface"
              style={{ transform: "scale(0.96) translateY(10px)", zIndex: 9, opacity: 0.7 }}
            >
              <Skeleton className="h-full w-full rounded-3xl" />
            </div>
            <div className="relative z-20 overflow-hidden rounded-3xl border border-border bg-surface shadow-elevate">
              <Skeleton className="aspect-[4/3] w-full rounded-none" />
              <div className="space-y-2.5 p-3">
                <Skeleton className="h-3 w-32 rounded-full" />
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  <Skeleton className="h-56 rounded-xl" />
                  <Skeleton className="h-56 rounded-xl" />
                </div>
              </div>
            </div>
          </div>
          <div className="mt-5 flex items-center justify-center gap-9">
            <Skeleton className="h-16 w-16 rounded-full" />
            <Skeleton className="h-[72px] w-[72px] rounded-full" />
          </div>
        </div>
      ) : candidates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-12 text-center text-sm text-muted-foreground">
          <p>Every pin in this board already has a product attached.</p>
          <button
            onClick={backToBoard}
            className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow"
          >
            Back to board
          </button>
        </div>
      ) : view === "board" ? (
        <BoardOverview
          candidates={candidates}
          statusById={statusById}
          currentIndex={currentIndex}
          readyCount={readyRemaining.length}
          remainingCount={remaining.length}
          onApproveReady={handleApproveReviewed}
          onApproveAll={handleApproveAllClick}
          onPick={(i: number) => {
            jumpTo(i);
            setView("review");
          }}
        />
      ) : (
        <div className="mx-auto flex h-[calc(100dvh-6.5rem)] max-w-md flex-col px-1">
          {/* Tiny pin-count summary, directly above the navigator. */}
          <div className="flex shrink-0 items-center justify-center gap-2 pb-2 text-mini font-medium text-muted-foreground">
            <span className="tabular-nums">
              Reviewed {reviewedCount}/{total}
            </span>
            <span className="text-muted-foreground/40">•</span>
            <span className="font-semibold text-emerald-600">{approvedCount} approved</span>
            <span className="text-muted-foreground/40">•</span>
            <span>{skippedCount} skipped</span>
          </div>

          {/* Current pin's Pinterest traffic — impressions + clicks. */}
          {current && (
            <div className="flex shrink-0 items-center justify-center gap-3 pb-2 text-mini font-semibold text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Eye className="h-3.5 w-3.5" /> {fmtCompact(current.impressions)} impressions
              </span>
              <span className="text-muted-foreground/40">•</span>
              <span className="inline-flex items-center gap-1">
                <Navigation className="h-3.5 w-3.5" /> {fmtCompact(current.clicks)} clicks
              </span>
            </div>
          )}

          {/* Pin navigator + detected products. The navigator is a neutral grey
              panel; the product card below carries the brand-red boundary. The
              selected pin becomes a white red-bordered tab that pokes down and
              cuts into the red top edge of the product card — so the selected
              pin sits inside the product boundary, like the connected tab in
              the reference. */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Navigator — neutral grey panel. Extra top room so the enlarged
                selected pin has space to grow upward without clipping. Side
                padding matches the product card's rounded-3xl (24px) corner
                radius below, so the connected tab's straight border always
                lands past the curve instead of cutting across it — even when
                the first/last pin in the strip is the one poking down. */}
            <div className="relative z-20 shrink-0 rounded-t-3xl bg-surface-2 px-6 pb-2 pt-6">
              <BoardNavigator
                candidates={candidates}
                currentIndex={currentIndex}
                statusById={statusById}
                covers={candidates.map((c) => c.imageUrl).filter(Boolean) as string[]}
                onJump={jumpTo}
                onOpenBoard={() => setView("board")}
              />
            </div>

            {/* Detected products — the hero, in a red-bordered card that echoes
                the selected pin. Skeletons while matching, so the layout never
                shifts and the buttons never move. */}
            <div
              ref={scanScrollRef}
              className="no-scrollbar relative z-10 min-h-0 flex-1 overflow-y-auto rounded-3xl border-2 border-primary bg-surface p-3 shadow-sm"
            >
              <div ref={reviewPanelRef} className="scroll-mt-2">
                {currentMatchesLoading ? (
                  <div className="space-y-3">
                    <div className="h-3.5 w-40 animate-pulse rounded-full bg-surface-2" />
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                      <AddProductTile onClick={handleAddMore} />
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div
                          key={i}
                          className="min-h-[210px] animate-pulse rounded-2xl border border-border bg-surface-2/60"
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <motion.div
                    key={current ? current.pinId : "none"}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                    className="space-y-3"
                  >
                    <div className="flex items-center justify-between px-0.5">
                      <p className="flex items-center gap-1.5 text-mini font-semibold uppercase tracking-wide text-muted-foreground">
                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                        {currentMatches.length === 0
                          ? "Add a product"
                          : currentMatches.length === 1
                            ? "1 suggested match"
                            : `${currentMatches.length} suggested matches`}
                      </p>
                      {currentMatches.length > 0 && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-micro font-semibold text-primary">
                          {currentMatches.filter((m) => !deselectedRecLinks.has(m.link)).length}{" "}
                          selected
                        </span>
                      )}
                    </div>

                    {currentMatches.length === 0 && (
                      <p className="-mt-1.5 px-0.5 text-xs text-muted-foreground">
                        No matching products found — add one manually.
                      </p>
                    )}

                    {/* Category pills removed here too — use live filters. */}

                    {/* Product-tag pills — one per detected component. Shown
                        whenever detection named at least one; a single category
                        still gets "All" + its own pill. Same as pin attach. */}
                    {tags.length >= 1 && (
                      <div className="no-scrollbar -mx-1 flex items-center gap-2 overflow-x-auto px-1">
                        <TagTab
                          label="All"
                          count={currentMatches.length}
                          active={activeTag === null}
                          onClick={() => setActiveTag(null)}
                        />
                        {tags.map((t) => (
                          <TagTab
                            key={t}
                            label={t}
                            count={tagCounts.get(t) ?? 0}
                            active={activeTag === t}
                            onClick={() => setActiveTag(t)}
                          />
                        ))}
                      </div>
                    )}

                    {/* Same grid as attach-products. The "add your own product"
                        tile is always the very first card in the grid. */}
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                      <AddProductTile onClick={handleAddMore} />

                      {visibleMatches.map((m) => (
                        <ProgressiveSuggestionCard
                          key={m.link}
                          match={m}
                          selected={!deselectedRecLinks.has(m.link)}
                          onToggle={() => toggleRecSelection(m.link)}
                          onSettled={handleMatchSettled}
                        />
                      ))}

                      {manualDraft.products.map((p) => (
                        <SuggestionCard
                          key={p.id}
                          title={p.title}
                          thumbnail={null}
                          source={hostBrand(p.url)}
                          link={p.url}
                          price={null}
                          selected={p.selected}
                          onToggle={() => toggleManualProduct(p.id)}
                        />
                      ))}

                      {storeProducts
                        .filter((p) => pickedProductIds.has(p.id))
                        .map((p) => (
                          <SuggestionCard
                            key={p.id}
                            title={p.title}
                            thumbnail={p.image_url}
                            source={hostBrand(p.affiliate_url)}
                            link={p.affiliate_url}
                            price={realProductPrice(p.price_cents)}
                            commissionPct={p.commission_pct}
                            selected
                            onToggle={() => toggleCollectionProduct(p.id)}
                          />
                        ))}
                    </div>
                  </motion.div>
                )}
              </div>
            </div>
          </div>

          {/* Fixed action zone. Skip (small) + Approve (dominant), the bulk
              pair beneath, then the tiny progress line. Never moves. */}
          <div className="shrink-0 space-y-2.5 pt-3">
            <div className="flex items-stretch gap-2.5">
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={handleSkip}
                aria-label="Skip this pin"
                className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-2xl border-2 border-border bg-surface px-4 py-3.5 text-sm font-bold text-muted-foreground transition hover:text-foreground"
              >
                <X className="h-4 w-4" strokeWidth={2.5} /> Skip
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={handleApprove}
                aria-label="Approve this pin"
                disabled={currentMatchesLoading || (!!current && pendingIds.has(current.pinId))}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-4 py-3.5 text-lead font-extrabold text-primary-foreground shadow-glow transition disabled:opacity-60"
              >
                {current && pendingIds.has(current.pinId) ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Heart className="h-5 w-5" fill="currentColor" />
                )}
                Approve
              </motion.button>
            </div>

            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={handleApproveAllClick}
              disabled={remaining.length === 0}
              className="inline-flex w-full items-center justify-center rounded-2xl border-2 border-primary bg-surface px-3 py-3 text-body font-bold text-primary transition disabled:opacity-40"
            >
              Approve all remaining
            </motion.button>
          </div>

          {/* "Add products" bottom sheet — same flow as attach-products: paste
              a link (or from clipboard), add it, and it joins the grid above. */}
          <AnimatePresence>
            {showManualAdd && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-[55] flex items-end justify-center bg-background/60 backdrop-blur-sm sm:items-center sm:p-4"
                onClick={() => setShowManualAdd(false)}
              >
                <motion.div
                  onClick={(e) => e.stopPropagation()}
                  initial={{ y: 40, opacity: 0.6 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 40, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 380, damping: 34 }}
                  className="w-full max-w-2xl rounded-t-3xl border border-border bg-surface p-5 shadow-elevate sm:rounded-3xl"
                  style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
                >
                  <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-border" />
                  <h3 className="font-display text-lg font-bold">Add products</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Paste an affiliate link to add it to this pin.
                  </p>

                  {/* Paste a link */}
                  <div className="mt-4 flex items-center gap-2">
                    <div
                      className={`flex flex-1 items-center gap-2 rounded-2xl border bg-background px-3 py-3 ${
                        manualUrlError ? "border-rose-400" : "border-input"
                      }`}
                    >
                      <Link2 className="h-4 w-4 shrink-0 text-primary" />
                      <input
                        ref={manualUrlInputRef}
                        type="url"
                        value={manualDraft.pasteUrl}
                        onChange={(e) => {
                          setManualDraft({ ...manualDraft, pasteUrl: e.target.value });
                          if (manualUrlError) setManualUrlError(null);
                        }}
                        placeholder="Paste more links"
                        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={pasteFromClipboard}
                      aria-label="Paste from clipboard"
                      className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-2xl bg-emerald-500 text-white shadow-sm transition active:scale-95"
                    >
                      <ClipboardPaste className="h-5 w-5" />
                    </button>
                  </div>
                  {manualUrlError && (
                    <p className="mt-1.5 text-xs text-rose-500">{manualUrlError}</p>
                  )}
                  {/* Only appears once there's a link to add. */}
                  {manualDraft.pasteUrl.trim() && (
                    <button
                      type="button"
                      onClick={addManualProduct}
                      className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
                    >
                      <Plus className="h-4 w-4" /> Add link
                    </button>
                  )}

                  {/* divider */}
                  <div className="my-4 flex items-center gap-3 text-mini font-semibold uppercase tracking-wide text-muted-foreground/70">
                    <span className="h-px flex-1 bg-border" /> or{" "}
                    <span className="h-px flex-1 bg-border" />
                  </div>

                  {/* Add from collection — full-screen: a Collections grid,
                      then that collection's products. Same shared flow as
                      the single-pin attach dialog. */}
                  <AddFromCollectionButton onClick={() => setShowCollection(true)} />
                  {showCollection && (
                    <CollectionAddFlow
                      products={storeProducts}
                      pickedIds={pickedProductIds}
                      onTogglePicked={toggleCollectionProduct}
                      onExit={() => setShowCollection(false)}
                    />
                  )}

                  {/* Everything added so far — pasted links + collection picks,
                      remove either with ✕. */}
                  {(manualDraft.products.length > 0 || pickedProductIds.size > 0) && (
                    <div className="mt-5">
                      <p className="mb-2 text-xs font-semibold text-muted-foreground">
                        {manualDraft.products.length + pickedProductIds.size} added
                      </p>
                      <div className="flex max-h-[38vh] flex-col gap-2 overflow-y-auto">
                        {manualDraft.products.map((p) => (
                          <div
                            key={p.id}
                            className="flex items-center gap-2.5 rounded-2xl border border-border bg-surface p-2 shadow-sm"
                          >
                            <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-2 text-muted-foreground">
                              <ImageIcon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-micro font-bold uppercase tracking-wide text-muted-foreground">
                                {hostBrand(p.url)}
                              </p>
                              <p className="truncate text-sm font-semibold leading-tight">
                                {p.title}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeManualProduct(p.id)}
                              aria-label="Remove"
                              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                        {storeProducts
                          .filter((p) => pickedProductIds.has(p.id))
                          .map((p) => (
                            <div
                              key={p.id}
                              className="flex items-center gap-2.5 rounded-2xl border border-border bg-surface p-2 shadow-sm"
                            >
                              <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-2 text-muted-foreground">
                                {p.image_url ? (
                                  <img
                                    src={p.image_url}
                                    alt=""
                                    className="h-full w-full object-cover"
                                  />
                                ) : (
                                  <ImageIcon className="h-4 w-4" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-micro font-bold uppercase tracking-wide text-muted-foreground">
                                  {hostBrand(p.affiliate_url)}
                                </p>
                                <p className="truncate text-sm font-semibold leading-tight">
                                  {p.title}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => toggleCollectionProduct(p.id)}
                                aria-label="Remove"
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowManualAdd(false)}
                    className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
                  >
                    Done
                    {manualDraft.products.length + pickedProductIds.size > 0
                      ? ` (${manualDraft.products.length + pickedProductIds.size})`
                      : ""}
                  </button>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </AppShell>
  );
}

// One product-tag pill (a detected component). Mirrors the pin attach screen's
// TagTab so both surfaces read identically.
function TagTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
        active
          ? "bg-gradient-primary text-primary-foreground shadow-glow"
          : "bg-surface-2 text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 text-micro font-bold ${
          active ? "bg-white/25 text-primary-foreground" : "bg-foreground/10 text-foreground/70"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

// The dashed "add your own product" tile — always the first card in the grid.
function AddProductTile({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className="flex min-h-[210px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/50 bg-primary/[0.04] p-3 text-primary transition hover:border-primary hover:bg-primary/[0.08]"
    >
      <span className="grid h-11 w-11 place-items-center rounded-full bg-primary/10">
        <Plus className="h-6 w-6" strokeWidth={2.5} />
      </span>
      <span className="text-xs font-bold">Add product</span>
      <span className="px-1 text-center text-micro font-medium text-muted-foreground">
        Paste your own link
      </span>
    </motion.button>
  );
}

// Fixed geometry for the paged navigator. Each pin lives in a whole SLOT, and
// the strip only ever translates by whole slots — so at any moment you see
// only complete pins, never a half one, and swiping moves exactly ±1.
const NAV_SLOT = 72; // px per pin slot (56px pin + spacing + room to enlarge)
const NAV_VISIBLE = 4; // whole pins visible at once

// The horizontal board navigator — a paged (whole-pin) carousel. Swipe, wheel
// and taps all step the selection by exactly one pin; the window shifts a whole
// slot at a time, so a half-pin is never on screen. The selected pin becomes a
// white, red-bordered tab that pokes down and connects into the red product
// card below (the "cut-in" tab from the reference). The board thumbnail is
// pinned on the right and never scrolls away — tap it for the full overview.
function BoardNavigator({
  candidates,
  currentIndex,
  statusById,
  covers,
  onJump,
  onOpenBoard,
}: {
  candidates: BoardCandidate[];
  currentIndex: number;
  statusById: Record<string, "approved" | "skipped">;
  covers: string[];
  onJump: (i: number) => void;
  onOpenBoard: () => void;
}) {
  const total = candidates.length;
  const visible = Math.min(NAV_VISIBLE, total);
  const maxStart = Math.max(0, total - visible);

  // The window's own scroll position, independent of the selection — so you can
  // browse the strip (a whole pin at a time) without changing which pin you're
  // reviewing. Tapping a pin still selects it.
  const [start, setStart] = useState(() => Math.min(Math.max(currentIndex - 1, 0), maxStart));
  const clampStart = (s: number) => Math.min(Math.max(s, 0), maxStart);

  // Whenever the selection changes (tap / approve auto-advance), scroll the
  // window just enough to keep the selected pin in view.
  useEffect(() => {
    setStart((s) => {
      if (currentIndex < s) return clampStart(currentIndex);
      if (currentIndex > s + visible - 1) return clampStart(currentIndex - visible + 1);
      return clampStart(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, visible, maxStart]);

  const movedRef = useRef(false);
  const downXRef = useRef<number | null>(null);
  const lastStepRef = useRef(0);

  // Scroll the window by exactly one pin.
  const step = (dir: number) => setStart((s) => clampStart(s + dir));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    downXRef.current = e.clientX;
    movedRef.current = false;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (downXRef.current != null && Math.abs(e.clientX - downXRef.current) > 6) {
      movedRef.current = true;
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (downXRef.current == null) return;
    const dx = e.clientX - downXRef.current;
    downXRef.current = null;
    if (Math.abs(dx) > 30) step(dx < 0 ? 1 : -1);
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 8) return;
    const now = Date.now();
    if (now - lastStepRef.current < 260) return;
    lastStepRef.current = now;
    step(d > 0 ? 1 : -1);
  };

  const [a, b, c] = covers;

  return (
    <div className="flex items-stretch justify-between gap-2.5">
      {/* Paged window — clips horizontally to whole slots (overflow-x-clip
          keeps vertical visible so the selected tab can poke down). */}
      <div
        className="relative overflow-x-clip"
        style={{ width: visible * NAV_SLOT }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <motion.div
          className="flex items-end"
          animate={{ x: -start * NAV_SLOT }}
          transition={{ type: "spring", stiffness: 380, damping: 34 }}
        >
          {candidates.map((cand, i) => {
            const status = statusById[cand.pinId];
            const active = i === currentIndex;
            return (
              <div
                key={cand.pinId}
                className="flex shrink-0 justify-center"
                style={{ width: NAV_SLOT }}
              >
                <motion.button
                  onClick={() => {
                    if (!movedRef.current) onJump(i);
                  }}
                  aria-label={active ? "Current pin" : "Go to this pin"}
                  // The selected pin grows from its bottom edge — bigger upward
                  // while its base stays put — as a white red-bordered tab whose
                  // OPEN bottom pokes down into the red product card, so its
                  // border joins the card's boundary (the connected tab).
                  animate={{ scale: active ? 1.32 : 0.8 }}
                  transition={{ type: "spring", stiffness: 420, damping: 24 }}
                  className={`relative h-14 w-14 origin-bottom overflow-hidden will-change-transform ${
                    active
                      ? "z-30 -mb-4 rounded-2xl rounded-b-none border-2 border-b-0 border-primary bg-surface p-[3px] shadow-[0_-3px_10px_rgba(0,0,0,0.08)]"
                      : "rounded-2xl bg-gradient-to-br from-rose-500 to-pink-600 opacity-90 shadow-sm hover:opacity-100"
                  }`}
                >
                  {cand.imageUrl && (
                    <img
                      src={cand.imageUrl}
                      alt=""
                      draggable={false}
                      className={`h-full w-full object-cover ${active ? "rounded-t-lg" : ""} ${
                        status === "skipped" ? "opacity-30 grayscale" : ""
                      }`}
                    />
                  )}
                  {status === "approved" && (
                    <span className="absolute inset-0 grid place-items-center rounded-lg bg-emerald-500/70 text-white">
                      <Check className="h-4 w-4" strokeWidth={3} />
                    </span>
                  )}
                  {status === "skipped" && (
                    <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/55 text-white">
                      <X className="h-4 w-4" strokeWidth={3} />
                    </span>
                  )}
                </motion.button>
              </div>
            );
          })}
        </motion.div>
      </div>

      {/* Persistent board thumbnail — never scrolls away. */}
      <motion.button
        whileTap={{ scale: 0.92 }}
        onClick={onOpenBoard}
        aria-label="Open board overview"
        className="relative h-14 w-14 shrink-0 self-center overflow-hidden rounded-2xl border border-border bg-surface shadow-elevate"
      >
        <div className="flex h-full w-full gap-0.5">
          <div className="relative flex-[2] bg-gradient-to-br from-rose-500 to-pink-600">
            {a && <img src={a} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          </div>
          <div className="flex flex-1 flex-col gap-0.5">
            {[b, c].map((src, i) => (
              <div key={i} className="relative flex-1 bg-gradient-to-br from-rose-400 to-pink-500">
                {src && (
                  <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />
                )}
              </div>
            ))}
          </div>
        </div>
        <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-nano font-bold uppercase tracking-wide text-white backdrop-blur-sm">
          Board
        </span>
      </motion.button>
    </div>
  );
}

// The dedicated board overview. Every pin in a Pinterest masonry, each in one
// of four visual states (approved / skipped / selected / pending). Tapping any
// pin returns to the reviewer focused on that pin — pure view swap, no reload.
function BoardOverview({
  candidates,
  statusById,
  currentIndex,
  readyCount,
  remainingCount,
  onApproveReady,
  onApproveAll,
  onPick,
}: {
  candidates: BoardCandidate[];
  statusById: Record<string, "approved" | "skipped">;
  currentIndex: number;
  readyCount: number;
  remainingCount: number;
  onApproveReady: () => void;
  onApproveAll: () => void;
  onPick: (i: number) => void;
}) {
  const approved = candidates.filter((c) => statusById[c.pinId] === "approved").length;
  const skipped = candidates.filter((c) => statusById[c.pinId] === "skipped").length;
  // Round-robin into 2 columns so order reads left-to-right, top-to-bottom.
  const cols = 2;
  const columns: { c: BoardCandidate; i: number }[][] = Array.from({ length: cols }, () => []);
  candidates.forEach((c, i) => columns[i % cols].push({ c, i }));

  return (
    <div className="mx-auto flex h-[calc(100dvh-6.5rem)] max-w-md flex-col px-1">
      <div className="flex shrink-0 items-center justify-center gap-2 pb-3 text-mini font-medium text-muted-foreground">
        <span className="font-semibold text-emerald-600">{approved} approved</span>
        <span className="text-muted-foreground/40">•</span>
        <span>{skipped} skipped</span>
        <span className="text-muted-foreground/40">•</span>
        <span className="tabular-nums">{candidates.length} total</span>
      </div>

      <div className="no-scrollbar flex-1 overflow-y-auto pb-4">
        <div className="flex gap-3">
          {columns.map((col, ci) => (
            <div key={ci} className="flex flex-1 flex-col gap-3">
              {col.map(({ c, i }) => {
                const status = statusById[c.pinId];
                const selected = i === currentIndex;
                return (
                  <motion.button
                    key={c.pinId}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => onPick(i)}
                    className={`relative overflow-hidden rounded-3xl bg-gradient-to-br from-rose-500 to-pink-600 text-left shadow-sm transition ${
                      selected ? "z-10 shadow-elevate ring-[3px] ring-primary" : ""
                    } ${status === "approved" ? "ring-2 ring-emerald-500" : ""}`}
                  >
                    {c.imageUrl ? (
                      <img
                        src={c.imageUrl}
                        alt=""
                        loading="lazy"
                        className={`block h-auto w-full ${status === "skipped" ? "opacity-40 grayscale" : ""}`}
                      />
                    ) : (
                      <div className="aspect-[4/5] w-full" />
                    )}

                    {status === "approved" && (
                      <span className="pointer-events-none absolute inset-0 bg-emerald-500/25" />
                    )}
                    {status === "skipped" && (
                      <span className="pointer-events-none absolute inset-0 bg-black/45" />
                    )}

                    {status === "approved" && (
                      <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-emerald-500 text-white shadow">
                        <Check className="h-4 w-4" strokeWidth={3} />
                      </span>
                    )}
                    {status === "skipped" && (
                      <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white shadow">
                        <X className="h-4 w-4" strokeWidth={3} />
                      </span>
                    )}
                    {selected && (
                      <span className="absolute left-2 top-2 rounded-full bg-primary px-2 py-0.5 text-nano font-bold uppercase tracking-wide text-primary-foreground shadow">
                        Current
                      </span>
                    )}
                  </motion.button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Fixed bulk actions — same pair as the reviewer. */}
      <div className="grid shrink-0 grid-cols-2 gap-2.5 border-t border-border/60 pb-1 pt-3">
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={onApproveReady}
          disabled={readyCount === 0}
          className="inline-flex items-center justify-center rounded-2xl bg-gradient-primary px-3 py-3 text-body font-bold text-primary-foreground shadow-glow transition disabled:opacity-40"
        >
          {approved > 0 ? `Approve ${approved} pin${approved === 1 ? "" : "s"}` : "Approve pins"}
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={onApproveAll}
          disabled={remainingCount === 0}
          className="inline-flex items-center justify-center rounded-2xl border-2 border-primary bg-surface px-3 py-3 text-body font-bold text-primary transition disabled:opacity-40"
        >
          Approve all remaining
        </motion.button>
      </div>
    </div>
  );
}

// The pre-deck experience, told as a story: every pin pops onto a greyed grid
// while the board's own cover sits bright in the centre being "scanned". After
// a short beat it resolves into a personalised "we found products" moment with
// two big choices — approve everything at once, or review each pin by hand.
// While candidates are still fetching it shows grey placeholders.
const INTRO_TILE_TARGET = 24;

function MonetiseBoardIntro({
  boardName,
  loading,
  total,
  candidates,
  onReviewManually,
  onApproveAll,
}: {
  boardName: string;
  loading: boolean;
  total: number;
  candidates: BoardCandidate[];
  onReviewManually: () => void;
  onApproveAll: () => void;
}) {
  const [phase, setPhase] = useState<"scanning" | "ready">("scanning");

  const messages = [
    `Finding products for ${total || "your"} pin${total === 1 ? "" : "s"}…`,
    "Matching retailers that pay you commission…",
    "Checking live prices & stock…",
    "Ranking the best matches…",
  ];
  const [msg, setMsg] = useState(0);
  useEffect(() => {
    if (loading || phase !== "scanning") return;
    const t = setInterval(() => setMsg((m) => (m + 1) % messages.length), 1600);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, phase]);

  // Hold the scan a beat once pins are in, then resolve to the choice screen.
  useEffect(() => {
    if (loading || total === 0 || phase !== "scanning") return;
    const t = setTimeout(() => setPhase("ready"), 4000);
    return () => clearTimeout(t);
  }, [loading, total, phase]);

  const covers = candidates.map((c) => c.imageUrl).filter(Boolean) as string[];
  // A full-screen field of the board's pins, cycled so the grid always fills
  // edge to edge (blacked-out, so the repeat never reads as duplication).
  const tiles = Array.from({ length: INTRO_TILE_TARGET }, (_, i) =>
    covers.length ? covers[i % covers.length] : null,
  );

  return (
    <div
      onClick={phase === "scanning" && !loading ? () => setPhase("ready") : undefined}
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-hidden px-6"
      style={{
        background: "linear-gradient(180deg, #fbe9ec 0%, #faf4f0 50%, #f6efe9 100%)",
      }}
    >
      {/* Full-screen field of the board's pins — blurred + faded so they read
          as soft texture behind, not foreground content. */}
      <div className="absolute inset-0 grid grid-cols-3 content-center gap-2 p-2 sm:grid-cols-4">
        {tiles.map((src, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, scale: 0.6, filter: "blur(10px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(3px)" }}
            transition={{
              delay: Math.min(i * 0.045, 0.9),
              type: "spring",
              stiffness: 260,
              damping: 22,
            }}
            className="relative aspect-square overflow-hidden rounded-xl bg-rose-100/40"
          >
            {src && (
              <img
                src={src}
                alt=""
                className="h-full w-full object-cover opacity-30 grayscale-[30%]"
              />
            )}
          </motion.div>
        ))}
      </div>

      {/* Soft white wash so the grid melts into the cream theme */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-background/30" />

      {/* Ambient drifting brand glow — gentle on the light backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob absolute -left-16 top-10 h-64 w-64 rounded-full bg-primary/20 blur-3xl" />
        <div className="animate-blob-delay-2 absolute -right-14 top-1/3 h-56 w-56 rounded-full bg-rose-400/20 blur-3xl" />
        <div className="animate-blob-delay-4 absolute -bottom-10 left-1/4 h-56 w-56 rounded-full bg-amber-300/25 blur-3xl" />
      </div>

      {/* Light vignette — fades the edges into cream so focus lands dead centre */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 85% at 50% 50%, transparent 4%, rgba(250,244,240,0.55) 50%, rgba(250,244,240,0.95) 100%)",
        }}
      />

      {/* Centre card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.82, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 240, damping: 19, delay: 0.15 }}
        className={`relative z-10 ${phase === "ready" ? "w-[92%] max-w-sm" : "w-[84%] max-w-xs"}`}
      >
        {/* Gradient glow bloom behind the card */}
        <div
          aria-hidden
          className="absolute -inset-3 rounded-[36px] bg-gradient-primary opacity-30 blur-2xl"
        />

        <div className="relative overflow-hidden rounded-[28px] border border-border/70 bg-surface/95 p-6 text-center shadow-elevate backdrop-blur-xl">
          <AnimatePresence mode="wait">
            {phase === "scanning" ? (
              <motion.div
                key="scanning"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.3 }}
              >
                <motion.div
                  className="relative mx-auto w-48"
                  animate={{ scale: [1, 1.015, 1] }}
                  transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                >
                  <span className="pointer-events-none absolute inset-0 -m-2 animate-ping rounded-[28px] border-2 border-primary/30" />
                  <span className="pointer-events-none absolute inset-0 -m-4 rounded-[32px] border border-primary/15" />
                  <BoardThumb covers={covers} scanning />
                  {/* Lens gliding over the board as it scans */}
                  <motion.span
                    className="pointer-events-none absolute left-1/2 top-1/2 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-primary shadow-glow ring-2 ring-primary/30 backdrop-blur"
                    animate={{ x: [-34, 34, -34], y: [-22, 26, -22], rotate: [-6, 6, -6] }}
                    transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
                  >
                    <Search className="h-5 w-5" strokeWidth={2.5} />
                  </motion.span>
                  <motion.span
                    className="absolute -right-3 -top-3 text-primary"
                    animate={{ scale: [0, 1, 0], rotate: [0, 90, 180], opacity: [0, 1, 0] }}
                    transition={{ duration: 1.9, repeat: Infinity, ease: "easeInOut" }}
                  >
                    <Sparkles className="h-6 w-6" fill="currentColor" />
                  </motion.span>
                  <motion.span
                    className="absolute -bottom-2 -left-3 text-rose-400"
                    animate={{ scale: [0, 1, 0], rotate: [0, -90, -180], opacity: [0, 1, 0] }}
                    transition={{ duration: 2.1, repeat: Infinity, delay: 0.7, ease: "easeInOut" }}
                  >
                    <Sparkles className="h-4 w-4" fill="currentColor" />
                  </motion.span>
                </motion.div>

                <h2 className="mt-5 font-display text-xl font-extrabold tracking-tight">
                  Monetising{boardName ? ` “${boardName}”` : " this board"}
                </h2>
                <p
                  key={loading ? "loading" : msg}
                  className="animate-hint-in mt-1.5 min-h-[2.5em] text-sm font-medium text-muted-foreground"
                >
                  {loading ? "Gathering your pins…" : messages[msg]}
                </p>
                <div className="mx-auto mt-3 h-1.5 w-40 overflow-hidden rounded-full bg-primary/10">
                  <div className="h-full w-1/3 animate-indeterminate rounded-full bg-gradient-primary" />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="ready"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
              >
                {/* Native board thumbnail with a success badge */}
                <div className="relative mx-auto w-52">
                  <BoardThumb covers={covers} />
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.15 }}
                    className="absolute -bottom-3 -right-3 grid h-10 w-10 place-items-center rounded-full bg-emerald-500 text-white shadow-glow ring-4 ring-surface"
                  >
                    <CheckCheck className="h-5 w-5" strokeWidth={2.5} />
                  </motion.span>
                </div>

                <h2 className="mt-5 font-display text-2xl font-extrabold leading-tight tracking-tight">
                  How do you want to go?
                </h2>
                <p className="mx-auto mt-1.5 max-w-[17rem] text-sm font-medium text-muted-foreground">
                  We found {total} pin{total === 1 ? "" : "s"} in your board
                </p>

                <div className="mt-6 grid grid-cols-2 gap-3">
                  <button
                    onClick={onApproveAll}
                    className="flex flex-col items-center gap-2.5 rounded-2xl bg-gradient-primary p-4 text-center shadow-glow transition active:scale-[0.97]"
                  >
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/20 text-primary-foreground">
                      <Sparkles className="h-6 w-6" />
                    </span>
                    <span className="text-sm font-bold leading-tight text-primary-foreground">
                      Approve all
                    </span>
                  </button>

                  <button
                    onClick={onReviewManually}
                    className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-primary bg-surface p-4 text-center transition active:scale-[0.97]"
                  >
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-primary/10 text-primary">
                      <Heart className="h-6 w-6" fill="currentColor" />
                    </span>
                    <span className="text-sm font-bold leading-tight text-primary">
                      Review manually
                    </span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

// The board's native thumbnail — the same collage we use to represent a board
// everywhere else: one big cover on the left, two stacked pins on the right.
// `scanning` adds the reverse-image-search sweep + viewfinder brackets.
function BoardThumb({ covers, scanning = false }: { covers: string[]; scanning?: boolean }) {
  const [a, b, c] = covers;
  const side = [b, c];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/70 shadow-glow ring-1 ring-primary/25">
      <div className="flex aspect-[4/3] w-full gap-0.5 bg-surface">
        <div className="relative flex-[2] bg-gradient-to-br from-rose-500 to-pink-600">
          {a ? (
            <img src={a} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-primary-foreground">
              <Wand2 className="h-8 w-8" />
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-0.5">
          {side.map((src, i) => (
            <div key={i} className="relative flex-1 bg-gradient-to-br from-rose-400 to-pink-500">
              {src && (
                <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />
              )}
            </div>
          ))}
        </div>
      </div>
      {scanning && (
        <>
          <span className="pointer-events-none absolute inset-x-0 top-0 h-14 animate-scan bg-gradient-to-b from-primary/70 via-primary/25 to-transparent" />
          <span className="absolute left-2 top-2 h-5 w-5 rounded-tl-md border-l-2 border-t-2 border-white/90" />
          <span className="absolute right-2 top-2 h-5 w-5 rounded-tr-md border-r-2 border-t-2 border-white/90" />
          <span className="absolute bottom-2 left-2 h-5 w-5 rounded-bl-md border-b-2 border-l-2 border-white/90" />
          <span className="absolute bottom-2 right-2 h-5 w-5 rounded-br-md border-b-2 border-r-2 border-white/90" />
        </>
      )}
    </div>
  );
}

// A friendly, human ETA string from a seconds count.
function formatEta(seconds: number): string {
  if (seconds <= 0) return "any second now";
  if (seconds < 60) return `~${Math.max(5, Math.ceil(seconds / 5) * 5)} sec`;
  const mins = Math.ceil(seconds / 60);
  return `~${mins} min`;
}

// Shown after "Approve all" — the heavy matching runs in the background, so
// this is a calm, delightful "we're on it" state: a progress ring winding
// around the board's cover as pins get matched, a live ETA that counts down,
// and a clear nudge that the user can head home rather than wait here — the
// job finishes on its own and they'll be notified.
function BoardApproving({
  covers,
  matched,
  total,
  onBack,
}: {
  covers: string[];
  matched: number;
  total: number;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const cover = covers[0] ?? null;
  const pct = total > 0 ? Math.min(matched / total, 1) : 0;
  const R = 66;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - pct);
  const allMatched = total > 0 && matched >= total;

  // Live ETA. Seed a rough estimate from the board size (matching runs 4-wide
  // at ~7s/pin, plus a short attach tail), then tick it down each second so the
  // wait visibly moves. Floors at a few seconds while work is still in flight.
  const initialEtaRef = useRef(Math.max(15, Math.ceil(total / 4) * 7 + 6));
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const remainingEta = Math.max(allMatched ? 0 : 3, initialEtaRef.current - elapsed);

  return (
    <div className="relative mx-auto flex min-h-[calc(100dvh-6rem)] max-w-xs flex-col items-center justify-center overflow-hidden px-6 text-center">
      {/* One quiet ambient wash — depth without competing motion. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-3xl"
      />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="relative flex w-full flex-col items-center"
      >
        {/* Progress ring + board cover */}
        <div className="relative h-40 w-40">
          <span className="pointer-events-none absolute inset-0 animate-pulse rounded-full bg-primary/10 blur-xl" />
          <svg viewBox="0 0 160 160" className="absolute inset-0 h-full w-full -rotate-90">
            <circle
              cx="80"
              cy="80"
              r={R}
              fill="none"
              strokeWidth="8"
              className="stroke-surface-2"
            />
            <circle
              cx="80"
              cy="80"
              r={R}
              fill="none"
              strokeWidth="8"
              strokeLinecap="round"
              stroke="url(#approveGrad)"
              strokeDasharray={CIRC}
              strokeDashoffset={offset}
              style={{ transition: "stroke-dashoffset 0.7s cubic-bezier(0.22,1,0.36,1)" }}
            />
            <defs>
              <linearGradient id="approveGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#f43f5e" />
                <stop offset="100%" stopColor="#e11d48" />
              </linearGradient>
            </defs>
          </svg>

          <div className="absolute inset-3 overflow-hidden rounded-full border-4 border-surface bg-gradient-to-br from-rose-500 to-pink-600 shadow-glow">
            {cover ? (
              <img src={cover} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-primary-foreground">
                <Wand2 className="h-7 w-7" />
              </div>
            )}
            <span className="pointer-events-none absolute inset-x-0 top-0 h-7 animate-scan bg-gradient-to-b from-primary/60 via-primary/20 to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-6">
              <span className="text-lg font-extrabold tabular-nums text-white">
                {Math.round(pct * 100)}%
              </span>
            </div>
          </div>
        </div>

        <span className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {matched}/{total} pin{total === 1 ? "" : "s"} matched
        </span>

        <h2 className="mt-4 font-display text-[26px] font-extrabold leading-tight tracking-tight">
          {allMatched ? "Almost there — publishing" : "Sit back, we're on it"}
        </h2>
        {/* The chip above already counts the pins and the heading already says
            what's happening, so this only has to answer "how long, and do I
            have to sit here" — which is what the buttons below act on. */}
        <p className="mx-auto mt-2 max-w-[17rem] text-lead leading-snug text-muted-foreground">
          {allMatched ? "Wrapping up" : `${formatEta(remainingEta)} left`} — leave if you like,
          we'll notify you.
        </p>

        {/* Primary: go home. Secondary: stay on the board. */}
        <button
          onClick={() => navigate({ to: "/dashboard" })}
          className="mt-8 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-6 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.97]"
        >
          <Home className="h-4 w-4" /> Back to home
        </button>
        <button
          onClick={onBack}
          className="mt-3 inline-flex items-center justify-center gap-1 text-sm font-semibold text-muted-foreground transition hover:text-foreground active:scale-[0.98]"
        >
          <ChevronLeft className="h-4 w-4" /> Stay on the board
        </button>
      </motion.div>
    </div>
  );
}

// A continuous rain of rupee notes behind the "board monetised" success card.
// Particles are randomised once per mount (useMemo) so they don't reset or
// jitter on re-render — only the celebration screen ever mounts this.
function MoneyRain() {
  const particles = useMemo(
    () =>
      Array.from({ length: 20 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 2.6,
        duration: 2.8 + Math.random() * 2,
        size: 14 + Math.random() * 12,
        drift: (Math.random() - 0.5) * 70,
        tone: ["text-emerald-500", "text-amber-500", "text-primary"][i % 3],
      })),
    [],
  );

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className={`absolute top-[-8%] ${p.tone}`}
          style={{ left: `${p.left}%` }}
          initial={{ y: "-10%", x: 0, opacity: 0, rotate: 0 }}
          animate={{ y: "115vh", x: p.drift, opacity: [0, 1, 1, 0], rotate: 360 }}
          transition={{ duration: p.duration, delay: p.delay, repeat: Infinity, ease: "linear" }}
        >
          <Banknote style={{ width: p.size, height: p.size }} />
        </motion.span>
      ))}
    </div>
  );
}

// The celebration screen every "board is fully monetised" path lands on —
// manual review finishing the last pin, the background bulk job completing
// (whether the user stuck around or came back via the dashboard floater), or
// tapping the floater's "done" toast. Same route, same component, so all
// three converge here automatically once `done && !bgRunning` is true.
function BoardMonetized({
  boardName,
  approvedCount,
  onBack,
}: {
  boardName: string;
  approvedCount: number;
  onBack: () => void;
}) {
  return (
    <div className="relative mx-auto flex min-h-[calc(100dvh-6rem)] max-w-sm flex-col items-center justify-center overflow-hidden px-5 text-center">
      <MoneyRain />

      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob absolute -left-16 top-10 h-64 w-64 rounded-full bg-emerald-400/20 blur-3xl" />
        <div className="animate-blob-delay-2 absolute -right-14 top-1/3 h-56 w-56 rounded-full bg-amber-300/25 blur-3xl" />
        <div className="animate-blob-delay-4 absolute -bottom-10 left-1/3 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="relative flex w-full flex-col items-center"
      >
        <motion.span
          initial={{ scale: 0.4, opacity: 0, rotate: -15 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 14, delay: 0.1 }}
          className="relative grid h-24 w-24 place-items-center rounded-full bg-emerald-500 text-white shadow-glow"
        >
          <span className="pointer-events-none absolute inset-0 animate-ping rounded-full bg-emerald-500/40" />
          <PartyPopper className="h-11 w-11" />
        </motion.span>

        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.35 }}
          className="mt-6 font-display text-[26px] font-extrabold leading-tight tracking-tight"
        >
          Full board monetised! 🎉
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.35 }}
          className="mx-auto mt-2 max-w-[18rem] text-sm font-medium text-muted-foreground"
        >
          {approvedCount} pin{approvedCount === 1 ? "" : "s"} now live in{" "}
          {boardName ? `“${boardName}”` : "your board"} — you're earning on every one of them.
        </motion.p>

        <motion.button
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45, duration: 0.35 }}
          whileTap={{ scale: 0.97 }}
          onClick={onBack}
          className="mt-8 inline-flex w-full max-w-[19rem] items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition"
        >
          See live pins
        </motion.button>
      </motion.div>
    </div>
  );
}
