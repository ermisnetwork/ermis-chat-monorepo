import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import init,* as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager,IndexedDBEncryptionStorage,sha256Hex}=createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const binary=fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url));await init({module_or_path:binary});let sequence=0;
const incident='00000000-0000-4000-8000-000000000001';
async function fixture(status='missing'){
  const user='channel-evidence-'+ ++sequence,device='device',cid='team:'+user,storage=new IndexedDBEncryptionStorage(user),events=[];
  const m=new EncryptionManager();Object.assign(m,{storage,userId:user,deviceId:device,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(binary)});
  await m._initWasm();await m._initIdentity();
  const group=wasm.Group.create_with_cid(m.provider,m.identity,cid),marker={cid,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1};
  m.groups.set(cid,group);m._groupGenerations.set(cid,marker);await storage.saveGroupState(cid,marker);await m._persistProviderStrict();
  m.initialized=true;m._armValidationAckRetry=()=>{};m._queueGroupInfoValidationAck=()=>{};m._queueChannelEvidence=()=>{};
  m.client={activeChannels:{[cid]:{data:{mls_enabled:true},state:{members:{[user]:{user_id:user,created_at:'2026-10-17T00:00:00Z'}}}}},dispatchEvent:e=>events.push(e)};
  let uploads=0,continues=0,body;
  m.e2eeClient={getGroupInfoPublicationMarker:async()=>({marker:{request_id:incident,group_generation:0,epoch:0,observed_hash:null}}),uploadGroupInfo:async(_type,_id,b)=>{uploads++;assert.deepEqual(b.expected,{group_generation:0,group_id:null});assert.equal(b.epoch,0);},continueRecovery:async(_type,_id,b)=>{continues++;body=b;return{status:'admitted'};}};
  m.e2eeClient.submitReservedGroupInfo=(...args)=>m.e2eeClient.uploadGroupInfo(...args);
  m._discoverMlsRecoveryStates=async()=>({states:{},unsupported:false});
  const metadata={cid,group_generation:0,group_id:null,epoch:0,group_info:{status,ready:status==='ready',epoch:status==='missing'?null:0,last_uploaded_at:null},recovery:{action:'waiting_for_evidence',incident_id:incident,revision:'2',repair_retry_until:new Date(Date.now()-60000).toISOString()}};
  m.observeChannelE2ee(metadata);
  return{m,storage,user,device,cid,group,metadata,events,get uploads(){return uploads;},get continues(){return continues;},get body(){return body;}};
}
async function work(f){const db=await f.storage.openDB();return new Promise((resolve,reject)=>{const tx=db.transaction('meta','readonly'),r=tx.objectStore('meta').getAll(IDBKeyRange.bound('channel_evidence:v1:','channel_evidence:v1:\uffff'));tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);});}
async function due(f){const db=await f.storage.openDB();await new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite'),r=tx.objectStore('meta').openCursor(IDBKeyRange.bound('channel_evidence:v1:','channel_evidence:v1:\uffff'));r.onsuccess=()=>{const cursor=r.result;if(cursor){cursor.update({...cursor.value,retry_at:Date.now()-1});cursor.continue();}};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});f.m._channelEvidenceBudget={at:Date.now(),remaining:6};}
test('healthy local group publishes GI with generation fence and without lease or continuation',async()=>{
 const f=await fixture();const sends=[];f.m.e2eeClient.uploadGroupInfo=async(_t,_i,b)=>{sends.push(b);};
 await f.m._checkChannelEvidence(f.cid);assert.equal(sends.length,1);assert.equal(f.continues,0);
 assert.deepEqual(sends[0].expected,{group_generation:0,group_id:null});
 assert.equal(sends[0].lease_token,undefined);assert.equal(sends[0].request_id,undefined);
 const p=new wasm.Provider(),i=new wasm.Identity(p,'next');
 const joined=wasm.Group.join_external_with_policy(p,i,sends[0].group_info,null,false);
 assert.equal(Number(joined.group.epoch()),1);
 assert.equal((await work(f))[0].outcome,'finished');
 await f.m._checkChannelEvidence(f.cid);assert.equal(sends.length,1);
});
test('lost replies use one durable CID budget across repeated hints and manager restart',async()=>{
 const f=await fixture();const bodies=[];
 f.m.e2eeClient.uploadGroupInfo=async(_t,_i,b)=>{bodies.push(structuredClone(b));throw Object.assign(new Error('offline'),{code:'ERR_NETWORK'});};
 for(let attempt=0;attempt<3;attempt++){await due(f);await f.m._checkChannelEvidence(f.cid);}
 assert.equal(bodies.length,3);assert.equal((await work(f))[0].attempts,3);assert.equal((await work(f))[0].outcome,'exhausted');
 for(const body of bodies)assert.deepEqual(body,bodies[0]);
 f.m.observeChannelE2ee({...f.metadata,recovery:{...f.metadata.recovery,revision:'4'}});await due(f);await f.m._checkChannelEvidence(f.cid);
 assert.equal(bodies.length,3,'metadata revision cannot replenish a CID budget');
 const reopened=new IndexedDBEncryptionStorage(f.user), persisted=await reopened.loadProviderCheckpoint(f.user,f.device);
 f.m.storage=reopened;f.m._providerDurableBase={storage:reopened,userId:f.user,deviceId:f.device,revision:persisted.revision};
 f.m._channelEvidenceBudget={at:0,remaining:6};await f.m._checkChannelEvidence(f.cid);
 assert.equal(bodies.length,3,'durable record survives storage reopen and a fresh in-memory request budget');
});
test('generic publication succeeds without reset incident or continuation authority',async()=>{
 const f=await fixture();f.m._channelE2ee.set(f.cid,{...f.metadata,recovery:undefined});
 f.m._recoveryControls.clear();await f.m._checkChannelEvidence(f.cid);
 assert.equal(f.uploads,1);assert.equal(f.continues,0);
});
test('ready metadata is quiet unless the durable publication marker is set',async()=>{
 const f=await fixture('ready');await f.m._checkChannelEvidence(f.cid);assert.equal(f.uploads,0);
 f.m.observeChannelE2ee({...f.metadata,group_info:{...f.metadata.group_info,refresh_requested:true}});
 await f.m._checkChannelEvidence(f.cid);assert.equal(f.uploads,1);
});
test('missing local state and unmatched epoch cannot upload or offer reset authority',async()=>{
 const f=await fixture();f.m.groups.delete(f.cid);await f.m._checkChannelEvidence(f.cid);assert.equal(f.uploads+f.continues,0);
 const g=await fixture();g.m._channelE2ee.get(g.cid).epoch=1;g.m._syncChannelFromCursor=async()=>({needs_retry:true});g.m._loadScopeSyncCursor=async()=>null;
 await g.m._checkChannelEvidence(g.cid);assert.equal(g.uploads+g.continues,0);
});
test('concurrent key/mutation writer wins the composed publication CAS',async()=>{
 const f=await fixture();const save=f.storage.saveChannelEvidenceWork.bind(f.storage);
 f.storage.saveChannelEvidenceWork=async(user,device,cid,expected,next,assertOwner)=>{
   const db=await f.storage.openDB();await new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({pending:true},'mls_mutation:v1:'+cid);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
   return save(user,device,cid,expected,next,assertOwner);
 };
 await assert.rejects(f.m._checkChannelEvidence(f.cid),/recovery_checkpoint_conflict/);assert.equal(f.uploads+f.continues,0);assert.equal((await work(f)).length,0);
});
test('changed server generation marker prevents publication and preserves reserved evidence',async()=>{
 const f=await fixture();f.m.e2eeClient.getGroupInfoPublicationMarker=async()=>({marker:{group_generation:1,epoch:0}});
 await f.m._checkChannelEvidence(f.cid);assert.equal(f.uploads+f.continues,0);assert.equal((await work(f))[0].attempts,1);
});
test('owner replacement while reading marker sends no GI and cannot settle replacement state',async()=>{
 const f=await fixture();f.m.e2eeClient.getGroupInfoPublicationMarker=async()=>{f.m.deviceId='new-device';return{marker:null};};
 await assert.rejects(()=>f.m._checkChannelEvidence(f.cid),{code:'recovery_scope_changed'});assert.equal(f.uploads,0);
});
test('missing atomic evidence storage surfaces upgrade before publication',async()=>{
 const f=await fixture();f.storage.channelEvidenceWorkVersion=undefined;
 await assert.rejects(()=>f.m._checkChannelEvidence(f.cid),{code:'client_upgrade_required'});assert.equal(f.uploads+f.continues,0);
});

test('generic missing GI leaves retained validation ACK admission and send jobs dormant',async()=>{
 const f=await fixture('missing');let scans=0;
 f.m._maintainRecoveryWork=async()=>{scans++;};f.m._takeValidationWorkPage=async()=>{scans++;return[];};
 await f.m._drainValidationAckAdmissions();await f.m._drainGroupInfoValidationAcks();
 assert.equal(scans,0);assert.equal(f.uploads+f.continues,0);
});

for(const dimension of ['provider','marker'])test('publication initial snapshot '+dimension+' winner fences current and late Ready without overwriting durable state',async()=>{
 const f=await fixture();const load=f.storage.loadChannelEvidenceWork.bind(f.storage);let winner,once=false;
 f.storage.loadChannelEvidenceWork=async(...args)=>{
  if(!once){once=true;
   if(dimension==='provider'){
    const base=await f.storage.loadProviderCheckpoint(f.user,f.device),p=wasm.Provider.from_bytes(base.provider_bytes),i=wasm.Identity.from_bytes(p,f.m.identity.to_bytes()),kp=i.key_package(p);kp.free();winner=p.to_bytes();await f.storage.saveProviderState(f.user,f.device,winner,{expected_revision:base.revision,next_revision:crypto.randomUUID()});i.free();p.free();
   }else{winner={...f.m._groupGenerations.get(f.cid),status:'historical'};await f.storage.saveGroupState(f.cid,winner);}
  }
  return load(...args);
 };
 try{await assert.rejects(f.m._checkChannelEvidence(f.cid));assert.notEqual(f.m.getE2eeState(f.cid).state,'ready');const late=[];f.m.subscribeE2eeState(f.cid,v=>late.push(v));assert.notEqual(late[0].state,'ready');assert.equal(f.uploads,0);
  if(dimension==='provider'){assert.equal(f.m._providerPersistenceUncertain,true);assert.deepEqual(await f.storage.loadProviderState(f.user,f.device),winner);}else{assert.equal(f.m._providerPersistenceUncertain,false);assert.deepEqual(await f.storage.loadGroupState(f.cid),winner);}
 }finally{f.m.destroy();await f.storage.close();}
});
