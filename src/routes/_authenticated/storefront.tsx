import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Trash2,
  Loader2,
  FolderPlus,
  Image as ImageIcon,
  Pencil,
  ExternalLink,
  Copy,
  Sparkles,
  Layers,
  Plus,
  Check,
  Camera,
  ArrowRightLeft,
  Share2,
  MessageCircle,
  Mail,
  Send,
  Facebook,
  Twitter,
  GripVertical,
  X,
  Link2,
  ClipboardPaste,
} from "lucide-react";
import { Reorder, motion } from "framer-motion";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { takeDownCollection } from "@/lib/pinterest.functions";
import { fetchLinkPreviews } from "@/lib/link-preview.functions";
import { syncPinterestAccount } from "@/lib/pinterest-sync.functions";
import { usePinterestSync } from "@/hooks/use-pinterest-sync";
import { PinterestSyncModal } from "@/components/pinterest-sync-modal";
import { SuggestionCard, realProductPrice } from "@/components/suggestion-card";
import {
  CollectionAddFlow,
  AddFromCollectionButton,
  type PickableProduct,
} from "@/components/collection-picker";
import { hostBrand } from "@/lib/brands";

const DEFAULT_BACKGROUND =
  "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1600&q=80&auto=format&fit=crop";

type StorefrontSearch = { collection?: string; edit?: 1; new?: 1 };

export const Route = createFileRoute("/_authenticated/storefront")({
  component: StorefrontPage,
  validateSearch: (search: Record<string, unknown>): StorefrontSearch => ({
    collection: typeof search.collection === "string" ? search.collection : undefined,
    // The Health Score "Complete Profile" action deep-links here to fill the
    // bio/website — auto-opens the edit-store dialog.
    edit: search.edit === 1 || search.edit === "1" ? 1 : undefined,
    // The dashboard's "New collection" quick action deep-links here. Collection
    // creation has no route of its own — it is a dialog on this page — so the
    // link opens the page with the dialog already up rather than landing the
    // creator on the storefront to hunt for the button.
    new: search.new === 1 || search.new === "1" ? 1 : undefined,
  }),
});

type Storefront = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  brand_color: string | null;
  background_image_url: string | null;
};

type Collection = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  cover_color: string | null;
  cover_image_url: string | null;
  source: string;
  position: number;
};

type Pin = {
  id: string;
  title: string;
  image_url: string | null;
  collection_id: string | null;
  external_url: string | null;
  product_id: string | null;
  status: string;
};

type Board = {
  id: string;
  name: string;
  cover_image_url: string | null;
  position: number;
};

type BoardCollection = { board_id: string; collection_id: string };

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "board"
  );
}

async function uploadCover(file: File, folder: string): Promise<string> {
  const { data: userRes } = await supabase.auth.getUser();
  if (!userRes.user) throw new Error("Not signed in");
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${userRes.user.id}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from("storefront-covers")
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  const { data: signed, error: signErr } = await supabase.storage
    .from("storefront-covers")
    .createSignedUrl(path, 60 * 60 * 24 * 365 * 10);
  if (signErr || !signed) throw signErr ?? new Error("Failed to sign URL");
  return signed.signedUrl;
}

function StorefrontPage() {
  const qc = useQueryClient();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [tab, setTab] = useState<"collections" | "boards">("collections");
  const [reorderOpen, setReorderOpen] = useState(false);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [showEditStore, setShowEditStore] = useState(false);
  const [coverPickerFor, setCoverPickerFor] = useState<string | null>(null);
  const [viewCollectionFor, setViewCollectionFor] = useState<string | null>(
    search.collection ?? null,
  );
  const [viewBoardFor, setViewBoardFor] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const bgInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (search.collection) setViewCollectionFor(search.collection);
  }, [search.collection]);

  // Deep-linked from the Health Score: open the edit dialog immediately.
  useEffect(() => {
    if (search.edit) setShowEditStore(true);
  }, [search.edit]);

  // Deep-linked from the dashboard's "New collection" quick action. The param
  // is cleared as it opens so a back-navigation or refresh doesn't reopen a
  // dialog the creator already dismissed.
  useEffect(() => {
    if (!search.new) return;
    setTab("collections");
    setShowNewCollection(true);
    void navigate({ search: (s) => ({ ...s, new: undefined }), replace: true });
  }, [search.new, navigate]);

  // The unified reconcile — same call the connect flow and the auto-sync use, so
  // "Sync boards & pins" here can't drift from what happens elsewhere.
  const importBoards = useServerFn(syncPinterestAccount);
  const { invalidateAll: invalidatePinterestData } = usePinterestSync();

  const { data: profile } = useQuery({
    queryKey: ["me-profile"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("id,avatar_url,display_name")
        .eq("id", userRes.user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: storefront, isLoading: sfLoading } = useQuery({
    queryKey: ["my-storefront"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) return null;
      const { data, error } = await supabase
        .from("storefronts")
        .select("id,name,slug,description,brand_color,background_image_url")
        .eq("user_id", userRes.user.id)
        .order("is_default", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Storefront | null;
    },
  });

  const { data: collections = [] } = useQuery({
    queryKey: ["collections", storefront?.id],
    enabled: !!storefront,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("collections")
        .select("id,name,slug,description,cover_color,cover_image_url,source,position")
        .eq("storefront_id", storefront!.id)
        .is("hidden_from_storefront_at", null)
        .order("position", { ascending: true });
      if (error) throw error;
      return data as Collection[];
    },
  });

  const { data: pins = [] } = useQuery({
    queryKey: ["storefront-pins", storefront?.id],
    enabled: !!storefront,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pins")
        .select("id,title,image_url,collection_id,external_url,product_id,status")
        .eq("storefront_id", storefront!.id)
        .eq("is_owner", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Pin[];
    },
  });

  // Products attached to collections directly (pasted links, monetized
  // pins). Link-only collections have no pins at all, so both the grid
  // filter and the card cover/count need these.
  const { data: storefrontProducts = [] } = useQuery({
    queryKey: ["storefront-products", storefront?.id],
    enabled: !!storefront,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("storefront_products")
        .select("id,collection_id,image_url")
        .eq("storefront_id", storefront!.id)
        .not("collection_id", "is", null)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as { id: string; collection_id: string | null; image_url: string | null }[];
    },
  });

  const { data: boards = [] } = useQuery({
    queryKey: ["boards", storefront?.id],
    enabled: !!storefront,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("boards")
        .select("id,name,cover_image_url,position")
        .eq("storefront_id", storefront!.id)
        .is("hidden_from_storefront_at", null)
        .order("position", { ascending: true });
      if (error) throw error;
      return data as Board[];
    },
  });

  const boardIds = useMemo(() => boards.map((b) => b.id), [boards]);

  const { data: boardCollections = [] } = useQuery({
    queryKey: ["board-collections", storefront?.id, boardIds.join(",")],
    enabled: !!storefront && boardIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("board_collections")
        .select("board_id,collection_id")
        .in("board_id", boardIds);
      if (error) throw error;
      return data as BoardCollection[];
    },
  });

  const runImport = useMutation({
    mutationFn: async () => importBoards({ data: { analytics: false } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["collections", storefront?.id] });
      qc.invalidateQueries({ queryKey: ["storefront-pins", storefront?.id] });
      invalidatePinterestData();
      if (!r.ok) {
        toast.error(r.needsReconnect ? "Pinterest needs reconnecting" : (r.error ?? "Sync failed"));
        return;
      }
      // A re-sync now also pulls edits and deletions, not just new boards, so the
      // "already up to date" case is genuinely nothing-changed rather than
      // nothing-new.
      const created = r.boards.created + r.pins.created;
      const changed = r.boards.updated + r.pins.updated + r.pins.rehomed + r.pins.removed;
      if (created === 0 && changed === 0) {
        toast("Your store is already up to date");
      } else if (created > 0) {
        toast.success(`Imported ${r.boards.created} boards, ${r.pins.created} pins`);
      } else {
        toast.success(`Updated ${changed} ${changed === 1 ? "item" : "items"} from Pinterest`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const startSync = () => {
    setSyncOpen(true);
    runImport.reset();
    runImport.mutate();
  };

  const runFetchLinkPreviews = useServerFn(fetchLinkPreviews);
  const createCollection = useMutation({
    mutationFn: async (p: {
      name: string;
      coverFile: File | null;
      links: string[];
      products: PickableProduct[];
      linkImages?: (string | null)[];
    }) => {
      const { data: userRes } = await supabase.auth.getUser();
      let coverUrl: string | null = null;
      if (p.coverFile) coverUrl = await uploadCover(p.coverFile, "collections");

      // Each link's og:image, best-effort — the products get their own
      // pictures, and with no uploaded cover the first product's picture
      // becomes the collection cover. The dialog already fetched previews to
      // show the default cover, so reuse them instead of fetching twice.
      let linkImages: (string | null)[] = p.links.map(() => null);
      if (p.links.length > 0) {
        if (p.linkImages && p.linkImages.length === p.links.length) {
          linkImages = p.linkImages;
        } else {
          try {
            const res = await runFetchLinkPreviews({ data: { urls: p.links } });
            linkImages = res.images;
          } catch {
            /* previews are a bonus — create the collection regardless */
          }
        }
      }
      if (!coverUrl) {
        coverUrl =
          linkImages.find((img): img is string => !!img) ??
          p.products.find((pr) => pr.image_url)?.image_url ??
          null;
      }

      const topPos =
        collections.length > 0 ? Math.min(...collections.map((c) => c.position)) - 1 : 0;
      const { data: inserted, error } = await supabase
        .from("collections")
        .insert({
          user_id: userRes.user!.id,
          storefront_id: storefront!.id,
          name: p.name,
          slug: `${slugify(p.name)}-${Math.random().toString(36).slice(2, 5)}`,
          source: "manual",
          position: topPos, // new items appear on top
          cover_image_url: coverUrl,
        })
        .select("id")
        .single();
      if (error) throw error;

      const linkRows = p.links.map((url, i) => {
        let hostname = "New product";
        try {
          hostname = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          /* keep default */
        }
        return {
          user_id: userRes.user!.id,
          storefront_id: storefront!.id,
          collection_id: inserted.id,
          title: `${p.name} — ${hostname}`,
          affiliate_url: url,
          image_url: linkImages[i] ?? coverUrl,
        };
      });
      // Products picked from existing collections are COPIED — a product row
      // belongs to exactly one collection, so re-pointing it would silently
      // pull it out of the collection it lives in.
      const copiedRows = p.products.map((pr) => ({
        user_id: userRes.user!.id,
        storefront_id: storefront!.id,
        collection_id: inserted.id,
        title: pr.title,
        affiliate_url: pr.affiliate_url,
        image_url: pr.image_url,
        price_cents: pr.price_cents,
        commission_pct: pr.commission_pct,
      }));
      const rows = [...linkRows, ...copiedRows];
      if (rows.length > 0) {
        const { error: prodErr } = await supabase.from("storefront_products").insert(rows);
        if (prodErr) throw prodErr;
      }
      return inserted;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["collections", storefront?.id] });
      qc.invalidateQueries({ queryKey: ["storefront-products"] });
      qc.invalidateQueries({ queryKey: ["collection-products"] });
      qc.invalidateQueries({ queryKey: ["all-products"] });
      setShowNewCollection(false);
      toast.success("Collection created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runTakeDownCollection = useServerFn(takeDownCollection);
  // "Remove from storefront" = take the collection down: every pin in it
  // returns to the available-to-attach pool (back under its board), its
  // products detach, and the collection is removed. Pins and boards are
  // preserved — nothing is lost.
  const hideCollection = useMutation({
    mutationFn: async (id: string) => {
      await runTakeDownCollection({ data: { collectionId: id } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["collections", storefront?.id] });
      qc.invalidateQueries({ queryKey: ["pins", storefront?.id] });
      setCoverPickerFor(null);
      toast.success("Taken down — pins back in available to attach");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setCollectionCover = useMutation({
    mutationFn: async ({ id, url }: { id: string; url: string | null }) => {
      const { error } = await supabase
        .from("collections")
        .update({ cover_image_url: url })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["collections", storefront?.id] });
      toast.success("Cover updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveCollectionOrder = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(
        ids.map((id, idx) => supabase.from("collections").update({ position: idx }).eq("id", id)),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections", storefront?.id] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const saveBoardOrder = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(
        ids.map((id, idx) => supabase.from("boards").update({ position: idx }).eq("id", id)),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["boards", storefront?.id] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const setBackground = useMutation({
    mutationFn: async (file: File | null) => {
      let url: string | null = null;
      if (file) url = await uploadCover(file, "backgrounds");
      const { error } = await supabase
        .from("storefronts")
        .update({ background_image_url: url })
        .eq("id", storefront!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-storefront"] });
      toast.success("Background updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createBoard = useMutation({
    mutationFn: async (p: { name: string; coverFile: File | null; collectionIds: string[] }) => {
      if (p.collectionIds.length === 0) {
        throw new Error("Boards are built from your existing collections — pick at least one.");
      }
      const { data: userRes } = await supabase.auth.getUser();
      let coverUrl: string | null = null;
      if (p.coverFile) coverUrl = await uploadCover(p.coverFile, "boards");
      const { data: inserted, error } = await supabase
        .from("boards")
        .insert({
          user_id: userRes.user!.id,
          storefront_id: storefront!.id,
          name: p.name,
          cover_image_url: coverUrl,
          position: boards.length > 0 ? Math.min(...boards.map((b) => b.position)) - 1 : 0,
        })
        .select("id")
        .single();
      if (error) throw error;
      if (p.collectionIds.length > 0) {
        const rows = p.collectionIds.map((cid, idx) => ({
          board_id: inserted.id,
          collection_id: cid,
          user_id: userRes.user!.id,
          position: idx,
        }));
        const { error: linkErr } = await supabase.from("board_collections").insert(rows);
        if (linkErr) throw linkErr;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["boards", storefront?.id] });
      qc.invalidateQueries({ queryKey: ["board-collections", storefront?.id] });
      setShowNewBoard(false);
      toast.success("Board created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const hideBoard = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("boards")
        .update({ hidden_from_storefront_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["boards", storefront?.id] });
      toast.success("Board removed from storefront");
    },
  });

  const updateStore = useMutation({
    mutationFn: async (p: { name: string; description: string; avatarFile: File | null }) => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) throw new Error("Not signed in");
      let avatarUrl: string | null = null;
      if (p.avatarFile) {
        const ext = p.avatarFile.name.split(".").pop()?.toLowerCase() || "jpg";
        const path = `${userRes.user.id}/avatar-${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("avatars")
          .upload(path, p.avatarFile, { upsert: true, contentType: p.avatarFile.type });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
        avatarUrl = pub.publicUrl;
      }
      const trimmedName = p.name.trim();
      const trimmedDesc = p.description.trim();
      const { error: sfErr } = await supabase
        .from("storefronts")
        .update({ name: trimmedName, description: trimmedDesc || null })
        .eq("id", storefront!.id);
      if (sfErr) throw sfErr;
      if (avatarUrl) {
        const { error: pErr } = await supabase
          .from("profiles")
          .update({ avatar_url: avatarUrl })
          .eq("id", userRes.user.id);
        if (pErr) throw pErr;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-storefront"] });
      qc.invalidateQueries({ queryKey: ["me-profile"] });
      setShowEditStore(false);
      toast.success("Store updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const collectionsByBoard = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const bc of boardCollections) {
      const arr = map.get(bc.board_id) ?? [];
      arr.push(bc.collection_id);
      map.set(bc.board_id, arr);
    }
    return map;
  }, [boardCollections]);

  // A collection only counts as "in the storefront" once at least one of its
  // pins is actually live — a pin only goes live from the preview page's
  // explicit Go Live button (which requires a real product attached), so
  // this is the one true signal, not just "has a product_id" (a pin can have
  // a product picked mid-edit without ever having gone live).
  const pinsWithProduct = useMemo(() => pins.filter((p) => p.status === "live"), [pins]);
  const productsByCollection = useMemo(() => {
    const map = new Map<string, { id: string; image_url: string | null }[]>();
    for (const p of storefrontProducts) {
      if (!p.collection_id) continue;
      const arr = map.get(p.collection_id) ?? [];
      arr.push(p);
      map.set(p.collection_id, arr);
    }
    return map;
  }, [storefrontProducts]);
  // A collection with directly-attached products (the new-collection dialog
  // creates these from pasted links) belongs in the storefront too — it has
  // no pins at all, so the live-pin signal alone would hide it forever.
  const storefrontCollections = useMemo(
    () =>
      collections.filter(
        (c) =>
          pinsWithProduct.some((p) => p.collection_id === c.id) || productsByCollection.has(c.id),
      ),
    [collections, pinsWithProduct, productsByCollection],
  );
  const storefrontCollectionIds = useMemo(
    () => new Set(storefrontCollections.map((c) => c.id)),
    [storefrontCollections],
  );

  if (sfLoading) {
    return (
      <AppShell title="My Store" backButton backTo="/dashboard">
        <SkeletonRows />
      </AppShell>
    );
  }

  if (!storefront) {
    return (
      <AppShell title="My Store" backButton backTo="/dashboard">
        <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-12 text-center">
          <p className="text-sm text-muted-foreground">
            Your storefront is being set up. Refresh in a moment.
          </p>
        </div>
      </AppShell>
    );
  }

  const publicUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/s/${storefront.slug}`;
  const brandColor = storefront.brand_color ?? "#E60023";
  const backgroundUrl = storefront.background_image_url ?? DEFAULT_BACKGROUND;

  return (
    <AppShell
      title="My Store"
      backButton
      backTo="/dashboard"
      inlineActions
      actions={
        <Link
          to="/s/$slug"
          params={{ slug: storefront.slug }}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-2"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Preview
        </Link>
      }
    >
      {/* Background band */}
      <div className="relative -mx-4 mb-4 h-40 overflow-hidden sm:-mx-6">
        <div
          onClick={() => bgInputRef.current?.click()}
          className="absolute inset-0 cursor-pointer"
          role="button"
          aria-label="Upload background"
        >
          <FadeImage src={backgroundUrl} className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-background" />
        </div>
        {storefront.background_image_url && (
          <button
            type="button"
            onClick={() => setBackground.mutate(null)}
            disabled={setBackground.isPending}
            aria-label="Reset default background"
            className="absolute right-3 top-3 z-10 grid h-6 w-6 place-items-center rounded-full bg-black/50 text-white backdrop-blur transition hover:bg-black/70 disabled:opacity-60"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        <input
          ref={bgInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) setBackground.mutate(f);
          }}
        />
      </div>

      {/* Store header */}
      <div className="-mt-16 flex flex-col items-center px-2 pb-6 text-center">
        <label
          className="group relative grid h-24 w-24 cursor-pointer place-items-center overflow-hidden rounded-full text-2xl font-semibold text-white shadow-elevate ring-4 ring-background"
          style={{ background: brandColor }}
          aria-label="Change profile picture"
        >
          {profile?.avatar_url ? (
            <FadeImage
              src={profile.avatar_url}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <span>{storefront.name[0]?.toUpperCase()}</span>
          )}
          <span className="absolute inset-0 grid place-items-center bg-black/40 text-micro font-medium uppercase tracking-wide opacity-0 transition group-hover:opacity-100">
            {updateStore.isPending ? "Saving…" : "Change"}
          </span>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={updateStore.isPending}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              updateStore.mutate({
                name: storefront.name,
                description: storefront.description ?? "",
                avatarFile: f,
              });
            }}
          />
        </label>
        <h2 className="mt-3 font-display text-xl font-semibold">{storefront.name}</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {storefront.description ??
            "Hey, welcome to my store — curated picks and affiliate finds."}
        </p>
        <div className="mt-5 flex items-center gap-2">
          <button
            onClick={() => setShowEditStore(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-2"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
          <Popover>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-2">
                <Share2 className="h-3.5 w-3.5" /> Share
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-2">
              <div className="grid grid-cols-4 gap-1">
                {(() => {
                  const shareText = `Check out my storefront: ${storefront.name}`;
                  const encodedUrl = encodeURIComponent(publicUrl);
                  const encodedText = encodeURIComponent(shareText);
                  const items: { label: string; icon: ReactNode; onClick: () => void }[] = [
                    {
                      label: "Pinterest",
                      icon: (
                        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                          <path d="M12 0C5.4 0 0 5.4 0 12c0 5 3.1 9.4 7.5 11.1-.1-.9-.2-2.4 0-3.4.2-.9 1.4-5.7 1.4-5.7s-.4-.7-.4-1.8c0-1.7 1-2.9 2.2-2.9 1 0 1.5.8 1.5 1.7 0 1-.7 2.6-1 4-.3 1.2.6 2.1 1.7 2.1 2.1 0 3.7-2.2 3.7-5.4 0-2.8-2-4.8-4.9-4.8-3.3 0-5.3 2.5-5.3 5.1 0 1 .4 2.1.9 2.7.1.1.1.2.1.3-.1.4-.3 1.2-.3 1.4-.1.2-.2.3-.4.2-1.5-.7-2.4-2.9-2.4-4.6 0-3.8 2.7-7.2 7.9-7.2 4.1 0 7.3 3 7.3 6.9 0 4.1-2.6 7.5-6.2 7.5-1.2 0-2.4-.6-2.8-1.4l-.7 2.9c-.3 1-1 2.3-1.5 3.1 1.1.3 2.3.5 3.5.5 6.6 0 12-5.4 12-12S18.6 0 12 0z" />
                        </svg>
                      ),
                      onClick: () =>
                        window.open(
                          `https://pinterest.com/pin/create/button/?url=${encodedUrl}&description=${encodedText}`,
                          "_blank",
                        ),
                    },
                    {
                      label: "WhatsApp",
                      icon: <MessageCircle className="h-5 w-5" />,
                      onClick: () =>
                        window.open(`https://wa.me/?text=${encodedText}%20${encodedUrl}`, "_blank"),
                    },
                    {
                      label: "Telegram",
                      icon: <Send className="h-5 w-5" />,
                      onClick: () =>
                        window.open(
                          `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
                          "_blank",
                        ),
                    },
                    {
                      label: "X",
                      icon: <Twitter className="h-5 w-5" />,
                      onClick: () =>
                        window.open(
                          `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedText}`,
                          "_blank",
                        ),
                    },
                    {
                      label: "Facebook",
                      icon: <Facebook className="h-5 w-5" />,
                      onClick: () =>
                        window.open(
                          `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
                          "_blank",
                        ),
                    },
                    {
                      label: "Email",
                      icon: <Mail className="h-5 w-5" />,
                      onClick: () => {
                        window.location.href = `mailto:?subject=${encodeURIComponent(storefront.name)}&body=${encodedText}%20${encodedUrl}`;
                      },
                    },
                    {
                      label: "More",
                      icon: <Share2 className="h-5 w-5" />,
                      onClick: async () => {
                        if (navigator.share) {
                          try {
                            await navigator.share({
                              title: storefront.name,
                              text: shareText,
                              url: publicUrl,
                            });
                          } catch {
                            /* user dismissed the native share sheet */
                          }
                        } else {
                          navigator.clipboard.writeText(publicUrl);
                          toast.success("Link copied");
                        }
                      },
                    },
                    {
                      label: "Copy",
                      icon: <Copy className="h-5 w-5" />,
                      onClick: () => {
                        navigator.clipboard.writeText(publicUrl);
                        toast.success("Link copied");
                      },
                    },
                  ];
                  return items.map((it) => (
                    <button
                      key={it.label}
                      onClick={it.onClick}
                      className="flex flex-col items-center gap-1 rounded-lg p-2 text-micro font-medium text-foreground hover:bg-surface-2"
                    >
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2">
                        {it.icon}
                      </span>
                      {it.label}
                    </button>
                  ));
                })()}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex items-center justify-center gap-1 rounded-full border border-border bg-surface p-1">
        <button
          onClick={() => setTab("collections")}
          className={`flex-1 rounded-full px-4 py-2 text-sm font-semibold transition ${
            tab === "collections"
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Collections
        </button>
        <button
          onClick={() => setTab("boards")}
          className={`flex-1 rounded-full px-4 py-2 text-sm font-semibold transition ${
            tab === "boards"
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Boards
        </button>
      </div>

      {/* Section header */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-base font-semibold">{"\n"}</h3>
          <div className="flex items-center gap-2">
            {(tab === "collections" ? storefrontCollections.length : boards.length) >= 2 && (
              <button
                onClick={() => setReorderOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                Reorder
              </button>
            )}
            <button
              onClick={() =>
                tab === "collections" ? setShowNewCollection(true) : setShowNewBoard(true)
              }
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {tab === "collections" ? (
                <FolderPlus className="h-3.5 w-3.5" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              New
            </button>
          </div>
        </div>

        {tab === "collections" ? (
          storefrontCollections.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-10 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
                <Layers className="h-6 w-6 text-primary-foreground" />
              </div>
              <h4 className="mt-4 font-display text-base font-semibold">No collections yet</h4>
              <p className="mx-auto mt-2 max-w-xs text-sm text-muted-foreground">
                {collections.length === 0
                  ? "Sync your boards, or create one."
                  : "Attach a product to a pin and its collection lands here."}
              </p>
              {collections.length === 0 ? (
                <button
                  onClick={startSync}
                  disabled={runImport.isPending}
                  className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow disabled:opacity-60"
                >
                  {runImport.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {runImport.isPending ? "Syncing…" : "Sync Pinterest"}
                </button>
              ) : (
                <button
                  onClick={() => navigate({ to: "/pins/attach" } as never)}
                  className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow"
                >
                  <Plus className="h-3.5 w-3.5" /> Attach products
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {storefrontCollections.map((c) => {
                const cPins = pinsWithProduct.filter((p) => p.collection_id === c.id);
                const cProducts = productsByCollection.get(c.id) ?? [];
                const coverUrl =
                  c.cover_image_url ??
                  cPins.find((p) => p.image_url)?.image_url ??
                  cProducts.find((p) => p.image_url)?.image_url ??
                  null;
                return (
                  <CollectionCard
                    key={c.id}
                    name={c.name}
                    count={cPins.length + cProducts.length}
                    countLabel="product"
                    coverUrl={coverUrl}
                    coverColor={c.cover_color}
                    brandColor={brandColor}
                    onOpen={() => setViewCollectionFor(c.id)}
                    onEditCover={() => setCoverPickerFor(c.id)}
                    onRemove={() => {
                      if (
                        confirm(
                          `Remove "${c.name}" from storefront? Its pins go back to available-to-attach and their products are detached.`,
                        )
                      ) {
                        hideCollection.mutate(c.id);
                      }
                    }}
                  />
                );
              })}
            </div>
          )
        ) : boards.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-10 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
              <Layers className="h-6 w-6 text-primary-foreground" />
            </div>
            <h4 className="mt-4 font-display text-base font-semibold">No boards yet</h4>
            <p className="mx-auto mt-2 max-w-xs text-sm text-muted-foreground">
              Boards group your collections — like Pinterest folders.
            </p>
            <button
              onClick={() => setShowNewBoard(true)}
              className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow"
            >
              <Plus className="h-3.5 w-3.5" /> New board
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {boards.map((b) => {
              const memberIds = collectionsByBoard.get(b.id) ?? [];
              const memberCollections = collections.filter(
                (c) => memberIds.includes(c.id) && storefrontCollectionIds.has(c.id),
              );
              let coverUrl = b.cover_image_url;
              const mosaic: string[] = [];
              for (const mc of memberCollections) {
                const img =
                  mc.cover_image_url ??
                  pinsWithProduct.find((p) => p.collection_id === mc.id && p.image_url)
                    ?.image_url ??
                  null;
                if (img) mosaic.push(img);
              }
              if (!coverUrl && mosaic.length > 0) coverUrl = mosaic[0];
              return (
                <BoardCard
                  key={b.id}
                  name={b.name}
                  count={memberCollections.length}
                  coverUrl={coverUrl}
                  mosaic={mosaic}
                  brandColor={brandColor}
                  onOpen={() => setViewBoardFor(b.id)}
                  onRemove={() => {
                    if (confirm(`Remove "${b.name}" from storefront?`)) {
                      hideBoard.mutate(b.id);
                    }
                  }}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Public link card */}
      <a
        href={publicUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-6 flex items-center justify-between rounded-2xl border border-border bg-surface p-4 text-sm hover:border-primary/40"
      >
        <span className="flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-primary" /> Public store link
        </span>
        <span className="truncate text-xs text-muted-foreground">{publicUrl}</span>
      </a>

      {/* Dialogs */}
      {showNewCollection && (
        <NewCollectionDialog
          onCancel={() => setShowNewCollection(false)}
          onCreate={(v) => createCollection.mutate(v)}
          pending={createCollection.isPending}
        />
      )}

      {showNewBoard && (
        <NewBoardDialog
          collections={storefrontCollections}
          onCancel={() => setShowNewBoard(false)}
          onCreate={(v) => createBoard.mutate(v)}
          onCreateCollection={() => {
            setShowNewBoard(false);
            setShowNewCollection(true);
          }}
          pending={createBoard.isPending}
        />
      )}

      {coverPickerFor && (
        <CoverPickerDialog
          collection={collections.find((c) => c.id === coverPickerFor)!}
          pins={pins.filter((p) => p.collection_id === coverPickerFor && p.image_url)}
          onSetCover={(url) => setCollectionCover.mutate({ id: coverPickerFor, url })}
          onUploadCover={async (file) => {
            try {
              const url = await uploadCover(file, "collections");
              setCollectionCover.mutate({ id: coverPickerFor, url });
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
          onClose={() => setCoverPickerFor(null)}
        />
      )}

      {viewCollectionFor && collections.find((c) => c.id === viewCollectionFor) && (
        <CollectionPinsDialog
          collection={collections.find((c) => c.id === viewCollectionFor)!}
          pins={pins.filter((p) => p.collection_id === viewCollectionFor)}
          onClose={() => {
            setViewCollectionFor(null);
            if (search.collection) {
              navigate({ search: { collection: undefined } as never, replace: true });
            }
          }}
        />
      )}

      {viewBoardFor && boards.find((b) => b.id === viewBoardFor) && (
        <BoardDialog
          board={boards.find((b) => b.id === viewBoardFor)!}
          collections={collections.filter((c) =>
            (collectionsByBoard.get(viewBoardFor) ?? []).includes(c.id),
          )}
          pins={pins}
          brandColor={brandColor}
          onOpenCollection={(id) => {
            setViewBoardFor(null);
            setViewCollectionFor(id);
          }}
          onCreateCollection={() => {
            setViewBoardFor(null);
            setShowNewCollection(true);
          }}
          onClose={() => setViewBoardFor(null)}
        />
      )}

      <PinterestSyncModal
        open={syncOpen}
        status={
          runImport.isPending
            ? "running"
            : runImport.isError
              ? "error"
              : runImport.isSuccess
                ? "success"
                : "idle"
        }
        result={
          runImport.data
            ? {
                boardsCreated: runImport.data.boards.created + runImport.data.boards.updated,
                pinsCreated:
                  runImport.data.pins.created +
                  runImport.data.pins.updated +
                  runImport.data.pins.rehomed,
              }
            : null
        }
        error={
          runImport.error
            ? (runImport.error as Error).message
            : runImport.data && !runImport.data.ok
              ? (runImport.data.error ?? "Sync failed")
              : null
        }
        onClose={() => {
          setSyncOpen(false);
          runImport.reset();
        }}
        onRetry={() => {
          runImport.reset();
          runImport.mutate();
        }}
      />

      {showEditStore && (
        <EditStoreDialog
          initialName={storefront.name}
          initialDescription={storefront.description ?? ""}
          initialAvatarUrl={profile?.avatar_url ?? null}
          brandColor={brandColor}
          onCancel={() => setShowEditStore(false)}
          onSave={(v) => updateStore.mutate(v)}
          pending={updateStore.isPending}
        />
      )}

      {reorderOpen && (
        <ReorderListDialog
          title={tab === "collections" ? "Reorder collections" : "Reorder boards"}
          items={
            tab === "collections"
              ? storefrontCollections.map((c) => {
                  const cPins = pinsWithProduct.filter((p) => p.collection_id === c.id);
                  return {
                    id: c.id,
                    name: c.name,
                    subtitle: `${cPins.length} product${cPins.length === 1 ? "" : "s"}`,
                    coverUrl:
                      c.cover_image_url ?? cPins.find((p) => p.image_url)?.image_url ?? null,
                    coverColor: c.cover_color,
                  };
                })
              : boards.map((b) => {
                  const memberIds = collectionsByBoard.get(b.id) ?? [];
                  const memberCollections = collections.filter(
                    (c) => memberIds.includes(c.id) && storefrontCollectionIds.has(c.id),
                  );
                  let coverUrl = b.cover_image_url;
                  if (!coverUrl) {
                    for (const mc of memberCollections) {
                      const img =
                        mc.cover_image_url ??
                        pinsWithProduct.find((p) => p.collection_id === mc.id && p.image_url)
                          ?.image_url ??
                        null;
                      if (img) {
                        coverUrl = img;
                        break;
                      }
                    }
                  }
                  return {
                    id: b.id,
                    name: b.name,
                    subtitle: `${memberCollections.length} collection${memberCollections.length === 1 ? "" : "s"}`,
                    coverUrl,
                    coverColor: null,
                  };
                })
          }
          brandColor={brandColor}
          pending={tab === "collections" ? saveCollectionOrder.isPending : saveBoardOrder.isPending}
          onSave={(order) => {
            if (tab === "collections") saveCollectionOrder.mutate(order);
            else saveBoardOrder.mutate(order);
          }}
          onClose={() => setReorderOpen(false)}
        />
      )}
    </AppShell>
  );
}

// Fade-in wrapper for remote/user-uploaded images (covers, avatars, product
// thumbnails) — starts transparent and eases in once loaded, so slow images
// don't pop in. Purely presentational; onError/other behavior is untouched.
function FadeImage({
  src,
  alt = "",
  className = "",
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      className={`${className} opacity-0 transition-opacity duration-300 ${loaded ? "opacity-100" : ""}`}
    />
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-6">
      {/* Background band */}
      <Skeleton className="-mx-4 -mt-4 h-40 rounded-none sm:-mx-6" />
      {/* Store header */}
      <div className="-mt-16 flex flex-col items-center gap-3 py-2">
        <Skeleton className="h-24 w-24 rounded-full ring-4 ring-background" />
        <Skeleton className="h-5 w-40 rounded-full" />
        <Skeleton className="h-4 w-56 rounded-full" />
        <div className="mt-2 flex gap-2">
          <Skeleton className="h-9 w-20 rounded-full" />
          <Skeleton className="h-9 w-20 rounded-full" />
        </div>
      </div>
      {/* Tabs */}
      <Skeleton className="h-11 w-full rounded-full" />
      {/* Collection/board card grid */}
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

type ReorderListItem = {
  id: string;
  name: string;
  subtitle: string;
  coverUrl: string | null;
  coverColor: string | null;
};

function ReorderListDialog({
  title,
  items,
  brandColor,
  pending,
  onSave,
  onClose,
}: {
  title: string;
  items: ReorderListItem[];
  brandColor: string;
  pending: boolean;
  onSave: (order: string[]) => void;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<string[]>(() => items.map((i) => i.id));
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  return (
    <ModalShell onClose={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-elevate">
        <div className="border-b border-border/60 px-4 py-3">
          <h3 className="font-display text-base font-semibold">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Drag to reorder</p>
        </div>
        <Reorder.Group
          axis="y"
          values={order}
          onReorder={setOrder}
          className="flex flex-1 flex-col gap-2 overflow-y-auto p-3"
        >
          {order.map((id) => {
            const item = byId.get(id);
            if (!item) return null;
            return (
              <Reorder.Item
                key={id}
                value={id}
                whileDrag={{
                  scale: 1.03,
                  boxShadow: "0 20px 40px -12px rgba(0,0,0,0.35)",
                  zIndex: 10,
                }}
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
                className="flex touch-none select-none items-center gap-3 rounded-2xl border border-border bg-surface p-2.5 shadow-sm active:cursor-grabbing"
              >
                <motion.div
                  whileHover={{ scale: 1.1 }}
                  className="grid h-8 w-8 shrink-0 cursor-grab place-items-center rounded-full text-muted-foreground active:cursor-grabbing"
                >
                  <GripVertical className="h-4 w-4" />
                </motion.div>
                <div
                  className="h-12 w-12 shrink-0 overflow-hidden rounded-xl"
                  style={{
                    background:
                      item.coverColor ?? `linear-gradient(135deg, ${brandColor}, #F5E1D5)`,
                  }}
                >
                  {item.coverUrl ? (
                    <FadeImage src={item.coverUrl} className="h-full w-full object-cover" />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-white/80">
                      <ImageIcon className="h-4 w-4" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{item.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.subtitle}</p>
                </div>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              onSave(order);
              onClose();
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow disabled:opacity-60"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Save order
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function CollectionCard({
  name,
  count,
  countLabel,
  coverUrl,
  coverColor,
  brandColor,
  onOpen,
  onEditCover,
  onRemove,
}: {
  name: string;
  count: number;
  countLabel: string;
  coverUrl: string | null;
  coverColor: string | null;
  brandColor: string;
  onOpen: () => void;
  onEditCover: () => void;
  onRemove: () => void;
}) {
  return (
    <article className="group relative overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:shadow-md">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`View ${name}`}
        className="block w-full text-left"
      >
        <div
          className="relative aspect-square w-full"
          style={{
            background: coverColor ?? `linear-gradient(135deg, ${brandColor}, #F5E1D5)`,
          }}
        >
          {coverUrl ? (
            <FadeImage src={coverUrl} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-white/80">
              <ImageIcon className="h-8 w-8" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
          <div className="absolute inset-x-3 bottom-2 text-white">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="text-micro opacity-80">
              {count} {countLabel}
              {count === 1 ? "" : "s"}
            </p>
          </div>
        </div>
      </button>
      <button
        onClick={onEditCover}
        aria-label="Change cover"
        className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/50 text-white opacity-0 backdrop-blur transition group-hover:opacity-100"
      >
        <ImageIcon className="h-3.5 w-3.5" />
      </button>
      {/* Always visible (not hover-gated) — hover never fires on touch
          screens, and delete must be reachable there. */}
      <button
        onClick={onRemove}
        aria-label="Delete collection"
        className="absolute left-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/50 text-white backdrop-blur transition hover:bg-black/70"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </article>
  );
}

function BoardCard({
  name,
  count,
  coverUrl,
  mosaic,
  brandColor,
  onOpen,
  onRemove,
}: {
  name: string;
  count: number;
  coverUrl: string | null;
  mosaic: string[];
  brandColor: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const hero = coverUrl;
  const side = mosaic.filter((m) => m !== hero).slice(0, 2);
  return (
    <article className="group relative overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:shadow-md">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div
          className="relative grid aspect-square w-full grid-cols-3 gap-0.5"
          style={{ background: `linear-gradient(135deg, ${brandColor}, #F5E1D5)` }}
        >
          <div className="relative col-span-2 row-span-2 overflow-hidden">
            {hero ? (
              <FadeImage src={hero} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-white/80">
                <Layers className="h-8 w-8" />
              </div>
            )}
          </div>
          <div className="relative overflow-hidden bg-surface-2">
            {side[0] ? (
              <FadeImage src={side[0]} className="absolute inset-0 h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="relative overflow-hidden bg-surface-2">
            {side[1] ? (
              <FadeImage src={side[1]} className="absolute inset-0 h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
          <div className="absolute inset-x-3 bottom-2 text-white">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="text-micro opacity-80">
              {count} collection{count === 1 ? "" : "s"}
            </p>
          </div>
        </div>
      </button>
      <button
        onClick={onRemove}
        aria-label="Remove from storefront"
        className="absolute left-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/50 text-white opacity-0 backdrop-blur transition group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </article>
  );
}

function NewCollectionDialog({
  onCancel,
  onCreate,
  pending,
}: {
  onCancel: () => void;
  onCreate: (v: {
    name: string;
    coverFile: File | null;
    links: string[];
    products: PickableProduct[];
    linkImages?: (string | null)[];
  }) => void;
  pending: boolean;
}) {
  // Two steps: the Add-products screen first — the same sheet the pin flow
  // uses (paste links OR pick from a collection) — then name + cover, where
  // the first product's picture is the default cover.
  const [step, setStep] = useState<"products" | "details">("products");
  const [name, setName] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [links, setLinks] = useState<string[]>([]);
  const [linkInput, setLinkInput] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [showCollection, setShowCollection] = useState(false);
  // Pick order preserved (array, not Set) — the first added product's image
  // becomes the cover when none was uploaded.
  const [picked, setPicked] = useState<string[]>([]);
  // og:images for the pasted links, fetched on entering the details step so
  // the default cover can be shown; null = still loading. Passed along to
  // onCreate so the mutation doesn't fetch them a second time.
  const [linkImages, setLinkImages] = useState<(string | null)[] | null>(null);
  const runPreviews = useServerFn(fetchLinkPreviews);
  // Guards against an older fetch resolving after a newer one when the user
  // bounces between the steps editing links.
  const previewReq = useRef(0);

  const goToDetails = () => {
    setStep("details");
    const reqId = ++previewReq.current;
    if (links.length === 0) {
      setLinkImages([]);
      return;
    }
    setLinkImages(null);
    const snapshot = [...links];
    // The server fn caps at 10 URLs — links beyond that just get no preview.
    runPreviews({ data: { urls: snapshot.slice(0, 10) } })
      .then((r) => {
        if (previewReq.current !== reqId) return;
        setLinkImages(snapshot.map((_, i) => r.images[i] ?? null));
      })
      .catch(() => {
        if (previewReq.current !== reqId) return;
        setLinkImages(snapshot.map(() => null));
      });
  };

  const { data: allProducts = [] } = useQuery({
    queryKey: ["all-products"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("storefront_products")
        .select("id,title,image_url,affiliate_url,price_cents,commission_pct,collection_id")
        .eq("user_id", userId);
      return (data ?? []) as PickableProduct[];
    },
  });

  const togglePicked = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const pickedProducts = picked
    .map((id) => allProducts.find((p) => p.id === id))
    .filter((p): p is PickableProduct => !!p);

  // Default cover = the first product's picture, matching what the create
  // mutation falls back to when nothing is uploaded: first link og:image,
  // then first picked product with an image.
  const defaultCover =
    linkImages?.find((img): img is string => !!img) ??
    pickedProducts.find((p) => p.image_url)?.image_url ??
    null;
  const coverLoading = links.length > 0 && linkImages === null;

  const addLink = () => {
    const url = linkInput.trim();
    if (!url) {
      setLinkError("Paste a product link first");
      return;
    }
    try {
      new URL(url);
    } catch {
      setLinkError("That doesn't look like a valid URL");
      return;
    }
    const normalize = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
    if (links.some((l) => normalize(l) === normalize(url))) {
      setLinkError("Already added");
      return;
    }
    setLinkError(null);
    setLinks((prev) => [...prev, url]);
    setLinkInput("");
  };

  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) {
        setLinkInput(t.trim());
        setLinkError(null);
      }
    } catch {
      toast.error("Clipboard access blocked — paste with ⌘/Ctrl+V");
    }
  };

  return (
    <ModalShell onClose={onCancel}>
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-elevate">
        {step === "details" ? (
          <>
            <h3 className="font-display text-lg font-semibold">Name your collection</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Group your products the way you'd group them on Pinterest.
            </p>
            <label className="mt-4 block cursor-pointer">
              <div className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-xl border border-dashed border-border bg-surface-2 text-muted-foreground">
                {preview ?? defaultCover ? (
                  <FadeImage
                    src={(preview ?? defaultCover)!}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : coverLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span className="flex items-center gap-2 text-xs">
                    <Camera className="h-4 w-4" /> Upload cover (optional)&nbsp;
                  </span>
                )}
              </div>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setCoverFile(f);
                  setPreview(f ? URL.createObjectURL(f) : null);
                }}
              />
            </label>
            {!preview && (
              <p className="mt-1.5 text-mini text-muted-foreground">
                {defaultCover
                  ? "Using the first product's picture"
                  : "Optional — the first product's picture is used"}
              </p>
            )}
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Fall capsule wardrobe"
              className="mt-3 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setStep("products")}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                Back
              </button>
              <button
                disabled={!name.trim() || pending}
                onClick={() =>
                  onCreate({
                    name: name.trim(),
                    coverFile,
                    links,
                    products: pickedProducts,
                    linkImages: linkImages ?? undefined,
                  })
                }
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow disabled:opacity-60"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />} Create collection
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="font-display text-lg font-bold">New collection</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add products first — paste an affiliate link, or pick from an existing collection.
            </p>

            {/* Paste a link — identical to the pin flow's Add-more sheet:
                link input plus the green paste-from-clipboard square. */}
            <div className="mt-4 flex items-center gap-2">
              <div
                className={`flex flex-1 items-center gap-2 rounded-2xl border bg-background px-3 py-3 ${
                  linkError ? "border-rose-400" : "border-input"
                }`}
              >
                <Link2 className="h-4 w-4 shrink-0 text-primary" />
                <input
                  autoFocus
                  type="url"
                  value={linkInput}
                  onChange={(e) => {
                    setLinkInput(e.target.value);
                    if (linkError) setLinkError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addLink();
                    }
                  }}
                  placeholder="Paste a product link"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                />
              </div>
              <button
                type="button"
                onClick={() => void pasteFromClipboard()}
                aria-label="Paste from clipboard"
                className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-2xl bg-emerald-500 text-white shadow-sm transition active:scale-95"
              >
                <ClipboardPaste className="h-5 w-5" />
              </button>
            </div>
            {linkError && <p className="mt-1.5 text-xs text-rose-500">{linkError}</p>}
            {/* Only appears once there's a link to add. */}
            {linkInput.trim() && (
              <button
                type="button"
                onClick={addLink}
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
                then that collection's products. */}
            <AddFromCollectionButton onClick={() => setShowCollection(true)} />

            {showCollection && (
              <CollectionAddFlow
                products={allProducts}
                pickedIds={new Set(picked)}
                onTogglePicked={togglePicked}
                onExit={() => setShowCollection(false)}
              />
            )}

            {/* Everything added so far — pasted links and picked products. */}
            {links.length + pickedProducts.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">
                  {links.length + pickedProducts.length} added
                </p>
                <div className="flex max-h-[34vh] flex-col gap-2 overflow-y-auto">
                  {links.map((url) => (
                    <div
                      key={url}
                      className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-2.5 py-2"
                    >
                      <Link2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">{hostBrand(url)}</p>
                        <p className="truncate text-micro text-muted-foreground">{url}</p>
                      </div>
                      <button
                        type="button"
                        aria-label="Remove link"
                        onClick={() => setLinks((prev) => prev.filter((l) => l !== url))}
                        className="shrink-0 text-muted-foreground transition hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {pickedProducts.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-2.5 py-2"
                    >
                      {p.image_url ? (
                        <img
                          src={p.image_url}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">{p.title}</p>
                        <p className="truncate text-micro text-muted-foreground">
                          {hostBrand(p.affiliate_url)}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label="Remove product"
                        onClick={() => togglePicked(p.id)}
                        className="shrink-0 text-muted-foreground transition hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onCancel}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                disabled={links.length === 0 && pickedProducts.length === 0}
                onClick={goToDetails}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow disabled:opacity-60"
              >
                Next
              </button>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}

function NewBoardDialog({
  collections,
  onCancel,
  onCreate,
  onCreateCollection,
  pending,
}: {
  collections: Collection[];
  onCancel: () => void;
  onCreate: (v: { name: string; coverFile: File | null; collectionIds: string[] }) => void;
  onCreateCollection: () => void;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  return (
    <ModalShell onClose={onCancel}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-elevate">
        <h3 className="font-display text-lg font-semibold">New board</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Boards are folders of collections — pick a cover and add your collections.
        </p>
        <label className="mt-4 block cursor-pointer">
          <div className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-xl border border-dashed border-border bg-surface-2 text-muted-foreground">
            {preview ? (
              <FadeImage src={preview} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <span className="flex items-center gap-2 text-xs">
                <Camera className="h-4 w-4" /> Upload cover&nbsp;
              </span>
            )}
          </div>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setCoverFile(f);
              setPreview(f ? URL.createObjectURL(f) : null);
            }}
          />
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Home aesthetic"
          className="mt-3 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Collections in this board
          </p>
          {collections.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-surface-2/40 p-4 text-center">
              <p className="text-xs text-muted-foreground">You don't have any collections yet.</p>
              <button
                type="button"
                onClick={onCreateCollection}
                className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-glow"
              >
                <FolderPlus className="h-3.5 w-3.5" /> Make a collection first
              </button>
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
              {collections.map((c) => {
                const active = selected.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggle(c.id)}
                    className={`flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 ${
                      active ? "bg-primary/5" : "hover:bg-surface-2"
                    }`}
                  >
                    <div
                      className={`grid h-5 w-5 place-items-center rounded-full border ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border"
                      }`}
                    >
                      {active && <Check className="h-3 w-3" />}
                    </div>
                    {c.cover_image_url ? (
                      <FadeImage src={c.cover_image_url} className="h-8 w-8 rounded object-cover" />
                    ) : (
                      <div
                        className="h-8 w-8 rounded"
                        style={{ background: c.cover_color ?? "#7C5CFF" }}
                      />
                    )}
                    <span className="flex-1 truncate">{c.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            disabled={!name.trim() || selected.size === 0 || pending}
            onClick={() =>
              onCreate({ name: name.trim(), coverFile, collectionIds: Array.from(selected) })
            }
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow disabled:opacity-60"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Create
          </button>
        </div>
        {collections.length > 0 && selected.size === 0 && (
          <p className="mt-2 text-right text-mini text-muted-foreground">
            Pick at least one collection — boards are built from your existing collections.
          </p>
        )}
      </div>
    </ModalShell>
  );
}

function CoverPickerDialog({
  collection,
  pins,
  onSetCover,
  onUploadCover,
  onClose,
}: {
  collection: Collection;
  pins: Pin[];
  onSetCover: (url: string | null) => void;
  onUploadCover: (file: File) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-t-2xl border border-border bg-surface shadow-xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h3 className="text-sm font-semibold">Choose cover · {collection.name}</h3>
          <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4">
          <label className="mb-3 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border bg-surface-2/50 p-3 text-xs font-medium text-muted-foreground hover:text-foreground">
            <Camera className="h-4 w-4" /> Upload a new cover image
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) onUploadCover(f);
              }}
            />
          </label>
          {pins.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-surface-2/40 p-6 text-center text-xs text-muted-foreground">
              Or add products to this collection to use as covers.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {pins.map((p) => {
                const active = collection.cover_image_url === p.image_url;
                return (
                  <button
                    key={p.id}
                    onClick={() => onSetCover(p.image_url)}
                    className={`relative aspect-square overflow-hidden rounded-lg border transition ${
                      active
                        ? "border-primary ring-2 ring-primary"
                        : "border-border hover:border-primary/60"
                    }`}
                  >
                    <FadeImage src={p.image_url!} className="h-full w-full object-cover" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {collection.cover_image_url && (
          <div className="border-t border-border/60 px-4 py-3">
            <button
              onClick={() => onSetCover(null)}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Reset to default
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EditStoreDialog({
  initialName,
  initialDescription,
  initialAvatarUrl,
  brandColor,
  onCancel,
  onSave,
  pending,
}: {
  initialName: string;
  initialDescription: string;
  initialAvatarUrl: string | null;
  brandColor: string;
  onCancel: () => void;
  onSave: (v: { name: string; description: string; avatarFile: File | null }) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);

  const handleAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setAvatarFile(f);
    setAvatarUrl(URL.createObjectURL(f));
  };

  return (
    <ModalShell onClose={onCancel}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-elevate">
        <h3 className="font-display text-lg font-semibold">Edit store</h3>
        <div className="mt-4 flex flex-col items-center">
          <label
            className="group relative grid h-20 w-20 cursor-pointer place-items-center overflow-hidden rounded-full text-xl font-semibold text-white shadow-glow ring-4 ring-background"
            style={{ background: brandColor }}
          >
            {avatarUrl ? (
              <FadeImage src={avatarUrl} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <span>{name[0]?.toUpperCase()}</span>
            )}
            <span className="absolute inset-0 grid place-items-center bg-black/40 text-micro font-medium uppercase tracking-wide opacity-0 transition group-hover:opacity-100">
              Change
            </span>
            <input type="file" accept="image/*" onChange={handleAvatar} className="hidden" />
          </label>
        </div>
        <div className="mt-5 space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Store name"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short bio"
            rows={3}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            disabled={!name.trim() || pending}
            onClick={() =>
              onSave({ name: name.trim(), description: description.trim(), avatarFile })
            }
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow disabled:opacity-60"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function CollectionPinsDialog({
  collection,
  pins,
  onClose,
}: {
  collection: Collection;
  pins: Pin[];
  onClose: () => void;
}) {
  const { data: products = [] } = useQuery({
    queryKey: ["collection-products", collection.id],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data, error } = await supabase
        .from("storefront_products")
        .select("id,title,image_url,affiliate_url,price_cents,commission_pct")
        .eq("collection_id", collection.id)
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as {
        id: string;
        title: string;
        image_url: string | null;
        affiliate_url: string;
        price_cents: number | null;
        commission_pct: number | null;
      }[];
    },
  });

  const totalItems = pins.length + products.length;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-t-2xl border border-border bg-surface shadow-xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">{collection.name}</h3>
            <p className="text-mini text-muted-foreground">
              {totalItems} item{totalItems === 1 ? "" : "s"}
            </p>
          </div>
          <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          {totalItems === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-surface-2/40 p-6 text-center">
              <p className="text-xs text-muted-foreground">No items in this collection yet.</p>
              <Link
                to="/collections/$id/attach"
                params={{ id: collection.id }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-glow"
              >
                <Sparkles className="h-3.5 w-3.5" /> Attach products
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {products.map((p) => (
                <SuggestionCard
                  key={`prod-${p.id}`}
                  title={p.title}
                  thumbnail={p.image_url}
                  source={hostBrand(p.affiliate_url)}
                  link={p.affiliate_url}
                  price={realProductPrice(p.price_cents)}
                  commissionPct={p.commission_pct}
                />
              ))}
              {pins.map((p) => (
                <SuggestionCard
                  key={`pin-${p.id}`}
                  title={p.title}
                  thumbnail={p.image_url}
                  source={hostBrand(p.external_url ?? "")}
                  link={p.external_url ?? ""}
                  price={null}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BoardDialog({
  board,
  collections,
  pins,
  brandColor,
  onOpenCollection,
  onCreateCollection,
  onClose,
}: {
  board: Board;
  collections: Collection[];
  pins: Pin[];
  brandColor: string;
  onOpenCollection: (id: string) => void;
  onCreateCollection: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-t-2xl border border-border bg-surface shadow-xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">{board.name}</h3>
            <p className="text-mini text-muted-foreground">
              {collections.length} collection{collections.length === 1 ? "" : "s"}
            </p>
          </div>
          <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          {collections.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-surface-2/40 p-6 text-center">
              <p className="text-xs text-muted-foreground">This board is empty.</p>
              <button
                type="button"
                onClick={onCreateCollection}
                className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-glow"
              >
                <FolderPlus className="h-3.5 w-3.5" /> Create a collection
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {collections.map((c) => {
                const cPins = pins.filter((p) => p.collection_id === c.id);
                const coverUrl =
                  c.cover_image_url ?? cPins.find((p) => p.image_url)?.image_url ?? null;
                return (
                  <button
                    key={c.id}
                    onClick={() => onOpenCollection(c.id)}
                    className="group overflow-hidden rounded-xl border border-border bg-surface-2 text-left"
                  >
                    <div
                      className="relative aspect-square w-full"
                      style={{
                        background:
                          c.cover_color ?? `linear-gradient(135deg, ${brandColor}, #F5E1D5)`,
                      }}
                    >
                      {coverUrl ? (
                        <FadeImage
                          src={coverUrl}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 grid place-items-center text-white/80">
                          <ImageIcon className="h-8 w-8" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                      <div className="absolute inset-x-3 bottom-2 text-white">
                        <p className="truncate text-sm font-semibold">{c.name}</p>
                        <p className="text-micro opacity-80">
                          {cPins.length} product{cPins.length === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
