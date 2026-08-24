import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { usePinterestAutoSync } from "@/hooks/use-pinterest-sync";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }

    // Gate onboarding, and ONLY onboarding. Pinterest is deliberately not part
    // of this check: authorization is skippable at the door, so a creator who
    // skipped it has `pinterest_connected: false` and still belongs inside the
    // app. Requiring it here was what made skipping impossible — the redirect
    // fired again on the very next navigation, so any "skip" button would have
    // bounced straight back to this screen.
    //
    // What replaces it is per-action gating: the handful of things that genuinely
    // need Pinterest ask for authorization at the moment they are used, and
    // cannot be skipped there. See components/pinterest-gate.tsx.
    if (location.pathname !== "/onboarding") {
      const { data: profile } = await supabase
        .from("profiles")
        .select("onboarding_completed")
        .eq("id", data.user.id)
        .maybeSingle();
      if (!profile?.onboarding_completed) {
        throw redirect({ to: "/onboarding" });
      }
    }
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  // Mounted once for the whole signed-in app: re-reads Pinterest whenever the
  // local copy has gone stale (including on tab focus, which is exactly when
  // someone returns from editing their boards on pinterest.com). Skipped during
  // onboarding, where the connect flow runs its own explicit import.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  usePinterestAutoSync(pathname !== "/onboarding");
  return <Outlet />;
}
