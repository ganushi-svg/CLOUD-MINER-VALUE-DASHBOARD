# Data dictionary — `Client_Miner_Model_Summary_FULL`

Spreadsheet `1XySY4bTYTU0XYjndcRlKyBcXLH8n9FiGQtet-iYTRU4`, captured 2026-09-02T13:27:38Z.
Header declares: report date **2026-08-04**, **1,318 workers / 1,395 units**;
used prices = cheapest exact match as of 2026-09-02; fresh prices = latest-dated
source (Bitmars 02-Sep > Letine 31-Aug > Miners1688 18-Aug > undated).

Types below are the **normalized** types produced by Milestone 1, not the raw cell formats.

## Tab 2 — Miner Model Summary (Fleet View) · 24 rows · model grain

The model authority: the only tab stating both hashrate and power per model.

| Field | Type | Description | Example | Notes |
| --- | --- | --- | --- | --- |
| `modelKey` | slug | Canonical model identity | `antminer-s21+-235th` | Derived. Join key across all tabs |
| `label` | string | Model as written | `Bitmain Antminer S21+ 235TH` | 24 distinct |
| `hashrateTh` | decimal | Rated hashrate, TH/s | `235` | |
| `powerW` | decimal | Rated draw, W | `3877` | |
| `efficiencyJPerTh` | decimal | `powerW / hashrateTh` | `16.5` | **Derived.** Comparable only within one algorithm |
| `totalUnits` | integer | Units of this model | `594` | Σ = 1,395 |
| `clientCount` | integer | Clients holding it | `53` | |
| `totalHashrateTh` | decimal | Fleet contribution | `139590` | |
| `totalPowerKw` | decimal | Fleet contribution | `2302.9` | |
| `fleetSharePct` | decimal | % of fleet | `42.6` | Σ = 100.0 ✓ |
| `usedUnitPriceMinor` | integer cents | Second-hand unit price | `126900` | `null` when not quoted |
| `usedUnitPriceAvailability` | enum | `QUOTED` \| `NOT_QUOTED` \| `MISSING` | `QUOTED` | 13 models are `NOT_QUOTED` |
| `usedFleetValueMinor` | integer cents | `usedUnitPrice × totalUnits` | `75378600` | |
| `freshUnitPriceMinor` | integer cents | New-unit price | `148050` | 9 models `NOT_QUOTED` |
| `freshFleetValueMinor` | integer cents | | `87941700` | |
| `usedPriceNote` | string | Supplier and $/TH basis | `PUNKHASH S21+ 235T Mix, $5.40/TH` | Free text |
| `freshPriceSource` | string | Supplier and quote date | `Bitmars (S21++ 235T) - $6.30/T x235 (2026-09-02)` | Free text |
| `otherQuotesNote` | string | Competing quotes | `Letine 31-Aug $1,504; undated list…` | Free text |

## Tab 1 — Client-wise Valuation · 147 rows · client × model grain

| Field | Type | Description | Example | Notes |
| --- | --- | --- | --- | --- |
| `rowNumber` | integer | S.No | `1` | |
| `clientKey` | string | Stable client identity | `c:144` | Derived |
| `clientCode` | string | Operator client code, zero-padded | `144` | `null` for 4 uncoded clients |
| `clientName` | string | Display name | `George Pastakis` | |
| `clientCoded` | boolean | Whether a code was present | `true` | Uncoded rows join on name only — weaker key |
| `modelKey` / `modelLabel` | slug / string | Resolved model | `antminer-s21+-235th` | 100% resolve |
| `hashrateTh` | decimal | Per-unit hashrate | `235` | |
| `units` | integer | Units of this model held | `238` | Σ = 1,395 ✓ |
| `clientTotalUnits` | integer | Client's total, from a merged cell | `263` | **Repeated** on each of the client's rows — never sum |
| `clientTotalUnitsMerged` | boolean | Value came from a merged cell | `true` | 75 rows |
| `clientTotalHashrateTh` | decimal | Client's total TH, merged cell | `60930.0` | Same caution |
| `usedUnitPriceMinor` / `usedTotalMinor` | integer cents | Used basis | `126900` / `30202200` | 31 rows have no used price |
| `freshUnitPriceMinor` / `freshTotalMinor` | integer cents | Fresh basis | `148050` / `35235900` | 26 rows have no fresh price |
| `*Availability` | enum | Why a price is absent | `MISSING` | |

## Tab 3 — Worker Detail · 225 rows · worker grain

⚠️ **Partial extract.** The header claims 1,318 workers; the tab carries 225 (17.1%).
Anything computed here describes a sample, not the fleet.

| Field | Type | Description | Example | Notes |
| --- | --- | --- | --- | --- |
| `workerId` | string | Pool worker identifier | `globalsand.b056` | Unique across 225 rows ✓ |
| `expenseDate` | ISO date | Accounting date | `2026-08-04` | **Single date** — no time series |
| `clientKey` / `clientName` | string | Owning client | `c:144` / `George Pastakis` | 60 clients in the sample |
| `modelKey` / `modelLabel` | slug / string | Normalised model | `antminer-s21+-235th` | 15 models in the sample |
| `originalModelString` | string | Pre-normalisation spelling | `Bitmain Antminer S21+ 235TH` | Provenance |
| `units` | integer | Units behind the worker | `1` | Always 1 in this extract |
| `hashrateTh` / `powerW` | decimal | Per-unit ratings | `235` / `3877` | |
| `hostingRateMicroUsdPerKwh` | integer µ$ | Contracted rate | `70000` = $0.070/kWh | Range $0.050–$0.080, 10 distinct |
| `engine` | enum | `SEGPOOL` \| `CLOUD` | `SEGPOOL` | 158 / 67 |

## Fields requiring care

- **Merged cells.** `Client Total Units` / `Client Total Hashrate` repeat one client-level
  value across that client's rows. The export marks repeats `[merged]`; Milestone 1
  strips and flags them, and validates the recomputed total against the stated one
  (98/98 match).
- **Two absence semantics.** `N/Q` = no supplier listing exists. Blank = nobody
  recorded one. Collapsing both to `null` would silently overstate price coverage.
- **Prices are supplier quotes, not Segments' book value.** Used and fresh bases
  differ by ~35% at fleet level ($1.70M vs $2.29M). Neither is an accounting valuation.
- **Efficiency across algorithms.** `Antminer KS5 Pro (21T)` computes to 150 J/TH
  because it is a Kaspa miner; the sheet carries no algorithm column. Do not average it
  with SHA-256 models.
- **Coverage before conclusions.** Used-price coverage is 45.8% of models / 78.9% of
  holding rows; fresh is 62.5% / 82.3%. Valuation totals cover priced units only.

## Not determinable from this dataset

Uptime · downtime · incidents · availability · site or facility identity ·
maintenance · response and resolution time · capacity headroom · utilisation ·
trends · "what changed today". No column in any of the three tabs carries a site,
status, incident or event timestamp, and every row shares one date.
These require the operational feeds listed in `MILESTONES.md` § Milestone 3b.
