import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,work,put,privatePreserved,peer,latch,sdk,wasm} from './flat_publication_fixture.mjs';

for(const phase of ['initial','before-write','after-commit','marker-http','upload-http'])
for(const dimension of ['provider','mutation','marker','control'])test(`${phase} ${dimension} winner fences current/listener/late Ready and preserves durable winner`,async()=>{
 const h=await fixture();try{
  await h.m.refreshE2eeState(h.cid);const seen=[];h.m.subscribeE2eeState(h.cid,v=>seen.push(v));let winner,once=false;
  async function change(){if(once)return;once=true;
   if(dimension==='provider')winner=(await peer(h)).base;
   if(dimension==='mutation'){winner={operation_id:'winner'};await put(h,'mls_mutation:v1:'+h.cid,winner);}
   if(dimension==='marker'){winner={...h.marker,status:'historical'};await h.s.saveGroupState(h.cid,winner);}
   if(dimension==='control'){winner={version:1,user_id:h.user,device_id:h.device,cid:h.cid,signing_identity_sha256:sdk.sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:crypto.randomUUID(),recovery_action:'manual_intervention_required',recovery_revision:'2',repair_retry_until:null};await h.s.saveRecoveryControlCheckpoint(winner);}
  }
  if(phase==='initial'){const load=h.s.loadChannelEvidenceWork.bind(h.s);h.s.loadChannelEvidenceWork=async(...a)=>{await change();return load(...a);};}
  if(phase==='before-write'||phase==='after-commit'){const save=h.s.saveChannelEvidenceWork.bind(h.s);h.s.saveChannelEvidenceWork=async(...a)=>{if(phase==='before-write')await change();const value=await save(...a);if(phase==='after-commit'){await change();const error=Object.assign(Error('readback conflict'),{code:'recovery_checkpoint_uncertain'});throw error;}return value;};}
  if(phase==='marker-http'){h.m.e2eeClient.getGroupInfoPublicationMarker=async()=>{await change();return{marker:null};};}
  if(phase==='upload-http'){h.m.e2eeClient.submitReservedGroupInfo=async()=>{await change();return{};};}
  await assert.rejects(h.m._checkChannelEvidence(h.cid));assert.equal(once,true);
  assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');const late=[];h.m.subscribeE2eeState(h.cid,v=>late.push(v));assert.notEqual(late[0].state,'ready');assert.notEqual(seen.at(-1).state,'ready');
  if(dimension==='provider'){assert.equal(h.m._providerPersistenceUncertain,true);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner);}
  else{assert.equal(h.m._providerPersistenceUncertain,false);await privatePreserved(h);const base=await h.s.loadMlsReadyBase(h.user,h.device,h.cid);if(dimension==='marker')assert.deepEqual(base.cleanup.marker,winner);if(dimension==='control')assert.deepEqual(base.control,winner);if(dimension==='mutation')assert.deepEqual(base.cleanup.metadata[`mls_mutation:v1:${h.cid}`],winner);}
 }finally{await h.close();}
});
for(const fault of ['abort','unknown-public'])test(`${fault} journal error preserves independently proved private Ready`,async()=>{
 const h=await fixture();try{await h.m.refreshE2eeState(h.cid);const save=h.s.saveChannelEvidenceWork.bind(h.s);h.s.saveChannelEvidenceWork=async(...a)=>{if(fault==='unknown-public')await save(...a);throw Error('public work unavailable');};
  await assert.rejects(h.m._checkChannelEvidence(h.cid));assert.equal(h.m._providerPersistenceUncertain,false);await privatePreserved(h);
  assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal((await work(h)).length,fault==='abort'?0:1);
 }finally{await h.close();}
});
test('peer private writer reload retains both original private KP and winning KP after the fence',async()=>{
 const h=await fixture();try{await h.m.refreshE2eeState(h.cid);const winner=await peer(h);await h.m._checkChannelEvidence(h.cid).catch(()=>{});assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');
  const p=wasm.Provider.from_bytes(winner.base.provider_bytes),i=wasm.Identity.from_bytes(p,await h.s.loadIdentity(h.user,h.device));assert.equal(i.owns_key_package_ref(p,h.ref),true);assert.equal(i.owns_key_package_ref(p,winner.ref),true);i.free();p.free();
  assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner.base);
 }finally{await h.close();}
});
test('old publication finally cannot clear a replacement in-flight CID owner',async()=>{
 const h=await fixture(),entered=latch(),gate=latch();try{h.m.e2eeClient.getGroupInfoPublicationMarker=async()=>{entered.resolve();await gate.promise;return{marker:null};};const old=h.m._checkChannelEvidence(h.cid),observed=old.catch(e=>e);await entered.promise;
  h.m.deviceId='replacement';const replacement=Promise.resolve();h.m._channelEvidenceLocks.set(h.cid,replacement);gate.resolve();assert.ok(await observed instanceof Error);assert.equal(h.m._channelEvidenceLocks.get(h.cid),replacement);
 }finally{gate.resolve();await h.close();}
});

test('returning channel subscriber shares the current durable hot proof after a private write while unmounted',async()=>{
 const h=await fixture('ready');let sub;try{
  assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
  sub=h.m.subscribeE2eeState(h.cid,()=>{});sub.unsubscribe();
  await h.m._persistProviderStrict();assert.equal(h.m.getE2eeState(h.cid).state,'ready');
  assert.equal(h.m._subscribedReadyRequests.size,0,'unmounted channel has no background proof obligation');
  const before=await h.s.loadProviderCheckpoint(h.user,h.device),seen=[];h.calls.length=0;
  sub=h.m.subscribeE2eeState(h.cid,x=>seen.push(x));assert.equal(seen[0].state,'ready','Returning view shares the newly verified durable proof');
  await h.m._subscribedReadyRevalidation;
  assert.equal(seen.at(-1).state,'ready');assert.equal(h.m.getE2eeState(h.cid).state,'ready');
  assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before,'readmission performs no private rewrite');assert.equal(h.calls.length,0,'local proof readmission performs no HTTP');await privatePreserved(h);
 }finally{sub?.unsubscribe();await h.close();}
});

test('one live composer does not revalidate five inactive recent scopes on every provider checkpoint',async()=>{
 const h=await fixture('ready'),cids=[h.cid],subs=[];
 try{
  for(let i=1;i<6;i++){
   const cid=h.cid+'-'+i,group=wasm.Group.create_with_cid(h.m.provider,h.m.identity,cid),marker={...h.marker,cid};
   h.m.groups.set(cid,group);h.m._groupGenerations.set(cid,marker);await h.s.saveGroupState(cid,marker);
   h.m.client.activeChannels[cid]={data:{mls_enabled:true},state:{members:{[h.user]:{user_id:h.user,created_at:'2026-10-17T00:00:00Z'}}}};
   h.m.observeChannelE2ee({...h.metadata,cid},true);cids.push(cid);
  }
  await h.m._persistProviderStrict();
  for(const cid of cids)assert.equal((await h.m.refreshE2eeState(cid)).state,'ready');
  const live=cids.at(-1),proofs=[],refresh=h.m._refreshE2eeStateOnce.bind(h.m);
  subs.push(h.m.subscribeE2eeState(live,()=>{}));
  h.m._refreshE2eeStateOnce=async(cid,...args)=>{proofs.push(cid);return refresh(cid,...args);};
  await h.m._persistProviderStrict();
  assert.deepEqual(proofs,[live],'only the live scope needs an eager native/durable observation');
  assert.equal(h.m.getE2eeState(live).state,'ready');
  for(const cid of cids.slice(0,-1))assert.notEqual(h.m.getE2eeState(cid)?.state,'ready','inactive proof must retire truthfully');
  proofs.length=0;await h.m._withProviderMutation(async()=>{});
  assert.deepEqual(proofs,[],'intent reservation/read-only provider work must not fall back to an inactive view while a live view is already Ready');
  const after=await h.s.loadProviderCheckpoint(h.user,h.device);h.calls.length=0;
  const seen=[];subs.push(h.m.subscribeE2eeState(cids[0],state=>seen.push(state.state)));
  await h.m._subscribedReadyRevalidation;
  assert.equal(seen.at(-1),'ready');assert.equal(h.calls.length,0);
  assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),after,'late local proof does not rewrite the private provider');
 }finally{subs.forEach(s=>s.unsubscribe());await h.close();}
});

test('durable intent admission stays open during a held local reproof while cryptographic Ready stays false',async()=>{
 const h=await fixture('ready'),entered=latch(),release=latch();let sub;
 try{
  const cursor={created_at:'2026-11-01T00:00:00Z',event_id:'00000000-0000-0000-0000-000000000001'};
  await h.s.saveScopeSyncCursor(h.cid,cursor);assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
  h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));
  sub=h.m.subscribeE2eeState(h.cid,()=>{});
  const refresh=h.m._refreshE2eeStateOnce.bind(h.m);
  h.m._refreshE2eeStateOnce=async(...args)=>{entered.resolve();await release.promise;return refresh(...args);};
  const writer=h.m._persistProviderStrict();await entered.promise;
  assert.equal(h.m.getE2eeState(h.cid)?.state,'repairing');
  assert.equal(h.m.getE2eeState(h.cid)?.reason,'local_checkpoint_pending');
  assert.equal(typeof h.m.canEnqueueApplicationSend,'function');
  assert.equal(h.m.canEnqueueApplicationSend(h.cid),true);
  assert.equal(h.m.getE2eeState(h.cid)?.state,'repairing','intent eligibility never publishes Ready');
  const blocked = (set, restore, reason) => {
   set();try{assert.equal(h.m.canEnqueueApplicationSend(h.cid),false,reason);}finally{restore();}
   assert.equal(h.m.canEnqueueApplicationSend(h.cid),true,'original exact owner remains eligible after '+reason);
  };
  blocked(()=>h.m._providerPersistenceUncertain=true,()=>h.m._providerPersistenceUncertain=false,'uncertain persistence');
  h.m._syncing=true;assert.equal(h.m.canEnqueueApplicationSend(h.cid),true,'independent account sync cannot block this scope after its bound delivery');h.m._syncing=false;
  blocked(()=>h.m._pendingMlsMutations.set(h.cid,{}),()=>h.m._pendingMlsMutations.delete(h.cid),'retained mutation');
  blocked(()=>h.m._externalJoinCandidates.set(h.cid,{}),()=>h.m._externalJoinCandidates.delete(h.cid),'retained External Join');
  blocked(()=>h.m._scopeRepairLocks.set(h.cid,Promise.resolve()),()=>h.m._scopeRepairLocks.delete(h.cid),'repair ownership');
  blocked(()=>h.m._scopeSyncRequestedAfterRepair.add(h.cid),()=>h.m._scopeSyncRequestedAfterRepair.delete(h.cid),'missing repair delivery');
  blocked(()=>h.m._recoveryControls.set(h.cid,{recovery_action:'manual_intervention_required'}),()=>h.m._recoveryControls.delete(h.cid),'manual recovery');
  const data=h.m.client.activeChannels[h.cid].data;
  blocked(()=>data.deleted_at='2026-11-23T00:00:00Z',()=>delete data.deleted_at,'deleted channel');
  const delivery=h.m._completedSyncProgress.get(h.cid);
  blocked(()=>h.m._completedSyncProgress.delete(h.cid),()=>h.m._completedSyncProgress.set(h.cid,delivery),'unproved delivery');
  const head=h.m._channelE2ee.get(h.cid);
  blocked(()=>h.m._channelE2ee.set(h.cid,{...head,epoch:1}),()=>h.m._channelE2ee.set(h.cid,head),'new remote epoch');
  blocked(()=>h.m._channelE2ee.set(h.cid,{...head,group_generation:1}),()=>h.m._channelE2ee.set(h.cid,head),'new generation');
  const owner=h.m._retiredHotReady.get(h.cid);
  blocked(()=>h.m._retiredHotReady.delete(h.cid),()=>h.m._retiredHotReady.set(h.cid,owner),'no prior owned Ready witness');
  assert.equal(h.calls.length,0,'UI intent eligibility performs no HTTP');
  release.resolve();await writer;assert.equal(h.m.getE2eeState(h.cid)?.state,'ready');
 }finally{release.resolve();sub?.unsubscribe();await h.close();}
});

for(const stop of ['unsubscribe','owner','manual'])test('returning subscriber checkpoint wake preserves '+stop+' fences',async()=>{
 const h=await fixture('ready'),entered=latch(),release=latch();let writer,sub;try{
  await h.m.refreshE2eeState(h.cid);await h.m._persistProviderStrict();
  const save=h.s.saveProviderState.bind(h.s);h.s.saveProviderState=async(...a)=>{entered.resolve();await release.promise;return save(...a)};
  const kp=h.m.identity.key_package(h.m.provider);kp.free();
  writer=h.m._persistProviderStrict();await entered.promise;
  const seen=[];sub=h.m.subscribeE2eeState(h.cid,x=>seen.push(x));
  if(stop==='unsubscribe')sub.unsubscribe();
  if(stop==='owner')h.m.client={activeChannels:{}};
  if(stop==='manual'){const control={version:1,user_id:h.user,device_id:h.device,cid:h.cid,signing_identity_sha256:sdk.sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:crypto.randomUUID(),recovery_action:'manual_intervention_required',recovery_revision:'2',repair_retry_until:null};h.m._recoveryControls.set(h.cid,control);await h.s.saveRecoveryControlCheckpoint(control);}
  release.resolve();await writer;await h.m._subscribedReadyRevalidation;
  assert.ok(seen.every(x=>x.state!=='ready'));
  if(stop==='unsubscribe')assert.equal(h.m.getE2eeState(h.cid)?.state,'ready');else assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');
 }finally{release.resolve();if(writer)await writer;sub?.unsubscribe();await h.close();}
});

test('restart metadata control reads do not serialize the shared provider once per scope',async(t)=>{
 const h=await fixture('ready'),provider=h.m.provider,original=provider.to_bytes.bind(provider);let serializations=0;
 try{
  Object.assign(h.m.client.activeChannels[h.cid],{cid:h.cid,id:h.cid.slice(5),type:'team'});
  provider.to_bytes=()=>{serializations++;return original();};
  await h.m._restoreGroupsLocally([]);const one=serializations;
  for(let i=1;i<49;i++){const cid=h.cid+'-'+i;h.m.client.activeChannels[cid]={cid,id:cid.slice(5),type:'team',data:{mls_enabled:true},state:{members:{[h.user]:{user_id:h.user,created_at:'2026-10-17T00:00:00Z'}}}};}
  assert.equal(h.m._listKnownE2eeChannels().length,49,'fixture must exercise the actual full metadata inventory');
  serializations=0;await h.m._restoreGroupsLocally([]);const many=serializations;
  t.diagnostic(`provider_serializations one_scope=${one} forty_nine_scopes=${many}`);
  assert.ok(many<=one+4,`private-byte serialization amplified with metadata scope count: one=${one}, fortyNine=${many}`);
  assert.equal(h.m.groups.size,1,'metadata scan does not restore dormant native groups');assert.equal(h.calls.length,0);
 }finally{provider.to_bytes=original;await h.close();}
});
for(const change of ['account','private_bytes','control'])test('batched metadata control read keeps '+change+' owner fencing',async()=>{
 const h=await fixture('ready'),entered=latch(),release=latch(),load=h.s.loadRecoveryControlCheckpoint.bind(h.s);let work;
 try{
  h.s.loadRecoveryControlCheckpoint=async(...args)=>{const value=await load(...args);entered.resolve();await release.promise;return value;};
  work=h.m._restoreGroupsLocally([]);const rejected=assert.rejects(work,{code:'recovery_scope_changed'});await entered.promise;
  if(change==='account')h.m.userId='replacement';
  if(change==='private_bytes'){const kp=h.m.identity.key_package(h.m.provider);kp.free();}
  const winner={group_generation:0,recovery_action:'manual_intervention_required'};
  if(change==='control')h.m._recoveryControls.set(h.cid,winner);
  release.resolve();await rejected;
  if(change==='control')assert.equal(h.m._recoveryControls.get(h.cid),winner);else assert.equal(h.m._recoveryControls.has(h.cid),false);
 }finally{release.resolve();if(work)await work.catch(()=>{});h.m.userId=h.user;await h.close();}
});

test('metadata page validates every control before adopting a malformed later row',async()=>{
 const h=await fixture('ready'),other=h.cid+'-other';
 try{
  h.m.client.activeChannels[other]={cid:other,id:other.slice(5),type:'team',data:{mls_enabled:true},state:{members:{[h.user]:{user_id:h.user}}}};
  const control={version:1,user_id:h.user,device_id:h.device,cid:h.cid,signing_identity_sha256:sdk.sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:crypto.randomUUID(),recovery_action:'manual_intervention_required',recovery_revision:'2',repair_retry_until:null};
  await h.s.saveRecoveryControlCheckpoint(control);h.s.loadRecoveryControlCheckpoint=async cid=>cid===h.cid?control:{version:99};
  await assert.rejects(h.m._restoreGroupsLocally([]));assert.equal(h.m._recoveryControls.size,0,'bad later metadata cannot partially install earlier controls');
 }finally{await h.close();}
});
test('metadata restore uses at most fifty simultaneous reads and adopts actual manual controls',async()=>{
 const h=await fixture('ready'),load=h.s.loadRecoveryControlCheckpoint.bind(h.s);let active=0,peak=0,reads=0;
 try{
  Object.assign(h.m.client.activeChannels[h.cid],{cid:h.cid,id:h.cid.slice(5),type:'team'});
  for(let i=1;i<101;i++){const cid=h.cid+'-'+i;h.m.client.activeChannels[cid]={cid,id:cid.slice(5),type:'team',data:{mls_enabled:true},state:{members:{[h.user]:{user_id:h.user}}}};}
  const control={version:1,user_id:h.user,device_id:h.device,cid:h.cid,signing_identity_sha256:sdk.sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:crypto.randomUUID(),recovery_action:'manual_intervention_required',recovery_revision:'2',repair_retry_until:null};
  await h.s.saveRecoveryControlCheckpoint(control);
  h.s.loadRecoveryControlCheckpoint=async(...a)=>{reads++;active++;peak=Math.max(peak,active);try{return await load(...a)}finally{active--}};
  await h.m._restoreGroupsLocally([]);assert.equal(reads,101);assert.ok(peak<=50);assert.deepEqual(h.m._recoveryControls.get(h.cid),control);
  assert.notEqual((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal(h.calls.length,0);assert.equal(h.m.groups.size,1);
 }finally{await h.close();}
});
