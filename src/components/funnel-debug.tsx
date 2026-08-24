import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { notifyDone, notifyProblem } from "@/lib/notify";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardCopy,
  Crop as CropIcon,
  Layers,
  RefreshCw,
  Scan,
  Search,
  ShoppingBag,
  Tag,
  X,
} from "lucide-react";
import { useOverlayChrome } from "@/components/app-sheet";
import {
  visualSearchDebug,
  type CkResult,
  type DropReason,
  type FunnelCandidate,
  type FunnelComponent,
  type FunnelTrace,
} from "@/lib/pinterest.functions";

/* ============================================================================
   The funnel, made visible.

   An image becomes products through eleven lossy stages, and until this panel
   existed the screen showed only the last one. When a tab held the wrong
   products there was nothing to look at: the boxes never reached the browser,
   the crops are virtual (Google applies the region itself, so no crop image is
   ever rendered anywhere), and the gate that most often causes the complaint
   logged nothing at all.

   So this reads the trace `visualSearchDebug` collects from the real pipeline
   and lays it out in pipeline order — boxes on the image, the crop each box
   became, each Lens search's yield, then every candidate with the reason it is
   or isn't on screen. The question it is built to answer is not "what did we
   end up with" but "where did the thing I expected disappear".

   Rendering the crops is the one part that is genuinely reconstructed here
   rather than reported: since nothing in the pipeline ever produces a crop
   image, the panel recreates each one in CSS from the same normalised box that
   was sent to SearchAPI. What you see is the region, at the coordinates the
   search used.
   ========================================================================== */

/** Colours cycled across components so a box, its pill and its rows agree.
 * Fixed literals rather than theme tokens: these encode identity, not meaning,
 * and must stay distinguishable from each other in both themes. */
const HUES = [
  { line: "#e11d48", chip: "bg-rose-500", soft: "bg-rose-500/10 text-rose-600 border-rose-500/30" },
  { line: "#2563eb", chip: "bg-blue-600", soft: "bg-blue-600/10 text-blue-600 border-blue-600/30" },
  {
    line: "#16a34a",
    chip: "bg-green-600",
    soft: "bg-green-600/10 text-green-700 border-green-600/30",
  },
  {
    line: "#d97706",
    chip: "bg-amber-600",
    soft: "bg-amber-600/10 text-amber-700 border-amber-600/30",
  },
  {
    line: "#9333ea",
    chip: "bg-purple-600",
    soft: "bg-purple-600/10 text-purple-600 border-purple-600/30",
  },
  { line: "#0891b2", chip: "bg-cyan-600", soft: "bg-cyan-600/10 text-cyan-700 border-cyan-600/30" },
];

/** Why a candidate isn't on screen, in the words of the stage that dropped it.
 * Each one names the knob to turn, because "dropped" on its own sends you
 * reading source instead of fixing the thing. */
const DROP_COPY: Record<DropReason, { label: string; detail: string }> = {
  category_conflict: {
    label: "Category conflict",
    detail:
      "The retailer's title reads as a different category than this object. Widen the title vocabulary or add a compatible pair in product-category.ts.",
  },
  whole_needs_category: {
    label: "Unreadable title",
    detail:
      "From the whole-image search, where a title must positively name this category to enter. Nothing in it matched any category rule — usually a vocabulary gap, not a wrong product.",
  },
  crop_category_other: {
    label: "Crop category is 'other'",
    detail:
      "The detector couldn't classify this object, so the whole-image source is skipped entirely and only its own region contributes.",
  },
  full_image_cap: {
    label: "Past the whole-image cap",
    detail: "Ranked below FULL_IMAGE_MAX after the priced-first reorder.",
  },
  pool_cap: {
    label: "Past the pool cap",
    detail: "Ranked below VERIFY_POOL_MAX, so it was never a candidate for verification.",
  },
  duplicate: {
    label: "Duplicate URL",
    detail: "The same product, already held from a better-scoring occurrence.",
  },
  duplicate_promoted_crop: {
    label: "Duplicate (promoted)",
    detail:
      "Found by both sources. This occurrence collapsed into the held one, which is now counted as crop-confirmed.",
  },
  landed_veto: {
    label: "Box missed its object",
    detail:
      "No region result read as this object's category, so crop-sourced candidates are vetoed. The box probably landed off the product.",
  },
  look_different: {
    label: "Look gate: different",
    detail: "The vision model judged this photo as visibly not the object in the pin.",
  },
  verifier_blind_veto: {
    label: "Verifier blind + box missed",
    detail:
      "Not one candidate got a real verdict, so the title heuristic took over and vetoed crop-sourced candidates.",
  },
  tab_cap: {
    label: "Past the tab cap",
    detail: "Real, ranked, and below PER_TAG_MAX. Raise the cap to show it.",
  },
};

const VERDICT_STYLE: Record<string, string> = {
  same: "bg-green-600/10 text-green-700 border-green-600/30",
  close: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  different: "bg-destructive/10 text-destructive border-destructive/30",
};

export function FunnelDebug({
  pinId,
  imageUrl,
  title = "",
  description = "",
  onClose,
}: {
  pinId?: string;
  imageUrl?: string | null;
  title?: string;
  description?: string;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayChrome({ onClose, ref: panel });

  const run = useServerFn(visualSearchDebug);
  const [stage, setStage] = useState<"fast" | "verified">("verified");
  const [selected, setSelected] = useState(0);

  // Same freezing as every other search query in the app: this explains one
  // answer, and an answer that re-resolves under the reader is worse than one
  // they have to ask for again.
  const trace = useQuery({
    queryKey: ["funnel-debug", pinId ?? imageUrl, stage],
    queryFn: ({ signal }) =>
      run({
        data: pinId
          ? { pinId, stage, title, description }
          : { imageUrl: imageUrl!, stage, title, description },
        signal,
      }),
    enabled: !!(pinId || imageUrl),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const data = trace.data;
  const component = data?.components[selected];

  // Clamp when the stage switch returns a different number of components.
  useEffect(() => {
    if (data && selected >= data.components.length) setSelected(0);
  }, [data, selected]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[80] flex flex-col bg-background"
    >
      <div ref={panel} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
        <Header
          trace={data}
          loading={trace.isPending}
          stage={stage}
          onStage={setStage}
          onRefresh={() => void trace.refetch()}
          onClose={onClose}
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-16 pt-4 sm:px-6">
          <div className="mx-auto w-full max-w-5xl space-y-6">
            {trace.isPending && <Loading />}
            {trace.isError && <Failed error={trace.error} onRetry={() => void trace.refetch()} />}

            {data && (
              <>
                <FunnelSummary trace={data} />
                <DetectionStage
                  trace={data}
                  selected={selected}
                  onSelect={setSelected}
                  imageUrl={data.imageUrl}
                />
                {component ? (
                  <ComponentDetail
                    component={component}
                    index={selected}
                    imageUrl={data.imageUrl}
                    trace={data}
                  />
                ) : (
                  <Empty>
                    The detector found nothing purchasable in this image, so no component search
                    ran.
                  </Empty>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/* ---------------- Chrome ---------------- */

function Header({
  trace,
  loading,
  stage,
  onStage,
  onRefresh,
  onClose,
}: {
  trace?: FunnelTrace;
  loading: boolean;
  stage: "fast" | "verified";
  onStage: (s: "fast" | "verified") => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border bg-surface px-4 py-3 sm:px-6">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-foreground text-background">
          <Layers className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-base font-bold tracking-tight">Match funnel</h2>
          <p className="truncate text-xs text-muted-foreground">
            {loading
              ? "Replaying the pipeline from cache…"
              : trace
                ? `${trace.components.length} component${trace.components.length === 1 ? "" : "s"} · replayed in ${trace.durationMs}ms`
                : "—"}
          </p>
        </div>

        {/* Which answer to explain. The fast tab is what appeared first; the
            verified one is what replaced it. They disagree by design, so a
            complaint about the wrong products belongs to whichever the reader
            actually saw. */}
        <div className="hidden rounded-xl border border-border bg-surface-2 p-0.5 sm:flex">
          {(["fast", "verified"] as const).map((s) => (
            <button
              key={s}
              onClick={() => onStage(s)}
              className={`rounded-[0.6rem] px-3 py-1.5 text-xs font-semibold capitalize transition ${
                stage === s
                  ? "bg-surface text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {trace && (
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(JSON.stringify(trace, null, 2))
                .then(() => notifyDone("Trace copied as JSON"))
                .catch(() => notifyProblem("Couldn't reach the clipboard"));
            }}
            title="Copy the whole trace as JSON"
            className="grid h-9 w-9 place-items-center rounded-xl border border-border text-muted-foreground transition hover:text-foreground"
          >
            <ClipboardCopy className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={onRefresh}
          title="Replay the funnel"
          className="grid h-9 w-9 place-items-center rounded-xl border border-border text-muted-foreground transition hover:text-foreground"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={onClose}
          aria-label="Close funnel debug"
          className="grid h-9 w-9 place-items-center rounded-xl border border-border text-muted-foreground transition hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-3">
      <div className="h-20 animate-pulse rounded-2xl bg-surface-2" />
      <div className="h-72 animate-pulse rounded-2xl bg-surface-2" />
      <div className="h-40 animate-pulse rounded-2xl bg-surface-2" />
    </div>
  );
}

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
      <p className="flex items-center gap-2 text-sm font-bold text-destructive">
        <AlertTriangle className="h-4 w-4" /> The trace itself failed
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <button
        onClick={onRetry}
        className="mt-4 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-semibold"
      >
        Try again
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface-2 p-5 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/* ---------------- The collapse, stage by stage ---------------- */

/** The one view that answers "where did everything go" without scrolling: raw
 * Lens results through to cards on screen, summed across components. */
function FunnelSummary({ trace }: { trace: FunnelTrace }) {
  const totals = useMemo(() => {
    let raw = 0;
    let supported = 0;
    let gated = 0;
    let pooled = 0;
    let onScreen = 0;
    for (const c of trace.components) {
      for (const s of c.searches) {
        raw += s.rawCount;
        supported += s.keptCount;
      }
      gated += c.candidates.filter((x) => x.score != null).length;
      pooled += c.pooled;
      onScreen += c.candidates.filter((x) => x.finalRank != null).length;
    }
    return { raw, supported, gated, pooled, onScreen };
  }, [trace]);

  const steps = [
    { icon: Scan, label: "Objects detected", value: trace.detection.objects },
    { icon: Search, label: "Raw Lens results", value: totals.raw },
    { icon: Tag, label: "Supported retailers", value: totals.supported },
    { icon: CropIcon, label: "Passed category gate", value: totals.gated },
    { icon: Layers, label: "Pooled", value: totals.pooled },
    { icon: ShoppingBag, label: "On screen", value: totals.onScreen },
  ];

  return (
    <section>
      <SectionTitle>Funnel</SectionTitle>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {steps.map(({ icon: Icon, label, value }, i) => (
          <div
            key={label}
            className={`rounded-2xl border p-3 ${
              value === 0 && i > 0
                ? "border-destructive/40 bg-destructive/5"
                : "border-border bg-surface"
            }`}
          >
            <Icon className="h-4 w-4 text-muted-foreground" />
            <p className="mt-2 font-display text-xl font-bold tabular-nums leading-none">{value}</p>
            <p className="mt-1 text-[0.7rem] leading-tight text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      {trace.detection.atCropCap && (
        <Note>
          Exactly CROP_MAX ({trace.limits.cropMax}) components, so the detector may have found more
          objects and had them truncated. If a product you expected has no pill at all, this is the
          first cap to raise.
        </Note>
      )}
      {trace.detection.noProducts && (
        <Note>
          The detector reported nothing purchasable, so the search fell back to the whole image.
          Note that an image the vision proxy could not fetch at all collapses to this same state.
        </Note>
      )}
      {!trace.limits.detectEnabled && (
        <Note>VISION_DETECT_ENABLED is false — component detection is switched off.</Note>
      )}
      {!trace.limits.verifyEnabled && (
        <Note>VISION_VERIFY_ENABLED is false — the look gate never ran.</Note>
      )}
    </section>
  );
}

/** Stage 1: the boxes, on the image. The single most useful thing in the panel,
 * because a box that landed on the wall beside a blazer explains everything
 * downstream at a glance and is invisible everywhere else. */
function DetectionStage({
  trace,
  selected,
  onSelect,
  imageUrl,
}: {
  trace: FunnelTrace;
  selected: number;
  onSelect: (i: number) => void;
  imageUrl: string;
}) {
  const boxed = trace.components.filter((c) => c.box);

  return (
    <section>
      <SectionTitle>1 · Detection — boxes as they were sent</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,22rem)_1fr]">
        <div className="relative overflow-hidden rounded-2xl border border-border bg-surface-2">
          <img src={imageUrl} alt="" className="block w-full" />
          {boxed.map((c) => {
            const i = trace.components.indexOf(c);
            const hue = HUES[i % HUES.length];
            const active = i === selected;
            return (
              <button
                key={c.key}
                onClick={() => onSelect(i)}
                title={`${c.label} — ${c.category}`}
                className="absolute transition-opacity"
                style={{
                  left: `${c.box!.x * 100}%`,
                  top: `${c.box!.y * 100}%`,
                  width: `${c.box!.w * 100}%`,
                  height: `${c.box!.h * 100}%`,
                  border: `2px solid ${hue.line}`,
                  borderRadius: 6,
                  boxShadow: active ? `0 0 0 9999px rgba(0,0,0,0.45)` : "none",
                  opacity: active ? 1 : 0.75,
                  zIndex: active ? 2 : 1,
                }}
              >
                <span
                  className="absolute -top-0.5 left-0 -translate-y-full whitespace-nowrap rounded px-1 py-0.5 text-[0.6rem] font-bold text-white"
                  style={{ background: hue.line }}
                >
                  {c.label}
                </span>
              </button>
            );
          })}
          {boxed.length === 0 && (
            <p className="absolute inset-x-0 bottom-0 bg-background/85 p-2 text-center text-xs text-muted-foreground">
              No boxes — every component covers the whole frame
            </p>
          )}
        </div>

        <div className="space-y-2">
          {trace.components.map((c, i) => (
            <button
              key={c.key}
              onClick={() => onSelect(i)}
              className={`flex w-full items-center gap-3 rounded-2xl border p-2.5 text-left transition ${
                i === selected
                  ? "border-foreground/25 bg-surface shadow-sm"
                  : "border-border bg-surface-2 hover:border-foreground/15"
              }`}
            >
              <CropPreview imageUrl={imageUrl} box={c.box} className="h-14 w-14 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-bold">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${HUES[i % HUES.length].chip}`} />
                  {c.label}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.category}
                  {c.signature ? ` · ${c.signature}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-display text-base font-bold tabular-nums leading-none">
                  {c.candidates.filter((x) => x.finalRank != null).length}
                </p>
                <p className="text-[0.65rem] text-muted-foreground">on screen</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The crop, recreated in CSS from the normalised box.
 *
 * Nothing in the pipeline produces a crop image — SearchAPI is handed the region
 * and Google crops the original itself — so this is a reconstruction, drawn from
 * the identical coordinates the search used. The image's natural aspect ratio is
 * measured on load so the region isn't stretched. */
function CropPreview({
  imageUrl,
  box,
  className = "",
}: {
  imageUrl: string;
  box: FunnelComponent["box"];
  className?: string;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    // A decode already in flight for the previous image would otherwise land
    // after the swap and stretch the new crop to the old aspect ratio.
    let live = true;
    setNatural(null);
    const img = new Image();
    img.onload = () => {
      if (live) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = imageUrl;
    return () => {
      live = false;
    };
  }, [imageUrl]);

  if (!box) {
    return (
      <div
        className={`overflow-hidden rounded-xl border border-border bg-surface-2 ${className}`}
        style={{ backgroundImage: `url(${imageUrl})`, backgroundSize: "cover" }}
      />
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border border-border bg-surface-2 ${className}`}
      style={{
        backgroundImage: `url(${imageUrl})`,
        // The full image is 1/box.w by 1/box.h of the container.
        backgroundSize: `${100 / box.w}% ${100 / box.h}%`,
        // A percentage position aligns the image's p% point with the container's,
        // which works out to box.x/(1-box.w) for the left edge.
        backgroundPosition: `${box.w < 1 ? (box.x / (1 - box.w)) * 100 : 0}% ${
          box.h < 1 ? (box.y / (1 - box.h)) * 100 : 0
        }%`,
        aspectRatio: natural ? `${box.w * natural.w} / ${box.h * natural.h}` : undefined,
      }}
    />
  );
}

/* ---------------- One component, end to end ---------------- */

function ComponentDetail({
  component: c,
  index,
  imageUrl,
  trace,
}: {
  component: FunnelComponent;
  index: number;
  imageUrl: string;
  trace: FunnelTrace;
}) {
  const hue = HUES[index % HUES.length];
  const survivors = c.candidates.filter((x) => x.finalRank != null);
  const dropped = c.candidates.filter((x) => x.finalRank == null);

  const byReason = useMemo(() => {
    const groups = new Map<DropReason, FunnelCandidate[]>();
    for (const d of dropped) {
      const key = d.droppedAt ?? "tab_cap";
      const list = groups.get(key);
      if (list) list.push(d);
      else groups.set(key, [d]);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [dropped]);

  return (
    <>
      {/* ---- 2 · the crop this box became ---- */}
      <section>
        <SectionTitle>
          2 · Crop sent to Lens —{" "}
          <span className={`rounded border px-1.5 py-0.5 text-xs ${hue.soft}`}>{c.label}</span>
        </SectionTitle>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
          <CropPreview imageUrl={imageUrl} box={c.box} className="w-full" />
          <div className="space-y-2">
            <Facts
              rows={[
                ["Category", c.category],
                ["Look signature", c.signature || "— (look gate falls back to the label alone)"],
                [
                  "Box (normalised, padded)",
                  c.box
                    ? `x ${c.box.x.toFixed(3)} · y ${c.box.y.toFixed(3)} · w ${c.box.w.toFixed(3)} · h ${c.box.h.toFixed(3)}`
                    : "—",
                ],
                ["Frame share", `${(c.boxArea * 100).toFixed(1)}%`],
                [
                  "SearchAPI crop",
                  c.cropParam ?? "none — box was near-full-frame, shares the whole-image search",
                ],
              ]}
            />
            <div className="flex flex-wrap gap-1.5">
              {c.boxArea < trace.limits.widenSpeculateBelowArea && (
                <Flag tone="info">
                  small box · widened search warmed at {trace.limits.widenFactor}×
                </Flag>
              )}
              {c.widened && <Flag tone="info">widen rescue merged</Flag>}
              {!c.landed && <Flag tone="bad">box missed its object (landed = false)</Flag>}
              {c.verifierBlind && <Flag tone="bad">verifier blind — no verdict anywhere</Flag>}
              {c.partial && (
                <Flag tone="warn">partial pool — a Lens source hadn&apos;t landed</Flag>
              )}
              {c.verifyDisabled && <Flag tone="warn">look gate skipped</Flag>}
              {c.niche && <Flag tone="info">niche: {c.niche}</Flag>}
              <Flag tone="info">pooled {c.pooled}</Flag>
              {c.headSize > 0 && <Flag tone="info">verified head {c.headSize}</Flag>}
              <Flag tone="info">{c.durationMs}ms</Flag>
            </div>
          </div>
        </div>
      </section>

      {/* ---- 3 · the searches ---- */}
      <section>
        <SectionTitle>3 · Lens searches &amp; retailer filter</SectionTitle>
        <div className="space-y-2">
          {c.searches.length === 0 && <Empty>No Lens search ran for this component.</Empty>}
          {c.searches.map((s, i) => (
            <div key={i} className="rounded-2xl border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-lg bg-surface-2 px-2 py-1 text-xs font-bold capitalize">
                  {s.kind === "whole" ? "whole image" : s.kind}
                </span>
                <code className="truncate text-[0.7rem] text-muted-foreground">
                  {s.cropParam ?? "no crop param"}
                </code>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {s.rawCount} raw → <strong className="text-foreground">{s.keptCount}</strong>{" "}
                  supported
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {!s.answered && <Flag tone="warn">never landed — grace expired</Flag>}
                <Flag tone="info">
                  {s.origin === "unknown"
                    ? "not in memory cache"
                    : s.origin === "db"
                      ? "from lens_searches row"
                      : s.origin === "live"
                        ? "fetched live this process"
                        : "memory"}
                </Flag>
                {s.speculated && <Flag tone="info">speculatively warmed</Flag>}
                {s.merged === false && (
                  <Flag tone="warn">widen found no more — merge rejected</Flag>
                )}
                {s.merged === true && <Flag tone="info">merged into the crop pool</Flag>}
              </div>
              {s.unsupported.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
                    {s.rawCount - s.keptCount} dropped as unsupported retailers
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.unsupported.map((u) => (
                      <span
                        key={u.host}
                        className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[0.7rem] text-muted-foreground"
                      >
                        {u.host} ×{u.count}
                      </span>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ---- 4 · candidates ---- */}
      <section>
        <SectionTitle>
          4 · Candidates — {survivors.length} on screen, {dropped.length} dropped
        </SectionTitle>

        {c.queryWords.length > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            Ranking context: <code>{c.queryWords.join(" ")}</code>
            {c.labelWords.length > 0 && (
              <>
                {" "}
                · label words <code>{c.labelWords.join(" ")}</code>
              </>
            )}
          </p>
        )}

        <div className="space-y-1.5">
          {survivors.map((x) => (
            <CandidateRow key={x.link} c={x} />
          ))}
        </div>

        {survivors.length === 0 && (
          <Empty>
            Nothing reached this tab. The drop groups below are where it went — the largest group is
            the stage to look at first.
          </Empty>
        )}

        {byReason.map(([reason, list]) => (
          <DropGroup key={reason} reason={reason} list={list} />
        ))}
      </section>
    </>
  );
}

function DropGroup({ reason, list }: { reason: DropReason; list: FunnelCandidate[] }) {
  const [open, setOpen] = useState(false);
  const copy = DROP_COPY[reason];
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-surface-2 px-3 py-2.5 text-left"
      >
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">
            {copy.label}{" "}
            <span className="font-normal tabular-nums text-muted-foreground">
              · {list.length} dropped
            </span>
          </p>
          <p className="text-xs leading-snug text-muted-foreground">{copy.detail}</p>
        </div>
      </button>
      {open && (
        <div className="space-y-1.5 bg-surface p-2">
          {list.map((x) => (
            <CandidateRow key={x.link} c={x} muted />
          ))}
        </div>
      )}
    </div>
  );
}

function CandidateRow({ c, muted = false }: { c: FunnelCandidate; muted?: boolean }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-border p-2 ${
        muted ? "bg-surface-2 opacity-80" : "bg-surface"
      }`}
    >
      {c.thumbnail ? (
        <img
          src={c.thumbnail}
          alt=""
          loading="lazy"
          className="h-12 w-12 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : (
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-[0.6rem] text-muted-foreground">
          no img
        </div>
      )}

      <div className="min-w-0 flex-1">
        <a
          href={c.link}
          target="_blank"
          rel="noreferrer"
          className="line-clamp-1 text-xs font-semibold hover:underline"
        >
          {c.title}
        </a>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          <span>{c.source}</span>
          {c.price && <span>· {c.price}</span>}
          <span>· pos {c.position}</span>
          {c.score != null && <span>· score {c.score.toFixed(1)}</span>}
          {c.labelHits ? <span>· {c.labelHits} label hits</span> : null}
          <span className="rounded border border-border px-1">{c.titleCategory}</span>
          <span className="rounded border border-border px-1">{c.from}</span>
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {c.finalRank != null && (
          <span className="flex items-center gap-1 rounded-lg border border-green-600/30 bg-green-600/10 px-1.5 py-0.5 text-[0.7rem] font-bold text-green-700">
            <Check className="h-3 w-3" strokeWidth={3} />#{c.finalRank + 1}
          </span>
        )}
        {c.verdict ? (
          <span
            className={`rounded-lg border px-1.5 py-0.5 text-[0.7rem] font-semibold ${VERDICT_STYLE[c.verdict]}`}
          >
            {c.verdict}
          </span>
        ) : (
          <span className="rounded-lg border border-border px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
            unjudged
          </span>
        )}
        <CkChip link={c.link} />
      </div>
    </div>
  );
}

/** The last stage of the funnel, read from the React Query cache rather than
 * fetched: each card on the real screen owns its own CK lookup, so whatever it
 * resolved to is already here. Fetching it again would spend a live retailer
 * scrape per row just to display it. */
function CkChip({ link }: { link: string }) {
  const qc = useQueryClient();
  const state = qc.getQueryState<{ details: CkResult }>(["product-details", link]);
  if (!state) return null;
  if (state.status === "pending")
    return <span className="text-[0.65rem] text-muted-foreground">CK…</span>;
  if (state.status === "error")
    return <span className="text-[0.65rem] text-destructive">CK failed</span>;
  const details = state.data?.details;
  if (!details) return <span className="text-[0.65rem] text-muted-foreground">CK: no price</span>;
  return (
    <span className="text-[0.65rem] text-muted-foreground">
      CK ₹{details.discountedPrice.toLocaleString("en-IN")}
      {details.available ? "" : " · out of stock"}
    </span>
  );
}

/* ---------------- Small pieces ---------------- */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3 px-3 py-2">
          <dt className="w-36 shrink-0 text-muted-foreground">{k}</dt>
          <dd className="min-w-0 flex-1 break-words font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Flag({ tone, children }: { tone: "info" | "warn" | "bad"; children: React.ReactNode }) {
  const style =
    tone === "bad"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700"
        : "border-border bg-surface-2 text-muted-foreground";
  return (
    <span className={`rounded-lg border px-1.5 py-0.5 text-[0.7rem] font-semibold ${style}`}>
      {children}
    </span>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs leading-snug text-amber-800">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
