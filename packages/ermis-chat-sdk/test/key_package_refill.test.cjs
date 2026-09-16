const assert = require('node:assert/strict');
const test = require('node:test');

const bundle = process.env.KP_REFILL_SDK_BUNDLE || '../dist/encryption/index.cjs';
const { EncryptionManager } = require(bundle);

function refillEvent(generation, usableCount = 0) {
  return {
    type: usableCount === 0 ? 'key_packages.empty' : 'key_packages.low',
    idempotency_key: `kp-refill-v1:test-${generation}`,
    device_id: 'device-a',
    usable_count: usableCount,
    target: 100,
    requested_delta: 100 - usableCount,
    reason: 'consume',
    generation,
    version: 1,
  };
}

function managerHarness({
  initialRemaining,
  loseFirstResponse = false,
  failFirstUpload = false,
  drainSuccessfulUploads = false,
}) {
  const manager = new EncryptionManager();
  let serverRemaining = initialRemaining;
  let countCalls = 0;
  let uploadCalls = 0;
  const generatedDeltas = [];
  const persisted = [];
  const retryDelays = [];

  manager.deviceId = 'device-a';
  manager.userId = 'user-a';
  manager.provider = {
    to_bytes() {
      return Uint8Array.from([1, 2, 3]);
    },
  };
  manager.identity = {
    key_packages(_provider, count) {
      generatedDeltas.push(count);
      return Array.from({ length: count }, (_, index) => ({
        to_bytes() {
          return Uint8Array.from([index % 251]);
        },
      }));
    },
  };
  manager.storage = {
    async saveProviderState(_userId, _deviceId, bytes) {
      persisted.push(Array.from(bytes));
    },
  };
  manager.e2eeClient = {
    async getKeyPackageCount() {
      countCalls += 1;
      return {
        remaining: serverRemaining,
        target: 100,
        low_watermark: 50,
        requested_delta: 100 - serverRemaining,
        refill_generation: serverRemaining >= 100 ? null : 1,
      };
    },
    async uploadKeyPackages({ key_packages }) {
      uploadCalls += 1;
      if (loseFirstResponse && uploadCalls === 1) {
        serverRemaining += key_packages.length;
        throw new Error('response lost after accept');
      }
      if (failFirstUpload && uploadCalls === 1) {
        throw new Error('transient rejection before accept');
      }
      if (!drainSuccessfulUploads) serverRemaining += key_packages.length;
      return {
        stored: key_packages.length,
        total_remaining: serverRemaining,
        target: 100,
        low_watermark: 50,
        requested_delta: Math.max(0, 100 - serverRemaining),
        refill_generation: serverRemaining >= 100 ? null : 1,
      };
    },
  };
  manager._keyPackageRefillSleep = async (milliseconds) => {
    retryDelays.push(milliseconds);
  };
  manager._keyPackageRefillRandom = () => 0.5;

  return {
    manager,
    state() {
      return { serverRemaining, countCalls, uploadCalls, generatedDeltas, persisted, retryDelays };
    },
  };
}

test('100 duplicate empty events coalesce and lost acknowledgement does not upload twice', async () => {
  const harness = managerHarness({ initialRemaining: 0, loseFirstResponse: true });
  const event = refillEvent(1);
  await Promise.all(Array.from({ length: 100 }, () => harness.manager.handleKeyPackageRefill(event)));

  const state = harness.state();
  assert.equal(state.serverRemaining, 100);
  assert.equal(state.uploadCalls, 1);
  assert.deepEqual(state.generatedDeltas, [100]);
  assert.equal(state.persisted.length, 1, 'private KeyPackage material must persist before upload');
  assert.equal(state.countCalls, 2, 'retry must recheck authoritative server count');
  assert.equal(state.retryDelays.length, 1);

  await harness.manager.handleKeyPackageRefill(event);
  assert.equal(harness.state().countCalls, 2, 'completed generation must be idempotent');
});

test('transient rejection retries with jitter and uploads the exact current delta', async () => {
  const harness = managerHarness({ initialRemaining: 40, failFirstUpload: true });
  await harness.manager.ensureKeyPackages(40, 100, 50, 3, true);

  const state = harness.state();
  assert.equal(state.serverRemaining, 100);
  assert.equal(state.uploadCalls, 2);
  assert.deepEqual(state.generatedDeltas, [60, 60]);
  assert.equal(state.persisted.length, 2);
  assert.equal(state.countCalls, 1);
  assert.equal(state.retryDelays.length, 1);
});

test('health count above the low watermark does not start a top-up', async () => {
  const harness = managerHarness({ initialRemaining: 51 });
  await harness.manager.ensureKeyPackages(51, 100, 50);
  const state = harness.state();
  assert.equal(state.countCalls, 0);
  assert.equal(state.uploadCalls, 0);
  assert.deepEqual(state.generatedDeltas, []);
});

test('continuous concurrent consumption cannot make refill loop without a bound', async () => {
  const harness = managerHarness({ initialRemaining: 0, drainSuccessfulUploads: true });
  await harness.manager.ensureKeyPackages(0, 100, 50, 4, true);

  const state = harness.state();
  assert.equal(state.serverRemaining, 0);
  assert.equal(state.uploadCalls, 5);
  assert.equal(state.countCalls, 4);
  assert.deepEqual(state.generatedDeltas, [100, 100, 100, 100, 100]);
  assert.equal(state.persisted.length, 5);
  assert.equal(state.retryDelays.length, 4);
});
