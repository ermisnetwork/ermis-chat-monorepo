const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {webcrypto} = require('node:crypto');
require('fake-indexeddb/auto'); globalThis.crypto ??= webcrypto;
const {EncryptionManager, IndexedDBEncryptionStorage, E2eeClient, sha256Hex} = require('../dist/encryption/index.cjs');
let unique = 0, wasmPromise;
async function fixture() {
  const wasm = await (wasmPromise ??= (async () => {
    const w = await import(pathToFileURL(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm.js')));
    await w.default({module_or_path: fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'))}); return w;
  })());
  const user = `external-bob-${++unique}`, device = 'device', cid = `team:external-${unique}`;
  const a = new wasm.Provider(), alice = new wasm.Identity(a, 'alice'), group = wasm.Group.create_with_cid(a, alice, cid);
  const storage = new IndexedDBEncryptionStorage(user);
  async function manager() {
    const m = new EncryptionManager(); Object.assign(m, {userId: user, deviceId: device, storage});
    m._injectedWasm = wasm; m._wasmArtifactSha256 = sha256Hex(fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'))); await m._initWasm(); await m._initIdentity(); await m._persistProviderStrict();
    m.initialized = true; m.safeArchiveCurrentEpoch = async () => {}; m.ensureKeyPackagesFromServer = async () => {};
    return m;
  }
  const m = await manager(); let post = 0, body, receiptOverride, hideReceipt = false, uploadCalls = 0;
  const unknown = op => ({version:1,operation_id:op,cid,state:'outcome_unknown',delivery_pending:false,
    group_generation:null,epoch:null,group_id:null,commit_sha256:null,event_id:null,acceptance_context:null});
  const accepted = b => {
    const eventId = '00000000-0000-4000-8000-000000000001', hash = sha256Hex(b.commit);
    return {version:1,operation_id:b.operation_id,cid,state:'accepted',delivery_pending:true,group_generation:b.group_generation || 0,
      epoch:b.epoch,group_id:b.group_id || null,commit_sha256:hash,group_info_sha256:sha256Hex(b.group_info),event_id:eventId,
      acceptance_context:{version:1,event_id:eventId,cid,group_generation:b.group_generation || 0,epoch:b.epoch,
        accepted_at:Math.floor(Date.now()/1000),payload_sha256:hash,provenance:'bellboy_transition_v1'}};
  };
  const api = {
    getGroupInfo: async () => ({group_info:group.export_group_info(a,alice,true),epoch:Number(group.epoch()),hash:'fixture',is_stale:false,group_generation:0,group_id:null}),
    getExternalJoinReceipt: async (_type,_id,op) => receiptOverride ? receiptOverride(op) : body && !hideReceipt ? accepted(body) : unknown(op),
    externalJoin: async (_type,_id,b) => {post++; body=b;},
    uploadGroupInfo: async () => {uploadCalls++; throw Error('offline after acceptance');},
  };
  m.e2eeClient = api;
  return {m,manager,wasm,storage,user,device,cid,a,alice,group,api,accepted,unknown,
    post:()=>post,uploads:()=>uploadCalls,body:()=>body,setReceipt:fn=>receiptOverride=fn,hide:value=>hideReceipt=value};
}
const join = f => f.m.joinExternal('team',f.cid.slice(5),f.cid);

test('isolated candidate precedes HTTP; unknown/lost ACK survives restart and accepted receipt alone activates', async () => {
  const f=await fixture(), before=sha256Hex(f.m.provider.to_bytes());
  f.api.externalJoin=async (_t,_id,body) => {
    assert.equal(f.m._providerCheckpointInFlight,false);
    assert.equal(f.m.groups.has(f.cid),false);
    assert.equal(sha256Hex(f.m.provider.to_bytes()),before);
    const stored=await f.storage.loadExternalJoinCandidateCheckpoint(f.cid);
    assert.equal(stored.body.operation_id,body.operation_id); assert.equal(stored.commit_sha256,sha256Hex(body.commit));
    throw Error('lost ACK');
  };
  await assert.rejects(join(f),e=>e.code==='transport_unknown');
  const job=await f.storage.loadExternalJoinCandidateCheckpoint(f.cid);
  assert.equal(sha256Hex(f.m.provider.to_bytes()),before); assert.equal(f.m.groups.has(f.cid),false);
  const restarted=await f.manager(); restarted.e2eeClient={...f.api,getExternalJoinReceipt:async()=>f.accepted(job.body),externalJoin:async()=>assert.fail('must query accepted receipt before retry')};
  await restarted._restoreGroupsLocally(); assert.equal(restarted.groups.has(f.cid),false);
  await restarted._resumeExternalJoinCandidates();
  assert.equal(restarted.getEpoch(f.cid),job.body.epoch);
  assert.equal(await f.storage.loadExternalJoinCandidateCheckpoint(f.cid),null);
  assert.equal((await f.storage.loadExternalJoinReceipt(f.cid)).operation_id,job.body.operation_id);
  assert.equal((await f.storage.loadExternalJoinReadiness(f.cid)).first_decryptable_epoch,job.body.epoch);
  assert.equal(f.uploads(),0,'GI is already accepted atomically; no post-accept upload');
  const restored=f.wasm.Provider.from_bytes(await f.storage.loadProviderState(f.user,f.device));
  assert.equal(Number(f.wasm.Group.load(restored,f.cid).epoch()),job.body.epoch);
  await f.storage.close();
});

test('HTTP releases provider lock; rebase preserves a concurrently durably generated private KP', async () => {
  const f=await fixture(); let entered,release;
  const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const submit=f.api.externalJoin;
  f.api.externalJoin=async (...args)=>{await submit(...args);entered();await gate;};
  let uploaded;
  f.api.uploadKeyPackages=async ({key_packages},id)=>{uploaded=key_packages[0];return {batch_id:id,validation_version:1,stored:1,total_remaining:100,target:100,low_watermark:50,requested_delta:0,refill_generation:null};};
  const joining=join(f);await start;await f.m._uploadKeyPackages(1);release();await joining;
  const kp=f.wasm.KeyPackage.from_bytes(uploaded);
  assert(f.m.identity.owns_key_package_ref(f.m.provider,kp.hash_ref(f.m.provider)));
  assert.equal(f.m.getEpoch(f.cid),1);await f.storage.close();
});

test('save failure sends no HTTP; activation quota/clone error aborts all provider/receipt/group writes', async () => {
  const f=await fixture(), before=sha256Hex(f.m.provider.to_bytes());
  const save=f.storage.saveExternalJoinWork.bind(f.storage);
  f.storage.saveExternalJoinWork=async()=>{throw Object.assign(Error('quota before HTTP'),{checkpoint_outcome:'aborted'});};
  await assert.rejects(join(f),/quota before HTTP/);assert.equal(f.post(),0);
  assert.equal(sha256Hex(f.m.provider.to_bytes()),before);
  f.storage.saveExternalJoinWork=save;
  const activation=f.storage.saveExternalJoinActivationCheckpoint.bind(f.storage);
  f.storage.saveExternalJoinWork=async(...args)=>{if(args[4].kind==='activate')throw Object.assign(Error('activation quota'),{checkpoint_outcome:'aborted'});return save(...args);};
  await assert.rejects(join(f),/activation quota/);
  const job=await f.storage.loadExternalJoinCandidateCheckpoint(f.cid);
  assert.equal(f.m.groups.has(f.cid),false);assert.equal(sha256Hex(f.m.provider.to_bytes()),before);
  assert.equal(await f.storage.loadExternalJoinReceipt(f.cid),null);
  await assert.rejects(activation({user_id:f.user,device_id:f.device,cid:f.cid,provider_bytes:Uint8Array.of(99),
    generation:{cannotClone(){}},readiness:null},f.accepted(job.body),f.m.provider.to_bytes()));
  assert.equal(sha256Hex(await f.storage.loadProviderState(f.user,f.device)),before);
  assert.equal(await f.storage.loadGroupState(f.cid),null);assert.equal(await f.storage.loadExternalJoinReceipt(f.cid),null);
  assert.equal((await f.storage.loadExternalJoinCandidateCheckpoint(f.cid)).body.operation_id,job.body.operation_id);
  await f.storage.close();
});

test('receipt tamper and stale operation/provider CAS never publish or erase the candidate', async () => {
  const f=await fixture();f.hide(true);await assert.rejects(join(f),e=>e.code==='transport_unknown');
  const job=await f.storage.loadExternalJoinCandidateCheckpoint(f.cid),before=sha256Hex(f.m.provider.to_bytes());
  for (const change of [{commit_sha256:'0'.repeat(64)},{group_generation:1},{epoch:99},{operation_id:crypto.randomUUID()},
    {acceptance_context:{...f.accepted(job.body).acceptance_context,accepted_at:Math.floor(Date.now()/1000)+1000}}]) {
    await assert.rejects(f.m._activateExternalJoinCandidate(job,{...f.accepted(job.body),...change}),e=>e.code==='acceptance_metadata_invalid');
    assert.equal(sha256Hex(f.m.provider.to_bytes()),before);assert.equal(f.m.groups.has(f.cid),false);
  }
  const activate=f.storage.saveExternalJoinActivationCheckpoint.bind(f.storage);
  await assert.rejects(activate({user_id:f.user,device_id:f.device,cid:f.cid,provider_bytes:Uint8Array.of(88),readiness:null},
    f.accepted(job.body),Uint8Array.of(99)),/CAS failed/);
  assert.equal(sha256Hex(await f.storage.loadProviderState(f.user,f.device)),before);
  assert.equal((await f.storage.loadExternalJoinCandidateCheckpoint(f.cid)).body.operation_id,job.body.operation_id);
  await f.storage.close();
});

test('committed activation/readback failure blocks live mutation; startup restores durable group and receipt', async () => {
  const f=await fixture(),active=f.m.provider,before=sha256Hex(active.to_bytes());
  const save=f.storage.saveExternalJoinWork.bind(f.storage);
  f.storage.saveExternalJoinWork=async(...args)=>{const result=await save(...args);if(args[4].kind==='activate')throw Error('readback unavailable');return result;};
  await assert.rejects(join(f),/readback unavailable/);
  assert.equal(sha256Hex(active.to_bytes()),before);assert.equal(f.m.groups.has(f.cid),false);
  assert.throws(()=>f.m.provider,e=>e.code==='provider_persistence_uncertain');
  f.storage.saveExternalJoinWork=save;
  const restarted=await f.manager();await restarted._restoreGroupsLocally();
  assert.equal(restarted.getEpoch(f.cid),1);assert.equal(restarted._externalJoinCandidates.size,0);
  assert.equal((await f.storage.loadExternalJoinReceipt(f.cid)).state,'accepted');
  await f.storage.close();
});

test('Welcome during pending external acceptance stays installed; conflicting receipt remains pending without rollback', async () => {
  const f=await fixture();const kp=f.m.identity.key_package(f.m.provider);await f.m._persistProviderStrict();
  const invite=f.group.add_members(f.a,f.alice,[kp]);f.group.merge_pending_commit(f.a);
  let entered,release;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r),submit=f.api.externalJoin;
  f.api.externalJoin=async (...args)=>{await submit(...args);entered();await gate;};
  const joining=join(f);await start;
  await f.m.joinGroup(invite.welcome);const welcomeGroup=f.m.groups.get(f.cid),durable=sha256Hex(await f.storage.loadProviderState(f.user,f.device));
  release();await assert.rejects(joining,e=>e.code==='external_join_welcome_conflict');
  assert.equal(f.m.groups.get(f.cid),welcomeGroup);assert.equal(f.m.getEpoch(f.cid),1);
  assert.equal(sha256Hex(await f.storage.loadProviderState(f.user,f.device)),durable);
  assert(await f.storage.loadExternalJoinCandidateCheckpoint(f.cid));
  assert.throws(()=>f.m._assertNoPendingMlsMutation(f.cid),e=>e.code==='mls_mutation_outcome_pending');
  await f.storage.close();
});

test('HTTP receipt codec preserves operation UUID/context and decodes public GroupId without network', async () => {
  const calls=[],op=crypto.randomUUID();
  const client={baseURL:'https://bellboy.test',deviceId:'device',doAxiosRequest:async(method,url,data)=>{
    calls.push({method,url,data});return {version:1,operation_id:op,cid:'team:fixture',state:'accepted',group_id:'AQID',acceptance_context:{version:1}};
  }};
  const api=new E2eeClient(client,()=>({userId:'fixture',projectId:'00000000-0000-4000-8000-000000000083',deviceId:'device',identity:{},assertCurrent(){},assertRegistrationCurrent(){},async verifyDurable(){}})),receipt=await api.getExternalJoinReceipt('team','fixture',op);
  assert.equal(receipt.operation_id,op);assert.deepEqual(receipt.group_id,Uint8Array.of(1,2,3));
  assert(calls[0].url.endsWith(`/external_join/operations/${op}`));
  await assert.rejects(api.getExternalJoinReceipt('team','fixture','../wrong'));assert.equal(calls.length,1);
});

async function welcomeFixture(owned = false) {
  const f = await fixture();
  const inviteeProvider = owned ? f.m.provider : new f.wasm.Provider();
  const invitee = owned ? f.m.identity : new f.wasm.Identity(inviteeProvider, 'other-device');
  const packageBytes = invitee.key_package(inviteeProvider);
  if (owned) await f.m._persistProviderStrict();
  const bundle = f.group.add_members(f.a, f.alice, [packageBytes]); f.group.merge_pending_commit(f.a);
  const eventId = `welcome-${crypto.randomUUID()}`, createdAt = new Date().toISOString(), epoch = Number(f.group.epoch());
  const envelope = {event_id:eventId,cid:f.cid,group_generation:0,epoch};
  const context = {version:1,...envelope,accepted_at:Math.floor(Date.now()/1000),
    payload_sha256:sha256Hex(bundle.welcome),provenance:'bellboy_transition_v1'};
  const protocol = {type:'welcome',event_id:eventId,epoch,group_generation:0,welcome:bundle.welcome,
    ratchet_tree:f.group.export_ratchet_tree().to_bytes(),target_user_ids:[f.user],target_device_ids:[f.device],acceptance_context:context};
  return {...f,protocol,event:{type:'protocol',cid:f.cid,created_at:createdAt,event_id:eventId,data:protocol},
    options:{acceptanceContext:context,acceptanceEnvelope:envelope},cursor:{created_at:createdAt,event_id:eventId}};
}

test('typed failed Welcome freezes history; exact accepted activation atomically supersedes it and restart can advance', async () => {
  const f=await welcomeFixture(),start={created_at:'2026-10-08T00:00:00Z',event_id:'before-welcome'};
  const before=sha256Hex(f.m.provider.to_bytes());
  const blocked=await f.m._processChannelEvents(f.cid,[f.event],start);
  assert.equal(blocked.processedEvents,0);assert.deepEqual(blocked.processedEventCursor,start);
  assert.equal(sha256Hex(f.m.provider.to_bytes()),before);
  const pending=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);
  assert.equal(pending.status,'pending_external_join');assert.equal(pending.epoch,1);
  assert.equal((await f.storage.loadExternalJoinReadiness(f.cid)).welcome_generation,0);
  await join(f);
  const superseded=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);
  assert.equal(superseded.status,'superseded_by_recovery');assert.equal(superseded.checkpoint.receipt.operation_id,f.body().operation_id);
  assert.equal(superseded.checkpoint.receipt.epoch,2);assert.equal(superseded.checkpoint.marker.current_epoch,2);
  assert.equal((await f.storage.listWelcomeRecoveryCheckpoints(f.cid,f.device,100)).length,0);
  const restarted=await f.manager();await restarted._restoreGroupsLocally();
  const applied=await restarted._processChannelEvents(f.cid,[f.event],start);
  assert.equal(applied.processedEvents,1);assert.deepEqual(applied.processedEventCursor,f.cursor);
  assert.equal(restarted.getEpoch(f.cid),2);
  const record=structuredClone(superseded);record.checkpoint.receipt.commit_sha256='0'.repeat(64);
  const original=f.storage.loadExternalJoinWorkBase.bind(f.storage);
  f.storage.loadExternalJoinWorkBase=async(...args)=>{const base=await original(...args);base.welcome_primary[Object.keys(base.welcome_primary)[0]]=record;return base;};
  await assert.rejects(restarted.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),e=>e.code==='acceptance_metadata_invalid');
  f.storage.loadWelcomeRecoveryCheckpoint=original;
  await f.storage.close();
});

test('successful live Welcome checkpoint permits duplicate history without re-consuming KP; existing group alone is insufficient', async () => {
  const f=await welcomeFixture(true);
  assert.equal(await f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),'applied');
  const record=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);
  assert.equal(record.status,'applied');assert.equal(record.checkpoint.marker.current_epoch,1);
  assert.equal(await f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),'applied');
  const restarted=await f.manager();await restarted._restoreGroupsLocally();
  assert.equal(await restarted.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),'applied');
  const db=await f.storage.openDB();await new Promise((resolve,reject)=>{
    const tx=db.transaction('meta','readwrite');
    tx.objectStore('meta').delete(`welcome_recovery:v1:${encodeURIComponent(f.device)}:${encodeURIComponent(f.cid)}:${encodeURIComponent(f.cursor.event_id)}`);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });
  assert.equal(await restarted.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),'pending_external_join');
  assert.equal(restarted.getEpoch(f.cid),1,'a missing disposition cannot erase the successfully joined group');
  await f.storage.close();
});

test('metadata precedes bootstrap mutation; live device targeting and generic failures cannot manufacture a recovery record', async () => {
  const f=await welcomeFixture();let bootstrap=0;f.m.reconcileMlsBootstrapWelcome=async()=>bootstrap++;
  await assert.rejects(f.m.processMlsWelcome(f.cid,f.protocol,{},f.cursor),e=>e.code==='acceptance_metadata_invalid');
  assert.equal(bootstrap,0);assert.equal(await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id),null);
  assert.equal(await f.m.processMlsWelcome(f.cid,{...f.protocol,target_device_ids:['another-device']},f.options,f.cursor),'not_targeted');
  assert.equal(await f.storage.loadExternalJoinReadiness(f.cid),null);
  f.m.joinGroup=async()=>{const e=Error('storage failed');e.code='storage_error';throw e;};
  await assert.rejects(f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),e=>e.code==='storage_error');
  assert.equal(await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id),null);
  await f.storage.close();
});

test('failure-journal and superseded-disposition clone faults never advance cursor or partly activate provider', async () => {
  const f=await welcomeFixture();const original=f.storage.saveWelcomeWork.bind(f.storage);
  f.storage.saveWelcomeWork=async()=>{throw Object.assign(Error('Welcome journal quota'),{checkpoint_outcome:'aborted'});};
  await assert.rejects(f.m._processChannelEvents(f.cid,[f.event],{created_at:'2026-10-08T00:00:00Z',event_id:'before'}),/journal quota/);
  assert.equal(await f.storage.loadExternalJoinReadiness(f.cid),null);
  f.storage.saveWelcomeWork=original;
  await f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor);
  const activate=f.storage.saveExternalJoinWork.bind(f.storage),before=sha256Hex(f.m.provider.to_bytes());
  f.storage.saveExternalJoinWork=async(...args)=>{
    if(args[4].kind==='activate')args[4].checkpoint.welcome_dispositions[0].cannotClone=()=>{};
    return activate(...args);
  };
  await assert.rejects(join(f));
  assert.equal(f.m.groups.has(f.cid),false);assert.equal(sha256Hex(await f.storage.loadProviderState(f.user,f.device)),before);
  assert.equal(await f.storage.loadExternalJoinReceipt(f.cid),null);
  assert.equal((await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id)).status,'pending_external_join');
  assert(await f.storage.loadExternalJoinCandidateCheckpoint(f.cid));
  await f.storage.close();
});

test('multiple pending Welcome events retain exact identities; another generation is never superseded', async () => {
  const f=await welcomeFixture();
  await f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor);
  const pending=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);
  const second={...pending,event_cursor:{...f.cursor,event_id:'second-welcome'}},other={...pending,group_generation:1,event_cursor:{...f.cursor,event_id:'other-generation'}};
  const readiness=await f.storage.loadExternalJoinReadiness(f.cid);
  await f.storage.saveWelcomeFailureCheckpoint(second,readiness);await f.storage.saveWelcomeFailureCheckpoint(other,readiness);
  await join(f);
  assert.equal((await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,'second-welcome')).status,'superseded_by_recovery');
  assert.equal((await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,'other-generation')).status,'pending_external_join');
  assert.equal((await f.storage.listWelcomeRecoveryCheckpoints(f.cid,f.device,100)).length,1);
  const completed=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);
  await f.storage.saveWelcomeFailureCheckpoint(pending,readiness);
  assert.deepEqual(await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id),completed,'late failure cannot demote a committed disposition');
  await f.storage.close();
});

test('clearing buffered applications after a blocked Welcome cannot advance to the end of the page', async () => {
  const f=await welcomeFixture(),start={created_at:'2026-10-08T00:00:00Z',event_id:'before'};
  const message={id:'buffered-message',cid:f.cid,content_type:'mls',mls_ciphertext:'AQI=',mls_epoch:9,created_at:f.cursor.created_at};
  const snapshot=f.m._toPendingSnapshot(f.cid,'application',message,f.cursor.created_at,f.cursor.created_at);
  await f.storage.savePendingE2eeSnapshots(f.cid,[snapshot]);let calls=0;
  f.m.decryptApplicationMessages=async(_cid,messages)=>({decrypted:[],buffered:++calls===1?messages:[]});
  const result=await f.m._processChannelEvents(f.cid,[f.event,{type:'application',cid:f.cid,created_at:f.cursor.created_at,
    event_id:'after-welcome',data:{id:'after-welcome',content_type:'standard',text:'after',created_at:f.cursor.created_at}}],start);
  assert.equal(calls,2);assert.equal(result.bufferedMessages,0);
  assert.equal(result.processedEvents,0);assert.deepEqual(result.processedEventCursor,start);
  assert.equal(await f.storage.loadMessage('after-welcome'),null);
  await f.storage.close();
});


function rejected(f,job) {
  return {version:1,operation_id:job.body.operation_id,cid:f.cid,state:'rejected',delivery_pending:false,
    group_generation:job.marker.group_generation,epoch:job.body.epoch,group_id:job.marker.group_id,
    commit_sha256:job.commit_sha256,group_info_sha256:job.group_info_sha256,event_id:null,acceptance_context:null,rejection_reason:'head_conflict',rejected_at:new Date().toISOString()};
}

test('canonical head rejection journals before dropping only that candidate, with active KP/provider/cursor retained', async () => {
  const f=await fixture();f.hide(true);await assert.rejects(join(f),e=>e.code==='transport_unknown');
  const job=await f.storage.loadExternalJoinCandidateCheckpoint(f.cid),before=await f.storage.loadProviderState(f.user,f.device);
  const cursor={created_at:new Date().toISOString(),event_id:'00000000-0000-4000-8000-000000000001'};
  await f.storage.saveScopeSyncCursor(f.cid,cursor);
  f.setReceipt(()=>rejected(f,job));const posts=f.post();
  await assert.rejects(join(f),e=>e.code==='epoch_conflict');
  assert.equal(f.post(),posts);assert.equal(await f.storage.loadExternalJoinCandidateCheckpoint(f.cid),null);
  assert.equal((await f.storage.loadExternalJoinRejectionCheckpoint(f.cid,job.body.operation_id)).state,'rejected');
  assert.deepEqual(await f.storage.loadProviderState(f.user,f.device),before);assert.equal(f.m.groups.has(f.cid),false);
  assert.deepEqual(await f.storage.loadScopeSyncCursor(f.cid),cursor);assert.equal(await f.storage.loadExternalJoinReceipt(f.cid),null);
  assert.equal(f.m._externalJoinCandidates.has(f.cid),false);
  const restarted=await f.manager();await restarted._restoreGroupsLocally();assert.equal(restarted._externalJoinCandidates.has(f.cid),false);
  assert.equal((await f.storage.loadExternalJoinRejectionCheckpoint(f.cid,job.body.operation_id)).commit_sha256,job.commit_sha256);
  await f.storage.close();
});

test('tampered/future/unknown rejection cannot erase private candidate or advance cursor', async () => {
  const f=await fixture();f.hide(true);await assert.rejects(join(f),e=>e.code==='transport_unknown');
  const job=await f.storage.loadExternalJoinCandidateCheckpoint(f.cid),base=rejected(f,job);
  for(const change of [{commit_sha256:'0'.repeat(64)},{operation_id:crypto.randomUUID()},{cid:'team:other'},
    {epoch:99},{group_generation:1},{rejection_reason:'authorization_failed'},{delivery_pending:true},
    {event_id:crypto.randomUUID()},{acceptance_context:{}},{rejected_at:new Date(Date.now()+600_000).toISOString()},
    {group_id:Uint8Array.of(1)}]) {
    await assert.rejects(f.m._activateExternalJoinCandidate(job,{...base,...change}),e=>e.code==='acceptance_metadata_invalid');
    assert.equal((await f.storage.loadExternalJoinCandidateCheckpoint(f.cid)).body.operation_id,job.body.operation_id);
  }
  await f.storage.close();
});

test('rejection quota/clone/CAS/readback failures retain durable or live pending intent and never Ready', async () => {
  const f=await fixture();f.hide(true);await assert.rejects(join(f),e=>e.code==='transport_unknown');
  const job=await f.storage.loadExternalJoinCandidateCheckpoint(f.cid),receipt=rejected(f,job);
  const component=f.storage.saveExternalJoinRejectionCheckpoint.bind(f.storage),save=f.storage.saveExternalJoinRejectionWork.bind(f.storage);
  f.storage.saveExternalJoinRejectionWork=async()=>{throw Error('quota');};
  await assert.rejects(f.m._activateExternalJoinCandidate(job,receipt),/quota/);
  assert.equal((await f.storage.loadExternalJoinCandidateCheckpoint(f.cid)).body.operation_id,job.body.operation_id);
  f.storage.saveExternalJoinRejectionWork=save;
  await assert.rejects(component(job,{...receipt,cannotClone(){}}));
  assert.equal((await f.storage.loadExternalJoinCandidateCheckpoint(f.cid)).body.operation_id,job.body.operation_id);
  await assert.rejects(component({...job,device_id:'other'},receipt));
  const read=f.storage.loadExternalJoinRejectionCheckpoint.bind(f.storage);f.storage.saveExternalJoinRejectionWork=async(...args)=>{await save(...args);throw Object.assign(Error('lost full readback'),{code:'recovery_checkpoint_uncertain'});};
  await assert.rejects(f.m._activateExternalJoinCandidate(job,receipt),e=>e.code==='recovery_checkpoint_uncertain');
  assert.equal(f.m._externalJoinCandidates.has(f.cid),true);assert.equal(f.m.groups.has(f.cid),false);
  f.storage.saveExternalJoinRejectionWork=save;
  assert.equal((await read(f.cid,job.body.operation_id)).state,'rejected');
  await f.storage.close();
});

// DEC084 regression: GI is produced before HTTP and its receipt binding cannot be substituted.
test('inline GI belongs to the same isolated epoch and a forged GI digest cannot activate', async () => {
  const f = await fixture(); f.hide(true);
  await assert.rejects(join(f), e => e.code === 'transport_unknown');
  const job = await f.storage.loadExternalJoinCandidateCheckpoint(f.cid);
  assert(job.body.group_info instanceof Uint8Array); assert.equal(job.group_info_sha256, sha256Hex(job.body.group_info));
  const checkProvider = new f.wasm.Provider(), next = new f.wasm.Identity(checkProvider, 'next-joiner');
  const external = f.wasm.Group.join_external_with_policy(checkProvider, next, job.body.group_info, undefined, false);
  assert.equal(Number(external.group.epoch()), job.body.epoch + 1);
  await assert.rejects(f.m._activateExternalJoinCandidate(job, {...f.accepted(job.body), group_info_sha256: '0'.repeat(64)}), e => e.code === 'acceptance_metadata_invalid');
  assert.equal(f.m.groups.has(f.cid), false); assert.equal(f.uploads(), 0);
  await f.storage.close();
});
