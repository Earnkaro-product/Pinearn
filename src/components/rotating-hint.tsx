import { useEffect, useState } from "react";
import { Lightbulb, Sparkles } from "lucide-react";

// A small, self-rotating "here's what's happening / what to do next" tip.
// Meant to sit inside any loading or matching state so the wait teaches
// something instead of feeling dead. Each hint fades in as it swaps; the
// component cycles on its own and cleans up its timer on unmount.
//
// `bare` drops the card chrome (border/background) so it can be embedded
// inside a richer container like EducationalLoader.
export function RotatingHint({
  hints,
  intervalMs = 3200,
  bare = false,
  className = "",
}: {
  hints: readonly string[];
  intervalMs?: number;
  bare?: boolean;
  className?: string;
}) {
  const [i, setI] = useState(0);

  useEffect(() => {
    setI(0);
    if (hints.length <= 1) return;
    const t = setInterval(() => setI((n) => (n + 1) % hints.length), intervalMs);
    return () => clearInterval(t);
  }, [hints, intervalMs]);

  if (hints.length === 0) return null;
  const hint = hints[i] ?? hints[0];

  const chrome = bare ? "" : "rounded-xl border border-border/60 bg-surface-2/50 px-3 py-2";

  return (
    <div className={`flex items-start gap-2 ${chrome} ${className}`}>
      <Lightbulb className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" />
      {/* key={i} remounts the <p> so the fade-in animation replays each swap */}
      <p key={i} className="animate-hint-in text-mini leading-snug text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

// The loading state itself, turned into a teaching moment. Replaces empty
// skeleton boxes: a labelled header, an always-moving progress sweep so the
// wait reads as active work, and the rotating tip as the centrepiece. Use
// this anywhere products/pins are being matched or fetched.
export function EducationalLoader({
  label,
  hints,
  className = "",
}: {
  label: string;
  hints: readonly string[];
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-rose-50/70 via-surface-2/40 to-amber-50/60 p-4 ${className}`}
    >
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4 animate-pulse" />
        </span>
        <p className="text-mini font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
      </div>

      {/* Indeterminate sweep — motion so the wait never looks frozen. */}
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full w-1/3 animate-indeterminate rounded-full bg-primary/60" />
      </div>

      <RotatingHint hints={hints} bare className="mt-3" />
    </div>
  );
}

// Contextual tip sets. Kept here so the copy lives in one place and every
// loading state pulls from a consistent, on-brand voice — a mix of "what's
// happening right now" and "what you can do next".
export const HINTS = {
  // While reverse-image search is finding products for a pin.
  matching: [
    "Scanning your pin for products people can actually buy…",
    "We only match retailers that pay commission — so every match can earn.",
    "Tip: no perfect match? Paste your own affiliate link above.",
    "You'll earn a commission on every click that turns into a sale.",
    "Prices and stock are pulled live from each retailer.",
  ],
  // While the board's pins are being loaded before the swipe deck.
  boardPins: [
    "Gathering every pin in this board that still needs a product…",
    "You'll review each pin: Skip, Approve, or Approve all at once.",
    "Approving attaches the matched product and makes the pin shoppable.",
    "In a hurry? “Approve all” matches every remaining pin instantly.",
  ],
  // While “Approve all” bulk-matches remaining pins.
  approveAll: [
    "Matching a product to every remaining pin…",
    "Each pin becomes a live, shoppable link in your storefront.",
    "Pins we can't match are left for you to tag manually later.",
  ],
  // While the create-pin visual search runs.
  createScan: [
    "Reading your image to find matching products…",
    "Pick the ones that fit, or paste your own link.",
    "Once live, this pin points shoppers straight to the product.",
  ],
} as const;
