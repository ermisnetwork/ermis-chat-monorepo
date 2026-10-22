import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const { EncryptionManager, IndexedDBEncryptionStorage, sha256Hex, discoveryWorkKey, discoveryDueKey } = createRequire(
  import.meta.url,
)('../dist/index.cjs');
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const binary = fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url));
await init({ module_or_path: binary });
let seq = 0;
const latch = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(kind = 'ack', overrides = {}) {
  const user = 'owned-ack-discovery-' + ++seq,
    device = 'device',
    cid = 'team:' + user,
    s = new IndexedDBEncryptionStorage(user),
    m = new EncryptionManager(),
    events = [];
  Object.assign(m, {
    userId: user,
    deviceId: device,
    storage: s,
    _injectedWasm: wasm,
    _wasmArtifactSha256: sha256Hex(binary),
  });
  await m._initWasm();
  await m._initIdentity();
  const group = wasm.Group.create_with_cid(m.provider, m.identity, cid),
    marker = { cid, group_generation: 0, group_id: null, current_epoch: 0, status: 'active', updated_at: 1 };
  m.groups.set(cid, group);
  m._groupGenerations.set(cid, marker);
  await m._writeMlsMutation(cid, null);
  m.client = {
    activeChannels: {
      [cid]: {
        data: { mls_enabled: true },
        state: { members: { [user]: { user_id: user, created_at: '2026-10-11T00:00:00Z' } } },
      },
    },
    dispatchEvent: (e) => events.push(e),
  };
  m.initialized = true;
  m._armValidationAckRetry = () => {};
  m._validationAckAdmissionWork = Promise.resolve();
  const kp = m.identity.key_package(m.provider),
    ref = kp.hash_ref(m.provider);
  kp.free();
  await m._saveEncryptionSyncCheckpoint();
  const infoBytes = group.export_group_info(m.provider, m.identity, true),
    info = { group_info: infoBytes, epoch: 0, group_generation: 0, hash: sha256Hex(infoBytes), is_stale: false };
  let posts = 0,
    gets = 0;
  m.e2eeClient = {
    getGroupInfo: async () => {
      gets++;
      return info;
    },
    acknowledgeGroupInfoValidation: async () => {
      posts++;
      return { accepted: true, idempotent: false, recovery_action: 'none', recovery_revision: '2' };
    },
    discoverMlsRecovery: async () => ({ protocol_version: 1, capability: { protocol_version: 1 }, states: {} }),
    ...overrides,
  };
  if (kind === 'ack') {
    await s.saveRecoveryControlCheckpoint({
      version: 1,
      user_id: user,
      device_id: device,
      cid,
      signing_identity_sha256: sha256Hex(m.identity.signature_public_key()),
      group_generation: 0,
      incident_id: '00000000-0000-4000-8000-000000000001',
      recovery_action: 'repair',
      recovery_revision: '1',
      repair_retry_until: new Date(Date.now() + 600000).toISOString(),
    });
    await m._loadRecoveryControl(cid);requireValidationMetadata(m,cid);
  }
  const c = m._getRecoveryDiscoveryCoordinator();
  c.arm = () => {};
  await m.refreshE2eeState(cid);
  assert.equal(m.getE2eeState(cid).state, 'ready');
  events.length = 0;
  const seen = [];
  m.subscribeE2eeState(cid, (v) => seen.push(v));
  return {
    m,
    s,
    user,
    device,
    cid,
    group,
    marker,
    c,
    info,
    ref,
    seen,
    events,
    bytes: m._activeProvider.to_bytes(),
    base: await s.loadProviderCheckpoint(user, device),
    get posts() {
      return posts;
    },
    get gets() {
      return gets;
    },
  };
}
const primary = (h) => h.s.loadGroupInfoValidationAdmission(h.cid, h.device);
async function reserve(h, owner) {
  owner ||= await h.m._captureValidationAdmissionWork(h.cid);
  const job = {
    ...owner.expected.admission,
    job_id: crypto.randomUUID(),
    attempts: 0,
    retry_at: Date.now(),
    recovery_revision: owner.expected.control.recovery_revision,
    incident_id: owner.expected.control.incident_id,
    ...(owner.expected.control.recovery_action === 'manual_intervention_required' ? { trigger: 'manual' } : {}),
  };
  const selected = await owner.save({ kind: 'reserve', job, now: Date.now() + 2 });
  assert.ok(selected);
  return { owner, job: selected };
}
async function manual(h) {
  const control = {
    ...h.m._recoveryControls.get(h.cid),
    recovery_action: 'manual_intervention_required',
    recovery_revision: '2',
  };
  await h.s.saveRecoveryControlCheckpoint(control);
  await h.m._loadRecoveryControl(h.cid);requireValidationMetadata(h.m,h.cid);
  return control;
}
async function privateWin(h) {
  const before = await h.s.loadProviderCheckpoint(h.user, h.device),
    p = wasm.Provider.from_bytes(before.provider_bytes),
    i = wasm.Identity.from_bytes(p, h.m.identity.to_bytes()),
    kp = i.key_package(p),
    ref = kp.hash_ref(p);
  kp.free();
  const bytes = p.to_bytes();
  i.free();
  p.free();
  const revision = crypto.randomUUID();
  await h.s.saveProviderState(h.user, h.device, bytes, { expected_revision: before.revision, next_revision: revision });
  return { bytes, revision, ref };
}
function fenced(h) {
  const state =
    h.m._recoveryControls.get(h.cid)?.recovery_action === 'manual_intervention_required'
      ? 'manual_intervention_required'
      : 'repairing';
  assert.equal(h.m.getE2eeState(h.cid).state, state);
  assert.equal(h.seen.at(-1).state, state);
  const late = [];
  h.m.subscribeE2eeState(h.cid, (x) => late.push(x));
  assert.equal(late[0].state, state);
}
async function preserved(h, win = h.base) {
  assert.equal(sha256Hex(h.m._activeProvider.to_bytes()), sha256Hex(h.bytes));
  const actual = await h.s.loadProviderCheckpoint(h.user, h.device);
  assert.equal(actual.revision, win.revision);
  assert.equal(sha256Hex(actual.provider_bytes), sha256Hex(win.bytes || win.provider_bytes));
}
async function restored(h) {
  const m = new EncryptionManager();
  Object.assign(m, {
    userId: h.user,
    deviceId: h.device,
    storage: new IndexedDBEncryptionStorage(h.user),
    _injectedWasm: wasm,
    _wasmArtifactSha256: sha256Hex(binary),
  });
  await m._initWasm();
  await m._initIdentity();
  await m._restoreGroupsLocally();
  await m._saveEncryptionSyncCheckpoint();
  m.initialized = true;
  m.client = h.m.client;
  m.e2eeClient = {};
  m._armValidationAckRetry = () => {};
  return m;
}
for (const kind of ['reserve', 'finish', 'defer', 'pause'])
  for (const fault of ['abort', 'unknown', 'readback', 'index-mismatch'])
    test(
      kind + ' admission ' + fault + ' retains exact budget/private state and fails scheduling before publication',
      async () => {
        const h = await fixture();
        if (kind === 'pause') await manual(h);
        let owner = await h.m._captureValidationAdmissionWork(h.cid),
          job = owner.expected.admission;
        if (kind === 'finish') {
          ({ owner, job } = await reserve(h, owner));
          await h.m._prepareGroupInfoValidationAck('team', h.cid.slice(5), h.cid, undefined, owner);
        }
        const change =
          kind === 'reserve'
            ? { kind, job, now: Date.now() + 2 }
            : kind === 'finish'
            ? { kind, job_id: job.job_id, attempt: job.attempts, prepared: true }
            : { kind: 'defer', now: Date.now() + 5, pause: kind === 'pause' };
        const db = await h.s.openDB(),
          orig = db.transaction.bind(db),
          save = h.s.saveValidationAdmissionWork.bind(h.s);
        let committed = false;
        if (fault === 'unknown')
          h.s.saveValidationAdmissionWork = async (...a) => {
            const v = await save(...a);
            throw Error('committed public return lost');
          };
        else
          db.transaction = (...a) => {
            const tx = orig(...a);
            if (a[1] === 'readwrite') {
              if (fault === 'abort') queueMicrotask(() => tx.abort());
              else
                tx.addEventListener('complete', () => {
                  committed = true;
                  if (fault === 'index-mismatch') {
                    const t = orig('meta', 'readwrite'),
                      key =
                        kind === 'pause'
                          ? `gi_validation_admission_paused:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(
                              h.cid,
                            )}`
                          : `gi_validation_admission:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`,
                      q = t.objectStore('meta').get(key);
                    q.onsuccess = () =>
                      t
                        .objectStore('meta')
                        .put(
                          kind === 'pause'
                            ? { job_id: 'wrong', reason: 'manual_intervention_required' }
                            : { ...q.result, retry_at: q.result.retry_at + 1 },
                          key,
                        );
                  }
                });
            }
            if (committed && fault === 'readback' && a[1] === 'readonly') queueMicrotask(() => tx.abort());
            return tx;
          };
        await assert.rejects(owner.save(change));
        db.transaction = orig;
        assert.equal(h.posts, 0);
        assert.equal(h.m._providerPersistenceUncertain, false);
        await preserved(h);
        const actual = await primary(h);
        if (fault === 'abort') assert.deepEqual(actual, job);
        else {
          assert.equal(actual.job_id, job.job_id);
          assert.equal(actual.attempts, job.attempts + (kind === 'reserve' ? 1 : 0));
        }
        const n = await restored(h);
        assert.deepEqual(await n.storage.loadGroupInfoValidationAdmission(h.cid, h.device), actual);
        assert.equal(n.identity.owns_key_package_ref(n._activeProvider, h.ref), true);
        h.c.stop();
      },
    );
for (const kind of ['reserve', 'finish', 'defer', 'pause'])
  test(kind + ' stale private writer fences current/late Ready without overwriting actual WASM winner', async () => {
    const h = await fixture();
    if (kind === 'pause') await manual(h);
    let { owner, job } = await reserve(h);
    if (kind === 'finish') await h.m._prepareGroupInfoValidationAck('team', h.cid.slice(5), h.cid, undefined, owner);
    const before = await primary(h),
      win = await privateWin(h);
    const change =
      kind === 'reserve'
        ? { kind, job, now: job.retry_at + 1 }
        : kind === 'finish'
        ? { kind, job_id: job.job_id, attempt: job.attempts, prepared: true }
        : { kind: 'defer', now: Date.now() + 5, pause: kind === 'pause' };
    await assert.rejects(owner.save(change));
    fenced(h);
    assert.equal(h.m._providerPersistenceUncertain, true);
    assert.deepEqual(await primary(h), before);
    await preserved(h, win);
    const n = await restored(h);
    assert.equal(n.identity.owns_key_package_ref(n._activeProvider, win.ref), true);
    h.c.stop();
  });
for (const cap of ['validationAdmissionWorkCheckpointVersion', 'saveValidationAdmissionWork'])
  test('missing ' + cap + ' stops repair Ready and manual/automatic GET before mutation', async () => {
    const h = await fixture(),
      before = await h.s.loadMlsReadyBase(h.user, h.device, h.cid);
    h.s[cap] = undefined;
    const state = await h.m.refreshE2eeState(h.cid);
    assert.equal(state.state, 'upgrade_required');
    assert.equal(state.reason, 'client_upgrade_required');
    assert.deepEqual(await h.s.loadMlsReadyBase(h.user, h.device, h.cid), before);
    await assert.rejects(h.m._captureValidationAdmissionWork(h.cid), (e) => e.code === 'client_upgrade_required');
    assert.equal(h.gets, 0);
    assert.equal(h.posts, 0);
    await preserved(h);
    h.c.stop();
  });
test('manual and automatic successful production admission observe full proof before GET and finish only verified ACK field', async () => {
  for (const trigger of ['automatic', 'manual']) {
    const h = await fixture();
    if (trigger === 'manual') await manual(h);
    h.m._validationAckAdmissionWork = null;
    h.m._drainGroupInfoValidationAcks = async () => {};
    let gets = 0;
    h.m.e2eeClient.getGroupInfo = async () => {
      gets++;
      const state = await h.s.loadMlsReadyBase(h.user, h.device, h.cid);
      assert.equal(state.admission.attempts, 1);
      assert.deepEqual(state.admission_pending, state.admission);
      assert.equal(state.admission_paused, null);
      return h.info;
    };
    if (trigger === 'manual') await h.m.validateManualGroupInfoAck('team', h.cid.slice(5), h.cid);
    else {
      h.m._validationAckAdmissions.set(h.cid, 'intent');
      await h.m._drainValidationAckAdmissions();
    }
    const state = await h.s.loadMlsReadyBase(h.user, h.device, h.cid);
    assert.equal(gets, 1);
    assert.equal(state.admission.outcome, 'prepared');
    assert.equal(state.admission_pending, null);
    assert.equal(state.admission_paused, null);
    assert.ok(state.ack);
    assert.equal(h.posts, 0);
    h.c.stop();
  }
});
for (const trigger of ['automatic', 'manual'])
  test(trigger + ' GET delayed behind peer private writer cannot finish/defer into unowned base', async () => {
    const h = await fixture();
    if (trigger === 'manual') await manual(h);
    h.m._validationAckAdmissionWork = null;
    const entered = latch(),
      gate = latch();
    h.m.e2eeClient.getGroupInfo = async () => {
      entered.resolve();
      await gate.promise;
      return h.info;
    };
    h.m._validationAckAdmissions.set(h.cid, 'intent');
    const work =
        trigger === 'manual'
          ? h.m.validateManualGroupInfoAck('team', h.cid.slice(5), h.cid)
          : h.m._drainValidationAckAdmissions(),
      rejected = assert.rejects(work);
    await entered.promise;
    const before = await primary(h),
      win = await privateWin(h);
    gate.resolve();
    await rejected;
    fenced(h);
    assert.deepEqual(await primary(h), before);
    assert.equal(h.posts, 0);
    await preserved(h, win);
    h.c.stop();
  });
for (const replacement of [
  'user',
  'device',
  'storage',
  'signer',
  'artifact',
  'transport',
  'provider',
  'group',
  'marker',
])
  test('manual delayed GET ' + replacement + ' cannot finish old admission or clear replacement work', async () => {
    const h = await fixture();
    await manual(h);
    const entered = latch(),
      gate = latch();
    h.m.e2eeClient.getGroupInfo = async () => {
      entered.resolve();
      await gate.promise;
      return h.info;
    };
    const work = h.m.validateManualGroupInfoAck('team', h.cid.slice(5), h.cid),
      rejected = assert.rejects(work, (e) => e.code === 'recovery_scope_changed');
    await entered.promise;
    const before = await primary(h),
      replacementWork = Promise.resolve();
    if (replacement === 'user') h.m.userId = 'other';
    if (replacement === 'device') h.m.deviceId = 'other';
    if (replacement === 'storage') h.m.storage = new IndexedDBEncryptionStorage(h.user);
    if (replacement === 'signer') h.m.identity = wasm.Identity.from_bytes(h.m.provider, h.m.identity.to_bytes());
    if (replacement === 'artifact') h.m._wasmArtifactSha256 = '0'.repeat(64);
    if (replacement === 'transport') h.m.e2eeClient = {};
    if (replacement === 'provider') h.m._activeProvider = wasm.Provider.from_bytes(h.bytes);
    if (replacement === 'group') h.m.groups.set(h.cid, wasm.Group.load(h.m.provider, h.cid));
    if (replacement === 'marker') h.m._groupGenerations.set(h.cid, { ...h.marker, updated_at: 99 });
    h.m._manualValidationAckWork.set(h.cid, { scope: [], work: replacementWork });
    gate.resolve();
    await rejected;
    assert.equal(h.m._manualValidationAckWork.get(h.cid).work, replacementWork);
    assert.deepEqual(await primary(h), before);
    assert.equal(h.posts, 0);
    h.c.stop();
  });
test('completion accepts only its verified ACK field, rejecting unrelated cursor/admission/provider/revision advance', async () => {
  for (const field of ['revision', 'provider_bytes', 'admission', 'cleanup']) {
    const h = await fixture(),
      owner = await h.m._captureValidationAdmissionWork(h.cid),
      state = structuredClone(owner.expected);
    if (field === 'revision') state.revision = crypto.randomUUID();
    if (field === 'provider_bytes') state.provider_bytes = new Uint8Array([1]);
    if (field === 'admission') state.admission.attempts = 3;
    if (field === 'cleanup') state.cleanup.metadata['scope_sync:' + h.cid] = { cursor: 'other' };
    assert.throws(
      () => owner.acceptAck(state),
      (e) => e.code === 'recovery_checkpoint_conflict',
    );
    await preserved(h);
    h.c.stop();
  }
});
test('paused intent restart never reopens from old/same authority; newer Ready reindexes after full proof', async () => {
  const h = await fixture();
  await reserve(h);
  await manual(h);
  h.m._validationAckAdmissionWork = null;
  h.m._queueGroupInfoValidationAck(h.cid);
  h.m._validationAckAdmissions.set(h.cid, 'retained-manual-intent');
  await h.m._drainValidationAckAdmissions();
  const old = await primary(h),
    base = await h.s.loadMlsReadyBase(h.user, h.device, h.cid);
  assert.equal(base.admission_pending, null);
  assert.equal(base.admission_paused.job_id, old.job_id);
  const n = await restored(h);
  await n._loadRecoveryControl(h.cid);requireValidationMetadata(n,h.cid);
  await n._drainValidationAckAdmissions();
  assert.equal((await n.refreshE2eeState(h.cid)).state, 'manual_intervention_required');
  assert.deepEqual(await n.storage.loadGroupInfoValidationAdmission(h.cid, h.device), old);
  await n.storage.saveRecoveryControlCheckpoint({
    ...n._recoveryControls.get(h.cid),
    recovery_revision: '3',
    recovery_action: 'repair',
  });
  await n._loadRecoveryControl(h.cid);requireValidationMetadata(n,h.cid);
  assert.equal((await n.refreshE2eeState(h.cid)).state, 'ready');
  const next = await n.storage.loadMlsReadyBase(h.user, h.device, h.cid);
  assert.equal(next.admission.recovery_revision, '3');
  assert.equal(next.admission.attempts, 0);
  assert.deepEqual(next.admission_pending, next.admission);
  assert.equal(next.admission_paused, null);
  h.c.stop();
});
for (const trigger of ['automatic', 'manual'])
  test(
    trigger + ' unknown ACK checkpoint keeps exact pending admission; failure cleanup never uses a fresh read-set',
    async () => {
      const h = await fixture();
      if (trigger === 'manual') await manual(h);
      h.m._validationAckAdmissionWork = null;
      h.m._validationAckAdmissions.set(h.cid, 'intent');
      let finished = 0;
      const write = h.s.saveValidationAdmissionWork.bind(h.s),
        saveAck = h.s.saveValidationAckWork.bind(h.s);
      h.s.saveValidationAdmissionWork = async (...a) => {
        if (a[4].kind === 'finish') finished++;
        return write(...a);
      };
      h.s.saveValidationAckWork = async (...a) => {
        await saveAck(...a);
        throw Error('ACK journal return lost');
      };
      h.m._drainGroupInfoValidationAcks = async () => {};
      if (trigger === 'manual') await assert.rejects(h.m.validateManualGroupInfoAck('team', h.cid.slice(5), h.cid));
      else await h.m._drainValidationAckAdmissions();
      const job = await primary(h),
        state = await h.s.loadMlsReadyBase(h.user, h.device, h.cid);
      assert.equal(job.attempts, 1);
      assert.equal(job.outcome, 'pending');
      assert.deepEqual(state.admission_pending, job);
      assert.ok(state.ack);
      assert.equal(finished, 0);
      assert.equal(h.posts, 0);
      assert.equal(h.m._providerPersistenceUncertain, false);
      await preserved(h);
      const n = await restored(h);
      assert.deepEqual(await n.storage.loadGroupInfoValidationAdmission(h.cid, h.device), job);
      h.c.stop();
    },
  );
for (const change of ['marker', 'control', 'mutation', 'removal', 'rebootstrap'])
  test(
    'committed admission readback learns ' + change + ' scope winner, closes Ready and preserves its obligation',
    async () => {
      const h = await fixture(),
        owner = await h.m._captureValidationAdmissionWork(h.cid),
        db = await h.s.openDB(),
        orig = db.transaction.bind(db);
      let injected = false;
      db.transaction = (...a) => {
        const tx = orig(...a);
        if (a[1] === 'readwrite' && !injected)
          tx.addEventListener('complete', () => {
            injected = true;
            const t = orig(['meta', 'groups'], 'readwrite');
            if (change === 'marker') t.objectStore('groups').put({ ...h.marker, status: 'historical' }, h.cid);
            else if (change === 'control') {
              const key = `recovery_control:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`,
                q = t.objectStore('meta').get(key);
              q.onsuccess = () => t.objectStore('meta').put({ ...q.result, recovery_revision: '2' }, key);
            } else
              t.objectStore('meta').put(
                { operation_id: 'winning-obligation' },
                `${
                  change === 'mutation'
                    ? 'mls_mutation'
                    : change === 'removal'
                    ? 'mls_removal'
                    : 'mls_rebootstrap_candidate'
                }:v1:${h.cid}`,
              );
          });
        return tx;
      };
      await assert.rejects(
        owner.save({ kind: 'reserve', job: owner.expected.admission, now: Date.now() + 2 }),
        (e) => e.recovery_owner_conflict === 'scope',
      );
      db.transaction = orig;
      assert.ok(injected);
      fenced(h);
      assert.equal(h.m._providerPersistenceUncertain, false);
      await preserved(h);
      const next = await primary(h);
      assert.equal(next.attempts, 1);
      assert.equal(next.outcome, 'pending');
      h.c.stop();
    },
  );
test('owned local private write and new Ready during delayed GET survive old failure/finally without demotion', async () => {
  const h = await fixture();
  h.m._validationAckAdmissionWork = null;
  h.m._validationAckAdmissions.set(h.cid, 'intent');
  const entered = latch(),
    gate = latch();
  h.m.e2eeClient.getGroupInfo = async () => {
    entered.resolve();
    await gate.promise;
    return h.info;
  };
  const work = h.m._drainValidationAckAdmissions(),
    rejected = assert.rejects(work, (e) => e.code === 'recovery_scope_changed');
  await entered.promise;
  const kp = h.m.identity.key_package(h.m.provider),
    ref = kp.hash_ref(h.m.provider);
  kp.free();
  await h.m._saveEncryptionSyncCheckpoint();
  assert.equal((await h.m.refreshE2eeState(h.cid)).state, 'ready');
  const win = await h.s.loadProviderCheckpoint(h.user, h.device),
    job = await primary(h),
    replacementWork = Promise.resolve();
  h.m._validationAckAdmissionWork = replacementWork;
  h.m._validationAckAdmissions.set(h.cid, 'new-owner-work');
  gate.resolve();
  await rejected;
  assert.equal(h.m._validationAckAdmissionWork, replacementWork);
  assert.equal(h.m._validationAckAdmissions.get(h.cid), 'new-owner-work');
  assert.equal(h.m.getE2eeState(h.cid).state, 'ready');
  assert.equal(h.m._providerPersistenceUncertain, false);
  assert.equal(h.m.identity.owns_key_package_ref(h.m._activeProvider, ref), true);
  assert.deepEqual(await h.s.loadProviderCheckpoint(h.user, h.device), win);
  assert.deepEqual(await primary(h), job);
  h.c.stop();
});
test('authoritative reopen full Ready proof rejects a restored obsolete due key in the same readonly snapshot', async () => {
  const h = await fixture();
  await manual(h);
  const owner = await h.m._captureValidationAdmissionWork(h.cid);
  await owner.save({ kind: 'defer', now: Date.now(), pause: true });
  const old = await primary(h);
  await h.s.saveRecoveryControlCheckpoint({
    ...h.m._recoveryControls.get(h.cid),
    recovery_revision: '3',
    recovery_action: 'repair',
  });
  await h.m._loadRecoveryControl(h.cid);requireValidationMetadata(h.m,h.cid);
  const save = h.s.saveMlsReadyCheckpoint.bind(h.s);
  h.s.saveMlsReadyCheckpoint = async (...a) => {
    await save(...a);
    const db = await h.s.openDB();
    await new Promise((r, j) => {
      const t = db.transaction('meta', 'readwrite');
      t.objectStore('meta').put(
        old,
        `gi_validation_admission_pending:v1:${encodeURIComponent(h.device)}:${String(old.retry_at).padStart(
          16,
          '0',
        )}:${encodeURIComponent(h.cid)}`,
      );
      t.oncomplete = r;
      t.onabort = j;
    });
  };
  const state = await h.m.refreshE2eeState(h.cid);
  assert.equal(state.state, 'repairing');
  assert.equal(state.reason, 'provider_persistence_uncertain');
  assert.equal(h.m._providerPersistenceUncertain, true);
  assert.equal(sha256Hex(h.m._activeProvider.to_bytes()), sha256Hex(h.bytes));
  assert.equal((await primary(h)).recovery_revision, '3');
  h.c.stop();
});
test('newer control alone cannot unpause via reserve/defer; a full owned Ready checkpoint is required', async () => {
  const h = await fixture();
  await manual(h);
  let owner = await h.m._captureValidationAdmissionWork(h.cid);
  await owner.save({ kind: 'defer', now: Date.now(), pause: true });
  const before = await h.s.loadMlsReadyBase(h.user, h.device, h.cid);
  await h.s.saveRecoveryControlCheckpoint({
    ...h.m._recoveryControls.get(h.cid),
    recovery_revision: '3',
    recovery_action: 'repair',
  });
  await h.m._loadRecoveryControl(h.cid);requireValidationMetadata(h.m,h.cid);
  owner = await h.m._captureValidationAdmissionWork(h.cid);
  assert.equal(
    await owner.save({
      kind: 'reserve',
      job: { ...before.admission, recovery_revision: '3', job_id: crypto.randomUUID() },
      now: Date.now() + 30001,
    }),
    null,
  );
  await assert.rejects(
    owner.save({ kind: 'defer', now: Date.now(), pause: false }),
    (e) => e.code === 'validation_ack_retry_deferred',
  );
  const after = await h.s.loadMlsReadyBase(h.user, h.device, h.cid);
  assert.deepEqual(after.admission, before.admission);
  assert.deepEqual(after.admission_paused, before.admission_paused);
  assert.equal(after.admission_pending, null);
  h.c.stop();
});
test('committed admission full readback racing real private bytes/revision fences Ready and preserves new key package', async () => {
  const h = await fixture(),
    owner = await h.m._captureValidationAdmissionWork(h.cid),
    p = wasm.Provider.from_bytes(h.bytes),
    i = wasm.Identity.from_bytes(p, h.m.identity.to_bytes()),
    kp = i.key_package(p),
    ref = kp.hash_ref(p);
  kp.free();
  const bytes = p.to_bytes(),
    revision = crypto.randomUUID();
  i.free();
  p.free();
  const db = await h.s.openDB(),
    orig = db.transaction.bind(db);
  let injected = false;
  db.transaction = (...a) => {
    const t = orig(...a);
    if (a[1] === 'readwrite' && !injected)
      t.addEventListener('complete', () => {
        injected = true;
        const win = orig('meta', 'readwrite');
        win.objectStore('meta').put(bytes, `provider:${h.user}:${h.device}`);
        win.objectStore('meta').put(revision, `provider_revision:${h.user}:${h.device}`);
      });
    return t;
  };
  await assert.rejects(
    owner.save({ kind: 'reserve', job: owner.expected.admission, now: Date.now() + 2 }),
    (e) => e.recovery_owner_conflict === 'provider',
  );
  db.transaction = orig;
  assert.ok(injected);
  fenced(h);
  assert.equal(h.m._providerPersistenceUncertain, true);
  assert.equal((await primary(h)).attempts, 1);
  await preserved(h, { bytes, revision });
  const n = await restored(h);
  assert.equal(n.identity.owns_key_package_ref(n._activeProvider, ref), true);
  h.c.stop();
});
test('public admission primary/due replacement is proven no-op and preserves independent private Ready', async () => {
  const h = await fixture(),
    owner = await h.m._captureValidationAdmissionWork(h.cid),
    old = owner.expected.admission,
    winning = { ...old, job_id: crypto.randomUUID(), attempts: 1, retry_at: Date.now() + 30000 },
    key = (j) =>
      `gi_validation_admission_pending:v1:${encodeURIComponent(h.device)}:${String(j.retry_at).padStart(
        16,
        '0',
      )}:${encodeURIComponent(h.cid)}`,
    db = await h.s.openDB();
  await new Promise((r, j) => {
    const t = db.transaction('meta', 'readwrite'),
      meta = t.objectStore('meta');
    meta.delete(key(old));
    meta.put(winning, `gi_validation_admission:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`);
    meta.put(winning, key(winning));
    t.oncomplete = r;
    t.onabort = j;
  });
  assert.equal(await owner.save({ kind: 'reserve', job: old, now: Date.now() + 2 }), null);
  const actual = await h.s.loadMlsReadyBase(h.user, h.device, h.cid);
  assert.deepEqual(actual.admission, winning);
  assert.deepEqual(actual.admission_pending, winning);
  assert.equal(h.m.getE2eeState(h.cid).state, 'ready');
  assert.equal(h.m._providerPersistenceUncertain, false);
  await preserved(h);
  h.c.stop();
});

// Explicit crypto-invalid fixture metadata; missing/stale GI alone never authorizes ACK work.
function requireValidationMetadata(m,cid) {
 const marker=m._groupGenerations.get(cid),control=m._recoveryControls.get(cid);if(!marker||!control)return;
 m._channelE2ee.set(cid,{cid,group_generation:marker.group_generation,group_id:marker.group_id?Buffer.from(marker.group_id).toString('base64'):null,epoch:marker.current_epoch,
  group_info:{status:'validation_required',ready:false,epoch:marker.current_epoch,last_uploaded_at:null,refresh_requested:false},
  recovery:{action:control.recovery_action,incident_id:control.incident_id,revision:control.recovery_revision,repair_retry_until:control.repair_retry_until}});
}
