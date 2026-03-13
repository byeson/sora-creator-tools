const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');

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
    globalThis.__resolveIncomingUserKey = resolveIncomingUserKey;`,
    context,
    { filename: 'background-user-key-canonicalization-harness.js' }
  );
  return {
    resolveIncomingUserKey: context.__resolveIncomingUserKey,
  };
}

test('background resolves incoming id-key snapshots onto an existing handle bucket with the same user id', () => {
  const { resolveIncomingUserKey } = buildBackgroundHarness();
  const key = resolveIncomingUserKey(
    {
      users: {
        'h:byeson': { id: 'user-SyMuQgidCFglkii63U5d5ANg' }
      }
    },
    {
      userId: 'user-SyMuQgidCFglkii63U5d5ANg',
      userKey: 'id:user-SyMuQgidCFglkii63U5d5ANg',
      pageUserKey: 'unknown'
    }
  );
  assert.equal(key, 'h:byeson');
});
