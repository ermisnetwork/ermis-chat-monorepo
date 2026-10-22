import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import init,* as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager,IndexedDBEncryptionStorage,sha256Hex}=createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
await init({module_or_path:fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url))});
let seq=0;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(retained=false){
 const user='identity-'+(++seq),s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager();
 Object.assign(m,{userId:user,deviceId:'device',storage:s,_injectedWasm:wasm});
 if(retained){const p=new wasm.Provider(),i=new wasm.Identity(p,user),kp=i.key_package(p),ref=kp.hash_ref(p);kp.free();await s.saveProviderState(user,'device',p.to_bytes());await s.saveIdentity(user,'device',i.to_bytes());m.ref=ref;}
 await m._initWasm();return {m,s,user,p:m.provider,bytes:m.provider.to_bytes(),cp:await s.loadProviderCheckpoint(user,'device'),identity:await s.loadIdentity(user,'device')};
}
function abort(s){const old=s._writeProviderCheckpoint.bind(s);s._writeProviderCheckpoint=(tx,...args)=>{old(tx,...args);tx.abort();};return ()=>s._writeProviderCheckpoint=old;}
for(const cap of ['identityCheckpointVersion','providerCheckpointCASVersion','loadProviderCheckpoint','loadIdentityCheckpoint','saveIdentityCheckpoint','verifyIdentityCheckpoint','loadIdentity'])test(`identity missing ${cap} rejects before active mutation`,async()=>{
 const h=await fixture();h.s[cap]=undefined;await assert.rejects(h.m._initIdentity(),e=>e.code==='client_upgrade_required');assert.equal(h.m.identity,null);assert.deepEqual(h.p.to_bytes(),h.bytes);assert.equal(h.m._providerPersistenceUncertain,false);
});
for(const retained of [false,true])test(`actual identity ${retained?'restore':'create'} abort preserves active and durable tuple`,async()=>{
 const h=await fixture(retained),restore=abort(h.s);await assert.rejects(h.m._initIdentity(),e=>e.checkpoint_outcome==='aborted');restore();assert.equal(h.m._activeProvider,h.p);assert.equal(h.m.identity,null);assert.deepEqual(h.p.to_bytes(),h.bytes);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,'device'),h.cp);assert.deepEqual(await h.s.loadIdentity(h.user,'device'),h.identity);assert.equal(h.m._providerPersistenceUncertain,false);await h.m._initIdentity();assert.ok(h.m.identity);if(retained)assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.m.ref),true);
});
for(const mode of ['unknown','readback','metadata'])test(`identity ${mode} committed outcome blocks active and durable restart recovers signer`,async()=>{
 const h=await fixture(true),save=h.s.saveIdentityCheckpoint.bind(h.s),verify=h.s.verifyIdentityCheckpoint.bind(h.s);
 if(mode==='unknown')h.s.saveIdentityCheckpoint=async cp=>{await save(cp);throw Error('committed outcome unknown');};
 else h.s.verifyIdentityCheckpoint=async cp=>{if(mode==='readback')throw Error('readback unavailable');await h.s.saveIdentity(h.user,'device',new Uint8Array([9]));return verify(cp);};
 await assert.rejects(h.m._initIdentity());assert.equal(h.m._activeProvider,h.p);assert.deepEqual(h.p.to_bytes(),h.bytes);assert.equal(h.m.identity,null);assert.equal(h.m._providerPersistenceUncertain,true);assert.throws(()=>h.m.provider,e=>e.code==='provider_persistence_uncertain');
 if(mode!=='metadata'){h.s.saveIdentityCheckpoint=save;h.s.verifyIdentityCheckpoint=verify;const restarted=new EncryptionManager();Object.assign(restarted,{storage:h.s,userId:h.user,deviceId:'device',_injectedWasm:wasm});await restarted._initWasm();await restarted._initIdentity();assert.deepEqual(restarted.identity.to_bytes(),h.identity);assert.equal(restarted.identity.owns_key_package_ref(restarted.provider,h.m.ref),true);}
 else assert.deepEqual(await h.s.loadIdentity(h.user,'device'),new Uint8Array([9]));
});
test('local private writer during identity write keeps winning active state; no install',async()=>{
 const h=await fixture(true),entered=latch(),release=latch(),save=h.s.saveIdentityCheckpoint.bind(h.s);
 h.s.saveIdentityCheckpoint=async cp=>{entered.resolve();await release.promise;return save(cp);};const work=h.m._initIdentity();await entered.promise;const i=wasm.Identity.from_bytes(h.p,h.identity),kp=i.key_package(h.p),ref=kp.hash_ref(h.p),winning=h.p.to_bytes();kp.free();release.resolve();await assert.rejects(work,e=>e.code==='recovery_scope_changed');assert.deepEqual(h.p.to_bytes(),winning);assert.equal(i.owns_key_package_ref(h.p,ref),true);assert.equal(h.m._providerPersistenceUncertain,true);assert.equal(h.m.identity,null);
});
for(const writer of ['provider','identity'])test(`remote ${writer} winner rejects stale identity admission without overwrite`,async()=>{
 const h=await fixture(true);let winning;
 if(writer==='provider'){const p=wasm.Provider.from_bytes(h.bytes),i=wasm.Identity.from_bytes(p,h.identity),kp=i.key_package(p);kp.free();winning=p.to_bytes();await h.s.saveProviderState(h.user,'device',winning,{expected_revision:h.cp.revision,next_revision:'remote'});}
 else{winning=new wasm.Identity(new wasm.Provider(),'replacement').to_bytes();await h.s.saveIdentity(h.user,'device',winning);}
 await assert.rejects(h.m._initIdentity(),e=>e.code==='provider_checkpoint_conflict');assert.deepEqual(h.p.to_bytes(),h.bytes);assert.equal(h.m.identity,null);assert.equal(h.m._providerPersistenceUncertain,true);assert.deepEqual(writer==='provider'?await h.s.loadProviderState(h.user,'device'):await h.s.loadIdentity(h.user,'device'),winning);
});
for(const dimension of ['same-account','account','device','signer','client','transport','artifact','owner','group'])test(`delayed identity admission preserves ${dimension} replacement`,async()=>{
 const h=await fixture(),entered=latch(),release=latch(),save=h.s.saveIdentityCheckpoint.bind(h.s);h.s.saveIdentityCheckpoint=async cp=>{entered.resolve();await release.promise;return save(cp);};const work=h.m._initIdentity();await entered.promise;
 if(dimension==='same-account')h.m.storage=new IndexedDBEncryptionStorage(h.user);else if(dimension==='account')h.m.userId='replacement';else if(dimension==='device')h.m.deviceId='replacement';else if(dimension==='signer')h.m.identity={replacement:true};else if(dimension==='client')h.m.client={};else if(dimension==='transport')h.m.e2eeClient={};else if(dimension==='artifact')h.m._wasmArtifactSha256='replacement';else if(dimension==='owner')h.m._initializationOwner={replacement:true};else h.m.groups.set('team:replacement',{replacement:true});
 const signer=h.m.identity,owner=h.m._initializationOwner,group=h.m.groups.get('team:replacement');release.resolve();await assert.rejects(work,e=>e.code==='recovery_scope_changed');assert.equal(h.m._activeProvider,h.p);assert.deepEqual(h.p.to_bytes(),h.bytes);assert.equal(h.m.identity,signer);assert.equal(h.m._initializationOwner,owner);assert.equal(h.m.groups.get('team:replacement'),group);
});
test('identity full proof and installation finish inside queue before dependent writer',async()=>{
 const h=await fixture(),entered=latch(),release=latch(),verify=h.s.verifyIdentityCheckpoint.bind(h.s);h.s.verifyIdentityCheckpoint=async cp=>{entered.resolve();await release.promise;return verify(cp);};const first=h.m._initIdentity();await entered.promise;
 // A queued callback captures the pre-install signer; it must fail rather than
 // use a freed provider or implicitly adopt an unrelated signer.
 let ran=false;const second=h.m._withProviderMutation(async()=>{ran=true;});assert.equal(ran,false);release.resolve();await first;await assert.rejects(second);assert.equal(ran,false);assert.ok(h.m.identity);const durable=await h.s.loadProviderCheckpoint(h.user,'device');assert.deepEqual(h.m.provider.to_bytes(),durable.provider_bytes);assert.deepEqual(h.m.identity.to_bytes(),await h.s.loadIdentity(h.user,'device'));
});
// These tests exercise initialization ownership, including the required MLS
// registration boundary, with controlled transport and the actual WASM signer.
function withRegistration(client){
 client.projectId='00000000-0000-4000-8000-000000000083';
 client.doAxiosRequest=async(method,url,body)=>String(url).endsWith('/devices/register')?
  {registration:{active:true,registration_id:crypto.randomUUID(),generation:0,device_id:body.device_id}}:{version:1,entries:[]};
 return client;
}
function startup(m){m._loadRecoveryPublicMetadata=async()=>{};m._normalizeStaleRestoreProgress=async()=>{};m.ensureKeyPackagesFromCachedHealthOrServer=async()=>{};m._restoreGroupsLocally=async()=>{};m._resumeExternalJoinCandidates=async()=>{};m._resumeEpochArchiveCheckpoints=async()=>{};m.resumePendingE2eeSends=async()=>{};m._drainGroupInfoValidationAcks=async()=>{};}
for(const mode of ['abort','readback'])test(`initialization final ${mode} does not register or publish initialized`,async()=>{
 const user='startup-'+(++seq),s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager(),events=[];startup(m);const client={deviceId:'device',baseURL:'http://fixture',dispatchEvent:e=>events.push(e)};
 if(mode==='abort'){const old=s.saveIdentityCheckpoint.bind(s);let writes=0;s.saveIdentityCheckpoint=async(...args)=>{if(++writes===1)return old(...args);const restore=abort(s);try{return await old(...args);}finally{restore();}};}
 else{const old=s.verifyIdentityCheckpoint.bind(s);let reads=0;s.verifyIdentityCheckpoint=async(...args)=>{if(++reads>1)throw Error('final readback unavailable');return old(...args);};}
 await assert.rejects(m.initialize(withRegistration(client),user,{storage:s,wasmModule:wasm,wasmArtifactSha256:sha256Hex(fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url)))}));assert.equal(m.initialized,false);assert.equal(client.encryptionManager,undefined);assert.deepEqual(events,[]);assert.equal(m._initializationOwner,null);assert.ok(await s.loadIdentity(user,'device'));
});
for(const mode of ['device-await','final-proof','callback'])test(`initialization ${mode} replacement retains owner and suppresses old continuation`,async()=>{
 const user='startup-'+(++seq),s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager(),entered=latch(),release=latch(),events=[];startup(m);const replacement={},client={baseURL:'http://fixture',dispatchEvent:e=>{events.push(e);if(mode==='callback')m._initializationOwner=replacement;}};
 if(mode==='device-await')s.getDeviceId=async()=>{entered.resolve();await release.promise;return 'old-device';};
 else{client.deviceId='device';if(mode==='final-proof'){const old=s.verifyIdentityCheckpoint.bind(s);let reads=0;s.verifyIdentityCheckpoint=async(...args)=>{if(++reads>1){entered.resolve();await release.promise;}return old(...args);};}}
 const work=m.initialize(withRegistration(client),user,{storage:s,wasmModule:wasm,wasmArtifactSha256:sha256Hex(fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url)))});if(mode!=='callback'){await entered.promise;m._initializationOwner=replacement;release.resolve();}
 await assert.rejects(work,e=>e.code==='recovery_scope_changed');assert.equal(m._initializationOwner,replacement);if(mode!=='callback'){assert.equal(m.initialized,false);assert.deepEqual(events,[]);}if(mode==='device-await'){assert.equal(client.deviceId,undefined);assert.equal(m.deviceId,null);assert.equal(await s.loadProviderState(user,'device'),null);}
});
test('missing initialization capability does not load or mutate private provider',async()=>{
 const s=new IndexedDBEncryptionStorage('missing'),m=new EncryptionManager();s.identityCheckpointVersion=undefined;s.loadProviderCheckpoint=async()=>{throw Error('private read forbidden');};await assert.rejects(m.initialize({deviceId:'device'},'missing',{storage:s,wasmModule:wasm,wasmArtifactSha256:sha256Hex(fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url)))}),e=>e.code==='client_upgrade_required');assert.equal(m._activeProvider,null);assert.equal(m.identity,null);assert.equal(m.initialized,false);
});
test('owned device initialization advances its auth scope only after device read',async()=>{
 const user='startup-'+(++seq),s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager(),events=[];startup(m);s.getDeviceId=async()=> 'device';const client={dispatchEvent:e=>events.push(e),_captureAuthScope(){const device=this.deviceId;return {assertCurrent:()=>{if(this.deviceId!==device)throw Error('auth device scope replaced');}};}};await m.initialize(withRegistration(client),user,{storage:s,wasmModule:wasm,wasmArtifactSha256:sha256Hex(fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url)))});assert.equal(m.initialized,true);assert.equal(client.deviceId,'device');assert.equal(events.filter(e=>e.type==='e2ee.initialized').length,1);assert.equal(client.encryptionManager,m);assert.equal(m._initializationOwner,null);
});
for(const stage of ['private-read','provider-present'])test(`durable identity load ${stage} replacement cannot install provider`,async()=>{
 const h=await fixture(stage==='provider-present'),n=new EncryptionManager();Object.assign(n,{storage:h.s,userId:h.user,deviceId:'device',_injectedWasm:wasm});const entered=latch(),release=latch(),read=h.s.loadIdentityCheckpoint.bind(h.s);h.s.loadIdentityCheckpoint=async(...args)=>{const cp=await read(...args);entered.resolve();await release.promise;return cp;};const work=n._initWasm();await entered.promise;const winner={replacement:true};n.client=winner;release.resolve();await assert.rejects(work,e=>e.code==='recovery_scope_changed');assert.equal(n._activeProvider,null);assert.equal(n.identity,null);assert.equal(n.client,winner);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,'device'),h.cp);
});
test('metadata-only signer replacement before final initialization checkpoint cannot publish usable runtime',async()=>{
 const user='startup-'+(++seq),s=new IndexedDBEncryptionStorage(user),m=new EncryptionManager(),events=[];startup(m);const winner=new Uint8Array([9]);m._resumeExternalJoinCandidates=async()=>{await s.saveIdentity(user,'device',winner);};const client={deviceId:'device',dispatchEvent:e=>events.push(e)};await assert.rejects(m.initialize(withRegistration(client),user,{storage:s,wasmModule:wasm,wasmArtifactSha256:sha256Hex(fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url)))}),e=>e.code==='provider_checkpoint_conflict');assert.equal(m.initialized,false);assert.equal(client.encryptionManager,undefined);assert.deepEqual(events,[]);assert.deepEqual(await s.loadIdentity(user,'device'),winner);assert.equal(m._providerPersistenceUncertain,true);
});
