// Force a re-ingest, bypassing the warm-instance cache.
// Read-only with respect to the source: it re-reads the sheet, never writes.
import { getDataset, summarize } from '../src/dataset.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const dataset = await getDataset({ force: true });
    res.status(200).json({ refreshed: true, ...summarize(dataset), sourceAttempts: dataset.meta.attempts });
  } catch (err) {
    res.status(503).json({ refreshed: false, error: 'ingestion_unavailable', detail: err.message, attempts: err.attempts ?? [] });
  }
}
