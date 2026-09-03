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

test('historySeries groups by model and basis, oldest first', async () => {
  const { historySeries } = await import('../src/pricefeed/store.js');
  const h = historySeries([obs({ observedAt: '2026-09-03T08:00:00Z', unitPriceMinor: 132000 }), obs(), obs({ basis: 'FRESH' })]);
  assert.equal(h.length, 2);
  const used = h.find((x) => x.basis === 'USED');
  assert.deepEqual(used.points.map((p) => p.unitPriceMinor), [126900, 132000]);
  assert.equal(used.points[0].observedAt, '2026-09-02T08:00:00Z');
});

test('supabase store inserts with ignore-duplicates, reads oldest-first, upserts and deletes states', async () => {
  const calls = [];
  const table = new Map(); // dedupe_key -> row
  const states = new Map();
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const method = init.method ?? 'GET';
    calls.push([method, u.pathname + u.search, init.headers]);
    assert.equal(init.headers.apikey, 'secret'); assert.equal(init.headers.authorization, 'Bearer secret');
    if (u.pathname.endsWith('/ops_price_observations')) {
      if (method === 'POST') {
        assert.equal(u.searchParams.get('on_conflict'), 'dedupe_key');
        assert.match(init.headers.prefer, /resolution=ignore-duplicates/);
        const inserted = [];
        for (const r of JSON.parse(init.body)) { if (!table.has(r.dedupe_key)) { table.set(r.dedupe_key, r); inserted.push(r); } }
        return { ok: true, status: 201, json: async () => inserted };
      }
      assert.equal(u.searchParams.get('order'), 'observed_at.desc');
      const rows = [...table.values()].sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1)).slice(0, Number(u.searchParams.get('limit')));
      return { ok: true, status: 200, json: async () => rows };
    }
    if (u.pathname.endsWith('/ops_event_states')) {
      if (method === 'POST') { assert.match(init.headers.prefer, /merge-duplicates/); for (const r of JSON.parse(init.body)) states.set(r.id, r); return { ok: true, status: 201, json: async () => [] }; }
      if (method === 'DELETE') { const list = decodeURIComponent(u.search).match(/in\.\((.*)\)/)[1]; for (const id of list.split(',').map((x) => x.replace(/"/g, ''))) states.delete(id); return { ok: true, status: 204, json: async () => null }; }
      return { ok: true, status: 200, json: async () => [...states.values()] };
    }
    throw new Error('unexpected ' + url);
  };
  const store = createStore({ PRICEFEED_STORE: 'supabase', SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SECRET_KEY: 'secret' }, { fetchImpl });
  assert.equal(store.kind, 'supabase'); assert.equal(store.durable, true); assert.equal(store.statesDurable, true);
  assert.deepEqual(await store.append([obs(), obs({ messageId: 'b' })]), { added: 1, duplicates: 1 }, 'in-batch duplicate never leaves the process');
  assert.deepEqual(await store.append([obs(), obs({ observedAt: '2026-09-03T08:00:00Z', unitPriceMinor: 125000 })]), { added: 1, duplicates: 1 }, 'table duplicate counted from the representation');
  const all = await store.all();
  assert.deepEqual(all.map((o) => o.unitPriceMinor), [126900, 125000], 'oldest first, money exact');
  assert.equal(all[0].dedupeKey, dedupeKey(obs()));
  assert.equal((await store.latest())[0].unitPriceMinor, 125000);
  assert.equal((await store.history())[0].points.length, 2);
  await store.putStates([{ id: 'price.delta:antminer-s21+-235th:USED', severity: 'WARNING', title: 't', firstSeenAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-09-02T00:00:00Z', clearedAt: null }]);
  assert.equal((await store.getStates())[0].id, 'price.delta:antminer-s21+-235th:USED');
  await store.deleteStates(['price.delta:antminer-s21+-235th:USED']);
  assert.deepEqual(await store.getStates(), []);
  assert.ok(calls.some(([m, p]) => m === 'DELETE' && p.includes('%2B')), 'plus sign in an id is percent-encoded, not turned into a space');
});

test('a requested store without credentials falls back to memory and says which store was asked for', () => {
  const store = createStore({ PRICEFEED_STORE: 'supabase' });
  assert.equal(store.kind, 'memory');
  assert.equal(store.requested, 'supabase');
});
