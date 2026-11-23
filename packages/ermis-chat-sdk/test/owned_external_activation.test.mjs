import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import init,* as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager,IndexedDBEncryptionStorage,sha256Hex}=createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const binary=fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url));await init({module_or_path:binary});let sequence=0;
const enc=encodeURIComponent,latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function fixture(pending=true,generation=0,existingCursor=null,retainedWelcome=true){
 const user='external-activation-'+ ++sequence,device='device',cid='team:'+user,peer=cid+'-peer',s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager(),events=[];
 Object.assign(m,{userId:user,deviceId:device,storage:s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(binary)});await m._initWasm();await m._initIdentity();m.initialized=true;m.client={activeChannels:{},dispatchEvent:e=>events.push(e)};m._armValidationAckRetry=()=>{};m.safeArchiveCurrentEpoch=async()=>{};m.ensureKeyPackagesFromServer=async()=>{};
 const g=wasm.Group.create_with_cid(m._activeProvider,m.identity,peer),marker={cid:peer,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1};m.groups.set(peer,g);m._groupGenerations.set(peer,marker);await s.saveGroupState(peer,marker);
 for(const id of [cid,peer])m.client.activeChannels[id]={data:{mls_enabled:true},state:{members:{[user]:{user_id:user}}}};
 if(existingCursor)await s.saveScopeSyncCursor(cid,existingCursor);
 const kp=m.identity.key_package(m._activeProvider),ref=kp.hash_ref(m._activeProvider);kp.free();await m._persistProviderStrict();
 const p=new wasm.Provider(),i=new wasm.Identity(p,'remote'),groupId=generation?Uint8Array.of(42,43,sequence%255):null,remote=generation?wasm.Group.create_with_group_id(p,i,groupId):wasm.Group.create_with_cid(p,i,cid),otherP=new wasm.Provider(),otherI=new wasm.Identity(otherP,'other'),otherKp=otherI.key_package(otherP),bundle=remote.add_members(p,i,[otherKp]);remote.merge_pending_commit(p);otherI.free();otherP.free();
 const event='00000000-0000-4000-8000-000000000011',created_at=new Date().toISOString(),context={version:1,event_id:event,cid,group_generation:generation,epoch:Number(remote.epoch()),accepted_at:Math.floor(Date.now()/1000),payload_sha256:sha256Hex(bundle.welcome),provenance:'bellboy_transition_v1'};
 const protocol={type:'welcome',event_id:event,epoch:Number(remote.epoch()),group_generation:generation,group_id:groupId,welcome:bundle.welcome,ratchet_tree:remote.export_ratchet_tree().to_bytes(),target_user_ids:[user],target_device_ids:[device],acceptance_context:context};
 if(generation)await m._applyRecoveryControl(cid,{group_generation:generation,group_id:groupId,current_epoch:1,membership_version:'1',state:'ready',reason:'fixture',retryable:true,incident_id:'00000000-0000-4000-8000-000000000020',recovery_action:'repair',recovery_revision:'1',repair_retry_until:new Date(Date.now()+900000).toISOString()});
 if(retainedWelcome)assert.equal(await m.processMlsWelcome(cid,protocol,{acceptanceContext:context,acceptanceEnvelope:{event_id:event,cid,group_generation:generation,epoch:protocol.epoch}},{event_id:event,created_at}),'pending_external_join');
 let posts=0,reads=0;const unknown=op=>({version:1,operation_id:op,cid,state:'outcome_unknown',delivery_pending:false,group_generation:null,epoch:null,group_id:null,commit_sha256:null,event_id:null,acceptance_context:null});
 const api={getGroupInfo:async()=>({group_info:remote.export_group_info(p,i,true),epoch:Number(remote.epoch()),hash:'fixture',is_stale:false,group_generation:generation,group_id:groupId,external_join_prerequisite:{reason:'active_member_recovery'}}),getExternalJoinReceipt:async(_t,_id,op)=>{reads++;return unknown(op);},externalJoin:async()=>{assert.equal(m._providerCheckpointInFlight,false);posts++;},uploadGroupInfo:async()=>{}};m.e2eeClient=api;
 const join=()=>m.joinExternal('team',user,cid);if(pending)await assert.rejects(join(),e=>e.code==='transport_unknown');
 const job=await s.loadExternalJoinCandidateCheckpoint(cid),base=await s.loadProviderCheckpoint(user,device),identity=await s.loadIdentity(user,device);
 const accepted=j=>{const id='00000000-0000-4000-8000-000000000012';return{version:1,operation_id:j.body.operation_id,cid,state:'accepted',delivery_pending:true,group_generation:j.marker.group_generation,epoch:j.body.epoch,group_id:j.marker.group_id,commit_sha256:j.commit_sha256,group_info_sha256:j.group_info_sha256,event_id:id,acceptance_context:{version:1,event_id:id,cid,group_generation:j.marker.group_generation,epoch:j.body.epoch,accepted_at:Math.floor(Date.now()/1000),payload_sha256:j.commit_sha256,provenance:'bellboy_transition_v1'}};};
 async function verifyPrivate(bytes){const q=wasm.Provider.from_bytes(bytes),id=wasm.Identity.from_bytes(q,identity);assert.equal(id.owns_key_package_ref(q,ref),true);const survivor=wasm.Group.load(q,peer);assert.equal(Number(survivor.epoch()),0);survivor.free();id.free();q.free();}
 async function restart(){const next=new EncryptionManager();Object.assign(next,{userId:user,deviceId:device,storage:s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(binary),client:m.client,e2eeClient:api});await next._initWasm();await next._initIdentity();await next._restoreGroupsLocally();next.initialized=true;next._armValidationAckRetry=()=>{};return next;}
 return{m,s,user,device,cid,peer,job,base,identity,accepted,api,join,event,protocol,context,generation,groupId,verifyPrivate,restart,events,posts:()=>posts,reads:()=>reads,close:async()=>{await s.close();remote.free();i.free();p.free();}};
}
async function put(h,key,value,store='meta'){const db=await h.s.openDB();await new Promise((yes,no)=>{const tx=db.transaction(store,'readwrite');if(value===undefined)tx.objectStore(store).delete(key);else tx.objectStore(store).put(value,key);tx.oncomplete=yes;tx.onabort=()=>no(tx.error);});}
async function mutate(h,field,base,job,transaction){
 const t=transaction(['meta','identity','groups'],'readwrite'),meta=t.objectStore('meta');let key,value;
 if(field==='provider'){const p=wasm.Provider.from_bytes(base.state.provider_bytes),i=wasm.Identity.from_bytes(p,h.identity),kp=i.key_package(p);kp.free();value={provider_bytes:p.to_bytes(),revision:crypto.randomUUID()};meta.put(value.provider_bytes,`provider:${h.user}:${h.device}`);meta.put(value.revision,`provider_revision:${h.user}:${h.device}`);i.free();p.free();}
 if(field==='identity'){key=`${h.user}:${h.device}`;value=Uint8Array.of(255);t.objectStore('identity').put(value,key);}
 if(field==='marker'){key=h.cid;value={...job.marker,status:'historical'};t.objectStore('groups').put(value,key);}
 if(field==='control'){key=`recovery_control:v1:device:${enc(h.cid)}`;value={version:99};}
 if(field==='candidate'){key=`external_candidate:v1:${h.cid}`;value={...job,created_at:job.created_at+1};}
 if(field==='accepted'){key=`external_receipt:v1:${h.cid}`;value={...h.accepted(job),delivery_pending:false};}
 if(field==='rejected'){key=`external_rejection:v1:${enc(h.cid)}:${job.body.operation_id}`;value={version:99,state:'rejected'};}
 if(field==='primary'){key=Object.keys(base.welcome_primary)[0];value={...base.welcome_primary[key],payload_sha256:'f'.repeat(64)};}
 if(field==='index'){key=Object.keys(base.welcome_pending)[0];const primaryKey=Object.keys(base.welcome_primary)[0];const row=key?base.welcome_pending[key]:base.welcome_primary[primaryKey];key ||= primaryKey.replace('welcome_recovery:','welcome_pending:');value={...row,status:'pending_external_join',checkpoint:undefined,payload_sha256:'f'.repeat(64)};}
 if(field==='cursor'){key=`scope_sync:${h.cid}`;value={created_at:new Date().toISOString(),event_id:'winning-cursor'};}
 if(field==='ack'){key=`gi_validation_ack:v1:device:${enc(h.cid)}`;value={version:99};}
 if(field==='admission'){key=`gi_validation_admission:v1:device:${enc(h.cid)}`;value={version:99};}
 if(!['provider','identity','marker'].includes(field))meta.put(value,key);
 await new Promise((yes,no)=>{t.oncomplete=yes;t.onabort=()=>no(t.error);});return{key,value};
}
for(const phase of ['prepare','activate'])for(const fault of ['abort','readback','unknown'])test('actual full External Join '+phase+' '+fault+' retains the exact private journal boundary',async()=>{
 const h=await fixture(phase==='activate'),save=h.s.saveExternalJoinWork.bind(h.s),db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false,candidate;
 h.s.saveExternalJoinWork=async(...args)=>{if(args[4].kind!==phase)return save(...args);candidate=args[4].candidate;
  if(fault==='unknown'){await save(...args);throw Error('commit acknowledgement lost');}
  db.transaction=(...a)=>{const tx=original(...a);if(a[1]==='readwrite'){if(fault==='abort')queueMicrotask(()=>tx.abort());else tx.addEventListener('complete',()=>{committed=true;});}if(a[1]==='readonly'&&committed&&fault==='readback')queueMicrotask(()=>tx.abort());return tx;};try{return await save(...args);}finally{db.transaction=original;}};
 await assert.rejects(phase==='prepare'?h.join():h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job)));db.transaction=original;
 const durable=await h.s.loadProviderCheckpoint(h.user,h.device);await h.verifyPrivate(durable.provider_bytes);
 if(phase==='prepare'||fault==='abort'){assert.deepEqual(durable,h.base);assert.equal(h.m._providerPersistenceUncertain,false);assert.equal(h.m.groups.has(h.cid),false);}
 else{assert.equal(h.m._providerPersistenceUncertain,true);assert.notDeepEqual(durable,h.base);assert.equal(h.m.groups.has(h.cid),false);}
 const work=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,candidate.body.operation_id);
 if(fault==='abort'){assert.equal(work.accepted,null);assert.equal(Object.values(work.welcome_pending)[0].status,'pending_external_join');}
 else if(phase==='prepare'){assert.deepEqual(work.state.cleanup.metadata[`external_candidate:v1:${h.cid}`],candidate);assert.equal(h.posts(),0);}
 else{assert.equal(work.accepted.operation_id,candidate.body.operation_id);assert.equal(work.state.cleanup.metadata[`external_candidate:v1:${h.cid}`],null);assert.equal(Object.values(work.welcome_primary)[0].status,'superseded_by_recovery');assert.equal(Object.keys(work.welcome_pending).length,0);}
 const next=await h.restart();if(phase==='activate'&&fault!=='abort'){assert.equal(next.groups.has(h.cid),true);assert.equal((await next.refreshE2eeState(h.cid)).state,'ready');}await h.close();
});
for(const phase of ['prepare','activate'])for(const timing of ['before','after'])for(const field of ['provider','identity','marker','control','candidate','accepted','rejected','primary','index','cursor','ack','admission'])test('full '+phase+' '+timing+' '+field+' winner cannot be overwritten or published',async()=>{
 const h=await fixture(phase==='activate'),save=h.s.saveExternalJoinWork.bind(h.s),db=await h.s.openDB(),original=db.transaction.bind(db);let winner,captured,job;
 h.s.saveExternalJoinWork=async(...args)=>{if(args[4].kind!==phase)return save(...args);captured=args[3];job=args[4].candidate;
  if(timing==='before'){winner=await mutate(h,field,captured,job,original);return save(...args);}
  db.transaction=(...a)=>{const tx=original(...a);if(a[1]==='readwrite')tx.addEventListener('complete',()=>{void mutate(h,field,captured,job,original).then(v=>{winner=v;});});return tx;};try{return await save(...args);}finally{db.transaction=original;}};
 await assert.rejects(phase==='prepare'?h.join():h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job)));db.transaction=original;assert.equal(h.m.groups.has(h.cid),false);assert(winner);
 const durable=await h.s.loadProviderCheckpoint(h.user,h.device);
 if(field==='provider'){assert.deepEqual(durable,winner.value);await h.verifyPrivate(durable.provider_bytes);}else if(timing==='before'||phase==='prepare')assert.deepEqual(durable,h.base);else await h.verifyPrivate(durable.provider_bytes);
 if(winner.key){const store=field==='identity'?'identity':field==='marker'?'groups':'meta',t=original(store,'readonly'),r=t.objectStore(store).get(winner.key);await new Promise((yes,no)=>{t.oncomplete=yes;t.onabort=()=>no(t.error);});assert.deepEqual(r.result,winner.value);}
 assert.equal(h.m._providerPersistenceUncertain,phase==='activate'&&timing==='after'||['provider','identity'].includes(field));await h.close();
});
test('actual accepted full proof preserves unrelated KP/group/cursor, supersedes only eligible Welcome, then local Ready does not wait for ACK network',async()=>{
 const h=await fixture(),cursor={created_at:new Date().toISOString(),event_id:'retained-peer-cursor'};await h.s.saveScopeSyncCursor(h.peer,cursor);
 await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));assert.equal(h.m.groups.has(h.cid),true);assert.equal(h.m.getEpoch(h.cid),2);await h.verifyPrivate((await h.s.loadProviderCheckpoint(h.user,h.device)).provider_bytes);assert.deepEqual(await h.s.loadScopeSyncCursor(h.peer),cursor);
 const work=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);assert.equal(Object.keys(work.welcome_pending).length,0);assert.equal(Object.values(work.welcome_primary)[0].checkpoint.receipt.operation_id,h.job.body.operation_id);
 const seen=[];h.m.subscribeE2eeState(h.cid,v=>seen.push(v));assert.notEqual(seen[0].state,'ready');assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');const late=[];h.m.subscribeE2eeState(h.cid,v=>late.push(v));assert.equal(late[0].state,'ready');assert.equal(h.posts(),1);await h.close();
});
for(const field of ['receipt_missing','receipt_digest','receipt_epoch','primary_missing','index_orphan','legacy_readiness','capability'])test('restart Ready cannot cross '+field+' without a composed external proof',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id),key=Object.keys(base.welcome_primary)[0];
 if(field==='receipt_missing')await put(h,`external_receipt:v1:${h.cid}`,undefined);if(field==='receipt_digest')await put(h,`external_receipt:v1:${h.cid}`,{...base.accepted,commit_sha256:'f'.repeat(64)});
 if(field==='receipt_epoch')await put(h,`external_receipt:v1:${h.cid}`,{...base.accepted,epoch:999});if(field==='primary_missing')await put(h,key,undefined);
 if(field==='index_orphan')await put(h,key.replace('welcome_recovery:','welcome_pending:'),Object.values(base.welcome_primary)[0]);
 if(field==='legacy_readiness')await put(h,`external_join_readiness:${h.cid}`,{cid:h.cid,status:'joined_external',first_decryptable_epoch:999});
 const next=await h.restart();if(field==='capability')h.s.externalJoinReadyCheckpointVersion=undefined;
 const value=await next.refreshE2eeState(h.cid);assert.notEqual(value.state,'ready');await h.close();
});
for(const kind of ['primary','pending'])test('101st Welcome '+kind+' row is typed backlog, never truncated or deleted',async()=>{
 const h=await fixture(),base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id),row=Object.values(base.welcome_pending)[0],prefix=`welcome_${kind==='primary'?'recovery':'pending'}:v1:device:${enc(h.cid)}:`;
 const db=await h.s.openDB();await new Promise((yes,no)=>{const t=db.transaction('meta','readwrite');for(let i=0;i<100;i++){const v={...row,event_cursor:{...row.event_cursor,event_id:'extra-'+i}};t.objectStore('meta').put(v,prefix+enc(v.event_cursor.event_id));}t.oncomplete=yes;t.onabort=()=>no(t.error);});
 await assert.rejects(h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job)),e=>e.code==='welcome_history_backlog');assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),h.base);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);await h.close();
});
for(const cap of ['externalJoinWorkCheckpointVersion','loadExternalJoinWorkBase','saveExternalJoinWork'])test('missing '+cap+' fails before GroupInfo HTTP or candidate mutation',async()=>{
 const h=await fixture(false);h.s[cap]=undefined;let gets=0;h.api.getGroupInfo=async()=>{gets++;throw Error('unexpected HTTP');};await assert.rejects(h.join(),e=>e.code==='client_upgrade_required');assert.equal(gets,0);assert.equal(h.posts(),0);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),h.base);await h.close();
});

for(const scope of ['account','device','storage','identity','provider','base','control','candidate','peer_group'])test('held accepted full-base load rejects '+scope+' replacement without publication',async()=>{
 const h=await fixture(),load=h.s.loadExternalJoinWorkBase.bind(h.s),entered=latch(),gate=latch();h.s.loadExternalJoinWorkBase=async(...a)=>{const value=await load(...a);entered.resolve();await gate.promise;return value;};
 const work=h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job)),failed=assert.rejects(work);await entered.promise;
 if(scope==='account')h.m.userId='other';if(scope==='device')h.m.deviceId='other';if(scope==='storage')h.m.storage=new IndexedDBEncryptionStorage(h.user);if(scope==='identity')h.m.identity=wasm.Identity.from_bytes(h.m._activeProvider,h.identity);
 if(scope==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.base.provider_bytes);if(scope==='base')h.m._providerDurableBase={...h.m._providerDurableBase};if(scope==='control')h.m._recoveryControls.set(h.cid,{recovery_revision:'9'});
 if(scope==='candidate')h.m._externalJoinCandidates.set(h.cid,structuredClone(h.job));if(scope==='peer_group')h.m.groups.set(h.peer,wasm.Group.load(h.m._activeProvider,h.peer));
 gate.resolve();await failed;assert.equal(h.m.groups.has(h.cid),false);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),h.base);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);await h.close();
});
for(const timing of ['before','after'])for(const field of ['accepted','primary','index'])test('joined Ready full '+timing+' '+field+' replacement cannot activate current or late Ready',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id),db=await h.s.openDB(),original=db.transaction.bind(db),save=h.s.saveMlsReadyCheckpoint.bind(h.s);let winner;
 h.s.saveMlsReadyCheckpoint=async(...args)=>{assert(args[0].external_join_base);if(timing==='before'){winner=await mutate(h,field,base,h.job,original);return save(...args);}
 db.transaction=(...a)=>{const tx=original(...a);if(a[1]==='readwrite')tx.addEventListener('complete',()=>{void mutate(h,field,base,h.job,original).then(v=>{winner=v;});});return tx;};try{return await save(...args);}finally{db.transaction=original;}};
 const seen=[];h.m.subscribeE2eeState(h.cid,v=>seen.push(v));assert.notEqual((await h.m.refreshE2eeState(h.cid)).state,'ready');db.transaction=original;assert.notEqual(seen.at(-1).state,'ready');const late=[];h.m.subscribeE2eeState(h.cid,v=>late.push(v));assert.notEqual(late[0].state,'ready');assert(winner);await h.verifyPrivate((await h.s.loadProviderCheckpoint(h.user,h.device)).provider_bytes);await h.close();
});
test('canonical explicit GroupId binds real nonzero preparation, accepted activation and Ready after restart',async()=>{
 const h=await fixture(true,1);assert.deepEqual(h.job.marker.group_id,h.groupId);await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');const next=await h.restart();assert.equal((await next.refreshE2eeState(h.cid)).state,'ready');assert.equal(next.getE2eeState(h.cid).group_generation,1);await h.verifyPrivate((await h.s.loadProviderCheckpoint(h.user,h.device)).provider_bytes);await h.close();
});
test('legacy numeric-only nonzero cannot prepare/POST; exact old private state and failed Welcome remain',async()=>{
 const h=await fixture(false,1);await put(h,`recovery_control:v1:device:${enc(h.cid)}`,undefined);h.m._recoveryControls.delete(h.cid);const before=await h.s.loadProviderCheckpoint(h.user,h.device);await assert.rejects(h.join(),e=>e.code==='mls_generation_binding_pending');assert.equal(h.posts(),0);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);assert.equal((await h.s.listWelcomeRecoveryCheckpoints(h.cid,h.device,100)).length,1);await h.close();
});
for(const receipt of ['unknown','accepted'])test('newer canonical generation keeps old '+receipt+' operation pending without POST or activation',async()=>{
 const h=await fixture(),before=h.posts();await h.m._applyRecoveryControl(h.cid,{group_generation:1,group_id:Uint8Array.of(40,50),current_epoch:3,membership_version:'2',state:'ready',reason:'fixture',retryable:true,incident_id:'00000000-0000-4000-8000-000000000020',recovery_action:'repair',recovery_revision:'2',repair_retry_until:new Date(Date.now()+900000).toISOString()});if(receipt==='accepted')h.api.getExternalJoinReceipt=async()=>h.accepted(h.job);
 await assert.rejects(h.join(),e=>e.code==='canonical_receipt_pending');assert.equal(h.posts(),before);assert.deepEqual(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),h.job);assert.equal(h.m.groups.has(h.cid),false);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),h.base);await h.close();
});
test('local joined Ready and durable ACK retry remain independent through real readonly validation',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));await h.m._applyRecoveryControl(h.cid,{group_generation:0,group_id:null,current_epoch:2,membership_version:'1',state:'ready',reason:'fixture',retryable:true,incident_id:'00000000-0000-4000-8000-000000000020',recovery_action:'repair',recovery_revision:'2',repair_retry_until:new Date(Date.now()+900000).toISOString()});h.m._channelE2ee.set(h.cid,{cid:h.cid,group_generation:0,group_id:null,epoch:2,group_info:{status:'validation_required',ready:false,epoch:2,last_uploaded_at:null},recovery:null});let acks=0;h.api.acknowledgeGroupInfoValidation=async()=>{acks++;throw Error('ACK offline');};h.api.getGroupInfo=async()=>{const bytes=h.m.groups.get(h.cid).export_group_info(h.m._activeProvider,h.m.identity,true);return{group_info:bytes,hash:sha256Hex(bytes),epoch:2,is_stale:false,group_generation:0,group_id:null};};
 assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');await h.m._prepareGroupInfoValidationAck('team',h.user,h.cid);const job=await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device);assert(job);assert.equal(h.m.getE2eeState(h.cid).state,'ready');await h.m._drainGroupInfoValidationAcks();assert.equal(acks,1);const retained=await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device);assert.equal(retained.job_id,job.job_id);assert.equal(retained.attempts,1);assert.equal(h.m.getE2eeState(h.cid).state,'ready');await h.close();
});

test('exact 100-Welcome boundary is retained and completed atomically with one actual accepted operation',async()=>{
 const h=await fixture(),row=(await h.s.listWelcomeRecoveryCheckpoints(h.cid,h.device,100))[0],ready=await h.s.loadExternalJoinReadiness(h.cid);
 for(let i=0;i<99;i++)await h.s.saveWelcomeFailureCheckpoint({...row,event_cursor:{...row.event_cursor,event_id:'bounded-'+String(i).padStart(3,'0')}},ready);
 await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);assert.equal(Object.keys(base.welcome_primary).length,100);assert.equal(Object.keys(base.welcome_pending).length,0);assert.equal(Object.values(base.welcome_primary).every(r=>r.status==='superseded_by_recovery'&&r.checkpoint.receipt.operation_id===h.job.body.operation_id),true);await h.verifyPrivate(base.state.provider_bytes);assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');await h.close();
});
test('composed adapter activation and Ready never fall back to legacy candidate/activation/receipt point methods',async()=>{
 const h=await fixture();h.s.saveExternalJoinCandidateCheckpoint=undefined;h.s.saveExternalJoinActivationCheckpoint=undefined;h.s.loadExternalJoinReceipt=undefined;await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');await h.close();
});

test('unknown primitive after accepted commit fences an independent current/late Ready with actual winning private state intact',async()=>{
 const h=await fixture();assert.equal((await h.m.refreshE2eeState(h.peer)).state,'ready');const seen=[];h.m.subscribeE2eeState(h.peer,v=>seen.push(v));const save=h.s.saveExternalJoinWork.bind(h.s);h.s.saveExternalJoinWork=async(...a)=>{await save(...a);throw 'unknown committed activation';};
 await assert.rejects(h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job)));assert.equal(h.m._providerPersistenceUncertain,true);assert.notEqual(seen.at(-1).state,'ready');const late=[];h.m.subscribeE2eeState(h.peer,v=>late.push(v));assert.notEqual(late[0].state,'ready');assert.equal(h.m._externalJoinCandidates.has(h.cid),true);await h.verifyPrivate((await h.s.loadProviderCheckpoint(h.user,h.device)).provider_bytes);await h.close();
});
test('synchronous target replacement during accepted revision publication retains the replacement and defers live activation',async()=>{
 const h=await fixture();assert.equal((await h.m.refreshE2eeState(h.peer)).state,'ready');const dispatch=h.m.client.dispatchEvent,winning={...h.job.marker,status:'historical'},token={};h.m.client.dispatchEvent=e=>{dispatch(e);if(e.cid===h.peer&&e.state==='repairing'){h.m._groupGenerations.set(h.cid,winning);h.m._mlsCleanupRevisions.set(h.cid,token);}};
 await assert.rejects(h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job)));assert.equal(h.m._groupGenerations.get(h.cid),winning);assert.equal(h.m._mlsCleanupRevisions.get(h.cid),token);assert.equal(h.m.groups.has(h.cid),false);assert.equal(h.m._providerPersistenceUncertain,true);assert.equal((await h.s.loadExternalJoinReceipt(h.cid)).state,'accepted');await h.verifyPrivate((await h.s.loadProviderCheckpoint(h.user,h.device)).provider_bytes);await h.close();
});
test('late committed activation error cannot poison an unrelated replacement provider',async()=>{
 const h=await fixture(),save=h.s.saveExternalJoinWork.bind(h.s);let replacement;h.s.saveExternalJoinWork=async(...a)=>{await save(...a);replacement=wasm.Provider.from_bytes(h.base.provider_bytes);h.m._activeProvider=replacement;throw Error('late old readback error');};await assert.rejects(h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job)));assert.equal(h.m._activeProvider,replacement);assert.equal(h.m._providerPersistenceUncertain,false);assert.equal(h.m.groups.has(h.cid),false);assert.equal((await h.s.loadExternalJoinReceipt(h.cid)).state,'accepted');await h.close();
});


for (const repeated of [false,true]) test('joined Ready own full-base cursor progress re-proves boundedly '+repeated,async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));
 const verify=h.s.verifyMlsReadyCheckpoint.bind(h.s),provider=new Uint8Array(h.m.provider.to_bytes()),identity=new Uint8Array(h.m.identity.to_bytes());let checks=0;
 h.s.verifyMlsReadyCheckpoint=async cp=>{checks++;if(repeated||checks===1)await h.s.saveScopeSyncCursor(h.cid,{created_at:'2026-11-01T00:00:00Z',event_id:'forward-'+checks});return verify(cp);};
 const state=await h.m.refreshE2eeState(h.cid);assert.equal(h.m._providerPersistenceUncertain,false);assert.equal(checks,2);
 assert.equal(state.state,repeated?'repairing':'ready');if(repeated)assert.equal(state.reason,'local_checkpoint_pending');
 assert.deepEqual(new Uint8Array(h.m.provider.to_bytes()),provider);assert.deepEqual(new Uint8Array(h.m.identity.to_bytes()),identity);assert.equal(h.posts(),1);
 const base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);assert.equal(base.accepted.operation_id,h.job.body.operation_id);assert.equal(Object.values(base.welcome_primary)[0].status,'superseded_by_recovery');
 h.s.verifyMlsReadyCheckpoint=verify;assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');await h.close();
});
test('joined Ready cursor progress never masks an accepted receipt replacement',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const verify=h.s.verifyMlsReadyCheckpoint.bind(h.s),base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);
 h.s.verifyMlsReadyCheckpoint=async cp=>{await h.s.saveScopeSyncCursor(h.cid,{created_at:'2026-11-01T00:00:00Z',event_id:'forward'});await put(h,`external_receipt:v1:${h.cid}`,{...base.accepted,commit_sha256:'f'.repeat(64)});return verify(cp);};
 assert.notEqual((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal(h.m._providerPersistenceUncertain,true);assert.equal((await h.s.loadExternalJoinReceipt(h.cid)).commit_sha256,'f'.repeat(64));await h.close();
});
test('joined Ready own revision still stays uncertain when the canonical reproof read throws',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const verify=h.s.verifyMlsReadyCheckpoint.bind(h.s),load=h.s.loadExternalJoinWorkBase.bind(h.s);let committed=false;
 h.s.verifyMlsReadyCheckpoint=async cp=>{await h.s.saveScopeSyncCursor(h.cid,{created_at:'2026-11-01T00:00:00Z',event_id:'forward'});committed=true;return verify(cp);};
 h.s.loadExternalJoinWorkBase=async(...a)=>{if(committed)throw Error('unknown canonical read');return load(...a);};
 assert.notEqual((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal(h.m._providerPersistenceUncertain,true);assert.equal(h.posts(),1);await h.close();
});


test('canonical older Welcome first observed after accepted External Join uses that receipt without reopening join',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));
 const bytes=await h.s.loadProviderCheckpoint(h.user,h.device),posts=h.posts();
 const event='00000000-0000-4000-8000-000000000099',context={...h.context,event_id:event};
 const protocol={...h.protocol,event_id:event,acceptance_context:context};
 const disposition=await h.m.processMlsWelcome(h.cid,protocol,{acceptanceContext:context,acceptanceEnvelope:{event_id:event,cid:h.cid,group_generation:h.generation,epoch:protocol.epoch}},{event_id:event,created_at:new Date(context.accepted_at*1000).toISOString()});
 assert.equal(disposition,'superseded_by_recovery');assert.equal(h.posts(),posts);assert.equal(h.m._externalJoinCandidates.size,0);
 const base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);
 assert.equal(Object.keys(base.welcome_pending).length,0);assert.equal(Object.values(base.welcome_primary).find(x=>x.event_cursor.event_id===event).checkpoint.receipt.operation_id,h.job.body.operation_id);
 assert.deepEqual(base.state.provider_bytes,bytes.provider_bytes);assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');await h.close();
});


function lateWelcome(h,event='00000000-0000-4000-8000-000000000098') {
 const context={...h.context,event_id:event}, protocol={...h.protocol,event_id:event,acceptance_context:context};
 const options={acceptanceContext:context,acceptanceEnvelope:{event_id:event,cid:h.cid,group_generation:h.generation,epoch:protocol.epoch}};
 const cursor={event_id:event,created_at:new Date(context.accepted_at*1000).toISOString()};
 return {protocol,options,cursor,record:h.m._welcomeRecoveryRecord(protocol.welcome,{...options,welcomeEventCursor:cursor})};
}
test('replay repairs late Welcome pending metadata using the same accepted operation and unchanged private bytes',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const late=lateWelcome(h),bytes=await h.s.loadProviderCheckpoint(h.user,h.device),posts=h.posts();
 await h.m._recordOwnedWelcomeFailure(late.record,h.m._captureExternalJoinOwner(h.cid));
 assert.equal((await h.s.loadExternalJoinReadiness(h.cid)).status,'pending_external_join');
 assert.equal(await h.m.processMlsWelcome(h.cid,late.protocol,late.options,late.cursor),'superseded_by_recovery');
 const base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);
 assert.equal(base.state.cleanup.metadata['external_join_readiness:'+h.cid].status,'joined_external');assert.equal(Object.keys(base.welcome_pending).length,0);
 assert.equal(base.accepted.operation_id,h.job.body.operation_id);assert.deepEqual(base.state.provider_bytes,bytes.provider_bytes);assert.equal(h.posts(),posts);await h.close();
});
for(const kind of ['equal_epoch','newer_epoch','different_generation','missing_receipt'])test('late Welcome '+kind+' cannot borrow accepted join entitlement',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const late=lateWelcome(h),before=await h.s.loadProviderCheckpoint(h.user,h.device);
 if(kind==='equal_epoch')late.record.epoch=h.job.body.epoch;
 if(kind==='newer_epoch')late.record.epoch=h.job.body.epoch+1;
 if(kind==='different_generation')late.record.group_generation=h.generation+1;
 if(kind==='missing_receipt')await put(h,'external_receipt:v1:'+h.cid,undefined);
 assert.equal(await h.m._reconcileWelcomeAfterAcceptedExternalJoin(late.record,h.m._captureExternalJoinOwner(h.cid)),false);
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);assert.equal(h.m._externalJoinCandidates.size,0);await h.close();
});
for(const fault of ['abort','lost_ack'])test('late Welcome reconciliation '+fault+' keeps the existing full-readset ownership boundary',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const late=lateWelcome(h),before=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);
 const save=h.s.saveWelcomeWork.bind(h.s);h.s.saveWelcomeWork=async(...args)=>{
  if(args[4].kind!=='reconcile_external')return save(...args);
  if(fault==='abort')throw Object.assign(Error('fixture transaction aborted'),{checkpoint_outcome:'aborted'});
  await save(...args);throw Error('fixture committed acknowledgement lost');
 };
 await assert.rejects(h.m.processMlsWelcome(h.cid,late.protocol,late.options,late.cursor));
 const after=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);
 assert.equal(h.m._providerPersistenceUncertain,fault==='lost_ack');assert.equal(h.posts(),1);assert.equal(after.accepted.operation_id,before.accepted.operation_id);
 assert.deepEqual(after.state.provider_bytes,before.state.provider_bytes);
 if(fault==='abort')assert.deepEqual(after,before);else assert(Object.values(after.welcome_primary).some(x=>x.event_cursor.event_id===late.cursor.event_id&&x.status==='superseded_by_recovery'));
 await h.close();
});


test('late Welcome actual IndexedDB transaction abort preserves receipt, provider and pending indexes',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const late=lateWelcome(h);
 const before=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id),save=h.s.saveWelcomeWork.bind(h.s),db=await h.s.openDB(),original=db.transaction.bind(db);
 h.s.saveWelcomeWork=async(...args)=>{if(args[4].kind!=='reconcile_external')return save(...args);
  db.transaction=(...a)=>{const tx=original(...a);if(a[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};try{return await save(...args);}finally{db.transaction=original;}};
 await assert.rejects(h.m.processMlsWelcome(h.cid,late.protocol,late.options,late.cursor));db.transaction=original;
 assert.deepEqual(await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id),before);assert.equal(h.m._providerPersistenceUncertain,false);assert.equal(h.posts(),1);await h.close();
});
test('late Welcome full-readset CAS cannot overwrite a concurrent durable control winner',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const late=lateWelcome(h),save=h.s.saveWelcomeWork.bind(h.s);
 const key='recovery_control:v1:device:'+encodeURIComponent(h.cid),winner={version:99,opaque:'fixture-control-winner'};
 h.s.saveWelcomeWork=async(...args)=>{if(args[4].kind==='reconcile_external')await put(h,key,winner);return save(...args);};
 await assert.rejects(h.m.processMlsWelcome(h.cid,late.protocol,late.options,late.cursor));
 const db=await h.s.openDB(),tx=db.transaction('meta','readonly'),request=tx.objectStore('meta').get(key);await new Promise((yes,no)=>{tx.oncomplete=yes;tx.onabort=()=>no(tx.error);});
 assert.deepEqual(request.result,winner);assert.equal(h.posts(),1);assert.equal(h.m._externalJoinCandidates.size,0);await h.close();
});


test('late Welcome requires explicit adapter capability before any reconciliation write',async()=>{
 const h=await fixture();await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const late=lateWelcome(h),before=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);
 h.s.welcomeExternalDispositionVersion=undefined;
 await assert.rejects(h.m.processMlsWelcome(h.cid,late.protocol,late.options,late.cursor),error=>error.code==='client_upgrade_required');
 assert.deepEqual(await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id),before);assert.equal(h.posts(),1);await h.close();
});

test('fresh accepted receipt seeds the canonical second but preserves an existing cursor',async()=>{
 for(const saved of [null,{created_at:'2026-01-01T00:00:00.123Z',event_id:'existing-durable-position'}]){
  const h=await fixture(true,0,saved,false),receipt=h.accepted(h.job);
  try{await h.m._activateExternalJoinCandidate(h.job,receipt);
   assert.deepEqual(await h.s.loadScopeSyncCursor(h.cid),saved||{created_at:new Date(receipt.acceptance_context.accepted_at*1000).toISOString(),event_id:'00000000-0000-0000-0000-000000000000'});
   assert.equal(h.m._getCompletedSyncProgress(h.cid),null,'An initial boundary is not completed live delivery');
  }finally{await h.close();}
 }
});

test('fresh initial receipt cursor cannot be rewound by a competing Ready observation',async()=>{
 const h=await fixture(true,0,null,false);try{
  await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));
  const initial=await h.s.loadScopeSyncCursor(h.cid),verify=h.s.verifyMlsReadyCheckpoint.bind(h.s);
  h.s.verifyMlsReadyCheckpoint=async cp=>{await h.s.saveScopeSyncCursor(h.cid,{created_at:new Date(Date.parse(initial.created_at)-1000).toISOString(),event_id:'backward'});return verify(cp);};
  assert.notEqual((await h.m.refreshE2eeState(h.cid)).state,'ready');
  assert.equal(h.m._providerPersistenceUncertain,true);assert.equal(h.posts(),1);
 }finally{await h.close();}
});

for(const retained of [false,true])test('stale active-member prerequisite reconciles the original accepted activation, retained Welcome='+retained,async()=>{
 const h=await fixture(true,0,null,retained);
 try{
  await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));
  const before=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id),posts=h.posts();
  await h.s.saveExternalJoinReadiness({cid:h.cid,status:'pending_external_join',reason:'active_member_recovery',updated_at:Date.now()});
  assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
  const after=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id);
  assert.equal(after.state.cleanup.metadata['external_join_readiness:'+h.cid].status,'joined_external');
  assert.equal(after.state.cleanup.metadata['external_join_readiness:'+h.cid].first_decryptable_epoch,h.job.body.epoch);
  assert.deepEqual(after.state.provider_bytes,before.state.provider_bytes);assert.equal(after.state.revision,before.state.revision);
  assert.deepEqual(after.state.cleanup.marker,before.state.cleanup.marker);assert.deepEqual(after.accepted,before.accepted);
  assert.deepEqual(after.welcome_primary,before.welcome_primary);assert.deepEqual(after.welcome_pending,before.welcome_pending);
  assert.deepEqual(after.state.cleanup.metadata['scope_sync:'+h.cid],before.state.cleanup.metadata['scope_sync:'+h.cid]);
  assert.equal(h.posts(),posts,'reconciliation performs no External Join');
 }finally{h.m.destroy();await h.close();}
});
for(const fault of ['receipt_missing','receipt_digest','receipt_operation','pending_welcome','candidate','manual','capability'])test('stale prerequisite reconciliation keeps '+fault+' blocked',async()=>{
 const h=await fixture();
 try{
  await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));
  const base=await h.s.loadExternalJoinWorkBase(h.user,h.device,h.cid,h.job.body.operation_id),provider=await h.s.loadProviderCheckpoint(h.user,h.device);
  const pending={cid:h.cid,status:'pending_external_join',reason:'active_member_recovery',updated_at:Date.now()};await h.s.saveExternalJoinReadiness(pending);
  if(fault==='receipt_missing')await put(h,'external_receipt:v1:'+h.cid,undefined);
  if(fault==='receipt_digest')await put(h,'external_receipt:v1:'+h.cid,{...base.accepted,commit_sha256:'f'.repeat(64)});
  if(fault==='receipt_operation')await put(h,'external_receipt:v1:'+h.cid,{...base.accepted,operation_id:crypto.randomUUID()});
  if(fault==='pending_welcome'){const row=Object.values(base.welcome_primary)[0];await put(h,Object.keys(base.welcome_primary)[0].replace('welcome_recovery:','welcome_pending:'),{...row,status:'pending_external_join',checkpoint:undefined});}
  if(fault==='candidate')await put(h,'external_candidate:v1:'+h.cid,h.job);
  if(fault==='manual')h.m._recoveryControls.set(h.cid,{recovery_action:'manual_intervention_required'});
  if(fault==='capability')h.s.externalJoinReadinessReconcileVersion=undefined;
  assert.notEqual((await h.m.refreshE2eeState(h.cid)).state,'ready');
  assert.deepEqual(await h.s.loadExternalJoinReadiness(h.cid),pending);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),provider);
 }finally{h.m.destroy();await h.close();}
});
test('a dormant installed group cannot be downgraded by an active-member prerequisite',async()=>{
 const h=await fixture();try{
  await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const before=await h.s.loadExternalJoinReadiness(h.cid);
  h.m.groups.get(h.cid).free();h.m.groups.delete(h.cid);
  assert.equal(await h.m._recordActiveMemberRecoveryPrerequisite(h.cid,{reason:'active_member_recovery'}),false);
  assert.equal(h.m.groups.has(h.cid),true);assert.deepEqual(await h.s.loadExternalJoinReadiness(h.cid),before);
 }finally{h.m.destroy();await h.close();}
});
test('an installed-group winner during GroupInfo HTTP cannot be downgraded or joined again',async()=>{
 const h=await fixture(),entered=latch(),release=latch();let work;
 try{
  await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));const before=await h.s.loadExternalJoinReadiness(h.cid),posts=h.posts();
  h.m.groups.get(h.cid).free();h.m.groups.delete(h.cid);
  h.api.getGroupInfo=async()=>{entered.resolve();await release.promise;return{external_join_prerequisite:{reason:'active_member_recovery'}};};
  work=h.m._syncNewChannelLegacy('team',h.cid.slice(5),h.cid,{initialScopeSyncCompleted:true});work.catch(()=>{});await entered.promise;
  await h.m._restoreInstalledGroupOnDemand(h.cid);release.resolve();await work;
  assert.deepEqual(await h.s.loadExternalJoinReadiness(h.cid),before);assert.equal(h.posts(),posts);
 }finally{release.resolve();if(work)await work.catch(()=>{});h.m.destroy();await h.close();}
});

test('typed active-member prerequisite persists only for a genuinely missing group with unchanged private state',async()=>{
 const h=await fixture(false,0,null,false);try{
  const before=await h.s.loadProviderCheckpoint(h.user,h.device);
  assert.equal(await h.m._recordActiveMemberRecoveryPrerequisite(h.cid,{reason:'sync_failed'}),false);
  assert.equal(await h.m._recordActiveMemberRecoveryPrerequisite(h.cid,{reason:'active_member_recovery'}),true);
  assert.equal((await h.s.loadExternalJoinReadiness(h.cid)).status,'pending_external_join');
  assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);assert.equal(h.posts(),0);
 }finally{h.m.destroy();await h.close();}
});
for(const winner of ['account','cursor','provider','readback'])test('accepted-readiness metadata reconciliation preserves '+winner+' fencing',async()=>{
 const h=await fixture(),save=h.s.saveExternalJoinWork.bind(h.s);try{
  await h.m._activateExternalJoinCandidate(h.job,h.accepted(h.job));
  const pending={cid:h.cid,status:'pending_external_join',reason:'active_member_recovery',updated_at:Date.now()};await h.s.saveExternalJoinReadiness(pending);
  const before=await h.s.loadProviderCheckpoint(h.user,h.device);let once=false;
  h.s.saveExternalJoinWork=async(...args)=>{
   if(args[4].kind!=='restore_readiness'||once)return save(...args);once=true;
   if(winner==='account')h.m.userId='replacement';
   if(winner==='cursor')await h.s.saveScopeSyncCursor(h.cid,{created_at:'2026-11-23T00:00:00Z',event_id:'winner'});
   if(winner==='provider')await mutate(h,'provider',args[3],h.job,(await h.s.openDB()).transaction.bind(await h.s.openDB()));
   const actual=await save(...args);
   if(winner==='readback')throw Object.assign(Error('metadata readback unavailable'),{code:'recovery_checkpoint_uncertain'});
   return actual;
  };
  const outcome=await h.m.refreshE2eeState(h.cid).then(state=>state,()=>null);
  assert.equal(once,true);assert.notEqual(outcome?.state,'ready');
  if(winner!=='readback')assert.deepEqual(await h.s.loadExternalJoinReadiness(h.cid),pending);
  if(winner!=='provider')assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);
  if(winner==='cursor')assert.equal((await h.s.loadScopeSyncCursor(h.cid)).event_id,'winner');
 }finally{h.m.userId=h.user;h.m.destroy();await h.close();}
});
