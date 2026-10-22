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
const ack = (h) => h.s.loadGroupInfoValidationAckCheckpoint(h.cid, h.device);
const discovery = (h) => h.s.loadRecoveryDiscoveryWork(h.device, [h.cid]).then((v) => v[h.cid]);
const prepare = (h) => h.m.validateAndQueueGroupInfoAck('team', h.cid.slice(5), h.cid);
async function peer(h) {
  const s = new IndexedDBEncryptionStorage(h.user),
    before = await s.loadProviderCheckpoint(h.user, h.device),
    p = wasm.Provider.from_bytes(before.provider_bytes),
    i = wasm.Identity.from_bytes(p, h.m.identity.to_bytes()),
    kp = i.key_package(p),
    ref = kp.hash_ref(p);
  kp.free();
  await s.saveProviderState(h.user, h.device, p.to_bytes(), {
    expected_revision: before.revision,
    next_revision: crypto.randomUUID(),
  });
  i.free();
  p.free();
  return { base: await s.loadProviderCheckpoint(h.user, h.device), ref };
}
async function privateKept(h, expected = h.base) {
  assert.equal(sha256Hex(h.m._activeProvider.to_bytes()), sha256Hex(h.bytes));
  const actual = await h.s.loadProviderCheckpoint(h.user, h.device);
  assert.equal(actual.revision, expected.revision);
  assert.equal(sha256Hex(actual.provider_bytes), sha256Hex(expected.provider_bytes));
}
function fenced(h) {
  assert.equal(h.m.getE2eeState(h.cid).state, 'repairing');
  assert.equal(h.seen.at(-1).state, 'repairing');
  const late = [];
  h.m.subscribeE2eeState(h.cid, (v) => late.push(v));
  assert.equal(late[0].state, 'repairing');
}
async function reload(h) {
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
  m.client = h.m.client;
  m.e2eeClient = {};
  m.initialized = true;
  m._armValidationAckRetry = () => {};
  assert.equal((await m.refreshE2eeState(h.cid)).state, 'ready');
  return m;
}
for (const kind of ['discovery', 'ack'])
  test(
    kind +
      ' learned remote private owner conflict fences current/late/listener Ready and reload preserves actual winning KP',
    async () => {
      const entered = latch(),
        gate = latch(),
        h = await fixture(kind);
      const original = kind === 'ack' ? h.m.e2eeClient.getGroupInfo : h.m.e2eeClient.discoverMlsRecovery;
      if (kind === 'ack')
        h.m.e2eeClient.getGroupInfo = async () => {
          entered.resolve();
          await gate.promise;
          return original();
        };
      else
        h.m.e2eeClient.discoverMlsRecovery = async () => {
          entered.resolve();
          await gate.promise;
          return original();
        };
      const work = kind === 'ack' ? prepare(h) : h.c.request([h.cid]),
        rejected = assert.rejects(work);
      await entered.promise;
      const saved = kind === 'ack' ? await ack(h) : await discovery(h),
        win = await peer(h);
      gate.resolve();
      await rejected;
      fenced(h);
      assert.equal(h.m._providerPersistenceUncertain, true);
      await privateKept(h, win.base);
      assert.equal(h.posts, 0);
      assert.deepEqual(kind === 'ack' ? await ack(h) : await discovery(h), saved);
      const m = await reload(h);
      assert.equal(m.identity.owns_key_package_ref(m.provider, win.ref), true);
      assert.deepEqual(kind === 'ack' ? await ack(h) : await discovery(h), saved);
      h.c.stop();
    },
  );
for (const phase of ['intake', 'reserve', 'finish'])
  for (const fault of ['abort', 'unknown', 'readback'])
    test(
      'discovery ' + phase + '/' + fault + ' retains exact durable obligation and independently proven Ready',
      async () => {
        const h = await fixture('discovery');
        if (phase !== 'intake') await h.c.enqueue([h.cid]);
        let calls = 0;
        h.m.e2eeClient.discoverMlsRecovery = async () => {
          calls++;
          return {
            protocol_version: 1,
            capability: { protocol_version: 1 },
            states: { [h.cid]: { result: 'error', reason: 'not_authorized', retryable: false } },
          };
        };
        const save = h.s.saveRecoveryDiscoveryWork.bind(h.s);
        h.s.saveRecoveryDiscoveryWork = async (...args) => {
          const n = args[2][0].next,
            hit =
              phase === 'intake'
                ? !args[2][0].expected
                : phase === 'reserve'
                ? !!n.lease_id
                : !n.lease_id && n.attempts > 0;
          if (!hit) return save(...args);
          if (fault === 'unknown') {
            await save(...args);
            throw Error('public committed return lost');
          }
          const db = await h.s.openDB(),
            orig = db.transaction.bind(db);
          let committed = false;
          db.transaction = (...a) => {
            const tx = orig(...a);
            if (a[1] === 'readwrite') {
              if (fault === 'abort') queueMicrotask(() => tx.abort());
              else tx.addEventListener('complete', () => (committed = true));
            }
            if (fault === 'readback' && committed && a[1] === 'readonly') queueMicrotask(() => tx.abort());
            return tx;
          };
          try {
            return await save(...args);
          } finally {
            db.transaction = orig;
          }
        };
        await assert.rejects(phase === 'intake' ? h.c.enqueue([h.cid]) : h.c.run());
        assert.equal(calls, phase === 'finish' ? 1 : 0);
        assert.equal(h.m.getE2eeState(h.cid).state, 'ready');
        assert.equal(h.m._providerPersistenceUncertain, false);
        await privateKept(h);
        const row = await discovery(h);
        assert.equal(!!row, phase !== 'intake' || fault !== 'abort');
        h.c.stop();
      },
    );
for (const phase of ['prepare', 'reserve', 'finish', 'defer'])
  for (const fault of ['abort', 'unknown', 'readback', 'due-mismatch'])
    test(
      'ACK ' + phase + '/' + fault + ' prevents unproven transport/publication and keeps private state and exact job',
      async () => {
        const h = await fixture();
        if (phase !== 'prepare') await prepare(h);
        if (phase === 'defer') h.m._pendingMlsMutations.set(h.cid, {operation_id:'retained-local-prerequisite'});
        const save = h.s.saveValidationAckWork.bind(h.s);
        h.s.saveValidationAckWork = async (...args) => {
          const before = args[3].state.ack,
            next = args[4],
            hit =
              phase === 'prepare'
                ? !before
                : phase === 'reserve'
                ? next.attempts > before.attempts && next.outcome === 'pending'
                : phase === 'finish'
                ? next.outcome === 'accepted'
                : next.attempts === before.attempts && next.retry_at > before.retry_at;
          if (!hit) return save(...args);
          if (fault === 'unknown') {
            await save(...args);
            throw Error('public committed return lost');
          }
          const db = await h.s.openDB(),
            orig = db.transaction.bind(db);
          let committed = false;
          db.transaction = (...a) => {
            const tx = orig(...a);
            if (a[1] === 'readwrite') {
              if (fault === 'abort') queueMicrotask(() => tx.abort());
              else
                tx.addEventListener('complete', () => {
                  committed = true;
                  if (fault === 'due-mismatch') {
                    const win = orig(['meta'], 'readwrite'),
                      meta = win.objectStore('meta'),
                      prefix = 'gi_validation_ack_pending:v1:';
                    const read = meta.openCursor();
                    read.onsuccess = () => {
                      const cursor = read.result;
                      if (cursor) {
                        if (String(cursor.key).startsWith(prefix)) cursor.update({ ...cursor.value, attempts: 3 });
                        cursor.continue();
                      }
                    };
                  }
                });
            }
            if (fault === 'readback' && committed && a[1] === 'readonly') queueMicrotask(() => tx.abort());
            return tx;
          };
          try {
            return await save(...args);
          } finally {
            db.transaction = orig;
          }
        };
        // A terminal ACK removes the due row; inject terminal primary mismatch as the corresponding proof fault.
        if (phase === 'finish' && fault === 'due-mismatch') {
          h.s.saveValidationAckWork = async (...args) => {
            const n = args[4];
            if (n.outcome !== 'accepted') return save(...args);
            const db = await h.s.openDB(),
              orig = db.transaction.bind(db);
            db.transaction = (...a) => {
              const tx = orig(...a);
              if (a[1] === 'readwrite')
                tx.addEventListener('complete', () => {
                  const t = orig(['meta'], 'readwrite'),
                    key = `gi_validation_ack:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`,
                    read = t.objectStore('meta').get(key);
                  read.onsuccess = () => t.objectStore('meta').put({ ...read.result, outcome: 'pending' }, key);
                });
              return tx;
            };
            try {
              return await save(...args);
            } finally {
              db.transaction = orig;
            }
          };
        }
        await assert.rejects(phase === 'prepare' ? prepare(h) : h.m._drainGroupInfoValidationAcks());
        assert.equal(h.posts, phase === 'finish' ? 1 : 0);
        assert.equal(h.m._providerPersistenceUncertain, false);
        await privateKept(h);
        if (phase !== 'defer') assert.equal(h.m.getE2eeState(h.cid).state, 'ready');
        assert.equal(!!(await ack(h)), phase !== 'prepare' || fault !== 'abort');
        h.c.stop();
      },
    );
for (const cap of ['validationAckWorkCheckpointVersion', 'loadValidationAckWorkBase', 'saveValidationAckWork'])
  test('missing ' + cap + ' fails upgrade before GI/ACK transport and private mutation', async () => {
    const h = await fixture();
    h.s[cap] = undefined;
    await assert.rejects(prepare(h), (e) => e.code === 'client_upgrade_required');
    assert.equal(h.gets, 0);
    assert.equal(h.posts, 0);
    await privateKept(h);
    h.c.stop();
  });
for (const change of ['marker', 'control', 'mutation', 'external', 'removal'])
  test(
    'ACK learns ' + change + ' owned metadata conflict before GI and fences selected Ready without private poison',
    async () => {
      const h = await fixture(),
        db = await h.s.openDB();
      await new Promise((r, j) => {
        const tx = db.transaction(['meta', 'groups'], 'readwrite'),
          meta = tx.objectStore('meta');
        if (change === 'marker') tx.objectStore('groups').put({ ...h.marker, updated_at: 2 }, h.cid);
        else if (change === 'control') {
          const key = `recovery_control:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`,
            q = meta.get(key);
          q.onsuccess = () => meta.put({ ...q.result, recovery_revision: '2' }, key);
        } else
          meta.put(
            { operation_id: 'winning' },
            `${
              change === 'mutation' ? 'mls_mutation' : change === 'external' ? 'external_candidate' : 'mls_removal'
            }:v1:${h.cid}`,
          );
        tx.oncomplete = r;
        tx.onabort = j;
      });
      if (change === 'control') {
        // Hold the original owned control so this tests the capture conflict rather than authoritative adoption.
        h.m._loadRecoveryControl = async () => {};
      }
      await assert.rejects(prepare(h));
      fenced(h);
      assert.equal(h.m._providerPersistenceUncertain, false);
      assert.equal(h.gets, 0);
      assert.equal(h.posts, 0);
      await privateKept(h);
      h.c.stop();
    },
  );
for (const kind of ['discovery', 'ack'])
  test(
    kind + ' provider queue overload still fences Ready after a learned private conflict and preserves durable winner',
    async () => {
      const entered = latch(),
        gate = latch(),
        h = await fixture(kind);
      if (kind === 'ack')
        h.m.e2eeClient.getGroupInfo = async () => {
          entered.resolve();
          await gate.promise;
          return h.info;
        };
      else
        h.m.e2eeClient.discoverMlsRecovery = async () => {
          entered.resolve();
          await gate.promise;
          return { protocol_version: 1, capability: { protocol_version: 1 }, states: {} };
        };
      const work = kind === 'ack' ? prepare(h) : h.c.request([h.cid]),
        rejected = assert.rejects(work);
      await entered.promise;
      const win = await peer(h);
      h.m._providerMutationQueued = 32;
      gate.resolve();
      await rejected;
      h.m._providerMutationQueued = 0;
      // ACK cannot validate while the queue is full; learn its already saved owner's CAS conflict directly.
      if (kind === 'ack') {
        const guard = await h.s.loadValidationAckWorkBase(h.user, h.device, h.cid);
        assert.equal(guard.state.revision, win.base.revision);
        assert.equal(h.posts, 0);
      } else fenced(h);
      await privateKept(h, win.base);
      h.c.stop();
    },
  );
for (const replacement of [
  'account',
  'device',
  'storage',
  'signer',
  'artifact',
  'transport',
  'group',
  'marker',
  'provider',
])
  test(
    'delayed ACK ' + replacement + ' continuation retains original job and cannot clear replacement work',
    async () => {
      const entered = latch(),
        gate = latch(),
        h = await fixture();
      await prepare(h);
      const job = await ack(h);
      h.m.e2eeClient.acknowledgeGroupInfoValidation = async () => {
        entered.resolve();
        await gate.promise;
        return { accepted: true, idempotent: false, recovery_action: 'none', recovery_revision: '2' };
      };
      const work = h.m._drainGroupInfoValidationAcks(),
        rejected = assert.rejects(work);
      await entered.promise;
      const reserved = await ack(h);
      if (replacement === 'account') h.m.userId = 'replacement';
      if (replacement === 'device') h.m.deviceId = 'replacement';
      if (replacement === 'storage') h.m.storage = new IndexedDBEncryptionStorage(h.user);
      if (replacement === 'signer')
        h.m.identity = wasm.Identity.from_bytes(h.m._activeProvider, h.m.identity.to_bytes());
      if (replacement === 'artifact') h.m._wasmArtifactSha256 = 'a'.repeat(64);
      if (replacement === 'transport') h.m.e2eeClient = {};
      if (replacement === 'group') h.m.groups.set(h.cid, wasm.Group.load(h.m._activeProvider, h.cid));
      if (replacement === 'marker') h.m._groupGenerations.set(h.cid, { ...h.marker, updated_at: 2 });
      if (replacement === 'provider') h.m.provider = wasm.Provider.from_bytes(h.bytes);
      const replacementPromise = Promise.resolve();
      h.m._validationAckWork = replacementPromise;
      gate.resolve();
      await rejected;
      assert.equal(h.m._validationAckWork, replacementPromise);
      assert.deepEqual(await ack(h), reserved);
      assert.equal(reserved.job_id, job.job_id);
      h.c.stop();
    },
  );

for (const fault of ['provider-digest', 'marker', 'control', 'manual-admission'])
  test('fresh ACK checkpoint rejects mismatched captured ' + fault + ' before any write', async () => {
    const h = await fixture();
    await prepare(h);
    const job = await ack(h);
    const db = await h.s.openDB();
    await new Promise((r, j) => {
      const tx = db.transaction('meta', 'readwrite'),
        read = tx.objectStore('meta').openCursor();
      read.onsuccess = () => {
        const c = read.result;
        if (c) {
          if (String(c.key).startsWith('gi_validation_ack')) c.delete();
          c.continue();
        }
      };
      tx.oncomplete = r;
      tx.onabort = j;
    });
    const base = await h.s.loadValidationAckWorkBase(h.user, h.device, h.cid),
      next = structuredClone(job);
    if (fault === 'provider-digest') next.provider_sha256 = '0'.repeat(64);
    if (fault === 'marker') {
      next.request.epoch = 1;
      next.marker.current_epoch = 1;
    }
    if (fault === 'control') next.recovery_revision = '2';
    if (fault === 'manual-admission') {
      next.trigger = 'manual';
      base.state.control = { ...base.state.control, recovery_action: 'manual_intervention_required' };
    }
    await assert.rejects(
      h.s.saveValidationAckWork(h.user, h.device, h.cid, base, next, () => {}),
      (e) => e.code === 'validation_ack_checkpoint_invalid',
    );
    assert.equal(await ack(h), null);
    await privateKept(h);
    h.c.stop();
  });
for (const obligation of ['mls_mutation', 'mls_removal', 'external_candidate', 'mls_rebootstrap_candidate'])
  test(
    'ACK defer learns durable-only ' + obligation + ' and retains exact obligation while closing current/late Ready',
    async () => {
      const h = await fixture();
      await prepare(h);
      const old = await ack(h),
        db = await h.s.openDB(),
        record = { operation_id: 'durable-obligation', submission: 'unknown' };
      await new Promise((r, j) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(record, obligation + ':v1:' + h.cid);
        tx.oncomplete = r;
        tx.onabort = j;
      });
      await h.m._drainGroupInfoValidationAcks();
      fenced(h);
      assert.equal(h.posts, 0);
      assert.equal(h.m._providerPersistenceUncertain, false);
      const actual = await h.s.loadValidationAckWorkBase(h.user, h.device, h.cid);
      assert.deepEqual(actual.state.cleanup.metadata[obligation + ':v1:' + h.cid], record);
      assert.equal(actual.state.ack.job_id, old.job_id);
      assert.equal(actual.state.ack.attempts, old.attempts);
      assert.equal(actual.state.ack.outcome, 'pending');
      assert.deepEqual(actual.pending, actual.state.ack);
      await privateKept(h);
      h.c.stop();
    },
  );
test('ACK committed full readback races actual private writer: winning key package survives and current/late Ready fences', async () => {
  const h = await fixture(),
    db = await h.s.openDB(),
    orig = db.transaction.bind(db),
    base = h.base,
    p = wasm.Provider.from_bytes(base.provider_bytes),
    i = wasm.Identity.from_bytes(p, h.m.identity.to_bytes()),
    kp = i.key_package(p),
    ref = kp.hash_ref(p);
  kp.free();
  const bytes = p.to_bytes();
  i.free();
  p.free();
  const save = h.s.saveValidationAckWork.bind(h.s);
  let injected = false,
    win;
  const winningRevision = crypto.randomUUID();
  h.s.saveValidationAckWork = async (...args) => {
    db.transaction = (...a) => {
      const tx = orig(...a);
      if (a[1] === 'readwrite' && !injected)
        tx.addEventListener('complete', () => {
          injected = true;
          const t = orig('meta', 'readwrite');
          t.objectStore('meta').put(bytes, `provider:${h.user}:${h.device}`);
          t.objectStore('meta').put(winningRevision, `provider_revision:${h.user}:${h.device}`);
        });
      return tx;
    };
    try {
      return await save(...args);
    } finally {
      db.transaction = orig;
    }
  };
  await assert.rejects(prepare(h));
  assert.ok(injected);
  fenced(h);
  assert.equal(h.posts, 0);
  assert.equal(h.m._providerPersistenceUncertain, true);
  win = await h.s.loadProviderCheckpoint(h.user, h.device);
  assert.equal(win.revision, winningRevision);
  assert.equal(sha256Hex(win.provider_bytes), sha256Hex(bytes));
  assert.equal(sha256Hex(h.m._activeProvider.to_bytes()), sha256Hex(h.bytes));
  const reloaded = await reload(h);
  assert.equal(reloaded.identity.owns_key_package_ref(reloaded._activeProvider, ref), true);
  h.c.stop();
});

// Explicit crypto-invalid fixture metadata; missing/stale GI alone never authorizes ACK work.
function requireValidationMetadata(m,cid) {
 const marker=m._groupGenerations.get(cid),control=m._recoveryControls.get(cid);if(!marker||!control)return;
 m._channelE2ee.set(cid,{cid,group_generation:marker.group_generation,group_id:marker.group_id?Buffer.from(marker.group_id).toString('base64'):null,epoch:marker.current_epoch,
  group_info:{status:'validation_required',ready:false,epoch:marker.current_epoch,last_uploaded_at:null,refresh_requested:false},
  recovery:{action:control.recovery_action,incident_id:control.incident_id,revision:control.recovery_revision,repair_retry_until:control.repair_retry_until}});
}
