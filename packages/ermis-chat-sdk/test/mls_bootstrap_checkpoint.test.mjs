import acceptedFixture from './accepted_protocol_fixture.cjs';
const {accepted, processOwnAccepted} = acceptedFixture;
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const require = createRequire(import.meta.url);
const { EncryptionManager, IndexedDBEncryptionStorage, sha256Hex } = require('../dist/index.cjs');
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
    const durable = await storage.loadProviderCheckpoint(user, 'device');
    m._providerDurableBase = {storage, userId:user, deviceId:'device', revision:durable.revision};
    await storage.saveIdentity(user, 'device', identityBytes);
    m._wasmArtifactSha256 = sha256Hex(fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url)));
    m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
    m.safeArchiveCurrentEpoch = async () => {}; m.safeArchiveCurrentEpochForCid = async () => {};
    m._cleanupEvictedGhosts = async () => {}; m._uploadGroupInfo = async () => {};
    const channel = {}; m._getActiveChannel = () => channel; m._getMembershipCreatedAt = () => '2026-10-06T00:00:00Z';
    m._syncChannelFromCursor = async () => {};
    m.client = { baseURL: 'http://fixture/v1', post: async () => ({}) };
    await m._persistProviderStrict();
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
    for (const job of await storage.listExternalJoinCandidateCheckpoints()) {
      m._validateExternalJoinCandidate(job); m._externalJoinCandidates.set(job.cid, job);
    }
    for (const cid of await storage.listGroupCids()) {
      if (m.groups.has(cid)) continue;
      const marker = await storage.loadGroupState(cid);
      m.groups.set(cid, marker.group_generation ? wasm.Group.load_with_group_id(m.provider,marker.group_id) : wasm.Group.load(m.provider,cid));
      m._groupGenerations.set(cid,marker);
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
    await assert.rejects(() => m._prepareApplicationSend({e2ee_group_id: cid, payload: {text: 'blocked'}}), /outcome_pending/);
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
  assert.equal(m._providerPersistenceUncertain, true);
  const restored = await h.restore();
  restored.e2eeClient = { getGroupInfo: async () => { throw new Error('not created'); } };
  await restored._resumePendingMlsMutations();
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
// DEC084 topic joins use ExternalJoinCandidateCheckpoint and canonical per-topic receipts.
// Restart, unknown/accepted/aborted activation and owner races are exercised by
// owned_external_join + external_join_candidate_checkpoint, including the batch helper.
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

async function singleExternalFixture(h, m) {
  const fixtures = await batchFixture(h, m);
  for (const f of fixtures) if (f.info.group_generation) await m._applyRecoveryControl(f.cid, {
    group_generation: f.info.group_generation, group_id: f.info.group_id, current_epoch: f.info.epoch,
    membership_version: '1', state: 'ready', reason: 'fixture', retryable: true,
    incident_id: '00000000-0000-4000-8000-000000000062', recovery_action: 'repair', recovery_revision: '1',
    repair_retry_until: new Date(Date.now() + 900000).toISOString(),
  });
  return fixtures;
}
function unknownReceipt(f,op) {
  return {version:1,operation_id:op,cid:f.cid,state:'outcome_unknown',delivery_pending:false,
    group_generation:null,epoch:null,group_id:null,commit_sha256:null,event_id:null,acceptance_context:null};
}
function receiptFor(f,body) {
  const cp=accepted({_groupGenerations:new Map()},f.cid,body.commit,body.epoch,body.group_generation || 0).acceptanceContext;
  return {version:1,operation_id:body.operation_id,cid:f.cid,state:'accepted',delivery_pending:true,
    group_generation:body.group_generation || 0,epoch:body.epoch,group_id:body.group_id || null,
    commit_sha256:cp.payload_sha256,group_info_sha256:sha256Hex(body.group_info),event_id:cp.event_id,acceptance_context:cp};
}
for (const generation of [0, 1]) {
  for (const boundary of ['unknown', 'activation_failed', 'readback_failed']) {
    test(`single external join generation ${generation} ${boundary}: isolated candidate restores and decrypts`, {timeout:5000}, async () => {
      const h=await harness(),m=await h.manager(),fixtures=await singleExternalFixture(h,m),f=fixtures[generation];let body;
      m.e2eeClient.getExternalJoinReceipt=async (_t,_id,op)=>boundary==='unknown' || !body ? unknownReceipt(f,op) : receiptFor(f,body);
      m.e2eeClient.externalJoin=async (_t,_id,b)=>{body=b;f.group.process_message(f.p,b.commit);throw Error('lost single response');};
      const save=h.storage.saveExternalJoinWork.bind(h.storage);
      h.storage.saveExternalJoinWork=async(...args)=>{
        if(boundary==='activation_failed'&&args[4].kind==='activate')throw Object.assign(Error('activation fault'),{checkpoint_outcome:'aborted'});
        const result=await save(...args);if(boundary==='readback_failed'&&args[4].kind==='activate')throw Error('readback fault');return result;
      };
      await assert.rejects(m.joinExternal('topic',f.cid.slice(6),f.cid));
      assert.equal(m.groups.has(f.cid),false,'pending candidate is never an active group');
      h.storage.saveExternalJoinWork=save;
      const job=await h.storage.loadExternalJoinCandidateCheckpoint(f.cid),n=await h.restore();
      n.e2eeClient={getExternalJoinReceipt:async()=>receiptFor(f,body),externalJoin:async()=>assert.fail('accepted receipt must not regenerate/resend')};
      if (job) {await n._resumeExternalJoinCandidates();assert.equal(n._externalJoinCandidates.size,0);}
      else assert.equal(boundary,'readback_failed');
      assert.equal(n.getEpoch(f.cid),2);
      const encrypted=f.group.create_message(f.p,f.owner,new TextEncoder().encode('single join recovered'));
      assert.equal(new TextDecoder().decode(n.groups.get(f.cid).process_message(n.provider,encrypted).content),'single join recovered');
      assert.equal((await h.storage.loadExternalJoinReadiness(f.cid)).first_decryptable_epoch,2);
      assert.equal((await h.storage.loadExternalJoinReceipt(f.cid)).operation_id,body.operation_id);
      assert.equal(await h.storage.loadExternalJoinCandidateCheckpoint(f.cid),null);
    });
  }
}
test('single join prepared before HTTP retries only the exact saved request after reload', {timeout:5000}, async()=>{
  const h=await harness(),m=await h.manager(),[f]=await singleExternalFixture(h,m);
  m.e2eeClient.getExternalJoinReceipt=async(_t,_id,op)=>unknownReceipt(f,op);
  m.e2eeClient.externalJoin=async()=>{throw Error('crash before HTTP');};
  await assert.rejects(m.joinExternal('topic',f.cid.slice(6),f.cid));
  const pending=await h.storage.loadExternalJoinCandidateCheckpoint(f.cid),n=await h.restore();let sends=0,acceptedBody;
  n.e2eeClient={getExternalJoinReceipt:async(_t,_id,op)=>acceptedBody ? receiptFor(f,acceptedBody) : unknownReceipt(f,op),externalJoin:async(type,id,body)=>{
    sends++;assert.equal(type,'topic');assert.equal(id,f.cid.slice(6));assert.deepEqual(body.commit,pending.body.commit);assert.equal(body.operation_id,pending.body.operation_id);
    f.group.process_message(f.p,body.commit);acceptedBody=body;
  }};
  await n._resumeExternalJoinCandidates();await n._resumeExternalJoinCandidates();assert.equal(sends,1);
  assert.equal(await h.storage.loadExternalJoinCandidateCheckpoint(f.cid),null);
});
test('single join cannot send when candidate checkpoint fails or an adapter lacks receipt checkpoints', {timeout:5000}, async()=>{
  const h=await harness(),m=await h.manager(),[f]=await singleExternalFixture(h,m);let sends=0,gets=0;
  m.e2eeClient.getExternalJoinReceipt=async(_t,_id,op)=>{gets++;return unknownReceipt(f,op);};m.e2eeClient.externalJoin=async()=>{sends++;};
  h.storage.saveExternalJoinWork=async()=>{throw Object.assign(Error('checkpoint abort'),{checkpoint_outcome:'aborted'});};
  await assert.rejects(m.joinExternal('topic',f.cid.slice(6),f.cid),/checkpoint abort/);assert.equal(sends,0);assert.equal(gets,0);
  m.storage={saveJoinCheckpoint:async()=>{},saveMlsMutationCheckpoint:async()=>{},listPendingMlsMutations:async()=>[]};
  await assert.rejects(m.joinExternal('topic',f.cid.slice(6),f.cid),e=>e.code==='client_upgrade_required');
});
test('single join in flight cannot be resent by sync', {timeout:5000}, async()=>{
  const h=await harness(),m=await h.manager(),[f]=await singleExternalFixture(h,m);let sends=0,release,entered,body;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  m.ensureKeyPackagesFromServer=async()=>{};
  m.e2eeClient.getExternalJoinReceipt=async(_t,_id,op)=>body ? receiptFor(f,body) : unknownReceipt(f,op);
  m.e2eeClient.externalJoin=async(_t,_id,b)=>{sends++;entered();await gate;f.group.process_message(f.p,b.commit);body=b;};
  const joining=m.joinExternal('topic',f.cid.slice(6),f.cid);await started;
  await m._resumeExternalJoinCandidates();assert.equal(sends,1);release();assert.equal((await joining).status,'joined_external');
});
test('single HTTP rejection and ambiguous retry retain isolated candidate until canonical receipt', {timeout:5000}, async()=>{
  for (const status of [403,408,429]) {
    const h=await harness(),m=await h.manager(),[f]=await singleExternalFixture(h,m);
    m.e2eeClient.getExternalJoinReceipt=async(_t,_id,op)=>unknownReceipt(f,op);m.e2eeClient.externalJoin=async()=>{throw {response:{status}};};
    await assert.rejects(m.joinExternal('topic',f.cid.slice(6),f.cid),e=>e.code==='transport_unknown');
    const prior=await h.storage.loadExternalJoinCandidateCheckpoint(f.cid);assert.equal(m.groups.has(f.cid),false);
    const n=await h.restore();n.e2eeClient=m.e2eeClient;await n._resumeExternalJoinCandidates();
    assert.equal((await h.storage.loadExternalJoinCandidateCheckpoint(f.cid)).body.operation_id,prior.body.operation_id);
    assert.equal(await h.storage.loadExternalJoinReadiness(f.cid),null);
  }
});
test('single accepted-pending receipt activates durably with inline GroupInfo', {timeout:5000}, async()=>{
  const h=await harness(),m=await h.manager(),[f]=await singleExternalFixture(h,m);let body;
  const cursor={created_at:'2026-10-06T00:00:00Z',event_id:'welcome-boundary'};
  await h.storage.saveExternalJoinReadiness({cid:f.cid,status:'pending_external_join',reason:'NoMatchingKeyPackage',welcome_epoch:1,welcome_event_cursor:cursor,updated_at:1});
  m.ensureKeyPackagesFromServer=async()=>{};
  m.e2eeClient.getExternalJoinReceipt=async(_t,_id,op)=>body ? receiptFor(f,body) : unknownReceipt(f,op);
  m.e2eeClient.externalJoin=async(_t,_id,b)=>{f.group.process_message(f.p,b.commit);body=b;throw {response:{status:503,data:{reason:'mls_transition_pending',epoch:2,operation_id:b.operation_id}}};};
  const joined=await m.joinExternal('topic',f.cid.slice(6),f.cid);assert.equal(joined.status,'joined_external');
  const readiness=await h.storage.loadExternalJoinReadiness(f.cid);assert.equal(readiness.first_decryptable_epoch,2);assert.deepEqual(readiness.welcome_event_cursor,cursor);
  assert.equal(await h.storage.loadExternalJoinCandidateCheckpoint(f.cid),null);
});
test('stale epoch HTTP response without a canonical rejected receipt cannot mint another candidate', {timeout:5000}, async()=>{
  const h=await harness(),m=await h.manager(),[f]=await singleExternalFixture(h,m);let sends=0;
  m.e2eeClient.getExternalJoinReceipt=async(_t,_id,op)=>unknownReceipt(f,op);
  m.e2eeClient.externalJoin=async()=>{sends++;throw {response:{status:400,data:{message:'epoch_stale: expected 3, got 2'}}};};
  await assert.rejects(m.joinExternal('topic',f.cid.slice(6),f.cid),e=>e.code==='transport_unknown');
  const original=await h.storage.loadExternalJoinCandidateCheckpoint(f.cid);
  await assert.rejects(m.joinExternal('topic',f.cid.slice(6),f.cid),e=>e.code==='transport_unknown');
  assert.equal((await h.storage.loadExternalJoinCandidateCheckpoint(f.cid)).body.operation_id,original.body.operation_id);assert.equal(sends,2);
  assert.equal(m.groups.has(f.cid),false);
});

function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
async function bindingFixture() {
  const h = await harness(), m = await h.manager();
  m.e2eeClient = {getKeyPackagesByUserIds: async () => recipients(), getGroupInfo: async () => {throw Error('not confirmed');}};
  const bundle = await m.createE2eeChannel('team', h.user, h.cid, ['bob']);
  return {...h, m, payload: encodedBody(bundle, {name: 'original'}), url: m.client.baseURL + '/channels/team/' + h.user + '/query'};
}
const scopeChanged = error => error.code === 'recovery_scope_changed';
for (const field of ['client', 'e2eeClient', 'deviceId', '_wasmArtifactSha256']) {
  for (const outcome of ['success', 'error']) {
    test(`bound bootstrap ${outcome} POST cannot affect replacement ${field} or release its sender`, async () => {
      const f = await bindingFixture(), entered = deferred(), release = deferred();
      let confirms = 0, marks = 0;
      f.m.e2eeClient.getGroupInfo = async () => {confirms++; throw Error('must not confirm');};
      f.m._markMlsMutationPending = () => {marks++;};
      f.m.client.post = async () => {entered.resolve(); await release.promise; if(outcome === 'error') throw Error('old HTTP'); return {};};
      const work = f.m.postMlsBootstrap(f.cid, f.url, f.payload), rejected = assert.rejects(work, scopeChanged);
      await entered.promise;
      f.m[field] = typeof f.m[field] === 'object' ? {...f.m[field]} : 'replacement';
      const owner = {}; f.m._bootstrapSendingOwners.set(f.cid, owner); f.m._sendingMlsMutations.add(f.cid);
      const pending = f.m._pendingMlsMutations.get(f.cid), bytes = f.m._activeProvider.to_bytes();
      release.resolve(); await rejected;
      assert.equal(confirms, 0); assert.equal(marks, 0); assert.equal(f.m.getEpoch(f.cid), 0);
      assert.equal(f.m._pendingMlsMutations.get(f.cid), pending); assert.deepEqual(f.m._activeProvider.to_bytes(), bytes);
      assert.equal(f.m._bootstrapSendingOwners.get(f.cid), owner); assert.equal(f.m._sendingMlsMutations.has(f.cid), true);
      assert.equal((await f.storage.listPendingMlsMutations())[0].request.query_body.data.name, 'original');
    });
  }
}
for (const field of ['pending', 'marker', 'readiness']) {
  test(`general CAS checkpoint rejects committed ${field} corruption with unchanged provider bytes`, async () => {
    const f = await bindingFixture(), save = f.storage.saveMlsMutationCheckpoint.bind(f.storage);
    const pending = f.m._pendingMlsMutations.get(f.cid), before = f.m._activeProvider.to_bytes();
    const readiness = {cid: f.cid, status: 'joined_external', reason: 'manual_external_join', updated_at: 1};
    f.storage.saveMlsMutationCheckpoint = async cp => {
      const changed = structuredClone(cp);
      if(field === 'pending') changed.pending.request.channel_id = 'wrong';
      if(field === 'marker') changed.marker.current_epoch = 99;
      if(field === 'readiness') changed.readiness.reason = 'wrong';
      await save(changed);
    };
    await assert.rejects(f.m._writeMlsMutation(f.cid, pending, readiness), e => e.code === 'provider_persistence_uncertain');
    assert.equal(f.m._providerPersistenceUncertain, true); assert.deepEqual(f.m._activeProvider.to_bytes(), before);
    assert.equal(f.m._pendingMlsMutations.get(f.cid), pending);
    assert.throws(() => f.m.provider, e => e.code === 'provider_persistence_uncertain');
    assert.deepEqual(await f.storage.loadProviderState(f.user, 'device'), before);
  });
}
test('binding readback failure retains original live journal and issues no HTTP', async () => {
  const f = await bindingFixture(), save = f.storage.saveMlsMutationCheckpoint.bind(f.storage);
  const pending = f.m._pendingMlsMutations.get(f.cid); let posts = 0;
  f.m.client.post = async () => {posts++;};
  f.storage.saveMlsMutationCheckpoint = async cp => {
    const changed = structuredClone(cp); changed.pending.request.query_body.data.name = 'corrupt'; await save(changed);
  };
  await assert.rejects(f.m.postMlsBootstrap(f.cid, f.url, f.payload), e => e.code === 'provider_persistence_uncertain');
  assert.equal(posts, 0); assert.equal(pending.request.query_path, undefined);
  assert.equal(f.m._pendingMlsMutations.get(f.cid), pending); assert.equal(f.m._providerPersistenceUncertain, true);
  assert.equal((await f.storage.listPendingMlsMutations())[0].request.query_body.data.name, 'corrupt');
});
test('caller and adapter mutation cannot alter frozen bootstrap binding or proof', async () => {
  const f = await bindingFixture(), save = f.storage.saveMlsMutationCheckpoint.bind(f.storage);
  const entered = deferred(), release = deferred(); let sent;
  f.storage.saveMlsMutationCheckpoint = async cp => {
    entered.resolve(); await release.promise; await save(cp); cp.pending.request.query_body.data.name = 'adapter changed';
  };
  f.m.client.post = async (_url, body) => {sent = structuredClone(body); body.data.name = 'transport changed'; throw Error('lost reply');};
  const work = f.m.postMlsBootstrap(f.cid, f.url, f.payload), rejected = assert.rejects(work, /lost reply/);
  await entered.promise; f.payload.data.name = 'caller changed';
  assert.equal(f.m._pendingMlsMutations.get(f.cid).request.query_path, undefined);
  release.resolve(); await rejected;
  assert.equal(sent.data.name, 'original');
  assert.equal(f.m._pendingMlsMutations.get(f.cid).request.query_body.data.name, 'original');
  assert.equal((await f.storage.listPendingMlsMutations())[0].request.query_body.data.name, 'original');
});
test('replacement journal while binding is queued survives without durable overwrite or HTTP', async () => {
  const f = await bindingFixture(), entered = deferred(), release = deferred();
  const blocker = f.m._withProviderMutation(async () => {entered.resolve(); await release.promise;});
  await entered.promise; const before = await f.storage.loadProviderCheckpoint(f.user, 'device'); let posts = 0;
  f.m.client.post = async () => {posts++;};
  const work = f.m.postMlsBootstrap(f.cid, f.url, f.payload), rejected = assert.rejects(work, scopeChanged);
  const replacement = structuredClone(f.m._pendingMlsMutations.get(f.cid)); replacement.request.channel_id = 'new owner';
  f.m._pendingMlsMutations.set(f.cid, replacement); release.resolve(); await blocker; await rejected;
  assert.equal(f.m._pendingMlsMutations.get(f.cid), replacement); assert.equal(posts, 0);
  assert.deepEqual(await f.storage.loadProviderCheckpoint(f.user, 'device'), before);
});
test('same payload retry cannot change the durable create route', async () => {
  const f = await bindingFixture(); let posts = 0;
  f.m.client.post = async () => {posts++; throw Error('lost reply');};
  await assert.rejects(f.m.postMlsBootstrap(f.cid, f.url, f.payload), /lost reply/);
  const before = await f.storage.loadProviderCheckpoint(f.user, 'device');
  await assert.rejects(f.m.postMlsBootstrap(f.cid, f.url + '/other', f.payload), /preserve.*route/);
  assert.equal(posts, 1); assert.deepEqual(await f.storage.loadProviderCheckpoint(f.user, 'device'), before);
});
for (const capability of ['providerCheckpointCASVersion', 'mlsMutationCheckpointVersion', 'verifyMlsMutationCheckpoint', 'saveMlsMutationCheckpoint', 'listPendingMlsMutations']) {
  test(`bootstrap missing ${capability} fails typed upgrade before binding or HTTP`, async () => {
    const f = await bindingFixture(), pending = f.m._pendingMlsMutations.get(f.cid); let posts = 0, writes = 0;
    f.storage.saveMlsMutationCheckpoint = async () => {writes++;}; f.storage[capability] = undefined;
    f.m.client.post = async () => {posts++;};
    await assert.rejects(f.m.postMlsBootstrap(f.cid, f.url, f.payload), e => e.code === 'client_upgrade_required');
    assert.equal(posts, 0); assert.equal(writes, 0); assert.equal(pending.request.query_path, undefined);
    assert.equal(f.m._sendingMlsMutations.size, 0);
  });
}
for (const replacement of ['scope', 'journal']) {
  test(`bootstrap confirmation does not settle ${replacement} replaced during GET`, async () => {
    const f = await bindingFixture(), entered = deferred(), release = deferred();
    const pending = f.m._pendingMlsMutations.get(f.cid), proof = infoProof(pending); let finishes = 0;
    f.m.e2eeClient.getGroupInfo = async () => {entered.resolve(); await release.promise; return proof;};
    f.m._finishMlsMutation = async () => {finishes++;};
    const work = f.m._confirmMlsBootstrap(f.cid), rejected = assert.rejects(work, scopeChanged); await entered.promise;
    if(replacement === 'scope') f.m.client = {...f.m.client};
    else f.m._pendingMlsMutations.set(f.cid, structuredClone(pending));
    release.resolve(); await rejected; assert.equal(finishes, 0); assert.equal(f.m.getEpoch(f.cid), 0);
    assert.equal((await f.storage.listPendingMlsMutations()).length, 1);
  });
}
test('initial preparation failure never clears a replacement pending group', async () => {
  const f = await bindingFixture(), pending = f.m._pendingMlsMutations.get(f.cid);
  f.m._pendingMlsMutations.delete(f.cid);
  const entered = deferred(), release = deferred(), save = f.storage.saveMlsMutationCheckpoint.bind(f.storage);
  f.storage.saveMlsMutationCheckpoint = async () => {entered.resolve(); await release.promise; throw Error('aborted write');};
  const work = f.m._prepareMlsMutation(f.cid, f.m._captureMlsPreparation(f.cid), (_provider, group) => ({group,
    marker: {...f.m._groupGenerations.get(f.cid)}, commit: pending.commit, ghosts: [], request: pending.request, expected_epoch: 0}));
  const rejected = assert.rejects(work, /aborted write/); await entered.promise;
  const replacement = structuredClone(pending), group = f.m.groups.get(f.cid), before = f.m._activeProvider.to_bytes();
  f.m._pendingMlsMutations.set(f.cid, replacement); release.resolve(); await rejected;
  assert.equal(f.m._pendingMlsMutations.get(f.cid), replacement); assert.equal(f.m.groups.get(f.cid), group);
  assert.deepEqual(f.m._activeProvider.to_bytes(), before); f.storage.saveMlsMutationCheckpoint = save;
});

test('same Client route change while binding is queued fails without persisting old route', async () => {
  const f = await bindingFixture(), entered = deferred(), release = deferred();
  const blocker = f.m._withProviderMutation(async () => {entered.resolve(); await release.promise;});
  await entered.promise; const before = await f.storage.loadProviderCheckpoint(f.user, 'device'); let posts = 0;
  f.m.client.post = async () => {posts++;};
  const work = f.m.postMlsBootstrap(f.cid, f.url, f.payload), rejected = assert.rejects(work, scopeChanged);
  f.m.client.baseURL = 'http://replacement/v1'; release.resolve(); await blocker; await rejected;
  assert.equal(posts, 0); assert.equal(f.m._pendingMlsMutations.get(f.cid).request.query_path, undefined);
  assert.deepEqual(await f.storage.loadProviderCheckpoint(f.user, 'device'), before);
});
test('identical replacement journal while binding is queued still rejects obsolete ownership', async () => {
  const f = await bindingFixture(), entered = deferred(), release = deferred();
  const blocker = f.m._withProviderMutation(async () => {entered.resolve(); await release.promise;});
  await entered.promise; const before = await f.storage.loadProviderCheckpoint(f.user, 'device'); let posts = 0;
  f.m.client.post = async () => {posts++;};
  const work = f.m.postMlsBootstrap(f.cid, f.url, f.payload), rejected = assert.rejects(work, scopeChanged);
  const replacement = structuredClone(f.m._pendingMlsMutations.get(f.cid));
  f.m._pendingMlsMutations.set(f.cid, replacement); release.resolve(); await blocker; await rejected;
  assert.equal(f.m._pendingMlsMutations.get(f.cid), replacement); assert.equal(posts, 0);
  assert.deepEqual(await f.storage.loadProviderCheckpoint(f.user, 'device'), before);
});
test('preparation cleanup cannot clear a replacement handle on the same provider', async () => {
  const f = await bindingFixture(), pending = f.m._pendingMlsMutations.get(f.cid);
  f.m._pendingMlsMutations.delete(f.cid);
  const entered = deferred(), release = deferred();
  f.storage.saveMlsMutationCheckpoint = async () => {entered.resolve(); await release.promise; throw Error('aborted write');};
  const work = f.m._prepareMlsMutation(f.cid, f.m._captureMlsPreparation(f.cid), (_provider, group) => ({group,
    marker: {...f.m._groupGenerations.get(f.cid)}, commit: pending.commit, ghosts: [], request: pending.request, expected_epoch: 0}));
  const rejected = assert.rejects(work, /aborted write/); await entered.promise;
  const group = wasm.Group.load(f.m._activeProvider, f.cid), before = f.m._activeProvider.to_bytes();
  f.m.groups.set(f.cid, group); release.resolve(); await rejected;
  assert.equal(f.m.groups.get(f.cid), group); assert.deepEqual(f.m._activeProvider.to_bytes(), before);
  assert.equal(f.m._pendingMlsMutations.has(f.cid), false);
});

for(const target of ['marker','pending'])test(`bound request CAS preserves remote ${target} replacement without provider revision change`,async()=>{
 const f=await bindingFixture(),before=await f.storage.loadProviderCheckpoint(f.user,'device'),db=await f.storage.openDB(),pending=f.m._pendingMlsMutations.get(f.cid);const replacement=target==='marker'?{...f.m._groupGenerations.get(f.cid),updated_at:123}:{...structuredClone(pending),request:{...pending.request,query_path:'/replacement'}};
 await new Promise(r=>{const tx=db.transaction(target==='marker'?'groups':'meta','readwrite');tx.objectStore(target==='marker'?'groups':'meta').put(replacement,target==='marker'?f.cid:'mls_mutation:v1:'+f.cid);tx.oncomplete=r;});let posts=0;f.m.client.post=async()=>{posts++;};
 await assert.rejects(f.m.postMlsBootstrap(f.cid,f.url,f.payload),e=>e.code==='provider_checkpoint_conflict'&&e.checkpoint_outcome==='aborted');assert.equal(posts,0);assert.equal(f.m._providerPersistenceUncertain,true);assert.deepEqual(await f.storage.loadProviderCheckpoint(f.user,'device'),before);assert.deepEqual(target==='marker'?await f.storage.loadGroupState(f.cid):(await f.storage.listPendingMlsMutations())[0],replacement);
});
for(const target of ['group','marker'])test(`bound bootstrap HTTP cannot recapture ${target} replacement as confirmation owner`,async()=>{
 const f=await bindingFixture(),entered=deferred(),release=deferred();let confirms=0;f.m.client.post=async()=>{entered.resolve();await release.promise;return {};};f.m.e2eeClient.getGroupInfo=async()=>{confirms++;return infoProof(f.m._pendingMlsMutations.get(f.cid));};
 const work=f.m.postMlsBootstrap(f.cid,f.url,f.payload),rejected=assert.rejects(work,scopeChanged);await entered.promise;if(target==='group')f.m.groups.set(f.cid,wasm.Group.load(f.m._activeProvider,f.cid));else f.m._groupGenerations.set(f.cid,structuredClone(f.m._groupGenerations.get(f.cid)));const group=f.m.groups.get(f.cid),marker=f.m._groupGenerations.get(f.cid),pending=f.m._pendingMlsMutations.get(f.cid);release.resolve();await rejected;assert.equal(confirms,0);assert.equal(f.m.groups.get(f.cid),group);assert.equal(f.m._groupGenerations.get(f.cid),marker);assert.equal(f.m._pendingMlsMutations.get(f.cid),pending);assert.equal((await f.storage.listPendingMlsMutations())[0].accepted,false);
});
test('bound request commit then throw fails closed and reload preserves exact bound body',async()=>{
 const f=await bindingFixture(),save=f.storage.saveMlsMutationCheckpoint.bind(f.storage),provider=f.m._activeProvider;let posts=0;f.storage.saveMlsMutationCheckpoint=async cp=>{await save(cp);throw Error('unknown committed binding');};f.m.client.post=async()=>{posts++;};await assert.rejects(f.m.postMlsBootstrap(f.cid,f.url,f.payload),/unknown committed binding/);assert.equal(posts,0);assert.equal(f.m._activeProvider,provider);assert.equal(f.m._providerPersistenceUncertain,true);const durable=(await f.storage.listPendingMlsMutations())[0];assert.equal(durable.request.query_path,f.url.slice(f.m.client.baseURL.length));assert.deepEqual(durable.request.query_body,f.payload);f.storage.saveMlsMutationCheckpoint=save;const restored=await f.restore();assert.deepEqual(restored._pendingMlsMutations.get(f.cid),durable);
});
