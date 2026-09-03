// Integrity and plausibility rules over the normalized dataset.
//
// Each rule returns a finding with an explicit severity so that later
// milestones (event detection, AI interpretation) consume a stable contract
// rather than re-deriving judgement from raw rows:
//
//   CRITICAL  the dataset contradicts itself; downstream numbers would be wrong
//   WARNING   the dataset is internally consistent but incomplete or suspicious
//   INFO      a fact worth surfacing that needs no action
//
// Rules never mutate the dataset and never repair it. Silent repair is how a
// spreadsheet error becomes a management report error.

export const Severity = Object.freeze({ INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL' });

const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

function finding(id, severity, summary, detail = {}) {
  return { id, severity, summary, ...detail };
}

/** Holdings units must reconcile to the model tab's stated fleet size. */
function unitsReconcile({ holdings, models }) {
  const h = sum(holdings.map((x) => x.units));
  const m = sum(models.map((x) => x.totalUnits));
  if (h === m) {
    return finding('integrity.units.total', Severity.INFO,
      `Holdings and fleet view agree on ${h.toLocaleString()} units.`, { holdingsUnits: h, modelUnits: m });
  }
  return finding('integrity.units.total', Severity.CRITICAL,
    `Unit totals disagree: holdings ${h} vs fleet view ${m}.`,
    { holdingsUnits: h, modelUnits: m, delta: h - m });
}

/** Per-model unit totals must reconcile between the two tabs. */
function unitsPerModel({ holdings, models }) {
  const byModel = new Map();
  for (const h of holdings) {
    if (!h.modelKey) continue;
    byModel.set(h.modelKey, (byModel.get(h.modelKey) ?? 0) + (h.units ?? 0));
  }
  const mismatches = models
    .map((m) => ({ modelKey: m.modelKey, label: m.label, fleetView: m.totalUnits ?? 0, holdings: byModel.get(m.modelKey) ?? 0 }))
    .filter((r) => r.fleetView !== r.holdings);

  if (!mismatches.length) {
    return finding('integrity.units.per_model', Severity.INFO,
      `All ${models.length} models reconcile between holdings and fleet view.`);
  }
  return finding('integrity.units.per_model', Severity.CRITICAL,
    `${mismatches.length} model(s) disagree on unit count between tabs.`, { mismatches });
}

/** % of Fleet is a stated column; it should sum to 100. */
function fleetShare({ models }) {
  const total = Number(sum(models.map((m) => m.fleetSharePct)).toFixed(1));
  if (Math.abs(total - 100) <= 0.5) {
    return finding('integrity.fleet_share', Severity.INFO, `Fleet share sums to ${total}%.`, { total });
  }
  return finding('integrity.fleet_share', Severity.WARNING,
    `Fleet share sums to ${total}%, not 100%.`, { total, delta: Number((total - 100).toFixed(1)) });
}

/** unit price x units must equal the stated line total, to the cent. */
function lineTotals({ holdings }) {
  const bad = [];
  for (const h of holdings) {
    for (const basis of ['used', 'fresh']) {
      const unit = h[`${basis}UnitPriceMinor`];
      const total = h[`${basis}TotalMinor`];
      if (unit == null || total == null || h.units == null) continue;
      const expected = unit * h.units;
      if (expected !== total) {
        bad.push({ rowNumber: h.rowNumber, clientName: h.clientName, modelLabel: h.modelLabel,
          basis, units: h.units, unitPriceMinor: unit, statedTotalMinor: total, expectedTotalMinor: expected });
      }
    }
  }
  if (!bad.length) {
    return finding('integrity.line_totals', Severity.INFO, 'Every priced line total equals unit price x units.');
  }
  return finding('integrity.line_totals', Severity.CRITICAL,
    `${bad.length} line total(s) do not equal unit price x units.`, { rows: bad.slice(0, 25), count: bad.length });
}

/** No model string may go unresolved — an unmatched row is invisible to rollups. */
function modelResolution({ unresolvedModelReferences, holdings, workers }) {
  const unmatchedRows = [...holdings, ...workers].filter((r) => !r.modelKey).length;
  if (!unresolvedModelReferences.length && !unmatchedRows) {
    return finding('integrity.model_resolution', Severity.INFO, 'All model references resolved to the registry.');
  }
  return finding('integrity.model_resolution', Severity.CRITICAL,
    `${unmatchedRows} row(s) reference ${unresolvedModelReferences.length} unknown model string(s).`,
    { unresolved: unresolvedModelReferences, unmatchedRows });
}

/** Worker IDs are the join key to pool/billing systems; they must be unique. */
function workerIdUniqueness({ workers }) {
  const seen = new Map();
  for (const w of workers) seen.set(w.workerId, (seen.get(w.workerId) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ workerId: id, count: n }));
  if (!dupes.length) {
    return finding('integrity.worker_ids', Severity.INFO, `${workers.length} worker IDs, all unique.`);
  }
  return finding('integrity.worker_ids', Severity.CRITICAL, `${dupes.length} duplicate worker ID(s).`, { dupes });
}

/**
 * The workbook header states a fleet-wide worker count. The worker tab carries
 * fewer rows than that, so it is a partial extract — any per-worker metric
 * computed from it describes a sample, not the fleet.
 */
function workerCoverage({ workers, meta }) {
  const claimed = meta.claimedWorkers;
  if (!claimed) {
    return finding('coverage.workers', Severity.WARNING,
      'Workbook header states no worker count; worker-tab completeness cannot be verified.');
  }
  const present = workers.length;
  const pct = Number(((present / claimed) * 100).toFixed(1));
  if (present >= claimed) {
    return finding('coverage.workers', Severity.INFO,
      `Worker tab carries all ${present.toLocaleString()} stated workers.`, { present, claimed, coveragePct: pct });
  }
  return finding('coverage.workers', Severity.WARNING,
    `Worker tab carries ${present} of ${claimed.toLocaleString()} stated workers (${pct}%). ` +
    'Per-worker figures describe a sample, not the fleet.',
    { present, claimed, coveragePct: pct, missing: claimed - present });
}

/** Valuation completeness, split by the two price bases. */
function priceCoverage({ models, holdings }) {
  const stat = (rows, field) => {
    const quoted = rows.filter((r) => r[`${field}Availability`] === 'QUOTED').length;
    return { quoted, total: rows.length, pct: Number(((quoted / rows.length) * 100).toFixed(1)) };
  };
  const detail = {
    modelsUsed: stat(models, 'usedUnitPrice'),
    modelsFresh: stat(models, 'freshUnitPrice'),
    holdingsUsed: stat(holdings, 'usedUnitPrice'),
    holdingsFresh: stat(holdings, 'freshUnitPrice'),
  };
  const worst = Math.min(...Object.values(detail).map((d) => d.pct));
  return finding('coverage.prices', worst < 80 ? Severity.WARNING : Severity.INFO,
    `Price coverage ranges ${worst}%-${Math.max(...Object.values(detail).map((d) => d.pct))}% across bases; ` +
    'unpriced units are excluded from valuation totals.', detail);
}

/** Hosting rates outside a commercially plausible band signal a data error. */
function hostingRateBand({ workers }, { minMicro = 10_000, maxMicro = 500_000 } = {}) {
  const rates = workers.map((w) => w.hostingRateMicroUsdPerKwh).filter((r) => r != null);
  if (!rates.length) return finding('plausibility.hosting_rate', Severity.WARNING, 'No hosting rates present.');
  const outliers = workers.filter(
    (w) => w.hostingRateMicroUsdPerKwh != null &&
      (w.hostingRateMicroUsdPerKwh < minMicro || w.hostingRateMicroUsdPerKwh > maxMicro),
  ).map((w) => ({ workerId: w.workerId, rate: w.hostingRateMicroUsdPerKwh / 1e6 }));

  const detail = { minUsdPerKwh: Math.min(...rates) / 1e6, maxUsdPerKwh: Math.max(...rates) / 1e6,
    distinctRates: new Set(rates).size, outliers };
  return outliers.length
    ? finding('plausibility.hosting_rate', Severity.WARNING, `${outliers.length} hosting rate(s) outside the plausible band.`, detail)
    : finding('plausibility.hosting_rate', Severity.INFO,
        `Hosting rates span $${detail.minUsdPerKwh}-$${detail.maxUsdPerKwh}/kWh across ${detail.distinctRates} distinct rates.`, detail);
}

/**
 * Efficiency outside this band means hashrate and power disagree - but only
 * within one hashing algorithm. Models are grouped by their curated algorithm;
 * a group of one has no peer and is reported, not judged.
 */
function efficiencyBand({ models }, { min = 5, max = 100 } = {}) {
  const groups = new Map();
  for (const m of models) {
    const k = m.algorithm ?? 'UNKNOWN';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const missing = models.filter((m) => m.efficiencyJPerTh == null).map((m) => m.label);
  const outliers = [], singletons = [];
  for (const [algo, ms] of groups) {
    if (ms.length === 1) { singletons.push({ algorithm: algo, label: ms[0].label, efficiencyJPerTh: ms[0].efficiencyJPerTh }); continue; }
    for (const m of ms) {
      if (m.efficiencyJPerTh != null && (m.efficiencyJPerTh < min || m.efficiencyJPerTh > max)) {
        outliers.push({ algorithm: algo, modelKey: m.modelKey, label: m.label, efficiencyJPerTh: m.efficiencyJPerTh });
      }
    }
  }
  const byAlgo = Object.fromEntries([...groups].map(([k, v]) => [k, v.length]));
  if (!outliers.length && !missing.length) {
    const solo = singletons.map((s) => `${s.label} (${s.algorithm}, ${s.efficiencyJPerTh} J/TH)`).join('; ');
    return finding('plausibility.efficiency', Severity.INFO,
      `All models within ${min}-${max} J/TH inside their algorithm group` +
      (singletons.length ? `; ${singletons.length} model(s) have no peer to compare against: ${solo}.` : '.'),
      { byAlgorithm: byAlgo, singletons, note: 'Algorithm is curated product knowledge, not a sheet column.' });
  }
  return finding('plausibility.efficiency', Severity.WARNING,
    `${outliers.length} model(s) outside ${min}-${max} J/TH within their own algorithm group; ${missing.length} lack hashrate or power.`,
    { outliers, missing, byAlgorithm: byAlgo, singletons });
}

/** A single report date means the snapshot is a point-in-time cut, not a series. */
function reportDateSpread({ workers, meta }) {
  const dates = [...new Set(workers.map((w) => w.expenseDate).filter(Boolean))].sort();
  return finding('coverage.time', dates.length <= 1 ? Severity.WARNING : Severity.INFO,
    dates.length <= 1
      ? `All worker rows share one date (${dates[0] ?? 'none'}). No time series is derivable from this source alone.`
      : `Worker rows span ${dates.length} dates (${dates[0]} to ${dates.at(-1)}).`,
    { dates, reportDate: meta.reportDate });
}

/**
 * Each holding row repeats its client's total in a merged cell. Recomputing the
 * total from the rows and comparing it back is the cheapest check that the
 * merged-cell unmerge did not misalign rows against clients.
 */
function clientTotals({ clients }) {
  const mismatches = clients
    .filter((c) => c.statedTotalUnits != null && c.statedTotalUnits !== c.units)
    .map((c) => ({ clientKey: c.clientKey, clientName: c.clientName, computed: c.units, stated: c.statedTotalUnits }));
  if (!mismatches.length) {
    return finding('integrity.client_totals', Severity.INFO,
      `All ${clients.length} client totals match the sum of their rows.`);
  }
  return finding('integrity.client_totals', Severity.CRITICAL,
    `${mismatches.length} client(s) whose stated total differs from the sum of their rows.`, { mismatches });
}

const RULES = [
  unitsReconcile, unitsPerModel, fleetShare, lineTotals, clientTotals, modelResolution,
  workerIdUniqueness, workerCoverage, priceCoverage, hostingRateBand,
  efficiencyBand, reportDateSpread,
];

/** Run every rule; return findings plus a severity rollup. */
export function validate(dataset) {
  const findings = RULES.map((rule) => rule(dataset));
  const counts = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return {
    ok: counts.CRITICAL === 0,
    counts,
    // Worst severity first so a consumer can read the top of the list and stop.
    findings: findings.sort(
      (a, b) => ['CRITICAL', 'WARNING', 'INFO'].indexOf(a.severity) - ['CRITICAL', 'WARNING', 'INFO'].indexOf(b.severity),
    ),
  };
}
