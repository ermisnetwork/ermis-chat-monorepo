const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{webcrypto,randomUUID}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {EncryptionManager,IndexedDBEncryptionStorage}=require('../dist/encryption/index.cjs');
let sequence=0,wasmPromise;
function latch(){let open;const promise=new Promise(r=>open=r);return{promise,open};}
async function fixture(generation=0){
 const w=await(wasmPromise??=(async()=>{const w=await import(pathToFileURL(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm.js')));await w.default({module_or_path:fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))});return w;})());
 const user=`receive-checkpoint-${++sequence}`,device='device',cid=`team:receive-${sequence}`,groupId=new TextEncoder().encode(randomUUID());
 async function manager(){const m=new EncryptionManager(),storage=new IndexedDBEncryptionStorage(user);Object.assign(m,{storage,userId:user,deviceId:device,_injectedWasm:w});await m._initWasm();await m._initIdentity();m.initialized=true;m.client={activeChannels:{},user:{id:user},state:{users:{}},dispatchEvent:()=>{}};m._buildFullMessageWithQuoted=async m=>m;m._clearRepairIssue=async()=>{};m._recordRepairIssue=async()=>{};m._rememberPendingE2eeSnapshot=async()=>{};return m;}
 const m=await manager(),originalStorage=m.storage,senderProvider=new w.Provider(),sender=new w.Identity(senderProvider,'sender');
 const senderGroup=generation?w.Group.create_with_group_id(senderProvider,sender,groupId):w.Group.create_with_cid(senderProvider,sender,cid);
 const kp=m.identity.key_package_typed(m.provider),bundle=senderGroup.add_members(senderProvider,sender,[kp]);senderGroup.merge_pending_commit(senderProvider);senderGroup.save_state(senderProvider);
 m.groups.set(cid,w.Group.join(m.provider,bundle.welcome,senderGroup.export_ratchet_tree()));
 const marker={cid,group_generation:generation,group_id:generation?groupId:null,current_epoch:1,status:'active',updated_at:1};m._groupGenerations.set(cid,marker);await m._persistProviderStrict();
 function message(text='receiver',changes={},payload={}){const msg={id:randomUUID(),cid,created_at:'2026-10-11T00:00:00Z',mls_epoch:1,group_generation:generation,user:{id:'sender'},...changes};const aad=m._expectedAadForMessage(cid,cid,msg);const bytes=new TextEncoder().encode(JSON.stringify({...payload,text}));msg.mls_ciphertext=aad?senderGroup.create_message_with_aad(senderProvider,sender,bytes,aad):senderGroup.create_message(senderProvider,sender,bytes);senderGroup.save_state(senderProvider);return msg;}
 async function restart(){const n=await manager();n.groups.set(cid,generation?w.Group.load_with_group_id(n.provider,groupId):w.Group.load(n.provider,cid));n._groupGenerations.set(cid,marker);return n;}
 return{w,m,cid,user,device,message,restart,senderProvider,sender,senderGroup,marker,close:async()=>{await originalStorage.close();senderGroup.free();sender.free();senderProvider.free();}};
}

async function pastProof(changes={}) {
 const f=await fixture(),msg=f.message('persisted historical plaintext');await f.m.processE2eeMessage(f.cid,msg);
 const cached=await f.m.storage.loadMessage(msg.id);delete cached.mls_application_checkpoint_version;delete cached.mls_aad_sha256;
 Object.assign(cached,changes);await f.m.storage.saveMessage(cached);
 const g=f.m.getGroup(f.cid);g.self_update(f.m.provider,f.m.identity);g.merge_pending_commit(f.m.provider);g.save_state(f.m.provider);await f.m._persistProviderStrict();return{...f,msg,cached};
}
test('consumed ciphertext without exact plaintext proof stays buffered',async()=>{
 const f=await fixture(),msg=f.message();// Simulate a previously shipped legacy consumer that consumed without a plaintext proof.
 f.m.groups.get(f.cid).process_application_message(f.m.provider,msg.mls_ciphertext,undefined);f.m.groups.get(f.cid).save_state(f.m.provider);await f.m._persistProviderStrict();
 const result=await f.m.decryptApplicationMessages(f.cid,[msg]);assert.deepEqual(result.decrypted,[]);assert.deepEqual(result.buffered,[msg]);assert.equal(f.m._decryptedMsgIds.size,0);await f.close();
});
test('cached encrypted envelope cannot skip real waterfall decrypt',async()=>{
 const f=await fixture(),msg=f.message();await f.m.storage.saveMessage({...msg,content_type:'mls',text:'',type:'regular',user_id:'sender'});
 const result=await f.m.decryptApplicationMessages(f.cid,[msg]);assert.equal(result.decrypted[0].text,'receiver');assert.equal(result.decrypted[0].mls_application_checkpoint_version,1);assert.deepEqual(result.buffered,[]);await f.close();
});
test('consumed encrypted cache without plaintext remains buffered',async()=>{
 const f=await fixture(),msg=f.message();// Simulate a previously shipped legacy consumer that consumed without a plaintext proof.
 f.m.groups.get(f.cid).process_application_message(f.m.provider,msg.mls_ciphertext,undefined);f.m.groups.get(f.cid).save_state(f.m.provider);await f.m._persistProviderStrict();await f.m.storage.saveMessage({...msg,content_type:'mls',text:'',type:'regular',user_id:'sender'});
 const result=await f.m.decryptApplicationMessages(f.cid,[msg]);assert.deepEqual(result.decrypted,[]);assert.deepEqual(result.buffered,[msg]);await f.close();
});
test('invalid encoded ciphertext stays buffered without touching ratchet',async()=>{
 const f=await fixture(),msg={...f.message(),mls_ciphertext:'invalid!'},before=await f.m.storage.loadProviderCheckpoint(f.user,f.device);
 const result=await f.m.decryptApplicationMessages(f.cid,[msg]);assert.deepEqual(result.buffered,[msg]);assert.deepEqual(await f.m.storage.loadProviderCheckpoint(f.user,f.device),before);await f.close();
});
test('same-epoch legacy exact proof gets a verified atomic upgrade without replaying consumed secret',async()=>{
 const f=await fixture(),msg=f.message();await f.m.processE2eeMessage(f.cid,msg);const cached=await f.m.storage.loadMessage(msg.id);delete cached.mls_application_checkpoint_version;delete cached.mls_aad_sha256;await f.m.storage.saveMessage(cached);
 const result=await f.m.decryptApplicationMessages(f.cid,[msg]);assert.equal(result.decrypted[0].text,'receiver');assert.equal(result.decrypted[0].mls_application_checkpoint_version,1);assert.deepEqual(result.buffered,[]);await f.close();
});
test('mismatched ciphertext proof cannot authorize consumed success',async()=>{
 const f=await fixture(),msg=f.message();await f.m.processE2eeMessage(f.cid,msg);const cached=await f.m.storage.loadMessage(msg.id);await f.m.storage.saveMessage({...cached,mls_ciphertext_hash:'wrong'});
 const result=await f.m.decryptApplicationMessages(f.cid,[msg]);assert.deepEqual(result.decrypted,[]);assert.deepEqual(result.buffered,[msg]);await f.close();
});
test('committed receive readback failure rejects waterfall and blocks completion',async()=>{
 const f=await fixture(),msg=f.message();f.m.storage.verifyApplicationReceiveCheckpoint=async()=>false;
 await assert.rejects(f.m.decryptApplicationMessages(f.cid,[msg]),e=>e.code==='provider_persistence_uncertain');assert.equal(f.m._decryptedMsgIds.size,0);assert.equal((await f.m.storage.loadMessage(msg.id)).text,'receiver');await f.close();
});
test('aborted receive leaves ratchet untouched and event buffered; retry decrypts exact bytes',async()=>{
 const f=await fixture(),msg=f.message(),s=f.m.storage,save=s.saveApplicationReceiveCheckpoint.bind(s),base=await s.loadProviderCheckpoint(f.user,f.device);s.saveApplicationReceiveCheckpoint=async()=>{throw Error('synthetic save failure');};
 const result=await f.m.decryptApplicationMessages(f.cid,[msg]);assert.deepEqual(result.buffered,[msg]);assert.equal(f.m._decryptedMsgIds.size,0);assert.equal(f.m._pendingApplicationWrites.size,0);assert.deepEqual(await s.loadProviderCheckpoint(f.user,f.device),base);assert.equal(await s.loadMessage(msg.id),null);
 s.saveApplicationReceiveCheckpoint=save;assert.equal((await f.m.decryptApplicationMessages(f.cid,[msg])).decrypted[0].text,'receiver');await f.close();
});
test('waterfall waits for atomic provider/plaintext readback before publishing even the first row',async()=>{
 const f=await fixture(3),s=f.m.storage,msg=f.message(),entered=latch(),release=latch(),verify=s.verifyApplicationReceiveCheckpoint.bind(s),provider=f.m._activeProvider;let returned=false;
 s.verifyApplicationReceiveCheckpoint=async c=>{entered.open();await release.promise;return verify(c);};
 const work=f.m.decryptApplicationMessages(f.cid,[msg]).then(r=>{returned=true;return r;});await entered.promise;assert.equal(returned,false);assert.equal(f.m._activeProvider,provider);assert.equal(f.m._decryptedMsgIds.size,0);assert.equal((await s.loadMessage(msg.id)).mls_application_checkpoint_version,1);
 release.open();assert.equal((await work).decrypted[0].text,'receiver');assert.notEqual(f.m._activeProvider,provider);await f.close();
});
test('a failed second row preserves verified prefix and leaves exact ciphertext available for retry',async()=>{
 const f=await fixture(),first=f.message('first',{created_at:'2026-10-11T00:00:00Z'}),second=f.message('second',{created_at:'2026-10-11T00:00:01Z'}),s=f.m.storage,save=s.saveApplicationReceiveCheckpoint.bind(s);
 s.saveApplicationReceiveCheckpoint=async c=>{if(c.message.id===second.id)throw Error('quota second row');return save(c);};
 const result=await f.m.decryptApplicationMessages(f.cid,[second,first]);assert.equal(result.decrypted.length,1);assert.equal(result.decrypted[0].id,first.id);assert.deepEqual(result.buffered,[second]);assert.equal(await s.loadMessage(second.id),null);s.saveApplicationReceiveCheckpoint=save;
 const n=await f.restart(),retry=await n.decryptApplicationMessages(f.cid,[first,second]);assert.deepEqual(retry.decrypted.map(r=>r.text),['first','second']);assert.deepEqual(retry.buffered,[]);await n.storage.close();await f.close();
});
test('provider CAS conflict rejects a whole waterfall before plaintext, cursor or Ready publication',async()=>{
 const f=await fixture(),msg=f.message(),winner=await f.restart(),kp=winner.identity.key_package_typed(winner.provider),ref=kp.hash_ref(winner.provider);kp.free();await winner._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:{created_at:'2026-10-11T00:00:03Z',event_id:randomUUID()}}});const checkpoint=await winner.storage.loadProviderCheckpoint(f.user,f.device);
 await assert.rejects(f.m.decryptApplicationMessages(f.cid,[msg]),e=>e.code==='provider_checkpoint_conflict');assert.deepEqual(await winner.storage.loadProviderCheckpoint(f.user,f.device),checkpoint);assert.equal(await winner.storage.loadMessage(msg.id),null);assert.equal(winner.identity.owns_key_package_ref(winner.provider,ref),true);await winner.storage.close();await f.close();
});
test('late cache or checkpoint session replacement cannot write or return to a replacement scope',async()=>{
 for(const phase of ['cache','verify']){const f=await fixture(),msg=f.message(),s=f.m.storage;let touched=0;
 if(phase==='cache'){s.loadMessage=async()=>{f.m.storage={saveMessage:async()=>{touched++;}};return null;};}
 else{const verify=s.verifyApplicationReceiveCheckpoint.bind(s);s.verifyApplicationReceiveCheckpoint=async c=>{const result=await verify(c);f.m.client={activeChannels:{}};return result;};}
 await assert.rejects(f.m.decryptApplicationMessages(f.cid,[msg]),e=>e.code==='recovery_scope_changed');assert.equal(touched,0);assert.equal(f.m._decryptedMsgIds.size,0);await f.close();}
});
test('atomic cached proof binds AAD and cannot authorize changed metadata or an unproven consumed legacy context',async()=>{
 const f=await fixture(),msg=f.message('forward',{forward_cid:'team:source'});await f.m.processE2eeMessage(f.cid,msg);const changed={...msg,forward_cid:'team:changed'},cached=await f.m.storage.loadMessage(msg.id),base=await f.m.storage.loadProviderCheckpoint(f.user,f.device);
 assert.equal(f.m._cachedMessageMatchesEnvelope(cached,changed,f.cid,msg.mls_ciphertext),false);const rejected=await f.m.decryptApplicationMessages(f.cid,[changed]);assert.deepEqual(rejected.decrypted,[]);assert.deepEqual(rejected.buffered,[changed]);assert.deepEqual(await f.m.storage.loadProviderCheckpoint(f.user,f.device),base);
 delete cached.mls_application_checkpoint_version;delete cached.mls_aad_sha256;await f.m.storage.saveMessage(cached);const legacy=await f.m.decryptApplicationMessages(f.cid,[msg]);assert.deepEqual(legacy.decrypted,[]);assert.deepEqual(legacy.buffered,[msg]);assert.equal(await f.m.processE2eeMessage(f.cid,msg),null);await f.close();
});
test('concurrent waterfall and realtime receive serialize one durable ratchet and exact duplicate proof',async()=>{
 const f=await fixture(),first=f.message('first',{created_at:'2026-10-11T00:00:00Z'}),second=f.message('second',{created_at:'2026-10-11T00:00:01Z'});
 const results=await Promise.all([f.m.decryptApplicationMessages(f.cid,[first,second]),f.m.processE2eeMessage(f.cid,first)]);assert.deepEqual(results[0].decrypted.map(r=>r.text),['first','second']);assert.equal(results[1].text,'first');assert.deepEqual(results[0].buffered,[]);await f.close();
});
test('caller mutation during waterfall waits cannot alter submitted batch ciphertext or routing',async()=>{
 const f=await fixture(),msg=f.message(),entered=latch(),release=latch(),s=f.m.storage,load=s.loadMessage.bind(s);let first=true;
 s.loadMessage=async id=>{if(first){first=false;entered.open();await release.promise;}return load(id);};const work=f.m.decryptApplicationMessages(f.cid,[msg]);await entered.promise;msg.mls_ciphertext.fill(0);msg.cid='team:mutated';release.open();const result=await work;assert.equal(result.decrypted[0].text,'receiver');assert.equal(result.decrypted[0].cid,f.cid);await f.close();
});
test('old pending plaintext flush captures adapter and never deletes a new scope row with the same key',async()=>{
 const f=await fixture(),s=f.m.storage,old={id:'pending',cid:f.cid,text:'old'},replacement={...old,text:'new'};f.m._pendingApplicationWrites.set('key',old);let wrong=0;
 s.saveMessage=async()=>{f.m.storage={saveMessage:async()=>wrong++};f.m._pendingApplicationWrites.set('key',replacement);};await assert.rejects(f.m._flushPendingApplicationWrites(),e=>e.code==='recovery_scope_changed');assert.equal(wrong,0);assert.equal(f.m._pendingApplicationWrites.get('key'),replacement);await f.close();
});
test('past exact legacy proof stays readable and upgrades without obsolete ratchet replay',async()=>{
 const f=await pastProof(),result=await f.m.decryptApplicationMessages(f.cid,[f.msg]);assert.equal(result.decrypted[0].text,f.cached.text);assert.equal(result.decrypted[0].mls_application_checkpoint_version,1);assert.deepEqual(result.buffered,[]);await f.close();
});
test('past legacy upgrade requires verified provider/plaintext persistence',async()=>{
 const f=await pastProof();f.m.storage.verifyApplicationReceiveCheckpoint=async()=>false;await assert.rejects(f.m.decryptApplicationMessages(f.cid,[f.msg]),e=>e.code==='provider_persistence_uncertain');await f.close();
});
for(const changes of [{cid:'team:other'},{mls_epoch:2},{group_generation:1},{e2ee_group_id:'team:other'},{mls_ciphertext_hash:'different'}])test('past cache proof rejects mismatched binding '+Object.keys(changes)[0],async()=>{
 const f=await pastProof(changes),result=await f.m.decryptApplicationMessages(f.cid,[f.msg]);assert.deepEqual(result.decrypted,[]);assert.deepEqual(result.buffered,[f.msg]);await f.close();
});
test('future cached proof cannot skip current receiver mutation',async()=>{
 const f=await fixture(),msg=f.message(),cached={...f.m._storedFromPayload(f.cid,{text:'future cache'},msg),mls_epoch:2};await f.m.storage.saveMessage(cached);
 const future={...msg,mls_epoch:2},base=await f.m.storage.loadProviderCheckpoint(f.user,f.device),result=await f.m.decryptApplicationMessages(f.cid,[future]);assert.deepEqual(result.decrypted,[]);assert.deepEqual(result.buffered,[future]);assert.deepEqual(await f.m.storage.loadProviderCheckpoint(f.user,f.device),base);await f.close();
});
test('WS cache lookup rejects changed ciphertext despite same version',async()=>{
 const f=await fixture(),msg=f.message();await f.m.processE2eeMessage(f.cid,msg);const cached=await f.m.storage.loadMessage(msg.id);assert.equal(f.m._cachedMessageMatchesEnvelope(cached,msg,f.cid,msg.mls_ciphertext),true);assert.equal(f.m._cachedMessageMatchesEnvelope(cached,msg,f.cid,Uint8Array.of(9)),false);await f.close();
});
test('disabled synchronous decrypt rejects before any ratchet or group-save access',()=>{
 const m=new EncryptionManager();let touched=false;m.groups.set('team:strict',{process_application_message:()=>{touched=true;},save_state:()=>{touched=true;}});
 assert.throws(()=>m.decryptMessage('team:strict',Uint8Array.of(1)),e=>e.code==='client_upgrade_required');assert.equal(touched,false);
});

test('global startup sync stops an empty has-more page without advancing cursor or READY', async () => {
  const f = await fixture(), manager = f.m, message = {cid: f.cid};
  const cursor = { created_at: '2026-10-04T00:00:00Z', event_id: 'fixture-event' };
  let requests = 0;
  const states = [];
  manager._restoreGroupsLocally = async () => {};
  manager._resumeExternalJoinCandidates = async () => {}; // Component routing only; no External Join/Ready proof claim.
  manager._loadAllScopeSyncCursors = async () => ({ [message.cid]: cursor });
  manager.storage.loadRemovedSyncCursor = async () => null;
  manager._listKnownE2eeChannels = () => [];
  manager._membershipBoundedEventCursor = () => cursor;
  manager._flushPendingSnapshotsForScope = async () => ({ pending: [] });
  manager._emitSyncState = state => states.push(state);
  manager._saveEncryptionSyncCheckpoint = async options => assert.deepEqual(options.scopeCursors[message.cid], cursor);
  manager._discoverMlsRecoveryStates = async () => ({ states: {}, unsupported: false });
  manager.bootstrapKnownE2eeChannels = async options => assert.deepEqual(options.scopeSyncedCids, []);
  manager.e2eeClient = { scopeSync: async () => {
    if (++requests > 2) throw new Error('would loop without progress');
    return { channels: { [message.cid]: { events: [], has_more: true } } };
  } };
  await manager._syncAndRestoreGroups();
  assert.equal(requests, 1);
  assert.equal(states[0].needs_retry, true);
  assert.notEqual(states[0].status, 'ready'); await f.close();
});
