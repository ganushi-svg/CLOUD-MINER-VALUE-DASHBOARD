// Operational event engine - the Phase 6 severity model, applied to what the
// data can currently support.
//
//   NORMAL    within band; stated so the absence of a problem is visible
//   INFO      a fact worth knowing that needs no action
//   WARNING   incomplete, drifting, or approaching a limit
//   CRITICAL  contradicted data or a breached threshold; act now
//   RECOVERY  a prior WARNING or CRITICAL has cleared. Needs the previous run's
//             state, which the price-feed store keeps (durably on Supabase, in
//             function memory otherwise). A recovery stays visible for 24 hours.
//
// Every rule is a pure function of (dataset, priceFeed) and documents its
// thresholds inline; reconcileStates() is the only stateful step and is pure
// in (events, previous states, now). The output shape is the contract
// Milestone 8 hands to the mascot controller: { id, severity, title, detail, source }.

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
  if (store.durable) return ev('price.store', EventSeverity.NORMAL, `Price observations stored in ${store.kind}`, 'Durable across restarts.', 'pricefeed');
  const why = store.requested
    ? `PRICEFEED_STORE=${store.requested} is set but its credentials are missing, so the store fell back to function memory.`
    : 'The store is function memory; set PRICEFEED_STORE=supabase (with SUPABASE_URL and SUPABASE_SECRET_KEY) to keep them.';
  return ev('price.store', EventSeverity.WARNING, 'Price observations are not durable', why, 'pricefeed');
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

const ALERTING = new Set([EventSeverity.WARNING, EventSeverity.CRITICAL]);
export const RECOVERY_WINDOW_MS = 24 * 3_600_000;
const stamp = (iso) => String(iso).slice(0, 16).replace('T', ' ') + ' UTC';

/**
 * Compare this run's events with the alerting states remembered from the last
 * run. An id that was WARNING/CRITICAL and is now absent or calm becomes a
 * RECOVERY event for the next 24 hours; alerting ids keep their first-seen time.
 * Returns the recoveries to publish and the states to remember for next time
 * (states outside the recovery window are dropped, so the caller can delete them).
 */
export function reconcileStates(events, prevStates = [], now = new Date()) {
  const prev = new Map((prevStates ?? []).map((s) => [s.id, s]));
  const nowIso = now.toISOString();
  const next = new Map();
  const recoveries = [];
  const recover = (s, current) => {
    const clearedAt = s.clearedAt ?? nowIso;
    if (now - new Date(clearedAt) > RECOVERY_WINDOW_MS) return; // window passed: forget it
    next.set(s.id, { ...s, clearedAt });
    recoveries.push(ev(`recovery:${s.id}`, EventSeverity.RECOVERY, `Cleared: ${s.title}`,
      `Was ${s.severity} from ${stamp(s.firstSeenAt)}; ${current ? `${current.severity.toLowerCase()} since` : 'no longer reported as of'} ${stamp(clearedAt)}.`,
      'events', { clearedId: s.id, wasSeverity: s.severity, firstSeenAt: s.firstSeenAt, clearedAt }));
  };
  const seen = new Set();
  for (const e of events) {
    seen.add(e.id);
    const p = prev.get(e.id);
    if (ALERTING.has(e.severity)) {
      const continuing = p && !p.clearedAt && ALERTING.has(p.severity);
      next.set(e.id, { id: e.id, severity: e.severity, title: e.title, firstSeenAt: continuing ? p.firstSeenAt : nowIso, lastSeenAt: nowIso, clearedAt: null });
    } else if (p && ALERTING.has(p.severity)) {
      recover(p, e);
    }
  }
  for (const [id, p] of prev) if (!seen.has(id) && ALERTING.has(p.severity)) recover(p, null);
  return { recoveries, states: [...next.values()] };
}

const sortBySeverity = (events) => [...events].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

/**
 * @param {object} ctx { dataset, latest (enriched observations), store, now (Date), prevStates? }
 * @returns the feed plus `states` for the caller to persist (strip before serving).
 */
export function evaluateEvents(ctx) {
  const now = ctx.now ?? new Date();
  const ruled = RULES.flatMap((rule) => { const r = rule({ ...ctx, now }); return Array.isArray(r) ? r : r ? [r] : []; });
  const { recoveries, states } = reconcileStates(ruled, ctx.prevStates ?? [], now);
  const events = sortBySeverity([...ruled, ...recoveries]);
  const counts = { CRITICAL: 0, WARNING: 0, RECOVERY: 0, INFO: 0, NORMAL: 0 };
  for (const e of events) counts[e.severity]++;
  const overall = events[0]?.severity ?? EventSeverity.NORMAL;
  return { generatedAt: now.toISOString(), overall, counts, events: events.map((e) => ({ ...e, at: now.toISOString() })), states };
}
