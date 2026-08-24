import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Coins,
  Pencil,
  RotateCcw,
  Sparkles,
  TrendingUp,
  TriangleAlert,
  X,
} from "lucide-react";
import { AppSheet } from "@/components/app-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { BaseFixCard, FixField } from "@/hooks/use-fix-flow";
import { pointsLabel } from "@/lib/health-score";
import type { KeywordSummary } from "@/lib/pin-seo.functions";

/* ---------------- Bottom sheet shell (shared with every other overlay) --------------- */

/** Thin alias kept so the four sheets in this file read the same as before —
 * the shell itself (Escape, scroll lock, focus, safe area) is shared now. */
function Sheet({
  onClose,
  children,
  labelledBy,
}: {
  onClose: () => void;
  children: React.ReactNode;
  labelledBy?: string;
}) {
  return (
    <AppSheet onClose={onClose} labelledBy={labelledBy} size="lg">
      {children}
    </AppSheet>
  );
}

/* ---------------- Edit-before-apply ---------------- */

/** Lets the creator tweak the suggested rewrite before applying it — with a
 * live character counter against the SEO band, which doubles as teaching what
 * the score actually checks. */
export function FixEditSheet({
  fields,
  onSave,
  onClose,
}: {
  fields: FixField[];
  onSave: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.value])),
  );
  const firstRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const inBand = (f: FixField, v: string) =>
    (f.min == null || v.trim().length >= f.min) && (f.max == null || v.trim().length <= f.max);
  const allValid = fields.every((f) => inBand(f, values[f.key]));

  return (
    <Sheet onClose={onClose} labelledBy="edit-sheet-title">
      {/* No subtitle: the counter next to each label turns green in the band,
          which teaches the rule faster than a sentence about it. */}
      <h3 id="edit-sheet-title" className="font-display text-lg font-bold">
        Edit the copy
      </h3>
      <div className="mt-4 space-y-4">
        {fields.map((f, i) => {
          const v = values[f.key];
          const len = v.trim().length;
          const ok = inBand(f, v);
          return (
            <div key={f.key}>
              <div className="mb-1 flex items-baseline justify-between">
                <label htmlFor={`fix-${f.key}`} className="text-xs font-semibold">
                  {f.label}
                </label>
                {(f.min != null || f.max != null) && (
                  <span
                    className={`text-mini font-bold tabular-nums ${
                      ok ? "text-emerald-600" : "text-amber-600"
                    }`}
                  >
                    {len}
                    {f.max != null ? ` / ${f.min ?? 0}–${f.max}` : ""}
                  </span>
                )}
              </div>
              {f.multiline ? (
                <textarea
                  id={`fix-${f.key}`}
                  ref={i === 0 ? (firstRef as React.Ref<HTMLTextAreaElement>) : undefined}
                  value={v}
                  onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                  rows={4}
                  className="w-full resize-none rounded-2xl border border-input bg-background p-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              ) : (
                <input
                  id={`fix-${f.key}`}
                  ref={i === 0 ? (firstRef as React.Ref<HTMLInputElement>) : undefined}
                  value={v}
                  onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                  className="w-full rounded-2xl border border-input bg-background p-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-5 flex gap-2.5">
        <button
          type="button"
          onClick={onClose}
          className="min-h-[48px] flex-1 rounded-2xl border border-border bg-surface text-sm font-semibold text-muted-foreground transition hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!allValid}
          onClick={() => {
            onSave(values);
            onClose();
          }}
          className="min-h-[48px] flex-[1.5] rounded-2xl bg-gradient-primary text-sm font-bold text-primary-foreground shadow-glow transition disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </Sheet>
  );
}

/* ---------------- Approve-all confirmation ---------------- */

/** A one-tap bulk write to live content deserves a beat of confirmation — with
 * a couple of real before→after previews so it's never a blind action. */
export function ApproveAllSheet({
  cards,
  unitLabel,
  costCoins,
  balance,
  onConfirm,
  onCancel,
}: {
  cards: BaseFixCard[];
  unitLabel: string; // "pins" | "boards"
  // Coin cost of this batch, and the balance it's charged against. Omitted by
  // flows that don't cost coins (board SEO), which then render no
  // cost row at all rather than a misleading "0 coins".
  costCoins?: number;
  balance?: number | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const samples = cards.slice(0, 2);
  const showCost = costCoins != null && costCoins > 0 && balance != null;
  // The weekly allowance is smaller than a full deck, so a batch bigger than the
  // balance is trimmed rather than refused: it covers as many items as there are
  // coins and says so. Only a completely empty wallet blocks the action.
  const covered = showCost ? Math.min(cards.length, balance) : cards.length;
  const trimmed = showCost && covered < cards.length;
  const affordable = covered > 0;
  return (
    <Sheet onClose={onCancel} labelledBy="approveall-title">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-600">
          <TriangleAlert className="h-5 w-5" />
        </div>
        <div>
          <h3 id="approveall-title" className="font-display text-lg font-bold">
            Apply {cards.length} {unitLabel} at once?
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Rewrites them live. Undo anything on the next screen.
          </p>
        </div>
      </div>

      {samples.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-mini font-bold uppercase tracking-wide text-muted-foreground">
            Preview
          </p>
          {samples.map((c) => (
            <div key={c.id} className="rounded-2xl border border-border bg-surface-2/40 p-3">
              <p className="truncate text-mini text-muted-foreground line-through">
                {c.original[c.fields[0].key]?.toString().trim() || "(empty)"}
              </p>
              {/* A flow may not have generated its copy yet (the pin Boost
                  deck fills cards in asynchronously and generates the rest on
                  confirm), so an empty value is expected, not a bug. */}
              {c.fields[0].value.trim() ? (
                <p className="mt-0.5 line-clamp-2 text-sm font-semibold">{c.fields[0].value}</p>
              ) : (
                <p className="mt-0.5 text-sm font-medium italic text-muted-foreground/60">
                  Written on confirm
                </p>
              )}
            </div>
          ))}
          {cards.length > samples.length && (
            <p className="text-center text-mini text-muted-foreground">
              + {cards.length - samples.length} more
            </p>
          )}
        </div>
      )}

      {/* What the batch costs, before it's charged — one coin per pin, against
          the balance in the header. */}
      {showCost && (
        <div
          className={`mt-4 flex items-center justify-between gap-3 rounded-2xl p-3 ring-1 ring-inset ${
            affordable ? "bg-surface-2/70 ring-border/70" : "bg-amber-500/10 ring-amber-500/25"
          }`}
        >
          <div className="min-w-0">
            <p className="text-micro font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Cost
            </p>
            <p className="text-body font-semibold">
              {covered} {covered === 1 ? unitLabel.replace(/s$/, "") : unitLabel} × 1 coin
            </p>
            {trimmed && (
              <p className="mt-0.5 text-mini font-semibold leading-snug text-amber-800">
                First {covered} of {cards.length} — the rest stay queued.
              </p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <p
              className={`font-display text-lg font-bold leading-none tabular-nums ${
                trimmed ? "text-amber-800" : "text-foreground"
              }`}
            >
              −{covered.toLocaleString()}
            </p>
            <p className="mt-0.5 text-micro font-semibold tabular-nums text-muted-foreground">
              {(balance - covered).toLocaleString()} left
            </p>
          </div>
        </div>
      )}

      <div className="mt-5 flex gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[48px] flex-1 rounded-2xl border border-border bg-surface text-sm font-semibold text-muted-foreground transition hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!affordable}
          onClick={() => {
            onConfirm();
            onCancel();
          }}
          className="min-h-[48px] flex-[1.5] rounded-2xl bg-gradient-primary text-sm font-bold text-primary-foreground shadow-glow disabled:opacity-50"
        >
          {/* The cost block directly above already prices this tap, so the
              button only needs to say what it does. */}
          {affordable ? `Apply ${covered} ${covered === 1 ? "fix" : "fixes"}` : "Out of coins"}
        </button>
      </div>
    </Sheet>
  );
}

/* ---------------- Shared states ---------------- */

/** Shown when the deck is empty. Since the decks now include EVERY pin and
 * board rather than only the failing ones, an empty deck no longer means
 * "nothing to fix" — it means there is nothing here at all. Saying "you're
 * fully optimized" to someone with zero pins would be nonsense. */
export function OptimizedState({
  onBack,
  unitLabel = "pins",
}: {
  onBack: () => void;
  unitLabel?: string;
}) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="rounded-3xl border border-border bg-surface p-10 text-center shadow-elevate">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
        <h2 className="mt-3 font-display text-xl font-bold">Nothing here yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add some {unitLabel} and we'll rewrite them.
        </p>
        <button
          onClick={onBack}
          className="mt-5 inline-flex min-h-[48px] items-center gap-1.5 rounded-full bg-gradient-primary px-5 text-sm font-bold text-primary-foreground shadow-glow"
        >
          Back to Boost
        </button>
      </div>
    </div>
  );
}

/** The done screen — a real celebration with an auditable, revertable list of
 * exactly what changed, so bulk apply → review → selective undo is one loop. */
export function DoneState({
  scoreLabel,
  points,
  maxPoints,
  gained,
  approvedCount,
  skippedCount,
  appliedCards,
  coinsSpent,
  onRevertOne,
  onUndoAll,
  onBack,
  busy,
}: {
  scoreLabel: string;
  /** Pts this area now holds on the 100-pt Boost Score. */
  points: number;
  maxPoints: number;
  /** Pts the run just added. */
  gained: number;
  approvedCount: number;
  skippedCount: number;
  appliedCards: BaseFixCard[];
  // Coins this run cost. Omitted by flows that don't charge.
  coinsSpent?: number;
  onRevertOne: (card: BaseFixCard) => void;
  onUndoAll: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  const [reverted, setReverted] = useState<Set<string>>(new Set());
  const [showReview, setShowReview] = useState(false);
  // Snapshot on mount: reverting a row removes it from the live appliedCards,
  // but the row should stay visible in an "Undone" state, not disappear.
  const [snapshot] = useState(appliedCards);
  return (
    <div className="grid flex-1 place-items-center overflow-y-auto py-2">
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        className="w-full rounded-3xl border border-border bg-surface p-7 text-center shadow-elevate"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 18, delay: 0.1 }}
          className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-500"
        >
          <CheckCircle2 className="h-8 w-8" />
        </motion.div>
        <h2 className="mt-3 font-display text-xl font-bold">
          {approvedCount > 0
            ? `${approvedCount} ${approvedCount === 1 ? "fix" : "fixes"} applied`
            : "All reviewed"}
        </h2>
        {/* Three stacked sentences became one line of chips: the score, the
            split, the coins. The headline already said how many landed, so
            "N applied · N skipped · N reviewed" only had to carry what the
            headline didn't. */}
        <p className="mt-1 text-sm text-muted-foreground">
          {scoreLabel}{" "}
          <span className="font-bold text-foreground">
            {pointsLabel(points)}/{maxPoints} pts
          </span>
          {gained > 0 && (
            <span className="font-bold text-emerald-600"> +{pointsLabel(gained)}</span>
          )}
        </p>
        {(skippedCount > 0 || (coinsSpent ?? 0) > 0) && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-mini font-semibold">
            {skippedCount > 0 && (
              <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted-foreground">
                {skippedCount} skipped
              </span>
            )}
            {coinsSpent != null && coinsSpent > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 font-bold text-amber-800 ring-1 ring-inset ring-amber-500/20">
                <Coins className="h-3 w-3" /> {coinsSpent} · undo refunds
              </span>
            )}
          </div>
        )}

        <button
          onClick={onBack}
          disabled={busy}
          className="mt-5 inline-flex min-h-[52px] w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-primary px-5 text-sm font-bold text-primary-foreground shadow-glow transition disabled:opacity-70"
        >
          {busy ? "Saving…" : "See your score"} <ArrowRight className="h-4 w-4" />
        </button>

        {snapshot.length > 0 && (
          <>
            <button
              onClick={() => setShowReview((v) => !v)}
              className="mt-2.5 text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline"
            >
              {showReview ? "Hide" : `Review ${snapshot.length}`}
            </button>
            <AnimatePresence>
              {showReview && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 space-y-2 overflow-hidden text-left"
                >
                  {snapshot.map((c) => {
                    const isReverted = reverted.has(c.id);
                    return (
                      <div
                        key={c.id}
                        className="flex items-start gap-2 rounded-2xl border border-border bg-surface-2/40 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-mini text-muted-foreground line-through">
                            {c.original[c.fields[0].key]?.toString().trim() || "(empty)"}
                          </p>
                          <p
                            className={`mt-0.5 line-clamp-2 text-xs font-semibold ${
                              isReverted ? "text-muted-foreground line-through" : ""
                            }`}
                          >
                            {c.fields[0].value}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={isReverted || busy}
                          onClick={() => {
                            setReverted((s) => new Set(s).add(c.id));
                            onRevertOne(c);
                          }}
                          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 text-mini font-bold text-muted-foreground ring-1 ring-border transition hover:text-foreground disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" /> {isReverted ? "Undone" : "Undo"}
                        </button>
                      </div>
                    );
                  })}
                  <button
                    onClick={onUndoAll}
                    disabled={busy}
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-2xl border border-border text-xs font-semibold text-muted-foreground transition hover:text-foreground disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Undo all
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </motion.div>
    </div>
  );
}

export function DeckSkeleton() {
  return (
    <div className="flex flex-1 flex-col">
      <Skeleton className="mb-2.5 h-1.5 w-full rounded-full" />
      <div className="relative min-h-0 flex-1">
        <Skeleton className="absolute inset-0 rounded-3xl" />
      </div>
      <div className="mt-3 flex shrink-0 gap-2.5">
        <Skeleton className="h-[52px] w-24 rounded-2xl" />
        <Skeleton className="h-[52px] flex-1 rounded-2xl" />
      </div>
    </div>
  );
}

/* ---------------- AI rewrite card internals ---------------- */
//
// Shared by the Pin Boost and Board Boost decks. Both screens present the same
// idea — "here is what you have, here is what the pipeline wrote, and here is
// the search demand it targeted" — so the pieces live here rather than being
// forked per route and drifting apart.

/** The item's health-check status. Now that the deck includes items with
 * perfectly good copy, "no issues" needs its own affirmative state — a card
 * with an empty chip row would just look broken. */
export function IssueChips({ issues }: { issues: string[] }) {
  if (issues.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-micro font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-500/20">
        <CheckCircle2 className="h-2.5 w-2.5" /> Already passing
      </span>
    );
  }
  return (
    <>
      {issues.map((issue) => (
        <span
          key={issue}
          className="rounded-full bg-amber-500/10 px-2 py-0.5 text-micro font-semibold text-amber-700 ring-1 ring-inset ring-amber-500/20"
        >
          {issue}
        </span>
      ))}
    </>
  );
}

/** Before → after SEO score. The whole point of showing both is that the deck
 * now offers a rewrite for every pin and board, including ones that already
 * pass — so the creator needs to see whether accepting it is actually an
 * upgrade rather than taking "AI suggested" on faith. */
function ScoreDelta({ current, next }: { current: number; next: number }) {
  const gain = next - current;
  const better = gain > 0;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-micro font-bold tabular-nums">
      <span className="text-muted-foreground/70">{current}</span>
      <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/50" />
      <span className={better ? "text-emerald-700" : "text-amber-700"}>{next}</span>
      <span
        className={`rounded-full px-1.5 py-0.5 ${
          better ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700"
        }`}
      >
        {gain > 0 ? `+${gain}` : gain === 0 ? "no change" : gain}
      </span>
    </span>
  );
}

/** A green/amber pill that shows a field's length against Pinterest's sweet
 * spot — the same band the score checks. Doubles as proof the rewrite is
 * genuinely better, not just different. */
function FitChip({ len, min, max }: { len: number; min?: number; max?: number }) {
  const ok = (min == null || len >= min) && (max == null || len <= max);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-micro font-bold tabular-nums ring-1 ring-inset ${
        ok
          ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20"
          : "bg-amber-500/10 text-amber-700 ring-amber-500/20"
      }`}
    >
      {ok && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
      {len}
      {max != null ? `/${max}` : ""}
    </span>
  );
}

/** Placeholder lines standing in for copy that's still being written. One
 * shimmering bar per line of the real thing, so the card barely moves when the
 * text lands. The block breathes and a highlight sweeps across it, which reads
 * as "being written" rather than "failed to load". */
export function CopyShimmer({ lines }: { lines: number }) {
  // Ragged widths — uniform bars read as a table, not prose — and the last
  // line is always short, the way a real paragraph ends.
  const WIDTHS = ["100%", "92%", "97%"];
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="animate-copy-line relative h-3 overflow-hidden rounded-full bg-primary/10"
          style={{
            width: i === lines - 1 && lines > 1 ? "64%" : WIDTHS[i % WIDTHS.length],
            animationDelay: `${i * 160}ms`,
          }}
        >
          <div
            className="animate-copy-shimmer absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-primary/30 to-transparent"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        </div>
      ))}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1 w-1 rounded-full bg-primary/70"
          style={{
            animation: "copy-line-pulse 1.1s ease-in-out infinite",
            animationDelay: `${i * 140}ms`,
          }}
        />
      ))}
    </span>
  );
}

/** One field's Now → AI comparison. The current value is
 * demoted and struck through; the AI suggestion is the bright, primary-accented
 * payoff carrying a live SEO-fit chip.
 *
 * While the pipeline runs there is no suggestion yet — the payoff row shimmers
 * rather than showing template copy, so nothing on screen can be mistaken for
 * a finished rewrite. */
export function FieldDiff({
  heading,
  now,
  field,
  loading,
  lines,
}: {
  heading: string;
  now?: string;
  field: FixField;
  loading: boolean;
  lines: number;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <p className="border-b border-border/70 bg-surface-2/50 px-3.5 py-2 text-mini font-bold uppercase tracking-wide text-muted-foreground">
        {heading}
      </p>

      {/* What they have — demoted. One word, not two: the pairing with
          "AI" below already says which side is which. */}
      <div className="px-3.5 py-2.5">
        <p className="text-micro font-bold uppercase tracking-wide text-muted-foreground/60">Now</p>
        <p
          className={`mt-0.5 text-sm ${
            now
              ? "text-muted-foreground line-through decoration-muted-foreground/40"
              : "italic text-muted-foreground/50"
          }`}
        >
          {now || `No ${heading.toLowerCase()} yet`}
        </p>
      </div>

      {/* AI suggested — the payoff. */}
      <div className="bg-primary/[0.05] px-3.5 py-3">
        <div className="flex items-center justify-between">
          <p className="text-micro font-bold uppercase tracking-wide text-primary">AI</p>
          {loading ? (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-primary/10 px-2">
              <TypingDots />
            </span>
          ) : (
            <FitChip len={field.value.trim().length} min={field.min} max={field.max} />
          )}
        </div>
        <div className="mt-1.5">
          {loading ? (
            <CopyShimmer lines={lines} />
          ) : (
            <motion.p
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="text-lead font-bold leading-snug text-foreground"
            >
              {field.value}
            </motion.p>
          )}
        </div>
      </div>
    </div>
  );
}

/** What the pipeline optimized this pin for — the primary keyword with its
 * real Pinterest search interest, plus the SEO score of the finished copy.
 * This is the honest version of "AI rewrite": it shows the evidence, so a
 * creator can judge the suggestion instead of trusting a label. */
export function KeywordProof({
  result,
}: {
  // Structural, not tied to either pipeline's full result type: the pin and
  // board flows return different shapes and both render this block.
  result: { seoScore: number; currentScore: number; keywords: KeywordSummary | null };
}) {
  const kw = result.keywords;
  if (!kw) return null;
  const primaryStats = kw.ranked.find((k) => k.term.toLowerCase() === kw.primary.toLowerCase());
  const supporting = [...kw.secondary, ...kw.longTail].slice(0, 3);
  const gain = result.seoScore - result.currentScore;

  return (
    <div className="rounded-2xl border border-border bg-surface-2/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1 text-micro font-bold uppercase tracking-wide text-muted-foreground">
          <TrendingUp className="h-3 w-3" /> Ranking for
        </p>
        <ScoreDelta current={result.currentScore} next={result.seoScore} />
      </div>

      {/* The deck reviews copy that already passes, so an honest "this is not
          actually better" is a required state, not an edge case. */}
      {gain <= 0 && (
        <p className="mt-1.5 rounded-xl bg-amber-500/10 px-2 py-1 text-micro font-semibold leading-snug text-amber-700">
          {gain === 0
            ? "Same score as yours — skip unless you prefer it."
            : "Yours scores higher — skip."}
        </p>
      )}

      <p className="mt-1 text-sm font-bold text-foreground">
        {kw.primary}
        {primaryStats?.volume != null && (
          <span className="ml-1.5 text-mini font-semibold text-muted-foreground tabular-nums">
            {primaryStats.volume}/100 interest
            {primaryStats.rising && <span className="text-emerald-600"> · rising</span>}
          </span>
        )}
      </p>

      {supporting.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {supporting.map((t) => (
            <span
              key={t}
              className="rounded-full bg-surface px-2 py-0.5 text-micro font-medium text-muted-foreground ring-1 ring-inset ring-border"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <p className="mt-1.5 text-micro text-muted-foreground/70">
        {kw.hasTrendData
          ? `Pinterest Trends · ${kw.country}${kw.asOf ? ` · ${kw.asOf}` : ""}`
          : "No live trend data"}
      </p>
    </div>
  );
}

// The pipeline's real stages, in order, with roughly how long each takes on a
// cold pin. Cycling through them beats a spinner because the wait is genuinely
// several seconds and each line is true.
//
// Keep this list in step with runSuggestionPipeline's stages: the pipeline is
// now trends → keywords → one copy call, with no separate image-analysis pass,
// because the model reads the image while it writes. A stage listed here that
// no longer happens is a small lie told during every single wait.
const GENERATION_STAGES = [
  { label: "Checking Pinterest trends", ms: 7000 },
  { label: "Picking keywords", ms: 4000 },
  { label: "Writing your copy", ms: 999_999 },
] as const;

/** Shown while the pipeline runs: a progress sweep plus the current stage,
 * advancing on the real timings above. It settles on the last stage rather
 * than looping, so a slow pin reads as "still writing" instead of restarting. */
export function GeneratingNotice() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (stage >= GENERATION_STAGES.length - 1) return;
    const t = setTimeout(() => setStage((s) => s + 1), GENERATION_STAGES[stage].ms);
    return () => clearTimeout(t);
  }, [stage]);

  return (
    <div className="overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-rose-50/70 via-surface-2/40 to-amber-50/60 p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-3.5 w-3.5 animate-pulse" />
        </span>
        {/* key remounts the <p> so each stage fades in as it swaps. */}
        <p key={stage} className="animate-hint-in text-mini font-semibold text-muted-foreground">
          {GENERATION_STAGES[stage].label}…
        </p>
      </div>
      <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="animate-indeterminate h-full w-1/3 rounded-full bg-primary/60" />
      </div>
    </div>
  );
}
