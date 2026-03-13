const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard.js');

function buildNetworkHarness() {
  const src = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  const startMarker = 'const NETWORK_GRAPH_DEFAULT_MAX_NODES = 1200;';
  const endMarker = '\n\n  function getInitialSidebarWidth(viewportWidth = window.innerWidth){';
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, 'network helper start not found');
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, 'network helper end not found');
  const snippet = src.slice(start, end);

  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `
      const SITE_ORIGIN = 'https://sora.chatgpt.com';
      ${snippet}
      globalThis.__buildRemixNetworkForUser = buildRemixNetworkForUser;
      globalThis.__computeRemixNetworkInsights = computeRemixNetworkInsights;
      globalThis.__normalizeNetworkPrefs = normalizeNetworkPrefs;
    `,
    context,
    { filename: 'dashboard-network-harness.js' }
  );
  assert.equal(typeof context.__buildRemixNetworkForUser, 'function');
  assert.equal(typeof context.__computeRemixNetworkInsights, 'function');
  assert.equal(typeof context.__normalizeNetworkPrefs, 'function');
  return {
    buildRemixNetworkForUser: context.__buildRemixNetworkForUser,
    computeRemixNetworkInsights: context.__computeRemixNetworkInsights,
    normalizeNetworkPrefs: context.__normalizeNetworkPrefs,
  };
}

function makePost({
  id,
  remixPostIds = null,
  parentPostId = null,
  caption = '',
  ownerHandle = 'alice',
  url = null,
  likes = 0,
  views = 0,
  comments = 0,
  remixes = 0,
} = {}) {
  return {
    id,
    caption,
    ownerHandle,
    url,
    remix_post_ids: remixPostIds,
    parent_post_id: parentPostId,
    snapshots: [{
      t: 1,
      likes,
      views,
      comments,
      remix_count: remixes,
    }],
  };
}

function edgeSet(graph) {
  return new Set(
    (graph?.edges || []).map((e) => `${e.sourceId}->${e.targetId}:${e.inferred ? 'i' : 'd'}`)
  );
}

test('buildRemixNetworkForUser builds edges from remix_post_ids', () => {
  const { buildRemixNetworkForUser: build } = buildNetworkHarness();
  const user = {
    handle: 'alice',
    posts: {
      s_parent: makePost({ id: 's_parent', remixPostIds: ['s_child1', 's_child2'] }),
      s_child1: makePost({ id: 's_child1' }),
      s_child2: makePost({ id: 's_child2' }),
    },
  };
  const visibleSet = new Set(['s_parent', 's_child1', 's_child2']);
  const graph = build(user, visibleSet, { mode: 'visible' });
  const edges = edgeSet(graph);
  assert.equal(edges.has('s_parent->s_child1:d'), true);
  assert.equal(edges.has('s_parent->s_child2:d'), true);
  assert.equal(graph.meta.edgeCount, 2);
});

test('buildRemixNetworkForUser adds parent_post_id fallback edges', () => {
  const { buildRemixNetworkForUser: build } = buildNetworkHarness();
  const user = {
    handle: 'alice',
    posts: {
      s_parent: makePost({ id: 's_parent' }),
      s_child: makePost({ id: 's_child', parentPostId: 's_parent' }),
    },
  };
  const visibleSet = new Set(['s_child']);
  const graph = build(user, visibleSet, { mode: 'visible' });
  const edges = edgeSet(graph);
  assert.equal(edges.has('s_parent->s_child:i'), true);
  assert.equal(graph.meta.edgeCount, 1);
});

test('buildRemixNetworkForUser deduplicates remix and parent fallback edges', () => {
  const { buildRemixNetworkForUser: build } = buildNetworkHarness();
  const user = {
    handle: 'alice',
    posts: {
      s_parent: makePost({ id: 's_parent', remixPostIds: ['s_child'] }),
      s_child: makePost({ id: 's_child', parentPostId: 's_parent' }),
    },
  };
  const visibleSet = new Set(['s_parent', 's_child']);
  const graph = build(user, visibleSet, { mode: 'visible' });
  assert.equal(graph.edges.length, 1);
  const edge = {
    sourceId: graph.edges[0]?.sourceId,
    targetId: graph.edges[0]?.targetId,
    inferred: !!graph.edges[0]?.inferred,
  };
  assert.deepEqual(edge, { sourceId: 's_parent', targetId: 's_child', inferred: false });
});

test('buildRemixNetworkForUser creates placeholder nodes for unresolved remix IDs', () => {
  const { buildRemixNetworkForUser: build } = buildNetworkHarness();
  const user = {
    handle: 'alice',
    posts: {
      s_parent: makePost({ id: 's_parent', remixPostIds: ['s_unknown'] }),
    },
  };
  const visibleSet = new Set(['s_parent']);
  const graph = build(user, visibleSet, { mode: 'visible' });
  const unknown = graph.nodes.find((n) => n.id === 's_unknown');
  assert.ok(unknown, 'placeholder node should be created');
  assert.equal(unknown.isPlaceholder, true);
  assert.equal(unknown.isVisible, false);
  assert.equal(unknown.owner, null, 'unresolved placeholder should not inherit selected user ownership');
});

test('buildRemixNetworkForUser resolves cross-user post ownership by post id', () => {
  const { buildRemixNetworkForUser: build } = buildNetworkHarness();
  const user = {
    handle: 'alice',
    posts: {
      s_parent: makePost({ id: 's_parent', remixPostIds: ['s_child'] }),
    },
  };
  const visibleSet = new Set(['s_parent']);
  const graph = build(user, visibleSet, {
    mode: 'visible',
    resolvePostById(postId) {
      if (postId === 's_parent') {
        return {
          userKey: 'h:alice',
          ownerHandle: 'alice',
          ownerId: 'user-1',
          post: user.posts.s_parent,
        };
      }
      if (postId === 's_child') {
        return {
          userKey: 'h:bob',
          ownerHandle: 'bob',
          ownerId: 'user-2',
          post: makePost({ id: 's_child', ownerHandle: 'bob' }),
        };
      }
      return null;
    },
  });
  const child = graph.nodes.find((n) => n.id === 's_child');
  assert.ok(child, 'resolved child node should be present');
  assert.equal(child.isPlaceholder, false);
  assert.equal(child.owner, 'bob');
});

test('computeRemixNetworkInsights keeps remixer stats from base graph even when filtered graph is selected-user only', () => {
  const { computeRemixNetworkInsights } = buildNetworkHarness();
  const baseGraph = {
    nodes: [
      { id: 's_parent', owner: 'alice', isPlaceholder: false },
      { id: 's_child', owner: 'bob', isPlaceholder: false },
    ],
    edges: [
      { sourceId: 's_parent', targetId: 's_child', inferred: false },
    ],
  };
  const filteredGraph = {
    nodes: [
      { id: 's_parent', owner: 'alice', isPlaceholder: false },
    ],
    edges: [],
  };
  const insights = computeRemixNetworkInsights(baseGraph, { handle: 'alice' }, { filteredGraph });
  const statsRows = JSON.parse(JSON.stringify(insights.statsRows));
  assert.deepEqual(statsRows, [
    ['Filtered Nodes', '1'],
    ['Filtered Edges', '0'],
    ['Unique Remixers', '1'],
    ['Direct Remix Edges', '1'],
    ['Top Remixer', 'bob (1)'],
  ]);
  assert.equal(insights.topRemixers.length, 1);
  assert.equal(insights.topRemixers[0].ownerKey, 'bob');
  assert.equal(insights.topRemixers[0].count, 1);
});

test('computeRemixNetworkInsights aggregates remixers for virtual users like Top Today', () => {
  const { computeRemixNetworkInsights } = buildNetworkHarness();
  const graph = {
    nodes: [
      { id: 'a1', owner: 'alice', isPlaceholder: false },
      { id: 'b1', owner: 'bob', isPlaceholder: false },
      { id: 'c1', owner: 'cara', isPlaceholder: false },
      { id: 'a2', owner: 'alice', isPlaceholder: false },
    ],
    edges: [
      { sourceId: 'a1', targetId: 'b1', inferred: false },
      { sourceId: 'a1', targetId: 'c1', inferred: false },
      { sourceId: 'a2', targetId: 'b1', inferred: false },
    ],
    meta: { selectedPosts: 3 },
  };
  const insights = computeRemixNetworkInsights(graph, { handle: 'Top Today', __specialKey: '__top_today__' }, { filteredGraph: graph });
  const statsRows = JSON.parse(JSON.stringify(insights.statsRows));
  assert.deepEqual(statsRows, [
    ['Filtered Nodes', '4'],
    ['Filtered Edges', '3'],
    ['Unique Remixers', '2'],
    ['Direct Remix Edges', '3'],
    ['Top Remixer', 'bob (2)'],
  ]);
  assert.equal(insights.topRemixers.length, 2);
  assert.equal(insights.topRemixers[0].ownerKey, 'bob');
  assert.equal(insights.topRemixers[0].count, 2);
});

test('computeRemixNetworkInsights can target a specific source owner within an aggregate graph', () => {
  const { computeRemixNetworkInsights } = buildNetworkHarness();
  const graph = {
    nodes: [
      { id: 'a1', owner: 'alice', isPlaceholder: false },
      { id: 'a2', owner: 'alice', isPlaceholder: false },
      { id: 'b1', owner: 'bob', isPlaceholder: false },
      { id: 'b2', owner: 'bob', isPlaceholder: false },
      { id: 'c1', owner: 'cara', isPlaceholder: false },
      { id: 'd1', owner: 'dave', isPlaceholder: false },
    ],
    edges: [
      { sourceId: 'a1', targetId: 'b1', inferred: false },
      { sourceId: 'a2', targetId: 'c1', inferred: false },
      { sourceId: 'b2', targetId: 'd1', inferred: false },
    ],
    meta: { selectedPosts: 4 },
  };
  const insights = computeRemixNetworkInsights(graph, { handle: 'Top Today', __specialKey: '__top_today__' }, {
    filteredGraph: graph,
    sourceOwnerKey: 'alice',
  });
  const statsRows = JSON.parse(JSON.stringify(insights.statsRows));
  assert.deepEqual(statsRows, [
    ['Filtered Nodes', '6'],
    ['Filtered Edges', '3'],
    ['Unique Remixers', '2'],
    ['Direct Remix Edges', '2'],
    ['Top Remixer', 'bob (1)'],
  ]);
  assert.equal(insights.topRemixers.length, 2);
  assert.equal(insights.topRemixers.some((row) => row.ownerKey === 'bob' && row.count === 1), true);
  assert.equal(insights.topRemixers.some((row) => row.ownerKey === 'cara' && row.count === 1), true);
});

test('buildRemixNetworkForUser honors raised max node caps so remixer targets are retained', () => {
  const { buildRemixNetworkForUser: build } = buildNetworkHarness();
  const user = {
    handle: 'alice',
    posts: {
      s_parent1: makePost({ id: 's_parent1', remixPostIds: ['s_child1'] }),
      s_parent2: makePost({ id: 's_parent2', remixPostIds: ['s_child2'] }),
    },
  };
  const visibleSet = new Set(['s_parent1', 's_parent2']);
  const resolvePostById = (postId) => {
    if (postId === 's_child1') return { ownerHandle: 'bob', post: makePost({ id: 's_child1', ownerHandle: 'bob' }) };
    if (postId === 's_child2') return { ownerHandle: 'cara', post: makePost({ id: 's_child2', ownerHandle: 'cara' }) };
    if (user.posts[postId]) return { ownerHandle: 'alice', post: user.posts[postId] };
    return null;
  };
  const capped = build(user, visibleSet, { mode: 'visible', maxNodes: 2, resolvePostById });
  const uncapped = build(user, visibleSet, { mode: 'visible', maxNodes: 10, maxEdges: 10, resolvePostById });
  assert.equal(capped.nodes.some((n) => n.id === 's_child1'), false);
  assert.equal(capped.nodes.some((n) => n.id === 's_child2'), false);
  assert.equal(uncapped.nodes.some((n) => n.id === 's_child1'), true);
  assert.equal(uncapped.nodes.some((n) => n.id === 's_child2'), true);
});

test('buildRemixNetworkForUser respects visible mode vs all mode', () => {
  const { buildRemixNetworkForUser: build } = buildNetworkHarness();
  const user = {
    handle: 'alice',
    posts: {
      s_a: makePost({ id: 's_a', remixPostIds: ['s_b'] }),
      s_b: makePost({ id: 's_b' }),
      s_c: makePost({ id: 's_c', remixPostIds: ['s_d'] }),
      s_d: makePost({ id: 's_d' }),
    },
  };
  const visibleSet = new Set(['s_a', 's_b']);
  const visibleGraph = build(user, visibleSet, { mode: 'visible' });
  const allGraph = build(user, visibleSet, { mode: 'all' });
  assert.equal(visibleGraph.nodes.some((n) => n.id === 's_c'), false);
  assert.equal(allGraph.nodes.some((n) => n.id === 's_c'), true);
  assert.equal(visibleGraph.meta.edgeCount, 1);
  assert.equal(allGraph.meta.edgeCount, 2);
});

test('buildRemixNetworkForUser is deterministic across runs', () => {
  const { buildRemixNetworkForUser: build } = buildNetworkHarness();
  const user = {
    handle: 'alice',
    posts: {
      s_c: makePost({ id: 's_c', remixPostIds: ['s_d'] }),
      s_a: makePost({ id: 's_a', remixPostIds: ['s_b'] }),
      s_b: makePost({ id: 's_b' }),
      s_d: makePost({ id: 's_d', parentPostId: 's_c' }),
    },
  };
  const visibleSet = new Set(['s_a', 's_b', 's_c', 's_d']);
  const one = build(user, visibleSet, { mode: 'visible' });
  const two = build(user, visibleSet, { mode: 'visible' });
  assert.deepEqual(one.nodes.map((n) => n.id), two.nodes.map((n) => n.id));
  assert.deepEqual(one.edges, two.edges);
});

test('normalizeNetworkPrefs keeps valid mode/metric/density values only', () => {
  const { normalizeNetworkPrefs } = buildNetworkHarness();
  const normalized = normalizeNetworkPrefs({
    mode: 'all',
    sizeMetric: 'likes',
    labelDensity: 'off',
    ownerFilter: 'user:creator_a',
    extra: 'ignored',
  });
  const plain = normalized ? {
    mode: normalized.mode,
    sizeMetric: normalized.sizeMetric,
    labelDensity: normalized.labelDensity,
    ownerFilter: normalized.ownerFilter,
  } : normalized;
  assert.deepEqual(plain, {
    mode: 'all',
    sizeMetric: 'likes',
    labelDensity: 'off',
    ownerFilter: 'user:creator_a',
  });
});

test('normalizeNetworkPrefs returns null for malformed prefs', () => {
  const { normalizeNetworkPrefs } = buildNetworkHarness();
  assert.equal(normalizeNetworkPrefs(null), null);
  assert.equal(normalizeNetworkPrefs('bad'), null);
  assert.equal(normalizeNetworkPrefs({ mode: 'nope', sizeMetric: 123, labelDensity: 'dense' }), null);
});
