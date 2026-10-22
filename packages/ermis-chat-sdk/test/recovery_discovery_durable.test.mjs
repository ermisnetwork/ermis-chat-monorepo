import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import init,* as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager,IndexedDBEncryptionStorage,GroupInfoRepairCoordinator,E2eeClient,sha256Hex}=createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const wasmBytes=fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url));
await init({module_or_path:wasmBytes});let seq=0;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function fixture(){
 const user='discovery-durable-'+(++seq),device='device',cid='team:'+user,s=new IndexedDBEncryptionStorage(user),events=[];
 const m=new EncryptionManager();Object.assign(m,{userId:user,deviceId:device,storage:s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(wasmBytes)});await m._initWasm();await m._initIdentity();
 const group=wasm.Group.create_with_cid(m.provider,m.identity,cid),marker={cid,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1};m.groups.set(cid,group);m._groupGenerations.set(cid,marker);await m._writeMlsMutation(cid,null);
 const channel={data:{mls_enabled:true},state:{members:{[user]:{user_id:user,created_at:'2026-10-11T00:00:00Z'}}}};
 m.client={activeChannels:{[cid]:channel},dispatchEvent:e=>events.push(e)};m.e2eeClient={};m.initialized=true;
 const kp=m.identity.key_package(m.provider),ref=kp.hash_ref(m.provider);kp.free();await m._saveEncryptionSyncCheckpoint();
 return{m,s,user,device,cid,group,marker,channel,events,ref,bytes:m.provider.to_bytes(),base:await s.loadProviderCheckpoint(user,device)};
}


const generation={group_generation:0,group_id:null,current_epoch:0,membership_version:'1',state:'ready',reason:'group_info_missing',retryable:true};
const response=cids=>({protocol_version:1,capability:{protocol_version:1},states:Object.fromEntries(cids.map(cid=>[cid,{result:'state',generation,group_info_refresh:null}]))});
const hint=(cid,revision='1')=>({cid,data:{version:1,event_id:'00000000-0000-4000-8000-000000000001',group_generation:0,incident_id:null,recovery_revision:revision}});
function lane(h,fetch=async cids=>response(cids)){h.m.e2eeClient={discoverMlsRecovery:fetch};const c=h.m._getRecoveryDiscoveryCoordinator();c.arm=()=>{};c.now=()=>h.now??Date.now();return c;}
const primary=(h,cid=h.cid)=>h.s.loadRecoveryDiscoveryWork(h.device,[cid]).then(r=>r[cid]);
const owner=(h,cids=[h.cid])=>h.m._getRecoveryDiscoveryCoordinator().context.captureOwner(cids);
async function preserved(h){assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),h.base);assert.equal(h.m.identity.owns_key_package_ref(h.m._activeProvider,h.ref),true);assert.equal(h.events.some(e=>e.state==='ready'),false);}
test('durable primary/due/lease full readback precedes one discovery POST and successful observation never makes Ready',async()=>{const h=await fixture();let calls=0;const c=lane(h,async cids=>{calls++;const row=await primary(h);assert.equal(row.attempts,1);assert.ok(row.lease_id);assert.equal(row.disposition,'pending');const future=await h.s.listDueRecoveryDiscoveryWork(h.device,row.retry_at,200);assert.equal(future[0].lease_id,row.lease_id);return response(cids);});const result=await c.request([h.cid]);assert.equal(result.states[h.cid].result,'state');assert.equal(calls,1);assert.equal((await primary(h)).disposition,'settled');assert.deepEqual(await h.s.listDueRecoveryDiscoveryWork(h.device,Number.MAX_SAFE_INTEGER,200),[]);await preserved(h);c.stop();});
for(const fault of ['abort','readback','unknown','index-mismatch'])test('intent '+fault+' prevents HTTP and preserves actual private provider',async()=>{const h=await fixture();let calls=0;const c=lane(h,async cids=>{calls++;return response(cids);});const db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false;
 if(fault==='abort')db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
 if(fault==='readback')db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite'){let wroteIntent=false;const store=tx.objectStore('meta'),put=store.put.bind(store);store.put=(value,key)=>{if(String(key).startsWith('mls_discovery:v1:'))wroteIntent=true;return put(value,key);};tx.addEventListener('complete',()=>{if(wroteIntent)committed=true;});}if(args[1]==='readonly'&&committed)queueMicrotask(()=>tx.abort());return tx;};
 if(fault==='unknown'){const save=h.s.saveRecoveryDiscoveryWork.bind(h.s);h.s.saveRecoveryDiscoveryWork=async(...args)=>{await save(...args);throw Error('committed return lost');};}
 if(fault==='index-mismatch')db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite')tx.addEventListener('complete',()=>{const mutation=original('meta','readwrite');const read=mutation.objectStore('meta').openCursor();read.onsuccess=()=>{const cursor=read.result;if(cursor){if(String(cursor.key).startsWith('mls_discovery_due:'))cursor.update({...cursor.value,attempts:3});cursor.continue();}};});return tx;};
 await assert.rejects(c.request([h.cid]));db.transaction=original;assert.equal(calls,0);assert.equal((await primary(h))!==null,fault!=='abort');await preserved(h);c.stop();});
for(const phase of ['reserve','finish'])test('actual '+phase+' RWabort preserves exact durable obligation',async()=>{const h=await fixture();let calls=0;const c=lane(h,async cids=>{calls++;return response(cids);});await c.enqueue([h.cid]);const initial=await primary(h);const save=h.s.saveRecoveryDiscoveryWork.bind(h.s);h.s.saveRecoveryDiscoveryWork=async(...args)=>{const next=args[2][0].next;if(phase==='reserve'?!!next.lease_id:next.disposition==='settled'){const db=await h.s.openDB(),original=db.transaction.bind(db);db.transaction=(...txargs)=>{const tx=original(...txargs);if(txargs[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};try{return await save(...args);}finally{db.transaction=original;}}return save(...args);};await assert.rejects(c.run());const retained=await primary(h);assert.equal(retained.job_id,initial.job_id);assert.equal(calls,phase==='reserve'?0:1);assert.equal(retained.attempts,phase==='reserve'?0:1);assert.equal(retained.disposition,'pending');await preserved(h);c.stop();});
test('three unknown observations retain a deferred budget across restart; timer cannot reset it',async()=>{const h=await fixture();h.now=Date.now();let calls=0;const c=lane(h,async()=>{calls++;throw Error('lost transport');});await c.request([h.cid]);for(let i=0;i<2;i++){h.now+=30001;await c.run();}const saved=await primary(h);assert.equal(calls,3);assert.equal(saved.attempts,3);assert.equal(saved.disposition,'deferred');c.stop();const next=lane(h,async()=>{calls++;throw Error('transport');});await next.resume();assert.equal(calls,3);assert.deepEqual(await primary(h),saved);await next.request([h.cid]);assert.equal(calls,3);assert.deepEqual(await primary(h),saved);await next.invalidate([h.cid],hint(h.cid,'2'));h.now+=251;await next.resume();assert.equal(calls,4);assert.equal((await primary(h)).attempts,1);assert.notEqual((await primary(h)).job_id,saved.job_id);await preserved(h);next.stop();});
test('dirty newer hint held over HTTP survives old finish and lease/restart; duplicates do not extend retry or consume budget',async()=>{const h=await fixture();h.now=Date.now();const entered=latch(),gate=latch();let calls=0;const c=lane(h,async cids=>{calls++;if(calls===1){entered.resolve();await gate.promise;}return response(cids);});const work=c.request([h.cid]);await entered.promise;const original=await primary(h);await c.invalidate([h.cid],hint(h.cid,'2'));const replacement=await primary(h);assert.notEqual(replacement.job_id,original.job_id);await c.invalidate([h.cid],hint(h.cid,'1'));await c.invalidate([h.cid],hint(h.cid,'2'));assert.deepEqual(await primary(h),replacement);gate.resolve();await work;assert.deepEqual(await primary(h),replacement);c.stop();const next=lane(h,async cids=>{calls++;return response(cids);});await next.resume();assert.equal(calls,1);h.now+=30001;await next.resume();assert.equal(calls,2);assert.equal((await primary(h)).hint.data.recovery_revision,'2');assert.equal((await primary(h)).disposition,'settled');await preserved(h);next.stop();});
for(const replacement of ['account','device','storage','signer','artifact','transport','provider','group','marker','pending','membership'])test('delayed '+replacement+' owner cannot clear replacement work',async()=>{const h=await fixture();const entered=latch(),gate=latch();const c=lane(h,async cids=>{entered.resolve();await gate.promise;return response(cids);});const work=c.request([h.cid]);const rejected=assert.rejects(work);await entered.promise;const before=await primary(h);const guard=owner(h);const winning={...before,job_id:crypto.randomUUID(),lease_id:null,attempts:0,retry_at:before.retry_at+1};await h.s.saveRecoveryDiscoveryWork(h.user,h.device,[{cid:h.cid,expected:before,next:winning}],guard.owner,guard.assertOwner);
 if(replacement==='account')h.m.userId='new';if(replacement==='device')h.m.deviceId='new';if(replacement==='storage')h.m.storage=new IndexedDBEncryptionStorage(h.user);if(replacement==='signer')h.m.identity=wasm.Identity.from_bytes(h.m.provider,h.m.identity.to_bytes());if(replacement==='artifact')h.m._wasmArtifactSha256='a'.repeat(64);if(replacement==='transport')h.m.e2eeClient={};if(replacement==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.bytes);if(replacement==='group')h.m.groups.set(h.cid,wasm.Group.load(h.m.provider,h.cid));if(replacement==='marker')h.m._groupGenerations.set(h.cid,{...h.marker,updated_at:2});if(replacement==='pending')h.m._pendingMlsMutations.set(h.cid,{operation_id:'winning'});if(replacement==='membership')h.channel.state.members[h.user]={user_id:h.user,created_at:'2026-10-13T00:00:00Z'};
 gate.resolve();await rejected;assert.deepEqual(await primary(h),winning);assert.equal(h.events.some(e=>e.state==='ready'),false);c.stop();});
test('450 durable CIDs defer overload after two200 batches; remaining50 are retained and a failing front page cannot starve them',async()=>{const h=await fixture();h.now=Date.now();const cids=[h.cid,...Array.from({length:449},(_,i)=>'team:backlog-'+i)],calls=[];const c=lane(h,async batch=>{calls.push(batch);throw Error('transport');});const result=await c.request(cids);assert.equal(calls.length,2);assert.ok(calls.every(r=>r.length===200));assert.equal(Object.keys(result.states).length,450);const all=Object.values(await h.s.loadRecoveryDiscoveryWork(h.device,cids.slice(0,200))).filter(Boolean);assert.equal(all.length,200);const due=await h.s.listDueRecoveryDiscoveryWork(h.device,h.now,200);assert.equal(due.length,50);await c.run();assert.equal(calls.length,3);assert.equal(calls[2].length,50);assert.equal(new Set(calls.flat()).size,450);await preserved(h);c.stop();});
test('cross-tab lease reserves only one observation and stale provider writer cannot adopt current revision',async()=>{const h=await fixture();h.now=Date.now();const entered=latch(),gate=latch();let calls=0;const c=lane(h,async cids=>{calls++;entered.resolve();await gate.promise;return response(cids);});const work=c.request([h.cid]);const rejected=assert.rejects(work);await entered.promise;const row=await primary(h);const guard=owner(h);const peer=new IndexedDBEncryptionStorage(h.user);assert.deepEqual(await peer.listDueRecoveryDiscoveryWork(h.device,h.now,200),[]);const p=wasm.Provider.from_bytes(h.bytes),identity=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=identity.key_package(p);kp.free();await peer.saveProviderState(h.user,h.device,p.to_bytes(),{expected_revision:h.base.revision,next_revision:crypto.randomUUID()});const winner=await peer.loadProviderCheckpoint(h.user,h.device);gate.resolve();await rejected;assert.equal(calls,1);assert.deepEqual(await primary(h),row);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner);identity.free();p.free();c.stop();});
test('durable manual control pauses failed automatic discovery without deleting it or extending deadline',async()=>{const h=await fixture();const ctrl={version:1,user_id:h.user,device_id:h.device,cid:h.cid,signing_identity_sha256:sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:'00000000-0000-4000-8000-000000000001',recovery_action:'manual_intervention_required',recovery_revision:'2',repair_retry_until:'2026-10-12T00:00:00Z'};await h.s.saveRecoveryControlCheckpoint(ctrl);await h.m._loadRecoveryControl(h.cid);let calls=0;const c=lane(h,async()=>{calls++;throw Error('transport');});await c.request([h.cid]);const job=await primary(h);assert.equal(job.disposition,'deferred');assert.equal(job.reason,'manual');await c.resume();assert.equal(calls,1);assert.deepEqual(await h.s.loadRecoveryControlCheckpoint(h.cid,h.device),ctrl);assert.equal(h.m.getE2eeState(h.cid).state,'manual_intervention_required');await preserved(h);c.stop();});
for(const cap of ['recoveryDiscoveryWorkVersion','loadRecoveryDiscoveryWork','listDueRecoveryDiscoveryWork','saveRecoveryDiscoveryWork'])test('missing '+cap+' fails upgrade before HTTP or private mutation',async()=>{const h=await fixture();let calls=0;h.s[cap]=undefined;lane(h,async cids=>{calls++;return response(cids);});const result=await h.m._discoverMlsRecoveryStates([h.cid]);assert.equal(result.states[h.cid].reason,'client_upgrade_required');assert.equal(calls,0);await preserved(h);h.m._recoveryDiscoveryCoordinator.stop();});
test('discovery wire bounds and hidden auth retry are explicit; status never means MLS rejection',async()=>{let observed;const client=new E2eeClient({baseURL:'https://fixture.invalid',deviceId:'device',doAxiosRequest:async(...args)=>{observed=args;return{protocol_version:1,capability:{protocol_version:1},states:{}};}});await client.discoverMlsRecovery(['team:test']);assert.equal(observed[0],'post');assert.equal(observed[3].timeout,5000);assert.equal(observed[3].maxBodyLength,131072);assert.equal(observed[3].maxContentLength,1048576);assert.equal(observed[3].__tokenRefreshAttempted,true);await assert.rejects(client.discoverMlsRecovery(Array.from({length:201},(_,i)=>'team:'+i)));});

test('late due-index scan cannot capture a replacement group/marker after await',async()=>{const h=await fixture();let calls=0;const c=lane(h,async cids=>{calls++;return response(cids);});await c.enqueue([h.cid]);const saved=await primary(h),scan=h.s.listDueRecoveryDiscoveryWork.bind(h.s),entered=latch(),gate=latch();h.s.listDueRecoveryDiscoveryWork=async(...args)=>{const rows=await scan(...args);entered.resolve();await gate.promise;return rows;};const work=c.run(),rejected=assert.rejects(work,e=>e.code==='recovery_scope_changed');await entered.promise;h.m.groups.set(h.cid,wasm.Group.load(h.m.provider,h.cid));gate.resolve();await rejected;assert.equal(calls,0);assert.deepEqual(await primary(h),saved);c.stop();});
for(const phase of ['reserve','finish'])test('unknown committed '+phase+' survives restart with exact budget and no premature publication',async()=>{const h=await fixture();h.now=Date.now();let calls=0;const c=lane(h,async cids=>{calls++;return response(cids);});await c.enqueue([h.cid]);const save=h.s.saveRecoveryDiscoveryWork.bind(h.s);h.s.saveRecoveryDiscoveryWork=async(...args)=>{const result=await save(...args),next=args[2][0].next;if(phase==='reserve'?!!next.lease_id:next.disposition==='settled')throw Error('commit return lost');return result;};await assert.rejects(c.run());const saved=await primary(h);assert.equal(saved.attempts,1);assert.equal(calls,phase==='reserve'?0:1);assert.equal(saved.disposition,phase==='reserve'?'pending':'settled');c.stop();h.s.saveRecoveryDiscoveryWork=save;const restarted=lane(h,async cids=>{calls++;return response(cids);});await restarted.resume();assert.deepEqual(await primary(h),saved);assert.equal(calls,phase==='reserve'?0:1);if(phase==='reserve'){h.now+=30001;await restarted.resume();assert.equal((await primary(h)).attempts,2);}await preserved(h);restarted.stop();});
test('same-account coordinator replacement survives delayed old error/finally and retains work',async()=>{const h=await fixture();const entered=latch(),gate=latch();const first=lane(h,async cids=>{entered.resolve();await gate.promise;return response(cids);});const old=first.request([h.cid]),rejected=assert.rejects(old,e=>e.code==='recovery_scope_changed');await entered.promise;const saved=await primary(h);const replacement=lane(h);assert.notEqual(replacement,first);gate.resolve();await rejected;assert.equal(h.m._recoveryDiscoveryCoordinator,replacement);assert.deepEqual(await primary(h),saved);replacement.stop();});
test('valid maximum CID hint fits bounded durable record without discard',async()=>{const h=await fixture();h.now=Date.now();const cid='team:'+ 'a'.repeat(507),c=lane(h);await c.invalidate([cid],hint(cid,'9007199254740993'));const row=await primary(h,cid);assert.equal(row.hint.data.recovery_revision,'9007199254740993');assert.ok(new TextEncoder().encode(JSON.stringify(row)).length<=2048);assert.equal(row.disposition,'pending');c.stop();});

test('a changed group owner cannot join an older discovery promise even under same account/provider',async()=>{const h=await fixture();const entered=latch(),gate=latch();const c=lane(h,async cids=>{entered.resolve();await gate.promise;return response(cids);});const old=c.request([h.cid]),oldRejected=assert.rejects(old,e=>e.code==='recovery_scope_changed');await entered.promise;const saved=await primary(h);h.m.groups.set(h.cid,wasm.Group.load(h.m.provider,h.cid));await assert.rejects(c.request([h.cid]),e=>e.code==='recovery_scope_changed');gate.resolve();await oldRejected;assert.deepEqual(await primary(h),saved);c.stop();});


test('a real hint equal to authenticated durable control still wakes an observation that never consumed it',async()=>{
 const h=await fixture();h.now=Date.now();let calls=0;
 const c=lane(h,async()=>{calls++;throw Error('lost transport');});
 await c.request([h.cid]);for(let i=0;i<2;i++){h.now+=30001;await c.run();}
 const exhausted=await primary(h);assert.equal(exhausted.attempts,3);
 h.m._recoveryControls.set(h.cid,{group_generation:0,recovery_revision:'2',recovery_action:'none'});
 await h.m.handleMlsRecoveryChanged(hint(h.cid,'2'));h.now+=251;await c.run();
 assert.equal(calls,4);const newer=await primary(h);assert.notEqual(newer.job_id,exhausted.job_id);assert.equal(newer.attempts,1);
 await h.m.handleMlsRecoveryChanged(hint(h.cid,'2'));assert.deepEqual(await primary(h),newer);
 await preserved(h);c.stop();
});

test('a newly authenticated head wakes exhausted discovery after lost hint while reconnect alone preserves the budget',async()=>{
 const h=await fixture();h.now=Date.now();let calls=0,head=null;
 const c=lane(h,async()=>{calls++;throw Error('lost transport');});c.context.observedHead=()=>head;
 await c.request([h.cid]);for(let i=0;i<2;i++){h.now+=30001;await c.run();}
 const exhausted=await primary(h);await c.request([h.cid]);assert.equal(calls,3);assert.deepEqual(await primary(h),exhausted);
 head={group_generation:0,recovery_revision:'2'};await c.request([h.cid]);
 assert.equal(calls,4);const first=await primary(h);assert.notEqual(first.job_id,exhausted.job_id);assert.equal(first.attempts,1);assert.deepEqual(first.observed_head,head);
 await c.request([h.cid]);assert.equal(calls,4);assert.deepEqual(await primary(h),first);
 for(let i=0;i<2;i++){h.now+=30001;await c.run();}assert.equal(calls,6);
 const sameHead=await primary(h);await c.request([h.cid]);assert.equal(calls,6);assert.deepEqual(await primary(h),sameHead);
 c.stop();const restarted=lane(h,async()=>{calls++;throw Error('transport');});restarted.context.observedHead=()=>head;
 await restarted.request([h.cid]);assert.equal(calls,6);assert.deepEqual(await primary(h),sameHead);
 head={group_generation:0,recovery_revision:'1'};await restarted.request([h.cid]);assert.equal(calls,6);
 head={group_generation:0,recovery_revision:'3'};await restarted.request([h.cid]);assert.equal(calls,7);assert.equal((await primary(h)).attempts,1);
 await preserved(h);restarted.stop();
});


const metadata=(cid,revision='2',generation=0)=>({cid,group_generation:generation,group_id:null,epoch:0,
 group_info:{status:'ready',ready:true,epoch:0,last_uploaded_at:null},
 recovery:{action:'none',incident_id:null,revision,repair_retry_until:null}});
test('authenticated channel hydration reconnects the production manager without synthetic recovery events',async()=>{
 const h=await fixture();h.now=Date.now();let calls=0;
 const c=lane(h,async()=>{calls++;throw Error('transport');});
 await c.request([h.cid]);for(let i=0;i<2;i++){h.now+=30001;await c.run();}const exhausted=await primary(h);
 h.m.observeChannelE2ee(metadata(h.cid),false);await c.request([h.cid]);assert.equal(calls,3);assert.deepEqual(await primary(h),exhausted);
 h.m.observeChannelE2ee(metadata(h.cid),true);await c.request([h.cid]);assert.equal(calls,4);
 const observed=await primary(h);assert.equal(observed.hint,null);assert.deepEqual(observed.observed_head,{group_generation:0,recovery_revision:'2'});
 h.m.observeChannelE2ee(metadata(h.cid),true);h.m.observeChannelE2ee(metadata(h.cid,'1'),true);await c.request([h.cid]);
 assert.equal(calls,4);assert.deepEqual(await primary(h),observed);
 await preserved(h);c.stop();
});
test('new authenticated head cannot shorten the reservation held by an in-flight observation',async()=>{
 const h=await fixture();h.now=Date.now();const entered=latch(),gate=latch();let calls=0,head=null;
 const c=lane(h,async cids=>{calls++;if(calls===1){entered.resolve();await gate.promise;}return response(cids);});c.context.observedHead=()=>head;
 const work=c.request([h.cid]);await entered.promise;const inFlight=await primary(h);assert.ok(inFlight.lease_id);
 head={group_generation:0,recovery_revision:'2'};await c.invalidate([h.cid]);const fresh=await primary(h);
 assert.equal(fresh.retry_at,inFlight.retry_at);assert.equal(fresh.attempts,0);assert.notEqual(fresh.job_id,inFlight.job_id);
 gate.resolve();await work;assert.deepEqual(await primary(h),fresh);await c.resume();assert.equal(calls,1);
 h.now=inFlight.retry_at;await c.resume();assert.equal(calls,2);assert.equal((await primary(h)).attempts,1);await preserved(h);c.stop();
});
test('authenticated head and event hints share one monotonic durable evidence frontier',async()=>{
 const h=await fixture();h.now=Date.now();let calls=0,head={group_generation:0,recovery_revision:'9007199254740993'};
 const c=lane(h,async()=>{calls++;throw Error('transport');});c.context.observedHead=()=>head;
 await c.request([h.cid]);for(let i=0;i<2;i++){h.now+=30001;await c.run();}const saved=await primary(h);
 await c.invalidate([h.cid],hint(h.cid,'9007199254740993'));await c.invalidate([h.cid],hint(h.cid,'2'));await c.request([h.cid]);
 assert.equal(calls,3);assert.deepEqual(await primary(h),saved);
 await c.invalidate([h.cid],hint(h.cid,'9007199254740994'));h.now+=251;await c.resume();assert.equal(calls,4);const event=await primary(h);
 head={group_generation:0,recovery_revision:'9007199254740994'};await c.request([h.cid]);assert.equal(calls,4);assert.deepEqual(await primary(h),event);
 await preserved(h);c.stop();
});
for(const head of [null,{}, {group_generation:-1,recovery_revision:'2'}, {group_generation:0,recovery_revision:'bad'}, {group_generation:0,recovery_revision:'18446744073709551616'}])test('malformed persisted observed head remains corruption before HTTP: '+JSON.stringify(head),async()=>{
 const h=await fixture();let calls=0;const c=lane(h,async cids=>{calls++;return response(cids);});await c.enqueue([h.cid]);const saved=await primary(h),guard=owner(h);
 await assert.rejects(h.s.saveRecoveryDiscoveryWork(h.user,h.device,[{cid:h.cid,expected:saved,next:{...saved,observed_head:head}}],guard.owner,guard.assertOwner),e=>e.code==='storage_corruption');
 assert.deepEqual(await primary(h),saved);assert.equal(calls,0);await preserved(h);c.stop();
});
test('maximum CID plus HTTP head and event hint stay inside the existing version1 byte limit',async()=>{
 const h=await fixture();h.now=Date.now();const cid='team:'+'a'.repeat(507),c=lane(h);c.context.observedHead=()=>({group_generation:0,recovery_revision:'9007199254740993'});
 await c.invalidate([cid],hint(cid,'9007199254740994'));const saved=await primary(h,cid);assert.ok(new TextEncoder().encode(JSON.stringify(saved)).length<=2048);
 assert.equal(saved.observed_head.recovery_revision,'9007199254740993');assert.equal(saved.hint.data.recovery_revision,'9007199254740994');c.stop();
});
