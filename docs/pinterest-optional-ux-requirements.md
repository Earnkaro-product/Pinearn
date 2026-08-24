# Pinterest-Optional UX — Annotated Requirements & QA

**Scope** — the change set that makes Pinterest authorization optional at the door and enforces it per action, removes premature activation prompts, and repairs failure/empty states.

**Provenance and its limits.** The review transcript was not available when this document was written. Requirements were reconstructed from the working-tree diff against `HEAD` (33 modified files, 7 new files), which is the implementation of the review, plus the eight verification targets named in the brief. Consequences you must read before using this:

- **"Current issue"** is the behaviour at `HEAD`, read from the diff and from the rationale comments the implementation carries. It is evidence, not the reviewer's words.
- **Exact copy** marked `VERBATIM` is quoted character-for-character from the implementation. It is what will ship. Where the review specified copy, this is it; where the review did not, this is the implementer's copy and is open to edit.
- **Priority** is *proposed*, not transcribed. The review's own ranking is unknown.
- **Nothing here is inferred beyond the diff.** Where behaviour is undefined or two implementations disagree, it is raised in [Open decisions](#open-decisions) rather than resolved.

Legend — **P0** ships or the release is broken · **P1** ships with the release · **P2** follow-up.
`⚑` marks a requirement that cannot be completed without a product or design decision.

---

## A. Authorization model

The spine of the change set. Everything in B–E depends on A1.

### A1 — Route guard must stop requiring a Pinterest connection
| | |
|---|---|
| **Screen / flow** | `_authenticated` route guard (`src/routes/_authenticated/route.tsx`) |
| **Current issue** | `beforeLoad` redirected to `/onboarding` unless `onboarding_completed` **and** `pinterest_connected`. Any "skip" was structurally impossible: the write landed, the next navigation re-read the profile, and the redirect fired again. |
| **Required change** | Guard checks `onboarding_completed` only. `pinterest_connected: false` is a valid, fully-supported state for an authenticated user. |
| **Priority** | **P0** |
| **Dependency** | None. **Blocks A2, A3, B1, B2, C1, E1.** |
| **Acceptance criteria** | 1. Profile with `onboarding_completed: true`, `pinterest_connected: false` reaches every authenticated route without redirect. 2. Profile with `onboarding_completed: false` still redirects to `/onboarding` from every route except `/onboarding`. 3. Unauthenticated user still redirects to `/auth` carrying `redirect=<href>`. 4. The guard's `select` no longer requests `pinterest_connected`. |

### A2 — Per-action gate for actions that write to or read live Pinterest
| | |
|---|---|
| **Screen / flow** | `usePinterestGate()` (`src/components/pinterest-gate.tsx`); consumer: board import on My Store |
| **Current issue** | Board import fired regardless of connection state and failed *inside* the progress sheet, reading as "the sync is broken" rather than "we need access". |
| **Required change** | An action needing Pinterest is wrapped in `gate.run(reason, action)`. Three paths: **connected** → runs immediately, no prompt; **state still loading** → prompt opens in a checking state and the action fires itself once the state resolves as connected; **not connected** → non-skippable prompt. There is no path that runs the action unauthorized. |
| **Exact copy** | Sheet title `VERBATIM`: "Pinterest access needed" / when the token is dead: "Reconnect Pinterest to continue". Non-skippable notice `VERBATIM`: "This one can't be skipped — it acts on your Pinterest account. Everything else in ShopMyPin stays open to you either way." Buttons: "Connect Pinterest" / "Reconnect Pinterest" / "Checking your connection…" / "Opening Pinterest…" / "Not now". Board-import reason `VERBATIM`: action "Import your boards and Pins", reason "Importing reads the boards and Pins on your Pinterest account. Nothing on Pinterest is changed — this only copies them into your store." |
| **Priority** | **P0** |
| **Dependency** | A1 |
| **Acceptance criteria** | 1. Connected: pressing Sync starts the import with no prompt and no flicker. 2. Not connected: the sheet opens and the import does **not** start. 3. Sheet is `dismissible: false` — Escape and backdrop tap do not close it and do not run the action. 4. "Not now" closes the sheet and abandons the action. 5. Authorizing and returning re-enters the screen with no action auto-fired; the creator presses Sync again. 6. If the connection query resolves as connected while the sheet is open, the sheet closes and the action runs exactly once. |

### A3 — Whole-screen gate for screens that are only Pinterest data
| | |
|---|---|
| **Screen / flow** | `PinterestConnectPanel`; consumers: `/pins/create`, `/boost` |
| **Current issue** | Screens built entirely from Pinterest data rendered empty or zeroed with no explanation. |
| **Required change** | The screen's content is replaced by an offer with the reason attached — not an error, the creator did nothing wrong by skipping — and always keeps a route out (`backTo`), so a gated page cannot become a dead end. `/pins/create` gates at the door, not at Publish: the board list comes from the account and step 4 publishes, so stopping someone after they have uploaded an image, written a title and picked products would waste all of it. |
| **Exact copy** | `/pins/create` `VERBATIM`: title "Connect Pinterest to create a Pin"; reason "A new Pin is published to your Pinterest account, and its board comes from there too — so this is the one flow that can't run without authorization."; bullets "We only publish the Pin you build here, when you press Publish." / "Your existing Pins and boards are imported, never changed." / "The rest of ShopMyPin — your store, products and links — stays open without it."; back "Back to Pins". `/boost` `VERBATIM`: title "Connect Pinterest to get your SEO score"; reason "Your score is built from your real Pins, boards and Pinterest profile — the titles, descriptions and how recently you posted. Without access to them there is nothing here to measure."; bullets "Read-only to begin with: we score what's already on your account." / "Nothing on Pinterest is edited unless you apply a fix yourself." Revoked-token variant `VERBATIM`: "Reconnect Pinterest to use this" + "Pinterest's access expired or was revoked, so this screen has nothing to read. Authorizing again brings it back." |
| **Priority** | **P0** |
| **Dependency** | A1 |
| **Acceptance criteria** | 1. `/pins/create` unauthorized shows the panel, never the wizard. 2. While the connection query is pending the screen shows a spinner, **not** the gate — a connected creator must never see "connect Pinterest" flash. 3. `/boost` gates only when the score is empty **and** the connection is unusable; a creator with imported Pins and a dead token still reaches their score. 4. Both panels keep a working back control. 5. Panel switches to reconnect copy when `needsReconnect`. |

### A4 — Analytics: only the Pinterest half waits for authorization
| | |
|---|---|
| **Screen / flow** | `/analytics` |
| **Current issue** | The Pinterest analytics query and the account sync fired on every page view regardless of connection — a guaranteed failure per view. |
| **Required change** | Orders, sales and earnings are first-party and shown to everyone. `getPinterestAnalytics` and the mount sync are `enabled` only when the connection is usable. The sync banner above the content carries the fix. |
| **Priority** | **P1** |
| **Dependency** | A1, C1 |
| **Acceptance criteria** | 1. Unauthorized: zero network calls to `getPinterestAnalytics`; no error toast. 2. Unauthorized: orders/sales/earnings still render. 3. Authorized: the mount sync fires exactly once per mount. 4. Impressions/Pin-clicks tiles do not display fabricated zeros as if measured. |

---

## B. First-time onboarding

### B1 — Replace the "Required" pill with a working skip
| | |
|---|---|
| **Screen / flow** | `/onboarding`, both steps (name, authorize) |
| **Current issue** | A padlock pill reading "Required" sat top-right. Nothing in the flow is required to use the product, so it was false; and there was no way past the authorize step. |
| **Required change** | The pill becomes the top-level exit, present on **both** steps — a creator who wants in should not have to answer two screens first. Skip writes `onboarding_completed: true` only; `pinterest_connected` stays false. A name typed but not submitted (≥2 chars) is carried over, including the storefront rename. Navigation to Home is a **hard** navigation, because the guard runs in `beforeLoad` and a soft push can land back on onboarding with the pre-skip profile snapshot. A failed profile write must **not** navigate — the flag would not stick and the creator would be sent back here on next boot. |
| **Exact copy** | `VERBATIM`: corner button "Skip for now" (pending: "Skipping…"); authorize-step button "Skip — I'll connect later" (pending: "Taking you in…"); success toast "You can connect Pinterest any time from Settings"; reassurance line under the skip "You can look around the whole app without this. We'll ask again — and only ask — when you do something that touches your Pinterest account." |
| **Priority** | **P0** |
| **Dependency** | A1 |
| **Acceptance criteria** | 1. No "Required" pill and no padlock anywhere in onboarding. 2. Skip from the name step lands on `/dashboard`; profile has `onboarding_completed: true`, `pinterest_connected: false`. 3. A name of ≥2 chars typed but not submitted is saved as `display_name` and the storefront is renamed. 4. Skip from the authorize step behaves identically. 5. A failed `profiles` update shows the friendly error and stays on the screen. 6. After skipping, a full reload of `/dashboard` does not return to onboarding. 7. Both skip controls disable and show a spinner while in flight; double-tap cannot double-write. |

### B2 — Failed import must offer a way forward, not only Retry/Cancel
| | |
|---|---|
| **Screen / flow** | `/onboarding` → sync sheet (`PinterestSyncModal`) |
| **Current issue** | A failed import offered "Retry sync" and "Cancel". Cancel dropped the creator back on the authorize card with its button already reading "Pinterest connected" and no way onward — a dead end. |
| **Required change** | The sheet gains an optional `onContinue` / `continueLabel`. Onboarding passes them: continuing writes `onboarding_completed`, closes the sheet, and hard-navigates Home. No data is lost — every screen re-syncs on its own and the Home banner offers the same retry. |
| **Exact copy** | `VERBATIM`: button label "Continue to Home"; toast "You're in — your boards will import on the next sync". Component default when a caller passes `onContinue` without a label: "Continue anyway". |
| **Priority** | **P0** |
| **Dependency** | B1 |
| **Acceptance criteria** | 1. Forced import failure shows three controls: Retry, Continue to Home, Cancel. 2. Continue lands on `/dashboard` with `onboarding_completed: true`. 3. The Home sync banner then offers the retry. 4. Callers that pass no `onContinue` render exactly as before. |

### B3 — Name-step copy says what the name is for
| | |
|---|---|
| **Screen / flow** | `/onboarding`, name step |
| **Current issue** | "What's your name?" / "Shown on your storefront." — the subtitle assumed the creator already knew they were getting a storefront, on the screen before they have seen one. |
| **Required change** | Heading and subtitle rewritten. |
| **Exact copy** | `VERBATIM`: "Hey, what's your name?" / "Your digital shop will be named after you." |
| **Priority** | **P2** |
| **Dependency** | None |
| **Acceptance criteria** | Both strings render as specified; the redundant "Exactly what this gives us." subtitle is gone from the authorize step. |

---

## C. Failure and retry

### C1 — One classifier for every Pinterest failure
| | |
|---|---|
| **Screen / flow** | `src/lib/pinterest-failure.ts`; every surface that connects Pinterest |
| **Current issue** | Every failure mode surfaced as the same `toast.error(e.message)` carrying raw server text (e.g. "Pinterest token exchange failed: … the redirect URI used was …"). Two defects: a toast disappears, leaving nothing on screen to press; and the text was unactionable. |
| **Required change** | Nine classified kinds — `declined`, `network`, `auth`, `forbidden`, `rate_limit`, `pinterest_down`, `state`, `config`, `unknown` — each carrying title, message, `canRetry`, `retryLabel`, `status`. Classification is by message pattern, not exception type, because these errors cross a server-function boundary that flattens everything to `Error(message)`; the status code is parsed back out of the composed message. Specific actionable causes are tested **before** generic status buckets (a 401 raised while verifying state is a state problem, not a token problem). `config` is the only `canRetry: false` — retrying an app misconfiguration can only fail the same way. |
| **Exact copy** | All nine title/message pairs are `VERBATIM` in `BY_KIND` and are the shipping copy. Retry labels: "Try again" / "Authorize again" (auth) / "Start again" (state). |
| **Priority** | **P0** |
| **Dependency** | None. **Blocks C2, C3, B2.** |
| **Acceptance criteria** | 1. `?error=access_denied` on the callback → `declined`. 2. HTTP 401 → `auth`; 403 → `forbidden`; 429 → `rate_limit`; ≥500 → `pinterest_down`; 404 → `config`. 3. A 400 from the token endpoint → `config`, not a retry loop. 4. Any message naming `PINTEREST_APP_ID` / `PINTEREST_REDIRECT_URI` / `PINTEREST_APP_SECRET` / `PINTEREST_API_BASE_URL` → `config`, `canRetry: false`. 5. State-token expiry → `state`, label "Start again". 6. `statusOf` extracts the code from both `"… failed (429): …"` and `"… status 429 …"` shapes and returns null for anything outside 100–599. 7. No raw server text reaches the UI on any path. |

### C2 — Every failure leaves something to press
| | |
|---|---|
| **Screen / flow** | `PinterestFailureNotice`; consumers: onboarding, OAuth callback, Settings, Profile, sync banner, gate sheet, connect panel |
| **Current issue** | Failures lived in toasts. On the authorize step the toast faded and left a button that looked untouched — which reads as "nothing happened", the one thing it must never read as. |
| **Required change** | An inline `role="alert"` block: title, message, the HTTP status as a small technical hint when present, a Retry (suppressed only when `canRetry: false`), and an optional `secondary` escape. Every consumer supplies a secondary where one makes sense. |
| **Exact copy** | `VERBATIM`: status hint "Pinterest returned status {n}."; retry pending state "Retrying…". |
| **Priority** | **P0** |
| **Dependency** | C1 |
| **Acceptance criteria** | 1. Every listed surface renders the notice inline and it persists until acted on. 2. Retry is disabled and shows a spinner while retrying; it cannot be double-fired. 3. `canRetry: false` renders no Retry, but the secondary is still present. 4. The status hint is absent when `status` is null. 5. Screen readers announce the notice (`role="alert"`). |

### C3 — OAuth callback: retry means re-authorize, and lands the creator somewhere real
| | |
|---|---|
| **Screen / flow** | `/pinterest/callback` |
| **Current issue** | The page held a raw error string and offered a "Try again" that navigated to `/onboarding` — for anyone connecting from Settings that was neither a retry nor where they were. |
| **Required change** | All four failure entry points (Pinterest's `?error=`, missing code/state, token exchange, sync) resolve into one classified failure. **Retry restarts the authorization**, never re-mounts the page — the code in the URL is already spent, so a reload could only fail. Destination depends on onboarding status: mid-onboarding retries return to `/onboarding`, otherwise `/dashboard`. Giving up mid-onboarding records the skip first, so the guard does not bounce the creator back to a screen they just chose to leave. |
| **Exact copy** | `VERBATIM`: secondary "Skip for now" (mid-onboarding) / "Back to ShopMyPin" (otherwise), pending "One moment…"; footer "Nothing was connected, and nothing in ShopMyPin changed."; mid-onboarding toast "You can connect Pinterest any time from Settings". |
| **Priority** | **P0** |
| **Dependency** | C1, C2, A1 |
| **Acceptance criteria** | 1. Retry initiates a fresh OAuth round-trip; the spent code is never replayed. 2. Mid-onboarding retry returns to `/onboarding`; post-onboarding retry to `/dashboard`. 3. Mid-onboarding "Skip for now" writes `onboarding_completed: true` and lands on `/dashboard` without a bounce. 4. Post-onboarding "Back to ShopMyPin" lands on `/dashboard` with no profile write. 5. Arriving with `?error=access_denied` shows the `declined` copy, never a raw string. 6. Arriving with no `code`/`state` shows the state-expiry classification. |

### C4 — Sync banner covers all three connection states
| | |
|---|---|
| **Screen / flow** | `PinterestSyncBanner` — Home, `/analytics`, `/profile`, `/pins` empty state |
| **Current issue** | The banner returned `null` unless a connection existed, so "never connected" was invisible. A creator who skipped had no route back to authorization. A failed reconnect vanished into a toast, leaving an amber banner that looked exactly as it had a second earlier. |
| **Required change** | Three states: **never connected** → an offer (not a nag, not an error); **`needsReconnect`** → amber reconnect; **connected** → last-synced timestamp and a manual re-sync. Failures render inline via C2. `connect()` defaults its `returnTo` to the current path, so the creator lands back on the screen they started from. A `compact` variant renders as a pill. |
| **Exact copy** | `VERBATIM` — never connected: "Pinterest isn't connected" / "Connect it to import your boards and Pins and to see real impressions and clicks. Everything else in ShopMyPin works without it." / button "Connect"; compact "Connect Pinterest" / "Opening…". Reconnect: "Pinterest needs reconnecting" / "Its access expired or was revoked, so nothing new can be imported. Your Pins, boards and earnings in ShopMyPin are untouched." |
| **Priority** | **P0** |
| **Dependency** | C1, C2 |
| **Acceptance criteria** | 1. Never connected: banner appears on Home and offers Connect. 2. Connected and healthy: no banner on Home. 3. `needsReconnect`: amber banner with Reconnect. 4. A failed connect/reconnect shows the inline notice under the banner with a working Retry. 5. Authorizing from any host screen returns to that same screen. |

---

## D. Premature activation prompts

### D1 — Delete the post-onboarding activation modal
| | |
|---|---|
| **Screen / flow** | Home (`NewUserCta`, `src/components/new-user-cta.tsx` — **deleted**) |
| **Current issue** | A full-screen, non-dismissible-by-tap modal fired once per browser immediately after onboarding, switching pitch on pin count. It pushed an action before the creator had seen anything, it locked `document.body` scroll, and it said the same kind of thing whichever flow the creator was headed into. |
| **Required change** | Component deleted and its Home mount removed. Its replacement is contextual: see D2. |
| **Priority** | **P0** |
| **Dependency** | D2 (so the education is not simply lost) |
| **Acceptance criteria** | 1. `src/components/new-user-cta.tsx` does not exist and nothing imports it. 2. A brand-new account reaching Home sees no blocking overlay. 3. `document.body.style.overflow` is never written by Home. 4. `localStorage` key `pinearn.newUserCtaSeen` is no longer read or written. |

### D2 — Contextual primer, inside the flow it explains
| | |
|---|---|
| **Screen / flow** | `FlowPrimer` — `/pins/attach` (`monetize-pin`), `/pins/create` step 1 (`create-pin`), `/storefront` (`store`) |
| **Current issue** | See D1. |
| **Required change** | An inline card at the top of the flow it explains, above that flow's own UI. Rules, each load-bearing: it is **never a modal** — the flow is usable with the card open; it carries **no call to action** — the flow's own controls are the CTA, and a button here would be the activation push relocated; it shows **once per flow per browser**, keyed independently per flow (`pinearn.primer.<flow>`); `localStorage` failure fails *closed* (a card that never shows beats one that shows every visit); the first render must not depend on `localStorage`, so server and hydration renders match. |
| **Exact copy** | All three headline/body/step-label sets are `VERBATIM` in `PRIMERS`. Controls: "Got it" and an X labelled "Dismiss". |
| **Priority** | **P1** |
| **Dependency** | None |
| **Acceptance criteria** | 1. Each of the three flows shows its own card on first visit and never again after dismissal. 2. Dismissing one flow's card does not dismiss another's. 3. No overlay, no scroll lock, no focus trap; the flow beneath is operable with the card open. 4. The card contains no CTA that navigates or mutates. 5. `/pins/create` shows it only on step 1. 6. `/pins/attach` shows it only when no board is open. 7. No hydration mismatch warning. 8. Private-mode Safari (throwing `localStorage`) shows no card and logs no error. |

### D3 — Boost must not scan before the creator knows what it is
| | |
|---|---|
| **Screen / flow** | `/boost` |
| **Current issue** | The "analysing your Pinterest" choreography fired the moment the route mounted — answering a question nobody had asked. A first-time creator does not know what Pinterest SEO is or why a score of it matters. |
| **Required change** | A three-screen sequence earns the scan: the problem, what the AI does, then the ask. The CTA triggers the analyzer; the analyzer choreography itself is unchanged. Gated once per session — the same gate the analyzer already used — and skipped entirely when returning from a fix flow, because the climbing score *is* that moment. Skip is reachable top-right on both non-final screens and goes straight to the scan. |
| **Exact copy** | `VERBATIM`: "Great Pins get buried" / "Weak titles, keywords and boards keep your best Pins out of Pinterest search."; "AI that tunes everything" / "It rewrites, re-keywords and reorganizes your whole Pinterest — automatically."; "Your score is waiting" / "See exactly what's holding your Pinterest growth back." / CTA "Check Your Pinterest SEO Score". |
| **Priority** | **P1** |
| **Dependency** | A3 (the gate is evaluated before the intro) |
| **Acceptance criteria** | 1. First `/boost` visit in a session: intro screens, no scan running. 2. Pressing the CTA starts the analyzer; the score follows. 3. Second `/boost` visit in the same session: straight to the score, no intro, no scan. 4. Returning from a fix flow: straight to the climbing score, no intro. 5. Skip on screens 1–2 goes directly to the scan. 6. Back is available on screens 2–3 and absent on 1. 7. Unauthorized with an empty score: the connect panel wins over the intro. 8. Under `prefers-reduced-motion` the animated screens render their finished state, never an empty one. |

---

## E. Empty and zero states

### E1 — "No pins" must distinguish *never imported* from *nothing monetized*
| | |
|---|---|
| **Screen / flow** | `/pins` empty state |
| **Current issue** | One message for two unrelated problems. Telling someone with no Pins at all to "attach a product to a pin" sends them looking for a button that cannot help them. |
| **Required change** | Three-way copy: not connected → explain that Pins live on Pinterest and render the sync banner inline; connected with a storefront → attach; no storefront → add a storefront and product first. Already-imported Pins stay fully usable without a live connection. |
| **Exact copy** | `VERBATIM` not-connected body: "Your Pins live on Pinterest. Connect it and we'll import them here — or create one from scratch." Heading stays "No pins here". |
| **Priority** | **P1** |
| **Dependency** | A1, C4 |
| **Acceptance criteria** | 1. Unauthorized, zero pins: the not-connected copy plus a working `PinterestSyncBanner`; no "Attach" CTA. 2. Authorized, zero pins, storefront exists: attach copy and CTA. 3. Authorized, zero pins, no storefront: storefront-first copy, no CTA. 4. Unauthorized but with previously imported pins: the grid renders normally, no empty state. |

### E2 — "Connected, synced, and genuinely empty" is not a failure
| | |
|---|---|
| **Screen / flow** | `PinterestSyncBanner`; onboarding/callback sync summary |
| **Current issue** | An account holding only re-saved Pins imported zero and looked identical to a broken import — a blank grid and "0 pins". |
| **Required change** | When `counts.pins === 0` and `savedSkipped > 0`, say so plainly with a "Sync now" affordance. The sync summary applies the same rule: "0 pins" alone reads as a failed import. |
| **Exact copy** | `VERBATIM` banner: "{n} saved Pin/Pins found, none created by you" / "ShopMyPin monetises Pins you made yourself — a Pin you saved from someone else keeps their link, so there is nothing here to attach a product to. Create a Pin on @{username} and it will appear on the next sync." Summary `VERBATIM`: "{n} saved Pin/Pins found — ShopMyPin works on Pins you created yourself". |
| **Priority** | **P1** |
| **Dependency** | C4 |
| **Acceptance criteria** | 1. Account of only saves: the explanatory banner, never an error. 2. Singular/plural correct at n=1. 3. `@username` used when known, "your account" when not. 4. Callback summary shows the saved-Pins sentence instead of "0 pins · 0 boards". 5. An account with created Pins is unaffected. |

### E3 — Boost decks contain only failing items; the empty deck is the optimized state
| | |
|---|---|
| **Screen / flow** | `/boost/pins`, `/boost/boards` |
| **Current issue** | Both decks offered every Pin and every board, including passing ones. A passing item has no points to give, so offering to "fix" it is noise — or an invitation to break something that works. |
| **Required change** | Build the deck from failing items only. When nothing fails the deck is empty and the page shows the optimized state. Crucially, the points denominator stays **all** items on the account (`totalPins` / `totalBoards`), not the failing subset — the pass rate is measured against everything. |
| **Priority** | **P1** |
| **Dependency** | None |
| **Acceptance criteria** | 1. A passing Pin/board never appears in a deck. 2. All-passing account: optimized state on both routes, no empty deck shell. 3. Per-item points are computed against the full account count; the picker header's total gain matches the sum of its rows. 4. Every remaining card shows non-zero points. |

---

## F. Header counter scoping ⚑

### F1 — Coin counter hidden where it is noise ⚑
| | |
|---|---|
| **Screen / flow** | `AppShell` `hideWallet`; `WalletPill` |
| **Current issue** | The coin balance rendered in the header on every screen and competed with each screen's own CTA. Tapping a ~90px capsule darkened the entire screen with a modal sheet plus a ledger — the wrong weight for three facts (how many are left, when they refill, what they buy). |
| **Required change** | `AppShell` accepts `hideWallet`; the pill is suppressed on screens that cannot spend coins. The sheet becomes an anchored popover with a beak, click-away and Escape, and no ledger. |
| **Priority** | **P1** |
| **⚑ Decision required** | The brief calls for **"all specified token counters"** to be **removed**. No token or credit counter exists in this codebase — the only counter is the weekly **coin** wallet, and the implementation *scoped and restyled* it rather than removing it. It is currently hidden on `/pins` only. Before this can be verified, product must state: (a) is the coin wallet the counter in question; (b) removed outright, or hidden per screen; (c) if per screen, the exact list. Coins are spent only in the Boost flows, which argues for hiding everywhere except those — but that is not in the diff and is not assumed here. |
| **Acceptance criteria** *(pending the decision)* | 1. The pill is absent on every screen on the agreed list and present on the rest. 2. The popover opens on tap, closes on re-tap, click-away and Escape. 3. It never traps focus or blocks the header. 4. `aria-expanded` / `aria-haspopup` are correct; the pill's `aria-label` still states balance, allowance and refill. 5. The ±n delta flash still fires on a balance change. |

---

## G. Navigation

### G1 — Back follows real history, with the declared parent as deep-link fallback
| | |
|---|---|
| **Screen / flow** | `useGoBack`; `AppShell`; `/terms`, `/privacy`, `/brands/$brandId`, `/storefront` |
| **Current issue** | `backTo` navigated to a hard-coded parent regardless of how the screen was reached — the classic "attach a pin from the dashboard, hit back, land on Live pins". Every screen has several entry points (dashboard tiles, speed dial, bottom nav, deep links, in-flow hand-offs). |
| **Required change** | Back uses `router.history.back()` when in-app history exists, and the declared fallback only when there is none (deep link, fresh tab, external referrer) — which also stops back from leaving the app. An explicit `onBack` still wins, for sub-views that swap rather than leave. `/pins/attach` now declares `/dashboard` as its fallback. |
| **Priority** | **P1** |
| **Dependency** | None |
| **Acceptance criteria** | 1. Dashboard → Attach → back = Dashboard. 2. Pins → Attach → back = Pins. 3. Attach opened in a fresh tab → back = `/dashboard`. 4. Back never leaves the app to an external referrer. 5. Screens passing `onBack` are unchanged. |

### G2 — Deep-linked dialogs survive a round trip
| | |
|---|---|
| **Screen / flow** | `/pins`, `/pins/attach` — pin detail dialog; `/storefront` — new-collection dialog |
| **Current issue** | The open pin lived in local state only, so leaving for `/pins/preview` and coming back dumped the creator on the bare grid. Separately, a `?new=1` arrival that cancelled the new-collection dialog was stranded on My Store — a page they never chose to visit. |
| **Required change** | The open pin is stamped into the URL as `?pinId` with `replace` (not push) before navigating to preview, so back from preview returns to the originating page with the pin reopened. Closing the dialog strips `?pinId` so a later back/forward cannot reopen a dismissed dialog. Cancelling a deep-linked new-collection dialog returns the creator to where the tile was tapped; opened from a button on the page, it just closes. |
| **Priority** | **P2** |
| **Dependency** | G1 |
| **Acceptance criteria** | 1. `/pins` → open pin → preview → back reopens that pin on `/pins`. 2. Same from `/pins/attach`, returning to `/pins/attach`. 3. Closing the dialog removes `pinId` from the URL. 4. Back/forward after closing does not reopen it. 5. Dashboard tile → `?new=1` → Cancel returns to Dashboard. 6. My Store's own "New collection" button → Cancel stays on My Store. |

---

## H. Collections

### H1 — Owner-only product reordering on the public storefront
| | |
|---|---|
| **Screen / flow** | `/s/$slug` (public storefront), collection view |
| **Current issue** | Order was fixed at whatever the loader returned; the creator standing on their own public page had no way to change it. |
| **Required change** | Owner-only Reorder control, shown only when the viewer's session user id matches the store owner and the collection holds ≥2 products. Drag list plus tap-target move controls, so the action is reachable without a drag. Saving issues one `UPDATE` per row (no unique key to upsert against, and an upsert would resend every `NOT NULL` column), renumbering `position` `0..n-1` **within that collection** — positions are only ever compared against siblings on the same page. The saved order is held locally so the grid re-sorts immediately; anything the saved order does not know about keeps its loader position at the end rather than vanishing; the loader is then refetched so a reload agrees with the screen. |
| **Priority** | **P1** |
| **Dependency** | None |
| **Acceptance criteria** | 1. A signed-out shopper never sees the Reorder control. 2. A signed-in non-owner never sees it. 3. The owner sees it only with ≥2 products. 4. Owner chrome appears after hydration without a flash for shoppers. 5. Saving re-sorts the grid immediately and survives a hard reload. 6. `position` values are contiguous `0..n-1` within the collection; another collection's positions are untouched. 7. A product added in another tab mid-reorder appears at the end, not lost. 8. Keyboard/tap move controls produce the same result as a drag. 9. Dialog is labelled `Reorder products` for assistive tech. |

### H2 — Collection creation is not a dashboard quick action
| | |
|---|---|
| **Screen / flow** | Home quick actions |
| **Current issue** | The 2×2 grid deep-linked "New collection" via `?new=1` — an action that presumes a store the creator has not built yet — and labelled monetization simply "Attach". |
| **Required change** | Grid reordered to the sequence a creator actually meets: monetize what is already on Pinterest, create something new, tune it, then the store it feeds. "New collection" is replaced by "My store". |
| **Exact copy** | `VERBATIM`: "Monetise pin", "Create pin", "Pinterest SEO", "My store". |
| **Priority** | **P2** |
| **Dependency** | None |
| **Acceptance criteria** | 1. Four tiles in that order with those labels. 2. "My store" goes to `/storefront` with no `?new=1`. 3. The `?new=1` handler still works for the speed dial (G2 case 5). |

---

## I. Score presentation

### I1 — Points before label; explainer earns a label
| | |
|---|---|
| **Screen / flow** | `/boost` score rows and hero |
| **Current issue** | Each row led with a category icon and buried `earned/total pts` at the right end of a bar. The scoring explainer was an unlabelled info glyph in the corner. Rank-1 emphasis (animated border, ping dot, sheen, trophy) shouted over 300 thumbnails. |
| **Required change** | Rows lead with `earned/total` + "pts" in a fixed-width column, then a divider, then the label and bar; the category icon is dropped. The explainer becomes a labelled pill in the hero footer; recheck stays an icon. Rank-1 emphasis reduced to a plain section — being first on the page *is* the emphasis. |
| **Exact copy** | `VERBATIM`: "How your score works"; section heading "Fix your Pinterest now" (was "Biggest wins first"). |
| **Priority** | **P2** |
| **Dependency** | None |
| **Acceptance criteria** | 1. Every row shows `earned/total pts` in the leading column. 2. Fully optimized rows show `total/total` and a check. 3. The explainer pill opens the scoring sheet. 4. No trophy, ping dot, animated border or sheen on rank 1. |

### I2 — "Board Structure" → "Board SEO"
| | |
|---|---|
| **Screen / flow** | `/boost/boards` — done state, progress header, and the scoring sheet |
| **Current issue** | User-facing label used the internal key's phrasing. |
| **Required change** | Rename in all user-facing strings. The `boardStructure` key and weights are unchanged. |
| **Priority** | **P2** |
| **Dependency** | None |
| **Acceptance criteria** | 1. No user-facing "Board Structure" remains. 2. `SUB_SCORE_WEIGHTS.boardStructure` and every consumer are untouched; scores are numerically identical. |

---

## J. Pre-login

### J1 — Five-slide story replaces the single static claim
| | |
|---|---|
| **Screen / flow** | `/` (pre-login landing) |
| **Current issue** | One static headline could carry only the first of four things a cold arrival needs before signup is a decision rather than a guess: that their existing Pins are the asset, that matching and linking is one tap, that the storefront is a shop, and that the SEO work is done for them. |
| **Required change** | Five auto-advancing slides in one frame. The drifting pin wall does **not** reset between slides — it is the continuous element that stops five slides reading as five screens. Claim and wall move together; the CTAs never move and signup is never more than a tap away. Slide 5 is terminal: auto-advance stops there rather than looping, so the sequence ends pointing at signup. A manual move restarts the dwell timer from that slide. Progress is a filling segmented bar, not a dot row. |
| **Priority** | **P2** |
| **Dependency** | None |
| **Acceptance criteria** | 1. Slides advance on a timer and stop on slide 5. 2. Manual advance restarts the timer rather than firing immediately after the tap. 3. The pin wall animates continuously across slide changes. 4. The claim block enters and leaves as one object. 5. CTAs hold a fixed position across all five slides. 6. Progress segments have a thumb-sized target without added visible height. 7. The headline area does not reflow between 4- and 5-word headlines. |

---

## Open decisions

Requirements that cannot be completed, or verified, without a product or design call.

| # | Decision | Why it is blocked | Blocks |
|---|---|---|---|
| **⚑1** | **Which activation-education pattern ships.** Two complete implementations exist. `src/components/flow-primer.tsx` — an inline, CTA-less card — is wired into all three flows. `src/components/flow-intro.tsx` — a 185-line, four-flow, three-screen phone-format intro **with** a final CTA — is imported nowhere and is currently dead code. Its own header comment references a gating hook `useFlowIntro` that does not exist in the tree. | These are opposite answers to the same review note. The primer's stated rule is that it carries no CTA because a CTA is the activation push relocated; `FlowIntro` ends every flow on an action button. Only product can say which reading is correct. | D2 |
| **⚑2** | **`FlowIntro`'s `pinterest-seo` flow vs `SeoOnboarding`.** `flow-intro.tsx` describes a `pinterest-seo` variant gated once per session; `src/components/seo-onboarding.tsx` implements exactly that and is what `/boost` uses. | Duplicate implementations of one requirement. One must be deleted; which depends on ⚑1. | D3 |
| **⚑3** | **What "token counters" means, and whether removal or scoping is wanted.** See F1. | No token/credit counter exists. The coin wallet was restyled and hidden on one screen, not removed. | F1, and the "token counters removed" verification |
| **⚑4** | **Whether applying a Boost fix needs a per-action gate.** Applying a Pin or board rewrite writes to Pinterest. `/boost` gates only when the score is empty *and* the connection is unusable (A3, deliberately — so a creator with imported Pins and a dead token can still see their score). That same creator can reach the fix deck and press Apply, and the write will fail against Pinterest. `usePinterestGate` is currently wired only to board import. | Two defensible answers: wrap Apply in the per-action gate (consistent with A2), or let it fail and surface C1 copy. The diff chose neither explicitly. | A2 scope; QA item 4 below |
| **⚑5** | **Error handling parity on the "continue without import" path.** `skipOnboarding` checks the `profiles` update for error and refuses to navigate on failure (B1). `continueWithoutImport` (B2) performs the same write without checking. | If that write fails, the creator is navigated Home and the guard returns them to onboarding on next boot — the exact failure B1 exists to prevent. Product/eng call on whether B2 adopts B1's guard. | B2 AC 2 |
| **⚑6** | **Brand name in user-facing copy.** Shipping copy says "ShopMyPin" (and `/shopmypin-logo.png`); the repository and `localStorage` namespace are `pinearn.*`. | Not a defect on its own, but no source in the diff states which is canonical for user-facing strings. | Copy review across A2, A3, C3, C4, E2 |

---

## QA checklist

Derived from the acceptance criteria above. IDs trace back to the requirement. `⚑` items cannot be signed off until the matching open decision is resolved.

### 1. First-time onboarding
- [ ] **B3** Name step reads "Hey, what's your name?" / "Your digital shop will be named after you."
- [ ] **B3** Authorize step no longer shows "Exactly what this gives us."
- [ ] **B1** No "Required" pill and no padlock anywhere in onboarding.
- [ ] **B1** "Skip for now" is present in the top-right on *both* the name step and the authorize step.
- [ ] Happy path: name → authorize → import → Home, with `onboarding_completed: true` and `pinterest_connected: true`.
- [ ] **B1** Skip controls disable and spin while in flight; a double-tap produces one write.
- [ ] **B1** Failed `profiles` update on skip shows the friendly error and does **not** navigate.
- [ ] **D1** A brand-new account landing on Home sees no blocking overlay and no scroll lock.

### 2. Pinterest skip → Home
- [ ] **B1** Skip from the name step lands on `/dashboard`; profile is `onboarding_completed: true`, `pinterest_connected: false`.
- [ ] **B1** A name of ≥2 chars typed but not submitted is saved as `display_name` and renames the storefront.
- [ ] **B1** A name of <2 chars is discarded without error.
- [ ] **B1** Toast reads "You can connect Pinterest any time from Settings".
- [ ] **B1** Skip from the authorize step behaves identically.
- [ ] **A1** After skipping, a hard reload of `/dashboard` does not return to onboarding.
- [ ] **A1** Every authenticated route is reachable in the skipped state: Home, Pins, Analytics, My Store, Profile, Settings, Boost, Brands, Attach.
- [ ] **C4** Home shows the "Pinterest isn't connected" banner with a working Connect.
- [ ] **B1** The reassurance line under the skip is present and correct.

### 3. Pinterest failure → Retry
- [ ] **C3** `?error=access_denied` on the callback shows the `declined` copy — no raw server text.
- [ ] **C3** Callback with no `code`/`state` shows the state-expiry classification.
- [ ] **C3** Retry starts a *fresh* OAuth round-trip; the spent code is never replayed.
- [ ] **C3** Mid-onboarding: retry returns to `/onboarding`; secondary reads "Skip for now" and lands on Home with `onboarding_completed: true` and no bounce.
- [ ] **C3** Post-onboarding: secondary reads "Back to ShopMyPin", lands on Home, writes nothing.
- [ ] **C3** Footer reads "Nothing was connected, and nothing in ShopMyPin changed."
- [ ] **C1** Forced 401 → "Pinterest wouldn't accept the access", retry labelled "Authorize again".
- [ ] **C1** Forced 429 → rate-limit copy; 5xx → "Pinterest isn't responding"; 403 → forbidden copy.
- [ ] **C1** Forced `config` failure (bad redirect URI / 400 from the token endpoint) → **no Retry button**, secondary still present.
- [ ] **C1** Offline → "Couldn't reach Pinterest".
- [ ] **C2** Every failure surface keeps the notice on screen until acted on — onboarding, callback, Settings, Profile, sync banner, gate sheet, connect panel.
- [ ] **C2** Retry disables and spins; it cannot be double-fired.
- [ ] **C2** The status hint renders only when a status exists.
- [ ] **C2** `role="alert"` is announced by a screen reader.
- [ ] **C4** A failed reconnect from the amber banner shows the inline notice, not a fading toast.
- [ ] **C4** Authorizing from Settings / Profile / Analytics returns to that same screen.
- [ ] **B2** Forced import failure in onboarding offers Retry, "Continue to Home", Cancel; Continue lands on Home with the flag written and toast "You're in — your boards will import on the next sync".
- [ ] ⚑**5** Behaviour when the `continueWithoutImport` profile write itself fails.

### 4. Authorized vs. unauthorized monetization
- [ ] **A2** Authorized: My Store → Sync boards & Pins starts immediately, no prompt, no flicker.
- [ ] **A2** Unauthorized: the gate sheet opens and the import does **not** start.
- [ ] **A2** The sheet is non-skippable — Escape and backdrop tap do nothing.
- [ ] **A2** "Not now" closes it and abandons the import.
- [ ] **A2** Authorizing and returning re-enters My Store with no auto-fired import.
- [ ] **A2** Slow-network case: pressing Sync before the connection query resolves opens the sheet in "Checking your connection…" and, on resolving as connected, runs the import exactly **once** without a second press.
- [ ] **A2** Non-skippable copy is present verbatim.
- [ ] **A3** Unauthorized `/pins/create` shows the connect panel, never the wizard; "Back to Pins" works.
- [ ] **A3** No "connect Pinterest" flash for a connected creator while the query is pending — spinner only.
- [ ] **A3** Unauthorized `/boost` with an empty score shows the connect panel.
- [ ] **A3** Unauthorized `/boost` **with** imported Pins shows the score, not the gate.
- [ ] **A3** Revoked-token state switches both panels to reconnect copy.
- [ ] **A4** Unauthorized `/analytics`: zero `getPinterestAnalytics` calls, no error toast, orders/sales/earnings still render.
- [ ] **A4** Authorized `/analytics`: mount sync fires exactly once per mount.
- [ ] Unauthorized `/pins/attach`: attaching a product to an already-imported Pin succeeds — it touches no Pinterest API.
- [ ] Public storefront `/s/$slug` renders and its affiliate links resolve with Pinterest never connected.
- [ ] ⚑**4** Applying a Boost fix while the token is revoked — expected outcome undefined; do not sign off until ⚑4 is resolved.

### 5. No-pins and empty-board states
- [ ] **E1** Unauthorized + zero pins: not-connected copy, inline sync banner, no Attach CTA.
- [ ] **E1** Authorized + zero pins + storefront: attach copy and CTA.
- [ ] **E1** Authorized + zero pins + no storefront: storefront-first copy, no CTA.
- [ ] **E1** Unauthorized but with imported pins: normal grid, no empty state.
- [ ] **E2** Saves-only account: "{n} saved Pins found, none created by you" with a working Sync now — never an error.
- [ ] **E2** Singular at n=1; `@username` when known, "your account" when not.
- [ ] **E2** Callback summary shows the saved-Pins sentence, not "0 pins · 0 boards".
- [ ] **E3** `/boost/pins` and `/boost/boards` contain no passing items.
- [ ] **E3** All-passing account: optimized state on both, not an empty deck shell.
- [ ] **E3** Points use the full account count as denominator; the picker header total equals the sum of its rows.
- [ ] **E3** Every card in a deck shows non-zero points.
- [ ] Account with boards but zero pins, and account with pins but zero boards, both render without a crash.

### 6. Collection editing and reordering
- [ ] **H1** Signed-out shopper on `/s/$slug`: no Reorder control anywhere.
- [ ] **H1** Signed-in non-owner: no Reorder control.
- [ ] **H1** Owner with 1 product: no control. With ≥2: control present.
- [ ] **H1** No owner-chrome flash for shoppers during hydration.
- [ ] **H1** Reorder → Save: grid re-sorts immediately and survives a hard reload.
- [ ] **H1** `position` is contiguous `0..n-1` within the collection; a sibling collection's positions are unchanged.
- [ ] **H1** A product added in another tab mid-reorder lands at the end and is not lost.
- [ ] **H1** Tap move controls produce the same order as a drag.
- [ ] **H1** Dialog is labelled "Reorder products".
- [ ] Collection create / rename / cover change still work from My Store; the pre-existing collection reorder dialog is unaffected.
- [ ] **G2** Dashboard tile → `?new=1` → Cancel returns to Dashboard; My Store's own button → Cancel stays on My Store.
- [ ] **H2** Home quick actions read "Monetise pin", "Create pin", "Pinterest SEO", "My store", in that order; "My store" carries no `?new=1`.

### 7. Counters removed ⚑
- [ ] ⚑**3** Blocked: confirm what "token counters" refers to before signing off. Provisional checks against the current implementation:
- [ ] **F1** The coin pill is absent on `/pins` and present elsewhere — *pending the agreed screen list*.
- [ ] **F1** The wallet opens as an anchored popover, not a full-screen sheet; the ledger is gone.
- [ ] **F1** Re-tap, click-away and Escape all close it; the header is never trapped behind it.
- [ ] **F1** `aria-expanded` / `aria-haspopup` correct; `aria-label` still states balance, allowance and refill.
- [ ] **F1** The ±n delta flash still fires when the balance changes.

### 8. Premature activation prompts removed
- [ ] **D1** `src/components/new-user-cta.tsx` is deleted and nothing imports it.
- [ ] **D1** No blocking overlay on Home for a brand-new account; `document.body.style.overflow` untouched.
- [ ] **D1** `localStorage` key `pinearn.newUserCtaSeen` is neither read nor written.
- [ ] **D3** First `/boost` visit in a session shows the intro screens with **no** scan running.
- [ ] **D3** The CTA starts the analyzer; second visit in the same session goes straight to the score.
- [ ] **D3** Returning from a fix flow shows the climbing score with no intro.
- [ ] **D3** Skip on intro screens 1–2 goes straight to the scan; Back present on 2–3, absent on 1.
- [ ] **D3** `prefers-reduced-motion`: animated screens show their finished state, never an empty one.
- [ ] **D2** Each of the three primers shows once per flow per browser and never again; dismissing one does not dismiss the others.
- [ ] **D2** No primer blocks its flow; none contains a CTA that navigates or mutates.
- [ ] **D2** `/pins/create` shows its primer on step 1 only; `/pins/attach` only when no board is open.
- [ ] **D2** No hydration mismatch warning on any primer host screen.
- [ ] **D2** Private-mode Safari: no primer, no console error.
- [ ] ⚑**1**/⚑**2** `flow-intro.tsx` is either wired in or deleted — it must not ship as dead code.

### 9. Cross-cutting
- [ ] **G1** Dashboard → Attach → back = Dashboard; Pins → Attach → back = Pins; fresh tab → back = `/dashboard`.
- [ ] **G1** Back never exits to an external referrer.
- [ ] **G2** Pin dialog round trip through `/pins/preview` reopens the pin on the originating page; closing strips `?pinId`; back/forward does not resurrect it.
- [ ] **I1** Score rows lead with `earned/total pts`; no category icon; optimized rows show `total/total` + check.
- [ ] **I1** "How your score works" pill opens the scoring sheet; no trophy/ping/sheen on rank 1.
- [ ] **I1** Section heading reads "Fix your Pinterest now".
- [ ] **I2** No user-facing "Board Structure"; scores numerically unchanged.
- [ ] **J1** Landing slides auto-advance and stop on slide 5; manual advance restarts the dwell timer; the pin wall runs continuously; CTAs never move; the headline area does not reflow.
- [ ] ⚑**6** Brand name in user-facing copy is consistent with whichever name product confirms.
