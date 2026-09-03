import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEvents, reconcileStates, EventSeverity, RECOVERY_WINDOW_MS } from '../src/events/rules.js';
import { getDataset } from '../src/dataset.js';

const ev = (id, severity, title = id) => ({ id, severity, title, detail: '', source: 'test' });

test('reconcileStates remembers alerting ids and keeps their first-seen time', () => {
  const t1 = new Date('2026-09-01T00:00:00Z'), t2 = new Date('2026-09-02T00:00:00Z');
  const run1 = reconcileStates([ev('a', 'WARNING'), ev('b', 'NORMAL')], [], t1);
  assert.deepEqual(run1.recoveries, []);
  assert.equal(run1.states.length, 1);
  assert.equal(run1.states[0].firstSeenAt, t1.toISOString());
  const run2 = reconcileStates([ev('a', 'CRITICAL')], run1.states, t2);
  assert.equal(run2.states[0].severity, 'CRITICAL');
  assert.equal(run2.states[0].firstSeenAt, t1.toISOString(), 'escalation keeps the original first-seen time');
  assert.equal(run2.states[0].lastSeenAt, t2.toISOString());
});

test('a cleared or vanished alert becomes RECOVERY for 24 hours, then is forgotten', () => {
  const t1 = new Date('2026-09-01T00:00:00Z'), t2 = new Date('2026-09-02T00:00:00Z');
  const { states } = reconcileStates([ev('price.delta:x', 'WARNING', 'X drifted'), ev('data.staleness', 'CRITICAL', 'Stale')], [], t1);
  // x vanished entirely, staleness is calm again
  const r = reconcileStates([ev('data.staleness', 'NORMAL', 'Fresh')], states, t2);
  assert.equal(r.recoveries.length, 2);
  const ids = r.recoveries.map((e) => e.id).sort();
  assert.deepEqual(ids, ['recovery:data.staleness', 'recovery:price.delta:x']);
  assert.ok(r.recoveries.every((e) => e.severity === EventSeverity.RECOVERY && e.title.startsWith('Cleared: ')));
  assert.ok(r.states.every((s) => s.clearedAt === t2.toISOString()), 'cleared states stay for the window');
  // still inside the window: still reported, clearedAt unchanged
  const t3 = new Date(t2.getTime() + RECOVERY_WINDOW_MS - 60_000);
  const r2 = reconcileStates([ev('data.staleness', 'NORMAL')], r.states, t3);
  assert.equal(r2.recoveries.length, 2);
  assert.equal(r2.states[0].clearedAt, t2.toISOString());
  // past the window: gone
  const t4 = new Date(t2.getTime() + RECOVERY_WINDOW_MS + 60_000);
  const r3 = reconcileStates([ev('data.staleness', 'NORMAL')], r2.states, t4);
  assert.deepEqual(r3.recoveries, []);
  assert.deepEqual(r3.states, []);
  // re-alerting after a clear starts a new episode
  const r4 = reconcileStates([ev('data.staleness', 'WARNING')], r.states, t3);
  assert.equal(r4.states.find((s) => s.id === 'data.staleness').firstSeenAt, t3.toISOString());
  assert.equal(r4.recoveries.length, 1, 'only x is still recovering');
});

test('evaluateEvents on the snapshot: staleness and store warnings, integrity normal, RECOVERY plumbed through', async () => {
  const dataset = await getDataset({ env: { INGEST_SOURCES: 'fixture' } });
  const now = new Date('2026-09-03T00:00:00Z');
  const first = evaluateEvents({ dataset, latest: [], store: { kind: 'memory', durable: false }, now });
  assert.equal(first.overall, 'WARNING');
  assert.ok(first.events.some((e) => e.id === 'data.staleness' && e.severity === 'WARNING' && e.days === 30));
  assert.ok(first.events.some((e) => e.id === 'validation.integrity' && e.severity === 'NORMAL'));
  assert.ok(first.events.some((e) => e.id === 'price.store' && e.severity === 'WARNING'));
  assert.equal(first.counts.RECOVERY, 0);
  assert.ok(Array.isArray(first.states) && first.states.length === 2);
  // next run with a durable store: the store warning clears -> RECOVERY appears
  const second = evaluateEvents({ dataset, latest: [], store: { kind: 'supabase', durable: true }, now: new Date(now.getTime() + 3_600_000), prevStates: first.states });
  const rec = second.events.find((e) => e.severity === 'RECOVERY');
  assert.ok(rec, 'recovery emitted');
  assert.equal(rec.clearedId, 'price.store');
  assert.equal(second.counts.RECOVERY, 1);
  assert.equal(second.overall, 'WARNING', 'staleness still outranks recovery');
});
