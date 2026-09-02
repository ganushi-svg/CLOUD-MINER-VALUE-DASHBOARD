#!/usr/bin/env node
// CLI: run the Milestone 1 pipeline and print the normalization report.
// Usage: node scripts/ingest.mjs [--json] [--out <file>]
import { writeFile } from 'node:fs/promises';
import { buildDataset, summarize } from '../src/dataset.js';
import { formatMinorUnits } from '../src/normalize/coerce.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const outIdx = args.indexOf('--out');

const dataset = await buildDataset();
const summary = summarize(dataset);

if (outIdx !== -1 && args[outIdx + 1]) {
  await writeFile(args[outIdx + 1], JSON.stringify(dataset, null, 2));
  console.error(`wrote ${args[outIdx + 1]}`);
}

if (asJson) {
  console.log(JSON.stringify({ summary, validation: dataset.validation }, null, 2));
} else {
  const { counts, fleet } = summary;
  console.log(`\nSegments Cloud - Milestone 1 ingestion report`);
  console.log(`source=${summary.source}  reportDate=${summary.reportDate}  captured=${summary.capturedAt}`);
  console.log(`\n  models ${counts.models}   clients ${counts.clients}   holdings ${counts.holdings}   workers ${counts.workers}`);
  console.log(`  fleet  ${fleet.units.toLocaleString()} units   ${fleet.hashrateTh.toLocaleString()} TH/s   ${fleet.powerKw.toLocaleString()} kW`);
  const usd = (minor) => Number(formatMinorUnits(minor)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  console.log(`  value  used $${usd(fleet.usedValueMinor)}   fresh $${usd(fleet.freshValueMinor)}`);
  console.log(`\nValidation: ${dataset.validation.ok ? 'PASS' : 'FAIL'}  ` +
    `(${dataset.validation.counts.CRITICAL} critical, ${dataset.validation.counts.WARNING} warning, ${dataset.validation.counts.INFO} info)\n`);
  for (const f of dataset.validation.findings) {
    console.log(`  [${f.severity.padEnd(8)}] ${f.id.padEnd(30)} ${f.summary}`);
  }
  console.log();
}
process.exit(dataset.validation.ok ? 0 : 1);
