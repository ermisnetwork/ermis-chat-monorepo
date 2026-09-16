const assert = require('node:assert/strict');
const test = require('node:test');

const bundle = process.env.REBOOTSTRAP_SDK_BUNDLE || '../dist/encryption/index.cjs';
const { EncryptionManager, classifyMlsRebootstrapFailure, resolveMlsRebootstrapClaimIntent } = require(bundle);

class MemoryClaimIntentStorage {
  constructor() {
    this.intent = null;
    this.saved = 0;
    this.deleted = 0;
  }
  async loadRebootstrapClaimIntent(cid) {
    return this.intent?.cid === cid ? { ...this.intent } : null;
  }
  async saveRebootstrapClaimIntent(intent) {
    this.intent = { ...intent };
    this.saved += 1;
  }
  async deleteRebootstrapClaimIntent(cid) {
    if (this.intent?.cid === cid) this.intent = null;
    this.deleted += 1;
  }
}

const boundary = {
  user_id: 'alice',
  device_id: 'web-a',
  cid: 'messaging:stable-cid',
  expected_generation: 0,
  expected_epoch: 9,
};

test('ambiguous claim ACK reuses the durable operation key after restart', async () => {
  const storage = new MemoryClaimIntentStorage();
  let allocated = 0;
  const factory = () => `operation-${++allocated}`;
  const first = await resolveMlsRebootstrapClaimIntent(storage, boundary, factory, () => 10);

  // Simulate process loss after the server accepted claim but before its response.
  const restarted = await resolveMlsRebootstrapClaimIntent(storage, boundary, factory, () => 20);
  assert.equal(first.operation_key, 'operation-1');
  assert.equal(restarted.operation_key, first.operation_key);
  assert.equal(allocated, 1);
  assert.equal(storage.saved, 1);
  assert.equal(storage.deleted, 0);
});

test('a changed authoritative generation boundary invalidates the old intent', async () => {
  const storage = new MemoryClaimIntentStorage();
  let allocated = 0;
  const factory = () => `operation-${++allocated}`;
  const first = await resolveMlsRebootstrapClaimIntent(storage, boundary, factory, () => 10);
  const advanced = await resolveMlsRebootstrapClaimIntent(
    storage,
    { ...boundary, expected_generation: 1, expected_epoch: 0 },
    factory,
    () => 20,
  );

  assert.notEqual(advanced.operation_key, first.operation_key);
  assert.equal(advanced.expected_generation, 1);
  assert.equal(storage.deleted, 1);
  assert.equal(storage.saved, 2);
});

test('legacy storage fails closed before claim I/O', async () => {
  await assert.rejects(
    resolveMlsRebootstrapClaimIntent({}, boundary, () => 'unsafe-key'),
    /does not support durable rebootstrap claim intent/,
  );
});

test('new client classifies an old server route as upgrade required', () => {
  const result = classifyMlsRebootstrapFailure(
    { response: { status: 404, data: { message: 'not found' } } },
    boundary.cid,
    0,
    9,
  );
  assert.equal(result.status, 'client_upgrade_required');
  assert.equal(result.reason, 'unsupported_protocol_version');
  assert.equal(result.retryable, false);
});

test('old discovery server keeps generation zero compatible until repair deadline then requires server upgrade', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:legacy-discovery-server';
  let now = Date.parse('2026-09-11T08:00:00.000Z');
  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager._generationRecoveryNow = () => now;
  let scheduledDelay;
  manager._generationRecoverySetTimeout = (_callback, delayMs) => {
    scheduledDelay = delayMs;
    return 1;
  };
  manager._generationRecoveryClearTimeout = () => {};
  manager._mlsRecoveryDiscoverySupported = false;
  manager.client = { dispatchEvent() {} };
  manager.storage = { loadRebootstrapCandidateCheckpoint: async () => null };
  manager.e2eeClient = {};
  manager._emitGroupInfoRepairState({
    cid,
    status: 'retryable',
    reason: 'no_local_group',
    deadline_at: '2026-09-11T08:15:00.000Z',
  });
  assert.equal(scheduledDelay, 15 * 60 * 1000);

  const beforeDeadline = await manager.recoverMlsGeneration('team', 'legacy-discovery-server', cid);
  assert.equal(beforeDeadline.status, 'recovered');
  assert.equal(beforeDeadline.reason, 'unsupported_protocol_version');

  now = Date.parse('2026-09-11T08:15:00.000Z');
  const atDeadline = await manager.recoverMlsGeneration('team', 'legacy-discovery-server', cid);
  assert.equal(atDeadline.status, 'client_upgrade_required');
  assert.equal(atDeadline.reason, 'unsupported_protocol_version');
  assert.equal(atDeadline.retryable, false);
});

test('typed server claim failure preserves allowlisted reason and retryability', () => {
  const result = classifyMlsRebootstrapFailure(
    {
      response: {
        status: 409,
        data: { state: 'eligible', reason: 'lease_unavailable', retryable: true },
      },
    },
    boundary.cid,
    0,
    9,
  );
  assert.equal(result.status, 'waiting_for_repair');
  assert.equal(result.reason, 'lease_unavailable');
  assert.equal(result.retryable, true);
});

test('unknown server errors fail closed as retryable infrastructure', () => {
  const result = classifyMlsRebootstrapFailure(new Error('opaque'), boundary.cid, 0, 9);
  assert.equal(result.status, 'retryable_infrastructure_failure');
  assert.equal(result.reason, 'infrastructure_unavailable');
  assert.equal(result.retryable, true);
});

test('expired durable candidate is discarded before authoritative recovery retries', async () => {
  const manager = new EncryptionManager();
  const cid = boundary.cid;
  const deleted = [];
  manager.initialized = true;
  manager.userId = boundary.user_id;
  manager.deviceId = boundary.device_id;
  manager._generationRecoveryNow = () => Date.parse('2026-09-11T08:00:00.000Z');
  manager.storage = {
    loadRebootstrapCandidateCheckpoint: async () => ({
      claim: {
        operation_id: 'operation-expired',
        expected_generation: boundary.expected_generation,
        expected_epoch: boundary.expected_epoch,
      },
      completion: {},
    }),
    deleteRebootstrapCandidateCheckpoint: async (key) => deleted.push(`candidate:${key}`),
    deleteRebootstrapClaimIntent: async (key) => deleted.push(`intent:${key}`),
  };
  manager.e2eeClient = {
    getMlsRebootstrapReceipt: async () => {
      throw {
        response: {
          status: 409,
          data: { state: 'preparation_failed_retryable', reason: 'operation_conflict', retryable: false },
        },
      };
    },
    completeMlsRebootstrap: async () => {
      throw {
        response: {
          status: 409,
          data: { state: 'preparation_failed_retryable', reason: 'lease_expired', retryable: true },
        },
      };
    },
  };

  const result = await manager.recoverMlsGeneration('messaging', 'stable-cid', cid);

  assert.equal(result.reason, 'lease_expired');
  assert.equal(result.retry_at, '2026-09-11T08:00:05.000Z');
  assert.deepEqual(deleted, [`candidate:${cid}`, `intent:${cid}`]);
});

test('generation recovery deadline retries use one-CID discovery without legacy GET loops', async () => {
  const manager = new EncryptionManager();
  const cid = 'team:missing-generation';
  const recoveryEvents = [];
  let now = Date.parse('2026-09-11T07:45:30.000Z');
  let scheduledTimer;
  const discoveryCalls = [];
  let ensureCalls = 0;

  manager.initialized = true;
  manager.userId = 'user-1';
  manager.deviceId = 'device-1';
  manager._generationRecoveryNow = () => now;
  manager._generationRecoverySetTimeout = (callback, delayMs) => {
    scheduledTimer = { callback, delayMs };
    return 1;
  };
  manager._generationRecoveryClearTimeout = () => {};
  manager.client = {
    activeChannels: {
      [cid]: {
        cid,
        id: 'missing-generation',
        type: 'team',
        data: { mls_enabled: true },
        state: { membership: { channel_role: 'member' } },
      },
    },
    dispatchEvent(event) {
      if (event.type === 'e2ee.mls_generation_recovery_state') recoveryEvents.push(event);
    },
  };
  manager.storage = {
    loadRebootstrapCandidateCheckpoint: async () => null,
  };
  manager.e2eeClient = {
    discoverMlsRecovery: async (cids) => {
      discoveryCalls.push([...cids]);
      const common = {
        group_generation: 0,
        group_id: null,
        current_epoch: 1,
        membership_version: 'membership-v1',
        retryable: discoveryCalls.length === 1,
      };
      const capability = {
          protocol_version: 1,
          automatic_enabled: true,
          repair_timeout_seconds: 900,
          max_group_info_bytes: 1_048_576,
          max_ratchet_tree_bytes: 1_048_576,
          max_welcome_recipients: 200,
          max_welcome_bytes: 6_291_456,
      };
      const generation =
        discoveryCalls.length === 1
          ? {
              ...common,
              state: 'repairing',
              reason: 'group_info_invalid',
              first_unresolved_at: '2026-09-11T07:30:00.000Z',
              incident_deadline_at: '2026-09-11T07:45:00.000Z',
            }
          : {
              ...common,
              state: 'upgrade_required',
              reason: 'client_upgrade_required',
            };
      return {
        protocol_version: 1,
        capability,
        states: {
          [cid]: { result: 'state', generation, group_info_refresh: null },
        },
      };
    },
    getMlsGenerationState: async () => {
      throw new Error('deadline retry must not use per-CID generation GET');
    },
  };
  manager.ensureChannelReady = async () => {
    ensureCalls += 1;
    return { cid, status: 'needs_retry' };
  };

  await manager.bootstrapKnownE2eeChannels({ source: 'channels_queried' });
  await manager.bootstrapKnownE2eeChannels({ source: 'channels_queried' });

  assert.deepEqual(discoveryCalls, [[cid]]);
  assert.equal(ensureCalls, 0);
  assert.equal(recoveryEvents[0].status, 'waiting_for_repair');
  assert.equal(scheduledTimer.delayMs, 250);

  now += 1_000;
  scheduledTimer.callback();
  for (let attempt = 0; attempt < 4 && discoveryCalls.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(discoveryCalls, [[cid], [cid]]);
  assert.equal(ensureCalls, 0);
  assert.equal(recoveryEvents[1].status, 'client_upgrade_required');
});
