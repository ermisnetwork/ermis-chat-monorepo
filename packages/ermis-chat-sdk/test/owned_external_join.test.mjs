import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager, IndexedDBEncryptionStorage, sha256Hex} = createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const binary=fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url));await init({module_or_path:binary});let n=0;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function fixture(pending=true,channelType="team"){
 const user='owned-external-'+ ++n,device='device',cid=channelType+':'+user,s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager(),events=[];
 Object.assign(m,{userId:user,deviceId:device,storage:s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(binary)});await m._initWasm();await m._initIdentity();
 const kp=m.identity.key_package(m._activeProvider),ref=kp.hash_ref(m._activeProvider);kp.free();await m._persistProviderStrict();
 const p=new wasm.Provider(),i=new wasm.Identity(p,'issuer'),g=wasm.Group.create_with_cid(p,i,cid),info={group_info:g.export_group_info(p,i,true),epoch:0,hash:'fixture',is_stale:false,group_generation:0,group_id:null};
 const unknown=op=>({version:1,operation_id:op,cid,state:'outcome_unknown',delivery_pending:false,group_generation:null,epoch:null,group_id:null,commit_sha256:null,event_id:null,acceptance_context:null});
 let posts=0,reads=0,auth=1;const api={getGroupInfo:async()=>info,getExternalJoinReceipt:async(_t,_id,op)=>{reads++;return unknown(op);},externalJoin:async()=>{assert.equal(m._providerCheckpointInFlight,false);posts++;},uploadGroupInfo:async()=>{}};
 m.e2eeClient=api;m.client={baseURL:'https://fixture.invalid',activeChannels:{},dispatchEvent:e=>events.push(e),_captureAuthScope:()=>{const a=auth;return{assertCurrent:()=>{if(auth!==a)throw Error('auth changed');}};}};
 m.initialized=true;m.safeArchiveCurrentEpoch=async()=>{};m.ensureKeyPackagesFromServer=async()=>{};
 const join=()=>m.joinExternal(channelType,user,cid);if(pending)await assert.rejects(join(),e=>e.code==='transport_unknown');
 const job=await s.loadExternalJoinCandidateCheckpoint(cid),base=await s.loadProviderCheckpoint(user,device);
 const rejection=()=>({version:1,operation_id:job.body.operation_id,cid,state:'rejected',delivery_pending:false,group_generation:0,epoch:job.body.epoch,group_id:null,commit_sha256:job.commit_sha256,group_info_sha256:job.group_info_sha256,event_id:null,acceptance_context:null,rejection_reason:'head_conflict',rejected_at:new Date().toISOString()});
 const preserve=async()=>{assert.deepEqual(await s.loadProviderCheckpoint(user,device),base);const q=wasm.Provider.from_bytes(base.provider_bytes),id=wasm.Identity.from_bytes(q,await s.loadIdentity(user,device));assert.equal(id.owns_key_package_ref(q,ref),true);id.free();q.free();};
 const close=async()=>{await s.close();g.free();i.free();p.free();};
 return{m,s,user,device,cid,api,info,job,join,unknown,rejection,base,events,issuer:{provider:p,identity:i,group:g},privateRef:ref,posts:()=>posts,reads:()=>reads,bumpAuth:()=>{auth++;},preserve,close};
}
function acceptedReceipt(h){
 const event='00000000-0000-4000-8000-000000000017',body=h.job.body;
 return {version:1,operation_id:body.operation_id,cid:h.cid,state:'accepted',delivery_pending:false,
  group_generation:0,epoch:body.epoch,group_id:null,commit_sha256:sha256Hex(body.commit),group_info_sha256:sha256Hex(body.group_info),event_id:event,
  acceptance_context:{version:1,event_id:event,cid:h.cid,group_generation:0,epoch:body.epoch,accepted_at:Math.floor(Date.now()/1000),payload_sha256:sha256Hex(body.commit),provenance:'bellboy_transition_v1'}};
}
function acceptedReadiness(h){
 h.issuer.group.process_message(h.issuer.provider,h.job.body.commit);
 h.api.getExternalJoinReceipt=async(_t,_id,op)=>{assert.equal(op,h.job.body.operation_id);return acceptedReceipt(h);};
 h.api.externalJoin=async()=>{assert.fail('accepted candidate must not POST another commit');};
 // This fixture has no application backlog. Keep the real receipt, rebase,
 // IDB checkpoint and Ready validation; only historical transport is empty.
 h.m._syncChannelFromCursor=async()=>({cid:h.cid,status:'ready',epoch:1,has_more:false,needs_retry:false});
}
test('normal channel readiness resumes accepted pending UUID instead of dead-ending before receipt',async()=>{
 const h=await fixture();acceptedReadiness(h);const before=h.posts();
 const result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
 assert.equal(result.status,'ready');assert.equal(h.m.getE2eeState(h.cid).state,'ready');
 assert.equal(h.posts(),before);assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);
 assert.equal(Number(h.m.groups.get(h.cid).epoch()),1);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.privateRef),true);await h.close();
});
test('unsealed application send resumes accepted join then encrypts and peer decrypts once',async()=>{
 const h=await fixture();acceptedReadiness(h);const id=crypto.randomUUID();let sends=0;
 h.m.client.user={id:h.user};h.m.client.state={users:{}};h.m._buildFullMessageWithQuoted=async x=>x;
 h.api.sendMessage=async(_t,_id,body)=>{sends++;assert.equal(body.message.id,id);
  const clear=h.issuer.group.process_application_message(h.issuer.provider,body.message.mls_ciphertext,undefined);
  assert.equal(JSON.parse(new TextDecoder().decode(clear.content)).text,'retained old channel send');
  return {message:{id,msg_seq:1,last_event_seq:1,created_at:new Date().toISOString()}};};
 await h.m.sendMessage('team',h.user,h.cid,'retained old channel send',id);
 assert.equal(sends,1);assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);
 const pending=await h.s.loadPendingE2eeSend(id);assert.ok(pending===null||pending.status==='sent');await h.close();
});
test('normal readiness unknown receipt retains exact candidate and does not publish Ready',async()=>{
 const h=await fixture(),before=h.posts();let replay;
 h.api.externalJoin=async(_t,_id,body)=>{replay=body;};
 const result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'send'});
 assert.equal(result.status,'pending_external_join');assert.deepEqual(replay,h.job.body);assert.equal(h.posts(),before);
 assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);await h.preserve();await h.close();
});
for(const fence of ['manual','uncertain','expired'])test(`normal pending receipt recovery preserves ${fence} fence`,async()=>{
 const h=await fixture();let reads=0;h.api.getExternalJoinReceipt=async()=>{reads++;throw Error('fenced HTTP forbidden');};
 if(fence==='manual')h.m._recoveryControls.set(h.cid,{recovery_action:'manual_intervention_required',recovery_revision:'1'});
 else if(fence==='expired')h.m._recoveryControls.set(h.cid,{recovery_action:'repair',repair_retry_until:new Date(Date.now()-1000).toISOString(),recovery_revision:'1'});
 else h.m._providerPersistenceUncertain=true;
 const result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'send'});assert.notEqual(result.status,'ready');assert.equal(reads,0);
 assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);await h.preserve();await h.close();
});
test('normal pending receipt recovery cannot install after transport owner replacement',async()=>{
 const h=await fixture(),entered=latch(),release=latch();
 h.api.getExternalJoinReceipt=async()=>{entered.resolve();await release.promise;return acceptedReceipt(h);};
 const work=h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'}),failed=assert.rejects(work,e=>e.code==='recovery_scope_changed');
 await entered.promise;h.m.e2eeClient={};release.resolve();await failed;
 assert.equal(h.m.groups.has(h.cid),false);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);await h.preserve();await h.close();
});
test('POST accepted before recovery-control change retires attempt; next normal open adopts same UUID',async()=>{
 const h=await fixture(false);let receipt,posts=0;
 h.api.getExternalJoinReceipt=async(_t,_id,op)=>receipt??h.unknown(op);
 h.api.externalJoin=async(_t,_id,body)=>{
  posts++;assert.equal(posts,1);h.job=await h.s.loadExternalJoinCandidateCheckpoint(h.cid);receipt=acceptedReceipt(h);
  h.issuer.group.process_message(h.issuer.provider,body.commit);
  await h.m._applyRecoveryControl(h.cid,{group_generation:0,group_id:null,incident_id:null,recovery_action:'none',recovery_revision:'1',repair_retry_until:null});
 };
 await assert.rejects(h.join(),e=>e.code==='recovery_scope_changed');
 assert.equal(h.m.groups.has(h.cid),false);assert.ok(await h.s.loadExternalJoinCandidateCheckpoint(h.cid));
 h.m._syncChannelFromCursor=async()=>({cid:h.cid,status:'ready',epoch:1,has_more:false,needs_retry:false});
 const result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
 assert.equal(result.status,'ready');assert.equal(posts,1);assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);
 assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.privateRef),true);await h.close();
});
async function put(h,key,value,store='meta'){const db=await h.s.openDB();await new Promise((yes,no)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=yes;tx.onabort=()=>no(tx.error);});}
for(const scope of ['account','device','identity','storage','transport','client','artifact','provider','marker','control','pending','candidate','cleanup','route','auth'])test('held External Join receipt cannot continue after '+scope+' replacement',async()=>{
 const h=await fixture(),gate=latch(),entered=latch(),before=h.posts(),events=h.events.length;
 h.api.getExternalJoinReceipt=async(_t,_id,op)=>{entered.resolve();await gate.promise;return h.unknown(op);};
 const work=h.join(),failed=assert.rejects(work);await entered.promise;
 if(scope==='account')h.m.userId='other';if(scope==='device')h.m.deviceId='other';if(scope==='identity')h.m.identity=wasm.Identity.from_bytes(h.m._activeProvider,h.m.identity.to_bytes());
 if(scope==='storage')h.m.storage=new IndexedDBEncryptionStorage(h.user);if(scope==='transport')h.m.e2eeClient={};if(scope==='client')h.m.client={};if(scope==='artifact')h.m._wasmArtifactSha256='f'.repeat(64);
 if(scope==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.base.provider_bytes);if(scope==='marker')h.m._groupGenerations.set(h.cid,{cid:h.cid,status:'historical'});
 if(scope==='control')h.m._recoveryControls.set(h.cid,{recovery_revision:'99',recovery_action:'manual_intervention_required'});
 if(scope==='pending')h.m._pendingMlsMutations.set(h.cid,{});if(scope==='candidate')h.m._externalJoinCandidates.set(h.cid,structuredClone(h.job));if(scope==='cleanup')h.m._mlsCleanupRevisions.set(h.cid,{});
 if(scope==='route')h.m.client.baseURL='https://other.invalid';if(scope==='auth')h.bumpAuth();
 gate.resolve();await failed;assert.equal(h.posts(),before);assert.equal(h.events.length,events);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);await h.preserve();await h.close();
});
for(const phase of ['candidate','control','groupinfo','restore'])test('scope is captured before held '+phase+' read',async()=>{
 const h=await fixture(phase!=='groupinfo'),gate=latch(),entered=latch();let work;
 if(phase==='candidate'){const load=h.s.loadExternalJoinCandidateCheckpoint.bind(h.s);h.s.loadExternalJoinCandidateCheckpoint=async(...a)=>{entered.resolve();await gate.promise;return load(...a);};work=h.join();}
 if(phase==='control'){const load=h.s.loadRecoveryControlCheckpoint.bind(h.s);h.s.loadRecoveryControlCheckpoint=async(...a)=>{entered.resolve();await gate.promise;return load(...a);};work=h.m._joinExternalCore('team',h.user,h.cid);}
 if(phase==='groupinfo'){h.api.getGroupInfo=async()=>{entered.resolve();await gate.promise;return h.info;};work=h.join();}
 if(phase==='restore'){const load=h.s.takeExternalJoinCandidatePage.bind(h.s);h.s.takeExternalJoinCandidatePage=async(...args)=>{entered.resolve();await gate.promise;return load(...args);};h.m._externalJoinCandidates.clear();work=h.m._restoreGroupsLocally();}
 const failed=assert.rejects(work);await entered.promise;h.m.e2eeClient={};gate.resolve();await failed;
 assert.equal(h.m._externalJoinCandidates.size,phase==='groupinfo'||phase==='restore'?0:1);assert.equal(h.m.groups.size,0);await h.preserve();await h.close();
});
test('old error/finally cannot clear replacement promise or sending token; duplicate follows replacement',async()=>{
 const h=await fixture(),first=latch(),second=latch(),entered1=latch(),entered2=latch();
 h.api.externalJoin=async()=>{entered1.resolve();await first.promise;throw Error('late old HTTP error');};const old=h.join(),oldFailed=assert.rejects(old);await entered1.promise;
 const newApi={...h.api,externalJoin:async()=>{entered2.resolve();await second.promise;}};h.m.e2eeClient=newApi;
 const next=h.join(),nextFailed=assert.rejects(next,e=>e.code==='transport_unknown');await entered2.promise;const work=h.m._externalJoinWork.get(h.cid),sending=h.m._externalJoinSendingOwners.get(h.cid);
 first.resolve();await oldFailed;assert.equal(h.m._externalJoinWork.get(h.cid),work);assert.equal(h.m._externalJoinSendingOwners.get(h.cid),sending);assert.equal(h.m._sendingMlsMutations.has(h.cid),true);
 const duplicate=h.join(),duplicateFailed=assert.rejects(duplicate,e=>e.code==='transport_unknown');await Promise.resolve();assert.equal(h.m._externalJoinWork.get(h.cid),work);
 second.resolve();await nextFailed;await duplicateFailed;assert.equal(h.m._sendingMlsMutations.has(h.cid),false);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);await h.preserve();await h.close();
});
test('late own replay receipt cannot reject a replacement candidate',async()=>{
 const h=await fixture(),gate=latch(),entered=latch(),event='own-external-event',context={version:1,event_id:event,cid:h.cid,group_generation:0,epoch:h.job.body.epoch,accepted_at:Math.floor(Date.now()/1000),payload_sha256:h.job.commit_sha256,provenance:'bellboy_transition_v1'};
 h.api.getExternalJoinReceipt=async()=>{entered.resolve();await gate.promise;return h.rejection();};
 const work=h.m.processOwnMlsCommit(h.cid,{commit:h.job.body.commit,epoch:h.job.body.epoch,group_generation:0},{acceptanceContext:context,acceptanceEnvelope:{event_id:event,cid:h.cid,group_generation:0,epoch:h.job.body.epoch}}),failed=assert.rejects(work);
 await entered.promise;const replacement=structuredClone(h.job);h.m._externalJoinCandidates.set(h.cid,replacement);gate.resolve();await failed;
 assert.equal(h.m._externalJoinCandidates.get(h.cid),replacement);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);assert.equal(await h.s.loadExternalJoinRejectionCheckpoint(h.cid,h.job.body.operation_id),null);await h.preserve();await h.close();
});
for(const capability of ['externalJoinRejectionWorkVersion','saveExternalJoinRejectionWork'])test('missing '+capability+' retains exact pending candidate and old private state',async()=>{
 const h=await fixture(),before=await h.s.loadMlsReadyBase(h.user,h.device,h.cid);h.s[capability]=undefined;
 await assert.rejects(h.m._activateExternalJoinCandidate(h.job,h.rejection()),e=>e.code==='client_upgrade_required');assert.deepEqual(await h.s.loadMlsReadyBase(h.user,h.device,h.cid),before);await h.preserve();await h.close();
});
for(const fault of ['abort','readback','unknown','provider','identity','control','marker','cursor','ack','candidate','rejection'])test('full owned canonical rejection '+fault+' preserves winning private state and pending proof',async()=>{
 const h=await fixture(),prior=await h.s.loadMlsReadyBase(h.user,h.device,h.cid),save=h.s.saveExternalJoinRejectionWork.bind(h.s),db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false,winner;
 h.s.saveExternalJoinRejectionWork=async(...args)=>{
  if(fault==='unknown'){await save(...args);throw Error('unknown committed rejection');}
  db.transaction=(...a)=>{const t=original(...a);if(a[1]==='readwrite'){
   if(fault==='abort')queueMicrotask(()=>t.abort());else t.addEventListener('complete',()=>{committed=true;
    if(!['readback'].includes(fault)){const tx=original(['meta','identity','groups'],'readwrite'),meta=tx.objectStore('meta');
     if(fault==='provider'){const p=wasm.Provider.from_bytes(h.base.provider_bytes),id=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=id.key_package(p);kp.free();winner={provider_bytes:p.to_bytes(),revision:crypto.randomUUID()};meta.put(winner.provider_bytes,`provider:${h.user}:${h.device}`);meta.put(winner.revision,`provider_revision:${h.user}:${h.device}`);id.free();p.free();}
     if(fault==='identity'){winner=Uint8Array.of(255);tx.objectStore('identity').put(winner,`${h.user}:${h.device}`);}
     if(fault==='control'){winner={version:99};meta.put(winner,`recovery_control:v1:device:${encodeURIComponent(h.cid)}`);}
     if(fault==='marker'){winner={cid:h.cid,status:'historical'};tx.objectStore('groups').put(winner,h.cid);}
     if(fault==='cursor'){winner={created_at:new Date().toISOString(),event_id:'winning-cursor'};meta.put(winner,`scope_sync:${h.cid}`);}
     if(fault==='ack'){winner={version:99};meta.put(winner,`gi_validation_ack:v1:device:${encodeURIComponent(h.cid)}`);}
     if(fault==='candidate'){winner={...h.job,created_at:h.job.created_at+1};meta.put(winner,`external_candidate:v1:${h.cid}`);}
     if(fault==='rejection'){winner={...h.rejection(),rejected_at:'2026-01-01T00:00:00Z'};meta.put(winner,`external_rejection:v1:${encodeURIComponent(h.cid)}:${h.job.body.operation_id}`);}
    }
   });
  }if(a[1]==='readonly'&&committed&&fault==='readback')queueMicrotask(()=>t.abort());return t;};
  try{return await save(...args);}finally{db.transaction=original;}
 };
 await assert.rejects(h.m._activateExternalJoinCandidate(h.job,h.rejection()));db.transaction=original;
 assert.equal(h.m._externalJoinCandidates.has(h.cid),true);assert.equal(h.m.groups.has(h.cid),false);
 const actual=await h.s.loadMlsReadyBase(h.user,h.device,h.cid);
 if(fault==='abort')assert.deepEqual(actual,prior);if(fault==='provider')assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner);
 if(fault==='identity')assert.deepEqual(actual.identity_bytes,winner);if(fault==='control')assert.deepEqual(actual.control,winner);if(fault==='marker')assert.deepEqual(actual.cleanup.marker,winner);
 if(fault==='cursor')assert.deepEqual(actual.cleanup.metadata[`scope_sync:${h.cid}`],winner);if(fault==='ack')assert.deepEqual(actual.ack,winner);if(fault==='candidate')assert.deepEqual(actual.cleanup.metadata[`external_candidate:v1:${h.cid}`],winner);
 if(fault==='rejection')assert.deepEqual(await h.s.loadExternalJoinRejectionCheckpoint(h.cid,h.job.body.operation_id),winner);
 if(fault!=='provider')assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),h.base);
 assert.equal(h.m._providerPersistenceUncertain,['provider','identity'].includes(fault));const states=[];h.m.subscribeE2eeState(h.cid,v=>states.push(v));assert.notEqual(states[0].state,'ready');await h.close();
});
test('stale full rejection base cannot delete candidate after private KP winner; current/late state fences',async()=>{
 const h=await fixture(),p=wasm.Provider.from_bytes(h.base.provider_bytes),id=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=id.key_package(p),ref=kp.hash_ref(p);kp.free();
 const winner={provider_bytes:p.to_bytes(),revision:crypto.randomUUID()};await put(h,`provider:${h.user}:${h.device}`,winner.provider_bytes);await put(h,`provider_revision:${h.user}:${h.device}`,winner.revision);
 await assert.rejects(h.m._activateExternalJoinCandidate(h.job,h.rejection()));assert.equal(h.m._providerPersistenceUncertain,true);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner);assert.equal(id.owns_key_package_ref(p,ref),true);id.free();p.free();await h.close();
});

test('manual pause survives restart; only newer authoritative control reopens the retained exact UUID',async()=>{
 const h=await fixture(),control={version:1,user_id:h.user,device_id:h.device,cid:h.cid,signing_identity_sha256:sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:'00000000-0000-4000-8000-000000000001',recovery_action:'manual_intervention_required',recovery_revision:'5',repair_retry_until:new Date(Date.now()+900000).toISOString()};
 await h.s.saveRecoveryControlCheckpoint(control);const before=h.reads();await assert.rejects(h.join(),e=>e.code==='manual_intervention_required');assert.equal(h.reads(),before);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);
 const m=new EncryptionManager();Object.assign(m,{userId:h.user,deviceId:h.device,storage:h.s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(binary),e2eeClient:h.api,client:h.m.client});await m._initWasm();await m._initIdentity();await m._restoreGroupsLocally();m.initialized=true;
 await m._resumeExternalJoinCandidates();assert.equal(h.reads(),before);assert.equal(m.getE2eeState(h.cid).state,'manual_intervention_required');
 const state=revision=>({group_generation:0,group_id:null,current_epoch:0,membership_version:'1',state:'ready',reason:'fixture',retryable:true,incident_id:control.incident_id,recovery_action:'repair',recovery_revision:revision,repair_retry_until:control.repair_retry_until});
 await m._applyRecoveryControl(h.cid,state('4'));await m._resumeExternalJoinCandidates();assert.equal(h.reads(),before);
 await m._applyRecoveryControl(h.cid,state('6'));await m._resumeExternalJoinCandidates();assert.equal(h.reads(),before+2);assert.equal((await h.s.loadExternalJoinCandidateCheckpoint(h.cid)).body.operation_id,h.job.body.operation_id);assert.notEqual(m.getE2eeState(h.cid).state,'ready');await h.close();
});

test('learned rejection private conflict demotes an independent current and late Ready without losing winning KP',async()=>{
 const h=await fixture(),cid=h.cid+'-ready',g=wasm.Group.create_with_cid(h.m._activeProvider,h.m.identity,cid),marker={cid,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1};h.m.groups.set(cid,g);h.m._groupGenerations.set(cid,marker);await h.s.saveGroupState(cid,marker);
 h.m.client.activeChannels[cid]={data:{mls_enabled:true},state:{members:{[h.user]:{user_id:h.user}}}};const control={version:1,user_id:h.user,device_id:h.device,cid,signing_identity_sha256:sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:'00000000-0000-4000-8000-000000000001',recovery_action:'repair',recovery_revision:'1',repair_retry_until:new Date(Date.now()+900000).toISOString()};await h.s.saveRecoveryControlCheckpoint(control);await h.m._loadRecoveryControl(cid);await h.m._persistProviderStrict();h.m._armValidationAckRetry=()=>{};
 assert.equal((await h.m.refreshE2eeState(cid)).state,'ready');const seen=[];h.m.subscribeE2eeState(cid,v=>seen.push(v));
 const p=wasm.Provider.from_bytes(h.m._activeProvider.to_bytes()),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p),ref=kp.hash_ref(p);kp.free();const winner={provider_bytes:p.to_bytes(),revision:crypto.randomUUID()};await put(h,`provider:${h.user}:${h.device}`,winner.provider_bytes);await put(h,`provider_revision:${h.user}:${h.device}`,winner.revision);
 await assert.rejects(h.m._activateExternalJoinCandidate(h.job,h.rejection()));assert.notEqual(seen.at(-1).state,'ready');assert.notEqual(h.m.getE2eeState(cid).state,'ready');const late=[];h.m.subscribeE2eeState(cid,v=>late.push(v));assert.notEqual(late[0].state,'ready');assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner);assert.equal(i.owns_key_package_ref(p,ref),true);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);i.free();p.free();await h.close();
});

test('initial GroupInfo is frozen before candidate read, preserving actual MLS input across caller mutation',async()=>{
 const h=await fixture(false),entered=latch(),gate=latch(),load=h.s.loadExternalJoinCandidateCheckpoint.bind(h.s);let once=true;
 h.s.loadExternalJoinCandidateCheckpoint=async(...a)=>{if(once){once=false;entered.resolve();await gate.promise;}return load(...a);};
 const info={...h.info,group_info:new Uint8Array(h.info.group_info)},work=h.m.joinExternal('team',h.user,h.cid,info),failed=assert.rejects(work,e=>e.code==='transport_unknown');await entered.promise;info.epoch=999;info.group_info.fill(0);gate.resolve();await failed;
 const job=await load(h.cid);assert.equal(job.body.epoch,1);assert.notEqual(job.commit_sha256,sha256Hex(info.group_info));await h.preserve();await h.close();
});
test('scope change during stale GroupInfo reporting cannot start a replacement coordinator wait',async()=>{
 const h=await fixture(false),entered=latch(),gate=latch();let waits=0;h.api.getGroupInfo=async()=>({...h.info,is_stale:true});h.m._groupInfoRepair={reportExternalJoinFailure:async()=>{entered.resolve();await gate.promise;},waitForNewerGroupInfo:async()=>{waits++;return h.info;}};
 const work=h.join(),failed=assert.rejects(work);await entered.promise;h.m.e2eeClient={};gate.resolve();await failed;assert.equal(waits,0);assert.equal(h.posts(),0);assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);await h.preserve();await h.close();
});
test('transport cannot mutate retained candidate through its submitted body reference',async()=>{
 const h=await fixture();h.api.externalJoin=async(_t,_id,body)=>{body.operation_id=crypto.randomUUID();body.commit.fill(0);};await assert.rejects(h.join(),e=>e.code==='transport_unknown');
 assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);assert.deepEqual(h.m._externalJoinCandidates.get(h.cid),h.job);await h.preserve();await h.close();
});

test('mismatched route cannot send a valid candidate to another channel endpoint',async()=>{
 const h=await fixture(),reads=h.reads(),posts=h.posts();await assert.rejects(h.m.joinExternal('team','other',h.cid),e=>e.code==='external_join_checkpoint_invalid');await assert.rejects(h.m._joinExternalCore('team','other',h.cid),e=>e.code==='external_join_checkpoint_invalid');assert.equal(h.reads(),reads);assert.equal(h.posts(),posts);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);await h.preserve();await h.close();
});
test('candidate read cannot adopt a different durable operation into the captured continuation',async()=>{
 const h=await fixture(),load=h.s.loadExternalJoinCandidateCheckpoint.bind(h.s),before=h.reads(),replacement={...h.job,created_at:h.job.created_at+1};h.s.loadExternalJoinCandidateCheckpoint=async()=>replacement;
 await assert.rejects(h.join(),e=>e.code==='recovery_scope_changed');assert.equal(h.reads(),before);assert.deepEqual(h.m._externalJoinCandidates.get(h.cid),h.job);assert.deepEqual(await load(h.cid),h.job);await h.preserve();await h.close();
});

test('batch topic helper uses canonical isolated UUID/GI receipt flow and sends no later GI POST',async()=>{
 const h=await fixture(false,'topic');let receipt,posts=0,uploads=0;
 h.m._resolveChannelE2eeGroupId=cid=>cid;
 h.api.batchExternalJoinTopics=async()=>{throw Error('legacy batch bypass');};
 h.api.uploadGroupInfo=async()=>{uploads++;};
 h.api.getExternalJoinReceipt=async(_t,_i,op)=>receipt||h.unknown(op);
 h.api.externalJoin=async(type,id,body)=>{
   posts++;assert.equal(type,'topic');assert.equal(id,h.user);
   const saved=await h.s.loadExternalJoinCandidateCheckpoint(h.cid);assert.deepEqual(saved.body,body);
   const event=crypto.randomUUID();
   receipt={version:1,state:'accepted',operation_id:body.operation_id,cid:h.cid,group_generation:0,epoch:body.epoch,
     group_id:null,commit_sha256:sha256Hex(body.commit),group_info_sha256:sha256Hex(body.group_info),event_id:event,delivery_pending:false,
     acceptance_context:{version:1,event_id:event,cid:h.cid,group_generation:0,epoch:body.epoch,
       accepted_at:Math.floor(Date.now()/1000),payload_sha256:sha256Hex(body.commit),provenance:'bellboy_transition_v1'}};
   const p=new wasm.Provider(),i=new wasm.Identity(p,'following-topic-device');
   const joined=wasm.Group.join_external_with_policy(p,i,body.group_info,null,false);assert.equal(Number(joined.group.epoch()),2);
 };
 const response=await h.m.batchExternalJoinTopics('team','parent',[h.cid,h.cid]);
 assert.deepEqual(response.results,[{topic_cid:h.cid,success:true,epoch:1}]);assert.equal(posts,1);assert.equal(uploads,0);
 assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);await h.close();
});
test('batch topic unknown outcome retains isolated candidate and does not adopt live state',async()=>{
 const h=await fixture(false,'topic');h.m._resolveChannelE2eeGroupId=cid=>cid;
 const before=await h.s.loadProviderCheckpoint(h.user,h.device);
 const response=await h.m.batchExternalJoinTopics('team','parent',[h.cid]);
 assert.equal(response.results[0].success,false);assert.ok(await h.s.loadExternalJoinCandidateCheckpoint(h.cid));
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);assert.equal(h.m.groups.has(h.cid),false);
 assert.equal((await h.s.listPendingMlsMutations()).length,0);await h.close();
});
