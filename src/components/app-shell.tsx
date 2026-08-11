import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Compass,
  Home,
  LogOut,
  Pin,
  Store,
  Plus,
  Link2,
  Link as LinkIcon,
  X,
  ChevronLeft,
  ChevronDown,
  User as UserIcon,
  Settings,
  Users,
  Check,
  Sparkles,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AffiliateLinkDialog, openAffiliateLinkDialog } from "@/components/affiliate-link-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletPill } from "@/components/wallet-pill";

const NAV = [
  { to: "/dashboard", label: "Home", icon: Home },
  { to: "/pins", label: "Pins", icon: Pin },
  { to: "/analytics", label: "Stats", icon: BarChart3 },
  { to: "/storefront", label: "My Store", icon: Store },
] as const;

export function AppShell({
  title,
  subtitle,
  actions,
  inlineActions,
  backButton,
  backTo,
  backSearch,
  onBack,
  greetingName,
  hideBottomNav,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  inlineActions?: boolean;
  backButton?: boolean;
  // Explicit parent route for the back button. When set, the back button
  // navigates here instead of `history.back()` — so back is deterministic
  // regardless of how the user reached the page (deep link, redirect, or a
  // different entry point). `backSearch` supplies its search params.
  backTo?: string;
  backSearch?: Record<string, unknown>;
  // Full override: when set, the back button calls this instead of navigating.
  // Used by pages with in-memory sub-views (e.g. the board overview inside the
  // review flow), where "back" should swap the view, not leave the page.
  onBack?: () => void;
  greetingName?: boolean;
  hideBottomNav?: boolean;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hideHeaderActions = pathname === "/pins/attach";

  const navigate = useNavigate();
  const qc = useQueryClient();

  // Back navigation: an explicit override wins, then the explicit parent
  // route, then browser history.
  const goBack = () => {
    if (onBack) {
      onBack();
    } else if (backTo) {
      navigate({ to: backTo, search: backSearch ?? {} } as never);
    } else {
      history.back();
    }
  };

  const { data: me, isPending: meLoading } = useQuery({
    queryKey: ["me-shell"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name, avatar_url, pinterest_username, pinterest_connected")
        .eq("id", u.user.id)
        .maybeSingle();
      return { email: u.user.email, ...(profile ?? {}) } as {
        email: string | undefined;
        display_name?: string | null;
        avatar_url?: string | null;
        pinterest_username?: string | null;
        pinterest_connected?: boolean | null;
      };
    },
  });

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const firstName = (me?.display_name ?? me?.email?.split("@")[0] ?? "creator").split(" ")[0];
  const initials = firstName.slice(0, 1).toUpperCase();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4 md:flex">
          <Link to="/dashboard" className="mb-6 flex items-center gap-2 px-2">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-glow">
              <span className="font-display text-base font-bold">P</span>
            </div>
            <span className="font-display text-lg font-semibold tracking-tight">Pinearn</span>
          </Link>

          <ProfileSwitcher
            name={me?.display_name ?? firstName}
            handle={me?.pinterest_username}
            connected={!!me?.pinterest_connected}
            initials={initials}
            avatar={me?.avatar_url ?? undefined}
            loading={meLoading}
          />

          <nav className="mt-6 flex-1 space-y-1">
            {NAV.map((n) => {
              const active = pathname === n.to;
              const Icon = n.icon;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  }`}
                >
                  <Icon className="h-[18px] w-[18px]" />
                  {n.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-4 rounded-2xl border border-sidebar-border bg-sidebar-accent/60 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-primary">
              <Compass className="h-3.5 w-3.5" /> Pro tip
            </div>
            <p className="mt-2 text-xs leading-relaxed text-sidebar-foreground/70">
              Pins with rich alt-text convert 2.4× better. Try the AI describer.
            </p>
          </div>
          <button
            onClick={signOut}
            className="mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </aside>

        <main className="min-w-0 flex-1 pb-24 md:pb-0">
          {/* Top app bar */}
          <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur-xl">
            <div className="safe-top flex items-center gap-3 px-5 pb-3 pt-3 sm:px-6 md:px-10 md:pt-4">
              {backButton ? (
                <button
                  onClick={goBack}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-2 text-foreground"
                  aria-label="Back"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              ) : (
                <UserMenu
                  name={me?.display_name ?? firstName}
                  email={me?.email}
                  initials={initials}
                  avatar={me?.avatar_url ?? undefined}
                  onSignOut={signOut}
                  loading={meLoading}
                />
              )}
              <div className="min-w-0 flex-1">
                {greetingName ? (
                  <>
                    <h1 className="truncate font-display text-[22px] font-bold leading-tight tracking-tight md:text-2xl">
                      {meLoading ? (
                        <>
                          Hi, <Skeleton className="inline-block h-4 w-16 align-middle" /> 👋
                        </>
                      ) : (
                        <>Hi, {firstName} 👋</>
                      )}
                    </h1>
                  </>
                ) : (
                  <>
                    <h1 className="truncate font-display text-[22px] font-bold leading-tight tracking-tight md:text-2xl">
                      {title}
                    </h1>
                    {subtitle && (
                      <p className="mt-0.5 hidden truncate text-sm text-muted-foreground sm:block">
                        {subtitle}
                      </p>
                    )}
                  </>
                )}
              </div>
              {/* Coin balance, top right on every screen — it's spent from the
                  Boost flows but it's account-level, so it lives in the shell
                  rather than being re-mounted per route. */}
              <WalletPill />

              {!hideHeaderActions && (
                <div
                  className={
                    inlineActions
                      ? "flex items-center gap-2"
                      : "hidden sm:flex sm:items-center sm:gap-2"
                  }
                >
                  {actions}
                </div>
              )}
            </div>

            {/* Actions row on mobile */}
            {actions && !inlineActions && (
              <div className="no-scrollbar flex items-center gap-2 overflow-x-auto border-t border-border/60 px-5 py-2.5 sm:hidden">
                {actions}
              </div>
            )}
          </header>

          <div className="px-5 py-6 sm:px-6 sm:py-8 md:px-10">{children}</div>
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      {!hideBottomNav && (
        <nav className="fixed inset-x-0 bottom-0 z-40 md:hidden">
          <div className="safe-bottom relative mx-auto border-t border-border/60 bg-background/95 px-2 pt-2 backdrop-blur-xl">
            <div className="mx-auto grid max-w-md grid-cols-5 items-end">
              {NAV.slice(0, 2).map((n) => (
                <BottomTab
                  key={n.to}
                  to={n.to}
                  label={n.label}
                  Icon={n.icon}
                  active={pathname === n.to}
                />
              ))}
              <SpeedDial pathname={pathname} />
              {NAV.slice(2).map((n) => (
                <BottomTab
                  key={n.to}
                  to={n.to}
                  label={n.label}
                  Icon={n.icon}
                  active={pathname === n.to}
                />
              ))}
            </div>
          </div>
        </nav>
      )}
      <AffiliateLinkDialog />
    </div>
  );
}

const SPEED_ACTIONS = [
  { to: "/pins/attach", label: "Attach product", icon: Link2, x: -108, y: -168 },
  { to: "/pins/create", label: "Create pin", icon: Plus, x: 0, y: -232 },
  { to: "__affiliate__", label: "Make affiliate link", icon: LinkIcon, x: 108, y: -168 },
] as const;

function SpeedDial({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-start justify-center">
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-background/75 backdrop-blur-md transition-opacity duration-300"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {open && (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-0 z-30 h-[360px] border-t border-border/60 bg-surface/90 shadow-elevate"
          aria-hidden="true"
        />
      )}

      {/* Arc glow behind orbiting buttons */}
      <div
        className={`absolute z-30 transition-all duration-400 ease-out ${
          open ? "opacity-100 scale-100" : "opacity-0 scale-50 pointer-events-none"
        }`}
        style={{
          width: 390,
          height: 290,
          top: -270,
          left: "50%",
          transform: "translateX(-50%)",
          background:
            "radial-gradient(ellipse at 50% 100%, oklch(0.55 0.23 25 / 0.16), oklch(0.55 0.23 25 / 0.06) 38%, transparent 72%)",
          borderRadius: "50%",
          transitionDelay: open ? "0ms" : "120ms",
        }}
      />

      {/* Orbiting action buttons */}
      {SPEED_ACTIONS.map((a, i) => {
        const Icon = a.icon;
        const isAffiliate = a.to === "__affiliate__";
        const isActive = !isAffiliate && pathname === a.to;
        const commonClass = `absolute z-40 flex w-max flex-col items-center gap-2.5 transition-all duration-350 ${
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`;
        const commonStyle = {
          transform: open
            ? `translate(${a.x}px, ${a.y}px) scale(1)`
            : `translate(0px, 0px) scale(0.4)`,
          transitionTimingFunction: open
            ? "cubic-bezier(0.34, 1.56, 0.64, 1)"
            : "cubic-bezier(0.36, 0, 0.66, -0.56)",
          transitionDelay: open ? `${i * 50}ms` : `${(SPEED_ACTIONS.length - 1 - i) * 35}ms`,
        } as const;
        const inner = (
          <>
            <span className="whitespace-nowrap rounded-full border border-background/25 bg-foreground px-4 py-2.5 text-sm font-semibold leading-none tracking-normal text-background shadow-elevate">
              {a.label}
            </span>
            <div
              className={`grid h-16 w-16 shrink-0 place-items-center rounded-full shadow-elevate ring-2 ring-background transition-all duration-200 ${
                isActive
                  ? "bg-primary text-primary-foreground ring-[4px] ring-primary/25"
                  : "bg-surface text-foreground hover:bg-primary hover:text-primary-foreground hover:ring-primary/25"
              }`}
            >
              <Icon className="h-7 w-7" strokeWidth={2.4} />
            </div>
          </>
        );
        if (isAffiliate) {
          return (
            <button
              key={a.to}
              type="button"
              onClick={() => {
                setOpen(false);
                openAffiliateLinkDialog();
              }}
              className={commonClass}
              style={commonStyle}
            >
              {inner}
            </button>
          );
        }
        return (
          <Link
            key={a.to}
            to={a.to}
            onClick={() => setOpen(false)}
            className={commonClass}
            style={commonStyle}
          >
            {inner}
          </Link>
        );
      })}

      {/* Main FAB */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close actions" : "Open quick actions"}
        aria-expanded={open}
        className="relative z-50 -mt-7 grid h-[58px] w-[58px] place-items-center rounded-full bg-gradient-primary text-primary-foreground shadow-glow ring-[5px] ring-background transition-all duration-300 active:scale-90"
      >
        <Plus
          className={`h-7 w-7 transition-transform duration-300 ease-out ${open ? "rotate-45" : "rotate-0"}`}
          strokeWidth={2.4}
        />
      </button>
    </div>
  );
}

function BottomTab({
  to,
  label,
  Icon,
  active,
}: {
  to: string;
  label: string;
  Icon: typeof Home;
  active: boolean;
}) {
  return (
    <Link to={to} className="flex flex-col items-center gap-0.5 py-1.5" aria-label={label}>
      <Icon
        className={`h-6 w-6 transition ${active ? "text-primary" : "text-muted-foreground"}`}
        strokeWidth={active ? 2.4 : 1.8}
      />
      <span
        className={`text-micro font-medium transition ${
          active ? "text-primary" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </Link>
  );
}

/* ---------- Profile Switcher (sidebar) ---------- */

type PinAccount = { id: string; handle: string; label?: string };

function useLocalPinAccounts(primary?: string | null) {
  const [accounts, setAccounts] = useState<PinAccount[]>([]);
  const [activeId, setActiveId] = useState<string>("primary");

  useEffect(() => {
    try {
      const raw = localStorage.getItem("pinearn.pinAccounts");
      if (raw) {
        const parsed = JSON.parse(raw) as { accounts: PinAccount[]; activeId: string };
        setAccounts(parsed.accounts ?? []);
        setActiveId(parsed.activeId ?? "primary");
      }
    } catch {
      /* corrupt/missing localStorage value — fall back to defaults */
    }
  }, []);

  function persist(next: PinAccount[], nextActive: string) {
    setAccounts(next);
    setActiveId(nextActive);
    localStorage.setItem(
      "pinearn.pinAccounts",
      JSON.stringify({ accounts: next, activeId: nextActive }),
    );
  }

  const all: PinAccount[] = [
    { id: "primary", handle: primary ?? "your-pinterest", label: "Primary" },
    ...accounts,
  ];

  return {
    all,
    activeId,
    setActive: (id: string) => persist(accounts, id),
    add: (handle: string) => {
      const id = crypto.randomUUID();
      const next = [...accounts, { id, handle }];
      persist(next, id);
    },
  };
}

function ProfileSwitcher({
  name,
  handle,
  connected,
  initials,
  avatar,
  loading,
}: {
  name: string;
  handle?: string | null;
  connected: boolean;
  initials: string;
  avatar?: string;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { all, activeId, setActive, add } = useLocalPinAccounts(handle);
  const active = all.find((a) => a.id === activeId) ?? all[0];

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function handleAdd() {
    const h = prompt("Enter your Pinterest handle (without @):");
    if (!h) return;
    add(h.replace(/^@/, "").trim());
    toast.success(`Added @${h} — connect for full sync from Settings`);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-2xl border border-sidebar-border bg-surface p-3 text-left transition hover:bg-surface-2"
      >
        <Avatar initials={initials} src={avatar} loading={loading} />
        <div className="min-w-0 flex-1">
          {loading ? (
            <Skeleton className="h-4 w-16" />
          ) : (
            <div className="truncate text-sm font-semibold">{name}</div>
          )}
          <div className="truncate text-xs text-muted-foreground">@{active.handle}</div>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute inset-x-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-2xl border border-border bg-surface p-2 shadow-elevate">
          <div className="px-2 pb-1 pt-2 text-micro font-semibold uppercase tracking-widest text-muted-foreground">
            Switch Pinterest
          </div>
          {all.map((a) => {
            const isActive = a.id === activeId;
            return (
              <button
                key={a.id}
                onClick={() => {
                  setActive(a.id);
                  setOpen(false);
                  toast.success(`Switched to @${a.handle}`);
                }}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-surface-2"
              >
                <div className="grid h-8 w-8 place-items-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                  {a.handle.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">@{a.handle}</div>
                  {a.label && <div className="text-mini text-muted-foreground">{a.label}</div>}
                </div>
                {isActive && <Check className="h-4 w-4 text-primary" />}
              </button>
            );
          })}
          <button
            onClick={handleAdd}
            className="mt-1 flex w-full items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/5"
          >
            <Plus className="h-4 w-4" /> Add Pinterest account
          </button>
          {!connected && (
            <div className="mt-2 rounded-xl bg-primary/5 p-3 text-mini text-primary">
              <Sparkles className="mr-1 inline h-3 w-3" /> Connect to sync pins & boards
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Top-right user menu ---------- */

function UserMenu({
  name,
  email,
  initials,
  avatar,
  onSignOut,
  loading,
}: {
  name: string;
  email?: string;
  initials: string;
  avatar?: string;
  onSignOut: () => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid h-10 w-10 place-items-center rounded-full ring-2 ring-border transition hover:ring-primary/40"
        aria-label="Account menu"
      >
        <Avatar initials={initials} src={avatar} size={36} loading={loading} />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+8px)] z-50 w-64 overflow-hidden rounded-2xl border border-border bg-surface p-2 shadow-elevate">
          <div className="flex items-center gap-3 rounded-xl bg-surface-2 p-3">
            <Avatar initials={initials} src={avatar} loading={loading} />
            <div className="min-w-0">
              {loading ? (
                <Skeleton className="h-4 w-16" />
              ) : (
                <div className="truncate text-sm font-semibold">{name}</div>
              )}
              {email && <div className="truncate text-xs text-muted-foreground">{email}</div>}
            </div>
          </div>
          <MenuItem
            icon={UserIcon}
            label="Profile"
            onClick={() => {
              setOpen(false);
              navigate({ to: "/profile" });
            }}
          />
          <MenuItem
            icon={Users}
            label="Switch profile"
            onClick={() => {
              setOpen(false);
              navigate({ to: "/switch-profile" });
            }}
          />
          <MenuItem
            icon={Settings}
            label="Settings"
            onClick={() => {
              setOpen(false);
              navigate({ to: "/settings" });
            }}
          />
          <div className="my-1 h-px bg-border/70" />
          <MenuItem icon={LogOut} label="Sign out" danger onClick={onSignOut} />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: any;
  label: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition hover:bg-surface-2 ${
        danger ? "text-destructive" : "text-foreground"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Avatar({
  initials,
  src,
  size = 40,
  loading,
}: {
  initials: string;
  src?: string;
  size?: number;
  loading?: boolean;
}) {
  if (loading) {
    return <Skeleton style={{ width: size, height: size }} className="rounded-full" />;
  }
  if (src) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size }}
        className="rounded-full object-cover"
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size }}
      className="grid place-items-center rounded-full bg-gradient-primary text-primary-foreground"
    >
      <span className="font-display text-sm font-bold">{initials}</span>
    </div>
  );
}
