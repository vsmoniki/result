// 心拍折れ線が使う縦軸の範囲を求める。
// 表示範囲が狭いと少しの心拍変動でも線が大きく上下してしまうため、
// 常に MIN_SPAN_BPM 以上の幅を確保して 1bpm あたりの振れ幅を抑える。
export const HEART_LINE_MIN_SPAN_BPM = 150;

export function getHeartLineRange(avgHeartRate, maxHeartRate, maxHrSetting, minSpan = HEART_LINE_MIN_SPAN_BPM) {
  const baseMin = Math.max(0, Math.min(avgHeartRate - 50, maxHeartRate - 92));
  const baseMax = Math.max(maxHrSetting * 0.78, maxHeartRate + 12);
  const span = baseMax - baseMin;
  if (span >= minSpan) return { min: baseMin, max: baseMax };

  // 上下に均等に広げて、線が縦方向の中央付近に留まるようにする。
  const pad = (minSpan - span) / 2;
  const min = Math.max(0, baseMin - pad);
  const max = Math.max(baseMax + pad, min + minSpan);
  return { min, max };
}
