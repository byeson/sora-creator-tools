const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');
const BACKGROUND_SRC = fs.readFileSync(BACKGROUND_PATH, 'utf8');

function extractBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} start not found`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${label} end not found`);
  return source.slice(start, end);
}

function buildBackgroundRemixHarness() {
  const sanitizerBlock = extractBetween(
    BACKGROUND_SRC,
    'function isPlainObject(value) {',
    'function sanitizeMetricsBatch(items) {',
    'background sanitizer block'
  );
  const resolveIncomingUserKeyBlock = extractBetween(
    BACKGROUND_SRC,
    'function resolveIncomingUserKey(metrics, snap) {',
    'function normalizeMetrics(raw) {',
    'background resolveIncomingUserKey block'
  );
  const flushLoopStart = BACKGROUND_SRC.indexOf('      for (const snap of items) {');
  assert.notEqual(flushLoopStart, -1, 'flush loop start not found');
  const flushLoopEnd = BACKGROUND_SRC.indexOf('\n      if (!dirty) {', flushLoopStart);
  assert.notEqual(flushLoopEnd, -1, 'flush loop end not found');
  const flushLoopBody = BACKGROUND_SRC.slice(flushLoopStart, flushLoopEnd);
  return { sanitizerBlock, resolveIncomingUserKeyBlock, flushLoopBody };
}

function runFlushLoop(metrics, items, seededPostIds = []) {
  const { sanitizerBlock, resolveIncomingUserKeyBlock, flushLoopBody } = buildBackgroundRemixHarness();
  const context = {
    __metrics: metrics,
    __items: items,
    __postIdToUserKey: new Map(seededPostIds),
  };
  vm.createContext(context);
  const bootstrap = `
    const MAX_REMIX_POST_IDS_PER_POST = 300;
    const MAX_MAILBOX_EVENTS_PER_POST = 200;
    const MAX_EVENT_ID_LEN = 256;
    ${sanitizerBlock}
    const MAX_SNAPSHOT_HISTORY_PER_POST = 720;
    const MAX_PROFILE_SERIES_POINTS = 720;
    const DEBUG = { storage: false, thumbs: false };
    function dlog() {}
    function trimSeriesInPlace() {}
    ${resolveIncomingUserKeyBlock}
    const coldSnapshotBuffer = new Map();
    const coldDirtyUsers = new Set();
    const postIdToUserKey = globalThis.__postIdToUserKey;
    let dirty = false;
    const metrics = globalThis.__metrics;
    const items = globalThis.__items;
    const touchedPosts = new Set();
    ${flushLoopBody}
    globalThis.__resultMetrics = metrics;
    globalThis.__dirty = dirty;
  `;
  vm.runInContext(bootstrap, context, { filename: 'background-remix-flush-harness.js' });
  return {
    metrics: context.__resultMetrics,
    dirty: context.__dirty,
  };
}

test('mergeRemixPostIds deduplicates ids and preserves newest ids within the cap', () => {
  const { sanitizerBlock } = buildBackgroundRemixHarness();
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `
      const MAX_REMIX_POST_IDS_PER_POST = 300;
      const MAX_MAILBOX_EVENTS_PER_POST = 200;
      const MAX_EVENT_ID_LEN = 256;
      ${sanitizerBlock}
      globalThis.__mergeRemixPostIds = mergeRemixPostIds;
    `,
    context,
    { filename: 'background-remix-merge-harness.js' }
  );

  const existing = Array.from({ length: 300 }, (_, index) => `s_${index}`);
  const result = context.__mergeRemixPostIds(existing, ['s_299', 's_300', 's_301']);

  assert.equal(result.length, 300);
  assert.equal(result.includes('s_0'), false);
  assert.deepEqual(Array.from(result.slice(-3)), ['s_299', 's_300', 's_301']);
});

test('flush backfills parent remix_post_ids when a remix child arrives', () => {
  const existingMetrics = {
    users: {
      'h:alice': {
        handle: 'alice',
        id: 'user-alice',
        posts: {
          s_parent: { url: null, thumb: null, snapshots: [] }
        },
        followers: [],
        cameos: [],
      }
    }
  };

  const items = [{
    postId: 's_child',
    userKey: 'h:alice',
    userHandle: 'alice',
    userId: 'user-alice',
    parent_post_id: 's_parent',
    ts: 1773545000000,
    uv: 10,
    likes: 1,
    views: 100,
    comments: 0,
    remix_count: 0,
  }];

  const result = runFlushLoop(existingMetrics, items, [['s_parent', 'h:alice']]);
  assert.equal(result.dirty, true);
  assert.deepEqual(
    Array.from(result.metrics.users['h:alice'].posts.s_parent.remix_post_ids),
    ['s_child']
  );
});

test('flush creates a minimal parent stub when the remix parent is not in storage yet', () => {
  const existingMetrics = {
    users: {
      'h:alice': {
        handle: 'alice',
        id: 'user-alice',
        posts: {},
        followers: [],
        cameos: [],
      }
    }
  };

  const items = [{
    postId: 's_child_only',
    userKey: 'h:alice',
    userHandle: 'alice',
    userId: 'user-alice',
    parent_post_id: 's_missing_parent',
    ts: 1773545000000,
    uv: 5,
    likes: 0,
    views: 50,
    comments: 0,
    remix_count: 0,
  }];

  const result = runFlushLoop(existingMetrics, items);
  const parentPost = result.metrics.users['h:alice'].posts.s_missing_parent;

  assert.equal(result.dirty, true);
  assert.ok(parentPost);
  assert.deepEqual(Array.from(parentPost.remix_post_ids), ['s_child_only']);
  assert.deepEqual(Array.from(parentPost.snapshots), []);
});

test('flush ignores suspicious zero follower and cameo counts from post-scoped snapshots after positive history exists', () => {
  const existingMetrics = {
    users: {
      'h:alice': {
        handle: 'alice',
        id: 'user-alice',
        posts: {},
        followers: [{ t: 1773544000000, count: 120 }],
        cameos: [{ t: 1773544000000, count: 9 }],
      }
    }
  };

  const items = [{
    postId: 's_child_only',
    userKey: 'h:alice',
    userHandle: 'alice',
    userId: 'user-alice',
    ts: 1773545000000,
    followers: 0,
    cameo_count: 0,
    uv: 5,
    likes: 0,
    views: 50,
    comments: 0,
    remix_count: 0,
  }];

  const result = runFlushLoop(existingMetrics, items);

  assert.deepEqual(
    Array.from(result.metrics.users['h:alice'].followers),
    [{ t: 1773544000000, count: 120 }]
  );
  assert.deepEqual(
    Array.from(result.metrics.users['h:alice'].cameos),
    [{ t: 1773544000000, count: 9 }]
  );
});
