// Operational events: the severity-classified view of "what needs attention".
// This is the contract later milestones consume (mascot state, alerts).
//
// The one stateful step: alerting event ids are remembered in the price-feed
// store between runs so a cleared WARNING/CRITICAL surfaces as RECOVERY.
import { getDataset } from '../src/dataset.js';
import { createStore } from '../src/pricefeed/store.js';
import { enrichWithQuotes } from '../src/pricefeed/compare.js';
import { evaluateEvents } from '../src/events/rules.js';

export default async function handler(req, res) {
  try {
    const dataset = await getDataset();
    const store = createStore();
    let latest = [], prevStates = [];
    try { latest = enrichWithQuotes(await store.latest(), dataset.models); } catch { latest = []; }
    try { prevStates = (await store.getStates?.()) ?? []; } catch { prevStates = []; }
    const { states, ...feed } = evaluateEvents({
      dataset, latest, prevStates,
      store: { kind: store.kind, durable: store.durable, requested: store.requested ?? null },
    });
    let remembered = false;
    try {
      const keep = new Set(states.map((s) => s.id));
      const drop = prevStates.filter((s) => !keep.has(s.id)).map((s) => s.id);
      await store.putStates?.(states);
      if (drop.length) await store.deleteStates?.(drop);
      remembered = true;
    } catch { remembered = false; }
    res.status(200).json({ ...feed, stateStore: { kind: store.kind, durable: Boolean(store.statesDurable), remembered } });
  } catch (err) {
    res.status(503).json({ error: 'events_unavailable', detail: err.message });
  }
}
