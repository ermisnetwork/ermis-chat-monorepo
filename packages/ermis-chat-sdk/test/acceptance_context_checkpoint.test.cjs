const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {webcrypto} = require('node:crypto');
require('fake-indexeddb/auto'); globalThis.crypto ??= webcrypto;
const {EncryptionManager, IndexedDBEncryptionStorage, sha256Hex, validateMlsAcceptanceContext,
  mlsProtocolProcessingOptions} = require('../dist/encryption/index.cjs');
let unique = 0;
async function fixture() {
  const wasm = await import(pathToFileURL(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm.js')));
  await wasm.default({module_or_path: fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'))});
  const cid = `team:context-checkpoint-${++unique}`;
  const ap = new wasm.Provider(), bp = new wasm.Provider();
  const alice = new wasm.Identity(ap, 'alice'), bob = new wasm.Identity(bp, 'bob');
  const group = wasm.Group.create_with_cid(ap, alice, cid);
  const invite = group.add_members(ap, alice, [bob.key_package(bp)]); group.merge_pending_commit(ap);
  const joined = wasm.Group.join_with_welcome(bp, invite.welcome, null);
  const m = new EncryptionManager(); m.userId = `bob-context-${unique}`; m.deviceId = 'device'; m.initialized = true;
  m.storage = new IndexedDBEncryptionStorage(m.userId);
  await m.storage.saveIdentity(m.userId, m.deviceId, bob.to_bytes());
  await m.storage.saveProviderState(m.userId, m.deviceId, bp.to_bytes());
  m._injectedWasm = wasm; await m._initWasm(); await m._initIdentity();
  m.groups.set(cid, wasm.Group.load(m.provider, cid)); await m._persistProviderStrict();
  m.safeArchiveCurrentEpochForCid = async () => {}; m._flushPendingSnapshotsForScope = async () => {};
  const bundle = group.self_update(ap, alice); group.merge_pending_commit(ap);
  const context = {version: 1, event_id: 'context-event', cid, group_generation: 0, epoch: 2,
    accepted_at: Math.floor(Date.now() / 1000), payload_sha256: sha256Hex(bundle.commit), provenance: 'bellboy_transition_v1'};
  const envelope = {event_id: context.event_id, cid, group_generation: 0, epoch: 2};
  return {m, wasm, cid, commit: bundle.commit, context, envelope};
}
test('same canonical event through live/history uses actual contextual WASM, durable marker and reload', async () => {
  for (const historicalReplay of [false, true]) {
    const f = await fixture(); const options = {historicalReplay, acceptanceContext: f.context, acceptanceEnvelope: f.envelope};
    await f.m.processCommit(f.cid, f.commit, 2, undefined, options); assert.equal(f.m.getEpoch(f.cid), 2);
    assert.equal((await f.m.storage.loadGroupState(f.cid)).current_epoch, 2);
    const reloaded = f.wasm.Provider.from_bytes(await f.m.storage.loadProviderState(f.m.userId, f.m.deviceId));
    assert.equal(Number(f.wasm.Group.load(reloaded, f.cid).epoch()), 2);
    assert.equal(await f.m.processCommit(f.cid, f.commit, 2, undefined, options), null);
    await f.m.storage.close();
  }
});
test('raw timestamp, unknown provenance, tampered time/digest/event/CID/generation reject before snapshot or mutation', async () => {
  const f = await fixture(); const before = f.m.provider.to_bytes();
  for (const patch of [null, {provenance: 'imported'}, {accepted_at: Math.floor(Date.now()/1000) + 301},
    {accepted_at: -1}, {payload_sha256: '0'.repeat(64)}, {event_id: 'wrong'}, {cid: 'team:other'},
    {group_generation: 1}, {epoch: 1}, {version: 2}]) {
    await assert.rejects(f.m.processCommit(f.cid, f.commit, 2, undefined, {historicalReplay: true,
      serverAcceptedAt: '2026-09-08T01:02:03Z', acceptanceContext: patch === null ? undefined : {...f.context, ...patch},
      acceptanceEnvelope: f.envelope}), e => e.code === 'acceptance_metadata_invalid');
    assert.deepEqual(f.m.provider.to_bytes(), before); assert.equal(f.m.getEpoch(f.cid), 1);
  }
  await f.m.storage.close();
});
test('candidate persistence failure holds active group/epoch/private state without rollback over another writer', async () => {
  const f = await fixture(); const active = f.m.provider, before = active.to_bytes();
  const original = f.m.storage.saveMlsMutationCheckpoint.bind(f.m.storage);
  let entered, release; const start = new Promise(r => entered = r), gate = new Promise(r => release = r);
  f.m.storage.saveMlsMutationCheckpoint = async () => {entered(); await gate; throw Error('disk failed');};
  const processing = f.m.processCommit(f.cid, f.commit, 2, undefined, {acceptanceContext: f.context, acceptanceEnvelope: f.envelope});
  await start; assert.equal(f.m.getEpoch(f.cid), 1); assert.deepEqual(active.to_bytes(), before);
  assert.throws(() => f.m.provider, e => e.code === 'provider_mutation_busy');
  release(); await assert.rejects(processing, /disk failed/); assert.equal(f.m.getEpoch(f.cid), 1);
  assert.deepEqual(f.m.provider.to_bytes(), before); f.m.storage.saveMlsMutationCheckpoint = original;
  await f.m.processCommit(f.cid, f.commit, 2, undefined, {acceptanceContext: f.context, acceptanceEnvelope: f.envelope});
  assert.equal(f.m.getEpoch(f.cid), 2); await f.m.storage.close();
});
test('own settlement and missing local group cannot use raw timestamp to advance event disposition', async () => {
  const f = await fixture(); let settle = false;
  f.m.reconcileOwnMlsCommit = async () => {settle = true;};
  await assert.rejects(f.m.processOwnMlsCommit(f.cid, {commit: f.commit, epoch: 2}, {serverAcceptedAt: '2026-10-09T00:00:00Z'}), e => e.code === 'acceptance_metadata_invalid');
  assert.equal(settle, false);
  f.m.groups.delete(f.cid);
  await assert.rejects(f.m.processCommit(f.cid, f.commit, 2, undefined, {acceptanceContext: f.context, acceptanceEnvelope: f.envelope}), e => e.code === 'mls_group_missing');
  await f.m.storage.close();
});
test('metadata byte/control/integer bounds and projection disagreement fail closed', () => {
  const bytes = Uint8Array.of(1), envelope = {event_id: 'e', cid: 'team:test', group_generation: 0, epoch: 1};
  const context = {version: 1, ...envelope, accepted_at: Math.floor(Date.now()/1000), payload_sha256: sha256Hex(bytes), provenance: 'bellboy_transition_v1'};
  assert.equal(validateMlsAcceptanceContext(context, envelope, bytes), context);
  for (const patch of [{event_id: 'x'.repeat(129)}, {cid: 'x'.repeat(513)}, {event_id: 'e\n'},
    {extra: 'x'.repeat(4096)}, {accepted_at: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.throws(() => validateMlsAcceptanceContext({...context, ...patch}, envelope, bytes), e => e.code === 'acceptance_metadata_invalid');
  }
  assert.throws(() => mlsProtocolProcessingOptions({event_id: 'e'}, {event_id: 'other'}, 'team:test', true), e => e.code === 'acceptance_metadata_invalid');
});
