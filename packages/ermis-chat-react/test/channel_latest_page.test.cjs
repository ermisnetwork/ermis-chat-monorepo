const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const moduleFixture = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/hooks/channelLatestPage.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: moduleFixture.exports, module: moduleFixture, Promise, WeakMap, WeakSet });
const { queryLatestPage, hasLatestPage } = moduleFixture.exports;
for (const encrypted of [false, true]) test(`preview1 → latest25 and concurrent entry coalesces, encrypted=${encrypted}`, async () => {
  let resolve, calls = 0;
  const channel = { data: { mls_enabled: encrypted }, messages: [{ id: 'preview' }], query(options) {
    calls++; assert.equal(options.messages_seq.limit, 25);
    return new Promise(done => { resolve = done; });
  } };
  assert.equal(hasLatestPage(channel), false);
  const first = queryLatestPage(channel), second = queryLatestPage(channel);
  assert.equal(first, second); await Promise.resolve(); assert.equal(calls, 1);
  const page = Array.from({ length: 25 }, (_, i) => ({ id: String(i) }));
  resolve(page); assert.equal((await first).length, 25); assert.equal(hasLatestPage(channel), true);
  // A later real entry refreshes, retaining the same existing SDK query route.
  const refresh = queryLatestPage(channel); await Promise.resolve(); assert.equal(calls, 2);
  resolve(page); await refresh;
});
test('failed query is retryable and cannot mark preview as a loaded page', async () => {
  let failed = true, calls = 0;
  const channel = { query: async () => { calls++; if (failed) throw new Error('offline'); return []; } };
  await assert.rejects(queryLatestPage(channel), /offline/); assert.equal(hasLatestPage(channel), false);
  failed = false; assert.deepEqual(await queryLatestPage(channel), []); assert.equal(calls, 2);
});
test('same CID in another account/channel object neither reuses request nor inherits completeness', async () => {
  const a = { cid: 'team:same', query: async () => ['a'] }, b = { cid: 'team:same', query: async () => ['b'] };
  await queryLatestPage(a); assert.equal(hasLatestPage(b), false);
  assert.deepEqual(await queryLatestPage(b), ['b']);
});

// Execute the actual hook's initial entry with no standard DB and E2EE init still
// pending. The only fake is the channel transport; presentation must receive25.
for (const encrypted of [false, true]) for (const cached of [false, true]) test(`actual channel hook queries and displays25 without awaiting account encryption, encrypted=${encrypted}, cached=${cached}`, async () => {
 const effects = [], timers = [], subscriptions = [];
 let shown = [], requests = 0, readiness = 0, restoreRequests = 0;
 const systemCache = Array.from({ length: 5 }, (_, i) => ({ id: 'system-' + i, type: 'system', text: 'fixture system', content_type: 'standard' }));
 const listeners = new Map();
 const noop = () => {}, sub = () => ({ unsubscribe: noop });
 const client = { userID: 'fixture', state: { users: {} }, activeChannels: {}, on: (event, callback) => { listeners.set(event, callback); return { unsubscribe: () => listeners.delete(event) }; },
   encryptionManager: { initialized: false, subscribeE2eeState: sub,
     restoreHistoryPage: async (_type, _id, page, options) => {
       restoreRequests++;
       assert.equal(page.length, 25);
       assert.equal(options.showHistoryProgress, true);
     },
     ensureChannelReady: async (...args) => { readiness++; assert.equal(args[3].source, 'open'); } } };
 const channel = { cid: 'team:fixture', type: 'team', id: 'fixture',
   data: { mls_enabled: encrypted }, state: { latestMessages: [{ id: 'preview', text: 'preview' }], read: {}, membership: { channel_role: 'member' } },
   getClient: () => client, on: sub,
   async query(options, messageSet, showHistoryProgress) {
     requests++; assert.equal(options.messages_seq.limit, 25);
     assert.equal(messageSet, 'current');
     assert.equal(showHistoryProgress, true);
     channel.state.latestMessages = Array.from({ length: 25 }, (_, i) => ({ id: 'message-' + i, text: 'fixture', content_type: encrypted ? 'mls' : 'standard' }));
   } };
 client.activeChannels[channel.cid] = channel;
 if (cached) {
   shown = [...channel.state.latestMessages];
   client.encryptionManager.storage = { getMessages: async () => systemCache, loadMessages: async () => new Map() };
 }
 const output = { exports: {} };
 const react = { useCallback: fn => fn, useRef: value => ({ current: value }), useLayoutEffect: fn => fn(), useEffect: fn => effects.push(fn) };
 const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/hooks/useChannelMessages.ts'), 'utf8'),
   { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
 vm.runInNewContext(code, { exports: output.exports, module: output,
   require: name => {
     if (name === 'react') return react;
     if (name === './channelLatestPage') return moduleFixture.exports;
     if (name === './useChatCore') return { useChatCore: () => ({ client, activeChannel: channel }) };
     if (name === './useChatMessages') return { useChatMessages: () => ({ syncMessages: () => { shown = channel.state.latestMessages; },
       setMessages: value => { shown = typeof value === 'function' ? value(shown) : value; }, setReadState: noop, setChannelE2eeRepairing: noop }) };
     if (name === '../channelRoleUtils') return { isPendingMember: () => false };
     if (name === '../messageTypeUtils') return { isDeletedMessage: () => false, isUnavailableDisplayMessage: () => false,
       MESSAGE_TYPES: { DELETED: 'deleted' }, MESSAGE_DISPLAY_TYPES: { DELETED: 'deleted' } };
     throw new Error(name);
   }, console, setTimeout: fn => { timers.push(fn); }, requestAnimationFrame: fn => { timers.push(fn); },
   Promise, Map, Set, WeakMap, WeakSet, JSON, Date, Number });
 output.exports.useChannelMessages({ scrollToBottom: noop, followBottomAfterRender: noop,
   jumpingRef: { current: false }, isAtBottomRef: { current: true } });
 for (const effect of effects) subscriptions.push(effect());
 await new Promise(done => setImmediate(done));
 assert.equal(requests, 1);
 assert.equal(shown.filter(message => message.id.startsWith('message-')).length, 25, 'the queried window replaces sidebar preview even when React/cache is nonempty');
 if (encrypted && cached) assert.equal(shown.filter(message => message.content_type === 'mls').length, 25);
 assert.equal(client.encryptionManager.initialized, false);
 assert.equal(readiness, 0);
 client.encryptionManager.initialized = true;
 listeners.get('e2ee.initialized')?.();
 await new Promise(done => setImmediate(done));
 assert.equal(readiness, encrypted ? 1 : 0, 'the still-open encrypted scope is promoted once initialization becomes available');
 assert.equal(restoreRequests, encrypted ? 1 : 0);
 const staleInitialization = listeners.get('e2ee.initialized');
 for (const unsubscribe of subscriptions) unsubscribe?.();
 staleInitialization?.();
 await new Promise(done => setImmediate(done));
 assert.equal(readiness, encrypted ? 1 : 0, 'retired channel cannot enqueue readiness');
});
