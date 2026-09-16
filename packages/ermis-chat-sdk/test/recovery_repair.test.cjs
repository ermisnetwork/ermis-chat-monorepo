const assert = require('node:assert/strict');
const test = require('node:test');

const { EncryptionManager, ErmisChat, PartialWelcomeJoinCoordinator } = require('../dist/index.cjs');

const makeProgress = (overrides = {}) => ({
  device_id: 'device-1',
  cid: 'messaging:channel-1',
  user_id: 'user-1',
  channel_type: 'messaging',
  channel_id: 'channel-1',
  status: 'done',
  completed_epochs: [],
  permanent_gaps: [],
  transient_failures: [],
  repair_issues: [],
  last_checked_at: 1,
  updated_at: 1,
  ...overrides,
});

test('processed event cursor keeps its own event_id when server cursor is later in same timestamp', () => {
  const manager = new EncryptionManager();
  const started = {
    created_at: '2026-06-13T00:00:00.000Z',
    event_id: '00000000-0000-0000-0000-000000000000',
  };
  const processed = {
    created_at: '2026-06-13T00:00:10.000Z',
    event_id: '00000000-0000-0000-0000-000000000006',
  };
  const serverNext = {
    created_at: '2026-06-13T00:00:10.000Z',
    event_id: '00000000-0000-0000-0000-000000000010',
  };

  const result = manager._resolveProcessedEventCursor(
    { processedEventCursor: processed, processedEvents: 6, bufferedMessages: 0, decrypted: [] },
    started,
    serverNext,
  );

  assert.equal(result.cursorLagged, true);
  assert.deepEqual(result.durableCursor, processed);
});

test('live ciphertext from an inactive generation never reaches the installed MLS provider', async () => {
  const manager = new EncryptionManager();
  const cid = 'messaging:generation-fence';
  manager._groupGenerations.set(cid, {
    cid,
    group_generation: 2,
    group_id: new Uint8Array([2]),
    current_epoch: 0,
    status: 'active',
    updated_at: Date.now(),
  });
  let groupLookupCount = 0;
  manager.groups = {
    get() {
      groupLookupCount += 1;
      throw new Error('inactive generation reached MLS provider');
    },
  };

  const result = await manager.processE2eeMessage(cid, {
    id: 'old-generation-message',
    cid,
    group_generation: 1,
    mls_epoch: 3,
    mls_ciphertext: new Uint8Array([1, 2, 3]),
  });

  assert.equal(result, null);
  assert.equal(groupLookupCount, 0);
});

test('durable ciphertext is terminal when its generation is no longer active', async () => {
  const manager = new EncryptionManager();
  const cid = 'messaging:generation-fence';
  manager._groupGenerations.set(cid, {
    cid,
    group_generation: 3,
    group_id: new Uint8Array([3]),
    current_epoch: 0,
    status: 'active',
    updated_at: Date.now(),
  });
  manager.e2eeClient = {
    sendMessage: async () => {
      throw new Error('old generation was sent');
    },
  };

  await assert.rejects(
    manager._sendPersistedPendingE2eeRecord({
      message_id: 'pending-old-generation',
      cid,
      e2ee_group_id: cid,
      channel_type: 'messaging',
      channel_id: 'generation-fence',
      text: 'do not replay',
      mls_ciphertext: new Uint8Array([1, 2, 3]),
      mls_epoch: 4,
      group_generation: 2,
      retry_count: 0,
      status: 'failed_retryable',
      created_at: 1,
      updated_at: 1,
    }),
    (error) => error?.code === 'old_group_generation',
  );
});

test('a new failed message remains repairable in a completed epoch', () => {
  const manager = new EncryptionManager();
  const progress = manager._upsertRepairIssueInProgress(
    makeProgress({ completed_epochs: [12] }),
    {
      id: 'message-1',
      cid: 'messaging:channel-1',
      created_at: '2026-06-13T00:00:00.000Z',
      mls_epoch: 12,
      mls_ciphertext: new Uint8Array([1, 2, 3]),
    },
    'decrypt_error',
  );

  assert.deepEqual(progress.completed_epochs, [12]);
  assert.equal(progress.repair_issues.length, 1);
  assert.equal(progress.repair_issues[0].message_id, 'message-1');
  assert.equal(manager._finalRestoreStatus(progress), 'failed');
});

test('retries update one issue per message version instead of counting the epoch batch', () => {
  const manager = new EncryptionManager();
  const message = {
    id: 'failed-message',
    cid: 'messaging:channel-1',
    created_at: '2026-06-13T00:00:00.000Z',
    mls_epoch: 5,
    mls_ciphertext: new Uint8Array([4, 5, 6]),
  };

  let progress = manager._upsertRepairIssueInProgress(makeProgress(), message, 'decrypt_error');
  progress = manager._upsertRepairIssueInProgress(progress, message, 'decrypt_error');

  assert.equal(progress.repair_issues.length, 1);
  assert.equal(progress.repair_issues[0].retry_count, 2);
});

test('message repair identity does not change when the same version is observed at another epoch', () => {
  const manager = new EncryptionManager();
  const first = {
    id: 'same-version',
    created_at: '2026-06-13T00:00:00Z',
    mls_epoch: 3,
  };
  const second = {
    ...first,
    created_at: '2026-06-13T00:00:00.000Z',
    mls_epoch: 9,
  };

  assert.equal(manager._messageVersionKey(first), manager._messageVersionKey(second));
});

test('pending invite defers realtime encryption messages before local group processing', async () => {
  const manager = new EncryptionManager();
  manager.userId = 'user-1';
  const cid = 'messaging:channel-1';
  manager.client = {
    activeChannels: {
      [cid]: {
        id: 'channel-1',
        type: 'messaging',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'pending' } },
      },
    },
  };
  manager.storage = {
    loadE2eeMessage: async () => {
      throw new Error('pending invite message should not touch storage');
    },
  };

  const result = await manager.processE2eeMessage(cid, {
    id: 'pending-message',
    cid,
    created_at: '2026-06-13T00:00:00.000Z',
    mls_epoch: 1,
    mls_ciphertext: new Uint8Array([1, 2, 3]),
  });

  assert.equal(result, null);
});

test('open-channel readiness waits for the cold-start owner and reuses its persisted ready scope', async () => {
  const manager = new EncryptionManager();
  manager.initialized = true;
  const cid = 'messaging:channel-1';
  const cursor = {
    created_at: '2026-06-13T00:00:10.000Z',
    event_id: '00000000-0000-0000-0000-000000000006',
  };
  let scopeSyncCalls = 0;
  let coldStartWaitCalls = 0;
  let releaseColdStart;
  const coldStart = new Promise((resolve) => {
    releaseColdStart = resolve;
  });

  manager.groups.set(cid, { epoch: () => 12 });
  manager.client = {
    _waitForHydratedColdStartSync: async () => {
      coldStartWaitCalls += 1;
      await coldStart;
    },
    activeChannels: {
      [cid]: {
        id: 'channel-1',
        type: 'messaging',
        data: { mls_enabled: true },
        state: {
          membership: {
            channel_role: 'member',
            created_at: '2026-06-13T00:00:00.000Z',
          },
        },
      },
    },
  };
  manager.storage = {
    loadScopeSyncCursor: async () => cursor,
    loadChannelRepairState: async () => null,
  };
  manager.e2eeClient = {
    scopeSync: async () => {
      scopeSyncCalls += 1;
      return { channels: {}, removed_channels: { events: [], has_more: false } };
    },
  };
  manager._lastSyncStates.set(cid, {
    cid,
    status: 'ready',
    started_cursor: '2026-06-13T00:00:00.000Z',
    processed_cursor: cursor.created_at,
    started_event_cursor: {
      created_at: '2026-06-13T00:00:00.000Z',
      event_id: '00000000-0000-0000-0000-000000000000',
    },
    processed_event_cursor: cursor,
    has_more: false,
    needs_retry: false,
    processed_events: 6,
    buffered_messages: 0,
  });

  const readiness = manager.ensureChannelReady('messaging', 'channel-1', cid, { source: 'open' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scopeSyncCalls, 0);
  releaseColdStart();
  const result = await readiness;

  assert.equal(result.status, 'ready');
  assert.equal(result.epoch, 12);
  assert.equal(coldStartWaitCalls, 1);
  assert.equal(scopeSyncCalls, 0);
});

test('non-terminal initial batch state keeps the bounded per-CID catch-up', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  const cursor = {
    created_at: '2026-06-13T00:00:10.000Z',
    event_id: '00000000-0000-0000-0000-000000000006',
  };
  let scopeSyncCalls = 0;

  manager.initialized = true;
  manager.groups.set(cid, { epoch: () => 4 });
  manager.client = {
    activeChannels: {
      [cid]: {
        cid,
        id: 'channel-1',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member', created_at: '2026-06-13T00:00:00.000Z' } },
      },
    },
    dispatchEvent() {},
  };
  manager.storage = {
    loadScopeSyncCursor: async () => cursor,
    loadPendingE2eeSnapshots: async () => [],
  };
  manager.e2eeClient = {
    scopeSync: async () => {
      scopeSyncCalls += 1;
      return { channels: { [cid]: { events: [], has_more: false } }, removed_channels: { events: [] } };
    },
  };
  manager._lastSyncStates.set(cid, {
    cid,
    status: 'needs_retry',
    started_cursor: cursor.created_at,
    processed_cursor: cursor.created_at,
    started_event_cursor: cursor,
    processed_event_cursor: cursor,
    has_more: false,
    needs_retry: true,
    processed_events: 0,
    buffered_messages: 0,
  });

  const result = await manager.ensureChannelReady('team', 'channel-1', cid, {
    source: 'sync',
    initialScopeSyncCompleted: true,
  });

  assert.equal(result.status, 'ready');
  assert.equal(scopeSyncCalls, 1);
});

test('concurrent cold-start sync callers reuse one scope sync and one recovery discovery', async () => {
  const manager = new EncryptionManager();
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager.client = {
    activeChannels: {
      'team:channel-1': {
        cid: 'team:channel-1',
        id: 'channel-1',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member' } },
      },
      'team:channel-2': {
        cid: 'team:channel-2',
        id: 'channel-2',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member' } },
      },
    },
    dispatchEvent() {},
  };
  manager.storage = {
    loadRemovedSyncCursor: async () => null,
  };
  manager._restoreGroupsLocally = async () => {};
  manager._loadAllScopeSyncCursors = async () => ({});
  manager._saveEncryptionSyncCheckpoint = async () => {};

  let scopeSyncCalls = 0;
  let discoveryCalls = 0;
  manager.e2eeClient = {
    scopeSync: async (cursors) => {
      scopeSyncCalls += 1;
      assert.deepEqual(Object.keys(cursors).sort(), ['team:channel-1', 'team:channel-2']);
      return {
        channels: Object.fromEntries(Object.keys(cursors).map((cid) => [cid, { events: [], has_more: false }])),
        removed_channels: { events: [], has_more: false },
      };
    },
    discoverMlsRecovery: async (cids) => {
      discoveryCalls += 1;
      return {
        protocol_version: 1,
        capability: { protocol_version: 1 },
        states: Object.fromEntries(
          cids.map((cid) => [
            cid,
            {
              result: 'state',
              generation: {
                group_generation: 0,
                group_id: null,
                current_epoch: 0,
                membership_version: 'membership-v1',
                state: 'activated',
                reason: 'repair_window_open',
                retryable: false,
              },
              group_info_refresh: null,
            },
          ]),
        ),
      };
    },
  };
  manager.recoverMlsGeneration = async (_channelType, _channelId, cid) => ({
    cid,
    generation: 0,
    epoch: 0,
    status: 'recovered',
    reason: 'repair_window_open',
    retryable: false,
  });

  let releaseFirstEnsure;
  const firstEnsureBlocked = new Promise((resolve) => {
    releaseFirstEnsure = resolve;
  });
  let ensureCalls = 0;
  manager.ensureChannelReady = async (_channelType, _channelId, cid) => {
    ensureCalls += 1;
    if (ensureCalls === 1) await firstEnsureBlocked;
    return { cid, status: 'needs_retry' };
  };

  const firstSync = manager.sync();
  await new Promise((resolve) => setImmediate(resolve));
  const secondSync = manager.sync();
  releaseFirstEnsure();
  await Promise.all([firstSync, secondSync]);

  assert.equal(scopeSyncCalls, 1);
  assert.equal(discoveryCalls, 1);
  assert.equal(ensureCalls, 2);
});

test('startup uses one scope sync then one recovery discovery for every channel', async () => {
  const manager = new EncryptionManager();
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager.client = {
    activeChannels: {
      'team:channel-1': {
        cid: 'team:channel-1',
        id: 'channel-1',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member' } },
      },
      'team:channel-2': {
        cid: 'team:channel-2',
        id: 'channel-2',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member' } },
      },
    },
    dispatchEvent() {},
  };
  manager.storage = {
    listGroupCids: async () => [],
    loadRemovedSyncCursor: async () => null,
    loadScopeSyncCursors: async () => ({}),
    loadScopeSyncCursor: async () => null,
    saveEncryptionSyncCheckpoint: async () => {},
    loadPendingE2eeSnapshots: async () => [],
    loadChannelRepairState: async () => null,
  };
  manager._restoreGroupsLocally = async () => {};
  manager._loadAllScopeSyncCursors = async () => ({});
  manager._saveEncryptionSyncCheckpoint = async () => {};
  manager._markKnownChannelPendingRecoveryUnlock = async () => {};

  let scopeSyncCalls = 0;
  let discoveryCalls = 0;
  let generationCalls = 0;
  manager.e2eeClient = {
    scopeSync: async (cursors) => {
      scopeSyncCalls += 1;
      assert.deepEqual(Object.keys(cursors).sort(), ['team:channel-1', 'team:channel-2']);
      return {
        channels: Object.fromEntries(Object.keys(cursors).map((cid) => [cid, { events: [], has_more: false }])),
        removed_channels: { events: [], has_more: false },
      };
    },
    discoverMlsRecovery: async (cids) => {
      discoveryCalls += 1;
      const generation = {
        group_generation: 0,
        group_id: null,
        current_epoch: 4,
        membership_version: 'membership-v1',
        state: 'activated',
        reason: 'repair_window_open',
        retryable: false,
      };
      return {
        protocol_version: 1,
        capability: {
          protocol_version: 1,
          automatic_enabled: true,
          repair_timeout_seconds: 900,
          max_group_info_bytes: 1_048_576,
          max_ratchet_tree_bytes: 1_048_576,
          max_welcome_recipients: 200,
          max_welcome_bytes: 6_291_456,
        },
        states: Object.fromEntries(
          cids.map((cid) => [cid, { result: 'state', generation, group_info_refresh: null }]),
        ),
      };
    },
    getMlsGenerationState: async () => {
      generationCalls += 1;
      throw new Error('per-channel generation discovery must not run');
    },
  };
  manager.groups.set('team:channel-1', { epoch: () => 4 });
  manager.groups.set('team:channel-2', { epoch: () => 4 });
  manager.recoverMlsGeneration = async (_channelType, _channelId, cid) => ({
    cid,
    generation: 0,
    epoch: 4,
    status: 'recovered',
    reason: 'repair_window_open',
    retryable: false,
  });

  await manager.sync();

  assert.equal(scopeSyncCalls, 1);
  assert.equal(discoveryCalls, 1);
  assert.equal(generationCalls, 0);
  assert.equal(manager.getSyncState('team:channel-1').status, 'ready');
  assert.equal(manager.getSyncState('team:channel-2').status, 'ready');
});

test('client owns one cold-start sync despite duplicate channel hydration signals', async () => {
  const client = new ErmisChat('api-key', 'project-id', 'http://example.test', {
    browser: false,
    logger: () => {},
  });
  client.activeChannels = { 'team:channel-1': {} };
  client.encryptionManager = { initialized: true, handleChannelsHydrated() {} };
  let restoreCalls = 0;
  let syncCalls = 0;
  client.restoreSyncState = async () => {
    restoreCalls += 1;
  };
  client.performSync = async () => {
    syncCalls += 1;
    await new Promise((resolve) => setImmediate(resolve));
  };

  client._scheduleHydratedColdStartSync();
  client._scheduleHydratedColdStartSync();
  client._scheduleHydratedColdStartSync();
  await client._waitForHydratedColdStartSync();

  assert.equal(restoreCalls, 1);
  assert.equal(syncCalls, 1);
});

test('selected-channel open races by joining the real Client cold-start promise without another scope sync', async () => {
  const client = new ErmisChat('api-key', 'project-id', 'http://example.test', {
    browser: false,
    logger: () => {},
  });
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  const cursor = {
    created_at: '2026-06-13T00:00:10.000Z',
    event_id: '00000000-0000-0000-0000-000000000006',
  };
  let scopeSyncCalls = 0;
  let releaseColdStart;
  const coldStartWork = new Promise((resolve) => {
    releaseColdStart = resolve;
  });

  manager.initialized = true;
  manager.client = client;
  manager.groups.set(cid, { epoch: () => 4 });
  manager.storage = {
    loadScopeSyncCursor: async () => cursor,
    loadPendingE2eeSnapshots: async () => [],
    loadChannelRepairState: async () => null,
  };
  manager.e2eeClient = {
    scopeSync: async () => {
      scopeSyncCalls += 1;
      return { channels: {}, removed_channels: { events: [], has_more: false } };
    },
  };
  manager._lastSyncStates.set(cid, {
    cid,
    status: 'ready',
    started_cursor: cursor.created_at,
    processed_cursor: cursor.created_at,
    started_event_cursor: cursor,
    processed_event_cursor: cursor,
    has_more: false,
    needs_retry: false,
    processed_events: 0,
    buffered_messages: 0,
  });

  client.activeChannels = {
    [cid]: {
      cid,
      id: 'channel-1',
      type: 'team',
      data: { mls_enabled: true },
      state: { membership: { channel_role: 'member', created_at: '2026-06-13T00:00:00.000Z' } },
    },
  };
  client.encryptionManager = manager;
  client.restoreSyncState = async () => {};
  client.performSync = async () => {
    await coldStartWork;
  };

  client._scheduleHydratedColdStartSync();
  const readiness = manager.ensureChannelReady('team', 'channel-1', cid, { source: 'open' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scopeSyncCalls, 0);
  releaseColdStart();
  const result = await readiness;

  assert.equal(result.status, 'ready');
  assert.equal(scopeSyncCalls, 0);
});

test('201 E2EE channels use deterministic recovery discovery chunks of 200 and 1', async () => {
  const manager = new EncryptionManager();
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  const cids = Array.from({ length: 201 }, (_, index) => `team:channel-${String(index).padStart(3, '0')}`);
  manager.client = {
    activeChannels: Object.fromEntries(
      cids.map((cid) => [
        cid,
        {
          cid,
          id: cid.slice('team:'.length),
          type: 'team',
          data: { mls_enabled: true },
          state: { membership: { channel_role: 'member' } },
        },
      ]),
    ),
    dispatchEvent() {},
  };
  manager.storage = { loadRemovedSyncCursor: async () => null };
  manager._restoreGroupsLocally = async () => {};
  manager._loadAllScopeSyncCursors = async () => ({});
  manager._saveEncryptionSyncCheckpoint = async () => {};
  const chunks = [];
  manager.e2eeClient = {
    scopeSync: async (cursors) => ({
      channels: Object.fromEntries(Object.keys(cursors).map((cid) => [cid, { events: [], has_more: false }])),
      removed_channels: { events: [], has_more: false },
    }),
    discoverMlsRecovery: async (chunk) => {
      chunks.push([...chunk]);
      return {
        protocol_version: 1,
        capability: { protocol_version: 1 },
        states: Object.fromEntries(
          chunk.map((cid) => [
            cid,
            {
              result: 'state',
              generation: {
                group_generation: 0,
                group_id: null,
                current_epoch: 0,
                membership_version: 'membership-v1',
                state: 'activated',
                reason: 'repair_window_open',
                retryable: false,
              },
              group_info_refresh: null,
            },
          ]),
        ),
      };
    },
  };
  manager.recoverMlsGeneration = async (_type, _id, cid) => ({
    cid,
    generation: 0,
    epoch: 0,
    status: 'recovered',
    reason: 'repair_window_open',
    retryable: false,
  });
  manager.ensureChannelReady = async (_type, _id, cid) => ({ cid, status: 'needs_retry' });

  await manager.sync();

  assert.deepEqual(chunks.map((chunk) => chunk.length), [200, 1]);
  assert.deepEqual(chunks.flat(), [...cids].sort());
});

test('scope pagination completes before the single recovery discovery request', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager.client = {
    activeChannels: {
      [cid]: {
        cid,
        id: 'channel-1',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member' } },
      },
    },
    dispatchEvent() {},
  };
  manager.storage = {
    loadRemovedSyncCursor: async () => ({ removed_at: '2026-01-01T00:00:00Z', event_id: 'a' }),
    saveRemovedSyncCursor: async () => {},
  };
  manager._restoreGroupsLocally = async () => {};
  manager._loadAllScopeSyncCursors = async () => ({});
  manager._saveEncryptionSyncCheckpoint = async () => {};
  const order = [];
  let scopeCalls = 0;
  manager.e2eeClient = {
    scopeSync: async (cursors) => {
      scopeCalls += 1;
      order.push(`scope-${scopeCalls}`);
      return {
        channels: Object.fromEntries(Object.keys(cursors).map((key) => [key, { events: [], has_more: false }])),
        removed_channels:
          scopeCalls === 1
            ? {
                events: [],
                has_more: true,
                next_cursor: { removed_at: '2026-01-01T00:00:01Z', event_id: 'b' },
              }
            : { events: [], has_more: false },
      };
    },
    discoverMlsRecovery: async () => {
      order.push('discover');
      return { protocol_version: 1, capability: { protocol_version: 1 }, states: {} };
    },
  };
  manager.ensureChannelReady = async () => ({ cid, status: 'needs_retry' });

  await manager.sync();

  assert.deepEqual(order, ['scope-1', 'scope-2', 'discover']);
});

test('unsupported discovery is cached and never falls back to per-channel generation fan-out', async () => {
  const manager = new EncryptionManager();
  const cids = ['team:channel-1', 'team:channel-2'];
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager.client = {
    activeChannels: Object.fromEntries(
      cids.map((cid) => [cid, { cid, id: cid.slice(5), type: 'team', data: { mls_enabled: true } }]),
    ),
    dispatchEvent() {},
  };
  manager.storage = { loadRemovedSyncCursor: async () => null };
  manager._restoreGroupsLocally = async () => {};
  manager._loadAllScopeSyncCursors = async () => ({});
  manager._saveEncryptionSyncCheckpoint = async () => {};
  let discoveryCalls = 0;
  let generationCalls = 0;
  manager.e2eeClient = {
    scopeSync: async (cursors) => ({
      channels: Object.fromEntries(Object.keys(cursors).map((cid) => [cid, { events: [], has_more: false }])),
      removed_channels: { events: [], has_more: false },
    }),
    discoverMlsRecovery: async () => {
      discoveryCalls += 1;
      const error = new Error('unsupported');
      error.response = { status: 404 };
      throw error;
    },
    getMlsGenerationState: async () => {
      generationCalls += 1;
      throw new Error('must not fan out');
    },
  };
  manager.ensureChannelReady = async (_type, _id, cid) => ({ cid, status: 'needs_retry' });

  await manager.sync();
  manager._generationRecoveryAttempted.clear();
  await manager.sync();

  assert.equal(discoveryCalls, 1);
  assert.equal(generationCalls, 0);
});

function missingGroupRecoveryManager(groupInfoResponse) {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  const readiness = new Map();
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager.client = {
    activeChannels: {
      [cid]: {
        cid,
        id: 'channel-1',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member', created_at: '2026-07-21T00:00:00.000Z' } },
      },
    },
    dispatchEvent() {},
  };
  manager.storage = {
    loadScopeSyncCursor: async () => null,
    loadPendingE2eeSnapshots: async () => [],
    saveExternalJoinReadiness: async (state) => readiness.set(state.cid, { ...state }),
    loadExternalJoinReadiness: async (key) => readiness.get(key) || null,
    deleteExternalJoinReadiness: async (key) => readiness.delete(key),
  };
  manager._partialWelcomeJoin = new PartialWelcomeJoinCoordinator(manager.storage);
  manager.e2eeClient = {
    scopeSync: async () => ({
      channels: {
        [cid]: { events: [], has_more: false },
      },
    }),
    getGroupInfo: async () => groupInfoResponse,
  };
  return { manager, cid, readiness };
}

test('exhausted sync uses the exact active-member recovery prerequisite and reuses GroupInfo', async () => {
  const groupInfo = {
    group_info: Uint8Array.from([1, 2, 3]),
    epoch: 1,
    hash: 'hash',
    external_join_prerequisite: { reason: 'active_member_recovery' },
  };
  const { manager, cid, readiness } = missingGroupRecoveryManager(groupInfo);
  let joinedWith;
  manager.joinExternal = async (_channelType, _channelId, _cid, initialGroupInfo) => {
    joinedWith = initialGroupInfo;
    return { epoch: 2, status: 'joined_external' };
  };
  manager.syncAfterExternalJoin = async () => ({ cid, status: 'ready' });

  const result = await manager.syncNewChannel('team', 'channel-1', cid);

  assert.equal(result.status, 'joined_external');
  assert.equal(joinedWith, groupInfo);
  assert.equal(readiness.get(cid).reason, 'active_member_recovery');
});

test('missing or malformed recovery prerequisite remains fail closed after empty sync', async () => {
  for (const prerequisite of [undefined, { reason: 'sync_failed' }]) {
    const { manager, cid, readiness } = missingGroupRecoveryManager({
      group_info: Uint8Array.from([1, 2, 3]),
      epoch: 1,
      hash: 'hash',
      external_join_prerequisite: prerequisite,
    });
    manager.joinExternal = async () => {
      throw new Error('external join must remain blocked');
    };

    const result = await manager.syncNewChannel('team', 'channel-1', cid);

    assert.equal(result.status, 'needs_retry');
    assert.equal(readiness.size, 0);
  }
});

test('recovery status does not invent incomplete restore for ready channel without progress record', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager.groups.set(cid, { epoch: () => 3 });
  manager.client = {
    activeChannels: {
      [cid]: {
        id: 'channel-1',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member' } },
      },
    },
  };
  manager._loadRecoveryPublicMetadata = async () => ({ revision: 1 });
  manager.storage = {
    getDeviceId: async () => 'device-1',
    loadIncompleteRestores: async () => [],
    loadRestoresWithPermanentGaps: async () => [],
    loadRestoreProgress: async () => {
      throw new Error('missing progress must not be treated as incomplete restore');
    },
  };

  const status = await manager.getRecoveryStatus();

  assert.equal(status.hasVault, true);
  assert.equal(status.hasIncompleteRestore, false);
  assert.deepEqual(status.incompleteChannels, []);
});

test('recovery status ignores passive decrypt repair issues for PIN gate', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager._loadRecoveryPublicMetadata = async () => ({ revision: 1 });
  manager.storage = {
    getDeviceId: async () => 'device-1',
    loadIncompleteRestores: async () => [
      manager._upsertRepairIssueInProgress(
        makeProgress({ cid, status: 'failed' }),
        {
          id: 'encrypted-message',
          cid,
          created_at: '2026-06-17T00:00:00.000Z',
          mls_epoch: 4,
        },
        'decrypt_error',
        false,
      ),
    ],
    loadRestoresWithPermanentGaps: async () => [],
  };

  const status = await manager.getRecoveryStatus();

  assert.equal(status.hasVault, true);
  assert.equal(status.hasIncompleteRestore, false);
  assert.deepEqual(status.incompleteChannels, []);
});

test('recovery status treats pending unlock action as PIN-gated restore work', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager._loadRecoveryPublicMetadata = async () => ({ revision: 1 });
  manager.storage = {
    getDeviceId: async () => 'device-1',
    loadIncompleteRestores: async () => [
      makeProgress({ cid, status: 'pending', requires_user_action: 'unlock_recovery_vault' }),
    ],
    loadRestoresWithPermanentGaps: async () => [],
  };

  const status = await manager.getRecoveryStatus();

  assert.equal(status.hasVault, true);
  assert.equal(status.hasIncompleteRestore, true);
  assert.deepEqual(status.incompleteChannels, [cid]);
});

test('recovery status keeps active archive restore progress in PIN gate', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager._loadRecoveryPublicMetadata = async () => ({ revision: 1 });
  manager.storage = {
    getDeviceId: async () => 'device-1',
    loadIncompleteRestores: async () => [makeProgress({ cid, status: 'failed', target_epochs: [4] })],
    loadRestoresWithPermanentGaps: async () => [],
  };

  const status = await manager.getRecoveryStatus();

  assert.equal(status.hasVault, true);
  assert.equal(status.hasIncompleteRestore, true);
  assert.deepEqual(status.incompleteChannels, [cid]);
});

test('bootstrap marks old known E2EE channels as pending recovery unlock when vault is locked', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  const saved = [];
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager.groups.set(cid, { epoch: () => 1 });
  manager._loadRecoveryPublicMetadata = async () => ({ revision: 1 });
  manager.client = {
    state: { users: {} },
    activeChannels: {
      [cid]: {
        cid,
        type: 'team',
        id: 'channel-1',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member', created_at: '2026-06-16T00:00:00.000Z' } },
      },
    },
    dispatchEvent() {},
  };
  manager.storage = {
    loadRestoreProgress: async () => null,
    saveRestoreProgress: async (record) => saved.push(record),
  };

  await manager.bootstrapKnownE2eeChannels({ source: 'channels_queried' });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].cid, cid);
  assert.equal(saved[0].status, 'pending');
  assert.equal(saved[0].requires_user_action, 'unlock_recovery_vault');
});

test('bootstrap does not mark freshly accepted E2EE channels as pending recovery unlock', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:channel-1';
  const saved = [];
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager.groups.set(cid, { epoch: () => 1 });
  manager._loadRecoveryPublicMetadata = async () => ({ revision: 1 });
  manager.client = {
    state: { users: {} },
    activeChannels: {
      [cid]: {
        cid,
        type: 'team',
        id: 'channel-1',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member', created_at: new Date().toISOString() } },
      },
    },
    dispatchEvent() {},
  };
  manager.storage = {
    loadRestoreProgress: async () => null,
    saveRestoreProgress: async (record) => saved.push(record),
  };

  await manager.bootstrapKnownE2eeChannels({ source: 'channels_queried' });

  assert.equal(saved.length, 0);
});

test('inherited E2EE topic resolves encryption group from parent channel', () => {
  const manager = new EncryptionManager();
  const parentCid = 'team:channel-1';
  const topicCid = 'topic:topic-1';
  manager.client = {
    activeChannels: {
      [parentCid]: {
        cid: parentCid,
        data: { mls_enabled: true },
      },
      [topicCid]: {
        cid: topicCid,
        data: { parent_cid: parentCid },
      },
    },
  };

  assert.equal(manager._resolveChannelE2eeGroupId(topicCid, manager.client.activeChannels[topicCid]), parentCid);
});

test('inherited E2EE topic decrypt gate follows parent membership', () => {
  const manager = new EncryptionManager();
  const parentCid = 'team:channel-1';
  const topicCid = 'topic:topic-1';
  manager.userId = 'user-1';
  manager.client = {
    activeChannels: {
      [parentCid]: {
        cid: parentCid,
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member' } },
      },
      [topicCid]: {
        cid: topicCid,
        data: { parent_cid: parentCid, gate: false },
        state: { membership: { channel_role: 'pending' } },
      },
    },
  };

  assert.equal(manager._isEncryptionProcessingBlockedForRoute(topicCid, parentCid), false);

  manager.client.activeChannels[parentCid].state.members = {
    'user-1': { channel_role: 'pending' },
  };

  assert.equal(manager._isEncryptionProcessingBlockedForRoute(topicCid, parentCid), true);
});

test('decrypted inherited topic messages publish into topic state even when topic is only nested under parent', () => {
  const manager = new EncryptionManager();
  const parentCid = 'team:channel-1';
  const topicCid = 'topic:topic-1';
  const dispatched = [];
  const topic = {
    cid: topicCid,
    data: { parent_cid: parentCid },
    state: {
      messageSets: [
        {
          messages: [
            {
              id: 'topic-message-1',
              cid: topicCid,
              content_type: 'mls',
              text: '',
              created_at: '2026-06-17T00:00:00.000Z',
            },
          ],
        },
      ],
      addMessagesSorted(messages) {
        this.addedMessages = messages;
        this.messageSets[0].messages = messages;
      },
    },
  };

  manager.client = {
    state: {
      users: {
        'user-1': { id: 'user-1', name: 'User One' },
      },
    },
    activeChannels: {
      [parentCid]: {
        cid: parentCid,
        data: { mls_enabled: true },
        state: { topics: [topic] },
      },
    },
    dispatchEvent(event) {
      dispatched.push(event);
    },
  };

  manager._publishDecryptedMessages([
    {
      id: 'topic-message-1',
      cid: topicCid,
      content_type: 'standard',
      text: '7',
      user_id: 'user-1',
      created_at: '2026-06-17T00:00:00.000Z',
      type: 'regular',
    },
  ]);

  assert.equal(topic.state.addedMessages[0].text, '7');
  assert.equal(topic.state.messageSets[0].messages[0].content_type, 'standard');
  assert.equal(topic.state.messageSets[0].messages[0].text, '7');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].cid, topicCid);
  assert.equal(dispatched[0].messages[0].text, '7');
});

test('forward secrecy consumed remains blocked and recoverable by an alternate archive', () => {
  const manager = new EncryptionManager();
  const progress = manager._upsertRepairIssueInProgress(
    makeProgress(),
    {
      id: 'consumed-message',
      created_at: '2026-06-13T00:00:00.000Z',
      mls_epoch: 4,
    },
    'forward_secrecy_consumed',
  );

  assert.equal(progress.repair_issues[0].status, 'blocked');
  assert.equal(progress.repair_issues[0].max_retries, 0);
  assert.equal(manager._finalRestoreStatus(progress), 'done_with_gaps');
});

test('clearing one message version does not erase another version of the same message', () => {
  const manager = new EncryptionManager();
  const first = {
    id: 'edited-message',
    created_at: '2026-06-13T00:00:00.000Z',
    mls_epoch: 8,
  };
  const second = {
    ...first,
    updated_at: '2026-06-13T00:01:00.000Z',
  };

  let progress = manager._upsertRepairIssueInProgress(makeProgress(), first, 'decrypt_error');
  progress = manager._upsertRepairIssueInProgress(progress, second, 'decrypt_error');
  progress = manager._clearRepairIssueInProgress(progress, second);

  assert.equal(progress.repair_issues.length, 1);
  assert.equal(progress.repair_issues[0].message_version, manager._messageVersionKey(first));
});

test('manual material failures replace the target issue without adding an epoch duplicate', () => {
  const manager = new EncryptionManager();
  const message = {
    id: 'message-2',
    created_at: '2026-06-13T00:00:00.000Z',
    mls_epoch: 7,
  };
  let progress = manager._upsertRepairIssueInProgress(makeProgress(), message, 'decrypt_error');
  progress = manager._replaceTargetRepairIssueReason(progress, 7, 'no_archive', new Set(['message-2']));

  assert.equal(progress.repair_issues.length, 1);
  assert.equal(progress.repair_issues[0].reason, 'no_archive');
  assert.equal(progress.repair_issues[0].status, 'blocked');
});

test('manual repair marks failed issue no_archive when list epochs has no matching archive', () => {
  const manager = new EncryptionManager();
  const message = {
    id: 'message-no-archive',
    created_at: '2026-06-13T00:00:00.000Z',
    mls_epoch: 11,
  };
  const progress = manager._markManualRepairIssuesMissingArchives(
    manager._upsertRepairIssueInProgress(makeProgress(), message, 'decrypt_error'),
    [],
    { manualRepair: true },
  );

  assert.equal(progress.repair_issues.length, 1);
  assert.equal(progress.repair_issues[0].reason, 'no_archive');
  assert.equal(progress.repair_issues[0].status, 'blocked');
  assert.equal(progress.permanent_gaps[0].epoch, 11);
  assert.equal(progress.permanent_gaps[0].reason, 'no_archive');
});

test('legacy epoch progress is lazily exposed as repair issues', () => {
  const manager = new EncryptionManager();
  const progress = manager._normalizeProgress({
    ...makeProgress(),
    repair_issues: undefined,
    permanent_gaps: [{ epoch: 3, reason: 'expired_restore_window', updated_at: 10 }],
    transient_failures: [
      {
        epoch: 4,
        reason: 'network_error',
        retry_count: 1,
        max_retries: 5,
        updated_at: 11,
      },
    ],
  });

  assert.equal(progress.repair_issues.length, 2);
  assert.equal(progress.repair_issues.find((issue) => issue.mls_epoch === 3).status, 'terminal');
  assert.equal(progress.repair_issues.find((issue) => issue.mls_epoch === 4).status, 'retryable');
});

test('post-unlock recovery maintenance runs in the background and dedupes', async () => {
  const manager = new EncryptionManager();
  const calls = [];
  let releaseRecheck;

  manager._recoveryPrivateKey = new Uint8Array([1]);
  manager._flushDeferredArchives = async () => {
    calls.push('flush');
  };
  manager._resumeEpochArchiveCheckpoints = async () => {
    calls.push('resume');
  };
  manager._recheckKnownRecoveryChannelsOnce = async () => {
    calls.push('recheck');
    await new Promise((resolve) => {
      releaseRecheck = resolve;
    });
  };

  manager._scheduleRecoveryPostUnlockMaintenance();
  const firstWork = manager._recoveryPostUnlockMaintenancePromise;
  manager._scheduleRecoveryPostUnlockMaintenance();

  assert.ok(firstWork);
  assert.equal(manager._recoveryPostUnlockMaintenancePromise, firstWork);
  assert.deepEqual(calls, []);

  for (let attempt = 0; attempt < 10 && calls.length < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.deepEqual(calls, ['flush', 'resume', 'recheck']);
  assert.equal(manager._recoveryPostUnlockMaintenancePromise, firstWork);
  assert.equal(typeof releaseRecheck, 'function');

  releaseRecheck();
  await firstWork;

  assert.equal(manager._recoveryPostUnlockMaintenancePromise, null);
});

test('repair republishes already-cached plaintext over an encrypted placeholder', async () => {
  const manager = new EncryptionManager();
  const cid = 'messaging:channel-1';
  const messageId = 'cached-repaired-message';
  const createdAt = '2026-06-18T00:00:00.000Z';
  const dispatched = [];
  const published = [];
  const storedMessage = {
    id: messageId,
    cid,
    content_type: 'standard',
    type: 'regular',
    text: 'restored plaintext',
    created_at: createdAt,
    user_id: 'user-2',
  };

  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager._recoveryPrivateKey = new Uint8Array([1]);
  manager.client = {
    state: { users: { 'user-2': { id: 'user-2', name: 'User Two' } } },
    activeChannels: {
      [cid]: {
        cid,
        type: 'messaging',
        id: 'channel-1',
        data: { mls_enabled: true },
        state: {
          messageSets: [
            {
              messages: [
                {
                  id: messageId,
                  cid,
                  content_type: 'mls',
                  text: '',
                  e2ee_status: 'failed',
                  created_at: createdAt,
                  mls_epoch: 7,
                },
              ],
            },
          ],
          addMessagesSorted(messages) {
            published.push(...messages);
            this.messageSets[0].messages = messages;
          },
        },
      },
    },
    dispatchEvent(event) {
      dispatched.push(event);
    },
  };

  let progress = manager._upsertRepairIssueInProgress(
    makeProgress({ status: 'failed' }),
    {
      id: messageId,
      cid,
      created_at: createdAt,
      mls_epoch: 7,
      mls_ciphertext: new Uint8Array([1, 2, 3]),
    },
    'decrypt_error',
  );
  manager.storage = {
    loadPendingE2eeSnapshots: async () => [],
    loadRestoreProgress: async () => progress,
    saveRestoreProgress: async (next) => {
      progress = next;
    },
    loadMessage: async (id) => (id === messageId ? storedMessage : null),
  };
  manager.e2eeClient = {
    queryEpochArchives: async (_channelType, _channelId, options) =>
      options.list_epochs
        ? { epochs: [{ epoch: 7, scope: 'account_owned', blob_id: 'blob-1' }] }
        : {
            blobs: [
              {
                archive_blob_id: 'blob-1',
                cid,
                epoch: 7,
                archive_scope: 'account_owned',
                exporter_user_id: 'user-1',
                exporter_device_id: 'device-1',
                member_snapshot_hash: 'snapshot-1',
                encrypted_archive_bytes: new Uint8Array([1]),
                aead_nonce: new Uint8Array([2]),
                aead_aad: new Uint8Array([3]),
                created_at: createdAt,
              },
            ],
            wraps: [
              {
                archive_blob_id: 'blob-1',
                recipient_user_id: 'user-1',
                recipient_recovery_key_id: 'key-1',
                hpke_kem_output: new Uint8Array([1]),
                hpke_ciphertext: new Uint8Array([2]),
                ciphersuite: 1,
                hpke_info: new Uint8Array([3]),
                epoch: 7,
                created_at: createdAt,
              },
            ],
            snapshots: {},
          },
    queryArchiveCiphertexts: async () => ({
      ciphertexts: [
        {
          cid,
          message_id: messageId,
          mls_ciphertext: new Uint8Array([4, 5, 6]),
          mls_epoch: 7,
          created_at: createdAt,
          user_id: 'user-2',
        },
      ],
      has_more: false,
    }),
  };

  const result = await manager.repairRecoveryChannel('messaging', 'channel-1', {
    mode: 'recheck_channel',
    flushPending: false,
  });

  assert.equal(result.alreadyAvailable, 1);
  assert.equal(result.stillFailed.length, 0);
  assert.equal(published.length, 1);
  assert.equal(published[0].content_type, 'standard');
  assert.equal(published[0].text, 'restored plaintext');
  const refreshEvent = dispatched.find((event) => event.type === 'e2ee.local_messages_loaded');
  assert.ok(refreshEvent);
  assert.equal(refreshEvent.cid, cid);
  assert.equal(refreshEvent.messages[0].text, 'restored plaintext');

  manager.client.activeChannels[cid].state.locallyDeletedMessageIds = new Set([messageId]);
  published.length = 0;
  dispatched.length = 0;
  await manager.repairRecoveryChannel('messaging', 'channel-1', {
    mode: 'recheck_channel',
    flushPending: false,
    forceRecheck: true,
  });

  assert.equal(published.length, 0);
  assert.equal(
    dispatched.some((event) => event.type === 'e2ee.local_messages_loaded'),
    false,
  );
});
test('encrypted channel repair requires recovery setup when the private key is unavailable', async () => {
  const manager = new EncryptionManager();
  manager._recoveryPrivateKey = null;
  manager.getRecoveryStatus = async () => {
    throw new Error('repair must not fail open when no recovery vault exists');
  };

  const result = await manager._repairMessagesAfterStateSync('messaging', 'channel-1');

  assert.equal(result.requiresPin, true);
  assert.equal(result.messageRepair, undefined);
});

test('encrypted channel repair dispatches a paired started and completed lifecycle', async () => {
  const manager = new EncryptionManager();
  const events = [];
  manager.client = {
    dispatchEvent: (event) => events.push(event),
  };
  const expected = { checked: 3, newlyRepaired: [], stillFailed: [], alreadyAvailable: 3 };
  manager._replayEncryptedChannelState = async () => expected;
  manager._withScopeRepairLock = async (_scopeCid, repair) => repair();

  const returned = await manager.repairEncryptedChannel('messaging', 'channel-1');

  assert.deepEqual(returned, expected);
  assert.deepEqual(
    events.map((event) => event.type),
    ['e2ee.repair_started', 'e2ee.repair_completed'],
  );
  assert.ok(events[0].repair_id);
  assert.equal(events[1].repair_id, events[0].repair_id);
});

test('encrypted channel repair dispatches failed with the same repair id before rethrowing', async () => {
  const manager = new EncryptionManager();
  const events = [];
  const expectedError = new Error('repair failed safely');
  manager.client = {
    dispatchEvent: (event) => events.push(event),
  };
  manager._withScopeRepairLock = async (_scopeCid, repair) => repair();
  manager._replayEncryptedChannelState = async () => {
    throw expectedError;
  };

  await assert.rejects(manager.repairEncryptedChannel('messaging', 'channel-1'), expectedError);

  assert.deepEqual(
    events.map((event) => event.type),
    ['e2ee.repair_started', 'e2ee.repair_failed'],
  );
  assert.ok(events[0].repair_id);
  assert.equal(events[1].repair_id, events[0].repair_id);
  assert.equal(events[1].error, expectedError.message);
});
