// Observed prices against the sheet's recorded quotes.
//
// The sheet holds two quote bases per model (used, fresh). An observation is
// compared with the basis it declares; an UNKNOWN basis is compared with the
// used quote, since supplier lists that omit condition are overwhelmingly
// second-hand stock. Every derived figure carries the units it covers, so a
// mark-to-market total never silently pretends to cover the whole fleet.

const refFor = (o, q) => (o.basis === 'FRESH' ? q?.freshUnitPriceMinor : q?.usedUnitPriceMinor) ?? null;

/** Attach the matching sheet quote and the percentage delta to each observation. */
export function enrichWithQuotes(observations, models) {
  const quotes = new Map(models.map((m) => [m.modelKey, m]));
  return observations.map((o) => {
    const ref = refFor(o, quotes.get(o.modelKey));
    return { ...o, sheetUnitPriceMinor: ref, deltaPct: ref ? Number((((o.unitPriceMinor - ref) / ref) * 100).toFixed(1)) : null };
  });
}

/**
 * Re-value the fleet at the latest observed price per model.
 * Only models with an observation AND a comparable sheet quote enter the totals,
 * and the result says how many units that is.
 */
export function markToMarket(latest, dataset) {
  const byModel = new Map(dataset.models.map((m) => [m.modelKey, m]));
  // One observation per model: prefer USED, then UNKNOWN, then FRESH, newest wins within a basis.
  const pick = new Map();
  const rank = { USED: 0, UNKNOWN: 1, FRESH: 2 };
  for (const o of latest) {
    const prev = pick.get(o.modelKey);
    if (!prev || rank[o.basis] < rank[prev.basis] || (rank[o.basis] === rank[prev.basis] && o.observedAt > prev.observedAt)) pick.set(o.modelKey, o);
  }
  const rows = [];
  for (const [modelKey, o] of pick) {
    const m = byModel.get(modelKey);
    if (!m) continue;
    const sheet = refFor(o, m);
    const units = m.totalUnits ?? 0;
    rows.push({
      modelKey, label: m.label, units, basis: o.basis, observedAt: o.observedAt, source: o.source,
      observedUnitMinor: o.unitPriceMinor, sheetUnitMinor: sheet,
      deltaUnitMinor: sheet == null ? null : o.unitPriceMinor - sheet,
      observedValueMinor: units * o.unitPriceMinor,
      sheetValueMinor: sheet == null ? null : units * sheet,
      exposureMinor: sheet == null ? null : units * (o.unitPriceMinor - sheet),
    });
  }
  const comparable = rows.filter((r) => r.sheetValueMinor != null);
  const observedValueMinor = comparable.reduce((a, r) => a + r.observedValueMinor, 0);
  const sheetValueMinor = comparable.reduce((a, r) => a + r.sheetValueMinor, 0);
  const coveredUnits = comparable.reduce((a, r) => a + r.units, 0);

  // Client exposure: units held x per-unit delta, over comparable models only.
  const deltaByModel = new Map(comparable.map((r) => [r.modelKey, r.deltaUnitMinor]));
  const clients = new Map();
  for (const h of dataset.holdings) {
    const d = deltaByModel.get(h.modelKey);
    if (d == null) continue;
    const c = clients.get(h.clientKey) ?? { clientKey: h.clientKey, clientName: h.clientName, units: 0, exposureMinor: 0 };
    c.units += h.units ?? 0; c.exposureMinor += (h.units ?? 0) * d; clients.set(h.clientKey, c);
  }
  return {
    models: rows.sort((a, b) => Math.abs(b.exposureMinor ?? 0) - Math.abs(a.exposureMinor ?? 0)),
    totals: {
      modelsObserved: rows.length, modelsComparable: comparable.length,
      coveredUnits, fleetUnits: dataset.models.reduce((a, m) => a + (m.totalUnits ?? 0), 0),
      observedValueMinor, sheetValueMinor, deltaMinor: observedValueMinor - sheetValueMinor,
      deltaPct: sheetValueMinor ? Number((((observedValueMinor - sheetValueMinor) / sheetValueMinor) * 100).toFixed(1)) : null,
    },
    clients: [...clients.values()].sort((a, b) => Math.abs(b.exposureMinor) - Math.abs(a.exposureMinor)).slice(0, 8),
  };
}
