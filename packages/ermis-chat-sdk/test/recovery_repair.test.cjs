const assert = require('node:assert/strict');
const test = require('node:test');

const { MlsManager } = require('../dist/index.cjs');

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
  const manager = new MlsManager();
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
  const manager = new MlsManager();
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
  const manager = new MlsManager();
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
  const manager = new MlsManager();
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

test('pending invite defers realtime MLS messages before local group processing', async () => {
  const manager = new MlsManager();
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
  const manager = new MlsManager();
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

test('forward secrecy consumed remains blocked and recoverable by an alternate archive', () => {
  const manager = new MlsManager();
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
  const manager = new MlsManager();
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
  const manager = new MlsManager();
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
  const manager = new MlsManager();
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
  const manager = new MlsManager();
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
