import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import init,* as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager,IndexedDBEncryptionStorage,sha256Hex}=createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const wasmBytes=fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url));await init({module_or_path:wasmBytes});let seq=0;
async function fixture(count=1){
 const user='admission-fair-'+(++seq),device='device',s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager(),cids=[];
 Object.assign(m,{userId:user,deviceId:device,storage:s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(wasmBytes)});await m._initWasm();await m._initIdentity();
 for(let i=0;i<count;i++){const cid='team:'+user+'-'+String(i).padStart(3,'0'),group=wasm.Group.create_with_cid(m.provider,m.identity,cid);cids.push(cid);m.groups.set(cid,group);m._groupGenerations.set(cid,{cid,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1});}
 const kp=m.identity.key_package(m.provider),ref=kp.hash_ref(m.provider);kp.free();await m._persistProviderStrict();m.initialized=true;m._armValidationAckRetry=()=>{};m.client={activeChannels:{},dispatchEvent(){}};m.e2eeClient={};
 const now=Date.now(),jobs=[];
 for(const cid of cids){await s.saveGroupState(cid,m._groupGenerations.get(cid));const control={version:1,user_id:user,device_id:device,cid,signing_identity_sha256:sha256Hex(m.identity.signature_public_key()),group_generation:0,incident_id:'00000000-0000-4000-8000-000000000001',recovery_action:'repair',recovery_revision:'1',repair_retry_until:new Date(now+900000).toISOString()};await s.saveRecoveryControlCheckpoint(control);await m._loadRecoveryControl(cid);requireValidationMetadata(m,cid);
 const job={version:1,job_id:crypto.randomUUID(),user_id:user,device_id:device,cid,signing_identity_sha256:control.signing_identity_sha256,group_generation:0,epoch:0,incident_id:control.incident_id,recovery_revision:'1',artifact_sha256:sha256Hex(wasmBytes),policy:'verify',attempts:0,retry_at:now-30001,outcome:'pending'};jobs.push(await s.reserveGroupInfoValidationAdmission(job,now-30001));}
 const cid=cids[0],owner=()=>({provider_revision:m._providerDurableBase.revision,marker:m._groupGenerations.get(cid),control:m._recoveryControls.get(cid)});
 return{m,s,user,device,cids,cid,jobs,now,owner,ref,bytes:m.provider.to_bytes()};
}
async function manual(h,cid=h.cid){const old=h.m._recoveryControls.get(cid),next={...old,recovery_revision:'2',recovery_action:'manual_intervention_required'};await h.s.saveRecoveryControlCheckpoint(next);await h.m._loadRecoveryControl(cid);requireValidationMetadata(h.m,cid);return next;}
async function rows(h){return h.s.listDueGroupInfoValidationAdmissions(h.device,Date.now()+1000000,50);}

test('actual metadata abort preserves primary/index/private KP; defer consumes no attempt and full proof precedes return',async()=>{
 const h=await fixture(),db=await h.s.openDB(),orig=db.transaction.bind(db);db.transaction=(...args)=>{const tx=orig(...args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
 await assert.rejects(h.s.deferGroupInfoValidationAdmission(h.jobs[0],h.now,false,h.owner(),()=>{}),e=>e.checkpoint_outcome==='aborted');db.transaction=orig;
 assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cid,h.device),h.jobs[0]);assert.deepEqual(await rows(h),h.jobs);
 assert.equal(await h.s.deferGroupInfoValidationAdmission(h.jobs[0],h.now,false,h.owner(),()=>{}),true);const next=await h.s.loadGroupInfoValidationAdmission(h.cid,h.device);assert.deepEqual(next,{...h.jobs[0],retry_at:h.now+30000});assert.equal(next.attempts,1);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.ok(h.m.identity.owns_key_package_ref(h.m.provider,h.ref));await h.s.close();
});
for(const kind of ['owner','provider','marker','control','replacement_job'])test('admission defer '+kind+' replacement keeps winning durable scheduling state',async()=>{
 const h=await fixture(),job=h.jobs[0],owner=h.owner();let winning=job;
 if(kind==='provider'){const p=wasm.Provider.from_bytes(h.bytes),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p);kp.free();await h.s.saveProviderState(h.user,h.device,p.to_bytes(),{expected_revision:owner.provider_revision,next_revision:'remote-winner'});i.free();p.free();}
 if(kind==='marker')await h.s.saveGroupState(h.cid,{...owner.marker,status:'historical'});
 if(kind==='control')await h.s.saveRecoveryControlCheckpoint({...owner.control,recovery_revision:'2',recovery_action:'manual_intervention_required'});
 if(kind==='replacement_job'){const control={...owner.control,recovery_revision:'2'};await h.s.saveRecoveryControlCheckpoint(control);winning=await h.s.reserveGroupInfoValidationAdmission({...job,job_id:crypto.randomUUID(),recovery_revision:'2',attempts:0,retry_at:h.now},h.now);assert.ok(winning);}
 if(kind==='replacement_job')assert.equal(await h.s.deferGroupInfoValidationAdmission(job,h.now,false,owner,()=>{}),false);
 else await assert.rejects(h.s.deferGroupInfoValidationAdmission(job,h.now,false,owner,()=>{if(kind==='owner')throw Error('old owner');}));
 assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cid,h.device),winning);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);await h.s.close();
});
for(const kind of ['readback','metadata','unknown'])test('committed admission '+kind+' outcome keeps exact obligation and private winner through restart',async()=>{
 const h=await fixture(),db=await h.s.openDB(),orig=db.transaction.bind(db);let didWrite=false;
 db.transaction=(...args)=>{const tx=orig(...args);if(args[1]==='readwrite'){didWrite=true;if(kind==='metadata')tx.addEventListener('complete',()=>{const replacement=orig('meta','readwrite');replacement.objectStore('meta').put({...h.owner().control,recovery_revision:'2'},`recovery_control:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`);});}if(args[1]==='readonly'&&didWrite&&kind==='readback')queueMicrotask(()=>tx.abort());return tx;};
 if(kind==='unknown'){const save=h.s.deferGroupInfoValidationAdmission.bind(h.s);h.s.deferGroupInfoValidationAdmission=async(...args)=>{await save(...args);throw Error('outcome unknown');};}
 await assert.rejects(h.s.deferGroupInfoValidationAdmission(h.jobs[0],h.now,false,h.owner(),()=>{}));db.transaction=orig;
 const restarted=new IndexedDBEncryptionStorage(h.user),next=await restarted.loadGroupInfoValidationAdmission(h.cid,h.device);assert.deepEqual(next,{...h.jobs[0],retry_at:h.now+30000});assert.deepEqual(await restarted.loadProviderState(h.user,h.device),h.bytes);assert.equal((await restarted.listDueGroupInfoValidationAdmissions(h.device,h.now+30000,50)).length,1);await restarted.close();await h.s.close();
});

test('durable manual pause preserves primary intent across restart; old/same authority cannot reindex; new Ready proof can',async()=>{
 const h=await fixture();await manual(h);let reads=0;h.m.e2eeClient={getGroupInfo:async()=>{reads++;throw Error('manual auto loop');}};
 await h.m._drainValidationAckAdmissions();assert.equal(reads,0);assert.equal((await rows(h)).length,0);assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cid,h.device),h.jobs[0]);
 const n=new EncryptionManager();Object.assign(n,{userId:h.user,deviceId:h.device,storage:new IndexedDBEncryptionStorage(h.user),_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(wasmBytes)});await n._initWasm();await n._initIdentity();await n._restoreGroupsLocally();n.initialized=true;n.client={activeChannels:{}};n.e2eeClient={};n._armValidationAckRetry=()=>{};
 await n._drainValidationAckAdmissions();assert.equal((await n.storage.listDueGroupInfoValidationAdmissions(h.device,Date.now()+1000000,50)).length,0);assert.equal((await n.refreshE2eeState(h.cid)).state,'manual_intervention_required');
 await n.storage.saveRecoveryControlCheckpoint({...h.owner().control,recovery_revision:'1',recovery_action:'repair'});await n._loadRecoveryControl(h.cid);requireValidationMetadata(n,h.cid);assert.equal((await n.refreshE2eeState(h.cid)).state,'manual_intervention_required');
 await n.storage.saveRecoveryControlCheckpoint({...h.owner().control,recovery_revision:'3',recovery_action:'repair'});await n._loadRecoveryControl(h.cid);requireValidationMetadata(n,h.cid);assert.equal((await n.refreshE2eeState(h.cid)).state,'ready');const fresh=await n.storage.loadGroupInfoValidationAdmission(h.cid,h.device);assert.equal(fresh.recovery_revision,'3');assert.equal(fresh.attempts,0);assert.equal((await n.storage.listDueGroupInfoValidationAdmissions(h.device,Date.now()+1000000,50)).length,1);await n.storage.close();await h.s.close();
});

test('51 actual groups: 50 durable manual jobs cannot starve valid peer; page50/batch6/no GET budget reset',async()=>{
 const h=await fixture(51),realNow=Date.now;let now=h.now,gets=0,posts=0;Date.now=()=>now;
 try{for(const cid of h.cids.slice(0,50))await manual(h,cid);h.m.e2eeClient={getGroupInfo:async(_type,id)=>{gets++;const cid='team:'+id,group=h.m.groups.get(cid),gi=group.export_group_info(h.m.provider,h.m.identity,true);return{group_info:gi,group_generation:0,group_id:null,epoch:0,hash:sha256Hex(gi),is_stale:false};},acknowledgeGroupInfoValidation:async()=>{posts++;return{accepted:true,idempotent:false,recovery_action:'none',recovery_revision:'2'};}};
 for(let i=0;i<10;i++){await h.m._drainValidationAckAdmissions();now+=30001;}
 assert.equal(gets,1);assert.equal(posts,1);for(let i=0;i<50;i++)assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cids[i],h.device),h.jobs[i]);
 const last=await h.s.loadGroupInfoValidationAdmission(h.cids[50],h.device);assert.equal(last.attempts,2);assert.equal(last.outcome,'prepared');assert.equal((await rows(h)).length,0);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.ok(h.m.identity.owns_key_package_ref(h.m.provider,h.ref));
 }finally{Date.now=realNow;await h.s.close();}
});

test('repair Ready on missing fair scheduling capability stays upgrade before metadata/private mutation',async()=>{
 const h=await fixture();h.s.validationAdmissionSchedulingVersion=undefined;const before=await h.s.loadMlsReadyBase(h.user,h.device,h.cid);const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'upgrade_required');assert.equal(state.reason,'client_upgrade_required');assert.deepEqual(await h.s.loadMlsReadyBase(h.user,h.device,h.cid),before);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);await h.s.close();
});

for(const kind of ['account','device','storage','signer','transport','artifact','provider','group','marker'])test('production admission delayed scan rejects '+kind+' owner replacement without clearing replacement work',async()=>{
 const h=await fixture();let entered,release;const seen=new Promise(r=>entered=r),gate=new Promise(r=>release=r),scan=h.s.takeRecoveryWorkPage.bind(h.s);
 h.s.takeRecoveryWorkPage=async(...args)=>{const rows=await scan(...args);if(args[2]==='admission'){entered();await gate;}return rows;};
 const work=h.m._drainValidationAckAdmissions(),rejected=assert.rejects(work,e=>e.code==='recovery_scope_changed');await seen;
 if(kind==='account')h.m.userId='replacement';if(kind==='device')h.m.deviceId='replacement';if(kind==='storage')h.m.storage=new IndexedDBEncryptionStorage(h.user);
 if(kind==='signer')h.m.identity=wasm.Identity.from_bytes(h.m._activeProvider,h.m.identity.to_bytes());if(kind==='transport')h.m.e2eeClient={};if(kind==='artifact')h.m._wasmArtifactSha256='f'.repeat(64);
 if(kind==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.bytes);if(kind==='group')h.m.groups.set(h.cid,wasm.Group.load(h.m._activeProvider,h.cid));if(kind==='marker')h.m._groupGenerations.set(h.cid,{...h.m._groupGenerations.get(h.cid),group_generation:1,group_id:h.m.groups.get(h.cid).group_id()});
 h.m._validationAckAdmissions.set(h.cid,'replacement-work');release();await rejected;assert.equal(h.m._validationAckAdmissions.get(h.cid),'replacement-work');assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cid,h.device),h.jobs[0]);await h.s.close();
});
for(const kind of ['control','pending_commit'])test('delayed admission GET cannot finish or remove '+kind+' winning operation',async()=>{
 const h=await fixture();let entered,release;const seen=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const gi=h.m.groups.get(h.cid).export_group_info(h.m.provider,h.m.identity,true),info={group_info:gi,group_generation:0,group_id:null,epoch:0,hash:sha256Hex(gi),is_stale:false};
 h.m.e2eeClient={getGroupInfo:async()=>{entered();await gate;return info;},acknowledgeGroupInfoValidation:async()=>{assert.fail('old admission sent ACK');}};
 const work=h.m._drainValidationAckAdmissions(),rejected=assert.rejects(work,e=>e.code==='recovery_scope_changed');await seen;let winner;
 if(kind==='control'){await manual(h);winner=await h.s.reserveGroupInfoValidationAdmission({...h.jobs[0],job_id:crypto.randomUUID(),recovery_revision:'2',trigger:'manual',attempts:0,retry_at:Date.now()},Date.now());assert.ok(winner);}
 else {const marker=h.m._groupGenerations.get(h.cid),guard=h.m._captureMlsPreparation(h.cid);await h.m._prepareMlsMutation(h.cid,guard,(provider,g)=>{const b=g.self_update(provider,h.m.identity);return{group:g,marker,commit:b.commit,ghosts:[],expected_epoch:0,request:{kind:'rotation',channel_type:'team',channel_id:h.cid.slice(5),target_user_ids:[],body:{}}};});winner=(await h.s.listPendingMlsMutations()).find(row=>row.cid===h.cid);}
 const bytes=h.m.provider.to_bytes();h.m._validationAckAdmissions.set(h.cid,'replacement-work');release();await rejected;assert.equal(h.m._validationAckAdmissions.get(h.cid),'replacement-work');assert.deepEqual(h.m.provider.to_bytes(),bytes);
 if(kind==='control')assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cid,h.device),winner);else assert.deepEqual((await h.s.listPendingMlsMutations()).find(row=>row.cid===h.cid),winner);await h.s.close();
});
test('overload durably defers exact admission without consuming attempt or extending authority deadline',async()=>{
 const h=await fixture(),control=h.m._recoveryControls.get(h.cid);for(let i=0;i<6;i++)h.m._validationAckPreparing.set('busy:'+i,Promise.resolve());let gets=0;h.m.e2eeClient={getGroupInfo:async()=>{gets++;throw Error('overload must defer');}};
 await h.m._drainValidationAckAdmissions();const next=await h.s.loadGroupInfoValidationAdmission(h.cid,h.device);assert.equal(gets,0);assert.equal(next.job_id,h.jobs[0].job_id);assert.equal(next.attempts,1);assert.ok(next.retry_at>=h.now+30000);assert.equal(h.m._recoveryControls.get(h.cid).repair_retry_until,control.repair_retry_until);assert.equal(h.m._validationAckAdmissions.has(h.cid),true);await h.s.close();
});

test('CAS no-op on a replacement admission retains fair follow-up instead of clearing the only work signal',async()=>{
 const h=await fixture();await manual(h);const defer=h.s.saveValidationAdmissionWork.bind(h.s);let winner;
 h.s.saveValidationAdmissionWork=async(...args)=>{if(!winner)winner=await h.s.reserveGroupInfoValidationAdmission({...h.jobs[0],job_id:crypto.randomUUID(),recovery_revision:'2',trigger:'manual',attempts:0,retry_at:Date.now()},Date.now());return defer(...args);};
 await h.m._drainValidationAckAdmissions();assert.ok(winner);assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cid,h.device),winner);assert.equal(h.m._validationAckAdmissions.has(h.cid),true);assert.equal((await h.s.listDueGroupInfoValidationAdmissions(h.device,Date.now()+30001,50)).length,1);await h.s.close();
});

for(const kind of ['primary_shape','primary_scope','due_index','paused'])test('Ready full primary/index/disposition proof rejects '+kind+' corruption without replacing obligation',async()=>{
 const h=await fixture(),job=h.jobs[0],db=await h.s.openDB(),key=`gi_validation_admission:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`,index=`gi_validation_admission_pending:v1:${encodeURIComponent(h.device)}:${String(job.retry_at).padStart(16,'0')}:${encodeURIComponent(h.cid)}`;
 await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite'),meta=tx.objectStore('meta');if(kind==='primary_shape')meta.put({...job,attempts:99},key);if(kind==='primary_scope')meta.put({...job,signing_identity_sha256:'f'.repeat(64)},key);if(kind==='due_index')meta.put({...job,job_id:crypto.randomUUID()},index);if(kind==='paused')meta.put({job_id:job.job_id,reason:'manual_intervention_required'},`gi_validation_admission_paused:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`);tx.oncomplete=yes;tx.onabort=no;});
 const before=await h.s.loadMlsReadyBase(h.user,h.device,h.cid),state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'repairing');assert.equal(state.reason,'storage_corruption');assert.deepEqual(await h.s.loadMlsReadyBase(h.user,h.device,h.cid),before);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);await h.s.close();
});
test('Ready retains actual pending Commit fence even when a corrupt local journal index is missing',async()=>{
 const h=await fixture(),marker=h.m._groupGenerations.get(h.cid),guard=h.m._captureMlsPreparation(h.cid);await h.m._prepareMlsMutation(h.cid,guard,(provider,g)=>{const b=g.self_update(provider,h.m.identity);return{group:g,marker,commit:b.commit,ghosts:[],expected_epoch:0,request:{kind:'rotation',channel_type:'team',channel_id:h.cid.slice(5),target_user_ids:[],body:{}}};});h.m._pendingMlsMutations.delete(h.cid);
 const db=await h.s.openDB();await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete('mls_mutation:v1:'+h.cid);tx.oncomplete=yes;tx.onabort=no;});const before=h.m.provider.to_bytes();assert.equal(h.m.getE2eeState(h.cid).state,'pending_external_join');const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'pending_external_join');assert.equal(state.reason,'mls_mutation_outcome_pending');assert.deepEqual(h.m.provider.to_bytes(),before);assert.ok(h.m.groups.get(h.cid).has_pending_commit());await h.s.close();
});
for(const field of ['admission_pending','admission_paused'])test('committed Ready mismatch in '+field+' fails closed before callback',async()=>{
 const h=await fixture(),verify=h.s.verifyMlsReadyCheckpoint.bind(h.s);h.m.client.dispatchEvent=event=>{assert.notEqual(event.state,'ready');};
 h.s.verifyMlsReadyCheckpoint=async cp=>{const db=await h.s.openDB();await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite'),meta=tx.objectStore('meta');if(field==='admission_pending'){const job=cp.admission;meta.put({...job,job_id:crypto.randomUUID()},`gi_validation_admission_pending:v1:${encodeURIComponent(h.device)}:${String(job.retry_at).padStart(16,'0')}:${encodeURIComponent(h.cid)}`);}else meta.put({job_id:cp.admission.job_id,reason:'manual_intervention_required'},`gi_validation_admission_paused:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`);tx.oncomplete=yes;tx.onabort=no;});return verify(cp);};
 const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'repairing');assert.equal(state.reason,'provider_persistence_uncertain');assert.ok(h.m._providerPersistenceUncertain);assert.throws(()=>h.m.provider);assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);await h.s.close();
});

test('meaning-equivalent scheduling property reorder still gets actual Ready proof without resetting admission budget',async()=>{
 const h=await fixture(),job=h.jobs[0],db=await h.s.openDB(),index=`gi_validation_admission_pending:v1:${encodeURIComponent(h.device)}:${String(job.retry_at).padStart(16,'0')}:${encodeURIComponent(h.cid)}`;
 await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(Object.fromEntries(Object.entries(job).reverse()),index);tx.oncomplete=yes;tx.onabort=no;});
 assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cid,h.device),job);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);await h.s.close();
});

for(const kind of ['has_more','authorization_failed','transport_unavailable','client_upgrade_required','canonical_receipt_pending'])test('known nonterminal '+kind+' replay cannot publish common Ready before its public result',async()=>{
 const h=await fixture(),events=[];h.m._channelE2ee.get(h.cid).group_info.status='missing';h.m.client.dispatchEvent=e=>events.push(e);h.m._ensureChannelReadyLegacy=async()=>({cid:h.cid,status:'needs_retry',error:kind==='has_more'?undefined:kind,sync_state:{cid:h.cid,status:'needs_retry',needs_retry:true,has_more:kind==='has_more'}});
 const before=await h.s.loadMlsReadyBase(h.user,h.device,h.cid),result=await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid);
 assert.notEqual(result.status,'ready');assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');assert.equal(h.m.getE2eeState(h.cid).reason,kind==='has_more'?'scope_sync_pending':kind);
 assert.equal(events.some(e=>e.state==='ready'||e.type==='e2ee.channel_ready'),false);assert.deepEqual(await h.s.loadMlsReadyBase(h.user,h.device,h.cid),before);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);await h.s.close();
});

test('late inherited/nested topic subscription gets the actual proven MLS CID and copied current snapshot',async()=>{
 const h=await fixture(),topic='team:topic',parent='team:intermediate',seen=[];h.m.client.activeChannels[topic]={data:{e2ee_group_id:parent}};h.m.client.activeChannels[parent]={data:{e2ee_group_id:h.cid}};h.m.subscribeE2eeState(topic,s=>seen.push(s));
 const state=await h.m.refreshE2eeState(topic);assert.equal(state.cid,h.cid);assert.equal(state.state,'ready');assert.equal(seen.at(-1).cid,h.cid);assert.equal(seen.at(-1).state,'ready');const late=[];h.m.subscribeE2eeState(topic,s=>late.push(s));assert.equal(late[0].state,'ready');late[0].group_generation=999;assert.equal(h.m.getE2eeState(topic).group_generation,0);assert.equal(h.m.groups.has(topic),false);await h.s.close();
});
test('changed inherited scope retires old subscription/continuation without claiming child Ready',async()=>{
 const h=await fixture(),topic='team:topic',seen=[];h.m.client.activeChannels[topic]={data:{e2ee_group_id:h.cid}};await h.m.refreshE2eeState(h.cid);h.m.subscribeE2eeState(topic,s=>seen.push(s));const owner=h.m._captureCleanupRevisionGuard(topic);h.m.client.activeChannels[topic].data.e2ee_group_id='team:replacement';assert.throws(owner,e=>e.code==='recovery_scope_changed');h.m._publishCommonState(h.m._commonSnapshot(h.cid,'repairing','scope_sync_pending'));assert.equal(seen.length,1);assert.notEqual(h.m.getE2eeState(topic)?.state,'ready');await h.s.close();
});
test('cyclic scope hints give typed defer with no transport/private mutation/Ready row',async()=>{
 const h=await fixture(),topic='team:topic';h.m.client.activeChannels[topic]={data:{e2ee_group_id:h.cid}};h.m.client.activeChannels[h.cid]={data:{e2ee_group_id:topic}};let calls=0;h.m._ensureChannelReadyLegacy=async()=>{calls++;assert.fail('cycle reached transport');};
 assert.equal(h.m.getE2eeState(topic).reason,'mls_scope_binding_pending');assert.equal((await h.m.refreshE2eeState(topic)).reason,'mls_scope_binding_pending');assert.equal((await h.m.ensureChannelReady('team','topic',topic)).error,'mls_scope_binding_pending');assert.equal(calls,0);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).ready,null);await h.s.close();
});
for(const kind of ['manual','historical','pending'])test('published/current '+kind+' invariant cannot disagree after control/repair continuation',async()=>{
 const h=await fixture(),seen=[];if(kind==='manual')await manual(h);if(kind==='historical')h.m._groupGenerations.set(h.cid,{...h.m._groupGenerations.get(h.cid),status:'historical'});if(kind==='pending')h.m._pendingMlsMutations.set(h.cid,{cid:h.cid});h.m.subscribeE2eeState(h.cid,s=>seen.push(s));h.m._publishCommonState(h.m._commonSnapshot(h.cid,'repairing','repair_window_open'));assert.deepEqual(seen.at(-1),h.m.getE2eeState(h.cid));await h.s.close();
});

test('derived current snapshot and later identical publication dedupe per late subscriber before any stored common record',async()=>{
 const h=await fixture();await manual(h);const seen=[];h.m.subscribeE2eeState(h.cid,s=>seen.push(s));h.m._publishCommonState(h.m._commonSnapshot(h.cid,'repairing','repair_window_open'));assert.equal(seen.length,1);assert.equal(seen[0].state,'manual_intervention_required');await h.s.close();
});

// Explicit crypto-invalid fixture metadata; missing/stale GI alone never authorizes ACK work.
function requireValidationMetadata(m,cid) {
 const marker=m._groupGenerations.get(cid),control=m._recoveryControls.get(cid);if(!marker||!control)return;
 m._channelE2ee.set(cid,{cid,group_generation:marker.group_generation,group_id:marker.group_id?Buffer.from(marker.group_id).toString('base64'):null,epoch:marker.current_epoch,
  group_info:{status:'validation_required',ready:false,epoch:marker.current_epoch,last_uploaded_at:null,refresh_requested:false},
  recovery:{action:control.recovery_action,incident_id:control.incident_id,revision:control.recovery_revision,repair_retry_until:control.repair_retry_until}});
}
