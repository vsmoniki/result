import FitParser from 'fit-file-parser';
import '@fontsource/m-plus-rounded-1c/700.css';
import '@fontsource/m-plus-rounded-1c/800.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow/800.css';
import '@fontsource/noto-sans-jp/500.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/noto-sans-jp/800.css';
import { calculateNormalizedPower, calculateStressPoints } from './sp.js';
import { titleFromFileName } from './ride-title.js';
import { getHeartLineRange } from './heart-line-range.js';

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
  previewScrollArmed: true,
  graphSmoothnessTouched: false,
  powerGraphHeightTouched: false,
  graphLineWidthTouched: false,
  avatarImage: null,
  avatarCrop: null,
};

// Guard against duplicate activations while the native file picker is open.
let pickerIsActive = false;
let pickerActivatedAt = 0;
const PICKER_TIMEOUT_MS = 30_000;
const DEFAULT_CANVAS_WIDTH = 1920;
const DEFAULT_CANVAS_HEIGHT = 1080;
// Exported images are drawn at 2x the logical size (supersampling) so text
// and graph lines stay sharp; all drawing code keeps logical coordinates.
const EXPORT_SCALE = 2;
const REPORT_LOGICAL_WIDTH = 1000;
const REPORT_LOGICAL_HEIGHT = 642;
const FINISH_LOGICAL_WIDTH = 470;
const FINISH_LOGICAL_HEIGHT = 584;
const MIN_GRAPH_SMOOTHNESS = -20;
const MAX_GRAPH_SMOOTHNESS = 100;
const LEGACY_GRAPH_SMOOTHNESS = 0;
const DEFAULT_POWER_GRAPH_HEIGHT = 0;
const DEFAULT_GRAPH_LINE_WIDTH = 0;
const DEFAULT_AVATAR_MESSAGE = 'GO!';
const DEFAULT_AVATAR_BUBBLE_COLOR = '#2f8ef4';
const DEFAULT_AVATAR_TEXT_COLOR = '#ffffff';
const AVATAR_IMAGE_KEY = 'avatarImageDataUrl';
const AVATAR_MESSAGE_KEY = 'avatarMessage';
const AVATAR_BUBBLE_COLOR_KEY = 'avatarBubbleColor';
const AVATAR_TEXT_COLOR_KEY = 'avatarTextColor';
const FTP_SETTING_KEY = 'ftpSetting';
const MAX_HR_SETTING_KEY = 'maxHrSetting';
const WEIGHT_SETTING_KEY = 'weightSetting';
const HEART_LINE_AMPLITUDE_SCALE = 0.9;
const FAN_TOOL_MARK_LINES = ['Unofficial Fan Tool', 'by Moniki Lab'];
const REPORT_FONT = "'M PLUS Rounded 1c', 'Arial Rounded MT Bold', 'Hiragino Maru Gothic ProN', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif";
// The finish-time panel mirrors official Zwift's gothic (non-rounded) look:
// Japanese text uses a plain gothic stack while numbers stay in Barlow.
const FINISH_FONT = "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic UI', 'Yu Gothic', system-ui, sans-serif";
const REPORT_NUMBER_FONT = "'Barlow', 'M PLUS Rounded 1c', 'Arial Black', 'Arial Rounded MT Bold', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif";

// Bundled webfonts (Fontsource) keep the generated images identical on
// iPhone / Windows / Android instead of falling back to per-OS fonts.
// generateImage() waits for these faces before drawing real output.
// The loads carry representative sample text: Fontsource splits the
// Japanese face into unicode-range subsets, and document.fonts.load only
// guarantees the subsets covering the given text — loading with the
// default sample would leave title/label glyphs to the fallback fonts.
const FONT_SAMPLE_DIGITS = '0123456789:.,';
const FONT_SAMPLE_JA = 'ライドレポート完走タイムパワー心拍数分布数値あいうえお伊豆峠閉じるBESbswy0123456789';
const fontsReadyPromise = (typeof document !== 'undefined' && document.fonts?.load)
  ? Promise.all([
    document.fonts.load('800 27px "M PLUS Rounded 1c"', FONT_SAMPLE_JA),
    document.fonts.load('700 12px "M PLUS Rounded 1c"', FONT_SAMPLE_JA),
    document.fonts.load('600 38px "Barlow"', FONT_SAMPLE_DIGITS),
    document.fonts.load('800 32px "Barlow"', FONT_SAMPLE_DIGITS),
    document.fonts.load('700 20px "Barlow"', FONT_SAMPLE_DIGITS),
    document.fonts.load('800 40px "Noto Sans JP"', FONT_SAMPLE_JA),
    document.fonts.load('700 20px "Noto Sans JP"', FONT_SAMPLE_JA),
    document.fonts.load('500 34px "Barlow"', FONT_SAMPLE_DIGITS),
    document.fonts.load('500 17px "Noto Sans JP"', FONT_SAMPLE_JA),
  ]).catch(() => {})
  : Promise.resolve();
let appFontsReady = false;
fontsReadyPromise.then(() => { appFontsReady = true; });

// Wait for the static faces plus, when given, the subsets covering the
// exact extra text (the current ride title). Never blocks forever: if the
// fonts do not arrive within ~1.5s we draw with fallbacks, as before.
async function ensureDrawingFonts(extraText = '') {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  try {
    const loads = [fontsReadyPromise];
    if (extraText) {
      loads.push(document.fonts.load('800 27px "M PLUS Rounded 1c"', extraText).catch(() => {}));
      loads.push(document.fonts.load('700 12px "M PLUS Rounded 1c"', extraText).catch(() => {}));
    }
    await Promise.race([
      Promise.all(loads),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // Font loading is best-effort; fall through and draw anyway.
  }
}
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
const avatarCropDialog = $('#avatarCropDialog');
const avatarCropCanvas = $('#avatarCropCanvas');
const avatarCropCtx = avatarCropCanvas.getContext('2d');
const avatarCropSizeSlider = $('#avatarCropSize');

$('input[name="mode"][value="finish"]').addEventListener('change', syncMode);
$('input[name="mode"][value="report"]').addEventListener('change', syncMode);
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
$('#generate').addEventListener('click', async () => {
  state.previewScrollArmed = true;
  showLoadingStatus();
  await nextPaint();
  try {
    await generateImage();
  } finally {
    hideLoadingStatus();
  }
});
$('#download').addEventListener('click', savePng);
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
$('#rideTitle').addEventListener('input', handleRideTitleInput);
$('#avatarMessage').addEventListener('input', handleAvatarMessageInput);
$('#avatarBubbleColor').addEventListener('input', handleAvatarStyleInput);
$('#avatarTextColor').addEventListener('input', handleAvatarStyleInput);
$('#resetAvatarBubble').addEventListener('click', resetAvatarBubbleSettings);
$('#avatarImageFile').addEventListener('change', handleAvatarImageInput);
$('#resetAvatarImage').addEventListener('click', resetAvatarImage);
$('#applyAvatarCrop').addEventListener('click', applyAvatarCrop);
$('#cancelAvatarCrop').addEventListener('click', cancelAvatarCrop);
avatarCropCanvas.addEventListener('pointerdown', startAvatarCropDrag);
avatarCropCanvas.addEventListener('pointermove', dragAvatarCrop);
avatarCropCanvas.addEventListener('pointerup', finishAvatarCropDrag);
avatarCropCanvas.addEventListener('pointercancel', finishAvatarCropDrag);
avatarCropSizeSlider.addEventListener('input', handleAvatarCropSizeInput);
$('#ftp').addEventListener('input', handleFtpSettingInput);
$('#maxHrSetting').addEventListener('input', handleMaxHrSettingInput);
$('#level').addEventListener('input', handleLevelInput);
$('#spInput').addEventListener('input', handleSpInput);
$('#weight').addEventListener('input', handleWeightSettingInput);
graphSmoothnessSlider.addEventListener('input', handleGraphSmoothnessInput);
powerGraphHeightSlider.addEventListener('input', handlePowerGraphHeightInput);
graphLineWidthSlider.addEventListener('input', handleGraphLineWidthInput);
resetOptionsButton.addEventListener('click', resetOptionsToDefaults);
loadSavedPerformanceSettings();
loadSavedAvatarBubbleSettings();
loadSavedAvatarImage();

function syncMode() {
  const mode = getMode();
  $('#finishInputs').classList.toggle('hidden', mode !== 'finish');
  $('#reportInputs').classList.toggle('hidden', mode !== 'report');
  syncModeLayoutState();
  document.querySelector('.preview-options').classList.toggle('hidden', mode !== 'report');
  syncPreviewOptionsOpenState();
  clearGeneratedDownload();
  syncGraphSmoothnessSliderDefault();
  syncPowerGraphHeightSliderDefault();
  syncGraphLineWidthSliderDefault();
  drawPlaceholder();
  setStatus(state.metrics ? 'モードを切り替えました。「画像を作成」で生成できます。' : 'FITファイルを選択してください。');
}

function syncModeLayoutState() {
  const mode = getMode();
  document.querySelector('.preview-panel').classList.toggle('has-preview-options', mode === 'report');
}

function syncPreviewOptionsOpenState() {
  const previewOptions = document.querySelector('.preview-options');
  if (getMode() !== 'report') return;
  previewOptions.open = matchMedia('(min-width: 1081px)').matches;
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
    setStatus('対応していないファイルです。FITファイルを選んでください。', true);
    return;
  }

  showLoadingStatus();
  await nextPaint();
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
    hideLoadingStatus();
    finishFileSelection(selectionToken);
  }
}

function beginFileSelection(file) {
  const selectionToken = state.fileSelectionToken + 1;
  state.fileSelectionToken = selectionToken;
  state.isLoadingFile = true;
  state.previewScrollArmed = true;
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
  fileDrop.classList.remove('has-file');
  if (resetFileName) $('#fileName').textContent = '未選択';
}

function handleRideTitleInput(event) {
  if (event.currentTarget.value !== state.autoRideTitle) {
    state.autoRideTitle = '';
  }
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function handleAvatarMessageInput() {
  saveAvatarBubbleSettings();
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function handleAvatarStyleInput() {
  saveAvatarBubbleSettings();
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function resetAvatarBubbleSettings() {
  $('#avatarMessage').value = DEFAULT_AVATAR_MESSAGE;
  $('#avatarBubbleColor').value = DEFAULT_AVATAR_BUBBLE_COLOR;
  $('#avatarTextColor').value = DEFAULT_AVATAR_TEXT_COLOR;
  handleAvatarStyleInput();
}

function handleAvatarImageInput(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const img = new Image();
    img.onload = () => {
      openAvatarCropper(img);
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

function openAvatarCropper(img) {
  const maxDrawSize = Math.min(avatarCropCanvas.width - 24, avatarCropCanvas.height - 24);
  const scale = Math.min(maxDrawSize / img.naturalWidth, maxDrawSize / img.naturalHeight);
  const displayW = img.naturalWidth * scale;
  const displayH = img.naturalHeight * scale;
  const display = {
    x: (avatarCropCanvas.width - displayW) / 2,
    y: (avatarCropCanvas.height - displayH) / 2,
    width: displayW,
    height: displayH,
  };
  const size = Math.min(displayW, displayH);
  state.avatarCrop = {
    img,
    display,
    crop: {
      x: display.x + (displayW - size) / 2,
      y: display.y + (displayH - size) / 2,
      size,
    },
    dragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
  };
  avatarCropSizeSlider.value = 100;
  drawAvatarCropper();
  avatarCropDialog.showModal();
}

function drawAvatarCropper() {
  const cropState = state.avatarCrop;
  if (!cropState) return;
  const { img, display, crop } = cropState;
  avatarCropCtx.clearRect(0, 0, avatarCropCanvas.width, avatarCropCanvas.height);
  avatarCropCtx.fillStyle = '#101827';
  avatarCropCtx.fillRect(0, 0, avatarCropCanvas.width, avatarCropCanvas.height);
  avatarCropCtx.drawImage(img, display.x, display.y, display.width, display.height);
  avatarCropCtx.fillStyle = 'rgba(0,0,0,.52)';
  avatarCropCtx.fillRect(0, 0, avatarCropCanvas.width, avatarCropCanvas.height);
  avatarCropCtx.save();
  avatarCropCtx.beginPath();
  avatarCropCtx.rect(crop.x, crop.y, crop.size, crop.size);
  avatarCropCtx.clip();
  avatarCropCtx.drawImage(img, display.x, display.y, display.width, display.height);
  avatarCropCtx.restore();
  avatarCropCtx.strokeStyle = '#ffb21a';
  avatarCropCtx.lineWidth = 3;
  avatarCropCtx.strokeRect(crop.x + 1.5, crop.y + 1.5, crop.size - 3, crop.size - 3);
}

function startAvatarCropDrag(event) {
  const cropState = state.avatarCrop;
  if (!cropState) return;
  const point = getAvatarCropPoint(event);
  const { crop } = cropState;
  if (
    point.x < crop.x
    || point.x > crop.x + crop.size
    || point.y < crop.y
    || point.y > crop.y + crop.size
  ) return;
  cropState.dragging = true;
  cropState.dragOffsetX = point.x - crop.x;
  cropState.dragOffsetY = point.y - crop.y;
  avatarCropCanvas.setPointerCapture(event.pointerId);
}

function dragAvatarCrop(event) {
  const cropState = state.avatarCrop;
  if (!cropState?.dragging) return;
  const point = getAvatarCropPoint(event);
  cropState.crop.x = point.x - cropState.dragOffsetX;
  cropState.crop.y = point.y - cropState.dragOffsetY;
  clampAvatarCrop();
  drawAvatarCropper();
}

function finishAvatarCropDrag(event) {
  const cropState = state.avatarCrop;
  if (!cropState) return;
  cropState.dragging = false;
  if (avatarCropCanvas.hasPointerCapture?.(event.pointerId)) {
    avatarCropCanvas.releasePointerCapture(event.pointerId);
  }
}

function handleAvatarCropSizeInput() {
  const cropState = state.avatarCrop;
  if (!cropState) return;
  const { display, crop } = cropState;
  const centerX = crop.x + crop.size / 2;
  const centerY = crop.y + crop.size / 2;
  const maxSize = Math.min(display.width, display.height);
  const nextSize = maxSize * (Number(avatarCropSizeSlider.value) / 100);
  crop.size = nextSize;
  crop.x = centerX - nextSize / 2;
  crop.y = centerY - nextSize / 2;
  clampAvatarCrop();
  drawAvatarCropper();
}

function clampAvatarCrop() {
  const cropState = state.avatarCrop;
  if (!cropState) return;
  const { display, crop } = cropState;
  crop.size = Math.min(crop.size, display.width, display.height);
  crop.x = Math.max(display.x, Math.min(display.x + display.width - crop.size, crop.x));
  crop.y = Math.max(display.y, Math.min(display.y + display.height - crop.size, crop.y));
}

function getAvatarCropPoint(event) {
  const rect = avatarCropCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * avatarCropCanvas.width,
    y: ((event.clientY - rect.top) / rect.height) * avatarCropCanvas.height,
  };
}

function applyAvatarCrop() {
  const cropState = state.avatarCrop;
  if (!cropState) return;
  const { img, display, crop } = cropState;
  const sourceX = ((crop.x - display.x) / display.width) * img.naturalWidth;
  const sourceY = ((crop.y - display.y) / display.height) * img.naturalHeight;
  const sourceSize = (crop.size / display.width) * img.naturalWidth;
  const output = document.createElement('canvas');
  output.width = 256;
  output.height = 256;
  const outputCtx = output.getContext('2d');
  outputCtx.drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, output.width, output.height);
  const dataUrl = output.toDataURL('image/png');
  saveAvatarImageDataUrl(dataUrl);
  closeAvatarCropper();
}

function cancelAvatarCrop() {
  $('#avatarImageFile').value = '';
  closeAvatarCropper();
}

function closeAvatarCropper() {
  state.avatarCrop = null;
  if (avatarCropDialog.open) avatarCropDialog.close();
}

function saveAvatarImageDataUrl(dataUrl) {
  const img = new Image();
  img.onload = () => {
    state.avatarImage = img;
    try { localStorage.setItem(AVATAR_IMAGE_KEY, dataUrl); } catch {}
    clearGeneratedDownload();
    if (getMode() === 'report' && canGenerateImage()) generateImage();
  };
  img.src = dataUrl;
}

function loadSavedAvatarImage() {
  const dataUrl = localStorage.getItem(AVATAR_IMAGE_KEY);
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => {
    if (img.naturalWidth !== img.naturalHeight) {
      saveAvatarImageDataUrl(centerCropAvatarImage(img));
      return;
    }
    state.avatarImage = img;
  };
  img.src = dataUrl;
}

function centerCropAvatarImage(img) {
  const sourceSize = Math.min(img.naturalWidth, img.naturalHeight);
  const sourceX = (img.naturalWidth - sourceSize) / 2;
  const sourceY = (img.naturalHeight - sourceSize) / 2;
  const output = document.createElement('canvas');
  output.width = 256;
  output.height = 256;
  const outputCtx = output.getContext('2d');
  outputCtx.drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, output.width, output.height);
  return output.toDataURL('image/png');
}

function loadSavedAvatarBubbleSettings() {
  const message = getLocalStorageValue(AVATAR_MESSAGE_KEY);
  const bubbleColor = getLocalStorageValue(AVATAR_BUBBLE_COLOR_KEY);
  const textColor = getLocalStorageValue(AVATAR_TEXT_COLOR_KEY);
  if (message !== null) $('#avatarMessage').value = message || DEFAULT_AVATAR_MESSAGE;
  if (isHexColor(bubbleColor)) $('#avatarBubbleColor').value = bubbleColor;
  if (isHexColor(textColor)) $('#avatarTextColor').value = textColor;
}

function saveAvatarBubbleSettings() {
  try {
    localStorage.setItem(AVATAR_MESSAGE_KEY, $('#avatarMessage').value.trim() || DEFAULT_AVATAR_MESSAGE);
    localStorage.setItem(AVATAR_BUBBLE_COLOR_KEY, getColorInputValue('#avatarBubbleColor', DEFAULT_AVATAR_BUBBLE_COLOR));
    localStorage.setItem(AVATAR_TEXT_COLOR_KEY, getColorInputValue('#avatarTextColor', DEFAULT_AVATAR_TEXT_COLOR));
  } catch {}
}

function getLocalStorageValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}


function loadSavedPerformanceSettings() {
  loadSavedNumberInput(FTP_SETTING_KEY, '#ftp');
  loadSavedNumberInput(MAX_HR_SETTING_KEY, '#maxHrSetting');
  loadSavedNumberInput(WEIGHT_SETTING_KEY, '#weight');
}

function loadSavedNumberInput(key, selector) {
  const value = getLocalStorageValue(key);
  if (value === null || value === '') return;
  if (!isValidPositiveNumber(Number(value))) return;
  $(selector).value = value;
}

function saveNumberInputValue(key, selector) {
  try {
    localStorage.setItem(key, $(selector).value);
  } catch {}
}

function handleFtpSettingInput() {
  saveNumberInputValue(FTP_SETTING_KEY, '#ftp');
  syncSp();
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function handleMaxHrSettingInput() {
  saveNumberInputValue(MAX_HR_SETTING_KEY, '#maxHrSetting');
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function handleLevelInput() {
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function handleSpInput() {
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
}

function handleWeightSettingInput() {
  saveNumberInputValue(WEIGHT_SETTING_KEY, '#weight');
  clearGeneratedDownload();
  if (getMode() === 'finish' && canGenerateImage()) generateImage();
}

function resetAvatarImage() {
  state.avatarImage = null;
  $('#avatarImageFile').value = '';
  try { localStorage.removeItem(AVATAR_IMAGE_KEY); } catch {}
  clearGeneratedDownload();
  if (getMode() === 'report' && canGenerateImage()) generateImage();
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

function buildDownloadFileName(mode) {
  const parts = ['zwift', mode, formatFileNameDate(getRideDate())];
  if (mode === 'report') {
    const slug = rideTitleSlug();
    if (slug) parts.push(slug);
  }
  return `${parts.join('-')}.png`;
}

function getRideDate() {
  const timestamp = state.metrics?.records?.[0]?.timestamp;
  return timestamp instanceof Date && Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
}

function formatFileNameDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function rideTitleSlug() {
  // Keep letters/numbers (including Japanese) and turn whitespace into '-';
  // drop path separators and every other unsafe character.
  return $('#rideTitle').value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
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

async function generateImage() {
  // Never draw final output with fallback fonts when they can be helped:
  // wait for the bundled faces, including the subsets covering the exact
  // glyphs of the current ride title, then proceed with the current inputs.
  const titleForFonts = $('#rideTitle')?.value?.trim() || '';
  await ensureDrawingFonts(titleForFonts);
  const mode = getMode();
  if (state.isLoadingFile) {
    setStatus('ファイルを読み込み中です。完了してから画像を作成してください。', true);
    return;
  }
  if (!state.metrics) {
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
    const avatarMessage = getAvatarMessage();
    const avatarBubbleColor = getColorInputValue('#avatarBubbleColor', DEFAULT_AVATAR_BUBBLE_COLOR);
    const avatarTextColor = getColorInputValue('#avatarTextColor', DEFAULT_AVATAR_TEXT_COLOR);
    const graphSmoothness = getSelectedGraphSmoothness();
    const powerGraphHeight = getSelectedPowerGraphHeight();
    const graphLineWidth = getSelectedGraphLineWidth();
    drawRideReport(state.metrics, { title, ftp, level: Math.round(level), maxHrSetting, sp, avatarMessage, avatarBubbleColor, avatarTextColor, graphSmoothness, powerGraphHeight, graphLineWidth });
  }
  canvas.toBlob((blob) => {
    if (!blob) return;
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadBlob = blob;
    state.downloadFileName = buildDownloadFileName(mode);
    state.downloadUrl = URL.createObjectURL(blob);
    const download = $('#download');
    download.href = state.downloadUrl;
    download.download = state.downloadFileName;
    download.classList.remove('disabled');
  }, 'image/png');
  const saveMessage = isSmartphoneDevice()
    ? '画像を作成しました。「画像を保存」から端末に保存できます。'
    : '画像を作成しました。画像を保存できます。';
  setStatus(saveMessage);
  maybeScrollToPreview();
}

// After a fresh generation (new file loaded or the generate button was
// pressed), bring the preview into view on small screens — but only when
// it is mostly off-screen, and only once per arming, so editing fields or
// sliders afterwards never yanks the page away from the user.
function maybeScrollToPreview() {
  if (!state.previewScrollArmed) return;
  state.previewScrollArmed = false;
  const panel = document.querySelector('.preview-panel');
  if (!panel) return;
  if (panel.getBoundingClientRect().top > window.innerHeight * 0.6) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
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

function getAvatarMessage() {
  return $('#avatarMessage').value.trim() || DEFAULT_AVATAR_MESSAGE;
}

function getColorInputValue(selector, fallback) {
  const value = $(selector).value;
  return isHexColor(value) ? value : fallback;
}

function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function isValidLevel(value) {
  return Number.isInteger(value) && value >= 1 && value <= 999;
}

function isSmartphoneDevice() {
  return /Android|iPhone|iPod|Windows Phone/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && matchMedia('(max-width: 767px)').matches);
}

function setStatus(message, isError = false) {
  const status = $('#status');
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.classList.remove('loading');
}

// Heavy flows (file load, the generate button) show a spinner on the
// status line; any later setStatus() supersedes and clears it. Lightweight
// live-regenerations from input edits never call this, so they don't
// flicker.
function showLoadingStatus() {
  const status = $('#status');
  status.textContent = '読み込み中…';
  status.classList.remove('error');
  status.classList.add('loading');
}

function hideLoadingStatus() {
  $('#status').classList.remove('loading');
}

// Let the browser paint once (spinner included) before a synchronous
// parse/draw block would otherwise freeze the frame it was requested in.
function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
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

  // Attach to each record the time it represents (seconds until the next
  // record's timestamp; the last record reuses the previous dt). Smart
  // recording produces irregular intervals, so downstream averages weight
  // samples by dt instead of counting records. dt is clamped to [0, 30] so
  // pauses cannot dominate; unusable timestamps fall back to dt = 1, which
  // reproduces the old record-count behavior exactly.
  records.forEach((record, index) => {
    const next = records[index + 1];
    let dt = next ? (next.timestamp.getTime() - record.timestamp.getTime()) / 1000 : NaN;
    if (!Number.isFinite(dt)) dt = index > 0 ? records[index - 1].dt : 1;
    record.dt = Math.min(30, Math.max(0, dt));
  });

  const powers = records.map((r) => r.power).filter(Number.isFinite);
  const heartRates = records.map((r) => r.heartRate).filter(Number.isFinite);
  const maxElapsed = Math.max(...records.map((r) => r.elapsed));
  const minElapsed = Math.min(...records.map((r) => r.elapsed));
  const duration = data.sampleIntervalSeconds && minElapsed <= data.sampleIntervalSeconds
    ? maxElapsed + data.sampleIntervalSeconds
    : maxElapsed;
  const lastDistance = [...records].reverse().find((r) => Number.isFinite(r.distance))?.distance ?? 0;
  // Session total_distance parses in the same unit (km) as record distance
  // under the app's parser options (verified with a synthetic FIT fixture),
  // and is the device's official total — prefer it when present.
  const sessionDistance = data.sessions?.[0]?.total_distance;
  const distanceKm = (Number.isFinite(sessionDistance) && sessionDistance > 0) ? sessionDistance : lastDistance;
  const avgPower = timeWeightedAverage(records, 'power');
  const maxPower = powers.length ? Math.max(...powers) : 0;
  const maxHeartRate = heartRates.length ? Math.max(...heartRates) : 0;
  const avgHeartRate = heartRates.length ? timeWeightedAverage(records, 'heartRate') : 0;
  const calories = data.sessions?.[0]?.total_calories ?? Math.round(avgPower * duration / 1000 * 0.96);
  const sessionTimerTime = data.sessions?.[0]?.total_timer_time;
  const timerSeconds = (Number.isFinite(sessionTimerTime) && sessionTimerTime > 0)
    ? sessionTimerTime
    : duration;

  return {
    records,
    duration,
    timerSeconds,
    distanceKm,
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
  // Time-based sliding window: same elapsed extent and 90%-span acceptance
  // as the old record-count version, but each sample is weighted by its dt
  // (the time it represents), so smart-recording files with irregular
  // intervals produce true time averages. With dt = 1 throughout (regular
  // 1-second recordings) every sum below reduces to the old record-count
  // arithmetic exactly.
  let best = 0;
  let weightedSum = 0;
  let validDt = 0;
  let totalDt = 0;
  let left = 0;
  const dtOf = (record) => (Number.isFinite(record.dt) ? record.dt : 1);
  for (let right = 0; right < records.length; right += 1) {
    const rightRecord = records[right];
    const rightDt = dtOf(rightRecord);
    totalDt += rightDt;
    const rightValue = rightRecord[field];
    if (Number.isFinite(rightValue)) {
      weightedSum += rightValue * rightDt;
      validDt += rightDt;
    }
    while (records[right].elapsed - records[left].elapsed > seconds) {
      const leftRecord = records[left];
      const leftDt = dtOf(leftRecord);
      totalDt -= leftDt;
      const leftValue = leftRecord[field];
      if (Number.isFinite(leftValue)) {
        weightedSum -= leftValue * leftDt;
        validDt -= leftDt;
      }
      left += 1;
    }
    // Covered time span of the window (sum of dt over its records) must
    // reach 90% of the target duration, as the old span check required.
    if (totalDt >= seconds * 0.9 && validDt > 0) {
      best = Math.max(best, weightedSum / validDt);
    }
  }
  if (best === 0) {
    return timeWeightedAverage(records, field);
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

// Mean of a record field weighted by each record's dt (the time the sample
// represents). Samples with a non-finite value are skipped together with
// their dt. With dt = 1 everywhere this is exactly average() over the same
// samples. Falls back to the plain average if no positive dt is available.
function timeWeightedAverage(records, field) {
  let weightedSum = 0;
  let totalDt = 0;
  records.forEach((record) => {
    const value = record[field];
    if (!Number.isFinite(value)) return;
    const dt = Number.isFinite(record.dt) ? record.dt : 1;
    weightedSum += value * dt;
    totalDt += dt;
  });
  if (totalDt > 0) return weightedSum / totalDt;
  return average(records.map((record) => record[field]));
}

function reportFont(size, weight = 800, family = REPORT_FONT) {
  return `${weight} ${size}px ${family}`;
}

function drawPlaceholder() {
  canvas.width = DEFAULT_CANVAS_WIDTH;
  canvas.height = DEFAULT_CANVAS_HEIGHT;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  ctx.fillText(state.metrics ? '「画像を作成」でプレビューを表示' : 'FITファイルを選択して画像を作成', w / 2, h / 2);
}

function drawFinishCrown(cx, cy) {
  // Simple 3-point crown drawn as a vector so it renders identically on
  // every platform (the ♛ text glyph depends on OS fonts).
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(cx - 22, cy + 10);
  ctx.lineTo(cx - 18, cy - 12);
  ctx.lineTo(cx - 7, cy + 2);
  ctx.lineTo(cx, cy - 16);
  ctx.lineTo(cx + 7, cy + 2);
  ctx.lineTo(cx + 18, cy - 12);
  ctx.lineTo(cx + 22, cy + 10);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - 22, cy + 14, 44, 6, 3);
  ctx.fill();
  ctx.restore();
}

function drawFinishResult(metrics, weight) {
  canvas.width = FINISH_LOGICAL_WIDTH * EXPORT_SCALE;
  canvas.height = FINISH_LOGICAL_HEIGHT * EXPORT_SCALE;
  ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
  const W = FINISH_LOGICAL_WIDTH;
  const H = FINISH_LOGICAL_HEIGHT;
  const cx = W / 2;
  // Official Zwift finish panel: a bright-blue rounded panel floating over
  // the scene, everything centered, white text, content distributed over
  // the full panel height (fractions of H below mirror the official
  // layout). The crown stays our own vector drawing; no ride title,
  // credit or SP is drawn here (SP lives in the report header only).
  // The PNG keeps transparent corners outside the rounded panel.
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 18);
  ctx.clip();
  ctx.fillStyle = '#0066aa';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';

  // Crown graphic unchanged, scaled to ~54px wide, center ≈ 0.13H.
  const crownCy = 50;
  ctx.save();
  ctx.translate(cx, crownCy);
  ctx.scale(54 / 44, 54 / 44);
  ctx.translate(-cx, -crownCy);
  drawFinishCrown(cx, crownCy);
  ctx.restore();

  ctx.font = reportFont(40, 700, FINISH_FONT);
  ctx.fillText('完走タイム', cx, H * 0.24);

  // The clock keeps the official panel's fixed proportions (~88px at this
  // width, like the official "25:58"); it only shrinks when a very long
  // time string would overflow the panel — it never scales up.
  const timeText = formatDuration(metrics.timerSeconds);
  let timeSize = 88;
  ctx.font = reportFont(timeSize, 700, REPORT_NUMBER_FONT);
  const measuredTimeWidth = ctx.measureText(timeText).width;
  if (measuredTimeWidth > W * 0.88) {
    timeSize = Math.round(Math.max(56, (timeSize * (W * 0.88)) / measuredTimeWidth));
    ctx.font = reportFont(timeSize, 700, REPORT_NUMBER_FONT);
  }
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.fillText(timeText, cx, H * 0.4);
  ctx.restore();

  ctx.font = reportFont(17, 500, FINISH_FONT);
  ctx.fillText('パワー', cx, H * 0.56);

  const labels = [['20分', 1200], ['5分', 300], ['1分', 60], ['15秒', 15]];
  labels.forEach(([label, seconds], index) => {
    const x = cx + (index - 1.5) * 95;
    ctx.font = reportFont(34, 500, REPORT_NUMBER_FONT);
    ctx.fillText(calculateWattsPerKg(metrics.bestPower[seconds], weight).toFixed(1), x, H * 0.65);
    ctx.font = reportFont(14, 500, FINISH_FONT);
    ctx.fillText(label, x, H * 0.71);
  });

  const buttonWidth = W * 0.76;
  const buttonX = (W - buttonWidth) / 2;
  const buttonY = H * 0.79;
  const buttonHeight = H * 0.095;
  roundRect(ctx, buttonX, buttonY, buttonWidth, buttonHeight, 8, '#f5f5f5');
  roundRect(ctx, buttonX + 7, buttonY + 7, buttonWidth - 14, buttonHeight - 14, 4, '#ff5b1a');

  ctx.font = reportFont(28, 700, FINISH_FONT);
  ctx.fillStyle = '#fff';
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.fillText('閉じる', cx, buttonY + buttonHeight / 2);
  ctx.restore();

  ctx.restore();
}

function drawRideReport(metrics, options) {
  canvas.width = REPORT_LOGICAL_WIDTH * EXPORT_SCALE;
  canvas.height = REPORT_LOGICAL_HEIGHT * EXPORT_SCALE;
  ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
  ctx.clearRect(0, 0, REPORT_LOGICAL_WIDTH, REPORT_LOGICAL_HEIGHT);
  ctx.fillStyle = '#f6f6f4';
  ctx.fillRect(0, 0, REPORT_LOGICAL_WIDTH, REPORT_LOGICAL_HEIGHT);

  roundRect(ctx, 0, 0, REPORT_LOGICAL_WIDTH, REPORT_LOGICAL_HEIGHT, 8, '#f6f6f4');
  ctx.fillStyle = '#2d2d2d';
  ctx.fillRect(0, 0, 1000, 41);
  ctx.fillStyle = '#fff';
  ctx.font = reportFont(37);
  ctx.textAlign = 'center';
  ctx.fillText('ライドレポート', 500, 34);
  drawReportFanToolMark();

  drawHeader(metrics, options);
  drawTabs();
  drawTimeline(metrics, options);
  drawLegends();
  drawDistributionPanels(metrics, options);
}


function drawHeader(metrics, { title, level, sp, avatarMessage, avatarBubbleColor, avatarTextColor }) {
  ctx.fillStyle = '#27272b';
  ctx.textAlign = 'left';
  // Shrink the title to fit before the avatar/bubble area (which starts
  // around x=736 at its widest); truncate with an ellipsis as a last resort
  // so a long title can never slide under the avatar.
  const TITLE_MAX_WIDTH = 695;
  const TITLE_MIN_FONT_SIZE = 18;
  let titleFontSize = 27;
  ctx.font = reportFont(titleFontSize, 800, REPORT_NUMBER_FONT);
  while (ctx.measureText(title).width > TITLE_MAX_WIDTH && titleFontSize > TITLE_MIN_FONT_SIZE) {
    titleFontSize -= 1;
    ctx.font = reportFont(titleFontSize, 800, REPORT_NUMBER_FONT);
  }
  let displayTitle = title;
  if (ctx.measureText(displayTitle).width > TITLE_MAX_WIDTH) {
    while (displayTitle.length > 1 && ctx.measureText(`${displayTitle}…`).width > TITLE_MAX_WIDTH) {
      displayTitle = displayTitle.slice(0, -1);
    }
    displayTitle = `${displayTitle}…`;
  }
  ctx.fillText(displayTitle, 27, 72);

  // Each stat owns the slot from its x to the next stat's x (SP runs to
  // 912, just before the avatar); drawHeaderStat shrinks the value until
  // icon + value + unit all fit inside the slot, gap included.
  const stats = [
    { icon: 'bolt', value: formatInt(metrics.avgPower), unit: 'AVG', x: 37, slotEnd: 240 },
    { icon: 'route', value: metrics.distanceKm.toFixed(1), unit: 'km', x: 240, slotEnd: 414 },
    { icon: 'clock', value: formatDuration(metrics.timerSeconds), unit: '', x: 414, slotEnd: 610 },
    { icon: null, value: formatInt(metrics.calories), unit: 'KCAL', x: 610, slotEnd: 817 },
    { icon: null, value: formatInt(sp), unit: 'SP', x: 817, slotEnd: 912, outline: true },
  ];
  drawLevelProgress(level);
  drawAvatar(avatarMessage, avatarBubbleColor, avatarTextColor);
  stats.forEach((stat) => drawHeaderStat(stat));
}

function drawReportFanToolMark() {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,.56)';
  ctx.font = reportFont(9, 800);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  FAN_TOOL_MARK_LINES.forEach((line, index) => ctx.fillText(line, 984, 12 + index * 13));
  ctx.restore();
}


function drawHeaderStat({ icon, value, unit, x, slotEnd, outline = false }) {
  ctx.fillStyle = '#24242a';
  ctx.textAlign = 'left';
  const valueX = icon ? x + 32 : x;
  if (icon) drawHeaderIcon(icon, x, 105);
  const text = String(value);
  // Budget the whole stat against its slot: icon space + value + gap +
  // unit (measured at the font the unit is actually drawn with). A wide
  // value like 18:56:13 shrinks until the unit still ends before the next
  // stat starts, instead of running straight into it. A stat with an empty
  // unit (the clock) draws no unit and reserves no width for one, so the
  // freed space counts toward the value's shrink decision.
  const slotWidth = slotEnd - 14 - x;
  const iconWidth = icon ? 32 : 0;
  ctx.font = reportFont(12);
  const unitWidth = unit ? ctx.measureText(unit).width + 5 : 0;
  let fontSize = 39;
  ctx.font = reportFont(fontSize, 800, REPORT_NUMBER_FONT);
  while (fontSize > 22 && iconWidth + ctx.measureText(text).width + unitWidth > slotWidth) {
    fontSize -= 1;
    ctx.font = reportFont(fontSize, 800, REPORT_NUMBER_FONT);
  }
  if (outline) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    ctx.strokeText(text, valueX, 118);
    ctx.restore();
  }
  ctx.fillText(text, valueX, 118);
  if (unit) {
    const unitX = valueX + ctx.measureText(text).width + 5;
    ctx.font = reportFont(12);
    ctx.fillText(unit, unitX, 116);
  }
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
  ctx.fillText(`🚴 ${formatInt(level)}`, 58, 146);
  // No XP data source exists, so the track stays a plain full track:
  // no partial progress fill and no invented XP number.
  roundRect(ctx, 96, 133, 878, 16, 8, '#c9c9c9');
}

function drawAvatar(message = DEFAULT_AVATAR_MESSAGE, bubbleColor = DEFAULT_AVATAR_BUBBLE_COLOR, textColor = DEFAULT_AVATAR_TEXT_COLOR) {
  ctx.save();
  ctx.translate(916, 45);
  ctx.rotate(-0.12);
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const text = String(message).trim() || DEFAULT_AVATAR_MESSAGE;
  let fontSize = 20;
  const minBubbleWidth = 69;
  const maxBubbleWidth = 180;
  const bubblePaddingX = 14;
  const maxTextWidth = maxBubbleWidth - bubblePaddingX * 2;
  ctx.font = reportFont(fontSize);
  while (ctx.measureText(text).width > maxTextWidth && fontSize > 12) {
    fontSize -= 1;
    ctx.font = reportFont(fontSize);
  }
  const textWidth = ctx.measureText(text).width;
  const bubbleWidth = Math.min(maxBubbleWidth, Math.max(minBubbleWidth, Math.ceil(textWidth + bubblePaddingX * 2)));
  roundRect(ctx, -bubbleWidth, -1, bubbleWidth, 38, 9, bubbleColor);
  ctx.fillStyle = textColor;
  ctx.fillText(text, -bubbleWidth / 2, 25);
  ctx.restore();

  ctx.save();
  ctx.translate(944, 101);
  if (state.avatarImage) {
    // Clip the uploaded image to the same circle as the default avatar's
    // face (r=29 at this origin), with high-quality smoothing.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, 29, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.avatarImage, -29, -29, 58, 58);
    ctx.restore();
  } else {
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
  }
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
  const { min: heartLineMin, max: heartLineMax } = getHeartLineRange(metrics.maxHeartRate, maxHrSetting);
  // 0bpm がグラフ枠の一番下（パワーの棒グラフと同じ基準線）に来るよう、
  // 描画領域の下端を枠の底に合わせる。
  const heartLineY = y + 28;
  const heartLineHeight = height - 28;
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

  // Peak labels must describe the series actually drawn (rolling-averaged
  // and downsampled), not raw 1-second record spikes the chart's own line
  // never reaches.
  const drawnPowerPeak = powers.reduce((peak, value, index) => (
    Number.isFinite(value) && (!peak || value > peak.value) ? { value, index } : peak
  ), null);
  if (drawnPowerPeak && drawnPowerPeak.value > 0) {
    const maxPowerX = x + (drawnPowerPeak.index + 0.5) * (width / Math.max(1, powers.length));
    const maxPowerY = getPowerLineY(drawnPowerPeak.value, y, height, maxGraphPower, powerGraphDrawHeight);
    drawPeakLabel(`${formatInt(drawnPowerPeak.value)}w`, maxPowerX, maxPowerY - 16, '#fff', '#ffb21a', y + 16, y + height - 22, x, x + width);
  }
  const drawnHrPeak = hrs.reduce((peak, value, index) => (
    Number.isFinite(value) && (!peak || value > peak.value) ? { value, index } : peak
  ), null);
  if (drawnHrPeak) {
    const maxHrX = x + (drawnHrPeak.index / Math.max(1, hrs.length - 1)) * width;
    const maxHrY = getSeriesY(
      drawnHrPeak.value,
      heartLineY,
      heartLineHeight,
      heartLineMax,
      heartLineMin,
      HEART_LINE_AMPLITUDE_SCALE,
    );
    drawPeakLabel(`${formatInt(drawnHrPeak.value)}bpm`, maxHrX, maxHrY - 16, '#fff', '#e11f28', y + 16, y + height - 22, x, x + width);
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

// 下端(min)を描画領域の一番下に固定したまま振れ幅だけを圧縮する。
// 中央基準で縮めると min が下端から浮いてしまうため、下端を基準にする。
function getSeriesY(value, y, height, max, min = 0, amplitudeScale = 1) {
  const ratio = (value - min) / Math.max(1, max - min);
  return y + height - ratio * height * amplitudeScale;
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
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
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

function drawPeakLabel(text, x, y, color, pointerColor, minY = -Infinity, maxY = Infinity, minX = -Infinity, maxX = Infinity) {
  const labelY = Math.max(minY, Math.min(maxY, y));
  ctx.font = reportFont(13);
  // Keep the whole label (text + pointer) inside the panel horizontally so
  // a peak at the right edge does not clip.
  const halfWidth = ctx.measureText(text).width / 2 + 4;
  const labelX = Math.max(minX + halfWidth, Math.min(maxX - halfWidth, x));
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, labelX, labelY);
  ctx.fillStyle = pointerColor;
  ctx.beginPath();
  ctx.moveTo(labelX - 4, labelY + 6);
  ctx.lineTo(labelX + 4, labelY + 6);
  ctx.lineTo(labelX, labelY + 13);
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
  drawPowerHistogram(metrics, 34, 464, 436, 112, 610, panelBottomY, 27, 449);
  drawHeartHistogram(metrics, options, 525, 452, 449, 124, 610, panelBottomY, 525, 449);
  drawDistributionUnit(251, 628, 'ワット');
  drawDistributionUnit(749, 628, 'bpm');
}

// Clamp an AVG marker/badge into its panel: the marker line stays within
// [panelX, panelX + panelWidth] and the badge (40 wide, drawn centered on
// its x) is shifted so the whole box remains inside the panel. Averages
// below the axis minimum (e.g. avgPower < 100) otherwise push the marker
// and badge off the panel's left edge.
function clampAvgMarker(rawX, panelX, panelWidth) {
  const lineX = Math.max(panelX, Math.min(panelX + panelWidth, rawX));
  const badgeX = Math.max(panelX + 20, Math.min(panelX + panelWidth - 20, lineX));
  return { lineX, badgeX };
}

function drawPowerHistogram(metrics, x, y, width, height, axisY, panelBottomY, panelX = x, panelWidth = width) {
  // Official Zwift plots the full range starting at 0W: samples below
  // 100W appear as bars at the left of the panel and only the axis labels
  // start at 100, inset from the left edge. Bin counts are dt-weighted
  // (seconds represented), like the other metrics.
  const powerValues = [];
  const powerWeights = [];
  metrics.records.forEach((record) => {
    if (!Number.isFinite(record.power)) return;
    powerValues.push(record.power);
    powerWeights.push(Number.isFinite(record.dt) ? record.dt : 1);
  });
  const maxPowerAxis = getPowerHistogramMax(powerValues);
  const bins = makeHistogram(powerValues, 0, maxPowerAxis, 36, powerWeights);
  const maxBin = Math.max(...bins, 1);
  const baselineY = panelBottomY;
  ctx.fillStyle = '#fff';
  bins.forEach((count, i) => {
    const barW = width / bins.length + 0.5;
    const barH = count ? Math.max(5, (count / maxBin) * (baselineY - y - 24)) : 0;
    roundedTopRect(ctx, x + i * (width / bins.length), baselineY - barH, barW, barH, 10, '#fff');
  });
  drawAxisLabelsAt(axisY, makePowerAxisLabels(maxPowerAxis).map((value) => ({
    label: formatInt(value),
    x: x + (value / Math.max(1, maxPowerAxis)) * width,
  })));
  const rawAvgX = x + (metrics.avgPower / Math.max(1, maxPowerAxis)) * width;
  const { lineX: avgX, badgeX: avgBadgeX } = clampAvgMarker(rawAvgX, panelX, panelWidth);
  ctx.strokeStyle = '#8c8f93';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(avgX, y + 34);
  ctx.lineTo(avgX, baselineY);
  ctx.stroke();
  badge(`AVG
${formatInt(metrics.avgPower)}`, avgBadgeX, y + 18);
}

// Axis label values for the power distribution: 100, 150, 200, ... up to
// the axis maximum, positioned by the 0-based scale when drawn. The step
// widens on very large axes so labels stay readable; the axis maximum is
// always included.
function makePowerAxisLabels(maxPowerAxis) {
  let step = 50;
  while (maxPowerAxis / step > 12) step *= 2;
  const values = [];
  for (let value = 100; value < maxPowerAxis; value += step) values.push(value);
  if (values[values.length - 1] !== maxPowerAxis) values.push(maxPowerAxis);
  return values;
}

function getPowerHistogramMax(values) {
  const maxValue = Math.max(...values, 600);
  if (maxValue <= 600) return 600;
  return Math.min(2000, Math.ceil(maxValue / 100) * 100);
}

function drawHeartHistogram(metrics, { maxHrSetting }, x, y, width, height, axisY, panelBottomY, panelX = x, panelWidth = width) {
  const displayMinHr = Math.max(40, Math.round((maxHrSetting * 0.32) / 5) * 5);
  const zoneThresholds = [
    0.5 * maxHrSetting,
    0.6 * maxHrSetting,
    0.7 * maxHrSetting,
    0.8 * maxHrSetting,
    0.9 * maxHrSetting,
    maxHrSetting,
  ];
  const colors = ['#338cf0', '#58b957', '#ffd342', '#ff6538', '#ff2f1d'];
  // Fully linear value-to-x mapping over the displayed range, matching
  // official Zwift: a heart-rate value always sits at
  // x + (value - min) / (max - min) * width, so axis labels, zone bands,
  // bars and the AVG marker all agree with the numbers. (The previous
  // zone-based warping moved values away from their labeled positions.)
  const hrToX = (value) => {
    const clampedValue = Math.max(displayMinHr, Math.min(maxHrSetting, value));
    return x + ((clampedValue - displayMinHr) / Math.max(1, maxHrSetting - displayMinHr)) * width;
  };
  const axisLabels = Array.from({ length: 11 }, (_, index) => {
    const labelX = x + (index / 10) * width;
    const labelValue = displayMinHr + ((maxHrSetting - displayMinHr) * index) / 10;
    return { label: formatInt(labelValue), x: labelX };
  });
  // Clip the zone backgrounds to the panel's rounded corners (panel is
  // drawn in drawDistributionPanels at (x, panelBottomY - 158, width, 158)
  // with radius 9) so their square bottom corners do not poke out.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, panelBottomY - 158, width, 158, 9);
  ctx.clip();
  colors.forEach((color, i) => {
    // Zone band edges are the zone boundary heart rates (fractions of max
    // HR, as before) mapped through the same linear scale; bands extending
    // past the panel are cut off by the clip above.
    const start = hrToX(zoneThresholds[i]);
    const end = i === colors.length - 1 ? x + width : Math.min(x + width, hrToX(zoneThresholds[i + 1]));
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
  ctx.restore();
  const hrValues = [];
  const hrWeights = [];
  metrics.records.forEach((record) => {
    if (!Number.isFinite(record.heartRate)) return;
    hrValues.push(record.heartRate);
    hrWeights.push(Number.isFinite(record.dt) ? record.dt : 1);
  });
  const bins = makeMappedHistogram(hrValues, 30, (value) => hrToX(value), x, width, hrWeights);
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
  const { lineX: avgX, badgeX: avgBadgeX } = clampAvgMarker(hrToX(metrics.avgHeartRate), panelX, panelWidth);
  ctx.strokeStyle = '#8c8f93';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(avgX, y + 34);
  ctx.lineTo(avgX, baselineY);
  ctx.stroke();
  badge(`AVG
${formatInt(metrics.avgHeartRate)}`, avgBadgeX, y + 28);
}

function makeHistogram(values, min, max, bins, weights) {
  const hist = Array.from({ length: bins }, () => 0);
  values.forEach((value, i) => {
    if (!Number.isFinite(value)) return;
    const index = Math.max(0, Math.min(bins - 1, Math.floor(((value - min) / Math.max(1, max - min)) * bins)));
    hist[index] += weights ? weights[i] : 1;
  });
  return hist;
}

function makeMappedHistogram(values, bins, mapValueToX, x, width, weights) {
  const hist = Array.from({ length: bins }, () => 0);
  values.forEach((value, i) => {
    if (!Number.isFinite(value)) return;
    const mappedX = mapValueToX(value);
    const index = Math.max(0, Math.min(bins - 1, Math.floor(((mappedX - x) / Math.max(1, width)) * bins)));
    hist[index] += weights ? weights[i] : 1;
  });
  return hist;
}

function drawAxisLabelsAt(y, labels) {
  ctx.fillStyle = '#1c1c1c';
  ctx.font = reportFont(11, 800, REPORT_NUMBER_FONT);
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
  ctx.font = reportFont(17, 800, REPORT_NUMBER_FONT);
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

// Shared integer formatter for displayed numbers: thousands separators
// (1,200 etc.) via ja-JP grouping. Decimals (distance, W/kg) and clock
// strings do not go through this.
const intFormatter = new Intl.NumberFormat('ja-JP');
function formatInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? intFormatter.format(Math.round(num)) : String(value);
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

// --- Auto-update: reload once when a newer build is deployed -----------
// The running bundle knows its own build ID (__APP_VERSION__, injected by
// vite.config.js). version.json is emitted next to the built site on every
// deploy and fetched with no-store, so a mismatch means this page is a
// cached old version. A timestamp guard prevents reload loops.
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
const VERSION_RELOAD_KEY = 'appVersionReloadAt';

async function checkForAppUpdate() {
  if (!APP_VERSION) return;
  try {
    const response = await fetch('./version.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!data?.version || data.version === APP_VERSION) return;
    let lastReloadAt = 0;
    try { lastReloadAt = Number(sessionStorage.getItem(VERSION_RELOAD_KEY)) || 0; } catch {}
    if (Date.now() - lastReloadAt < 30_000) return;
    try { sessionStorage.setItem(VERSION_RELOAD_KEY, String(Date.now())); } catch {}
    window.location.reload();
  } catch {
    // Offline or dev server without version.json: stay on this version.
  }
}

checkForAppUpdate();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForAppUpdate();
});

syncGraphSmoothnessSliderDefault();
syncPowerGraphHeightSliderDefault();
syncGraphLineWidthSliderDefault();
syncModeLayoutState();
syncPreviewOptionsOpenState();
drawPlaceholder();
