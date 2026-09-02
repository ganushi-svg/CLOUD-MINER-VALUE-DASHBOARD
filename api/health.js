// Liveness + ingestion status. Cheap enough to poll.
import { getDataset, summarize } from '../src/dataset.js';

export default async function handler(req, res) {
  try {
    const dataset = await getDataset();
    const summary = summarize(dataset);
    res.status(dataset.validation.ok ? 200 : 503).json({
      ok: dataset.validation.ok,
      milestone: 1,
      service: 'segments-cloud-ops-center/ingestion',
      ...summary,
      sourceAttempts: dataset.meta.attempts,
      cache: dataset.cache,
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'ingestion_unavailable', detail: err.message, attempts: err.attempts ?? [] });
  }
}
