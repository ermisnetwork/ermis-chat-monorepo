// DEC084: flat publication/CAS replacements for the preserved per-request lease fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,work,put,privatePreserved,peer,latch,sdk,wasm} from './flat_publication_fixture.mjs';

for(const phase of ['reservation','completion']) for(const fault of ['abort','unknown','readback'])
test(`${phase} ${fault} keeps private material and the durable publication obligation`,async()=>{
 const h=await fixture();try{
  const save=h.s.saveChannelEvidenceWork.bind(h.s);let hit=false;
  h.s.saveChannelEvidenceWork=async(...args)=>{
   if(hit || (args[4].outcome==='finished')!==(phase==='completion'))return save(...args);
   hit=true;
   if(fault==='unknown'){await save(...args);throw Error('committed return lost');}
   const db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false;
   db.transaction=(...a)=>{const tx=original(...a);if(a[1]==='readwrite'){if(fault==='abort')queueMicrotask(()=>tx.abort());else tx.addEventListener('complete',()=>{committed=true;});}if(a[1]==='readonly'&&committed)queueMicrotask(()=>tx.abort());return tx;};
   try{return await save(...args);}finally{db.transaction=original;}
  };
  if(phase==='completion'&&fault==='abort')await h.m._checkChannelEvidence(h.cid);else await assert.rejects(h.m._checkChannelEvidence(h.cid));assert.equal(hit,true);
  assert.equal(h.calls.filter(x=>typeof x==='object').length,phase==='completion'?1:0);
  const rows=await work(h);assert.equal(rows.length,phase==='reservation'&&fault==='abort'?0:1);
  if(rows.length){assert.equal(rows[0].attempts,1);assert.equal(rows[0].outcome,phase==='completion'&&fault!=='abort'?'finished':'pending');}
  await privatePreserved(h);
 }finally{await h.close();}
});
for(const dimension of ['account','device','storage','signer','artifact','membership','transport','coordinator','group','marker','pending','provider','control'])
for(const outcome of ['success','error'])test(`late marker ${outcome} cannot mutate ${dimension} replacement`,async()=>{
 const h=await fixture(),entered=latch(),gate=latch();try{
  h.m.e2eeClient.getGroupInfoPublicationMarker=async()=>{entered.resolve();await gate.promise;if(outcome==='error')throw Error('late error');return{marker:null};};
  const task=h.m._checkChannelEvidence(h.cid),observed=task.catch(e=>e);await entered.promise;const before=await work(h);
  if(dimension==='account')h.m.userId='replacement';if(dimension==='device')h.m.deviceId='replacement';
  if(dimension==='storage')h.m.storage=new sdk.IndexedDBEncryptionStorage(h.user);
  if(dimension==='signer')h.m.identity=wasm.Identity.from_bytes(h.m.provider,h.m.identity.to_bytes());
  if(dimension==='artifact')h.m._wasmArtifactSha256='a'.repeat(64);
  if(dimension==='membership')h.m.client.activeChannels[h.cid].state.members[h.user]={user_id:h.user,created_at:'2026-10-18T00:00:00Z'};
  if(dimension==='transport')h.m.e2eeClient={};if(dimension==='coordinator')h.m._groupInfoRepair={};
  if(dimension==='group')h.m.groups.set(h.cid,wasm.Group.load(h.m.provider,h.cid));
  if(dimension==='marker')h.m._groupGenerations.set(h.cid,{...h.marker,updated_at:2});
  if(dimension==='pending')h.m._pendingMlsMutations.set(h.cid,{operation_id:'winner'});
  if(dimension==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.bytes);
  if(dimension==='control')h.m._recoveryControls.set(h.cid,{recovery_revision:'2'});
  gate.resolve();const result=await observed;if(dimension!=='control')assert.ok(result instanceof Error);assert.deepEqual(await work(h),before);
  assert.equal(h.calls.filter(x=>typeof x==='object').length,0);
 }finally{gate.resolve();await h.close();}
});
for(const kind of ['mutation','external','removal'])test(`durable ${kind} blocks publication even without its RAM hint`,async()=>{
 const h=await fixture();try{const key=kind==='mutation'?'mls_mutation:v1:':kind==='external'?'external_candidate:v1:':'mls_removal:v1:';
  await put(h,key+h.cid,{operation_id:'durable'});await h.m._checkChannelEvidence(h.cid);
  assert.equal(h.calls.length,0);assert.equal((await work(h)).length,0);await privatePreserved(h);
 }finally{await h.close();}
});
for(const cap of ['channelEvidenceWorkVersion','loadChannelEvidenceWork','saveChannelEvidenceWork'])test(`missing ${cap} upgrades before marker or POST`,async()=>{
 const h=await fixture();try{h.s[cap]=undefined;await assert.rejects(h.m._checkChannelEvidence(h.cid),{code:'client_upgrade_required'});assert.equal(h.calls.length,0);await privatePreserved(h);}finally{await h.close();}
});
for(const reason of ['ERR_NETWORK','ETIMEDOUT','group_info_target_changed','client_upgrade_required'])test(`publication ${reason} retains bounded durable attempts and exact exported bytes`,async()=>{
 const h=await fixture();try{let body;h.m.e2eeClient.submitReservedGroupInfo=async(_t,_i,b)=>{body=structuredClone(b);throw Object.assign(Error(reason),{code:reason});};
  await h.m._checkChannelEvidence(h.cid);const row=(await work(h))[0];assert.equal(row.attempts,1);assert.equal(row.last_reason,reason);assert.ok(row.retry_at>Date.now());
  assert.equal(row.outcome,reason==='client_upgrade_required'?'exhausted':'pending');assert.equal(body.lease_token,undefined);assert.equal(body.request_id,undefined);
  assert.deepEqual(body.expected,{group_generation:0,group_id:null});assert.equal(row.request,null);await privatePreserved(h);
 }finally{await h.close();}
});
test('lost upload ACK is retried from the same durable evidence after storage reopen without replenishing attempts',async()=>{
 const h=await fixture();try{h.m.e2eeClient.submitReservedGroupInfo=async()=>{throw Object.assign(Error('offline'),{code:'ERR_NETWORK'});};await h.m._checkChannelEvidence(h.cid);
  const before=await work(h),s=new sdk.IndexedDBEncryptionStorage(h.user),base=await s.loadProviderCheckpoint(h.user,h.device);h.m.storage=s;h.m._providerDurableBase={storage:s,userId:h.user,deviceId:h.device,revision:base.revision};
  await h.m._checkChannelEvidence(h.cid);assert.deepEqual(await work(h),before);assert.equal(h.calls.length,1);await s.close();await privatePreserved(h);
 }finally{await h.close();}
});
test('flat marker null still requires generation-bound publication and actual independent crypto can join',async()=>{
 const h=await fixture();try{h.m.e2eeClient.getGroupInfoPublicationMarker=async()=>({marker:null});await h.m._checkChannelEvidence(h.cid);
  const body=h.calls.find(x=>typeof x==='object'),p=new wasm.Provider(),i=new wasm.Identity(p,'independent');
  const joined=wasm.Group.join_external_with_policy(p,i,body.group_info,null,false);assert.equal(Number(joined.group.epoch()),1);
  assert.equal((await work(h))[0].outcome,'finished');await privatePreserved(h);
 }finally{await h.close();}
});
test('legacy hints never resurrect claim/lease APIs or erase retained old obligations',async()=>{
 const h=await fixture('ready');try{const legacy={cid:h.cid,request_id:'retained',minimum_epoch:0,reason:'group_info_stale',deadline_at:new Date().toISOString(),expires_at:'2030-01-01T00:00:00Z',attempt_count:1};await h.s.saveGroupInfoRefreshRequest(legacy);
  h.m._groupInfoRepair=h.m._createDurableGroupInfoRepair();await h.m._groupInfoRepair.start([],[{...legacy,version:1}]);await h.m._groupInfoRepair.handleUploaded({cid:h.cid,version:1});
  assert.deepEqual(await h.s.listGroupInfoRefreshRequests(),[legacy]);assert.equal(h.calls.length,0);assert.equal((await work(h)).length,0);await privatePreserved(h);
 }finally{await h.close();}
});
test('signed standalone publication keeps the existing five-second HTTP timeout and generation expectation',async()=>{
 const calls=[],api=new sdk.E2eeClient({baseURL:'https://fixture.invalid',deviceId:'device',doAxiosRequest:async(...a)=>{calls.push(a);return{};}});
 await api.getGroupInfoPublicationMarker('team','x');await api.submitReservedGroupInfo('team','x',{group_info:Uint8Array.of(1),epoch:0,observed_hash:null,expected:{group_generation:0,group_id:null}});
 assert.equal(calls.length,2);for(const call of calls)assert.equal(call[3].timeout,5000);assert.equal(calls[1][2].lease_token,undefined);
});
