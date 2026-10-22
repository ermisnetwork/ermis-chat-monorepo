const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {webcrypto} = require('node:crypto');
globalThis.crypto ??= webcrypto;
let wasmPromise;
const actualWasm = () => wasmPromise ??= (async () => {
 const wasm = await import(pathToFileURL(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm.js')));
 await wasm.default({module_or_path: fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'))});return wasm;
})();

const bundle = process.env.KP_REFILL_SDK_BUNDLE || '../dist/encryption/index.cjs';
const { EncryptionManager, IndexedDBEncryptionStorage } = require(bundle);
require('fake-indexeddb/auto');
let unique = 0;

function refillEvent(generation, usableCount = 0) {
  return {
    type: usableCount === 0 ? 'key_packages.empty' : 'key_packages.low',
    idempotency_key: `kp-refill-v1:test-${generation}`,
    device_id: 'device-a',
    usable_count: usableCount,
    target: 100,
    requested_delta: 100 - usableCount,
    reason: 'consume',
    generation,
    version: 1,
  };
}

async function managerHarness({initialRemaining, loseFirstResponse = false, failFirstUpload = false, drainSuccessfulUploads = false}) {
  const manager = new EncryptionManager(), wasm = await actualWasm();
  const user = 'kp-refill-' + ++unique, storage = new IndexedDBEncryptionStorage(user);
  Object.assign(manager, {userId:user, deviceId:'device-a', storage, _injectedWasm:wasm});
  await manager._initWasm(); await manager._initIdentity(); await manager._persistProviderStrict();
  let serverRemaining=initialRemaining, countCalls=0, uploadCalls=0;
  const generatedDeltas=[], persisted=[], retryDelays=[], batches=new Map();
  const generate=manager.identity.key_packages_typed.bind(manager.identity);
  manager.identity.key_packages_typed=(provider,count)=>{generatedDeltas.push(count);return generate(provider,count);};
  const save=storage.saveKeyPackageUploadCheckpoint.bind(storage);
  storage.saveKeyPackageUploadCheckpoint=async(...args)=>{await save(...args);persisted.push(args[2].length);};
  manager.e2eeClient={
    getKeyPackageOwnership:async()=>({version:1,entries:[]}),
    async getKeyPackageCount(){countCalls++;return{remaining:serverRemaining,target:100,low_watermark:50,requested_delta:Math.max(0,100-serverRemaining),refill_generation:serverRemaining>=100?null:1};},
    async uploadKeyPackages({key_packages},id){
      uploadCalls++;
      if(failFirstUpload&&uploadCalls===1)throw Error('transport unknown before accept');
      if(!batches.has(id)){
        if(!drainSuccessfulUploads)serverRemaining+=key_packages.length;
        batches.set(id,{batch_id:id,validation_version:1,stored:key_packages.length,total_remaining:serverRemaining,target:100,low_watermark:50,requested_delta:Math.max(0,100-serverRemaining),refill_generation:serverRemaining>=100?null:1});
      }
      if(loseFirstResponse&&uploadCalls===1)throw Error('response lost after accept');
      return batches.get(id);
    },
  };
  manager._keyPackageRefillSleep=async ms=>{retryDelays.push(ms);};manager._keyPackageRefillRandom=()=>0.5;
  return{manager,storage,user,close:async()=>{manager.destroy();await storage.close();},state:()=>({serverRemaining,countCalls,uploadCalls,generatedDeltas,persisted,retryDelays})};
}
async function due(h){const pending=await h.storage.loadPendingKeyPackageUpload(h.user,'device-a');assert.ok(pending);const real=Date.now;Date.now=()=>Math.max(real(),pending.retry_at+1);try{await h.manager.ensureKeyPackagesFromServer();}finally{Date.now=real;}}

test('100 duplicate events coalesce; lost ACK retains batch and a healthy count cannot replace reconciliation',async()=>{
 const h=await managerHarness({initialRemaining:0,loseFirstResponse:true});try{
  await Promise.all(Array.from({length:100},()=>h.manager.handleKeyPackageRefill(refillEvent(1))));
  assert.equal(h.state().uploadCalls,1);assert.equal(h.state().serverRemaining,100);assert.equal(h.state().countCalls,1);
  const pending=await h.storage.loadPendingKeyPackageUpload(h.user,'device-a');assert.equal(pending.attempts,1);assert.ok(pending.retry_at>Date.now());
  await h.manager.ensureKeyPackagesFromServer();assert.equal(h.state().countCalls,1);assert.equal(h.state().uploadCalls,1);assert.deepEqual(await h.storage.loadPendingKeyPackageUpload(h.user,'device-a'),pending);
  await due(h);assert.equal(h.state().uploadCalls,2);assert.equal(h.state().countCalls,1);assert.deepEqual(h.state().generatedDeltas,[100]);assert.equal(await h.storage.loadPendingKeyPackageUpload(h.user,'device-a'),null);
 }finally{await h.close();}
});
test('unknown pre-accept transport resumes exact batch only when durable retry is due',async()=>{
 const h=await managerHarness({initialRemaining:40,failFirstUpload:true});try{
  await h.manager.ensureKeyPackages(40,100,50,3,true);assert.equal(h.state().uploadCalls,1);const job=await h.storage.loadPendingKeyPackageUpload(h.user,'device-a');assert.equal(job.attempts,1);
  await due(h);assert.equal(h.state().serverRemaining,100);assert.equal(h.state().uploadCalls,2);assert.deepEqual(h.state().generatedDeltas,[60]);assert.equal(h.state().persisted.length,1);
 }finally{await h.close();}
});
test('health count above the low watermark does not start a top-up', async (t) => {
  const harness = await managerHarness({ initialRemaining: 51 }); t.after(()=>harness.close());
  await harness.manager.ensureKeyPackages(51, 100, 50);
  const state = harness.state();
  assert.equal(state.countCalls, 0);
  assert.equal(state.uploadCalls, 0);
  assert.deepEqual(state.generatedDeltas, []);
});

test('continuous concurrent consumption cannot make refill loop without a bound', async (t) => {
  const harness = await managerHarness({ initialRemaining: 0, drainSuccessfulUploads: true }); t.after(()=>harness.close());
  await harness.manager.ensureKeyPackages(0, 100, 50, 4, true);

  const state = harness.state();
  assert.equal(state.serverRemaining, 0);
  assert.equal(state.uploadCalls, 5);
  assert.equal(state.countCalls, 4);
  assert.deepEqual(state.generatedDeltas, [100, 100, 100, 100, 100]);
  assert.equal(state.persisted.length, 5);
  assert.equal(state.retryDelays.length, 4);
});

test('contradictory durable inventory never generates private material', async (t) => {
  for (const override of [
    { requested_delta: 99 }, { target: 101 }, { remaining: -1 },
    { remaining: 0.5 }, { low_watermark: 100 }, { refill_generation: null },
    { refill_generation: 1.5 }, { target: undefined },
  ]) {
    const harness = await managerHarness({ initialRemaining: 0 }); t.after(()=>harness.close());
    harness.manager.e2eeClient.getKeyPackageCount = async () => ({
      remaining: 0, target: 100, low_watermark: 50, requested_delta: 100, refill_generation: 1,
      ...override,
    });
    await harness.manager.ensureKeyPackagesFromServer();
    assert.deepEqual(harness.state().generatedDeltas, [], JSON.stringify(override));
    assert.equal(harness.state().uploadCalls, 0);
  }
});

test('stale empty event cannot refill a healthy pool without current durable demand', async (t) => {
  const harness = await managerHarness({ initialRemaining: 60 }); t.after(()=>harness.close());
  harness.manager.e2eeClient.getKeyPackageCount = async () => ({
    remaining: 60, target: 100, low_watermark: 50, requested_delta: 40, refill_generation: null,
  });
  await harness.manager.handleKeyPackageRefill(refillEvent(3));
  assert.equal(harness.state().uploadCalls, 0);
});

test('an open durable demand continues above the low watermark until target', async (t) => {
  const harness = await managerHarness({ initialRemaining: 60 }); t.after(()=>harness.close());
  await harness.manager.ensureKeyPackagesFromServer();
  assert.deepEqual(harness.state().generatedDeltas, [40]);
  assert.equal(harness.state().serverRemaining, 100);
});

test('provider checkpoint failure sends no HTTP and cannot create an accepted batch', async()=>{
 const h=await managerHarness({initialRemaining:0});try{
  h.storage.saveKeyPackageUploadCheckpoint=async()=>{throw Error('disk unavailable');};
  await h.manager.handleKeyPackageRefill(refillEvent(1));assert.equal(h.state().uploadCalls,0);assert.equal(await h.storage.loadPendingKeyPackageUpload(h.user,'device-a'),null);
 }finally{await h.close();}
});
