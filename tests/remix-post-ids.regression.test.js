const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_PATH = path.join(__dirname, '..', 'content.js');
const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard.js');

// ─── Harness builders ───────────────────────────────────────────────────────

function buildContentSanitizerHarness() {
  const src = fs.readFileSync(CONTENT_PATH, 'utf8');
  const start = src.indexOf('const MAX_METRICS_BATCH_ITEMS = 250;');
  assert.notEqual(start, -1, 'content sanitizer start not found');
  const end = src.indexOf('function sanitizeMetricsBatch(items) {', start);
  assert.notEqual(end, -1, 'content sanitizer end not found');
  const snippet = src.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${snippet}\nglobalThis.__sanitizeMetricsItem = sanitizeMetricsItem;\nglobalThis.__sanitizeRemixPostIds = sanitizeRemixPostIds;`,
    context,
    { filename: 'content-harness.js' }
  );
  assert.equal(typeof context.__sanitizeMetricsItem, 'function');
  assert.equal(typeof context.__sanitizeRemixPostIds, 'function');
  return { sanitizeMetricsItem: context.__sanitizeMetricsItem, sanitizeRemixPostIds: context.__sanitizeRemixPostIds };
}

function buildBackgroundSanitizerHarness() {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const start = src.indexOf('function isPlainObject(value) {');
  assert.notEqual(start, -1, 'background sanitizer start not found');
  const end = src.indexOf('function sanitizeMetricsBatch(items) {', start);
  assert.notEqual(end, -1, 'background sanitizer end not found');
  const snippet = src.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `const MAX_REMIX_POST_IDS_PER_POST = 300;\n${snippet}\nglobalThis.__sanitizeMetricsSnapshot = sanitizeMetricsSnapshot;\nglobalThis.__mergeRemixPostIds = mergeRemixPostIds;\nglobalThis.__sanitizeRemixPostIds = sanitizeRemixPostIds;`,
    context,
    { filename: 'background-harness.js' }
  );
  assert.equal(typeof context.__sanitizeMetricsSnapshot, 'function');
  assert.equal(typeof context.__mergeRemixPostIds, 'function');
  return {
    sanitizeMetricsSnapshot: context.__sanitizeMetricsSnapshot,
    mergeRemixPostIds: context.__mergeRemixPostIds,
    sanitizeRemixPostIds: context.__sanitizeRemixPostIds,
  };
}

function toNativeArray(value) {
  return Array.isArray(value) ? Array.from(value) : value;
}

function buildDashboardCSVHarness() {
  const src = fs.readFileSync(DASHBOARD_PATH, 'utf8');

  // Extract escapeCSV
  const escStart = src.indexOf('// Escape CSV field (handle commas, quotes, newlines)');
  assert.notEqual(escStart, -1, 'escapeCSV start not found');
  const escEnd = src.indexOf('\n\n  // Format timestamp for CSV', escStart);
  assert.notEqual(escEnd, -1, 'escapeCSV end not found');
  const escapeCSVSource = src.slice(escStart, escEnd);

  // Extract parseCSVLine
  const csvLineStart = src.indexOf('  // Parse CSV line handling quoted fields');
  assert.notEqual(csvLineStart, -1, 'parseCSVLine start not found');
  const csvLineEnd = src.indexOf('\n\n  // Convert ISO timestamp string back', csvLineStart);
  assert.notEqual(csvLineEnd, -1, 'parseCSVLine end not found');
  const parseCSVLineSource = src.slice(csvLineStart, csvLineEnd);

  // Extract processSection — we only need posts_summary branch
  const procStart = src.indexOf('  async function processSection(section, header, rows, metrics, stats) {');
  assert.notEqual(procStart, -1, 'processSection start not found');
  // End at the async function main(...) that follows processSection
  const procEnd = src.indexOf('\n\n  async function main(', procStart);
  assert.notEqual(procEnd, -1, 'processSection end not found');
  const processSectionSource = src.slice(procStart, procEnd);

  const context = {};
  vm.createContext(context);
  const bootstrap = `
    const SITE_ORIGIN = 'https://sora.chatgpt.com';
    ${escapeCSVSource}
    ${parseCSVLineSource}
    function parseTimestamp(tsStr) {
      if (!tsStr || tsStr === '') return null;
      const d = Date.parse(tsStr);
      if (!isNaN(d)) return d;
      return null;
    }
    function toTs(v) { return 0; }
    ${processSectionSource}
    globalThis.__processSection = processSection;
    globalThis.__escapeCSV = escapeCSV;
    globalThis.__parseCSVLine = parseCSVLine;
  `;
  vm.runInContext(bootstrap, context, { filename: 'dashboard-csv-harness.js' });
  return {
    processSection: context.__processSection,
    escapeCSV: context.__escapeCSV,
    parseCSVLine: context.__parseCSVLine,
  };
}

// ─── Phase 2: content.js sanitizer tests ────────────────────────────────────

test('content sanitizeRemixPostIds: valid IDs pass through deduped', () => {
  const { sanitizeRemixPostIds } = buildContentSanitizerHarness();
  const result = sanitizeRemixPostIds(['s_aaa', 's_bbb', 's_aaa']);
  assert.deepEqual(toNativeArray(result), ['s_aaa', 's_bbb']);
});

test('content sanitizeRemixPostIds: invalid IDs are filtered out', () => {
  const { sanitizeRemixPostIds } = buildContentSanitizerHarness();
  const result = sanitizeRemixPostIds(['s_aaa', '', null, 'bad id!', 's_bbb']);
  assert.deepEqual(toNativeArray(result), ['s_aaa', 's_bbb']);
});

test('content sanitizeRemixPostIds: non-array returns null', () => {
  const { sanitizeRemixPostIds } = buildContentSanitizerHarness();
  assert.equal(sanitizeRemixPostIds('not-array'), null);
  assert.equal(sanitizeRemixPostIds(null), null);
  assert.equal(sanitizeRemixPostIds(undefined), null);
});

test('content sanitizeRemixPostIds: empty array returns null', () => {
  const { sanitizeRemixPostIds } = buildContentSanitizerHarness();
  assert.equal(sanitizeRemixPostIds([]), null);
});

test('content sanitizeMetricsItem: remix_post_ids survives sanitization', () => {
  const { sanitizeMetricsItem } = buildContentSanitizerHarness();
  const out = sanitizeMetricsItem({
    postId: 's_parent',
    remix_post_ids: ['s_child1', 's_child2'],
  });
  assert.ok(out, 'item should be non-null');
  assert.deepEqual(toNativeArray(out.remix_post_ids), ['s_child1', 's_child2']);
});

test('content sanitizeMetricsItem: malformed remix_post_ids are dropped', () => {
  const { sanitizeMetricsItem } = buildContentSanitizerHarness();
  const out = sanitizeMetricsItem({
    postId: 's_parent',
    remix_post_ids: 'not-an-array',
  });
  assert.ok(out);
  assert.equal(out.remix_post_ids, undefined);
});

test('content sanitizeMetricsItem: empty remix_post_ids is omitted', () => {
  const { sanitizeMetricsItem } = buildContentSanitizerHarness();
  const out = sanitizeMetricsItem({
    postId: 's_parent',
    remix_post_ids: [],
  });
  assert.ok(out);
  assert.equal(out.remix_post_ids, undefined);
});

// ─── Phase 3: background.js sanitizer tests ──────────────────────────────────

test('background sanitizeRemixPostIds: valid IDs pass through deduped', () => {
  const { sanitizeRemixPostIds } = buildBackgroundSanitizerHarness();
  const result = sanitizeRemixPostIds(['s_aaa', 's_bbb', 's_aaa']);
  assert.deepEqual(toNativeArray(result), ['s_aaa', 's_bbb']);
});

test('background sanitizeRemixPostIds: invalid IDs are filtered out', () => {
  const { sanitizeRemixPostIds } = buildBackgroundSanitizerHarness();
  const result = sanitizeRemixPostIds(['s_aaa', 'bad id!', null, 's_bbb']);
  assert.deepEqual(toNativeArray(result), ['s_aaa', 's_bbb']);
});

test('background sanitizeMetricsSnapshot: remix_post_ids survives sanitization', () => {
  const { sanitizeMetricsSnapshot } = buildBackgroundSanitizerHarness();
  const out = sanitizeMetricsSnapshot({
    postId: 's_parent',
    remix_post_ids: ['s_child1', 's_child2'],
  });
  assert.ok(out);
  assert.deepEqual(toNativeArray(out.remix_post_ids), ['s_child1', 's_child2']);
});

test('background sanitizeMetricsSnapshot: malformed remix_post_ids are dropped', () => {
  const { sanitizeMetricsSnapshot } = buildBackgroundSanitizerHarness();
  const out = sanitizeMetricsSnapshot({
    postId: 's_parent',
    remix_post_ids: 'bad',
  });
  assert.ok(out);
  assert.equal(out.remix_post_ids, undefined);
});

// ─── Phase 3: mergeRemixPostIds tests ────────────────────────────────────────

test('mergeRemixPostIds: deduplicates and preserves order', () => {
  const { mergeRemixPostIds } = buildBackgroundSanitizerHarness();
  const existing = ['s_a', 's_b'];
  const incoming = ['s_b', 's_c'];
  const result = mergeRemixPostIds(existing, incoming);
  assert.deepEqual(toNativeArray(result), ['s_a', 's_b', 's_c']);
});

test('mergeRemixPostIds: caps at MAX_REMIX_POST_IDS_PER_POST by dropping oldest from front', () => {
  const { mergeRemixPostIds } = buildBackgroundSanitizerHarness();
  // Build existing array of 300 IDs
  const existing = Array.from({ length: 300 }, (_, i) => `s_${i}`);
  const incoming = ['s_new'];
  const result = mergeRemixPostIds(existing, incoming);
  assert.equal(result.length, 300);
  // Oldest (s_0) should be dropped, s_new should be at the end
  assert.equal(result[result.length - 1], 's_new');
  assert.equal(result.includes('s_0'), false);
});

test('mergeRemixPostIds: handles null/undefined existing', () => {
  const { mergeRemixPostIds } = buildBackgroundSanitizerHarness();
  const result = mergeRemixPostIds(null, ['s_a', 's_b']);
  assert.deepEqual(toNativeArray(result), ['s_a', 's_b']);
});

test('mergeRemixPostIds: preserves existing IDs when incoming is empty', () => {
  const { mergeRemixPostIds } = buildBackgroundSanitizerHarness();
  const result = mergeRemixPostIds(['s_a', 's_b'], []);
  assert.deepEqual(toNativeArray(result), ['s_a', 's_b']);
});

// ─── Phase 4: dashboard.js CSV round-trip tests ──────────────────────────────

test('dashboard CSV: remix_post_ids exports as JSON array string and re-imports correctly', async () => {
  const { processSection, escapeCSV, parseCSVLine } = buildDashboardCSVHarness();

  const remixIds = ['s_child1', 's_child2', 's_child3'];
  const remixPostIdsStr = JSON.stringify(remixIds);

  // Build a minimal POSTS SUMMARY CSV row matching the new header
  const header = [
    'User Key', 'User Handle', 'User ID',
    'Post ID', 'Post URL', 'Post Time', 'Post Time (ISO)', 'Caption',
    'Thumbnail URL', 'Parent Post ID', 'Root Post ID', 'Remix Post IDs', 'Last Seen Timestamp',
    'Owner Key', 'Owner Handle', 'Owner ID',
    'Latest Snapshot Timestamp', 'Unique Views', 'Total Views', 'Likes', 'Comments', 'Remixes',
    'Interaction Rate %', 'Remix Rate %', 'Like Rate %',
    'Snapshot Count', 'First Snapshot Timestamp', 'Last Snapshot Timestamp',
  ];

  const dataRow = [
    'h:alice', 'alice', '123',
    's_parent', 'https://sora.chatgpt.com/p/s_parent', '', '', 'test caption',
    '', '', '', remixPostIdsStr, '',
    'h:alice', 'alice', '123',
    '', '', '', '', '', '',
    '', '', '',
    '0', '', '',
  ].map(escapeCSV).join(',');

  const metrics = { users: {} };
  const stats = { postsAdded: 0, postsUpdated: 0, snapshotsAdded: 0, snapshotsSkipped: 0,
    followersAdded: 0, followersSkipped: 0, cameosAdded: 0, cameosSkipped: 0,
    usersAdded: 0, usersUpdated: 0 };

  await processSection('posts_summary', header, [dataRow], metrics, stats);

  assert.equal(stats.postsAdded, 1);
  const post = metrics.users['h:alice']?.posts?.['s_parent'];
  assert.ok(post, 'post should exist after import');
  assert.deepEqual(toNativeArray(post.remix_post_ids), remixIds);
});

test('dashboard CSV: malformed remix_post_ids JSON is silently ignored', async () => {
  const { processSection, escapeCSV } = buildDashboardCSVHarness();

  const header = [
    'User Key', 'User Handle', 'User ID',
    'Post ID', 'Post URL', 'Post Time', 'Post Time (ISO)', 'Caption',
    'Thumbnail URL', 'Parent Post ID', 'Root Post ID', 'Remix Post IDs', 'Last Seen Timestamp',
    'Owner Key', 'Owner Handle', 'Owner ID',
    'Latest Snapshot Timestamp', 'Unique Views', 'Total Views', 'Likes', 'Comments', 'Remixes',
    'Interaction Rate %', 'Remix Rate %', 'Like Rate %',
    'Snapshot Count', 'First Snapshot Timestamp', 'Last Snapshot Timestamp',
  ];

  const dataRow = [
    'h:alice', 'alice', '123',
    's_parent2', 'https://sora.chatgpt.com/p/s_parent2', '', '', '',
    '', '', '', 'NOT_VALID_JSON', '',
    'h:alice', 'alice', '123',
    '', '', '', '', '', '',
    '', '', '',
    '0', '', '',
  ].map(escapeCSV).join(',');

  const metrics = { users: {} };
  const stats = { postsAdded: 0, postsUpdated: 0, snapshotsAdded: 0, snapshotsSkipped: 0,
    followersAdded: 0, followersSkipped: 0, cameosAdded: 0, cameosSkipped: 0,
    usersAdded: 0, usersUpdated: 0 };

  // Should not throw
  await processSection('posts_summary', header, [dataRow], metrics, stats);

  const post = metrics.users['h:alice']?.posts?.['s_parent2'];
  assert.ok(post, 'post should still be created');
  assert.equal(post.remix_post_ids, null, 'remix_post_ids should be null for bad JSON');
});

test('dashboard CSV: existing CSV without Remix Post IDs column still imports cleanly', async () => {
  const { processSection, escapeCSV } = buildDashboardCSVHarness();

  // Old-style header without Remix Post IDs
  const header = [
    'User Key', 'User Handle', 'User ID',
    'Post ID', 'Post URL', 'Post Time', 'Post Time (ISO)', 'Caption',
    'Thumbnail URL', 'Parent Post ID', 'Root Post ID', 'Last Seen Timestamp',
    'Owner Key', 'Owner Handle', 'Owner ID',
    'Latest Snapshot Timestamp', 'Unique Views', 'Total Views', 'Likes', 'Comments', 'Remixes',
    'Interaction Rate %', 'Remix Rate %', 'Like Rate %',
    'Snapshot Count', 'First Snapshot Timestamp', 'Last Snapshot Timestamp',
  ];

  const dataRow = [
    'h:alice', 'alice', '123',
    's_parent3', 'https://sora.chatgpt.com/p/s_parent3', '', '', '',
    '', '', '', '',
    'h:alice', 'alice', '123',
    '', '', '', '', '', '',
    '', '', '',
    '0', '', '',
  ].map(escapeCSV).join(',');

  const metrics = { users: {} };
  const stats = { postsAdded: 0, postsUpdated: 0, snapshotsAdded: 0, snapshotsSkipped: 0,
    followersAdded: 0, followersSkipped: 0, cameosAdded: 0, cameosSkipped: 0,
    usersAdded: 0, usersUpdated: 0 };

  await processSection('posts_summary', header, [dataRow], metrics, stats);

  const post = metrics.users['h:alice']?.posts?.['s_parent3'];
  assert.ok(post, 'post should still be created from old CSV');
  assert.equal(post.remix_post_ids, null, 'remix_post_ids should be null when column missing');
});

test('dashboard CSV: remix_post_ids with non-string array entries is rejected', async () => {
  const { processSection, escapeCSV } = buildDashboardCSVHarness();

  const header = [
    'User Key', 'User Handle', 'User ID',
    'Post ID', 'Post URL', 'Post Time', 'Post Time (ISO)', 'Caption',
    'Thumbnail URL', 'Parent Post ID', 'Root Post ID', 'Remix Post IDs', 'Last Seen Timestamp',
    'Owner Key', 'Owner Handle', 'Owner ID',
    'Latest Snapshot Timestamp', 'Unique Views', 'Total Views', 'Likes', 'Comments', 'Remixes',
    'Interaction Rate %', 'Remix Rate %', 'Like Rate %',
    'Snapshot Count', 'First Snapshot Timestamp', 'Last Snapshot Timestamp',
  ];

  // JSON is valid but contains numbers (wrong type)
  const dataRow = [
    'h:alice', 'alice', '123',
    's_parent4', 'https://sora.chatgpt.com/p/s_parent4', '', '', '',
    '', '', '', '[1, 2, 3]', '',
    'h:alice', 'alice', '123',
    '', '', '', '', '', '',
    '', '', '',
    '0', '', '',
  ].map(escapeCSV).join(',');

  const metrics = { users: {} };
  const stats = { postsAdded: 0, postsUpdated: 0, snapshotsAdded: 0, snapshotsSkipped: 0,
    followersAdded: 0, followersSkipped: 0, cameosAdded: 0, cameosSkipped: 0,
    usersAdded: 0, usersUpdated: 0 };

  await processSection('posts_summary', header, [dataRow], metrics, stats);

  const post = metrics.users['h:alice']?.posts?.['s_parent4'];
  assert.ok(post);
  assert.equal(post.remix_post_ids, null, 'non-string array should be rejected');
});

// ─── Phase 3: edge completion (reverse-link backfill) ────────────────────────

test('background flush: remix child with parent_post_id backfills parent remix_post_ids', async () => {
  // Build a minimal flush harness from background.js
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');

  // Extract everything from isPlainObject up to (but not including) flush-internal chrome calls
  // We'll mock the external dependencies and run just the flush merge loop logic

  // Extract sanitizer block
  const sanitizerStart = src.indexOf('function isPlainObject(value) {');
  const sanitizerEnd = src.indexOf('function sanitizeMetricsBatch(items) {', sanitizerStart);
  const sanitizerBlock = src.slice(sanitizerStart, sanitizerEnd);

  // Extract mergeRemixPostIds (already in sanitizer block range above)

  // Extract the inner flush logic (the for..of items loop body)
  const flushLoopStart = src.indexOf('      for (const snap of items) {');
  assert.notEqual(flushLoopStart, -1, 'flush loop start not found');
  const flushLoopEnd = src.indexOf('\n      if (!dirty) {', flushLoopStart);
  assert.notEqual(flushLoopEnd, -1, 'flush loop end not found');
  const flushLoopBody = src.slice(flushLoopStart, flushLoopEnd);

  const context = {};
  vm.createContext(context);

  // Set up the test scenario: a parent post already exists; a remix child arrives
  // The parent has no remix_post_ids yet.
  const existingMetrics = {
    users: {
      'h:alice': {
        handle: 'alice',
        id: null,
        posts: {
          's_parent': { url: null, thumb: null, snapshots: [], remix_post_ids: undefined }
        },
        followers: [],
        cameos: [],
      }
    }
  };

  const items = [{
    postId: 's_child',
    userKey: 'h:alice',
    parent_post_id: 's_parent',
    root_post_id: null,
    ts: Date.now(),
    uv: 10,
    likes: 1,
    views: 100,
    comments: 0,
    remixes: 0,
    remix_count: 0,
  }];

  const bootstrap = `
    const MAX_REMIX_POST_IDS_PER_POST = 300;
    ${sanitizerBlock}
    const MAX_SNAPSHOT_HISTORY_PER_POST = 720;
    const MAX_PROFILE_SERIES_POINTS = 720;
    const DEBUG = { storage: false, thumbs: false };
    function dlog() {}
    function trimSeriesInPlace() {}
    const coldSnapshotBuffer = new Map();
    const coldDirtyUsers = new Set();
    const postIdToUserKey = globalThis.__postIdToUserKey;

    let dirty = false;
    const metrics = globalThis.__metrics;
    const items = globalThis.__items;
    const touchedPosts = new Set();

    ${flushLoopBody}

    globalThis.__dirty = dirty;
    globalThis.__resultMetrics = metrics;
  `;

  const postIdToUserKey = new Map();
  postIdToUserKey.set('s_parent', 'h:alice'); // pre-seed so parent lookup works via index
  context.__postIdToUserKey = postIdToUserKey;
  context.__metrics = existingMetrics;
  context.__items = items;

  vm.runInContext(bootstrap, context, { filename: 'flush-edge-completion-harness.js' });

  const resultMetrics = context.__resultMetrics;
  const parentPost = resultMetrics.users['h:alice'].posts['s_parent'];
  assert.ok(parentPost, 'parent post should exist');
  assert.ok(Array.isArray(parentPost.remix_post_ids), 'parent should have remix_post_ids');
  assert.ok(parentPost.remix_post_ids.includes('s_child'), 'parent remix_post_ids should contain child ID');
});

test('background flush: edge completion creates minimal parent stub when parent not present', async () => {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');

  const sanitizerStart = src.indexOf('function isPlainObject(value) {');
  const sanitizerEnd = src.indexOf('function sanitizeMetricsBatch(items) {', sanitizerStart);
  const sanitizerBlock = src.slice(sanitizerStart, sanitizerEnd);

  const flushLoopStart = src.indexOf('      for (const snap of items) {');
  const flushLoopEnd = src.indexOf('\n      if (!dirty) {', flushLoopStart);
  const flushLoopBody = src.slice(flushLoopStart, flushLoopEnd);

  const context = {};
  vm.createContext(context);

  // No parent post exists at all — child arrives first
  const existingMetrics = {
    users: {
      'h:alice': {
        handle: 'alice',
        id: null,
        posts: {},
        followers: [],
        cameos: [],
      }
    }
  };

  const items = [{
    postId: 's_child_only',
    userKey: 'h:alice',
    parent_post_id: 's_unknown_parent',
    root_post_id: null,
    ts: Date.now(),
    uv: 5,
    likes: 0,
    views: 50,
    comments: 0,
    remixes: 0,
    remix_count: 0,
  }];

  const bootstrap = `
    const MAX_REMIX_POST_IDS_PER_POST = 300;
    ${sanitizerBlock}
    const MAX_SNAPSHOT_HISTORY_PER_POST = 720;
    const MAX_PROFILE_SERIES_POINTS = 720;
    const DEBUG = { storage: false, thumbs: false };
    function dlog() {}
    function trimSeriesInPlace() {}
    const coldSnapshotBuffer = new Map();
    const coldDirtyUsers = new Set();
    const postIdToUserKey = globalThis.__postIdToUserKey;

    let dirty = false;
    const metrics = globalThis.__metrics;
    const items = globalThis.__items;
    const touchedPosts = new Set();

    ${flushLoopBody}

    globalThis.__dirty = dirty;
    globalThis.__resultMetrics = metrics;
  `;

  const postIdToUserKey = new Map();
  context.__postIdToUserKey = postIdToUserKey;
  context.__metrics = existingMetrics;
  context.__items = items;

  vm.runInContext(bootstrap, context, { filename: 'flush-stub-harness.js' });

  const resultMetrics = context.__resultMetrics;
  // Parent stub should have been created somewhere in metrics.users
  let parentFound = null;
  for (const user of Object.values(resultMetrics.users)) {
    if (user.posts && user.posts['s_unknown_parent']) {
      parentFound = user.posts['s_unknown_parent'];
      break;
    }
  }
  assert.ok(parentFound, 'parent stub should be created');
  assert.ok(Array.isArray(parentFound.remix_post_ids), 'parent stub should have remix_post_ids');
  assert.ok(parentFound.remix_post_ids.includes('s_child_only'), 'parent stub should reference child');
});
