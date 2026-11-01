// Intervals.icu API 連携。
//
// このサイトはサーバーを持たない静的ページなので、APIキーは利用者本人の
// ブラウザ内にだけ保存し、通信は intervals.icu へ直接行う。他のサーバーへ
// キーを送る経路は存在しない。キーの保存先は設定画面の選択により
// localStorage（この端末に保存）か sessionStorage（タブを閉じたら消去）の
// どちらか一方だけにし、もう一方に古いキーが残らないようにする。

export const INTERVALS_API_BASE = 'https://intervals.icu/api/v1';

export const INTERVALS_STREAM_TYPES = [
  'time',
  'watts',
  'heartrate',
  'cadence',
  'distance',
  'velocity_smooth',
];

const API_KEY_STORAGE_KEY = 'intervalsIcu.apiKey';
const ATHLETE_ID_STORAGE_KEY = 'intervalsIcu.athleteId';

// Intervals.icu の個人APIキーは HTTP Basic 認証で使う。
// ユーザー名は固定文字列 "API_KEY"、パスワードがキー本体。
export function buildIntervalsAuthHeader(apiKey) {
  const raw = `API_KEY:${String(apiKey ?? '').trim()}`;
  return `Basic ${base64Encode(raw)}`;
}

function base64Encode(text) {
  if (typeof btoa === 'function') return btoa(text);
  return Buffer.from(text, 'utf8').toString('base64');
}

// アスリートIDは未入力なら "0"（= キーの持ち主）として扱う。
// 表示名の "i123456" 形式もそのまま API で使える。
export function normalizeAthleteId(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || '0';
}

export function buildActivitiesUrl({ athleteId, oldest, newest }) {
  const params = new URLSearchParams({
    oldest,
    newest,
    fields: [
      'id',
      'name',
      'type',
      'start_date_local',
      'moving_time',
      'elapsed_time',
      'distance',
      'total_elevation_gain',
      'calories',
    ].join(','),
  });
  return `${INTERVALS_API_BASE}/athlete/${encodeURIComponent(normalizeAthleteId(athleteId))}/activities?${params}`;
}

export function buildStreamsUrl(activityId) {
  const params = new URLSearchParams({ types: INTERVALS_STREAM_TYPES.join(',') });
  return `${INTERVALS_API_BASE}/activity/${encodeURIComponent(String(activityId))}/streams?${params}`;
}

export function buildAthleteUrl(athleteId) {
  return `${INTERVALS_API_BASE}/athlete/${encodeURIComponent(normalizeAthleteId(athleteId))}`;
}

// 一覧表示用にアクティビティ概要を整える。距離は API のメートル表記を
// このアプリの表示単位 km に直す。
export function summarizeActivity(raw) {
  if (!raw || raw.id == null) return null;
  const distanceM = Number(raw.distance);
  const elevationM = Number(raw.total_elevation_gain);
  return {
    id: String(raw.id),
    name: String(raw.name ?? '').trim() || '(無題)',
    type: String(raw.type ?? ''),
    startDateLocal: String(raw.start_date_local ?? ''),
    movingTimeSec: Number.isFinite(Number(raw.moving_time)) ? Number(raw.moving_time) : null,
    elapsedTimeSec: Number.isFinite(Number(raw.elapsed_time)) ? Number(raw.elapsed_time) : null,
    distanceKm: Number.isFinite(distanceM) ? distanceM / 1000 : null,
    elevationGainM: Number.isFinite(elevationM) ? elevationM : null,
    calories: Number.isFinite(Number(raw.calories)) ? Number(raw.calories) : null,
  };
}

function streamDataByType(streams) {
  const byType = new Map();
  if (Array.isArray(streams)) {
    streams.forEach((stream) => {
      if (stream && typeof stream.type === 'string') byType.set(stream.type, stream.data);
    });
  } else if (streams && typeof streams === 'object') {
    Object.entries(streams).forEach(([type, stream]) => {
      byType.set(type, Array.isArray(stream) ? stream : stream?.data);
    });
  }
  return byType;
}

function finiteOrUndefined(value) {
  return Number.isFinite(value) ? value : undefined;
}

// Intervals.icu のストリームを、FIT パーサーの出力と同じ形
// （extractMetrics が受け取る data）に変換する。
// 単位の違いに注意: FIT 側は本アプリのパーサー設定で距離 km・速度 km/h に
// 揃っているため、Intervals.icu の距離 m・速度 m/s をここで合わせる。
export function streamsToFitData(activity, streams) {
  const byType = streamDataByType(streams);
  const time = byType.get('time');
  if (!Array.isArray(time) || time.length === 0) {
    // Strava 由来のアクティビティは規約上 API でストリームを返さないため、
    // この失敗の多くはそれが原因。利用者が判断できるよう文面で案内する。
    throw new Error('時系列データ（time）を取得できませんでした。Strava由来のアクティビティはAPI経由で取得できないため、Garminなどから取り込んだアクティビティを選んでください。');
  }

  const watts = byType.get('watts');
  const heartrate = byType.get('heartrate');
  const cadence = byType.get('cadence');
  const distance = byType.get('distance');
  const velocity = byType.get('velocity_smooth');

  const startMs = Date.parse(activity?.startDateLocal || activity?.start_date_local || '');
  const startBase = Number.isFinite(startMs) ? startMs : 0;

  // ストリームの欠測は null で届く。Number(null) は 0 になってしまうため、
  // 数値化の前に null / undefined を欠測として弾く。
  const valueAt = (series, index) => {
    if (!Array.isArray(series)) return undefined;
    const raw = series[index];
    if (raw === null || raw === undefined) return undefined;
    return finiteOrUndefined(Number(raw));
  };

  const records = time.map((elapsed, index) => {
    const elapsedSec = Number(elapsed);
    const distanceM = valueAt(distance, index);
    const velocityMs = valueAt(velocity, index);
    return {
      timestamp: new Date(startBase + (Number.isFinite(elapsedSec) ? elapsedSec : index) * 1000),
      elapsed_time: finiteOrUndefined(elapsedSec),
      power: valueAt(watts, index),
      heart_rate: valueAt(heartrate, index),
      cadence: valueAt(cadence, index),
      distance: distanceM === undefined ? undefined : distanceM / 1000,
      speed: velocityMs === undefined ? undefined : velocityMs * 3.6,
    };
  });

  const session = {};
  if (Number.isFinite(activity?.distanceKm) && activity.distanceKm > 0) {
    session.total_distance = activity.distanceKm;
  }
  if (Number.isFinite(activity?.calories)) session.total_calories = activity.calories;
  const timerSec = activity?.movingTimeSec ?? activity?.elapsedTimeSec;
  if (Number.isFinite(timerSec) && timerSec > 0) session.total_timer_time = timerSec;

  return {
    records,
    sessions: [session],
    sampleIntervalSeconds: sampleIntervalSeconds(time),
  };
}

// スマートレコーディング等で間隔が一定でない場合に備え、代表間隔は
// 中央値を採用する（FIT 側の duration 補正と同じ考え方）。
function sampleIntervalSeconds(time) {
  const diffs = [];
  for (let i = 1; i < time.length; i += 1) {
    const diff = Number(time[i]) - Number(time[i - 1]);
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }
  if (!diffs.length) return undefined;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// ---- 設定の保存 ----

function defaultStorages() {
  if (typeof window === 'undefined') return { local: null, session: null };
  let local = null;
  let session = null;
  try { local = window.localStorage; } catch (_) { /* 利用不可環境では保存しない */ }
  try { session = window.sessionStorage; } catch (_) { /* 同上 */ }
  return { local, session };
}

function readKey(storage, key) {
  try { return storage?.getItem(key) ?? null; } catch (_) { return null; }
}

function writeKey(storage, key, value) {
  try {
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
  } catch (_) { /* 保存できなくても利用は継続できる */ }
}

export function loadIntervalsSettings(storages = defaultStorages()) {
  const fromLocal = readKey(storages.local, API_KEY_STORAGE_KEY);
  if (fromLocal) {
    return {
      apiKey: fromLocal,
      athleteId: readKey(storages.local, ATHLETE_ID_STORAGE_KEY) || '',
      remember: true,
    };
  }
  const fromSession = readKey(storages.session, API_KEY_STORAGE_KEY);
  if (fromSession) {
    return {
      apiKey: fromSession,
      athleteId: readKey(storages.session, ATHLETE_ID_STORAGE_KEY) || '',
      remember: false,
    };
  }
  return { apiKey: '', athleteId: '', remember: true };
}

// remember=true なら localStorage、false なら sessionStorage にだけ書く。
// 保存先でない側は必ず消し、古いキーが残り続ける事故を防ぐ。
export function saveIntervalsSettings(settings, storages = defaultStorages()) {
  const apiKey = String(settings?.apiKey ?? '').trim();
  const athleteId = String(settings?.athleteId ?? '').trim();
  const target = settings?.remember ? storages.local : storages.session;
  const other = settings?.remember ? storages.session : storages.local;
  writeKey(target, API_KEY_STORAGE_KEY, apiKey);
  writeKey(target, ATHLETE_ID_STORAGE_KEY, athleteId);
  writeKey(other, API_KEY_STORAGE_KEY, '');
  writeKey(other, ATHLETE_ID_STORAGE_KEY, '');
}

export function clearIntervalsSettings(storages = defaultStorages()) {
  writeKey(storages.local, API_KEY_STORAGE_KEY, '');
  writeKey(storages.local, ATHLETE_ID_STORAGE_KEY, '');
  writeKey(storages.session, API_KEY_STORAGE_KEY, '');
  writeKey(storages.session, ATHLETE_ID_STORAGE_KEY, '');
}

// ---- API 呼び出し ----

export class IntervalsApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function intervalsFetchJson(url, apiKey, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new IntervalsApiError('通信機能を利用できませんでした。');
  let response;
  try {
    response = await doFetch(url, {
      headers: { Authorization: buildIntervalsAuthHeader(apiKey), Accept: 'application/json' },
    });
  } catch (_) {
    // ネットワーク不通や CORS で失敗した場合はここに来る。原因を断定できない
    // ため、キーの問題とは切り分けて伝える。
    throw new IntervalsApiError('Intervals.icuへ接続できませんでした。通信環境を確認してください。');
  }
  if (response.status === 401 || response.status === 403) {
    throw new IntervalsApiError('認証に失敗しました。APIキーを確認してください。', response.status);
  }
  if (!response.ok) {
    throw new IntervalsApiError(`Intervals.icuからエラーが返りました（${response.status}）。`, response.status);
  }
  return response.json();
}

export async function testIntervalsConnection(settings, fetchImpl) {
  const athlete = await intervalsFetchJson(buildAthleteUrl(settings?.athleteId), settings?.apiKey, fetchImpl);
  return athlete;
}

export async function fetchIntervalsActivities(settings, { oldest, newest }, fetchImpl) {
  const raw = await intervalsFetchJson(
    buildActivitiesUrl({ athleteId: settings?.athleteId, oldest, newest }),
    settings?.apiKey,
    fetchImpl,
  );
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map(summarizeActivity)
    .filter(Boolean)
    .sort((a, b) => String(b.startDateLocal).localeCompare(String(a.startDateLocal)));
}

export async function fetchIntervalsActivityStreams(settings, activityId, fetchImpl) {
  return intervalsFetchJson(buildStreamsUrl(activityId), settings?.apiKey, fetchImpl);
}
