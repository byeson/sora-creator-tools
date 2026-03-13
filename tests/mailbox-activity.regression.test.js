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

function buildDashboardHarness() {
  const src = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  const start = src.indexOf('const NETWORK_GRAPH_DEFAULT_MAX_NODES = 1200;');
  assert.notEqual(start, -1, 'dashboard harness start not found');
  const end = src.indexOf('\n\n  function getInitialSidebarWidth(viewportWidth = window.innerWidth){', start);
  assert.notEqual(end, -1, 'dashboard harness end not found');
  const snippet = src.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `
      const SITE_ORIGIN = 'https://sora.chatgpt.com';
      ${snippet}
      globalThis.__computeMailboxActivityInsights = computeMailboxActivityInsights;
    `,
    context,
    { filename: 'dashboard-mailbox-harness.js' }
  );
  return { computeMailboxActivityInsights: context.__computeMailboxActivityInsights };
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
    ]
  });
  assert.ok(out);
  assert.deepEqual(toNative(out.mailbox_likes), [
    { eventId: 'evt_like_1:h:alice', actorKey: 'h:alice', actorHandle: 'alice', ts: 1000 }
  ]);
  assert.deepEqual(toNative(out.mailbox_comments), [
    { eventId: 'evt_comment_1:h:bob', actorKey: 'h:bob', actorHandle: 'bob', ts: 2000 }
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

test('inject processMailboxJson forwards embedded post payloads and actor batches', () => {
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
            remix_posts: {
              items: [
                { post: { id: 's_child', shared_by: 'user-2', parent_post_id: 's_parent' } }
              ]
            }
          }
        },
        profiles: [
          { user_id: 'user-10', username: 'silentaura' },
          { user_id: 'user-11', username: 'catalexandra' }
        ]
      }
    ]
  });
  assert.equal(feedPayloads.length, 1);
  assert.equal(feedPayloads[0].items.length, 1);
  assert.equal(feedPayloads[0].items[0].post.id, 's_parent');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'metrics_batch');
  assert.equal(messages[0].items.length, 1);
  assert.equal(messages[0].items[0].postId, 's_parent');
  assert.equal(messages[0].items[0].mailbox_likes.length, 2);
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
          { eventId: 'like_hidden:h:carol', actorKey: 'h:carol', actorHandle: 'carol', ts: 3000 }
        ],
        mailbox_comments: []
      }
    }
  };
  const insights = computeMailboxActivityInsights(user, new Set(['s_a']));
  assert.equal(insights.matchedPosts, 1);
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
});
