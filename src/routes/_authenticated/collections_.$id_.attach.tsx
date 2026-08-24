import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Loader2, Link2, Plus, Store, ArrowRight } from "lucide-react";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { SuggestionCard, realProductPrice } from "@/components/suggestion-card";
import { AppShell } from "@/components/app-shell";
import { supabase } from "@/integrations/supabase/client";
import { hostBrand } from "@/lib/brands";
import { fetchLinkPreviews } from "@/lib/link-preview.functions";
import { getFriendlyMessage } from "@/lib/friendly-error";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/collections_/$id_/attach")({
  component: AttachToCollectionPage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-destructive">{getFriendlyMessage(error)}</div>
  ),
  notFoundComponent: () => (
    <div className="p-6 text-sm text-muted-foreground">Collection not found.</div>
  ),
});

type CollectionRow = {
  id: string;
  name: string;
  cover_image_url: string | null;
  storefront_id: string;
};

type ProductRow = {
  id: string;
  title: string;
  image_url: string | null;
  affiliate_url: string;
  collection_id: string | null;
  price_cents: number | null;
  commission_pct: number | null;
};

function AttachToCollectionPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: collection, isLoading } = useQuery({
    queryKey: ["collection", id],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return null;
      const { data, error } = await supabase
        .from("collections")
        .select("id,name,cover_image_url,storefront_id")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data as CollectionRow | null;
    },
  });

  const { data: products = [] } = useQuery({
    queryKey: ["collection-products", id],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data, error } = await supabase
        .from("storefront_products")
        .select("id,title,image_url,affiliate_url,collection_id,price_cents,commission_pct")
        .eq("collection_id", id)
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ProductRow[];
    },
  });

  const imageUrl = collection?.cover_image_url ?? "";
  const [manualUrl, setManualUrl] = useState("");
  const runFetchLinkPreviews = useServerFn(fetchLinkPreviews);

  const addManual = useMutation({
    mutationFn: async () => {
      const url = manualUrl.trim();
      if (!url) throw new Error("Paste a product link first");
      try {
        new URL(url);
      } catch {
        throw new Error("That doesn't look like a valid URL");
      }
      if (!collection) throw new Error("Collection not loaded");
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) throw new Error("Not signed in");

      // The link's og:image, best-effort — gives the product card a real
      // picture and, when the collection has no cover yet, becomes the
      // cover (a skipped upload defaults to the first product's picture).
      let previewImage: string | null = null;
      try {
        const res = await runFetchLinkPreviews({ data: { urls: [url] } });
        previewImage = res.images[0] ?? null;
      } catch {
        /* previews are a bonus — add the product regardless */
      }

      let hostname = "New product";
      try {
        hostname = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        /* keep default */
      }
      const title = collection.name ? `${collection.name} — ${hostname}` : hostname;
      const { error } = await supabase.from("storefront_products").insert({
        user_id: userId,
        storefront_id: collection.storefront_id,
        collection_id: collection.id,
        title,
        affiliate_url: url,
        image_url: previewImage ?? imageUrl ?? null,
      });
      if (error) throw error;

      if (!collection.cover_image_url && previewImage) {
        const { error: coverErr } = await supabase
          .from("collections")
          .update({ cover_image_url: previewImage })
          .eq("id", collection.id);
        if (coverErr) throw coverErr;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["collection-products", id] });
      qc.invalidateQueries({ queryKey: ["collection", id] });
      qc.invalidateQueries({ queryKey: ["collections"] });
      setManualUrl("");
      notifyDone("Product added to collection");
    },
    onError: (e: Error) => notifyProblem(getFriendlyMessage(e)),
  });

  if (isLoading) {
    return (
      <AppShell title="Attach products" backButton backTo="/storefront" hideBottomNav>
        <div className="mx-auto max-w-2xl space-y-6 pb-32">
          {/* Cover image placeholder */}
          <div className="overflow-hidden rounded-2xl border border-border bg-surface-2/40">
            <Skeleton className="aspect-[4/5] max-h-72 w-full rounded-none" />
          </div>

          {/* Manual link placeholder */}
          <div>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-1.5 h-11 w-full rounded-xl" />
            <Skeleton className="mt-2 h-9 w-full rounded-xl" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (!collection) {
    return (
      <AppShell title="Attach products" backButton backTo="/storefront" hideBottomNav>
        <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-12 text-center text-sm text-muted-foreground">
          Collection not found.
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={collection.name}
      subtitle="Attach products"
      backButton
      backTo="/storefront"
      hideBottomNav
    >
      <div className="mx-auto max-w-2xl space-y-6 pb-32">
        {/* Collection cover */}
        {imageUrl ? (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface-2/40 shadow-sm">
            <img src={imageUrl} alt="" className="max-h-72 w-full object-cover" />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-surface-2/40 p-6 text-center text-xs text-muted-foreground">
            No cover yet — the first product you add sets it.
          </div>
        )}

        {/* Manual link */}
        <div>
          <label className="text-mini font-semibold uppercase tracking-wide text-muted-foreground">
            Product link
          </label>
          <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-input bg-background px-3 py-2.5">
            <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              type="url"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (manualUrl.trim() && !addManual.isPending) addManual.mutate();
                }
              }}
              placeholder="Paste an affiliate link…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          <button
            type="button"
            onClick={() => addManual.mutate()}
            disabled={addManual.isPending || !manualUrl.trim()}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary/10 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/15 disabled:opacity-50"
          >
            {addManual.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Add link
          </button>
        </div>

        {/* Already in this collection */}
        {products.length > 0 ? (
          <div>
            <h5 className="flex items-center gap-1.5 text-sm font-semibold">
              <Store className="h-4 w-4 text-primary" />
              In this collection
              <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-micro font-semibold text-primary">
                {products.length}
              </span>
            </h5>
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {products.map((p) => (
                <SuggestionCard
                  key={p.id}
                  title={p.title}
                  thumbnail={p.image_url}
                  source={hostBrand(p.affiliate_url)}
                  link={p.affiliate_url}
                  price={realProductPrice(p.price_cents)}
                  commissionPct={p.commission_pct}
                />
              ))}
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border bg-surface-2/40 p-4 text-center text-xs text-muted-foreground">
            No products yet — paste a link above to add the first one.
          </p>
        )}
      </div>

      {/* Sticky Done */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/95 px-5 py-3 backdrop-blur-xl"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex max-w-2xl items-center justify-end">
          <button
            onClick={() => navigate({ to: "/storefront" })}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition active:scale-[0.98]"
          >
            Done <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </AppShell>
  );
}
