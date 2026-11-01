import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIntervalsAuthHeader,
  normalizeAthleteId,
  buildActivitiesUrl,
  buildStreamsUrl,
  summarizeActivity,
  streamsToFitData,
  loadIntervalsSettings,
  saveIntervalsSettings,
  clearIntervalsSettings,
  fetchIntervalsActivities,
  IntervalsApiError,
} from '../src/intervals.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('auth header is HTTP Basic with fixed API_KEY user name', () => {
  const header = buildIntervalsAuthHeader('abc123');
  assert.equal(header, `Basic ${Buffer.from('API_KEY:abc123', 'utf8').toString('base64')}`);
});

test('athlete id defaults to 0 (key owner) when blank', () => {
  assert.equal(normalizeAthleteId(''), '0');
  assert.equal(normalizeAthleteId('  '), '0');
  assert.equal(normalizeAthleteId(' i123456 '), 'i123456');
});

test('activities url carries the range without field filtering', () => {
  const url = buildActivitiesUrl({ athleteId: '', oldest: '2026-10-01', newest: '2026-10-31' });
  assert.match(url, /\/athlete\/0\/activities\?/);
  assert.match(url, /oldest=2026-10-01/);
  assert.match(url, /newest=2026-10-31/);
  assert.doesNotMatch(url, /fields=/);
});

test('summarizeActivity falls back when the name is empty', () => {
  const fromTitle = summarizeActivity({ id: 'i2', title: 'Evening Ride', type: 'Ride', start_date_local: '2026-10-30T18:00:00' });
  assert.equal(fromTitle.name, 'Evening Ride');
  const fromType = summarizeActivity({ id: 'i3', name: '  ', type: 'VirtualRide', start_date_local: '2026-10-30T06:00:00' });
  assert.equal(fromType.name, 'VirtualRide（10/30）');
  const bare = summarizeActivity({ id: 'i4' });
  assert.equal(bare.name, 'アクティビティ');
});

test('streams url requests the series the graph uses', () => {
  const url = buildStreamsUrl('i123');
  assert.match(url, /\/activity\/i123\/streams\?/);
  assert.match(url, /types=time(%2C|,)watts/);
});

test('summarizeActivity converts meters to km', () => {
  const summary = summarizeActivity({
    id: 'i1',
    name: 'Morning Ride',
    type: 'Ride',
    start_date_local: '2026-10-30T06:00:00',
    moving_time: 3600,
    distance: 42195,
    total_elevation_gain: 500,
  });
  assert.equal(summary.id, 'i1');
  assert.equal(summary.distanceKm, 42.195);
  assert.equal(summary.movingTimeSec, 3600);
});

test('streamsToFitData converts units to the FIT parser shape', () => {
  const activity = summarizeActivity({
    id: 'i1',
    name: 'Ride',
    start_date_local: '2026-10-30T06:00:00',
    moving_time: 3,
    distance: 3000,
    calories: 100,
  });
  const data = streamsToFitData(activity, [
    { type: 'time', data: [0, 1, 2] },
    { type: 'watts', data: [100, null, 200] },
    { type: 'heartrate', data: [120, 121, 122] },
    { type: 'cadence', data: [80, 81, 82] },
    { type: 'distance', data: [0, 1500, 3000] },
    { type: 'velocity_smooth', data: [0, 10, 10] },
  ]);

  assert.equal(data.records.length, 3);
  assert.equal(data.records[0].power, 100);
  assert.equal(data.records[1].power, undefined);
  assert.equal(data.records[2].heart_rate, 122);
  // meters -> km, m/s -> km/h, matching the app's FIT parser options
  assert.equal(data.records[1].distance, 1.5);
  assert.equal(data.records[1].speed, 36);
  assert.equal(data.sessions[0].total_distance, 3);
  assert.equal(data.sessions[0].total_timer_time, 3);
  assert.equal(data.sessions[0].total_calories, 100);
  assert.equal(data.sampleIntervalSeconds, 1);
  assert.ok(data.records[0].timestamp instanceof Date);
});

test('streamsToFitData rejects a payload without a time stream', () => {
  assert.throws(
    () => streamsToFitData({ startDateLocal: '2026-10-30T06:00:00' }, [{ type: 'watts', data: [1] }]),
    /time/,
  );
});

test('settings round-trip keeps the key in exactly one storage', () => {
  const storages = { local: fakeStorage(), session: fakeStorage() };
  saveIntervalsSettings({ apiKey: 'k1', athleteId: 'i9', remember: true }, storages);
  assert.deepEqual(loadIntervalsSettings(storages), { apiKey: 'k1', athleteId: 'i9', remember: true });

  saveIntervalsSettings({ apiKey: 'k2', athleteId: '', remember: false }, storages);
  assert.deepEqual(loadIntervalsSettings(storages), { apiKey: 'k2', athleteId: '', remember: false });
  assert.equal(storages.local.getItem('intervalsIcu.apiKey'), null);

  clearIntervalsSettings(storages);
  assert.equal(loadIntervalsSettings(storages).apiKey, '');
});

test('fetchIntervalsActivities maps and sorts newest first', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /\/athlete\/0\/activities/);
    assert.match(options.headers.Authorization, /^Basic /);
    return {
      ok: true,
      status: 200,
      json: async () => ([
        { id: 'i1', name: 'Old', start_date_local: '2026-10-01T06:00:00', moving_time: 60, distance: 1000 },
        { id: 'i2', name: 'New', start_date_local: '2026-10-20T06:00:00', moving_time: 60, distance: 2000 },
      ]),
    };
  };
  const list = await fetchIntervalsActivities({ apiKey: 'k', athleteId: '' }, { oldest: '2026-10-01', newest: '2026-10-31' }, fetchImpl);
  assert.deepEqual(list.map((a) => a.id), ['i2', 'i1']);
});

test('fetchIntervalsActivities turns 401 into a key-focused message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    fetchIntervalsActivities({ apiKey: 'bad', athleteId: '' }, { oldest: '2026-10-01', newest: '2026-10-31' }, fetchImpl),
    (error) => error instanceof IntervalsApiError && /APIキー/.test(error.message),
  );
});
