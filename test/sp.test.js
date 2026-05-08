import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNormalizedPower, calculateStressPoints } from '../src/sp.js';

function makeRecords(powers) {
  return powers.map((power, elapsed) => ({ elapsed, power }));
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
