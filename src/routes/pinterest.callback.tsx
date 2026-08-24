import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CheckCircle2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { completePinterestOAuthCallback } from "@/lib/pinterest-oauth.functions";
import { syncPinterestAccount } from "@/lib/pinterest-sync.functions";
import {
  describeOAuthCallbackError,
  describePinterestFailure,
  type PinterestFailure,
} from "@/lib/pinterest-failure";
import { PinterestFailureNotice, GateSecondaryButton } from "@/components/pinterest-gate";
import { usePinterestConnect } from "@/hooks/use-pinterest-connect";

const searchSchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export const Route = createFileRoute("/pinterest/callback")({
  validateSearch: (s) => searchSchema.parse(s),
  component: PinterestCallbackPage,
});

type Stage = "linking" | "syncing" | "done";

const STAGE_COPY: Record<Stage, { title: string; body: string }> = {
  linking: {
    title: "Connecting your Pinterest…",
    body: "Exchanging the authorization Pinterest just gave us.",
  },
  syncing: {
    title: "Importing your Pinterest…",
    body: "Reading your boards, pins and profile. This is the only slow bit — a big account takes a few seconds.",
  },
  done: { title: "All set", body: "Taking you back to ShopMyPin." },
};

/**
 * Where a failed authorization should send the creator back to.
 *
 * Onboarding is the one place where "try again" has to return HERE rather than
 * to whichever page they came from, and it's also the only place where giving up
 * needs to write `onboarding_completed` — otherwise the app's guard would send
 * them straight back to a screen they just chose to leave.
 */
function useOnboardingStatus() {
  const [completed, setCompleted] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("onboarding_completed")
        .eq("id", data.user.id)
        .maybeSingle();
      if (alive) setCompleted(!!profile?.onboarding_completed);
    })();
    return () => {
      alive = false;
    };
  }, []);
  return completed;
}

function PinterestCallbackPage() {
  const search = Route.useSearch();
  const complete = useServerFn(completePinterestOAuthCallback);
  const sync = useServerFn(syncPinterestAccount);
  const { connect, connecting } = usePinterestConnect();
  const onboardingCompleted = useOnboardingStatus();

  /* Every way this screen can fail now lands in one classified failure, so the
     copy and the next action come from the same place whether Pinterest bounced
     us at its own consent screen, the token exchange was rejected, or the state
     token had gone stale. Previously this held a raw string — usually a sentence
     of server debug about redirect URIs — and offered a "Try again" that walked
     to /onboarding, which for anyone connecting from Settings was neither a
     retry nor where they were. */
  const [failure, setFailure] = useState<PinterestFailure | null>(
    search.error || search.error_description
      ? describeOAuthCallbackError(search.error, search.error_description)
      : null,
  );
  const [stage, setStage] = useState<Stage>("linking");
  const [summary, setSummary] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (failure) return;
    if (!search.code || !search.state) {
      setFailure(
        describePinterestFailure(
          "Pinterest didn't return an authorization code — the state token may have expired.",
        ),
      );
      return;
    }

    (async () => {
      const res = await complete({ data: { code: search.code!, state: search.state! } });

      // The import runs HERE, not on whichever page the user came from. That was
      // the actual reason connecting "did nothing": only the onboarding screen
      // ever kicked off a sync, so connecting from Settings — or landing back on
      // any other page — left the account authorized but never read.
      let dest = res.returnTo || "/dashboard";
      // Onboarding runs the import itself, behind its own progress modal — doing
      // it here too would walk every board and pin twice.
      const importHere = !dest.startsWith("/onboarding");
      if (!importHere) {
        setStage("done");
        window.location.href = dest.includes("?") ? dest : `${dest}?connected=1`;
        return;
      }

      setStage("syncing");
      try {
        const result = await sync({ data: { analytics: true } });
        if (result.ok) {
          const imported = result.pins.created + result.pins.updated;
          const boardCount = result.boards.created + result.boards.updated;
          // "0 pins" on its own reads as a failed import. When the account holds
          // nothing but saves, say that instead — it's the difference between a
          // bug report and an understood outcome.
          setSummary(
            imported === 0 && result.pins.savedSkipped > 0
              ? `${result.pins.savedSkipped} saved ${
                  result.pins.savedSkipped === 1 ? "Pin" : "Pins"
                } found — ShopMyPin works on Pins you created yourself`
              : `${imported} pins · ${boardCount} boards`,
          );
        } else if (result.error) {
          // The connection itself worked; a partial import is worth continuing
          // with, and the sync banner will offer a retry inside the app.
          console.error("[pinterest/callback] sync reported", result.error);
        }
      } catch (e) {
        console.error("[pinterest/callback] sync failed", e);
      }

      setStage("done");
      // Hard navigation: forces the `_authenticated` route guard to re-check the
      // now-updated `pinterest_connected` flag from scratch.
      if (!dest.startsWith("/")) dest = "/dashboard";
      window.location.href = dest.includes("?") ? dest : `${dest}?connected=1`;
    })().catch((e) => {
      setFailure(describePinterestFailure(e));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Retry means re-running the authorization, not re-mounting this page: the
   *  code in the URL has already been spent, so reloading could only fail. */
  function retry() {
    void connect(onboardingCompleted === false ? "/onboarding" : "/dashboard");
  }

  /** Give up on connecting, and still end up somewhere useful. Mid-onboarding
   *  that means recording the skip, so the guard doesn't bounce them back. */
  async function leave() {
    setLeaving(true);
    if (onboardingCompleted === false) {
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        await supabase
          .from("profiles")
          .update({ onboarding_completed: true })
          .eq("id", data.user.id);
      }
      // Nothing toasted on the way out. `window.location.href` reloads the app
      // before a toast can paint, and the offer this was making — connect
      // Pinterest whenever you like — is what the dashboard's Pinterest banner
      // is for, stated there for as long as it's unconnected.
    }
    window.location.href = "/dashboard";
  }

  const copy = STAGE_COPY[stage];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      {failure ? (
        <div className="w-full max-w-md text-left">
          <PinterestFailureNotice
            failure={failure}
            onRetry={retry}
            retrying={connecting}
            secondary={
              <GateSecondaryButton onClick={leave}>
                {leaving
                  ? "One moment…"
                  : onboardingCompleted === false
                    ? "Skip for now"
                    : "Back to ShopMyPin"}
              </GateSecondaryButton>
            }
          />
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Nothing was connected, and nothing in ShopMyPin changed.
          </p>
        </div>
      ) : (
        <>
          {stage === "done" ? (
            <div className="grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-600">
              <CheckCircle2 className="h-7 w-7" />
            </div>
          ) : (
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          )}
          <h1 className="font-display text-xl font-semibold">{copy.title}</h1>
          <p className="max-w-sm text-sm text-muted-foreground">{copy.body}</p>
          {summary && <p className="text-xs font-semibold text-primary">{summary}</p>}
        </>
      )}
    </div>
  );
}
