import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { completePinterestOAuthCallback } from "@/lib/pinterest-oauth.functions";
import { syncPinterestAccount } from "@/lib/pinterest-sync.functions";

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
  done: { title: "All set", body: "Taking you back to Pinearn." },
};

function PinterestCallbackPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const complete = useServerFn(completePinterestOAuthCallback);
  const sync = useServerFn(syncPinterestAccount);
  const [error, setError] = useState<string | null>(
    search.error_description || search.error || null,
  );
  const [stage, setStage] = useState<Stage>("linking");
  const [summary, setSummary] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (error) return;
    if (!search.code || !search.state) {
      setError("Pinterest didn't return an authorization code. Please try connecting again.");
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
          setSummary(
            `${result.pins.created + result.pins.updated} pins · ${
              result.boards.created + result.boards.updated
            } boards`,
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
      setError(e instanceof Error ? e.message : "Couldn't finish connecting Pinterest.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = STAGE_COPY[stage];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      {error ? (
        <>
          <div className="grid h-14 w-14 place-items-center rounded-full bg-destructive/15 text-destructive">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h1 className="font-display text-xl font-semibold">Couldn't connect Pinterest</h1>
          <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => navigate({ to: "/onboarding" })}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow"
            >
              Try again
            </button>
            <button
              onClick={() => navigate({ to: "/dashboard" })}
              className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
            >
              Back to Pinearn
            </button>
          </div>
        </>
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
