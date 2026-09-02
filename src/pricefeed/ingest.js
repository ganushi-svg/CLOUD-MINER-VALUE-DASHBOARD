// Text in, observations stored, report out. Shared by the WhatsApp webhook and
// the manual /api/pricefeed POST so both paths behave identically.
import { getDataset } from '../dataset.js';
import { buildResolver, parsePriceList } from './parse.js';
import { createStore } from './store.js';

let resolverCache = { at: 0, resolve: null };

async function resolver(env) {
  if (resolverCache.resolve && Date.now() - resolverCache.at < 300_000) return resolverCache.resolve;
  const dataset = await getDataset({ env });
  resolverCache = { at: Date.now(), resolve: buildResolver(dataset.models) };
  return resolverCache.resolve;
}

export async function ingestText({ text, source, sender, observedAt, messageId }, { env = process.env, fetchImpl = fetch } = {}) {
  const resolve = await resolver(env);
  const { observations, unresolved } = parsePriceList(text, { source, sender, observedAt, messageId }, resolve);
  const store = createStore(env, { fetchImpl });
  const { added, duplicates } = observations.length ? await store.append(observations) : { added: 0, duplicates: 0 };
  return {
    store: { kind: store.kind, durable: store.durable },
    parsed: observations.length, added, duplicates,
    observations, unresolved,
  };
}
