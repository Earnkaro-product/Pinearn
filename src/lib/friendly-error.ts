// Translates technical/internal error text (Supabase/Postgres messages, OAuth
// debug strings, network errors) into short, user-safe copy. Never changes
// what was thrown — only what gets shown.
const PATTERNS: Array<{ test: RegExp; message: string }> = [
  {
    test: /token exchange failed|oauth state|PINTEREST_APP_(ID|SECRET)|PINTEREST_REDIRECT_URI/i,
    message: "We couldn't connect to Pinterest. Please try again.",
  },
  {
    test: /failed to fetch|networkerror|load failed|ECONNRESET|ETIMEDOUT/i,
    message: "Network issue — check your connection and try again.",
  },
  {
    test: /jwt|not authenticated|auth session missing|401/i,
    message: "Your session expired. Please sign in again.",
  },
  { test: /duplicate key|violates unique constraint/i, message: "That already exists." },
  {
    test: /violates foreign key constraint|violates row-level security/i,
    message: "We couldn't complete that action. Please try again.",
  },
  { test: /permission denied|forbidden|403/i, message: "You don't have permission to do that." },
];

/** Text that is technical enough to hide even though no PATTERN claimed it:
 * stack-ish noise, bare status codes, JSON/HTML bodies, SQL. Anything else
 * short enough to be a sentence is assumed to be copy somebody wrote FOR the
 * creator, and is shown as-is. */
function looksTechnical(raw: string): boolean {
  return (
    raw.length > 140 ||
    /\n/.test(raw) ||
    /^\s*[[{<]/.test(raw) ||
    /\b(?:undefined|null|NaN|TypeError|ReferenceError|SyntaxError)\b/.test(raw) ||
    /\b(?:at\s+\w+\s*\(|https?:\/\/|\{\}|=>)/.test(raw) ||
    /\b(?:PGRST|SQLSTATE|ECONN|ENOTFOUND|EAI_AGAIN)\w*/i.test(raw) ||
    /\b(?:select|insert|update|delete)\b.*\b(?:from|into|where)\b/i.test(raw)
  );
}

export function getFriendlyMessage(error: unknown): string {
  const raw = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).trim();
  const match = PATTERNS.find((p) => p.test.test(raw));
  if (match) return match.message;
  // A server message that is already written for the creator ("Attach at
  // least one product before going live.") is the most useful thing we can
  // show — masking it behind "Something went wrong" was hiding the one line
  // that says what to DO, and made real failures undiagnosable.
  if (raw && !looksTechnical(raw)) return raw;
  return "Something went wrong. Please try again.";
}
