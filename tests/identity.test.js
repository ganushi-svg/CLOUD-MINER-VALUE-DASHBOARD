import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClient } from '../src/normalize/clients.js';
import { ModelRegistry, modelSlug } from '../src/normalize/models.js';

test('client codes are extracted and zero-padded to a stable key', () => {
  assert.deepEqual(parseClient('144. George Pastakis'),
    { key: 'c:144', code: '144', name: 'George Pastakis', coded: true, raw: '144. George Pastakis' });
  // "40." and "040." must land on the same client.
  assert.equal(parseClient('40. Marco Buchegger').key, parseClient('040. Marco Buchegger').key);
  // Missing space after the dot is common in the source.
  assert.equal(parseClient('186.Maxwell Takura Makara').code, '186');
});

test('uncoded clients fall back to a name slug and are marked', () => {
  const c = parseClient('DELTA ROCKHOLD EE');
  assert.equal(c.coded, false);
  assert.equal(c.code, null);
  assert.equal(c.key, 'n:delta-rockhold-ee');
});

test('the three spellings of one model converge on one slug', () => {
  const s = modelSlug('Bitmain Antminer S21+ 235TH');
  assert.equal(modelSlug('Antminer S21+ 235TH'), s);
  assert.equal(modelSlug('  bitmain   antminer  s21+ 235th '), s);
  assert.equal(modelSlug('Bitmain Antminer S21+ Hydro (395Th)'), modelSlug('Antminer S21+ HYD (395TH)'));
});

test('"+" is significant: S21 and S21+ never collide', () => {
  assert.notEqual(modelSlug('Antminer S21 (200T)'), modelSlug('Antminer S21+ (216Th)'));
});

test('registry resolves by label then slug, and records what it cannot match', () => {
  const registry = new ModelRegistry([
    { modelKey: 'antminer-s21+-235th', slug: 'antminer-s21+-235th', label: 'Bitmain Antminer S21+ 235TH' },
  ]);
  assert.deepEqual(registry.resolve('Bitmain Antminer S21+ 235TH'), { modelKey: 'antminer-s21+-235th', matchedBy: 'label' });
  assert.deepEqual(registry.resolve('antminer s21+ 235TH'), { modelKey: 'antminer-s21+-235th', matchedBy: 'slug' });
  assert.deepEqual(registry.resolve('Whatsminer M60'), { modelKey: null, matchedBy: null });
  assert.deepEqual(registry.unresolvedReferences(), [{ label: 'Whatsminer M60', count: 1 }]);
});
