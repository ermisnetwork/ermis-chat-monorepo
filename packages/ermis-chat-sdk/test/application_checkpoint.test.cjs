const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EncryptionManager } = require('../dist/encryption/index.cjs');

const message = { id: 'checkpoint-fixture', cid: 'team:fixture', created_at: '2026-10-04T00:00:00Z',
  mls_epoch: 1, mls_ciphertext: Uint8Array.from([1, 2, 3]) };
function harness({ cached, saveFails = false, decryptFails = false, providerFails = false } = {}) {
  const manager = new EncryptionManager();
  const calls = [];
  manager.userId = 'fixture'; manager.deviceId = 'fixture';
  manager.groups.set(message.cid, { epoch: () => 1 });
  manager.provider = { to_bytes: () => Uint8Array.from([7]) };
  manager.storage = {
    loadMessage: async () => cached,
    saveMessage: async () => { calls.push('decoded'); if (saveFails) throw new Error('synthetic write failure'); },
    saveProviderState: async () => { calls.push('provider'); if (providerFails) throw new Error('synthetic provider failure'); },
  };
  manager._isEncryptionProcessingBlockedForRoute = () => false;
  manager._clearRepairIssue = async () => {};
  manager._recordRepairIssue = async () => {};
  manager._logExpectedDecryptFailureOnce = () => {};
  manager._isExpectedRecoverableDecryptFailure = () => false;
  manager.decryptMessage = () => {
    calls.push('decrypt');
    if (decryptFails) throw new Error('SecretReuseError');
    return { payload: { text: 'harmless fixture' }, messageType: 0 };
  };
  return { manager, calls };
}
test('consumed ciphertext without an exact cached proof stays buffered', async () => {
  const { manager } = harness({ decryptFails: true });
  const result = await manager.decryptApplicationMessages(message.cid, [message]);
  assert.deepEqual(result.decrypted, []);
  assert.deepEqual(result.buffered, [message]);
  assert.equal(manager._decryptedMsgIds.has(manager._messageVersionKey(message)), false);
});
test('a cached encrypted envelope does not satisfy plaintext replay or skip decryption', async () => {
  const cached = { ...message, content_type: 'mls' };
  const { manager, calls } = harness({ cached });
  const result = await manager.decryptApplicationMessages(message.cid, [message]);
  assert.equal(result.decrypted[0].text, 'harmless fixture');
  assert.deepEqual(calls, ['decrypt', 'decoded', 'provider']);
});
test('a consumed encrypted cache row without plaintext proof remains buffered', async () => {
  const cached = { ...message, content_type: 'mls' };
  const { manager } = harness({ cached, decryptFails: true });
  const result = await manager.decryptApplicationMessages(message.cid, [message]);
  assert.deepEqual(result.decrypted, []);
  assert.deepEqual(result.buffered, [message]);
});
test('invalid encoded ciphertext remains buffered without touching the ratchet', async () => {
  const { manager, calls } = harness();
  const invalid = { ...message, mls_ciphertext: 'invalid!' };
  const result = await manager.decryptApplicationMessages(message.cid, [invalid]);
  assert.deepEqual(result.buffered, [invalid]);
  assert.deepEqual(calls, []);
});
test('an exact proof recovers consumed ciphertext and must persist provider', async () => {
  const cached = { ...message, text: 'harmless fixture', content_type: 'standard',
    mls_ciphertext_hash: createHash('sha256').update(message.mls_ciphertext).digest('hex') };
  const { manager, calls } = harness({ cached, decryptFails: true });
  const result = await manager.decryptApplicationMessages(message.cid, [message]);
  assert.deepEqual(result.decrypted, [cached]);
  assert.deepEqual(result.buffered, []);
  assert.deepEqual(calls, ['decrypt', 'provider']);
});
test('mismatched ciphertext proof cannot authorize consumed success', async () => {
  const cached = { ...message, text: 'older fixture', content_type: 'standard', mls_ciphertext_hash: 'wrong' };
  const { manager } = harness({ cached, decryptFails: true });
  const result = await manager.decryptApplicationMessages(message.cid, [message]);
  assert.deepEqual(result.decrypted, []);
  assert.deepEqual(result.buffered, [message]);
});
test('provider persistence failure rejects completion after decoded write', async () => {
  const { manager, calls } = harness({ providerFails: true });
  await assert.rejects(manager.decryptApplicationMessages(message.cid, [message]), /synthetic provider failure/);
  assert.deepEqual(calls, ['decrypt', 'decoded', 'provider']);
});
test('decoded write failure leaves the event buffered and clears memory dedup', async () => {
  const { manager, calls } = harness({ saveFails: true });
  const result = await manager.decryptApplicationMessages(message.cid, [message]);
  assert.deepEqual(result.buffered, [message]);
  assert.equal(manager._decryptedMsgIds.has(manager._messageVersionKey(message)), false);
  assert.deepEqual(calls, ['decrypt', 'decoded']);
  await assert.rejects(manager._persistProviderStrict(), /synthetic write failure/);
  assert.deepEqual(calls, ['decrypt', 'decoded', 'decoded']);
  assert.equal(manager._pendingApplicationWrites.size, 1);
});

test('global startup sync stops an empty has-more page without advancing cursor or READY', async () => {
  const { manager } = harness();
  const cursor = { created_at: '2026-10-04T00:00:00Z', event_id: 'fixture-event' };
  let requests = 0;
  const states = [];
  manager._restoreGroupsLocally = async () => {};
  manager._loadAllScopeSyncCursors = async () => ({ [message.cid]: cursor });
  manager.storage.loadRemovedSyncCursor = async () => null;
  manager._listKnownE2eeChannels = () => [];
  manager._membershipBoundedEventCursor = () => cursor;
  manager._flushPendingSnapshotsForScope = async () => ({ pending: [] });
  manager._emitSyncState = state => states.push(state);
  manager._saveEncryptionSyncCheckpoint = async options => assert.deepEqual(options.scopeCursors[message.cid], cursor);
  manager._discoverMlsRecoveryStates = async () => ({ states: {}, unsupported: false });
  manager.bootstrapKnownE2eeChannels = async options => assert.deepEqual(options.scopeSyncedCids, []);
  manager.e2eeClient = { scopeSync: async () => {
    if (++requests > 2) throw new Error('would loop without progress');
    return { channels: { [message.cid]: { events: [], has_more: true } } };
  } };
  await manager._syncAndRestoreGroups();
  assert.equal(requests, 1);
  assert.equal(states[0].needs_retry, true);
  assert.notEqual(states[0].status, 'ready');
});
