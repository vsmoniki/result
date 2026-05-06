import FitParser from 'fit-file-parser';
import './styles.css';

const $ = (selector) => document.querySelector(selector);
const app = $('#app');

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">FITファイルからPNG生成</p>
      <h1>Zwift風リザルト画像メーカー</h1>
      <p>FITファイルをブラウザ内で解析し、完走タイム画面またはライドレポート画面を生成します。画像はサーバーへ送信されません。</p>
    </section>

    <section class="panel controls">
      <label class="file-drop" for="fitFile">
        <span>FITファイルを選択</span>
        <strong id="fileName">未選択</strong>
        <input id="fitFile" type="file" accept=".fit,application/octet-stream" />
      </label>

      <div class="mode-grid" role="tablist" aria-label="作成する画像タイプ">
        <label><input type="radio" name="mode" value="finish" checked /> 完走タイム</label>
        <label><input type="radio" name="mode" value="report" /> ライドレポート</label>
      </div>

      <div id="finishInputs" class="form-grid">
        <label>体重（kg）<input id="weight" type="number" min="20" step="0.1" value="60" /></label>
      </div>

      <div id="reportInputs" class="form-grid hidden">
        <label>ライドタイトル<input id="rideTitle" type="text" value="WTRL Team Time Trial - Zone 11 (FRAPPE)" /></label>
        <label>FTP（W）<input id="ftp" type="number" min="1" step="1" value="250" /></label>
        <label>最大心拍数（bpm）<input id="maxHrSetting" type="number" min="80" step="1" value="186" /></label>
      </div>

      <div class="actions">
        <button id="generate" type="button">画像を作成</button>
        <a id="download" class="download disabled" download="zwift-result.png">PNGを保存</a>
      </div>
      <p id="status" class="status">FITファイルを選択してください。</p>
    </section>

    <section class="panel preview-panel">
      <div class="preview-toolbar">
        <h2>プレビュー</h2>
        <span id="summary"></span>
      </div>
      <canvas id="canvas" width="1920" height="1080" aria-label="生成画像プレビュー"></canvas>
    </section>
  </main>
`;

const state = { fitData: null, metrics: null, downloadUrl: null };
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

$('input[name="mode"][value="finish"]').addEventListener('change', syncMode);
$('input[name="mode"][value="report"]').addEventListener('change', syncMode);
$('#fitFile').addEventListener('change', handleFile);
$('#generate').addEventListener('click', generateImage);

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
  $('#fileName').textContent = file.name;
  setStatus('FITファイルを解析中…');
  try {
    const parser = new FitParser({ force: true, mode: 'both', speedUnit: 'km/h', lengthUnit: 'km', elapsedRecordField: true });
    const buffer = await file.arrayBuffer();
    state.fitData = await parser.parseAsync(buffer);
    state.metrics = extractMetrics(state.fitData);
    setStatus(`${state.metrics.records.length.toLocaleString()}点の記録を読み込みました。画像を作成できます。`);
    $('#summary').textContent = `${formatDuration(state.metrics.duration)} / ${Math.round(state.metrics.avgPower)}W avg`;
  } catch (error) {
    state.fitData = null;
    state.metrics = null;
    $('#summary').textContent = '';
    setStatus(`FITファイルを解析できませんでした: ${error.message}`, true);
  }
}

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function generateImage() {
  if (!state.metrics) {
    setStatus('先にFITファイルを選択してください。', true);
    return;
  }
  if (getMode() === 'finish') {
    const weight = Number($('#weight').value);
    if (!weight) return setStatus('体重を入力してください。', true);
    drawFinishResult(state.metrics, weight);
  } else {
    const title = $('#rideTitle').value.trim() || 'Zwift Ride';
    const ftp = Number($('#ftp').value);
    const maxHrSetting = Number($('#maxHrSetting').value);
    if (!ftp || !maxHrSetting) return setStatus('タイトル、FTP、最大心拍数を入力してください。', true);
    drawRideReport(state.metrics, { title, ftp, maxHrSetting });
  }
  canvas.toBlob((blob) => {
    if (!blob) return;
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = URL.createObjectURL(blob);
    const download = $('#download');
    download.href = state.downloadUrl;
    download.classList.remove('disabled');
  });
  setStatus('画像を作成しました。PNGを保存できます。');
}

function setStatus(message, isError = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', isError);
}

function extractMetrics(data) {
  const records = (data.records || [])
    .filter((record) => record.timestamp)
    .map((record, index) => ({
      timestamp: new Date(record.timestamp),
      elapsed: Number.isFinite(record.elapsed_time) ? record.elapsed_time : undefined,
      power: clean(record.power),
      heartRate: clean(record.heart_rate),
      cadence: clean(record.cadence),
      distance: clean(record.distance),
      speed: clean(record.speed),
      index,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!records.length) throw new Error('FITに時系列レコードがありません。');
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

function rollingPower(records, windowSize = 3) {
  return records.map((record, index) => {
    const from = Math.max(0, index - windowSize + 1);
    return average(records.slice(from, index + 1).map((r) => r.power ?? 0));
  });
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
  ctx.fillText('FITファイルを選択して画像を作成', w / 2, h / 2);
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
  canvas.width = 1920;
  canvas.height = 1080;
  const w = canvas.width;
  const h = canvas.height;
  drawRoadBackdrop(w, h);
  roundRect(ctx, 255, 15, 1410, 910, 12, '#f7f7f4');
  roundRect(ctx, 255, 15, 1410, 62, 12, '#2b2b2b');
  ctx.fillRect(255, 60, 1410, 18);
  ctx.fillStyle = '#fff';
  ctx.font = '900 50px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ライドレポート', 960, 62);

  drawHeader(metrics, options);
  drawTabs();
  drawTimeline(metrics, options);
  drawLegends();
  drawDistributionPanels(metrics, options);

  roundRect(ctx, 765, 940, 390, 110, 16, '#fff');
  roundRect(ctx, 775, 950, 370, 90, 8, '#ff5b1a');
  ctx.fillStyle = '#fff';
  ctx.font = '900 66px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('OK', 960, 1018);
}

function drawRoadBackdrop(w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#4fa1b7');
  sky.addColorStop(0.45, '#a4d5df');
  sky.addColorStop(0.46, '#37424a');
  sky.addColorStop(1, '#15191f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = '#1e242b';
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(760, 520);
  ctx.lineTo(1070, 520);
  ctx.lineTo(1920, h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#f2c22c';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(120, 1080);
  ctx.lineTo(820, 520);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(165, 1080);
  ctx.lineTo(840, 520);
  ctx.stroke();
  ctx.restore();
}

function drawHeader(metrics, { title }) {
  ctx.fillStyle = '#222';
  ctx.textAlign = 'left';
  ctx.font = '900 34px system-ui, sans-serif';
  ctx.fillText('●', 282, 112);
  ctx.fillStyle = '#f5d900';
  ctx.fillText('D', 286, 114);
  ctx.fillStyle = '#222';
  ctx.font = '900 37px system-ui, sans-serif';
  ctx.fillText(title, 335, 120);

  const stats = [
    ['⚡', Math.round(metrics.avgPower), 'AVG'],
    ['〽', metrics.distanceKm.toFixed(1), 'km'],
    ['◷', formatDuration(metrics.duration), 'ET'],
    ['', Math.round(metrics.calories), 'KCAL'],
    ['', '50', 'SP'],
  ];
  const xs = [305, 590, 840, 1110, 1410];
  stats.forEach(([icon, value, unit], index) => {
    ctx.fillStyle = '#24242a';
    ctx.font = '900 44px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${icon} ${value}`, xs[index], 184);
    ctx.font = '900 22px system-ui, sans-serif';
    ctx.fillText(unit, xs[index] + String(value).length * 28 + 55, 183);
  });
  roundRect(ctx, 288, 207, 100, 24, 10, '#2f3338');
  ctx.fillStyle = '#fff';
  ctx.font = '900 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🚴 100', 338, 226);
  roundRect(ctx, 388, 207, 1238, 24, 10, '#c7c7c7');
  roundRect(ctx, 388, 207, 355, 24, 10, '#ff5b1a');
  ctx.fillStyle = '#111';
  ctx.font = '800 18px system-ui, sans-serif';
  ctx.fillText('次のリワードまで 14282 XP', 1485, 226);
  roundRect(ctx, 1470, 92, 95, 58, 12, '#c9341c');
  ctx.save();
  ctx.translate(1517, 128);
  ctx.rotate(-0.13);
  ctx.fillStyle = '#fff';
  ctx.font = '900 36px system-ui, sans-serif';
  ctx.fillText('OK!', 0, 0);
  ctx.restore();
}

function drawTabs() {
  const y = 245;
  roundRect(ctx, 555, y, 810, 30, 5, '#000');
  ctx.fillStyle = '#ff5b1a';
  ctx.fillRect(825, y, 270, 30);
  [['全般', 690], ['タイムライン', 960], ['クリティカルパワー', 1230]].forEach(([label, x]) => {
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = label === 'タイムライン' ? 1 : 0.45;
    ctx.font = '900 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y + 22);
    ctx.globalAlpha = 1;
  });
}

function drawTimeline(metrics, { ftp, maxHrSetting }) {
  const x = 290;
  const y = 295;
  const width = 1340;
  const height = 304;
  roundRect(ctx, x, y, width, height, 10, '#2d2d2d');
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 10);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x, y + (height * i) / 5);
    ctx.lineTo(x + width, y + (height * i) / 5);
    ctx.stroke();
  }
  const powers = rollingPower(metrics.records, 3);
  const maxGraphPower = Math.max(ftp * 1.45, metrics.maxPower, 1);
  metrics.records.forEach((record, index) => {
    const px = x + (index / Math.max(1, metrics.records.length - 1)) * width;
    const barW = Math.max(1, width / metrics.records.length + 0.5);
    const p = powers[index];
    const barH = Math.min(height - 4, (p / maxGraphPower) * (height - 28));
    ctx.fillStyle = zoneColor(p, ftp);
    ctx.globalAlpha = 0.78;
    ctx.fillRect(px, y + height - barH, barW, barH);
  });
  ctx.globalAlpha = 1;
  drawSeries(powers, x, y + 24, width, height - 32, maxGraphPower, '#fff', 3);
  const hrs = metrics.records.map((r) => r.heartRate ?? NaN);
  drawSeries(hrs, x, y + 18, width, height - 60, maxHrSetting, '#e11f28', 3, 0);
  ctx.restore();
  drawPeakLabel(`${Math.round(metrics.maxPower)}w`, x + 70, y + 103, '#fff', '#ffb21a');
  if (metrics.maxHeartRate) drawPeakLabel(`${Math.round(metrics.maxHeartRate)}bpm`, x + width * 0.69, y + 60, '#fff', '#e11f28');
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
  ctx.font = '900 18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
  ctx.fillStyle = pointerColor;
  ctx.beginPath();
  ctx.moveTo(x - 5, y + 8);
  ctx.lineTo(x + 5, y + 8);
  ctx.lineTo(x, y + 17);
  ctx.closePath();
  ctx.fill();
}

function drawLegends() {
  const items = [['パワー', true], ['ケイデンス', false], ['心拍数', true]];
  let x = 305;
  items.forEach(([label, active]) => {
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + 10, 624, 9, 0, Math.PI * 2);
    ctx.stroke();
    if (active) {
      ctx.fillStyle = '#ff5b1a';
      ctx.beginPath();
      ctx.arc(x + 10, 624, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#111';
    ctx.font = '900 23px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 25, 633);
    x += 130 + label.length * 18;
  });
}

function drawDistributionPanels(metrics, options) {
  roundRect(ctx, 290, 646, 635, 220, 9, '#2d2d2d');
  roundRect(ctx, 993, 646, 635, 220, 9, '#2d2d2d');
  ctx.fillStyle = '#fff';
  ctx.font = '900 27px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('パワー分布', 607, 674);
  ctx.fillText('心拍数分布', 1310, 674);
  drawPowerHistogram(metrics, 290, 676, 635, 190);
  drawHeartHistogram(metrics, options, 993, 676, 635, 190);
}

function drawPowerHistogram(metrics, x, y, width, height) {
  const bins = makeHistogram(metrics.records.map((r) => r.power ?? 0), 100, 600, 18);
  const maxBin = Math.max(...bins, 1);
  ctx.fillStyle = '#fff';
  bins.forEach((count, i) => {
    const barW = width / bins.length - 2;
    const barH = (count / maxBin) * (height - 50);
    ctx.beginPath();
    ctx.roundRect(x + i * (width / bins.length), y + height - barH - 18, barW, barH, 8);
    ctx.fill();
  });
  drawAxisLabels(x, y + height, width, ['100', '150', '200', '250', '300', '350', '400', '450', '500', '550', '600'], 'ワット');
  const avgX = x + ((metrics.avgPower - 100) / 500) * width;
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(avgX, y + 44);
  ctx.lineTo(avgX, y + height - 18);
  ctx.stroke();
  badge(`AVG\n${Math.round(metrics.avgPower)}`, avgX, y + 68);
}

function drawHeartHistogram(metrics, { maxHrSetting }, x, y, width, height) {
  const zoneStarts = [0, 0.5, 0.6, 0.7, 0.8, 0.9].map((rate) => rate * maxHrSetting);
  const colors = ['#2f8ef4', '#56bf5b', '#ffd045', '#ff683b', '#ff321a'];
  colors.forEach((color, i) => {
    const start = x + (i / colors.length) * width;
    ctx.fillStyle = color;
    ctx.fillRect(start, y, width / colors.length, height - 30);
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#fff';
    ctx.font = '900 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Z${i + 1}`, start + width / colors.length / 2, y + 24);
    ctx.globalAlpha = 1;
  });
  const values = metrics.records.map((r) => r.heartRate).filter(Number.isFinite);
  const bins = makeHistogram(values, Math.round(zoneStarts[1]), maxHrSetting, 18);
  const maxBin = Math.max(...bins, 1);
  ctx.fillStyle = '#fff';
  bins.forEach((count, i) => {
    const barW = width / bins.length - 2;
    const barH = (count / maxBin) * (height - 70);
    ctx.beginPath();
    ctx.roundRect(x + i * (width / bins.length), y + height - barH - 30, barW, barH, 8);
    ctx.fill();
  });
  drawAxisLabels(x, y + height, width, ['60', '73', '85', '98', '110', '123', '136', '148', '161', '173', String(maxHrSetting)], 'bpm');
  const avgX = x + ((metrics.avgHeartRate - 0.5 * maxHrSetting) / (0.5 * maxHrSetting)) * width;
  badge(`AVG\n${Math.round(metrics.avgHeartRate)}`, avgX, y + 70);
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
  ctx.font = '900 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((label, i) => ctx.fillText(label, x + (i / (labels.length - 1)) * width, y - 6));
  ctx.font = '900 24px system-ui, sans-serif';
  ctx.fillText(unit, x + width / 2, y + 16);
}

function badge(text, x, y) {
  const lines = text.split('\n');
  roundRect(ctx, x - 34, y - 24, 68, 48, 11, '#8a8d91');
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = '900 14px system-ui, sans-serif';
  ctx.fillText(lines[0], x, y - 6);
  ctx.font = '900 24px system-ui, sans-serif';
  ctx.fillText(lines[1], x, y + 17);
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
