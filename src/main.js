import FitParser from 'fit-file-parser';
import { calculateNormalizedPower, calculateStressPoints } from './sp.js';
import { titleFromFileName } from './ride-title.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  sourceData: null,
  metrics: null,
  downloadUrl: null,
  downloadBlob: null,
  downloadFileName: 'zwift-result.png',
  fileSelectionToken: 0,
  fileInputKey: null,
  autoRideTitle: '',
  isLoadingFile: false,
  graphSmoothnessTouched: false,
  powerGraphHeightTouched: false,
  graphLineWidthTouched: false,
};

// Guard against duplicate activations while the native file picker is open.
let pickerIsActive = false;
let pickerActivatedAt = 0;
const PICKER_TIMEOUT_MS = 30_000;
const DEFAULT_CANVAS_WIDTH = 1920;
const DEFAULT_CANVAS_HEIGHT = 1080;
const MIN_GRAPH_SMOOTHNESS = -20;
const MAX_GRAPH_SMOOTHNESS = 100;
const LEGACY_GRAPH_SMOOTHNESS = 0;
const DEFAULT_POWER_GRAPH_HEIGHT = 0;
const DEFAULT_GRAPH_LINE_WIDTH = 0;
const HEART_LINE_AMPLITUDE_SCALE = 0.9;
const REPORT_FONT = "'Arial Rounded MT Bold', 'Hiragino Maru Gothic ProN', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif";
const REPORT_NUMBER_FONT = "'Arial Black', 'Arial Rounded MT Bold', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif";
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const fileInput = $('#fitFile');
const fileDrop = $('#fileDrop');
const graphSmoothnessSlider = $('#graphSmoothness');
const graphSmoothnessValue = $('#graphSmoothnessValue');
const powerGraphHeightSlider = $('#powerGraphHeight');
const powerGraphHeightValue = $('#powerGraphHeightValue');
const graphLineWidthSlider = $('#graphLineWidth');
const graphLineWidthValue = $('#graphLineWidthValue');
const resetOptionsButton = $('#resetOptions');

$('input[name="mode"][value="finish"]').addEventListener('change', syncMode);
$('input[name="mode"][value="report"]').addEventListener('change', syncMode);
$('input[name="mode"][value="ftp-update"]').addEventListener('change', syncMode);
fileDrop.addEventListener('dragover', handleFileDragOver);
fileDrop.addEventListener('dragleave', handleFileDragLeave);
fileDrop.addEventListener('drop', handleFileDrop);
fileDrop.addEventListener('pointerenter', handlePendingFileSelection);
fileInput.addEventListener('click', prepareFilePicker);
fileInput.addEventListener('blur', handlePendingFileSelection);
fileInput.addEventListener('cancel', onPickerClose);
fileInput.addEventListener('input', handleFile);
fileInput.addEventListener('change', handleFile);
window.addEventListener('focus', () => {
  if (!pickerIsActive) return;
  setTimeout(() => {
    onPickerClose();
    handlePendingFileSelection();
  }, 500);
});
$('#generate').addEventListener('click', generateImage);
$('#download').addEventListener('click', savePng);
$('#rideTitle').addEventListener('input', handleRideTitleInput);
$('#ftp').addEventListener('input', syncSp);
graphSmoothnessSlider.addEventListener('input', handleGraphSmoothnessInput);
powerGraphHeightSlider.addEventListener('input', handlePowerGraphHeightInput);
graphLineWidthSlider.addEventListener('input', handleGraphLineWidthInput);
resetOptionsButton.addEventListener('click', resetOptionsToDefaults);

function syncMode() {
  const mode = getMode();
  const requiresFitFile = mode !== 'ftp-update';
  $('#finishInputs').classList.toggle('hidden', mode !== 'finish');
  $('#reportInputs').classList.toggle('hidden', mode !== 'report');
  $('#ftpUpdateInputs').classList.toggle('hidden', mode !== 'ftp-update');
  fileDrop.classList.toggle('hidden', !requiresFitFile);
  document.querySelector('.preview-options').classList.toggle('hidden', mode !== 'report');
  clearGeneratedDownload();
  syncGraphSmoothnessSliderDefault();
  syncPowerGraphHeightSliderDefault();
  syncGraphLineWidthSliderDefault();
  drawPlaceholder();
  setStatus(getMode() === 'ftp-update' ? '元々のFTPと更新後のFTPを入力してください。' : 'FITファイルを選択してください。');
}

function prepareFilePicker(event) {
  const now = Date.now();
  // If the picker is already active (opened by an earlier genuine click), ignore
  // duplicate events. The 30-second timeout is a safety valve so a cancelled
  // picker (no cancel/change event) doesn't block future opens.
  if (pickerIsActive && now - pickerActivatedAt < PICKER_TIMEOUT_MS) {
    return;
  }
  state.fileInputKey = null;
  fileInput.value = '';
  pickerIsActive = true;
  pickerActivatedAt = now;
}

function onPickerClose() {
  pickerIsActive = false;
}

async function handleFile(event) {
  await processFileInputSelection(event.currentTarget);
}

async function handlePendingFileSelection() {
  await processFileInputSelection(fileInput);
}

async function processFileInputSelection(input) {
  const file = input.files?.[0];
  if (!file) return;
  onPickerClose();

  const fileInputKey = getFileInputKey(file);
  if (fileInputKey === state.fileInputKey) return;
  state.fileInputKey = fileInputKey;

  await processSelectedFile(file);
}


function getFileInputKey(file) {
  return [file.name, file.size, file.lastModified, file.type].join(':');
}

function handleFileDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  fileDrop.classList.add('drag-over');
}

function handleFileDragLeave() {
  fileDrop.classList.remove('drag-over');
}

async function handleFileDrop(event) {
  event.preventDefault();
  fileDrop.classList.remove('drag-over');
  const file = [...(event.dataTransfer?.files || [])].find(isSupportedActivityFile);
  if (!file) {
    setStatus('FITファイルをドロップしてください。', true);
    return;
  }
  await processSelectedFile(file);
}

async function processSelectedFile(file) {
  const selectionToken = beginFileSelection(file);

  if (!isSupportedActivityFile(file)) {
    finishFileSelection(selectionToken);
    setStatus('FITファイルを選択してください。', true);
    return;
  }

  setStatus('FITファイルを読み込み中…');
  try {
    const sourceData = await parseActivityFile(file);
    const metrics = extractMetrics(sourceData);
    if (!isCurrentFileSelection(selectionToken)) return;

    state.sourceData = sourceData;
    state.metrics = metrics;
    state.isLoadingFile = false;
    syncRideTitle(file);
    syncGraphSmoothnessSliderDefault();
    syncPowerGraphHeightSliderDefault();
    syncGraphLineWidthSliderDefault();
    syncSp();
    $('#generate').disabled = false;
    fileDrop.classList.add('has-file');
    $('#summary').textContent = `${formatDuration(metrics.duration)} / ${Math.round(metrics.avgPower)}W avg`;
    if (canGenerateImage()) {
      generateImage();
      setStatus('プレビューへ反映しました。');
    } else {
      setStatus('必要項目を入力して画像を作成してください。');
    }
  } catch (error) {
    if (!isCurrentFileSelection(selectionToken)) return;
    resetSelectedFileState(false);
    setStatus(`FITファイルを読み込めませんでした: ${formatError(error)}`, true);
  } finally {
    finishFileSelection(selectionToken);
  }
}

function beginFileSelection(file) {
  const selectionToken = state.fileSelectionToken + 1;
  state.fileSelectionToken = selectionToken;
  state.isLoadingFile = true;
  resetSelectedFileState();
  $('#fileName').textContent = file.name;
  clearGeneratedDownload();
  $('#generate').disabled = true;
  syncGraphSmoothnessSliderDefault();
  syncPowerGraphHeightSliderDefault();
  syncGraphLineWidthSliderDefault();
  drawPlaceholder();
  return selectionToken;
}

function finishFileSelection(selectionToken) {
  if (!isCurrentFileSelection(selectionToken)) return;
  state.isLoadingFile = false;
  $('#generate').disabled = !state.metrics;
}

function isCurrentFileSelection(selectionToken) {
  return selectionToken === state.fileSelectionToken;
}

function resetSelectedFileState(resetFileName = true) {
  state.sourceData = null;
  state.metrics = null;
  $('#summary').textContent = '';
  fileDrop.classList.remove('has-file');
  if (resetFileName) $('#fileName').textContent = '未選択';
}

function handleRideTitleInput(event) {
  if (event.currentTarget.value !== state.autoRideTitle) {
    state.autoRideTitle = '';
  }
}

function handleGraphSmoothnessInput() {
  state.graphSmoothnessTouched = true;
  syncGraphSmoothnessValue();
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function handlePowerGraphHeightInput() {
  state.powerGraphHeightTouched = true;
  syncPowerGraphHeightValue();
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function handleGraphLineWidthInput() {
  state.graphLineWidthTouched = true;
  syncGraphLineWidthValue();
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function resetOptionsToDefaults() {
  state.graphSmoothnessTouched = false;
  state.powerGraphHeightTouched = false;
  state.graphLineWidthTouched = false;
  syncGraphSmoothnessSliderDefault();
  syncPowerGraphHeightSliderDefault();
  syncGraphLineWidthSliderDefault();
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function syncGraphSmoothnessSliderDefault() {
  if (!state.graphSmoothnessTouched) {
    graphSmoothnessSlider.value = getDefaultGraphSmoothness();
  }
  syncGraphSmoothnessValue();
}

function syncGraphSmoothnessValue() {
  const smoothness = getSelectedGraphSmoothness();
  graphSmoothnessValue.textContent = formatSignedPercent(smoothness);
}

function getSelectedGraphSmoothness() {
  if (!state.graphSmoothnessTouched) return getDefaultGraphSmoothness();
  return clampGraphSmoothness(Number(graphSmoothnessSlider.value));
}

function getDefaultGraphSmoothness() {
  return LEGACY_GRAPH_SMOOTHNESS;
}

function syncPowerGraphHeightSliderDefault() {
  if (!state.powerGraphHeightTouched) {
    powerGraphHeightSlider.value = getDefaultPowerGraphHeight();
  }
  syncPowerGraphHeightValue();
}

function syncPowerGraphHeightValue() {
  const height = getSelectedPowerGraphHeight();
  powerGraphHeightValue.textContent = formatSignedPercent(height);
}

function getSelectedPowerGraphHeight() {
  if (!state.powerGraphHeightTouched) return getDefaultPowerGraphHeight();
  return clampPowerGraphHeight(Number(powerGraphHeightSlider.value));
}

function getDefaultPowerGraphHeight() {
  return DEFAULT_POWER_GRAPH_HEIGHT;
}

function clampPowerGraphHeight(value) {
  if (!Number.isFinite(value)) return getDefaultPowerGraphHeight();
  return Math.max(-50, Math.min(50, Math.round(value)));
}

function syncGraphLineWidthSliderDefault() {
  if (!state.graphLineWidthTouched) {
    graphLineWidthSlider.value = getDefaultGraphLineWidth();
  }
  syncGraphLineWidthValue();
}

function syncGraphLineWidthValue() {
  const lineWidth = getSelectedGraphLineWidth();
  graphLineWidthValue.textContent = formatSignedPercent(lineWidth);
}

function getSelectedGraphLineWidth() {
  if (!state.graphLineWidthTouched) return getDefaultGraphLineWidth();
  return clampGraphLineWidth(Number(graphLineWidthSlider.value));
}

function getDefaultGraphLineWidth() {
  return DEFAULT_GRAPH_LINE_WIDTH;
}

function clampGraphLineWidth(value) {
  if (!Number.isFinite(value)) return getDefaultGraphLineWidth();
  return Math.max(-100, Math.min(100, Math.round(value)));
}

function getGraphLineWidthMultiplier(lineWidth) {
  return 1 + clampGraphLineWidth(lineWidth) / 100;
}

function getDurationBasedGraphLineWidths(metrics) {
  const step = Math.min(3, Math.max(0, getAutomaticTimelineAverageSeconds(metrics) - 2));
  return {
    lineWidth: 1.7 - step * 0.3,
    shadowWidth: 3.6 - step * 0.8,
  };
}

function formatSignedPercent(value) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function getAutomaticTimelineAverageSeconds(metrics) {
  const duration = metrics?.duration ?? 0;
  if (duration >= 18000) return 5;
  if (duration >= 10800) return 4;
  if (duration >= 7200) return 3;
  return 2;
}

function getTimelineLevelingConfig(metrics, smoothness, graphWidth) {
  const powerWindow = getTimelinePowerAverageSeconds(metrics, smoothness);
  const heartWindow = Math.max(3, Math.round(powerWindow * 1.25));
  const maxSamples = getTimelineMaxSamples(metrics, smoothness, graphWidth);
  return { powerWindow, heartWindow, maxSamples };
}

function getTimelinePowerAverageSeconds(metrics, smoothness) {
  const baseWindow = getAutomaticTimelineAverageSeconds(metrics);
  const clampedSmoothness = clampGraphSmoothness(smoothness);
  if (clampedSmoothness < 0) {
    const detailAmount = (clampedSmoothness - MIN_GRAPH_SMOOTHNESS) / (LEGACY_GRAPH_SMOOTHNESS - MIN_GRAPH_SMOOTHNESS);
    return Math.max(1, Math.round(1 + detailAmount * (baseWindow - 1)));
  }

  const amount = clampedSmoothness / MAX_GRAPH_SMOOTHNESS;
  const maxWindow = 30;
  return Math.min(maxWindow, baseWindow + Math.round(amount ** 1.15 * (maxWindow - baseWindow)));
}

function getTimelineMaxSamples(metrics, smoothness, graphWidth) {
  const recordCount = metrics?.records?.length ?? 0;
  const clampedSmoothness = clampGraphSmoothness(smoothness);
  if (clampedSmoothness <= MIN_GRAPH_SMOOTHNESS) return Math.max(1, recordCount);

  const sampleDensity = getTimelineSampleDensity(clampedSmoothness);
  return Math.max(120, Math.round(graphWidth * sampleDensity));
}

function getTimelineSampleDensity(smoothness) {
  const clampedSmoothness = clampGraphSmoothness(smoothness);
  if (clampedSmoothness < 0) {
    const detailAmount = (clampedSmoothness - MIN_GRAPH_SMOOTHNESS) / (LEGACY_GRAPH_SMOOTHNESS - MIN_GRAPH_SMOOTHNESS);
    return 1 + (1 - detailAmount);
  }

  const amount = clampedSmoothness / MAX_GRAPH_SMOOTHNESS;
  return 1 - amount ** 1.2 * 0.72;
}

function getTimelineBarMaxSamples(graphWidth, maxSamples) {
  return Math.max(1, Math.min(Math.round(graphWidth), Math.round(maxSamples)));
}


function clampGraphSmoothness(value) {
  if (!Number.isFinite(value)) return getDefaultGraphSmoothness();
  return Math.max(MIN_GRAPH_SMOOTHNESS, Math.min(MAX_GRAPH_SMOOTHNESS, Math.round(value)));
}

function syncSp() {
  if (!state.metrics) return;
  const ftp = Number($('#ftp').value);
  if (!isValidPositiveNumber(ftp)) return;
  const np = calculateNormalizedPower(state.metrics.records);
  const sp = calculateStressPoints(state.metrics.timerSeconds, np, ftp);
  $('#spInput').value = sp;
}

function syncRideTitle(file) {
  const titleInput = $('#rideTitle');
  const currentTitle = titleInput.value.trim();
  if (currentTitle && currentTitle !== state.autoRideTitle) return;

  const title = titleFromFileName(file.name);
  if (!title) return;

  titleInput.value = title;
  state.autoRideTitle = title;
}

function clearGeneratedDownload() {
  const download = $('#download');
  download.classList.add('disabled');
  download.removeAttribute('href');
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
  }
  state.downloadUrl = null;
  state.downloadBlob = null;
}


function isSupportedActivityFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.fit') || ['application/vnd.ant.fit', 'application/octet-stream'].includes(file.type);
}

async function parseActivityFile(file) {
  return parseFitBuffer(await readFileAsArrayBuffer(file));
}

function readFileAsArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return readFileWithFileReader(file, 'readAsArrayBuffer');
}

function readFileWithFileReader(file, method) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error || new Error('ファイルの読み込みに失敗しました。')));
    reader.addEventListener('abort', () => reject(new Error('ファイルの読み込みがキャンセルされました。')));
    reader[method](file);
  });
}

function parseFitBuffer(buffer) {
  if (typeof FitParser !== 'function') {
    throw new Error('FITパーサーを読み込めませんでした。');
  }

  const parser = new FitParser({
    force: true,
    mode: 'both',
    speedUnit: 'km/h',
    lengthUnit: 'km',
    elapsedRecordField: true,
  });

  if (typeof parser.parseAsync === 'function') return parser.parseAsync(buffer);

  return parseWithCallback(parser, buffer);
}

function parseWithCallback(parser, buffer) {
  return new Promise((resolve, reject) => {
    let parsedData;
    let parseError;

    try {
      parser.parse(buffer, (error, data) => {
        if (error) parseError = error;
        if (data) parsedData = data;
      });
    } catch (error) {
      reject(error);
      return;
    }

    if (parsedData) {
      resolve(parsedData);
    } else {
      reject(parseError || new Error('FITデータが空でした。'));
    }
  });
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '不明なエラー';
}

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function generateImage() {
  const mode = getMode();
  if (state.isLoadingFile && mode !== 'ftp-update') {
    setStatus('ファイルを読み込み中です。完了してから画像を作成してください。', true);
    return;
  }
  if (mode === 'ftp-update') {
    const previousFtp = Number($('#previousFtp').value);
    const updatedFtp = Number($('#updatedFtp').value);
    if (!isValidPositiveNumber(previousFtp) || !isValidPositiveNumber(updatedFtp)) return setStatus('元々のFTPと更新後のFTPを入力してください。', true);
    drawFtpUpdateResult(Math.round(previousFtp), Math.round(updatedFtp));
  } else if (!state.metrics) {
    handlePendingFileSelection();
    setStatus('先にFITファイルを選択してください。', true);
    return;
  } else if (mode === 'finish') {
    const weight = Number($('#weight').value);
    if (!isValidPositiveNumber(weight)) return setStatus('体重を入力してください。', true);
    drawFinishResult(state.metrics, weight);
  } else {
    const title = $('#rideTitle').value.trim();
    const ftp = Number($('#ftp').value);
    const level = Number($('#level').value);
    const maxHrSetting = Number($('#maxHrSetting').value);
    if (!title || !isValidPositiveNumber(ftp) || !isValidLevel(level) || !isValidPositiveNumber(maxHrSetting)) return setStatus('タイトル、FTP、レベル、最大心拍数を入力してください。', true);
    const sp = Math.max(0, Math.round(Number($('#spInput').value) || 0));
    const graphSmoothness = getSelectedGraphSmoothness();
    const powerGraphHeight = getSelectedPowerGraphHeight();
    const graphLineWidth = getSelectedGraphLineWidth();
    drawRideReport(state.metrics, { title, ftp, level: Math.round(level), maxHrSetting, sp, graphSmoothness, powerGraphHeight, graphLineWidth });
  }
  canvas.toBlob((blob) => {
    if (!blob) return;
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadBlob = blob;
    state.downloadUrl = URL.createObjectURL(blob);
    const download = $('#download');
    download.href = state.downloadUrl;
    download.download = state.downloadFileName;
    download.classList.remove('disabled');
  }, 'image/png');
  const saveMessage = isSmartphoneDevice()
    ? '画像を作成しました。「PNGを保存」から端末に保存できます。'
    : '画像を作成しました。PNGを保存できます。';
  setStatus(saveMessage);
}

async function savePng(event) {
  const download = $('#download');
  if (download.classList.contains('disabled') || !state.downloadBlob) {
    event.preventDefault();
    return;
  }

  if (!isSmartphoneDevice()) return;

  const file = new File([state.downloadBlob], state.downloadFileName, { type: 'image/png' });
  if (!navigator.canShare?.({ files: [file] }) || !navigator.share) return;

  event.preventDefault();
  try {
    await navigator.share({ files: [file], title: 'Zwiftリザルト画像' });
    setStatus('共有メニューから端末にPNGを保存できます。');
  } catch (error) {
    if (error?.name === 'AbortError') {
      setStatus('PNGの保存をキャンセルしました。');
      return;
    }
    setStatus(`PNGの保存を開始できませんでした: ${formatError(error)}`, true);
  }
}

function canGenerateImage() {
  if (getMode() === 'ftp-update') {
    return isValidPositiveNumber(Number($('#previousFtp').value))
      && isValidPositiveNumber(Number($('#updatedFtp').value));
  }
  if (!state.metrics || state.isLoadingFile) return false;
  if (getMode() === 'finish') return isValidPositiveNumber(Number($('#weight').value));
  return Boolean(
    $('#rideTitle').value.trim()
      && isValidPositiveNumber(Number($('#ftp').value))
      && isValidLevel(Number($('#level').value))
      && isValidPositiveNumber(Number($('#maxHrSetting').value)),
  );
}

function isValidPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function isValidLevel(value) {
  return Number.isInteger(value) && value >= 1 && value <= 999;
}

function isSmartphoneDevice() {
  return /Android|iPhone|iPod|Windows Phone/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && matchMedia('(max-width: 767px)').matches);
}

function setStatus(message, isError = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', isError);
}

function calculateWattsPerKg(power, weight) {
  if (!Number.isFinite(power) || !Number.isFinite(weight) || weight <= 0) return 0;
  return power / weight;
}

function extractMetrics(data, sourceLabel = 'FIT') {
  const records = (data.records || [])
    .filter((record) => record.timestamp)
    .map((record, index) => ({
      timestamp: new Date(record.timestamp),
      elapsed: Number.isFinite(record.elapsed_time) ? record.elapsed_time : clean(record.elapsed),
      power: clean(record.power),
      heartRate: clean(record.heart_rate),
      cadence: clean(record.cadence),
      distance: clean(record.distance),
      speed: clean(record.speed),
      index,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!records.length) throw new Error(`${sourceLabel}に時系列レコードがありません。`);
  const firstTime = records[0].timestamp.getTime();
  records.forEach((record) => {
    if (!Number.isFinite(record.elapsed)) record.elapsed = Math.max(0, (record.timestamp.getTime() - firstTime) / 1000);
  });

  const powers = records.map((r) => r.power).filter(Number.isFinite);
  const heartRates = records.map((r) => r.heartRate).filter(Number.isFinite);
  const maxElapsed = Math.max(...records.map((r) => r.elapsed));
  const minElapsed = Math.min(...records.map((r) => r.elapsed));
  const duration = data.sampleIntervalSeconds && minElapsed <= data.sampleIntervalSeconds
    ? maxElapsed + data.sampleIntervalSeconds
    : maxElapsed;
  const lastDistance = [...records].reverse().find((r) => Number.isFinite(r.distance))?.distance ?? 0;
  const avgPower = average(powers);
  const maxPower = powers.length ? Math.max(...powers) : 0;
  const maxHeartRate = heartRates.length ? Math.max(...heartRates) : 0;
  const avgHeartRate = heartRates.length ? average(heartRates) : 0;
  const calories = data.sessions?.[0]?.total_calories ?? Math.round(avgPower * duration / 1000 * 0.96);
  const sessionTimerTime = data.sessions?.[0]?.total_timer_time;
  const timerSeconds = (Number.isFinite(sessionTimerTime) && sessionTimerTime > 0)
    ? sessionTimerTime
    : duration;

  return {
    records,
    duration,
    timerSeconds,
    distanceKm: lastDistance,
    avgPower,
    maxPower,
    maxHeartRate,
    avgHeartRate,
    calories,
    bestPower: {
      1200: bestRollingAverage(records, 1200),
      300: bestRollingAverage(records, 300),
      60: bestRollingAverage(records, 60),
      15: bestRollingAverage(records, 15),
    },
  };
}

function clean(value) {
  return Number.isFinite(value) ? value : undefined;
}

function bestRollingAverage(records, seconds, field = 'power') {
  let best = 0;
  let sum = 0;
  let validCount = 0;
  let left = 0;
  for (let right = 0; right < records.length; right += 1) {
    const rightValue = records[right][field];
    if (Number.isFinite(rightValue)) {
      sum += rightValue;
      validCount += 1;
    }
    while (records[right].elapsed - records[left].elapsed > seconds) {
      const leftValue = records[left][field];
      if (Number.isFinite(leftValue)) {
        sum -= leftValue;
        validCount -= 1;
      }
      left += 1;
    }
    const span = Math.max(1, records[right].elapsed - records[left].elapsed + 1);
    if (span >= seconds * 0.9 && validCount) best = Math.max(best, sum / validCount);
  }
  if (best === 0) {
    return average(records.map((record) => record[field]));
  }
  return best;
}

function rollingMetric(records, field, windowSeconds) {
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

function rollingPower(records, windowSeconds = 2) {
  return rollingMetric(records, 'power', windowSeconds).map((value) => value || 0);
}

function rollingHeartRate(records, windowSeconds = 3) {
  return rollingMetric(records, 'heartRate', windowSeconds).map((value) => value || NaN);
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function reportFont(size, weight = 900, family = REPORT_FONT) {
  return `${weight} ${size}px ${family}`;
}

function drawPlaceholder() {
  canvas.width = DEFAULT_CANVAS_WIDTH;
  canvas.height = DEFAULT_CANVAS_HEIGHT;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#0d5e9e');
  gradient.addColorStop(1, '#11395f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = '800 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(getMode() === 'ftp-update' ? 'FTP更新画像を作成' : 'FITファイルを選択して画像を作成', w / 2, h / 2);
}

function drawFtpUpdateResult(previousFtp, updatedFtp) {
  canvas.width = 1536;
  canvas.height = 1024;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawFtpUpdateWorldBackground();
  drawFtpUpdateDialog(previousFtp, updatedFtp);
}

function drawFtpUpdateWorldBackground() {
  const sky = ctx.createLinearGradient(0, 0, 0, 450);
  sky.addColorStop(0, '#f28c67');
  sky.addColorStop(0.38, '#ffc37d');
  sky.addColorStop(0.72, '#8fb0ff');
  sky.addColorStop(1, '#5e7ed7');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(248, 188, 128, 0.35)';
  for (let i = 0; i < 15; i += 1) {
    ctx.beginPath();
    ctx.ellipse(360 + i * 28, 150 + Math.sin(i) * 24, 115, 25, -0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  drawMountain(96, 0, 420, 750, '#6f7558', '#384b3c');
  drawMountain(618, 80, 815, 520, '#7fa6f8', '#5678de');
  drawFtpUpdateTrees();

  ctx.fillStyle = '#1e2d63';
  ctx.beginPath();
  ctx.moveTo(18, 1024);
  ctx.lineTo(590, 514);
  ctx.lineTo(942, 514);
  ctx.lineTo(1394, 1024);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#f2c52a';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(136, 1024);
  ctx.lineTo(658, 520);
  ctx.moveTo(179, 1024);
  ctx.lineTo(690, 520);
  ctx.stroke();

  ctx.strokeStyle = '#8ed8ff';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(1248, 1024);
  ctx.lineTo(907, 526);
  ctx.stroke();

  drawFtpUpdateRider();

  ctx.fillStyle = '#f62419';
  ctx.fillRect(0, 0, canvas.width, 29);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
  ctx.fillRect(0, 29, canvas.width, 4);
}

function drawMountain(x, y, width, height, light, dark) {
  const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
  gradient.addColorStop(0, light);
  gradient.addColorStop(1, dark);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.bezierCurveTo(x + width * 0.1, y + height * 0.2, x + width * 0.28, y + height * 0.08, x + width * 0.45, y);
  ctx.bezierCurveTo(x + width * 0.58, y + height * 0.26, x + width * 0.82, y + height * 0.24, x + width, y + height);
  ctx.closePath();
  ctx.fill();
}

function drawFtpUpdateTrees() {
  const grass = ctx.createLinearGradient(0, 420, 0, 1024);
  grass.addColorStop(0, '#1d7c39');
  grass.addColorStop(1, '#47df66');
  ctx.fillStyle = grass;
  ctx.beginPath();
  ctx.moveTo(760, 556);
  ctx.bezierCurveTo(990, 490, 1220, 485, 1536, 404);
  ctx.lineTo(1536, 1024);
  ctx.lineTo(1028, 1024);
  ctx.bezierCurveTo(986, 820, 848, 665, 760, 556);
  ctx.closePath();
  ctx.fill();

  for (let i = 0; i < 32; i += 1) {
    const x = 826 + (i * 73) % 710;
    const y = 72 + (i * 41) % 390;
    const radius = 50 + (i % 5) * 13;
    ctx.fillStyle = i % 3 === 0 ? '#145c31' : '#1f7439';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFtpUpdateRider() {
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.translate(745, 790);
  ctx.strokeStyle = '#101a3d';
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-28, 112);
  ctx.lineTo(8, 14);
  ctx.lineTo(56, 120);
  ctx.moveTo(10, 18);
  ctx.lineTo(-55, 62);
  ctx.moveTo(8, 14);
  ctx.lineTo(70, 49);
  ctx.stroke();
  ctx.fillStyle = '#1774e8';
  roundRect(ctx, -25, -18, 50, 90, 17, '#1774e8');
  ctx.fillStyle = '#f3c1a4';
  ctx.beginPath();
  ctx.arc(7, -48, 23, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111827';
  ctx.beginPath();
  ctx.arc(7, -56, 25, Math.PI, 0);
  ctx.fill();
  ctx.restore();
}

function drawFtpUpdateDialog(previousFtp, updatedFtp) {
  const panelX = 268;
  const panelY = 350;
  const panelW = 916;
  const headerH = 64;
  const bodyH = 328;
  roundRect(ctx, panelX, panelY, panelW, headerH, 8, '#f1f6f6');
  ctx.fillStyle = '#25242e';
  ctx.fillRect(panelX, panelY + headerH, panelW, bodyH);

  ctx.fillStyle = '#342c37';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '900 44px "Arial Rounded MT Bold", "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif';
  ctx.fillText('FTPの向上が検知されました', panelX + panelW / 2, panelY + 47);

  ctx.fillStyle = '#fff';
  ctx.font = '900 27px "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif';
  ctx.fillText('パワー(FTP)の向上が検知され、プロフィールが更新されました！', panelX + panelW / 2, panelY + 121);

  ctx.fillStyle = '#9d9ba5';
  ctx.font = '900 24px "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif';
  ctx.fillText('前回', panelX + 280, panelY + 190);
  ctx.fillStyle = '#ffcf18';
  ctx.fillText('今回', panelX + 636, panelY + 190);

  ctx.font = '950 78px "Arial Black", "Arial Rounded MT Bold", "Hiragino Sans", system-ui, sans-serif';
  ctx.fillStyle = '#f1fbff';
  ctx.fillText(`${previousFtp}w`, panelX + 310, panelY + 279);
  ctx.fillStyle = '#ffffff';
  ctx.font = '950 40px "Arial Black", system-ui, sans-serif';
  ctx.fillText('»', panelX + 456, panelY + 259);
  ctx.fillText('»', panelX + 472, panelY + 259);
  ctx.fillStyle = '#ffcf18';
  ctx.font = '950 78px "Arial Black", "Arial Rounded MT Bold", "Hiragino Sans", system-ui, sans-serif';
  ctx.fillText(`${updatedFtp}w`, panelX + 662, panelY + 279);

  roundRect(ctx, 556, 756, 342, 86, 12, '#fb4d13');
  ctx.fillStyle = '#fff';
  ctx.font = '900 47px "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif';
  ctx.fillText('やったー！', 727, 815);
}

function drawFinishResult(metrics, weight) {
  canvas.width = 470;
  canvas.height = 584;
  roundRect(ctx, 0, 0, 470, 584, 0, '#075f9f');
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.font = '700 48px system-ui, sans-serif';
  ctx.fillText('♛', 235, 84);
  ctx.font = '900 38px system-ui, sans-serif';
  ctx.fillText('完走タイム', 235, 142);
  ctx.font = '900 86px system-ui, sans-serif';
  ctx.fillText(formatDuration(metrics.duration), 235, 260);
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.fillText('パワー', 235, 330);

  const labels = [['20 分', 1200], ['5 分', 300], ['1 分', 60], ['15 秒', 15]];
  labels.forEach(([label, seconds], index) => {
    const x = 95 + index * 90;
    ctx.font = '400 36px system-ui, sans-serif';
    ctx.fillText(calculateWattsPerKg(metrics.bestPower[seconds], weight).toFixed(1), x, 384);
    ctx.font = '400 15px system-ui, sans-serif';
    ctx.fillText(label, x, 420);
  });

  roundRect(ctx, 52, 506, 366, 73, 8, '#f5f5f5');
  roundRect(ctx, 60, 514, 350, 58, 4, '#ff5b1a');
  ctx.font = '900 30px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText('閉じる', 235, 553);
}

function drawRideReport(metrics, options) {
  canvas.width = 1000;
  canvas.height = 642;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f6f6f4';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  roundRect(ctx, 0, 0, 1000, 642, 8, '#f6f6f4');
  ctx.fillStyle = '#2d2d2d';
  ctx.fillRect(0, 0, 1000, 41);
  ctx.fillStyle = '#fff';
  ctx.font = reportFont(37);
  ctx.textAlign = 'center';
  ctx.fillText('ライドレポート', 500, 34);

  drawHeader(metrics, options);
  drawTabs();
  drawTimeline(metrics, options);
  drawLegends();
  drawDistributionPanels(metrics, options);
}


function drawHeader(metrics, { title, level, sp }) {
  ctx.fillStyle = '#27272b';
  ctx.textAlign = 'left';
  ctx.font = reportFont(27, 950, REPORT_NUMBER_FONT);
  ctx.fillText(title, 27, 72);

  const stats = [
    { icon: 'bolt', value: Math.round(metrics.avgPower), unit: 'AVG', x: 37, maxWidth: 178 },
    { icon: 'route', value: metrics.distanceKm.toFixed(1), unit: 'km', x: 240, maxWidth: 155 },
    { icon: 'clock', value: formatReportDuration(metrics.duration), unit: 'ET', x: 414, maxWidth: 150 },
    { icon: null, value: Math.round(metrics.calories), unit: 'KCAL', x: 610, maxWidth: 155 },
    { icon: null, value: sp, unit: 'SP', x: 817, maxWidth: 92 },
  ];
  drawLevelProgress(level);
  drawAvatar();
  stats.forEach((stat) => drawHeaderStat(stat));
}


function drawHeaderStat({ icon, value, unit, x, maxWidth }) {
  ctx.fillStyle = '#24242a';
  ctx.textAlign = 'left';
  const valueX = icon ? x + 32 : x;
  if (icon) drawHeaderIcon(icon, x, 105);
  const text = String(value);
  let fontSize = 39;
  ctx.font = reportFont(fontSize, 900, REPORT_NUMBER_FONT);
  while (ctx.measureText(text).width > maxWidth && fontSize > 29) {
    fontSize -= 1;
    ctx.font = reportFont(fontSize, 900, REPORT_NUMBER_FONT);
  }
  ctx.fillText(text, valueX, 118);
  const unitX = valueX + ctx.measureText(text).width + 5;
  ctx.font = reportFont(12);
  ctx.fillText(unit, unitX, 116);
}

function drawHeaderIcon(type, x, y) {
  ctx.save();
  ctx.fillStyle = '#24242a';
  ctx.strokeStyle = '#24242a';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (type === 'bolt') {
    ctx.beginPath();
    ctx.moveTo(x + 12, y - 16);
    ctx.lineTo(x + 2, y + 2);
    ctx.lineTo(x + 13, y + 2);
    ctx.lineTo(x + 8, y + 20);
    ctx.lineTo(x + 24, y - 4);
    ctx.lineTo(x + 13, y - 4);
    ctx.closePath();
    ctx.fill();
  } else if (type === 'route') {
    ctx.beginPath();
    ctx.arc(x + 6, y + 8, 4, 0, Math.PI * 2);
    ctx.arc(x + 24, y - 8, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 10, y + 5);
    ctx.bezierCurveTo(x + 14, y - 10, x + 17, y + 8, x + 21, y - 5);
    ctx.stroke();
  } else if (type === 'clock') {
    ctx.beginPath();
    ctx.arc(x + 13, y, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 13, y);
    ctx.lineTo(x + 13, y - 8);
    ctx.moveTo(x + 13, y);
    ctx.lineTo(x + 20, y + 4);
    ctx.stroke();
  }

  ctx.restore();
}

function drawLevelProgress(level) {
  roundRect(ctx, 27, 133, 63, 16, 8, '#30343a');
  ctx.fillStyle = '#fff';
  ctx.font = reportFont(12);
  ctx.textAlign = 'center';
  ctx.fillText(`🚴 ${level}`, 58, 146);
  roundRect(ctx, 96, 133, 878, 16, 8, '#c9c9c9');
  roundedLeftRect(ctx, 96, 133, 37, 16, 8, '#ff5b1a');
  ctx.fillStyle = '#151515';
  ctx.font = reportFont(12);
  ctx.textAlign = 'right';
  ctx.fillText('次のレベルまで 19192 XP', 966, 146);
}

function drawAvatar() {
  ctx.save();
  ctx.translate(916, 54);
  ctx.rotate(-0.12);
  roundRect(ctx, -53, -1, 69, 38, 9, '#2f8ef4');
  ctx.fillStyle = '#fff';
  ctx.font = reportFont(20);
  ctx.textAlign = 'center';
  ctx.fillText('GO!', -18, 25);
  ctx.restore();

  ctx.save();
  ctx.translate(944, 101);
  ctx.fillStyle = '#d9a47d';
  ctx.beginPath();
  ctx.arc(0, 0, 29, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1f2937';
  ctx.beginPath();
  ctx.arc(2, -16, 31, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#ff5b1a';
  ctx.fillRect(-28, -18, 56, 8);
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.moveTo(-28, -7);
  ctx.lineTo(25, -14);
  ctx.lineTo(20, 1);
  ctx.lineTo(-22, 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#37d5ff';
  ctx.beginPath();
  ctx.moveTo(-20, -5);
  ctx.lineTo(0, -8);
  ctx.lineTo(-1, 7);
  ctx.lineTo(-16, 8);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(4, -9);
  ctx.lineTo(24, -12);
  ctx.lineTo(18, 3);
  ctx.lineTo(4, 5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#7c3f24';
  ctx.beginPath();
  ctx.arc(20, 11, 9, -0.3, 1.4);
  ctx.strokeStyle = '#7c3f24';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();
}

function drawTabs() {
  const y = 160;
  roundRect(ctx, 215, y, 570, 22, 4, '#000');
  ctx.fillStyle = '#ff5b1a';
  ctx.fillRect(406, y, 190, 22);
  [['全般', 310], ['タイムライン', 501], ['クリティカルパワー', 688]].forEach(([label, x]) => {
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = label === 'タイムライン' ? 1 : 0.42;
    ctx.font = reportFont(13);
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y + 16);
    ctx.globalAlpha = 1;
  });
}

function drawTimeline(metrics, { ftp, maxHrSetting, graphSmoothness, powerGraphHeight, graphLineWidth }) {
  const x = 27;
  const y = 195;
  const width = 948;
  const height = 198;
  roundRect(ctx, x, y, width, height, 10, '#2d2d2d');
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 10);
  ctx.clip();
  const { powerWindow, heartWindow, maxSamples } = getTimelineLevelingConfig(metrics, graphSmoothness, width);

  const averagedPowers = rollingPower(metrics.records, powerWindow);
  const powers = downsampleSeries(averagedPowers, maxSamples);
  const powerBars = downsampleSeries(averagedPowers, getTimelineBarMaxSamples(width, maxSamples));
  const maxDisplayedPowerIndex = averagedPowers.reduce((maxI, p, i) => (Number.isFinite(p) && p > (averagedPowers[maxI] ?? 0) ? i : maxI), 0);
  const maxDisplayedPower = averagedPowers[maxDisplayedPowerIndex] ?? 0;
  const maxGraphPower = Math.max(ftp * 1.45, maxDisplayedPower, 1);

  // Keep the filled bar layer to one sample per drawable pixel. At the -20
  // detail setting the line can use every activity record, but drawing thousands
  // of semi-transparent 1px bars into a 948px area overpaints the same pixels and
  // makes the graph look darker/noisy.
  const barCount = Math.max(1, powerBars.length);
  const powerGraphDrawHeight = getPowerGraphDrawHeight(height, powerGraphHeight);
  powerBars.forEach((p, index) => {
    const barH = Math.min(height - 5, (p / maxGraphPower) * powerGraphDrawHeight);
    const barX = x + Math.round((index * width) / barCount);
    const nextBarX = x + Math.round(((index + 1) * width) / barCount);
    ctx.fillStyle = zoneColor(p, ftp);
    ctx.globalAlpha = 0.82;
    ctx.fillRect(barX, y + height - barH, Math.max(1, nextBarX - barX), barH);
  });
  ctx.globalAlpha = 1;
  const { lineWidth: baseLineWidth, shadowWidth: baseShadowWidth } = getDurationBasedGraphLineWidths(metrics);
  // Keep smoothing independent from white-line thickness while preserving the duration-based default.
  const lineWidthMultiplier = getGraphLineWidthMultiplier(graphLineWidth);
  drawPowerLine(
    powers,
    x,
    y,
    width,
    height,
    maxGraphPower,
    powerGraphDrawHeight,
    baseLineWidth * lineWidthMultiplier,
    baseShadowWidth * lineWidthMultiplier,
  );
  const hrs = downsampleSeries(rollingHeartRate(metrics.records, heartWindow), maxSamples);
  const heartLineMin = Math.max(0, Math.min(metrics.avgHeartRate - 50, metrics.maxHeartRate - 92));
  const heartLineMax = Math.max(maxHrSetting * 0.78, metrics.maxHeartRate + 12);
  const heartLineY = y + 28;
  const heartLineHeight = height - 84;
  drawSeries(
    hrs,
    x,
    heartLineY,
    width,
    heartLineHeight,
    heartLineMax,
    '#e51f23',
    1.7,
    heartLineMin,
    HEART_LINE_AMPLITUDE_SCALE,
  );

  ctx.restore();

  if (maxDisplayedPower > 0) {
    const peakDownsampledIndex = Math.min(powers.length - 1, Math.floor(maxDisplayedPowerIndex * powers.length / averagedPowers.length));
    const maxPowerX = x + (peakDownsampledIndex + 0.5) * (width / Math.max(1, powers.length));
    const maxPowerY = getPowerLineY(maxDisplayedPower, y, height, maxGraphPower, powerGraphDrawHeight);
    const centerElapsed = metrics.records[maxDisplayedPowerIndex]?.elapsed;
    const peakOneSec = metrics.records.reduce((max, record) => {
      if (!Number.isFinite(record.power) || !Number.isFinite(record.elapsed) || !Number.isFinite(centerElapsed)) return max;
      return Math.abs(record.elapsed - centerElapsed) <= powerWindow ? Math.max(max, record.power) : max;
    }, metrics.records[maxDisplayedPowerIndex]?.power ?? maxDisplayedPower);
    drawPeakLabel(`${Math.round(peakOneSec)}w`, maxPowerX, maxPowerY - 16, '#fff', '#ffb21a', y + 16, y + height - 22);
  }
  const maxHeartRatePeak = findMaxHeartRateRecord(metrics.records);
  if (maxHeartRatePeak) {
    const hrDownsampledIndex = Math.min(hrs.length - 1, Math.floor(maxHeartRatePeak.index * hrs.length / metrics.records.length));
    const maxHrX = x + (hrDownsampledIndex / Math.max(1, hrs.length - 1)) * width;
    const maxHrY = getSeriesY(
      maxHeartRatePeak.heartRate,
      heartLineY,
      heartLineHeight,
      heartLineMax,
      heartLineMin,
      HEART_LINE_AMPLITUDE_SCALE,
    );
    drawPeakLabel(`${Math.round(maxHeartRatePeak.heartRate)}bpm`, maxHrX, maxHrY - 16, '#fff', '#e11f28', y + 16, y + height - 22);
  }
}


function findMaxPowerRecord(records) {
  let peak = null;
  records.forEach((record, index) => {
    if (!Number.isFinite(record?.power)) return;
    if (!peak || record.power > peak.power) {
      peak = { record, index, power: record.power };
    }
  });
  return peak;
}


function findMaxHeartRateRecord(records) {
  let peak = null;
  records.forEach((record, index) => {
    if (!Number.isFinite(record?.heartRate)) return;
    if (!peak || record.heartRate > peak.heartRate) {
      peak = { record, index, heartRate: record.heartRate };
    }
  });
  return peak;
}

function getTimelineRecordX(record, records, x, width) {
  if (!record || !records.length) return x;

  const firstElapsed = records.find((item) => Number.isFinite(item?.elapsed))?.elapsed;
  const lastElapsed = [...records].reverse().find((item) => Number.isFinite(item?.elapsed))?.elapsed;
  if (Number.isFinite(record.elapsed) && Number.isFinite(firstElapsed) && Number.isFinite(lastElapsed) && lastElapsed > firstElapsed) {
    const progress = (record.elapsed - firstElapsed) / (lastElapsed - firstElapsed);
    return x + clamp01(progress) * width;
  }

  const index = Math.max(0, records.indexOf(record));
  return x + (index / Math.max(1, records.length - 1)) * width;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function getSeriesY(value, y, height, max, min = 0, amplitudeScale = 1) {
  const rawY = y + height - ((value - min) / Math.max(1, max - min)) * height;
  const centerY = y + height / 2;
  return centerY + (rawY - centerY) * amplitudeScale;
}

function getPowerLineY(value, y, height, max, drawHeight = height - 58) {
  return y + height - (value / Math.max(1, max)) * drawHeight;
}

function getPowerGraphDrawHeight(height, powerGraphHeight) {
  const baseHeight = height - 58;
  const multiplier = 1 + clampPowerGraphHeight(powerGraphHeight) / 100;
  return Math.max(height * 0.2, Math.min(height - 5, baseHeight * multiplier));
}

function drawPowerLine(values, x, y, width, height, max, drawHeight = height - 58, lineWidth = 1.7, shadowWidth = 3.6) {
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  drawPowerLineStroke(values, x, y, width, height, max, drawHeight, 'rgba(45,45,45,.5)', shadowWidth);
  drawPowerLineStroke(values, x, y, width, height, max, drawHeight, '#f8f8f2', lineWidth);
  ctx.restore();
}

function drawPowerLineStroke(values, x, y, width, height, max, drawHeight, color, lineWidth) {
  if (!Number.isFinite(lineWidth) || lineWidth <= 0) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  let started = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const px = x + (index + 0.5) * (width / Math.max(1, values.length));
    const py = getPowerLineY(value, y, height, max, drawHeight);
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.stroke();
}

function downsampleSeries(values, maxPoints, strategy = 'average') {
  if (values.length <= maxPoints) return values;
  const result = [];
  const ratio = values.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    if (strategy === 'nearest') {
      const index = Math.min(values.length - 1, Math.floor((i + 0.5) * ratio));
      result.push(values[index]);
      continue;
    }

    const start = Math.floor(i * ratio);
    const end = Math.min(values.length, Math.floor((i + 1) * ratio));
    const slice = values.slice(start, end).filter(Number.isFinite);
    result.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : NaN);
  }
  return result;
}

function drawSeries(values, x, y, width, height, max, color, lineWidth, min = 0, amplitudeScale = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  let started = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const px = x + (index / Math.max(1, values.length - 1)) * width;
    const py = getSeriesY(value, y, height, max, min, amplitudeScale);
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.stroke();
}

function drawPeakLabel(text, x, y, color, pointerColor, minY = -Infinity, maxY = Infinity) {
  const labelY = Math.max(minY, Math.min(maxY, y));
  ctx.fillStyle = color;
  ctx.font = reportFont(13);
  ctx.textAlign = 'center';
  ctx.fillText(text, x, labelY);
  ctx.fillStyle = pointerColor;
  ctx.beginPath();
  ctx.moveTo(x - 4, labelY + 6);
  ctx.lineTo(x + 4, labelY + 6);
  ctx.lineTo(x, labelY + 13);
  ctx.closePath();
  ctx.fill();
}

function drawLegends() {
  const items = [['パワー', true], ['ケイデンス', false], ['心拍数', true]];
  let x = 37;
  const y = 414;
  items.forEach(([label, active]) => {
    ctx.strokeStyle = '#bdbdbd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + 9, y, 7, 0, Math.PI * 2);
    ctx.stroke();
    if (active) {
      ctx.fillStyle = '#ff5b1a';
      ctx.beginPath();
      ctx.arc(x + 9, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#111';
    ctx.font = reportFont(17);
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 20, y + 7);
    x += label === 'ケイデンス' ? 120 : 92;
  });
}

function drawDistributionPanels(metrics, options) {
  const panelBottomY = 588;
  roundRect(ctx, 27, 430, 449, 158, 9, '#2d2d2d');
  roundRect(ctx, 525, 430, 449, 158, 9, '#2d2d2d');
  ctx.fillStyle = '#fff';
  ctx.font = reportFont(19);
  ctx.textAlign = 'center';
  ctx.fillText('パワー分布', 251, 452);
  ctx.fillText('心拍数分布', 749, 452);
  drawPowerHistogram(metrics, 34, 464, 436, 112, 610, panelBottomY);
  drawHeartHistogram(metrics, options, 525, 452, 449, 124, 610, panelBottomY);
  drawDistributionUnit(251, 628, 'ワット');
  drawDistributionUnit(749, 628, 'bpm');
}

function drawPowerHistogram(metrics, x, y, width, height, axisY, panelBottomY) {
  const powerValues = metrics.records.map((r) => r.power).filter((value) => Number.isFinite(value) && value >= 100);
  const maxPowerAxis = getPowerHistogramMax(powerValues);
  const bins = makeHistogram(powerValues, 100, maxPowerAxis, 36);
  const maxBin = Math.max(...bins, 1);
  const baselineY = panelBottomY;
  ctx.fillStyle = '#fff';
  bins.forEach((count, i) => {
    const barW = width / bins.length + 0.5;
    const barH = count ? Math.max(5, (count / maxBin) * (baselineY - y - 24)) : 0;
    roundedTopRect(ctx, x + i * (width / bins.length), baselineY - barH, barW, barH, 10, '#fff');
  });
  drawAxisLabels(x, axisY, width, makeLinearLabels(100, maxPowerAxis, 11));
  const avgX = x + ((metrics.avgPower - 100) / Math.max(1, maxPowerAxis - 100)) * width;
  ctx.strokeStyle = '#8c8f93';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(avgX, y + 34);
  ctx.lineTo(avgX, baselineY);
  ctx.stroke();
  badge(`AVG
${Math.round(metrics.avgPower)}`, avgX, y + 18);
}

function getPowerHistogramMax(values) {
  const maxValue = Math.max(...values, 600);
  if (maxValue <= 600) return 600;
  return Math.min(2000, Math.ceil(maxValue / 100) * 100);
}

function drawHeartHistogram(metrics, { maxHrSetting }, x, y, width, height, axisY, panelBottomY) {
  const displayMinHr = Math.max(40, Math.round((maxHrSetting * 0.32) / 5) * 5);
  const zoneThresholds = [
    0.5 * maxHrSetting,
    0.6 * maxHrSetting,
    0.7 * maxHrSetting,
    0.8 * maxHrSetting,
    0.9 * maxHrSetting,
    maxHrSetting,
  ];
  const linearHrToX = (value) => x + ((value - displayMinHr) / Math.max(1, maxHrSetting - displayMinHr)) * width;
  const colors = ['#338cf0', '#58b957', '#ffd342', '#ff6538', '#ff2f1d'];
  const zoneStartX = Math.max(x, linearHrToX(zoneThresholds[0]));
  const zoneWidthUnit = (x + width - zoneStartX) / 5;
  const zoneWidths = [1.5, 1, 1, 1, 0.5].map((ratio) => ratio * zoneWidthUnit);
  const hrToX = (value) => {
    const clampedValue = Math.max(displayMinHr, Math.min(maxHrSetting, value));
    if (clampedValue <= zoneThresholds[0]) {
      return x + ((clampedValue - displayMinHr) / Math.max(1, zoneThresholds[0] - displayMinHr)) * (zoneStartX - x);
    }
    const zoneIndex = Math.min(
      zoneWidths.length - 1,
      Math.max(0, zoneThresholds.findIndex((threshold, index) => index > 0 && clampedValue <= threshold) - 1),
    );
    const zoneMin = zoneThresholds[zoneIndex];
    const zoneMax = zoneThresholds[zoneIndex + 1];
    const zoneX = zoneStartX + zoneWidths.slice(0, zoneIndex).reduce((sum, zoneWidth) => sum + zoneWidth, 0);
    return zoneX + ((clampedValue - zoneMin) / Math.max(1, zoneMax - zoneMin)) * zoneWidths[zoneIndex];
  };
  const xToHr = (position) => {
    if (position <= zoneStartX) {
      return displayMinHr + ((position - x) / Math.max(1, zoneStartX - x)) * (zoneThresholds[0] - displayMinHr);
    }
    let zoneX = zoneStartX;
    for (let i = 0; i < zoneWidths.length; i += 1) {
      const nextZoneX = i === zoneWidths.length - 1 ? x + width : zoneX + zoneWidths[i];
      if (position <= nextZoneX || i === zoneWidths.length - 1) {
        return zoneThresholds[i] + ((position - zoneX) / Math.max(1, nextZoneX - zoneX)) * (zoneThresholds[i + 1] - zoneThresholds[i]);
      }
      zoneX = nextZoneX;
    }
    return maxHrSetting;
  };
  const axisLabels = Array.from({ length: 11 }, (_, index) => {
    const labelX = x + (index / 10) * width;
    return { label: String(Math.round(xToHr(labelX))), x: labelX };
  });
  let zoneX = zoneStartX;
  colors.forEach((color, i) => {
    const start = zoneX;
    const end = i === colors.length - 1 ? x + width : Math.min(x + width, start + zoneWidths[i]);
    zoneX = end;
    if (end <= start) return;
    ctx.fillStyle = color;
    ctx.fillRect(start, y, end - start, panelBottomY - y);
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#fff';
    ctx.font = reportFont(13);
    ctx.textAlign = 'center';
    ctx.fillText(`Z${i + 1}`, start + (end - start) / 2, y + 17);
    ctx.globalAlpha = 1;
  });
  const values = metrics.records.map((r) => r.heartRate).filter(Number.isFinite);
  const bins = makeMappedHistogram(values, 30, (value) => hrToX(value), x, width);
  const maxBin = Math.max(...bins, 1);
  const baselineY = panelBottomY;
  ctx.fillStyle = '#fff';
  bins.forEach((count, i) => {
    const barW = width / bins.length + 0.5;
    const barX = x + i * (width / bins.length);
    const barH = count ? Math.max(7, (count / maxBin) * (baselineY - y - 42)) : 0;
    roundedTopRect(ctx, barX, baselineY - barH, barW, barH, 10, '#fff');
  });
  drawAxisLabelsAt(axisY, axisLabels);
  const avgX = hrToX(metrics.avgHeartRate);
  ctx.strokeStyle = '#8c8f93';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(avgX, y + 34);
  ctx.lineTo(avgX, baselineY);
  ctx.stroke();
  badge(`AVG
${Math.round(metrics.avgHeartRate)}`, avgX, y + 28);
}

function makeLinearLabels(min, max, count) {
  return Array.from({ length: count }, (_, index) => {
    const value = min + ((max - min) * index) / Math.max(1, count - 1);
    return String(Math.round(value));
  });
}

function makeHistogram(values, min, max, bins) {
  const hist = Array.from({ length: bins }, () => 0);
  values.forEach((value) => {
    if (!Number.isFinite(value)) return;
    const index = Math.max(0, Math.min(bins - 1, Math.floor(((value - min) / Math.max(1, max - min)) * bins)));
    hist[index] += 1;
  });
  return hist;
}

function makeMappedHistogram(values, bins, mapValueToX, x, width) {
  const hist = Array.from({ length: bins }, () => 0);
  values.forEach((value) => {
    if (!Number.isFinite(value)) return;
    const mappedX = mapValueToX(value);
    const index = Math.max(0, Math.min(bins - 1, Math.floor(((mappedX - x) / Math.max(1, width)) * bins)));
    hist[index] += 1;
  });
  return hist;
}

function drawAxisLabels(x, y, width, labels) {
  ctx.fillStyle = '#1c1c1c';
  ctx.font = reportFont(11, 900, REPORT_NUMBER_FONT);
  ctx.textAlign = 'center';
  labels.forEach((label, i) => ctx.fillText(label, x + (i / (labels.length - 1)) * width, y));
}

function drawAxisLabelsAt(y, labels) {
  ctx.fillStyle = '#1c1c1c';
  ctx.font = reportFont(11, 900, REPORT_NUMBER_FONT);
  ctx.textAlign = 'center';
  labels.forEach(({ label, x }) => ctx.fillText(label, x, y));
}

function drawDistributionUnit(x, y, unit) {
  ctx.fillStyle = '#1c1c1c';
  ctx.font = reportFont(14);
  ctx.textAlign = 'center';
  ctx.fillText(unit, x, y);
}

function badge(text, x, y) {
  const lines = text.split('\n');
  roundRect(ctx, x - 20, y - 20, 40, 38, 8, '#8a8d91');
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = reportFont(9);
  ctx.fillText(lines[0], x, y - 7);
  ctx.font = reportFont(17, 900, REPORT_NUMBER_FONT);
  ctx.fillText(lines[1], x, y + 11);
}

function zoneColor(power, ftp) {
  const ratio = power / ftp;
  if (ratio < 0.55) return '#8b8f91';
  if (ratio < 0.75) return '#2d73b8';
  if (ratio < 0.9) return '#5a9e45';
  if (ratio < 1.05) return '#c4a927';
  if (ratio < 1.2) return '#d95f21';
  return '#bf2b20';
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatReportDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function roundRect(context, x, y, width, height, radius, fillStyle) {
  context.fillStyle = fillStyle;
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function roundedTopRect(context, x, y, width, height, radius, fillStyle) {
  const r = Math.min(radius, width / 2, height);
  context.fillStyle = fillStyle;
  context.beginPath();
  context.moveTo(x, y + height);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height);
  context.closePath();
  context.fill();
}

function roundedLeftRect(context, x, y, width, height, radius, fillStyle) {
  const r = Math.min(radius, width, height / 2);
  context.fillStyle = fillStyle;
  context.beginPath();
  context.moveTo(x + width, y);
  context.lineTo(x + r, y);
  context.quadraticCurveTo(x, y, x, y + r);
  context.lineTo(x, y + height - r);
  context.quadraticCurveTo(x, y + height, x + r, y + height);
  context.lineTo(x + width, y + height);
  context.closePath();
  context.fill();
}

syncGraphSmoothnessSliderDefault();
syncPowerGraphHeightSliderDefault();
syncGraphLineWidthSliderDefault();
drawPlaceholder();
