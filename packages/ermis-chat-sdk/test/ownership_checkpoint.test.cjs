const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), {pathToFileURL} = require('node:url');
const binary = fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'));
let wasmPromise;
const actualWasm = () => wasmPromise ??= (async () => {const wasm = await import(pathToFileURL(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm.js')));await wasm.default({module_or_path: binary});return wasm;})();
const realNow = Date.now; test.afterEach(() => {Date.now = realNow;});
require('fake-indexeddb/auto');
globalThis.crypto ??= webcrypto;
const { EncryptionManager, IndexedDBEncryptionStorage, sha256Hex } = require('../dist/encryption/index.cjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = n => ({ id: id(n), created_at: '2026-10-09T00:00:00Z', key_package_ref: Uint8Array.from({length: 32}, (_, i) => (n >> ((i % 4) * 8)) & 255) });
let unique = 0;
async function fixture(user = `own-durable-${++unique}`, storage = new IndexedDBEncryptionStorage(user)) {
  const m = new EncryptionManager(); m.userId = user; m.deviceId = 'device'; m.storage = storage;
  const wasm = await actualWasm(); m._injectedWasm = wasm; m._wasmArtifactSha256 = sha256Hex(binary);
  await m._initWasm(); await m._initIdentity(); await m._persistProviderStrict(); m.initialized = true;
  const seen = []; const remaining = Array.from({length: 450}, (_, n) => entry(n + 1));
  m.e2eeClient = {
    async getKeyPackageOwnership(cursor) {
      seen.push(['get', cursor?.id || null]);
      const rows = remaining.filter(e => !cursor || e.id > cursor.id).slice(0, 100);
      const last = rows.at(-1);
      return {version: 1, entries: rows, next_cursor: last && remaining.some(e => e.id > last.id) ? {id: last.id, created_at: last.created_at} : null};
    },
    async reconcileKeyPackageOwnership(missing) {
      seen.push(['post', missing.length]);
      for (const e of missing) { const at = remaining.findIndex(r => r.id === e.id); if (at >= 0) remaining.splice(at, 1); }
      return {retired: missing.length};
    },
  };
  const restart = async (nextStorage = storage) => {
    const manager = new EncryptionManager(); Object.assign(manager, {userId: user, deviceId: 'device', storage: nextStorage,
      e2eeClient: m.e2eeClient, _injectedWasm: wasm, _wasmArtifactSha256: sha256Hex(binary)});
    await manager._initWasm(); await manager._initIdentity(); manager.initialized = true; return manager;
  };
  return {m, seen, storage, remaining, user, restart};
}
async function run(m) { const at = Math.max(Date.now(), m._keyPackageOwnershipCheckedAt + 30_000); Date.now = () => at; return m.reconcileKeyPackageOwnership(); }
async function cp(f) { return f.storage.loadKeyPackageOwnershipCheckpoint(f.user, 'device'); }
async function makeDue(f) {
  const value = await cp(f); const due = Math.max(Date.now(), value.scan_next_retry_at, ...value.retry_queue.map(item => item.next_retry_at));
  Date.now = () => due;
}

test('450 rows: six HTTP bound, restart resumes durable cursor through another adapter', async () => {
  const f = await fixture();
  await run(f.m); assert.equal(f.seen.length, 6); assert.equal((await cp(f)).scan_cursor.id, id(300));
  const other = new IndexedDBEncryptionStorage(f.user);
  const restarted = await f.restart(other);
  await run(restarted); assert.deepEqual(f.seen[6], ['get', id(300)]);
  assert.equal(f.remaining.length, 0); assert.equal((await cp(f)).scan_cursor, null);
  await other.close(); await f.storage.close();
});

test('three partial acknowledgements preserve page then yield a retry lane; fresh scan progresses', async () => {
  const f = await fixture(); f.m.e2eeClient.reconcileKeyPackageOwnership = async () => {f.seen.push(['post', 100]); return {retired: 0};};
  for (let n = 1; n <= 3; n++) {
    await run(f.m); const value = await cp(f);
    assert.equal(value.retry_queue.length, n === 3 ? 1 : 0);
    assert.equal(value.scan_cursor?.id || null, n === 3 ? id(100) : null);
    await makeDue(f);
  }
  f.seen.length = 0; await run(f.m);
  assert.deepEqual(f.seen.filter(x => x[0] === 'get').map(x => x[1]), [null, id(100)]);
  assert.equal((await cp(f)).retry_queue[0].attempts, 4);
  // Retry never drops after repeated failures; other fresh pages still get slots.
  await makeDue(f); await run(f.m);
  assert.equal((await cp(f)).retry_queue[0].cursor, null);
  assert.equal((await cp(f)).retry_queue[0].attempts, 5);
  assert.equal((await cp(f)).scan_cursor.id, id(200));
  await f.storage.close();
});

test('full sixteen-page queue keeps current cursor and marks required rescan', async () => {
  const f = await fixture(); await run(f.m); let value = await cp(f);
  value.scan_cursor = {id: id(400), created_at: entry(400).created_at}; value.scan_attempts = 2;
  value.retry_queue = Array.from({length: 16}, (_, n) => ({cursor: {id: id(n + 1), created_at: entry(n + 1).created_at}, attempts: 3, next_retry_at: Date.now() + 300_000}));
  f.m.e2eeClient.reconcileKeyPackageOwnership = async () => ({retired: 0});
  await f.storage.saveKeyPackageOwnershipCheckpoint(value); await run(f.m); value = await cp(f);
  assert.equal(value.retry_queue.length, 16); assert.equal(value.scan_cursor.id, id(400)); assert.equal(value.restart_scan_required, true);
  await f.storage.close();
});

test('obsolete signer checkpoint is retained; corrupt/future clock defers without resetting original metadata', async () => {
  const f = await fixture(); await run(f.m); const snapshot = await f.storage.loadProviderState(f.user, 'device');
  let value = await cp(f); value.signing_identity_sha256 = 'f'.repeat(64);
  await f.storage.saveKeyPackageOwnershipCheckpoint(value); f.seen.length = 0; await run(f.m);
  assert.deepEqual(f.seen[0], ['get', null]);
  value = await cp(f); value.retry_queue = [{cursor: null, attempts: 9, next_retry_at: Number.MAX_SAFE_INTEGER}];
  value.updated_at = Number.MAX_SAFE_INTEGER; value.scan_next_retry_at = Number.MAX_SAFE_INTEGER;
  await f.storage.saveKeyPackageOwnershipCheckpoint(value); await run(f.m); value = await cp(f);
  assert.equal(value.retry_queue[0].next_retry_at, Number.MAX_SAFE_INTEGER);
  assert.equal(value.scan_next_retry_at, Number.MAX_SAFE_INTEGER);
  value.retry_queue = [{cursor: {id: 'malformed'}, attempts: 0, next_retry_at: 0}];
  await f.storage.saveKeyPackageOwnershipCheckpoint(value); await run(f.m); assert.deepEqual(await cp(f), value);
  assert.deepEqual(await f.storage.loadProviderState(f.user, 'device'), snapshot);
  await f.storage.close();
});

test('missing durability capability, storage read failure and retained identity mismatch never send retirement', async () => {
  for (const mode of ['missing', 'read', 'identity', 'provider']) {
    const f = await fixture();
    if (mode === 'missing') f.storage.saveKeyPackageOwnershipWork = undefined;
    if (mode === 'read') f.storage.loadKeyPackageOwnershipWorkBase = async () => {throw Error('storage');};
    if (mode === 'identity') await f.storage.saveIdentity(f.user, 'device', Uint8Array.of(99));
    if (mode === 'provider') await f.storage.saveProviderState(f.user, 'device', Uint8Array.of(99));
    await run(f.m); assert.deepEqual(f.seen, []); await f.storage.close();
  }
});

test('mutation without provider replacement invalidates a probe waiting on HTTP', async () => {
  const f = await fixture();
  f.m.e2eeClient.getKeyPackageOwnership = async () => {const kp=f.m.identity.key_package(f.m.provider);kp.free();return {version: 1, entries: [entry(2)]};};
  f.m.e2eeClient.reconcileKeyPackageOwnership = async () => {assert.fail('retirement after provider mutation');};
  await run(f.m); assert.equal((await cp(f)).scan_cursor, null); await f.storage.close();
});

test('lost retirement response or checkpoint failure cannot advance a durable cursor', async () => {
  const f = await fixture();
  f.m.e2eeClient.reconcileKeyPackageOwnership = async () => {throw Error('lost ACK');};
  await run(f.m); assert.equal((await cp(f)).scan_cursor, null);
  await makeDue(f);
  let writes = 0; const save = f.storage.saveKeyPackageOwnershipWork.bind(f.storage);
  f.storage.saveKeyPackageOwnershipWork = async (...args) => {if (++writes > 1) throw Error('checkpoint failed'); return save(...args);};
  f.m.e2eeClient.reconcileKeyPackageOwnership = async missing => ({retired: missing.length});
  await run(f.m); assert.equal((await cp(f)).scan_cursor, null);
  assert.equal((await cp(f)).signing_identity_sha256, sha256Hex(f.m.identity.signature_public_key()));
  await f.storage.close();
});


test('transient GET backoff is durable across restart, exponential, capped and never unsupported', async () => {
  const f = await fixture(); let calls = 0;
  f.m.e2eeClient.getKeyPackageOwnership = async () => {calls++; throw {response: {status: 503}};};
  const providerBefore = await f.storage.loadProviderState(f.user, 'device');
  for (let attempt = 1; attempt <= 7; attempt++) {
    const before = Date.now(); await run(f.m); const value = await cp(f);
    assert.equal(value.scan_cursor, null); assert.equal(value.scan_attempts, attempt);
    const delay = Math.min(300_000, 30_000 * 2 ** Math.min(4, attempt - 1));
    assert(value.scan_next_retry_at >= before + delay && value.scan_next_retry_at <= Date.now() + delay);
    const restarted = await f.restart();
    await run(restarted); assert.equal(calls, attempt); assert.equal(restarted._keyPackageOwnershipUnsupported, false); f.m = restarted;
    await makeDue(f);
  }
  f.m.e2eeClient.getKeyPackageOwnership = async () => ({version: 1, entries: []});
  await run(f.m); assert.equal((await cp(f)).scan_attempts, 0);
  assert.deepEqual(await f.storage.loadProviderState(f.user, 'device'), providerBefore); await f.storage.close();
});

test('lost retirement ACK survives restart without cursor advance or a second immediate POST', async () => {
  const f = await fixture(); let posts = 0;
  f.m.e2eeClient.reconcileKeyPackageOwnership = async () => {posts++; throw Error('lost ACK');};
  await run(f.m); assert.equal(posts, 1); assert.equal((await cp(f)).scan_cursor, null);
  const restarted = await f.restart();
  await run(restarted); assert.equal(posts, 1); await makeDue(f); await run(restarted);
  assert.equal(posts, 2); assert.equal((await cp(f)).scan_attempts, 2); assert.equal((await cp(f)).scan_cursor, null);
  await f.storage.close();
});

test('failed retry-lane GET preserves its cursor and still allows two fresh scan slots', async () => {
  const f = await fixture(); await run(f.m); const value = await cp(f);
  value.retry_queue = [{cursor: null, attempts: 3, next_retry_at: 0}];
  await f.storage.saveKeyPackageOwnershipCheckpoint(value); f.seen.length = 0;
  const get = f.m.e2eeClient.getKeyPackageOwnership;
  f.m.e2eeClient.getKeyPackageOwnership = async cursor => {if (!cursor) {f.seen.push(['failed_get', null]); throw {status: 503};} return get(cursor);};
  await run(f.m); const next = await cp(f);
  assert.deepEqual(f.seen.map(x => x[0]), ['failed_get', 'get', 'post', 'get', 'post']);
  assert.equal(next.retry_queue[0].cursor, null); assert.equal(next.retry_queue[0].attempts, 4);
  assert.equal(f.remaining.length, 0); assert.equal(next.scan_cursor, null); await f.storage.close();
});

for (const replacement of ['storage', 'client']) test(`ownership ${replacement} replacement while GET waits invalidates retirement and old capability response`, async () => {
  const f = await fixture(); const original = await cp(f); let posts = 0, writes = 0;
  f.m.e2eeClient.reconcileKeyPackageOwnership = async () => {posts++; return {retired: 1};};
  f.m.e2eeClient.getKeyPackageOwnership = async () => {
    if (replacement === 'storage') f.m.storage = {saveKeyPackageOwnershipCheckpoint: async () => {writes++;}};
    else f.m.e2eeClient = {reconcileKeyPackageOwnership: async () => {posts++;}};
    return {version: 1, entries: [entry(2)]};
  };
  await run(f.m); assert.equal(posts, 0); assert.equal(writes, 0); assert.equal((await cp(f)).scan_attempts, 1);
  assert.equal((await cp(f)).scan_cursor, original?.scan_cursor || null); assert.equal(f.m._keyPackageOwnershipUnsupported, false);
  await f.storage.close();
});
