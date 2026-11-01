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

test('returning channel subscriber re-admits its genuine Ready proof after a private write while unmounted',async()=>{
 const h=await fixture('ready');let sub;try{
  assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
  sub=h.m.subscribeE2eeState(h.cid,()=>{});sub.unsubscribe();
  await h.m._persistProviderStrict();assert.equal(h.m.getE2eeState(h.cid).reason,'local_checkpoint_pending');
  assert.equal(h.m._subscribedReadyRequests.size,0,'unmounted channel has no background proof obligation');
  const before=await h.s.loadProviderCheckpoint(h.user,h.device),seen=[];h.calls.length=0;
  sub=h.m.subscribeE2eeState(h.cid,x=>seen.push(x));assert.equal(seen[0].reason,'local_checkpoint_pending','stale proof cannot be called Ready synchronously');
  await h.m._subscribedReadyRevalidation;
  assert.equal(seen.at(-1).state,'ready');assert.equal(h.m.getE2eeState(h.cid).state,'ready');
  assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before,'readmission performs no private rewrite');assert.equal(h.calls.length,0,'local proof readmission performs no HTTP');await privatePreserved(h);
 }finally{sub?.unsubscribe();await h.close();}
});

for(const stop of ['unsubscribe','owner','manual'])test('returning subscriber checkpoint wake preserves '+stop+' fences',async()=>{
 const h=await fixture('ready'),entered=latch(),release=latch();let writer,sub;try{
  await h.m.refreshE2eeState(h.cid);await h.m._persistProviderStrict();
  const save=h.s.saveProviderState.bind(h.s);h.s.saveProviderState=async(...a)=>{entered.resolve();await release.promise;return save(...a)};
  writer=h.m._persistProviderStrict();await entered.promise;
  const seen=[];sub=h.m.subscribeE2eeState(h.cid,x=>seen.push(x));
  if(stop==='unsubscribe')sub.unsubscribe();
  if(stop==='owner')h.m.client={activeChannels:{}};
  if(stop==='manual'){const control={version:1,user_id:h.user,device_id:h.device,cid:h.cid,signing_identity_sha256:sdk.sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:crypto.randomUUID(),recovery_action:'manual_intervention_required',recovery_revision:'2',repair_retry_until:null};h.m._recoveryControls.set(h.cid,control);await h.s.saveRecoveryControlCheckpoint(control);}
  release.resolve();await writer;await h.m._subscribedReadyRevalidation;
  assert.ok(seen.every(x=>x.state!=='ready'));assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');
 }finally{release.resolve();if(writer)await writer;sub?.unsubscribe();await h.close();}
});
