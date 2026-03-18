const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_PATH = path.join(__dirname, '..', 'content.js');
const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');
const INJECT_PATH = path.join(__dirname, '..', 'inject.js');
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard.js');

function toNative(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildContentHarness() {
  const src = fs.readFileSync(CONTENT_PATH, 'utf8');
  const start = src.indexOf('const MAX_METRICS_BATCH_ITEMS = 250;');
  assert.notEqual(start, -1, 'content harness start not found');
  const end = src.indexOf('function sanitizeMetricsBatch(items) {', start);
  assert.notEqual(end, -1, 'content harness end not found');
  const snippet = src.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${snippet}
    globalThis.__sanitizeMetricsItem = sanitizeMetricsItem;`,
    context,
    { filename: 'content-mailbox-harness.js' }
  );
  return { sanitizeMetricsItem: context.__sanitizeMetricsItem };
}

function buildBackgroundHarness() {
  const src = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const start = src.indexOf('function isPlainObject(value) {');
  assert.notEqual(start, -1, 'background harness start not found');
  const end = src.indexOf('function sanitizeMetricsBatch(items) {', start);
  assert.notEqual(end, -1, 'background harness end not found');
  const snippet = src.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `const MAX_REMIX_POST_IDS_PER_POST = 300;
     const MAX_MAILBOX_EVENTS_PER_POST = 200;
     const MAX_EVENT_ID_LEN = 256;
     ${snippet}
     globalThis.__sanitizeMetricsSnapshot = sanitizeMetricsSnapshot;
     globalThis.__mergeMailboxActorEvents = mergeMailboxActorEvents;`,
    context,
    { filename: 'background-mailbox-harness.js' }
  );
  return {
    sanitizeMetricsSnapshot: context.__sanitizeMetricsSnapshot,
    mergeMailboxActorEvents: context.__mergeMailboxActorEvents,
  };
}

function buildInjectHarness() {
  const src = fs.readFileSync(INJECT_PATH, 'utf8');
  const start = src.indexOf('function classifyMailboxEventType(item) {');
  assert.notEqual(start, -1, 'inject mailbox start not found');
  const end = src.indexOf('\n\n  function processFeedJson(json) {', start);
  assert.notEqual(end, -1, 'inject mailbox end not found');
  const snippet = src.slice(start, end);
  const context = {
    __feedPayloads: [],
    __messages: [],
  };
  vm.createContext(context);
  vm.runInContext(
    `
      const window = {
        postMessage(payload) {
          globalThis.__messages.push(payload);
        }
      };
      function dlog() {}
      function getOwner(item) {
        const post = item?.post || item || {};
        return {
          handle: typeof post.ownerHandle === 'string' && post.ownerHandle ? post.ownerHandle : null,
          id: typeof post.shared_by === 'string' && post.shared_by ? post.shared_by : null,
        };
      }
      function processFeedJson(payload) {
        globalThis.__feedPayloads.push(payload);
      }
      ${snippet}
      globalThis.__processMailboxJson = processMailboxJson;
    `,
    context,
    { filename: 'inject-mailbox-harness.js' }
  );
  return {
    processMailboxJson: context.__processMailboxJson,
    feedPayloads: context.__feedPayloads,
    messages: context.__messages,
  };
}

function buildInjectPostDetailHarness() {
  const src = fs.readFileSync(INJECT_PATH, 'utf8');
  const start = src.indexOf('function extractPostCommenters(items) {');
  assert.notEqual(start, -1, 'inject post detail start not found');
  const end = src.indexOf('\n\n  function looksLikePendingV2Task(item) {', start);
  assert.notEqual(end, -1, 'inject post detail end not found');
  const snippet = src.slice(start, end);
  const context = {
    __feedPayloads: [],
    __messages: [],
    __renderDetailBadgeCalls: 0,
  };
  vm.createContext(context);
  vm.runInContext(
    `
      const window = {
        postMessage(payload) {
          globalThis.__messages.push(payload);
        }
      };
      const processedPostDetailIds = new Set();
      const lockedPostIds = new Set();
      const idToMeta = new Map();
      const idToUnique = new Map();
      const idToLikes = new Map();
      const idToRemixes = new Map();
      let suppressDetailBadgeRender = false;
      function dlog() {}
      function getOwner(item) {
        const post = item?.post || item || {};
        const profile = item?.profile || post?.profile || null;
        return {
          handle: typeof profile?.username === 'string' && profile.username ? profile.username : null,
          id: typeof post?.shared_by === 'string' && post.shared_by
            ? post.shared_by
            : (typeof profile?.user_id === 'string' && profile.user_id ? profile.user_id : null),
        };
      }
      function currentSIdFromURL() {
        return 's_parent';
      }
      function renderDetailBadge() {
        globalThis.__renderDetailBadgeCalls++;
      }
      function __sorauv_toTs(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return n < 1e11 ? n * 1000 : n;
      }
      ${snippet}
      function processFeedJson(payload) {
        globalThis.__feedPayloads.push(payload);
      }
      globalThis.__processPostDetailJson = processPostDetailJson;
    `,
    context,
    { filename: 'inject-post-detail-harness.js' }
  );
  return {
    processPostDetailJson: context.__processPostDetailJson,
    feedPayloads: context.__feedPayloads,
    messages: context.__messages,
    getRenderDetailBadgeCalls: () => context.__renderDetailBadgeCalls,
  };
}

function buildInjectProfileHarness() {
  const src = fs.readFileSync(INJECT_PATH, 'utf8');
  const start = src.indexOf('function extractProfileSnapshot(payload, pageUserHandle, pageUserKey){');
  assert.notEqual(start, -1, 'inject profile start not found');
  const end = src.indexOf('\n\n  function classifyMailboxEventType(item) {', start);
  assert.notEqual(end, -1, 'inject profile end not found');
  const snippet = src.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `
      function isProfile() { return true; }
      function currentProfileHandleFromURL() { return 'byeson'; }
      const window = { postMessage() {} };
      ${snippet}
      globalThis.__extractProfileSnapshot = extractProfileSnapshot;
    `,
    context,
    { filename: 'inject-profile-harness.js' }
  );
  return {
    extractProfileSnapshot: context.__extractProfileSnapshot
  };
}

function buildInjectMetricCountHarness() {
  const src = fs.readFileSync(INJECT_PATH, 'utf8');
  const start = src.indexOf('const getCameos = (item) => {');
  assert.notEqual(start, -1, 'inject metric count start not found');
  const end = src.indexOf('\n  function getOwner(item) {', start);
  assert.notEqual(end, -1, 'inject metric count end not found');
  const snippet = src.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `
      ${snippet}
      globalThis.__getCameos = getCameos;
      globalThis.__getFollowerCount = getFollowerCount;
    `,
    context,
    { filename: 'inject-metric-count-harness.js' }
  );
  return {
    getCameos: context.__getCameos,
    getFollowerCount: context.__getFollowerCount
  };
}

function buildDashboardHarness() {
  const src = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  const start = src.indexOf('function normalizeMailboxActorEvent(raw) {');
  assert.notEqual(start, -1, 'dashboard mailbox start not found');
  const end = src.indexOf('\n\n  function createRemixLeaderboardContext(metrics) {', start);
  assert.notEqual(end, -1, 'dashboard mailbox end not found');
  const snippet = src.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `
      let metrics = { users: {} };
      let mailboxOwnerKey = null;
      function isTopTodayKey(key) { return key === '__top_today__'; }
      function isCameoKey(key) { return typeof key === 'string' && key.startsWith('c:'); }
      function isVirtualUserKey(key) { return isTopTodayKey(key) || isCameoKey(key); }
      function areEquivalentUserKeys(metricsObj, leftKey, rightKey) {
        if (!leftKey || !rightKey) return false;
        if (leftKey === rightKey) return true;
        const left = metricsObj?.users?.[leftKey];
        const right = metricsObj?.users?.[rightKey];
        if (!left || !right) return false;
        if (left.id && right.id && String(left.id) === String(right.id)) return true;
        const leftHandle = String(left.handle || '').toLowerCase();
        const rightHandle = String(right.handle || '').toLowerCase();
        return !!leftHandle && leftHandle === rightHandle;
      }
      function toTs(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
        if (typeof value === 'string' && value.trim()) {
          const text = value.trim();
          if (/^\\d+$/.test(text)) {
            const parsed = Number(text);
            return parsed < 1e11 ? parsed * 1000 : parsed;
          }
          const parsedDate = Date.parse(text);
          if (!Number.isNaN(parsedDate)) return parsedDate;
        }
        return 0;
      }
      ${snippet}
      globalThis.__computeMailboxActivityInsights = computeMailboxActivityInsights;
      globalThis.__shouldShowMailboxActivityForSelection = shouldShowMailboxActivityForSelection;
      globalThis.__setMailboxOwnerKey = (value) => { mailboxOwnerKey = value; };
      globalThis.__setMetrics = (value) => { metrics = value; };
    `,
    context,
    { filename: 'dashboard-mailbox-harness.js' }
  );
  return {
    computeMailboxActivityInsights: context.__computeMailboxActivityInsights,
    shouldShowMailboxActivityForSelection: context.__shouldShowMailboxActivityForSelection,
    setMailboxOwnerKey: context.__setMailboxOwnerKey,
    setMetrics: context.__setMetrics,
  };
}

test('content sanitizeMetricsItem keeps mailbox actor events', () => {
  const { sanitizeMetricsItem } = buildContentHarness();
  const out = sanitizeMetricsItem({
    postId: 's_parent',
    mailbox_likes: [
      { eventId: 'evt_like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1000 },
      { eventId: 'evt_like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1000 },
    ],
    mailbox_comments: [
      { eventId: 'evt_comment_1:h:bob', actorKey: 'h:bob', actorHandle: 'bob', ts: 2000 }
    ],
    mailbox_remixes: [
      { eventId: 'evt_remix_1:h:carol', actorKey: 'h:carol', actorHandle: 'carol', ts: 3000 }
    ],
    post_commenters: [
      { eventId: 'commenter:h:dora', actorKey: 'h:dora', actorHandle: 'dora', ts: 4000 }
    ]
  });
  assert.ok(out);
  assert.deepEqual(toNative(out.mailbox_likes), [
    { eventId: 'evt_like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1000 }
  ]);
  assert.deepEqual(toNative(out.mailbox_comments), [
    { eventId: 'evt_comment_1:h:bob', actorKey: 'h:bob', actorHandle: 'bob', ts: 2000 }
  ]);
  assert.deepEqual(toNative(out.mailbox_remixes), [
    { eventId: 'evt_remix_1:h:carol', actorKey: 'h:carol', actorHandle: 'carol', ts: 3000 }
  ]);
  assert.deepEqual(toNative(out.post_commenters), [
    { eventId: 'commenter:h:dora', actorKey: 'h:dora', actorHandle: 'dora', ts: 4000 }
  ]);
});

test('background sanitizeMetricsSnapshot keeps post commenters', () => {
  const { sanitizeMetricsSnapshot } = buildBackgroundHarness();
  const out = sanitizeMetricsSnapshot({
    postId: 's_parent',
    post_commenters: [
      { eventId: 'commenter:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 5000 },
      { eventId: 'commenter:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 5000 }
    ]
  });
  assert.ok(out);
  assert.deepEqual(toNative(out.post_commenters), [
    { eventId: 'commenter:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 5000 }
  ]);
});

test('background mergeMailboxActorEvents deduplicates repeated mailbox events', () => {
  const { mergeMailboxActorEvents } = buildBackgroundHarness();
  const merged = mergeMailboxActorEvents(
    [{ eventId: 'evt_like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1000 }],
    [
      { eventId: 'evt_like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1000 },
      { eventId: 'evt_like_2:h:bob', actorKey: 'h:bob', actorHandle: 'bob', ts: 2000 }
    ]
  );
  assert.deepEqual(toNative(merged), [
    { eventId: 'evt_like_2:h:bob', actorKey: 'h:bob', actorHandle: 'bob', ts: 2000 },
    { eventId: 'evt_like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', actorId: null, ts: 1000 }
  ]);
});

test('inject processMailboxJson forwards embedded post payloads and actor batches for likes comments and remixes', () => {
  const { processMailboxJson, feedPayloads, messages } = buildInjectHarness();
  processMailboxJson({
    items: [
      {
        id: 'EventNotification_like_1',
        kind: 'like',
        ts: 1773419311.702984,
        object: {
          kind: 'post',
          post: {
            id: 's_parent',
            shared_by: 'user-1',
            is_owner: true
          }
        },
        profiles: [
          { user_id: 'user-10', username: 'silentaura' }
        ]
      },
      {
        id: 'EventNotification_comment_1',
        kind: 'comment',
        ts: 1773419322.0,
        object: {
          kind: 'post',
          post: {
            id: 's_parent',
            shared_by: 'user-1'
          }
        },
        profiles: [
          { user_id: 'user-11', username: 'catalexandra' }
        ]
      },
      {
        id: 'EventNotification_remix_1',
        kind: 'remix',
        ts: 1773419333.0,
        object: {
          kind: 'post',
          post: {
            id: 's_parent',
            shared_by: 'user-1'
          }
        },
        profiles: [
          { user_id: 'user-12', username: 'remixer' }
        ]
      }
    ]
  });
  assert.equal(feedPayloads.length, 1);
  assert.equal(feedPayloads[0].items.length, 3);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, 'metrics_batch');
  assert.equal(messages[0].items.length, 2);
  assert.equal(messages[0].items[0].mailbox_likes.length, 1);
  assert.equal(messages[0].items[1].mailbox_comments.length, 1);
  assert.equal(messages[0].items.every((item) => !Array.isArray(item.mailbox_remixes)), true);
  assert.equal(messages[1].type, 'mailbox_owner');
  assert.equal(messages[1].userKey, 'id:user-1');
});

test('inject processMailboxJson infers mailbox owner when mailbox items agree on one owner without is_owner', () => {
  const { processMailboxJson, messages } = buildInjectHarness();
  processMailboxJson({
    items: [
      {
        id: 'EventNotification_like_1',
        kind: 'like',
        ts: 1773419311.702984,
        object: {
          kind: 'post',
          post: {
            id: 's_parent_a',
            ownerHandle: 'byeson',
            shared_by: 'user-1'
          }
        },
        profiles: [
          { user_id: 'user-10', username: 'silentaura' }
        ]
      },
      {
        id: 'EventNotification_comment_1',
        kind: 'comment',
        ts: 1773419322.0,
        object: {
          kind: 'post',
          post: {
            id: 's_parent_b',
            ownerHandle: 'byeson',
            shared_by: 'user-1'
          }
        },
        profiles: [
          { user_id: 'user-11', username: 'catalexandra' }
        ]
      }
    ]
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].type, 'mailbox_owner');
  assert.equal(messages[1].userKey, 'h:byeson');
});

test('inject processPostDetailJson extracts unique commenters from children and attaches them to the parent post', () => {
  const { processPostDetailJson, feedPayloads, messages, getRenderDetailBadgeCalls } = buildInjectPostDetailHarness();
  processPostDetailJson({
    post: {
      id: 's_parent',
      shared_by: 'user-parent'
    },
    profile: {
      user_id: 'user-parent',
      username: 'byeson'
    },
    children: {
      items: [
        {
          post: {
            id: 'comment-1',
            shared_by: 'user-a',
            posted_at: 1773794883
          },
          profile: {
            user_id: 'user-a',
            username: 'directorbrocklee'
          }
        },
        {
          post: {
            id: 'comment-2',
            shared_by: 'user-a',
            posted_at: 1773797883
          },
          profile: {
            user_id: 'user-a',
            username: 'directorbrocklee'
          }
        },
        {
          post: {
            id: 'comment-3',
            shared_by: 'user-b',
            posted_at: 1773795883
          },
          profile: {
            user_id: 'user-b',
            username: 'mistercoolldude'
          }
        }
      ]
    }
  });

  assert.equal(feedPayloads.length, 1);
  assert.equal(feedPayloads[0].items.length, 1);

  const batchMessage = messages.find((message) => message?.type === 'metrics_batch');
  assert.ok(batchMessage);
  assert.equal(batchMessage.items.length, 1);
  assert.equal(batchMessage.items[0].postId, 's_parent');
  assert.equal(batchMessage.items[0].userKey, 'h:byeson');
  assert.deepEqual(toNative(batchMessage.items[0].post_commenters), [
    {
      eventId: 'commenter:h:directorbrocklee',
      actorKey: 'h:directorbrocklee',
      actorHandle: 'directorbrocklee',
      actorId: 'user-a',
      ts: 1773797883000
    },
    {
      eventId: 'commenter:h:mistercoolldude',
      actorKey: 'h:mistercoolldude',
      actorHandle: 'mistercoolldude',
      actorId: 'user-b',
      ts: 1773795883000
    }
  ]);
  assert.equal(getRenderDetailBadgeCalls(), 1);
});

test('inject extractProfileSnapshot treats null follower_count as missing instead of zero', () => {
  const { extractProfileSnapshot } = buildInjectProfileHarness();
  const snapshot = extractProfileSnapshot({
    items: [
      {
        post: {
          owner_profile: {
            id: 'user-byeson',
            username: 'byeson',
            follower_count: null,
            cameo_count: null
          }
        }
      }
    ]
  }, 'byeson', 'h:byeson');

  assert.ok(snapshot);
  assert.equal(snapshot.userKey, 'h:byeson');
  assert.equal(snapshot.followers, null);
  assert.equal(snapshot.cameos, null);
});

test('inject post metric extractors treat null follower and cameo counts as missing instead of zero', () => {
  const { getCameos, getFollowerCount } = buildInjectMetricCountHarness();
  const item = {
    post: {
      owner: {
        follower_count: null
      },
      cameo_count: null
    }
  };

  assert.equal(getFollowerCount(item), null);
  assert.equal(getCameos(item), null);
});

test('dashboard computeMailboxActivityInsights aggregates visible mailbox actors only', () => {
  const { computeMailboxActivityInsights } = buildDashboardHarness();
  const user = {
    handle: 'byeson',
    posts: {
      s_a: {
        mailbox_likes: [
          { eventId: 'like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1000 },
          { eventId: 'like_2:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1500 },
          { eventId: 'like_3:h:bob', actorKey: 'h:bob', actorHandle: 'bob', ts: 1200 }
        ],
        mailbox_comments: [
          { eventId: 'comment_1:h:bob', actorKey: 'h:bob', actorHandle: 'bob', ts: 2000 }
        ]
      },
      s_hidden: {
        mailbox_likes: [
          { eventId: 'like_hidden:h:carol', actorKey: 'h:carol', actorHandle: 'carol', ts: 4000 }
        ],
        mailbox_comments: []
      }
    }
  };
  const insights = computeMailboxActivityInsights(user, new Set(['s_a']));
  assert.equal(insights.matchedPosts, 1);
  assert.equal(insights.postsWithMailboxEvents, 1);
  assert.equal(insights.topLikers.length, 2);
  assert.deepEqual(toNative(insights.topLikers[0]), {
    actorKey: 'h:alice',
    actorHandle: 'alice',
    actorId: null,
    count: 2,
    lastTs: 1500000
  });
  assert.deepEqual(toNative(insights.topCommenters[0]), {
    actorKey: 'h:bob',
    actorHandle: 'bob',
    actorId: null,
    count: 1,
    lastTs: 2000000
  });
  assert.equal('topRemixers' in insights, false);
});

test('dashboard mailbox activity visibility is limited to the inferred mailbox owner', () => {
  const { shouldShowMailboxActivityForSelection, setMailboxOwnerKey, setMetrics } = buildDashboardHarness();
  setMetrics({
    users: {
      'h:byeson': { handle: 'byeson', id: 'user-byeson', posts: {} },
      'id:user-byeson': { handle: 'byeson', id: 'user-byeson', posts: {} },
      'h:cameoeds': { handle: 'cameoeds', id: 'user-cameoeds', posts: {} }
    }
  });
  setMailboxOwnerKey('h:byeson');
  assert.equal(
    shouldShowMailboxActivityForSelection('id:user-byeson', { handle: 'byeson', id: 'user-byeson', posts: {} }),
    true
  );
  assert.equal(
    shouldShowMailboxActivityForSelection('h:cameoeds', { handle: 'cameoeds', id: 'user-cameoeds', posts: {} }),
    false
  );
});

test('dashboard mailbox activity stays visible when selected profile already has mailbox data but owner key is missing', () => {
  const { shouldShowMailboxActivityForSelection, setMailboxOwnerKey, setMetrics } = buildDashboardHarness();
  const user = {
    handle: 'byeson',
    id: 'user-byeson',
    posts: {
      s_a: {
        mailbox_likes: [
          { eventId: 'like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1000 }
        ]
      }
    }
  };
  setMetrics({ users: { 'h:byeson': user } });
  setMailboxOwnerKey(null);
  assert.equal(shouldShowMailboxActivityForSelection('h:byeson', user), true);
});
