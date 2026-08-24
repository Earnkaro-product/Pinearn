import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { LiveScorePill } from "@/components/health-widgets";
import { pointsLabel } from "@/lib/health-score";

/* ------------------------------------------------------------------ *
 * Shared furniture for the two boost pickers — the screen where a run
 * gets built before any AI is spent.
 *
 * Pins and boards queue different things but pick them the same way: tap
 * anything to queue it, hold a card to see what it's worth, launch from the
 * bottom bar. Keeping that vocabulary in one file is what stops the two
 * flows from drifting into two products.
 * ------------------------------------------------------------------ */

/** The check dot every selectable thing on a picker wears — one visual verb
 * ("this is queued") shared by the rails, the grids and the board cards. */
export function SelectDot({ on, small }: { on: boolean; small?: boolean }) {
  return (
    <span
      className={`grid place-items-center rounded-full border-2 transition ${
        small ? "h-5 w-5" : "h-6 w-6"
      } ${
        on
          ? "border-primary bg-primary text-primary-foreground"
          : "border-white/80 bg-black/25 text-transparent backdrop-blur-sm"
      }`}
    >
      <motion.span
        initial={false}
        animate={{ scale: on ? 1 : 0.4, opacity: on ? 1 : 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 24 }}
      >
        <Check className={small ? "h-3 w-3" : "h-3.5 w-3.5"} strokeWidth={3.5} />
      </motion.span>
    </span>
  );
}

/** Tiny uppercase rail label with its ranking rule on the right — the whole
 * "why these" answer in five muted words. */
export function RailLabel({ text, metric }: { text: string; metric: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <p className="text-micro font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {text}
      </p>
      <p className="text-micro font-semibold text-muted-foreground/70">{metric}</p>
    </div>
  );
}

/** Animated progress ring — the pts as a shape, with the number inside. The
 * ring is the fraction, so the digits never have to spell out a denominator. */
export function ScoreRing({ points, maxPoints }: { points: number; maxPoints: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const share = maxPoints > 0 ? (points / maxPoints) * 100 : 0;
  return (
    <div className="relative grid h-14 w-14 shrink-0 place-items-center">
      <svg viewBox="0 0 48 48" className="h-14 w-14 -rotate-90">
        <circle cx="24" cy="24" r={r} fill="none" strokeWidth="4.5" className="stroke-border/70" />
        <motion.circle
          cx="24"
          cy="24"
          r={r}
          fill="none"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          // A floor of 2% keeps a sliver of colour visible at zero, so the ring
          // reads as "empty" rather than "not loaded".
          animate={{ strokeDashoffset: c * (1 - Math.min(100, Math.max(2, share)) / 100) }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          className="stroke-primary"
        />
      </svg>
      <span className="absolute flex flex-col items-center leading-none">
        <span className="text-xs font-bold tabular-nums">{Math.round(points)}</span>
        <span className="mt-px text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
          pts
        </span>
      </span>
    </div>
  );
}

/** The whole briefing in one slim band: pts banked, pts on the table, and the
 * page's only instruction — everything else is pictures. */
export function PickerHeader({
  heading,
  points,
  maxPoints,
  gainPoints,
  note,
  onGuide,
}: {
  heading: string;
  /** Pts this area has already banked on the 100-pt Boost Score. */
  points: number;
  /** The most this area can be worth. */
  maxPoints: number;
  /** Pts still recoverable from everything on this screen. */
  gainPoints: number;
  /** Optional one-or-two-sentence brief: what this screen is deciding, and on
   * what basis. Worth the height on a surface whose ORDER is the product — a
   * ranked list nobody can see the rule behind reads as an arbitrary one. */
  note?: ReactNode;
  onGuide: () => void;
}) {
  return (
    // The eyebrow ("Pin SEO") went: the app bar directly above already says
    // which flow this is, so it was the same words twice, one line apart.
    <header className="rounded-3xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-3.5">
        <ScoreRing points={points} maxPoints={maxPoints} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[22px] font-bold leading-tight tracking-tight">
            {heading}
          </h2>
          <p className="mt-0.5 text-mini font-bold text-primary">
            +{pointsLabel(gainPoints)} pts on the table
          </p>
          {/* Labelled, not an info glyph — same call as the score hero. */}
          <button
            type="button"
            onClick={onGuide}
            className="mt-1 inline-flex items-center gap-0.5 text-micro font-semibold text-muted-foreground transition hover:text-primary"
          >
            How it works
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </div>
      {note && (
        <p className="mt-3 border-t border-border/70 pt-3 text-mini leading-relaxed text-muted-foreground">
          {note}
        </p>
      )}
    </header>
  );
}

/** Search + sort, in the language of the Select pin screen so every picking
 * surface feels like one product. `neutralSort` is the key that reads as "not
 * sorted yet" — every other choice lights the control up. */
export function QueueToolbar<K extends string>({
  query,
  onQuery,
  placeholder,
  sort,
  onSort,
  options,
  neutralSort,
}: {
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
  sort: K;
  onSort: (v: K) => void;
  options: { key: K; label: string }[];
  neutralSort: K;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const active = options.find((o) => o.key === sort);

  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-1 items-center gap-2.5 rounded-full bg-surface-2 px-4 py-2.5 transition focus-within:bg-surface focus-within:ring-2 focus-within:ring-foreground">
        <Search className="h-[17px] w-[17px] shrink-0 text-foreground/60" strokeWidth={2.4} />
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent text-body font-medium outline-none placeholder:text-foreground/45"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground/10 text-foreground/70 transition hover:bg-foreground/20"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div ref={ref} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`flex h-[42px] items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-body font-bold transition ${
            sort !== neutralSort
              ? "bg-foreground text-background"
              : "bg-surface-2 text-foreground hover:bg-surface-2/70"
          }`}
        >
          {sort === neutralSort ? "Sort" : (active?.label ?? "Sort")}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="absolute right-0 top-[calc(100%+8px)] z-30 w-48 overflow-hidden rounded-2xl border border-border bg-surface p-1.5 shadow-elevate"
            >
              {options.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => {
                    onSort(o.key);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-body font-semibold transition hover:bg-surface-2 ${
                    o.key === sort ? "text-primary" : "text-foreground"
                  }`}
                >
                  {o.label}
                  {o.key === sort && <Check className="h-4 w-4" />}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Lenses over the grid, with counts on the chips so an empty bucket is
 * obvious before it's tapped — plus the select-all/clear switch for whatever
 * the active lens is showing. */
export function FilterChipRow<K extends string>({
  filters,
  active,
  counts,
  onFilter,
  allSelected,
  onToggleAll,
  toggleDisabled,
}: {
  filters: { key: K; label: string }[];
  active: K;
  counts: Record<K, number>;
  onFilter: (key: K) => void;
  allSelected: boolean;
  onToggleAll: () => void;
  toggleDisabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="no-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
        {filters.map((f) => {
          const on = f.key === active;
          const n = counts[f.key];
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              disabled={n === 0}
              onClick={() => onFilter(f.key)}
              className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-mini font-bold transition disabled:opacity-35 ${
                on
                  ? "bg-foreground text-background shadow-sm"
                  : "bg-surface text-muted-foreground ring-1 ring-border hover:text-foreground"
              }`}
            >
              {f.label}
              <span className={`tabular-nums ${on ? "opacity-70" : "opacity-55"}`}>{n}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onToggleAll}
        disabled={toggleDisabled}
        className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-3 text-mini font-bold transition disabled:opacity-40 ${
          allSelected
            ? "bg-foreground text-background"
            : "bg-surface text-primary ring-1 ring-primary/25 hover:bg-primary/10"
        }`}
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
        {allSelected ? "Clear" : "Select all"}
      </button>
    </div>
  );
}

/** The run launcher — and, until something is queued, the page's instruction.
 * Everything it needs to say fits inside the button. `coins` is omitted by
 * flows that don't bill (boards), so the bar never invents a price. */
export function SelectionBar({
  selectedCount,
  unit,
  unitPlural,
  emptyLabel,
  selectedPoints,
  coins,
  reward,
  emptyAction,
  onStart,
  onClear,
}: {
  selectedCount: number;
  unit: string;
  unitPlural: string;
  emptyLabel: string;
  selectedPoints: number;
  coins?: number;
  /** The headline win of this run, already formatted ("≈ +142 views"). Leads
   * the receipt line when present — it's the number that answers "why tap
   * this", so it must not live in a caption below the button. */
  reward?: string;
  /** What the bar offers to DO while nothing is queued. "Select pins" asks a
   * creator staring at hundreds of thumbnails to make the exact decision they
   * opened the screen unable to make; a flow that can rank them should just
   * make the pick, and let it be unpicked. Omit to keep the inert label. */
  emptyAction?: { label: string; onClick: () => void };
  onStart: () => void;
  onClear: () => void;
}) {
  const has = selectedCount > 0;
  const empty = !has && emptyAction;

  // One quiet receipt line INSIDE the button: reward, then score, then price.
  // These used to be two pill badges crowding the label — "+0.8\npts" wrapped
  // into a two-line blob at button font size — plus a red caption below for
  // the most persuasive number of the three. Same facts, one whisper.
  const receipt = has
    ? [
        reward,
        selectedPoints > 0 ? `+${pointsLabel(selectedPoints)} pts` : null,
        coins !== undefined ? `${coins} ${coins === 1 ? "coin" : "coins"}` : null,
      ]
        .filter(Boolean)
        .join("  ·  ")
    : "";

  return (
    <div className="shrink-0">
      <div
        aria-hidden
        className="pointer-events-none h-5 bg-gradient-to-t from-background to-transparent"
      />
      <div className="flex items-stretch gap-2 pb-1">
        <AnimatePresence initial={false}>
          {has && (
            <motion.button
              key="clear"
              type="button"
              onClick={onClear}
              initial={{ opacity: 0, scale: 0.8, width: 0 }}
              animate={{ opacity: 1, scale: 1, width: 48 }}
              exit={{ opacity: 0, scale: 0.8, width: 0 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
              aria-label="Clear selection"
              className="grid shrink-0 place-items-center rounded-2xl border-2 border-border bg-surface text-muted-foreground transition hover:text-foreground"
            >
              <X className="h-4 w-4" strokeWidth={2.5} />
            </motion.button>
          )}
        </AnimatePresence>

        <motion.button
          type="button"
          whileTap={has || empty ? { scale: 0.98 } : undefined}
          onClick={has ? onStart : emptyAction?.onClick}
          disabled={!has && !empty}
          className={`flex flex-1 items-center justify-center rounded-2xl px-4 transition ${
            receipt ? "py-2.5" : "py-3.5"
          } ${
            has
              ? "bg-gradient-primary text-primary-foreground shadow-glow"
              : empty
                ? "bg-foreground text-background"
                : "bg-surface-2 text-muted-foreground ring-1 ring-inset ring-border"
          }`}
        >
          {has ? (
            <span className="flex min-w-0 flex-col items-center">
              {/* The action, and only the action, at button weight. */}
              <span className="inline-flex items-center gap-2 text-lead font-extrabold">
                <Sparkles className="h-4 w-4" />
                Boost{" "}
                <motion.span
                  key={selectedCount}
                  initial={{ y: -6, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.18 }}
                  className="tabular-nums"
                >
                  {selectedCount}
                </motion.span>{" "}
                {selectedCount === 1 ? unit : unitPlural}
                <ArrowRight className="h-4 w-4" strokeWidth={2.75} />
              </span>
              {receipt && (
                <span className="mt-0.5 max-w-full truncate text-mini font-semibold tabular-nums text-primary-foreground/85">
                  {receipt}
                </span>
              )}
            </span>
          ) : empty ? (
            <span className="inline-flex items-center gap-2 text-lead font-extrabold">
              <Sparkles className="h-4 w-4" />
              {emptyAction.label}
              <ArrowRight className="h-4 w-4" strokeWidth={2.75} />
            </span>
          ) : (
            <span className="text-lead font-extrabold">{emptyLabel}</span>
          )}
        </motion.button>
      </div>
    </div>
  );
}

/** The beat between picking and reviewing: the first item of the run, framed
 * and lit, while the deck narrows behind it. `children` is whatever the flow
 * puts in the frame — a pin image, a board's cover collage. */
export function LaunchScreen({
  title,
  badge = "Boost run",
  children,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <motion.div
      key="boost-launch"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-3xl border border-primary/15 bg-surface"
    >
      <motion.div
        aria-hidden
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1.8, opacity: [0, 0.18, 0] }}
        transition={{ duration: 1.05, ease: [0.22, 1, 0.36, 1] }}
        className="absolute h-72 w-72 rounded-full border-2 border-primary"
      />
      <motion.div
        aria-hidden
        initial={{ y: 120, opacity: 0 }}
        animate={{ y: -120, opacity: [0, 1, 0] }}
        transition={{ duration: 1.05, ease: "easeInOut" }}
        className="absolute h-24 w-full bg-gradient-to-b from-transparent via-primary/20 to-transparent"
      />
      <motion.div
        initial={{ y: 18, scale: 0.9, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
        className="relative w-full max-w-[18rem] px-6 text-center"
      >
        <div className="mx-auto overflow-hidden rounded-[1.75rem] border-4 border-primary bg-surface shadow-elevate">
          <div className="aspect-[4/5] bg-surface-2">{children}</div>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22, duration: 0.32 }}
          className="mt-5"
        >
          <p className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-mini font-extrabold uppercase tracking-wide text-primary">
            <Sparkles className="h-3 w-3" /> {badge}
          </p>
          <h2 className="mt-2 font-display text-2xl font-bold">{title}</h2>
          <div className="mx-auto mt-3 h-1.5 w-44 overflow-hidden rounded-full bg-surface-2">
            <div className="animate-indeterminate h-full w-1/3 rounded-full bg-primary" />
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

/** Compact status bar for a review surface. Live pts, position, a segmented
 * progress track (applied vs skipped vs remaining) and the run's promise, in
 * one band — the three centred rows this replaced cost ~70px of the card's
 * height on a small phone and read as three unrelated captions. */
export function ReviewProgressHeader({
  label,
  points,
  maxPoints,
  index,
  total,
  approvedCount,
  skippedCount,
  onGuide,
}: {
  label: string;
  /** Pts this area has banked so far — climbs live as fixes land. */
  points: number;
  maxPoints: number;
  index: number;
  total: number;
  approvedCount: number;
  skippedCount: number;
  onGuide: () => void;
}) {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  // A one-item run has nothing to track: the bar can only be empty or full, and
  // "0 applied · 0 skipped · 1 left" is three numbers restating "1/1". Both rows
  // collapse so the rewrite gets the height instead.
  const showTrack = total > 1;
  return (
    <div className={`shrink-0 ${showTrack ? "pb-3" : "pb-2"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <LiveScorePill label={label} points={points} maxPoints={maxPoints} />
          {/* Position only. The "strongest gains first" reassurance belonged to
              the picker, where the order is chosen — repeating it on every card
              of the run spent a line saying nothing new. */}
          <p className="min-w-0 text-mini font-semibold leading-tight text-muted-foreground">
            {total > 1 ? (
              <span className="tabular-nums text-foreground">
                {Math.min(index + 1, total)}/{total}
              </span>
            ) : (
              <span className="text-foreground">1 of 1</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onGuide}
          aria-label="How it works"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-primary ring-1 ring-primary/20 transition hover:bg-primary/10"
        >
          <Info className="h-4 w-4" />
        </button>
      </div>

      {showTrack && (
        <>
          {/* Segmented track: applied (green) → skipped (grey) → remaining. */}
          <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-border/60">
            <motion.div
              className="h-full bg-emerald-500"
              animate={{ width: `${pct(approvedCount)}%` }}
              transition={{ type: "spring", stiffness: 220, damping: 30 }}
            />
            <motion.div
              className="h-full bg-muted-foreground/35"
              animate={{ width: `${pct(skippedCount)}%` }}
              transition={{ type: "spring", stiffness: 220, damping: 30 }}
            />
          </div>

          {/* The dots ARE the legend — they're the same two colours as the
              segments directly above, so "applied" and "skipped" were labels
              for something already colour-coded an eighth of an inch away. */}
          <div className="mt-1.5 flex items-center gap-3 text-micro font-semibold tabular-nums">
            <span
              className="inline-flex items-center gap-1 text-emerald-600"
              aria-label={`${approvedCount} applied`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {approvedCount}
            </span>
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              aria-label={`${skippedCount} skipped`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
              {skippedCount}
            </span>
            <span className="ml-auto text-muted-foreground/70">
              {Math.max(total - approvedCount - skippedCount, 0)} left
            </span>
          </div>
        </>
      )}
    </div>
  );
}
