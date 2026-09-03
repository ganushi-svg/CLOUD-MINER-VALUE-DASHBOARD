// The normalized dataset. `?section=` trims the payload for callers that only
// need one slice; later milestones read this instead of touching the sheet.
import { getDataset, summarize } from '../src/dataset.js';
import { formatMinorUnits } from '../src/normalize/coerce.js';

const CSV_SECTIONS = new Set(['models', 'clients', 'holdings', 'workers']);
/** Flat rows -> CSV. Minor-unit money becomes decimal dollars for spreadsheet readers. */
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]).map((k) => (k.endsWith('Minor') ? k.replace(/Minor$/, 'Usd') : k));
  const cell = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(Object.entries(r).map(([k, v]) => cell(k.endsWith('Minor') && v != null ? formatMinorUnits(v, { scale: k.includes('Micro') ? 6 : 2 }) : typeof v === 'object' ? JSON.stringify(v) : v)).join(','));
  }
  return lines.join('\n') + '\n';
}

const SECTIONS = new Set(['models', 'clients', 'holdings', 'workers', 'summary', 'all']);

export default async function handler(req, res) {
  const section = String(req.query?.section ?? 'all').toLowerCase();
  if (!SECTIONS.has(section)) {
    return res.status(400).json({ error: 'invalid_section', allowed: [...SECTIONS] });
  }
  try {
    const dataset = await getDataset({ force: req.query?.refresh === '1' });
    if (String(req.query?.format ?? '').toLowerCase() === 'csv') {
      if (!CSV_SECTIONS.has(section)) return res.status(400).json({ error: 'csv_section_required', allowed: [...CSV_SECTIONS] });
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${section}-${dataset.meta.reportDate ?? 'snapshot'}.csv"`);
      return res.status(200).send(toCsv(dataset[section]));
    }
    const base = { meta: dataset.meta, validation: dataset.validation };
    if (section === 'summary') return res.status(200).json({ ...base, summary: summarize(dataset) });
    if (section === 'all') {
      return res.status(200).json({
        ...base,
        summary: summarize(dataset),
        models: dataset.models,
        clients: dataset.clients,
        holdings: dataset.holdings,
        workers: dataset.workers,
        unresolvedModelReferences: dataset.unresolvedModelReferences,
      });
    }
    return res.status(200).json({ ...base, [section]: dataset[section] });
  } catch (err) {
    res.status(503).json({ error: 'ingestion_unavailable', detail: err.message, attempts: err.attempts ?? [] });
  }
}
