import { useNavigate, useRouter } from "@tanstack/react-router";

/**
 * Back navigation for in-app back buttons.
 *
 * Every screen here has several entry points (dashboard quick actions, the
 * speed dial, bottom nav, deep links, in-flow hand-offs), so a hard-coded
 * parent route sends the user somewhere they never came from — the classic
 * "attach a pin from the dashboard, hit back, land on Live pins". So back
 * follows real history whenever there is any, and only falls back to the
 * declared parent when there is nothing to go back to (deep link, fresh tab,
 * external referrer) — which also keeps back from leaving the app.
 */
export function useGoBack(fallback: { to: string; search?: Record<string, unknown> }) {
  const router = useRouter();
  const navigate = useNavigate();

  return () => {
    if (router.history.canGoBack()) {
      router.history.back();
      return;
    }
    navigate({ to: fallback.to, search: fallback.search ?? {} } as never);
  };
}
