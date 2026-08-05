import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Loader2,
  Check,
  ChevronRight,
  Sparkles,
  Store,
  Link2,
  Plus,
  X,
  ClipboardPaste,
  ArrowRight,
  Grip,
  Image as ImageIcon,
} from "lucide-react";
import { AnimatePresence, motion, Reorder } from "framer-motion";
import { useScrollMorph } from "@/hooks/use-scroll-morph";
import { PinScanOverlay, type ScanPhase } from "@/components/pin-scan-overlay";
import { CollectionAddFlow, AddFromCollectionButton } from "@/components/collection-picker";
import { suggestPinTitle, suggestPinDescription } from "@/lib/health-score";
import { toast } from "sonner";
import {
  SuggestionCard,
  ProgressiveSuggestionCard,
  realProductPrice,
} from "@/components/suggestion-card";
import { EducationalLoader, HINTS } from "@/components/rotating-hint";
import { AppShell } from "@/components/app-shell";
import { supabase } from "@/integrations/supabase/client";
import { hostBrand, estimateCommissionPct } from "@/lib/brands";
import { getFriendlyMessage } from "@/lib/friendly-error";
import {
  visualSearchImage,
  createPinterestPin,
  type CkResult,
  type RawVisualMatch,
} from "@/lib/pinterest.functions";
import {
  CATEGORY_PILLS,
  TagTab,
  ReorderableCard,
  type Collection,
  type Product,
  type Storefront,
} from "./pins";

type PinterestBoard = { id: string; name: string };

export const Route = createFileRoute("/_authenticated/pins_/create")({
  // The Health Score "Add Fresh Pins" action deep-links here pre-filtered to
  // a board (collection id) with no recent activity.
  validateSearch: (s: Record<string, unknown>): { board?: string } => ({
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  component: CreatePinWizard,
});

type Step = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<Step, string> = {
  1: "Upload image",
  2: "Add details",
  3: "Pick products",
  4: "Publish",
};

function CreatePinWizard() {
  const { board: boardFromSearch } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);

  // form state
  const [imageUrl, setImageUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [storefrontId, setStorefrontId] = useState<string>("");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [boardId, setBoardId] = useState<string>("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const runCreatePinterestPin = useServerFn(createPinterestPin);

  const { data: boards = [] } = useQuery({
    queryKey: ["pinterest-boards"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("collections")
        .select("id,name,pinterest_board_id")
        .eq("user_id", userId)
        .not("pinterest_board_id", "is", null)
        .order("position", { ascending: true });
      return ((data ?? []) as { id: string; name: string }[]).map((c) => ({
        id: c.id,
        name: c.name,
      })) as PinterestBoard[];
    },
  });

  useEffect(() => {
    if (boardId || boards.length === 0) return;
    // A deep-linked stale board (Health Score freshness fix) wins over the
    // default first-board pick.
    const linked = boardFromSearch && boards.find((b) => b.id === boardFromSearch);
    setBoardId(linked ? linked.id : boards[0].id);
  }, [boards, boardId, boardFromSearch]);

  const { data: storefronts = [] } = useQuery({
    queryKey: ["storefronts"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("storefronts")
        .select("id,name,slug")
        .eq("user_id", userId);
      return (data ?? []) as Storefront[];
    },
  });

  const { data: collections = [] } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("collections")
        .select("id,name,slug")
        .eq("user_id", userId)
        .order("position", { ascending: true });
      return (data ?? []) as Collection[];
    },
  });

  const { data: products = [] } = useQuery({
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

  // Follow the selection order (drag-reorder in step 3 writes it) so the
  // first product stays the primary one at publish time.
  const selectedProducts = selectedProductIds
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is Product => !!p);
  // Use the first selected product's storefront so the pin still links to a shop.
  const derivedStorefrontId = selectedProducts[0]?.storefront_id ?? storefrontId ?? "";
  const activeStorefront = storefronts.find((s) => s.id === derivedStorefrontId);

  // Keep storefrontId in sync with the picked products.
  useEffect(() => {
    if (selectedProducts[0]?.storefront_id && selectedProducts[0].storefront_id !== storefrontId) {
      setStorefrontId(selectedProducts[0].storefront_id);
    }
  }, [selectedProducts, storefrontId]);

  async function handleUpload(file: File) {
    if (!file.type.startsWith("image/")) return toast.error("Please choose an image file");
    if (file.size > 10 * 1024 * 1024) return toast.error("Max file size is 10 MB");
    setUploading(true);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes.user?.id;
      if (!uid) throw new Error("Not signed in");
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${uid}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("pin-images")
        .upload(path, file, { upsert: false, contentType: file.type });
      if (upErr) throw upErr;
      const { data: signed, error: signErr } = await supabase.storage
        .from("pin-images")
        .createSignedUrl(path, 60 * 60 * 24 * 365 * 10);
      if (signErr || !signed) throw signErr ?? new Error("Could not sign URL");
      setImageUrl(signed.signedUrl);
      toast.success("Image uploaded");
    } catch (e) {
      toast.error(getFriendlyMessage(e));
    } finally {
      setUploading(false);
    }
  }

  const publish = useMutation({
    mutationFn: async () => {
      if (!boardId) throw new Error("Sync a Pinterest board from Storefront first");
      if (!imageUrl) throw new Error("Add an image first");

      const primaryProduct = selectedProducts[0];
      const external = activeStorefront
        ? `${window.location.origin}/s/${activeStorefront.slug}`
        : primaryProduct?.affiliate_url || undefined;

      await runCreatePinterestPin({
        data: {
          collectionId: boardId,
          title: title.trim() || "Untitled pin",
          description: description.trim() || undefined,
          imageUrl,
          link: external,
          productId: primaryProduct?.id,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pins"] });
      toast.success("Pin published to Pinterest");
      navigate({ to: "/pins" });
    },
    onError: (e: Error) => toast.error(getFriendlyMessage(e)),
  });

  function next() {
    if (step === 1 && !imageUrl) return toast.error("Upload an image to continue");
    if (step === 2 && !title.trim()) {
      setTitleError("Add a title");
      titleInputRef.current?.focus();
      return toast.error("Add a title");
    }
    if (step === 3 && selectedProductIds.length === 0)
      return toast.error("Pick at least one product");
    setStep((s) => (s < 4 ? ((s + 1) as Step) : s));
  }

  return (
    <AppShell
      title="Create pin"
      subtitle={STEP_LABELS[step]}
      backButton
      backTo="/pins"
      hideBottomNav
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
          e.target.value = "";
        }}
      />

      {/* Stepper */}
      <div className="mx-auto mb-6 flex max-w-2xl items-center gap-2">
        {([1, 2, 3, 4] as Step[]).map((n, i) => {
          const done = step > n;
          const active = step === n;
          return (
            <div key={n} className="flex flex-1 items-center gap-2">
              <div
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ring-2 transition ${
                  done
                    ? "bg-primary text-primary-foreground ring-primary"
                    : active
                      ? "bg-primary/10 text-primary ring-primary"
                      : "bg-surface-2 text-muted-foreground ring-border"
                }`}
              >
                {done ? <Check className="h-4 w-4" /> : n}
              </div>
              {i < 3 && (
                <div
                  className={`h-0.5 flex-1 rounded transition ${done ? "bg-primary" : "bg-border"}`}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mx-auto max-w-2xl pb-32">
        {step === 1 && (
          <StepImage
            imageUrl={imageUrl}
            uploading={uploading}
            onPick={() => fileRef.current?.click()}
            onClear={() => setImageUrl("")}
          />
        )}
        {step === 2 && (
          <StepDetails
            imageUrl={imageUrl}
            title={title}
            setTitle={setTitle}
            description={description}
            setDescription={setDescription}
            titleError={titleError}
            setTitleError={setTitleError}
            titleInputRef={titleInputRef}
            boards={boards}
            boardId={boardId}
            setBoardId={setBoardId}
          />
        )}
        {step === 3 && (
          <StepProducts
            imageUrl={imageUrl}
            title={title}
            description={description}
            storefronts={storefronts}
            preferredStorefrontId={derivedStorefrontId}
            products={products}
            selectedIds={selectedProductIds}
            toggle={(id) =>
              setSelectedProductIds((cur) =>
                cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
              )
            }
            reorder={setSelectedProductIds}
            onNext={next}
          />
        )}
        {step === 4 && (
          <StepReview
            imageUrl={imageUrl}
            title={title}
            description={description}
            storefront={activeStorefront}
            products={selectedProducts}
            boards={boards}
            boardId={boardId}
            setBoardId={setBoardId}
          />
        )}
      </div>

      {/* Sticky footer — step 3 renders its own attach-style footer
          (Add more + Next), identical to the attach-products dialog. */}
      {step !== 3 && (
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/95 px-5 py-3 backdrop-blur-xl"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex max-w-2xl items-center justify-end gap-3">
          {step < 4 ? (
            <button
              onClick={next}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition active:scale-[0.98]"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={() => publish.mutate()}
              disabled={publish.isPending || !boardId}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition active:scale-[0.98] disabled:opacity-70"
            >
              {publish.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Publish to Pinterest
            </button>
          )}
        </div>
      </div>
      )}
    </AppShell>
  );
}

function StepImage({
  imageUrl,
  uploading,
  onPick,
  onClear,
}: {
  imageUrl: string;
  uploading: boolean;
  onPick: () => void;
  onClear: () => void;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  return (
    <div className="space-y-4">
      <h2 className="font-display text-xl font-bold">Add a photo</h2>
      <p className="text-sm text-muted-foreground">
        Vertical images (2:3) perform best on Pinterest.
      </p>
      {imageUrl ? (
        <div className="relative overflow-hidden rounded-3xl border border-border bg-surface">
          <img
            key={imageUrl}
            src={imageUrl}
            alt=""
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            className={`max-h-[520px] w-full object-contain opacity-0 transition-opacity duration-300 ${
              imgLoaded ? "opacity-100" : ""
            }`}
          />
          <button
            onClick={onClear}
            className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-background/90 text-foreground shadow-elevate"
            aria-label="Remove image"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          onClick={onPick}
          disabled={uploading}
          className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-border bg-surface/40 p-6 text-center transition hover:border-primary hover:bg-primary/5 disabled:opacity-70"
        >
          {uploading ? (
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          ) : (
            <>
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
                <Upload className="h-6 w-6" />
              </div>
              <div>
                <div className="font-semibold">Tap to upload</div>
                <div className="text-xs text-muted-foreground">JPG or PNG · up to 10 MB</div>
              </div>
            </>
          )}
        </button>
      )}
    </div>
  );
}

function StepDetails({
  imageUrl,
  title,
  setTitle,
  description,
  setDescription,
  titleError,
  setTitleError,
  titleInputRef,
  boards,
  boardId,
  setBoardId,
}: {
  imageUrl: string;
  title: string;
  setTitle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  titleError: string | null;
  setTitleError: (v: string | null) => void;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  boards: PinterestBoard[];
  boardId: string;
  setBoardId: (id: string) => void;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const descInputRef = useRef<HTMLTextAreaElement>(null);
  // Suggestions dismissed once the user accepts them; re-shown if they clear
  // the field again so the help is always one tap away.
  const [titleUsed, setTitleUsed] = useState(false);
  const [descUsed, setDescUsed] = useState(false);

  // Reuse the same heuristic rewrite the Boost flow uses. A synthetic pin
  // (seeded by the image URL for stable suffix rotation) feeds the helpers;
  // with no board context they fall back to their generic anchors.
  const pinLike = useMemo(
    () => ({
      id: imageUrl || "new-pin",
      title,
      description,
      image_url: imageUrl || null,
      collection_id: null,
      created_at: "",
    }),
    [imageUrl, title, description],
  );
  const titleSuggestion = useMemo(() => suggestPinTitle(pinLike, null), [pinLike]);
  const descSuggestion = useMemo(() => suggestPinDescription(pinLike, null), [pinLike]);

  // Only offer a suggestion when it actually improves on what's typed.
  const showTitleSug = !titleUsed && titleSuggestion.trim() !== title.trim();
  const showDescSug = !descUsed && descSuggestion.trim() !== description.trim();

  return (
    <div className="space-y-5">
      <h2 className="font-display text-xl font-bold">Pin details</h2>
      <div className="flex gap-4">
        {imageUrl && (
          <img
            key={imageUrl}
            src={imageUrl}
            alt=""
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            className={`hidden h-40 w-32 shrink-0 rounded-2xl object-cover opacity-0 ring-1 ring-border transition-opacity duration-300 sm:block ${
              imgLoaded ? "opacity-100" : ""
            }`}
          />
        )}
        <div className="flex-1 space-y-4">
          <div>
            <Field label="Title" hint={`${title.length}/100`}>
              <input
                ref={titleInputRef}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value.slice(0, 100));
                  if (titleError) setTitleError(null);
                  setTitleUsed(false);
                }}
                placeholder="Add a catchy title"
                className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
              />
            </Field>
            {titleError && (
              <p className="mt-1 text-xs font-medium text-destructive">{titleError}</p>
            )}
            {showTitleSug && (
              <AiSuggestion
                text={titleSuggestion}
                onUse={() => {
                  setTitle(titleSuggestion.slice(0, 100));
                  setTitleError(null);
                  setTitleUsed(true);
                  titleInputRef.current?.focus();
                }}
              />
            )}
          </div>
          <div>
            <Field label="Description" hint={`${description.length}/500`}>
              <textarea
                ref={descInputRef}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value.slice(0, 500));
                  setDescUsed(false);
                }}
                placeholder="Tell people about your pin"
                rows={4}
                className="w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
              />
            </Field>
            {showDescSug && (
              <AiSuggestion
                text={descSuggestion}
                onUse={() => {
                  setDescription(descSuggestion.slice(0, 500));
                  setDescUsed(true);
                  descInputRef.current?.focus();
                }}
              />
            )}
          </div>

          {/* Pick the Pinterest board here, alongside the details — the
              review step shows the same picker, pre-filled with this choice. */}
          <div>
            <Field label="Pinterest board">
              {boards.length === 0 ? (
                <div className="space-y-2 rounded-xl border border-dashed border-border bg-surface-2/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    No synced boards yet — sync your Pinterest boards from Storefront first.
                  </p>
                  <Link
                    to="/storefront"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                  >
                    Go to Storefront <ChevronRight className="h-3 w-3" />
                  </Link>
                </div>
              ) : (
                <select
                  value={boardId}
                  onChange={(e) => setBoardId(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
                >
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </div>
      </div>
    </div>
  );
}

// A single AI-drafted value with a one-tap "Use" action. Accepting it fills
// the field and removes the card (the parent flips its `used` flag).
function AiSuggestion({ text, onUse }: { text: string; onUse: () => void }) {
  return (
    <div className="mt-2 flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/5 p-2.5">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
          AI suggestion
        </p>
        <p className="mt-0.5 text-sm leading-snug text-foreground/90">{text}</p>
      </div>
      <button
        type="button"
        onClick={onUse}
        className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-90 active:scale-[0.97]"
      >
        Use
      </button>
    </div>
  );
}

function StepProducts({
  imageUrl,
  title,
  description,
  storefronts,
  preferredStorefrontId,
  products,
  selectedIds,
  toggle,
  reorder,
  onNext,
}: {
  imageUrl: string;
  title: string;
  description: string;
  storefronts: Storefront[];
  preferredStorefrontId: string;
  products: Product[];
  selectedIds: string[];
  toggle: (id: string) => void;
  reorder: (ids: string[]) => void;
  onNext: () => void;
}) {
  const qc = useQueryClient();
  const runVisualSearch = useServerFn(visualSearchImage);

  const [manualUrl, setManualUrl] = useState("");
  const [productUrlError, setProductUrlError] = useState<string | null>(null);
  const manualUrlInputRef = useRef<HTMLInputElement>(null);
  // Keyed by link (stable identity for a progressive-rendering match),
  // not index — the real storefront_products row id once auto-inserted.
  const [aiProductIds, setAiProductIds] = useState<Record<string, string>>({});
  const [manualProductIds, setManualProductIds] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);

  // Attach-flow UI state — mirrors the single-pin attach dialog exactly.
  // Manual entry lives in the "Add more" sheet, never inline on the page;
  // `showCollection` swaps in the full-screen Add-from-Collection flow.
  const [showAddMore, setShowAddMore] = useState(false);
  const [showCollection, setShowCollection] = useState(false);
  // Active product-tag tab (null = "All") + static category pills.
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeCategoryPill, setActiveCategoryPill] = useState<(typeof CATEGORY_PILLS)[number]>(
    CATEGORY_PILLS[0],
  );
  // Explicit display order of the AI match grid, driven by the inline drag.
  const [aiOrder, setAiOrder] = useState<string[]>([]);

  // Scroll-linked morph: the big pin preview shrinks/fades/lifts out of the
  // way as the results scroll down, and expands back on scroll up. This page
  // scrolls the window (no modal container), so no ref is passed.
  const morph = useScrollMorph(undefined, { heroMaxHeight: 208 });
  // Guards against double-inserting the same suggestion — plain ref (not
  // state) since it only needs to block a duplicate call, never render.
  const insertingLinksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const { data: aiData, isFetching: aiLoading } = useQuery({
    // title/description ride along to the server fn but aren't used by the
    // actual search (it only ever searches by imageUrl) — keeping them out
    // of the key means editing the title text can't trigger a redundant
    // re-search of the same image.
    queryKey: ["visual-search-image", imageUrl],
    queryFn: () => runVisualSearch({ data: { imageUrl, title, description } }),
    enabled: !!imageUrl,
    // Results are already fully validated (real matches, live price+stock) —
    // never silently refetch this expensive pipeline in the background; a
    // manual refetchAI() call is the only way it runs again.
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const suggestions = aiData?.suggestions ?? [];

  // Progressive rendering: `suggestions` paints immediately (image/title/
  // source + Lens price, no CK wait); each card resolves its live price/stock
  // independently via ProgressiveSuggestionCard. `confirmedByLink` records
  // each match's outcome the instant it settles — never present = still
  // resolving, `null` = no price from CK or Lens at all (rare).
  const [confirmedByLink, setConfirmedByLink] = useState<Map<string, CkResult>>(new Map());

  // Reset AI selection tracking when a fresh set of suggestions arrives.
  useEffect(() => {
    setAiProductIds({});
    setConfirmedByLink(new Map());
    insertingLinksRef.current = new Set();
    setAiOrder([]);
    setActiveTag(null);
  }, [aiData]);

  // Full-screen scan experience shown while the visual search runs — same as
  // the attach-products dialog. It resolves to `found` (brief success beat,
  // then auto-dismiss to the matches) or `empty` (points the user at manual
  // entry). `scanAck` = the overlay has been dismissed (auto or by tap).
  const [scanAck, setScanAck] = useState(false);
  // Revisiting this step with the search already cached — no scan to show.
  useEffect(() => {
    if (!aiLoading && aiData) setScanAck(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const scanPhase: ScanPhase | null = scanAck
    ? null
    : aiLoading
      ? "scanning"
      : suggestions.length > 0
        ? "found"
        : "empty";
  // Once matches are in, hold the success beat briefly, then reveal them.
  useEffect(() => {
    if (scanPhase !== "found") return;
    const t = setTimeout(() => setScanAck(true), 1000);
    return () => clearTimeout(t);
  }, [scanPhase]);

  const checkedAI = new Set<string>(
    Object.entries(aiProductIds)
      .filter(([, id]) => selectedIds.includes(id))
      .map(([link]) => link),
  );

  // The single best earning rate across the matched retailers — headlines the
  // results ("earn up to Y% per sale") so the value is obvious at a glance.
  const topCommission = suggestions.length
    ? Math.max(...suggestions.map((s) => estimateCommissionPct(s.source)))
    : 0;

  // Product-tag tabs (from object detection). Unique tags in first-seen order,
  // each with its match count. Tabs only show when detection produced ≥2
  // distinct components; otherwise the grid is just one list.
  const tagByLink = useMemo(
    () => new Map(suggestions.map((s) => [s.link, s.tag] as const)),
    [suggestions],
  );
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of suggestions) if (s.tag) m.set(s.tag, (m.get(s.tag) ?? 0) + 1);
    return m;
  }, [suggestions]);
  const tags = useMemo(() => [...tagCounts.keys()], [tagCounts]);
  // Keep the active tab valid as results change.
  useEffect(() => {
    if (activeTag && !tagCounts.has(activeTag)) setActiveTag(null);
  }, [activeTag, tagCounts]);

  // Inline drag-reorder of the found-products grid, driven by `aiOrder`.
  const orderedAiLinks = useMemo(() => {
    const rank = new Map(aiOrder.map((l, i) => [l, i]));
    return suggestions
      .map((s) => s.link)
      .sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  }, [suggestions, aiOrder]);
  const visibleAiLinks = useMemo(
    () =>
      activeTag ? orderedAiLinks.filter((l) => tagByLink.get(l) === activeTag) : orderedAiLinks,
    [activeTag, orderedAiLinks, tagByLink],
  );
  const onAiReorder = (links: string[]) => {
    setAiOrder(links);
    // Mirror the grid order into the wizard's selection so the first product
    // stays the primary one at publish time.
    const aiIds = links
      .map((l) => aiProductIds[l])
      .filter((id): id is string => !!id && selectedIds.includes(id));
    const rest = selectedIds.filter((id) => !aiIds.includes(id));
    reorder([...aiIds, ...rest]);
  };

  // Products offered by the Add-from-Collection flow — same storefront rule
  // as the attach dialog.
  const storeProducts = useMemo(
    () =>
      products.filter((p) => !preferredStorefrontId || p.storefront_id === preferredStorefrontId),
    [products, preferredStorefrontId],
  );

  // Pick an existing collection product from the "Add more" sheet — mirror it
  // into `manualProductIds` so it surfaces in the main grid, and toggle it.
  const toggleCollectionProduct = (id: string) => {
    setManualProductIds((prev) => new Set(prev).add(id));
    toggle(id);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setManualUrl(text.trim());
      else toast.error("Clipboard is empty");
    } catch {
      toast.error("Couldn't read clipboard — paste manually");
    }
  };

  // Everything currently selected, in selection order — the sheet's reorder
  // list reads from this and writes back via `reorder`.
  const selectedRows = selectedIds
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is Product => !!p);

  // Auto-inserts one confirmed-available suggestion as a real
  // storefront_product — same "add every AI match automatically" behavior
  // as before, just triggered per-match the instant CK confirms it instead
  // of blindly looping over unconfirmed raw matches.
  const autoInsertSuggestion = async (s: RawVisualMatch) => {
    if (aiProductIds[s.link] || insertingLinksRef.current.has(s.link)) return;
    const targetStorefront = preferredStorefrontId || storefronts[0]?.id;
    if (!targetStorefront) {
      toast.error("Create a storefront first.");
      return;
    }
    insertingLinksRef.current.add(s.link);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) throw new Error("Not signed in");
      const { data: inserted, error } = await supabase
        .from("storefront_products")
        .insert({
          user_id: userId,
          storefront_id: targetStorefront,
          title: s.title,
          affiliate_url: s.link,
          image_url: s.thumbnail,
        })
        .select("id")
        .single();
      if (error) throw error;
      if (!mountedRef.current) return;
      setAiProductIds((prev) => ({ ...prev, [s.link]: inserted.id as string }));
      toggle(inserted.id as string);
      qc.invalidateQueries({ queryKey: ["all-products"] });
    } catch (e) {
      toast.error(getFriendlyMessage(e));
    } finally {
      insertingLinksRef.current.delete(s.link);
    }
  };

  const handleSuggestionSettled = (link: string, details: CkResult) => {
    setConfirmedByLink((prev) => {
      if (prev.has(link)) return prev;
      const next = new Map(prev);
      next.set(link, details);
      return next;
    });
    // Every match that resolved with a usable price (live CK figure or the
    // Lens fallback, in stock or not) is auto-attached — there's no
    // "unavailable" card to hold back anymore. Only a match with no price at
    // all (`details === null`) is skipped, since there'd be nothing to show.
    if (details) {
      const s = suggestions.find((m) => m.link === link);
      if (s) void autoInsertSuggestion(s);
    }
  };

  // Toggling an already-inserted suggestion just flips its selection; a
  // card can't be tapped before it's confirmed+inserted (ProgressiveSuggestionCard
  // only renders onToggle once resolved), so this is the common path.
  const toggleAI = (link: string) => {
    const existingId = aiProductIds[link];
    if (existingId) {
      toggle(existingId);
      return;
    }
    const s = suggestions.find((m) => m.link === link);
    if (s) void autoInsertSuggestion(s);
  };

  const addProduct = useMutation({
    mutationFn: async () => {
      const url = manualUrl.trim();
      if (!url) throw new Error("Paste a product link first");
      try {
        new URL(url);
      } catch {
        throw new Error("That doesn't look like a valid URL");
      }
      const targetStorefront = preferredStorefrontId || storefronts[0]?.id;
      if (!targetStorefront) throw new Error("Create a storefront first.");

      const normalize = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
      const existing = products.find((p) => normalize(p.affiliate_url) === normalize(url));
      if (existing) return { id: existing.id, duplicate: true as const };

      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) throw new Error("Not signed in");
      let hostname = "New product";
      try {
        hostname = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        /* keep default */
      }
      const productTitle = title ? `${title} — ${hostname}` : hostname;
      const { data: inserted, error } = await supabase
        .from("storefront_products")
        .insert({
          user_id: userId,
          storefront_id: targetStorefront,
          title: productTitle,
          affiliate_url: url,
          image_url: imageUrl || null,
        })
        .select("id")
        .single();
      if (error) throw error;
      return { id: inserted.id as string, duplicate: false as const };
    },
    onSuccess: ({ id, duplicate }) => {
      qc.invalidateQueries({ queryKey: ["all-products"] });
      if (!selectedIds.includes(id)) toggle(id);
      setManualProductIds((prev) => new Set(prev).add(id));
      setManualUrl("");
      setProductUrlError(null);
      toast.success(duplicate ? "Already in Your products — selected" : "Added to Your products");
    },
    onError: (e: Error) => {
      toast.error(getFriendlyMessage(e));
      setProductUrlError(e.message);
      manualUrlInputRef.current?.focus();
    },
  });

  return (
    <>
      {/* Full-screen scan overlay while the visual search runs. */}
      <AnimatePresence>
        {scanPhase && (
          <PinScanOverlay
            imageUrl={imageUrl || null}
            phase={scanPhase}
            matchCount={suggestions.length}
            onContinue={() => {
              // No matches → land on the step with the Add-more sheet already
              // open so they can paste a link or pick from a collection.
              setScanAck(true);
              setShowAddMore(true);
            }}
            onSkip={() => {
              setScanAck(true);
              setShowAddMore(true);
            }}
          />
        )}
      </AnimatePresence>

      <div>
        {/* "Visual match" label — fades out with the hero as you scroll. */}
        <motion.div
          style={{ opacity: morph.heroOpacity }}
          className="mb-2 flex items-center gap-1.5"
        >
          <Sparkles className="h-3 w-3 shrink-0 text-primary" />
          <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-primary">
            {aiLoading && suggestions.length === 0 ? "Scanning pin…" : "Visual match"}
          </span>
        </motion.div>

        {/* Visual scan preview (big pin with scanning bar). Its reserved
            height collapses and the image shrinks/fades/lifts as the user
            scrolls down — and reverses on scroll up. */}
        {imageUrl && (
          <motion.div
            style={{ height: morph.heroHeight, opacity: morph.heroOpacity }}
            className="flex items-start justify-center overflow-hidden"
          >
            {/* The box hugs the pin: image sets its own width from the box
                height, so it fills edge-to-edge with no letterboxing. */}
            <motion.div
              style={{ scale: morph.heroScale, y: morph.heroY }}
              className="relative h-full origin-top overflow-hidden rounded-2xl border border-border shadow-sm"
            >
              <img src={imageUrl} alt="" className="h-full w-auto max-w-full object-cover" />
              {aiLoading && suggestions.length === 0 && (
                <>
                  <span className="pointer-events-none absolute inset-x-0 top-0 h-24 animate-scan bg-gradient-to-b from-primary/60 via-primary/20 to-transparent" />
                  <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary/50" />
                </>
              )}
            </motion.div>
          </motion.div>
        )}

        {/* Results — manual entry lives in the "Add more" sheet, never
            inline here. */}
        {aiLoading && suggestions.length === 0 ? (
          <div className="mt-6">
            <EducationalLoader label="Finding matching products…" hints={HINTS.createScan} />
          </div>
        ) : suggestions.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface-2/40 p-6 text-center">
            <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-amber-500/10 text-amber-600">
              <Sparkles className="h-5 w-5" />
            </span>
            <p className="mt-3 text-sm font-semibold">No matching products found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tap <span className="font-semibold text-primary">Add more</span> below to paste a
              link or pick from a collection.
            </p>
          </div>
        ) : (
          <>
            {/* Earnings-led header — centred and prominent */}
            <div className="mt-6 text-center">
              <h5 className="font-display text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                Found {suggestions.length} product{suggestions.length === 1 ? "" : "s"}
              </h5>
              <p className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5 text-base font-medium text-muted-foreground">
                Earn upto
                <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-3 py-0.5 text-base font-extrabold text-emerald-600">
                  {topCommission}%
                </span>
                per sale
              </p>
            </div>

            {/* Static category pills. */}
            <div className="no-scrollbar mt-4 -mx-1 flex items-center gap-2 overflow-x-auto px-1">
              {CATEGORY_PILLS.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setActiveCategoryPill(label)}
                  className={`inline-flex shrink-0 items-center rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                    activeCategoryPill === label
                      ? "bg-gradient-primary text-primary-foreground shadow-glow"
                      : "bg-surface-2 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Product-tag tabs — one per detected component. Below the pin,
                above the products. Only shown when detection found ≥2. */}
            {tags.length >= 2 && (
              <div className="no-scrollbar mt-4 -mx-1 flex items-center gap-2 overflow-x-auto px-1">
                <TagTab
                  label="All"
                  count={suggestions.length}
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

            {/* Drag any card by its ⠿ handle to rearrange (All tab only);
                tapping elsewhere selects/deselects it. */}
            {activeTag === null ? (
              <Reorder.Group
                as="div"
                axis="y"
                values={orderedAiLinks}
                onReorder={onAiReorder}
                className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3"
              >
                {orderedAiLinks.map((link) => {
                  const s = suggestions.find((m) => m.link === link);
                  if (!s) return null;
                  return (
                    <ReorderableCard key={link} value={link}>
                      <ProgressiveSuggestionCard
                        match={s}
                        selected={checkedAI.has(link)}
                        onToggle={() => toggleAI(link)}
                        onSettled={handleSuggestionSettled}
                      />
                    </ReorderableCard>
                  );
                })}
              </Reorder.Group>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {visibleAiLinks.map((link) => {
                  const s = suggestions.find((m) => m.link === link);
                  if (!s) return null;
                  return (
                    <ProgressiveSuggestionCard
                      key={link}
                      match={s}
                      selected={checkedAI.has(link)}
                      onToggle={() => toggleAI(link)}
                      onSettled={handleSuggestionSettled}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Manually-added products — no heading; they simply join the grid. */}
        {manualProductIds.size > 0 && (
          <div className="mt-4">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {products
                .filter((p) => manualProductIds.has(p.id))
                .map((p) => (
                  <SuggestionCard
                    key={p.id}
                    title={p.title}
                    thumbnail={p.image_url}
                    source={hostBrand(p.affiliate_url)}
                    link={p.affiliate_url}
                    price={realProductPrice(p.price_cents)}
                    commissionPct={p.commission_pct}
                    selected={selectedIds.includes(p.id)}
                    onToggle={() => toggle(p.id)}
                  />
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Sticky footer — Add more (outline) + Next (filled), same as the
          attach-products dialog. */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/95 px-5 py-3 backdrop-blur-xl"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <button
            onClick={() => {
              setShowCollection(false);
              setShowAddMore(true);
            }}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 border-primary bg-surface px-4 py-3 text-sm font-bold text-primary transition active:scale-[0.98]"
          >
            <Plus className="h-4 w-4" /> Add more
          </button>
          <button
            onClick={onNext}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
          >
            Next{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}{" "}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* "Add more" bottom sheet — paste a link manually, or pick from a
          collection. Opened from the footer or after a no-match scan. */}
      <AnimatePresence>
        {showAddMore && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[55] flex items-end justify-center bg-background/60 backdrop-blur-sm sm:items-center sm:p-4"
            onClick={() => setShowAddMore(false)}
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
                Paste an affiliate link, or pick a product from your collection.
              </p>

              {/* Paste a link */}
              <div className="mt-4 flex items-center gap-2">
                <div
                  className={`flex flex-1 items-center gap-2 rounded-2xl border bg-background px-3 py-3 ${
                    productUrlError ? "border-rose-400" : "border-input"
                  }`}
                >
                  <Link2 className="h-4 w-4 shrink-0 text-primary" />
                  <input
                    ref={manualUrlInputRef}
                    type="url"
                    value={manualUrl}
                    onChange={(e) => {
                      setManualUrl(e.target.value);
                      if (productUrlError) setProductUrlError(null);
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
              {productUrlError && <p className="mt-1.5 text-xs text-rose-500">{productUrlError}</p>}
              {/* Only appears once there's a link to add. */}
              {manualUrl.trim() && (
                <button
                  type="button"
                  onClick={() => addProduct.mutate()}
                  disabled={addProduct.isPending}
                  className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98] disabled:opacity-50"
                >
                  {addProduct.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Add link
                </button>
              )}

              {/* divider */}
              <div className="my-4 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                <span className="h-px flex-1 bg-border" /> or{" "}
                <span className="h-px flex-1 bg-border" />
              </div>

              {/* Add from collection — full-screen: a Collections grid,
                  then that collection's products. */}
              <AddFromCollectionButton onClick={() => setShowCollection(true)} />

              {showCollection && (
                <CollectionAddFlow
                  products={storeProducts}
                  pickedIds={new Set(selectedIds)}
                  onTogglePicked={toggleCollectionProduct}
                  onExit={() => setShowCollection(false)}
                />
              )}

              {/* Everything picked so far — reorder by dragging a row, or
                  remove with ✕. */}
              {selectedRows.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-xs font-semibold text-muted-foreground">
                    {selectedRows.length} selected
                  </p>
                  <Reorder.Group
                    as="div"
                    axis="y"
                    values={selectedIds}
                    onReorder={reorder}
                    className="flex max-h-[34vh] flex-col gap-2 overflow-y-auto"
                  >
                    {selectedRows.map((p) => {
                      const amount = p.price_cents != null ? p.price_cents / 100 : null;
                      const pct =
                        p.commission_pct ?? estimateCommissionPct(hostBrand(p.affiliate_url));
                      const earn = amount != null ? Math.round(amount * (pct / 100)) : null;
                      return (
                        <Reorder.Item
                          as="div"
                          key={p.id}
                          value={p.id}
                          whileDrag={{ scale: 1.02, zIndex: 10 }}
                          transition={{ type: "spring", stiffness: 500, damping: 40 }}
                          className="flex touch-none select-none items-center gap-2.5 rounded-2xl border border-border bg-surface p-2 shadow-sm active:cursor-grabbing"
                        >
                          <span className="grid h-7 w-6 shrink-0 cursor-grab place-items-center text-muted-foreground/60 active:cursor-grabbing">
                            <Grip className="h-4 w-4" />
                          </span>
                          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-surface-2">
                            {p.image_url ? (
                              <img src={p.image_url} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <div className="grid h-full w-full place-items-center text-muted-foreground">
                                <ImageIcon className="h-4 w-4" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                              {hostBrand(p.affiliate_url)}
                            </p>
                            <p className="truncate text-sm font-semibold leading-tight">
                              {p.title}
                            </p>
                            <div className="mt-0.5 flex items-center gap-2">
                              {amount != null && (
                                <span className="text-xs font-bold">
                                  ₹{amount.toLocaleString("en-IN")}
                                </span>
                              )}
                              {earn != null && (
                                <span className="text-[11px] font-bold text-emerald-600">
                                  Earn ₹{earn}/sale
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(p.id);
                            }}
                            aria-label="Remove"
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </Reorder.Item>
                      );
                    })}
                  </Reorder.Group>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  setShowAddMore(false);
                  onNext();
                }}
                className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
              >
                Continue{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
                <ArrowRight className="h-4 w-4" />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
        active
          ? "bg-primary text-primary-foreground shadow-glow"
          : "bg-surface-2 text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function StepReview({
  imageUrl,
  title,
  description,
  storefront,
  products,
  boards,
  boardId,
  setBoardId,
}: {
  imageUrl: string;
  title: string;
  description: string;
  storefront: Storefront | undefined;
  products: Product[];
  boards: PinterestBoard[];
  boardId: string;
  setBoardId: (id: string) => void;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  return (
    <div className="space-y-5">
      <h2 className="font-display text-xl font-bold">Ready to publish</h2>

      <div>
        <label className="mb-1.5 block text-sm font-medium">Pinterest board</label>
        {boards.length === 0 ? (
          <div className="space-y-2 rounded-xl border border-dashed border-border bg-surface-2/40 p-3">
            <p className="text-xs text-muted-foreground">
              No synced boards yet — sync your Pinterest boards from Storefront first.
            </p>
            <Link
              to="/storefront"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              Go to Storefront <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        ) : (
          <select
            value={boardId}
            onChange={(e) => setBoardId(e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="overflow-hidden rounded-3xl border border-border bg-surface">
        {imageUrl && (
          <img
            key={imageUrl}
            src={imageUrl}
            alt=""
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            className={`max-h-[420px] w-full object-cover opacity-0 transition-opacity duration-300 ${
              imgLoaded ? "opacity-100" : ""
            }`}
          />
        )}
        <div className="space-y-3 p-5">
          <h3 className="font-display text-lg font-bold">{title || "Untitled pin"}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
          {storefront && (
            <div className="flex items-center gap-2 rounded-xl bg-primary/5 px-3 py-2 text-xs font-medium text-primary">
              <Store className="h-4 w-4" /> {storefront.name}
              {products.length > 0 && (
                <span className="text-primary/70">
                  · {products.length} product{products.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {products.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Attached products
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {products.map((p) => (
              <div key={p.id} className="h-56 w-36 shrink-0">
                <SuggestionCard
                  title={p.title}
                  thumbnail={p.image_url}
                  source={hostBrand(p.affiliate_url)}
                  link={p.affiliate_url}
                  price={realProductPrice(p.price_cents)}
                  commissionPct={p.commission_pct}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
