import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, wasm} from './flat_publication_fixture.mjs';

test('opening a dormant installed scope consumes completed session delivery and proves Ready without sync or join', async () => {
 const h = await fixture('ready'); let syncs = 0, missingAdmissions = 0;
 try {
  const cursor = {created_at:'2026-11-01T00:00:00.000Z',event_id:'00000000-0000-0000-0000-000000000001'};
  await h.s.saveScopeSyncCursor(h.cid, cursor);
  assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
  await h.m._checkpointBootstrap(h.cid);
  h.group.free(); h.m.groups.delete(h.cid); h.m._commonStates.clear(); h.m._hotReadyScopes.length = 0;
  // The empty session delta completes delivery without materializing this group.
  h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));
  assert.equal(h.m.getEpoch(h.cid),-1);
  h.m.e2eeClient.scopeSync = async () => { syncs++; throw Error('unexpected open sync'); };
  h.m._syncNewChannelLegacy = async () => { missingAdmissions++; return {cid:h.cid,status:'needs_retry',error:'unexpected_missing_group_admission'}; };
  const result = await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'});
  assert.equal(result.status,'ready');
  assert.equal(h.m.getEpoch(h.cid),0);
  assert.equal(h.m.getE2eeState(h.cid)?.state,'ready');
  assert.equal(syncs,0); assert.equal(missingAdmissions,0);
 } finally { await h.close(); }
});

for (const change of ['owned_checkpoint','query_self_member']) test('completed event delivery survives ' + change + ' without granting Ready or fetching again', async () => {
 const h = await fixture('ready'); let syncs = 0;
 try {
  const cursor = {created_at:'2026-11-01T00:00:00.000Z',event_id:'00000000-0000-0000-0000-000000000001'};
  await h.s.saveScopeSyncCursor(h.cid,cursor);
  assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
  h.m._hotReadyScopes.length = 0;
  h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));
  if (change === 'query_self_member') {
   const channel = h.m.client.activeChannels[h.cid];
   channel.state.members[h.user] = {...channel.state.members[h.user]};
  } else {
   await h.m._withProviderMutation(async (provider,current,replace) => {
    const candidate = wasm.Provider.from_bytes(provider.to_bytes()), bytes = new Uint8Array(candidate.to_bytes());
    const guard = h.m._providerWriteGuard();
    await h.s.saveProviderState(h.user,h.device,bytes,guard); current();
    await h.m._readProviderWrite(bytes,guard,current);
    replace(candidate);
   });
  }
  assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready','current Ready still requires a fresh exact proof');
  assert.ok(h.m._getCompletedSyncProgress(h.cid),'logical delivery is independent of object materialization/profile hydration');
  h.m.e2eeClient.scopeSync = async () => { syncs++; throw Error('unexpected point sync'); };
  const result = await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'});
  assert.equal(result.status,'ready');assert.equal(syncs,0);
 } finally { await h.close(); }
});

test('post-query admission cannot inherit a retired pre-query evidence promise', async () => {
 const h = await fixture('ready');
 let release, entered;
 const gate = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
 try {
  const load = h.m._loadRecoveryControl.bind(h.m); let first = true;
  h.m._loadRecoveryControl = async (...args) => {
   if (first) { first = false; entered(); await gate; }
   return load(...args);
  };
  const old = h.m._checkChannelEvidence(h.cid, false);
  const retired = assert.rejects(old, {code:'recovery_scope_changed'});
  await started;
  const channel = h.m.client.activeChannels[h.cid];
  // An authoritative query replaces the self-member with the same membership.
  channel.state.members[h.user] = {...channel.state.members[h.user]};
  const fresh = h.m._checkChannelEvidence(h.cid, false);
  const observed = fresh.then(value => ({value}), error => ({error}));
  release(); await retired;
  const result = await observed;
  assert.equal(result.error, undefined);
  assert.equal(result.value?.snapshot.state, 'ready');
 } finally { release(); await h.close(); }
});

test('a retired open admission cannot mark the current session channel failed', async () => {
 const h = await fixture('ready'), progress = [];
 let release, entered;
 const gate = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
 try {
  h.m.client._recordSessionReadiness = (cid,result) => progress.push({cid,result});
  const load = h.m._loadRecoveryControl.bind(h.m);
  h.m._loadRecoveryControl = async (...args) => { entered(); await gate; return load(...args); };
  const old = h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'});
  const rejected = assert.rejects(old,{code:'recovery_scope_changed'});
  await started;
  const channel = h.m.client.activeChannels[h.cid];
  channel.state.members[h.user] = {...channel.state.members[h.user]};
  release(); await rejected;
  assert.deepEqual(progress,[]);
 } finally { release(); await h.close(); }
});

test('query self-member hydration cannot cancel a shared native read or strand its subscribed composer', async () => {
 const h = await fixture('ready'); let release, entered, reads = 0, sub;
 const gate = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
 try {
  h.group.free(); h.m.groups.delete(h.cid); h.m._commonStates.clear(); h.m._hotReadyScopes.length = 0;
  const load = h.s.loadGroupState.bind(h.s);
  h.s.loadGroupState = async cid => { reads++; entered(); await gate; return load(cid); };
  const seen = []; sub = h.m.subscribeE2eeState(h.cid,state => seen.push(state));
  const first = h.m._restoreInstalledGroupOnDemand(h.cid), observed = first.then(()=>null,e=>e);
  await started;
  const channel = h.m.client.activeChannels[h.cid];
  channel.state.members[h.user] = {...channel.state.members[h.user]};
  const fresh = h.m._restoreInstalledGroupOnDemand(h.cid), joined = fresh.then(()=>null,e=>e);
  release();
  assert.equal(await observed,null);assert.equal(await joined,null);
  assert.equal(reads,1,'equivalent query readsets coalesce the same read-only group load');
  assert.equal(h.m.getEpoch(h.cid),0);
  await h.m._subscribedReadyRevalidation;
  assert.equal(h.m.getE2eeState(h.cid)?.state,'ready');
  assert.equal(seen.at(-1)?.state,'ready');
 } finally { release();sub?.unsubscribe();await h.close(); }
});

for (const resident of [true,false]) for (const changed of [false,true]) test('eight cold scopes continue across query hydration, RAM markers=' + resident + ', real membership change=' + changed, async () => {
 const h = await fixture('ready'), cids = [h.cid], subs = [];
 let release, entered, reads = 0, activeReads = 0, peakReads = 0, syncs = 0;
 const gate = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
 try {
  for (let i=1;i<8;i++) {
   const cid = h.cid+'-'+i, group = wasm.Group.create_with_cid(h.m.provider,h.m.identity,cid), marker = {...h.marker,cid};
   h.m.groups.set(cid,group);h.m._groupGenerations.set(cid,marker);await h.s.saveGroupState(cid,marker);
   h.m.client.activeChannels[cid] = {data:{mls_enabled:true},state:{members:{[h.user]:{user_id:h.user,created_at:'2026-10-17T00:00:00Z'}}}};
   h.m.observeChannelE2ee({...h.metadata,cid},true);cids.push(cid);
  }
  await h.m._persistProviderStrict();
  for (const group of h.m.groups.values()) group.free();
  h.m.groups.clear();h.m._commonStates.clear();h.m._hotReadyScopes.length=0;
  if(!resident)h.m._groupGenerations.clear();
  const load = h.s.loadGroupState.bind(h.s);
  h.s.loadGroupState = async cid => { reads++;activeReads++;peakReads=Math.max(peakReads,activeReads);entered();try{await gate;return await load(cid);}finally{activeReads--;} };
  h.m.e2eeClient.scopeSync = async()=>{syncs++;throw Error('unexpected native-read sync');};
  for(const cid of cids)subs.push(h.m.subscribeE2eeState(cid,()=>{}));
  const requests = cids.flatMap(cid=>[h.m._restoreInstalledGroupOnDemand(cid),h.m._restoreInstalledGroupOnDemand(cid)]);
  const settled = Promise.allSettled(requests);await started;
  for(const cid of cids){const ch=h.m.client.activeChannels[cid];ch.state.members[h.user]={...ch.state.members[h.user]};}
  if(changed)h.m.client.activeChannels[cids.at(-1)].state.members[h.user].created_at='2026-11-02T00:00:00Z';
  release();const results=await settled;await h.m._subscribedReadyRevalidation;
  assert.equal(results.filter(r=>r.status==='rejected').length,changed?2:0);
  assert.equal(reads,changed?7:8);assert.equal(peakReads,1,'shared provider serializes the native-read ownership turn');
  for(const cid of cids.slice(0,changed?-1:undefined))assert.equal(h.m.getE2eeState(cid)?.state,'ready');
  if(changed){assert.equal(h.m.groups.has(cids.at(-1)),false);assert.notEqual(h.m.getE2eeState(cids.at(-1))?.state,'ready');}
  assert.equal(syncs,0);
 } finally { release();subs.forEach(s=>s.unsubscribe());await h.close(); }
});

test('a channel open without RAM marker reads only its own installed scope and waits for actual delivery', async () => {
 const h = await fixture('ready');let enumerations=0,restores=0,syncs=0;
 try {
  h.group.free();h.m.groups.clear();h.m._groupGenerations.clear();h.m._commonStates.clear();h.m._hotReadyScopes.length=0;
  h.s.listGroupCids=async()=>{enumerations++;throw Error('channel open enumerated all groups');};
  h.m._restoreGroupsLocally=async()=>{restores++;throw Error('channel open entered global restore');};
  h.m.e2eeClient.scopeSync=async()=>{syncs++;throw Error('unexpected channel-open HTTP');};
  const pending=await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'batch_finalization',batchSyncOnly:true,initialScopeSyncCompleted:true});
  assert.equal(h.m.getEpoch(h.cid),0);assert.equal(pending.status,'needs_retry','native load alone cannot fabricate completed delivery');
  const cursor={created_at:'2026-11-01T00:00:00.000Z',event_id:'00000000-0000-0000-0000-000000000001'};
  await h.s.saveScopeSyncCursor(h.cid,cursor);h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));
  assert.equal((await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'})).status,'ready');
  assert.equal(enumerations,0);assert.equal(restores,0);assert.equal(syncs,0);
 } finally { await h.close(); }
});

test('targeted historical marker restoration keeps cleanup and send guards without global restore', async () => {
 const h=await fixture('ready');
 try {
  h.group.free();h.m.groups.clear();h.m._groupGenerations.clear();h.m._commonStates.clear();h.m._hotReadyScopes.length=0;
  await h.s.saveGroupState(h.cid,{...h.marker,status:'historical'});
  h.m._restoreGroupsLocally=async()=>assert.fail('global restore entered');
  h.m.e2eeClient.scopeSync=async()=>assert.fail('historical group synced by native read');
  // Learning this persisted cleanup fence retires the old admission. A fresh
  // owner then reports the historical block without repeatedly replacing it.
  await assert.rejects(h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'batch_finalization',batchSyncOnly:true}),{code:'recovery_scope_changed'});
  const cleanup=h.m._mlsCleanupRevisions.get(h.cid);
  const result=await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'batch_finalization',batchSyncOnly:true});
  assert.equal(result.status,'needs_retry');assert.equal(h.m._groupGenerations.get(h.cid).status,'historical');
  assert.equal(h.m._mlsCleanupRevisions.get(h.cid),cleanup);
  assert.ok(h.m._mlsCleanupRevisions.get(h.cid));assert.equal(h.m.groups.has(h.cid),false);
  assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');
 } finally { await h.close(); }
});

for (const changed of ['marker','membership']) test('lazy native load cannot inherit completed delivery after changed ' + changed, async () => {
 const h = await fixture('ready');
 try {
  const cursor = {created_at:'2026-11-01T00:00:00.000Z',event_id:'00000000-0000-0000-0000-000000000001'};
  h.group.free(); h.m.groups.delete(h.cid); h.m._commonStates.clear(); h.m._hotReadyScopes.length = 0;
  h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));
  assert.ok(h.m._getCompletedSyncProgress(h.cid));
  if (changed === 'marker') await h.s.saveGroupState(h.cid,{...h.marker,current_epoch:1});
  else h.m.client.activeChannels[h.cid].state.members[h.user].created_at = '2026-11-02T00:00:00Z';
  await h.m._restoreInstalledGroupOnDemand(h.cid);
  assert.equal(h.m._getCompletedSyncProgress(h.cid),null);
  assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');
 } finally { await h.close(); }
});

for (const change of ['foreign_provider','banned','generation','cleanup','uncertain']) test('semantic delivery binding still fences ' + change, async () => {
 const h = await fixture('ready'); let oldProvider;
 try {
  const cursor = {created_at:'2026-11-01T00:00:00.000Z',event_id:'00000000-0000-0000-0000-000000000001'};
  h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));
  assert.ok(h.m._getCompletedSyncProgress(h.cid));
  if (change === 'foreign_provider') { oldProvider = h.m._activeProvider; h.m.provider = wasm.Provider.from_bytes(oldProvider.to_bytes()); }
  if (change === 'banned') h.m.client.activeChannels[h.cid].state.members[h.user].banned = true;
  if (change === 'generation') h.m._groupGenerations.set(h.cid,{...h.marker,group_generation:1,group_id:Uint8Array.of(1)});
  if (change === 'cleanup') h.m._mlsCleanupRevisions.set(h.cid,{});
  if (change === 'uncertain') h.m._providerPersistenceUncertain = true;
  assert.equal(h.m._getCompletedSyncProgress(h.cid),null);
 } finally { oldProvider?.free(); await h.close(); }
});

test('open resolves on its actual scope proof before unrelated cold-start work completes',async()=>{
 const h=await fixture('ready');let finishCold,opened=false,timer,work;
 const cold=new Promise(done=>{finishCold=done});h.m.client._getPendingHydratedColdStartSync=()=>cold;h.m.client._waitForHydratedColdStartSync=()=>cold;
 try{
  work=h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'});work.then(()=>{opened=true},()=>{});
  await new Promise(setImmediate);
  const cursor={created_at:'2026-11-01T00:00:00Z',event_id:'00000000-0000-0000-0000-000000000001'};
  await h.s.saveScopeSyncCursor(h.cid,cursor);h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));
  const proved=await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'batch_finalization',batchSyncOnly:true,initialScopeSyncCompleted:true});
  assert.equal(proved.status,'ready');h.m._finishForegroundReadiness(h.cid,proved);
  const result=await Promise.race([work,new Promise(done=>{timer=setTimeout(()=>done(null),1000)})]);
  assert.equal(result?.status,'ready','a proved active scope must not wait for independent session work');assert.equal(opened,true);
 }finally{clearTimeout(timer);finishCold();if(work)await work.catch(()=>{});await h.close();}
});
test('pre-batch foreground demand does not create a point sync for an inventory scope',async()=>{
 const h=await fixture('ready');let calls=0;try{
  const pending=h.m._queueForegroundReadiness(h.cid);pending.catch(()=>{});
  h.m.e2eeClient.scopeSync=async()=>{calls++;throw Error('unexpected point sync');};
  const result=await h.m._drainForegroundReadiness(2,new Set([h.cid]));
  assert.deepEqual(result,[]);assert.equal(calls,0);assert.equal(h.m._foregroundReadiness.has(h.cid),true);
 }finally{await h.close();}
});
test('cold-start settlement without completed scope delivery stays blocked without point HTTP',async()=>{
 const h=await fixture('ready');let finishCold,work,requests=0;
 const cold=new Promise(done=>{finishCold=done});h.m.client._getPendingHydratedColdStartSync=()=>cold;h.m.client._waitForHydratedColdStartSync=()=>cold;
 try{
  h.m.e2eeClient.scopeSync=async()=>{requests++;throw Error('unexpected point sync');};
  work=h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'});work.catch(()=>{});await new Promise(setImmediate);finishCold();
  const result=await work;assert.notEqual(result.status,'ready');assert.equal(requests,0);
 }finally{finishCold();if(work)await work.catch(()=>{});await h.close();}
});

test('a cold-start foreground ticket cannot publish into a replacement client',async()=>{
 const h=await fixture('ready');let finishCold,work,requests=0;
 const cold=new Promise(done=>{finishCold=done});h.m.client._getPendingHydratedColdStartSync=()=>cold;h.m.client._waitForHydratedColdStartSync=()=>cold;
 try{
  h.m.e2eeClient.scopeSync=async()=>{requests++;throw Error('unexpected point sync');};
  work=h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'});const rejected=assert.rejects(work,{code:'recovery_scope_changed'});
  await new Promise(setImmediate);h.m.client={...h.m.client};finishCold();await rejected;
  assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');assert.equal(requests,0);
 }finally{finishCold();if(work)await work.catch(()=>{});await h.close();}
});

test('cold start beginning during control hydration still releases open at its own proved scope',async()=>{
 const h=await fixture('ready');let finishCold,work,timer,live=false;
 const cold=new Promise(done=>{finishCold=done});h.m.client._getPendingHydratedColdStartSync=()=>live?cold:null;h.m.client._waitForHydratedColdStartSync=()=>live?cold:Promise.resolve();
 try{
  const load=h.m._loadRecoveryControl.bind(h.m);let first=true;
  h.m._loadRecoveryControl=async(...args)=>{await load(...args);if(first){first=false;live=true;}};
  work=h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'});work.catch(()=>{});await new Promise(setImmediate);
  const cursor={created_at:'2026-11-01T00:00:00Z',event_id:'00000000-0000-0000-0000-000000000001'};
  await h.s.saveScopeSyncCursor(h.cid,cursor);h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));
  const result=await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'batch_finalization',batchSyncOnly:true,initialScopeSyncCompleted:true});
  assert.equal(result.status,'ready');h.m._finishForegroundReadiness(h.cid,result);
  const opened=await Promise.race([work,new Promise(done=>{timer=setTimeout(()=>done(null),1000)})]);assert.equal(opened?.status,'ready');
 }finally{clearTimeout(timer);finishCold();if(work)await work.catch(()=>{});await h.close();}
});

for (const delivered of [false, true]) {
 test('foreground open loads its own dormant group during cold startup, delivered=' + delivered, async () => {
  const h = await fixture('ready');
  let finishCold, work, timer, loaded, loads = 0, requests = 0, settled = false;
  const cold = new Promise(resolve => { finishCold = resolve; });
  const materialized = new Promise(resolve => { loaded = resolve; });
  h.m.client._getPendingHydratedColdStartSync = () => cold;
  try {
   const cursor = {created_at:'2026-11-01T00:00:00Z',event_id:'00000000-0000-0000-0000-000000000001'};
   if (delivered) {
    await h.s.saveScopeSyncCursor(h.cid, cursor);
    h.m._emitSyncState(h.m._makeSyncState(h.cid, 'ready', cursor, cursor));
   }
   h.group.free();
   h.m.groups.delete(h.cid);
   h.m._commonStates.clear();
   h.m._hotReadyScopes.length = 0;
   const restore = h.m._restoreInstalledGroupOnDemand.bind(h.m);
   h.m._restoreInstalledGroupOnDemand = async cid => {
    assert.equal(cid, h.cid);
    loads++;
    await restore(cid);
    loaded(true);
   };
   h.m.e2eeClient.scopeSync = async () => { requests++; assert.fail('open must share the session transport'); };
   work = h.m.ensureChannelReady('team', h.cid.slice(5), h.cid, {source:'open'});
   work.then(() => { settled = true; }, () => {});
   const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); });
   assert.equal(await Promise.race([materialized, deadline]), true, 'materialization must start before the session settles');
   assert.equal(h.m.getEpoch(h.cid), 0);
   if (delivered) {
    assert.equal((await Promise.race([work, deadline]))?.status, 'ready');
    assert.equal(h.m.getE2eeState(h.cid)?.state, 'ready');
   } else {
    assert.equal(settled, false, 'loading the local group is insufficient to resolve the open');
   }
   assert.equal(loads, 1);
   assert.equal(requests, 0);
  } finally {
   clearTimeout(timer);
   finishCold();
   await work?.catch(() => {});
   await h.close();
  }
 });
}
