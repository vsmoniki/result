import test from 'node:test';
import assert from 'node:assert/strict';
import { getHeartLineRange, HEART_LINE_MIN_SPAN_BPM } from '../src/heart-line-range.js';

test('下端は常に0bpm', () => {
  assert.equal(getHeartLineRange(185, 190).min, 0);
  assert.equal(getHeartLineRange(0, 0).min, 0);
});

test('上端は最大心拍に余白を足した値', () => {
  assert.equal(getHeartLineRange(185, 190).max, 197);
});

test('設定最大心拍が実測より高い場合はその0.78倍を使う', () => {
  assert.equal(getHeartLineRange(140, 220).max, 171.6);
});

test('心拍データが無くても最低幅を確保する', () => {
  const { min, max } = getHeartLineRange(0, 0);
  assert.equal(max - min, HEART_LINE_MIN_SPAN_BPM);
});
