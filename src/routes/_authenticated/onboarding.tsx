import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { getFriendlyMessage } from "@/lib/friendly-error";
import { hasRealName, storefrontSlugFor } from "@/lib/creator-name";
import {
  CheckCircle2,
  ArrowRight,
  Ban,
  BarChart3,
  Eye,
  Loader2,
  PencilLine,
  ShieldCheck,
  Lock,
  Layers,
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

/* ============================================================================
   The permission disclosure.

   This screen is the ONLY place a creator is told, in their own language, what
   granting access actually means — Pinterest's own consent screen lists raw
   scopes ("Create, update or delete your public Pins") without saying why an app
   wants them, and an unexplained delete permission is exactly what makes someone
   abandon a connect flow.

   Each row below maps to a scope in `SCOPES` in src/lib/pinterest-api.ts. THAT
   CONSTANT IS THE SOURCE OF TRUTH: if a scope is added there, add a row here in
   the same commit. A disclosure that under-states what the app requests is worse
   than no disclosure, and it is the first thing an API access review checks.

   The "never" list is not marketing. Every line is enforced in code, and the
   file that enforces it is named so a reviewer — or the next engineer — can
   check the claim instead of trusting it.
   ========================================================================== */

const ACCESS_ITEMS = [
  {
    icon: Eye,
    // boards:read + pins:read
    title: "Your public boards and Pins",
    why: "To match products to them.",
  },
  {
    icon: BarChart3,
    // user_accounts:read
    title: "Your profile and Pin stats",
    why: "To show impressions, clicks and earnings.",
  },
  {
    icon: PencilLine,
    // boards:write + pins:write
    title: "Publish and edit Pins",
    why: "Only when you tap it here.",
  },
] as const;

/* The "never" list carries no explanatory sub-line on purpose: each title is
   already the whole claim, and a second sentence under it was re-stating the
   title in longer words. */
const NEVER_ITEMS = [
  "Secret and protected boards",
  "Pins you saved from other people",
  "Posting or messaging as you",
] as const;

/**
 * Carry the name the creator just typed onto their storefront.
 *
 * The storefront is created by a database trigger the instant the profile row
 * appears — which is BEFORE this screen runs — so it is named from whatever
 * display_name held then: the phone number. This screen's own caption promises
 * the name is "shown on your storefront", and until this function existed that
 * was simply untrue; every store stayed called "+917777777777", with the number
 * in its public URL.
 *
 * Only a placeholder store is renamed. A creator who has already picked a name in
 * Settings keeps it, and their slug is left alone — a live slug is a URL people
 * may have saved, so it is never rewritten out from under them once it is real.
 *
 * Best-effort: a failure here must not block onboarding, since the name is
 * editable later from the storefront screen.
 */
async function renameStorefront(userId: string, name: string) {
  try {
    const { data: store } = await supabase
      .from("storefronts")
      .select("id,name,slug")
      .eq("user_id", userId)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!store) return;
    // Placeholder = whatever the trigger derived from the phone number, or the
    // generic fallback. Anything else is a real choice and is left untouched.
    const isPlaceholder = !hasRealName(store.name) || store.name === "My Shop";
    if (!isPlaceholder) return;

    const slug = storefrontSlugFor(name, userId);
    const patch = {
      name,
      description: `Curated picks and affiliate links from ${name}`,
      slug,
    };
    const { error } = await supabase.from("storefronts").update(patch).eq("id", store.id);
    // A taken slug is the one predictable failure — two creators called Priya.
    // Retry once with a short id suffix rather than losing the rename.
    if (error) {
      await supabase
        .from("storefronts")
        .update({ ...patch, slug: `${slug}-${userId.slice(0, 4)}` })
        .eq("id", store.id);
    }
  } catch {
    /* non-fatal — the name is editable from the storefront screen */
  }
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
    if (error) {
      setSavingName(false);
      return toast.error(getFriendlyMessage(error));
    }
    await renameStorefront(userId, trimmed);
    setSavingName(false);
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
          `Found ${r.pins.savedSkipped} saved ${r.pins.savedSkipped === 1 ? "pin" : "pins"} on your boards. ShopMyPin works on Pins you created — create one on Pinterest and sync again.`,
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
        {/* One wait, one sentence. The heading, a paragraph and a spinner
            caption were three ways of saying "please hold". */}
        <h2 className="font-display text-2xl font-semibold">Syncing your Pinterest…</h2>
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Importing your boards and pins
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
      <div className="mx-auto w-full max-w-md px-4 pb-8 pt-8 sm:max-w-lg">
        <div className="mb-6 flex items-center gap-2">
          <img src="/shopmypin-logo.png" alt="" draggable={false} className="h-8 w-8" />
          <span className="font-display text-lg font-semibold">ShopMyPin</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-mini font-medium text-primary">
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
                <p className="text-sm text-muted-foreground">Shown on your storefront.</p>
              </div>
            </div>
            {/* No "Your name" label — the heading two lines up already asked
                the question, and the placeholder shows the shape of an answer. */}
            <form onSubmit={saveName} className="mt-6">
              <input
                type="text"
                aria-label="Your name"
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
          <div className="overflow-hidden rounded-3xl border border-border bg-surface/85 shadow-elevate backdrop-blur-xl">
            <div className="border-b border-border/70 p-6 pb-5">
              <div className="flex items-center gap-3.5">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-glow">
                  <PinterestIcon className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <h1 className="font-display text-xl font-semibold leading-tight">
                    Connect your Pinterest
                  </h1>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Exactly what this gives us.
                  </p>
                </div>
              </div>
            </div>

            {/* WHAT WE ACCESS. Pinterest's own consent screen lists the raw
                permissions with no reason attached, so "delete your public Pins"
                arrives cold. Naming the reason next to each one is the whole
                point of this section. */}
            <div className="p-6 pb-5">
              <h2 className="text-mini font-semibold uppercase tracking-wider text-muted-foreground">
                What ShopMyPin can access
              </h2>
              <ul className="mt-3.5 space-y-3.5">
                {ACCESS_ITEMS.map((item) => (
                  <li key={item.title} className="flex gap-3">
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <item.icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium leading-snug">{item.title}</span>
                      <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">
                        {item.why}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* WHAT WE NEVER TOUCH. The reassurance that actually decides it —
                and every line is enforced in code, not just promised. */}
            <div className="mx-6 mb-5 rounded-2xl border border-border bg-surface-2/70 p-4">
              <h2 className="flex items-center gap-1.5 text-mini font-semibold uppercase tracking-wider text-muted-foreground">
                <Ban className="h-3.5 w-3.5" /> What we never touch
              </h2>
              <ul className="mt-2.5 space-y-2">
                {NEVER_ITEMS.map((item) => (
                  <li key={item} className="flex items-center gap-2.5">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-accent" />
                    <span className="text-sm leading-snug">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="px-6 pb-6">
              {/* The specifics — third-party matching providers, token storage,
                  retention, revocation — live in the two documents rather than on
                  this screen. One line, both links. */}
              <p className="text-sm text-muted-foreground">
                More detail in our{" "}
                <Link
                  to="/privacy"
                  target="_blank"
                  className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                >
                  Privacy Policy
                </Link>{" "}
                and{" "}
                <Link
                  to="/terms"
                  target="_blank"
                  className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                >
                  Terms and Conditions
                </Link>
                .
              </p>

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
            </div>
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
