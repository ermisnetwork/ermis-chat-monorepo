import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import init,* as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager,IndexedDBEncryptionStorage,sha256Hex}=createRequire(import.meta.url)('../dist/encryption/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const binary=fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url));await init({module_or_path:binary});let sequence=0;
const latch=()=>{let open;return{promise:new Promise(r=>open=r),open:()=>open()};};
const entry=ref=>({id:'00000000-0000-4000-8000-000000000001',created_at:'2026-10-16T00:00:00Z',key_package_ref:ref});
async function turns(){for(let i=0;i<16;i++)await new Promise(setImmediate);}
async function fixture(){const user='ownership-work-'+ ++sequence,s=new IndexedDBEncryptionStorage(user),managers=[],stores=[s];
 async function open(storage=s){const m=new EncryptionManager();Object.assign(m,{userId:user,deviceId:'device',storage,_wasmArtifactSha256:sha256Hex(binary),client:{baseURL:'http://localhost:55472'}});m._injectedWasm=wasm;await m._initWasm();await m._initIdentity();m.initialized=true;m.e2eeClient={getKeyPackageOwnership:async()=>({version:1,entries:[]}),reconcileKeyPackageOwnership:async()=>({retired:1})};managers.push(m);if(!stores.includes(storage))stores.push(storage);return m;}
 const m=await open();const group=wasm.Group.create_with_cid(m.provider,m.identity,'team:'+user),marker={cid:'team:'+user,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1};m.groups.set(marker.cid,group);m._groupGenerations.set(marker.cid,marker);await s.saveGroupState(marker.cid,marker);await m._persistProviderStrict();const kp=m.identity.key_package(m.provider),ref=kp.hash_ref(m.provider);kp.free();await m._persistProviderStrict();
 return{m,s,user,ref,open,close:async()=>{for(const manager of managers)manager.destroy();for(const storage of stores)await storage.close();}};
}

function scheduler(m) {
  const real=Date.now; let now=real(),seq=0; const timers=new Map(); Date.now=()=>now;
  m._ownershipSetTimeout=(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id;};
  m._ownershipClearTimeout=id=>timers.delete(id);
  return {timers,get now(){return now;},advance:async ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await turns();},restore:()=>{Date.now=real;}};
}
const rowAt=n=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,created_at:'2026-10-18T00:00:00Z',key_package_ref:Uint8Array.from({length:32},(_,i)=>(n>>(i%4)*8)&255)});
test('401 actual native probes continue beyond three pages without another event and retain per-invocation bounds',async()=>{
 const f=await fixture(),time=scheduler(f.m);try{const rows=Array.from({length:401},(_,i)=>rowAt(i+1));let gets=0,posts=0,total=0;
 f.m.e2eeClient={getKeyPackageOwnership:async cursor=>{gets++;const start=cursor?rows.findIndex(r=>r.id===cursor.id)+1:0;const entries=rows.slice(start,start+100);return{version:1,entries,next_cursor:start+100<rows.length?{id:entries.at(-1).id,created_at:entries.at(-1).created_at}:null};},reconcileKeyPackageOwnership:async missing=>{posts++;total+=missing.length;return{retired:missing.length};}};
 await f.m.reconcileKeyPackageOwnership();assert.equal(gets,3);assert.equal(posts,3);assert.equal(total,300);
 const cp=await f.s.loadKeyPackageOwnershipCheckpoint(f.user,'device');assert.equal(cp.scan_cursor.id,rows[299].id);
 await time.advance(30000);await f.m._keyPackageOwnershipPromise;assert.equal(gets,5);assert.equal(posts,5);assert.equal(total,401);assert.equal((await f.s.loadKeyPackageOwnershipCheckpoint(f.user,'device')).scan_cursor,null);
 }finally{await f.close();time.restore();}
});
test('future durable retry wakes independently without resetting attempts or retry_at',async()=>{
 const f=await fixture(),time=scheduler(f.m);try{await f.m.reconcileKeyPackageOwnership();let cp=await f.s.loadKeyPackageOwnershipCheckpoint(f.user,'device');
 const due=time.now+60000;cp={...cp,scan_next_retry_at:time.now+240000,scan_attempts:4,retry_queue:[{cursor:null,attempts:3,next_retry_at:due}]};await f.s.saveKeyPackageOwnershipCheckpoint(cp);
 await time.advance(30000);await f.m._keyPackageOwnershipPromise;assert.deepEqual(await f.s.loadKeyPackageOwnershipCheckpoint(f.user,'device'),cp);
 let calls=0;f.m.e2eeClient.getKeyPackageOwnership=async()=>{calls++;return{version:1,entries:[]};};
 await time.advance(30000);await f.m._keyPackageOwnershipPromise;assert.equal(calls,1);const after=await f.s.loadKeyPackageOwnershipCheckpoint(f.user,'device');assert.equal(after.retry_queue.length,0);assert.equal(after.scan_attempts,4);assert.equal(after.scan_next_retry_at,cp.scan_next_retry_at);
 }finally{await f.close();time.restore();}
});
test('hung transport cancels at original operation lease and old success cannot mutate checkpoint',async()=>{
 const f=await fixture(),time=scheduler(f.m),entered=latch(),release=latch();let work;try{let signal,posts=0;
 f.m.e2eeClient.getKeyPackageOwnership=async(_,budget)=>{signal=budget.signal;entered.open();await release.promise;return{version:1,entries:[rowAt(1)]};};f.m.e2eeClient.reconcileKeyPackageOwnership=async()=>{posts++;return{retired:1};};
 work=f.m.reconcileKeyPackageOwnership();await entered.promise;const before=await f.s.loadKeyPackageOwnershipCheckpoint(f.user,'device');await time.advance(30000);await work;assert.equal(signal.aborted,true);release.open();await turns();assert.equal(posts,0);assert.deepEqual(await f.s.loadKeyPackageOwnershipCheckpoint(f.user,'device'),before);
 }finally{release.open();await work?.catch(()=>{});await f.close();time.restore();}
});
test('destroy cancels in-flight work and prevents its finally arming a replacement wake',async()=>{
 const f=await fixture(),time=scheduler(f.m),entered=latch();let work;try{let signal;f.m.e2eeClient.getKeyPackageOwnership=async(_,budget)=>{signal=budget.signal;entered.open();return new Promise(()=>{});};work=f.m.reconcileKeyPackageOwnership();await entered.promise;f.m.destroy();await work;assert.equal(signal.aborted,true);assert.equal(f.m._keyPackageOwnershipWake,null);
 }finally{await f.close();time.restore();}
});
