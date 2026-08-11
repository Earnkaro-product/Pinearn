import { useEffect, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, ChevronRight, Loader2, Sparkles, X } from "lucide-react";

import {
  dismissMonetizationJob,
  useMonetizationJobs,
  type MonetizationJob,
} from "@/lib/monetization-jobs";

// A friendly, moving ETA string from a seconds count — mirrors the board's
// "going live" screen so the two never disagree.
function formatEta(seconds: number): string {
  if (seconds <= 0) return "any moment";
  if (seconds < 60) return `~${Math.max(5, Math.ceil(seconds / 5) * 5)}s left`;
  const mins = Math.ceil(seconds / 60);
  return `~${mins} min left`;
}

// The Swiggy/Zomato-style order tracker: a persistent bar pinned above the
// bottom nav that follows a background board-monetisation job across every
// screen. It appears the instant "Approve all" kicks off and the user heads
// home, tracks matching → publishing live, then flips to a tappable "done"
// state before auto-clearing.
export function MonetizationFloater() {
  const jobs = useMonetizationJobs();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // The monetise-board screen has its own full-page "going live" experience, so
  // the floater would be redundant there — hide it on that route only.
  if (pathname.startsWith("/pins/monetize-board")) return null;
  // Show the most recently started job (there's realistically only ever one).
  const job = jobs[jobs.length - 1];
  if (!job) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[45] flex justify-center px-3">
      <div
        className="w-full max-w-md"
        // Sit clear of the mobile bottom nav (≈4.5rem + safe area); tuck to the
        // bottom on desktop where there's no bottom nav.
        style={{
          marginBottom: "calc(env(safe-area-inset-bottom) + 4.75rem)",
        }}
      >
        <AnimatePresence mode="popLayout">
          <FloaterCard key={job.id} job={job} />
        </AnimatePresence>
      </div>
    </div>
  );
}

function FloaterCard({ job }: { job: MonetizationJob }) {
  const navigate = useNavigate();
  const done = job.status === "done";
  const failed = job.status === "error";
  const publishing = job.status === "publishing";

  // Tick every second so the ETA and progress feel alive.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (done || failed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [done, failed]);

  // Terminal states linger a few seconds, then clear themselves.
  useEffect(() => {
    if (!done && !failed) return;
    const t = setTimeout(() => dismissMonetizationJob(job.id), done ? 7000 : 9000);
    return () => clearTimeout(t);
  }, [done, failed, job.id]);

  const elapsed = Math.floor((now - job.startedAt) / 1000);
  const remainingEta = Math.max(publishing ? 3 : 5, job.etaSeconds - elapsed);
  // Progress: matching drives most of the bar, publishing tops it off.
  const matchPct = job.total > 0 ? job.matched / job.total : 0;
  const pct = done ? 1 : publishing ? 0.94 : Math.min(matchPct * 0.9, 0.9);

  const [a, b, c] = job.covers;

  const title = failed
    ? "Couldn't finish monetising"
    : done
      ? `${job.approved} pin${job.approved === 1 ? "" : "s"} now live 🎉`
      : publishing
        ? "Publishing your pins…"
        : "Monetising your board";

  const subtitle = failed
    ? "Tap to review the board and retry"
    : done
      ? job.boardName
        ? `“${job.boardName}” is ready`
        : "Your board is ready"
      : `${job.matched}/${job.total} matched · ${formatEta(remainingEta)}`;

  const open = () =>
    navigate({ to: "/pins/monetize-board", search: { collectionId: job.id, resume: "" } });

  return (
    <motion.div
      layout
      initial={{ y: 90, opacity: 0, scale: 0.96 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 90, opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      className="pointer-events-auto overflow-hidden rounded-3xl border border-border/70 bg-surface/95 shadow-elevate backdrop-blur-xl"
    >
      <button
        type="button"
        onClick={open}
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition active:scale-[0.99]"
      >
        {/* Board thumbnail collage — same visual language as the board tiles. */}
        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className="flex h-full w-full gap-0.5">
            <div className="relative flex-[2] bg-gradient-to-br from-rose-500 to-pink-600">
              {a && <img src={a} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            </div>
            <div className="flex flex-1 flex-col gap-0.5">
              {[b, c].map((src, i) => (
                <div
                  key={i}
                  className="relative flex-1 bg-gradient-to-br from-rose-400 to-pink-500"
                >
                  {src && (
                    <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />
                  )}
                </div>
              ))}
            </div>
          </div>
          {/* Status glyph badge */}
          <span
            className={`absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full text-white shadow ring-2 ring-surface ${
              done ? "bg-emerald-500" : failed ? "bg-rose-600" : "bg-primary"
            }`}
          >
            {done ? (
              <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
            ) : failed ? (
              <X className="h-3 w-3" strokeWidth={3} />
            ) : (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
            )}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {!done && !failed && <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />}
            <p className="truncate text-body font-bold leading-tight text-foreground">{title}</p>
          </div>
          <p className="mt-0.5 truncate text-mini font-medium text-muted-foreground">{subtitle}</p>
        </div>

        {done || failed ? (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismissMonetizationJob(job.id);
            }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {/* Progress rail — hidden once terminal. */}
      {!done && !failed && (
        <div className="h-1 w-full bg-primary/10">
          <motion.div
            className="h-full rounded-r-full bg-gradient-primary"
            animate={{ width: `${Math.round(pct * 100)}%` }}
            transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.7 }}
          />
        </div>
      )}
    </motion.div>
  );
}
