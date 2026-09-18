import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Loader2,
  Check,
  ChevronRight,
  Sparkles,
  Link2,
  Plus,
  X,
  ClipboardPaste,
  ArrowRight,
  Image as ImageIcon,
  Search,
  Folder,
  FolderPlus,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useScrollMorph } from "@/hooks/use-scroll-morph";
import { PinScanOverlay } from "@/components/pin-scan-overlay";
import { useScanPhase } from "@/hooks/use-scan-phase";
import { CollectionAddFlow, AddFromCollectionButton } from "@/components/collection-picker";
import { draftPinSeo, type DraftSeoResult } from "@/lib/pin-seo.functions";
import { notifyDone, notifyProblem } from "@/lib/notify";
import {
  SuggestionCard,
  ProgressiveSuggestionCard,
  SuggestionCardSkeleton,
  realProductPrice,
} from "@/components/suggestion-card";
import { ShopTheLookPreview } from "@/components/shop-the-look";
import {
  EMPTY_ATTACHMENT,
  attachedLinkSet,
  composeAttachedTags,
  tagFromUrl,
  toProductTagInput,
  type AttachmentState,
  type PendingProductTag,
} from "@/lib/product-tag-data";
import { planProductTags, type ProductTagPlan } from "@/lib/product-tags.functions";
import { pinCollectionSlug, pinCollectionUrl } from "@/lib/product-tag-data";
import { MAX_PRODUCT_TAGS_PER_PIN, canonicalTagLink } from "@/lib/product-tagging";
import { logPipeline } from "@/lib/pipeline-log";
import { EducationalLoader, HINTS } from "@/components/rotating-hint";
import { useVisualSearch } from "@/hooks/use-visual-search";
import { AppShell } from "@/components/app-shell";
import { SeoInsightButton, SeoInsightSheet } from "@/components/seo-insight";
import { FlowIntroGate } from "@/components/flow-intro";
import { supabase } from "@/integrations/supabase/client";
import { estimateCommissionPct, hostBrand } from "@/lib/brands";
import { getFriendlyMessage } from "@/lib/friendly-error";
import { PinterestConnectPanel } from "@/components/pinterest-gate";
import { usePinterestConnection } from "@/hooks/use-pinterest-connect";
import {
  createPinterestBoard,
  createPinterestBoardSection,
  createPinterestPin,
  listPinterestBoardSections,
  type CkResult,
} from "@/lib/pinterest.functions";
import { TagTab, type Collection, type Product, type Storefront } from "./pins";

type PinterestBoard = { id: string; name: string };

/** A section inside a Pinterest board. Lives only on Pinterest — see
 * listPinterestBoardSections — so this is the live shape, not a DB row. */
type BoardSection = { id: string; name: string };

// Cover thumbnails + pin count per board (collection id) — what turns the
// board picker from a bare <select> into the same cover-collage cards the
// collection picker uses.
type BoardMeta = Record<string, { covers: string[]; count: number }>;

export const Route = createFileRoute("/_authenticated/pins_/create")({
  // The Health Score "Add Fresh Pins" action deep-links here pre-filtered to
  // a board (collection id) with no recent activity.
  validateSearch: (s: Record<string, unknown>): { board?: string } => ({
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  component: CreatePinRoute,
});

/**
 * The one screen in the app that cannot exist without Pinterest.
 *
 * Everything here ends in a real POST to pinterest.com — the board list comes
 * from the account, and step 4 publishes — so this is gated at the door rather
 * than at the Publish button: letting someone upload an image, write a title and
 * pick products, only to be stopped at the end, would waste all of it.
 *
 * The gate is a panel, not a redirect. It keeps the creator where they navigated
 * to, says why, and offers the connection plus a way back to Home.
 */
function CreatePinRoute() {
  const { usable, isLoading } = usePinterestConnection();

  if (isLoading) {
    // Deliberately a spinner and not the gate: flashing "connect Pinterest" at
    // a connected creator for the length of one query is its own bug.
    return (
      <AppShell title="Create pin" backButton backTo="/pins" hideBottomNav>
        <div className="grid place-items-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      </AppShell>
    );
  }

  if (!usable) {
    return (
      <AppShell title="Create pin" backButton backTo="/pins" hideBottomNav>
        <PinterestConnectPanel
          title="Connect Pinterest to create a Pin"
          reason="A new Pin is published to your Pinterest account, and its board comes from there too — so this is the one flow that can't run without authorization."
          bullets={[
            "We only publish the Pin you build here, when you press Publish.",
            "Your existing Pins and boards are imported, never changed.",
            "The rest of ShopMyPin — your store, products and links — stays open without it.",
          ]}
          backTo="/pins"
          backLabel="Back to Pins"
        />
      </AppShell>
    );
  }

  return <CreatePinWizard />;
}

type Step = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<Step, string> = {
  1: "Upload image",
  2: "Add details",
  3: "Pick products",
  4: "Publish",
};

// One-word versions that fit under the stepper dots.
const STEP_SHORT_LABELS: Record<Step, string> = {
  1: "Image",
  2: "Details",
  3: "Products",
  4: "Publish",
};

function CreatePinWizard() {
  const { board: boardFromSearch } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [insight, setInsight] = useState(false);

  // form state
  const [imageUrl, setImageUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [storefrontId, setStorefrontId] = useState<string>("");
  const [attachment, setAttachment] = useState<AttachmentState>(EMPTY_ATTACHMENT);
  // The pin's id, minted here so its storefront collection URL — the "Visit
  // website" destination — is known before the pin exists. Publish sends it;
  // the server creates the pin under it.
  const [draftPinId, setDraftPinId] = useState<string>(() => crypto.randomUUID());
  // A different image is a different Pin: what was attached starts over, and
  // so does the id.
  useEffect(() => {
    setAttachment(EMPTY_ATTACHMENT);
    setDraftPinId(crypto.randomUUID());
  }, [imageUrl]);
  const [boardId, setBoardId] = useState<string>("");
  // "" = publish to the board root, which is what Pinterest does when no
  // section is given. Sections are board-scoped, so this is cleared whenever
  // the board changes (below) — a section id from board A is not a valid
  // target on board B, and Pinterest would reject it at publish time.
  const [sectionId, setSectionId] = useState<string>("");
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

  // Every board change goes through this, so no path can leave a stale
  // section selected. Same-board re-selection keeps the section.
  function chooseBoard(id: string) {
    setBoardId((cur) => {
      if (cur !== id) setSectionId("");
      return id;
    });
  }

  useEffect(() => {
    if (boardId || boards.length === 0) return;
    // A deep-linked stale board (Health Score freshness fix) wins over the
    // default first-board pick.
    const linked = boardFromSearch && boards.find((b) => b.id === boardFromSearch);
    setBoardId(linked ? linked.id : boards[0].id);
  }, [boards, boardId, boardFromSearch]);

  // Up to three recent pin images per board for its cover collage, plus the
  // board's total pin count — purely presentational, so one cheap query.
  const { data: boardMeta = {} } = useQuery({
    queryKey: ["board-pin-covers"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return {} as BoardMeta;
      const { data } = await supabase
        .from("pins")
        .select("collection_id,image_url,created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      const meta: BoardMeta = {};
      for (const p of data ?? []) {
        if (!p.collection_id) continue;
        const m = (meta[p.collection_id] ??= { covers: [], count: 0 });
        m.count++;
        if (p.image_url && m.covers.length < 3) m.covers.push(p.image_url);
      }
      return meta;
    },
  });

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

  // The backend's product tags for this image — which products, in what
  // order. Asked for the moment the creator reaches Attach Products (title and
  // description are settled by then and are part of the ranking context), so
  // it is usually in hand before Preview. It joins the same pipeline work the
  // streamed grid started; nothing is computed twice.
  const runPlan = useServerFn(planProductTags);
  const plan = useQuery({
    queryKey: ["product-tag-plan", imageUrl, title.trim(), description.trim()],
    queryFn: () =>
      runPlan({ data: { imageUrl, title: title.trim(), description: description.trim() } }),
    enabled: !!imageUrl && step >= 3,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Everything attached, in the backend's sequence — what Preview shows and
  // what Publish persists. The plan's products are attached by default; the
  // creator's taps in Attach Products override them; owned products and
  // pasted links join unranked, after the ranked ones.
  const previewTags = useMemo(
    () => composeAttachedTags(plan.data, attachment, products),
    [plan.data, attachment, products],
  );

  // The storefront the pin links to: the one holding the first attached
  // product the creator already owns, else the first storefront. Matched
  // listings don't exist as products until publish, so they can't name one.
  const firstOwnedTag = previewTags.find((t) => t.productId);
  const firstOwnedProduct = firstOwnedTag
    ? products.find((p) => p.id === firstOwnedTag.productId)
    : undefined;
  const derivedStorefrontId = firstOwnedProduct?.storefront_id || storefrontId || "";
  const activeStorefront = storefronts.find((s) => s.id === derivedStorefrontId) ?? storefronts[0];

  // Keep storefrontId in sync with the picked products.
  useEffect(() => {
    if (firstOwnedProduct?.storefront_id && firstOwnedProduct.storefront_id !== storefrontId) {
      setStorefrontId(firstOwnedProduct.storefront_id);
    }
  }, [firstOwnedProduct, storefrontId]);

  async function handleUpload(file: File) {
    if (!file.type.startsWith("image/")) return notifyProblem("Please choose an image file");
    if (file.size > 10 * 1024 * 1024) return notifyProblem("Max file size is 10 MB");
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
      notifyDone("Image uploaded");
    } catch (e) {
      notifyProblem(getFriendlyMessage(e));
    } finally {
      setUploading(false);
    }
  }

  const publish = useMutation({
    mutationFn: async () => {
      if (!boardId) throw new Error("Sync a Pinterest board from Storefront first");
      if (!imageUrl) throw new Error("Add an image first");

      // Fallback destination for a pin with no products; with products the
      // server links the pin to its own collection (see createPinterestPin).
      const external = activeStorefront
        ? `${window.location.origin}/s/${activeStorefront.slug}`
        : previewTags[0]?.link || undefined;

      return runCreatePinterestPin({
        data: {
          collectionId: boardId,
          pinId: draftPinId,
          origin: window.location.origin,
          sectionId: sectionId || undefined,
          title: title.trim() || "Untitled pin",
          description: description.trim() || undefined,
          imageUrl,
          link: external,
          // The canonical sequence Preview showed — the first is the primary.
          // Each carries how it was matched (object, category, score, source);
          // the server creates product rows for matched listings and enforces
          // the per-pin limit.
          productTags: previewTags.map(toProductTagInput),
        },
      });
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["pins"] });
      qc.invalidateQueries({ queryKey: ["all-products"] });
      if (result.tagError) {
        // The Pin IS on Pinterest — say so, and say what didn't follow it.
        notifyDone("Pin published to Pinterest", `Product tags didn't save: ${result.tagError}`);
      } else {
        notifyDone(
          "Pin published to Pinterest",
          result.tagsWritten > 0
            ? `${result.tagsWritten} product${result.tagsWritten === 1 ? "" : "s"} tagged`
            : undefined,
        );
      }
      navigate({ to: "/pins" });
    },
    onError: (e: Error) => notifyProblem(getFriendlyMessage(e)),
  });

  function next() {
    if (step === 1 && !imageUrl) return notifyProblem("Upload an image to continue");
    if (step === 2 && !title.trim()) {
      setTitleError("Add a title");
      titleInputRef.current?.focus();
      return notifyProblem("Add a title");
    }
    if (step === 3 && previewTags.length === 0) return notifyProblem("Attach at least one product");
    setStep((s) => (s < 4 ? ((s + 1) as Step) : s));
  }

  return (
    <AppShell
      title="Create pin"
      subtitle={STEP_LABELS[step]}
      backButton
      backTo="/pins"
      hideBottomNav
      inlineActions
      // The bulb — why fresh pins matter. Lived on the Content SEO briefing
      // sheet this page used to sit behind; the briefing is gone, so it rides
      // the app bar.
      actions={<SeoInsightButton label="Content SEO" onClick={() => setInsight(true)} />}
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

      <FlowIntroGate flow="create-pin" />

      {/* Stepper — labelled dots so each step is named, not just numbered. */}
      <div className="mx-auto mb-6 flex max-w-2xl items-start gap-2">
        {([1, 2, 3, 4] as Step[]).map((n, i) => {
          const done = step > n;
          const active = step === n;
          return (
            <div key={n} className={`flex items-start gap-2 ${i < 3 ? "flex-1" : ""}`}>
              <div className="flex flex-col items-center gap-1">
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
                <span
                  className={`text-mini font-semibold ${
                    active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {STEP_SHORT_LABELS[n]}
                </span>
              </div>
              {i < 3 && (
                <div
                  className={`mt-[15px] h-0.5 flex-1 rounded transition ${
                    done ? "bg-primary" : "bg-border"
                  }`}
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
            setBoardId={chooseBoard}
            sectionId={sectionId}
            setSectionId={setSectionId}
            boardMeta={boardMeta}
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
            plan={plan.data}
            planPending={plan.isPending}
            attachment={attachment}
            setAttachment={setAttachment}
            attachedCount={previewTags.length}
            onNext={next}
          />
        )}
        {step === 4 && (
          <StepReview
            imageUrl={imageUrl}
            title={title}
            description={description}
            storefront={activeStorefront}
            tags={previewTags}
            draftPinId={draftPinId}
            planPending={plan.isPending}
            planFailed={plan.isError}
            onRetryPlan={() => void plan.refetch()}
            boards={boards}
            boardId={boardId}
            setBoardId={chooseBoard}
            sectionId={sectionId}
            setSectionId={setSectionId}
            boardMeta={boardMeta}
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
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            {step < 4 ? (
              <button
                onClick={next}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={() => publish.mutate()}
                // Held while the backend is still deciding the products: what
                // Preview shows is what gets published, and it isn't final yet.
                disabled={publish.isPending || !boardId || plan.isPending}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98] disabled:opacity-70"
              >
                {publish.isPending || plan.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {plan.isPending ? "Finding the best products…" : "Publish to Pinterest"}
              </button>
            )}
          </div>
        </div>
      )}

      <AnimatePresence>
        {insight && <SeoInsightSheet subKey="freshness" onClose={() => setInsight(false)} />}
      </AnimatePresence>
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
  sectionId,
  setSectionId,
  boardMeta,
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
  sectionId: string;
  setSectionId: (id: string) => void;
  boardMeta: BoardMeta;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const descInputRef = useRef<HTMLTextAreaElement>(null);
  // Suggestions dismissed once the user accepts them; re-shown if they clear
  // the field again so the help is always one tap away.
  const [titleUsed, setTitleUsed] = useState(false);
  const [descUsed, setDescUsed] = useState(false);

  // The real SEO pipeline — the same six stages the Boost deck runs (subject →
  // Pinterest Trends → keyword plan → one vision call → score), just without
  // the pin row that doesn't exist yet. What it replaced was a rotation of four
  // canned suffixes over the literal anchor "Trending Picks", which is why
  // every new pin used to be offered the same copy.
  //
  // `variant` bumps on Regenerate and rotates the writing angle, so a second
  // ask is a genuinely different framing rather than the same roll again.
  const [variant, setVariant] = useState(0);
  const runDraft = useServerFn(draftPinSeo);

  // Keyed on the image, board and variant only. Title and description are sent
  // as context but deliberately kept OUT of the key: this costs a model call,
  // and re-running it on every keystroke would bill the creator for typing.
  const draft = useQuery({
    queryKey: ["pin-seo-draft", imageUrl, boardId, variant],
    queryFn: () =>
      runDraft({
        data: {
          imageUrl,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          collectionId: boardId || undefined,
          variant,
        },
      }),
    enabled: !!imageUrl,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const titleSuggestion = draft.data?.title ?? "";
  const descSuggestion = draft.data?.description ?? "";

  // Switching board re-runs the SEO draft (boardId is in the query key) with
  // the new board's context — un-dismiss the suggestion cards so the re-
  // targeted copy is actually offered, even if an earlier one was accepted.
  useEffect(() => {
    setTitleUsed(false);
    setDescUsed(false);
  }, [boardId]);

  // Only offer a suggestion when it actually improves on what's typed.
  const showTitleSug = !titleUsed && !!titleSuggestion && titleSuggestion.trim() !== title.trim();
  const showDescSug = !descUsed && !!descSuggestion && descSuggestion.trim() !== description.trim();

  return (
    <div className="space-y-6">
      {/* Hero — the pin being described stays visible on every screen size,
          with the live SEO-draft status beside it. */}
      <div className="flex items-start gap-4">
        {imageUrl && (
          <img
            key={imageUrl}
            src={imageUrl}
            alt=""
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            className={`h-28 w-[5.5rem] shrink-0 rounded-2xl object-cover opacity-0 shadow-sm ring-1 ring-border transition-opacity duration-300 ${
              imgLoaded ? "opacity-100" : ""
            }`}
          />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xl font-bold">Pin details</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            A keyword-rich title and description help Pinterest show your pin to more people.
          </p>
          {imageUrl && (
            <div className="mt-2.5">
              <SeoDraftStatus
                query={draft}
                onRegenerate={() => {
                  setVariant((v) => v + 1);
                  setTitleUsed(false);
                  setDescUsed(false);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Board FIRST — the SEO draft targets the chosen board's keywords, so
          picking it before the copy keeps title/description aligned with it.
          The review step shows the same picker, pre-filled with this choice. */}
      <BoardPicker boards={boards} boardId={boardId} setBoardId={setBoardId} meta={boardMeta} />

      {/* Section second — it only exists inside the board above, so it can't
          be offered until a board is chosen. Optional: no choice publishes to
          the board root, exactly as before sections existed. */}
      <SectionPicker boardId={boardId} sectionId={sectionId} setSectionId={setSectionId} />

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
            className={`w-full rounded-2xl border bg-background px-4 py-3.5 text-sm shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 ${
              titleError ? "border-destructive" : "border-border"
            }`}
          />
        </Field>
        {titleError && <p className="mt-1 text-xs font-medium text-destructive">{titleError}</p>}
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
            className="w-full resize-none rounded-2xl border border-border bg-background px-4 py-3.5 text-sm shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
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
    </div>
  );
}

/**
 * Visual Pinterest-board picker — every board as a cover-collage card (the
 * same look as the collection picker's grid) instead of a bare <select>, with
 * a "New board" action that creates a real board on Pinterest and selects it.
 * Used by both the details step and the review step so the choice looks the
 * same wherever it's made.
 */
function BoardPicker({
  boards,
  boardId,
  setBoardId,
  meta,
  allowChange = true,
}: {
  boards: PinterestBoard[];
  boardId: string;
  setBoardId: (id: string) => void;
  meta: BoardMeta;
  allowChange?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = boards.find((b) => b.id === boardId) ?? null;
  const selectedCover = selected ? (meta[selected.id]?.covers[0] ?? null) : null;
  const selectedCount = selected ? (meta[selected.id]?.count ?? 0) : 0;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Pinterest board</span>
      </div>

      {selected ? (
        /* Board already chosen — just show it, with one obvious way out. */
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-2.5 shadow-sm">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-surface-2 ring-1 ring-border/60">
            {selectedCover ? (
              <img
                src={selectedCover}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted-foreground/40">
                <ImageIcon className="h-5 w-5" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{selected.name}</p>
            <p className="text-mini text-muted-foreground">
              {selectedCount} pin{selectedCount === 1 ? "" : "s"} · your pin publishes here
            </p>
          </div>
          {allowChange && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="shrink-0 rounded-full border border-border px-3.5 py-2 text-xs font-bold text-primary transition hover:bg-primary/10 active:scale-[0.97]"
            >
              Change
            </button>
          )}
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-surface-2/40 px-4 py-4 text-sm font-semibold text-primary transition hover:border-primary hover:bg-primary/5"
          >
            <Plus className="h-4 w-4" /> Choose or create a board
          </button>
          {boards.length === 0 && (
            <div className="mt-2 space-y-1.5 px-0.5">
              <p className="text-xs text-muted-foreground">
                You can also sync your existing Pinterest boards from Storefront.
              </p>
              <Link
                to="/storefront"
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
              >
                Go to Storefront <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {open && (
          <BoardPickerSheet
            boards={boards}
            boardId={boardId}
            meta={meta}
            onPick={(id) => {
              setBoardId(id);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** The "change board" box — search, every board as a cover-collage card, and
 * New board as the first tile. Picking (or creating) a board closes it. */
function BoardPickerSheet({
  boards,
  boardId,
  meta,
  onPick,
  onClose,
}: {
  boards: PinterestBoard[];
  boardId: string;
  meta: BoardMeta;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const runCreateBoard = useServerFn(createPinterestBoard);

  const q = query.trim().toLowerCase();
  const visibleBoards = q ? boards.filter((b) => b.name.toLowerCase().includes(q)) : boards;

  const createBoard = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Give the board a name first");
      return runCreateBoard({ data: { name: trimmed } });
    },
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ["pinterest-boards"] });
      qc.invalidateQueries({ queryKey: ["board-pin-covers"] });
      notifyDone(`Board "${b.name}" created on Pinterest`);
      onPick(b.id);
    },
    onError: (e: Error) => notifyProblem(getFriendlyMessage(e)),
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[55] flex items-end justify-center bg-background/60 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a board"
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 40, opacity: 0.6 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-t-3xl border border-border bg-surface p-5 shadow-elevate sm:rounded-3xl"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto mb-4 h-1.5 w-10 shrink-0 rounded-full bg-border" />
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-lg font-bold">Choose a board</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Your pin will be published to this Pinterest board.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-border bg-background px-3 py-2.5 shadow-sm transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your boards"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {creating && (
          <div className="mt-3 rounded-2xl border border-border bg-background p-3.5 shadow-sm">
            <label className="text-mini font-semibold uppercase tracking-wide text-muted-foreground">
              Board name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 50))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && !createBoard.isPending)
                  createBoard.mutate();
              }}
              placeholder="e.g. Diwali outfit ideas"
              className="mt-1.5 w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1.5 text-mini text-muted-foreground">
              Creates a real board on your Pinterest account.
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setName("");
                }}
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!name.trim() || createBoard.isPending}
                onClick={() => createBoard.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-60"
              >
                {createBoard.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create board
              </button>
            </div>
          </div>
        )}

        <div className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
            <NewBoardTile
              onClick={() => {
                setCreating(true);
                // Searched for a board that doesn't exist → that search is
                // almost certainly the name they want, so start the form with it.
                if (q && visibleBoards.length === 0) setName(query.trim());
              }}
            />
            {visibleBoards.map((b) => (
              <BoardCard
                key={b.id}
                board={b}
                covers={meta[b.id]?.covers ?? []}
                count={meta[b.id]?.count ?? 0}
                selected={b.id === boardId}
                onSelect={() => onPick(b.id)}
              />
            ))}
          </div>

          {q && visibleBoards.length === 0 && boards.length > 0 && (
            <p className="mt-2.5 text-xs text-muted-foreground">
              No boards match "<span className="font-semibold">{query.trim()}</span>" — tap{" "}
              <span className="font-semibold text-primary">New board</span> to create it.
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * Section picker — the sub-folder inside the chosen board.
 *
 * Deliberately inline rather than a sheet like the board picker: a board has
 * at most a handful of sections, the choice is optional, and the whole point
 * is that "no section" stays the effortless default. Sections are read live
 * from Pinterest each time a board is selected (nothing is mirrored locally),
 * so a section the creator just made in the Pinterest app shows up here.
 */
function SectionPicker({
  boardId,
  sectionId,
  setSectionId,
}: {
  boardId: string;
  sectionId: string;
  setSectionId: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const runListSections = useServerFn(listPinterestBoardSections);
  const runCreateSection = useServerFn(createPinterestBoardSection);

  const sections = useQuery({
    queryKey: ["board-sections", boardId],
    queryFn: () => runListSections({ data: { collectionId: boardId } }),
    enabled: !!boardId,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const list: BoardSection[] = sections.data?.sections ?? [];

  // Close the inline form whenever the board changes, so switching boards
  // never leaves a half-typed section name pointed at the wrong board.
  useEffect(() => {
    setCreating(false);
    setName("");
  }, [boardId]);

  const createSection = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Give the section a name first");
      return runCreateSection({ data: { collectionId: boardId, name: trimmed } });
    },
    onSuccess: async (section) => {
      // Refetch rather than patch the cache: the create path may have returned
      // an existing same-named section, and this list is also how a section
      // made outside the app arrives.
      await sections.refetch();
      setSectionId(section.id);
      setCreating(false);
      setName("");
      notifyDone(
        section.reused
          ? `Using your existing "${section.name}" section`
          : `Section "${section.name}" created on Pinterest`,
      );
    },
    onError: (e: Error) => notifyProblem(getFriendlyMessage(e)),
  });

  // No board yet → nothing to section. The board picker's own empty state is
  // already telling the creator what to do, so stay silent here.
  if (!boardId) return null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">
          Section <span className="font-normal text-muted-foreground">· optional</span>
        </span>
        {sections.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
      </div>

      {/* A failed section fetch must not block publishing — the pin still goes
          to the board root, which is where it went before sections existed. */}
      {sections.isError ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface-2/40 px-3.5 py-3">
          <p className="text-xs text-muted-foreground">
            Couldn't load this board's sections. Your pin will publish to the board itself.
          </p>
          <button
            type="button"
            onClick={() => sections.refetch()}
            className="shrink-0 text-xs font-bold text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {/* "No section" is a real, selectable option rather than an implicit
              absence, so the board root reads as a deliberate choice. */}
          <SectionChip
            label="No section"
            icon={<Folder className="h-3.5 w-3.5" />}
            selected={!sectionId}
            onClick={() => setSectionId("")}
          />
          {list.map((section) => (
            <SectionChip
              key={section.id}
              label={section.name || "Untitled section"}
              icon={<Folder className="h-3.5 w-3.5" />}
              selected={section.id === sectionId}
              onClick={() => setSectionId(section.id)}
            />
          ))}
          {!creating && (
            <SectionChip
              label="Create new section"
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              selected={false}
              dashed
              onClick={() => setCreating(true)}
            />
          )}
        </div>
      )}

      {creating && (
        <div className="mt-2.5 rounded-2xl border border-border bg-background p-3.5 shadow-sm">
          <label className="text-mini font-semibold uppercase tracking-wide text-muted-foreground">
            Section name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 180))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !createSection.isPending)
                createSection.mutate();
              if (e.key === "Escape") {
                setCreating(false);
                setName("");
              }
            }}
            placeholder="e.g. Festive looks"
            className="mt-1.5 w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1.5 text-mini text-muted-foreground">
            Creates a real section inside this board on Pinterest, then publishes your pin into it.
          </p>
          <div className="mt-2.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setName("");
              }}
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!name.trim() || createSection.isPending}
              onClick={() => createSection.mutate()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-60"
            >
              {createSection.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create section
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One section option — same pill language as the category tabs. */
function SectionChip({
  label,
  icon,
  selected,
  dashed = false,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  dashed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold transition active:scale-[0.97] ${
        selected
          ? "bg-gradient-primary text-primary-foreground shadow-glow"
          : dashed
            ? "border-2 border-dashed border-border text-primary hover:border-primary hover:bg-primary/5"
            : "border border-border bg-surface text-foreground hover:border-primary/40 hover:bg-primary/5"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}

/** The grid's first tile — same footprint as a board card, opens the
 * create-board form. */
function NewBoardTile({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group text-left">
      <div className="grid aspect-[4/3] place-items-center rounded-2xl border-2 border-dashed border-border bg-surface-2/40 transition group-hover:border-primary group-hover:bg-primary/5">
        <div className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
          <Plus className="h-5 w-5" />
        </div>
      </div>
      <div className="px-0.5 pt-1.5">
        <p className="truncate text-xs font-semibold text-primary">New board</p>
        <p className="text-mini text-muted-foreground">On Pinterest</p>
      </div>
    </button>
  );
}

/** One board as a Pinterest-style cover collage (one big + two small pin
 * images) with its name and pin count — selected = primary ring + check. */
function BoardCard({
  board,
  covers,
  count,
  selected,
  onSelect,
}: {
  board: PinterestBoard;
  covers: string[];
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const cells = [covers[0] ?? null, covers[1] ?? null, covers[2] ?? null];
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} className="group text-left">
      <div
        className={`relative grid aspect-[4/3] grid-cols-3 grid-rows-2 gap-0.5 overflow-hidden rounded-2xl bg-surface transition ${
          selected
            ? "ring-2 ring-primary"
            : "ring-1 ring-border/60 group-hover:shadow-elevate group-hover:ring-primary/40"
        }`}
      >
        <div className="relative col-span-2 row-span-2 overflow-hidden bg-surface-2">
          {cells[0] ? (
            <img src={cells[0]} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-muted-foreground/40">
              <ImageIcon className="h-5 w-5" />
            </div>
          )}
        </div>
        {cells.slice(1).map((src, i) => (
          <div key={i} className="relative overflow-hidden bg-surface-2">
            {src ? (
              <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted-foreground/30">
                <ImageIcon className="h-3.5 w-3.5" />
              </div>
            )}
          </div>
        ))}
        {selected && (
          <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="px-0.5 pt-1.5">
        <p className={`truncate text-xs font-semibold ${selected ? "text-primary" : ""}`}>
          {board.name}
        </p>
        <p className="text-mini text-muted-foreground">
          {count} pin{count === 1 ? "" : "s"}
        </p>
      </div>
    </button>
  );
}

/** The draft run's own state: what it's doing, what it targeted, how to ask
 * again. This exists because the copy below it is no longer free or instant —
 * it is a real keyword-planned model call, and a creator who can't see that is
 * left staring at two empty fields wondering if the app is broken. Showing the
 * keyword it aimed at is the same evidence the Boost deck gives before asking
 * anyone to accept a rewrite. */
function SeoDraftStatus({
  query,
  onRegenerate,
}: {
  query: UseQueryResult<DraftSeoResult>;
  onRegenerate: () => void;
}) {
  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2.5">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <p className="text-xs font-medium text-foreground/80">
          Writing SEO copy from your image and Pinterest Trends…
        </p>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
        <p className="min-w-0 flex-1 text-xs font-medium text-amber-700">
          Couldn't write SEO copy. You can still write your own.
        </p>
        <button
          type="button"
          onClick={onRegenerate}
          className="shrink-0 rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  const kw = query.data?.keywords;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <Sparkles className="h-4 w-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {kw?.primary ? (
          <>
            Targeting <span className="font-semibold text-foreground">{kw.primary}</span>
            {kw.secondary.length > 0 && ` +${kw.secondary.length} supporting`}
            {kw.hasTrendData && ` · live ${kw.country} trends`}
          </>
        ) : (
          "SEO copy ready"
        )}
      </p>
      <button
        type="button"
        onClick={onRegenerate}
        className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
      >
        Regenerate
      </button>
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
        <p className="text-mini font-semibold uppercase tracking-wide text-primary">
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
  plan,
  planPending,
  attachment,
  setAttachment,
  attachedCount,
  onNext,
}: {
  imageUrl: string;
  title: string;
  description: string;
  storefronts: Storefront[];
  preferredStorefrontId: string;
  products: Product[];
  plan: ProductTagPlan | undefined;
  planPending: boolean;
  attachment: AttachmentState;
  setAttachment: React.Dispatch<React.SetStateAction<AttachmentState>>;
  attachedCount: number;
  onNext: () => void;
}) {
  const [manualUrl, setManualUrl] = useState("");
  const [productUrlError, setProductUrlError] = useState<string | null>(null);
  const manualUrlInputRef = useRef<HTMLInputElement>(null);

  // Attach-flow UI state — mirrors the single-pin attach dialog exactly.
  // Manual entry lives in the "Add more" sheet, never inline on the page;
  // `showCollection` swaps in the full-screen Add-from-Collection flow.
  const [showAddMore, setShowAddMore] = useState(false);
  const [showCollection, setShowCollection] = useState(false);
  // Active product-tag tab (null = "All").
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Scroll-linked morph: the big pin preview shrinks/fades/lifts out of the
  // way as the results scroll down, and expands back on scroll up. This page
  // scrolls the window (no modal container), so no ref is passed.
  const morph = useScrollMorph(undefined, { heroMaxHeight: 208 });

  // Streamed in two stages — see useVisualSearch. The product pills land in
  // ~6s; each pill's grid fills on its own after that, so the wizard shows
  // what it found in the image long before it has finished pricing it.
  const {
    tabs,
    components,
    matches: suggestions,
    isDetecting,
    isLoading: aiLoading,
    isRefining,
    detectionFailed,
  } = useVisualSearch({ imageUrl, title, description, enabled: !!imageUrl });

  // Detection lifecycle events, through the app's existing pipeline log.
  const detectingRef = useRef(false);
  useEffect(() => {
    if (isDetecting && !detectingRef.current) {
      detectingRef.current = true;
      logPipeline("product_detection_started", {});
    } else if (!isDetecting && detectingRef.current) {
      detectingRef.current = false;
      logPipeline(detectionFailed ? "product_match_failed" : "product_detection_completed", {
        objects: components.length,
      });
    }
  }, [isDetecting, detectionFailed, components.length]);

  useEffect(() => {
    setActiveTag(null);
  }, [imageUrl]);

  // Full-screen scan experience shown while the visual search runs — same as
  // the attach-products dialog, and now on the same timing (see useScanPhase).
  const firstTabReady = tabs.some((t) => !t.loading);
  const { phase: scanPhase, dismiss: dismissScan } = useScanPhase({
    searching: isDetecting,
    hasResults: tabs.some((t) => !!t.label) || suggestions.length > 0,
    productsReady: firstTabReady,
    active: !!imageUrl,
  });

  // What's attached right now, derived exactly as Preview derives it, so a
  // checkmark here IS a card in Shop the look.
  const attached = useMemo(
    () => composeAttachedTags(plan, attachment, products),
    [plan, attachment, products],
  );
  const attachedLinks = useMemo(() => attachedLinkSet(attached), [attached]);
  const attachedProductIds = useMemo(
    () => new Set(attached.map((t) => t.productId).filter((id): id is string => !!id)),
    [attached],
  );
  const isSelected = (link: string) => attachedLinks.has(canonicalTagLink(link));

  // The backend's rank for each candidate — the grid's order under "All".
  const rankByLink = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of plan?.ranked ?? []) m.set(canonicalTagLink(t.match.link), t.rank);
    return m;
  }, [plan]);

  // The single best earning rate across the matched retailers — headlines the
  // results ("earn up to Y% per sale") so the value is obvious at a glance.
  const topCommission = suggestions.length
    ? Math.max(...suggestions.map((s) => estimateCommissionPct(s.source)))
    : 0;

  // Product-tag tabs, one per detected component, in prominence order.
  const tagByLink = useMemo(
    () => new Map(suggestions.map((s) => [s.link, s.tag] as const)),
    [suggestions],
  );
  const namedTabs = useMemo(
    () => tabs.filter((t) => !!t.label && (t.loading || t.matches.length > 0)),
    [tabs],
  );
  const tabLabels = useMemo(() => [...new Set(namedTabs.map((t) => t.label))], [namedTabs]);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of namedTabs) m.set(t.label, (m.get(t.label) ?? 0) + t.matches.length);
    return m;
  }, [namedTabs]);
  const tagLoading = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const t of namedTabs) m.set(t.label, (m.get(t.label) ?? false) || t.loading);
    return m;
  }, [namedTabs]);
  const pendingCardCount = activeTag
    ? tagLoading.get(activeTag)
      ? 3
      : 0
    : Math.min(6, namedTabs.filter((t) => t.loading).length * 3);
  useEffect(() => {
    if (activeTag && !tabLabels.includes(activeTag)) setActiveTag(null);
  }, [activeTag, tabLabels]);

  // "All" is the canonical sequence: the backend's ranked order — each
  // object's top three as a block, then the remainder interleaved tier by
  // tier (see selectProductTags) — then whatever the backend hasn't ranked
  // yet in the order it streamed in. A single object's tab keeps the pipeline
  // order.
  const orderedLinks = useMemo(() => {
    const links = suggestions.map((s) => s.link);
    if (activeTag) return links.filter((l) => tagByLink.get(l) === activeTag);
    return [...links]
      .map((l, i) => ({ l, i, r: rankByLink.get(canonicalTagLink(l)) ?? Infinity }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.l);
  }, [suggestions, activeTag, tagByLink, rankByLink]);

  // Products offered by the Add-from-Collection flow — same storefront rule
  // as the attach dialog.
  const storeProducts = useMemo(
    () =>
      products.filter((p) => !preferredStorefrontId || p.storefront_id === preferredStorefrontId),
    [products, preferredStorefrontId],
  );

  const handleSuggestionSettled = (link: string, details: CkResult) => {
    setAttachment((a) => {
      if (a.confirmedByLink.has(link)) return a;
      const next = new Map(a.confirmedByLink);
      next.set(link, details);
      return { ...a, confirmedByLink: next };
    });
  };

  const overLimit = () =>
    notifyProblem(
      `You can attach up to ${MAX_PRODUCT_TAGS_PER_PIN} products to a Pin`,
      "Remove one to add another.",
    );

  /** Tapping a card attaches it (or detaches it) — a plain product pick. */
  const toggleAI = (link: string) => {
    const on = isSelected(link);
    if (!on && attached.length >= MAX_PRODUCT_TAGS_PER_PIN) return overLimit();
    const match = suggestions.find((m) => m.link === link);
    if (!match) return;
    const key = canonicalTagLink(link);
    setAttachment((a) => {
      const overrides = new Map(a.overrides);
      overrides.set(link, { selected: !on, match });
      // Turning a listing off turns it off however it was attached.
      return on
        ? {
            ...a,
            overrides,
            pasted: a.pasted.filter((t) => canonicalTagLink(t.link) !== key),
            productIds: a.productIds.filter(
              (id) =>
                canonicalTagLink(products.find((p) => p.id === id)?.affiliate_url ?? "") !== key,
            ),
          }
        : { ...a, overrides };
    });
    logPipeline(on ? "product_tag_removed" : "product_tag_added", { source: "match" });
  };

  const toggleCollectionProduct = (id: string) => {
    const on = attachedProductIds.has(id);
    if (!on && attached.length >= MAX_PRODUCT_TAGS_PER_PIN) return overLimit();
    setAttachment((a) => ({
      ...a,
      productIds: on ? a.productIds.filter((x) => x !== id) : [...a.productIds, id],
    }));
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setManualUrl(text.trim());
      else notifyProblem("Clipboard is empty");
    } catch {
      notifyProblem("Couldn't read clipboard — paste manually");
    }
  };

  // A pasted link is attached now and becomes a product row at publish (the
  // server creates it, reusing an existing row with the same URL). Nothing is
  // written for a wizard the creator abandons.
  const addPastedLink = () => {
    const url = manualUrl.trim();
    if (!url) return setProductUrlError("Paste a product link first");
    let host: string;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error("bad scheme");
      host = u.hostname.replace(/^www\./, "");
    } catch {
      setProductUrlError("That doesn't look like a valid URL");
      manualUrlInputRef.current?.focus();
      return;
    }
    if (!(preferredStorefrontId || storefronts[0]?.id)) {
      notifyProblem("Create a storefront first.");
      return;
    }
    if (attachedLinks.has(canonicalTagLink(url))) {
      setManualUrl("");
      notifyDone("Already attached");
      return;
    }
    if (attached.length >= MAX_PRODUCT_TAGS_PER_PIN) return overLimit();
    const own = products.find((p) => canonicalTagLink(p.affiliate_url) === canonicalTagLink(url));
    setAttachment((a) =>
      own
        ? { ...a, productIds: [...a.productIds, own.id] }
        : {
            ...a,
            pasted: [
              ...a.pasted,
              tagFromUrl(url, title ? `${title} — ${host}` : host, imageUrl || null),
            ],
          },
    );
    setManualUrl("");
    setProductUrlError(null);
    notifyDone(own ? "Already in Your products — attached" : "Product attached");
    logPipeline("product_tag_added", { source: own ? "collection" : "url" });
  };

  return (
    <>
      {/* Full-screen scan overlay while the visual search runs. */}
      <AnimatePresence>
        {scanPhase && (
          <PinScanOverlay
            imageUrl={imageUrl || null}
            phase={scanPhase}
            found={tabs.map((t) => t.label).filter(Boolean)}
            onContinue={() => {
              // No matches → land on the step with the Add-more sheet already
              // open so they can paste a link or pick from a collection.
              dismissScan();
              setShowAddMore(true);
            }}
            onSkip={() => {
              dismissScan();
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
          <span className="truncate text-micro font-semibold uppercase tracking-wide text-primary">
            {aiLoading && suggestions.length === 0 ? "Scanning pin…" : "Visual match"}
          </span>
        </motion.div>

        {imageUrl && (
          <motion.div
            style={{ height: morph.heroHeight, opacity: morph.heroOpacity }}
            className="flex items-start justify-center overflow-hidden"
          >
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
        {isDetecting ? (
          <div className="mt-6">
            <EducationalLoader label="Finding products in your image…" hints={HINTS.createScan} />
          </div>
        ) : suggestions.length === 0 && !aiLoading ? (
          <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface-2/40 p-6 text-center">
            <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-amber-500/10 text-amber-600">
              <Sparkles className="h-5 w-5" />
            </span>
            <p className="mt-3 text-sm font-semibold">
              We couldn't identify any products in this Pin
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tap <span className="font-semibold text-primary">Add more</span> below to paste a link
              or pick from a collection.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-6 text-center">
              <h5 className="font-display text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                {aiLoading && namedTabs.length > 0
                  ? `Found ${namedTabs.length} item${namedTabs.length === 1 ? "" : "s"} in your pin`
                  : `Found ${suggestions.length} product${suggestions.length === 1 ? "" : "s"}`}
              </h5>
              <p className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5 text-base font-medium text-muted-foreground">
                {aiLoading && suggestions.length === 0 ? (
                  "Matching them to stores…"
                ) : (
                  <>
                    Earn upto
                    <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-3 py-0.5 text-base font-extrabold text-emerald-600">
                      {topCommission}%
                    </span>
                    per sale
                  </>
                )}
              </p>
              {/* The backend is choosing which products to attach by default —
                  said plainly, so unchecked cards read as "not decided yet"
                  rather than "nothing matched". */}
              {(isRefining || planPending) && suggestions.length > 0 ? (
                <p className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground/70">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {planPending ? "Choosing the best matches…" : "Checking each match…"}
                </p>
              ) : plan && plan.tags.length > 0 ? (
                <p className="mt-1 text-xs font-medium text-muted-foreground/70">
                  {plan.tags.length} best match{plan.tags.length === 1 ? "" : "es"} attached — tap
                  any card to change
                </p>
              ) : null}
            </div>

            {tabLabels.length >= 1 && (
              <div className="no-scrollbar mt-4 -mx-1 flex items-center gap-2 overflow-x-auto px-1">
                <TagTab
                  label="All"
                  count={suggestions.length}
                  pending={aiLoading}
                  active={activeTag === null}
                  onClick={() => setActiveTag(null)}
                />
                {tabLabels.map((t) => (
                  <TagTab
                    key={t}
                    label={t}
                    count={tagCounts.get(t) ?? 0}
                    pending={tagLoading.get(t) ?? false}
                    active={activeTag === t}
                    onClick={() => setActiveTag(t)}
                  />
                ))}
              </div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {orderedLinks.map((link) => {
                const s = suggestions.find((m) => m.link === link);
                if (!s) return null;
                return (
                  <ProgressiveSuggestionCard
                    key={link}
                    match={s}
                    selected={isSelected(link)}
                    onToggle={() => toggleAI(link)}
                    onSettled={handleSuggestionSettled}
                  />
                );
              })}
              {Array.from({ length: pendingCardCount }).map((_, i) => (
                <SuggestionCardSkeleton key={`skeleton-${i}`} />
              ))}
            </div>
          </>
        )}

        {/* Products attached by hand — pasted links and collection picks —
            join the grid below the matches. */}
        {(attachment.pasted.length > 0 || attachment.productIds.length > 0) && (
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {attachment.productIds.map((id) => {
              const p = products.find((x) => x.id === id);
              if (!p) return null;
              return (
                <SuggestionCard
                  key={p.id}
                  title={p.title}
                  thumbnail={p.image_url}
                  source={hostBrand(p.affiliate_url)}
                  link={p.affiliate_url}
                  price={realProductPrice(p.price_cents)}
                  commissionPct={p.commission_pct}
                  selected={attachedProductIds.has(p.id)}
                  onToggle={() => toggleCollectionProduct(p.id)}
                />
              );
            })}
            {attachment.pasted.map((t) => (
              <SuggestionCard
                key={t.key}
                title={t.title}
                thumbnail={t.thumbnail}
                source={t.retailer}
                link={t.link}
                price={t.price}
                selected={isSelected(t.link)}
                onToggle={() =>
                  setAttachment((a) => ({ ...a, pasted: a.pasted.filter((x) => x.key !== t.key) }))
                }
              />
            ))}
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
            Next{attachedCount > 0 ? ` (${attachedCount})` : ""} <ArrowRight className="h-4 w-4" />
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
              {manualUrl.trim() && (
                <button
                  type="button"
                  onClick={addPastedLink}
                  className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
                >
                  <Plus className="h-4 w-4" />
                  Add link
                </button>
              )}

              <div className="my-4 flex items-center gap-3 text-mini font-semibold uppercase tracking-wide text-muted-foreground/70">
                <span className="h-px flex-1 bg-border" /> or{" "}
                <span className="h-px flex-1 bg-border" />
              </div>

              <AddFromCollectionButton onClick={() => setShowCollection(true)} />

              {showCollection && (
                <CollectionAddFlow
                  products={storeProducts}
                  pickedIds={attachedProductIds}
                  onTogglePicked={toggleCollectionProduct}
                  onExit={() => setShowCollection(false)}
                />
              )}

              <button
                type="button"
                onClick={() => {
                  setShowAddMore(false);
                  onNext();
                }}
                className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98]"
              >
                Continue{attachedCount > 0 ? ` (${attachedCount})` : ""}
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
  tags,
  draftPinId,
  planPending,
  planFailed,
  onRetryPlan,
  boards,
  boardId,
  setBoardId,
  sectionId,
  setSectionId,
  boardMeta,
}: {
  imageUrl: string;
  title: string;
  description: string;
  storefront: Storefront | undefined;
  /** The canonical sequence — what Publish will persist. */
  tags: PendingProductTag[];
  draftPinId: string;
  planPending: boolean;
  planFailed: boolean;
  onRetryPlan: () => void;
  boards: PinterestBoard[];
  boardId: string;
  setBoardId: (id: string) => void;
  sectionId: string;
  setSectionId: (id: string) => void;
  boardMeta: BoardMeta;
}) {
  // Where a shopper lands from the pin: this pin's own storefront collection,
  // which Publish creates under a slug derived from the pin id — so the URL
  // shown here is the one the real pin will carry. No products → the
  // storefront itself.
  const websiteUrl =
    storefront && typeof window !== "undefined"
      ? tags.length > 0
        ? pinCollectionUrl(
            window.location.origin,
            storefront.slug,
            pinCollectionSlug(title.trim() || "Untitled pin", draftPinId),
          )
        : `${window.location.origin}/s/${storefront.slug}`
      : null;
  return (
    <div className="space-y-5">
      <h2 className="font-display text-xl font-bold">Ready to publish</h2>

      <BoardPicker
        boards={boards}
        boardId={boardId}
        setBoardId={setBoardId}
        meta={boardMeta}
        allowChange={false}
      />

      {/* Still changeable here — the board is locked on review but the section
          is a one-tap choice that's easy to reconsider at the last moment. */}
      <SectionPicker boardId={boardId} sectionId={sectionId} setSectionId={setSectionId} />

      {/* The buyer's view — the pin as a shopper will see it, with Shop the
          look in the sequence the backend decided. */}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          How shoppers will see it
        </div>
        <ShopTheLookPreview
          imageUrl={imageUrl}
          title={title}
          description={description}
          creatorName={storefront?.name}
          products={tags}
          websiteUrl={websiteUrl}
          loading={planPending}
          failed={planFailed}
          onRetry={onRetryPlan}
        />
      </div>
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
        {hint && <span className="text-mini text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
