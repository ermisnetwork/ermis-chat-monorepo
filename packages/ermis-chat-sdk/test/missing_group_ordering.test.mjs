import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import init,* as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager,IndexedDBEncryptionStorage,PartialWelcomeJoinCoordinator,sha256Hex}=createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const binary=fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url));await init({module_or_path:binary});let seq=0;
const time='2026-10-27T07:00:00.000000001Z',zero='00000000-0000-0000-0000-000000000000';
function event(cid,type,bytes,epoch,extra={}){
 const id=crypto.randomUUID(),context={version:1,event_id:id,cid,group_generation:0,epoch,accepted_at:Math.floor(Date.now()/1000),payload_sha256:sha256Hex(bytes),provenance:'bellboy_transition_v1'};
 return {cid,event_id:id,created_at:time,type:'protocol',acceptance_context:context,data:{type,epoch,group_generation:0,user:{id:'issuer'},device_id:'issuer-device',[type==='welcome'?'welcome':'commit']:bytes,...extra}};
}
async function fixture(owns=true){
 const user='missing-order-'+ ++seq,device='device',cid='team:'+user,s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager();
 Object.assign(m,{userId:user,deviceId:device,storage:s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(binary)});await m._initWasm();await m._initIdentity();m.initialized=true;m._partialWelcomeJoin=new PartialWelcomeJoinCoordinator(s);
 const kp=m.identity.key_package(m.provider),ref=kp.hash_ref(m.provider);await m._persistProviderStrict();
 const p=new wasm.Provider(),i=new wasm.Identity(p,'issuer'),g=wasm.Group.create_with_cid(p,i,cid),otherP=new wasm.Provider(),otherI=wasm.Identity.from_bytes(otherP,m.identity.to_bytes()),otherBase=otherP.to_bytes(),target=owns?kp:otherI.key_package(otherP);
 // add_members consumes the public KeyPackage handle; its private bundle stays in the recipient provider.
 const add=g.add_members(p,i,[target]);g.merge_pending_commit(p);if(!owns)kp.free();
 const commit=event(cid,'commit',add.commit,1),welcome=event(cid,'welcome',add.welcome,1,{target_user_ids:[user],target_device_ids:[device]});
 const info={group_info:g.export_group_info(p,i,true),epoch:1,hash:'',is_stale:false,group_generation:0,group_id:null,external_join_prerequisite:{reason:'active_member_recovery'}};info.hash=sha256Hex(info.group_info);
 const events=[commit,welcome],notifications=[];let posts=0,giReads=0,receipt=null;
 const api={scopeSync:async cursors=>({channels:Object.fromEntries(Object.entries(cursors).map(([key,cursor])=>[key,{events:key===cid&&cursor.event_id===zero?events:[],next_cursor:key===cid?{created_at:time,event_id:events.at(-1).event_id}:cursor,has_more:false}]))}),getGroupInfo:async()=>{giReads++;return info;},getExternalJoinReceipt:async(_t,_id,op)=>receipt||{version:1,operation_id:op,cid,state:'outcome_unknown',delivery_pending:false,group_generation:null,epoch:null,group_id:null,commit_sha256:null,event_id:null,acceptance_context:null},externalJoin:async(_t,_id,body)=>{
  posts++;g.process_message(p,body.commit);const e=event(cid,'external_commit',body.commit,body.epoch);receipt={version:1,operation_id:body.operation_id,cid,state:'accepted',delivery_pending:false,group_generation:0,epoch:body.epoch,group_id:null,commit_sha256:sha256Hex(body.commit),group_info_sha256:sha256Hex(body.group_info),event_id:e.event_id,acceptance_context:e.acceptance_context};return receipt;
 }};
 m.e2eeClient=api;m.client={baseURL:'https://clone-fixture.invalid',activeChannels:{[cid]:{id:user,type:'team',cid,data:{mls_enabled:true},state:{membership:{channel_role:'member',created_at:'2026-10-27T06:59:59Z'}}}},dispatchEvent:e=>notifications.push(e),_captureAuthScope:()=>({assertCurrent(){}})};
 m.safeArchiveCurrentEpochForCid=async()=>{};m.safeArchiveCurrentEpoch=async()=>{};m.ensureKeyPackagesFromServer=async()=>{};
 const preserve=async()=>{await m._withProviderMutation(async provider=>assert.equal(m.identity.owns_key_package_ref(provider,ref),true));};
 return {m,s,cid,user,device,p,i,g,otherP,otherBase,commit,welcome,events,info,api,notifications,preserve,posts:()=>posts,giReads:()=>giReads,close:async()=>{m.destroy();await s.close();g.free();i.free();p.free();otherI.free();otherP.free();}};
}
test('same-timestamp Add Commit before owned Welcome joins through real private package without External Join',async()=>{
 const h=await fixture();try{
  const result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
  assert.equal(result.status,'ready');assert.equal(h.m.getEpoch(h.cid),1);assert.equal(h.posts(),0);assert.equal(h.giReads(),0);
  const bytes=h.m.groups.get(h.cid).create_message(h.m.provider,h.m.identity,new TextEncoder().encode('ordering-owned'));
  assert.equal(new TextDecoder().decode(h.g.process_message(h.p,bytes).content),'ordering-owned');
  const persisted=await h.s.loadProviderCheckpoint(h.user,h.device),reload=wasm.Provider.from_bytes(persisted.provider_bytes),group=wasm.Group.load(reload,h.cid);assert.equal(Number(group.epoch()),1);group.free();reload.free();
  assert.equal((await h.s.loadScopeSyncCursor(h.cid)).event_id,h.welcome.event_id);
 }finally{await h.close();}
});
test('unowned Welcome after Add Commit reaches typed recovery and exactly one real External Join with peer decrypt',async()=>{
 const h=await fixture(false);try{
  const result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
  assert.equal(result.status,'ready');assert.equal(h.posts(),1);assert.equal(h.m.getEpoch(h.cid),2);assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);await h.preserve();
  const bytes=h.m.groups.get(h.cid).create_message(h.m.provider,h.m.identity,new TextEncoder().encode('ordering-recovered'));
  assert.equal(new TextDecoder().decode(h.g.process_message(h.p,bytes).content),'ordering-recovered');
  await h.m.ensureChannelReady('team',h.user,h.cid,{source:'reconnect'});assert.equal(h.posts(),1);
 }finally{await h.close();}
});
test('Commit without Welcome retains exact cursor while typed active-member GI recovery joins',async()=>{
 const h=await fixture(false);h.events.splice(1);try{
  const result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
  assert.equal(result.status,'ready');assert.equal(h.posts(),1);assert.equal(h.giReads(),1);await h.preserve();
 }finally{await h.close();}
});
test('missing group with no typed prerequisite remains blocked and never advances protocol cursor',async()=>{
 const h=await fixture(false);h.events.splice(1);delete h.info.external_join_prerequisite;try{
  const before=await h.s.loadScopeSyncCursor(h.cid),result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
  assert.equal(result.status,'needs_retry');assert.equal(h.posts(),0);assert.equal(h.m.groups.has(h.cid),false);assert.deepEqual(await h.s.loadScopeSyncCursor(h.cid),before);await h.preserve();
 }finally{await h.close();}
});
test('tampered lookahead Welcome fails closed before join and cursor advancement',async()=>{
 const h=await fixture();h.welcome.acceptance_context={...h.welcome.acceptance_context,payload_sha256:'0'.repeat(64)};try{
  await assert.rejects(h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'}),e=>e.code==='acceptance_metadata_invalid');
  assert.equal(h.posts(),0);assert.equal(h.m.groups.has(h.cid),false);assert.equal(await h.s.loadScopeSyncCursor(h.cid),null);await h.preserve();
 }finally{await h.close();}
});
test('startup missing-group scope cannot abort independent scope checkpoint or recovery discovery',async()=>{
 const h=await fixture(false),healthy='team:healthy-'+h.user;h.events.splice(1);try{
  h.m.client.activeChannels[healthy]={id:healthy.slice(5),type:'team',cid:healthy,data:{mls_enabled:true},state:{membership:{channel_role:'member',created_at:'2026-10-27T06:59:59Z'}}};
  const visited=[];h.m._discoverMlsRecoveryStates=async cids=>{visited.push(...cids);return {states:{},unsupported:false};};h.m.bootstrapKnownE2eeChannels=async()=>({results:[]});
  await h.m._syncAndRestoreGroups();
  assert.ok(visited.includes(h.cid));assert.ok(visited.includes(healthy));assert.equal(h.m.getSyncState(h.cid).needs_retry,true);assert.equal(h.m.getSyncState(h.cid).error,'mls_group_missing');
  // This empty peer scope has no group yet either. Its completed routing cursor
  // is durable, while common Ready correctly remains locally checkpoint-gated.
  assert.notEqual(h.m.getSyncState(healthy).error,'mls_group_missing');
  assert.equal(await h.s.loadScopeSyncCursor(h.cid),null);assert.ok(await h.s.loadScopeSyncCursor(healthy));assert.equal(h.posts(),0);await h.preserve();
 }finally{await h.close();}
});
for(const malformed of ['missing','digest'])test('startup '+malformed+' acceptance stays blocked without aborting an independent scope',async()=>{
 const h=await fixture(),healthy='team:independent-'+h.user;
 try{
  if(malformed==='missing')delete h.welcome.acceptance_context;
  else h.welcome.acceptance_context={...h.welcome.acceptance_context,payload_sha256:'0'.repeat(64)};
  h.m.client.activeChannels[healthy]={id:healthy.slice(5),type:'team',cid:healthy,data:{mls_enabled:true},state:{membership:{channel_role:'member',created_at:'2026-10-27T06:59:59Z'}}};
  const visited=[];let synced;
  h.m._discoverMlsRecoveryStates=async cids=>{visited.push(...cids);return{states:{},unsupported:false};};
  h.m.bootstrapKnownE2eeChannels=async options=>{synced=options.scopeSyncedCids;return{results:[]};};
  await h.m._syncAndRestoreGroups();
  assert.ok(visited.includes(healthy));assert.ok(visited.includes(h.cid));
  assert.ok(synced.includes(healthy));assert.ok(!synced.includes(h.cid));
  assert.equal(h.m.getSyncState(h.cid).error,'acceptance_metadata_invalid');
  assert.equal(h.m.getSyncState(h.cid).needs_retry,true);
  assert.equal(await h.s.loadScopeSyncCursor(h.cid),null);
  assert.ok(await h.s.loadScopeSyncCursor(healthy));
  assert.equal(h.m.groups.has(h.cid),false);assert.equal(h.posts(),0);await h.preserve();
 }finally{await h.close();}
});
for(const broken of ['stale','invalid'])test(broken+' GI cannot turn missing-group recovery into Ready or advance the blocked Commit',async()=>{
 const h=await fixture(false);h.events.splice(1);
 if(broken==='stale')h.info.is_stale=true;
 else {h.info.group_info=new Uint8Array(h.info.group_info);h.info.group_info[h.info.group_info.length-1]^=1;h.info.hash=sha256Hex(h.info.group_info);}
 try{
  const cursor=await h.s.loadScopeSyncCursor(h.cid),result=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
  assert.notEqual(result.status,'ready');assert.equal(h.posts(),0);assert.equal(h.m.groups.has(h.cid),false);assert.deepEqual(await h.s.loadScopeSyncCursor(h.cid),cursor);await h.preserve();
 }finally{await h.close();}
});
test('shared provider failure still aborts startup rather than being relabelled as per-channel recovery',async()=>{
 const h=await fixture(false);try{
  h.m._processChannelEvents=async()=>{throw Object.assign(Error('uncertain provider'),{code:'provider_persistence_uncertain'});};
  await assert.rejects(h.m._syncAndRestoreGroups(),e=>e.code==='provider_persistence_uncertain');assert.equal(await h.s.loadScopeSyncCursor(h.cid),null);assert.equal(h.posts(),0);await h.preserve();
 }finally{await h.close();}
});
test('installed real group reaches startup Ready despite exhausted public discovery; its exact budget is retained',async()=>{
 const h=await fixture();try{
  assert.equal((await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'})).status,'ready');
  const job={version:1,user_id:h.user,device_id:h.device,cid:h.cid,job_id:crypto.randomUUID(),signing_identity_sha256:sha256Hex(h.m.identity.signature_public_key()),artifact_sha256:sha256Hex(binary),hint:null,retry_at:Date.now()+30000,attempts:3,lease_id:null,disposition:'deferred',reason:'budget',observed_head:{group_generation:0,recovery_revision:'1'}};
  const db=await h.s.getDB();await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(job,`mls_discovery:v1:${encodeURIComponent(h.device)}:${encodeURIComponent(h.cid)}`);tx.oncomplete=yes;tx.onabort=()=>no(tx.error);});
  h.m._generationRecoveryPending.set(h.cid,{cid:h.cid,status:'retryable_infrastructure_failure',reason:'infrastructure_unavailable',retryable:false});
  const result=await h.m.bootstrapKnownE2eeChannels({source:'reconnect',targetCids:[h.cid],recoveryDiscoveryStates:{[h.cid]:{result:'error',reason:'state_unavailable',retryable:false}}});
  assert.equal(result.results[0].status,'ready');assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.deepEqual((await h.s.loadRecoveryDiscoveryWork(h.device,[h.cid]))[h.cid],job);assert.equal(h.posts(),0);
 }finally{await h.close();}
});
test('own commit activates during held join HTTP; fresh normal readiness wakes after the original owners settle',async()=>{
 const h=await fixture(false),send=h.api.externalJoin;try{
  h.api.externalJoin=async(type,id,body)=>{
   const receipt=await send(type,id,body);
   const protocol={commit:body.commit,epoch:body.epoch,group_generation:0,user:{id:h.user},device_id:h.device};
   await h.m.processOwnMlsCommit(h.cid,protocol,{acceptanceContext:receipt.acceptance_context,acceptanceEnvelope:{event_id:receipt.event_id,cid:h.cid,group_generation:0,epoch:body.epoch}});
   return receipt;
  };
  await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
  await h.m._externalJoinReadinessWakes?.get(h.cid)?.work;
  assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(h.posts(),1);assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);await h.preserve();
  const bytes=h.m.groups.get(h.cid).create_message(h.m.provider,h.m.identity,new TextEncoder().encode('live-own-winner'));
  assert.equal(new TextDecoder().decode(h.g.process_message(h.p,bytes).content),'live-own-winner');
 }finally{await h.close();}
});
for(const replacement of ['route','manual'])test('own-activation wake cannot continue across '+replacement+' replacement',async()=>{
 const h=await fixture(false),send=h.api.externalJoin;try{
  h.api.externalJoin=async(type,id,body)=>{
   const receipt=await send(type,id,body);
   await h.m.processOwnMlsCommit(h.cid,{commit:body.commit,epoch:body.epoch,group_generation:0,user:{id:h.user},device_id:h.device},
    {acceptanceContext:receipt.acceptance_context,acceptanceEnvelope:{event_id:receipt.event_id,cid:h.cid,group_generation:0,epoch:body.epoch}});
   if(replacement==='route')h.m.client.baseURL='https://replacement.invalid';
   else await h.m._applyRecoveryControl(h.cid,{group_generation:0,group_id:null,recovery_action:'manual_intervention_required',recovery_revision:'2',incident_id:crypto.randomUUID(),repair_retry_until:new Date(Date.now()-1000).toISOString()});
   return receipt;
  };
  await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'}).catch(()=>{});
  await h.m._externalJoinReadinessWakes?.get(h.cid)?.work;
  assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');assert.equal(h.posts(),1);
  assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);
 }finally{await h.close();}
});
test('repeated real NoMatching Welcome preserves the same pending/history work and never requests fresh packages',async()=>{
 const h=await fixture(false);let writes=0,refills=0;const save=h.s.saveWelcomeWork.bind(h.s);
 h.s.saveWelcomeWork=async(...args)=>{writes++;return save(...args);};h.m.ensureKeyPackagesFromServer=async()=>{refills++;};
 const processing={acceptanceContext:h.welcome.acceptance_context,acceptanceEnvelope:{event_id:h.welcome.event_id,cid:h.cid,group_generation:0,epoch:1}},cursor={created_at:time,event_id:h.welcome.event_id};
 try{
  assert.equal(await h.m.processMlsWelcome(h.cid,h.welcome.data,processing,cursor),'pending_external_join');
  const before=await h.s.loadWelcomeHistoryWork(h.user,h.device,h.cid),readiness=await h.s.loadExternalJoinReadiness(h.cid),record=await h.s.loadWelcomeRecoveryCheckpoint(h.cid,h.device,h.welcome.event_id);
  assert.equal(writes,1);
  assert.equal(await h.m.processMlsWelcome(h.cid,h.welcome.data,processing,cursor),'pending_external_join');
  assert.equal(writes,1);assert.equal(refills,0);assert.deepEqual(await h.s.loadWelcomeHistoryWork(h.user,h.device,h.cid),before);assert.deepEqual(await h.s.loadExternalJoinReadiness(h.cid),readiness);assert.deepEqual(await h.s.loadWelcomeRecoveryCheckpoint(h.cid,h.device,h.welcome.event_id),record);
  assert.equal(await h.s.loadScopeSyncCursor(h.cid),null);assert.equal(h.m.groups.has(h.cid),false);assert.equal(h.posts(),0);await h.preserve();
 }finally{await h.close();}
});
test('idempotent pending failure still re-evaluates a legitimately restored private package for the same signer',async()=>{
 const h=await fixture(false),processing={acceptanceContext:h.welcome.acceptance_context,acceptanceEnvelope:{event_id:h.welcome.event_id,cid:h.cid,group_generation:0,epoch:1}},cursor={created_at:time,event_id:h.welcome.event_id};
 try{
  assert.equal(await h.m.processMlsWelcome(h.cid,h.welcome.data,processing,cursor),'pending_external_join');
  await h.m._withProviderMutation(async(provider,assertCurrent,replace)=>{
   const restored=provider.rebase_candidate(h.otherBase,h.otherP.to_bytes()),bytes=restored.to_bytes(),guard=h.m._providerWriteGuard();
   await h.s.saveProviderState(h.user,h.device,bytes,guard);assertCurrent();await h.m._readProviderWrite(bytes,guard,assertCurrent);replace(restored);
  });
  assert.equal(await h.m.processMlsWelcome(h.cid,h.welcome.data,processing,cursor),'applied');
  assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal(h.posts(),0);await h.preserve();
  const bytes=h.g.create_message(h.p,h.i,new TextEncoder().encode('restored actual package'));
  assert.equal(new TextDecoder().decode(h.m.groups.get(h.cid).process_message(h.m.provider,bytes).content),'restored actual package');
 }finally{await h.close();}
});
for(const progress of [false,true])test('fresh evidence Ready proof '+(progress?'expires after real private revision and is revalidated':'is shared without a duplicate native validation'),async()=>{
 const h=await fixture();let validations=0;const validate=wasm.Group.validate_group_info_with_policy;
 try{
  assert.equal((await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'})).status,'ready');
  h.m.observeChannelE2ee({cid:h.cid,group_generation:0,group_id:null,epoch:1,group_info:{status:'ready',ready:true,epoch:1,last_uploaded_at:null,refresh_requested:false},recovery:{action:'none',incident_id:null,revision:'1',repair_retry_until:null}},true);
  if(progress){const check=h.m._checkChannelEvidence.bind(h.m);h.m._checkChannelEvidence=async(...args)=>{const proof=await check(...args);await h.m._persistProviderStrict();return proof;};}
  wasm.Group.validate_group_info_with_policy=(...args)=>{validations++;return validate(...args);};
  assert.equal((await h.m.ensureChannelReady('team',h.user,h.cid,{source:'manual_retry'})).status,'ready');
  assert.equal(validations,progress?2:1);assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(h.posts(),0);
 }finally{wasm.Group.validate_group_info_with_policy=validate;await h.close();}
});
test('fresh evidence proof cannot publish Ready after a route owner replacement',async()=>{
 const h=await fixture();try{
  assert.equal((await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'})).status,'ready');
  h.m.observeChannelE2ee({cid:h.cid,group_generation:0,group_id:null,epoch:1,group_info:{status:'ready',ready:true,epoch:1,last_uploaded_at:null,refresh_requested:false},recovery:{action:'none',incident_id:null,revision:'1',repair_retry_until:null}},true);
  const check=h.m._checkChannelEvidence.bind(h.m);h.m._checkChannelEvidence=async(...args)=>{const proof=await check(...args);h.m.client.baseURL='https://new-owner.invalid';return proof;};
  await assert.rejects(h.m.ensureChannelReady('team',h.user,h.cid,{source:'manual_retry'}),e=>e.code==='recovery_scope_changed');
  assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');assert.equal(h.posts(),0);
 }finally{await h.close();}
});

test('real expired tree remains typed and fail-closed through normal fallback before explicit join opt-in',async()=>{
 const h=await fixture(false),now=Date.now;
 try{
  const future=now()+90*24*60*60*1000;Date.now=()=>future;
  const denied=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
  assert.equal(denied.error,'key_package_expired');assert.equal(denied.status,'needs_retry');
  assert.equal(h.m.getE2eeState(h.cid).reason,'key_package_expired');assert.equal(h.posts(),0);assert.equal(h.m.groups.has(h.cid),false);const held=await h.s.loadScopeSyncCursor(h.cid);assert.deepEqual(held,denied.sync_state.started_event_cursor);assert.equal(held.event_id,zero);assert.ok(held.created_at<time);
  h.m._allowExpiredJoinTreeLeaves=true;
  const joined=await h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});
  assert.equal(joined.status,'ready');assert.equal(h.posts(),1);assert.equal(h.m.getEpoch(h.cid),2);
  const bytes=h.m.groups.get(h.cid).create_message(h.m.provider,h.m.identity,new TextEncoder().encode('explicit signed expired-tree join'));
  assert.equal(new TextDecoder().decode(h.g.process_message(h.p,bytes).content),'explicit signed expired-tree join');
 }finally{Date.now=now;await h.close();}
});

test('receipt-only activation wakes an already subscribed channel through normal sync without another join',async()=>{
 const h=await fixture(false),seen=[];await h.m.processMlsWelcome(h.cid,h.welcome.data,{acceptanceContext:h.welcome.acceptance_context,acceptanceEnvelope:{event_id:h.welcome.event_id,cid:h.cid,group_generation:0,epoch:1}},{created_at:time,event_id:h.welcome.event_id});const sub=h.m.subscribeE2eeState(h.cid,s=>seen.push(s.state));
 try{
  await h.m.joinExternal('team',h.user,h.cid);
  await h.m._externalJoinReadinessWakes.get(h.cid)?.work;
  assert.equal(h.m.getE2eeState(h.cid)?.state,'ready');assert.equal(seen.at(-1),'ready');
  assert.equal(h.posts(),1);assert.equal(await h.s.loadExternalJoinCandidateCheckpoint(h.cid),null);await h.preserve();
  const bytes=h.m.groups.get(h.cid).create_message(h.m.provider,h.m.identity,new TextEncoder().encode('receipt-activated subscribed'));
  assert.equal(new TextDecoder().decode(h.g.process_message(h.p,bytes).content),'receipt-activated subscribed');
 }finally{sub.unsubscribe();await h.close();}
});

test('activation wake waits for full native Ready admission and does not start a competing writer after success',async()=>{
 const h=await fixture(false),refresh=h.m.refreshE2eeState.bind(h.m),sync=h.api.scopeSync;
 let release,enter,calls=0,held=false;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r);
 h.api.scopeSync=async(...args)=>{calls++;return sync(...args);};
 h.m.refreshE2eeState=async(...args)=>{const result=await refresh(...args);if(result.state==='ready'&&!held){held=true;enter();await gate;}return result;};
 try{
  const work=h.m.ensureChannelReady('team',h.user,h.cid,{source:'open'});await entered;
  const before=calls,ticket=h.m._externalJoinReadinessWakes.get(h.cid);assert.ok(ticket);
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.equal(calls,before);
  release();assert.equal((await work).status,'ready');await ticket.work;assert.equal(calls,before);assert.equal(h.posts(),1);
  const bytes=h.m.groups.get(h.cid).create_message(h.m.provider,h.m.identity,new TextEncoder().encode('no competing wake'));
  assert.equal(new TextDecoder().decode(h.g.process_message(h.p,bytes).content),'no competing wake');
 }finally{release();await h.close();}
});
