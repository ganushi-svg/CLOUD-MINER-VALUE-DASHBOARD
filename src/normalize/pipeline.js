// Tab parsers -> one canonical dataset.
//
// Tab layout is positional, not header-addressed by position alone: each tab
// carries a title row and a metadata row before the real header, so the parser
// locates the header row by looking for a known anchor column rather than
// assuming row indices. That keeps ingestion working if someone inserts a note
// above the table, which is the most common way these sheets drift.

import {
  Availability, cleanText, stripMerged, toCount, toIsoDate, toMinorUnits, toNumber,
} from './coerce.js';
import { parseClient } from './clients.js';
import { ModelRegistry, modelSlug } from './models.js';
import { algorithmFor } from './algorithms.js';

const USD_SCALE = 2;   // cents
const RATE_SCALE = 6;  // micro-dollars per kWh — hosting rates run to 3-4 dp

const cell = (row, i) => (i >= 0 && i < row.length ? row[i] : '');

/** Find the header row by an anchor label, and map header name -> index. */
function locateHeader(rows, anchor) {
  for (let r = 0; r < rows.length; r++) {
    const idx = rows[r].findIndex((c) => cleanText(c).toLowerCase() === anchor.toLowerCase());
    if (idx !== -1) {
      const map = new Map();
      rows[r].forEach((h, i) => {
        const key = cleanText(h).toLowerCase();
        if (key && !map.has(key)) map.set(key, i);
      });
      return { headerRow: r, index: map };
    }
  }
  throw new Error(`header row not found (anchor "${anchor}")`);
}

/** Data rows are those whose S.No column holds an integer. */
function dataRows(rows, headerRow, snoIdx) {
  return rows.slice(headerRow + 1).filter((r) => /^\d+$/.test(cleanText(cell(r, snoIdx))));
}

const money = (row, idx, scale = USD_SCALE) => toMinorUnits(cell(row, idx), { scale });

/** "Report date 2026-08-04" / "1,318 workers / 1,395 units" preamble. */
function parseMeta(rows, headerRow) {
  const preamble = rows.slice(0, headerRow).flat().map(cleanText).join(' | ');
  const reportDate = /report date\s*(\d{4}-\d{2}-\d{2})/i.exec(preamble)?.[1] ?? null;
  const claim = /([\d,]+)\s*workers?\s*\/\s*([\d,]+)\s*units?/i.exec(preamble);
  return {
    reportDate: reportDate ? toIsoDate(reportDate) : null,
    claimedWorkers: claim ? toCount(claim[1]) : null,
    claimedUnits: claim ? toCount(claim[2]) : null,
    preamble,
  };
}

/** Fleet View tab — the model authority. */
export function parseModels(rows) {
  const { headerRow, index } = locateHeader(rows, 'Miner Model');
  const at = (name) => index.get(name.toLowerCase()) ?? -1;
  const sno = at('S.No');

  const models = dataRows(rows, headerRow, sno).map((row) => {
    const label = cleanText(cell(row, at('Miner Model')));
    const hashrateTh = toNumber(cell(row, at('Hashrate (TH)')));
    const powerW = toNumber(cell(row, at('Power (W)')));
    const used = money(row, at('Used Unit Price ($)'));
    const fresh = money(row, at('Fresh Unit Price ($)'));
    return {
      modelKey: modelSlug(label),
      slug: modelSlug(label),
      label,
      // Curated, not from the sheet - see normalize/algorithms.js.
      algorithm: algorithmFor(label),
      algorithmSource: 'curated',
      hashrateTh,
      powerW,
      // Efficiency is the standard fleet comparison metric; derived, not stated.
      efficiencyJPerTh:
        hashrateTh && powerW ? Number((powerW / hashrateTh).toFixed(2)) : null,
      totalUnits: toCount(cell(row, at('Total Units'))),
      clientCount: toCount(cell(row, at('No. of Clients'))),
      totalHashrateTh: toNumber(cell(row, at('Total Hashrate (TH)'))),
      totalPowerKw: toNumber(cell(row, at('Total Power (kW)'))),
      fleetSharePct: toNumber(cell(row, at('% of Fleet'))),
      usedUnitPriceMinor: used.value,
      usedUnitPriceAvailability: used.availability,
      usedFleetValueMinor: money(row, at('Used Fleet Value ($)')).value,
      freshUnitPriceMinor: fresh.value,
      freshUnitPriceAvailability: fresh.availability,
      freshFleetValueMinor: money(row, at('Fresh Fleet Value ($)')).value,
      usedPriceNote: cleanText(cell(row, at('Price Source / Note'))) || null,
      freshPriceSource: cleanText(cell(row, at('Fresh Source (date)'))) || null,
      otherQuotesNote: cleanText(cell(row, at('Other fresh quotes / notes'))) || null,
    };
  });

  return { models, meta: parseMeta(rows, headerRow) };
}

/** Client-wise Valuation tab — client x model holdings. */
export function parseHoldings(rows, registry) {
  const { headerRow, index } = locateHeader(rows, 'Client / Customer');
  const at = (name) => index.get(name.toLowerCase()) ?? -1;
  const sno = at('S.No');

  const holdings = dataRows(rows, headerRow, sno).map((row) => {
    const client = parseClient(cell(row, at('Client / Customer')));
    const modelLabel = cleanText(cell(row, at('Miner Model')));
    const { modelKey, matchedBy } = registry.resolve(modelLabel);
    const totalUnits = stripMerged(cell(row, at('Client Total Units')));
    const totalHash = stripMerged(cell(row, at('Client Total Hashrate (TH)')));
    const usedUnit = money(row, at('Used Unit Price ($)'));
    const freshUnit = money(row, at('Fresh Unit Price ($)'));

    return {
      rowNumber: toCount(cell(row, sno)),
      clientKey: client.key,
      clientCode: client.code,
      clientName: client.name,
      clientCoded: client.coded,
      modelKey,
      modelLabel,
      modelMatchedBy: matchedBy,
      hashrateTh: toNumber(cell(row, at('Hashrate (TH)'))),
      units: toCount(cell(row, at('Units'))),
      // Merged cells repeat a client-level total on every one of that client's
      // rows. Kept for traceability, never summed — see rule holdings.units.
      clientTotalUnits: toCount(totalUnits.text),
      clientTotalUnitsMerged: totalUnits.merged,
      clientTotalHashrateTh: toNumber(totalHash.text),
      usedUnitPriceMinor: usedUnit.value,
      usedUnitPriceAvailability: usedUnit.availability,
      usedTotalMinor: money(row, at('Used Total Price ($)')).value,
      freshUnitPriceMinor: freshUnit.value,
      freshUnitPriceAvailability: freshUnit.availability,
      freshTotalMinor: money(row, at('Fresh Total Price ($)')).value,
    };
  });

  return { holdings, meta: parseMeta(rows, headerRow) };
}

/** Worker Detail tab — one row per mining worker. */
export function parseWorkers(rows, registry) {
  const { headerRow, index } = locateHeader(rows, 'Worker ID');
  const at = (name) => index.get(name.toLowerCase()) ?? -1;
  const sno = at('S.No');

  const workers = dataRows(rows, headerRow, sno).map((row) => {
    const client = parseClient(cell(row, at('Customer')));
    const modelLabel = cleanText(cell(row, at('Miner Model (normalised)')));
    const { modelKey, matchedBy } = registry.resolve(modelLabel);
    const hashrateTh = toNumber(cell(row, at('Hashrate per Unit (TH)')));
    const powerW = toNumber(cell(row, at('Power per Unit (W)')));
    const engine = cleanText(cell(row, at('Worker Engine'))).toUpperCase() || null;

    return {
      rowNumber: toCount(cell(row, sno)),
      workerId: cleanText(cell(row, at('Worker ID'))),
      expenseDate: toIsoDate(cell(row, at('Expense Date'))),
      clientKey: client.key,
      clientCode: client.code,
      clientName: client.name,
      modelKey,
      modelLabel,
      modelMatchedBy: matchedBy,
      originalModelString: cleanText(cell(row, at('Original Model String'))) || null,
      units: toCount(cell(row, at('Units in Worker'))),
      hashrateTh,
      powerW,
      efficiencyJPerTh: hashrateTh && powerW ? Number((powerW / hashrateTh).toFixed(2)) : null,
      hostingRateMicroUsdPerKwh: money(row, at('Hosting Rate ($/kWh)'), RATE_SCALE).value,
      engine,
    };
  });

  return { workers, meta: parseMeta(rows, headerRow) };
}

/** Roll holdings up to one record per client. */
function rollUpClients(holdings) {
  const byClient = new Map();
  for (const h of holdings) {
    if (!byClient.has(h.clientKey)) {
      byClient.set(h.clientKey, {
        clientKey: h.clientKey,
        clientCode: h.clientCode,
        clientName: h.clientName,
        clientCoded: h.clientCoded,
        modelCount: 0,
        units: 0,
        hashrateTh: 0,
        usedValueMinor: 0,
        freshValueMinor: 0,
        statedTotalUnits: h.clientTotalUnits,
      });
    }
    const c = byClient.get(h.clientKey);
    c.modelCount += 1;
    c.units += h.units ?? 0;
    c.hashrateTh += (h.hashrateTh ?? 0) * (h.units ?? 0);
    c.usedValueMinor += h.usedTotalMinor ?? 0;
    c.freshValueMinor += h.freshTotalMinor ?? 0;
  }
  return [...byClient.values()]
    .map((c) => ({ ...c, hashrateTh: Number(c.hashrateTh.toFixed(1)) }))
    .sort((a, b) => b.units - a.units);
}

/** Identify the three tabs by shape, so tab order/naming can change safely. */
function classifyTabs(tabs) {
  const has = (tab, label) =>
    tab.rows.some((r) => r.some((c) => cleanText(c).toLowerCase() === label.toLowerCase()));
  const find = (label) => tabs.find((t) => has(t, label));

  const modelsTab = find('% of Fleet');
  const holdingsTab = find('Client Total Units');
  const workersTab = find('Worker ID');
  const missing = [
    !modelsTab && 'Fleet View (anchor "% of Fleet")',
    !holdingsTab && 'Client-wise Valuation (anchor "Client Total Units")',
    !workersTab && 'Worker Detail (anchor "Worker ID")',
  ].filter(Boolean);
  if (missing.length) throw new Error(`unrecognised workbook, missing: ${missing.join('; ')}`);
  return { modelsTab, holdingsTab, workersTab };
}

/** Workbook -> canonical dataset. */
export function normalizeWorkbook(workbook) {
  const { modelsTab, holdingsTab, workersTab } = classifyTabs(workbook.tabs);

  const { models, meta: modelMeta } = parseModels(modelsTab.rows);
  const registry = new ModelRegistry(models);
  const { holdings, meta: holdingMeta } = parseHoldings(holdingsTab.rows, registry);
  const { workers } = parseWorkers(workersTab.rows, registry);

  return {
    meta: {
      spreadsheetId: workbook.sheetId ?? null,
      title: workbook.title ?? null,
      source: workbook.source,
      capturedAt: workbook.capturedAt,
      normalizedAt: new Date().toISOString(),
      reportDate: holdingMeta.reportDate ?? modelMeta.reportDate,
      claimedWorkers: holdingMeta.claimedWorkers,
      claimedUnits: holdingMeta.claimedUnits,
      currency: 'USD',
      moneyScale: USD_SCALE,
      rateScale: RATE_SCALE,
      attempts: workbook.attempts ?? [],
    },
    models,
    holdings,
    workers,
    clients: rollUpClients(holdings),
    unresolvedModelReferences: registry.unresolvedReferences(),
  };
}
