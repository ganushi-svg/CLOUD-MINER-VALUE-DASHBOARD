// The normalized dataset. `?section=` trims the payload for callers that only
// need one slice; later milestones read this instead of touching the sheet.
import { getDataset, summarize } from '../src/dataset.js';

const SECTIONS = new Set(['models', 'clients', 'holdings', 'workers', 'summary', 'all']);

export default async function handler(req, res) {
  const section = String(req.query?.section ?? 'all').toLowerCase();
  if (!SECTIONS.has(section)) {
    return res.status(400).json({ error: 'invalid_section', allowed: [...SECTIONS] });
  }
  try {
    const dataset = await getDataset({ force: req.query?.refresh === '1' });
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
