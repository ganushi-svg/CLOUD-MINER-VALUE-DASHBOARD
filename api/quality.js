// Data-quality report on its own route: the findings, without the rows.
// This is the contract later milestones consume for event detection.
import { getDataset } from '../src/dataset.js';

export default async function handler(req, res) {
  try {
    const dataset = await getDataset({ force: req.query?.refresh === '1' });
    res.status(200).json({
      reportDate: dataset.meta.reportDate,
      source: dataset.meta.source,
      capturedAt: dataset.meta.capturedAt,
      normalizedAt: dataset.meta.normalizedAt,
      ...dataset.validation,
    });
  } catch (err) {
    res.status(503).json({ error: 'ingestion_unavailable', detail: err.message, attempts: err.attempts ?? [] });
  }
}
