# CLAUDE.md — Segments Cloud Ops Command Center

Standalone Vercel project (Node ≥20, ESM, one runtime dependency). Live at
https://cloud-miner-value-dashboard.vercel.app. Production follows `main`; every other
branch gets a preview URL. Development branch: `claude/segments-cloud-ops-center-mfsuxv`.

## Commands
- `npm test` — 40+ tests, hermetic (fixture snapshot, mocked fetch).
- `node scripts/ingest.mjs` — normalization + data-quality report; exit 1 on a CRITICAL finding.
- `npm run dev` — dev server mirroring Vercel's handlers on http://localhost:3000.
- `node scripts/deploy-status.mjs` — HEAD vs remote main vs what production serves.

## Layout
`src/ingest` (sheet connectors) → `src/normalize` (typed dataset) → `src/validate` (rules, never repairs)
→ `src/events` (severity engine) · `src/pricefeed` (supplier list parser, store, comparison) ·
`api/*.js` (Vercel functions; `api/whatsapp.js` uses the Web-standard signature) · `public/index.html`
(single-file tabbed dashboard, no framework) · `data/fixtures/snapshot.js` (verbatim sheet capture).

## Non-negotiables
- Money is integer minor units with explicit currency; never a JS float. Hosting rates are micro-$/kWh.
- Absence has two meanings: `NOT_QUOTED` (sheet says N/Q) ≠ `MISSING` (blank). Keep the availability flag.
- Validation reports; it never auto-repairs. Unresolvable price lines are returned, never guessed.
- Nothing in the app writes to the sheet or to any operational system (read-only by construction).
- Secrets only via environment variables; never log message bodies or phone numbers.
- Chart colours must pass the dataviz palette validator on the dark surface (`#4A8BF0`, `#C98500`).
- Sections and KPIs exist only where the data supports them. `docs/DATA_DICTIONARY.md` lists what the
  sheet cannot answer (uptime, incidents, trends); do not fabricate those.

Procedures live in `.claude/skills/` (run, verify deploy, ingest a price list, data quality, promote).
