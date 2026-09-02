import test from 'node:test';
import assert from 'node:assert/strict';
import { Availability, formatMinorUnits, stripMerged, toCount, toIsoDate, toMinorUnits, toNumber } from '../src/normalize/coerce.js';

test('money parses to exact integer minor units', () => {
  assert.equal(toMinorUnits('1,269.00').value, 126900);
  assert.equal(toMinorUnits('$5.40').value, 540);
  assert.equal(toMinorUnits('745.30').value, 74530);
  assert.equal(toMinorUnits('0').value, 0);
});

test('money avoids float error on totals', () => {
  // 0.1 + 0.2 !== 0.3 in floats; in minor units it is exact.
  const a = toMinorUnits('0.10').value + toMinorUnits('0.20').value;
  assert.equal(a, toMinorUnits('0.30').value);
});

test('N/Q and blank are distinguishable', () => {
  assert.equal(toMinorUnits('N/Q').availability, Availability.NOT_QUOTED);
  assert.equal(toMinorUnits('').availability, Availability.MISSING);
  assert.equal(toMinorUnits('1.00').availability, Availability.QUOTED);
  assert.equal(toMinorUnits('abc').availability, Availability.UNPARSEABLE);
});

test('precision beyond the minor unit is flagged, not silently dropped', () => {
  assert.equal(toMinorUnits('12.3456').truncated, true);
  assert.equal(toMinorUnits('12.3400').truncated, false);
});

test('hosting rates keep four decimals at micro scale', () => {
  assert.equal(toMinorUnits('0.054', { scale: 6 }).value, 54000);
  assert.equal(formatMinorUnits(54000, { scale: 6 }), '0.054000');
});

test('merged-cell markers are stripped and remembered', () => {
  assert.deepEqual(stripMerged('[merged] 60,930.0'), { text: '60,930.0', merged: true });
  assert.deepEqual(stripMerged('263'), { text: '263', merged: false });
});

test('dates must be real calendar dates', () => {
  assert.equal(toIsoDate('2026-08-04'), '2026-08-04');
  assert.equal(toIsoDate('2026-02-31'), null);
  assert.equal(toIsoDate('04/08/2026'), null);
});

test('counts reject non-integers and negatives', () => {
  assert.equal(toCount('238'), 238);
  assert.equal(toCount('23.5'), null);
  assert.equal(toCount('-1'), null);
  assert.equal(toNumber('42.6%'), 42.6);
});
