import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { PinterestSyncBanner } from "@/components/pinterest-sync-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Save, User as UserIcon, ImagePlus, Link2 } from "lucide-react";
import { startPinterestOAuth } from "@/lib/pinterest-oauth.functions";
import { getFriendlyMessage } from "@/lib/friendly-error";

export const Route = createFileRoute("/_authenticated/profile")({
  // The Health Score "Complete Profile" action deep-links straight to the
  // specific missing field (avatar / Pinterest connection), not a generic page.
  validateSearch: (s: Record<string, unknown>): { focus?: "avatar" | "pinterest" } => ({
    focus: s.focus === "avatar" || s.focus === "pinterest" ? s.focus : undefined,
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const { focus } = Route.useSearch();
  const runStartOAuth = useServerFn(startPinterestOAuth);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [displayName, setDisplayName] = useState("");
  const [pinterestUsername, setPinterestUsername] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [connected, setConnected] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);

  // Deep-linked from the Health Score: jump straight to the missing field the
  // moment the form renders.
  useEffect(() => {
    if (loading || !focus) return;
    const el = focus === "avatar" ? avatarInputRef.current : connectButtonRef.current;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus();
  }, [loading, focus]);

  const { data: pinCount } = useQuery({
    queryKey: ["pin-count", userId],
    queryFn: async () => {
      const { count } = await supabase
        .from("pins")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId!)
        .eq("is_owner", true);
      return count ?? 0;
    },
    enabled: !!userId,
  });
  const { data: storefrontCount } = useQuery({
    queryKey: ["sf-count", userId],
    queryFn: async () => {
      const { count } = await supabase
        .from("storefronts")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId!);
      return count ?? 0;
    },
    enabled: !!userId,
  });

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      setUserId(u.user.id);
      setEmail(u.user.email ?? "");
      const { data: p } = await supabase
        .from("profiles")
        .select("display_name, avatar_url, pinterest_username, pinterest_connected")
        .eq("id", u.user.id)
        .maybeSingle();
      if (p) {
        setDisplayName(p.display_name ?? "");
        setPinterestUsername(p.pinterest_username ?? "");
        setAvatarUrl(p.avatar_url ?? "");
        setConnected(!!p.pinterest_connected);
      }
      setLoading(false);
    })();
    if (new URLSearchParams(window.location.search).get("connected") === "1") {
      toast.success("Pinterest connected");
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function save() {
    if (!userId) return;
    if (displayName.trim().length < 2) {
      setNameError("Enter your name (min 2 characters)");
      nameInputRef.current?.focus();
      return toast.error("Enter your name");
    }
    setNameError(null);
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        display_name: displayName.trim(),
        avatar_url: avatarUrl.trim() || null,
      })
      .eq("id", userId);
    setSaving(false);
    if (error) return toast.error(getFriendlyMessage(error));
    toast.success("Profile updated");
  }

  async function connectPinterest() {
    setConnecting(true);
    try {
      const { url } = await runStartOAuth({ data: { returnTo: "/profile" } });
      window.location.href = url;
    } catch (e) {
      setConnecting(false);
      toast.error(e instanceof Error ? e.message : "Couldn't start the Pinterest connection");
    }
  }

  const initials = (displayName || email || "?")
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <AppShell title="Profile" backButton backTo="/dashboard">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="rounded-2xl border border-border bg-surface/85 p-6 shadow-elevate">
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-full bg-primary text-primary-foreground shadow-glow">
              {avatarUrl ? (
                <img
                  key={avatarUrl}
                  src={avatarUrl}
                  alt=""
                  loading="lazy"
                  onLoad={() => setAvatarLoaded(true)}
                  className={`h-full w-full object-cover opacity-0 transition-opacity duration-300 ${
                    avatarLoaded ? "opacity-100" : ""
                  }`}
                />
              ) : (
                <span className="font-display text-xl font-bold">{initials}</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-xl font-semibold leading-tight">
                {displayName || "Your profile"}
              </h1>
              <p className="truncate text-xs text-muted-foreground">{email}</p>
              <span
                className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-mini font-medium ${
                  connected ? "bg-accent/15 text-accent" : "bg-muted text-muted-foreground"
                }`}
              >
                {connected ? "Pinterest connected" : "Pinterest not connected"}
              </span>
            </div>
          </div>

          {loading ? (
            <div className="mt-6 space-y-4">
              <div className="flex items-center gap-4">
                <Skeleton className="h-16 w-16 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-11 w-full rounded-xl" />
              <Skeleton className="h-11 w-full rounded-xl" />
              <Skeleton className="h-11 w-full rounded-2xl" />
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              <div>
                <Field label="Display name" icon={UserIcon}>
                  <input
                    ref={nameInputRef}
                    value={displayName}
                    onChange={(e) => {
                      setDisplayName(e.target.value);
                      setNameError(null);
                    }}
                    className="w-full bg-transparent py-2 text-sm outline-none"
                    placeholder="Your name"
                  />
                </Field>
                {nameError && (
                  <p className="mt-1 text-xs font-medium text-destructive">{nameError}</p>
                )}
              </div>
              {connected ? (
                <>
                  <Field label="Pinterest username" icon={UserIcon}>
                    <span className="w-full py-2 text-sm text-muted-foreground">
                      @{pinterestUsername || "connected"}
                    </span>
                  </Field>
                  {/* Connection health lives with the connection itself: what's
                      imported, how fresh it is, and the manual re-sync (or a
                      reconnect prompt when the token has died). */}
                  <PinterestSyncBanner />
                </>
              ) : (
                <button
                  ref={connectButtonRef}
                  onClick={connectPinterest}
                  disabled={connecting}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/5 px-4 py-3 text-sm font-semibold text-primary transition hover:bg-primary/10 disabled:opacity-60"
                >
                  {connecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="h-4 w-4" />
                  )}
                  Connect Pinterest
                </button>
              )}
              <Field label="Avatar URL" icon={ImagePlus}>
                <input
                  ref={avatarInputRef}
                  value={avatarUrl}
                  onChange={(e) => {
                    setAvatarUrl(e.target.value);
                    setAvatarLoaded(false);
                  }}
                  className="w-full bg-transparent py-2 text-sm outline-none"
                  placeholder="https://…"
                />
              </Field>

              <button
                onClick={save}
                disabled={saving}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save
              </button>
            </div>
          )}
        </div>

        {/* Account panel */}
        <Card>
          <CardHeader title="Account" />
          {/* No "Pinterest" row here — the badge under the avatar and the
              username field above are already two statements of the same
              connection state; a third made the page read as a form and a
              report of that form. */}
          <ul className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Row k="Pins created" v={fmt(pinCount ?? 0)} />
            <Row k="Storefronts" v={fmt(storefrontCount ?? 0)} />
            <Row k="Plan" v="Creator (Free)" />
          </ul>
        </Card>
      </div>
    </AppShell>
  );
}

function Field({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 rounded-xl border border-input bg-background px-3">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {children}
      </div>
    </label>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-border bg-surface p-5 ${className ?? ""}`}>
      {children}
    </div>
  );
}

function CardHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4 flex items-baseline justify-between">
      <h3 className="font-display text-base font-semibold">{title}</h3>
      {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium">{v}</span>
    </li>
  );
}

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toLocaleString();
}
