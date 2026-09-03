// Observation store with three adapters, one interface.
//
//   memory    Default. Lives only as long as the warm function instance, which
//             is fine for trying the feed out and useless for keeping it. The
//             health endpoint and the events feed both say so in plain words.
//   sheet     A "PriceFeed" tab in the source workbook, written through the same
//             service account the live reader uses (needs the read-write Sheets
//             scope). Opt in with PRICEFEED_STORE=sheet.
//   supabase  Postgres on the Supabase project the storefront already uses,
//             reached through PostgREST. Opt in with PRICEFEED_STORE=supabase,
//             SUPABASE_URL and SUPABASE_SECRET_KEY (a server-only secret key or
//             the legacy service_role key; RLS is on with no policies, so nothing
//             else can read or write these tables). Schema: db/ops_pricefeed.sql.
//
// Interface every adapter honours:
//   append(observations)  -> { added, duplicates }
//   all({ limit })        -> observations, oldest first
//   latest()              -> newest observation per model and basis
//   history()             -> [{ modelKey, modelLabel, basis, points[] }], oldest first
//   getStates()           -> event states the RECOVERY rule compares against
//   putStates(rows)       -> upsert event states
//   deleteStates(ids)     -> drop event states whose recovery window has passed
//
// Money is integer minor units everywhere; the sheet adapter is the only one
// that formats to two decimals on the way out and parses back on the way in.

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

/** Per model and basis, the observed prices in time order - what a sparkline draws. */
export function historySeries(observations) {
  const series = new Map();
  for (const o of [...observations].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))) {
    const k = `${o.modelKey}|${o.basis}`;
    const s = series.get(k) ?? { modelKey: o.modelKey, modelLabel: o.modelLabel, basis: o.basis, points: [] };
    s.points.push({ observedAt: o.observedAt, unitPriceMinor: o.unitPriceMinor, source: o.source ?? null });
    series.set(k, s);
  }
  return [...series.values()].sort((a, b) => a.modelKey.localeCompare(b.modelKey) || a.basis.localeCompare(b.basis));
}

/** In-memory event states, shared by the adapters that have nowhere durable to keep them. */
function memoryStates() {
  const states = new Map();
  return {
    async getStates() { return [...states.values()].map((s) => ({ ...s })); },
    async putStates(rows) { for (const r of rows) states.set(r.id, { ...r }); },
    async deleteStates(ids) { for (const id of ids) states.delete(id); },
  };
}

function memoryStore(requested) {
  const rows = [];
  const keys = new Set();
  return {
    kind: 'memory', durable: false, statesDurable: false, requested,
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
    async history() { return historySeries(rows); },
    ...memoryStates(),
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
    kind: 'sheet', durable: true, statesDurable: false, sheetId, tab: TAB,
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
    async history() { return historySeries((await readAll()).rows); },
    ...memoryStates(),
  };
}

const OBS_TABLE = 'ops_price_observations';
const STATE_TABLE = 'ops_event_states';

function supabaseStore(env, fetchImpl) {
  const url = String(env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const rest = (path) => `${url}/rest/v1/${path}`;

  const toRow = (o, k) => ({
    dedupe_key: k, observed_at: o.observedAt, source: o.source ?? 'unknown', sender: o.sender ?? null, message_id: o.messageId ?? null,
    model_key: o.modelKey, model_label: o.modelLabel, hashrate_th: o.hashrateTh ?? null, unit_price_minor: o.unitPriceMinor,
    currency: o.currency ?? 'USD', basis: o.basis, confidence: o.confidence ?? null, per_th: Boolean(o.perTh), note: o.note ?? null, raw: o.raw ?? null,
  });
  const fromRow = (r) => ({
    observedAt: new Date(r.observed_at).toISOString(), source: r.source, sender: r.sender, messageId: r.message_id,
    modelKey: r.model_key, modelLabel: r.model_label, hashrateTh: r.hashrate_th == null ? null : Number(r.hashrate_th),
    unitPriceMinor: Number(r.unit_price_minor), currency: r.currency, basis: r.basis, confidence: r.confidence,
    perTh: Boolean(r.per_th), note: r.note, raw: r.raw, dedupeKey: r.dedupe_key,
  });
  const stateToRow = (s) => ({ id: s.id, severity: s.severity, title: s.title ?? null, first_seen_at: s.firstSeenAt, last_seen_at: s.lastSeenAt, cleared_at: s.clearedAt ?? null, updated_at: new Date().toISOString() });
  const stateFromRow = (r) => ({ id: r.id, severity: r.severity, title: r.title, firstSeenAt: new Date(r.first_seen_at).toISOString(), lastSeenAt: new Date(r.last_seen_at).toISOString(), clearedAt: r.cleared_at ? new Date(r.cleared_at).toISOString() : null });

  const fail = (what, res) => new Error(`supabase ${what} failed: HTTP ${res.status}`);
  async function get(path) {
    const res = await fetchImpl(rest(path), { headers });
    if (!res.ok) throw fail('read', res);
    return res.json();
  }
  async function readAll(limit = 5000) {
    const rows = await get(`${OBS_TABLE}?select=*&order=observed_at.desc&limit=${limit}`);
    return rows.map(fromRow).reverse();
  }

  return {
    kind: 'supabase', durable: true, statesDurable: true, url,
    async append(observations) {
      const seen = new Set(); const rows = [];
      for (const o of observations) { const k = dedupeKey(o); if (seen.has(k)) continue; seen.add(k); rows.push(toRow(o, k)); }
      if (!rows.length) return { added: 0, duplicates: observations.length };
      // ON CONFLICT DO NOTHING; the representation carries only the rows actually inserted.
      const res = await fetchImpl(rest(`${OBS_TABLE}?on_conflict=dedupe_key`), {
        method: 'POST', headers: { ...headers, prefer: 'return=representation,resolution=ignore-duplicates' }, body: JSON.stringify(rows),
      });
      if (!res.ok) throw fail('insert', res);
      const inserted = await res.json();
      return { added: inserted.length, duplicates: observations.length - inserted.length };
    },
    async all({ limit = 500 } = {}) { return readAll(limit); },
    async latest() { return latestByModel(await readAll()); },
    async history() { return historySeries(await readAll()); },
    async getStates() { return (await get(`${STATE_TABLE}?select=*`)).map(stateFromRow); },
    async putStates(rows) {
      if (!rows.length) return;
      const res = await fetchImpl(rest(`${STATE_TABLE}?on_conflict=id`), {
        method: 'POST', headers: { ...headers, prefer: 'return=minimal,resolution=merge-duplicates' }, body: JSON.stringify(rows.map(stateToRow)),
      });
      if (!res.ok) throw fail('state write', res);
    },
    async deleteStates(ids) {
      if (!ids.length) return;
      const list = ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
      const res = await fetchImpl(rest(`${STATE_TABLE}?id=in.(${encodeURIComponent(list)})`), { method: 'DELETE', headers: { ...headers, prefer: 'return=minimal' } });
      if (!res.ok) throw fail('state delete', res);
    },
  };
}

let memory = null;
export function createStore(env = process.env, { fetchImpl = fetch } = {}) {
  const requested = env.PRICEFEED_STORE || 'memory';
  if (requested === 'sheet') { const s = sheetStore(env, fetchImpl); if (s) return s; }
  if (requested === 'supabase') { const s = supabaseStore(env, fetchImpl); if (s) return s; }
  memory ??= memoryStore(null);
  memory.requested = requested === 'memory' ? null : requested; // what was asked for, so the events feed can say why it fell back
  return memory;
}
