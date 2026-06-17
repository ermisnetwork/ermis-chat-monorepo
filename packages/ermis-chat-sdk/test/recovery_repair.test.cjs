const assert = require('node:assert/strict');
const test = require('node:test');

const { EncryptionManager } = require('../dist/index.cjs');

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

test('open-channel readiness reuses persisted ready scope without scope_sync', async () => {
  const manager = new EncryptionManager();
  manager.initialized = true;
  const cid = 'messaging:channel-1';
  const cursor = {
    created_at: '2026-06-13T00:00:10.000Z',
    event_id: '00000000-0000-0000-0000-000000000006',
  };
  let scopeSyncCalls = 0;

  manager.groups.set(cid, { epoch: () => 12 });
  manager.client = {
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

  const result = await manager.ensureChannelReady('messaging', 'channel-1', cid, { source: 'open' });

  assert.equal(result.status, 'ready');
  assert.equal(result.epoch, 12);
  assert.equal(scopeSyncCalls, 0);
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

  assert.equal(
    manager._resolveChannelE2eeGroupId(topicCid, manager.client.activeChannels[topicCid]),
    parentCid,
  );
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
