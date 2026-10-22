const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {webcrypto} = require('node:crypto');
require('fake-indexeddb/auto'); globalThis.crypto ??= webcrypto;
const {EncryptionManager, IndexedDBEncryptionStorage} = require('../dist/encryption/index.cjs');
let unique = 0;
async function fixture() {
  const wasm = await import(pathToFileURL(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm.js')));
  await wasm.default({module_or_path: fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'))});
  const user = `upload-checkpoint-${++unique}`, device = 'device', storage = new IndexedDBEncryptionStorage(user);
  async function manager() {
    const m = new EncryptionManager(); Object.assign(m, {userId: user, deviceId: device, storage});
    m._injectedWasm = wasm; await m._initWasm(); await m._initIdentity(); await m._persistProviderStrict();
    return m;
  }
  const m = await manager();
  return {m, manager, wasm, storage, user, device};
}
const response = (n, id) => ({batch_id:id,validation_version:1,stored: n, total_remaining: 100, target: 100, low_watermark: 50, requested_delta: 0, refill_generation: null});
test('ambiguous HTTP acceptance survives restart and reuses exact signed bytes with durable private bundles', async () => {
  const f = await fixture(); let first, operationId;
  f.m.e2eeClient = {uploadKeyPackages: async ({key_packages}, id) => {operationId = id; first = key_packages.map(b => Uint8Array.from(b)); throw Error('lost ACK');}};
  await assert.rejects(f.m._uploadKeyPackages(7), /lost ACK/);
  const pending = await f.storage.loadPendingKeyPackageUpload(f.user, f.device); assert.equal(pending.packages.length, 7); assert.equal(operationId, pending.operation_id);
  const restarted = await f.manager(); let attempts = 0;
  restarted.e2eeClient = {uploadKeyPackages: async ({key_packages}, id) => {
    assert.equal(id, operationId); attempts++; assert.deepEqual(key_packages, first);
    for (const bytes of key_packages) {
      const kp = f.wasm.KeyPackage.from_bytes(bytes);
      assert(restarted.identity.owns_key_package_ref(restarted.provider, kp.hash_ref(restarted.provider)));
    }
    return response(7,id);
  }};
  await restarted._uploadKeyPackages(99); assert.equal(attempts, 1);
  assert.equal(await f.storage.loadPendingKeyPackageUpload(f.user, f.device), null);
  await f.storage.close();
});
test('HTTP runs outside the mutation lock and a later account response cannot clear a newer job', async () => {
  const f = await fixture(); let entered, release;
  const start = new Promise(r => entered = r), gate = new Promise(r => release = r);
  f.m.e2eeClient = {uploadKeyPackages: async () => {assert.equal(f.m._providerCheckpointInFlight, false); entered(); await gate; return response(2);}};
  const uploading = f.m._uploadKeyPackages(2); await start;
  const original = await f.storage.loadPendingKeyPackageUpload(f.user, f.device);
  await f.storage.saveKeyPackageUploadCheckpoint(f.user, f.device, f.m.provider.to_bytes(), {...original, operation_id: 'newer'});
  release(); await assert.rejects(uploading, e => ['key_package_upload_checkpoint_conflict','key_package_upload_scope_changed'].includes(e.code));
  assert.equal((await f.storage.loadPendingKeyPackageUpload(f.user, f.device)).operation_id, 'newer');
  await f.storage.close();
});
test('failed checkpoint or second-write clone error leaves active/provider store unchanged and sends no HTTP', async () => {
  const f = await fixture(); const active = f.m.provider, before = active.to_bytes(); let http = 0;
  f.m.e2eeClient = {uploadKeyPackages: async () => {http++; return response(3);}};
  const save = f.storage.saveKeyPackageUploadCheckpoint.bind(f.storage);
  f.storage.saveKeyPackageUploadCheckpoint = async () => {throw Error('quota');};
  await assert.rejects(f.m._uploadKeyPackages(3), /quota/);
  assert.deepEqual(active.to_bytes(), before); assert.equal(http, 0);
  await assert.rejects(save(f.user, f.device, Uint8Array.of(99), {cannotClone() {}}));
  assert.deepEqual(await f.storage.loadProviderState(f.user, f.device), before);
  assert.equal(await f.storage.loadPendingKeyPackageUpload(f.user, f.device), null);
  await f.storage.close();
});
test('malformed/hash-changed/public signer-changed pending job fails closed without new KP generation', async () => {
  const f = await fixture(); f.m.e2eeClient = {uploadKeyPackages: async () => {throw Error('unavailable');}};
  await assert.rejects(f.m._uploadKeyPackages(1)); const pending = await f.storage.loadPendingKeyPackageUpload(f.user, f.device);
  for (const change of [{package_sha256: ['0'.repeat(64)]}, {signing_identity_sha256: 'f'.repeat(64)}, {packages: []}]) {
    await f.storage.saveKeyPackageUploadCheckpoint(f.user, f.device, f.m.provider.to_bytes(), {...pending, ...change});
    const before = f.m.provider.to_bytes();
    await assert.rejects(f.m._uploadKeyPackages(100), e => e.code === 'key_package_upload_checkpoint_invalid');
    assert.deepEqual(f.m.provider.to_bytes(), before);
  }
  await f.storage.close();
});

const turns=async()=>{for(let i=0;i<24;i++)await new Promise(setImmediate);};
test('hung upload cancels at original operation deadline; late ACK cannot clear unresolved work',async()=>{
 const f=await fixture();let entered,release,signal,timer;const start=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 f.m._ownershipSetTimeout=fn=>{timer=fn;return 1;};f.m._ownershipClearTimeout=()=>{};
 f.m.e2eeClient={uploadKeyPackages:async(_body,id,budget)=>{signal=budget.signal;entered();await held;return response(2,id);}};
 try{const work=f.m._uploadKeyPackages(2);await start;const job=await f.storage.loadPendingKeyPackageUpload(f.user,f.device);assert.equal(job.attempts,1);timer();await assert.rejects(work,e=>e.code==='key_package_upload_deadline');assert.equal(signal.aborted,true);release();await turns();assert.deepEqual(await f.storage.loadPendingKeyPackageUpload(f.user,f.device),job);assert.equal(f.m._keyPackageUploadAborts.size,0);}
 finally{release();f.m.destroy();await f.storage.close();}
});
test('destroy cancels only old upload; reopened manager retains exact batch/private bundles',async()=>{
 const f=await fixture();let entered,release,signal;const start=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 f.m.e2eeClient={uploadKeyPackages:async(_body,id,budget)=>{signal=budget.signal;entered();await held;return response(2,id);}};
 let next;try{const old=f.m._uploadKeyPackages(2);const observed=old.catch(e=>e);await start;const job=await f.storage.loadPendingKeyPackageUpload(f.user,f.device);f.m.destroy();assert.ok(await observed instanceof Error);assert.equal(signal.aborted,true);
 next=await f.manager();next.e2eeClient={uploadKeyPackages:async(body,id)=>{assert.equal(id,job.operation_id);assert.deepEqual(body.key_packages,job.packages);return response(2,id);}};
 await next._uploadKeyPackages(99);release();await turns();assert.equal(await f.storage.loadPendingKeyPackageUpload(f.user,f.device),null);
 }finally{release();next?.destroy();await f.storage.close();}
});
test('native ownership probe uncertainty retains typed batch and never reaches HTTP',async()=>{
 const f=await fixture();let posts=0;const original=f.m.identity.owns_key_package_ref.bind(f.m.identity);f.m.identity.owns_key_package_ref=()=>{throw Error('private storage uncertain');};f.m.e2eeClient={uploadKeyPackages:async()=>{posts++;}};
 try{await assert.rejects(f.m._uploadKeyPackages(1),e=>e.code==='key_package_upload_private_uncertain');const job=await f.storage.loadPendingKeyPackageUpload(f.user,f.device);assert.equal(job.disposition,'retained_private_uncertain');assert.equal(posts,0);await assert.rejects(f.m._uploadKeyPackages(99));assert.equal(posts,0);}
 finally{f.m.identity.owns_key_package_ref=original;f.m.destroy();await f.storage.close();}
});
test('durable upload retry wakes without health/count event and never resets retry metadata',async()=>{
 const f=await fixture();let time=Date.now(),seq=0,posts=0,counts=0;const real=Date.now,timers=new Map();Date.now=()=>time;
 f.m.initialized=true;f.m._keyPackageOwnershipUnsupported=true;f.m._ownershipSetTimeout=(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:time+ms});return id;};f.m._ownershipClearTimeout=id=>timers.delete(id);f.m._keyPackageRefillSleep=async()=>{};
 f.m.e2eeClient={getKeyPackageCount:async()=>{counts++;return{remaining:100,target:100,low_watermark:50,requested_delta:0,refill_generation:null};},uploadKeyPackages:async(_body,id)=>{posts++;if(posts===1)throw Error('lost ACK');return response(2,id);}};
 try{await assert.rejects(f.m._uploadKeyPackages(2));const job=await f.storage.loadPendingKeyPackageUpload(f.user,f.device);await f.m.ensureKeyPackagesFromServer();assert.equal(posts,1);assert.equal(counts,0);assert.deepEqual(await f.storage.loadPendingKeyPackageUpload(f.user,f.device),job);assert.equal(timers.size,1);
 time=job.retry_at+1;for(const[id,t]of[...timers])if(t.at<=time){timers.delete(id);t.fn();}await turns();await f.m._keyPackageTopUpPromise;assert.equal(posts,2);assert.equal(counts,0);assert.equal(await f.storage.loadPendingKeyPackageUpload(f.user,f.device),null);
 }finally{f.m.destroy();await f.storage.close();Date.now=real;}
});
