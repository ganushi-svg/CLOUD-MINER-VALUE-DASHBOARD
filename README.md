# Segments Cloud · AI Operations Command Center

Read-only operations intelligence over the Segments Cloud fleet dataset.

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

No contradictions (0 critical). Four warnings that are true statements about the source:

| Finding | Detail |
| --- | --- |
| `coverage.workers` | Worker tab carries 225 of 1,318 stated workers (17.1%) — a sample, not the fleet |
| `coverage.time` | Every worker row is dated 2026-08-04 — no time series is derivable |
| `coverage.prices` | Price coverage 45.8%–82.3% depending on basis; unpriced units are excluded from totals |
| `plausibility.efficiency` | One model at 150 J/TH is a Kaspa miner, not a bad number — the source has no algorithm column |

The first two bound what the product can honestly claim: uptime, incidents,
availability and "what changed today" are **not** answerable from this sheet.
See `docs/MILESTONES.md` § Milestone 3b for the feeds that unlock them.

## Run it

```bash
node scripts/ingest.mjs          # ingestion report to stdout; exits non-zero on a CRITICAL finding
node scripts/ingest.mjs --json   # machine-readable
npm test                         # 28 tests
npm run dev                      # http://localhost:3000
```

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness, source used, fleet rollup, validation counts |
| `GET /api/dataset` | Normalized dataset; `?section=models\|clients\|holdings\|workers\|summary` |
| `GET /api/quality` | Data-quality findings with severities |
| `GET\|POST /api/refresh` | Force re-ingest, bypassing the warm-instance cache |

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

- [`docs/MILESTONES.md`](docs/MILESTONES.md) — the ten-milestone plan
- [`docs/DATA_DICTIONARY.md`](docs/DATA_DICTIONARY.md) — every field, its meaning, and what the data cannot answer
