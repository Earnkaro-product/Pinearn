import { useEffect, useMemo, useState } from "react";
import {
  Clipboard,
  Loader2,
  X,
  Link as LinkIcon,
  Copy,
  Store,
  Share2,
  Check,
  ArrowLeft,
  Plus,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppSheet } from "@/components/app-sheet";
import { supabase } from "@/integrations/supabase/client";

export const OPEN_AFFILIATE_DIALOG_EVENT = "pinearn:open-affiliate-dialog";

export function openAffiliateLinkDialog() {
  window.dispatchEvent(new CustomEvent(OPEN_AFFILIATE_DIALOG_EVENT));
}

export type CreatedProduct = {
  id: string;
  affiliate_url: string;
  storefront_id: string;
};

export function AffiliateLinkDialog() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [createdProduct, setCreatedProduct] = useState<CreatedProduct | null>(null);
  const [pickingCollection, setPickingCollection] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    function onOpen() {
      setOpen(true);
      setCreatedProduct(null);
      setPickingCollection(false);
      setUrl("");
    }
    window.addEventListener(OPEN_AFFILIATE_DIALOG_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_AFFILIATE_DIALOG_EVENT, onOpen);
  }, []);

  const create = useMutation({
    mutationFn: async () => {
      const link = url.trim();
      if (!link) throw new Error("Paste a product link first");
      try {
        new URL(link);
      } catch {
        throw new Error("That doesn't look like a valid URL");
      }
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) throw new Error("Not signed in");

      const { data: sf, error: sfErr } = await supabase
        .from("storefronts")
        .select("id")
        .eq("user_id", userId)
        .order("is_default", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sfErr) throw sfErr;
      if (!sf) throw new Error("Your storefront isn't ready yet. Try again in a moment.");

      let hostname = "New product";
      try {
        hostname = new URL(link).hostname.replace(/^www\./, "");
      } catch {
        /* keep */
      }

      const { data: inserted, error } = await supabase
        .from("storefront_products")
        .insert({
          user_id: userId,
          storefront_id: sf.id,
          title: hostname,
          affiliate_url: link,
        })
        .select("id,affiliate_url,storefront_id")
        .single();
      if (error) throw error;
      return inserted as CreatedProduct;
    },
    onSuccess: (inserted) => {
      qc.invalidateQueries({ queryKey: ["all-products"] });
      qc.invalidateQueries({ queryKey: ["storefront-products"] });
      toast.success("Affiliate link created");
      setCreatedProduct(inserted);
      setUrl("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function pasteFromClipboard() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setUrl(t.trim());
    } catch {
      toast.error("Clipboard access blocked — paste with ⌘/Ctrl+V");
    }
  }

  async function copyLink() {
    if (!createdProduct) return;
    const ok = await copyToClipboard(createdProduct.affiliate_url);
    if (ok) toast.success("Link copied");
    else toast.error("Could not copy link");
  }

  function reset() {
    setCreatedProduct(null);
    setPickingCollection(false);
    setUrl("");
  }

  if (!open) return null;

  return (
    <AppSheet
      onClose={() => setOpen(false)}
      label="Add an affiliate product"
      layout="panel"
      grabber={false}
    >
      <>
        <div className="flex items-center justify-between px-6 pt-5">
          <div className="flex items-center gap-2 text-primary">
            {pickingCollection ? (
              <button
                onClick={() => setPickingCollection(false)}
                className="flex items-center gap-1 text-xs font-semibold uppercase tracking-widest"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            ) : (
              <>
                <LinkIcon className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-widest">Affiliate</span>
              </>
            )}
          </div>
          <button
            onClick={() => setOpen(false)}
            className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-foreground transition hover:bg-surface"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* This sheet keeps its own padding, so it also owes the home indicator
            its clearance — the shell only adds that for the simple layout. */}
        <div className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3">
          {createdProduct && pickingCollection ? (
            <CollectionPicker
              product={createdProduct}
              onDone={(collectionId) => {
                setOpen(false);
                navigate({ to: "/storefront", search: { collection: collectionId } as never });
              }}
            />
          ) : createdProduct ? (
            <ShareSheet
              link={createdProduct.affiliate_url}
              onCopy={copyLink}
              onAddToStorefront={() => setPickingCollection(true)}
              onCreateAnother={reset}
            />
          ) : (
            <>
              <h2 className="font-display text-2xl font-bold text-foreground">
                Create Your Affiliate Link
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Paste any product URL and we'll add it to your storefront instantly.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate();
                }}
                className="mt-5"
              >
                <div className="flex items-center gap-2 rounded-full bg-surface-2 pl-5 pr-2 py-2 ring-1 ring-border">
                  <input
                    autoFocus
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="Paste any product link here"
                    className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={pasteFromClipboard}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-foreground transition hover:bg-surface-2"
                    aria-label="Paste from clipboard"
                  >
                    <Clipboard className="h-4 w-4" />
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={create.isPending || !url.trim()}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition disabled:opacity-60"
                >
                  {create.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Creating link...
                    </>
                  ) : (
                    "Create affiliate link"
                  )}
                </button>
              </form>
            </>
          )}
        </div>
      </>
    </AppSheet>
  );
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function openExternal(url: string) {
  try {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {
    window.location.href = url;
  }
}

type ShareSheetProps = {
  link: string;
  onCopy: () => void | Promise<void>;
  onAddToStorefront: () => void;
  onCreateAnother: () => void;
};

export function ShareSheet({ link, onCopy, onAddToStorefront, onCreateAnother }: ShareSheetProps) {
  const [copied, setCopied] = useState(false);

  const encoded = useMemo(() => encodeURIComponent(link), [link]);
  const shareText = useMemo(() => encodeURIComponent("Check this out 👀"), []);

  async function handleCopy() {
    await onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function openUrl(url: string) {
    openExternal(url);
  }

  async function nativeShare() {
    if (navigator.share) {
      try {
        await navigator.share({ url: link, text: "Check this out 👀" });
        return;
      } catch {
        /* user cancelled */
      }
    }
    handleCopy();
  }

  async function instagramShare() {
    await handleCopy();
    toast.success("Link copied — paste in your Instagram story or DM");
    window.location.href = "instagram://story-camera";
  }

  const actions: {
    key: string;
    label: string;
    onClick: () => void;
    node: React.ReactNode;
  }[] = [
    {
      key: "copy",
      label: copied ? "Copied" : "Copy Link",
      onClick: handleCopy,
      node: (
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground">
          {copied ? <Check className="h-6 w-6" /> : <Copy className="h-6 w-6" />}
        </div>
      ),
    },
    {
      key: "storefront",
      label: "Storefront",
      onClick: onAddToStorefront,
      node: (
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-foreground text-background">
          <Store className="h-6 w-6" />
        </div>
      ),
    },
    {
      key: "pinterest",
      label: "Pinterest",
      onClick: () =>
        openUrl(`https://pinterest.com/pin/create/button/?url=${encoded}&description=${shareText}`),
      node: (
        <SocialIcon bg="#E60023">
          <PinterestSvg />
        </SocialIcon>
      ),
    },
    {
      key: "whatsapp",
      label: "WhatsApp",
      onClick: () => openUrl(`https://wa.me/?text=${shareText}%20${encoded}`),
      node: (
        <SocialIcon bg="#25D366">
          <WhatsAppSvg />
        </SocialIcon>
      ),
    },
    {
      key: "instagram",
      label: "Instagram",
      onClick: instagramShare,
      node: (
        <SocialIcon bg="radial-gradient(circle at 30% 110%, #FFDD55 0%, #FF543E 45%, #C837AB 75%, #5851DB 100%)">
          <InstagramSvg />
        </SocialIcon>
      ),
    },
    {
      key: "facebook",
      label: "Facebook",
      onClick: () => openUrl(`https://www.facebook.com/sharer/sharer.php?u=${encoded}`),
      node: (
        <SocialIcon bg="#1877F2">
          <FacebookSvg />
        </SocialIcon>
      ),
    },
    {
      key: "x",
      label: "X",
      onClick: () => openUrl(`https://twitter.com/intent/tweet?text=${shareText}&url=${encoded}`),
      node: (
        <SocialIcon bg="#000000">
          <XSvg />
        </SocialIcon>
      ),
    },
    {
      key: "telegram",
      label: "Telegram",
      onClick: () => openUrl(`https://t.me/share/url?url=${encoded}&text=${shareText}`),
      node: (
        <SocialIcon bg="#229ED9">
          <TelegramSvg />
        </SocialIcon>
      ),
    },
    {
      key: "more",
      label: "More",
      onClick: nativeShare,
      node: (
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-2 text-foreground ring-1 ring-border">
          <Share2 className="h-6 w-6" />
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="flex flex-col items-center text-center">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-primary">
          <Check className="h-7 w-7" />
        </div>
        <h2 className="mt-3 font-display text-2xl font-bold text-foreground">
          Link Generated Successfully!
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Share your link anywhere — earn on every sale.
        </p>
      </div>

      <div className="mt-5 flex items-center gap-2 rounded-full bg-surface-2 pl-5 pr-2 py-2 ring-1 ring-border">
        <input
          readOnly
          value={link}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground focus:outline-none"
        />
        <button
          type="button"
          onClick={handleCopy}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-foreground transition hover:bg-surface-2"
          aria-label="Copy link"
        >
          {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>

      <div className="mt-5 -mx-6 px-6">
        <div className="flex gap-4 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              className="flex w-16 shrink-0 flex-col items-center gap-1.5 text-center"
            >
              {a.node}
              <span className="text-mini font-medium leading-tight text-foreground">{a.label}</span>
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onCreateAnother}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-surface-2 px-4 py-3 text-sm font-semibold text-foreground ring-1 ring-border transition hover:bg-surface"
      >
        Create another link
      </button>
    </>
  );
}

export function CollectionPicker({
  product,
  onDone,
}: {
  product: CreatedProduct;
  onDone: (collectionId: string) => void;
}) {
  const qc = useQueryClient();
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState("");

  const { data: collections = [], isLoading } = useQuery({
    queryKey: ["picker-collections", product.storefront_id],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data, error } = await supabase
        .from("collections")
        .select("id,name,cover_image_url,cover_color")
        .eq("storefront_id", product.storefront_id)
        .eq("user_id", userId)
        .is("hidden_from_storefront_at", null)
        .order("position", { ascending: true });
      if (error) throw error;
      return data as {
        id: string;
        name: string;
        cover_image_url: string | null;
        cover_color: string | null;
      }[];
    },
  });

  const attach = useMutation({
    mutationFn: async (collectionId: string) => {
      const { error } = await supabase
        .from("storefront_products")
        .update({ collection_id: collectionId })
        .eq("id", product.id);
      if (error) throw error;
      return collectionId;
    },
    onSuccess: (collectionId) => {
      qc.invalidateQueries({ queryKey: ["storefront-products"] });
      qc.invalidateQueries({ queryKey: ["collection-products"] });
      toast.success("Added to collection");
      onDone(collectionId);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createAndAttach = useMutation({
    mutationFn: async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Collection name required");
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) throw new Error("Not signed in");
      const slug = `${
        trimmed
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40) || "collection"
      }-${Math.random().toString(36).slice(2, 5)}`;
      const { data: inserted, error } = await supabase
        .from("collections")
        .insert({
          user_id: userId,
          storefront_id: product.storefront_id,
          name: trimmed,
          slug,
          source: "manual",
          position: collections.length,
        })
        .select("id")
        .single();
      if (error) throw error;
      const { error: upErr } = await supabase
        .from("storefront_products")
        .update({ collection_id: inserted.id })
        .eq("id", product.id);
      if (upErr) throw upErr;
      return inserted.id as string;
    },
    onSuccess: (collectionId) => {
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["storefront-products"] });
      qc.invalidateQueries({ queryKey: ["collection-products"] });
      toast.success("Collection created");
      onDone(collectionId);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pending = attach.isPending || createAndAttach.isPending;

  function handleDone() {
    if (creatingNew) {
      if (!newName.trim()) {
        toast.error("Give your collection a name");
        return;
      }
      createAndAttach.mutate(newName);
      return;
    }
    if (!selectedId) {
      toast.error("Pick a collection first");
      return;
    }
    attach.mutate(selectedId);
  }

  return (
    <div className="flex flex-col">
      <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
      <h2 className="font-display text-xl font-bold text-foreground">Add to a collection</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick where this product should live on your storefront.
      </p>

      {isLoading ? (
        <div className="mt-5 grid place-items-center py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="mt-5 max-h-[52vh] overflow-y-auto -mx-1 px-1 pb-1">
          <div className="grid grid-cols-2 gap-3">
            {collections.map((c) => {
              const active = selectedId === c.id && !creatingNew;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setCreatingNew(false);
                    setSelectedId(c.id);
                  }}
                  className={`group relative overflow-hidden rounded-2xl border bg-surface text-left transition disabled:opacity-60 ${
                    active
                      ? "border-primary ring-2 ring-primary shadow-elevate"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <div
                    className="relative aspect-square w-full"
                    style={{
                      background: c.cover_color ?? "linear-gradient(135deg,#E60023,#F5E1D5)",
                    }}
                  >
                    {c.cover_image_url ? (
                      <img
                        src={c.cover_image_url}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : null}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                    <div className="absolute inset-x-3 bottom-2 text-white">
                      <p className="truncate text-sm font-semibold">{c.name}</p>
                    </div>
                    {active && (
                      <div className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm">
                        <Check className="h-3.5 w-3.5" />
                      </div>
                    )}
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setSelectedId(null);
                setCreatingNew(true);
              }}
              className={`group relative flex aspect-square flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 border-dashed text-center transition disabled:opacity-60 ${
                creatingNew
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border bg-surface-2/40 text-muted-foreground hover:border-primary/60 hover:text-foreground"
              }`}
            >
              <div className="grid h-10 w-10 place-items-center rounded-full bg-background text-current ring-1 ring-border">
                <Plus className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold">New collection</span>
            </button>
          </div>
        </div>
      )}

      {creatingNew && (
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Collection name (e.g. Fall picks)"
          className="mt-4 w-full rounded-full bg-surface-2 px-5 py-3 text-sm text-foreground placeholder:text-muted-foreground ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-primary"
        />
      )}

      <button
        type="button"
        onClick={handleDone}
        disabled={pending || (!creatingNew && !selectedId) || (creatingNew && !newName.trim())}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition disabled:opacity-60"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        Done
      </button>
    </div>
  );
}

function SocialIcon({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div
      className="grid h-14 w-14 place-items-center rounded-2xl text-white"
      style={{ background: bg }}
    >
      {children}
    </div>
  );
}

function WhatsAppSvg() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor" aria-hidden>
      <path d="M20.52 3.48A11.86 11.86 0 0 0 12.02 0C5.42 0 .06 5.36.06 11.96c0 2.11.55 4.17 1.6 5.99L0 24l6.2-1.62a11.94 11.94 0 0 0 5.82 1.48h.01c6.6 0 11.96-5.36 11.96-11.96 0-3.2-1.25-6.2-3.47-8.42ZM12.03 21.8h-.01a9.83 9.83 0 0 1-5.01-1.37l-.36-.21-3.68.96.98-3.59-.23-.37a9.82 9.82 0 0 1-1.51-5.26c0-5.44 4.43-9.87 9.88-9.87 2.64 0 5.12 1.03 6.99 2.9a9.82 9.82 0 0 1 2.89 6.98c0 5.45-4.43 9.83-9.94 9.83Zm5.42-7.36c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15s-.77.97-.94 1.17c-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.64-2.05-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51l-.57-.01c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.9 1.22 3.1.15.2 2.1 3.2 5.1 4.49.71.31 1.27.5 1.7.64.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35Z" />
    </svg>
  );
}

function InstagramSvg() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-7 w-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PinterestSvg() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor" aria-hidden>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738.098.119.112.223.083.345-.09.375-.293 1.194-.333 1.361-.053.219-.174.265-.402.16-1.499-.698-2.436-2.888-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.379l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0Z" />
    </svg>
  );
}

function FacebookSvg() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor" aria-hidden>
      <path d="M13.5 22v-8h2.7l.4-3.2h-3.1V8.7c0-.9.26-1.55 1.56-1.55h1.66V4.28c-.29-.04-1.28-.13-2.44-.13-2.41 0-4.06 1.47-4.06 4.17v2.48H7.5V14h2.72v8h3.28Z" />
    </svg>
  );
}

function XSvg() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden>
      <path d="M18.244 2H21.5l-7.55 8.63L23 22h-6.914l-5.41-6.86L4.5 22H1.244l8.08-9.24L1 2h7.086l4.89 6.28L18.244 2Zm-2.42 18h1.914L7.28 4H5.27l10.554 16Z" />
    </svg>
  );
}

function TelegramSvg() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor" aria-hidden>
      <path d="M9.78 15.27 9.6 19c.36 0 .52-.15.7-.34l1.68-1.6 3.48 2.55c.64.35 1.1.17 1.27-.59l2.3-10.78c.22-1-.36-1.4-.98-1.17L4.4 12.36c-.98.4-.97.94-.17 1.19l3.6 1.12 8.36-5.27c.4-.25.75-.11.46.14L9.78 15.27Z" />
    </svg>
  );
}
