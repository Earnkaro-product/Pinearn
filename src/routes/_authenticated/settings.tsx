import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { AppShell } from "@/components/app-shell";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { disconnectPinterest } from "@/lib/pinterest-oauth.functions";
import { usePinterestConnect } from "@/hooks/use-pinterest-connect";
import { PinterestFailureNotice } from "@/components/pinterest-gate";
import { applyTheme } from "@/lib/theme";
import {
  Bell,
  Moon,
  Sun,
  Trash2,
  LogOut,
  ShieldCheck,
  Loader2,
  Link2,
  Link2Off,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

type Prefs = {
  notifications: boolean;
  weeklyDigest: boolean;
  theme: "light" | "dark";
};

const DEFAULTS: Prefs = { notifications: true, weeklyDigest: true, theme: "light" };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem("pinearn.prefs");
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function SettingsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const runDisconnect = useServerFn(disconnectPinterest);
  const {
    connect,
    connecting,
    failure: connectFailure,
    reset: clearFailure,
  } = usePinterestConnect();
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [connected, setConnected] = useState(false);
  const [pinterestUsername, setPinterestUsername] = useState("");
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      setUserId(u.user.id);
      setEmail(u.user.email ?? "");
      const { data: p } = await supabase
        .from("profiles")
        .select("pinterest_connected, pinterest_username")
        .eq("id", u.user.id)
        .maybeSingle();
      if (p) {
        setConnected(!!p.pinterest_connected);
        setPinterestUsername(p.pinterest_username ?? "");
      }
    })();
    if (new URLSearchParams(window.location.search).get("connected") === "1") {
      notifyDone("Pinterest connected");
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  function update(patch: Partial<Prefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    localStorage.setItem("pinearn.prefs", JSON.stringify(next));
    // Shared with the root, which re-applies this on every boot.
    if (patch.theme) applyTheme(patch.theme);
    notifyDone("Saved");
  }

  async function togglePinterest() {
    if (!userId) return;
    setBusy(true);
    try {
      if (connected) {
        await runDisconnect();
        setConnected(false);
        setPinterestUsername("");
        notifyDone("Pinterest disconnected");
      } else {
        // The failure lands under the row with a Retry (see below), so a
        // connection that can't start doesn't just flash a toast on a settings
        // screen the creator is likely to walk away from.
        await connect("/settings");
        return; // navigating away, unless it failed
      }
    } catch (e) {
      notifyProblem(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  async function deleteAccount() {
    if (!userId) return;
    const ok = window.confirm(
      "Delete your account? This clears your profile data and signs you out.",
    );
    if (!ok) return;
    setBusy(true);
    await supabase
      .from("profiles")
      .update({
        display_name: null,
        avatar_url: null,
        pinterest_connected: false,
        pinterest_username: null,
        onboarding_completed: false,
      })
      .eq("id", userId);
    setBusy(false);
    notifyDone("Account data cleared");
    await signOut();
  }

  return (
    <AppShell title="Settings" backButton backTo="/dashboard">
      <div className="mx-auto max-w-2xl space-y-4">
        <Section title="Account">
          <Row label={email || "Signed in"} sub="Signed in with phone OTP">
            <ShieldCheck className="h-4 w-4 text-accent" />
          </Row>
        </Section>

        <Section title="Pinterest">
          <Row
            label={
              connected
                ? `Connected${pinterestUsername ? ` · @${pinterestUsername}` : ""}`
                : "Not connected"
            }
            sub={connected ? "Syncs automatically" : "Sync your boards and pins"}
          >
            <button
              onClick={togglePinterest}
              disabled={busy || connecting}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition disabled:opacity-60 ${
                connected
                  ? "border border-border bg-surface hover:bg-surface-2"
                  : "bg-gradient-primary text-primary-foreground shadow-glow"
              }`}
            >
              {busy || connecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : connected ? (
                <Link2Off className="h-3.5 w-3.5" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              {connected ? "Disconnect" : "Connect"}
            </button>
          </Row>
          {connectFailure && (
            <PinterestFailureNotice
              failure={connectFailure}
              onRetry={togglePinterest}
              retrying={connecting}
              secondary={
                <button
                  type="button"
                  onClick={clearFailure}
                  className="inline-flex min-h-9 items-center rounded-full border border-border bg-surface px-4 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
                >
                  Dismiss
                </button>
              }
            />
          )}
        </Section>

        <Section title="Notifications">
          <Toggle
            icon={Bell}
            label="Push notifications"
            sub="Sales, clicks, and new followers"
            checked={prefs.notifications}
            onChange={(v) => update({ notifications: v })}
          />
          <Toggle
            icon={Bell}
            label="Weekly digest email"
            sub="Every Monday at 9am"
            checked={prefs.weeklyDigest}
            onChange={(v) => update({ weeklyDigest: v })}
          />
        </Section>

        <Section title="Appearance">
          <Toggle
            // No sub-line: a switch labelled "Dark mode" doesn't need a sentence
            // explaining what dark mode is for.
            icon={prefs.theme === "dark" ? Moon : Sun}
            label="Dark mode"
            checked={prefs.theme === "dark"}
            onChange={(v) => update({ theme: v ? "dark" : "light" })}
          />
        </Section>

        <Section title="Danger zone">
          <button
            onClick={signOut}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-3 text-sm font-medium hover:bg-surface-2"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
          <button
            onClick={deleteAccount}
            disabled={busy}
            className="flex w-full items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive hover:bg-destructive/15 disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" /> Delete account
          </button>
        </Section>
      </div>
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/85 p-4 shadow-elevate">
      <div className="mb-3 text-mini font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  icon: Icon,
  label,
  sub,
  checked,
  onChange,
}: {
  icon: any;
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 rounded-xl bg-surface-2 p-3 text-left"
    >
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
      </div>
      <div
        className={`relative h-6 w-11 rounded-full transition ${
          checked ? "bg-primary" : "bg-border"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </div>
    </button>
  );
}
