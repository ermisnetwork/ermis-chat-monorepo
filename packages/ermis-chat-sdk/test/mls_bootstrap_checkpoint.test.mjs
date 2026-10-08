import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const require = createRequire(import.meta.url);
const { EncryptionManager, IndexedDBEncryptionStorage } = require('../dist/index.cjs');
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
await init({ module_or_path: fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url)) });
let seq = 0;
async function harness() {
  const user = 'bootstrap-' + (++seq), cid = 'team:' + user;
  const provider = new wasm.Provider(), identity = new wasm.Identity(provider, user);
  const identityBytes = identity.to_bytes();
  const storage = new IndexedDBEncryptionStorage(user);
  async function manager(p = provider) {
    const m = new EncryptionManager();
    m.initialized = true; m.userId = user; m.deviceId = 'device'; m.provider = p;
    m.identity = wasm.Identity.from_bytes(p, identityBytes); m.storage = storage;
    m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
    m.safeArchiveCurrentEpoch = async () => {}; m.safeArchiveCurrentEpochForCid = async () => {};
    m._cleanupEvictedGhosts = async () => {}; m._uploadGroupInfo = async () => {};
    m._getActiveChannel = () => ({}); m._getMembershipCreatedAt = () => '2026-10-06T00:00:00Z';
    m._syncChannelFromCursor = async () => {};
    m.client = { baseURL: 'http://fixture/v1', post: async () => ({}) };
    return m;
  }
  async function restore() {
    const m = await manager(wasm.Provider.from_bytes(await storage.loadProviderState(user, 'device')));
    for (const pending of await storage.listPendingMlsMutations()) {
      const marker = await storage.loadGroupState(pending.cid);
      m.groups.set(pending.cid, marker.group_generation
        ? wasm.Group.load_with_group_id(m.provider, marker.group_id) : wasm.Group.load(m.provider, pending.cid));
      m._groupGenerations.set(pending.cid, marker); m._pendingMlsMutations.set(pending.cid, pending);
    }
    return m;
  }
  return { user, cid, provider, identity, storage, manager, restore };
}
function recipients() {
  const p = new wasm.Provider(), i = new wasm.Identity(p, 'bob');
  return { members: [{ user_id: 'bob', key_packages: [{ device_id: 'b', key_package: i.key_package(p).to_bytes() }] }] };
}
const welcomeProof = pending => ({ epoch: pending.expected_epoch + 1, group_generation: pending.group_generation,
  group_id: pending.group_id, welcome: pending.request.body.welcome, ratchet_tree: pending.request.body.ratchet_tree });
const infoProof = pending => ({ epoch: pending.expected_epoch + 1, is_stale: false,
  group_generation: pending.group_generation, group_id: pending.group_id, group_info: pending.request.body.group_info });
const encodedBody = (bundle, extra = {}) => ({ data: { ...bundle, ...extra,
  welcome: Buffer.from(bundle.welcome).toString('base64'),
  ratchet_tree: Buffer.from(bundle.ratchet_tree).toString('base64'),
  group_info: Buffer.from(bundle.group_info).toString('base64'),
} });
for (const topic of [false, true]) {
  test(`real WASM ${topic ? 'topic' : 'channel'} preparation retains original staged bundle across reload`, async () => {
    const h = await harness(), m = await h.manager(); let fetches = 0;
    m.e2eeClient = { getKeyPackagesByUserIds: async () => { fetches++; return recipients(); } };
    const cid = topic ? 'topic:' + h.user : h.cid;
    const bundle = topic ? await m.createE2eeTopic(cid, ['bob']) : await m.createE2eeChannel('team', h.user, cid, ['bob']);
    assert.equal(m.getEpoch(cid), 0); assert.equal(bundle.epoch, 0);
    assert.throws(() => m.encryptMessage(cid, { text: 'blocked' }), /outcome_pending/);
    const n = await h.restore(); n.e2eeClient = { getKeyPackagesByUserIds: async () => { throw new Error('must not fetch new KP'); } };
    const again = topic ? await n.createE2eeTopic(cid, ['bob']) : await n.createE2eeChannel('team', h.user, cid, ['bob']);
    assert.deepEqual(again.welcome, bundle.welcome); assert.equal(fetches, 1);
    const [pending] = await h.storage.listPendingMlsMutations();
    await n.reconcileMlsBootstrapWelcome(cid, { ...welcomeProof(pending), welcome: new Uint8Array([1]) });
    assert.equal(n.getEpoch(cid), 0);
    await n.reconcileMlsBootstrapWelcome(cid, welcomeProof(pending));
    assert.equal(n.getEpoch(cid), 1); assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
  });
}
test('unbound preparation cannot invent creation metadata or issue HTTP during sync', async () => {
  const h = await harness(), m = await h.manager(); let posts = 0;
  m.e2eeClient = { getKeyPackagesByUserIds: async () => recipients(), getGroupInfo: async () => { throw new Error('not found'); } };
  m.client.post = async () => { posts++; };
  await m.createE2eeChannel('team', h.user, h.cid, ['bob']);
  await m._resumePendingMlsMutations();
  assert.equal(posts, 0); assert.equal((await h.storage.listPendingMlsMutations()).length, 1);
});
test('sync cannot resend a bootstrap whose initial bound checkpoint is still in flight', async () => {
  const h = await harness(), m = await h.manager(); let posts = 0, entered, release;
  m.e2eeClient = { getKeyPackagesByUserIds: async () => recipients(), getGroupInfo: async () => { throw new Error('not found'); } };
  m.client.post = async () => { posts++; throw new Error('offline'); };
  const bundle = await m.createE2eeChannel('team', h.user, h.cid, ['bob']);
  const save = h.storage.saveMlsMutationCheckpoint.bind(h.storage);
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.storage.saveMlsMutationCheckpoint = async cp => { await save(cp); if(cp.pending?.request.query_path){entered();await gate;} };
  const send = m.postMlsBootstrap(h.cid, m.client.baseURL + '/channels/team/' + h.user + '/query', encodedBody(bundle));
  const rejected = assert.rejects(send, /offline/);
  await started; await m._resumePendingMlsMutations(); assert.equal(posts, 0);
  release(); await rejected; assert.equal(posts, 1); assert.equal(m._sendingMlsMutations.size, 0);
});
test('unknown topic creation blocks another random-CID create for that parent', async () => {
  const h = await harness(), m = await h.manager(), cid = 'topic:' + h.user;
  m.e2eeClient = { getKeyPackagesByUserIds: async () => recipients() };
  const bundle = await m.createE2eeTopic(cid, ['bob']);
  m.client.post = async () => { throw new Error('lost reply'); };
  await assert.rejects(m.postMlsBootstrap(cid, m.client.baseURL + '/channels/topic/' + h.user + '/query', {
    ...encodedBody(bundle), parent_cid: h.cid,
  }));
  assert.throws(() => m.assertCanCreateMlsTopic(h.cid), /outcome_pending/);
  assert.doesNotThrow(() => m.assertCanCreateMlsTopic('team:another'));
});
test('enable timeout retains the saved artifact until the server exposes the same enabled GroupInfo', async () => {
  const h = await harness(), m = await h.manager();
  m.e2eeClient = { getKeyPackagesByCid: async () => recipients(), enableE2ee: async () => { throw new Error('lost enable reply'); } };
  await assert.rejects(m.enableE2ee('team', h.user, h.cid, ['bob']), /lost enable reply/);
  const [pending] = await h.storage.listPendingMlsMutations();
  assert.equal(pending.request.kind, 'enable'); assert.equal(m.getEpoch(h.cid), 0);
  const n = await h.restore(); let enabled = false, sends = 0;
  n.e2eeClient = {
    getGroupInfo: async () => { if (!enabled) throw new Error('not enabled'); return infoProof(pending); },
    enableE2ee: async (_type, _id, body) => { sends++; assert.deepEqual(body, pending.request.body); enabled = true; },
  };
  await n._resumePendingMlsMutations();
  assert.equal(sends, 1); assert.equal(n.getEpoch(h.cid), 1);
  assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
});
test('bound create survives lost response and replays exactly the encoded request after reload', async () => {
  const h = await harness(), m = await h.manager();
  m.e2eeClient = { getKeyPackagesByUserIds: async () => recipients() };
  const bundle = await m.createE2eeChannel('team', h.user, h.cid, ['bob']);
  m.client.post = async () => { throw new Error('response lost'); };
  const body = encodedBody(bundle, { name: 'preserved name', members: ['bob'], mls_enabled: true });
  await assert.rejects(m.postMlsBootstrap(h.cid, m.client.baseURL + '/channels/team/' + h.user + '/query', body), /response lost/);
  const n = await h.restore(); let sent = 0, exists = false;
  const [pending] = await h.storage.listPendingMlsMutations();
  n.client.post = async (url, value) => { sent++; assert.deepEqual(value, body); assert.ok(url.endsWith(pending.request.query_path)); exists = true; };
  n.e2eeClient = { getGroupInfo: async () => { if (!exists) throw new Error('not found'); return infoProof(pending); } };
  await n._resumePendingMlsMutations(); await n._resumePendingMlsMutations();
  assert.equal(sent, 1); assert.equal(n.getEpoch(h.cid), 1);
  assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
});
test('HTTP 200 and a matching numeric epoch cannot accept another creator artifact', async () => {
  const h = await harness(), m = await h.manager();
  m.e2eeClient = { getKeyPackagesByUserIds: async () => recipients(), getGroupInfo: async () => ({ epoch: 1, group_info: new Uint8Array([1]) }) };
  const bundle = await m.createE2eeChannel('team', h.user, h.cid, ['bob']);
  await assert.rejects(m.postMlsBootstrap(h.cid, m.client.baseURL + '/channels/team/' + h.user + '/query', encodedBody(bundle)), /outcome_pending/);
  assert.equal(m.getEpoch(h.cid), 0); assert.equal((await h.storage.listPendingMlsMutations()).length, 1);
});
test('binding checkpoint failure and mismatched bundle never issue HTTP', async () => {
  const h = await harness(), m = await h.manager(); let posts = 0;
  m.e2eeClient = { getKeyPackagesByUserIds: async () => recipients() }; m.client.post = async () => { posts++; };
  const bundle = await m.createE2eeChannel('team', h.user, h.cid, ['bob']);
  const path = m.client.baseURL + '/channels/team/' + h.user + '/query';
  await assert.rejects(m.postMlsBootstrap(h.cid, path, encodedBody({ ...bundle, welcome: new Uint8Array([1]) })), /does not match/);
  h.storage.saveMlsMutationCheckpoint = async () => { throw new Error('disk failed'); };
  await assert.rejects(m.postMlsBootstrap(h.cid, path, encodedBody(bundle)), /disk failed/);
  assert.equal(m._pendingMlsMutations.get(h.cid).request.query_path, undefined);
  m.e2eeClient.getGroupInfo = async () => { throw new Error('not created'); };
  await m._resumePendingMlsMutations();
  assert.equal(posts, 0);
});
test('failed KeyPackage fetch does not replace or strand a bootstrap group', async () => {
  const h = await harness(), m = await h.manager();
  m.e2eeClient = { getKeyPackagesByUserIds: async () => { throw new Error('offline'); } };
  await assert.rejects(m.createE2eeChannel('team', h.user, h.cid, ['bob']), /offline/);
  assert.equal(m.groups.has(h.cid), false);
  m.e2eeClient.getKeyPackagesByUserIds = async () => recipients();
  await m.createE2eeChannel('team', h.user, h.cid, ['bob']);
  assert.equal((await h.storage.listPendingMlsMutations()).length, 1);
});
for (const boundary of ['accepted', 'merged']) {
  test(`bootstrap crash at ${boundary} checkpoint recovers the same provider candidate`, async () => {
    const h = await harness(), m = await h.manager();
    m.e2eeClient = { getKeyPackagesByUserIds: async () => recipients() };
    await m.createE2eeChannel('team', h.user, h.cid, ['bob']);
    const [pending] = await h.storage.listPendingMlsMutations();
    const save = h.storage.saveMlsMutationCheckpoint.bind(h.storage);
    h.storage.saveMlsMutationCheckpoint = async cp => {
      if (boundary === 'accepted' && cp.pending?.accepted) { await save(cp); throw new Error('renderer crashed'); }
      if (boundary === 'merged' && !cp.pending) throw new Error('renderer crashed');
      return save(cp);
    };
    await assert.rejects(m.reconcileMlsBootstrapWelcome(h.cid, welcomeProof(pending)), /renderer crashed/);
    h.storage.saveMlsMutationCheckpoint = save;
    const n = await h.restore(); await n._resumePendingMlsMutations();
    assert.equal(n.getEpoch(h.cid), 1); assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
  });
}
async function batchFixture(h, m) {
  const fixtures = [];
  for (const generation of [0, 1]) {
    const cid = 'topic:' + h.user + '-' + generation, p = new wasm.Provider(), owner = new wasm.Identity(p, 'owner');
    const id = new Uint8Array([9, 7, seq]);
    const group = generation ? wasm.Group.create_with_group_id(p, owner, id) : wasm.Group.create_with_cid(p, owner, cid);
    const bundle = group.commit_pending_proposals(p, owner); group.merge_pending_commit(p);
    fixtures.push({ cid, p, owner, group, info: { epoch: 1, is_stale: false, group_generation: generation,
      group_id: generation ? id : null, group_info: bundle.group_info } });
  }
  m._resolveChannelE2eeGroupId = cid => cid;
  m.e2eeClient = { getGroupInfo: async (_type, id) => fixtures.find(f => f.cid === 'topic:' + id).info };
  return fixtures;
}
for (const boundary of ['unknown', 'accepted', 'merged']) {
  test(`real batch external join ${boundary}: restore staged N+1 and actually merge before decrypt`, async () => {
    const h = await harness(), m = await h.manager(), fixtures = await batchFixture(h, m);
    m.e2eeClient.batchExternalJoinTopics = async (_type, _id, body) => {
      for (const b of body.topics) {
        const f = fixtures.find(f => f.cid === b.topic_cid);
        f.group.process_message(f.p, b.commit);
      }
      throw new Error('lost batch response');
    };
    await assert.rejects(m.batchExternalJoinTopics('team', 'parent', fixtures.map(f => f.cid)), /lost batch response/);
    const pending = await h.storage.listPendingMlsMutations();
    assert.equal(pending.length, 2); assert.ok(pending.every(p => p.expected_epoch === 1));
    const save = h.storage.saveMlsMutationCheckpoint.bind(h.storage);
    if (boundary !== 'unknown') {
      h.storage.saveMlsMutationCheckpoint = async cp => {
        if (boundary === 'accepted' && cp.pending?.accepted) { await save(cp); throw new Error('crashed'); }
        if (boundary === 'merged' && !cp.pending) throw new Error('crashed');
        return save(cp);
      };
      await assert.rejects(m.reconcileOwnMlsCommit(pending[0].cid, { epoch: 2, group_generation: pending[0].group_generation,
        group_id: pending[0].group_id, commit: pending[0].commit }), /crashed/);
      h.storage.saveMlsMutationCheckpoint = save;
    }
    const n = await h.restore();
    for (const p of await h.storage.listPendingMlsMutations()) {
      await assert.rejects(n.processOwnMlsCommit(p.cid, { epoch: 2, group_generation: p.group_generation, group_id: p.group_id,
        commit: new Uint8Array([1]) }), /outcome_pending/);
      await n.reconcileOwnMlsCommit(p.cid, { epoch: 2, group_generation: p.group_generation, group_id: p.group_id, commit: p.commit });
      const f = fixtures.find(f => f.cid === p.cid);
      const encrypted = f.group.create_message(f.p, f.owner, new TextEncoder().encode('joined epoch two'));
      const decoded = n.groups.get(p.cid).process_message(n.provider, encrypted);
      assert.equal(new TextDecoder().decode(decoded.content), 'joined epoch two');
      assert.equal((await h.storage.loadExternalJoinReadiness(p.cid)).first_decryptable_epoch, 2);
    }
    assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
  });
}
test('partial batch success merges only its exact epoch; ambiguous topics survive for sync', async () => {
  const h = await harness(), m = await h.manager(), fixtures = await batchFixture(h, m);
  m.e2eeClient.batchExternalJoinTopics = async () => ({ results: [
    { topic_cid: fixtures[0].cid, success: true, epoch: 2 },
    { topic_cid: fixtures[1].cid, success: false, error: 'delivery pending' },
  ] });
  await m.batchExternalJoinTopics('team', 'parent', fixtures.map(f => f.cid));
  const [pending] = await h.storage.listPendingMlsMutations();
  assert.equal(pending.cid, fixtures[1].cid);
  assert.equal((await h.storage.loadExternalJoinReadiness(fixtures[0].cid)).first_decryptable_epoch, 2);
  const result = await m.joinExternal('topic', fixtures[1].cid.slice(6), fixtures[1].cid);
  assert.equal(result.status, 'needs_retry');
});
test('batch retry after reload sends each exact saved Commit without another GroupInfo/join', async () => {
  const h = await harness(), m = await h.manager(), fixtures = await batchFixture(h, m);
  m.e2eeClient.batchExternalJoinTopics = async () => { throw new Error('crash before HTTP'); };
  await assert.rejects(m.batchExternalJoinTopics('team', 'parent', fixtures.map(f => f.cid)));
  const pending = await h.storage.listPendingMlsMutations(), n = await h.restore(); let sends = 0;
  n.e2eeClient = { batchExternalJoinTopics: async (_type, _id, body) => {
    sends++; assert.equal(body.topics.length, 1);
    const original = pending.find(p => p.cid === body.topics[0].topic_cid);
    assert.deepEqual(body.topics[0].commit, original.commit);
    return { results: [{ topic_cid: original.cid, success: true, epoch: 2 }] };
  } };
  await n._resumePendingMlsMutations(); await n._resumePendingMlsMutations();
  assert.equal(sends, 2); assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
});
test('join readiness and provider remain atomic when final checkpoint aborts', async () => {
  const h = await harness();
  await h.storage.saveProviderState(h.user, 'device', new Uint8Array([1]));
  const prior = { cid: h.cid, status: 'joined_external', first_decryptable_epoch: 4, updated_at: 1 };
  await h.storage.saveExternalJoinReadiness(prior);
  await assert.rejects(h.storage.saveMlsMutationCheckpoint({
    user_id: h.user, device_id: 'device', provider_bytes: new Uint8Array([2]), cid: h.cid,
    marker: () => {}, pending: null, readiness: { ...prior, first_decryptable_epoch: 1 },
  }));
  assert.deepEqual(await h.storage.loadProviderState(h.user, 'device'), new Uint8Array([1]));
  assert.deepEqual(await h.storage.loadExternalJoinReadiness(h.cid), prior);
});

for (const generation of [0, 1]) {
  for (const boundary of ['unknown', 'accepted', 'merged']) {
    test(`single external join generation ${generation} ${boundary}: exact journal restores and decrypts`, async () => {
      const h = await harness(), m = await h.manager(), fixtures = await batchFixture(h, m);
      const f = fixtures[generation];
      m.e2eeClient.externalJoin = async (_type, _id, body) => {
        f.group.process_message(f.p, body.commit);
        throw new Error('lost single response');
      };
      await assert.rejects(m.joinExternal('topic', f.cid.slice(6), f.cid), /lost single response/);
      const [pending] = await h.storage.listPendingMlsMutations();
      assert.equal(pending.request.kind, 'external_join');
      assert.equal(pending.expected_epoch, 1);
      assert.equal((await m.joinExternal('topic', f.cid.slice(6), f.cid)).status, 'needs_retry');
      assert.equal(await h.storage.loadExternalJoinReadiness(f.cid), null);
      assert.throws(() => m.encryptMessage(f.cid, { text: 'unsafe' }), /outcome_pending/);
      const save = h.storage.saveMlsMutationCheckpoint.bind(h.storage);
      if (boundary !== 'unknown') {
        h.storage.saveMlsMutationCheckpoint = async cp => {
          if (boundary === 'accepted' && cp.pending?.accepted) { await save(cp); throw new Error('crashed'); }
          if (boundary === 'merged' && !cp.pending) throw new Error('crashed');
          return save(cp);
        };
        await assert.rejects(m.reconcileOwnMlsCommit(f.cid, { epoch: 2, group_generation: generation,
          group_id: pending.group_id, commit: pending.commit }), /crashed/);
        h.storage.saveMlsMutationCheckpoint = save;
      }
      const n = await h.restore();
      await assert.rejects(n.processOwnMlsCommit(f.cid, { epoch: 2, group_generation: generation,
        group_id: pending.group_id, commit: new Uint8Array([1]) }), /outcome_pending/);
      await n.reconcileOwnMlsCommit(f.cid, { epoch: 2, group_generation: generation,
        group_id: pending.group_id, commit: pending.commit });
      const encrypted = f.group.create_message(f.p, f.owner, new TextEncoder().encode('single join recovered'));
      assert.equal(new TextDecoder().decode(n.groups.get(f.cid).process_message(n.provider, encrypted).content), 'single join recovered');
      assert.equal((await h.storage.loadExternalJoinReadiness(f.cid)).first_decryptable_epoch, 2);
      assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
    });
  }
}
test('single join prepared before HTTP retries only the exact saved request after reload', async () => {
  const h = await harness(), m = await h.manager(), [f] = await batchFixture(h, m);
  m.e2eeClient.externalJoin = async () => { throw new Error('crash before HTTP'); };
  await assert.rejects(m.joinExternal('topic', f.cid.slice(6), f.cid));
  const [pending] = await h.storage.listPendingMlsMutations(), n = await h.restore(); let sends = 0;
  n.e2eeClient = { externalJoin: async (type, id, body) => {
    sends++; assert.equal(type, 'topic'); assert.equal(id, f.cid.slice(6));
    assert.deepEqual(body.commit, pending.commit); assert.equal(body.epoch, 2);
    f.group.process_message(f.p, body.commit); return {};
  } };
  await n._resumePendingMlsMutations(); await n._resumePendingMlsMutations();
  assert.equal(sends, 1); assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
  const encrypted = f.group.create_message(f.p, f.owner, new TextEncoder().encode('exact retry'));
  assert.equal(new TextDecoder().decode(n.groups.get(f.cid).process_message(n.provider, encrypted).content), 'exact retry');
});
test('single join cannot send when staged checkpoint fails or an adapter lacks mutation journals', async () => {
  const h = await harness(), m = await h.manager(), [f] = await batchFixture(h, m); let sends = 0, gets = 0;
  m.e2eeClient.externalJoin = async () => { sends++; };
  h.storage.saveMlsMutationCheckpoint = async () => { throw new Error('checkpoint abort'); };
  await assert.rejects(m.joinExternal('topic', f.cid.slice(6), f.cid), /checkpoint abort/);
  assert.equal(sends, 0); assert.equal(m.groups.has(f.cid), false);
  m.storage = { saveJoinCheckpoint: async () => {} };
  m.e2eeClient.getGroupInfo = async () => { gets++; return f.info; };
  await assert.rejects(m.joinExternal('topic', f.cid.slice(6), f.cid), /atomic MLS mutation/);
  assert.equal(gets, 0); assert.equal(sends, 0);
});
test('single join in flight cannot be resent by sync', async () => {
  const h = await harness(), m = await h.manager(), [f] = await batchFixture(h, m);
  let sends = 0, release; const gate = new Promise(r => { release = r; });
  m.ensureKeyPackagesFromServer = async () => {};
  m.e2eeClient.externalJoin = async (_type, _id, body) => {
    sends++; await gate; f.group.process_message(f.p, body.commit); return {};
  };
  const joining = m.joinExternal('topic', f.cid.slice(6), f.cid);
  while (!sends) await new Promise(r => setTimeout(r, 1));
  await m._resumePendingMlsMutations(); assert.equal(sends, 1);
  release(); assert.equal((await joining).status, 'joined_external');
  assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
});
test('single initial authorization rejection clears candidate; timeout and retry rejection retain it', async () => {
  for (const status of [403, 408, 429]) {
    const h = await harness(), m = await h.manager(), [f] = await batchFixture(h, m);
    m.e2eeClient.externalJoin = async () => { throw { response: { status }, message: 'rejected' }; };
    await assert.rejects(m.joinExternal('topic', f.cid.slice(6), f.cid));
    assert.equal(m.groups.has(f.cid), status !== 403);
    assert.equal((await h.storage.listPendingMlsMutations()).length, status === 403 ? 0 : 1);
    if (status !== 403) {
      const n = await h.restore();
      n.e2eeClient = { externalJoin: async () => { throw { response: { status: 403 } }; } };
      await n._resumePendingMlsMutations();
      assert.equal((await h.storage.listPendingMlsMutations()).length, 1);
      assert.equal(await h.storage.loadExternalJoinReadiness(f.cid), null);
    }
  }
});
test('single join accepted-pending receipt merges durably before GroupInfo upload', async () => {
  const h = await harness(), m = await h.manager(), [f] = await batchFixture(h, m);
  const welcomeCursor = { created_at: '2026-10-06T00:00:00Z', event_id: 'welcome-boundary' };
  await h.storage.saveExternalJoinReadiness({ cid: f.cid, status: 'pending_external_join',
    reason: 'NoMatchingKeyPackage', welcome_epoch: 1, welcome_event_cursor: welcomeCursor, updated_at: 1 });
  m.ensureKeyPackagesFromServer = async () => {};
  m.e2eeClient.externalJoin = async (_type, _id, body) => {
    f.group.process_message(f.p, body.commit);
    throw { response: { status: 503, data: { reason: 'mls_transition_pending', retryable: true,
      epoch: 2, operation_id: '5e5634dc-2461-40d1-841c-ec3b1402a0ad' } } };
  };
  const joined = await m.joinExternal('topic', f.cid.slice(6), f.cid);
  assert.equal(joined.status, 'joined_external'); assert.equal(joined.epoch, 2);
  assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
  assert.equal((await h.storage.loadExternalJoinReadiness(f.cid)).first_decryptable_epoch, 2);
  const readiness = await h.storage.loadExternalJoinReadiness(f.cid);
  assert.equal(readiness.reason, 'NoMatchingKeyPackage');
  assert.deepEqual(readiness.welcome_event_cursor, welcomeCursor);
});
test('definitive stale-epoch rejection permits a fresh single join without an orphan candidate', async () => {
  const h = await harness(), m = await h.manager(), [f] = await batchFixture(h, m); let sends = 0;
  m.ensureKeyPackagesFromServer = async () => {};
  m.e2eeClient.externalJoin = async (_type, _id, body) => {
    if (++sends === 1) {
      const next = f.group.commit_pending_proposals(f.p, f.owner); f.group.merge_pending_commit(f.p);
      f.info = { ...f.info, epoch: 2, group_info: next.group_info };
      throw { response: { status: 400, data: { ermis_code: 4, message: 'epoch_stale: expected 3, got 2' } } };
    }
    f.group.process_message(f.p, body.commit); return {};
  };
  const result = await m.joinExternal('topic', f.cid.slice(6), f.cid);
  assert.equal(sends, 2); assert.equal(result.epoch, 3);
  assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
  assert.equal((await h.storage.loadExternalJoinReadiness(f.cid)).first_decryptable_epoch, 3);
  const encrypted = f.group.create_message(f.p, f.owner, new TextEncoder().encode('fresh after rejection'));
  assert.equal(new TextDecoder().decode(m.groups.get(f.cid).process_message(m.provider, encrypted).content), 'fresh after rejection');
});
