---
name: ops-center-conventions
description: Engineering conventions and data semantics for the Segments Cloud Ops Command Center codebase — money, availability flags, validation policy, chart palette, tab structure, API contract. Background knowledge Claude applies while editing this repo.
user-invocable: false
---

- **Money:** integer minor units (`*Minor`, cents) with `currency`; hosting rates micro-$/kWh
  (`*MicroUsdPerKwh`). Format only at the edge with `formatMinorUnits`. Never `parseFloat` a price.
- **Availability:** every price carries `QUOTED | NOT_QUOTED | MISSING | UNPARSEABLE`. `N/Q` in the
  sheet is a supplier fact (no listing), a blank is an omission. Do not collapse them.
- **Validation policy:** `src/validate/rules.js` classifies `INFO | WARNING | CRITICAL` and never
  mutates data. New checks are rules with a documented threshold and a test against the fixture.
- **Events:** `src/events/rules.js` emits `{ id, severity, title, detail, source }` with
  `NORMAL | INFO | WARNING | CRITICAL` (`RECOVERY` reserved until state persists). This is the
  mascot/alert contract; keep it stable.
- **Model identity:** `modelKey` slugs from `src/normalize/models.js`; the price-feed resolver
  matches on (family, hashrate) via `parseModelPhrase` — the same tokenizer runs over sheet labels.
  Algorithm is curated (`src/normalize/algorithms.js`), labelled `algorithmSource: 'curated'`.
- **UI:** one file, `public/index.html`, vanilla DOM helpers `$()` and `s()`; all text via
  `textContent` (never innerHTML with data). Tabs are hash-routed panels; every chart has a table
  twin; bars ≤24px, 4px rounded data-end, clean ticks via `niceTicks`; one direct label per row.
- **Palette (validated on `#111B30`):** series-1 `#4A8BF0`, series-2 `#C98500`; brand gold
  `#F5A623` is UI accent only, never a chart mark. Status colours ship with an icon + label.
- **APIs:** `/api/health`, `/api/dataset[?section=&format=csv]`, `/api/quality`, `/api/events`,
  `/api/pricefeed` (GET; POST with bearer secret), `/api/whatsapp` (Meta webhook, Web signature),
  `/api/refresh`. Errors are `{ error, detail }` with a 4xx/5xx status.
- **Tests:** `node --test tests/*.test.js`; integration tests pin real figures (1,395 units, 98
  clients, $1,697,311.80 used). A count change is a parser regression, not a fixture update.
