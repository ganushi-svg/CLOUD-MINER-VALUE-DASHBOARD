import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, latestByModel, createStore } from '../src/pricefeed/store.js';
import { verifySignature } from '../api/whatsapp.js';
import crypto from 'node:crypto';

const obs = (over = {}) => ({ modelKey: 'antminer-s21+-235th', modelLabel: 'S21+', hashrateTh: 235, unitPriceMinor: 126900,
  currency: 'USD', basis: 'USED', confidence: 'HIGH', perTh: false, note: null, source: 'test', sender: '+1',
  observedAt: '2026-09-02T08:00:00Z', messageId: 'a', raw: 'S21+ 235T $1269', ...over });

test('memory store dedupes by source, day, model, price and basis', async () => {
  const store = createStore({ PRICEFEED_STORE: 'memory' });
  const first = await store.append([obs(), obs({ messageId: 'b' })]);
  assert.deepEqual(first, { added: 1, duplicates: 1 });
  const again = await store.append([obs({ observedAt: '2026-09-03T08:00:00Z' })]);
  assert.deepEqual(again, { added: 1, duplicates: 0 }, 'a new day is a new observation');
  assert.equal(store.durable, false);
});

test('latestByModel keeps the newest per model and basis', () => {
  const rows = [obs(), obs({ observedAt: '2026-09-03T08:00:00Z', unitPriceMinor: 125000 }), obs({ basis: 'FRESH', unitPriceMinor: 148050 })];
  const latest = latestByModel(rows);
  assert.equal(latest.length, 2);
  assert.equal(latest.find((r) => r.basis === 'USED').unitPriceMinor, 125000);
});

test('sheet store writes a header on first use, appends rows, dedupes against the tab', async () => {
  const calls = [];
  const { generateKeyPairSync } = crypto;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let sheetRows = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init.method ?? 'GET']);
    if (String(url).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    if ((init.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ values: sheetRows }) };
    const body = JSON.parse(init.body); sheetRows = sheetRows.concat(body.values); return { ok: true, status: 200, json: async () => ({}) };
  };
  const env = { PRICEFEED_STORE: 'sheet', GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'svc@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
  const store = createStore(env, { fetchImpl });
  assert.equal(store.kind, 'sheet'); assert.equal(store.durable, true);

  assert.deepEqual(await store.append([obs()]), { added: 1, duplicates: 0 });
  assert.equal(sheetRows[0][0], 'observedAt', 'header written first');
  assert.equal(sheetRows.length, 2);
  assert.deepEqual(await store.append([obs(), obs({ basis: 'FRESH' })]), { added: 1, duplicates: 1 });
  assert.equal(sheetRows.length, 3);
  const all = await store.all();
  assert.equal(all.length, 2);
  assert.equal(all[0].unitPriceMinor, 126900, 'money round-trips through the sheet exactly');
  assert.equal(all[0].dedupeKey, dedupeKey(obs()));
  assert.ok(calls.some(([u]) => u.includes('scope') === false), 'scope travels in the JWT');
});

test('webhook signature verification is exact and constant-time shaped', () => {
  const secret = 'app-secret', body = '{"object":"whatsapp_business_account"}';
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifySignature(body, good, secret), true);
  assert.equal(verifySignature(body + ' ', good, secret), false, 'one byte off fails');
  assert.equal(verifySignature(body, good.replace('sha256=', 'sha1='), secret), false);
  assert.equal(verifySignature(body, '', secret), false);
});
