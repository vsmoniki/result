function cleanPower(value) {
  return Number.isFinite(value) ? value : 0;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function buildOneSecondPowerSeries(records, maxFillGapSeconds = 30) {
  const powerSeconds = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!Number.isFinite(record?.elapsed)) continue;

    if (i > 0 && Number.isFinite(records[i - 1]?.elapsed)) {
      const gap = Math.round(record.elapsed - records[i - 1].elapsed);
      if (gap > 1 && gap <= maxFillGapSeconds) {
        const previousPower = cleanPower(records[i - 1].power);
        for (let second = 1; second < gap; second += 1) powerSeconds.push(previousPower);
      }
    }

    powerSeconds.push(cleanPower(record.power));
  }

  return powerSeconds;
}

export function calculateNormalizedPower(records) {
  if (!records.length) return 0;

  const windowSeconds = 30;
  const powerSeconds = buildOneSecondPowerSeries(records);
  if (!powerSeconds.length) return 0;
  if (powerSeconds.length < windowSeconds) return average(powerSeconds);

  let windowSum = 0;
  let fourthPowerSum = 0;
  let rollingAverageCount = 0;

  for (let i = 0; i < powerSeconds.length; i += 1) {
    windowSum += powerSeconds[i];
    if (i >= windowSeconds) windowSum -= powerSeconds[i - windowSeconds];

    if (i >= windowSeconds - 1) {
      const avg = windowSum / windowSeconds;
      fourthPowerSum += avg ** 4;
      rollingAverageCount += 1;
    }
  }

  return (fourthPowerSum / rollingAverageCount) ** 0.25;
}

export function calculateStressPoints(durationSeconds, normalizedPower, ftp) {
  if (!ftp || ftp <= 0 || normalizedPower <= 0) return 0;
  const intensityFactor = normalizedPower / ftp;
  return Math.round((durationSeconds * normalizedPower * intensityFactor) / (ftp * 3600) * 100);
}

export function rollingMetric(records, field, windowSeconds) {
  const window = Math.max(1, Number(windowSeconds) || 1);
  let sum = 0;
  let validCount = 0;
  let left = 0;

  return records.map((record, index) => {
    const value = record[field];
    if (Number.isFinite(value)) {
      sum += value;
      validCount += 1;
    }

    while (left < index && getRecordAgeSeconds(records[left], record, left, index) >= window) {
      const leftValue = records[left][field];
      if (Number.isFinite(leftValue)) {
        sum -= leftValue;
        validCount -= 1;
      }
      left += 1;
    }

    return validCount ? sum / validCount : NaN;
  });
}

function getRecordAgeSeconds(olderRecord, newerRecord, olderIndex, newerIndex) {
  if (Number.isFinite(olderRecord?.elapsed) && Number.isFinite(newerRecord?.elapsed)) {
    return newerRecord.elapsed - olderRecord.elapsed;
  }
  return newerIndex - olderIndex;
}

export function rollingPower(records, windowSeconds = 2) {
  const window = Math.max(1, Math.round(Number(windowSeconds) || 1));
  if (window <= 1) return rollingMetric(records, 'power', 1).map((value) => value || 0);

  // Two box averages form a triangular-weighted average. This keeps the
  // timeline visually smoother as the slider approaches 30 seconds than a
  // single rectangular window, which can amplify some oscillation periods.
  const leadingWindow = Math.ceil(window / 2);
  const trailingWindow = window - leadingWindow + 1;
  const firstPass = rollingMetric(records, 'power', leadingWindow);
  const secondPassRecords = records.map((record, index) => ({
    elapsed: record.elapsed,
    value: firstPass[index],
  }));

  return rollingMetric(secondPassRecords, 'value', trailingWindow).map((value) => value || 0);
}

export function rollingHeartRate(records, windowSeconds = 3) {
  return rollingMetric(records, 'heartRate', windowSeconds).map((value) => value || NaN);
}
