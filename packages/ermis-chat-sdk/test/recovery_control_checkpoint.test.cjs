const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{webcrypto}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {EncryptionManager,IndexedDBEncryptionStorage,sha256Hex,selectRecoveryControl,recoveryControlFromState}=require('../dist/encryption/index.cjs');
let sequence=0,wasmPromise;
async function fixture() {
  const wasm=await(wasmPromise??=(async()=>{const w=await import(pathToFileURL(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm.js')));
    await w.default({module_or_path:fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))});return w;})());
  const user=`control-user-${++sequence}`,device='control-device',cid=`team:control-${sequence}`,events=[];
  const storage=new IndexedDBEncryptionStorage(user);
  async function manager(){const m=new EncryptionManager();Object.assign(m,{storage,userId:user,deviceId:device,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm')))});
    await m._initWasm();await m._initIdentity();await m._persistProviderStrict();m.initialized=true;
    m.client={activeChannels:{[cid]:{id:cid.slice(5),type:'team',data:{mls_enabled:true},state:{membership:{channel_role:'member'}}}},
      dispatchEvent:event=>events.push(event)};return m;}
  const m=await manager(),scope={cid,user_id:user,device_id:device,signing_identity_sha256:sha256Hex(m.identity.signature_public_key())};
  const state=(revision='1',action='manual_intervention_required',generation=0)=>({group_generation:generation,group_id:null,current_epoch:0,
    membership_version:'1',state:'repairing',reason:'group_info_invalid',retryable:true,incident_deadline_at:'2026-10-08T00:00:00Z',
    incident_id:'00000000-0000-4000-8000-000000000001',recovery_action:action,recovery_revision:revision,
    repair_retry_until:'2026-10-09T23:50:00Z',capability:{protocol_version:1,automatic_enabled:false,repair_timeout_seconds:900,
      max_group_info_bytes:1048576,max_ratchet_tree_bytes:6291456,max_welcome_recipients:200,max_welcome_bytes:6291456}});
  return {m,manager,scope,user,device,cid,storage,wasm,state,events};
}

test('decimal-u64 monotonic control rejects mixed/unknown fields, conflicting revision and malformed persisted scope',async()=>{
  const f=await fixture(),base=recoveryControlFromState(f.state('9007199254740993'),f.scope);
  assert.equal(base.recovery_revision,'9007199254740993');
  assert.equal(selectRecoveryControl(base,{...base,recovery_revision:'9007199254740992'}),base);
  assert.equal(selectRecoveryControl(base,{...base,recovery_revision:'9007199254740994'}).recovery_revision,'9007199254740994');
  assert.throws(()=>selectRecoveryControl(base,{...base,recovery_action:'repair'}),e=>e.code==='recovery_revision_conflict');
  for(const invalid of ['01','-1','18446744073709551616',42,'1e3'])assert.throws(()=>recoveryControlFromState({...f.state(),recovery_revision:invalid},f.scope));
  assert.throws(()=>recoveryControlFromState({...f.state(),incident_id:undefined},f.scope));
  assert.throws(()=>recoveryControlFromState({...f.state(),recovery_action:'unknown'},f.scope));
  assert.equal(recoveryControlFromState({group_generation:0},f.scope),null);
  await f.storage.close();
});

test('real IndexedDB concurrent/stale CAS cannot overwrite a terminal snapshot or persist a foreign account',async()=>{
  const f=await fixture(),high=recoveryControlFromState(f.state('3'),f.scope),low=recoveryControlFromState(f.state('2','repair'),f.scope);
  await Promise.all([f.storage.saveRecoveryControlCheckpoint(high),f.storage.saveRecoveryControlCheckpoint(low)]);
  assert.deepEqual(await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device),high);
  await assert.rejects(f.storage.saveRecoveryControlCheckpoint({...high,recovery_action:'repair'}),e=>e.code==='recovery_revision_conflict');
  await assert.rejects(f.storage.saveRecoveryControlCheckpoint({...high,user_id:'another-account'}),/account mismatch/);
  assert.deepEqual(await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device),high);
  await f.storage.close();
});

test('manual snapshot persists before callback, dedupes, suppresses retries/bootstrap/new candidate and survives restart',async()=>{
  const f=await fixture(),before=sha256Hex(f.m.provider.to_bytes());let reads=0;
  f.m.e2eeClient={getExternalJoinReceipt:async()=>{reads++;throw Error('no job');},getGroupInfo:async()=>{reads++;throw Error('must suppress');}};
  f.m._generationRecoveryRetries.set(f.cid,{retryAt:Date.now()+1000});
  let callbackDurable;
  f.m.client.dispatchEvent=event=>{f.events.push(event);callbackDurable=f.storage.loadRecoveryControlCheckpoint(f.cid,f.device);};
  const result=await f.m.recoverMlsGeneration('team',f.cid.slice(5),f.cid,f.state());
  assert.equal(result.status,'manual_intervention_required');assert.equal(result.retryable,false);assert.equal(result.retry_at,undefined);
  assert.equal((await callbackDurable).recovery_action,'manual_intervention_required');assert.equal(f.events.length,1);
  await f.m.recoverMlsGeneration('team',f.cid.slice(5),f.cid,f.state());assert.equal(f.events.length,1);
  assert.equal(f.m._generationRecoveryRetries.has(f.cid),false);
  await assert.rejects(f.m.joinExternal('team',f.cid.slice(5),f.cid),e=>e.code==='manual_intervention_required');assert.equal(reads,0);
  assert.equal(sha256Hex(f.m.provider.to_bytes()),before);
  const restarted=await f.manager();await restarted._restoreGroupsLocally();
  assert.equal(restarted.getRecoveryControlSnapshot(f.cid).recovery_action,'manual_intervention_required');
  await f.storage.close();
});

test('new authoritative reopen replaces memoized pending result and uses effective window; late manual/revision cannot undo it',async()=>{
  const f=await fixture();f.m._generationRecoveryNow=()=>Date.parse('2026-10-09T23:40:00Z');f.m.e2eeClient={};await f.m._applyRecoveryControl(f.cid,f.state());
  f.m._generationRecoveryPending.set(f.cid,{cid:f.cid,generation:0,epoch:0,status:'manual_intervention_required',reason:'repair_timeout_elapsed',retryable:false});
  f.m._generationRecoveryAttempted.add(f.cid);
  const fresh=f.state('2','repair');const results=await f.m.bootstrapKnownE2eeChannels({recoveryDiscoveryStates:{[f.cid]:{
    result:'state',generation:fresh,group_info_refresh:null}}});
  assert.equal(results.results[0].error,'waiting_for_repair');assert.equal(f.m._generationRecoveryPending.get(f.cid).retry_at,fresh.repair_retry_until);
  assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'repair');
  const stale=await f.m.recoverMlsGeneration('team',f.cid.slice(5),f.cid,f.state());
  assert.equal(stale.status,'waiting_for_repair');assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_revision,'2');
  if(f.m._generationRecoveryRetryTimer)clearTimeout(f.m._generationRecoveryRetryTimer);
  await f.storage.close();
});

test('manual authority never becomes Ready from a server-only upload/empty request and never deletes an already usable group',async()=>{
  const f=await fixture(),group=f.wasm.Group.create_with_cid(f.m.provider,f.m.identity,f.cid);
  f.m.groups.set(f.cid,group);f.m._groupGenerations.set(f.cid,{cid:f.cid,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1});
  await f.m._writeMlsMutation(f.cid,null);f.m.e2eeClient={};await f.m._applyRecoveryControl(f.cid,f.state());
  const result=await f.m.recoverMlsGeneration('team',f.cid.slice(5),f.cid,f.state());assert.equal(result.status,'manual_intervention_required');
  const count=f.events.length;f.m._emitGroupInfoRepairState({cid:f.cid,status:'ready'});assert.equal(f.events.length,count);
  const open=await f.m.syncNewChannel('team',f.cid.slice(5),f.cid);
  assert.equal(open.status,'needs_retry');assert.equal(open.error,'manual_intervention_required');
  const cursor={created_at:0,id:''};
  f.m._emitSyncState(f.m._makeSyncState(f.cid,'ready',cursor,cursor));
  assert.equal(f.m.getSyncState(f.cid).status,'needs_retry');
  assert.equal(f.m.getSyncState(f.cid).error,'manual_intervention_required');
  assert.equal(f.m._channelReadyUntil.has(f.cid),false);
  assert.equal(f.m.groups.get(f.cid),group);assert.equal(Number(group.epoch()),0);
  const other='team:no-group';f.m._emitGroupInfoRepairState({cid:other,status:'ready'});
  assert.equal(f.events.at(-1).repair_status,'retryable');assert.equal(f.events.at(-1).reason,'local_checkpoint_pending');
  await f.storage.close();
});

test('new control on a legacy storage adapter requires upgrade without an infrastructure retry loop',async()=>{
  const f=await fixture();f.storage.saveRecoveryControlWork=undefined;
  f.m.e2eeClient={discoverMlsRecovery:async()=>({protocol_version:1,capability:f.state().capability,
    states:{[f.cid]:{result:'state',generation:f.state(),group_info_refresh:null}}})};
  const discovery=await f.m._discoverMlsRecoveryStates([f.cid]);
  assert.deepEqual(discovery.states[f.cid],{result:'error',reason:'client_upgrade_required',retryable:false});
  const result=await f.m.recoverMlsGeneration('team',f.cid.slice(5),f.cid);
  assert.equal(result.status,'client_upgrade_required');assert.equal(result.retryable,false);assert.equal(result.retry_at,undefined);
  const bootstrap=await f.m.bootstrapKnownE2eeChannels({recoveryDiscoveryStates:discovery.states});
  assert.equal(bootstrap.results[0].status,'failed');assert.equal(bootstrap.results[0].error,'client_upgrade_required');
  assert.equal(f.m._generationRecoveryRetries.has(f.cid),false);assert.equal(f.events.some(e=>e.state==='ready'),false);
  await f.storage.close();
});

test('changed account/signer after HTTP discards response; write/readback failure publishes no recovery callback',async()=>{
  const f=await fixture();let release,enter;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r);
  f.m.e2eeClient={discoverMlsRecovery:async()=>{enter();await gate;return{protocol_version:1,capability:{protocol_version:1},states:{[f.cid]:{result:'state',generation:f.state(),group_info_refresh:null}}};}};
  const work=f.m._discoverMlsRecoveryStates([f.cid]);await entered;f.m.userId='different-user';release();
  await assert.rejects(work,e=>e.code==='recovery_scope_changed');
  assert.equal(await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device),null);assert.equal(f.events.length,0);f.m.userId=f.user;
  const save=f.storage.saveRecoveryControlWork.bind(f.storage);f.storage.saveRecoveryControlWork=async()=>{throw Error('quota');};
  await assert.rejects(f.m._applyRecoveryControl(f.cid,f.state()),/quota/);assert.equal(f.events.some(e=>e.state==='manual_intervention_required'),false);
  f.storage.saveRecoveryControlWork=async(...args)=>{await save(...args);throw Object.assign(Error('committed proof unavailable'),{code:'recovery_checkpoint_uncertain'});};
  await assert.rejects(f.m._applyRecoveryControl(f.cid,f.state()),e=>e.code==='recovery_checkpoint_uncertain');assert.equal(f.events.some(e=>e.state==='manual_intervention_required'),false);
  f.storage.saveRecoveryControlWork=save;await f.m._loadRecoveryControl(f.cid);
  assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'manual_intervention_required');
  await f.storage.close();
});
