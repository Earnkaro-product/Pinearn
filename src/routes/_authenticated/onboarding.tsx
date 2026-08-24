import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { getFriendlyMessage } from "@/lib/friendly-error";
import { hasRealName, opaqueHandle, storefrontSlugFor } from "@/lib/creator-name";
import {
  CheckCircle2,
  ArrowRight,
  Ban,
  BarChart3,
  ChevronRight,
  Eye,
  Loader2,
  PencilLine,
  ShieldCheck,
  Layers,
  User,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { syncPinterestAccount } from "@/lib/pinterest-sync.functions";
import { PinterestSyncModal, type SyncStatus } from "@/components/pinterest-sync-modal";
import { PinterestFailureNotice } from "@/components/pinterest-gate";
import { usePinterestConnect } from "@/hooks/use-pinterest-connect";

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
    // A taken slug is the one predictable failure — two creators called Priya —
    // and it is now a real unique-index violation rather than a silent duplicate
    // (20260818140000_storefront_slug_unique.sql). Step down through suffixed
    // forms; the last one is derived from the user id, so it cannot collide.
    if (error) {
      const suffixed = `${slug}-${opaqueHandle(userId, 4)}`;
      const { error: retryError } = await supabase
        .from("storefronts")
        .update({ ...patch, slug: suffixed })
        .eq("id", store.id);
      if (retryError) {
        await supabase
          .from("storefronts")
          .update({ ...patch, slug: `shop-${opaqueHandle(userId)}` })
          .eq("id", store.id);
      }
    }
  } catch {
    /* non-fatal — the name is editable from the storefront screen */
  }
}

function OnboardingPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const runSync = useServerFn(syncPinterestAccount);
  // Authorization lives in one hook so its failure survives on screen with a
  // Retry attached, instead of a toast that fades and leaves a dead button.
  const { connect, connecting: authorizing, failure: authFailure } = usePinterestConnect();

  const [userId, setUserId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(search.connected === "1" ? "sync" : "name");
  const [skipping, setSkipping] = useState(false);
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
  /** Why a successful import can still show zero pins — shown inside the sheet
   *  rather than toasted over it. */
  const [syncNote, setSyncNote] = useState<string | null>(null);

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
      notifyDone("Pinterest connected");
      setTimeout(() => startSync(), 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveName(e?: React.FormEvent) {
    e?.preventDefault();
    if (!userId) return;
    const trimmed = name.trim();
    if (trimmed.length < 2) return notifyProblem("Please enter your name");
    setSavingName(true);
    const { error } = await supabase
      .from("profiles")
      .update({ display_name: trimmed })
      .eq("id", userId);
    if (error) {
      setSavingName(false);
      return notifyProblem(getFriendlyMessage(error));
    }
    await renameStorefront(userId, trimmed);
    setSavingName(false);
    setPhase("authorize");
  }

  async function authorizePinterest() {
    if (!userId) return;
    await connect("/onboarding");
  }

  /**
   * Leave onboarding without connecting Pinterest.
   *
   * All this writes is `onboarding_completed` — `pinterest_connected` stays
   * false, which is now a perfectly valid state to be in. It is the whole reason
   * the `_authenticated` guard no longer checks for a Pinterest connection: with
   * that check in place this update was pointless, because the very next
   * navigation redirected straight back here.
   *
   * Then a HARD navigation to Home. The guard runs in `beforeLoad`, so it has to
   * re-read the profile row it just cached — a soft push can land back on this
   * screen with the pre-skip snapshot.
   *
   * A failed write is the one case where skipping must not pretend to work: the
   * flag wouldn't stick and the creator would be sent here again on the next
   * boot, so it says so instead of navigating.
   */
  async function skipOnboarding() {
    if (!userId || skipping) return;
    setSkipping(true);
    const { error } = await supabase
      .from("profiles")
      .update({ onboarding_completed: true })
      .eq("id", userId);
    if (error) {
      setSkipping(false);
      notifyProblem(getFriendlyMessage(error));
      return;
    }
    // Whatever name was typed but not submitted is still worth keeping.
    const trimmed = name.trim();
    if (trimmed.length >= 2) {
      await supabase.from("profiles").update({ display_name: trimmed }).eq("id", userId);
      await renameStorefront(userId, trimmed);
    }
    // Same again: the banner on the dashboard is where "Pinterest isn't
    // connected" belongs, and it survives longer than 2.5 seconds.
    window.location.href = "/dashboard";
  }

  async function startSync() {
    setSyncOpen(true);
    setSyncStatus("running");
    setSyncError(null);
    setSyncResult(null);
    setSyncNote(null);
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
      // like one — so the sheet showing the zero says which it is. This was a
      // toast stacked on top of the sheet, competing with the numbers it was
      // there to explain.
      setSyncNote(
        landed === 0 && r.pins.savedSkipped > 0
          ? `All ${r.pins.savedSkipped} ${r.pins.savedSkipped === 1 ? "Pin" : "Pins"} on your boards were saved from other people. ShopMyPin works on Pins you created — make one on Pinterest, then sync again.`
          : null,
      );
      setSyncStatus("success");
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed");
      setSyncStatus("error");
    }
  }

  /**
   * The import failed, but the connection itself is fine — go in anyway.
   *
   * Without this the failed-import sheet offered only "Retry sync" and
   * "Cancel", and Cancel dropped the creator back onto the authorize card with
   * its button already reading "Pinterest connected" and no way onward. The data
   * isn't lost by continuing: every screen inside the app re-syncs on its own,
   * and the sync banner offers the same retry from Home.
   */
  async function continueWithoutImport() {
    if (!userId) return;
    await supabase.from("profiles").update({ onboarding_completed: true }).eq("id", userId);
    setSyncOpen(false);
    // Nothing announced here: `window.location.href` tears the page down before
    // a toast can paint, and the dashboard's Pinterest banner already reports an
    // un-imported connection for as long as it's true.
    window.location.href = "/dashboard";
  }

  async function finishOnboarding() {
    if (!userId) return;
    await supabase.from("profiles").update({ onboarding_completed: true }).eq("id", userId);
    setSyncOpen(false);
    setPhase("done");
    // Show the syncing loader for a moment before entering the dashboard
    await new Promise((r) => setTimeout(r, 2200));
    // No "All set" toast on arrival. The creator has just watched a full-screen
    // sync animation and dismissed a sheet that reported the boards and pins it
    // imported; a third confirmation, landing on top of a dashboard that is
    // itself the evidence, told them nothing they hadn't just read twice.
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
        {/* The pill up here used to read "Required", with a padlock, and it was
            the most load-bearing lie on the screen: nothing on this flow is
            required to use the product. It is now the top-level way out — the
            same skip as the one below the connect button, in the corner where a
            skip is looked for. Present on the name step too, because a creator
            who wants in should not have to answer two screens first; a name
            typed but not submitted is carried over anyway (see skipOnboarding). */}
        <div className="mb-6 flex items-center gap-2">
          <img src="/shopmypin-logo.png" alt="" draggable={false} className="h-8 w-8" />
          <span className="font-display text-lg font-semibold">ShopMyPin</span>
          <button
            type="button"
            onClick={skipOnboarding}
            disabled={skipping || !userId}
            className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-full border border-border bg-surface px-3 text-mini font-semibold text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-60"
          >
            {skipping ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {skipping ? "Skipping…" : "Skip for now"}
            {!skipping && <ChevronRight className="h-3 w-3" />}
          </button>
        </div>

        {phase === "name" ? (
          <div className="rounded-3xl border border-border bg-surface/85 p-8 shadow-elevate backdrop-blur-xl">
            <div className="flex items-center gap-4">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-primary text-primary-foreground shadow-glow">
                <User className="h-6 w-6" />
              </div>
              <div>
                <h1 className="font-display text-2xl font-semibold leading-tight">
                  Hey, what's your name?
                </h1>
                {/* Says what the name is FOR. "Shown on your storefront" assumed
                    the creator already knew they were getting a storefront —
                    this is the screen before they've seen one. */}
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Your digital shop will be named after you.
                </p>
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

              {/* The failure, kept on screen. A connection that fails at this
                  step used to leave a toast and a button that looked untouched,
                  which reads as "nothing happened" — the one thing it must never
                  read as. Retry restarts the same authorization; skipping stays
                  available underneath, so a Pinterest outage can't wall a new
                  creator out of the product entirely. */}
              {authFailure && phase === "authorize" && (
                <PinterestFailureNotice
                  className="mt-4"
                  failure={authFailure}
                  onRetry={authorizePinterest}
                  retrying={authorizing}
                  secondary={
                    <button
                      type="button"
                      onClick={skipOnboarding}
                      disabled={skipping || !userId}
                      className="inline-flex min-h-9 items-center rounded-full border border-border bg-surface px-4 text-xs font-semibold text-muted-foreground transition hover:text-foreground disabled:opacity-60"
                    >
                      {skipping ? "Skipping…" : "Skip for now"}
                    </button>
                  }
                />
              )}

              {phase === "authorize" && (
                <button
                  type="button"
                  onClick={skipOnboarding}
                  disabled={skipping || !userId}
                  className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-2xl px-4 py-3 text-sm font-semibold text-muted-foreground transition hover:text-foreground disabled:opacity-60"
                >
                  {skipping ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {skipping ? "Taking you in…" : "Skip — I'll connect later"}
                </button>
              )}

              {phase === "authorize" && (
                <p className="mt-1 text-center text-xs leading-snug text-muted-foreground">
                  You can look around the whole app without this. We'll ask again — and only ask —
                  when you do something that touches your Pinterest account.
                </p>
              )}

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
        note={syncNote}
        onClose={() => {
          if (syncStatus === "success") finishOnboarding();
          else setSyncOpen(false);
        }}
        onRetry={() => {
          setSyncStatus("idle");
          startSync();
        }}
        onContinue={continueWithoutImport}
        continueLabel="Continue to Home"
      />
    </div>
  );
}
