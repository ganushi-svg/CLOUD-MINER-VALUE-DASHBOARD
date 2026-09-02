#!/usr/bin/env node
// Regenerate data/fixtures/snapshot.js from the live sheet.
// Requires a working live connector: set GOOGLE_SERVICE_ACCOUNT (see .env.example).
// Refuses to overwrite the snapshot from the snapshot itself.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchWorkbook, DEFAULT_SHEET_ID } from '../src/ingest/sheets.js';
import { normalizeWorkbook } from '../src/normalize/pipeline.js';
import { validate } from '../src/validate/rules.js';

let workbook;
try {
  workbook = await fetchWorkbook({ env: { ...process.env, INGEST_SOURCES: 'service_account,public_csv' } });
} catch (err) {
  console.error('no live connector available; the snapshot was left untouched.');
  for (const a of err.attempts ?? []) console.error(`  ${a.source}: ${a.reason}`);
  console.error('\nSet GOOGLE_SERVICE_ACCOUNT and share the sheet with its client_email as Viewer.');
  process.exit(2);
}

// Never freeze a broken capture into the repository.
const validation = validate(normalizeWorkbook(workbook));
if (!validation.ok) {
  console.error(`live workbook has ${validation.counts.CRITICAL} critical finding(s); not captured`);
  for (const f of validation.findings.filter((x) => x.severity === 'CRITICAL')) console.error(`  ${f.id}: ${f.summary}`);
  process.exit(1);
}

const payload = {
  source: {
    spreadsheetId: workbook.sheetId ?? DEFAULT_SHEET_ID,
    title: workbook.title,
    capturedAt: workbook.capturedAt,
    connector: workbook.source,
    note: 'Verbatim capture. Rows are raw cell strings; normalization happens in src/normalize.',
  },
  tabs: workbook.tabs.map(({ name, rows }) => ({ name, rows })),
};

const header = `// Verbatim snapshot of Client_Miner_Model_Summary_FULL, captured ${payload.source.capturedAt}
// via the ${workbook.source} connector. Rows are raw cell strings; all typing and
// cleaning happens in src/normalize.
//
// Shipped as a module rather than a JSON file read from disk so that the
// serverless bundler follows it as a normal import — a file read at runtime is
// invisible to dependency tracing and would be missing from the deployed function.
//
// Regenerate with: node scripts/capture-fixture.mjs (requires sheet access).

`;
const out = fileURLToPath(new URL('../data/fixtures/snapshot.js', import.meta.url));
await writeFile(out, `${header}export const snapshot = ${JSON.stringify(payload, null, 1)};\n`);
console.log(`captured ${payload.tabs.length} tabs from ${workbook.source} -> ${out}`);
