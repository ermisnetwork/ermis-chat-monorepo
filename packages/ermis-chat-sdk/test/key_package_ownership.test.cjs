const test=require('node:test');
const assert=require('node:assert/strict');
const {EncryptionManager,E2eeClient,IndexedDBEncryptionStorage}=require('../dist/encryption/index.cjs');
const {indexedDB,IDBKeyRange}=require('fake-indexeddb');globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;let fixtureSequence=0;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const entry=n=>({id:id(n),created_at:'2026-10-07T00:00:00.000Z',key_package_ref:Uint8Array.from({length:32},()=>n)});
async function harness(overrides={}) {
 const m=new EncryptionManager();m.userId='user-'+ ++fixtureSequence;m.deviceId='device';m.provider={to_bytes:()=>Uint8Array.of(7)};
 // Use the production composed adapter rather than obsolete point-only mocks.
 m.storage=new IndexedDBEncryptionStorage(m.userId);await m.storage.saveIdentity(m.userId,m.deviceId,Uint8Array.of(9));await m.storage.saveProviderState(m.userId,m.deviceId,Uint8Array.of(7));
 const cp=await m.storage.loadProviderCheckpoint(m.userId,m.deviceId);m._providerDurableBase={storage:m.storage,userId:m.userId,deviceId:m.deviceId,revision:cp.revision};m._wasmArtifactSha256='a'.repeat(64);m.initialized=true;
 const seen={get:0,retire:[]};m.identity={owns_key_package_ref:(_,ref)=>ref[0]===1,to_bytes:()=>Uint8Array.of(9),signature_public_key:()=>new Uint8Array(32)};
 m.e2eeClient={getKeyPackageOwnership:async()=>{seen.get++;return {version:1,entries:[entry(1),entry(2)]};},
 reconcileKeyPackageOwnership:async missing=>{seen.retire.push(missing.map(x=>x.id));return {retired:missing.length};},...overrides};
 return {m,seen};
}
test('concurrent reconcile coalesces and only retires missing private references',async()=>{
 const {m,seen}=await harness();await Promise.all(Array.from({length:100},()=>m.reconcileKeyPackageOwnership()));
 assert.equal(seen.get,1);assert.deepEqual(seen.retire,[[id(2)]]);
 await m.reconcileKeyPackageOwnership();assert.equal(seen.get,1);
});
test('old binding and pending mutation do not authorize retirement',async()=>{
 const {m,seen}=await harness();delete m.identity.owns_key_package_ref;await m.reconcileKeyPackageOwnership();assert.equal(seen.get,0);
 m.identity.owns_key_package_ref=()=>false;m._pendingMlsMutations.set('scope',{});await m.reconcileKeyPackageOwnership();assert.equal(seen.get,0);
});
test('private storage failure rejects whole page before any retire',async()=>{
 const {m,seen}=await harness();m.identity.owns_key_package_ref=(_,ref)=>{if(ref[0]===2)throw Error('storage');return false;};
 await m.reconcileKeyPackageOwnership();assert.deepEqual(seen.retire,[]);
});
for(const status of [404,405,501,503])test(`status ${status} preserves private ownership and caches only unsupported`,async()=>{
 const {m,seen}=await harness({getKeyPackageOwnership:async()=>{seen.get++;throw {response:{status}};}});
 await m.reconcileKeyPackageOwnership();m._keyPackageOwnershipCheckedAt=0;await m.reconcileKeyPackageOwnership();
 assert.equal(seen.get,1);assert.deepEqual(seen.retire,[]);
});
test('provider replaced while HTTP awaits cannot retire entries',async()=>{
 const {m,seen}=await harness();m.e2eeClient.getKeyPackageOwnership=async()=>{m.provider={};return {version:1,entries:[entry(2)]};};
 await m.reconcileKeyPackageOwnership();assert.deepEqual(seen.retire,[]);
});
test('malformed inventory and repeated cursor fail closed',async()=>{
 for(const invalid of [{version:2,entries:[entry(2)]},{version:1,entries:[entry(2),entry(2)]},
 {version:1,entries:[{...entry(2),key_package_ref:new Uint8Array(31)}]},
 {version:1,entries:[entry(2)],next_cursor:{created_at:'wrong',id:id(2)}}]){
 const {m,seen}=await harness({getKeyPackageOwnership:async()=>invalid});await m.reconcileKeyPackageOwnership();assert.deepEqual(seen.retire,[]);
 }
});
test('pagination budget is three pages and continuation resumes after successful ACK',async()=>{
 const {m,seen}=await harness();let next=1;
 m.e2eeClient.getKeyPackageOwnership=async cursor=>{seen.get++;if(cursor)assert.equal(cursor.id,id(next-1));const e=entry(next++);return {version:1,entries:[e],next_cursor:{created_at:e.created_at,id:e.id}};};
 await m.reconcileKeyPackageOwnership();assert.equal(seen.get,3);assert.equal(m._keyPackageOwnershipCursor.id,id(3));
 const realNow=Date.now,at=realNow()+31000;try{Date.now=()=>at;m._keyPackageOwnershipCheckedAt=0;await m.reconcileKeyPackageOwnership();assert.equal(seen.get,6);assert.equal(m._keyPackageOwnershipCursor.id,id(6));}finally{Date.now=realNow;}
});
test('lost retirement ACK retains cursor so retry checks same snapshot',async()=>{
 const {m,seen}=await harness({reconcileKeyPackageOwnership:async()=>{throw Error('lost ACK');}});
 await m.reconcileKeyPackageOwnership();assert.equal(m._keyPackageOwnershipCursor,undefined);
});
test('API uses authenticated device and base64 public reference contract',async()=>{
 const calls=[];const bytes=entry(2).key_package_ref;
 const api=new E2eeClient({baseURL:'http://fixture',deviceId:'device',doAxiosRequest:async(method,url,body,options)=>{
 calls.push({method,url,body,options});return method==='get'?{version:1,entries:[{...entry(2),key_package_ref:Buffer.from(bytes).toString('base64')}]}:{retired:1};}},()=>({userId:'fixture',projectId:id(83),deviceId:'device',identity:{},assertCurrent(){},assertRegistrationCurrent(){},async verifyDurable(){}}));
 const page=await api.getKeyPackageOwnership();assert.deepEqual(page.entries[0].key_package_ref,bytes);
 await api.reconcileKeyPackageOwnership(page.entries);assert.equal(calls[1].body.missing[0].key_package_ref,Buffer.from(bytes).toString('base64'));
 assert.equal(calls[0].options.headers['X-Device-ID'],'device');assert.deepEqual(Object.keys(calls[1].body.missing[0]),['id','key_package_ref']);
});
