---
name: data-quality
description: Run the normalization pipeline and explain the data-quality findings and operational events in plain terms. Use when asked whether the data is trustworthy, what the warnings mean, why a number is excluded, or what needs attention.
allowed-tools: Bash(node scripts/ingest.mjs *)
---

## Pipeline report

!`cd ${CLAUDE_PROJECT_DIR} && INGEST_SOURCES=fixture node scripts/ingest.mjs 2>&1 || true`

## How to interpret

- **CRITICAL** means the source contradicts itself; downstream numbers would be wrong. There should be
  none. If one appears, the fix is in the *source sheet* or in a parser bug — never patch the number.
- **WARNING** means internally consistent but incomplete. The standing ones and what they bound:
  - `coverage.workers` — the worker tab is a sample (225 of 1,318). Anything per-worker describes
    the sample; say "sample", never "fleet".
  - `coverage.time` — one report date; there is no time series in this source. Trends need the
    supplier price feed (dated observations) or Milestone 3b feeds.
  - `coverage.prices` — unpriced units are excluded from valuation totals; always quote the
    coverage alongside a total.
- **INFO** findings are reconciliations that passed. `plausibility.efficiency` compares J/TH only
  within one hashing algorithm (curated map in `src/normalize/algorithms.js`); a model alone in its
  algorithm is reported, not judged.

Answer the user's actual question using these findings. Quote finding ids so the answer is
traceable, and never describe the fixture snapshot as live data — its capture time is in the report.
