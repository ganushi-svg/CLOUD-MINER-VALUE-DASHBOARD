// Operational event engine - the Phase 6 severity model, applied to what the
// data can currently support.
//
//   NORMAL    within band; stated so the absence of a problem is visible
//   INFO      a fact worth knowing that needs no action
//   WARNING   incomplete, drifting, or approaching a limit
//   CRITICAL  contradicted data or a breached threshold; act now
//   RECOVERY  a prior CRITICAL has cleared - requires state from one run to
//             the next, which arrives with Milestone 2's database. The value is
//             reserved here and never emitted by the stateless engine.
//
// Every rule is a pure function of (dataset, priceFeed) and documents its
// thresholds inline. The output shape is the contract Milestone 8 hands to the
// mascot controller: { id, severity, title, detail, source }.

export const EventSeverity = Object.freeze({ NORMAL: 'NORMAL', INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL', RECOVERY: 'RECOVERY' });
const ORDER = { CRITICAL: 0, WARNING: 1, RECOVERY: 2, INFO: 3, NORMAL: 4 };
const ev = (id, severity, title, detail, source, extra = {}) => ({ id, severity, title, detail, source, ...extra });
const usd = (minor) => '$' + (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const daysBetween = (a, b) => Math.floor((b - a) / 86_400_000);

/** How old is the valuation basis? <=14 d normal, <=45 d warning, beyond critical. */
function staleness({ dataset, now }) {
  const rd = dataset.meta.reportDate ? new Date(dataset.meta.reportDate + 'T00:00:00Z') : null;
  if (!rd) return ev('data.staleness', EventSeverity.WARNING, 'Report date unknown', 'The workbook header carries no report date, so the age of the valuation basis cannot be judged.', 'dataset');
  const days = daysBetween(rd, now);
  const sev = days <= 14 ? EventSeverity.NORMAL : days <= 45 ? EventSeverity.WARNING : EventSeverity.CRITICAL;
  return ev('data.staleness', sev, `Valuation basis is ${days} day${days === 1 ? '' : 's'} old`,
    `Report date ${dataset.meta.reportDate}. Unit counts, holdings and quotes all date from that day.`, 'dataset', { days });
}

/** Snapshot vs live read. */
function source({ dataset }) {
  if (dataset.meta.source === 'fixture') {
    return ev('data.source', EventSeverity.INFO, 'Serving the committed snapshot',
      `Captured ${dataset.meta.capturedAt ? dataset.meta.capturedAt.slice(0, 16).replace('T', ' ') + ' UTC' : 'at an unknown time'}. A live sheet read needs the service account (see DEPLOY.md).`, 'dataset');
  }
  return ev('data.source', EventSeverity.NORMAL, `Reading the sheet live via ${dataset.meta.source.replace('_', ' ')}`, `Normalized ${dataset.meta.normalizedAt}.`, 'dataset');
}

/** Integrity contradictions are the one thing that always escalates. */
function integrity({ dataset }) {
  const v = dataset.validation;
  const crit = v.findings.filter((f) => f.severity === 'CRITICAL');
  if (crit.length) {
    return ev('validation.integrity', EventSeverity.CRITICAL, `${crit.length} integrity contradiction${crit.length === 1 ? '' : 's'} in the source`,
      crit.map((f) => `${f.id}: ${f.summary}`).join(' '), 'validation', { findings: crit.map((f) => f.id) });
  }
  return ev('validation.integrity', EventSeverity.NORMAL, 'All integrity checks pass',
    `${v.counts.INFO} checks passed; ${v.counts.WARNING} coverage warning${v.counts.WARNING === 1 ? '' : 's'} are listed under Data quality.`, 'validation');
}

/** Observed supplier price vs the sheet's quote. >=15% warning, >=30% critical. */
function priceDeltas({ latest }) {
  const out = [];
  for (const o of latest) {
    if (o.deltaPct == null) continue;
    const mag = Math.abs(o.deltaPct);
    if (mag < 15) continue;
    const sev = mag >= 30 ? EventSeverity.CRITICAL : EventSeverity.WARNING;
    const dir = o.deltaPct > 0 ? 'above' : 'below';
    out.push(ev(`price.delta:${o.modelKey}:${o.basis}`, sev,
      `${o.modelLabel.replace(/^Bitmain\s+/i, '')} observed ${mag}% ${dir} the sheet quote`,
      `${usd(o.unitPriceMinor)} observed (${o.basis.toLowerCase()} basis, ${o.source ?? 'unknown source'}) vs ${usd(o.sheetUnitPriceMinor)} recorded.`, 'pricefeed',
      { modelKey: o.modelKey, deltaPct: o.deltaPct }));
  }
  if (!out.length && latest.some((o) => o.deltaPct != null)) {
    out.push(ev('price.delta', EventSeverity.NORMAL, 'Observed prices within 15% of sheet quotes', `${latest.filter((o) => o.deltaPct != null).length} model/basis pairs compared.`, 'pricefeed'));
  }
  return out;
}

/** Is the feed alive? No data is INFO (not a fault); silence after data is a WARNING at 3 days. */
function feedActivity({ latest, now }) {
  if (!latest.length) return ev('price.feed', EventSeverity.INFO, 'No supplier price observations yet', 'Forward a price list to the WhatsApp Business number or POST it to /api/pricefeed.', 'pricefeed');
  const last = latest.map((o) => o.observedAt).sort().at(-1);
  const days = daysBetween(new Date(last), now);
  if (days > 3) return ev('price.feed', EventSeverity.WARNING, `No supplier prices for ${days} days`, `Last observation ${last.slice(0, 16).replace('T', ' ')} UTC.`, 'pricefeed', { days });
  return ev('price.feed', EventSeverity.NORMAL, 'Supplier price feed is current', `Last observation ${last.slice(0, 16).replace('T', ' ')} UTC across ${latest.length} model/basis pairs.`, 'pricefeed');
}

/** A memory store loses everything on the next cold start. */
function feedStore({ store }) {
  if (!store) return null;
  return store.durable
    ? ev('price.store', EventSeverity.NORMAL, `Price observations stored in ${store.kind}`, 'Durable across restarts.', 'pricefeed')
    : ev('price.store', EventSeverity.WARNING, 'Price observations are not durable', 'The store is function memory; set PRICEFEED_STORE=sheet or wait for Milestone 2 to keep them.', 'pricefeed');
}

/** Concentration is a fact to state, not an alarm: >=15% of the fleet in one client. */
function concentration({ dataset }) {
  const total = dataset.models.reduce((a, m) => a + (m.totalUnits ?? 0), 0);
  const top = dataset.clients[0];
  if (!top || !total) return null;
  const share = top.units / total;
  const hhi = dataset.clients.reduce((a, c) => a + Math.pow(c.units / total, 2), 0) * 10_000;
  if (share >= 0.15) {
    return ev('fleet.concentration', EventSeverity.INFO, `${top.clientName} holds ${(share * 100).toFixed(0)}% of the fleet`,
      `${top.units.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} units; HHI ${hhi.toFixed(0)} (below 1,500 reads as unconcentrated).`, 'dataset', { sharePct: Number((share * 100).toFixed(1)), hhi: Math.round(hhi) });
  }
  return ev('fleet.concentration', EventSeverity.NORMAL, 'No single client holds 15% of the fleet', `Largest holder ${top.clientName} at ${(share * 100).toFixed(1)}%; HHI ${hhi.toFixed(0)}.`, 'dataset');
}

const RULES = [staleness, source, integrity, priceDeltas, feedActivity, feedStore, concentration];

/**
 * @param {object} ctx { dataset, latest (enriched observations), store, now (Date) }
 */
export function evaluateEvents(ctx) {
  const now = ctx.now ?? new Date();
  const events = RULES.flatMap((rule) => { const r = rule({ ...ctx, now }); return Array.isArray(r) ? r : r ? [r] : []; })
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const counts = { CRITICAL: 0, WARNING: 0, RECOVERY: 0, INFO: 0, NORMAL: 0 };
  for (const e of events) counts[e.severity]++;
  const overall = events[0]?.severity ?? EventSeverity.NORMAL;
  return { generatedAt: now.toISOString(), overall, counts, events: events.map((e) => ({ ...e, at: now.toISOString() })) };
}
