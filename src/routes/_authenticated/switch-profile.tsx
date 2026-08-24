import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { AppShell } from "@/components/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Plus, Users } from "lucide-react";

export const Route = createFileRoute("/_authenticated/switch-profile")({
  component: SwitchProfilePage,
});

type PinAccount = { id: string; handle: string; label?: string };

function readStore(primaryHandle?: string | null): {
  accounts: PinAccount[];
  activeId: string;
} {
  try {
    const raw = localStorage.getItem("pinearn.pinAccounts");
    if (raw) return JSON.parse(raw);
  } catch {
    /* corrupt/missing localStorage value — fall back to defaults */
  }
  return { accounts: [], activeId: "primary" };
}

function writeStore(data: { accounts: PinAccount[]; activeId: string }) {
  localStorage.setItem("pinearn.pinAccounts", JSON.stringify(data));
}

function SwitchProfilePage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [primary, setPrimary] = useState<{ handle: string; name: string } | null>(null);
  const [accounts, setAccounts] = useState<PinAccount[]>([]);
  const [activeId, setActiveId] = useState("primary");
  const [newHandle, setNewHandle] = useState("");

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (u.user) {
        const { data: p } = await supabase
          .from("profiles")
          .select("display_name, pinterest_username")
          .eq("id", u.user.id)
          .maybeSingle();
        setPrimary({
          handle: p?.pinterest_username ?? "your-pinterest",
          name: p?.display_name ?? "Primary",
        });
      }
      const stored = readStore();
      setAccounts(stored.accounts ?? []);
      setActiveId(stored.activeId ?? "primary");
      setLoading(false);
    })();
  }, []);

  function pick(id: string, handle: string) {
    setActiveId(id);
    writeStore({ accounts, activeId: id });
    // The chosen row gets the active treatment immediately — that IS the
    // confirmation, and unlike a toast it's still true a minute later.
  }

  function addAccount(e: React.FormEvent) {
    e.preventDefault();
    const h = newHandle.replace(/^@/, "").trim();
    if (h.length < 2) return notifyProblem("Enter a handle");
    if (accounts.some((a) => a.handle === h)) return notifyProblem("Already added");
    const id = crypto.randomUUID();
    const next = [...accounts, { id, handle: h }];
    setAccounts(next);
    setActiveId(id);
    writeStore({ accounts: next, activeId: id });
    setNewHandle("");
    notifyDone(`Added @${h}`);
  }

  function remove(id: string) {
    const next = accounts.filter((a) => a.id !== id);
    const nextActive = activeId === id ? "primary" : activeId;
    setAccounts(next);
    setActiveId(nextActive);
    writeStore({ accounts: next, activeId: nextActive });
    notifyDone("Removed");
  }

  const all: PinAccount[] = [
    {
      id: "primary",
      handle: primary?.handle ?? "your-pinterest",
      label: primary?.name ?? "Primary",
    },
    ...accounts,
  ];

  return (
    <AppShell title="Switch profile" backButton backTo="/dashboard">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="rounded-2xl border border-border bg-surface/85 p-5 shadow-elevate">
          <div className="mb-4 flex items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-primary text-primary-foreground shadow-glow">
              <Users className="h-4 w-4" />
            </div>
            <div>
              <div className="font-display text-lg font-semibold leading-tight">
                Pinterest profiles
              </div>
              <div className="text-xs text-muted-foreground">Which one powers your storefront</div>
            </div>
          </div>

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-3"
                >
                  <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-28 rounded-full" />
                    <Skeleton className="h-2.5 w-16 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {all.map((a) => {
                const isActive = a.id === activeId;
                return (
                  <div
                    key={a.id}
                    className={`flex items-center gap-3 rounded-xl border p-3 transition ${
                      isActive
                        ? "border-primary bg-primary/5"
                        : "border-border bg-surface-2 hover:bg-surface"
                    }`}
                  >
                    <button
                      onClick={() => pick(a.id, a.handle)}
                      className="flex flex-1 items-center gap-3 text-left"
                    >
                      <div className="grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                        {a.handle.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">@{a.handle}</div>
                        {a.label && (
                          <div className="truncate text-xs text-muted-foreground">{a.label}</div>
                        )}
                      </div>
                      {isActive && <Check className="h-4 w-4 text-primary" />}
                    </button>
                    {a.id !== "primary" && (
                      <button
                        onClick={() => remove(a.id)}
                        className="rounded-lg px-2 py-1 text-mini font-medium text-destructive hover:bg-destructive/10"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <form onSubmit={addAccount} className="mt-4 flex items-stretch gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-xl border-2 border-dashed border-border bg-background px-3">
              <span className="text-muted-foreground">@</span>
              <input
                value={newHandle}
                onChange={(e) => setNewHandle(e.target.value)}
                placeholder="add-pinterest-handle"
                className="flex-1 bg-transparent py-2.5 text-sm outline-none"
              />
            </div>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-primary px-4 text-sm font-semibold text-primary-foreground shadow-glow"
            >
              <Plus className="h-4 w-4" /> Add
            </button>
          </form>
        </div>
        {/* No "Back to dashboard" button — the app bar's back arrow goes there,
            and a second one at the bottom of a one-card page is just a word. */}
      </div>
    </AppShell>
  );
}
