import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/600.css";
import "@fontsource/outfit/700.css";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";

import { MotionConfig } from "framer-motion";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "sonner";
import { MonetizationFloater } from "@/components/monetization-floater";
import { applyTheme, readTheme, type Theme } from "@/lib/theme";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-gradient">404</h1>
        <h2 className="mt-4 text-xl font-semibold">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for drifted off the board.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-gradient-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-glow transition hover:opacity-90"
        >
          Back home
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went sideways</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Give it another shot or head back to the dashboard.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-md bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-2"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#e60023" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "ShopMyPin" },
      { title: "ShopMyPin — Turn your Pins into income" },
      {
        name: "description",
        content:
          "ShopMyPin turns your Pinterest Pins into affiliate income. Connect your account, make any Pin shoppable, and watch clicks become earnings — in real time.",
      },
      { property: "og:title", content: "ShopMyPin — Turn your Pins into income" },
      {
        property: "og:description",
        content:
          "Make any Pin shoppable, attach your affiliate links, and track clicks & earnings in one place. Built for Pinterest creators.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/shopmypin-favicon.png", type: "image/png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  // The static `data-tsd-source` attributes below are load-bearing, not
  // decorative — do not remove them.
  //
  // In dev mode, @tanstack/devtools-vite's inject-source plugin auto-tags
  // every JSX element with `data-tsd-source="<file>:<line>:<col>"` (its
  // click-to-open-in-editor feature). For most components that's harmless.
  // But this file's SSR module graph and the client's HMR/Fast-Refresh
  // module graph transform this exact file differently before that plugin
  // computes positions (the client pipeline prepends extra boilerplate,
  // shifting line/column), so the *same* <html>/<head>/<body> node gets two
  // different computed values — e.g. observed "__root.tsx:118:5" from SSR
  // vs "__root.tsx:121:10" from the client bundle. Since RootShell is the
  // one component whose output becomes the hydration root itself
  // (hydrateRoot targets `document`), that attribute mismatch surfaces as
  // a hydration warning on <html>.
  //
  // The plugin skips elements that already carry a `data-tsd-source`
  // attribute in source, so giving these three elements a fixed, identical
  // (harmless) value here suppresses the buggy auto-injection at its exact
  // source — every other component in the app keeps the real dev feature.
  return (
    <html
      lang="en"
      className="scroll-smooth"
      data-tsd-source={import.meta.env.DEV ? "root-shell" : undefined}
    >
      <head data-tsd-source={import.meta.env.DEV ? "root-shell" : undefined}>
        <HeadContent />
      </head>
      <body data-tsd-source={import.meta.env.DEV ? "root-shell" : undefined}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  // The saved theme, applied once on boot — Settings persisted the choice but
  // only ever toggled the class while that page was mounted, so dark mode
  // reverted to light on the next reload. Kept in state as well so the toast
  // layer follows the app instead of staying stuck on light.
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    const saved = readTheme();
    setTheme(saved);
    applyTheme(saved);
  }, []);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [queryClient, router]);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Honour prefers-reduced-motion app-wide: framer-motion drops transform/
          layout animations for these users. Imperative animate() calls (e.g.
          AnimatedNumber) additionally self-guard via useReducedMotion(). */}
      <MotionConfig reducedMotion="user">
        <Outlet />
        <MonetizationFloater />
        {/* No global `closeButton`: whether a notification can be dismissed is a
            property of what it says, and src/lib/notify.tsx decides it per kind. */}
        <Toaster theme={theme} position="top-right" richColors duration={2500} />
      </MotionConfig>
    </QueryClientProvider>
  );
}
