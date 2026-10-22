import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager, IndexedDBEncryptionStorage, sha256Hex,newGroupInfoWork} = createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
const binary = fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url));
await init({module_or_path: binary}); let sequence = 0;
const latch = () => {let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve};};
const enc = encodeURIComponent;
async function fixture(count = 1) {
  const user = 'combined-lifecycle-' + ++sequence, device = 'device', s = new IndexedDBEncryptionStorage(user), m = new EncryptionManager(), cids = [], events = [];
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
    await m._loadRecoveryControl(cid);m._channelE2ee.set(cid,{cid,group_generation:0,group_id:null,epoch:0,group_info:{status:'validation_required',ready:false,epoch:0,last_uploaded_at:null,refresh_requested:false}});
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
    // Compatibility reader coverage: seed the old persisted format directly, never run retired orchestration.
    await h.s.saveGroupInfoRefreshRequest({...request,cid});
    const old=newGroupInfoWork({user_id:h.user,device_id:h.device,signing_identity_sha256:sha256Hex(h.m.identity.signature_public_key()),artifact_sha256:sha256Hex(binary)},
      {...request,cid},{markers:{[cid]:h.m._groupGenerations.get(cid)},controls:{[cid]:h.m._recoveryControls.get(cid)}},Date.now());
    await put(h,`gi_work:v1:${enc(h.device)}:${enc(cid)}:${enc(request.request_id)}`,old);
    await put(h,`gi_work_due:v1:${enc(h.device)}:${String(old.retry_at).padStart(16,'0')}:${enc(cid)}:${enc(request.request_id)}`,old);
    primary=`gi_work:v1:${enc(h.device)}:${enc(cid)}:${enc(request.request_id)}`;row=await get(h,primary);due=`gi_work_due:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}:${enc(request.request_id)}`;
    if(lane==='legacy_gi'){primary=`group_info_refresh:v1:${cid}:${request.request_id}`;row=await get(h,primary);due=primary;}}
  if(lane==='admission') {await h.m.refreshE2eeState(cid);row=await h.s.loadGroupInfoValidationAdmission(cid,h.device);primary=`gi_validation_admission:v1:${enc(h.device)}:${enc(cid)}`;due=`gi_validation_admission_pending:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}`;}
  if(lane==='ack') {row=await ack(h,cid);primary=`gi_validation_ack:v1:${enc(h.device)}:${enc(cid)}`;due=`gi_validation_ack_pending:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}`;}
  return {row,primary,due};
}
async function privatePreserved(h) {assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.deepEqual(await h.s.loadProviderState(h.user,h.device),h.bytes);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);}

for(const lane of ['discovery','gi','admission','ack'])for(const fault of ['unknown','corrupt','index_mismatch','scope','artifact','orphan'])test(lane+' '+fault+' gets exact durable disposition without deleting primary/private state',async()=>{
  const h=await fixture(),job=await seed(h,lane);let bad={...job.row};
  if(fault==='unknown')bad.version=99;if(fault==='corrupt')bad.retry_at=-1;if(fault==='index_mismatch')bad.job_id=crypto.randomUUID();if(fault==='scope')bad.user_id='other-account';if(fault==='artifact')bad.artifact_sha256='f'.repeat(64);
  if(fault==='orphan')await put(h,job.primary,undefined);await put(h,job.due,bad);
  const before=await get(h,job.primary);await h.m._maintainRecoveryWork(lane);
  assert.deepEqual(await get(h,job.primary),before);assert.equal(await get(h,job.due),null);
  const rows=await dispositions(h);assert.equal(rows.length,1);assert.deepEqual(rows[0].source,bad);assert.deepEqual(rows[0].primary,before);
  assert.equal(rows[0].reason,fault==='unknown'||fault==='artifact'?'upgrade':fault==='scope'?'scope':fault==='corrupt'?'corrupt':'index_mismatch');
  assert.equal('provider_bytes' in rows[0],false);assert.equal('identity_bytes' in rows[0],false);
  const restarted=new IndexedDBEncryptionStorage(h.user);assert.deepEqual(await restarted.loadProviderState(h.user,h.device),h.bytes);await privatePreserved(h);
  await h.m._maintainRecoveryWork(lane);assert.equal((await dispositions(h)).length,1);await restarted.close();await h.s.close();
});
for(const lane of ['discovery','gi','admission','ack','legacy_gi'])for(const fault of ['abort','readback','unknown','replacement'])test(lane+' disposition '+fault+' retains exact evidence, budget and winning state',async()=>{
  const h=await fixture(),job=await seed(h,lane),bad=lane==='legacy_gi'?{...job.row,minimum_epoch:-1}:{...job.row,version:99};await put(h,job.due,bad);
  const db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false;
  if(fault==='unknown'){const save=h.s.maintainRecoveryWork.bind(h.s);h.s.maintainRecoveryWork=async(...args)=>{await save(...args);throw Error('commit acknowledgement lost');};}
  else db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite'){
    if(fault==='abort')queueMicrotask(()=>tx.abort());else tx.addEventListener('complete',()=>{committed=true;if(fault==='replacement'){const winner=original('meta','readwrite');winner.objectStore('meta').put(job.row,job.due);}});
    }if(args[1]==='readonly'&&committed&&fault==='readback')queueMicrotask(()=>tx.abort());return tx;};
  await assert.rejects(h.m._maintainRecoveryWork(lane));db.transaction=original;
  assert.equal(h.m._providerPersistenceUncertain,false);assert.deepEqual(await get(h,job.due),fault==='abort'?bad:fault==='replacement'?job.row:null);
  const saved=await dispositions(h);assert.equal(saved.length,fault==='abort'?0:1);if(saved.length)assert.deepEqual(saved[0].source,bad);
  if(lane!=='legacy_gi')assert.deepEqual(await get(h,job.primary),job.row);await privatePreserved(h);await h.s.close();
});

test('canonical newer control archives pending ACK exactly and preserves the new independent intent',async()=>{
  const h=await fixture(),job=await seed(h,'ack'),before=job.row;
  const next={...h.m._recoveryControls.get(h.cid),recovery_revision:'2',incident_id:'00000000-0000-4000-8000-000000000002'};
  await h.s.saveRecoveryControlCheckpoint(next);await h.m._loadRecoveryControl(h.cid);
  await h.m._maintainRecoveryWork('ack');const retained=await dispositions(h);assert.equal(retained[0].reason,'superseded');assert.deepEqual(retained[0].source,before);assert.deepEqual(retained[0].primary,before);assert.equal(await get(h,job.primary),null);
  const fresh=await ack(h);assert.equal(fresh.recovery_revision,'2');assert.equal(fresh.attempts,0);assert.equal(fresh.request.incident_id,next.incident_id);assert.notEqual(fresh.job_id,before.job_id);
  assert.deepEqual((await dispositions(h))[0],retained[0]);assert.equal(h.posts,0);await privatePreserved(h);await h.s.close();
});

test('old/same control and arbitrary timeout cannot release an ambiguous ACK primary or reset its budget',async()=>{
  const h=await fixture(),job=await seed(h,'ack');h.m.e2eeClient.acknowledgeGroupInfoValidation=async()=>{throw Error('unknown network');};await h.m._drainGroupInfoValidationAcks();
  const pending=await get(h,job.primary);assert.equal(pending.attempts,1);await h.m._maintainRecoveryWork('ack');assert.deepEqual(await get(h,job.primary),pending);assert.deepEqual(await dispositions(h),[]);
  await h.s.saveRecoveryControlCheckpoint({...h.m._recoveryControls.get(h.cid),recovery_revision:'0'});await h.m._maintainRecoveryWork('ack');assert.deepEqual(await get(h,job.primary),pending);await privatePreserved(h);await h.s.close();
});

for(const scope of ['account','device','storage','identity','artifact','transport','provider','group','marker','control','membership'])test('held disposition rejects '+scope+' replacement before scheduling mutation',async()=>{
  const h=await fixture(),job=await seed(h,'discovery');await put(h,job.due,{...job.row,version:99});const entered=latch(),gate=latch(),save=h.s.maintainRecoveryWork.bind(h.s);
  h.s.maintainRecoveryWork=async(...args)=>{entered.resolve();await gate.promise;return save(...args);};
  const work=h.m._maintainRecoveryWork('discovery'),rejected=assert.rejects(work);await entered.promise;
  if(scope==='account')h.m.userId='other';if(scope==='device')h.m.deviceId='other';if(scope==='storage')h.m.storage=new IndexedDBEncryptionStorage(h.user);if(scope==='identity')h.m.identity=wasm.Identity.from_bytes(h.m._activeProvider,h.m.identity.to_bytes());if(scope==='artifact')h.m._wasmArtifactSha256='f'.repeat(64);if(scope==='transport')h.m.e2eeClient={};if(scope==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.bytes);if(scope==='group')h.m.groups.set(h.cid,wasm.Group.load(h.m._activeProvider,h.cid));if(scope==='marker')h.m._groupGenerations.set(h.cid,{...h.m._groupGenerations.get(h.cid),updated_at:2});if(scope==='control')h.m._recoveryControls.set(h.cid,{...h.m._recoveryControls.get(h.cid),recovery_revision:'2'});if(scope==='membership')h.m.client.activeChannels[h.cid].state.members[h.user]={user_id:h.user,created_at:'2026-10-15T01:00:00Z'};
  gate.resolve();await rejected;assert.deepEqual(await get(h,job.due),{...job.row,version:99});assert.deepEqual(await dispositions(h),[]);assert.deepEqual(await h.s.loadProviderState(h.user,h.device),h.bytes);await h.s.close();
});

test('cross-tab private winner fences current/late Ready and never gets imported over the winner',async()=>{
  const h=await fixture(),job=await seed(h,'discovery');await h.m.refreshE2eeState(h.cid);assert.equal(h.m.getE2eeState(h.cid).state,'ready');const seen=[];h.m.subscribeE2eeState(h.cid,s=>seen.push(s));
  await put(h,job.due,{...job.row,version:99});const peer=new IndexedDBEncryptionStorage(h.user),base=await peer.loadProviderCheckpoint(h.user,h.device),p=wasm.Provider.from_bytes(h.bytes),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p),ref=kp.hash_ref(p);kp.free();
  await peer.saveProviderState(h.user,h.device,p.to_bytes(),{expected_revision:base.revision,next_revision:crypto.randomUUID()});const winner=await peer.loadProviderCheckpoint(h.user,h.device);
  await assert.rejects(h.m._maintainRecoveryWork('discovery'));assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');const late=[];h.m.subscribeE2eeState(h.cid,s=>late.push(s));assert.notEqual(late[0].state,'ready');assert.notEqual(seen.at(-1).state,'ready');
  assert.deepEqual(await peer.loadProviderCheckpoint(h.user,h.device),winner);assert.equal(i.owns_key_package_ref(p,ref),true);assert.deepEqual(await get(h,job.due),{...job.row,version:99});assert.deepEqual(await dispositions(h),[]);i.free();p.free();await peer.close();await h.s.close();
});

test('blocked ACK CID cannot stop a later eligible ACK; both budgets and primary state survive',async()=>{
  const h=await fixture(2),first=await ack(h,h.cids[0]),second=await ack(h,h.cids[1]);const group=h.m.groups.get(h.cids[0]);h.m.groups.delete(h.cids[0]);
  // Keep the actual stored group absent as a scoped local restoration prerequisite.
  const restore=h.m._restoreRecoveryWorkCid.bind(h.m);h.m._restoreRecoveryWorkCid=async cid=>{if(cid!==h.cids[0])await restore(cid);};
  await h.m._drainGroupInfoValidationAcks();assert.equal(h.posts,1);const pending=await h.s.loadGroupInfoValidationAckCheckpoint(h.cids[0],h.device),done=await h.s.loadGroupInfoValidationAckCheckpoint(h.cids[1],h.device);
  assert.equal(pending.job_id,first.job_id);assert.equal(pending.attempts,0);assert.ok(pending.retry_at>first.retry_at);assert.equal(done.job_id,second.job_id);assert.equal(done.outcome,'accepted');h.m.groups.set(h.cids[0],group);await privatePreserved(h);await h.s.close();
});

test('unknown CID durable admission restores exact group/control before GET without private mutation',async()=>{
  const h=await fixture(),job=await seed(h,'admission');h.m.groups.delete(h.cid);h.m._groupGenerations.delete(h.cid);h.m._recoveryControls.delete(h.cid);
  await h.m._drainValidationAckAdmissions();assert.equal(h.gets,1);assert.equal(h.posts,1);assert.equal(h.m.groups.get(h.cid).epoch(),0n);assert.equal(h.m._recoveryControls.get(h.cid).recovery_revision,'1');
  assert.equal((await get(h,job.primary)).outcome,'prepared');await privatePreserved(h);await h.s.close();
});

test('combined valid GI/discovery/ACK backlog keeps independent bounds and progresses after corrupt heads',async()=>{
  const h=await fixture(8),heads={};for(const cid of h.cids){for(const lane of ['gi','discovery','ack']){const j=await seed(h,lane,cid);if(cid===h.cids[0])heads[lane]=j;}}
  for(const j of Object.values(heads))await put(h,j.due,{...j.row,version:99});
  const c=h.m._getRecoveryDiscoveryCoordinator();c.arm=()=>{};await c.run();await h.m._maintainRecoveryWork('gi');await h.m._maintainRecoveryWork('legacy_gi');await h.m._drainGroupInfoValidationAcks();assert.ok(h.posts<=6);await h.m._drainGroupInfoValidationAcks();
  assert.equal(h.posts,7);assert.equal((await dispositions(h)).length,3);assert.ok(h.observations<=6);await h.m._maintainRecoveryWork('gi');await h.m._maintainRecoveryWork('legacy_gi');assert.equal(h.observations,0,'retained lease jobs cannot dispatch retired transport');
  assert.equal((await h.s.listDueGroupInfoValidationAcks(h.device,Number.MAX_SAFE_INTEGER,50)).length,0);await privatePreserved(h);await h.s.close();
});

test('timer failure re-arms once under the same session and cannot remove a replacement timer',async()=>{
  const h=await fixture(),realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout;const timers=[];
  globalThis.setTimeout=fn=>{const value={fn,unref(){}};timers.push(value);return value;};globalThis.clearTimeout=()=>{};
  try{h.m._armValidationAckRetry=Object.getPrototypeOf(h.m)._armValidationAckRetry.bind(h.m);h.m._drainValidationAckAdmissions=async()=>{throw Error('transient scheduler read');};h.m._armValidationAckRetry();assert.equal(timers.length,1);timers[0].fn();await new Promise(r=>setImmediate(r));assert.equal(timers.length,2);
    const replacement={replacement:true};h.m._validationAckTimer=replacement;timers[1].fn();assert.equal(h.m._validationAckTimer,replacement);assert.equal(timers.length,2);
  }finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;h.m._validationAckTimer=null;await h.s.close();}
});

test('retired-session timer never starts work in another account/device/transport',async()=>{
  const h=await fixture(),realSet=globalThis.setTimeout;let timer,calls=0;globalThis.setTimeout=fn=>(timer={fn,unref(){}});
  try{h.m._armValidationAckRetry=Object.getPrototypeOf(h.m)._armValidationAckRetry.bind(h.m);h.m._drainValidationAckAdmissions=async()=>{calls++;};h.m._armValidationAckRetry();h.m.userId='replacement';timer.fn();await new Promise(r=>setImmediate(r));assert.equal(calls,0);}
  finally{globalThis.setTimeout=realSet;h.m._validationAckTimer=null;await h.s.close();}
});

for(const cap of ['recoveryWorkDispositionVersion','maintainRecoveryWork'])test('missing '+cap+' yields upgrade before Ready/validation transport and preserves the previous exact checkpoint',async()=>{
  const h=await fixture(),before=await h.s.loadMlsReadyBase(h.user,h.device,h.cid);h.s[cap]=undefined;
  const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'upgrade_required');assert.equal(state.reason,'client_upgrade_required');
  assert.deepEqual(await h.s.loadMlsReadyBase(h.user,h.device,h.cid),before);await assert.rejects(ack(h),e=>e.code==='client_upgrade_required');assert.equal(h.gets,0);assert.equal(h.posts,0);await privatePreserved(h);await h.s.close();
});

test('new authoritative intent survives direct validation while an older unknown ACK is retained as superseded evidence',async()=>{
  const h=await fixture(),old=await ack(h);const control={...h.m._recoveryControls.get(h.cid),recovery_revision:'2',incident_id:crypto.randomUUID()};await h.s.saveRecoveryControlCheckpoint(control);await h.m._loadRecoveryControl(h.cid);
  const next=await ack(h);assert.equal(next.request.incident_id,control.incident_id);assert.notEqual(next.job_id,old.job_id);assert.equal(next.attempts,0);
  const journal=await dispositions(h);assert.equal(journal.length,1);assert.equal(journal[0].reason,'superseded');assert.deepEqual(journal[0].source,old);await privatePreserved(h);await h.s.close();
});

test('bounded legacy corrupt intake and parked primary do not pin the backfill cursor or recreate due records',async()=>{
  const h=await fixture(),j=await seed(h,'gi');await put(h,j.due,{...j.row,version:99});
  const corruptKey='group_info_refresh:v1:aa:broken:request';await put(h,corruptKey,{cid:'aa:broken',request_id:'request',minimum_epoch:-1});
  await h.m._maintainRecoveryWork('gi');await h.m._maintainRecoveryWork('legacy_gi');assert.equal((await dispositions(h)).length,2);assert.equal(await get(h,corruptKey),null);assert.deepEqual(await get(h,j.primary),j.row);assert.equal(await get(h,j.due),null);
  await h.gi.applyAuthoritativeSnapshot({[h.cid]:j.row.request});await h.m._maintainRecoveryWork('gi');await h.m._maintainRecoveryWork('legacy_gi');assert.equal(await get(h,j.due),null);assert.deepEqual(await get(h,j.primary),j.row);assert.equal((await dispositions(h)).length,2);assert.equal(h.observations,0);await privatePreserved(h);await h.s.close();
});

for(const kind of ['unknown_version','wrong_scope','malformed'])test('actual corrupt primary '+kind+' is retained while GI cursor and a direct multi-CID discovery request progress',async()=>{
  const h=await fixture(2),giJobs=[],discoveryJobs=[];
  for(const cid of h.cids){giJobs.push(await seed(h,'gi',cid));discoveryJobs.push(await seed(h,'discovery',cid));}
  const corrupt=row=>kind==='unknown_version'?{...row,version:99}:kind==='wrong_scope'?{...row,user_id:'foreign-account'}:{...row,job_id:null};
  for(const j of [giJobs[0],discoveryJobs[0]])await put(h,j.primary,corrupt(j.row));
  await h.m._maintainRecoveryWork('gi');await h.m._maintainRecoveryWork('legacy_gi');assert.equal(h.observations,0,'retained legacy jobs are dormant');assert.deepEqual(await get(h,giJobs[0].primary),corrupt(giJobs[0].row));assert.equal(await get(h,giJobs[0].due),null);
  const c=h.m._getRecoveryDiscoveryCoordinator();c.arm=()=>{};const result=await c.request(h.cids);assert.equal(result.states[h.cids[0]].result,'error');assert.equal(result.states[h.cids[0]].retryable,false);assert.equal(result.states[h.cids[1]].result,'state');assert.deepEqual(Object.keys(result.states).sort(),[...h.cids].sort());
  assert.deepEqual(await get(h,discoveryJobs[0].primary),corrupt(discoveryJobs[0].row));assert.equal(await get(h,discoveryJobs[0].due),null);assert.equal((await dispositions(h)).length,2);await privatePreserved(h);c.stop();await h.s.close();
});
