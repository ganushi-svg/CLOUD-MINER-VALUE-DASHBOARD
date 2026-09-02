// Data-source connectors for the Client_Miner_Model_Summary_FULL workbook.
//
// Three connectors are tried in the order given by INGEST_SOURCES:
//
//   service_account  Google Sheets API v4 with a service-account JWT. The
//                    intended production path: read-only scope, credential
//                    supplied by environment variable, sheet shared to the
//                    service account as Viewer.
//   public_csv       The per-tab CSV export, usable only if the sheet is
//                    shared "anyone with the link". As of capture the sheet is
//                    private and this path returns 401, so it stays in the
//                    chain as an option rather than a dependency.
//   fixture          A verbatim snapshot committed under data/fixtures. Keeps
//                    the service deployable and the tests hermetic with no
//                    credentials at all.
//
// Every connector returns the same shape — raw cell strings, one array per tab
// — so the normalizer downstream cannot tell which one produced its input.
// Swapping the data source is configuration, not a code change.

import crypto from 'node:crypto';
import { parseCsv } from './csv.js';
import { snapshot } from '../../data/fixtures/snapshot.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const DEFAULT_SHEET_ID = '1XySY4bTYTU0XYjndcRlKyBcXLH8n9FiGQtet-iYTRU4';

export function serviceAccount(env) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    sa.private_key = sa.private_key.replace(/\\n/g, '\n'); // env-escaped newlines
    return sa;
  } catch {
    return null; // never log the value — it is a private key
  }
}

const tokenCache = {}; // per scope

export async function accessToken(sa, fetchImpl, scope = SCOPE) {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache[scope];
  if (cached && now < cached.expiresAt - 60) return cached.value;

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(sa.private_key)
    .toString('base64url');

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const json = await res.json();
  tokenCache[scope] = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
  return tokenCache[scope].value;
}

async function fromServiceAccount({ sheetId, env, fetchImpl }) {
  const sa = serviceAccount(env);
  if (!sa) return null;

  const token = await accessToken(sa, fetchImpl);
  const auth = { authorization: `Bearer ${token}` };

  const metaRes = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.title,sheets.properties.title`,
    { headers: auth },
  );
  if (!metaRes.ok) throw new Error(`sheets metadata failed: HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const titles = meta.sheets.map((s) => s.properties.title);

  const ranges = titles.map((t) => `ranges=${encodeURIComponent(`'${t}'`)}`).join('&');
  const valuesRes = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${ranges}&majorDimension=ROWS`,
    { headers: auth },
  );
  if (!valuesRes.ok) throw new Error(`sheets values failed: HTTP ${valuesRes.status}`);
  const { valueRanges } = await valuesRes.json();

  return {
    source: 'service_account',
    title: meta.properties?.title ?? null,
    capturedAt: new Date().toISOString(),
    tabs: titles.map((name, i) => ({ name, rows: valueRanges[i]?.values ?? [] })),
  };
}

async function fromPublicCsv({ sheetId, gids, fetchImpl }) {
  const tabs = [];
  for (const [index, gid] of gids.entries()) {
    const res = await fetchImpl(
      `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
      { redirect: 'follow' },
    );
    if (!res.ok) throw new Error(`csv export gid=${gid} failed: HTTP ${res.status}`);
    const text = await res.text();
    // A sign-in interstitial is HTML, not CSV — treat it as "not shared".
    if (text.trimStart().startsWith('<')) throw new Error('sheet is not link-shared');
    tabs.push({ name: `gid:${gid}`, rows: parseCsv(text), index });
  }
  return { source: 'public_csv', title: null, capturedAt: new Date().toISOString(), tabs };
}

async function fromFixture() {
  return {
    source: 'fixture',
    title: snapshot.source?.title ?? null,
    capturedAt: snapshot.source?.capturedAt ?? null,
    tabs: snapshot.tabs,
  };
}

/**
 * Try each configured connector in order; return the first that yields tabs.
 * Failures are collected and reported so an operator can see *why* the service
 * fell back to a snapshot instead of silently serving stale data.
 */
export async function fetchWorkbook({
  env = process.env,
  fetchImpl = fetch,
  sheetId = env.SHEET_ID || DEFAULT_SHEET_ID,
  gids = [0, 1, 2],
} = {}) {
  const order = (env.INGEST_SOURCES || 'service_account,public_csv,fixture')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const attempts = [];
  for (const name of order) {
    try {
      let result = null;
      if (name === 'service_account') result = await fromServiceAccount({ sheetId, env, fetchImpl });
      else if (name === 'public_csv') result = await fromPublicCsv({ sheetId, gids, fetchImpl });
      else if (name === 'fixture') result = await fromFixture();
      else { attempts.push({ source: name, ok: false, reason: 'unknown connector' }); continue; }

      if (!result) { attempts.push({ source: name, ok: false, reason: 'not configured' }); continue; }
      attempts.push({ source: name, ok: true });
      return { ...result, sheetId, attempts };
    } catch (err) {
      attempts.push({ source: name, ok: false, reason: err.message });
    }
  }
  throw Object.assign(new Error('no ingestion source available'), { attempts });
}
