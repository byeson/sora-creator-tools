const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard.js');

function buildBackgroundHarness() {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const start = src.indexOf('function trimSeriesInPlace(arr, maxPoints = MAX_PROFILE_SERIES_POINTS) {');
  assert.notEqual(start, -1, 'background helper start not found');
  const end = src.indexOf('\n\nfunction normalizeMetrics(raw) {', start);
  assert.notEqual(end, -1, 'background helper end not found');
  const snippet = src.slice(start, end);
  const context = { MAX_PROFILE_SERIES_POINTS: 720 };
  vm.createContext(context);
  vm.runInContext(
    `${snippet}
    globalThis.__shouldPersistFollowerCount = shouldPersistFollowerCount;`,
    context,
    { filename: 'followers-background-harness.js' }
  );
  return { shouldPersistFollowerCount: context.__shouldPersistFollowerCount };
}

function buildDashboardHarness() {
  const src = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  const start = src.indexOf('function sanitizeFollowersSeries(arr){');
  assert.notEqual(start, -1, 'dashboard follower sanitizer start not found');
  const end = src.indexOf('\n\n  function formatUserSelectionLabel(userKey, user){', start);
  assert.notEqual(end, -1, 'dashboard follower sanitizer end not found');
  const snippet = src.slice(start, end);
  const context = {
    metrics: { users: {} },
    isCameoKey: () => false,
    cameoNameFromKey: () => null,
    findUserByHandle: () => null,
  };
  vm.createContext(context);
  vm.runInContext(
    `${snippet}
    globalThis.__sanitizeFollowersSeries = sanitizeFollowersSeries;
    globalThis.__normalizeFollowersChartPoints = normalizeFollowersChartPoints;
    globalThis.__getFollowersSeriesForUser = getFollowersSeriesForUser;`,
    context,
    { filename: 'followers-dashboard-harness.js' }
  );
  return {
    sanitizeFollowersSeries: context.__sanitizeFollowersSeries,
    normalizeFollowersChartPoints: context.__normalizeFollowersChartPoints,
    getFollowersSeriesForUser: context.__getFollowersSeriesForUser,
  };
}

test('background skips persisting a zero follower sample after positive history', () => {
  const { shouldPersistFollowerCount } = buildBackgroundHarness();
  assert.equal(
    shouldPersistFollowerCount([{ t: 1, count: 16474 }], 0),
    false
  );
});

test('background allows an initial zero follower sample when there is no prior history', () => {
  const { shouldPersistFollowerCount } = buildBackgroundHarness();
  assert.equal(shouldPersistFollowerCount([], 0), true);
});

test('dashboard drops a trailing zero follower point when earlier positive data exists', () => {
  const { getFollowersSeriesForUser } = buildDashboardHarness();
  const series = getFollowersSeriesForUser('h:byeson', {
    followers: [
      { t: 1000, count: 16400 },
      { t: 2000, count: 16474 },
      { t: 3000, count: 0 }
    ]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(series)), [
    { t: 1000, count: 16400 },
    { t: 2000, count: 16474 }
  ]);
});

test('dashboard keeps a legitimate zero-only follower series intact', () => {
  const { sanitizeFollowersSeries } = buildDashboardHarness();
  const series = sanitizeFollowersSeries([{ t: 1000, count: 0 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(series)), [{ t: 1000, count: 0 }]);
});

test('dashboard collapses duplicate follower timestamps to the higher count', () => {
  const { sanitizeFollowersSeries } = buildDashboardHarness();
  const series = sanitizeFollowersSeries([
    { t: 1000, count: 16000 },
    { t: 2000, count: 0 },
    { t: 2000, count: 16480 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(series)), [
    { t: 1000, count: 16000 },
    { t: 2000, count: 16480 }
  ]);
});

test('dashboard removes a later zero follower point even when the raw series is out of order', () => {
  const { sanitizeFollowersSeries } = buildDashboardHarness();
  const series = sanitizeFollowersSeries([
    { t: 3000, count: 0 },
    { t: 1000, count: 16000 },
    { t: 2000, count: 16480 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(series)), [
    { t: 1000, count: 16000 },
    { t: 2000, count: 16480 }
  ]);
});

test('followers chart point normalization strips an out-of-order trailing zero point', () => {
  const { normalizeFollowersChartPoints } = buildDashboardHarness();
  const points = normalizeFollowersChartPoints([
    { x: 3000, y: 0, t: 3000 },
    { x: 1000, y: 16000, t: 1000 },
    { x: 2000, y: 16480, t: 2000 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(points)), [
    { x: 1000, y: 16000, t: 1000 },
    { x: 2000, y: 16480, t: 2000 }
  ]);
});
