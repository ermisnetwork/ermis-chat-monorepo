const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  ACTIVE_MEMBER_RECOVERY,
  EncryptionManager,
  NO_MATCHING_KEY_PACKAGE,
  PartialWelcomeJoinCoordinator,
  WelcomeJoinFailure,
  isNoMatchingKeyPackageFailure,
  selectedWelcomeLeaves,
} = require('../dist/encryption/index.cjs');

function memoryStorage(seed = new Map()) {
  return {
    states: seed,
    groups: new Map(),
    providers: new Map(),
    async loadExternalJoinReadiness(cid) {
      return this.states.get(cid) || null;
    },
    async saveExternalJoinReadiness(state) {
      this.states.set(state.cid, { ...state });
    },
    async deleteExternalJoinReadiness(cid) {
      this.states.delete(cid);
    },
    async saveJoinCheckpoint(checkpoint) {
      this.providers.set(`${checkpoint.user_id}:${checkpoint.device_id}`, Uint8Array.from(checkpoint.provider_bytes));
      this.groups.set(checkpoint.cid, true);
      if (checkpoint.readiness) this.states.set(checkpoint.cid, { ...checkpoint.readiness });
      else this.states.delete(checkpoint.cid);
    },
  };
}

async function loadActualWasm() {
  const jsPath = path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm.js');
  const wasm = await import(pathToFileURL(jsPath));
  const bytes = fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'));
  await wasm.default({ module_or_path: bytes });
  return wasm;
}

function managerStorage() {
  const storage = memoryStorage();
  return Object.assign(storage, {
    async getDeviceId() {
      return 'device-dave';
    },
    async loadProviderState() {
      return null;
    },
    async saveProviderState(userId, deviceId, bytes) {
      this.providers.set(`${userId}:${deviceId}`, Uint8Array.from(bytes));
    },
    async loadIdentity() {
      return null;
    },
    async saveIdentity() {},
    async listGroupCids() {
      return [];
    },
    async loadAllSyncTimestamps() {
      return {};
    },
    async loadPendingEvictions() {
      return {};
    },
    async loadIncompleteRestores() {
      return [];
    },
    async loadEpochArchiveCheckpoints() {
      return [];
    },
    async listPendingE2eeSends() {
      return [];
    },
  });
}

test('promoted artifact and EncryptionManager expose only typed Welcome fallback', async () => {
  const wasm = await loadActualWasm();
  assert.equal(typeof wasm.Group.join_with_welcome_typed, 'function');
  assert.equal(wasm.MlsErrorCode.NoMatchingKeyPackage, 11);

  const aliceProvider = new wasm.Provider();
  const bobProvider = new wasm.Provider();
  const alice = new wasm.Identity(aliceProvider, 'alice');
  const bob = new wasm.Identity(bobProvider, 'bob');
  const aliceGroup = wasm.Group.create_with_cid(aliceProvider, alice, 'team:artifact-typed-welcome');
  const bundle = aliceGroup.add_members(aliceProvider, alice, [bob.key_package(bobProvider)]);
  aliceGroup.merge_pending_commit(aliceProvider);
  const welcome = bundle.welcome;
  assert.ok(welcome instanceof Uint8Array);

  const storage = managerStorage();
  const client = {
    activeChannels: {},
    deviceId: 'device-dave',
    latestKeyPackagesRemaining: 100,
    dispatchEvent() {},
  };
  const manager = new EncryptionManager();
  await manager.initialize(client, 'dave', { storage, wasmModule: wasm });

  await assert.rejects(
    () => manager.joinGroup(welcome, aliceGroup.export_ratchet_tree().to_bytes()),
    (error) => error && error.code === NO_MATCHING_KEY_PACKAGE,
  );
  await assert.rejects(
    () => manager.joinGroup(Uint8Array.from([1, 2])),
    (error) => error && error.code !== NO_MATCHING_KEY_PACKAGE,
  );

  const order = [];
  const originalCheckpoint = storage.saveJoinCheckpoint.bind(storage);
  storage.saveJoinCheckpoint = async (checkpoint) => {
    order.push('checkpoint');
    await originalCheckpoint(checkpoint);
  };
  manager.e2eeClient = {
    async getGroupInfo() {
      return {
        group_info: aliceGroup.export_group_info(aliceProvider, alice, true),
        epoch: Number(aliceGroup.epoch()),
        is_stale: false,
      };
    },
    async externalJoin() {
      order.push('server');
      return { status: 'ok' };
    },
    async uploadGroupInfo() {
      order.push('upload');
      throw new Error('simulated GroupInfo outage');
    },
  };
  const external = await manager.joinExternal('team', 'artifact-typed-welcome', 'team:artifact-typed-welcome');
  assert.equal(external.status, 'joined_external');
  assert.deepEqual(order, ['server', 'checkpoint', 'upload']);
  const restarted = new PartialWelcomeJoinCoordinator(memoryStorage(storage.states));
  const restartedState = await restarted.getState('team:artifact-typed-welcome');
  assert.equal(restartedState.status, 'joined_external');
  assert.equal(restartedState.first_decryptable_epoch, external.epoch);
});

test('one usable device creates one real Welcome leaf without fabricating missing devices', () => {
  const response = {
    members: [
      {
        user_id: 'user-b',
        key_packages: [{ device_id: 'device-1', key_package: Uint8Array.from([1, 2, 3]) }],
      },
    ],
    outcomes: [
      {
        user_id: 'user-b',
        outcome: 'selected',
        truncated: false,
        devices: [
          { device_id: 'device-1', outcome: 'selected', requested: 1, selected: 1 },
          { device_id: 'device-2', outcome: 'empty', requested: 1, selected: 0 },
          { device_id: 'device-3', outcome: 'only_near_expiry', requested: 1, selected: 0 },
        ],
      },
    ],
  };

  const leaves = selectedWelcomeLeaves(response);
  assert.deepEqual(leaves, [{ userId: 'user-b', deviceId: 'device-1', keyPackage: Uint8Array.from([1, 2, 3]) }]);
});

test('only the typed NoMatchingKeyPackage outcome enables fallback', async () => {
  const storage = memoryStorage();
  const coordinator = new PartialWelcomeJoinCoordinator(storage);
  const cursor = { created_at: '2026-09-03T00:00:00.000000000Z', event_id: 'welcome-1' };

  assert.equal(isNoMatchingKeyPackageFailure(new Error('No matching key package was found')), false);
  assert.equal(await coordinator.recordWelcomeFailure('team:typed', new Error('generic failure'), 7, cursor), false);
  assert.equal(await coordinator.getState('team:typed'), null);

  const typed = new WelcomeJoinFailure();
  assert.equal(typed.code, NO_MATCHING_KEY_PACKAGE);
  assert.equal(await coordinator.recordWelcomeFailure('team:typed', typed, 7, cursor), true);
  assert.deepEqual(await coordinator.getState('team:typed'), {
    cid: 'team:typed',
    status: 'pending_external_join',
    reason: 'NoMatchingKeyPackage',
    welcome_epoch: 7,
    welcome_event_cursor: cursor,
    updated_at: storage.states.get('team:typed').updated_at,
  });
});

test('only the exact active-member server prerequisite enables the separate recovery lane', async () => {
  const storage = memoryStorage();
  const coordinator = new PartialWelcomeJoinCoordinator(storage);

  assert.equal(await coordinator.recordActiveMemberRecovery('team:recovery', undefined), false);
  assert.equal(await coordinator.recordActiveMemberRecovery('team:recovery', { reason: 'sync_failed' }), false);
  assert.equal(await coordinator.getState('team:recovery'), null);

  assert.equal(
    await coordinator.recordActiveMemberRecovery('team:recovery', { reason: ACTIVE_MEMBER_RECOVERY }),
    true,
  );
  assert.deepEqual(await coordinator.getState('team:recovery'), {
    cid: 'team:recovery',
    status: 'pending_external_join',
    reason: ACTIVE_MEMBER_RECOVERY,
    updated_at: storage.states.get('team:recovery').updated_at,
  });
});

test('pending fallback survives restart and successful Welcome clears it', async () => {
  const persisted = new Map();
  const first = new PartialWelcomeJoinCoordinator(memoryStorage(persisted));
  await first.recordWelcomeFailure('team:restart', new WelcomeJoinFailure(), 4);

  const restarted = new PartialWelcomeJoinCoordinator(memoryStorage(persisted));
  assert.equal((await restarted.getState('team:restart')).status, 'pending_external_join');
  await restarted.clearAfterWelcome('team:restart');
  assert.equal(await restarted.getState('team:restart'), null);
});

test('duplicate stale Welcome remains one device-local pending fallback', async () => {
  const storage = memoryStorage();
  const coordinator = new PartialWelcomeJoinCoordinator(storage);
  const lostPrivateKey = new WelcomeJoinFailure('local KeyPackage private material is unavailable');

  assert.equal(await coordinator.recordWelcomeFailure('team:duplicate', lostPrivateKey, 8), true);
  assert.equal(await coordinator.recordWelcomeFailure('team:duplicate', lostPrivateKey, 8), true);
  assert.equal(storage.states.size, 1);
  assert.deepEqual(await coordinator.getState('team:duplicate'), storage.states.get('team:duplicate'));
  assert.equal((await coordinator.getState('team:duplicate')).status, 'pending_external_join');
});

test('one hundred same-channel external joins share one mutation', async () => {
  const coordinator = new PartialWelcomeJoinCoordinator(memoryStorage());
  await coordinator.recordWelcomeFailure('team:race', new WelcomeJoinFailure(), 11);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const joins = Array.from({ length: 100 }, () =>
    coordinator.runExternalJoin('team:race', async () => {
      calls += 1;
      await gate;
      await coordinator.persistExternalJoin('team:race', 12, 'user-b', 'device-2', Uint8Array.from([12]));
      return { epoch: 12, status: 'joined_external' };
    }),
  );
  await Promise.resolve();
  release();
  const results = await Promise.all(joins);

  assert.equal(calls, 1);
  assert.equal(
    results.every((result) => result.epoch === 12),
    true,
  );
  assert.equal((await coordinator.getState('team:race')).status, 'joined_external');
  assert.equal(await coordinator.isPreJoinHistorical('team:race', 11), true);
  assert.equal(await coordinator.isPreJoinHistorical('team:race', 12), false);
});

test('failed external join releases the channel lock for reconnect retry', async () => {
  const coordinator = new PartialWelcomeJoinCoordinator(memoryStorage());
  await coordinator.recordWelcomeFailure('team:retry', new WelcomeJoinFailure(), 2);
  let calls = 0;

  await assert.rejects(
    coordinator.runExternalJoin('team:retry', async () => {
      calls += 1;
      throw new Error('temporary network failure');
    }),
    /temporary network failure/,
  );
  const result = await coordinator.runExternalJoin('team:retry', async () => {
    calls += 1;
    await coordinator.persistExternalJoin('team:retry', 3, 'user-b', 'device-3', Uint8Array.from([3]));
    return { epoch: 3 };
  });

  assert.equal(calls, 2);
  assert.equal(result.epoch, 3);
  assert.equal((await coordinator.getState('team:retry')).first_decryptable_epoch, 3);
});

test('JOIN checkpoint failure never publishes a ready state', async () => {
  const storage = memoryStorage();
  await new PartialWelcomeJoinCoordinator(storage).recordWelcomeFailure(
    'team:checkpoint-failure',
    new WelcomeJoinFailure(),
    9,
  );
  storage.saveJoinCheckpoint = async () => {
    throw new Error('simulated transaction abort');
  };
  const restarted = new PartialWelcomeJoinCoordinator(storage);

  await assert.rejects(
    () => restarted.persistExternalJoin('team:checkpoint-failure', 10, 'user-b', 'device-3', Uint8Array.from([10])),
    /transaction abort/,
  );
  assert.equal((await restarted.getState('team:checkpoint-failure')).status, 'pending_external_join');
  assert.equal(storage.groups.has('team:checkpoint-failure'), false);
});
