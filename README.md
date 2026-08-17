# ShopMyPin

**Turn your Pins into income.** ShopMyPin connects to a creator's Pinterest account, imports their
boards and Pins, finds the real, buyable products inside each Pin image, attaches affiliate links to
them, and tracks clicks and earnings in one place. It also audits and rewrites Pinterest SEO —
titles, descriptions and board names — so the Pins that carry those links actually get seen.

> **Naming.** The product is **ShopMyPin**. The repo, the Cloudflare worker (`ekproduct-pinearn`),
> the `localStorage` keys (`pinearn.*`) and the deploy host (`pinearn.vercel.app`) still carry the
> earlier name **Pinearn**. Same app.

---

## Table of contents

- [What it does](#what-it-does)
- [Stack](#stack)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Project layout](#project-layout)
- [Routes](#routes)
- [Architecture](#architecture)
- [Pipeline 1 — product matching](#pipeline-1--product-matching-a-pin-image--buyable-products)
- [Pipeline 2 — Pinterest SEO / Boost](#pipeline-2--pinterest-seo--boost)
- [Health Score](#health-score)
- [Coin wallet](#coin-wallet)
- [Pinterest integration](#pinterest-integration)
- [Data model](#data-model)
- [Auth & security](#auth--security)
- [Observability & debugging](#observability--debugging)
- [Resilience conventions](#resilience-conventions)
- [Deployment](#deployment)
- [Conventions & gotchas](#conventions--gotchas)

---

## What it does

Five things, in the order a creator meets them:

1. **Connect & sync Pinterest.** Real OAuth against Pinterest API v5. Boards, Pins, profile and
   analytics are pulled in and **reconciled** on every sync — new items created, changed items
   updated, deleted items flagged. Sync is compulsory: the app gates every screen behind it.
2. **Find the products in a Pin.** A vision model detects up to six distinct shoppable objects in a
   Pin image; each one is reverse-image-searched (Google Lens via SearchAPI), filtered to retailers
   that actually pay commission, price/stock-verified against the retailer's live page, and gated
   twice (category + "is this the same look?") before it's shown.
3. **Make the Pin shoppable.** Pick a matched product (or paste any affiliate link), attach it to a
   Pin or Collection, and publish. A whole board can be monetised in one background job.
4. **Fix Pinterest SEO (Boost).** A deterministic Health Score audits Pin copy, board structure,
   profile completeness and freshness; then an AI rewrite deck proposes keyword-grounded titles and
   descriptions, swipe-reviewed one card at a time. Rewrites are grounded in **real Pinterest Trends
   search demand**, not the model's imagination.
5. **Track earnings.** Impressions, clicks, conversions and earnings per Pin and per brand, plus a
   public storefront at `/s/:slug` where followers can browse the creator's Collections and Boards.

---

## Stack

| Layer | Choice |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) (SSR + server functions) on Vite 8 |
| UI | React 19, Tailwind CSS v4, shadcn/ui over Radix primitives, framer-motion |
| Routing | TanStack Router — **file-based**, `src/routes/` |
| Data fetching | TanStack Query (per-card queries, aggressive `staleTime: Infinity` on paid calls) |
| Backend | Supabase (Postgres + RLS, Auth, Storage) |
| Server runtime | Nitro, `cloudflare-module` preset (Workers); also runs on Node |
| Validation | Zod on every server-function input |
| Package manager | Bun (`bun.lock`, `bunfig.toml`); npm lockfile also committed |
| Platform | Lovable-connected project (`AGENTS.md`, `.lovable/`) |

---

## Quick start

```bash
bun install          # or: npm install
cp .env.example .env # if present — otherwise see the table below
bun run dev          # vite dev → http://localhost:8080 (port chosen by the Lovable vite config)
```

Scripts:

| Script | What it does |
| --- | --- |
| `dev` | `vite dev` — SSR dev server with HMR |
| `build` | `vite build` — emits `.output/` (Nitro server + static assets) |
| `build:dev` | Same, development mode |
| `preview` | `vite preview` |
| `lint` | `eslint .` |
| `format` | `prettier --write .` |

Supabase migrations live in `supabase/migrations/` and are applied with the Supabase CLI
(`supabase db push`). The project ref is in `supabase/config.toml`.

`bunfig.toml` sets `minimumReleaseAge = 86400` — a supply-chain guard that refuses package versions
published in the last 24 hours. Adding an exclusion is a deliberate, ask-first act.

### Minimum viable env

The app boots with just Supabase + Pinterest configured. Everything else degrades:

- no `VISUAL_SEARCH_*` → no product matches, rest of the app fine
- no `VISION_DETECT_*` → whole-image search instead of per-object
- no `OPENAI_PROXY_*` → SEO copy is composed deterministically, no model call
- no `APIFY_TOKEN` → keywords ranked from Pin metadata instead of live Pinterest Trends
- no `CK_PRODUCT_API_*` → matches show Lens's price snapshot, flagged `priceUnverified`

---

## Environment variables

All server-only unless marked `VITE_`. `.env` is gitignored.

### Supabase

| Var | Purpose |
| --- | --- |
| `SUPABASE_URL` / `VITE_SUPABASE_URL` | Project URL (server / browser) |
| `SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PUBLISHABLE_KEY` | Anon-tier key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Bypasses RLS.** Server handlers only, never imported into client code |
| `SUPABASE_PROJECT_ID` / `VITE_SUPABASE_PROJECT_ID` | Project ref |
| `SUPABASE_JWKS` | Optional seed of the project's **public** JWKS. Without it, every cold start can spend ~9s on a JWKS connect timeout before the retry lands — see [`token-verifier.ts`](src/integrations/supabase/token-verifier.ts) |

### Pinterest API v5

| Var | Purpose |
| --- | --- |
| `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET` | OAuth app credentials |
| `PINTEREST_REDIRECT_URI` | Must **byte-for-byte** match a redirect URI registered in the Pinterest app dashboard |
| `PINTEREST_API_BASE_URL` | Sandbox base while on Trial access; switch to `https://api.pinterest.com/v5` when Standard access is granted — no code change needed |

Scopes requested: `boards:read,boards:write,pins:read,pins:write,user_accounts:read`.

### Product matching

| Var | Purpose |
| --- | --- |
| `VISUAL_SEARCH_API_URL` / `VISUAL_SEARCH_API_KEY` | Reverse-image search (Google Lens via SearchAPI). Called **once per detected object**, with the original image URL plus a normalised crop region |
| `VISUAL_SEARCH_CROP_PARAM` / `VISUAL_SEARCH_QUERY_PARAM` | Optional param-name overrides; defaults match Lens (`crop`, `q`). An unsupported name degrades to whole-image results |
| `VISION_DETECT_ENABLED` | `false` forces the whole-image fallback (e.g. while the detector is down) |
| `VISION_DETECT_API_URL` | Legacy self-hosted detector endpoint; the live path uses the OpenAI vision proxy |
| `VISION_DETECT_TIMEOUT_MS` | Ceiling on one detection call — the pipeline **waits** on detection, so this is the longest a scan stalls before degrading |
| `VISION_DETECT_MIN_CONFIDENCE` | Below this, an object never earns a Lens call (a spurious object becomes a whole tab of wrong products) |
| `VISION_DETECT_MAX_OBJECTS` | **The Lens fan-out bound.** One paid call per object, so raising this raises per-Pin cost linearly |
| `VISION_IMAGE_PROXY_URL` | Optional. Public image proxy the model reads Pin images through, because retailer/Pinterest CDNs 403 a server-side fetch. Defaults to `images.weserv.nl` |
| `CK_PRODUCT_API_URL` / `CK_PRODUCT_API_KEY` | Validates a match against the retailer's real page: live MRP, discounted price, in-stock |

### Copy & keywords

| Var | Purpose |
| --- | --- |
| `OPENAI_PROXY_API_URL` | Text endpoint — body `{ prompt }` |
| `OPENAI_PROXY_IMAGE_URL` | Vision endpoint — body `{ prompt, image_url }`; `image_url` is **required and non-empty** (an empty string is a 400, not a text fallback) |
| `OPENAI_PROXY_API_KEY` | Shared key for both |
| `APIFY_TOKEN` | Pinterest Trends scraper actor. Optional; results cached in the shared `pinterest_trend_cache` table so the actor runs rarely at scale |

Neither proxy endpoint enforces a response schema, so prompts ask for raw JSON and
[`openai-proxy.server.ts`](src/lib/openai-proxy.server.ts) parses defensively — one format retry,
then deterministic fallback copy.

### Misc

| Var | Purpose |
| --- | --- |
| `VITE_LOVABLE_CONNECTOR_LOGO_DEV_API_KEY` | Brand-logo lookups on the Brands screens |

---

## Project layout

```
src/
├── routes/                    # file-based routes (see src/routes/README.md)
│   ├── __root.tsx             # app shell: head tags, theme boot, Toaster, auth listener
│   ├── index.tsx              # marketing landing
│   ├── auth.tsx               # sign-in
│   ├── privacy.tsx
│   ├── s.$slug.tsx            # PUBLIC storefront
│   ├── pinterest.callback.tsx # OAuth return → link + first sync
│   └── _authenticated/        # everything behind auth + onboarding gate
├── components/
│   ├── ui/                    # shadcn/ui primitives (~45 files)
│   └── *.tsx                  # feature components: app-shell, swipe-deck, boost-*, funnel-debug…
├── hooks/                     # use-visual-search, use-ai-rewrites, use-health-score, use-wallet…
├── lib/
│   ├── *.functions.ts         # server functions (createServerFn) — ship to the client as RPC stubs
│   ├── *.server.ts            # server-ONLY modules, never client-imported
│   └── *.ts                   # pure domain logic: pin-seo, board-seo, health-score, pin-keywords…
├── integrations/
│   ├── supabase/              # clients, auth middleware, local JWT verifier, generated types
│   └── lovable/               # Lovable OAuth helper
├── router.tsx  start.ts  server.ts  styles.css
supabase/migrations/           # 27 SQL migrations, each with a "why" header comment
```

The domain logic is deliberately **pure and separate** from the server functions that call it:
`pin-seo.ts` (prompt + validation + repair + fallback) is a no-network module; `pin-seo.functions.ts`
is the orchestration around it. Same split for boards, health score and keywords.

---

## Routes

### Public

| Route | Screen |
| --- | --- |
| `/` | Landing page |
| `/auth` | Sign in |
| `/privacy` | Privacy policy |
| `/s/:slug` | Public storefront — Collections + Boards, anon-key reads, live Pins only |
| `/pinterest/callback` | OAuth return: exchange code → link account → run first sync |

### Authenticated (`_authenticated/`)

| Route | Screen |
| --- | --- |
| `/onboarding` | Name → Pinterest authorize → sync → done. **Mandatory** |
| `/dashboard` | Home: earnings snapshot, resume-monetizing, brand shortcuts |
| `/pins` | Pin grid; open a Pin to scan it for products |
| `/pins/create` | Create a Pin (upload + AI-drafted SEO copy + product attach) |
| `/pins/attach` | Attach a product to an existing Pin |
| `/pins/preview` | Review before going live |
| `/pins/monetize-board` | Monetise a whole board — bulk match + approve |
| `/collections/:id/attach` | Attach products to a Collection |
| `/storefront` | Storefront editor: Collections / Boards tabs, covers, reorder, background |
| `/boost` | Pinterest SEO home: Health Score + analyzer + fix entry points |
| `/boost/pins` | Pin rewrite deck (costs coins) |
| `/boost/boards` | Board rename/describe deck |
| `/analytics` | Impressions, clicks, conversions, earnings; per-Pin and per-brand breakdown |
| `/brands`, `/brands/:brandId` | Affiliate brand catalogue + link generator |
| `/profile`, `/settings`, `/switch-profile` | Account, theme, Pinterest connect/disconnect |

Navigation is mobile-first: a 5-slot bottom bar (Home · Pins · **speed dial** · Earnings · My Store)
with Pinterest SEO in the sidebar, and a desktop sidebar carrying all six.

---

## Architecture

```
browser (React 19 / TanStack Router / Query)
   │
   │  server functions — same-origin RPC, CSRF-filtered, Bearer token attached client-side
   ▼
TanStack Start server (Nitro → Cloudflare Workers or Node)
   ├── requireSupabaseAuth  → local ES256 JWT verify (zero network) → RLS-scoped client
   ├── getServiceSupabase() → service-role client, RLS bypassed, server-only
   └── outbound, all concurrency-limited process-wide:
        Pinterest API v5 · Google Lens (SearchAPI) · CK Product Details
        OpenAI proxy (text + vision) · Apify (Pinterest Trends)
   ▼
Supabase — Postgres + RLS · Auth · Storage (avatars, pin-images, storefront-covers)
```

Three things shape almost every design decision in `src/lib`:

1. **Most outbound calls cost money.** Lens searches, CK scrapes and model calls are all paid, so
   every one of them sits behind a memory cache, a shared Postgres cache, an in-flight dedupe map,
   and a process-wide concurrency limiter — in that order.
2. **Nothing downstream of a read may fail the request.** No trends → rank from the Pin's own
   vocabulary. No model → deterministic composed copy. No detector → whole-image search. No CK →
   show Lens's price, flagged unverified.
3. **The UI streams.** Nothing waits for the slowest stage. Cards paint from partial data and refine
   under the user's eyes.

### Server functions

Every `*.functions.ts` export is a `createServerFn` handler with `requireSupabaseAuth` middleware and
a Zod validator. Globals are registered in [`start.ts`](src/start.ts):

- `attachSupabaseAuth` (client) — attaches the session's Bearer token to every RPC
- `createCsrfMiddleware` — scoped to `handlerType === "serverFn"`, so page navigation and SSR are untouched
- `errorMiddleware` — renders a branded 500 page instead of leaking a stack

[`server.ts`](src/server.ts) wraps the SSR entry to catch the case h3 swallows: an in-handler throw
becomes a plain `500 {"unhandled":true,"message":"HTTPError"}` that `try/catch` never sees.
[`error-capture.ts`](src/lib/error-capture.ts) records the real error out-of-band so the stack
survives.

---

## Pipeline 1 — product matching (a Pin image → buyable products)

Owned by [`vision-detect.server.ts`](src/lib/vision-detect.server.ts) and
[`pinterest.functions.ts`](src/lib/pinterest.functions.ts). Eleven lossy stages:

```
Pin image
  │
  1. DETECT      vision model → up to 6 boxes, each with a label + category
  │              (normalised 0–1 coords; no crop image is ever created or stored)
  2. CROP PARAM  box → Lens `crop=x1;y1;x2;y2`; Google crops at full resolution itself
  3. LENS        one search per object + one whole-image search, in parallel
  4. NORMALISE   clean redirect/tracking URLs
  5. RETAILER    drop anything not on the paying-retailer allowlist (Set lookup, O(depth))
  6. RANK        Lens position + title-keyword overlap vs the Pin's own copy + stock hint
  7. DEDUPE      same product from two sources collapses, best rank wins
  8. CATEGORY    does the product's category match what the detector said the object was?
  9. LOOK GATE   vision model verdict per card: same · close · different
 10. TOP N       per component
 11. CK DETAILS  live retailer page → real MRP, discounted price, in-stock
```

**Why boxes and not crops.** The old path cropped server-side, uploaded each crop to a public bucket,
and fed Lens the crop URL — ~27–50s and a storage write per object. The current path passes the
region as a Lens parameter, so no crop image exists anywhere. The `pin-crops` bucket migration is a
leftover from the old design.

**Streaming, in three stages** ([`use-visual-search.ts`](src/hooks/use-visual-search.ts)):

| Stage | Cost | What the user sees |
| --- | --- | --- |
| 1 · detection | ~6s cold, instant warm | the product pills ("Bag", "Sunglasses") |
| 2 · fast | Lens + category gate | **the cards** — this is what the screen was waiting for |
| 3 · verified | look gate, 10–30s | a reorder, a badge, the occasional lookalike removed |

Stage 3 used to be inside stage 2, which left the grid empty during the slowest and least urgent work
in the pipeline. Each card's CK lookup is then its own React Query
([`use-product-details.ts`](src/hooks/use-product-details.ts)), so one slow retailer never holds up
its neighbours and a sibling resolving never re-renders the rest.

**Caching.** Detections (`image_detections`), Lens results (`lens_searches`) and look verdicts
(`look_verdicts`) are cached in **shared** Postgres tables — none of them depend on *who* asked, and
in-process Maps die with every Cloudflare isolate. Plus per-component pool caches, in-flight dedupe,
and process-wide limiters (`LENS_CONCURRENCY = 16`, `CK_CONCURRENCY = 8`).

**Category vocabulary.** [`product-category.ts`](src/lib/product-category.ts) owns one closed enum
used by three parties that must agree: the detector (classifying objects), the matcher (classifying
retailer titles), and the gate (comparing them). `other` means "unrecognised", never "miscellaneous"
— it is the value that switches the gate *off*. The file is deliberately keyword-heavy: a head noun
missing from it is a shoppable product the pipeline can never see.

---

## Pipeline 2 — Pinterest SEO / Boost

Six stages, **exactly one paid model call per Pin**
([`pin-seo.functions.ts`](src/lib/pin-seo.functions.ts)):

| # | Stage | Cost |
| --- | --- | --- |
| 1 | **CONTEXT** — the Pin, its board, sibling titles, creator niche, tagged product, prior suggestions | Supabase reads |
| 2 | **SUBJECT** — what the Pin is about, from its own metadata ([`pin-subject.ts`](src/lib/pin-subject.ts)) | free, instant |
| 3 | **TRENDS** — seeds expanded against real Pinterest Trends via Apify ([`pinterest-trends.server.ts`](src/lib/pinterest-trends.server.ts)) | cache-first, shared across all users |
| 4 | **PLAN** — deterministic ranker picks a primary keyword + supporting + long-tail ([`pin-keywords.ts`](src/lib/pin-keywords.ts)) | free |
| 5 | **COPY** — one vision call: the Pin image + the plan → title & description. Validated, mechanically repaired, retried once with feedback | **paid** |
| 6 | **SCORE** — deterministic 0–100 SEO score recorded alongside | free |

**Relevance before volume.** Pinterest's related-search expansion is noisy — seeding "casual outfit"
genuinely returns "zoo outfit". So candidates are scored on relevance to the Pin's own vocabulary
first, and search volume only ranks what survived.

**The copy contract.** [`pin-seo.ts`](src/lib/pin-seo.ts) holds four things in one file on purpose:
the prompt, the validator, deterministic repairs, and a model-free fallback. Every rule dropped from
the prompt to save tokens still has to be enforced by the validator, so they cannot live apart. Its
bands mirror [`health-score.ts`](src/lib/health-score.ts) exactly, so an approved suggestion is
guaranteed to *raise* the Boost score.

Rules enforced: front-loaded title (the grid truncates around 30–40 chars on mobile), primary
keyword inside the first 120 chars of the description (only ~100 show before "more"), natural
sentences not keyword lists, **no hashtags** (Pinterest retired hashtag search), save-oriented CTA.

**Boards are not big Pins.** [`board-seo.ts`](src/lib/board-seo.ts) is separate because a board name
is a *category* ("Mid Century Living Room Decor"), not a product, capped at 50 chars, and renaming it
changes a URL people may have saved — so a suggestion that isn't a genuine improvement on the current
name is rejected rather than applied.

**The deck.** [`use-ai-rewrites.ts`](src/hooks/use-ai-rewrites.ts) renders all cards immediately with
empty fields and fills each in place. Fetching is lazy and cursor-driven with a 2-card lookahead, so
a 40-Pin deck costs a handful of model calls unless the user actually works through all forty.
`ensure()` covers the one case that can't use placeholders: bulk approve.

---

## Health Score

[`health-score.ts`](src/lib/health-score.ts) — pure, synchronous, deterministic, so the dashboard can
re-score instantly after a fix and animate the number climbing. Four weighted sub-scores:

| Sub-score | Measures |
| --- | --- |
| `pinSeo` | Title 40–100 chars, description 200–500, no placeholder text |
| `boardStructure` | Board name + description present and substantive |
| `profile` | Bio, avatar, website, socials — read **live from Pinterest**, not from the storefront |
| `freshness` | Activity within 30 days; stale boards surfaced by name |

Profile completeness deliberately scores the **Pinterest** profile. It used to score the ShopMyPin
storefront, which meant a creator with a perfect storefront and an empty Pinterest bio scored 100
while every visitor who tapped through from a Pin landed on a blank page. Nothing here is writable —
Pinterest owns those fields, so the app reports what's missing and deep-links to the exact settings
page.

---

## Coin wallet

Boost spends coins ([`coins.ts`](src/lib/coins.ts), `20260729130000_coin_wallet.sql`):

- **1 coin = 1 Pin boost** (applying an AI rewrite to one Pin)
- **100 coins per week**, reset — not accrued — at Monday 00:00 UTC, matching Postgres
  `date_trunc('week', …)` so client and server always agree which week a balance belongs to
- Unspent coins do not roll over; ledger reasons: `signup_grant`, `weekly_reset`, `pin_boost`,
  `pin_boost_refund`, `topup`, `adjustment`

[`use-wallet.ts`](src/hooks/use-wallet.ts) falls back to a **device-local balance** when the wallet
migration hasn't been applied (PostgREST `PGRST202` / `42P01`). The pill, the prices and the
spend/refund loop all work, the sheet says plainly that the balance is local, and the moment
`wallet_balance` starts answering the server ledger takes over permanently. A missing feature must
never lock a creator out of their own Pins.

---

## Pinterest integration

[`pinterest-api.ts`](src/lib/pinterest-api.ts) is a low-level v5 client using only Web Crypto and
`TextEncoder` — no `node:crypto`, no `Buffer` — so it runs unmodified on Node or Workers. Every
export is called only from inside a `createServerFn` handler, so the app secret and access tokens
never enter the browser bundle.

**OAuth** ([`pinterest-oauth.functions.ts`](src/lib/pinterest-oauth.functions.ts)): the redirect URI
is resolved against the origin the request actually came from and **signed into the state**, so the
token exchange presents the identical string Pinterest compares byte-for-byte. A mismatch against
`PINTEREST_REDIRECT_URI` logs a warning naming both URLs and what to do about it.
`withPinterestToken()` wraps every call with refresh-on-expiry.

**Sync is a reconcile, not an import**
([`pinterest-sync.functions.ts`](src/lib/pinterest-sync.functions.ts)). The original importer only
ever INSERTed, so renaming a board or rewriting a Pin on pinterest.com changed nothing here, deleted
Pins lived forever, and a connection made from Settings never synced at all. The current sync fetches
the account as it is now and makes the local copy match: create new, **update changed**, flag
disappeared, backfill analytics within a time budget. Idempotency keys are per-user, not global
(`20260803140000_pinterest_ids_per_user.sql`).

It never throws for an expired or revoked connection — that sets `needsReconnect` on the result and
flips the connection's `needs_reauth`, so the UI shows "reconnect Pinterest" instead of an empty
dashboard that looks like a bug. Auto-sync runs from the authenticated layout when the local copy is
>10 min stale, including on tab focus — exactly when someone returns from editing boards on
Pinterest.

Only Pins the creator **authored** are synced (`pins.is_owner`), never Pins they merely saved.

---

## Data model

Generated types: [`src/integrations/supabase/types.ts`](src/integrations/supabase/types.ts).

### Core

| Table | Notes |
| --- | --- |
| `profiles` | 1:1 with `auth.users`; `onboarding_completed`, `pinterest_connected` gate the app |
| `storefronts` | One per creator (enforced); `slug` → `/s/:slug`, brand color, background image |
| `collections` | **This is what the app calls a "board"** — carries `pinterest_board_id`; `hidden_from_storefront_at` is a soft-remove |
| `boards` + `board_collections` | Pinterest-style board grouping for the storefront's Boards tab |
| `pins` | `status` (draft/live), `is_owner`, `collection_id` vs `origin_collection_id`, metrics (`impressions`, `clicks`, `conversions`, `earnings_cents`) |
| `storefront_products` | An attached affiliate product: `affiliate_url`, price, commission, routed to a `pin_id` and/or `collection_id` |
| `pinterest_connections` | Access/refresh tokens. **No GRANT or policy for `anon`/`authenticated` at all** — service-role only |
| `pin_suggestion_history` | Every AI suggestion, whatever the outcome — powers 24h reuse and "avoid these phrasings" |

> **`collection_id` vs `origin_collection_id`.** Going live re-homes a Pin into its own per-Pin
> container, so `collection_id` stops pointing at a board. `origin_collection_id` is the only
> remaining link back to the real board — always use `boardIdOf()` for scoring, or a board looks
> empty and stale.

### Shared caches

Not per-user, by design — the answers don't depend on who asked, and in-process Maps die with every
Workers isolate.

| Table | Caches |
| --- | --- |
| `image_detections` | Object detection per image URL |
| `lens_searches` | Lens results per (image URL, crop region) |
| `look_verdicts` | Look-gate verdicts per (image URL, target) |
| `pinterest_trend_cache` | Trends: 7-day TTL for keyword expansion (Pinterest publishes weekly), 1-day for country trending |

### Storage buckets

`avatars` (public read, per-user write) · `pin-images` (authenticated read) · `storefront-covers`
(public) · `pin-crops` (**unused** — leftover from the old crop-and-upload detector)

### RLS

Owner-only (`auth.uid() = user_id`) everywhere, plus narrowly scoped public read for the storefront
page. `20260803150000_scope_public_read.sql` is worth reading: six tables carried `USING (true)`
granted to `anon, authenticated`, which meant **any logged-in user could read any other creator's
data**. Public read is now scoped to `anon` and to published/live rows only.

Every migration opens with a comment explaining the bug or requirement it exists for. They're the
best change-log this project has.

---

## Auth & security

- **Sign-in** ([`auth.tsx`](src/routes/auth.tsx)) is a phone + 6-digit OTP UI, but the OTP is
  currently a **hardcoded constant** and the credential pair is derived deterministically from the
  phone number via `signInWithPassword`, falling back to `signUp`. No SMS provider is wired. This is
  a demo stub — **replace it with `supabase.auth.signInWithOtp` before any real launch.** A Lovable
  OAuth helper (Google / Apple / Microsoft) exists at
  [`integrations/lovable/`](src/integrations/lovable/index.ts) but isn't wired into the sign-in
  screen.
- **Route gate**: `_authenticated/route.tsx` has `ssr: false` and a `beforeLoad` that redirects to
  `/auth` without a session, or to `/onboarding` until both `onboarding_completed` and
  `pinterest_connected` are true.
- **Token verification** ([`token-verifier.ts`](src/integrations/supabase/token-verifier.ts)):
  Supabase signs access tokens with one stable ES256 key, so the JWKS is fetched once at boot and
  every request verifies locally with WebCrypto — zero network per request. It is a **fast path
  only**: it can accept a token, never reject one. Anything it can't positively verify (cold cache,
  rotated `kid`, non-ES256) falls through to Supabase's authoritative `getClaims`, so correctness
  never depends on this code being exhaustive.
- **Service-role isolation**: `getServiceSupabase()` throws if `typeof window !== "undefined"`.
  `client.server.ts` must be dynamically imported inside handlers — a top-level import is safe only
  from other `*.server.ts` modules, because route files and `*.functions.ts` ship to the client
  bundle.
- **CSRF**: `createCsrfMiddleware` rejects cross-site server-function calls, filtered to `serverFn`
  only.
- **SSRF**: [`link-preview.functions.ts`](src/lib/link-preview.functions.ts) fetches user-supplied
  URLs server-side, so it refuses localhost, `.local`/`.internal`, IPv6 literals and every private
  IPv4 range, caps the read at 300KB, and stops at `</head>`.
- **Error copy**: [`friendly-error.ts`](src/lib/friendly-error.ts) translates Postgres/OAuth/network
  strings into user-safe text without changing what was thrown.

---

## Observability & debugging

| Tool | How |
| --- | --- |
| Server logs | `grep "[net]"` — [`net-logger.ts`](src/lib/net-logger.ts) emits structured `event k=v` lines for every cache hit/miss, retry, timeout and duration |
| Client logs | `grep "[pipeline]"` — [`pipeline-log.ts`](src/lib/pipeline-log.ts) records **ttfp** (first product painted), **ttfcp** (first complete card), and **done** |
| **Match funnel panel** | [`funnel-debug.tsx`](src/components/funnel-debug.tsx) + `visualSearchDebug` — replays the real pipeline with a trace and shows every stage's survivors, every dropped candidate with its `DropReason`, the detector's boxes, and each look verdict |
| Enabling it | Dev server always; otherwise `?debug=1` on any URL, which **latches** into `localStorage` so it survives the navigations the flow itself performs. `?debug=0` clears it |

The funnel panel exists because the visible screen only ever showed the last of eleven lossy stages:
boxes never reached the browser, crops are virtual, and the gate that causes most complaints logged
nothing at all. A traced run skips every cache and its results are never written back, so the debug
view can neither be answered by nor pollute the cache the real screen reads.

---

## Resilience conventions

- [`resilient-fetch.ts`](src/lib/resilient-fetch.ts) — `withConnectRetry` retries connect-level
  failures (`UND_ERR_CONNECT_TIMEOUT`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`) up to 4 attempts with
  300ms/1s/3s backoff. These are *local* outbound-networking conditions, not remote outages: the same
  URL answers instantly from `curl` moments later.
- [`net-dispatcher.server.ts`](src/lib/net-dispatcher.server.ts) — one-time undici tuning. The Lens
  and CK fan-out opens many concurrent sockets, and undici's ~4s keep-alive let the pooled Supabase
  socket idle-close between calls (a single Lens request can take 7–16s), forcing a cold reconnect
  that then couldn't get through under load. So: keep idle sockets warm much longer, raise the
  per-origin ceiling, and shorten the connect timeout so a genuinely stuck connect fails fast and the
  retry recovers.
- [`concurrency-limiter.ts`](src/lib/concurrency-limiter.ts) — limiters are **module-level, not
  per-call**. A per-call pool only bounds fan-out within one call; with several server functions
  running concurrently, N × cap is the real socket count.
- Timeouts are sized from measured latency, not guessed: Lens genuinely takes ~13–15s, so the budget
  is 16s with **zero retries** — a tight 7s budget timed out first attempts that would have
  succeeded, then re-ran the identical paid query for ~20s wall-clock.

---

## Deployment

`bun run build` emits `.output/`:

- `.output/server/` — Nitro server, `cloudflare-module` preset, `nodejs_compat`
- `.output/public/` — static assets

```bash
npx wrangler --cwd .output/server dev      # local preview of the built worker
npx wrangler --cwd .output/server deploy   # deploy (worker: ekproduct-pinearn)
```

The same output also runs on Node; a Vercel deployment exists at `pinearn.vercel.app`. Set every
non-`VITE_` variable as a server-side secret — never as a build-time `VITE_` var, which would inline
it into the browser bundle.

This project is **connected to Lovable**. Commits pushed to the connected branch sync back into the
Lovable editor, so keep that branch working, and never rewrite published history (force-push, rebase,
amend or squash of pushed commits) — it rewrites history on Lovable's side and the project's history
is lost. See [AGENTS.md](AGENTS.md).

---

## Conventions & gotchas

**Routing.** File-based, `src/routes/` only. Do **not** create `src/pages/`, `app/layout.tsx` or
other Next.js/Remix shapes. `routeTree.gen.ts` is generated — never hand-edit. Full conventions table
in [src/routes/README.md](src/routes/README.md).

**Vite config.** `@lovable.dev/vite-tanstack-config` already includes `tanstackStart`, `viteReact`,
`tailwindcss`, `tsConfigPaths`, Nitro, the component tagger, `VITE_*` injection, the `@` alias and
React/TanStack dedupe. Adding any of them manually breaks the app with duplicate plugins.

**`__root.tsx` has load-bearing `data-tsd-source` attributes** on `<html>`, `<head>` and `<body>`.
They suppress the dev source-tagger's auto-injection, which computes different line/column values for
this one file on the SSR and client module graphs — and since `RootShell`'s output *is* the hydration
root, that mismatch surfaces as a hydration warning. Do not remove them.

**Naming.** A "board" in the UI is a row in `collections`. The `boards` table is the storefront's
Pinterest-style grouping layer.

**Currency.** The affiliate catalogue is India-first (Myntra, AJIO, Flipkart, Amazon.in, Nykaa), with
earnings in ₹ and Pinterest Trends country resolved from currency, defaulting to `US`.

**Dead weight.** The `pin-crops` bucket and `VISION_DETECT_API_URL` belong to the retired
crop-and-upload detector. The current pipeline stores no crop image anywhere.

**Accessibility & motion.** `MotionConfig reducedMotion="user"` is set app-wide; imperative
`animate()` calls additionally self-guard via `useReducedMotion()`. Theme (`light`/`dark`) is read
from `localStorage` and applied once on boot in `__root.tsx` — Settings only writes the preference.

---

## License

MIT — see [LICENSE](LICENSE).
