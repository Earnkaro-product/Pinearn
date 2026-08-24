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
  Store,
  Link2,
  Plus,
  X,
  ClipboardPaste,
  ArrowRight,
  Grip,
  Image as ImageIcon,
  Search,
} from "lucide-react";
import { AnimatePresence, motion, Reorder } from "framer-motion";
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
import { EducationalLoader, HINTS } from "@/components/rotating-hint";
import { useVisualSearch } from "@/hooks/use-visual-search";
import { AppShell } from "@/components/app-shell";
import { SeoInsightButton, SeoInsightSheet } from "@/components/seo-insight";
import { FlowIntroGate } from "@/components/flow-intro";
import { supabase } from "@/integrations/supabase/client";
import { hostBrand, estimateCommissionPct } from "@/lib/brands";
import { getFriendlyMessage } from "@/lib/friendly-error";
import { PinterestConnectPanel } from "@/components/pinterest-gate";
import { usePinterestConnection } from "@/hooks/use-pinterest-connect";
import {
  createPinterestBoard,
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
      notifyDone("Pin published to Pinterest");
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
    if (step === 3 && selectedProductIds.length === 0)
      return notifyProblem("Pick at least one product");
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
            setBoardId={setBoardId}
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
                disabled={publish.isPending || !boardId}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-4 py-3.5 text-sm font-bold text-primary-foreground shadow-glow transition active:scale-[0.98] disabled:opacity-70"
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
  // Active product-tag tab only; category pills removed in favor of live filters.
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

  // Streamed in two stages — see useVisualSearch. The product pills land in
  // ~6s; each pill's grid fills on its own after that, so the wizard shows
  // what it found in the image long before it has finished pricing it.
  const {
    tabs,
    matches: suggestions,
    isDetecting,
    isLoading: aiLoading,
  } = useVisualSearch({ imageUrl, title, description, enabled: !!imageUrl });

  // Progressive rendering: `suggestions` paints immediately (image/title/
  // source + Lens price, no CK wait); each card resolves its live price/stock
  // independently via ProgressiveSuggestionCard. `confirmedByLink` records
  // each match's outcome the instant it settles — never present = still
  // resolving, `null` = no price from CK or Lens at all (rare).
  const [confirmedByLink, setConfirmedByLink] = useState<Map<string, CkResult>>(new Map());

  // Reset AI selection tracking when a fresh IMAGE is searched. Keyed on the
  // image rather than on the results: results now arrive in pieces as each
  // pill lands, and resetting on every piece would clear the user's picks
  // under them mid-scan.
  useEffect(() => {
    setAiProductIds({});
    setConfirmedByLink(new Map());
    insertingLinksRef.current = new Set();
    setAiOrder([]);
    setActiveTag(null);
  }, [imageUrl]);

  // Full-screen scan experience shown while the visual search runs — same as
  // the attach-products dialog, and now on the same timing (see useScanPhase).
  //
  // It waits for DETECTION, then briefly for the first tab's products — long
  // enough that the reveal lands on real cards instead of skeletons, capped so
  // a slow pin never traps anyone (see useScanPhase). The remaining grids fill
  // in underneath as their searches return. No image yet = no overlay.
  // A named component is a result in itself — it becomes a tab. The untagged
  // whole-image fallback has no label, so there it takes an actual match to
  // count, which is what keeps a pin with nothing to sell out of the "found"
  // ending and in the empty state that offers a manual link.
  const firstTabReady = tabs.some((t) => !t.loading);
  const { phase: scanPhase, dismiss: dismissScan } = useScanPhase({
    searching: isDetecting,
    hasResults: tabs.some((t) => !!t.label) || suggestions.length > 0,
    productsReady: firstTabReady,
    active: !!imageUrl,
  });

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

  // Product-tag tabs, one per detected component, in prominence order. Taken
  // from `tabs` (detection) rather than from the matches, so a pill shows the
  // moment it is named and carries a spinner until its own search lands.
  const tagByLink = useMemo(
    () => new Map(suggestions.map((s) => [s.link, s.tag] as const)),
    [suggestions],
  );
  // A pill earns its place by having something to show. It appears while its
  // search is running (that's the point — the user sees what was found in the
  // pin immediately) and is withdrawn if that search settles empty, because a
  // tab that opens onto nothing is worse than a tab that was never offered.
  const namedTabs = useMemo(
    () => tabs.filter((t) => !!t.label && (t.loading || t.matches.length > 0)),
    [tabs],
  );
  const tags = useMemo(() => [...new Set(namedTabs.map((t) => t.label))], [namedTabs]);
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
  // Keep the active tab valid as results change.
  useEffect(() => {
    if (activeTag && !tags.includes(activeTag)) setActiveTag(null);
  }, [activeTag, tags]);

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
      else notifyProblem("Clipboard is empty");
    } catch {
      notifyProblem("Couldn't read clipboard — paste manually");
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
      notifyProblem("Create a storefront first.");
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
      notifyProblem(getFriendlyMessage(e));
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
      notifyDone(duplicate ? "Already in Your products — selected" : "Added to Your products");
    },
    onError: (e: Error) => {
      notifyProblem(getFriendlyMessage(e));
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
        {isDetecting ? (
          <div className="mt-6">
            <EducationalLoader label="Finding products in your image…" hints={HINTS.createScan} />
          </div>
        ) : suggestions.length === 0 && !aiLoading ? (
          <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface-2/40 p-6 text-center">
            <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-amber-500/10 text-amber-600">
              <Sparkles className="h-5 w-5" />
            </span>
            <p className="mt-3 text-sm font-semibold">No matching products found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tap <span className="font-semibold text-primary">Add more</span> below to paste a link
              or pick from a collection.
            </p>
          </div>
        ) : (
          <>
            {/* Earnings-led header — centred and prominent. While the pills are
                still filling it names what was FOUND IN THE PIN, which is
                already known and doesn't churn as each search lands; a bare
                "Found 0 products" during that window would just look wrong. */}
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
            </div>

            {/* Category pills removed — use live filtering instead. */}

            {/* Product-tag tabs — one per detected component. Below the pin,
                above the products. Shown whenever detection named at least one
                component — a single category still gets "All" + its own pill. */}
            {tags.length >= 1 && (
              <div className="no-scrollbar mt-4 -mx-1 flex items-center gap-2 overflow-x-auto px-1">
                <TagTab
                  label="All"
                  count={suggestions.length}
                  pending={aiLoading}
                  active={activeTag === null}
                  onClick={() => setActiveTag(null)}
                />
                {tags.map((t) => (
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
                {Array.from({ length: pendingCardCount }).map((_, i) => (
                  <SuggestionCardSkeleton key={`skeleton-${i}`} />
                ))}
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
                {Array.from({ length: pendingCardCount }).map((_, i) => (
                  <SuggestionCardSkeleton key={`skeleton-${i}`} />
                ))}
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
              <div className="my-4 flex items-center gap-3 text-mini font-semibold uppercase tracking-wide text-muted-foreground/70">
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
                              <img
                                src={p.image_url}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="grid h-full w-full place-items-center text-muted-foreground">
                                <ImageIcon className="h-4 w-4" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-micro font-bold uppercase tracking-wide text-muted-foreground">
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
                                <span className="text-mini font-bold text-emerald-600">
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
  boardMeta,
}: {
  imageUrl: string;
  title: string;
  description: string;
  storefront: Storefront | undefined;
  products: Product[];
  boards: PinterestBoard[];
  boardId: string;
  setBoardId: (id: string) => void;
  boardMeta: BoardMeta;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
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
        {hint && <span className="text-mini text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
