const assert = require('node:assert/strict');
const test = require('node:test');
const { AxiosError } = require('axios');
const { EncryptionManager } = require('../dist/index.cjs');

function row(epoch = 15, channel = 'fixture') {
  return { cid: `messaging:${channel}`, channel_type: 'messaging', channel_id: channel,
    group_generation: 0, epoch, scope: 'account_owned', retry_count: 0, created_at: 1,
    upload: { group_generation: 0, epoch, archive_blob_id: `fixture-blob-${epoch}-${channel}`,
      idempotency_key: `fixture-key-${epoch}-${channel}`, scope: 'account_owned',
      encrypted_archive: { ciphertext: 'encrypted-fixture', nonce: 'fixture' },
      wraps: [{ recipient_recovery_key_id: 'fixture-recovery-key' }] } };
}
function checkpoint(epoch = 15) {
  return { scope_cid: 'messaging:fixture', channel_type: 'messaging', channel_id: 'fixture',
    group_generation: 0, epoch, encrypted_archive_bytes: { ciphertext: new Uint8Array([1, 2, 3]), nonce: new Uint8Array([4]) },
    snapshot: { snapshot_bytes: new Uint8Array([4]), snapshot_hash: 'fixture' },
    sponsor_role: 'primary', materialization: { account_owned: 'pending', group_sponsored: 'unsupported' },
    captured_at: 1, updated_at: 1 };
}
const key = r => JSON.stringify([r.cid, r.group_generation || 0, r.epoch, r.upload.archive_blob_id]);
const cpKey = (cid, epoch, gen = 0) => JSON.stringify([cid, gen, epoch]);
function harness(rows = [row()], checkpoints = []) {
  const manager = new EncryptionManager();
  const queue = new Map(rows.map(r => [key(r), structuredClone(r)]));
  const cps = new Map(checkpoints.map(c => [cpKey(c.scope_cid, c.epoch, c.group_generation), structuredClone(c)]));
  const requests = [], acks = [];
  manager.storage = {
    loadPendingArchiveUploads: async () => structuredClone([...queue.values()]),
    saveArchiveUpload: async r => queue.set(key(r), structuredClone(r)),
    deleteArchiveUpload: async (cid, epoch, blob, gen) => queue.delete(key({ cid, epoch, group_generation: gen, upload: { archive_blob_id: blob } })),
    loadEpochArchiveCheckpoint: async (cid, epoch, gen) => structuredClone(cps.get(cpKey(cid, epoch, gen)) || null),
    loadEpochArchiveCheckpoints: async () => structuredClone([...cps.values()]),
    saveEpochArchiveCheckpoint: async c => cps.set(cpKey(c.scope_cid, c.epoch, c.group_generation), structuredClone(c)),
    deleteEpochArchiveCheckpoint: async (cid, epoch, gen) => cps.delete(cpKey(cid, epoch, gen)),
    saveArchiveAck: async ack => acks.push(ack),
    loadPendingDeferredArchives: async () => [],
  };
  manager.e2eeClient = { uploadEpochArchive: async (_t, _c, upload) => { requests.push(structuredClone(upload)); return { status: 'stored' }; } };
  return { manager, queue, cps, requests, acks };
}
function error(code = 6, status = 400) {
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', undefined, undefined,
    { status, data: { ermis_code: code, message: code === 6 ? "you don't have permision to archive this epoch for recovery" : 'fixture rejection' } });
}
function deny(h) {
  h.manager.e2eeClient.uploadEpochArchive = async (_t, _c, upload) => { h.requests.push(structuredClone(upload)); throw error(); };
}

test('permission6 persists unchanged encrypted work and checkpoint without fake ACK or automatic retry', async () => {
  const h = harness([row()], [checkpoint()]); deny(h);
  await h.manager._drainArchiveUploadQueue();
  const retained = [...h.queue.values()][0];
  assert.equal(retained.status, 'permission_denied');
  assert.equal(retained.last_error_code, 6);
  assert.deepEqual(retained.upload, row().upload);
  assert.deepEqual([...h.cps.values()][0].encrypted_archive_bytes, checkpoint().encrypted_archive_bytes);
  assert.equal([...h.cps.values()][0].permission_denied, true);
  await h.manager._drainArchiveUploadQueue();
  assert.equal(h.requests.length, 1);
  assert.equal(h.acks.length, 0);
});

test('concurrent drain callers share a single upload per blob', async () => {
  const h = harness(); let release;
  const gate = new Promise(r => { release = r; });
  h.manager.e2eeClient.uploadEpochArchive = async (_t, _c, upload) => { h.requests.push(upload); await gate; return { status: 'stored' }; };
  const jobs = [h.manager._drainArchiveUploadQueue(), h.manager._drainArchiveUploadQueue(), h.manager._drainArchiveUploadQueue()];
  await new Promise(r => setImmediate(r)); release(); await Promise.all(jobs);
  assert.equal(h.requests.length, 1); assert.equal(h.acks.length, 1);
});

test('mid-drain enqueue is rescanned and transient work attempted once in that run', async () => {
  const h = harness(); let release;
  const gate = new Promise(r => { release = r; });
  h.manager.e2eeClient.uploadEpochArchive = async (_t, _c, upload) => {
    h.requests.push(upload); if (upload.epoch === 15) { await gate; throw error(4, 503); } return { status: 'stored' };
  };
  const first = h.manager._drainArchiveUploadQueue(); await new Promise(r => setImmediate(r));
  await h.manager.storage.saveArchiveUpload(row(16)); const second = h.manager._drainArchiveUploadQueue();
  release(); await Promise.all([first, second]);
  assert.deepEqual(h.requests.map(u => u.epoch), [15, 16]);
  assert.equal([...h.queue.values()][0].retry_count, 1);
  await h.manager._drainArchiveUploadQueue();
  assert.deepEqual(h.requests.map(u => u.epoch), [15, 16, 15]);
});

test('a denied old epoch does not block upload and ACK of a valid later epoch', async () => {
  const h = harness([row(), row(25)]);
  h.manager.e2eeClient.uploadEpochArchive = async (_t, _c, u) => { h.requests.push(u); if (u.epoch === 15) throw error(); return { status: 'stored' }; };
  await h.manager._drainArchiveUploadQueue();
  assert.deepEqual(h.requests.map(u => u.epoch), [15, 25]);
  assert.equal(h.acks.length, 1); assert.equal(h.acks[0].epoch, 25);
  assert.equal([...h.queue.values()][0].status, 'permission_denied');
});

test('paused work prevents native re-export only in the matching generation and epoch', async () => {
  const h = harness([{ ...row(), status: 'permission_denied' }]);
  let exports = 0;
  h.manager.groups.set(row().cid, { epoch: () => 15, archive_epoch_v2: () => { exports++; throw new Error('native export reached'); } });
  await h.manager.archiveCurrentEpoch('messaging', 'fixture'); assert.equal(exports, 0);
  h.manager._groupGenerations.set(row().cid, { group_generation: 1 });
  await assert.rejects(h.manager.archiveCurrentEpoch('messaging', 'fixture'), /native export reached/);
  assert.equal(exports, 1);
});

test('permission pause survives actual IndexedDB adapter reopen and manager replacement', async () => {
  require('fake-indexeddb/auto');
  const { IndexedDBEncryptionStorage } = require('../dist/encryption/index.cjs');
  const scope = `archive-fixture-${process.pid}`;
  let storage = new IndexedDBEncryptionStorage(scope);
  const h = harness(); h.manager.storage = storage; deny(h);
  await storage.saveArchiveUpload(row()); await storage.saveEpochArchiveCheckpoint(checkpoint());
  await h.manager._drainArchiveUploadQueue(); (await storage.getDB()).close();
  storage = new IndexedDBEncryptionStorage(scope);
  const resumed = new EncryptionManager(); resumed.storage = storage; resumed.e2eeClient = h.manager.e2eeClient;
  try {
    const [retained] = await storage.loadPendingArchiveUploads();
    assert.equal(retained.status, 'permission_denied'); assert.deepEqual(retained.upload, row().upload);
    assert.equal((await storage.loadEpochArchiveCheckpoint(row().cid, 15, 0)).permission_denied, true);
    await resumed._drainArchiveUploadQueue(); assert.equal(h.requests.length, 1);
    assert.equal(await resumed._hasPendingArchiveWork(row().cid, 0, 15, 'account_owned'), true);
  } finally { (await storage.getDB()).close(); }
});

test('sponsored recipient permission6 holds protected checkpoint and stops automatic query loop', async () => {
  const cp = checkpoint(); cp.materialization = { account_owned: 'uploaded', group_sponsored: 'pending' };
  const h = harness([], [cp]); let queries = 0;
  h.manager.e2eeClient.querySponsoredArchiveRecipients = async () => { queries++; throw error(); };
  await h.manager._materializeEpochArchiveCheckpoint(cp);
  const saved = [...h.cps.values()][0]; assert.equal(saved.permission_denied, true);
  assert.deepEqual(saved.encrypted_archive_bytes, cp.encrypted_archive_bytes);
  await h.manager._materializeEpochArchiveCheckpoint(saved); assert.equal(queries, 1);
});

test('explicit retry is channel scoped and sends identical blocked bytes after remediation', async () => {
  const h = harness([{ ...row(), status: 'permission_denied', last_error_code: 6 }, { ...row(15, 'other'), status: 'permission_denied' }]);
  assert.equal(await h.manager.retryBlockedArchiveUploads('messaging', 'fixture'), 1);
  assert.deepEqual(h.requests, [row().upload]); assert.equal(h.acks.length, 1);
  assert.equal([...h.queue.values()][0].channel_id, 'other'); assert.equal([...h.queue.values()][0].status, 'permission_denied');
});

test('manual retry prepares multiple checkpoints then attempts each transient blob only once', async () => {
  const rows = [row(), row(16)].map(r => ({ ...r, status: 'permission_denied' }));
  const cps = [checkpoint(), checkpoint(16)].map(c => ({ ...c, permission_denied: true }));
  const h = harness(rows, cps);
  h.manager.e2eeClient.uploadEpochArchive = async (_t, _c, u) => { h.requests.push(u); throw error(4, 503); };
  await h.manager.retryBlockedArchiveUploads('messaging', 'fixture');
  assert.deepEqual(h.requests.map(u => u.epoch), [15, 16]);
  assert.ok([...h.queue.values()].every(r => r.retry_count === 1));
  assert.ok([...h.cps.values()].every(c => !c.permission_denied));
});

test('explicit retry refused again returns to pause without losing payload', async () => {
  const h = harness([{ ...row(), status: 'permission_denied' }]); deny(h);
  await h.manager.retryBlockedArchiveUploads('messaging', 'fixture');
  assert.equal([...h.queue.values()][0].status, 'permission_denied'); assert.deepEqual(h.requests, [row().upload]);
});

test('pause persistence failure keeps work and resets single-flight for a subsequent attempt', async () => {
  const h = harness(); deny(h); const save = h.manager.storage.saveArchiveUpload;
  h.manager.storage.saveArchiveUpload = async () => { throw new Error('fixture storage unavailable'); };
  await assert.rejects(h.manager._drainArchiveUploadQueue(), /storage unavailable/);
  assert.equal(h.queue.size, 1); assert.equal(h.acks.length, 0);
  h.manager.storage.saveArchiveUpload = save; await h.manager._drainArchiveUploadQueue();
  assert.equal(h.requests.length, 2); assert.equal([...h.queue.values()][0].status, 'permission_denied');
});

test('other nonretryable server400 preserves previous terminal removal behavior', async () => {
  const h = harness(); h.manager.e2eeClient.uploadEpochArchive = async () => { throw error(4); };
  await h.manager._drainArchiveUploadQueue(); assert.equal(h.queue.size, 0); assert.equal(h.acks.length, 0);
});

test('a stale scope update preserves a permission pause and protected checkpoint from storage', async () => {
  const original = checkpoint(); original.materialization.group_sponsored = 'pending';
  const h = harness([], [{ ...original, permission_denied: true }]);
  await h.manager._saveCheckpointMaterialization(original, 'account_owned', 'uploaded');
  await h.manager._saveCheckpointMaterialization(original, 'group_sponsored', 'uploaded');
  const saved = [...h.cps.values()][0];
  assert.equal(saved.permission_denied, true);
  assert.deepEqual(saved.materialization, { account_owned: 'uploaded', group_sponsored: 'uploaded' });
});

test('logout during upload cannot publish ACK/delete into a replacement account storage', async () => {
  const h = harness([row(), row(16)]); let release;
  const gate = new Promise(r => { release = r; });
  h.manager.e2eeClient.uploadEpochArchive = async (_t, _c, u) => { h.requests.push(u); await gate; return { status: 'stored' }; };
  const job = h.manager._drainArchiveUploadQueue(); await new Promise(r => setImmediate(r));
  h.manager.destroy();
  const replacement = harness([row(25)]);
  h.manager.storage = replacement.manager.storage; h.manager.e2eeClient = replacement.manager.e2eeClient;
  const next = h.manager._drainArchiveUploadQueue();
  release(); await Promise.all([job, next]);
  assert.equal(h.requests.length, 1); assert.equal(h.queue.size, 2); assert.equal(h.acks.length, 0);
  assert.equal(replacement.queue.size, 0); assert.equal(replacement.acks.length, 1);
});

async function realStorage(label) {
  require('fake-indexeddb/auto');
  const { IndexedDBEncryptionStorage } = require('../dist/encryption/index.cjs');
  return new IndexedDBEncryptionStorage(`archive-${label}-${process.pid}`);
}
async function abortNextWrite(storage, storeName) {
  const db = await storage.getDB(); const original = db.transaction;
  let armed = true;
  db.transaction = function(names, mode, ...rest) {
    const tx = original.call(this, names, mode, ...rest);
    if (armed && mode === 'readwrite' && (typeof names === 'string' ? [names] : [...names]).includes(storeName)) {
      armed = false; queueMicrotask(() => tx.abort());
    }
    return tx;
  };
  return () => { db.transaction = original; };
}
const ack = () => ({ cid: row().cid, group_generation: 0, epoch: 15, scope: 'account_owned',
  coverage_key: 'fixture-recovery-key', recovery_key_id: 'fixture-recovery-key',
  archive_blob_id: row().upload.archive_blob_id, status: 'uploaded', updated_at: 1 });

test('actual IndexedDB pending request remains on disk at pre-ACK acceptance boundary', async () => {
  const storage = await realStorage('before-ack'); const h = harness(); h.manager.storage = storage;
  await storage.saveArchiveUpload(row()); let beforeAck;
  const save = storage.saveArchiveAck.bind(storage);
  storage.saveArchiveAck = async value => { beforeAck = await storage.loadPendingArchiveUploads(); await save(value); };
  try {
    await h.manager._drainArchiveUploadQueue();
    assert.equal(beforeAck.length, 1); assert.deepEqual(beforeAck[0].upload, row().upload);
    assert.deepEqual(await storage.loadPendingArchiveUploads(), []);
    assert.equal((await storage.loadArchiveAck(row().cid, 0, 15, 'account_owned', 'fixture-recovery-key')).archive_blob_id, row().upload.archive_blob_id);
  } finally { (await storage.getDB()).close(); }
});

test('actual IndexedDB has durable ACK while pending record still exists at pre-retirement boundary', async () => {
  const storage = await realStorage('before-delete'); const h = harness(); h.manager.storage = storage;
  await storage.saveArchiveUpload(row()); let beforeDelete;
  const remove = storage.deleteArchiveUpload.bind(storage);
  storage.deleteArchiveUpload = async (...args) => {
    beforeDelete = { ack: await storage.loadArchiveAck(row().cid, 0, 15, 'account_owned', 'fixture-recovery-key'), rows: await storage.loadPendingArchiveUploads() };
    await remove(...args);
  };
  try {
    await h.manager._drainArchiveUploadQueue();
    assert.equal(beforeDelete.ack?.archive_blob_id, row().upload.archive_blob_id);
    assert.equal(beforeDelete.rows.length, 1);
  } finally { (await storage.getDB()).close(); }
});

test('actual ACK transaction abort keeps exact request/checkpoint through reopen and idempotent retry', async () => {
  let storage = await realStorage('abort-recover'); const h = harness(); h.manager.storage = storage;
  await storage.saveArchiveUpload(row()); await storage.saveEpochArchiveCheckpoint(checkpoint());
  const restore = await abortNextWrite(storage, 'archive_acks');
  await h.manager._drainArchiveUploadQueue(); restore(); (await storage.getDB()).close();
  storage = await realStorage('abort-recover'); h.manager.storage = storage;
  try {
    const [retained] = await storage.loadPendingArchiveUploads();
    assert.deepEqual(retained.upload, row().upload); assert.equal(retained.retry_count, 1);
    assert.equal(await storage.loadArchiveAck(row().cid, 0, 15, 'account_owned', 'fixture-recovery-key'), null);
    assert.deepEqual((await storage.loadEpochArchiveCheckpoint(row().cid, 15, 0)).encrypted_archive_bytes, checkpoint().encrypted_archive_bytes);
    h.manager.e2eeClient.uploadEpochArchive = async (_t, _c, u) => { h.requests.push(structuredClone(u)); return { status: 'acknowledged', reason_code: 'idempotent' }; };
    await h.manager._drainArchiveUploadQueue();
    assert.deepEqual(h.requests, [row().upload, row().upload]);
    assert.deepEqual(await storage.loadPendingArchiveUploads(), []);
    assert.equal((await storage.loadArchiveAck(row().cid, 0, 15, 'account_owned', 'fixture-recovery-key')).status, 'idempotent');
  } finally { (await storage.getDB()).close(); }
});

for (const operation of ['upload', 'ack', 'checkpoint', 'delete']) {
  test(`actual ${operation} transaction abort rejects and leaves prior committed state`, async () => {
    const storage = await realStorage(`abort-${operation}`);
    await storage.saveArchiveUpload(row()); await storage.saveEpochArchiveCheckpoint(checkpoint());
    const store = { upload: 'archive_uploads', ack: 'archive_acks', checkpoint: 'meta', delete: 'archive_uploads' }[operation];
    const restore = await abortNextWrite(storage, store);
    try {
      const write = { upload: () => storage.saveArchiveUpload({ ...row(), status: 'permission_denied' }),
        ack: () => storage.saveArchiveAck(ack()),
        checkpoint: () => storage.saveEpochArchiveCheckpoint({ ...checkpoint(), permission_denied: true }),
        delete: () => storage.deleteArchiveUpload(row().cid, 15, row().upload.archive_blob_id, 0) }[operation];
      await assert.rejects(write(), /abort/i);
      assert.equal((await storage.loadPendingArchiveUploads()).length, 1);
      assert.equal((await storage.loadPendingArchiveUploads())[0].status, undefined);
      assert.equal(await storage.loadArchiveAck(row().cid, 0, 15, 'account_owned', 'fixture-recovery-key'), null);
      assert.equal((await storage.loadEpochArchiveCheckpoint(row().cid, 15, 0)).permission_denied, undefined);
    } finally { restore(); (await storage.getDB()).close(); }
  });
}

test('missing coverage cannot retire pending work without a durable ACK', async () => {
  const r = row(); r.upload.wraps = [];
  const h = harness([r]); await h.manager._drainArchiveUploadQueue();
  assert.equal(h.queue.size, 1); assert.equal(h.acks.length, 0);
});

test('recipient-set stale persists rewrap checkpoint before removing obsolete work without ACK', async () => {
  const r = row(); r.scope = 'group_sponsored'; r.upload.scope = 'group_sponsored'; r.upload.recipient_set_hash = 'fixture-set';
  const cp = checkpoint(); cp.materialization = { account_owned: 'uploaded', group_sponsored: 'pending' };
  const h = harness([r], [cp]); let atDelete;
  const remove = h.manager.storage.deleteArchiveUpload;
  h.manager.storage.deleteArchiveUpload = async (...args) => { atDelete = structuredClone([...h.cps.values()][0]); await remove(...args); };
  h.manager._materializeEpochArchiveCheckpoint = async () => {};
  h.manager.e2eeClient.uploadEpochArchive = async () => ({ status: 'acknowledged', reason_code: 'recipient_set_stale' });
  await h.manager._drainArchiveUploadQueue();
  assert.equal(atDelete.sponsored_rewrap_count, 1); assert.equal(atDelete.materialization.group_sponsored, 'pending');
  assert.equal(h.queue.size, 0); assert.equal(h.acks.length, 0);
});
