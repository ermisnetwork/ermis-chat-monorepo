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
  const user = 'fair-validation-'  + ++sequence, device = 'device', s = new IndexedDBEncryptionStorage(user), m = new EncryptionManager(), cids = [], events = [];
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


const cursorKey=(h,lane)=>`recovery_work_scan:v1:${enc(h.device)}:${lane}`;
async function bulk(h,rows){const db=await h.s.openDB();await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite');for(const[key,value]of rows)tx.objectStore('meta').put(value,key);tx.oncomplete=yes;tx.onabort=()=>no(tx.error);});}
async function backlog(h,lane,count=301){const good=await seed(h,lane),rows=[];
 for(let i=0;i<count;i++){const cid='team:blocked-'+String(i).padStart(4,'0'),row=structuredClone(good.row);row.job_id=crypto.randomUUID();row.retry_at=1;
  if(lane==='admission')row.cid=cid;else{row.request.cid=cid;row.marker.cid=cid;}
  const primary=lane==='admission'?`gi_validation_admission:v1:${enc(h.device)}:${enc(cid)}`:`gi_validation_ack:v1:${enc(h.device)}:${enc(cid)}`;
  const due=`gi_validation_${lane==='admission'?'admission':'ack'}_pending:v1:${enc(h.device)}:0000000000000001:${enc(cid)}`;
  rows.push([primary,row],[due,row]);
 }
 await bulk(h,rows);h.m._validationAckAdmissions.clear();h.m._validationAckAdmissionSeen.clear();
 const restore=h.m._restoreRecoveryWorkCid.bind(h.m);h.m._restoreRecoveryWorkCid=async cid=>{if(cid.startsWith('team:blocked-'))throw Error('retained blocked CID');return restore(cid);};
 return{good,rows};
}
for(const lane of ['admission','ack'])test(lane+' >300 permanent failed heads cannot starve an eligible CID beyond the first page',async()=>{
 const h=await fixture(),jobs=await backlog(h,lane),gets=h.gets;
 for(let wake=0;wake<9;wake++){try{await(lane==='admission'?h.m._drainValidationAckAdmissions():h.m._drainGroupInfoValidationAcks());}catch(e){assert.equal(e.message,'retained blocked CID');}}
 assert.equal(h.posts,1);assert.equal(h.gets,gets+(lane==='admission'?1:0));
 const done=await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device);assert.equal(done.outcome,'accepted');assert.equal(done.attempts,1);
 for(const[key,row]of jobs.rows)assert.deepEqual(await get(h,key),row,'blocked exact obligation changed');
 assert.ok(await get(h,cursorKey(h,lane)));await privatePreserved(h);await h.s.close();
});

for(const lane of ['admission','ack'])test(lane+' selection wraps, retains unprocessed jobs and excludes future leases without changing budgets',async()=>{
 const h=await fixture(),{good,rows}=await backlog(h,lane,101);let page=await h.m._takeValidationWorkPage(lane,Date.now());assert.equal(page.length,50);
 const first=page.map(row=>lane==='ack'?row.request.cid:row.cid);page=await h.m._takeValidationWorkPage(lane,Date.now());assert.equal(page.length,50);
 assert.ok(page.every(row=>!first.includes(lane==='ack'?row.request.cid:row.cid)));
 page=await h.m._takeValidationWorkPage(lane,Date.now());assert.equal(page.length,2);
 page=await h.m._takeValidationWorkPage(lane,Date.now());assert.equal(page.length,50);assert.deepEqual(page.map(row=>lane==='ack'?row.request.cid:row.cid),first);
 for(const[key,value]of [...rows,[good.primary,good.row],[good.due,good.row]])assert.deepEqual(await get(h,key),value);
 assert.equal(h.posts,0);await privatePreserved(h);await h.s.close();
});

for(const lane of ['admission','ack'])test(lane+' a future reservation is selected only after its exact retry time; empty scan safely wraps',async()=>{
 const h=await fixture(),good=await seed(h,lane),at=good.row.retry_at;
 assert.deepEqual(await h.m._takeValidationWorkPage(lane,at-1),[]);assert.equal((await get(h,cursorKey(h,lane))).after,null);
 assert.deepEqual(await h.m._takeValidationWorkPage(lane,at),[good.row]);assert.deepEqual(await get(h,good.primary),good.row);
 assert.equal(h.posts,0);await privatePreserved(h);await h.s.close();
});

for(const lane of ['admission','ack'])for(const fault of ['abort','readback','unknown','cursor_replacement','due_replacement'])test(lane+' fair cursor '+fault+' never returns an unproved page or mutates a job',async()=>{
 const h=await fixture(),good=await seed(h,lane),db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false,winner;
 if(fault==='unknown'){const take=h.s.takeRecoveryWorkPage.bind(h.s);h.s.takeRecoveryWorkPage=async(...args)=>{await take(...args);throw Error('selection acknowledgement lost');};}
 else db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite'){
   if(fault==='abort')queueMicrotask(()=>tx.abort());else tx.addEventListener('complete',()=>{committed=true;
    if(fault==='cursor_replacement'){const t=original('meta','readwrite');winner={version:1,user_id:h.user,device_id:h.device,lane,signing_identity_sha256:sha256Hex(h.m.identity.signature_public_key()),artifact_sha256:sha256Hex(binary),operation_id:crypto.randomUUID(),after:null};t.objectStore('meta').put(winner,cursorKey(h,lane));}
    if(fault==='due_replacement'){const t=original('meta','readwrite');winner={...good.row,job_id:crypto.randomUUID()};t.objectStore('meta').put(winner,good.due);}
   });
  }if(args[1]==='readonly'&&committed&&fault==='readback')queueMicrotask(()=>tx.abort());return tx;};
 await assert.rejects(h.m._takeValidationWorkPage(lane,Date.now()));db.transaction=original;
 assert.equal(h.m._providerPersistenceUncertain,false);assert.equal(h.posts,0);assert.deepEqual(await get(h,good.primary),good.row);
 assert.deepEqual(await get(h,good.due),fault==='due_replacement'?winner:good.row);
 if(fault==='abort')assert.equal(await get(h,cursorKey(h,lane)),null);else assert.ok(await get(h,cursorKey(h,lane)));
 if(fault==='cursor_replacement')assert.deepEqual(await get(h,cursorKey(h,lane)),winner);
 await privatePreserved(h);await h.s.close();
});

for(const lane of ['admission','ack'])for(const malformed of ['after','scope','operation'])test(lane+' known-v1 '+malformed+' selection cursor gets exact durable disposition before fair restart',async()=>{
 const h=await fixture(),good=await seed(h,lane);await h.m._takeValidationWorkPage(lane,Date.now());const previous=await get(h,cursorKey(h,lane));
 const bad={...previous,...(malformed==='after'?{after:'foreign:index'}:malformed==='scope'?{user_id:'other'}:{operation_id:'broken'})};await put(h,cursorKey(h,lane),bad);
 assert.deepEqual(await h.m._takeValidationWorkPage(lane,Date.now()),[good.row]);const records=await dispositions(h);assert.equal(records.length,1);
 assert.deepEqual(records[0].source,bad);assert.equal(records[0].primary_key,null);assert.deepEqual(records[0].replacement,await get(h,cursorKey(h,lane)));
 assert.deepEqual(await get(h,good.primary),good.row);assert.deepEqual(await get(h,good.due),good.row);await privatePreserved(h);await h.s.close();
});

for(const lane of ['admission','ack'])test(lane+' unknown future cursor version remains exact and returns typed upgrade before page/HTTP',async()=>{
 const h=await fixture(),good=await seed(h,lane),unknown={version:2,future:'opaque',after:'do-not-interpret'};await put(h,cursorKey(h,lane),unknown);
 await assert.rejects(h.m._takeValidationWorkPage(lane,Date.now()),e=>e.code==='client_upgrade_required');
 assert.deepEqual(await get(h,cursorKey(h,lane)),unknown);assert.deepEqual(await dispositions(h),[]);assert.equal(h.posts,0);assert.deepEqual(await get(h,good.due),good.row);
 await privatePreserved(h);await h.s.close();
});

for(const cap of ['recoveryWorkScanVersion','takeRecoveryWorkPage'])test('missing '+cap+' defers repair Ready and fair transport without modifying old private state',async()=>{
 const h=await fixture(),before=await h.s.loadMlsReadyBase(h.user,h.device,h.cid);h.s[cap]=undefined;
 const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'upgrade_required');assert.equal(state.reason,'client_upgrade_required');
 await assert.rejects(h.m._takeValidationWorkPage('ack',Date.now()),e=>e.code==='client_upgrade_required');
 assert.deepEqual(await h.s.loadMlsReadyBase(h.user,h.device,h.cid),before);assert.equal(h.posts,0);await privatePreserved(h);await h.s.close();
});

for(const replacement of ['account','device','storage','transport','signer','artifact','provider','group','marker','control'])test('held fair page cannot mutate cursor under replacement '+replacement,async()=>{
 const h=await fixture(),good=await seed(h,'ack'),entered=latch(),gate=latch(),take=h.s.takeRecoveryWorkPage.bind(h.s);
 h.s.takeRecoveryWorkPage=async(...args)=>{entered.resolve();await gate.promise;return take(...args);};
 const work=h.m._takeValidationWorkPage('ack',Date.now()),rejected=assert.rejects(work);await entered.promise;
 if(replacement==='account')h.m.userId='other';if(replacement==='device')h.m.deviceId='other';if(replacement==='storage')h.m.storage=new IndexedDBEncryptionStorage(h.user);
 if(replacement==='transport')h.m.e2eeClient={};if(replacement==='signer')h.m.identity=wasm.Identity.from_bytes(h.m._activeProvider,h.m.identity.to_bytes());
 if(replacement==='artifact')h.m._wasmArtifactSha256='f'.repeat(64);if(replacement==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.bytes);
 if(replacement==='group')h.m.groups.set(h.cid,wasm.Group.load(h.m._activeProvider,h.cid));if(replacement==='marker')h.m._groupGenerations.set(h.cid,{...h.m._groupGenerations.get(h.cid),updated_at:2});
 if(replacement==='control')h.m._recoveryControls.set(h.cid,{...h.m._recoveryControls.get(h.cid),recovery_revision:'2'});
 gate.resolve();await rejected;assert.equal(await get(h,cursorKey(h,'ack')),null);assert.deepEqual(await get(h,good.primary),good.row);assert.deepEqual(await get(h,good.due),good.row);
 assert.deepEqual(await h.s.loadProviderState(h.user,h.device),h.bytes);assert.equal(h.posts,0);await h.s.close();
});

for(const at of ['before_rw','before_readback'])test('fair scan '+at+' private winner fences current/late Ready and preserves exact winner',async()=>{
 const h=await fixture(),good=await seed(h,'ack');await h.m.refreshE2eeState(h.cid);assert.equal(h.m.getE2eeState(h.cid).state,'ready');const seen=[];h.m.subscribeE2eeState(h.cid,v=>seen.push(v));
 const p=wasm.Provider.from_bytes(h.bytes),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p),ref=kp.hash_ref(p),bytes=p.to_bytes(),revision=crypto.randomUUID();kp.free();
 const db=await h.s.openDB(),original=db.transaction.bind(db),write=()=>{const tx=original('meta','readwrite'),meta=tx.objectStore('meta');meta.put(bytes,`provider:${h.user}:${h.device}`);meta.put(revision,`provider_revision:${h.user}:${h.device}`);return new Promise((yes,no)=>{tx.oncomplete=yes;tx.onabort=()=>no(tx.error);});};
 if(at==='before_rw')await write();else{let fired=false;db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite'&&!fired){fired=true;tx.addEventListener('complete',()=>{void write();});}return tx;};}
 await assert.rejects(h.m._takeValidationWorkPage('ack',Date.now()));db.transaction=original;
 assert.equal(h.m._providerPersistenceUncertain,true);assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');const late=[];h.m.subscribeE2eeState(h.cid,v=>late.push(v));assert.notEqual(late[0].state,'ready');assert.notEqual(seen.at(-1).state,'ready');
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),{provider_bytes:bytes,revision});assert.deepEqual(await get(h,good.primary),good.row);assert.deepEqual(await get(h,good.due),good.row);
 assert.equal(i.owns_key_package_ref(p,ref),true);assert.equal(h.posts,0);i.free();p.free();await h.s.close();
});

test('new lower-key work is visited on wrap without replaying or merging any selected obligation',async()=>{
 const h=await fixture(),{good}=await backlog(h,'ack',51);await h.m._takeValidationWorkPage('ack',Date.now());
 const row={...good.row,job_id:crypto.randomUUID(),retry_at:1,request:{...good.row.request,cid:'team:000-new'},marker:{...good.row.marker,cid:'team:000-new'}};
 const primary=`gi_validation_ack:v1:${enc(h.device)}:${enc(row.request.cid)}`,due=`gi_validation_ack_pending:v1:${enc(h.device)}:0000000000000001:${enc(row.request.cid)}`;
 await bulk(h,[[primary,row],[due,row]]);let found=false;
 for(let wake=0;wake<3;wake++){const page=await h.m._takeValidationWorkPage('ack',Date.now());found ||=page.some(job=>job.job_id===row.job_id);}
 assert.equal(found,true);assert.deepEqual(await get(h,primary),row);assert.deepEqual(await get(h,due),row);assert.equal(h.posts,0);await privatePreserved(h);await h.s.close();
});

// Explicit crypto-invalid fixture metadata; missing/stale GI alone never authorizes ACK work.
function requireValidationMetadata(m,cid) {
 const marker=m._groupGenerations.get(cid),control=m._recoveryControls.get(cid);if(!marker||!control)return;
 m._channelE2ee.set(cid,{cid,group_generation:marker.group_generation,group_id:marker.group_id?Buffer.from(marker.group_id).toString('base64'):null,epoch:marker.current_epoch,
  group_info:{status:'validation_required',ready:false,epoch:marker.current_epoch,last_uploaded_at:null,refresh_requested:false},
  recovery:{action:control.recovery_action,incident_id:control.incident_id,revision:control.recovery_revision,repair_retry_until:control.repair_retry_until}});
}
