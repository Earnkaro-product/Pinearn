import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  RefreshCw,
  X,
  Sparkles,
  Layers,
  Image as ImageIcon,
} from "lucide-react";
import { AppSheet } from "@/components/app-sheet";

export type SyncStatus = "idle" | "running" | "success" | "error";

const STEPS = [
  { key: "connect", label: "Connecting to Pinterest", hint: "Verifying your linked account" },
  { key: "boards", label: "Fetching your boards", hint: "Pulling board names & covers" },
  { key: "pins", label: "Importing pins", hint: "Downloading titles, images & links" },
  { key: "finalize", label: "Finalising your store", hint: "Organising into collections" },
] as const;

export function PinterestSyncModal({
  open,
  status,
  result,
  error,
  onClose,
  onRetry,
}: {
  open: boolean;
  status: SyncStatus;
  result: { boardsCreated: number; pinsCreated: number } | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  // Simulated step progression while the server call is in flight.
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (status !== "running") {
      // reset to first step when we leave running
      if (status === "idle") setStepIndex(0);
      return;
    }
    setStepIndex(0);
    const timings = [700, 1100, 1600, 900];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let acc = 0;
    for (let i = 0; i < timings.length - 1; i++) {
      acc += timings[i];
      timers.push(setTimeout(() => setStepIndex((prev) => Math.max(prev, i + 1)), acc));
    }
    return () => timers.forEach(clearTimeout);
  }, [status]);

  // When the mutation finishes, snap to the last step
  useEffect(() => {
    if (status === "success") setStepIndex(STEPS.length - 1);
  }, [status]);

  if (!open) return null;

  const canClose = status !== "running";
  const activeStep = status === "success" ? STEPS.length : stepIndex;
  const progressPct =
    status === "success"
      ? 100
      : status === "error"
        ? Math.max(15, (activeStep / STEPS.length) * 100)
        : ((activeStep + 0.4) / STEPS.length) * 100;

  return (
    // Mid-sync the sheet can't be dismissed — the import is still writing rows,
    // so Escape and the backdrop stay inert until it lands.
    <AppSheet
      onClose={onClose}
      dismissible={canClose}
      labelledBy="pinterest-sync-title"
      grabber={false}
    >
      <>
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${
                status === "error"
                  ? "bg-destructive/15 text-destructive"
                  : status === "success"
                    ? "bg-accent/15 text-accent"
                    : "bg-gradient-primary text-primary-foreground shadow-glow"
              }`}
            >
              {status === "error" ? (
                <AlertCircle className="h-5 w-5" />
              ) : status === "success" ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <Sparkles className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0">
              <h3 id="pinterest-sync-title" className="font-display text-base font-semibold">
                {status === "error"
                  ? "Sync interrupted"
                  : status === "success"
                    ? "Your store is synced"
                    : "Syncing from Pinterest"}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {status === "error"
                  ? "We couldn't finish the import. You can safely retry."
                  : status === "success"
                    ? "Fresh boards and pins are live in your store."
                    : "Hang tight — this usually takes a few seconds."}
              </p>
            </div>
          </div>
          {canClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className={`h-full rounded-full transition-all duration-500 ease-out ${
              status === "error"
                ? "bg-destructive"
                : status === "success"
                  ? "bg-accent"
                  : "bg-gradient-primary"
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-micro font-medium uppercase tracking-wide text-muted-foreground">
          <span>
            {status === "success"
              ? "Complete"
              : status === "error"
                ? "Paused"
                : `Step ${Math.min(activeStep + 1, STEPS.length)} of ${STEPS.length}`}
          </span>
          <span>{Math.round(progressPct)}%</span>
        </div>

        {/* Steps or result */}
        {status === "success" && result ? (
          <div className="mt-5 grid grid-cols-2 gap-3">
            <ResultStat
              icon={<Layers className="h-4 w-4" />}
              label="Boards imported"
              value={result.boardsCreated}
              empty={result.boardsCreated === 0 ? "Already up to date" : undefined}
            />
            <ResultStat
              icon={<ImageIcon className="h-4 w-4" />}
              label="Pins imported"
              value={result.pinsCreated}
              empty={result.pinsCreated === 0 ? "No new pins" : undefined}
            />
          </div>
        ) : status === "error" ? (
          <div className="mt-5 rounded-xl border border-destructive/30 bg-destructive/10 p-3">
            <p className="text-xs font-medium text-destructive">
              {error ?? "Something went wrong while syncing."}
            </p>
            <p className="mt-1 text-mini text-destructive/80">
              Any boards already imported were saved — retrying will only fetch what's missing.
            </p>
          </div>
        ) : (
          <ol className="mt-5 space-y-2.5">
            {STEPS.map((s, i) => {
              const state: "done" | "active" | "pending" =
                i < stepIndex ? "done" : i === stepIndex ? "active" : "pending";
              return (
                <li key={s.key} className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-micro font-semibold ${
                      state === "done"
                        ? "bg-accent/15 text-accent"
                        : state === "active"
                          ? "bg-primary/15 text-primary"
                          : "bg-surface-2 text-muted-foreground"
                    }`}
                  >
                    {state === "done" ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : state === "active" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      i + 1
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-sm font-medium ${
                        state === "pending" ? "text-muted-foreground" : "text-foreground"
                      }`}
                    >
                      {s.label}
                    </div>
                    <div className="text-mini text-muted-foreground">{s.hint}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-end gap-2">
          {status === "error" && (
            <>
              <button
                onClick={onClose}
                className="rounded-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow"
              >
                <RefreshCw className="h-4 w-4" /> Retry sync
              </button>
            </>
          )}
          {status === "success" && (
            <button
              onClick={onClose}
              className="inline-flex items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background"
            >
              <CheckCircle2 className="h-4 w-4" /> Done
            </button>
          )}
          {status === "running" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Please keep this window open
            </div>
          )}
        </div>
      </>
    </AppSheet>
  );
}

function ResultStat({
  icon,
  label,
  value,
  empty,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  empty?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface-2/60 p-3">
      <div className="flex items-center gap-1.5 text-mini text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-1 font-display text-2xl font-semibold">{value}</div>
      {empty && <div className="mt-0.5 text-micro text-muted-foreground">{empty}</div>}
    </div>
  );
}
