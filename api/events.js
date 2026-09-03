// Operational events: the severity-classified view of "what needs attention".
// This is the contract later milestones consume (mascot state, alerts).
import { getDataset } from '../src/dataset.js';
import { createStore } from '../src/pricefeed/store.js';
import { enrichWithQuotes } from '../src/pricefeed/compare.js';
import { evaluateEvents } from '../src/events/rules.js';

export default async function handler(req, res) {
  try {
    const dataset = await getDataset();
    const store = createStore();
    let latest = [];
    try { latest = enrichWithQuotes(await store.latest(), dataset.models); } catch { latest = []; }
    res.status(200).json(evaluateEvents({ dataset, latest, store: { kind: store.kind, durable: store.durable } }));
  } catch (err) {
    res.status(503).json({ error: 'events_unavailable', detail: err.message });
  }
}
