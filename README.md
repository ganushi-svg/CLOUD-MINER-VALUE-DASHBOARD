# Segments Cloud · AI Operations Command Center

Read-only operations intelligence over the Segments Cloud fleet dataset.

**Live:** https://cloud-miner-value-dashboard.vercel.app — see [`DEPLOY.md`](DEPLOY.md) before sharing the link.

**Milestone 1 — data ingestion and normalization — is implemented.**
Milestones 2–10 are specified in [`docs/MILESTONES.md`](docs/MILESTONES.md).

## What Milestone 1 does

Turns the Google Sheet `Client_Miner_Model_Summary_FULL` into one validated,
typed dataset that every later milestone reads, so nothing else ever parses a
spreadsheet.

At capture the source describes **1,395 units across 98 clients and 24 models** —
399,850.5 TH/s, 6,331.6 kW, valued at $1,697,311.80 (used basis) or $2,294,701.10
(fresh basis), as at report date 2026-08-04.

Design decisions that matter:

- **Money never becomes a float.** Prices are integer minor units (cents), hosting
  rates micro-dollars per kWh, with an explicit currency.
- **Absence has two meanings.** `N/Q` (no supplier quote exists) stays distinct from
  blank (nobody recorded one) via an availability flag on every price.
- **The dataset is validated, never repaired.** Twelve rules classify findings
  `INFO` / `WARNING` / `CRITICAL`. Silent repair is how a spreadsheet error becomes a
  management-report error.
- **The data source is swappable.** Service account → public CSV → committed
  snapshot, chosen by `INGEST_SOURCES`. Going live is configuration, not code.

## Current data-quality findings

No contradictions (0 critical). Three warnings that are true statements about the source:

| Finding | Detail |
| --- | --- |
| `coverage.workers` | Worker tab carries 225 of 1,318 stated workers (17.1%) — a sample, not the fleet |
| `coverage.time` | Every worker row is dated 2026-08-04 — no time series is derivable |
| `coverage.prices` | Price coverage 45.8%–82.3% depending on basis; unpriced units are excluded from totals |

The source has no algorithm column, so each model carries a curated `algorithm`
(`algorithmSource: "curated"`, see `src/normalize/algorithms.js`). Efficiency
plausibility is judged inside the algorithm group; the one kHeavyHash model has no
peer and is reported as `INFO`, not as a bad number. Fleet efficiency in the summary
is the SHA-256 subset (`summary.fleet.sha256`), which is the only comparable one.

The first two bound what the product can honestly claim: uptime, incidents,
availability and "what changed today" are **not** answerable from this sheet.
See `docs/MILESTONES.md` § Milestone 3b for the feeds that unlock them.

## Dashboard

The root URL is a branded command-center overview reading entirely from `/api/dataset`:
fleet hero and KPI tiles, composition by model, client concentration (top-5 share, HHI),
used-vs-fresh valuation by model, hosting economics (badged as a 225-worker sample), the
twelve data-quality findings, and an explicit list of what this source cannot answer.
Every chart has a table view; chart colours were validated for CVD separation and
contrast on the dark surface. Sections exist only where the data supports them.

## Supplier price feed

Supplier price lists (forwarded from WhatsApp to the business number, or POSTed to
`/api/pricefeed`) are parsed line by line, resolved to the fleet's canonical models on a
(family, hashrate) key — the same tokenizer runs over the sheet's own labels — and stored
as observations with an explicit basis (used / fresh / unknown) and confidence. Lines that
don't resolve are reported, never guessed. The **Price feed** tab compares each observed
price with the quote recorded in the sheet. Set-up and the WhatsApp constraints are in
[`DEPLOY.md`](DEPLOY.md).

## Run it

```bash
node scripts/ingest.mjs          # ingestion report to stdout; exits non-zero on a CRITICAL finding
node scripts/ingest.mjs --json   # machine-readable
npm test                         # 37 tests
npm run dev                      # http://localhost:3000
```

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness, source used, fleet rollup, validation counts |
| `GET /api/dataset` | Normalized dataset; `?section=models\|clients\|holdings\|workers\|summary`; add `&format=csv` for a spreadsheet-ready export of one section |
| `GET /api/events` | Attention feed: severity-ranked events (staleness, integrity, price deltas, feed age, concentration) with an overall state; a cleared WARNING/CRITICAL is reported as RECOVERY for 24 h, with the alerting states remembered in the price-feed store |
| `GET /api/quality` | Data-quality findings with severities |
| `GET\|POST /api/refresh` | Force re-ingest, bypassing the warm-instance cache |
| `GET /api/pricefeed` | Observed supplier prices vs sheet quotes plus a fleet mark-to-market (`markToMarket`); `?view=all` adds every observation and the per-model `history` series behind the sparklines |
| `POST /api/pricefeed` | Ingest a price list (bearer `PRICEFEED_INGEST_SECRET`) |
| `GET\|POST /api/whatsapp` | Meta Cloud API webhook: verification handshake and signed message delivery |

## Configuration

See `.env.example`. To read the sheet live, set `GOOGLE_SERVICE_ACCOUNT` to a
service-account JSON and share the spreadsheet with its `client_email` as Viewer;
the connector chain then prefers it automatically. Without it the service serves
the committed snapshot, which is why it deploys with no credentials at all.

The sheet is currently private — its public CSV export returns 401 — so the
`public_csv` connector stays in the chain as an option, not a dependency.

## Security posture

Read-only by construction: no code path writes to the sheet or to any operational
system. Credentials come from environment variables only, are never logged, and
never reach the client.

## Documentation

- [`DEPLOY.md`](DEPLOY.md) — Vercel project settings and pre-launch exposure check
- [`docs/MILESTONES.md`](docs/MILESTONES.md) — the ten-milestone plan
- [`docs/DATA_DICTIONARY.md`](docs/DATA_DICTIONARY.md) — every field, its meaning, and what the data cannot answer
