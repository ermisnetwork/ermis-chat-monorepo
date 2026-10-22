const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{webcrypto}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {RecoveryDiscoveryCoordinator,parseRecoveryChangedHint,EncryptionManager,IndexedDBEncryptionStorage,sha256Hex}=require('../dist/encryption/index.cjs');
const {ErmisChat}=require('../dist/index.cjs');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){let now=1000,id=0;const jobs=new Map();return{now:()=>now,later:(fn,delay)=>{const key=++id;jobs.set(key,{at:now+delay,fn});return key;},cancel:key=>jobs.delete(key),
  async step(ms){now+=ms;for(let i=0;i<20;i++){let ready=false;for(const [key,j] of [...jobs])if(j.at<=now){jobs.delete(key);j.fn();ready=true;}await flush();if(!ready && ![...jobs.values()].some(j=>j.at<=now))break;}},pending:()=>jobs.size};}
const result=cids=>({states:Object.fromEntries(cids.map(cid=>[cid,{cid}])),unsupported:false});
const uuid='00000000-0000-4000-8000-000000000001';
const hint=(cid,revision='1',generation=0)=>({type:'mls.recovery.changed',cid,data:{version:1,event_id:uuid,group_generation:generation,incident_id:uuid,recovery_revision:revision}});

test('hint metadata rejects unknown version, malformed scope/UUID/u64 and retains precision above 2^53',()=>{
  assert.equal(parseRecoveryChangedHint(hint('team:test','9007199254740993')).data.recovery_revision,'9007199254740993');
  for(const value of [null,{},hint('x'),hint('team:\n'),hint('team:'+ 'x'.repeat(513)),hint('team:x','01'),hint('team:x','18446744073709551616'),
    hint('team:x','1',-1),{...hint('team:x'),data:{...hint('team:x').data,version:2}},{...hint('team:x'),data:{...hint('team:x').data,event_id:'bad'}}])assert.equal(parseRecoveryChangedHint(value),null);
});

test('450 direct CIDs share one serialized discovery lane with 200 body bound and same-CID in-flight sharing',async()=>{
  const c=clock(),calls=[];let release,first=true;
  const coordinator=new RecoveryDiscoveryCoordinator(async cids=>{calls.push(cids);if(first){first=false;await new Promise(r=>release=r);}return result(cids);},c.now,c.later,c.cancel);
  const cids=Array.from({length:450},(_,i)=>`team:${i}`),work=coordinator.request(cids);await c.step(0);
  assert.equal(calls.length,1);const same=coordinator.request([cids[0]]);const extra=coordinator.request(['team:extra']);await c.step(0);assert.equal(calls.length,1);
  release();await c.step(0);assert.equal(Object.keys((await work).states).length,450);assert.equal((await same).states[cids[0]].cid,cids[0]);assert.ok((await extra).states['team:extra']);
  assert.equal(calls.length,3);assert.ok(calls.every(batch=>batch.length<=200));assert.equal(calls.flat().filter(cid=>cid===cids[0]).length,1);coordinator.stop();
});

test('250ms duplicate coalescing, one dirty follow-up and 30s continuation cannot start a third same-CID request in one wake',async()=>{
  const c=clock(),calls=[],releases=[];
  const coordinator=new RecoveryDiscoveryCoordinator(async cids=>{calls.push(cids);await new Promise(r=>releases.push(r));return result(cids);},c.now,c.later,c.cancel);
  coordinator.invalidate(['team:a']);coordinator.invalidate(['team:a']);await c.step(249);assert.equal(calls.length,0);await c.step(1);assert.equal(calls.length,1);
  for(let i=0;i<100;i++)coordinator.invalidate(['team:a']);releases.shift()();await c.step(0);assert.equal(calls.length,2);
  coordinator.invalidate(['team:a']);releases.shift()();await c.step(0);assert.equal(calls.length,2);await c.step(29_999);assert.equal(calls.length,2);
  await c.step(1);assert.equal(calls.length,3);releases.shift()();await c.step(0);coordinator.stop();assert.equal(c.pending(),0);
});

test('scope teardown rejects queued/in-flight waiters, suppresses late completion and permits a fresh coordinator after transport failure',async()=>{
  const c=clock();let release;const stopped=new RecoveryDiscoveryCoordinator(async cids=>{await new Promise(r=>release=r);return result(cids);},c.now,c.later,c.cancel);
  const a=stopped.request(['team:a']);await c.step(0);const b=stopped.request(['team:b']);stopped.stop();
  await assert.rejects(a,e=>e.code==='recovery_scope_changed');await assert.rejects(b,e=>e.code==='recovery_scope_changed');release();await c.step(0);assert.equal(c.pending(),0);
  let attempts=0;const fresh=new RecoveryDiscoveryCoordinator(async cids=>{if(++attempts===1)throw Error('transport');return result(cids);},c.now,c.later,c.cancel);
  const failure=fresh.request(['team:a']),rejected=assert.rejects(failure,/transport/);await c.step(0);await rejected;const retry=fresh.request(['team:a']);await c.step(0);assert.ok((await retry).states['team:a']);fresh.stop();
});

let wasmPromise,sequence=0;
async function fixture(){
  const wasm=await(wasmPromise??=(async()=>{const w=await import(pathToFileURL(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm.js')));await w.default({module_or_path:fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))});return w;})());
  const user=`discovery-user-${++sequence}`,device='device',cid=`team:${sequence}`,events=[],storage=new IndexedDBEncryptionStorage(user),m=new EncryptionManager();
  Object.assign(m,{userId:user,deviceId:device,storage,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm')))});await m._initWasm();await m._initIdentity();await m._persistProviderStrict();m.initialized=true;
  m.client={activeChannels:{[cid]:{id:cid.slice(5),type:'team',data:{mls_enabled:true},state:{membership:{channel_role:'member'}}}},dispatchEvent:event=>events.push(event)};
  const state=(revision='1',action='manual_intervention_required',generation=0)=>({group_generation:generation,group_id:null,current_epoch:0,membership_version:'1',state:'repairing',reason:'group_info_invalid',retryable:true,
    incident_deadline_at:'2026-10-08T00:00:00Z',incident_id:uuid,recovery_action:action,recovery_revision:revision,repair_retry_until:'2026-10-09T23:50:00Z'});
  const response=state=>({protocol_version:1,capability:{protocol_version:1},states:{[cid]:{result:'state',generation:state,group_info_refresh:null}}});
  return {m,wasm,user,device,cid,events,storage,state,response,async close(){m._recoveryDiscoveryCoordinator?.stop();await storage.close();}};
}

test('actual WASM/IndexedDB applies discovery after readback, not hint action; old generation/revision and duplicates cannot mutate provider or cursor',async()=>{
  const f=await fixture(),c=clock();let calls=0;
  f.m.e2eeClient={discoverMlsRecovery:async()=>{calls++;return f.response(f.state('9007199254740993'));}};
  const coordinator=f.m._getRecoveryDiscoveryCoordinator();coordinator.now=c.now;coordinator.later=c.later;coordinator.cancel=c.cancel;coordinator.arm=()=>{};
  const before=sha256Hex(f.m.provider.to_bytes());
  await f.m.handleMlsRecoveryChanged({...hint(f.cid,'9007199254740993'),data:{...hint(f.cid,'9007199254740993').data,action:'ready'}});
  const deferred=await coordinator.request([f.cid]);assert.equal(deferred.states[f.cid].reason,'state_unavailable');assert.equal(f.m.getRecoveryControlSnapshot(f.cid),null);assert.equal(f.events.length,0);assert.equal(calls,0);
  await c.step(250);await coordinator.resume();
  assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'manual_intervention_required');assert.equal((await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device)).recovery_revision,'9007199254740993');
  assert.equal(f.events.at(-1).state,'manual_intervention_required');assert.equal(sha256Hex(f.m.provider.to_bytes()),before);
  await f.m.handleMlsRecoveryChanged(hint(f.cid,'9007199254740993'));await f.m.handleMlsRecoveryChanged(hint(f.cid,'9007199254740992')); await c.step(1000);assert.equal(calls,1);
  f.m._groupGenerations.set(f.cid,{cid:f.cid,group_generation:2,group_id:new Uint8Array([1]),current_epoch:0,status:'active',updated_at:1});
  await f.m.handleMlsRecoveryChanged(hint(f.cid,'9007199254740994',1));await c.step(1000);assert.equal(calls,1);assert.equal(f.events.some(e=>e.state==='ready'),false);await f.close();
});

test('lost hints reconcile on reconnect; concurrent discoveries share transport and scope switch discards late response before storage',async()=>{
  const f=await fixture();let calls=0,release;
  f.m.e2eeClient={discoverMlsRecovery:async()=>{calls++;await new Promise(r=>release=r);return f.response(f.state('2','repair'));}};
  const a=f.m.reconcileMlsRecovery(),b=f.m._discoverMlsRecoveryStates([f.cid]);for(let i=0;i<100&&!release;i++)await flush();assert.equal(calls,1);
  release();await Promise.all([a,b]);assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'repair');
  const work=f.m._discoverMlsRecoveryStates([f.cid]);for(let i=0;i<100&&calls<2;i++)await flush();f.m.deviceId='different';release();await assert.rejects(work,e=>e.code==='recovery_scope_changed');
  assert.equal((await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device)).recovery_revision,'2');await f.close();
});

test('client dispatcher forwards only invalidation and routes connection recovery to discovery',async()=>{
  const calls=[],mock={handleMlsRecoveryChanged:e=>calls.push(['hint',e]),reconcileMlsRecovery:async()=>calls.push(['discover']),resumePendingE2eeSends:async()=>{}};
  const client=ErmisChat.prototype;assert.equal(typeof client._handleClientEvent,'function');
  const target={_isMlsRemovalClientEvent:client._isMlsRemovalClientEvent,encryptionManager:mock,activeChannels:{},logger:()=>{},_resumePendingStandardAttachmentUploads:async()=>{},_abortPendingAttachmentUploads:()=>{}};
  client._handleClientEvent.call(target,hint('team:wire'));client._handleClientEvent.call(target,{type:'connection.changed',online:true});client._handleClientEvent.call(target,{type:'connection.recovered'});
  await flush();assert.equal(calls.filter(c=>c[0]==='hint').length,1);assert.equal(calls.filter(c=>c[0]==='discover').length,2);
});


test('a delayed discovery cannot write through a replacement storage adapter, even with unchanged account/device/signer',async()=>{
  const f=await fixture();let release;
  f.m.e2eeClient={discoverMlsRecovery:async()=>{await new Promise(r=>release=r);return f.response(f.state());}};
  const work=f.m._discoverMlsRecoveryStates([f.cid]);for(let i=0;i<100&&!release;i++)await flush();
  const replacement=new IndexedDBEncryptionStorage(f.user+'-replacement');f.m.storage=replacement;release();
  await assert.rejects(work,e=>e.code==='recovery_scope_changed');assert.equal(await replacement.loadRecoveryControlCheckpoint(f.cid,f.device),null);
  assert.equal(await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device),null);assert.equal(f.events.length,0);await replacement.close();await f.close();
});


const capability = automatic_enabled => ({protocol_version:1,automatic_enabled,repair_timeout_seconds:900,max_group_info_bytes:1048576,max_ratchet_tree_bytes:1048576,max_welcome_recipients:200,max_welcome_bytes:6291456});
for(const [defaultOn,scoped] of [[false,true],[true,false],[true,undefined]])test(`discovery retains scoped policy ${scoped} over batch ${defaultOn} with legacy fallback`,async()=>{
 const f=await fixture(),other=f.cid+'-control',global=capability(defaultOn),override=scoped===undefined?undefined:capability(scoped),states={};
 for(const cid of [f.cid,other])states[cid]={result:'state',generation:{...f.state('1','none'),...(cid===f.cid&&override?{capability:override}:{})},group_info_refresh:null};
 f.m.e2eeClient={discoverMlsRecovery:async()=>({protocol_version:1,capability:global,states})};
 const bytes=sha256Hex(f.m.provider.to_bytes()),out=await f.m._discoverMlsRecoveryStatesRaw([f.cid,other]);
 assert.equal(out.states[f.cid].result,'state');assert.equal(out.states[f.cid].generation.capability.automatic_enabled,scoped??defaultOn);
 assert.equal(out.states[other].generation.capability.automatic_enabled,defaultOn);assert.equal(out.states[f.cid].generation.capability.repair_timeout_seconds,900);
 assert.equal((await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device)).recovery_action,'none');assert.equal(sha256Hex(f.m.provider.to_bytes()),bytes);
 global.automatic_enabled=!defaultOn;if(override)override.automatic_enabled=!scoped;
 assert.equal(out.states[f.cid].generation.capability.automatic_enabled,scoped??defaultOn);assert.equal(out.states[other].generation.capability.automatic_enabled,defaultOn);await f.close();
});
for(const malformed of [null,'invalid',{}, {...capability(true),automatic_enabled:'true'}, {...capability(true),repair_timeout_seconds:0}, {...capability(true),protocol_version:2}])test(`invalid scoped discovery capability is fenced before control persistence: ${JSON.stringify(malformed)}`,async()=>{
 const f=await fixture(),other=f.cid+'-control',global=capability(false),states={};
 for(const cid of [f.cid,other])states[cid]={result:'state',generation:{...f.state('2','repair'),...(cid===f.cid?{capability:malformed}:{})},group_info_refresh:null};
 f.m.e2eeClient={discoverMlsRecovery:async()=>({protocol_version:1,capability:global,states})};const bytes=sha256Hex(f.m.provider.to_bytes());
 const out=await f.m._discoverMlsRecoveryStatesRaw([f.cid,other]);assert.equal(out.unsupported,false);assert.equal(out.states[f.cid].result,'error');assert.equal(out.states[f.cid].reason,malformed?.protocol_version===2?'client_upgrade_required':'state_unavailable');
 assert.equal(out.states[other].result,'state');assert.equal(out.states[other].generation.capability.automatic_enabled,false);assert.equal(await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device),null);assert.equal(sha256Hex(f.m.provider.to_bytes()),bytes);await f.close();
});
