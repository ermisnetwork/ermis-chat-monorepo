const test = require('node:test');
const assert = require('node:assert/strict');
const { ErmisChat, EncryptionManager } = require('../dist/index.cjs');

for (const own of [false, true]) for (const fails of [false, true]) {
  test(`realtime ${own ? 'own' : 'peer'} Commit ${fails ? 'failure' : 'success'} never requests sync`, async () => {
    const client = new ErmisChat('fixture', 'fixture', 'https://fixture.invalid', { browser: false });
    client.userID = 'alice'; client.logger = () => {};
    const channel = client.channel('team', 'realtime');
    const calls = { own: 0, peer: 0, sync: 0 };
    const process = key => async () => { calls[key]++; if (fails) throw Error('fixture protocol gap'); };
    client.encryptionManager = { initialized: true, userId: 'alice', deviceId: 'device',
      isSyncing: () => false, isScopeRepairing: () => false, noteRealtimeProtocolFailure: () => {},
      processOwnMlsCommit: process('own'), processCommit: process('peer'),
      requestScopeSyncAfterRepair: () => calls.sync++, sync: async () => calls.sync++,
    };
    await channel._handleChannelEvent({ type: 'protocol', cid: channel.cid, protocol_data: {
      type: 'commit', epoch: 2, user: { id: own ? 'alice' : 'bob' }, device_id: own ? 'device' : 'other',
    } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.own, own ? 1 : 0); assert.equal(calls.peer, own ? 0 : 1);
    assert.equal(calls.sync, 0);
  });
}

test('applied own realtime echo with missing legacy context is a local no-op without native apply', async () => {
  const manager = new EncryptionManager();
  manager.initialized = true; manager.userId = 'alice'; manager.deviceId = 'device';
  manager._restoreInstalledGroupOnDemand = async () => {};
  manager.groups.set('team:echo', { has_pending_commit: () => false });
  manager._groupGenerations.set('team:echo', { group_generation: 0, status: 'active' });
  manager.getEpoch = () => 5;
  manager.processCommit = async () => assert.fail('already applied echo must not mutate');
  await manager.processOwnMlsCommit('team:echo', { epoch: 5, group_generation: 0 }, { realtime: true });
});

test('unknown own candidate is retained and cannot use the realtime echo no-op', async () => {
  const manager = new EncryptionManager();
  manager.initialized = true; manager.userId = 'alice'; manager.deviceId = 'device';
  manager._restoreInstalledGroupOnDemand = async () => {};
  manager.groups.set('team:echo', { has_pending_commit: () => false });
  manager.getEpoch = () => 5;
  const candidate = { body: { operation_id: 'original-operation' } };
  manager._externalJoinCandidates.set('team:echo', candidate);
  await assert.rejects(manager.processOwnMlsCommit('team:echo', { epoch: 5 }, { realtime: true }));
  assert.equal(manager._externalJoinCandidates.get('team:echo'), candidate);
});

test('future ciphertext never triggers an offline scope request', () => {
  const manager = new EncryptionManager(); let calls = 0;
  manager.initialized = true; manager.e2eeClient = {};
  manager.requestScopeSyncAfterRepair = () => calls++;
  for (let i = 0; i < 100; i++) manager._requestFutureEpochSync('team:future', 4, 5, 'epoch mismatch');
  assert.equal(calls, 0);
});


test('channel metadata enable/update never starts offline sync while awaiting online Welcome', async () => {
  const client = new ErmisChat('fixture', 'fixture', 'https://fixture.invalid', { browser: false });
  client.userID = 'alice'; client.logger = () => {};
  const channel = client.channel('team', 'metadata'); let requests = 0;
  client.encryptionManager = { initialized: true, isChannelEncryptionSyncBlocked: () => false,
    ensureChannelReady: async () => requests++ };
  await channel._handleChannelEvent({ type: 'channel.updated', cid: channel.cid,
    channel: { cid: channel.cid, id: channel.id, type: 'team', mls_enabled: true,
      mls_enabled_at: '2026-11-22T00:00:00Z' } });
  assert.equal(channel.data.mls_enabled, true); assert.equal(requests, 0);
});


test('a real protocol gap revokes local Ready without fetching or settling an unknown operation', () => {
  const manager = new EncryptionManager(); manager.initialized = true; manager.userId = 'alice'; manager.deviceId = 'device';
  manager.groups.set('team:gap', { has_pending_commit: () => false }); manager.getEpoch = () => 4;
  manager._groupGenerations.set('team:gap', { group_generation: 0, status: 'active' });
  let requests = 0; manager.requestScopeSyncAfterRepair = () => requests++;
  manager.noteRealtimeProtocolFailure('team:gap', { epoch: 6, group_generation: 0 });
  assert.equal(manager.getE2eeState('team:gap').state, 'repairing');
  assert.equal(manager.getE2eeState('team:gap').reason, 'protocol_delivery_pending'); assert.equal(requests, 0);
});

test('another device of the same user still processes the realtime Commit', async () => {
  const client = new ErmisChat('fixture', 'fixture', 'https://fixture.invalid', { browser: false });
  client.userID = 'alice'; client.logger = () => {};
  const channel = client.channel('team', 'second-device'); let processed = 0;
  client.encryptionManager = { initialized: true, userId: 'alice', deviceId: 'current-device',
    isSyncing: () => false, isScopeRepairing: () => false,
    processOwnMlsCommit: async () => assert.fail('another device is not an own echo'),
    processCommit: async () => processed++, requestScopeSyncAfterRepair: () => assert.fail('no sync'),
  };
  await channel._handleChannelEvent({ type: 'protocol', cid: channel.cid, protocol_data: {
    type: 'commit', epoch: 5, user: { id: 'alice' }, device_id: 'second-device',
  } });
  assert.equal(processed, 1);
});
