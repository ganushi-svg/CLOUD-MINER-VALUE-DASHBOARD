import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkbook } from '../src/ingest/sheets.js';
import { normalizeWorkbook } from '../src/normalize/pipeline.js';
import { buildResolver, parseModelPhrase, parsePrice, parseBasis, parsePriceList } from '../src/pricefeed/parse.js';

const models = normalizeWorkbook(await fetchWorkbook({ env: { INGEST_SOURCES: 'fixture' } })).models;
const resolve = buildResolver(models);
const META = { source: 'test', sender: '+000', observedAt: '2026-09-02T08:00:00Z', messageId: 'm1' };

test('registry labels and supplier spellings meet at one family key', () => {
  assert.equal(parseModelPhrase('Bitmain Antminer S21+ Hydro (395Th)').family, 'antminer-s21+-hyd');
  assert.equal(parseModelPhrase('s21+ hyd 395t').family, 'antminer-s21+-hyd');
  assert.equal(parseModelPhrase('Antminer S19k Pro (120T)').family, 'antminer-s19k-pro');
  assert.equal(parseModelPhrase('S21 XP+ Hyd 500T').family, 'antminer-s21-xp+-hyd');
  assert.equal(parseModelPhrase('Bitdeer SealMinerA2 Pro Hyd (500Th)').family, 'bitdeer-sealminer-a2-pro-hyd');
  assert.equal(parseModelPhrase('WhatsMiner M63S (396Th)').family, 'whatsminer-m63s');
  assert.equal(parseModelPhrase('Bitmain Antminer S21+117.5TH').hashrate, 117.5);
  assert.equal(parseModelPhrase('random chatter about lunch'), null);
});

test('every registry label resolves back to itself', () => {
  for (const m of models) {
    const r = resolve(m.label);
    assert.equal(r.modelKey, m.modelKey, `${m.label} -> ${r.modelKey ?? r.reason}`);
    assert.equal(r.confidence, 'HIGH');
  }
});

test('prices in the common supplier notations', () => {
  assert.deepEqual(parsePrice('S21+ 235T $1,269'), { minor: 126900, perTh: false });
  assert.deepEqual(parsePrice('S21+ 235T 1269$'), { minor: 126900, perTh: false });
  assert.deepEqual(parsePrice('S21+ 235T 1269 usd'), { minor: 126900, perTh: false });
  assert.deepEqual(parsePrice('S21+ 235T USD 1269.50'), { minor: 126950, perTh: false });
  assert.deepEqual(parsePrice('S21 XP hyd $2.85k'), { minor: 285000, perTh: false });
  assert.deepEqual(parsePrice('S21+ mix $5.40/T'), { minor: 540, perTh: true });
  assert.deepEqual(parsePrice('S21+ 5.4$/TH'), { minor: 540, perTh: true });
  assert.equal(parsePrice('S21+ 235T in stock'), null);
});

test('condition words map to a basis, silence to UNKNOWN', () => {
  assert.equal(parseBasis('S21+ used $1200'), 'USED');
  assert.equal(parseBasis('S21+ mix $1200'), 'USED');
  assert.equal(parseBasis('S21+ brand new $1480'), 'FRESH');
  assert.equal(parseBasis('S21+ $1480'), 'UNKNOWN');
});

test('a realistic message becomes observations plus explicit leftovers', () => {
  const msg = `Daily list 02/09
S21+ 235T $1,269 used
Antminer S21 XP Hyd (473Th) - 2850$ new
S19k pro 120t 380 usd
S21 pro 234T $1357 | S21+ hyd 395T $1817
S21e XP Hyd 310T $1590
KS5 Pro 21T $250
S21+ 235T $5.40/T mix
M66S 300T $1100
S21 XP hyd 473T in stock
Whatsminer M63S 396T 2,300$`;
  const { observations, unresolved } = parsePriceList(msg, META, resolve);
  const by = (k) => observations.filter((o) => o.modelKey === k);

  assert.equal(by('antminer-s21+-235th').length, 2);
  assert.equal(by('antminer-s21+-235th')[0].unitPriceMinor, 126900);
  assert.equal(by('antminer-s21+-235th')[0].basis, 'USED');
  assert.equal(by('antminer-s21+-235th')[0].confidence, 'HIGH');
  assert.equal(by('antminer-s21+-235th')[1].unitPriceMinor, 126900, '$5.40/T x 235 = $1,269.00');
  assert.equal(by('antminer-s21+-235th')[1].confidence, 'MEDIUM');
  assert.equal(by('antminer-s21-xp-hyd-473th')[0].unitPriceMinor, 285000);
  assert.equal(by('antminer-s21-xp-hyd-473th')[0].basis, 'FRESH');
  assert.equal(by('antminer-s19k-pro-120t')[0].unitPriceMinor, 38000);
  assert.equal(by('antminer-s21-pro-234t')[0].confidence, 'HIGH', 'label says 234T even though it is rated 239 TH');
  assert.equal(by('antminer-s21+-hyd-395th')[0].unitPriceMinor, 181700);
  assert.equal(by('antminer-ks5-pro-21t')[0].unitPriceMinor, 25000);
  assert.equal(by('whatsminer-m63s-396th')[0].unitPriceMinor, 230000);

  const reasons = unresolved.map((u) => u.reason);
  assert.ok(reasons.some((r) => /m66s/.test(r)), 'M66S is not a fleet model');
  assert.ok(reasons.includes('no price'), 'a line with a model but no price is reported, not guessed');
  assert.equal(observations.length, 9);
});
