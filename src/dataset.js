// Orchestration: fetch -> normalize -> validate, with a short in-memory cache.
//
// Serverless functions are recycled frequently, so this cache only ever spares
// repeat calls within one warm instance. It is deliberately not a correctness
// mechanism: every entry carries the timestamps a consumer needs to decide
// whether the data is fresh enough.

import { fetchWorkbook } from './ingest/sheets.js';
import { normalizeWorkbook } from './normalize/pipeline.js';
import { validate } from './validate/rules.js';

let cache = { at: 0, payload: null };

export async function buildDataset(options = {}) {
  const workbook = await fetchWorkbook(options);
  const dataset = normalizeWorkbook(workbook);
  const validation = validate(dataset);
  return { ...dataset, validation };
}

export async function getDataset({ force = false, env = process.env, ...rest } = {}) {
  const ttlMs = Number(env.INGEST_CACHE_TTL ?? 300) * 1000;
  const now = Date.now();
  if (!force && cache.payload && now - cache.at < ttlMs) {
    return { ...cache.payload, cache: { hit: true, ageMs: now - cache.at, ttlMs } };
  }
  const payload = await buildDataset({ env, ...rest });
  cache = { at: now, payload };
  return { ...payload, cache: { hit: false, ageMs: 0, ttlMs } };
}

/** Compact rollup used by /api/health and the status page. */
export function summarize(dataset) {
  const units = dataset.models.reduce((a, m) => a + (m.totalUnits ?? 0), 0);
  const hashrate = dataset.models.reduce((a, m) => a + (m.totalHashrateTh ?? 0), 0);
  const powerKw = dataset.models.reduce((a, m) => a + (m.totalPowerKw ?? 0), 0);
  const usedValueMinor = dataset.models.reduce((a, m) => a + (m.usedFleetValueMinor ?? 0), 0);
  const freshValueMinor = dataset.models.reduce((a, m) => a + (m.freshFleetValueMinor ?? 0), 0);
  return {
    source: dataset.meta.source,
    reportDate: dataset.meta.reportDate,
    capturedAt: dataset.meta.capturedAt,
    normalizedAt: dataset.meta.normalizedAt,
    currency: dataset.meta.currency,
    counts: {
      models: dataset.models.length,
      clients: dataset.clients.length,
      holdings: dataset.holdings.length,
      workers: dataset.workers.length,
    },
    fleet: {
      units,
      hashrateTh: Number(hashrate.toFixed(1)),
      powerKw: Number(powerKw.toFixed(1)),
      usedValueMinor,
      freshValueMinor,
      // Efficiency is only meaningful within one algorithm; report the dominant one.
      sha256: (() => {
        const ms = dataset.models.filter((m) => m.algorithm === 'SHA-256');
        const th = ms.reduce((a, m) => a + (m.totalHashrateTh ?? 0), 0);
        const kw = ms.reduce((a, m) => a + (m.totalPowerKw ?? 0), 0);
        return { models: ms.length, hashrateTh: Number(th.toFixed(1)), powerKw: Number(kw.toFixed(1)),
          efficiencyJPerTh: th ? Number(((kw * 1000) / th).toFixed(2)) : null };
      })(),
      algorithms: dataset.models.reduce((acc, m) => { acc[m.algorithm ?? 'UNKNOWN'] = (acc[m.algorithm ?? 'UNKNOWN'] ?? 0) + 1; return acc; }, {}),
    },
    validation: { ok: dataset.validation.ok, counts: dataset.validation.counts },
  };
}
