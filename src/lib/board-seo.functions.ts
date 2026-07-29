// Board SEO pipeline — orchestration + server function.
//
//   1. CONTEXT  The board, its pins, and the creator's niche.
//   2. THEME    What the board is collectively about, aggregated by frequency
//               across its pins' titles. Deterministic and free.
//   3. TRENDS   The theme's head terms expanded against real Pinterest Trends.
//   4. PLAN     The same deterministic ranker the pin flow uses.
//   5. COPY     ONE model call: the board's newest pin image plus that plan go
//               to the proxy, and a name + description come back. Validated,
//               mechanically repaired, and retried once with feedback.
//
// One paid call per board, same as a pin. A board has no image of its own, so
// the newest pin's cover stands in as a representative sample of the look —
// enough for the model to judge aesthetic, and honest about being one pin
// rather than the whole collection.
//
// The board being renamed is a row in `collections` — that's what the rest of
// the app treats as a Pinterest board.

import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { isPlaceholderText } from "@/lib/health-score";
import { logNet } from "@/lib/net-logger";
import { createLimiter } from "@/lib/concurrency-limiter";
import {
  generateText,
  extractJsonObject,
  refusedImage,
  ImageUnfetchable,
} from "@/lib/openai-proxy.server";
import {
  fetchKeywordTrends,
  fetchTrendingNow,
  resolveTrendCountry,
} from "@/lib/pinterest-trends.server";
import { buildKeywordPlan, type KeywordPlan } from "@/lib/pin-keywords";
import { buildPinSubject, type PinSubject } from "@/lib/pin-subject";
import {
  buildBoardPrompt,
  boardRetryFeedback,
  composeBoardFallback,
  repairBoardSuggestion,
  scoreBoardSuggestion,
  validateBoardSuggestion,
  type BoardPinSummary,
  type BoardSuggestionCandidate,
  type BoardSuggestionContext,
} from "@/lib/board-seo";
import type { KeywordSummary, PipelineStage } from "@/lib/pin-seo.functions";

type Supabase = SupabaseClient<Database>;

// Shares the text provider with the pin flow's copy stage but gets its own
// module-level cap, so a board batch and a pin batch can't jointly swamp it.
const boardCopyLimit = createLimiter(2);

// One attempt plus one feedback retry — same economics as the pin flow.
const MAX_ATTEMPTS = 2;
// Enough pins to establish a theme; past this the prompt just gets longer.
const MAX_THEME_PINS = 12;

/* ---------------- Stage 1: context ---------------- */

export type BoardContext = {
  board: { id: string; name: string; description: string };
  pins: BoardPinSummary[];
  pinCount: number;
  niche: string | null;
  currency: string | null;
  /** Cover images, newest first — the deck renders these as a collage. */
  covers: string[];
};

export async function getBoardContext(
  supabase: Supabase,
  userId: string,
  boardId: string,
): Promise<BoardContext> {
  const { data: board, error: bErr } = await supabase
    .from("collections")
    .select("id, name, description")
    .eq("id", boardId)
    .eq("user_id", userId)
    .maybeSingle();
  if (bErr) throw new Error(bErr.message);
  if (!board) throw new Error("Board not found");

  const [pinsRes, storefrontRes, productRes] = await Promise.all([
    supabase
      .from("pins")
      // Either link counts. A pin that has gone live is re-homed into its own
      // per-pin collection, so `collection_id` no longer points at the board
      // and only `origin_collection_id` does — matching just the former themes
      // a fully-monetized board off an empty pin list.
      .select("id, title, image_url")
      .or(`collection_id.eq.${boardId},origin_collection_id.eq.${boardId}`)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(60),
    supabase.from("storefronts").select("name, description").eq("user_id", userId).maybeSingle(),
    // Any priced product on the board tells us the market for Trends lookup.
    supabase
      .from("storefront_products")
      .select("currency")
      .eq("collection_id", boardId)
      .not("currency", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);
  for (const res of [pinsRes, storefrontRes, productRes]) {
    if (res.error) throw new Error(res.error.message);
  }

  const pinRows = pinsRes.data ?? [];
  const storefront = storefrontRes.data;

  return {
    board: {
      id: board.id,
      name: board.name ?? "",
      description: board.description ?? "",
    },
    pinCount: pinRows.length,
    // Placeholder titles are dropped rather than passed through — "IMG_4821"
    // adds nothing to a theme and costs prompt tokens to say so.
    pins: pinRows
      .slice(0, MAX_THEME_PINS)
      .map((p) => ({ title: isPlaceholderText(p.title) ? "" : (p.title ?? "") })),
    niche: storefront
      ? [storefront.name, storefront.description].filter(Boolean).join(" — ") || null
      : null,
    currency: productRes.data?.currency ?? null,
    covers: pinRows
      .map((p) => p.image_url)
      .filter((u): u is string => !!u)
      .slice(0, 4),
  };
}

/* ---------------- Stage 2: theme ---------------- */

/** What the board is collectively about, as a phrase, plus the keyword bag the
 * ranker scores against. Built by frequency across the pins rather than by
 * asking a model: it's deterministic, free, and a board's theme genuinely is
 * "the thing most of its pins have in common". */
export function aggregateTheme(ctx: BoardContext): { theme: string; subject: PinSubject } {
  const titles = ctx.pins.map((p) => p.title.trim().toLowerCase()).filter(Boolean);

  // The words most pins share are the board's real subject, regardless of what
  // the creator named it. A word appearing in a single pin says nothing about
  // the collection, so ties break toward whatever recurs.
  const counts = new Map<string, number>();
  for (const title of titles) {
    // Count each word once per pin: a title that repeats a word doesn't make
    // that word more central to the board.
    for (const w of new Set(title.split(/[^a-z0-9]+/))) {
      if (w.length < 4) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const dominant = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([w]) => w);

  const boardName = isPlaceholderText(ctx.board.name) ? "" : ctx.board.name;
  const theme = dominant.slice(0, 2).join(" ") || boardName || "curated finds";

  // The board's theme, expressed through the same metadata subject the pin flow
  // uses, so buildKeywordPlan works unchanged for both.
  const subject = buildPinSubject({
    pinTitle: theme,
    boardName: boardName || null,
    niche: ctx.niche,
  });

  return {
    theme,
    // Fold in the recurring words so relevance scoring sees the board's whole
    // vocabulary, not just the two-word theme phrase.
    subject: {
      ...subject,
      descriptors: [...new Set([...subject.descriptors, ...dominant])],
    },
  };
}

/* ---------------- Result ---------------- */

export type SuggestBoardSeoResult = {
  boardId: string;
  name: string;
  description: string;
  status: "ready" | "needs_review";
  seoScore: number;
  seoBreakdown: ReturnType<typeof scoreBoardSuggestion>["breakdown"] | null;
  /** The same score applied to the board's EXISTING name/description, so the
   * card can show whether the rewrite is genuinely an upgrade. */
  currentScore: number;
  keywords: KeywordSummary | null;
  theme: string;
  pinCount: number;
  covers: string[];
  /** Whether the model read the representative cover image. See the pin flow's
   * `sawImage` for why this is surfaced rather than assumed. */
  sawImage: boolean;
  issues: string[];
  stages: PipelineStage[];
};

function summarizePlan(plan: KeywordPlan): KeywordSummary {
  return {
    primary: plan.primary,
    secondary: plan.secondary,
    longTail: plan.longTail,
    ranked: plan.ranked.slice(0, 12).map((k) => ({
      term: k.term,
      score: k.score,
      volume: k.volume,
      trend: k.trend,
      rising: k.rising,
    })),
    country: plan.country,
    hasTrendData: plan.hasTrendData,
    asOf: plan.asOf,
  };
}

async function timed<T>(
  stages: PipelineStage[],
  stage: PipelineStage["stage"],
  fn: () => Promise<{ value: T; detail: string }>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const { value, detail } = await fn();
    stages.push({ stage, ok: true, ms: Date.now() - startedAt, detail });
    return value;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    stages.push({ stage, ok: false, ms: Date.now() - startedAt, detail });
    throw e;
  }
}

/* ---------------- Copy stage ---------------- */

async function generateBoardCopy(
  context: BoardSuggestionContext,
  /** The newest pin's cover, standing in for the board's look. */
  coverUrl: string | null,
  previousIssues?: { issues: string[]; attempt: number },
): Promise<{ candidate: BoardSuggestionCandidate; sawImage: boolean }> {
  let prompt = buildBoardPrompt(context);
  if (previousIssues && previousIssues.issues.length > 0) {
    prompt += boardRetryFeedback(previousIssues.issues, previousIssues.attempt);
  }
  // Unlike the pin prompt, this one never asks the model to describe what it
  // sees — the cover is supplementary signal about the board's look, and the
  // copy is driven by the theme and keyword plan. So an unfetchable cover just
  // means retrying without it; there's no prompt to rebuild.
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({ prompt, imageUrl: coverUrl, label: "board_copy" });
  } catch (e) {
    if (!(e instanceof ImageUnfetchable)) throw e;
    result = await generateText({ prompt, imageUrl: null, label: "board_copy" });
  }

  const { text } = result;
  const sawImage = result.sawImage && !refusedImage(text);

  const raw = extractJsonObject(text) as Partial<BoardSuggestionCandidate>;
  if (typeof raw?.name !== "string" || typeof raw?.description !== "string") {
    throw new Error("board copy JSON was missing string name/description");
  }
  return {
    candidate: { name: raw.name.trim(), description: raw.description.trim() },
    sawImage,
  };
}

/* ---------------- Server function ---------------- */

/** POST — generate a name + description for one board. Never throws for
 * model-side reasons: a failure degrades to deterministic copy composed from
 * the keyword plan, exactly like the pin flow. */
export const suggestBoardSeo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { boardId: string }) => z.object({ boardId: z.string().uuid() }).parse(d))
  .handler(async ({ context: authContext, data }): Promise<SuggestBoardSeoResult> => {
    const { supabase, userId } = authContext;
    const stages: PipelineStage[] = [];
    const startedAt = Date.now();

    const ctx = await timed(stages, "context", async () => ({
      value: await getBoardContext(supabase, userId, data.boardId),
      detail: "loaded",
    }));

    const { theme, subject } = await timed(stages, "subject", async () => {
      const t = aggregateTheme(ctx);
      return { value: t, detail: `theme="${t.theme}"` };
    });
    const country = resolveTrendCountry(ctx.currency);

    const trends = await timed(stages, "trends", async () => {
      const [keywordResult, trendingNow] = await Promise.all([
        subject.seedTerms.length > 0
          ? fetchKeywordTrends(supabase, subject.seedTerms, country)
          : Promise.resolve({ terms: [], cachedSeeds: [], fetchedSeeds: [], ok: false }),
        fetchTrendingNow(supabase, country),
      ]);
      return {
        value: { keywordResult, trendingNow },
        detail: keywordResult.ok
          ? `${keywordResult.terms.length} terms`
          : "no trend data — theme keywords only",
      };
    });

    const plan = await timed(stages, "plan", async () => {
      const p = buildKeywordPlan({
        subject,
        trends: trends.keywordResult.terms,
        trendingNow: trends.trendingNow,
        productName: null,
        boardName: isPlaceholderText(ctx.board.name) ? null : ctx.board.name,
        pinTitle: null,
        niche: ctx.niche,
        country,
      });
      return { value: p, detail: `primary="${p.primary}"` };
    });

    const suggestionContext: BoardSuggestionContext = {
      board: ctx.board,
      pins: ctx.pins,
      pinCount: ctx.pinCount,
      niche: ctx.niche,
      theme,
      plan,
    };
    const validationInput = { plan, currentName: ctx.board.name };

    const coverUrl = ctx.covers[0] ?? null;

    const copy = await timed(stages, "copy", async () => {
      let best: { candidate: BoardSuggestionCandidate; issues: string[] } | null = null;
      let sawImage = false;
      let feedback: string[] = [];
      let lastError: string | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let candidate: BoardSuggestionCandidate;
        try {
          const result = await boardCopyLimit(() =>
            generateBoardCopy(
              suggestionContext,
              coverUrl,
              attempt > 1 ? { issues: feedback, attempt: attempt - 1 } : undefined,
            ),
          );
          candidate = result.candidate;
          sawImage = result.sawImage;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          logNet("board_copy.failed", { boardId: data.boardId, attempt, error: lastError });
          break;
        }

        const rawIssues = validateBoardSuggestion(candidate, validationInput);
        if (rawIssues.length === 0) {
          return {
            value: { candidate, issues: [] as string[], sawImage },
            detail: `clean on ${attempt}`,
          };
        }
        const repaired = repairBoardSuggestion(candidate, suggestionContext);
        const repairedIssues = validateBoardSuggestion(repaired, validationInput);
        if (repairedIssues.length === 0) {
          return {
            value: { candidate: repaired, issues: [] as string[], sawImage },
            detail: `repaired on ${attempt}`,
          };
        }
        if (!best || repairedIssues.length < best.issues.length) {
          best = { candidate: repaired, issues: repairedIssues };
        }
        feedback = rawIssues;
      }

      if (best) return { value: { ...best, sawImage }, detail: "best-effort" };
      const fallback = composeBoardFallback(suggestionContext);
      return {
        value: {
          candidate: fallback,
          issues: validateBoardSuggestion(fallback, validationInput),
          sawImage: false,
        },
        detail: `deterministic fallback${lastError ? `: ${lastError.slice(0, 100)}` : ""}`,
      };
    });

    const score = scoreBoardSuggestion(copy.candidate, plan);
    const currentScore = scoreBoardSuggestion(
      { name: ctx.board.name, description: ctx.board.description },
      plan,
    );
    logNet("board_seo.done", {
      boardId: data.boardId,
      score: score.total,
      primary: plan.primary,
      pins: ctx.pinCount,
      sawImage: copy.sawImage,
      durationMs: Date.now() - startedAt,
    });

    return {
      boardId: data.boardId,
      name: copy.candidate.name,
      description: copy.candidate.description,
      status: copy.issues.length > 0 ? "needs_review" : "ready",
      seoScore: score.total,
      seoBreakdown: score.breakdown,
      currentScore: currentScore.total,
      keywords: summarizePlan(plan),
      theme,
      pinCount: ctx.pinCount,
      covers: ctx.covers,
      sawImage: copy.sawImage,
      issues: copy.issues,
      stages,
    };
  });
