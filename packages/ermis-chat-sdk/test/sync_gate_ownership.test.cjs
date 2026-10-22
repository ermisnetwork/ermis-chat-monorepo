const test = require('node:test');
const assert = require('node:assert/strict');
const { EncryptionManager } = require('../dist/encryption/index.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
function owner() {
  const m = new EncryptionManager();
  Object.assign(m, { userId: 'qa-owner', deviceId: 'old-device', identity: {}, storage: {}, client: { baseURL: 'https://example.test' }, e2eeClient: {} });
  return m;
}
test('replacement semantic sync gate releases retired waiters while preserving the new gate', async () => {
  const m = owner();
  m.markSyncStart();
  const old = m.waitForSync();
  let retiredSettled = false;
  old.then(() => { retiredSettled = true; });
  m.deviceId = 'replacement-device';
  m.markSyncStart();
  const current = m.waitForSync();
  const finishCurrent = m._syncGateResolve;
  assert.notEqual(current, old);
  await turn();
  assert.equal(retiredSettled, true, 'retired decrypt waiters must resume and recheck their captured scope');
  assert.equal(m.isSyncing(), true);
  assert.equal(m.waitForSync(), current);
  assert.equal(m._syncGateResolve, finishCurrent);
  m._finishSyncGate();
  await current;
});
test('same owner coalesces gate and failed work releases waiters without reporting sync success', async () => {
  const m = owner();
  m.markSyncStart();
  const gate = m.waitForSync();
  m.markSyncStart();
  assert.equal(m.waitForSync(), gate);
  const error = new Error('canonical sync failure');
  m._syncAndRestoreGroups = async () => { throw error; };
  await assert.rejects(m.sync(), failure => failure === error);
  await gate;
  assert.equal(m.isSyncing(), false);
  assert.equal(m._syncWorkPromise, null);
});
test('late retired sync completion cannot clear a replacement owner gate', async () => {
  const m = owner();
  let release;
  m._syncAndRestoreGroups = () => new Promise(resolve => { release = resolve; });
  const oldWork = m.sync();
  const oldGate = m.waitForSync();
  const rejected = assert.rejects(oldWork, e => e.code === 'recovery_scope_changed');
  m.storage = {};
  m.markSyncStart();
  const current = m.waitForSync();
  release();
  await rejected;
  await oldGate;
  assert.equal(m.isSyncing(), true);
  assert.equal(m.waitForSync(), current);
  m._finishSyncGate();
  await current;
});
