import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkbook } from '../src/ingest/sheets.js';
import { parseCsv } from '../src/ingest/csv.js';

test('csv reader handles quotes, escaped quotes and embedded commas', () => {
  const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'he said "hi"']]);
});

test('fixture connector returns the three tabs without credentials', async () => {
  const wb = await fetchWorkbook({ env: { INGEST_SOURCES: 'fixture' } });
  assert.equal(wb.source, 'fixture');
  assert.equal(wb.tabs.length, 3);
  assert.deepEqual(wb.attempts, [{ source: 'fixture', ok: true }]);
});

test('connectors are tried in order and each failure is reported', async () => {
  const wb = await fetchWorkbook({
    env: { INGEST_SOURCES: 'service_account,public_csv,fixture' }, // no credential set
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '<html>' }),
  });
  assert.equal(wb.source, 'fixture', 'falls through to the snapshot');
  assert.deepEqual(wb.attempts.map((a) => [a.source, a.ok]),
    [['service_account', false], ['public_csv', false], ['fixture', true]]);
  assert.match(wb.attempts[0].reason, /not configured/);
  assert.match(wb.attempts[1].reason, /401/);
});

test('the service-account path is preferred once a credential exists', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    if (String(url).includes('?fields=')) {
      return { ok: true, json: async () => ({ properties: { title: 'X' }, sheets: [{ properties: { title: 'Tab1' } }] }) };
    }
    return { ok: true, json: async () => ({ valueRanges: [{ values: [['a']] }] }) };
  };
  // A throwaway key generated for this test only; never a real credential.
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wb = await fetchWorkbook({
    env: {
      INGEST_SOURCES: 'service_account,fixture',
      GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
        client_email: 'svc@example.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    },
    fetchImpl,
  });
  assert.equal(wb.source, 'service_account');
  assert.deepEqual(wb.tabs, [{ name: 'Tab1', rows: [['a']] }]);
  assert.ok(calls.some((u) => u.includes('spreadsheets.readonly') === false)); // scope travels in the JWT, not the URL
});

test('an unusable workbook is rejected rather than half-parsed', async () => {
  const { normalizeWorkbook } = await import('../src/normalize/pipeline.js');
  assert.throws(
    () => normalizeWorkbook({ tabs: [{ name: 'nope', rows: [['unrelated']] }] }),
    /unrecognised workbook/,
  );
});
