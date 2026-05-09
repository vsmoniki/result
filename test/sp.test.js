import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNormalizedPower, calculateStressPoints, rollingPower } from '../src/sp.js';

function makeRecords(powers) {
  return powers.map((power, elapsed) => ({ elapsed, power }));
}

function totalVariation(values) {
  let variation = 0;
  for (let i = 1; i < values.length; i += 1) {
    variation += Math.abs(values[i] - values[i - 1]);
  }
  return variation;
}

test('stress points are 100 for one hour at FTP', () => {
  const ftp = 250;
  const normalizedPower = calculateNormalizedPower(makeRecords(Array(3600).fill(ftp)));

  assert.equal(Math.round(normalizedPower), ftp);
  assert.equal(calculateStressPoints(3600, normalizedPower, ftp), 100);
});

test('stress points scale with squared intensity factor', () => {
  const ftp = 250;
  const normalizedPower = calculateNormalizedPower(makeRecords(Array(3600).fill(ftp / 2)));

  assert.equal(Math.round(normalizedPower), ftp / 2);
  assert.equal(calculateStressPoints(3600, normalizedPower, ftp), 25);
});

test('normalized power uses only complete 30-second rolling windows', () => {
  const records = makeRecords([
    ...Array(15).fill(300),
    ...Array(15).fill(0),
    ...Array(30).fill(0),
  ]);

  assert.equal(Math.round(calculateNormalizedPower(records)), 87);
});

test('short efforts under 30 seconds fall back to average power', () => {
  const records = makeRecords(Array(20).fill(200));

  assert.equal(calculateNormalizedPower(records), 200);
});

test('visual power smoothing keeps reducing oscillation near the 30-second slider limit', () => {
  const records = makeRecords(
    Array.from({ length: 3600 }, (_, index) => (index % 20 < 10 ? 300 : 100)),
  );

  const variations = [27, 28, 29, 30]
    .map((seconds) => totalVariation(rollingPower(records, seconds)));

  assert.deepEqual(
    variations,
    [...variations].sort((a, b) => b - a),
  );
});
