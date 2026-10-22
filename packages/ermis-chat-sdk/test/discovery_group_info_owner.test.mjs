// Original queue-retirement fixtures retained in the 20261019 QA evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,privatePreserved,peer,put,work,latch,sdk,wasm} from './flat_publication_fixture.mjs';
const legacy=h=>({cid:h.cid,request_id:'retained',minimum_epoch:0,reason:'group_info_stale',deadline_at:'2026-10-12T00:00:00Z',expires_at:'2030-01-01T00:00:00Z',attempt_count:1});
const response=(h,extra={})=>({protocol_version:1,capability:{protocol_version:1},states:{[h.cid]:{result:'state',generation:{group_generation:0,group_id:null,current_epoch:0,membership_version:'1',state:'ready',reason:'group_info_missing',retryable:true},publication_marker:null,...extra}}});
async function setup(){const h=await fixture('ready');delete h.m._discoverMlsRecoveryStates;h.m._groupInfoRepair=h.m._createDurableGroupInfoRepair();return h;}
test('discovery absent marker preserves legacy obligations and cannot publish Ready or GI',async()=>{
 const h=await setup();try{await h.s.saveGroupInfoRefreshRequest(legacy(h));h.events.length=0;h.m.e2eeClient.discoverMlsRecovery=async()=>response(h);
  assert.equal((await h.m._discoverMlsRecoveryStatesRaw([h.cid])).states[h.cid].result,'state');
  assert.deepEqual(await h.s.listGroupInfoRefreshRequests(),[legacy(h)]);assert.equal(h.events.some(e=>e.state==='ready'),false);assert.equal(h.calls.length,0);await privatePreserved(h);
 }finally{await h.close();}
});
for(const dimension of ['account','device','storage','identity','transport','artifact','group','marker','pending','external','membership','coordinator'])
for(const result of ['success','error'])test(`discovery late ${result} preserves ${dimension} replacement and retained obligations`,async()=>{
 const h=await setup(),entered=latch(),gate=latch();try{await h.s.saveGroupInfoRefreshRequest(legacy(h));h.m.e2eeClient.discoverMlsRecovery=async()=>{entered.resolve();await gate.promise;if(result==='error')throw Error('late transport');return response(h);};
  const task=h.m._discoverMlsRecoveryStatesRaw([h.cid]),observed=task.catch(e=>e);await entered.promise;await h.s.saveGroupInfoRefreshRequest({...legacy(h),request_id:'winner'});
  if(dimension==='account')h.m.userId='replacement';if(dimension==='device')h.m.deviceId='replacement';if(dimension==='storage')h.m.storage=new sdk.IndexedDBEncryptionStorage(h.user);
  if(dimension==='identity')h.m.identity=wasm.Identity.from_bytes(h.m.provider,h.m.identity.to_bytes());if(dimension==='transport')h.m.e2eeClient={};if(dimension==='artifact')h.m._wasmArtifactSha256='f'.repeat(64);
  if(dimension==='group')h.m.groups.set(h.cid,wasm.Group.load(h.m.provider,h.cid));if(dimension==='marker')h.m._groupGenerations.set(h.cid,{...h.marker,updated_at:2});if(dimension==='pending')h.m._pendingMlsMutations.set(h.cid,{operation_id:'winner'});
  if(dimension==='external')h.m._externalJoinCandidates.set(h.cid,{operation_id:'winner'});if(dimension==='membership')h.m.client.activeChannels[h.cid].state.members[h.user]={user_id:h.user,created_at:'2026-10-18T00:00:00Z'};if(dimension==='coordinator')h.m._groupInfoRepair=null;
  gate.resolve();const value=await observed;assert.ok(value instanceof Error || value.states[h.cid].result==='error');assert.equal((await h.s.listGroupInfoRefreshRequests()).length,2);assert.equal(h.calls.length,0);assert.equal((await work(h)).length,0);assert.equal(h.events.some(e=>e.state==='ready'),false);
 }finally{gate.resolve();await h.close();}
});
for(const state of ['matching','wrong-generation','wrong-epoch'])test(`metadata discovery ${state} marker only schedules matching publication and never creates Ready`,async()=>{
 const h=await setup();try{const queued=[];h.m._queueChannelEvidence=cid=>queued.push(cid);const marker={group_generation:state==='wrong-generation'?1:0,epoch:state==='wrong-epoch'?1:0,observed_hash:null};
  h.m.e2eeClient.discoverMlsRecovery=async()=>response(h,{publication_marker:marker});await h.m._discoverMlsRecoveryStatesRaw([h.cid]);marker.epoch=77;
  assert.equal(queued.length,state==='matching'?1:0);assert.equal(h.m._channelE2ee.get(h.cid).epoch,0);assert.equal(h.calls.length,0);assert.equal(h.events.some(e=>e.state==='ready'),false);await privatePreserved(h);
 }finally{await h.close();}
});
for(const fault of ['abort','readback','unknown','private-winner'])test(`discovered control ${fault} cannot publish unproved authority or overwrite private winner`,async()=>{
 const h=await setup();try{const next={...response(h).states[h.cid].generation,incident_id:crypto.randomUUID(),recovery_action:'repair',recovery_revision:'1',repair_retry_until:new Date(Date.now()+900000).toISOString()};
  h.m.e2eeClient.discoverMlsRecovery=async()=>response(h,{generation:next});const save=h.s.saveRecoveryControlWork.bind(h.s);let winner;
  h.s.saveRecoveryControlWork=async(...a)=>{if(fault==='private-winner'){winner=(await peer(h)).base;return save(...a);}if(fault==='unknown'){await save(...a);throw Error('return lost');}
   const db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false;db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite'){if(fault==='abort')queueMicrotask(()=>tx.abort());else tx.addEventListener('complete',()=>{committed=true;});}if(args[1]==='readonly'&&committed)queueMicrotask(()=>tx.abort());return tx;};try{return await save(...a);}finally{db.transaction=original;}};
  const result=await h.m._discoverMlsRecoveryStatesRaw([h.cid]);assert.equal(result.states[h.cid].result,'error');assert.equal(h.m._recoveryControls.has(h.cid),false);assert.equal(h.events.some(e=>e.state==='ready'),false);
  if(winner)assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner);else await privatePreserved(h);
 }finally{await h.close();}
});
test('101 retained legacy rows do not become a new generic discovery cap or erase a public obligation',async()=>{
 const h=await setup();try{for(let i=0;i<101;i++)await h.s.saveGroupInfoRefreshRequest({...legacy(h),request_id:'r'+i});let calls=0;h.m.e2eeClient.discoverMlsRecovery=async()=>{calls++;return response(h);};
  const value=await h.m._discoverMlsRecoveryStatesRaw([h.cid]);assert.equal(value.states[h.cid].result,'state');assert.equal(calls,1);assert.equal((await h.s.listGroupInfoRefreshRequests()).length,101);await privatePreserved(h);
 }finally{await h.close();}
});
