const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  E2eeClient,
  EncryptionManager,
  emitMlsRolloutMetricSafely,
  resolveMlsRolloutControls,
} = require('../dist/index.cjs');

test('E2EE client posts only bounded observations through authenticated device transport', async () => {
  const calls = [];
  const client = {
    baseURL: 'https://chat.invalid',
    deviceId: 'private-device-sentinel',
    async doAxiosRequest(...args) {
      calls.push(args);
      return { accepted: 1 };
    },
  };
  const e2ee = new E2eeClient(client);
  const response = await e2ee.reportMlsRolloutTelemetry([
    { name: 'delayed_commit', outcome: 'failure', reason: 'process_error' },
  ]);

  assert.equal(response.accepted, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'post');
  assert.equal(calls[0][1], 'https://chat.invalid/v1/e2ee/rollout/telemetry');
  assert.deepEqual(calls[0][2], {
    platform: 'web',
    observations: [{ name: 'delayed_commit', outcome: 'failure', reason: 'process_error' }],
  });
  assert.equal(calls[0][3].headers['X-Device-ID'], 'private-device-sentinel');
  assert.equal(JSON.stringify(calls[0][2]).includes('private-device-sentinel'), false);
});

test('UHM explicitly enables the authenticated rollout telemetry mapping', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../../../apps/uhm-chat/src/App.tsx'), 'utf8');
  assert.match(app, /VITE_E2EE_MLS_ROLLOUT_TELEMETRY/);
  assert.match(app, /enableMlsRolloutTelemetry:\s*E2EE_MLS_ROLLOUT_TELEMETRY_ENABLED/);
});

test('MLS rollout controls default enabled and disable independently', () => {
  const defaults = resolveMlsRolloutControls();
  assert.equal(defaults.historicalReplay, true);
  assert.equal(defaults.partialWelcomeFallback, true);
  assert.equal(defaults.groupInfoRepair, true);
  assert.equal(defaults.clientTelemetry, false);

  const observations = [];
  const configured = resolveMlsRolloutControls({
    enableHistoricalReplay: false,
    enablePartialWelcomeFallback: true,
    enableGroupInfoRepair: false,
    enableMlsRolloutTelemetry: true,
    onMlsRolloutMetric: (observation) => observations.push(observation),
  });
  assert.equal(configured.historicalReplay, false);
  assert.equal(configured.partialWelcomeFallback, true);
  assert.equal(configured.groupInfoRepair, false);
  assert.equal(configured.clientTelemetry, true);
  configured.emitMetric({
    name: 'delayed_commit',
    outcome: 'disabled',
    reason: 'historical_replay_disabled',
  });
  assert.deepEqual(observations, [
    {
      name: 'delayed_commit',
      outcome: 'disabled',
      reason: 'historical_replay_disabled',
    },
  ]);
});

test('authenticated rollout telemetry transport is single-flight and queue bounded', async () => {
  const manager = new EncryptionManager();
  manager._mlsRolloutTelemetryEnabled = true;
  const calls = [];
  let releaseFirst;
  manager.e2eeClient = {
    reportMlsRolloutTelemetry(batch) {
      calls.push(batch);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ accepted: batch.length });
        });
      }
      return Promise.resolve({ accepted: batch.length });
    },
  };

  const observation = {
    name: 'delayed_commit',
    outcome: 'failure',
    reason: 'process_error',
  };
  manager._emitMlsRolloutMetric(observation);
  for (let index = 0; index < 40; index += 1) manager._emitMlsRolloutMetric(observation);

  assert.deepEqual(calls.map((batch) => batch.length), [1]);
  assert.equal(manager._mlsRolloutTelemetryQueue.length, 32);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.map((batch) => batch.length), [1, 16, 16]);
  assert.equal(manager._mlsRolloutTelemetryQueue.length, 0);
});

test('rollout telemetry transport rejection does not fail MLS callback processing', async () => {
  const manager = new EncryptionManager();
  manager._mlsRolloutTelemetryEnabled = true;
  manager.e2eeClient = {
    reportMlsRolloutTelemetry() {
      return Promise.reject(new Error('SECRET_RAW_TRANSPORT_ERROR'));
    },
  };

  assert.doesNotThrow(() =>
    manager._emitMlsRolloutMetric({
      name: 'delayed_commit',
      outcome: 'failure',
      reason: 'process_error',
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager._mlsRolloutTelemetryInFlight, false);
});

test('rollout callback failure is isolated and emits only a fixed category', () => {
  const sentinel = 'SECRET_RAW_CALLBACK_ERROR';
  const failures = [];
  assert.doesNotThrow(() => {
    emitMlsRolloutMetricSafely(
      () => {
        throw new Error(sentinel);
      },
      {
        name: 'delayed_commit',
        outcome: 'failure',
        reason: 'process_error',
      },
      (category) => failures.push(category),
    );
  });
  assert.deepEqual(failures, ['callback_exception']);
  assert.equal(JSON.stringify(failures).includes(sentinel), false);
});

test('disabled historical replay fails closed before MLS state mutation', async () => {
  const observations = [];
  const manager = new EncryptionManager();
  manager._historicalReplayEnabled = false;
  manager._onMlsRolloutMetric = (observation) => observations.push(observation);

  await assert.rejects(
    manager.processCommit('messaging:private', new Uint8Array([1]), 2, undefined, {
      historicalReplay: true,
    }),
    (error) => error.code === 'historical_replay_disabled',
  );
  assert.deepEqual(observations, [
    {
      name: 'delayed_commit',
      outcome: 'disabled',
      reason: 'historical_replay_disabled',
    },
  ]);
});

test('historical replay requires the durable server timestamp before provider mutation', async () => {
  const manager = new EncryptionManager();
  let providerSnapshotted = false;
  let processCalled = false;
  manager.provider = {
    to_bytes() {
      providerSnapshotted = true;
      return new Uint8Array();
    },
  };
  manager.groups.set('messaging:private', {
    epoch: () => 1n,
    process_message_at() {
      processCalled = true;
    },
  });

  await assert.rejects(
    manager.processCommit('messaging:private', new Uint8Array([1]), 2, undefined, {
      historicalReplay: true,
    }),
    (error) => error.code === 'historical_acceptance_time_invalid',
  );
  assert.equal(providerSnapshotted, false);
  assert.equal(processCalled, false);
});

test('historical replay passes the authoritative timestamp to the contextual WASM API', async () => {
  const manager = new EncryptionManager();
  const calls = [];
  manager.provider = {
    to_bytes: () => new Uint8Array([7]),
  };
  manager._persistProvider = async () => {};
  manager.safeArchiveCurrentEpochForCid = async () => {};
  manager.groups.set('messaging:private', {
    epoch: () => 1n,
    process_message_at(provider, bytes, acceptedAtSeconds) {
      calls.push({ provider, bytes: Array.from(bytes), acceptedAtSeconds });
      return { message_type: 'commit' };
    },
  });

  await manager.processCommit('messaging:private', new Uint8Array([1, 2, 3]), 2, undefined, {
    historicalReplay: true,
    serverAcceptedAt: '2026-09-08T01:02:03.999Z',
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].bytes, [1, 2, 3]);
  assert.equal(calls[0].acceptedAtSeconds, 1788829323n);
});

test('historical replay fails closed when the deployed WASM artifact lacks contextual processing', async () => {
  const manager = new EncryptionManager();
  let liveProcessCalled = false;
  manager.provider = { to_bytes: () => new Uint8Array([7]) };
  manager.groups.set('messaging:private', {
    epoch: () => 1n,
    process_message() {
      liveProcessCalled = true;
    },
  });

  await assert.rejects(
    manager.processCommit('messaging:private', new Uint8Array([1]), 2, undefined, {
      historicalReplay: true,
      serverAcceptedAt: '2026-09-08T01:02:03Z',
    }),
    (error) => error.code === 'historical_replay_unsupported',
  );
  assert.equal(liveProcessCalled, false);
});
