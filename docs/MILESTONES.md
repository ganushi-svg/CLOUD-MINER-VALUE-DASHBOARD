# Segments Cloud · AI Operations Command Center — Implementation Plan

Ten independent milestones. Each states objective, components, dependencies, APIs,
inputs, outputs, testing and acceptance criteria. **Milestone 1 is implemented in
this repository.** Milestones 2–10 are specified, not built.

## Source of truth

Google Sheet `Client_Miner_Model_Summary_FULL`
(`1XySY4bTYTU0XYjndcRlKyBcXLH8n9FiGQtet-iYTRU4`), three tabs:

| Tab | Grain | Rows | Role |
| --- | --- | --- | --- |
| Client-wise Valuation | client × model | 147 | Who owns what, and what it is worth |
| Miner Model Summary — Fleet View | model | 24 | Model authority: hashrate, power, unit counts, prices |
| Worker Detail | worker | 225 | Per-worker hosting economics for one day |

Verified at capture: 1,395 units · 98 clients · 399,850.5 TH/s · 6,331.6 kW ·
used-basis value $1,697,311.80 · fresh-basis value $2,294,701.10 · report date 2026-08-04.

## What this source can and cannot answer

Milestones 3 and 4 are scoped by a hard constraint that must not be designed around:

**Derivable today** — fleet composition and concentration, client exposure,
model mix, hashrate and power density, efficiency (J/TH), hosting-rate spread,
valuation on two price bases, and the gap between them.

**Not derivable from this sheet** — uptime, downtime, incidents, availability,
site/facility performance, maintenance, "what changed today", or any trend.
The workbook is a **single-date snapshot** (every worker row is dated 2026-08-04)
with **no site, status, incident or timestamp columns**. A command centre that
claimed to answer "what is happening today?" from this source alone would be
fabricating. Milestone 3 therefore ships the analytics this data supports, and
Milestone 3b (below) adds the operational feeds that unlock the rest.

Candidate additional sources already present in the same Drive, to be confirmed
by the data owner before use:

- `Ops_SiteStatus_*` — daily per-facility online/total, utilisation %, kW, OK/WATCH/CRITICAL verdict. **This is the availability and severity feed.**
- `khazna downtime` — dated incident log with free-text cause and duration.
- `Inventory - offline and online machine list` — unit-level registry with per-miner status, location and repair history.
- `worker_report` — per-worker daily income/expense/P&L.

---

## Milestone 1 — Data ingestion and normalization ✅ implemented

**Objective.** Turn the workbook into one validated, typed dataset that every
later milestone reads, so no other component ever parses a spreadsheet.

**Components.**
`src/ingest/sheets.js` (connector chain), `src/ingest/csv.js`,
`src/normalize/coerce.js` (money, sentinels, dates), `src/normalize/clients.js`,
`src/normalize/models.js` (canonical registry), `src/normalize/algorithms.js`
(curated hash-algorithm map — the source has no algorithm column),
`src/normalize/pipeline.js`, `src/validate/rules.js`, `src/dataset.js`,
`api/{health,dataset,quality,refresh}.js`, `public/index.html`, `data/fixtures/`,
`scripts/{ingest,serve,deploy-status}.mjs`, and the project skills under
`.claude/skills/` (`run-dashboard`, `verify-deploy`, `ingest-pricelist`,
`data-quality`, `promote`, `ops-center-conventions`).

**Dependencies.** None. Node ≥20, zero runtime packages.

**APIs.** `GET /api/health` · `GET /api/dataset[?section=models|clients|holdings|workers|summary][&format=csv][&refresh=1]` · `GET /api/quality` · `GET|POST /api/refresh` · `GET /api/events` (attention feed, delivered early from M3/M4 — see below).

**Inputs.** The workbook via service account, public CSV export, or committed
snapshot — whichever `INGEST_SOURCES` resolves first.

**Outputs.** `{ meta, models[], holdings[], workers[], clients[], unresolvedModelReferences[], validation }`.
Money is integer minor units with an explicit currency; hosting rates are
micro-dollars per kWh. Prices carry an availability flag
(`QUOTED` / `NOT_QUOTED` / `MISSING` / `UNPARSEABLE`) so "no supplier quote"
stays distinct from "nobody filled it in".

**Testing.** 37 tests. Unit: money exactness, sentinel handling, merged-cell
stripping, calendar-date rejection, client-code and model-slug convergence.
Integration against the real snapshot: row counts, the 1,395-unit reconciliation,
exact prices, unmerge correctness, connector precedence and fallback, and a
negative test that a contradicted dataset fails loudly.

**Acceptance criteria.** All met:
1. Holdings and fleet view reconcile at 1,395 units, and per model. ✅
2. All 98 client totals equal the sum of their rows. ✅
3. Every priced line total equals unit price × units, to the cent. ✅
4. Every model string in all three tabs resolves to the registry; zero dropped rows. ✅
5. Worker IDs unique. ✅
6. Zero CRITICAL findings; the three WARNINGs are true statements about the data (efficiency is judged per algorithm group, so the Kaspa model is INFO, not a warning). ✅
7. The service deploys and serves without any credential. ✅

**Delivered ahead of schedule (pulled forward from M3/M4/M5).**
- *Events engine* — `src/events/rules.js` + `GET /api/events`. Deterministic
  rules over the M1 dataset and the price-feed store produce a severity-ranked
  attention feed (`NORMAL` / `INFO` / `WARNING` / `CRITICAL`) with an overall
  state: snapshot staleness, fixture-vs-live source, validation integrity,
  supplier price deltas ≥15% / ≥30%, feed age, memory-only store, fleet
  concentration. This is the alert contract the M7 mascot state machine and the
  M4 AI layer will consume; `RECOVERY` is reserved until M2 persistence can
  compare consecutive states.
- *Durable price observations* — `PRICEFEED_STORE=supabase` keeps observations
  and event states in two RLS-locked Postgres tables on the Segments Cloud
  Supabase project (`db/ops_pricefeed.sql`), reached through PostgREST with a
  server-only secret key. `GET /api/pricefeed?view=all` now returns a per-model
  `history` series; the events engine compares each run with the remembered
  alerting states and emits `RECOVERY` for 24 hours after a WARNING/CRITICAL
  clears. This is the first slice of Milestone 2's persistence.
- *Mark-to-market* — `src/pricefeed/compare.js`. Re-prices the fleet at the
  latest observed supplier quotes, basis-matched to the sheet's quote, with
  per-model and per-client exposure. Reported in `GET /api/pricefeed`.
- *Dashboard* — attention strip on the overview, mark-to-market card on the
  price-feed tab, SHA-256-only fleet efficiency tile, deploy provenance in the
  footer, CSV export of holdings.

---

## Milestone 2 — Database and backend API

**Objective.** Persist normalized snapshots so the system has history, and put a
stable versioned API in front of them.

**Components.** `db/schema.sql`; `src/db/{client,repository,migrate}.js`;
`src/ingest/snapshot.js` (write a dated snapshot); `api/v1/*`.

**Dependencies.** M1. Postgres (Neon or Supabase — serverless-friendly); Redis optional for cache.

**APIs.** `/api/v1/snapshots`, `/api/v1/models`, `/api/v1/clients`,
`/api/v1/clients/:key`, `/api/v1/workers`, `/api/v1/quality`. Cursor pagination, JWT bearer on writes.

**Inputs.** M1 dataset objects. **Outputs.** Durable snapshot rows keyed by
`(source, report_date, captured_at)`; a re-ingest of an unchanged sheet is a no-op.

**Schema sketch.** `snapshot`, `miner_model`, `client`, `holding`, `worker`,
`quality_finding`. Money as `NUMERIC(14,2)` with a `currency` column — never float.
Natural keys: `model_key`, `client_key`, `worker_id`.

**Testing.** Migration up/down on a scratch database; idempotent re-ingest writes
one snapshot; repository round-trip preserves minor-unit exactness; pagination stability.

**Acceptance criteria.** Two ingests of the same sheet produce one snapshot;
the API reproduces M1's numbers exactly; every endpoint validates input and
returns typed errors; no string-built SQL.

---

## Milestone 3 — Operational analytics

**Objective.** Compute the metrics this data genuinely supports, as pure functions.

**Components.** `src/analytics/{composition,concentration,valuation,efficiency,economics}.js`; `src/analytics/index.js`.

**Dependencies.** M2 (M1 alone is enough to develop against).

**APIs.** `/api/v1/analytics/fleet`, `/analytics/clients`, `/analytics/models`, `/analytics/economics`.

**Inputs.** A snapshot. **Outputs.** KPI objects, each carrying `value`, `formula`,
`inputs`, and `coverage` — the share of the fleet the number actually describes.

**KPIs (only those the data supports).**

| KPI | Formula | Data required |
| --- | --- | --- |
| Fleet units / hashrate / power | Σ units, Σ units×TH, Σ units×W | Fleet View |
| Model mix | model units ÷ 1,395 | Fleet View |
| Client concentration | top-N units ÷ total; HHI = Σ(share²) | Holdings |
| Fleet efficiency | Σ power ÷ Σ hashrate, **grouped by algorithm** | Fleet View |
| Valuation (used / fresh) | Σ units × unit price, priced units only | Both bases |
| Valuation spread | (fresh − used) ÷ used | Both bases |
| Price coverage | priced units ÷ total units | Availability flags |
| Hosting-rate spread | min/median/max $/kWh, by engine | Worker tab (sample) |
| Daily energy cost | Σ (W ÷ 1000 × 24 × rate) | Worker tab (sample) |

**Testing.** Golden-value tests against hand-computed figures; property test that
every KPI's `coverage` ≤ 1; a test asserting sample-derived KPIs are labelled as such.

**Acceptance criteria.** Every KPI states its formula and coverage; no KPI derived
from the 225-row worker sample is presented as fleet-wide; algorithm-mixed
efficiency is never averaged into one number.

### Milestone 3b — Operational feeds (unblocks availability, incidents, trends)

**Objective.** Add the sources that make "what is happening today?" answerable.

**Components.** `src/ingest/sources/{site_status,downtime,registry}.js`; conforming to M1's connector contract.

**Inputs.** `Ops_SiteStatus_*`, `khazna downtime`, unit-level inventory — **pending owner confirmation.**

**Outputs.** `site_status_daily`, `incident`, `unit_registry` tables.

**Testing.** Parsers must reject the known defects in these sources rather than
guess: year typos (`21/08/0226`, `13/02/0206`), duration as free text
(`45 MINUTES`, `1.5 HOUR`), site names spelled three ways (`Khazna 1` / `Khaznah 1` / `F24`).

**Acceptance criteria.** A canonical site dimension maps every alias to one key;
unparseable dates and durations are quarantined with a finding, never coerced.

**Delivered early — supplier price feed.** `src/pricefeed/` parses supplier price lists
(WhatsApp Business webhook at `api/whatsapp.js`, or `POST /api/pricefeed`), resolves each
line to the registry on a (family, hashrate) key, stores observations with basis and
confidence, and the dashboard's Price feed tab compares them with the sheet's quotes.
Store is memory or a `PriceFeed` sheet tab until M2's database lands.

---

## Milestone 4 — AI intelligence layer

**Objective.** Interpret computed analytics; never read raw rows, never invent numbers.

**Components.** `src/ai/{context,tools,interpret,guardrails}.js`; prompt templates under `src/ai/prompts/`.

**Dependencies.** M3. Claude API (`claude-sonnet-5` for interactive turns).

**APIs.** `POST /api/v1/ask { question }` → `{ answer, citations[], confidence, coverage }`.

**Inputs.** The analytics envelope plus the quality findings — **not** the dataset rows.

**Outputs.** Grounded natural-language answers where every figure carries a
citation to the KPI that produced it.

**Design rule.** The model receives pre-computed KPIs as tool results and composes
prose. It never performs arithmetic on raw rows, so a wrong number is a bug in a
tested function rather than a hallucination.

**Guardrails.** Refuse-and-say-so when the question needs data the snapshot lacks
(uptime, incidents, "what changed") until M3b lands; strictly read-only — no tool
may write, restart or modify anything; server-side API key only.

**Testing.** Golden Q&A set with known answers; adversarial set that must return
"not determinable from current dataset"; assertion that no answer contains a
number absent from the analytics envelope.

**Acceptance criteria.** Zero fabricated figures across the eval set; every
unanswerable question is declined explicitly rather than guessed.

---

## Milestone 5 — Dashboard

**Objective.** The operator-facing command centre.

**Components.** Next.js App Router: `app/(overview|fleet|clients|models|economics|quality|insights)/page.tsx`; `components/charts/*`; design tokens.

**Dependencies.** M2–M4. Next.js, TypeScript, Tailwind, Recharts.

**APIs.** Consumes `/api/v1/*` server-side. **Inputs/Outputs.** Snapshots and analytics → rendered views.

**Sections.** Overview · Fleet · Clients · Models · Economics · Data Quality · AI Insights.
No Sites/Incidents/Alerts sections until M3b supplies their data — an empty
section implies a capability the system does not have.

**Testing.** Component tests on KPI tiles; visual regression on the overview;
Lighthouse ≥ 90; axe accessibility pass at WCAG AA.

**Acceptance criteria.** Every figure on screen traces to an API field; data-quality
warnings are visible in-context, not buried; no section renders without data behind it.

---

## Milestone 6 — 3D mascot prototype

**Objective.** A static, on-brand mascot rendering in the browser at 60 fps.

**Components.** `components/mascot/{Canvas,Model,Loader}.tsx`; `public/mascot/segments-bot.glb`.

**Dependencies.** M5. three.js, @react-three/fiber, @react-three/drei; Draco compression.

**Inputs.** Authored GLB. **Outputs.** Lazy-loaded, code-split mascot component.

**Design direction.** Digital-infrastructure assistant — cloud/network/datacentre
motifs, subtle mechanical articulation, approachable and professional. Explicitly
not a mining rig and not a skeleton.

**Testing.** Bundle-size budget; static image fallback when WebGL is unavailable;
`prefers-reduced-motion` respected.

**Acceptance criteria.** ≤ 2 MB compressed; 60 fps on a mid-range laptop; the page
is fully usable with the mascot disabled.

---

## Milestone 7 — Mascot rig and animation state machine

**Objective.** Full humanoid rig plus a deterministic state machine.

**Components.** `src/mascot/{rig,stateMachine,transitions,idle}.ts`; animation clips in the GLB.

**Dependencies.** M6.

**Rig.** Head · neck · spine · chest · shoulders · upper arm · elbow · forearm ·
wrist · hand · fingers · pelvis · thigh · knee · lower leg · ankle · foot · toes.
IK for gaze and arm targets; FK for authored clips.

**States.** IDLE · WELCOME · LISTENING · THINKING · SPEAKING · NORMAL · INFO ·
WARNING · CRITICAL · SUCCESS · RECOVERY · ERROR · GOODBYE.

**Inputs.** A semantic command `{ state, severity, message, event_id }`.
**Outputs.** Blended animation. The controller accepts only these commands —
no data field is ever wired to a bone.

**Testing.** Every state reachable; transitions blend without popping; idle
variation does not loop visibly within 60 s.

**Acceptance criteria.** 13 states implemented and distinguishable; illegal
transitions rejected; the mascot never freezes on an unknown command.

---

## Milestone 8 — Mascot + AI integration

**Objective.** Bind operational severity to mascot behaviour through one contract.

**Components.** `src/events/{detect,severity,dispatch}.ts`; `src/mascot/bridge.ts`.

**Dependencies.** M4, M7.

**APIs.** `GET /api/v1/events` (SSE). Payload: `{ event_id, state, severity, message, source_kpi }`.

**Severity model.** `INFO` a fact worth stating · `NORMAL` within band ·
`WARNING` incomplete or drifting (e.g. price coverage below 80%) ·
`CRITICAL` self-contradictory or a threshold breach · `RECOVERY` a prior
CRITICAL cleared. Every rule documented and version-stamped; nothing defaults to CRITICAL.

**Testing.** Each severity maps to exactly one state; a CRITICAL followed by its
clearance produces RECOVERY, not silence; unknown severity degrades to INFO.

**Acceptance criteria.** No mascot state is triggerable except via an emitted event.

---

## Milestone 9 — Voice interaction

**Objective.** Speak and listen, with mouth movement driven by the audio.

**Components.** `src/voice/{stt,tts,intent,visemes}.ts`; `components/mascot/Speech.tsx`.

**Dependencies.** M8. Web Speech API for capture with a server STT fallback; a TTS provider returning timed marks.

**APIs.** `POST /api/v1/voice/transcribe`, `POST /api/v1/voice/speak`.

**Flow.** speech → text → intent → M4 answer → speech → viseme-driven mouth + SPEAKING state.

**Testing.** Intent classification accuracy on a labelled set; barge-in cancels
playback; graceful degradation to text when a microphone is denied.

**Acceptance criteria.** Round-trip under 3 s for a cached-analytics question;
voice is never required to use the product.

---

## Milestone 10 — Complete Segments Cloud experience

**Objective.** Ship it: arrival experience, auth, observability, hardening.

**Components.** `app/layout.tsx` arrival sequence; `src/auth/*`; `src/telemetry/*`; runbook.

**Dependencies.** M1–M9.

**Scope.** Mascot notices and greets the visitor, then offers the current summary ·
SSO or OTP with roles (viewer / operator / admin) · structured logs, error tracking,
uptime checks · scheduled ingest via cron with alerting on ingestion failure ·
secret rotation and a documented retention policy.

**Testing.** End-to-end journeys (arrive → greeted → ask → answered → drill in);
load test of `/api/v1/*`; restore-from-backup drill; a security review covering
authz, injection and secret handling.

**Acceptance criteria.** A named non-technical operator completes "give me today's
summary" unaided; ingestion failure pages someone; no secret reachable from the client.

---

## Sequencing

```
M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5 ──▶ M10
                │            ▲
                └── M3b ─────┘        (unblocks availability / incidents / trends)
      M6 ──▶ M7 ──▶ M8 ──────┘
```

M6 and M7 are independent of the data track and can run in parallel from the start.
M8 is the first point where the two tracks must meet.
