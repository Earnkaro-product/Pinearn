import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { getFriendlyMessage } from "@/lib/friendly-error";
import {
  CheckCircle2,
  ArrowRight,
  Loader2,
  ShieldCheck,
  Lock,
  Layers,
  Image as ImageIcon,
  Sparkles,
  User,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { syncPinterestAccount } from "@/lib/pinterest-sync.functions";
import { startPinterestOAuth } from "@/lib/pinterest-oauth.functions";
import { PinterestSyncModal, type SyncStatus } from "@/components/pinterest-sync-modal";

const searchSchema = z.object({
  connected: z.coerce.string().optional(),
});

export const Route = createFileRoute("/_authenticated/onboarding")({
  validateSearch: (s) => searchSchema.parse(s),
  component: OnboardingPage,
});

type Phase = "name" | "authorize" | "sync" | "done";

function PinterestIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0a12 12 0 0 0-4.37 23.17c-.1-.94-.2-2.4.04-3.44.22-.94 1.4-6 1.4-6s-.36-.72-.36-1.78c0-1.67.97-2.92 2.17-2.92 1.02 0 1.52.77 1.52 1.7 0 1.03-.66 2.58-1 4.02-.28 1.2.6 2.18 1.79 2.18 2.15 0 3.8-2.27 3.8-5.54 0-2.9-2.08-4.93-5.05-4.93-3.44 0-5.46 2.58-5.46 5.25 0 1.04.4 2.15.9 2.76a.36.36 0 0 1 .08.35c-.09.36-.28 1.13-.32 1.29-.05.21-.17.26-.4.16-1.5-.7-2.44-2.88-2.44-4.64 0-3.78 2.75-7.25 7.92-7.25 4.16 0 7.38 2.96 7.38 6.92 0 4.13-2.6 7.46-6.22 7.46-1.22 0-2.36-.63-2.75-1.38 0 0-.6 2.3-.75 2.86-.27 1.04-1 2.35-1.5 3.14A12 12 0 1 0 12 0z" />
    </svg>
  );
}

/**
 * Has this creator actually told us their name?
 *
 * Sign-up seeds `display_name` with the phone number (see auth.tsx:
 * `options: { data: { display_name: phone } }`), so a non-empty display_name is
 * NOT the same as a name the user chose — every brand-new account already has
 * one. Checking only for non-empty is what skipped the name step for new users.
 * A real name contains at least one letter; "+918619596704" doesn't.
 */
function hasRealName(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length >= 2 && /\p{L}/u.test(v);
}

function OnboardingPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const runSync = useServerFn(syncPinterestAccount);
  const runStartOAuth = useServerFn(startPinterestOAuth);

  const [userId, setUserId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(search.connected === "1" ? "sync" : "name");
  const [authorizing, setAuthorizing] = useState(false);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);

  // Sync modal state
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncResult, setSyncResult] = useState<{
    boardsCreated: number;
    pinsCreated: number;
  } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      setUserId(data.user.id);
      // Someone who already told us their name — a returning creator reconnecting
      // Pinterest, say — shouldn't be asked for it again on the way back in.
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", data.user.id)
        .maybeSingle();
      const existing = profile?.display_name?.trim();
      if (hasRealName(existing)) {
        setName(existing!);
        setPhase((p) => (p === "name" ? "authorize" : p));
      }
    });
    if (search.connected === "1") {
      toast.success("Pinterest connected");
      setTimeout(() => startSync(), 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveName(e?: React.FormEvent) {
    e?.preventDefault();
    if (!userId) return;
    const trimmed = name.trim();
    if (trimmed.length < 2) return toast.error("Please enter your name");
    setSavingName(true);
    const { error } = await supabase
      .from("profiles")
      .update({ display_name: trimmed })
      .eq("id", userId);
    setSavingName(false);
    if (error) return toast.error(getFriendlyMessage(error));
    setPhase("authorize");
  }

  async function authorizePinterest() {
    if (!userId) return;
    setAuthorizing(true);
    try {
      const { url } = await runStartOAuth({ data: { returnTo: "/onboarding" } });
      window.location.href = url;
    } catch (e) {
      setAuthorizing(false);
      toast.error(e instanceof Error ? e.message : "Couldn't start the Pinterest connection");
    }
  }

  async function startSync() {
    setSyncOpen(true);
    setSyncStatus("running");
    setSyncError(null);
    setSyncResult(null);
    try {
      const r = await runSync({ data: { analytics: true } });
      if (!r.ok) {
        setSyncError(
          r.needsReconnect
            ? "Pinterest's access expired before we could import. Connect it again to finish."
            : (r.error ?? "Sync failed"),
        );
        setSyncStatus("error");
        return;
      }
      // The modal counts what landed: fresh imports plus anything that was
      // already here and got refreshed from Pinterest.
      const landed = r.pins.created + r.pins.updated + r.pins.rehomed;
      setSyncResult({
        boardsCreated: r.boards.created + r.boards.updated,
        pinsCreated: landed,
      });
      // "0 pins" with a board full of saves isn't a failure, but it looks exactly
      // like one — say which it is.
      if (landed === 0 && r.pins.savedSkipped > 0) {
        toast.info(
          `Found ${r.pins.savedSkipped} saved ${r.pins.savedSkipped === 1 ? "pin" : "pins"} on your boards. Pinearn works on pins you created — create one on Pinterest and sync again.`,
          { duration: 8000 },
        );
      }
      setSyncStatus("success");
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed");
      setSyncStatus("error");
    }
  }

  async function finishOnboarding() {
    if (!userId) return;
    await supabase.from("profiles").update({ onboarding_completed: true }).eq("id", userId);
    setSyncOpen(false);
    setPhase("done");
    // Show the syncing loader for a moment before entering the dashboard
    await new Promise((r) => setTimeout(r, 2200));
    toast.success("You're all set");
    navigate({ to: "/dashboard" });
  }

  if (phase === "done") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background px-6 text-center">
        {/* Animated gradient blobs */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-blob absolute -left-20 -top-20 h-96 w-96 rounded-full bg-primary/20 blur-[100px]" />
          <div className="animate-blob-delay-2 absolute -right-20 top-1/4 h-80 w-80 rounded-full bg-accent/25 blur-[90px]" />
          <div className="animate-blob-delay-4 absolute bottom-0 left-1/3 h-[28rem] w-[28rem] rounded-full bg-chart-5/15 blur-[120px]" />
          <div className="animate-blob absolute bottom-1/4 right-1/4 h-64 w-64 rounded-full bg-primary/10 blur-[80px]" />
        </div>

        {/* Subtle dot pattern overlay */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage: `radial-gradient(circle, var(--foreground) 1px, transparent 1px)`,
            backgroundSize: `32px 32px`,
          }}
        />

        {/* Floating decorative shapes */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-float absolute left-[8%] top-[15%] h-4 w-4 rotate-45 rounded-sm bg-primary/30" />
          <div className="animate-float-delay absolute right-[12%] top-[22%] h-3 w-3 rounded-full bg-accent/40" />
          <div className="animate-float absolute left-[15%] bottom-[20%] h-5 w-5 rounded-lg bg-chart-5/25" />
          <div className="animate-float-delay absolute right-[18%] bottom-[18%] h-3.5 w-3.5 rotate-12 rounded-md bg-primary/25" />
          <div className="animate-float absolute left-[35%] top-[8%] h-2 w-2 rounded-full bg-accent/30" />
          <div className="animate-float-delay absolute right-[30%] bottom-[12%] h-2.5 w-2.5 rotate-45 rounded-sm bg-chart-5/30" />
        </div>

        {/* Mesh gradient overlay for depth */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 80% 50% at 50% -20%, oklch(0.72 0.16 45 / 0.12), transparent), radial-gradient(ellipse 60% 40% at 80% 80%, oklch(0.55 0.23 25 / 0.08), transparent)`,
          }}
        />
        <div className="relative mb-8">
          <div className="absolute inset-0 animate-ping rounded-full bg-primary/30" />
          <div className="relative grid h-20 w-20 place-items-center rounded-full bg-primary text-primary-foreground shadow-glow">
            <PinterestIcon className="h-9 w-9" />
          </div>
        </div>
        <h2 className="font-display text-2xl font-semibold">Syncing your Pinterest…</h2>
        <p className="mt-2 max-w-xs text-sm text-muted-foreground">
          Importing your boards & pins and building your storefront. Hang tight.
        </p>
        <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Preparing your dashboard
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      {/* Animated gradient blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob absolute -left-20 -top-20 h-96 w-96 rounded-full bg-primary/20 blur-[100px]" />
        <div className="animate-blob-delay-2 absolute -right-20 top-1/4 h-80 w-80 rounded-full bg-accent/25 blur-[90px]" />
        <div className="animate-blob-delay-4 absolute bottom-0 left-1/3 h-[28rem] w-[28rem] rounded-full bg-chart-5/15 blur-[120px]" />
        <div className="animate-blob absolute bottom-1/4 right-1/4 h-64 w-64 rounded-full bg-primary/10 blur-[80px]" />
      </div>

      {/* Subtle dot pattern overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage: `radial-gradient(circle, var(--foreground) 1px, transparent 1px)`,
          backgroundSize: `32px 32px`,
        }}
      />

      {/* Floating decorative shapes */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-float absolute left-[8%] top-[15%] h-4 w-4 rotate-45 rounded-sm bg-primary/30" />
        <div className="animate-float-delay absolute right-[12%] top-[22%] h-3 w-3 rounded-full bg-accent/40" />
        <div className="animate-float absolute left-[15%] bottom-[20%] h-5 w-5 rounded-lg bg-chart-5/25" />
        <div className="animate-float-delay absolute right-[18%] bottom-[18%] h-3.5 w-3.5 rotate-12 rounded-md bg-primary/25" />
        <div className="animate-float absolute left-[35%] top-[8%] h-2 w-2 rounded-full bg-accent/30" />
        <div className="animate-float-delay absolute right-[30%] bottom-[12%] h-2.5 w-2.5 rotate-45 rounded-sm bg-chart-5/30" />
      </div>

      {/* Mesh gradient overlay for depth */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 80% 50% at 50% -20%, oklch(0.72 0.16 45 / 0.12), transparent), radial-gradient(ellipse 60% 40% at 80% 80%, oklch(0.55 0.23 25 / 0.08), transparent)`,
        }}
      />
      <div className="mx-auto w-full max-w-md px-4 pt-8 sm:max-w-lg">
        <div className="mb-6 flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-primary shadow-glow">
            <span className="font-display text-sm font-bold text-primary-foreground">P</span>
          </div>
          <span className="font-display text-lg font-semibold">Pinearn</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
            <Lock className="h-3 w-3" /> Required
          </span>
        </div>

        {phase === "name" ? (
          <div className="rounded-3xl border border-border bg-surface/85 p-8 shadow-elevate backdrop-blur-xl">
            <div className="flex items-center gap-4">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-primary text-primary-foreground shadow-glow">
                <User className="h-6 w-6" />
              </div>
              <div>
                <h1 className="font-display text-2xl font-semibold leading-tight">
                  What's your name?
                </h1>
                <p className="text-sm text-muted-foreground">
                  We'll use this on your storefront and profile.
                </p>
              </div>
            </div>
            <form onSubmit={saveName} className="mt-6">
              <label className="mb-2 block text-base font-medium">Your name</label>
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                className="w-full rounded-2xl border-2 border-primary/40 bg-background px-5 py-4 text-base outline-none focus:border-primary"
              />
              <button
                type="submit"
                disabled={savingName}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-primary px-5 py-4 text-base font-semibold text-primary-foreground shadow-glow transition disabled:opacity-60"
              >
                {savingName ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                Continue
                {!savingName && <ArrowRight className="h-5 w-5" />}
              </button>
            </form>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-surface/85 p-6 shadow-elevate backdrop-blur-xl">
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-glow">
                <PinterestIcon className="h-5 w-5" />
              </div>
              <div>
                <h1 className="font-display text-xl font-semibold leading-tight">
                  Connect Pinterest to continue
                </h1>
                <p className="text-xs text-muted-foreground">
                  Pinearn only works when your Pinterest is linked & synced.
                </p>
              </div>
            </div>

            <ul className="mt-5 space-y-2.5 text-sm">
              <li className="flex items-start gap-2.5">
                <ShieldCheck className="mt-0.5 h-4 w-4 text-accent" />
                <span className="text-muted-foreground">
                  Secure OAuth — we never see your password.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <Layers className="mt-0.5 h-4 w-4 text-accent" />
                <span className="text-muted-foreground">
                  All your <span className="text-foreground font-medium">boards</span> become
                  collections in your store.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <ImageIcon className="mt-0.5 h-4 w-4 text-accent" />
                <span className="text-muted-foreground">
                  Every <span className="text-foreground font-medium">pin</span> is imported with
                  title, image & link.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <Sparkles className="mt-0.5 h-4 w-4 text-accent" />
                <span className="text-muted-foreground">
                  Attribute clicks & earnings back to each pin automatically.
                </span>
              </li>
            </ul>

            <button
              onClick={authorizePinterest}
              disabled={authorizing || phase !== "authorize"}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition hover:opacity-95 disabled:opacity-60"
            >
              {authorizing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : phase !== "authorize" ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <PinterestIcon />
              )}
              {phase === "authorize"
                ? authorizing
                  ? "Opening Pinterest…"
                  : "Continue with Pinterest"
                : "Pinterest connected"}
              {phase === "authorize" && !authorizing && <ArrowRight className="h-4 w-4" />}
            </button>

            {phase !== "authorize" && (
              <button
                onClick={startSync}
                disabled={syncStatus === "running"}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-4 py-2.5 text-sm font-medium transition hover:bg-surface-2 disabled:opacity-60"
              >
                {syncStatus === "running" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Layers className="h-4 w-4" />
                )}
                {syncStatus === "success" ? "Re-sync boards & pins" : "Sync boards & pins"}
              </button>
            )}

            <p className="mt-4 text-center text-[11px] text-muted-foreground">
              You can't skip this step — Pinearn needs Pinterest data to build your storefront.
            </p>
          </div>
        )}
      </div>

      <PinterestSyncModal
        open={syncOpen}
        status={syncStatus}
        result={syncResult}
        error={syncError}
        onClose={() => {
          if (syncStatus === "success") finishOnboarding();
          else setSyncOpen(false);
        }}
        onRetry={() => {
          setSyncStatus("idle");
          startSync();
        }}
      />
    </div>
  );
}
