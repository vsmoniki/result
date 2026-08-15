import test from 'node:test';
import assert from 'node:assert/strict';
import { getHeartLineRange, HEART_LINE_MIN_SPAN_BPM } from '../src/heart-line-range.js';

test('狭い心拍レンジは最小幅まで上下均等に広げる', () => {
  const { min, max } = getHeartLineRange(160, 185, 190);
  // 従来の計算では 93〜197 (104bpm) しかなく、線の振れ幅が大きかった
  assert.equal(max - min, HEART_LINE_MIN_SPAN_BPM);
  assert.equal(min, 70);
  assert.equal(max, 220);
});

test('すでに最小幅を超えている場合はそのままの範囲を使う', () => {
  const { min, max } = getHeartLineRange(60, 200, 200);
  assert.equal(min, 10);
  assert.equal(max, 212);
});

test('下限は0未満にならず、その分だけ上限を広げて最小幅を保つ', () => {
  const { min, max } = getHeartLineRange(55, 80, 100);
  assert.equal(min, 0);
  assert.ok(max - min >= HEART_LINE_MIN_SPAN_BPM);
});

test('心拍データが無い場合でも有効な範囲を返す', () => {
  const { min, max } = getHeartLineRange(0, 0, 190);
  assert.ok(Number.isFinite(min));
  assert.ok(Number.isFinite(max));
  assert.ok(max - min >= HEART_LINE_MIN_SPAN_BPM);
});
