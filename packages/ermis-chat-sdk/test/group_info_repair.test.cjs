const assert = require('node:assert/strict');
const test = require('node:test');

const bundle = process.env.GROUPINFO_SDK_BUNDLE || '../dist/encryption/index.cjs';
const { E2eeClient, EncryptionManager, GroupInfoRepairCoordinator } = require(bundle);

function request(overrides = {}) {
  return {
    request_id: '00000000-0000-0000-0000-000000000001',
    minimum_epoch: 7,
    deadline_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    reason: 'external_join_deadline',
    attempt_count: 1,
    ...overrides,
  };
}

class MemoryStorage {
  constructor(seed = []) {
    this.requests = seed.slice();
  }
  async listGroupInfoRefreshRequests() {
    return this.requests.slice();
  }
  async saveGroupInfoRefreshRequest(value) {
    this.requests = this.requests.filter(
      (candidate) => candidate.cid !== value.cid || candidate.request_id !== value.request_id,
    );
    this.requests.push({ ...value });
  }
  async deleteGroupInfoRefreshRequests(cid, throughEpoch, requestId) {
    this.requests = this.requests.filter((value) => {
      if (value.cid !== cid) return true;
      return !(
        (requestId === undefined && throughEpoch === undefined) ||
        (requestId !== undefined && value.request_id === requestId) ||
        (throughEpoch !== undefined && value.minimum_epoch <= throughEpoch)
      );
    });
  }
}

function harness({
  seed = [],
  claimFailures = 0,
  removed = false,
  localGroupMissing = false,
  offline = false,
  groupInfos = [],
} = {}) {
  const storage = new MemoryStorage(seed);
  const active = request();
  const calls = { reconcile: 0, claim: 0, upload: 0, report: 0 };
  const states = [];
  const api = {
    satisfied: false,
    async getGroupInfoRefresh() {
      calls.reconcile += 1;
      if (offline) throw new Error('offline');
      if (removed) throw { response: { status: 403 } };
      return { request: this.satisfied ? null : active };
    },
    async claimGroupInfoRefresh() {
      calls.claim += 1;
      if (offline) throw new Error('offline');
      if (removed) throw { response: { status: 403 } };
      if (calls.claim <= claimFailures) throw { response: { status: 400 } };
      return {
        ...active,
        lease_token: `lease-${calls.claim}`,
        lease_expires_at: new Date(Date.now() + 1000).toISOString(),
      };
    },
    async uploadGroupInfo(_type, _id, body) {
      calls.upload += 1;
      assert.equal(body.request_id, active.request_id);
      assert.match(body.lease_token, /^lease-/);
      this.satisfied = true;
      return { request_id: active.request_id, epoch: 7, hash: 'new', idempotent: false };
    },
    async reportGroupInfoFailure() {
      calls.report += 1;
      throw {
        response: {
          status: 409,
          data: {
            ...active,
            reason: 'group_info_invalid',
          },
        },
      };
    },
    async getGroupInfo() {
      return groupInfos.shift() || { group_info: Uint8Array.from([1]), epoch: 7, hash: 'old', is_stale: false };
    },
  };
  const coordinator = new GroupInfoRepairCoordinator(storage, api, {
    localEpoch: () => 7,
    exportGroupInfo: () => Uint8Array.from([1, 2, 3]),
    isEligible: () => !removed && !localGroupMissing,
    emit: (state) => states.push(state),
  });
  coordinator.sleep = async () => {};
  coordinator.random = () => 0.5;
  return { storage, api, calls, states, coordinator, active };
}

test('100 duplicate refresh events use one claim/upload and clear by durable reconcile', async () => {
  const h = harness();
  const event = { type: 'group_info.refresh_requested', cid: 'team:a', version: 1, ...h.active };
  await Promise.all(Array.from({ length: 100 }, () => h.coordinator.handleRequested(event)));
  assert.equal(h.calls.claim, 1);
  assert.equal(h.calls.upload, 1);
  assert.equal(h.storage.requests.length, 0);
  assert.equal(h.states.at(-1).status, 'ready');
});

test('offline request survives restart and reconciles before claim/upload', async () => {
  const first = harness({ offline: true });
  const event = { type: 'group_info.refresh_requested', cid: 'team:a', version: 1, ...first.active };
  await first.coordinator.handleRequested(event);
  assert.equal(first.storage.requests.length, 1);
  assert.equal(first.calls.upload, 0);

  const restarted = harness({ seed: first.storage.requests });
  await restarted.coordinator.start(['team:a']);
  assert.equal(restarted.calls.upload, 1);
  assert.equal(restarted.storage.requests.length, 0);
});

test('startup with no durable repair obligation does not probe every channel', async () => {
  const h = harness();

  await h.coordinator.start(['team:a', 'team:b', 'team:c']);

  assert.equal(h.calls.reconcile, 0);
  assert.equal(h.calls.claim, 0);
  assert.equal(h.calls.upload, 0);
});

test('expired or contested lease is retried with bounded attempts and a fresh claim', async () => {
  const h = harness({ claimFailures: 1 });
  await h.coordinator.reconcile('team:a');
  assert.equal(h.calls.claim, 2);
  assert.equal(h.calls.upload, 1);
  assert.ok(h.calls.claim <= 3);
});

test('removed member clears local obligations and never exports/uploads', async () => {
  const h = harness({ seed: [{ cid: 'team:a', ...request() }], removed: true });
  await h.coordinator.reconcile('team:a');
  assert.equal(h.calls.upload, 0);
  assert.equal(h.storage.requests.length, 0);
  assert.equal(h.states.at(-1).status, 'removed');
});

test('active member without a local group keeps the request and never claims or uploads', async () => {
  const h = harness({ localGroupMissing: true });
  const event = { type: 'group_info.refresh_requested', cid: 'team:a', version: 1, ...h.active };

  await h.coordinator.handleRequested(event);

  assert.equal(h.calls.claim, 0);
  assert.equal(h.calls.upload, 0);
  assert.equal(h.storage.requests.length, 1);
  assert.deepEqual(h.states.at(-1), {
    cid: 'team:a',
    status: 'retryable',
    request_id: h.active.request_id,
    minimum_epoch: h.active.minimum_epoch,
    deadline_at: h.active.deadline_at,
    reason: 'no_local_group',
  });
});

test('uploaded newer epoch clears matching and older requests', async () => {
  const h = harness({
    seed: [
      { cid: 'team:a', ...request({ request_id: 'old', minimum_epoch: 6 }) },
      { cid: 'team:a', ...request({ request_id: 'current', minimum_epoch: 7 }) },
      { cid: 'team:a', ...request({ request_id: 'future', minimum_epoch: 9 }) },
    ],
  });
  await h.coordinator.handleUploaded({
    type: 'group_info.uploaded',
    cid: 'team:a',
    request_id: 'current',
    epoch: 8,
    hash: 'new',
    version: 1,
  });
  assert.deepEqual(
    h.storage.requests.map((value) => value.request_id),
    ['future'],
  );
});

test('invalid external join reports observed pair and retries only after newer GroupInfo/backoff', async () => {
  const h = harness({
    groupInfos: [
      { group_info: Uint8Array.from([1]), epoch: 7, hash: 'old', is_stale: false },
      { group_info: Uint8Array.from([2]), epoch: 8, hash: 'new', is_stale: false },
    ],
  });
  const repair = await h.coordinator.reportExternalJoinFailure('team:a', {
    reason: 'group_info_invalid',
    observed_epoch: 7,
    observed_hash: 'old',
  });
  assert.equal(h.calls.report, 1);
  assert.equal(repair.request_id, h.active.request_id);
  const refreshed = await h.coordinator.waitForNewerGroupInfo('team:a', 7, 'old');
  assert.equal(refreshed.epoch, 8);
  assert.equal(refreshed.hash, 'new');
});

test('uploaded event wakes a waiting external join before the backoff timer', async () => {
  const h = harness({
    groupInfos: [{ group_info: Uint8Array.from([2]), epoch: 8, hash: 'new', is_stale: false }],
  });
  h.coordinator.sleep = () => new Promise(() => {});
  const waiting = h.coordinator.waitForNewerGroupInfo('team:a', 7, 'old', 1);
  await Promise.resolve();
  await h.coordinator.handleUploaded({
    type: 'group_info.uploaded',
    cid: 'team:a',
    request_id: h.active.request_id,
    epoch: 8,
    hash: 'new',
    version: 1,
  });
  const refreshed = await waiting;
  assert.equal(refreshed.epoch, 8);
  assert.equal(refreshed.hash, 'new');
});

test('accepted external commit is not retried when its post-merge GroupInfo upload fails', async () => {
  let externalJoinCalls = 0;
  let uploadCalls = 0;
  const provider = {
    to_bytes: () => Uint8Array.from([9]),
    free: () => {},
  };
  const joinedGroup = {
    epoch: () => 8,
    clear_pending_commit: () => {},
    merge_pending_commit: () => {},
    export_group_info: () => Uint8Array.from([1, 2, 3]),
  };
  const wasm = {
    Group: {
      join_external: () => ({ group: joinedGroup, commit: Uint8Array.from([4]) }),
    },
    Provider: {
      from_bytes: () => provider,
    },
  };
  const joinStates = new Map();
  const storage = {
    getDeviceId: async () => 'device-a',
    listGroupInfoRefreshRequests: async () => [],
    saveGroupInfoRefreshRequest: async () => {},
    deleteGroupInfoRefreshRequests: async () => {},
    saveGroupState: async () => {},
    loadExternalJoinReadiness: async (cid) => joinStates.get(cid) || null,
    saveExternalJoinReadiness: async (state) => joinStates.set(state.cid, { ...state }),
    deleteExternalJoinReadiness: async (cid) => joinStates.delete(cid),
    saveJoinCheckpoint: async (checkpoint) => {
      if (checkpoint.readiness) joinStates.set(checkpoint.cid, { ...checkpoint.readiness });
      else joinStates.delete(checkpoint.cid);
    },
  };
  const client = {
    baseURL: 'https://bellboy.test',
    deviceId: 'device-a',
    pendingGroupInfoRefreshEvents: [],
    dispatchEvent: () => {},
  };
  const manager = new EncryptionManager();
  manager._restoreOrCreateProvider = async () => {
    manager.provider = provider;
  };
  manager._initIdentity = async () => {
    manager.identity = {};
  };
  manager._loadRecoveryPublicMetadata = async () => null;
  manager._normalizeStaleRestoreProgress = async () => {};
  manager.ensureKeyPackagesFromCachedHealthOrServer = async () => {};
  manager._restoreGroupsLocally = async () => {};
  manager._persistProvider = async () => {};
  manager._resumeEpochArchiveCheckpoints = async () => {};
  manager.resumePendingE2eeSends = async () => {};
  manager.safeArchiveCurrentEpoch = async () => {};
  await manager.initialize(client, 'user-a', { storage, wasmModule: wasm });
  manager.e2eeClient = {
    getGroupInfo: async () => ({
      group_info: Uint8Array.from([1]),
      epoch: 7,
      hash: 'old',
      is_stale: false,
    }),
    externalJoin: async () => {
      externalJoinCalls += 1;
      return { status: 'ok' };
    },
    uploadGroupInfo: async () => {
      uploadCalls += 1;
      throw new Error('offline after accepted commit');
    },
  };

  const result = await manager.joinExternal('team', 'a', 'team:a');
  assert.equal(result.epoch, 8);
  assert.equal(externalJoinCalls, 1);
  assert.equal(uploadCalls, 1);
  assert.equal(manager.groups.get('team:a'), joinedGroup);
});

test('HTTP client sends reconcile, claim, report, and leased upload contract', async () => {
  const calls = [];
  const client = {
    baseURL: 'https://bellboy.test',
    deviceId: 'device-a',
    async doAxiosRequest(method, url, data, options) {
      calls.push({ method, url, data, options });
      if (url.endsWith('/group_info') && method === 'get') {
        return { group_info: 'AQ==', epoch: 7, hash: 'hash-a', is_stale: false };
      }
      return { request: null };
    },
  };
  const api = new E2eeClient(client);
  await api.getGroupInfoRefresh('team', 'a');
  await api.claimGroupInfoRefresh('team', 'a', 'request-a');
  await api.reportGroupInfoFailure('team', 'a', {
    reason: 'group_info_invalid',
    observed_epoch: 7,
    observed_hash: 'hash-a',
  });
  await api.uploadGroupInfo('team', 'a', {
    group_info: Uint8Array.from([1]),
    epoch: 7,
    request_id: 'request-a',
    lease_token: 'lease-a',
  });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url]),
    [
      ['get', 'https://bellboy.test/v1/e2ee/channels/team/a/group_info/refresh'],
      ['post', 'https://bellboy.test/v1/e2ee/channels/team/a/group_info/refresh/claim'],
      ['post', 'https://bellboy.test/v1/e2ee/channels/team/a/group_info/refresh'],
      ['post', 'https://bellboy.test/v1/e2ee/channels/team/a/group_info'],
    ],
  );
  assert.deepEqual(calls[1].data, { request_id: 'request-a' });
  assert.equal(calls[3].data.group_info, 'AQ==');
  assert.equal(calls[3].data.request_id, 'request-a');
  assert.equal(calls[3].data.lease_token, 'lease-a');
  assert.equal(calls[3].options.headers['X-Device-ID'], 'device-a');
});
