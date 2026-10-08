const assert = require('node:assert/strict');
const test = require('node:test');
const { EncryptionManager, ErmisChat } = require('../dist/index.cjs');
const cid = 'team:late-protocol';
const groupId = new Uint8Array([255, 0, 1]);
function harness({ delivered = true, localGeneration = 1, authoritativeGeneration = 1, authoritativeId = groupId, missingChannel = false, failure = false } = {}) {
  const m = new EncryptionManager();
  let epoch = 4;
  const calls = [];
  const states = [];
  const boundary = { created_at: '2026-10-05T00:00:00Z', event_id: 'zero' };
  m.groups = new Map([[cid, {}]]);
  m._groupGenerations = new Map([[cid, { cid, group_generation: localGeneration, group_id: groupId, status: 'active' }]]);
  m.getEpoch = () => epoch;
  m._getActiveChannel = () => missingChannel ? null : { cid };
  m._membershipBoundedEventCursor = (_, saved) => { assert.equal(saved, null); return boundary; };
  m._syncChannelFromCursor = async (scope, cursor, limit) => {
    calls.push({ scope, cursor, limit });
    if (failure) throw new Error('fixture network failure');
    if (delivered) epoch = 5;
    return { cid, status: 'ready', needs_retry: false };
  };
  m._emitSyncState = s => states.push(s);
  const discovery = { [cid]: { result: 'state', generation: { group_generation: authoritativeGeneration, group_id: authoritativeId, current_epoch: 5 } } };
  return { m, discovery, calls, states, epoch: () => epoch, boundary };
}
test('mixed cursor ahead of a delayed Commit replays from membership boundary without a send or new Commit', async () => {
  const h = harness();
  await h.m._replayLaggingEpochs(h.discovery);
  assert.equal(h.epoch(), 5);
  assert.deepEqual(h.calls, [{ scope: cid, cursor: h.boundary, limit: 100 }]);
  await h.m._replayLaggingEpochs(h.discovery);
  assert.equal(h.calls.length, 1);
});
test('reserved epoch without delivered Commit remains retryable instead of READY', async () => {
  const h = harness({ delivered: false });
  await h.m._replayLaggingEpochs(h.discovery);
  assert.equal(h.epoch(), 4);
  assert.equal(h.states.at(-1).status, 'needs_retry');
  assert.equal(h.states.at(-1).error, 'protocol_delivery_pending');
});
for (const [name, options] of [
  ['different generation', { authoritativeGeneration: 2 }],
  ['different GroupId', { authoritativeId: new Uint8Array([9]) }],
  ['unknown membership boundary', { missingChannel: true }],
]) {
  test(`${name} never authorizes a history rewind`, async () => {
    const h = harness(options);
    await h.m._replayLaggingEpochs(h.discovery);
    assert.equal(h.calls.length, 0);
    assert.equal(h.epoch(), 4);
  });
}
test('replay transport failure keeps needs_retry and does not replace group or advance epoch', async () => {
  const h = harness({ failure: true });
  h.m.getSyncState = () => ({ cid, status: 'ready' });
  await h.m._replayLaggingEpochs(h.discovery);
  assert.equal(h.epoch(), 4);
  assert.equal(h.states.at(-1).error, 'protocol_replay_failed');
});
test('ordinary global sync repairs a delayed Commit even when its saved application cursor is later', async () => {
  const h = harness();
  const advanced = { created_at: '2026-10-05T00:01:00Z', event_id: 'application-after-commit' };
  h.m._restoreGroupsLocally = async () => {};
  h.m._loadAllScopeSyncCursors = async () => ({ [cid]: advanced });
  h.m.storage = { loadRemovedSyncCursor: async () => null };
  h.m._listKnownE2eeChannels = () => [{ cid }];
  h.m._membershipBoundedEventCursor = (_, saved) => saved || h.boundary;
  h.m._flushPendingSnapshotsForScope = async () => ({ pending: [] });
  h.m._saveEncryptionSyncCheckpoint = async () => {};
  h.m._discoverMlsRecoveryStates = async () => ({ states: h.discovery, unsupported: false });
  h.m.bootstrapKnownE2eeChannels = async () => {};
  h.m.e2eeClient = { scopeSync: async cursors => {
    assert.deepEqual(cursors[cid], advanced);
    return { channels: { [cid]: { events: [], has_more: false } } };
  } };
  await h.m._syncAndRestoreGroups();
  assert.equal(h.epoch(), 5);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].cursor, h.boundary);
});
for (const code of ['mls_protocol_epoch_gap', 'mls_own_commit_unresolved']) {
test(`${code} in a forward page holds its prefix but still reaches authoritative rewind discovery`, async () => {
  const h = harness();
  const advanced = { created_at: '2026-10-05T00:01:00Z', event_id: 'ahead' };
  let checkpoint;
  h.m._restoreGroupsLocally = async () => {};
  h.m._loadAllScopeSyncCursors = async () => ({ [cid]: advanced });
  h.m.storage = { loadRemovedSyncCursor: async () => null };
  h.m._listKnownE2eeChannels = () => [{ cid }];
  h.m._membershipBoundedEventCursor = (_, saved) => saved || h.boundary;
  h.m._saveEncryptionSyncCheckpoint = async cp => { checkpoint = cp; };
  h.m._discoverMlsRecoveryStates = async () => ({ states: h.discovery, unsupported: false });
  h.m.bootstrapKnownE2eeChannels = async opts => { assert.deepEqual(opts.scopeSyncedCids, []); };
  h.m._resumePendingMlsMutations = async () => {};
  h.m._processChannelEvents = async () => {
    const error = new Error('actual Commit rejected because predecessor is missing');
    error.code = code; throw error;
  };
  h.m.e2eeClient = { scopeSync: async () => ({ channels: { [cid]: {
    events: [{ type: 'protocol' }], next_cursor: { created_at: '2026-10-05T00:02:00Z', event_id: 'future' },
    has_more: false,
  } } }) };
  await h.m._syncAndRestoreGroups();
  assert.deepEqual(checkpoint.scopeCursors[cid], advanced);
  assert.equal(h.states[0].status, 'needs_retry');
  assert.equal(h.epoch(), 5);
  assert.deepEqual(h.calls[0].cursor, h.boundary);
});
}
test('future application requests single-flight sync with a global cooldown; ordinary failures do not', async () => {
  const m = new EncryptionManager(); let calls = 0;
  m.initialized = true; m.e2eeClient = {};
  m.sync = async () => { calls++; };
  for (const [local, incoming, error] of [[4,4,'epoch differs'], [4,3,'epoch differs'],
    [4,5,'AEAD error'], [undefined,5,'epoch differs'], [4,NaN,'epoch differs']]) {
    m._requestFutureEpochSync(local, incoming, error);
  }
  assert.equal(calls, 0);
  m._syncing = true; m._requestFutureEpochSync(4,5,'epoch differs'); assert.equal(calls,0);
  m._syncing = false;
  for (let n=0;n<100;n++) m._requestFutureEpochSync(4,5,'epoch differs');
  assert.equal(calls, 1);
  m._lastFutureEpochSyncAt -= 10_001;
  m._requestFutureEpochSync(4,6,'epoch differs');
  assert.equal(calls, 2);
});
for (const type of ['commit', 'own-commit', 'welcome']) {
  test(`realtime ${type} waits for protocol replay before touching the provider`, async () => {
    const client = new ErmisChat('fixture', 'fixture', 'https://fixture.invalid', { browser: false });
    client.userID = 'alice'; client.logger = () => {};
    const channel = client.channel('team', `gate-${type}`);
    let syncing = true, release; const calls = [];
    const gate = new Promise(resolve => { release = resolve; });
    client.encryptionManager = { initialized: true, userId: 'alice', deviceId: 'device',
      isSyncing: () => syncing, waitForSync: () => gate, isScopeRepairing: () => false,
      isChannelEncryptionSyncBlocked: () => false, getGroup: () => null,
      reconcileMlsBootstrapWelcome: async () => {
        assert.equal(syncing, false);
      },
      joinGroup: async () => { calls.push('welcome'); },
      processOwnMlsCommit: async () => { calls.push('own-commit'); },
      processCommit: async () => { calls.push('commit'); },
    };
    const event = { type: 'protocol', cid: channel.cid, protocol_data: {
      type: type === 'welcome' ? 'welcome' : 'commit', epoch: 2,
      user: { id: type === 'own-commit' ? 'alice' : 'bob' },
      device_id: type === 'own-commit' ? 'device' : 'other', target_user_ids: ['alice'],
    } };
    const work = channel._handleChannelEvent(event);
    await Promise.resolve();
    assert.deepEqual(calls, []);
    syncing = false; release(); await work;
    assert.deepEqual(calls, [type]);
  });
}
test('a protocol event waiting for sync cannot cross a logout/session switch', async () => {
  const client = new ErmisChat('fixture', 'fixture', 'https://fixture.invalid', { browser: false });
  client.userID = 'alice'; client.logger = () => {};
  const channel = client.channel('team', 'switched-gate');
  let syncing = true, release, processed = 0;
  const gate = new Promise(resolve => { release = resolve; });
  client.encryptionManager = { initialized: true, userId: 'alice', deviceId: 'device',
    isSyncing: () => syncing, waitForSync: () => gate, isScopeRepairing: () => false,
    processCommit: async () => { processed++; },
  };
  const work = channel._handleChannelEvent({ type: 'protocol', protocol_data: {
    type: 'commit', user: { id: 'bob' }, device_id: 'other', epoch: 2,
  } });
  await Promise.resolve();
  client.encryptionManager.userId = 'new-user';
  syncing = false; release(); await work;
  assert.equal(processed, 0);
});

function membershipHarness() {
  const client = new ErmisChat('fixture', 'fixture', 'https://fixture.invalid', { browser: false });
  client.userID = 'alice'; client.user = { id: 'alice' }; client.logger = () => {};
  client.state.users = { alice: client.user, bob: { id: 'bob' } };
  const channel = client.channel('team', 'membership-boundary');
  channel.data = { mls_enabled: true, mls_enabled_at: '2026-10-04T00:00:00Z' };
  const own = { user_id: 'alice', user: client.user, channel_role: 'owner', created_at: '2026-10-04T00:00:01Z' };
  const peer = { user_id: 'bob', user: client.state.users.bob, channel_role: 'member', created_at: '2026-10-05T00:00:00Z' };
  channel.state.members = { alice: own, bob: peer }; channel.state.membership = own;
  const manager = new EncryptionManager(); manager.userId = 'alice'; manager.client = client;
  return { client, channel, manager, own, peer };
}
test('a peer member.updated event preserves the current-user membership and replay boundary', async () => {
  const h = membershipHarness();
  await h.channel._handleChannelEvent({ type: 'member.updated', member: h.peer });
  assert.equal(h.channel.state.membership.user_id, 'alice');
  assert.equal(h.channel.state.members.bob.created_at, h.peer.created_at);
  assert.equal(h.manager._getMembershipCreatedAt(h.channel), h.own.created_at);
  assert.equal(h.manager._membershipBoundedEventCursor(h.channel, null).created_at, '2026-10-04T00:00:00.999Z');
});
test('previously contaminated peer membership cannot authorize the current-user replay boundary', () => {
  const h = membershipHarness(); h.channel.state.membership = h.peer;
  assert.equal(h.manager._getMembershipCreatedAt(h.channel), h.own.created_at);
});
test('own member update still changes the current-user membership and fence', async () => {
  const h = membershipHarness();
  const updated = { ...h.own, created_at: '2026-10-06T00:00:00Z' };
  await h.channel._handleChannelEvent({ type: 'member.updated', member: updated });
  assert.equal(h.channel.state.membership.created_at, updated.created_at);
  assert.equal(h.manager._getMembershipCreatedAt(h.channel), updated.created_at);
});
test('legacy ownerless current membership remains usable when no peer identity contradicts it', () => {
  const h = membershipHarness(); h.channel.state.membership = { created_at: h.own.created_at };
  delete h.channel.state.members.alice;
  assert.equal(h.manager._getMembershipCreatedAt(h.channel), h.own.created_at);
});
