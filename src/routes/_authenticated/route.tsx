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

    // Gate onboarding: everything except /onboarding requires Pinterest to be
    // connected AND onboarding_completed. Pinterest sync is compulsory for all users.
    if (location.pathname !== "/onboarding") {
      const { data: profile } = await supabase
        .from("profiles")
        .select("onboarding_completed,pinterest_connected")
        .eq("id", data.user.id)
        .maybeSingle();
      if (!profile?.onboarding_completed || !profile?.pinterest_connected) {
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
