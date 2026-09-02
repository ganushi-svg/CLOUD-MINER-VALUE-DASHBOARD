// Integration tests over the committed snapshot of the real workbook.
// The expected numbers below were verified against the live sheet at capture
// time, so a regression in parsing shows up as a failing count, not as a
// plausible-looking wrong answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkbook } from '../src/ingest/sheets.js';
import { normalizeWorkbook } from '../src/normalize/pipeline.js';
import { validate } from '../src/validate/rules.js';

const FIXTURE_ENV = { INGEST_SOURCES: 'fixture' };
const load = async () => normalizeWorkbook(await fetchWorkbook({ env: FIXTURE_ENV }));

test('workbook shape matches the source of truth', async () => {
  const d = await load();
  assert.equal(d.models.length, 24, '24 miner models in the fleet view');
  assert.equal(d.holdings.length, 147, '147 client x model holding rows');
  assert.equal(d.workers.length, 225, '225 worker rows present in the tab');
  assert.equal(d.clients.length, 98, '98 distinct clients');
  assert.equal(d.meta.reportDate, '2026-08-04');
  assert.equal(d.meta.currency, 'USD');
});

test('fleet totals reconcile to the stated 1,395 units', async () => {
  const d = await load();
  const holdingUnits = d.holdings.reduce((a, h) => a + h.units, 0);
  const modelUnits = d.models.reduce((a, m) => a + m.totalUnits, 0);
  assert.equal(holdingUnits, 1395);
  assert.equal(modelUnits, 1395);
  assert.equal(d.meta.claimedUnits, 1395, 'header claim agrees with both tabs');
});

test('the header worker claim exceeds the rows present — a partial extract', async () => {
  const d = await load();
  assert.equal(d.meta.claimedWorkers, 1318);
  assert.ok(d.workers.length < d.meta.claimedWorkers);
});

test('money survives as exact minor units', async () => {
  const d = await load();
  const s21 = d.models.find((m) => m.modelKey === 'antminer-s21+-235th');
  assert.equal(s21.usedUnitPriceMinor, 126900, '$1,269.00');
  assert.equal(s21.freshUnitPriceMinor, 148050, '$1,480.50');
  assert.equal(s21.usedFleetValueMinor, s21.usedUnitPriceMinor * s21.totalUnits);
  assert.equal(s21.efficiencyJPerTh, 16.5, '3877 W / 235 TH');
});

test('unquoted and missing prices stay distinguishable after normalization', async () => {
  const d = await load();
  const notQuoted = d.models.filter((m) => m.usedUnitPriceAvailability === 'NOT_QUOTED');
  const missing = d.holdings.filter((h) => h.usedUnitPriceAvailability === 'MISSING');
  assert.equal(notQuoted.length, 13, '13 models carry the N/Q sentinel for used price');
  assert.equal(missing.length, 31, '31 holding rows have no used price at all');
  for (const m of notQuoted) assert.equal(m.usedUnitPriceMinor, null);
});

test('merged client totals unmerge onto the right client', async () => {
  const d = await load();
  const top = d.clients[0];
  assert.equal(top.clientCode, '144');
  assert.equal(top.units, 263);
  assert.equal(top.statedTotalUnits, 263, 'recomputed total equals the merged cell');
});

test('every model reference resolves; nothing is silently dropped', async () => {
  const d = await load();
  assert.deepEqual(d.unresolvedModelReferences, []);
  assert.equal(d.holdings.filter((h) => !h.modelKey).length, 0);
  assert.equal(d.workers.filter((w) => !w.modelKey).length, 0);
});

test('worker rows carry engine and hosting rate at micro precision', async () => {
  const d = await load();
  const engines = new Set(d.workers.map((w) => w.engine));
  assert.deepEqual([...engines].sort(), ['CLOUD', 'SEGPOOL']);
  const rates = d.workers.map((w) => w.hostingRateMicroUsdPerKwh);
  assert.equal(Math.min(...rates), 50_000, '$0.050/kWh');
  assert.equal(Math.max(...rates), 80_000, '$0.080/kWh');
});

test('validation passes with no contradictions and reports the real gaps', async () => {
  const v = validate(await load());
  assert.equal(v.ok, true);
  assert.equal(v.counts.CRITICAL, 0);

  const by = (id) => v.findings.find((f) => f.id === id);
  assert.equal(by('integrity.units.total').severity, 'INFO');
  assert.equal(by('integrity.units.per_model').severity, 'INFO');
  assert.equal(by('integrity.line_totals').severity, 'INFO');
  assert.equal(by('integrity.client_totals').severity, 'INFO');
  assert.equal(by('integrity.worker_ids').severity, 'INFO');

  const coverage = by('coverage.workers');
  assert.equal(coverage.severity, 'WARNING');
  assert.equal(coverage.present, 225);
  assert.equal(coverage.claimed, 1318);
  assert.equal(coverage.coveragePct, 17.1);

  assert.equal(by('coverage.time').severity, 'WARNING', 'single-date snapshot yields no time series');
});

test('a contradicted dataset fails validation loudly', async () => {
  const d = await load();
  d.holdings[0].units += 1; // inject the exact error the rules exist to catch
  const v = validate(d);
  assert.equal(v.ok, false);
  assert.equal(v.counts.CRITICAL >= 1, true);
  assert.equal(v.findings[0].severity, 'CRITICAL', 'worst finding sorts first');
});
