import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
export const sdk = createRequire(import.meta.url)('../dist/index.cjs');
export {wasm};
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const binary = fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url));
await init({module_or_path: binary});
let sequence = 0;
export const latch = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
};
export async function fixture(status = 'missing') {
  const user = 'flat-publication-' + ++sequence, device = 'device', cid = 'team:' + user;
  const s = new sdk.IndexedDBEncryptionStorage(user), m = new sdk.EncryptionManager(), events = [], calls = [];
  Object.assign(m, {storage:s, userId:user, deviceId:device, _injectedWasm:wasm, _wasmArtifactSha256:sdk.sha256Hex(binary)});
  await m._initWasm(); await m._initIdentity();
  const group = wasm.Group.create_with_cid(m.provider, m.identity, cid);
  const marker = {cid,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1};
  m.groups.set(cid,group); m._groupGenerations.set(cid,marker);
  await s.saveGroupState(cid,marker);
  const kp = m.identity.key_package(m.provider), ref = kp.hash_ref(m.provider); kp.free();
  await m._persistProviderStrict();
  m.initialized = true;
  m._armValidationAckRetry = () => {};
  m._queueChannelEvidence = () => {};
  m._queueGroupInfoValidationAck = () => {};
  m.client = {activeChannels:{[cid]:{data:{mls_enabled:true},state:{members:{[user]:{user_id:user,created_at:'2026-10-17T00:00:00Z'}}}}},dispatchEvent:e=>events.push(e)};
  m.e2eeClient = {
    getGroupInfoPublicationMarker:async()=>{calls.push('marker');return {marker:{group_generation:0,epoch:0,observed_hash:null}};},
    submitReservedGroupInfo:async(_t,_i,b)=>{calls.push(structuredClone(b));return {};},
    discoverMlsRecovery:async()=>({protocol_version:1,capability:{protocol_version:1},states:{}}),
  };
  m._discoverMlsRecoveryStates = async()=>({states:{},unsupported:false});
  const metadata = {cid,group_generation:0,group_id:null,epoch:0,group_info:{status,ready:status==='ready',epoch:0,last_uploaded_at:null,refresh_requested:false},recovery:null};
  m.observeChannelE2ee(metadata,true);
  return {m,s,user,device,cid,group,marker,metadata,events,calls,ref,bytes:m.provider.to_bytes(),
    close:async()=>{m.destroy();await s.close();}};
}
export async function work(h) {
  const db = await h.s.openDB();
  return new Promise((yes,no)=>{const tx=db.transaction('meta','readonly'),r=tx.objectStore('meta').getAll(IDBKeyRange.bound('channel_evidence:v1:','channel_evidence:v1:\uffff'));tx.oncomplete=()=>yes(r.result);tx.onabort=()=>no(tx.error);});
}
export async function put(h,key,value) {
  const db=await h.s.openDB();
  await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(value,key);tx.oncomplete=yes;tx.onabort=()=>no(tx.error);});
}
export async function privatePreserved(h) {
  assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);
  assert.deepEqual(await h.s.loadProviderState(h.user,h.device),h.bytes);
  assert.equal(h.m.identity.owns_key_package_ref(h.m._activeProvider,h.ref),true);
}
export async function peer(h) {
  const s=new sdk.IndexedDBEncryptionStorage(h.user),base=await s.loadProviderCheckpoint(h.user,h.device);
  const p=wasm.Provider.from_bytes(base.provider_bytes),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p),ref=kp.hash_ref(p);kp.free();
  await s.saveProviderState(h.user,h.device,p.to_bytes(),{expected_revision:base.revision,next_revision:crypto.randomUUID()});
  i.free();p.free();await s.close();return {base:await h.s.loadProviderCheckpoint(h.user,h.device),ref};
}
