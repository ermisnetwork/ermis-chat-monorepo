const assert = require('node:assert/strict');
const test = require('node:test');

const { EncryptionManager } = require('../dist/index.cjs');

function makeManagerHarness({ recoveredEpoch, rejoinedEpoch = recoveredEpoch }) {
  const manager = new EncryptionManager();
  const cid = 'messaging:channel-1';
  let epoch = 1;
  let replayCalls = 0;
  let rejoinCalls = 0;

  manager.getEpoch = () => epoch;
  manager.ensureChannelReady = async () => ({ cid, status: 'ready', epoch });
  manager._getActiveChannel = () => ({
    data: { mls_enabled: true, mls_enabled_at: '2026-07-27T00:00:00.000Z' },
    state: { members: {} },
  });
  manager._syncChannelFromCursor = async () => {
    replayCalls += 1;
    epoch = recoveredEpoch;
    return {
      cid,
      status: 'ready',
      started_cursor: '2026-07-27T00:00:00.000Z',
      processed_cursor: '2026-07-27T00:00:01.000Z',
      has_more: false,
      needs_retry: false,
      processed_events: 1,
      buffered_messages: 0,
    };
  };
  manager._rejoinEpochStaleGroup = async () => {
    rejoinCalls += 1;
    epoch = rejoinedEpoch;
    return epoch;
  };

  return { manager, cid, replayCalls: () => replayCalls, rejoinCalls: () => rejoinCalls };
}

test('epoch_stale recovery replays the scope until the local group reaches the server epoch', async () => {
  const harness = makeManagerHarness({ recoveredEpoch: 2 });

  const epoch = await harness.manager._recoverEpochStaleGroup(
    'messaging',
    'channel-1',
    harness.cid,
    new Error('epoch_stale: message encrypted with epoch 1, current group epoch is 2'),
  );

  assert.equal(epoch, 2);
  assert.equal(harness.replayCalls(), 1);
  assert.equal(harness.rejoinCalls(), 0);
});

test('epoch_stale recovery rejoins the latest group when protocol replay stays behind', async () => {
  const harness = makeManagerHarness({ recoveredEpoch: 1, rejoinedEpoch: 3 });

  const epoch = await harness.manager._recoverEpochStaleGroup(
    'messaging',
    'channel-1',
    harness.cid,
    new Error('epoch_stale: message encrypted with epoch 1, current group epoch is 2'),
  );

  assert.equal(epoch, 3);
  assert.equal(harness.replayCalls(), 1);
  assert.equal(harness.rejoinCalls(), 1);
});

test('epoch_stale recovery refuses to re-encrypt when replay and rejoin remain behind', async () => {
  const harness = makeManagerHarness({ recoveredEpoch: 1, rejoinedEpoch: 1 });

  await assert.rejects(
    harness.manager._recoverEpochStaleGroup(
      'messaging',
      'channel-1',
      harness.cid,
      new Error('epoch_stale: message encrypted with epoch 1, current group epoch is 2'),
    ),
    /Could not recover stale group.*local epoch 1, server epoch 2/,
  );
  assert.equal(harness.replayCalls(), 1);
  assert.equal(harness.rejoinCalls(), 1);
});
