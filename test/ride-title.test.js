import test from 'node:test';
import assert from 'node:assert/strict';
import { titleFromFileName } from '../src/ride-title.js';

test('ride title comes from FIT filename without extension', () => {
  assert.equal(titleFromFileName('Morning Ride.fit'), 'Morning Ride');
});

test('underscores in FIT filename become half-width spaces', () => {
  assert.equal(titleFromFileName('Makuri_Islands_Race.fit'), 'Makuri Islands Race');
});

test('filename title is trimmed after removing extension and underscores', () => {
  assert.equal(titleFromFileName('  Big_Ride_.fit'), 'Big Ride');
});
