import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager, IndexedDBEncryptionStorage, sha256Hex} = createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
const binary = fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url));
await init({module_or_path: binary}); let sequence = 0;
const latch = () => {let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve};};
const enc = encodeURIComponent;
async function fixture(count = 1) {
  const user = 'continuation-lifecycle-' + ++sequence, device = 'device', s = new IndexedDBEncryptionStorage(user), m = new EncryptionManager(), cids = [], events = [];
  Object.assign(m, {userId:user, deviceId:device, storage:s, _injectedWasm:wasm, _wasmArtifactSha256:sha256Hex(binary)});
  await m._initWasm(); await m._initIdentity();
  m.client = {activeChannels:{}, dispatchEvent:e => events.push(e)};
  for (let i = 0; i < count; i++) {
    const cid = 'team:' + user + '-' + String(i).padStart(3, '0'), group = wasm.Group.create_with_cid(m.provider, m.identity, cid);
    cids.push(cid); m.groups.set(cid, group);
    m._groupGenerations.set(cid, {cid, group_generation:0, group_id:null, current_epoch:0, status:'active', updated_at:1});
    await s.saveGroupState(cid, m._groupGenerations.get(cid));
    m.client.activeChannels[cid] = {data:{mls_enabled:true}, state:{members:{[user]:{user_id:user, created_at:'2026-10-15T00:00:00Z'}}}};
    await s.saveRecoveryControlCheckpoint({version:1, user_id:user, device_id:device, cid,
      signing_identity_sha256:sha256Hex(m.identity.signature_public_key()), group_generation:0,
      incident_id:'00000000-0000-4000-8000-000000000001', recovery_action:'repair', recovery_revision:'1',
      repair_retry_until:new Date(Date.now() + 900000).toISOString()});
    await m._loadRecoveryControl(cid);requireValidationMetadata(m,cid);
  }
  const kp = m.identity.key_package(m.provider), ref = kp.hash_ref(m.provider); kp.free();
  await m._persistProviderStrict(); m.initialized = true; m._armValidationAckRetry = () => {};
  let gets = 0, posts = 0, discoveries = 0, observations = 0;
  m.e2eeClient = {
    getGroupInfo:async (_type, id) => {gets++; const cid = 'team:' + id, bytes = m.groups.get(cid).export_group_info(m.provider, m.identity, true);
      return {group_info:bytes, epoch:0, group_generation:0, group_id:null, hash:sha256Hex(bytes), is_stale:false};},
    acknowledgeGroupInfoValidation:async () => {posts++; return {accepted:true, idempotent:false, recovery_action:'none', recovery_revision:'9'};},
    discoverMlsRecovery:async batch => {discoveries++; return {protocol_version:1, capability:{protocol_version:1}, states:Object.fromEntries(batch.map(cid => [cid,
      {result:'state', generation:{group_generation:0, group_id:null, current_epoch:0, membership_version:'1', state:'ready', reason:'group_info_missing', retryable:true}, group_info_refresh:null}]))};},
    observeGroupInfoRefresh:async () => {observations++; return {request:null};}, reserveGroupInfoRefreshClaim:async () => {assert.fail('unexpected claim');}, submitReservedGroupInfo:async () => {assert.fail('unexpected upload');},
  };
  const cid = cids[0], c = m._getRecoveryDiscoveryCoordinator(); c.arm = () => {};
  const gi = m._createDurableGroupInfoRepair(); m._groupInfoRepair = gi; gi.arm = () => {};
  const bytes = m.provider.to_bytes(), base = await s.loadProviderCheckpoint(user, device);
  return {m,s,user,device,cid,cids,events,ref,bytes,base,gi,get gets(){return gets;},get posts(){return posts;},get discoveries(){return discoveries;},get observations(){return observations;}};
}
async function put(h, key, value) {const db = await h.s.openDB(); await new Promise((yes,no) => {const tx = db.transaction('meta','readwrite');
  value === undefined ? tx.objectStore('meta').delete(key) : tx.objectStore('meta').put(value,key); tx.oncomplete = yes; tx.onabort = () => no(tx.error);});}
async function get(h, key) {const db = await h.s.openDB(); return new Promise((yes,no) => {const tx=db.transaction('meta','readonly'), r=tx.objectStore('meta').get(key);tx.oncomplete=()=>yes(r.result??null);tx.onabort=()=>no(tx.error);});}
async function dispositions(h) {const db = await h.s.openDB(), prefix = `recovery_work_disposition:v1:${enc(h.device)}:`;
  return new Promise((yes,no) => {const tx=db.transaction('meta','readonly'),r=tx.objectStore('meta').getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));tx.oncomplete=()=>yes(r.result);tx.onabort=()=>no(tx.error);});}
async function ack(h, cid = h.cid) {const old = h.m._validationAckAdmissionWork; h.m._validationAckAdmissionWork=Promise.resolve();
  try{await h.m.validateAndQueueGroupInfoAck('team',cid.slice(5),cid);}finally{h.m._validationAckAdmissionWork=old;}
  return h.s.loadGroupInfoValidationAckCheckpoint(cid,h.device);}
async function seed(h,lane,cid=h.cid) {
  let row, primary, due;
  if(lane==='discovery') {const c=h.m._getRecoveryDiscoveryCoordinator();c.arm=()=>{};await c.enqueue([cid]);row=(await h.s.loadRecoveryDiscoveryWork(h.device,[cid]))[cid];primary=`mls_discovery:v1:${enc(h.device)}:${enc(cid)}`;due=`mls_discovery_due:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}`;}
  if(lane==='gi'||lane==='legacy_gi') {const request={request_id:crypto.randomUUID(),minimum_epoch:0,deadline_at:new Date(Date.now()+600000).toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),reason:'group_info_stale',attempt_count:0,group_generation:0};
    await h.gi.applyAuthoritativeSnapshot({[cid]:request});primary=`gi_work:v1:${enc(h.device)}:${enc(cid)}:${enc(request.request_id)}`;row=await get(h,primary);due=`gi_work_due:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}:${enc(request.request_id)}`;
    if(lane==='legacy_gi'){primary=`group_info_refresh:v1:${cid}:${request.request_id}`;row=await get(h,primary);due=primary;}}
  if(lane==='admission') {await h.m.refreshE2eeState(cid);row=await h.s.loadGroupInfoValidationAdmission(cid,h.device);primary=`gi_validation_admission:v1:${enc(h.device)}:${enc(cid)}`;due=`gi_validation_admission_pending:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}`;}
  if(lane==='ack') {row=await ack(h,cid);primary=`gi_validation_ack:v1:${enc(h.device)}:${enc(cid)}`;due=`gi_validation_ack_pending:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}`;}
  return {row,primary,due};
}
async function privatePreserved(h) {assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.deepEqual(await h.s.loadProviderState(h.user,h.device),h.bytes);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);}

test('future ACK lease keeps a wake after clock rollback without sending or changing the job',async()=>{
 const h=await fixture(),job=await ack(h),owner=await h.m._captureValidationAckWork(h.cid,true);
 const future=await owner.save({...job,retry_at:Date.now()+120000});let armed=0;h.m._armValidationAckRetry=()=>{armed++;};
 await h.m._drainGroupInfoValidationAcks();assert.equal(armed,1);assert.equal(h.posts,0);
 assert.deepEqual(await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device),future);await privatePreserved(h);await h.s.close();
});

test('startup retains a wake for a future durable admission with empty RAM intake',async()=>{
 const h=await fixture(),job=await seed(h,'admission'),owner=await h.m._captureValidationAdmissionWork(h.cid);
 await owner.save({kind:'defer',now:Date.now()+90000,pause:false});const future=await get(h,job.primary);
 h.m._validationAckAdmissions.clear();h.m._validationAckAdmissionSeen.clear();let armed=0;h.m._armValidationAckRetry=()=>{armed++;};
 await h.m._drainValidationAckAdmissions();assert.ok(armed>=1);assert.equal(h.gets,0);assert.equal(h.posts,0);
 assert.deepEqual(await get(h,job.primary),future);await privatePreserved(h);await h.s.close();
});

test('admission backoff cannot block an independently due ACK',async()=>{
 const h=await fixture(2);await seed(h,'admission',h.cids[0]);const pending=await ack(h,h.cids[1]);
 h.m._validationAckAdmissionScope=[h.m.userId,h.m.deviceId,h.m.identity,h.m.storage,h.m.e2eeClient,h.m._wasmArtifactSha256];
 h.m._validationAckAdmissionNextAt=Date.now()+30000;const beforeGets=h.gets;
 await h.m._drainValidationAckAdmissions();assert.equal(h.gets,beforeGets);assert.equal(h.posts,1);
 const done=await h.s.loadGroupInfoValidationAckCheckpoint(h.cids[1],h.device);assert.equal(done.job_id,pending.job_id);assert.equal(done.outcome,'accepted');await privatePreserved(h);await h.s.close();
});

test('one CID restoration failure retains its obligation and lets admission and ACK peers finish',async()=>{
 const h=await fixture(3),bad=await seed(h,'admission',h.cids[0]);await seed(h,'admission',h.cids[1]);await ack(h,h.cids[2]);
 h.m.groups.delete(h.cids[0]);h.m._recoveryControls.delete(h.cids[0]);
 const restore=h.m._restoreRecoveryWorkCid.bind(h.m);h.m._restoreRecoveryWorkCid=async cid=>{if(cid===h.cids[0])throw Error('injected CID read failure');return restore(cid);};
 await assert.rejects(h.m._drainValidationAckAdmissions());assert.equal(h.posts,2);assert.equal(h.gets,2);
 assert.deepEqual(await get(h,bad.primary),bad.row);assert.deepEqual(await get(h,bad.due),bad.row);await privatePreserved(h);await h.s.close();
});

test('public admission scan failure still drains independently owned ACK and returns original error',async()=>{
 const h=await fixture(),pending=await ack(h),failure=Error('injected admission scan failure');
 const scan=h.s.takeRecoveryWorkPage.bind(h.s);h.s.takeRecoveryWorkPage=async(...args)=>{if(args[2]==='admission')throw failure;return scan(...args);};
 await assert.rejects(h.m._drainValidationAckAdmissions(),e=>e===failure);assert.equal(h.posts,1);
 assert.equal((await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device)).job_id,pending.job_id);await privatePreserved(h);await h.s.close();
});

test('simultaneous public lane failures retain the original admission error and exact ACK obligation',async()=>{
 const h=await fixture(),pending=await ack(h),failure=Error('first admission scan failure');let armed=0;
 h.m._armValidationAckRetry=()=>{armed++;};h.s.takeRecoveryWorkPage=async(...args)=>{if(args[2]==='admission')throw failure;throw Error('independent ACK scan failed too');};
 await assert.rejects(h.m._drainValidationAckAdmissions(),e=>e===failure);assert.equal(h.posts,0);assert.ok(armed>=1);
 assert.deepEqual(await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device),pending);await privatePreserved(h);await h.s.close();
});

test('restore-observed cross-tab private winner immediately fences current and late Ready',async()=>{
 const h=await fixture(2);await h.m.refreshE2eeState(h.cids[0]);assert.equal(h.m.getE2eeState(h.cids[0]).state,'ready');
 const seen=[];h.m.subscribeE2eeState(h.cids[0],s=>seen.push(s));h.m.groups.delete(h.cids[1]);h.m._recoveryControls.delete(h.cids[1]);
 const peer=new IndexedDBEncryptionStorage(h.user),base=await peer.loadProviderCheckpoint(h.user,h.device),p=wasm.Provider.from_bytes(h.bytes),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p),ref=kp.hash_ref(p);kp.free();
 await peer.saveProviderState(h.user,h.device,p.to_bytes(),{expected_revision:base.revision,next_revision:crypto.randomUUID()});const winner=await peer.loadProviderCheckpoint(h.user,h.device);
 await assert.rejects(h.m._restoreRecoveryWorkCid(h.cids[1]));assert.notEqual(h.m.getE2eeState(h.cids[0]).state,'ready');
 const late=[];h.m.subscribeE2eeState(h.cids[0],s=>late.push(s));assert.notEqual(late[0].state,'ready');assert.notEqual(seen.at(-1).state,'ready');
 assert.deepEqual(await peer.loadProviderCheckpoint(h.user,h.device),winner);assert.equal(i.owns_key_package_ref(p,ref),true);assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);
 i.free();p.free();await peer.close();await h.s.close();
});

for(const replacement of ['account','device','transport','provider','artifact'])test('failed admission scan cannot start independent ACK under replacement '+replacement,async()=>{
 const h=await fixture(),job=await ack(h),entered=latch(),gate=latch();
 const scan=h.s.takeRecoveryWorkPage.bind(h.s);h.s.takeRecoveryWorkPage=async(...args)=>{if(args[2]==='admission'){entered.resolve();await gate.promise;throw Error('old scan failed');}return scan(...args);};
 const work=h.m._drainValidationAckAdmissions(),rejected=assert.rejects(work);await entered.promise;
 const promise=Promise.resolve();h.m._validationAckAdmissionWork=promise;
 if(replacement==='account')h.m.userId='another';if(replacement==='device')h.m.deviceId='another';if(replacement==='transport')h.m.e2eeClient={};
 if(replacement==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.bytes);if(replacement==='artifact')h.m._wasmArtifactSha256='f'.repeat(64);
 gate.resolve();await rejected;assert.equal(h.posts,0);assert.equal(h.m._validationAckAdmissionWork,promise);
 assert.deepEqual(await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device),job);assert.deepEqual(await h.s.loadProviderState(h.user,h.device),h.bytes);await h.s.close();
});


// Explicit crypto-invalid fixture metadata; missing/stale GI alone never authorizes ACK work.
function requireValidationMetadata(m,cid) {
 const marker=m._groupGenerations.get(cid),control=m._recoveryControls.get(cid);if(!marker||!control)return;
 m._channelE2ee.set(cid,{cid,group_generation:marker.group_generation,group_id:marker.group_id?Buffer.from(marker.group_id).toString('base64'):null,epoch:marker.current_epoch,
  group_info:{status:'validation_required',ready:false,epoch:marker.current_epoch,last_uploaded_at:null,refresh_requested:false},
  recovery:{action:control.recovery_action,incident_id:control.incident_id,revision:control.recovery_revision,repair_retry_until:control.repair_retry_until}});
}
