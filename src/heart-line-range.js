// 心拍折れ線が使う縦軸の範囲を求める。
// 下端は必ず 0bpm とし、心拍が上下しても線が大きく跳ねないよう
// 上端は最低でも HEART_LINE_MIN_SPAN_BPM を確保する。
export const HEART_LINE_MIN_SPAN_BPM = 150;

export function getHeartLineRange(maxHeartRate, maxHrSetting, minSpan = HEART_LINE_MIN_SPAN_BPM) {
  const max = Math.max(maxHrSetting * 0.78, maxHeartRate + 12, minSpan);
  return { min: 0, max };
}
