import FitParser from 'fit-file-parser';

const $ = (selector) => document.querySelector(selector);

const state = { sourceData: null, metrics: null, downloadUrl: null, downloadBlob: null, downloadFileName: 'zwift-result.png' };
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const fileInput = $('#fitFile');
const fileDrop = $('#fileDrop');

$('input[name="mode"][value="finish"]').addEventListener('change', syncMode);
$('input[name="mode"][value="report"]').addEventListener('change', syncMode);
fileDrop.addEventListener('keydown', handleFileDropKeydown);
fileDrop.addEventListener('dragover', handleFileDragOver);
fileDrop.addEventListener('dragleave', handleFileDragLeave);
fileDrop.addEventListener('drop', handleFileDrop);
fileInput.addEventListener('change', handleFile);
$('#generate').addEventListener('click', generateImage);
$('#download').addEventListener('click', savePng);

function syncMode() {
  const mode = getMode();
  $('#finishInputs').classList.toggle('hidden', mode !== 'finish');
  $('#reportInputs').classList.toggle('hidden', mode !== 'report');
  $('#download').classList.add('disabled');
  drawPlaceholder();
}

async function handleFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  await processSelectedFile(file);
}

function openFilePicker() {
  fileInput.click();
}

function handleFileDropKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  openFilePicker();
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
    setStatus('FITまたはCSVファイルをドロップしてください。', true);
    return;
  }
  await processSelectedFile(file);
}

async function processSelectedFile(file) {
  $('#fileName').textContent = file.name;
  $('#download').classList.add('disabled');
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
    state.downloadBlob = null;
  }

  const fileType = getFileType(file);
  setStatus(`${fileType.label}ファイルを読み込み中…`);
  try {
    state.sourceData = await parseActivityFile(file, fileType);
    state.metrics = extractMetrics(state.sourceData, fileType.label);
    setStatus(`${state.metrics.records.length.toLocaleString()}点の記録を読み込みました。画像を作成できます。`);
    $('#summary').textContent = `${formatDuration(state.metrics.duration)} / ${Math.round(state.metrics.avgPower)}W avg`;
  } catch (error) {
    state.sourceData = null;
    state.metrics = null;
    $('#summary').textContent = '';
    setStatus(`${fileType.label}ファイルを読み込めませんでした: ${formatError(error)}`, true);
  }
}


function getFileType(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || /(?:^|\/)csv$|text\/plain/.test(file.type)) return { label: 'CSV', type: 'csv' };
  return { label: 'FIT', type: 'fit' };
}

function isSupportedActivityFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.fit') || name.endsWith('.csv') || ['text/csv', 'application/csv', 'application/vnd.ant.fit', 'application/octet-stream'].includes(file.type);
}

async function parseActivityFile(file, fileType) {
  if (fileType.type === 'csv') return parseCsvText(await file.text());
  return parseFitBuffer(await file.arrayBuffer());
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


function parseCsvText(text) {
  const rows = parseCsvRows(text).filter((row) => row.some((cell) => cell.trim() !== ''));
  if (rows.length < 2) throw new Error('CSVにヘッダー行とデータ行が必要です。');

  const headers = rows[0].map(normalizeHeader);
  const records = rows.slice(1).map((row, index) => csvRowToRecord(headers, row, index)).filter(Boolean);
  if (!records.length) throw new Error('CSVに読み取り可能な時系列レコードがありません。');

  const caloriesHeader = findHeader(headers, [['calories'], ['kcal'], ['calorie']]);
  const calories = caloriesHeader
    ? lastFinite(rows.slice(1).map((row) => parseNumber(row[caloriesHeader.index])))
    : undefined;

  return {
    records,
    sessions: Number.isFinite(calories) ? [{ total_calories: calories }] : [],
  };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function csvRowToRecord(headers, row, index) {
  const timestampInfo = findHeader(headers, [
    ['timestamp'], ['time'], ['datetime'], ['date'], ['starttime'], ['recordedat'], ['localtime'], ['時間'], ['日時'], ['時刻'],
  ]);
  const elapsedInfo = findHeader(headers, [
    ['elapsedtime'], ['elapsed'], ['duration'], ['seconds'], ['sec'], ['timeoffset'], ['経過時間'], ['経過秒'],
  ]);

  const elapsed = elapsedInfo ? parseDuration(row[elapsedInfo.index]) : undefined;
  const timestamp = timestampInfo ? parseTimestamp(row[timestampInfo.index], elapsed, index) : undefined;
  const fallbackTimestamp = Number.isFinite(elapsed) ? new Date(elapsed * 1000) : new Date(index * 1000);

  const distance = readCsvMetric(headers, row, [['distance'], ['dist'], ['km'], ['距離']]);
  const speed = readCsvMetric(headers, row, [['speed'], ['velocity'], ['kph'], ['kmh'], ['km/h'], ['速度']]);

  return {
    timestamp: timestamp || fallbackTimestamp,
    elapsed: Number.isFinite(elapsed) ? elapsed : undefined,
    power: readCsvNumber(headers, row, [['power'], ['watts'], ['watt'], ['w'], ['パワー']]),
    heart_rate: readCsvNumber(headers, row, [['heartrate'], ['heart rate'], ['hr'], ['bpm'], ['心拍'], ['心拍数']]),
    cadence: readCsvNumber(headers, row, [['cadence'], ['rpm'], ['ケイデンス']]),
    distance: normalizeDistance(distance),
    speed: normalizeSpeed(speed),
  };
}

function normalizeHeader(header) {
  return header.trim().toLowerCase().replace(/^\ufeff/, '').replace(/[\s_()\[\]{}.-]/g, '');
}

function findHeader(headers, candidates) {
  const normalizedCandidates = candidates.map((candidate) => candidate.map(normalizeHeader));
  for (const candidate of normalizedCandidates) {
    const index = headers.findIndex((header) => candidate.some((term) => header === term || header.includes(term)));
    if (index !== -1) return { index, header: headers[index] };
  }
  return undefined;
}

function readCsvNumber(headers, row, candidates) {
  return readCsvMetric(headers, row, candidates)?.value;
}

function readCsvMetric(headers, row, candidates) {
  const header = findHeader(headers, candidates);
  if (!header) return undefined;
  return { header: header.header, value: parseNumber(row[header.index]) };
}

function parseNumber(value) {
  if (value == null) return undefined;
  const normalized = String(value).trim().replace(/,/g, '');
  if (!normalized) return undefined;
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : undefined;
}

function parseDuration(value) {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  const timeParts = normalized.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.\d+)?$/);
  if (timeParts) {
    const [, hours = '0', minutes, seconds] = timeParts;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  }
  return parseNumber(normalized);
}

function parseTimestamp(value, elapsed, index) {
  if (value == null || String(value).trim() === '') return undefined;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  if (Number.isFinite(elapsed)) return new Date(elapsed * 1000);
  const duration = parseDuration(value);
  return Number.isFinite(duration) ? new Date(duration * 1000) : new Date(index * 1000);
}

function normalizeDistance(metric) {
  if (!Number.isFinite(metric?.value)) return undefined;
  return /(?:^|[^k])m$|meter|metre/.test(metric.header) ? metric.value / 1000 : metric.value;
}

function normalizeSpeed(metric) {
  if (!Number.isFinite(metric?.value)) return undefined;
  return /m\/s|meterpersecond|metrepersecond/.test(metric.header) ? metric.value * 3.6 : metric.value;
}

function lastFinite(values) {
  return [...values].reverse().find(Number.isFinite);
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
  if (!state.metrics) {
    setStatus('先にFITまたはCSVファイルを選択してください。', true);
    return;
  }
  if (getMode() === 'finish') {
    const weight = Number($('#weight').value);
    if (!weight) return setStatus('体重を入力してください。', true);
    drawFinishResult(state.metrics, weight);
  } else {
    const title = $('#rideTitle').value.trim();
    const ftp = Number($('#ftp').value);
    const maxHrSetting = Number($('#maxHrSetting').value);
    if (!title || !ftp || !maxHrSetting) return setStatus('タイトル、FTP、最大心拍数を入力してください。', true);
    drawRideReport(state.metrics, { title, ftp, maxHrSetting });
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

function isSmartphoneDevice() {
  return /Android|iPhone|iPod|Windows Phone/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && matchMedia('(max-width: 767px)').matches);
}

function setStatus(message, isError = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', isError);
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

  const powers = records.map((r) => r.power ?? 0);
  const heartRates = records.map((r) => r.heartRate).filter(Number.isFinite);
  const duration = Math.max(...records.map((r) => r.elapsed));
  const lastDistance = [...records].reverse().find((r) => Number.isFinite(r.distance))?.distance ?? 0;
  const avgPower = average(powers);
  const maxPower = Math.max(...powers);
  const maxHeartRate = heartRates.length ? Math.max(...heartRates) : 0;
  const avgHeartRate = heartRates.length ? average(heartRates) : 0;
  const calories = data.sessions?.[0]?.total_calories ?? Math.round(avgPower * duration / 1000 * 0.96);

  return {
    records,
    duration,
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

function bestRollingAverage(records, seconds) {
  let best = 0;
  let sum = 0;
  let left = 0;
  for (let right = 0; right < records.length; right += 1) {
    sum += records[right].power ?? 0;
    while (records[right].elapsed - records[left].elapsed > seconds) {
      sum -= records[left].power ?? 0;
      left += 1;
    }
    const span = Math.max(1, records[right].elapsed - records[left].elapsed + 1);
    if (span >= seconds * 0.9) best = Math.max(best, sum / (right - left + 1));
  }
  return best;
}

function rollingMetric(records, field, windowSize) {
  return records.map((record, index) => {
    const from = Math.max(0, index - windowSize + 1);
    return average(records.slice(from, index + 1).map((r) => r[field]));
  });
}

function rollingPower(records, windowSize = 2) {
  return rollingMetric(records, 'power', windowSize).map((value) => value || 0);
}

function rollingHeartRate(records, windowSize = 3) {
  return rollingMetric(records, 'heartRate', windowSize).map((value) => value || NaN);
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function drawPlaceholder() {
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
  ctx.fillText('FIT/CSVファイルを選択して画像を作成', w / 2, h / 2);
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
    ctx.fillText((metrics.bestPower[seconds] / weight).toFixed(1), x, 384);
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
  ctx.font = '900 36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ライドレポート', 500, 34);

  drawHeader(metrics, options);
  drawTabs();
  drawTimeline(metrics, options);
  drawLegends();
  drawDistributionPanels(metrics, options);
}

function drawHeader(metrics, { title }) {
  ctx.fillStyle = '#27272b';
  ctx.textAlign = 'left';
  ctx.font = '900 27px system-ui, sans-serif';
  ctx.fillText(title, 27, 72);

  const stats = [
    { icon: '⚡', value: Math.round(metrics.avgPower), unit: 'AVG', x: 37, maxWidth: 178 },
    { icon: '〽', value: metrics.distanceKm.toFixed(1), unit: 'km', x: 240, maxWidth: 155 },
    { icon: '◷', value: formatDuration(metrics.duration), unit: 'ET', x: 414, maxWidth: 175 },
    { icon: '', value: Math.round(metrics.calories), unit: 'KCAL', x: 610, maxWidth: 155 },
    { icon: '', value: '86', unit: 'SP', x: 817, maxWidth: 92 },
  ];
  stats.forEach((stat) => drawHeaderStat(stat));

  drawLevelProgress();
  drawAvatar();
}


function drawHeaderStat({ icon, value, unit, x, maxWidth }) {
  ctx.fillStyle = '#24242a';
  ctx.textAlign = 'left';
  const prefix = icon ? `${icon} ` : '';
  const text = `${prefix}${value}`;
  let fontSize = 40;
  ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
  while (ctx.measureText(text).width > maxWidth && fontSize > 30) {
    fontSize -= 1;
    ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
  }
  ctx.fillText(text, x, 118);
  const unitX = x + ctx.measureText(text).width + 4;
  ctx.font = '900 15px system-ui, sans-serif';
  ctx.fillText(unit, unitX, 118);
}

function drawLevelProgress() {
  roundRect(ctx, 27, 133, 63, 16, 8, '#30343a');
  ctx.fillStyle = '#fff';
  ctx.font = '900 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🚴 101', 58, 146);
  roundRect(ctx, 96, 133, 878, 16, 8, '#c9c9c9');
  ctx.fillStyle = '#ff5b1a';
  ctx.fillRect(96, 133, 37, 16);
  ctx.fillStyle = '#151515';
  ctx.font = '900 13px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('次のレベルまで 19192 XP', 966, 146);
}

function drawAvatar() {
  ctx.save();
  ctx.translate(916, 54);
  ctx.rotate(-0.12);
  roundRect(ctx, -53, -1, 69, 38, 9, '#d64a22');
  ctx.fillStyle = '#fff';
  ctx.font = '900 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NICE!', -18, 26);
  ctx.restore();

  ctx.save();
  ctx.translate(944, 101);
  ctx.fillStyle = '#f0c7a2';
  ctx.beginPath();
  ctx.arc(0, 0, 29, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d8d8d8';
  ctx.beginPath();
  ctx.arc(2, -16, 31, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.moveTo(-28, -7);
  ctx.lineTo(25, -14);
  ctx.lineTo(20, 1);
  ctx.lineTo(-22, 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#42e12f';
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
    ctx.font = '900 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y + 16);
    ctx.globalAlpha = 1;
  });
}

function drawTimeline(metrics, { ftp, maxHrSetting }) {
  const x = 27;
  const y = 195;
  const width = 948;
  const height = 214;
  roundRect(ctx, x, y, width, height, 10, '#2d2d2d');
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 10);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,.035)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x, y + (height * i) / 5);
    ctx.lineTo(x + width, y + (height * i) / 5);
    ctx.stroke();
  }
  const powers = rollingPower(metrics.records, 2);
  const maxGraphPower = Math.max(ftp * 1.45, metrics.maxPower, 1);
  metrics.records.forEach((record, index) => {
    const px = x + (index / Math.max(1, metrics.records.length - 1)) * width;
    const barW = Math.max(1, width / metrics.records.length + 0.25);
    const p = powers[index];
    const barH = Math.min(height - 5, (p / maxGraphPower) * (height - 34));
    ctx.fillStyle = zoneColor(p, ftp);
    ctx.globalAlpha = 0.82;
    ctx.fillRect(px, y + height - barH, barW, barH);
  });
  ctx.globalAlpha = 1;
  drawSeries(powers, x, y + 27, width, height - 40, maxGraphPower, '#fff', 2.4);
  const hrs = rollingHeartRate(metrics.records, 3);
  drawSeries(hrs, x, y + 20, width, height - 67, maxHrSetting, '#e11f28', 2.4, 0);
  ctx.restore();

  const maxPowerIndex = powers.reduce((best, value, index) => value > powers[best] ? index : best, 0);
  const maxPowerX = x + (maxPowerIndex / Math.max(1, powers.length - 1)) * width;
  drawPeakLabel(`${Math.round(metrics.maxPower)}w`, maxPowerX, y + 96, '#fff', '#ffb21a');
  if (metrics.maxHeartRate) {
    const hrValues = metrics.records.map((r) => r.heartRate ?? -Infinity);
    const maxHrIndex = hrValues.reduce((best, value, index) => value > hrValues[best] ? index : best, 0);
    const maxHrX = x + (maxHrIndex / Math.max(1, hrValues.length - 1)) * width;
    drawPeakLabel(`${Math.round(metrics.maxHeartRate)}bpm`, maxHrX, y + 56, '#fff', '#e11f28');
  }
}

function drawSeries(values, x, y, width, height, max, color, lineWidth, min = 0) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  let started = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const px = x + (index / Math.max(1, values.length - 1)) * width;
    const py = y + height - ((value - min) / Math.max(1, max - min)) * height;
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.stroke();
}

function drawPeakLabel(text, x, y, color, pointerColor) {
  ctx.fillStyle = color;
  ctx.font = '900 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
  ctx.fillStyle = pointerColor;
  ctx.beginPath();
  ctx.moveTo(x - 4, y + 6);
  ctx.lineTo(x + 4, y + 6);
  ctx.lineTo(x, y + 13);
  ctx.closePath();
  ctx.fill();
}

function drawLegends() {
  const items = [['パワー', true], ['ケイデンス', false], ['心拍数', true]];
  let x = 37;
  items.forEach(([label, active]) => {
    ctx.strokeStyle = '#bdbdbd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + 9, 428, 7, 0, Math.PI * 2);
    ctx.stroke();
    if (active) {
      ctx.fillStyle = '#ff5b1a';
      ctx.beginPath();
      ctx.arc(x + 9, 428, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#111';
    ctx.font = '900 17px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 20, 435);
    x += label === 'ケイデンス' ? 120 : 92;
  });
}

function drawDistributionPanels(metrics, options) {
  roundRect(ctx, 27, 443, 449, 173, 9, '#2d2d2d');
  roundRect(ctx, 525, 443, 449, 173, 9, '#2d2d2d');
  ctx.fillStyle = '#fff';
  ctx.font = '900 19px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('パワー分布', 251, 464);
  ctx.fillText('心拍数分布', 749, 464);
  drawPowerHistogram(metrics, 27, 464, 449, 144);
  drawHeartHistogram(metrics, options, 525, 464, 449, 144);
}

function drawPowerHistogram(metrics, x, y, width, height) {
  const bins = makeHistogram(metrics.records.map((r) => r.power ?? 0), 100, 600, 22);
  const maxBin = Math.max(...bins, 1);
  ctx.fillStyle = '#fff';
  bins.forEach((count, i) => {
    const barW = width / bins.length - 1.5;
    const barH = (count / maxBin) * (height - 58);
    ctx.beginPath();
    ctx.roundRect(x + i * (width / bins.length), y + height - barH - 24, barW, barH, 7);
    ctx.fill();
  });
  drawAxisLabels(x, y + height - 4, width, ['100', '150', '200', '250', '300', '350', '400', '450', '500', '550', '600'], 'ワット');
  const avgX = x + ((metrics.avgPower - 100) / 500) * width;
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(avgX, y + 42);
  ctx.lineTo(avgX, y + height - 24);
  ctx.stroke();
  badge(`AVG
${Math.round(metrics.avgPower)}`, avgX, y + 55);
}

function drawHeartHistogram(metrics, { maxHrSetting }, x, y, width, height) {
  const minHr = 0.5 * maxHrSetting;
  const colors = ['#2f8ef4', '#56bf5b', '#ffd045', '#ff683b', '#ff321a'];
  colors.forEach((color, i) => {
    const start = x + (i / colors.length) * width;
    ctx.fillStyle = color;
    ctx.fillRect(start, y, width / colors.length, height - 30);
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#fff';
    ctx.font = '900 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Z${i + 1}`, start + width / colors.length / 2, y + 17);
    ctx.globalAlpha = 1;
  });
  const values = metrics.records.map((r) => r.heartRate).filter(Number.isFinite);
  const bins = makeHistogram(values, Math.round(minHr), maxHrSetting, 18);
  const maxBin = Math.max(...bins, 1);
  ctx.fillStyle = '#fff';
  bins.forEach((count, i) => {
    const barW = width / bins.length - 2;
    const barH = (count / maxBin) * (height - 63);
    ctx.beginPath();
    ctx.roundRect(x + i * (width / bins.length), y + height - barH - 30, barW, barH, 7);
    ctx.fill();
  });
  drawAxisLabels(x, y + height - 4, width, ['60', '73', '85', '98', '110', '123', '136', '148', '161', '173', String(maxHrSetting)], 'bpm');
  const avgX = x + ((metrics.avgHeartRate - minHr) / Math.max(1, maxHrSetting - minHr)) * width;
  badge(`AVG
${Math.round(metrics.avgHeartRate)}`, avgX, y + 58);
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

function drawAxisLabels(x, y, width, labels, unit) {
  ctx.fillStyle = '#1c1c1c';
  ctx.font = '900 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((label, i) => ctx.fillText(label, x + (i / (labels.length - 1)) * width, y - 7));
  ctx.font = '900 14px system-ui, sans-serif';
  ctx.fillText(unit, x + width / 2, y + 15);
}

function badge(text, x, y) {
  const lines = text.split('\n');
  roundRect(ctx, x - 25, y - 23, 50, 45, 10, '#8a8d91');
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = '900 11px system-ui, sans-serif';
  ctx.fillText(lines[0], x, y - 7);
  ctx.font = '900 20px system-ui, sans-serif';
  ctx.fillText(lines[1], x, y + 14);
}

function zoneColor(power, ftp) {
  const ratio = power / ftp;
  if (ratio < 0.55) return '#9aa0a6';
  if (ratio < 0.75) return '#2f8ef4';
  if (ratio < 0.9) return '#56bf5b';
  if (ratio < 1.05) return '#ffd045';
  if (ratio < 1.2) return '#ff8a2a';
  return '#d72d16';
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function roundRect(context, x, y, width, height, radius, fillStyle) {
  context.fillStyle = fillStyle;
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

drawPlaceholder();
