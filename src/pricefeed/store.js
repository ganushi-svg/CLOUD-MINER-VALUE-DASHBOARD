// Observation store with two adapters.
//
//   memory  Default. Lives only as long as the warm function instance, which
//           is fine for trying the feed out and useless for keeping it. The
//           health endpoint says so in plain words.
//   sheet   A "PriceFeed" tab in the source workbook, written through the same
//           service account the live reader uses (needs the read-write Sheets
//           scope). Observations then sit next to the supplier quotes the
//           analysts already maintain. Opt in with PRICEFEED_STORE=sheet.
//
// Milestone 2's database replaces both; the interface is the contract.

import { serviceAccount, accessToken, DEFAULT_SHEET_ID } from '../ingest/sheets.js';

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TAB = 'PriceFeed';
const COLUMNS = ['observedAt', 'source', 'sender', 'messageId', 'modelKey', 'modelLabel', 'hashrateTh',
  'unitPriceUsd', 'basis', 'confidence', 'perTh', 'note', 'raw', 'dedupeKey'];

/** One observation per (source, day, model, price, basis). */
export function dedupeKey(o) {
  return [o.source ?? '', String(o.observedAt ?? '').slice(0, 10), o.modelKey, o.unitPriceMinor, o.basis].join('|');
}

/** Most recent observation per model and basis. */
export function latestByModel(observations) {
  const latest = new Map();
  for (const o of observations) {
    const k = `${o.modelKey}|${o.basis}`;
    const prev = latest.get(k);
    if (!prev || o.observedAt > prev.observedAt) latest.set(k, o);
  }
  return [...latest.values()].sort((a, b) => a.modelKey.localeCompare(b.modelKey) || a.basis.localeCompare(b.basis));
}

function memoryStore() {
  const rows = [];
  const keys = new Set();
  return {
    kind: 'memory', durable: false,
    async append(observations) {
      let added = 0, duplicates = 0;
      for (const o of observations) {
        const k = dedupeKey(o);
        if (keys.has(k)) { duplicates++; continue; }
        keys.add(k); rows.push({ ...o, dedupeKey: k }); added++;
      }
      return { added, duplicates };
    },
    async all({ limit = 500 } = {}) { return rows.slice(-limit); },
    async latest() { return latestByModel(rows); },
  };
}

function sheetStore(env, fetchImpl) {
  const sa = serviceAccount(env);
  if (!sa) return null;
  const sheetId = env.PRICEFEED_SHEET_ID || env.SHEET_ID || DEFAULT_SHEET_ID;
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = async () => ({ authorization: `Bearer ${await accessToken(sa, fetchImpl, WRITE_SCOPE)}`, 'content-type': 'application/json' });

  const toRow = (o, k) => [o.observedAt, o.source, o.sender, o.messageId, o.modelKey, o.modelLabel, o.hashrateTh,
    (o.unitPriceMinor / 100).toFixed(2), o.basis, o.confidence, o.perTh ? 'TRUE' : 'FALSE', o.note ?? '', o.raw, k];
  const fromRow = (r) => ({
    observedAt: r[0], source: r[1], sender: r[2], messageId: r[3], modelKey: r[4], modelLabel: r[5],
    hashrateTh: Number(r[6]) || null, unitPriceMinor: Math.round(Number(r[7]) * 100), currency: 'USD',
    basis: r[8], confidence: r[9], perTh: r[10] === 'TRUE', note: r[11] || null, raw: r[12], dedupeKey: r[13],
  });

  async function readAll() {
    const res = await fetchImpl(`${base}/${encodeURIComponent(`${TAB}!A1:N`)}`, { headers: await auth() });
    if (res.status === 400) return { header: false, rows: [] }; // tab does not exist yet
    if (!res.ok) throw new Error(`sheet read failed: HTTP ${res.status}`);
    const { values = [] } = await res.json();
    const header = values[0]?.[0] === COLUMNS[0];
    return { header, rows: (header ? values.slice(1) : values).filter((r) => r.length >= 5).map(fromRow) };
  }

  return {
    kind: 'sheet', durable: true, sheetId, tab: TAB,
    async append(observations) {
      const { header, rows } = await readAll();
      const keys = new Set(rows.map((r) => r.dedupeKey));
      const fresh = [];
      let duplicates = 0;
      for (const o of observations) {
        const k = dedupeKey(o);
        if (keys.has(k)) { duplicates++; continue; }
        keys.add(k); fresh.push(toRow(o, k));
      }
      if (!fresh.length) return { added: 0, duplicates };
      const values = header ? fresh : [COLUMNS, ...fresh];
      const res = await fetchImpl(`${base}/${encodeURIComponent(`${TAB}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', headers: await auth(), body: JSON.stringify({ values }) });
      if (!res.ok) throw new Error(`sheet append failed: HTTP ${res.status}`);
      return { added: fresh.length, duplicates };
    },
    async all({ limit = 500 } = {}) { return (await readAll()).rows.slice(-limit); },
    async latest() { return latestByModel((await readAll()).rows); },
  };
}

let memory = null;
export function createStore(env = process.env, { fetchImpl = fetch } = {}) {
  if ((env.PRICEFEED_STORE || 'memory') === 'sheet') {
    const s = sheetStore(env, fetchImpl);
    if (s) return s;
  }
  memory ??= memoryStore();
  return memory;
}
