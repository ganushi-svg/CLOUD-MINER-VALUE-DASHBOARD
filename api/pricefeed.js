// Price feed: read observed supplier prices, or ingest a price list by hand.
//
// GET  /api/pricefeed?view=latest|all   (all adds every observation and the per-model history series)
// POST /api/pricefeed   { text, source?, sender?, observedAt? }
//      Authorization: Bearer <PRICEFEED_INGEST_SECRET>
//
// The POST path is how a price list reaches the feed without WhatsApp: paste,
// forward-by-email automation, or a test. It runs the exact code the webhook runs.
import { createStore } from '../src/pricefeed/store.js';
import { ingestText } from '../src/pricefeed/ingest.js';
import { getDataset } from '../src/dataset.js';
import { enrichWithQuotes, markToMarket } from '../src/pricefeed/compare.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const store = createStore();
      const view = String(req.query?.view ?? 'latest');
      const wantAll = view === 'all' || view === 'history';
      const [latest, all, history, dataset] = await Promise.all([store.latest(), wantAll ? store.all() : [], wantAll ? store.history() : [], getDataset()]);
      const enrichedLatest = enrichWithQuotes(latest, dataset.models);
      return res.status(200).json({
        store: { kind: store.kind, durable: store.durable, requested: store.requested ?? null },
        latest: enrichedLatest,
        observations: enrichWithQuotes(all, dataset.models),
        history,
        markToMarket: enrichedLatest.length ? markToMarket(enrichedLatest, dataset) : null,
        generatedAt: new Date().toISOString(),
      });
    }
    if (req.method === 'POST') {
      const secret = process.env.PRICEFEED_INGEST_SECRET;
      if (!secret) return res.status(503).json({ error: 'ingest_disabled', detail: 'PRICEFEED_INGEST_SECRET is not set' });
      const given = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (given.length !== secret.length || !timingSafeEqualStr(given, secret)) return res.status(401).json({ error: 'unauthorized' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
      if (!body.text || typeof body.text !== 'string') return res.status(400).json({ error: 'bad_request', detail: 'text (string) is required' });
      const report = await ingestText({
        text: body.text.slice(0, 20_000),
        source: String(body.source ?? 'manual').slice(0, 80),
        sender: body.sender ? String(body.sender).slice(0, 80) : null,
        observedAt: body.observedAt ?? new Date().toISOString(),
        messageId: body.messageId ?? null,
      });
      return res.status(200).json(report);
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'pricefeed_error', detail: err.message });
  }
}

function timingSafeEqualStr(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
