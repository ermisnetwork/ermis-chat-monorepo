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
 function message(text='receiver',changes={},payload={}){const msg={id:randomUUID(),cid,created_at:'2026-10-11T00:00:00Z',mls_epoch:1,group_generation:generation,user:{id:'sender'},...changes};const aad=m._expectedAadForMessage(cid,cid,msg);msg.mls_ciphertext=senderGroup.create_message(senderProvider,sender,new TextEncoder().encode(JSON.stringify({...payload,text})),aad);senderGroup.save_state(senderProvider);return msg;}
 async function restart(){const n=await manager();n.groups.set(cid,generation?w.Group.load_with_group_id(n.provider,groupId):w.Group.load(n.provider,cid));n._groupGenerations.set(cid,marker);return n;}
 return{w,m,cid,user,device,message,restart,close:async()=>{await originalStorage.close();senderGroup.free();sender.free();senderProvider.free();}};
}
test('realtime plaintext/dedup/provider swap waits for exact atomic readback, including nonzero generation',async()=>{
 const f=await fixture(2),msg=f.message(),s=f.m.storage,entered=latch(),release=latch(),verify=s.verifyApplicationReceiveCheckpoint.bind(s),provider=f.m._activeProvider,group=f.m.getGroup(f.cid);
 s.verifyApplicationReceiveCheckpoint=async c=>{entered.open();await release.promise;return verify(c);};
 const work=f.m.processE2eeMessage(f.cid,msg);await entered.promise;
 assert.equal(f.m._activeProvider,provider);assert.equal(f.m.getGroup(f.cid),group);assert.equal(f.m._decryptedMsgIds.has(f.m._messageVersionKey(msg)),false);
 assert.throws(()=>f.m.provider,e=>e.code==='provider_mutation_busy');assert.equal((await s.loadMessage(msg.id)).text,'receiver');
 release.open();assert.equal((await work).text,'receiver');assert.notEqual(f.m._activeProvider,provider);assert.equal(f.m._decryptedMsgIds.has(f.m._messageVersionKey(msg)),true);await f.close();
});
for(const failure of ['save','clone','abort','verify'])test(`${failure} failure preserves old active receiver, atomically persisted proof only on committed uncertainty`,async()=>{
 const f=await fixture(),s=f.m.storage,msg=f.message(),provider=f.m._activeProvider,bytes=provider.to_bytes(),base=await s.loadProviderCheckpoint(f.user,f.device);let restore=()=>{};
 if(failure==='save')s.saveApplicationReceiveCheckpoint=async()=>{throw Error('quota receive fixture');};
 if(failure==='clone'){const save=s.saveApplicationReceiveCheckpoint.bind(s);s.saveApplicationReceiveCheckpoint=c=>save({...c,message:{...c.message,invalid:()=>{}}});}
 if(failure==='abort'){const db=await s.openDB(),transaction=db.transaction.bind(db);db.transaction=(...args)=>{const tx=transaction(...args);if(args[1]==='readwrite'&&Array.isArray(args[0]))queueMicrotask(()=>tx.abort());return tx;};restore=()=>db.transaction=transaction;}
 if(failure==='verify')s.verifyApplicationReceiveCheckpoint=async()=>false;
 await assert.rejects(f.m._receiveApplicationCheckpoint(f.cid,f.cid,msg));restore();assert.equal(f.m._activeProvider,provider);assert.deepEqual(provider.to_bytes(),bytes);assert.equal(f.m._decryptedMsgIds.size,0);
 if(failure==='verify'){assert.equal(f.m._providerPersistenceUncertain,true);assert.equal((await s.loadMessage(msg.id)).text,'receiver');const n=await f.restart();assert.equal((await n.processE2eeMessage(f.cid,msg)).text,'receiver');const next=f.message('after restart');assert.equal((await n.processE2eeMessage(f.cid,next)).text,'after restart');await n.storage.close();}
 else{assert.equal(await s.loadMessage(msg.id),null);assert.deepEqual(await s.loadProviderCheckpoint(f.user,f.device),base);assert.equal(f.m._providerPersistenceUncertain,false);if(failure!=='save'&&failure!=='clone')assert.equal((await f.m._receiveApplicationCheckpoint(f.cid,f.cid,msg)).text,'receiver');}await f.close();
});
test('stale receiver CAS preserves winner private KeyPackage/cursor/provider and never caches decoded plaintext',async()=>{
 const f=await fixture(),msg=f.message(),other=await f.restart(),kp=other.identity.key_package_typed(other.provider),ref=kp.hash_ref(other.provider);kp.free();await other._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:{created_at:'2026-10-11T00:00:01Z',event_id:randomUUID()}}});const winner=await other.storage.loadProviderCheckpoint(f.user,f.device);
 await assert.rejects(f.m.processE2eeMessage(f.cid,msg),e=>e.code==='provider_checkpoint_conflict');assert.deepEqual(await other.storage.loadProviderCheckpoint(f.user,f.device),winner);assert.equal(await other.storage.loadMessage(msg.id),null);assert.equal(f.m._providerPersistenceUncertain,true);
 const p=f.w.Provider.from_bytes(winner.provider_bytes);assert.equal(other.identity.owns_key_package_ref(p,ref),true);p.free();assert.equal((await other.processE2eeMessage(f.cid,msg)).text,'receiver');await other.storage.close();await f.close();
});
for(const changes of [{type:'deleted',display_type:'deleted'},{last_event_seq:20}])test('concurrent projection conflict atomically preserves provider and '+Object.keys(changes)[0],async()=>{
 const f=await fixture(),msg=f.message('old',{last_event_seq:2}),s=f.m.storage,save=s.saveApplicationReceiveCheckpoint.bind(s),base=await s.loadProviderCheckpoint(f.user,f.device);
 s.saveApplicationReceiveCheckpoint=async c=>{await s.saveMessage({...c.message,text:'newer',...changes});await save(c);};await assert.rejects(f.m.processE2eeMessage(f.cid,msg),e=>e.code==='application_receive_conflict');assert.equal((await s.loadMessage(msg.id)).text,'newer');assert.deepEqual(await s.loadProviderCheckpoint(f.user,f.device),base);assert.equal(f.m._providerPersistenceUncertain,false);await f.close();
});
test('duplicate queued receives share durable proof without replaying consumed secret; restart receives later messages',async()=>{
 const f=await fixture(),msg=f.message(),results=await Promise.all([f.m._receiveApplicationCheckpoint(f.cid,f.cid,msg),f.m._receiveApplicationCheckpoint(f.cid,f.cid,msg)]);assert.equal(results[0].text,'receiver');assert.equal(results[1].text,'receiver');
 const checkpoint=await f.m.storage.loadProviderCheckpoint(f.user,f.device);assert.equal((await f.m.processE2eeMessage(f.cid,msg)).text,'receiver');assert.deepEqual(await f.m.storage.loadProviderCheckpoint(f.user,f.device),checkpoint);const n=await f.restart();assert.equal((await n.processE2eeMessage(f.cid,f.message('next'))).text,'next');await n.storage.close();await f.close();
});
test('missing paired capability rejects before candidate mutation; manifest/AAD failures preserve active and durable receiver',async()=>{
 const f=await fixture(),msg=f.message(),s=f.m.storage,base=await s.loadProviderCheckpoint(f.user,f.device),provider=f.m._activeProvider;
 s.applicationReceiveCheckpointVersion=undefined;await assert.rejects(f.m.processE2eeMessage(f.cid,msg),e=>e.code==='client_upgrade_required');s.applicationReceiveCheckpointVersion=1;
 const attachment=randomUUID(),invalid=f.message('invalid');invalid.e2ee_attachment_ids=[attachment];await assert.rejects(f.m._receiveApplicationCheckpoint(f.cid,f.cid,invalid));
 const manifest=f.message('manifest',{}, {attachments:[{version:1,attachment_id:attachment}]});await assert.rejects(f.m._receiveApplicationCheckpoint(f.cid,f.cid,manifest),/manifest\/envelope id mismatch/);
 assert.equal(f.m._activeProvider,provider);assert.deepEqual(await s.loadProviderCheckpoint(f.user,f.device),base);assert.equal(await s.loadMessage(invalid.id),null);assert.equal(await s.loadMessage(manifest.id),null);assert.equal((await f.m.processE2eeMessage(f.cid,msg)).text,'receiver');await f.close();
});
test('scope replacement during checkpoint or cache wait suppresses publication and never touches replacement adapter',async()=>{
 for(const phase of ['readback','cache']){const f=await fixture(),msg=f.message(),s=f.m.storage;let touched=0;
 if(phase==='readback'){const verify=s.verifyApplicationReceiveCheckpoint.bind(s);s.verifyApplicationReceiveCheckpoint=async c=>{const proof=await verify(c);f.m.client={activeChannels:{}};return proof;};}
 else{s.loadMessage=async()=>{f.m.storage={loadMessage:async()=>{touched++;}};return null;};}
 await assert.rejects(f.m.processE2eeMessage(f.cid,msg),e=>e.code==='recovery_scope_changed');assert.equal(touched,0);assert.equal(f.m._decryptedMsgIds.size,0);assert.equal(f.m._decryptPromises.size,0);await s.close();await f.close();}
});
test('queue captures scope before admission and caller cannot mutate submitted ciphertext while waiting',async()=>{
 const f=await fixture(),msg=f.message(),entered=latch(),release=latch(),original=new Uint8Array(msg.mls_ciphertext);const lock=f.m._withProviderMutation(async()=>{entered.open();await release.promise;});await entered.promise;
 const work=f.m.processE2eeMessage(f.cid,msg);msg.mls_ciphertext.fill(0);release.open();await lock;assert.equal((await work).text,'receiver');assert.notDeepEqual(msg.mls_ciphertext,original);await f.close();
});
test('receive adapter freezes submitted proof before asynchronous database open and readback verifies every field',async()=>{
 const f=await fixture(),msg=f.message();let submitted;const s=f.m.storage,save=s.saveApplicationReceiveCheckpoint.bind(s);s.saveApplicationReceiveCheckpoint=async c=>{submitted=structuredClone(c);await save(c);};await f.m.processE2eeMessage(f.cid,msg);
 assert.equal(await s.verifyApplicationReceiveCheckpoint(submitted),true);assert.equal(await s.verifyApplicationReceiveCheckpoint({...submitted,message:{...submitted.message,text:'tampered'}}),false);
 await assert.rejects(save({...submitted,provider_write_guard:undefined}),e=>e.code==='application_receive_checkpoint_invalid');await assert.rejects(s.verifyApplicationReceiveCheckpoint({...submitted,provider_write_guard:undefined}),e=>e.code==='application_receive_checkpoint_invalid');
 const open=s.openDB.bind(s),gate=latch(),entered=latch();s.openDB=async()=>{entered.open();await gate.promise;return open();};
 const base=await open();void base;submitted.provider_write_guard={expected_revision:submitted.provider_write_guard.next_revision,next_revision:randomUUID()};const expected=structuredClone(submitted),work=save(submitted);await entered.promise;submitted.message.text='late mutation';submitted.provider_bytes.fill(0);gate.open();await work;s.openDB=open;assert.equal(await s.verifyApplicationReceiveCheckpoint(expected),true);await f.close();
});
test('concurrent same-version different ciphertext and edited content must never share an in-flight plaintext promise',async()=>{
 const f=await fixture(),id=randomUUID(),first=f.message('first',{id,last_event_seq:1}),second=f.message('edited',{id,last_event_seq:2});
 const results=await Promise.all([f.m.processE2eeMessage(f.cid,first),f.m.processE2eeMessage(f.cid,second)]);assert.equal(results[0].text,'first');assert.equal(results[1].text,'edited');assert.equal((await f.m.storage.loadMessage(id)).text,'edited');assert.equal(f.m._decryptPromises.size,0);await f.close();
});
test('committed uncertainty cannot publish cached plaintext until a fresh durable startup',async()=>{
 const f=await fixture(),msg=f.message();f.m.storage.verifyApplicationReceiveCheckpoint=async()=>false;await assert.rejects(f.m.processE2eeMessage(f.cid,msg),e=>e.code==='provider_persistence_uncertain');assert.equal((await f.m.storage.loadMessage(msg.id)).text,'receiver');await assert.rejects(f.m.processE2eeMessage(f.cid,msg),e=>e.code==='provider_persistence_uncertain');const n=await f.restart();assert.equal((await n.processE2eeMessage(f.cid,msg)).text,'receiver');await n.storage.close();await f.close();
});
test('protocol bytes, false epoch and missing sequence cannot consume the application receiver or overwrite a winner',async()=>{
 const f=await fixture(),s=f.m.storage,msg=f.message(),commit=f.m.getGroup(f.cid).self_update(f.m.provider,f.m.identity).commit;
 // The legacy synchronous producer above stages state; restore its durable group before this isolated admission test.
 const n=await f.restart(),base=await s.loadProviderCheckpoint(f.user,f.device);await assert.rejects(n._receiveApplicationCheckpoint(f.cid,f.cid,{...msg,mls_ciphertext:commit}));await assert.rejects(n._receiveApplicationCheckpoint(f.cid,f.cid,{...msg,mls_epoch:90}),e=>e.code==='application_receive_checkpoint_invalid');assert.deepEqual(await s.loadProviderCheckpoint(f.user,f.device),base);
 const save=n.storage.saveApplicationReceiveCheckpoint.bind(n.storage);n.storage.saveApplicationReceiveCheckpoint=async c=>{await n.storage.saveMessage({...c.message,text:'winner',last_event_seq:100});await save(c);};await assert.rejects(n.processE2eeMessage(f.cid,msg),e=>e.code==='application_receive_conflict');assert.deepEqual(await s.loadProviderCheckpoint(f.user,f.device),base);assert.equal((await s.loadMessage(msg.id)).text,'winner');await n.storage.close();await f.close();
});


async function withRetainedZeroHistory(){
 const f=await fixture(),old=f.message('uncached old generation'),groupId=new TextEncoder().encode(randomUUID()),next=f.w.Group.create_with_group_id(f.m.provider,f.m.identity,groupId);
 next.save_state(f.m.provider);f.m.groups.set(f.cid,next);f.m._groupGenerations.set(f.cid,{cid:f.cid,group_generation:1,group_id:groupId,current_epoch:0,status:'active',updated_at:Date.now()});await f.m._writeMlsMutation(f.cid,null);return {...f,old,next,groupId};
}
test('history decrypts uncached generation0 using the retained native group while generation1 stays active',async()=>{
 const f=await withRetainedZeroHistory(),active=f.m.getGroup(f.cid),marker=structuredClone(f.m._groupGenerations.get(f.cid));assert.equal(await f.m.storage.loadMessage(f.old.id),null);
 const result=await f.m.decryptApplicationMessages(f.cid,[f.old]);assert.equal(result.decrypted.length,1);assert.equal(result.decrypted[0].text,'uncached old generation');assert.equal(result.buffered.length,0);assert.equal(f.m.getGroup(f.cid),active);assert.deepEqual(f.m._groupGenerations.get(f.cid),marker);assert.equal(Number(active.epoch()),0);
 const duplicate=await f.m.decryptApplicationMessages(f.cid,[f.old]);assert.equal(duplicate.decrypted[0].text,'uncached old generation');assert.equal((await f.m.storage.loadMessage(f.old.id)).mls_application_checkpoint_version,1);await f.close();
});

test('retained history never uses the realtime current-generation route or decrypts a missing private group',async()=>{
 const f=await withRetainedZeroHistory(),before=f.m.provider.to_bytes();assert.equal(await f.m.processE2eeMessage(f.cid,f.old),null);assert.deepEqual(f.m.provider.to_bytes(),before);assert.equal(await f.m.storage.loadMessage(f.old.id),null);await f.close();
 const g=await fixture(1),message=g.message('foreign generation',{group_generation:0}),bytes=g.m.provider.to_bytes();const result=await g.m.decryptApplicationMessages(g.cid,[message]);assert.equal(result.decrypted.length,0);assert.equal(result.buffered.length,1);assert.deepEqual(g.m.provider.to_bytes(),bytes);assert.equal(await g.m.storage.loadMessage(message.id),null);await g.close();
});
for(const fault of ['abort','verify','owner'])test('retained-history '+fault+' preserves current group and exact durable outcome',async()=>{
 const f=await withRetainedZeroHistory(),active=f.m.getGroup(f.cid),marker=structuredClone(f.m._groupGenerations.get(f.cid)),before=f.m.provider.to_bytes(),s=f.m.storage;
 if(fault==='abort')s.saveApplicationReceiveCheckpoint=async()=>{throw Object.assign(Error('aborted'),{checkpoint_outcome:'aborted'});};
 if(fault==='verify')s.verifyApplicationReceiveCheckpoint=async()=>false;
 if(fault==='owner'){const verify=s.verifyApplicationReceiveCheckpoint.bind(s);s.verifyApplicationReceiveCheckpoint=async cp=>{const ok=await verify(cp);f.m.client={activeChannels:{}};return ok;};}
 await assert.rejects(f.m._receiveApplicationCheckpoint(f.cid,f.cid,f.old,0));assert.equal(f.m.getGroup(f.cid),active);assert.deepEqual(f.m._groupGenerations.get(f.cid),marker);assert.deepEqual(f.m._activeProvider.to_bytes(),before);
 if(fault==='abort')assert.equal(await s.loadMessage(f.old.id),null);else assert.equal((await s.loadMessage(f.old.id)).text,'uncached old generation');
 if(fault==='verify'){
  const n=new EncryptionManager();Object.assign(n,{storage:new IndexedDBEncryptionStorage(f.user),userId:f.user,deviceId:f.device,_injectedWasm:f.w,_wasmArtifactSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))).digest('hex')});await n._initWasm();await n._initIdentity();await n._restoreGroupsLocally();n.initialized=true;n.client={activeChannels:{},state:{users:{}},dispatchEvent(){}};n._clearRepairIssue=async()=>{};n._recordRepairIssue=async()=>{};
  const recovered=await n.decryptApplicationMessages(f.cid,[f.old]);assert.equal(recovered.decrypted[0].text,'uncached old generation');assert.equal(n._groupGenerations.get(f.cid).group_generation,1);await n.storage.close();
 }
 await f.close();
});
test('new-generation independent peer decrypt continues after retained old-history ratchet persistence',async()=>{
 const f=await withRetainedZeroHistory(),peerProvider=new f.w.Provider(),peer=new f.w.Identity(peerProvider,'current-peer'),kp=peer.key_package_typed(peerProvider),current=f.m.getGroup(f.cid);
 const bundle=current.add_members(f.m.provider,f.m.identity,[kp]);current.merge_pending_commit(f.m.provider);current.save_state(f.m.provider);f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:1});await f.m._writeMlsMutation(f.cid,null);
 const peerGroup=f.w.Group.join(peerProvider,bundle.welcome,current.export_ratchet_tree());const old=await f.m.decryptApplicationMessages(f.cid,[f.old]);assert.equal(old.decrypted[0].text,'uncached old generation');assert.equal(f.m.getGroup(f.cid),current);
 const message={id:randomUUID(),cid:f.cid,group_generation:1,mls_epoch:1,user:{id:'current-peer'},created_at:'2026-10-20T00:00:00Z'};message.mls_ciphertext=peerGroup.create_message(peerProvider,peer,new TextEncoder().encode(JSON.stringify({text:'new generation still decrypts'})));
 assert.equal((await f.m.processE2eeMessage(f.cid,message)).text,'new generation still decrypts');assert.equal(f.m._groupGenerations.get(f.cid).group_generation,1);peerGroup.free();peer.free();peerProvider.free();await f.close();
});
