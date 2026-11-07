const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{webcrypto,randomUUID}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {EncryptionManager,IndexedDBEncryptionStorage}=require('../dist/encryption/index.cjs');
let sequence=0,wasmPromise;
function latch(){let open;const promise=new Promise(r=>open=r);return{promise,open};}
async function fixture(generation=0){
 const w=await(wasmPromise??=(async()=>{const w=await import(pathToFileURL(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm.js')));await w.default({module_or_path:fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))});return w;})());
 const user=`send-checkpoint-${++sequence}`,device='device',cid=`team:send-${sequence}`,groupId=new TextEncoder().encode(randomUUID());
 async function manager(){const m=new EncryptionManager(),storage=new IndexedDBEncryptionStorage(user);Object.assign(m,{storage,userId:user,deviceId:device,_injectedWasm:w,_wasmArtifactSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))).digest('hex')});await m._initWasm();await m._initIdentity();m.initialized=true;m.client={activeChannels:{},user:{id:user},state:{users:{}},dispatchEvent:()=>{}};m._resolveChannelE2eeGroupId=()=>cid;m._buildFullMessageWithQuoted=async m=>m;return m;}
 const m=await manager(),g=generation?w.Group.create_with_group_id(m.provider,m.identity,groupId):w.Group.create_with_cid(m.provider,m.identity,cid);
 m.groups.set(cid,g);m._groupGenerations.set(cid,{cid,group_generation:generation,group_id:generation?groupId:null,current_epoch:0,status:'active',updated_at:1});await m._writeMlsMutation(cid,null);
 if(generation){const control={version:1,user_id:user,device_id:device,cid,group_generation:generation,group_id:groupId,signing_identity_sha256:require('node:crypto').createHash('sha256').update(m.identity.signature_public_key()).digest('hex'),incident_id:null,recovery_action:'none',recovery_revision:'1',repair_retry_until:null};await m.storage.saveRecoveryControlCheckpoint(control);m._recoveryControls.set(cid,control);}
 const calls=[];m.e2eeClient={getMlsGenerationState:async()=>({group_generation:generation,group_id:generation?groupId:null,current_epoch:m.getEpoch(cid)}),sendMessage:async(t,id,body)=>{calls.push({kind:'send',body:structuredClone(body)});return{message:{id:body.message.id,created_at:'2026-10-01T00:00:00Z'}};},updateMessage:async(t,id,mid,body)=>{calls.push({kind:'update',body:structuredClone(body)});return{message:{id:mid,created_at:'2026-10-01T00:00:00Z'}};}};
 return{w,m,user,device,cid,calls,manager,groupId,loadGroup:n=>{n.groups.set(cid,generation?w.Group.load_with_group_id(n.provider,groupId):w.Group.load(n.provider,cid));n._groupGenerations.set(cid,{...m._groupGenerations.get(cid)});if(m._recoveryControls.has(cid))n._recoveryControls.set(cid,structuredClone(m._recoveryControls.get(cid)));},send:(text='fixture',id=randomUUID())=>m.sendMessage('team',cid.slice(5),cid,text,id),close:()=>m.storage.close()};
}
test('unknown sealed intent overrides legacy plaintext cache through storage and channel reopen',async()=>{
 const f=await fixture(),id=randomUUID();let reopened;
 try{
  f.m.e2eeClient.sendMessage=async()=>{throw{response:{status:503,data:{reason:'message_delivery_unknown'}}}};
  await assert.rejects(f.send('retained unsent',id));const pending=await f.m.storage.loadPendingE2eeSend(id),provider=f.m._activeProvider.to_bytes();
  // Reproduce the old optimistic cache writer: text exists without delivery
  // status or a positive server sequence. It is not an acceptance receipt.
  await f.m.storage.saveMessage({id,cid:f.cid,user_id:f.user,text:'retained unsent',content_type:'standard',type:'regular',created_at:'2026-10-30T00:00:00Z'});
  reopened=new IndexedDBEncryptionStorage(f.user);
  const rows=await reopened.getMessages(f.cid,25);assert.equal(rows.find(x=>x.id===id).status,'error');
  assert.equal((await reopened.loadMessages([id])).get(id).status,'error','targeted React cache refresh must use the same pending outcome');
  const {ErmisChat}=require('../dist/index.cjs'),c=new ErmisChat('fixture','project','http://fixture.invalid',{browser:false,logger:()=>{}});
  c._setUser({id:f.user});c.deviceId=f.device;c.encryptionManager=f.m;f.m.client=c;
  const ch=c.channel('team',f.cid.slice(5));ch.data={mls_enabled:true};const loaded=new Promise(resolve=>c.on('e2ee.local_messages_loaded',resolve));
  ch._seedE2eeStateFromLocalCache({messages:{limit:25}},'latest');await loaded;
  assert.equal(ch.state.messages.find(x=>x.id===id).status,'error');assert.equal(ch.state.messages.find(x=>x.id===id).msg_seq,undefined);
  assert.deepEqual(await reopened.loadPendingE2eeSend(id),pending);assert.deepEqual(f.m._activeProvider.to_bytes(),provider);
  assert.equal((await reopened.loadMessage(id)).status,undefined,'read projection never rewrites cache as a receipt');
 }finally{await reopened?.close();await f.close()}
});
for(const status of ['sending','failed_terminal','canceled'])test('pending new-send '+status+' cannot hydrate as accepted from cache',async()=>{
 const f=await fixture(),id=randomUUID();try{
  f.m.e2eeClient.sendMessage=async()=>{throw Error('unknown')};await assert.rejects(f.send('opaque',id));const held=await f.m.storage.loadPendingE2eeSend(id);
  await f.m.storage.savePendingE2eeSendOutcome(held,{...held,status});await f.m.storage.saveMessage({id,cid:f.cid,user_id:f.user,text:'opaque',content_type:'standard',type:'regular',created_at:'2026-10-30T00:00:00Z',status:'received'});
  assert.equal((await f.m.storage.getMessages(f.cid)).find(x=>x.id===id).status,status==='sending'?'sending':'error');
  assert.equal((await f.m.storage.loadMessages([id])).get(id).status,status==='sending'?'sending':'error');
 }finally{await f.close()}
});
for(const mode of ['accepted','edit','other-cid','other-account'])test('pending presentation leaves '+mode+' history unchanged',async()=>{
 const f=await fixture(),id=randomUUID();let other;try{
  f.m.e2eeClient.sendMessage=async()=>{throw Error('unknown')};await assert.rejects(f.send('one',id));const held=await f.m.storage.loadPendingE2eeSend(id),message={id,cid:f.cid,user_id:f.user,text:'accepted history',content_type:'standard',type:'regular',status:'received',msg_seq:100,created_at:'2026-10-30T00:00:00Z'};
  if(mode==='accepted')await f.m.storage.savePendingE2eeSendOutcome(held,{...held,status:'sent'},message);
  if(mode==='edit')await f.m.storage.savePendingE2eeSend({...held,operation_kind:'update'});
  if(mode==='other-cid')await f.m.storage.savePendingE2eeSend({...held,cid:'team:other'});
  const storage=mode==='other-account'?(other=new IndexedDBEncryptionStorage(f.user+'-other')):f.m.storage;
  if(mode!=='accepted')await storage.saveMessage(message);
  assert.equal((await storage.getMessages(f.cid)).find(x=>x.id===id).status,'received');
  assert.equal((await storage.loadMessages([id])).get(id).status,'received');
 }finally{await other?.close();await f.close()}
});
test('pending presentation read abort cannot return cached accepted status',async()=>{
 const f=await fixture(),id=randomUUID();try{
  f.m.e2eeClient.sendMessage=async()=>{throw Error('unknown')};await assert.rejects(f.send('one',id));
  await f.m.storage.saveMessage({id,cid:f.cid,user_id:f.user,text:'one',content_type:'standard',type:'regular',status:'received',created_at:'2026-10-30T00:00:00Z'});
  const db=await f.m.storage.openDB(),transaction=db.transaction.bind(db);db.transaction=(...args)=>{const tx=transaction(...args);queueMicrotask(()=>tx.abort());return tx};
  await assert.rejects(f.m.storage.getMessages(f.cid));db.transaction=transaction;
  assert.equal((await f.m.storage.getMessages(f.cid)).find(x=>x.id===id).status,'error');
 }finally{await f.close()}
});
for(const cap of ['readyCheckpointVersion','saveMlsReadyCheckpoint','verifyMlsReadyCheckpoint'])test(`loaded provider without ${cap} cannot create ciphertext or POST`,async()=>{
 const f=await fixture(),id=randomUUID(),bytes=f.m.provider.to_bytes();f.m.storage[cap]=undefined;
 await assert.rejects(f.send('must be admitted',id),e=>e.code==='client_upgrade_required');
 assert.equal(f.calls.length,0);const held=await f.m.storage.loadPendingE2eeSend(id);assert.equal(held.unsealed_intent_version,1);assert.equal(held.mls_ciphertext,undefined);assert.deepEqual(f.m.provider.to_bytes(),bytes);await f.close();
});
test('Ready readback uncertainty blocks new ciphertext, retaining the exact committed provider',async()=>{
 const f=await fixture(),id=randomUUID(),bytes=f.m.provider.to_bytes();f.m.storage.verifyMlsReadyCheckpoint=async()=>false;
 await assert.rejects(f.send('unproven',id),e=>e.code==='provider_persistence_uncertain');assert.equal(f.calls.length,0);
 assert.equal((await f.m.storage.loadPendingE2eeSend(id)).unsealed_intent_version,1);assert.equal((await f.m.storage.loadPendingE2eeSend(id)).mls_ciphertext,undefined);assert.deepEqual(f.m._activeProvider.to_bytes(),bytes);assert.equal(f.m._providerPersistenceUncertain,true);await f.close();
});
test('foreign provider revision after admission blocks fresh ratchet CAS before POST',async()=>{
 const f=await fixture(),id=randomUUID(),bytes=f.m.provider.to_bytes(),verify=f.m.storage.verifyMlsReadyCheckpoint.bind(f.m.storage);
 let other,winner,injected=false;
 f.m.storage.verifyMlsReadyCheckpoint=async cp=>{const ok=await verify(cp);if(ok&&!injected){injected=true;other=await f.manager();f.loadGroup(other);await other._persistProviderStrict();winner=await other.storage.loadProviderCheckpoint(f.user,f.device);}return ok;};
 try{
  await assert.rejects(f.send('stale proof',id),e=>e.code==='provider_checkpoint_conflict');assert.equal(injected,true);assert.equal(f.calls.length,0);
  const held=await f.m.storage.loadPendingE2eeSend(id);assert.equal(held.unsealed_intent_version,1);assert.equal(held.mls_ciphertext,undefined);
  assert.deepEqual(f.m._activeProvider.to_bytes(),bytes);assert.deepEqual(await f.m.storage.loadProviderCheckpoint(f.user,f.device),winner);
 }finally{await other?.storage.close();await f.close();}
});

test('unknown accepted ciphertext keeps exact retry priority without new admission or encryption',async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw Error('lost response');};await assert.rejects(f.send('exact',id));
 const prior=await f.m.storage.loadPendingE2eeSend(id);f.m.storage.readyCheckpointVersion=undefined;let sent;
 f.m.e2eeClient.sendMessage=async(_t,_c,body)=>{sent=body.message.mls_ciphertext;return{message:{id}};};await f.send('exact',id);
 assert.deepEqual(sent,prior.mls_ciphertext);assert.equal((await f.m.storage.loadPendingE2eeSend(id)).mls_ciphertext_sha256,prior.mls_ciphertext_sha256);await f.close();
});
test('failed unsealed intent waits across restart for explicit retry with the same UUID and payload',async()=>{
 const f=await fixture(),id=randomUUID(),verify=f.m.storage.verifyMlsReadyCheckpoint;
 f.m.storage.readyCheckpointVersion=undefined;await assert.rejects(f.send('retained intent',id),e=>e.code==='client_upgrade_required');
 const held=await f.m.storage.loadPendingE2eeSend(id);assert.equal(held.message_id,id);assert.equal(held.payload.text,'retained intent');assert.equal(held.mls_ciphertext,undefined);
 f.m.storage.readyCheckpointVersion=2;f.m.storage.verifyMlsReadyCheckpoint=verify;
 const resumed=await f.manager();f.loadGroup(resumed);let posted;resumed.e2eeClient={sendMessage:async(_t,_c,body)=>{posted=body.message;return{message:{id}};}};
 resumed.client.channel=()=>({restorePendingE2eeAttachmentUpload:()=>{},updatePendingE2eeAttachmentUpload:()=>{},completePendingE2eeAttachmentUpload:()=>{},failPendingE2eeAttachmentUpload:()=>{}});
 let job;const process=resumed._processQueuedE2eeAttachmentMessage.bind(resumed);resumed._processQueuedE2eeAttachmentMessage=record=>(job=process(record));
 await resumed.resumePendingE2eeSends();assert.equal(job,undefined,'reload must retain an explicitly failed unsealed intent');await resumed.retryPendingE2eeSend(id,f.cid);await job;assert.equal(posted.id,id);assert.ok(posted.mls_ciphertext.length);assert.equal(await resumed.storage.loadPendingE2eeSend(id),null);
 await resumed.storage.close();await f.close();
});
test('unsealed intent cannot change payload or silently cross a generation',async()=>{
 const f=await fixture(),id=randomUUID();f.m.storage.readyCheckpointVersion=undefined;await assert.rejects(f.send('original',id));
 await assert.rejects(f.send('different',id),e=>e.code==='pending_send_conflict');const original=await f.m.storage.loadPendingE2eeSend(id);
 f.m.storage.readyCheckpointVersion=2;f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),group_generation:1});
 await assert.rejects(f.send('original',id),e=>e.code==='old_group_generation');assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),original);assert.equal(f.calls.length,0);await f.close();
});
test('queued cancellation after unknown HTTP retains exact ciphertext instead of deleting its obligation',async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw Error('offline');};await assert.rejects(f.send('unknown',id));
 const job=await f.m.storage.loadPendingE2eeSend(id);f.m.e2eeClient.sendMessage=async()=>{await f.m.cancelPendingE2eeSend(id);throw Error('lost response after cancel');};
 await f.m._processQueuedE2eeAttachmentMessage(job);const held=await f.m.storage.loadPendingE2eeSend(id);
 assert.equal(held.status,'canceled');assert.equal(held.last_error,'acceptance_unknown_after_cancel');assert.deepEqual(held.mls_ciphertext,job.mls_ciphertext);assert.equal(held.message_id,id);await f.close();
});
test('canceling an unsealed intent retains it across reopen and prevents automatic encryption',async()=>{
 const f=await fixture(),id=randomUUID();f.m.storage.readyCheckpointVersion=undefined;await assert.rejects(f.send('cancel original',id));
 await f.m.cancelPendingE2eeSend(id);const held=await f.m.storage.loadPendingE2eeSend(id);assert.equal(held.status,'canceled');assert.equal(held.payload.text,'cancel original');assert.equal(held.mls_ciphertext,undefined);
 const resumed=await f.manager();f.loadGroup(resumed);await assert.rejects(resumed._prepareApplicationSend(held),e=>e.code==='pending_send_conflict');assert.deepEqual(await resumed.storage.loadPendingE2eeSend(id),held);assert.equal(f.calls.length,0);await resumed.storage.close();await f.close();
});
test('late direct-send failure cannot revive a canceled exact ciphertext for automatic retry',async()=>{
 const f=await fixture(),id=randomUUID(),entered=latch(),release=latch();f.m.e2eeClient.sendMessage=async()=>{entered.open();await release.promise;throw Error('late unknown response');};
 const work=f.send('keep canceled',id),rejected=assert.rejects(work);await entered.promise;await f.m.cancelPendingE2eeSend(id);const canceled=await f.m.storage.loadPendingE2eeSend(id);release.open();await rejected;
 assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),canceled);assert.equal(canceled.status,'canceled');let posts=0;f.m.e2eeClient.sendMessage=async()=>{posts++;return{message:{id}};};await assert.rejects(f.m._sendPersistedPendingE2eeRecord(canceled),e=>e.code==='pending_send_conflict');assert.equal(posts,0);assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),canceled);await f.close();
});
test('concurrent reservations retain one exact intent and fence a changed payload',async()=>{
 const f=await fixture(),id=randomUUID();f.m.storage.readyCheckpointVersion=undefined;await assert.rejects(f.send('winner',id));
 const held=await f.m.storage.loadPendingE2eeSend(id),base=await f.m.storage.loadProviderCheckpoint(f.user,f.device),owner={...base,identity_bytes:f.m.identity.to_bytes()};
 const outcomes=await Promise.allSettled([f.m.storage.reserveApplicationIntent(held,owner,()=>{}),f.m.storage.reserveApplicationIntent({...held,payload:{text:'loser'}},owner,()=>{})]);
 assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].status,'rejected');assert.equal(outcomes[1].reason.code,'pending_send_conflict');assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),held);assert.deepEqual(await f.m.storage.loadProviderCheckpoint(f.user,f.device),base);await f.close();
});
for(const kind of ['send','update'])test(`${kind} cannot reach HTTP or swap active ratchet before exact provider+pending readback`,async()=>{
 const f=await fixture(1),s=f.m.storage,entered=latch(),release=latch(),verify=s.verifyEncryptionSyncCheckpoint.bind(s),provider=f.m._activeProvider,group=f.m.getGroup(f.cid),id=randomUUID();
 s.verifyEncryptionSyncCheckpoint=async c=>{if(c.pending_sends){entered.open();await release.promise;}return verify(c);};
 const work=kind==='send'?f.send('durable',id):f.m.updateMessage('team',f.cid.slice(5),f.cid,id,'durable');await entered.promise;
 assert.equal(f.calls.length,0);assert.equal(f.m._activeProvider,provider);assert.equal(f.m.getGroup(f.cid),group);assert.throws(()=>f.m.provider,e=>e.code==='provider_mutation_busy');
 const pending=await s.loadPendingE2eeSend(id);assert.ok(pending.mls_ciphertext.length>0);release.open();await work;assert.equal(f.calls[0].kind,kind);assert.notEqual(f.m._activeProvider,provider);assert.deepEqual(f.calls[0].body.message.mls_ciphertext,pending.mls_ciphertext);assert.equal((await s.loadPendingE2eeSend(id)).status,'sent');await f.close();
});
for(const failure of ['save','clone','abort','verify'])test(`${failure} failure sends no HTTP and retains old active ratchet or committed retry job`,async()=>{
 const f=await fixture(),s=f.m.storage,base=await s.loadProviderCheckpoint(f.user,f.device),provider=f.m._activeProvider,active=provider.to_bytes(),group=f.m.getGroup(f.cid),id=randomUUID();let restore=()=>{};
 if(failure==='save')s.saveEncryptionSyncCheckpoint=async()=>{throw new Error('quota fixture');};
 if(failure==='clone'){const save=s.saveEncryptionSyncCheckpoint.bind(s);s.saveEncryptionSyncCheckpoint=c=>save({...c,pending_sends:[{...c.pending_sends[0],files:[()=>{}]}]});}
 if(failure==='abort'){const db=await s.openDB(),tx=db.transaction.bind(db);db.transaction=(...args)=>{const t=tx(...args);if(args[1]==='readwrite'&&Array.isArray(args[0]))queueMicrotask(()=>t.abort());return t;};restore=()=>db.transaction=tx;}
 if(failure==='verify')s.verifyEncryptionSyncCheckpoint=async()=>false;
 await assert.rejects(f.send('never posted',id));restore();assert.equal(f.calls.length,0);assert.equal(f.m._activeProvider,provider);assert.equal(f.m.getGroup(f.cid),group);assert.deepEqual(provider.to_bytes(),active);
 if(failure==='verify'){assert.equal(f.m._providerPersistenceUncertain,true);assert.ok((await s.loadPendingE2eeSend(id)).mls_ciphertext);assert.notEqual((await s.loadProviderCheckpoint(f.user,f.device)).revision,base.revision);}
 else{assert.equal(f.m._providerPersistenceUncertain,false);const held=await s.loadPendingE2eeSend(id);if(failure==='abort')assert.equal(held,null);else{assert.equal(held.unsealed_intent_version,1);assert.equal(held.mls_ciphertext,undefined);}const current=await s.loadProviderCheckpoint(f.user,f.device);assert.deepEqual(current.provider_bytes,base.provider_bytes);if(failure==='abort')assert.equal(current.revision,base.revision);else{const admitted=await s.loadMlsReadyBase(f.user,f.device,f.cid);assert.equal(current.revision,admitted.ready.provider_revision);assert.equal(current.revision,base.revision);}}await f.close();
});
test('stale sender cannot overwrite winner private KP, provider/cursor or pending job',async()=>{
 const f=await fixture(),other=await f.manager();f.loadGroup(other);const kp=other.identity.key_package_typed(other.provider),ref=kp.hash_ref(other.provider);kp.free();await other._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:{created_at:'2026-10-01T00:00:01Z',event_id:randomUUID()}}});const winner=await other.storage.loadProviderCheckpoint(f.user,f.device);
 await assert.rejects(f.send(),e=>e.code==='provider_checkpoint_conflict');assert.equal(f.m._providerPersistenceUncertain,true);assert.equal(f.calls.length,0);assert.deepEqual(await other.storage.loadProviderCheckpoint(f.user,f.device),winner);const p=f.w.Provider.from_bytes(winner.provider_bytes);assert.equal(other.identity.owns_key_package_ref(p,ref),true);p.free();await other.storage.close();await f.close();
});
test('missing outbound capability rejects before mutation or HTTP',async()=>{
 const f=await fixture(),p=f.m._activeProvider,before=p.to_bytes();f.m.storage.applicationSendCheckpointVersion=undefined;await assert.rejects(f.send(),e=>e.code==='client_upgrade_required');assert.deepEqual(p.to_bytes(),before);assert.equal(f.calls.length,0);await f.close();
});
test('ambiguous retry and restart preserve exact ciphertext and edit endpoint',async()=>{
 for(const kind of ['send','update']){const f=await fixture(1),id=randomUUID();f.m.e2eeClient[kind==='send'?'sendMessage':'updateMessage']=async(...args)=>{f.calls.push(structuredClone(args[kind==='send'?2:3]));throw new Error('lost response');};const work=()=>kind==='send'?f.send('unchanged',id):f.m.updateMessage('team',f.cid.slice(5),f.cid,id,'unchanged');await assert.rejects(work());const record=await f.m.storage.loadPendingE2eeSend(id),revision=(await f.m.storage.loadProviderCheckpoint(f.user,f.device)).revision;
 await assert.rejects(work());assert.deepEqual(f.calls[0].message.mls_ciphertext,f.calls[1].message.mls_ciphertext);assert.equal((await f.m.storage.loadProviderCheckpoint(f.user,f.device)).revision,revision);
 const resumed=await f.manager();f.loadGroup(resumed);let endpoint;resumed.e2eeClient={getMlsGenerationState:async()=>({group_generation:1,group_id:f.groupId,current_epoch:0}),sendMessage:async()=>{endpoint='send';return{message:{id}};},updateMessage:async(_t,_c,_id,body)=>{endpoint='update';assert.deepEqual(body.message.mls_ciphertext,record.mls_ciphertext);return{message:{id}};}};await resumed._sendPersistedPendingE2eeRecord(record);assert.equal(endpoint,kind);assert.equal((await resumed.storage.loadPendingE2eeSend(id)).status,'sent');await resumed.storage.close();await f.close();}
});
test('one epoch-stale retry replaces durable bytes; second failure/reopen retain updated job',async()=>{
 const f=await fixture(),id=randomUUID();f.m._recoverEpochStaleGroup=async()=>{const g=f.m.getGroup(f.cid);g.self_update(f.m.provider,f.m.identity);g.merge_pending_commit(f.m.provider);g.save_state(f.m.provider);f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:Number(g.epoch())});await f.m._writeMlsMutation(f.cid,null);};f.m.e2eeClient.sendMessage=async(_t,_c,body)=>{f.calls.push(structuredClone(body));throw {response:{status:400,data:{message:'epoch_stale: current epoch differs'}}};};await assert.rejects(f.send('retry',id));assert.equal(f.calls.length,2);assert.notDeepEqual(f.calls[0].message.mls_ciphertext,f.calls[1].message.mls_ciphertext);const pending=await f.m.storage.loadPendingE2eeSend(id);assert.deepEqual(pending.mls_ciphertext,f.calls[1].message.mls_ciphertext);assert.equal(pending.mls_epoch,1);assert.equal(pending.status,'failed_retryable');await f.close();const s=new IndexedDBEncryptionStorage(f.user);assert.deepEqual((await s.loadPendingE2eeSend(id)).mls_ciphertext,pending.mls_ciphertext);await s.close();
});
test('stale HTTP outcome/update/delete cannot replace a newer ciphertext job',async()=>{
 const f=await fixture(),id=randomUUID(),entered=latch(),release=latch();f.m.e2eeClient.sendMessage=async()=>{entered.open();await release.promise;return{message:{id}};};const work=f.send('old',id),rejected=assert.rejects(work,e=>e.code==='pending_send_conflict');await entered.promise;const old=await f.m.storage.loadPendingE2eeSend(id),newer={...old,mls_ciphertext:Uint8Array.of(99),mls_ciphertext_sha256:'replacement'};await f.m.storage.savePendingE2eeSend(newer);assert.equal(await f.m.storage.savePendingE2eeSendOutcome(old,null),false);release.open();await rejected;assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),newer);assert.equal(await f.m.storage.loadMessage(id),null);await f.close();
});
test('scope replacement during HTTP suppresses cache/status/host success and preserves old job',async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{f.m.client={activeChannels:{}};return{message:{id}};};await assert.rejects(f.send('old session',id),e=>e.code==='recovery_scope_changed');assert.equal(await f.m.storage.loadMessage(id),null);assert.equal((await f.m.storage.loadPendingE2eeSend(id)).status,'sending');await f.close();
});
test('bounded send queue fences queued scope and freezes caller options',async()=>{
 const f=await fixture(),entered=latch(),release=latch();let first=true;f.m.e2eeClient.sendMessage=async(_t,_c,body)=>{if(first){first=false;entered.open();await release.promise;}return{message:{id:body.message.id}};};const work=f.send();await entered.promise;const opts={sticker_url:'original'},id=randomUUID(),queued=f.m.sendMessage('team',f.cid.slice(5),f.cid,'queued',id,opts);opts.sticker_url='changed';release.open();await work;await queued;assert.equal((await f.m.storage.loadPendingE2eeSend(id)).payload.sticker_url,'original');
 const hold=latch(),enteredQueue=latch(),admitted=[];admitted.push(f.m._withE2eeSendLock(f.cid,()=>{enteredQueue.open();return hold.promise;}));for(let i=1;i<32;i++)admitted.push(f.m._withE2eeSendLock(f.cid,()=>hold.promise));await enteredQueue.promise;await assert.rejects(f.m._withE2eeSendLock(f.cid,async()=>{}),e=>e.code==='provider_mutation_busy');f.m.client={activeChannels:{}};const outcomes=Promise.allSettled(admitted);hold.open();assert.equal((await outcomes).filter(x=>x.status==='rejected').length,31);assert.equal(f.m._e2eeSendLockQueued,0);await f.close();
});

test('peer decrypts consecutive fresh sends across provider/group replacement and sender restart',async()=>{
 const f=await fixture(),bobProvider=new f.w.Provider(),bob=new f.w.Identity(bobProvider,'peer'),kp=bob.key_package_typed(bobProvider),g=f.m.getGroup(f.cid);
 const bundle=g.add_members(f.m.provider,f.m.identity,[kp]);g.merge_pending_commit(f.m.provider);g.save_state(f.m.provider);f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:Number(g.epoch())});await f.m._writeMlsMutation(f.cid,null);
 const peer=f.w.Group.join(bobProvider,bundle.welcome,g.export_ratchet_tree());
 await f.send('one');const bytes=f.calls.at(-1).body.message.mls_ciphertext;assert.equal(JSON.parse(new TextDecoder().decode(peer.process_application_message(bobProvider,bytes,undefined).content)).text,'one');
 const restarted=await f.manager();f.loadGroup(restarted);restarted.e2eeClient=f.m.e2eeClient;await restarted.sendMessage('team',f.cid.slice(5),f.cid,'two',randomUUID());
 assert.equal(JSON.parse(new TextDecoder().decode(peer.process_application_message(bobProvider,f.calls.at(-1).body.message.mls_ciphertext,undefined).content)).text,'two');await restarted.storage.close();peer.free();bob.free();bobProvider.free();await f.close();
});
test('atomic outcomes preserve tombstones and newer sequence projections and roll back real transaction abort',async()=>{
 const f=await fixture(),id=randomUUID();await f.send('outcome',id);const job=await f.m.storage.loadPendingE2eeSend(id),projection={id,cid:f.cid,text:'old response',user_id:f.user,created_at:'2026-10-01T00:00:00Z',last_event_seq:2};
 await f.m.storage.saveMessage({...projection,text:'newer response',last_event_seq:10});assert.equal(await f.m.storage.savePendingE2eeSendOutcome(job,{...job,status:'sent'},projection),true);assert.equal((await f.m.storage.loadMessage(id)).text,'newer response');
 await f.m.storage.saveMessage({...projection,type:'deleted',display_type:'deleted',last_event_seq:20});await f.m.storage.savePendingE2eeSendOutcome(job,job,{...projection,last_event_seq:30});assert.equal((await f.m.storage.loadMessage(id)).type,'deleted');
 const db=await f.m.storage.openDB(),transaction=db.transaction.bind(db);db.transaction=(...args)=>{const tx=transaction(...args);if(Array.isArray(args[0])&&args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};await assert.rejects(f.m.storage.savePendingE2eeSendOutcome(job,{...job,status:'failed_retryable'},projection));db.transaction=transaction;assert.equal((await f.m.storage.loadPendingE2eeSend(id)).status,'sent');assert.equal((await f.m.storage.loadMessage(id)).type,'deleted');await f.close();
});
test('host retry callback and late list cannot restore or publish a replaced session, edits get no attachment presentation',async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw new Error('offline');};await assert.rejects(f.send('queued',id));const job=await f.m.storage.loadPendingE2eeSend(id);let callbacks=0;
 f.m.e2eeClient.sendMessage=async()=>{f.m.client={activeChannels:{},channel:()=>{callbacks++;throw Error('wrong host');}};return{message:{id}};};await f.m._processQueuedE2eeAttachmentMessage(job,{onSuccess:()=>callbacks++,onError:()=>callbacks++});assert.equal(callbacks,0);assert.equal((await f.m.storage.loadPendingE2eeSend(id)).status,'sending');
 const original=f.m.storage.listPendingE2eeSends.bind(f.m.storage);f.m.storage.listPendingE2eeSends=async(...args)=>{const rows=await original(...args);f.m.client={activeChannels:{},channel:()=>{callbacks++;}};return rows;};await f.m.resumePendingE2eeSends();assert.equal(callbacks,0);assert.equal(f.m._liveParamsForPendingE2eeSend({...job,operation_kind:'update'}),undefined);await f.close();
});
test('pending ambiguity cannot be replaced by different content and terminal/canceled jobs do not resend',async()=>{
 for(const status of ['failed_retryable','failed_terminal','canceled']){const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw new Error('offline');};await assert.rejects(f.send('original',id));const job=await f.m.storage.loadPendingE2eeSend(id);await f.m.storage.savePendingE2eeSend({...job,status});let requests=0;f.m.e2eeClient.sendMessage=async()=>{requests++;};await assert.rejects(f.send(status==='failed_retryable'?'different':'original',id),e=>e.code==='pending_send_conflict');assert.equal(requests,0);assert.deepEqual((await f.m.storage.loadPendingE2eeSend(id)).mls_ciphertext,job.mls_ciphertext);await f.close();}
});

test('corrupt persisted ciphertext fails before HTTP; cancellation does not delete a replaced job',async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw new Error('offline');};await assert.rejects(f.send('guarded',id));const job=await f.m.storage.loadPendingE2eeSend(id);let posts=0;f.m.e2eeClient.sendMessage=async()=>{posts++;};await assert.rejects(f.m._sendPersistedPendingE2eeRecord({...job,mls_ciphertext:Uint8Array.of(1)}),e=>e.code==='pending_send_checkpoint_invalid');assert.equal(posts,0);
 const read=f.m.storage.loadPendingE2eeSend.bind(f.m.storage),replacement={...job,mls_ciphertext:Uint8Array.of(2),mls_ciphertext_sha256:'new-job'};f.m.storage.loadPendingE2eeSend=async(mid)=>{const prior=await read(mid);await f.m.storage.savePendingE2eeSend(replacement);return prior;};await assert.rejects(f.m.cancelPendingE2eeSend(id),e=>e.code==='pending_send_conflict');f.m.storage.loadPendingE2eeSend=read;assert.deepEqual(await read(id),replacement);await f.close();
});


for(const race of ['cancel','replace'])test(`pending ${race} at private checkpoint aborts the whole candidate without overwriting the winning job`,async()=>{
 const f=await fixture(),id=randomUUID(),bytes=f.m.provider.to_bytes(),save=f.m.storage.saveEncryptionSyncCheckpoint.bind(f.m.storage);let winner;
 f.m.storage.saveEncryptionSyncCheckpoint=async cp=>{if(cp.pending_sends?.length){const old=await f.m.storage.loadPendingE2eeSend(id);if(race==='cancel')await f.m.cancelPendingE2eeSend(id);else await f.m.storage.savePendingE2eeSend({...old,payload:{text:'concurrent winner'}});winner=await f.m.storage.loadPendingE2eeSend(id);}return save(cp);};
 await assert.rejects(f.send('original',id),e=>e.code==='pending_send_conflict');assert.equal(f.calls.length,0);assert.deepEqual(f.m.provider.to_bytes(),bytes);assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),winner);assert.equal(winner.mls_ciphertext,undefined);assert.equal(winner.status,race==='cancel'?'canceled':'sending');assert.equal(f.m._providerPersistenceUncertain,false);await f.close();
});


for(const outcome of ['send','cancel','owner'])test(`provider checkpoint collision autonomously wakes exact queued ciphertext; ${outcome} remains fenced`,async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw Error('initial offline');};await assert.rejects(f.send('held original',id));const job=await f.m.storage.loadPendingE2eeSend(id),entered=latch(),release=latch();
 f.m.client.channel=()=>({restorePendingE2eeAttachmentUpload:()=>{},updatePendingE2eeAttachmentUpload:()=>{},completePendingE2eeAttachmentUpload:()=>{},failPendingE2eeAttachmentUpload:()=>{}});
 const checkpoint=f.m._withProviderMutation(async()=>{entered.open();await release.promise;});await entered.promise;let posted=0;const completed=latch();
 f.m.e2eeClient.sendMessage=async(_t,_c,body)=>{posted++;assert.equal(body.message.id,id);assert.deepEqual(body.message.mls_ciphertext,job.mls_ciphertext);return{message:{id}};};
 const process=f.m._processQueuedE2eeAttachmentMessage.bind(f.m);f.m._processQueuedE2eeAttachmentMessage=async(...args)=>{try{return await process(...args);}finally{if(posted)completed.open();}};
 await f.m._processQueuedE2eeAttachmentMessage(job);assert.equal(posted,0);assert.equal(f.m._pendingE2eeProviderWakes.size,1);
 if(outcome==='cancel')await f.m.cancelPendingE2eeSend(id);if(outcome==='owner')f.m.client={activeChannels:{}};
 release.open();await checkpoint;
 if(outcome==='send'){let timer;try{await Promise.race([completed.promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('No autonomous checkpoint wake')),1000))]);}finally{clearTimeout(timer);}assert.equal(posted,1);assert.equal(await f.m.storage.loadPendingE2eeSend(id),null);}
 else{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));assert.equal(posted,0);const retained=await f.m.storage.loadPendingE2eeSend(id);assert.deepEqual(retained.mls_ciphertext,job.mls_ciphertext);assert.equal(retained.status,outcome==='cancel'?'canceled':'failed_retryable');}
 assert.equal(f.m._pendingE2eeProviderWakes.size,0);await f.close();
});


test('restart cannot dispatch old ciphertext using only the restored local generation', async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw Error('offline');};await assert.rejects(f.send('original',id));
 const original=await f.m.storage.loadPendingE2eeSend(id),restarted=await f.manager();f.loadGroup(restarted);let gets=0,posts=0;
 restarted.e2eeClient={getMlsGenerationState:async()=>{gets++;return{group_generation:1,group_id:Uint8Array.of(1),current_epoch:1};},sendMessage:async()=>{posts++;return{message:{id}};}};
 await assert.rejects(restarted._sendPersistedPendingE2eeRecord(original),e=>e.code==='old_group_generation');
 assert.equal(gets,1);assert.equal(posts,0);const retained=await restarted.storage.loadPendingE2eeSend(id);assert.deepEqual(retained.mls_ciphertext,original.mls_ciphertext);assert.equal(retained.message_id,id);assert.equal(retained.status,'failed_terminal');await restarted.storage.close();await f.close();
});


test('same-generation restart retries exact unknown ciphertext without Ready or a new ratchet',async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw Error('unknown');};await assert.rejects(f.send('exact',id));const original=await f.m.storage.loadPendingE2eeSend(id),m=await f.manager();f.loadGroup(m);m.storage.readyCheckpointVersion=undefined;const before=m.provider.to_bytes();let gets=0,posted;
 m.e2eeClient={getMlsGenerationState:async(type,id)=>{gets++;assert.equal(type,'team');assert.equal(id,f.cid.slice(5));return{group_generation:0,group_id:null,current_epoch:0};},sendMessage:async(_t,_c,body)=>{posted=body.message;return{message:{id}};}};
 await m._sendPersistedPendingE2eeRecord(original);assert.equal(gets,1);assert.deepEqual(posted.mls_ciphertext,original.mls_ciphertext);assert.equal(posted.id,id);assert.deepEqual(m.provider.to_bytes(),before);await m.storage.close();await f.close();
});
for(const scenario of ['malformed','regressed','transient','legacy','positive-unsupported'])test('restored generation observation '+scenario+' preserves exact obligation',async()=>{
 const generation=scenario==='regressed'||scenario==='positive-unsupported'?1:0,f=await fixture(generation),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw Error('unknown');};await assert.rejects(f.send('exact',id));const original=await f.m.storage.loadPendingE2eeSend(id);let posts=0;
 f.m.e2eeClient.getMlsGenerationState=async()=>{if(scenario==='legacy'||scenario==='positive-unsupported')throw{response:{status:404}};if(scenario==='transient')throw{response:{status:503}};return{group_generation:scenario==='malformed'?-1:0,group_id:null,current_epoch:0};};f.m.e2eeClient.sendMessage=async()=>{posts++;return{message:{id}};};
 if(scenario==='legacy')await f.m._sendPersistedPendingE2eeRecord(original);else await assert.rejects(f.m._sendPersistedPendingE2eeRecord(original));
 assert.equal(posts,scenario==='legacy'?1:0);const kept=await f.m.storage.loadPendingE2eeSend(id);assert.deepEqual(kept.mls_ciphertext,original.mls_ciphertext);assert.equal(kept.message_id,id);await f.close();
});
for(const mode of ['cancel','owner'])test('held generation observation fences '+mode+' before ciphertext HTTP',async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw Error('unknown');};await assert.rejects(f.send('exact',id));const original=await f.m.storage.loadPendingE2eeSend(id),entered=latch(),release=latch();let posts=0;
 f.m.e2eeClient.getMlsGenerationState=async()=>{entered.open();await release.promise;return{group_generation:0,group_id:null,current_epoch:0};};f.m.e2eeClient.sendMessage=async()=>{posts++;return{message:{id}};};
 const work=f.m._sendPersistedPendingE2eeRecord(original),rejected=assert.rejects(work);await entered.promise;if(mode==='cancel')await f.m.cancelPendingE2eeSend(id);else f.m.client={activeChannels:{}};const held=await f.m.storage.loadPendingE2eeSend(id);release.open();await rejected;assert.equal(posts,0);assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),held);await f.close();
});


test('a fresh checkpoint dispatch allowance is consumed once, not retained across a later retry',async()=>{
 const f=await fixture(),id=randomUUID();const record=await f.m._prepareApplicationSend({message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),operation_kind:'send',text:'exact',payload:{text:'exact'},status:'sending',created_at:Date.now(),updated_at:Date.now()});let posts=0;
 f.m.e2eeClient.sendMessage=async()=>{posts++;throw Error('unknown');};await assert.rejects(f.m._sendPersistedPendingE2eeRecord(record));f.m.e2eeClient.getMlsGenerationState=async()=>({group_generation:1,group_id:Uint8Array.of(1),current_epoch:1});await assert.rejects(f.m._sendPersistedPendingE2eeRecord(record),e=>e.code==='old_group_generation');assert.equal(posts,1);await f.close();
});


test('Ready ignores opaque local upload File bodies but preserves exact raw pending obligation',async()=>{
 const f=await fixture(),id=randomUUID(),file=new File([Uint8Array.of(1,2,3)],'voice.wav',{type:'audio/wav'});
 await f.m.storage.savePendingE2eeSend({message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),text:'',files:[file],status:'uploading',created_at:1,updated_at:1,retry_count:0});
 const before=await f.m.storage.loadPendingE2eeSend(id),state=await f.m.refreshE2eeState(f.cid);assert.equal(state.state,'ready',state.reason);
 const after=await f.m.storage.loadPendingE2eeSend(id);assert.equal(after.status,before.status);assert.deepEqual(new Uint8Array(await after.files[0].arrayBuffer()),Uint8Array.of(1,2,3));
 const cleanup=await f.m.storage.loadMlsCleanupState(f.cid);assert.equal(cleanup.pending_sends[0].files[0].size,3,'destructive cleanup read retains full row');
 assert.equal(f.calls.length,0);await f.close();
});

for(const retainedFiles of [true,false])test('completed voice manifest resumes exact UUID '+(retainedFiles?'from old File job':'after restart without local File'),async()=>{
 const f=await fixture(),id=randomUUID(),asset=randomUUID(),manifest=[{version:1,attachment_id:asset,attachment_type:'voiceRecording'}],row={message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),text:'',files:retainedFiles?[new File([Uint8Array.of(4,5,6)],'voice.wav',{type:'audio/wav'})]:undefined,manifest,e2ee_attachment_ids:[asset],status:'uploaded',created_at:1,updated_at:1,retry_count:2};
 await f.m.storage.savePendingE2eeSend(row);const m=retainedFiles?f.m:await f.manager();if(m!==f.m){f.loadGroup(m);m.e2eeClient=f.m.e2eeClient;}let upload=0;m.uploadE2eeAttachments=async()=>{upload++;throw Error('Completed upload must not repeat');};
 if(retainedFiles)await m._processQueuedE2eeAttachmentMessage(await m.storage.loadPendingE2eeSend(id));
 else{let work;m.client.channel=()=>({restorePendingE2eeAttachmentUpload:()=>{},completePendingE2eeAttachmentUpload:()=>{},updatePendingE2eeAttachmentUpload:()=>{},failPendingE2eeAttachmentUpload:()=>{}});const process=m._processQueuedE2eeAttachmentMessage.bind(m);m._processQueuedE2eeAttachmentMessage=(...args)=>(work=process(...args));await m.resumePendingE2eeSends();assert.ok(work,'production restart selects completed manifest without File');await work;await m.storage.close();}
 assert.equal(f.calls.length,1,'must dispatch original completed-manifest job');assert.equal(f.calls[0].body.message.id,id);assert.deepEqual(f.calls[0].body.message.e2ee_attachment_ids,[asset]);assert.equal(upload,0);assert.equal(await f.m.storage.loadPendingE2eeSend(id),null);await f.close();
});


test('invalid completed manifest cannot discard original File or reach ciphertext HTTP',async()=>{
 const f=await fixture(),id=randomUUID(),row={message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),text:'',files:[new File([Uint8Array.of(7,8)],'voice.wav',{type:'audio/wav'})],manifest:[{version:1,attachment_id:randomUUID(),attachment_type:'voiceRecording'}],e2ee_attachment_ids:[randomUUID()],status:'uploaded',created_at:1,updated_at:1,retry_count:0};
 await f.m.storage.savePendingE2eeSend(row);await f.m._processQueuedE2eeAttachmentMessage(await f.m.storage.loadPendingE2eeSend(id));const kept=await f.m.storage.loadPendingE2eeSend(id);assert.equal(f.calls.length,0);assert.deepEqual(new Uint8Array(await kept.files[0].arrayBuffer()),Uint8Array.of(7,8));assert.deepEqual(kept.manifest,row.manifest);assert.equal(kept.mls_ciphertext,undefined);await f.close();
});


test('retained sent journals beyond100 cannot permanently block a fresh application send',async()=>{
 const f=await fixture();try{for(let n=0;n<102;n++)await f.send('retained-'+n);assert.equal(f.calls.length,102);assert.equal((await f.m.storage.listPendingE2eeSends()).length,102,'retained exact replay outcomes must not be purged to pass');}finally{await f.close();}
});


test('completed attachment from an old generation cannot silently create ciphertext in a replacement group',async()=>{
 const f=await fixture(1),id=randomUUID(),asset=randomUUID(),row={message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),group_generation:0,text:'',files:[new File([Uint8Array.of(9)],'voice.wav',{type:'audio/wav'})],manifest:[{version:1,attachment_id:asset,attachment_type:'voiceRecording'}],e2ee_attachment_ids:[asset],status:'uploaded',created_at:1,updated_at:1,retry_count:0};
 await f.m.storage.savePendingE2eeSend(row);const before=f.m.provider.to_bytes();await f.m._processQueuedE2eeAttachmentMessage(await f.m.storage.loadPendingE2eeSend(id));const kept=await f.m.storage.loadPendingE2eeSend(id);assert.equal(f.calls.length,0,'old upload intent must not adopt the replacement generation');assert.equal(kept.group_generation,0);assert.equal(kept.status,'failed_terminal');assert.equal(kept.mls_ciphertext,undefined);assert.deepEqual(f.m.provider.to_bytes(),before);assert.deepEqual(kept.manifest,row.manifest);await f.close();
});


test('completed upload generation remains pinned through a concurrent Ready wait',async()=>{
 const f=await fixture(),id=randomUUID(),asset=randomUUID(),row={message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),group_generation:0,text:'',manifest:[{version:1,attachment_id:asset,attachment_type:'voiceRecording'}],e2ee_attachment_ids:[asset],status:'uploaded',created_at:1,updated_at:1,retry_count:0};
 await f.m.storage.savePendingE2eeSend(row);const verify=f.m.storage.verifyMlsReadyCheckpoint.bind(f.m.storage),read=f.m.storage.loadPendingE2eeSend.bind(f.m.storage);let admitted=false,injected=false;
 f.m.storage.verifyMlsReadyCheckpoint=async cp=>{const ok=await verify(cp);if(ok)admitted=true;return ok;};
 f.m.storage.loadPendingE2eeSend=async key=>{const value=await read(key);if(admitted&&!injected&&key===id){injected=true;f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),group_generation:1});}return value;};
 const bytes=f.m.provider.to_bytes();await f.m._processQueuedE2eeAttachmentMessage(await f.m.storage.loadPendingE2eeSend(id));
 assert.equal(injected,true);assert.equal(f.calls.length,0);const kept=await f.m.storage.loadPendingE2eeSend(id);assert.equal(kept.group_generation,0);assert.equal(kept.status,'failed_terminal');assert.equal(kept.mls_ciphertext,undefined);assert.deepEqual(f.m.provider.to_bytes(),bytes);await f.close();
});


test('old-channel acceptance failure before POST retains unsent intent and closed reason across reload',async()=>{
 const f=await fixture(),id=randomUUID();f.m.groups.delete(f.cid);
 f.m.ensureChannelReady=async()=>{const error=new Error('invalid context');error.code='acceptance_metadata_invalid';error.reason='context_missing';throw error;};
 await assert.rejects(f.send('unsent old channel',id),e=>e.code==='acceptance_metadata_invalid');
 assert.equal(f.calls.length,0);const held=await f.m.storage.loadPendingE2eeSend(id);
 assert.equal(held.status,'failed_retryable');assert.equal(held.last_error,'acceptance_metadata_invalid:context_missing');
 assert.equal(held.mls_ciphertext,undefined);assert.equal(await f.m.storage.loadMessage(id),null);
 const reopened=new IndexedDBEncryptionStorage(f.user);assert.equal((await reopened.loadPendingE2eeSend(id)).message_id,id);
 await reopened.close();await f.close();
});

test('actual application provider swap re-admits subscribed Ready without another private write or POST',async()=>{
 const f=await fixture(1),seen=[],peerProvider=new f.w.Provider(),peerIdentity=new f.w.Identity(peerProvider,'owned-swap-peer');
 const group=f.m.groups.get(f.cid),bundle=group.add_members(f.m.provider,f.m.identity,[peerIdentity.key_package(peerProvider)]);group.merge_pending_commit(f.m.provider);
 // join_with_welcome consumes the RatchetTree handle.
 const tree=group.export_ratchet_tree(),peer=f.w.Group.join_with_welcome(peerProvider,bundle.welcome,tree);
 f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:1});await f.m._writeMlsMutation(f.cid,null);
 await f.m.refreshE2eeState(f.cid);const sub=f.m.subscribeE2eeState(f.cid,s=>seen.push(s.state));
 try{
  const old=f.m._activeProvider,id=randomUUID();await f.send('owned provider transition',id);const afterSend=await f.m.storage.loadProviderCheckpoint(f.user,f.device);
  await f.m._subscribedReadyRevalidation;
  assert.notEqual(f.m._activeProvider,old);assert.ok(seen.includes('repairing'));assert.equal(seen.at(-1),'ready');
  assert.equal(f.m.getE2eeState(f.cid).state,'ready');assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.message.id,id);
  assert.deepEqual(await f.m.storage.loadProviderCheckpoint(f.user,f.device),afterSend);
  const decrypted=peer.process_message(peerProvider,new Uint8Array(f.calls[0].body.message.mls_ciphertext));
  assert.equal(JSON.parse(new TextDecoder().decode(decrypted.content)).text,'owned provider transition');
 }finally{sub.unsubscribe();const storage=f.m.storage;f.m.destroy();await storage.close();peer.free();peerIdentity.free();peerProvider.free();}
});

for(const outcome of ['unknown','canceled'])test('subscribed owned-swap wake preserves '+outcome+' ciphertext without a transport retry',async()=>{
 const f=await fixture(1),id=randomUUID(),seen=[];await f.m.refreshE2eeState(f.cid);const sub=f.m.subscribeE2eeState(f.cid,s=>seen.push(s.state));let posts=0;
 f.m.e2eeClient.sendMessage=async()=>{posts++;if(outcome==='canceled')await f.m.cancelPendingE2eeSend(id);throw Error('ambiguous QA transport');};
 try{
  await assert.rejects(f.send('preserve exact unknown intent',id));const held=await f.m.storage.loadPendingE2eeSend(id);assert.ok(held.mls_ciphertext.length);
  await f.m._subscribedReadyRevalidation;
  assert.equal(posts,1);assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),held);
  assert.equal(held.status,outcome==='canceled'?'canceled':'failed_retryable');assert.equal(seen.at(-1),'ready');assert.equal(f.m._providerPersistenceUncertain,false);
 }finally{sub.unsubscribe();const storage=f.m.storage;f.m.destroy();await storage.close();}
});

test('accepted restored ciphertext is not submitted twice when a private writer overlaps HTTP completion',async()=>{
 const f=await fixture(),id=randomUUID(),peerProvider=new f.w.Provider(),peerIdentity=new f.w.Identity(peerProvider,'ack-peer');
 let peer,writer;const entered=latch(),release=latch();
 try{
  const g=f.m.groups.get(f.cid),bundle=g.add_members(f.m.provider,f.m.identity,[peerIdentity.key_package_typed(peerProvider)]);
  g.merge_pending_commit(f.m.provider);g.save_state(f.m.provider);f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:Number(g.epoch())});await f.m._writeMlsMutation(f.cid,null);
  peer=f.w.Group.join(peerProvider,bundle.welcome,g.export_ratchet_tree());
  f.m.e2eeClient.sendMessage=async()=>{throw Error('initial unavailable transport');};
  await assert.rejects(f.send('one durable intent',id));
  const record=await f.m.storage.loadPendingE2eeSend(id),before=f.m._activeProvider.to_bytes();let posts=0,success=0,failures=0;
  f.m.client.channel=()=>({restorePendingE2eeAttachmentUpload:()=>{},updatePendingE2eeAttachmentUpload:()=>{},completePendingE2eeAttachmentUpload:()=>success++,failPendingE2eeAttachmentUpload:()=>failures++});
  f.m.e2eeClient.sendMessage=async(_t,_c,body)=>{
   posts++;assert.equal(body.message.id,id);assert.deepEqual(body.message.mls_ciphertext,record.mls_ciphertext);
   if(posts===1){assert.equal(JSON.parse(new TextDecoder().decode(peer.process_application_message(peerProvider,body.message.mls_ciphertext,undefined).content)).text,'one durable intent');
    writer=f.m._withProviderMutation(async()=>{entered.open();await release.promise;});await entered.promise;
   }
   return{message:{id,msg_seq:posts,last_event_seq:posts,created_at:'2026-10-28T00:00:00Z'}};
  };
  await f.m._processQueuedE2eeAttachmentMessage(record,{onSuccess:()=>success++,onError:()=>failures++});
  release.open();await writer;
  for(let n=0;n<100;n++)await new Promise(r=>setImmediate(r));
  assert.equal(posts,1,'a local provider writer cannot revoke an accepted HTTP result or authorize a second POST');
  assert.equal(success,1);assert.equal(failures,0);assert.equal(await f.m.storage.loadPendingE2eeSend(id),null);
  const message=await f.m.storage.loadMessage(id);assert.equal(message.msg_seq,1);assert.equal(message.status,'received');assert.deepEqual(f.m._activeProvider.to_bytes(),before);
 }finally{release.open();if(writer)await writer;peer?.free();peerIdentity.free();peerProvider.free();await f.close();}
});

test('accepted send UUID returns its durable projection without another transport attempt',async()=>{
 const f=await fixture(),id=randomUUID();try{await f.send('accepted once',id);const before=f.m._activeProvider.to_bytes();const response=await f.send('accepted once',id);assert.equal(f.calls.length,1);assert.equal(response.message.id,id);assert.equal(response.message.text,'accepted once');assert.deepEqual(f.m._activeProvider.to_bytes(),before);assert.equal((await f.m.storage.loadPendingE2eeSend(id)).status,'sent');}finally{await f.close();}
});
test('accepted send with a missing projection fails closed without resubmission',async()=>{
 const f=await fixture(),id=randomUUID();try{await f.send('accepted projection',id);await f.m.storage.deleteMessage(id);await assert.rejects(f.send('accepted projection',id),e=>e.code==='application_checkpoint_missing');assert.equal(f.calls.length,1);assert.equal((await f.m.storage.loadPendingE2eeSend(id)).status,'sent');}finally{await f.close();}
});
test('accepted immutable ciphertext remains acknowledged while uncertain private state blocks new encryption',async()=>{
 const f=await fixture(),id=randomUUID();try{
  f.m.e2eeClient.sendMessage=async()=>{throw Error('before acceptance offline');};await assert.rejects(f.send('retained accepted',id));const record=await f.m.storage.loadPendingE2eeSend(id),before=f.m._activeProvider.to_bytes();let posts=0,success=0;
  f.m.e2eeClient.sendMessage=async(_t,_c,body)=>{posts++;assert.deepEqual(body.message.mls_ciphertext,record.mls_ciphertext);f.m._providerPersistenceUncertain=true;return{message:{id,msg_seq:1,last_event_seq:1}};};
  await f.m._processQueuedE2eeAttachmentMessage(record,{onSuccess:()=>success++});assert.equal(posts,1);assert.equal(success,1);assert.equal(await f.m.storage.loadPendingE2eeSend(id),null);assert.equal((await f.m.storage.loadMessage(id)).msg_seq,1);assert.equal(f.m.getE2eeState(f.cid).reason,'provider_persistence_uncertain');
  const next=randomUUID();await assert.rejects(f.send('must still be blocked',next));assert.equal(posts,1);assert.equal((await f.m.storage.loadPendingE2eeSend(next))?.mls_ciphertext,undefined);assert.deepEqual(f.m._activeProvider.to_bytes(),before);
 }finally{await f.close();}
});


test('lost ACK, reopen and missing legacy marker reconcile exact ciphertext without a fresh dispatch',async()=>{
 const f=await fixture(),id=randomUUID(),requests=[];
 f.m.e2eeClient.sendMessage=async(_t,_c,body,options)=>{requests.push({body:structuredClone(body),options});throw {response:{status:503,data:{reason:'message_delivery_unknown'}}};};
 await assert.rejects(f.send('one intent',id));const held=await f.m.storage.loadPendingE2eeSend(id);
 assert.equal(held.application_http_started,true);assert.equal(requests[0].options.reconcileOnly,false);
 await assert.rejects(f.send('one intent',id));assert.equal(requests[1].options.reconcileOnly,true);
 const restored=await f.manager();f.loadGroup(restored);restored.e2eeClient={...f.m.e2eeClient};const restoredBefore=restored.provider.to_bytes(),restoredCheckpoint=await restored.storage.loadProviderCheckpoint(f.user,f.device);
 await assert.rejects(restored._sendPersistedPendingE2eeRecord(await restored.storage.loadPendingE2eeSend(id)));
 assert.equal(requests[2].options.reconcileOnly,true);assert.deepEqual(requests.map(r=>r.body),[requests[0].body,requests[0].body,requests[0].body]);
 const legacy={...await restored.storage.loadPendingE2eeSend(id)};delete legacy.application_http_started;await restored.storage.savePendingE2eeSend(legacy);
 await assert.rejects(restored._sendPersistedPendingE2eeRecord(legacy));assert.equal(requests[3].options.reconcileOnly,true);
 assert.notEqual((await restored.storage.loadPendingE2eeSend(id)).status,'sent');assert.equal(await restored.storage.loadMessage(id),null);
 assert.deepEqual(restored.provider.to_bytes(),restoredBefore);assert.deepEqual(await restored.storage.loadProviderCheckpoint(f.user,f.device),restoredCheckpoint);await restored.storage.close();await f.close();
});

test('dispatch marker CAS has one winner and stale outcomes cannot clear it',async()=>{
 const f=await fixture(),id=randomUUID(),row=await f.m._prepareApplicationSend({message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),operation_kind:'send',payload:{text:'one'},status:'sending',created_at:1,updated_at:1});
 assert.equal(row.application_http_started,false);
 const mark=()=>f.m.storage.savePendingE2eeSendOutcome(row,{...row,application_http_started:true});
 const outcomes=await Promise.all([mark(),mark()]);assert.deepEqual(outcomes.sort(),[false,true]);
 assert.equal(await f.m.storage.savePendingE2eeSendOutcome(row,{...row,last_error:'stale HTTP outcome'}),true);
 assert.equal((await f.m.storage.loadPendingE2eeSend(id)).application_http_started,true);await f.close();
});

for(const status of [400,503])test('reconcile epoch error '+status+' cannot create replacement ciphertext',async()=>{
 const f=await fixture(),id=randomUUID();f.m.e2eeClient.sendMessage=async()=>{throw Error('lost ACK');};await assert.rejects(f.send('same',id));
 const held=await f.m.storage.loadPendingE2eeSend(id),provider=f.m.provider.to_bytes();let recovery=0,options;
 f.m._recoverEpochStaleGroup=async()=>{recovery++;};f.m.e2eeClient.sendMessage=async(_t,_c,_body,o)=>{options=o;throw {response:{status,data:{message:'epoch_stale: current epoch differs'}}};};
 await assert.rejects(f.send('same',id));assert.equal(options.reconcileOnly,true);assert.equal(recovery,0);
 assert.deepEqual((await f.m.storage.loadPendingE2eeSend(id)).mls_ciphertext,held.mls_ciphertext);assert.deepEqual(f.m.provider.to_bytes(),provider);await f.close();
});

test('ambiguous first dispatch with epoch text in a 503 cannot reencrypt or retry',async()=>{
 const f=await fixture(),id=randomUUID();let recovery=0,posts=0;f.m._recoverEpochStaleGroup=async()=>{recovery++;};
 f.m.e2eeClient.sendMessage=async()=>{posts++;throw {response:{status:503,data:{message:'epoch_stale: transport result unknown'}}};};
 await assert.rejects(f.send('one',id));assert.equal(posts,1);assert.equal(recovery,0);assert.equal((await f.m.storage.loadPendingE2eeSend(id)).application_http_started,true);await f.close();
});

test('sealed ciphertext dispatch waits for an actual concurrent provider checkpoint before HTTP',async()=>{
 const f=await fixture(),id=randomUUID(),p=new f.w.Provider(),identity=new f.w.Identity(p,'dispatch-peer'),entered=latch(),release=latch();let peer,writer;
 const persist=f.m.storage.saveProviderState.bind(f.m.storage),prepare=f.m._prepareApplicationSend.bind(f.m);
 try{
  const g=f.m.getGroup(f.cid),bundle=g.add_members(f.m.provider,f.m.identity,[identity.key_package_typed(p)]);g.merge_pending_commit(f.m.provider);g.save_state(f.m.provider);f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:Number(g.epoch())});await f.m._writeMlsMutation(f.cid,null);peer=f.w.Group.join(p,bundle.welcome,g.export_ratchet_tree());
  f.m._prepareApplicationSend=async(...args)=>{const row=await prepare(...args);f.m.storage.saveProviderState=async(...a)=>{entered.open();await release.promise;return persist(...a);};writer=f.m._persistProviderStrict();await entered.promise;return row;};
  let posts=0;f.m.e2eeClient.sendMessage=async(_t,_c,body,options)=>{
   posts++;assert.equal(options.reconcileOnly,false);
   assert.equal(JSON.parse(new TextDecoder().decode(peer.process_application_message(p,body.message.mls_ciphertext,undefined).content)).text,'one checkpointed intent');
   return{message:{id,msg_seq:99,last_event_seq:100,created_at:'2026-10-30T00:00:00Z'}};
  };
  let settled=false;const work=f.send('one checkpointed intent',id);work.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(posts,0);assert.throws(()=>f.m.provider,e=>e.code==='provider_mutation_busy');release.open();await work;assert.equal(posts,1);const row=await f.m.storage.loadPendingE2eeSend(id);assert.equal(row.application_http_started,true);assert.equal(row.status,'sent');
 }finally{release.open();if(writer)await writer;peer?.free();identity.free();p.free();await f.close();}
});

test('sealed dispatch does not strand its first POST when a provider writer starts during HTTP-marker CAS',async()=>{
 const f=await fixture(),id=randomUUID(),entered=latch(),release=latch();let writer;
 const save=f.m.storage.savePendingE2eeSendOutcome.bind(f.m.storage),persist=f.m.storage.saveProviderState.bind(f.m.storage);
 try{
  f.m.storage.savePendingE2eeSendOutcome=async(before,after,...rest)=>{
   const result=await save(before,after,...rest);
   if(result&&before.application_http_started===false&&after?.application_http_started===true){
    f.m.storage.saveProviderState=async(...args)=>{entered.open();await release.promise;return persist(...args);};
    writer=f.m._persistProviderStrict();await entered.promise;
   }
   return result;
  };
  const work=f.send('sealed first POST',id);work.catch(()=>{});
  await entered.promise;await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.length,1,'Marker winner must dispatch the first POST, never strand it as reconcile-only');
  assert.equal(f.calls[0].body.message.id,id);
  release.open();await writer;await work;
  assert.equal((await f.m.storage.loadPendingE2eeSend(id)).status,'sent');
 }finally{release.open();if(writer)await writer;await f.close();}
});

test('sealed dispatch still fails closed if provider persistence becomes uncertain during HTTP-marker CAS',async()=>{
 const f=await fixture(),id=randomUUID();
 const save=f.m.storage.savePendingE2eeSendOutcome.bind(f.m.storage);
 try{
  f.m.storage.savePendingE2eeSendOutcome=async(before,after,...rest)=>{
   const result=await save(before,after,...rest);
   if(result&&before.application_http_started===false&&after?.application_http_started===true)f.m._providerPersistenceUncertain=true;
   return result;
  };
  await assert.rejects(f.send('must remain fenced',id),e=>e.code==='provider_persistence_uncertain');
  assert.equal(f.calls.length,0);
  assert.equal((await f.m.storage.loadPendingE2eeSend(id)).application_http_started,true);
 }finally{await f.close();}
});

test('sealed dispatch still fails closed on provider persistence uncertainty before HTTP',async()=>{
 const f=await fixture(),id=randomUUID();try{
  const row=await f.m._prepareApplicationSend({message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),operation_kind:'send',payload:{text:'retain'},status:'sending',created_at:1,updated_at:1});
  f.m._providerPersistenceUncertain=true;await assert.rejects(f.m._sendPersistedPendingE2eeRecord(row),e=>e.code==='provider_persistence_uncertain');
  assert.equal(f.calls.length,0);assert.deepEqual(await f.m.storage.loadPendingE2eeSend(id),row);
 }finally{await f.close();}
});

function retryChannel(f){
 const {ErmisChat}=require('../dist/index.cjs'),c=new ErmisChat('fixture','project','http://fixture.invalid',{browser:false,logger:()=>{}});
 c._setUser({id:f.user});c.deviceId=f.device;c.encryptionManager=f.m;f.m.client=c;
 const ch=c.channel('team',f.cid.slice(5));ch.data={mls_enabled:true};ch.initialized=true;
 let plain=0;c.post=async()=>{plain++;throw Error('plaintext retry forbidden')};
 return{c,ch,plain:()=>plain,seed:(id,text)=>ch.state.addMessageSorted({id,text,user:{id:f.user},status:'error',created_at:new Date()},true)};
}
test('Channel retry uses original unsealed intent UUID and native peer decrypts original payload',async()=>{
 const f=await fixture(),id=randomUUID();try{
  const pp=new f.w.Provider(),pi=new f.w.Identity(pp,'authorized-peer'),g=f.m.groups.get(f.cid);
  const bundle=g.add_members(f.m.provider,f.m.identity,[pi.key_package(pp)]);g.merge_pending_commit(f.m.provider);g.save_state(f.m.provider);
  const receiver=f.w.Group.join_with_welcome(pp,bundle.welcome,g.export_ratchet_tree());
  f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:1});await f.m._writeMlsMutation(f.cid,null);
  f.m.storage.readyCheckpointVersion=undefined;await assert.rejects(f.send('original retry payload',id));f.m.storage.readyCheckpointVersion=2;
  const h=retryChannel(f);h.seed(id,'changed optimistic UI text');
  let posted;f.m.e2eeClient.sendMessage=async(_t,_c,b)=>{posted=structuredClone(b.message);return{message:{id,created_at:'2026-10-31T00:00:00Z'}}};
  await h.ch.retryMessage(id);assert.equal(h.plain(),0);assert.equal(posted.id,id);
  const decoded=JSON.parse(new TextDecoder().decode(receiver.process_application_message(pp,new Uint8Array(posted.mls_ciphertext)).content));
  assert.equal(decoded.text,'original retry payload');assert.equal(await f.m.storage.loadPendingE2eeSend(id),null);
  assert.equal(h.ch.state.messages.find(m=>m.id===id).status,'received');
 }finally{await f.close()}
});
test('Channel retry reconciles sealed unknown outcome with exact ciphertext and no fresh ratchet',async()=>{
 const f=await fixture(),id=randomUUID();try{
  f.m.e2eeClient.sendMessage=async()=>{throw Error('lost ACK')};await assert.rejects(f.send('unknown',id));
  const before=await f.m.storage.loadPendingE2eeSend(id),bytes=f.m._activeProvider.to_bytes(),h=retryChannel(f);h.seed(id,'unknown');
  // A durable obligation fences even a stale false channel encryption flag.
  h.ch.data.mls_enabled=false;
  let options;f.m.e2eeClient.sendMessage=async(_t,_c,b,o)=>{options=o;assert.equal(b.message.id,id);assert.deepEqual(b.message.mls_ciphertext,before.mls_ciphertext);return{message:{id}}};
  await h.ch.retryMessage(id);assert.equal(h.plain(),0);assert.equal(options.reconcileOnly,true);assert.deepEqual(f.m._activeProvider.to_bytes(),bytes);
  assert.equal(await f.m.storage.loadPendingE2eeSend(id),null);
 }finally{await f.close()}
});
for(const kind of ['missing','canceled','failed_terminal','foreign-cid','update'])test('encrypted retry fails closed for '+kind+' durable obligation',async()=>{
 const f=await fixture(),id=randomUUID();try{
  f.m.storage.readyCheckpointVersion=undefined;await assert.rejects(f.send('retain',id));const record=await f.m.storage.loadPendingE2eeSend(id);
  if(kind==='missing')await f.m.storage.deletePendingE2eeSend(id);
  else await f.m.storage.savePendingE2eeSend({...record,...(kind==='foreign-cid'?{cid:'team:foreign'}:kind==='update'?{operation_kind:'update'}:{status:kind})});
  const h=retryChannel(f);h.seed(id,'retain');await assert.rejects(h.ch.retryMessage(id));assert.equal(h.plain(),0);assert.equal(f.calls.length,0);
 }finally{await f.close()}
});
test('standard message retry keeps the existing ordinary send endpoint',async()=>{
 const f=await fixture(),id=randomUUID();try{
  const h=retryChannel(f);h.ch.data.mls_enabled=false;h.seed(id,'ordinary');let posted;
  h.c.post=async(url,payload)=>{posted={url,payload};return{message:{id,text:'ordinary',created_at:new Date().toISOString()}}};
  await h.ch.retryMessage(id);assert.equal(posted.payload.message.id,id);assert.equal(posted.payload.message.text,'ordinary');assert.equal(posted.payload.message.mls_ciphertext,undefined);
 }finally{await f.close()}
});

test('cipher-bearing message cannot fall through to plaintext with a stale channel flag and missing pending record',async()=>{
 const f=await fixture(),id=randomUUID();try{
  const h=retryChannel(f);h.ch.data.mls_enabled=false;h.seed(id,'must stay encrypted');
  h.ch.state.updateMessageById(id,m=>({...m,mls_ciphertext:[1,2,3]}));
  await assert.rejects(h.ch.retryMessage(id));assert.equal(h.plain(),0);
 }finally{await f.close()}
});


test('Ready admission and fresh send cannot be split by another owned provider checkpoint',async()=>{
 const f=await fixture(),id=randomUUID(),other='team:other-scope',cursor={created_at:'2026-11-03T00:00:00Z',event_id:randomUUID()};
 const verify=f.m.storage.verifyMlsReadyCheckpoint.bind(f.m.storage);let queued,injected=false;
 f.m.storage.verifyMlsReadyCheckpoint=async cp=>{
  const ok=await verify(cp);
  if(ok&&!injected){injected=true;queued=f.m._saveEncryptionSyncCheckpoint({scopeCursors:{[other]:cursor}});}
  return ok;
 };
 try{
  await f.send('Ready queue race',id);await queued;
  assert.equal(injected,true);assert.equal(f.calls.length,1);
  const sent=await f.m.storage.loadPendingE2eeSend(id);
  assert.equal(sent.status,'sent');assert.equal(sent.message_id,id);assert.ok(sent.mls_ciphertext.length>0);
  assert.equal((await f.m.storage.loadScopeSyncCursor(other)).event_id,cursor.event_id);
  assert.equal(f.m._providerPersistenceUncertain,false);
 }finally{await queued;await f.close();}
});


test('ten rapid sends reserve every durable intent while the first HTTP is still blocked',async()=>{
 const f=await fixture(),entered=latch(),release=latch(),reserved=latch(),ids=Array.from({length:10},()=>randomUUID());
 const reserve=f.m.storage.reserveApplicationIntent.bind(f.m.storage);const reservedIds=new Set();let timer;const tasks=[];
 f.m.storage.reserveApplicationIntent=async(...args)=>{const row=await reserve(...args);reservedIds.add(row.message_id);if(reservedIds.size>=10)reserved.open();return row;};
 f.m.e2eeClient.sendMessage=async(_t,_c,body)=>{entered.open();await release.promise;return{message:{id:body.message.id}};};
 try{
  tasks.push(f.send('burst-0',ids[0]));await entered.promise;
  for(let i=1;i<ids.length;i++)tasks.push(f.send('burst-'+i,ids[i]));
  await Promise.race([reserved.promise,new Promise(resolve=>{timer=setTimeout(resolve,1000)})]);
  const snapshot=await Promise.all(ids.map(id=>f.m.storage.loadPendingE2eeSend(id)));
  assert.equal(snapshot.filter(Boolean).length,10,'waiting behind a network send must not leave optimistic UUIDs only in memory');
  for(let i=1;i<snapshot.length;i++){assert.equal(snapshot[i].message_id,ids[i]);assert.equal(snapshot[i].payload.text,'burst-'+i);assert.equal(snapshot[i].mls_ciphertext,undefined,'reservation must not advance the ratchet');}
 }finally{clearTimeout(timer);release.open();await Promise.allSettled(tasks);await f.close();}
});


test('channel publishes an E2EE sending bubble only after its durable intent reservation',async()=>{
 const f=await fixture(),id=randomUUID(),entered=latch(),release=latch(),http=latch(),finish=latch();
 const {ErmisChat}=require('../dist/index.cjs'),c=new ErmisChat('fixture','project','http://fixture.invalid',{browser:false,logger:()=>{}});
 c._setUser({id:f.user});c.deviceId=f.device;c.encryptionManager=f.m;f.m.client=c;const ch=c.channel('team',f.cid.slice(5));ch.data={mls_enabled:true};
 const reserve=f.m.storage.reserveApplicationIntent.bind(f.m.storage);f.m.storage.reserveApplicationIntent=async(...args)=>{entered.open();await release.promise;return reserve(...args);};
 f.m.e2eeClient.sendMessage=async(_t,_cid,body)=>{http.open();await finish.promise;return{message:{id:body.message.id,text:'durable-bubble'}};};
 const sending=ch.sendMessage({id,text:'durable-bubble'});let publishedBeforeReservation;
 try{await entered.promise;publishedBeforeReservation=ch.state.messages.some(m=>m.id===id);release.open();await http.promise;
  assert.equal(publishedBeforeReservation,false,'an optimistic UI UUID must not imply a send that exists only in memory');
  assert.ok(await f.m.storage.loadPendingE2eeSend(id));assert.equal(ch.state.messages.find(m=>m.id===id)?.status,'sending');
 }finally{release.open();finish.open();await Promise.allSettled([sending]);await f.close();}
});


// LOR-BUG-ATTACHMENT-EDIT-001: public consumer + actual WASM/IndexedDB.
test('public Channel caption edit preserves authenticated image manifest and peer snapshot',async()=>{
 const f=await fixture(),id=randomUUID(),attachmentId=randomUUID(),assetId=randomUUID();
 const manifest={version:1,attachment_id:attachmentId,attachment_type:'image',assets:[{asset_id:assetId,kind:'original',frame_size:262144,content_key:Buffer.alloc(32,7).toString('base64'),nonce_prefix:Buffer.alloc(8,3).toString('base64'),cipher_sha256:'a'.repeat(64),cipher_size:24,plaintext_size:0,display:{name:'qaatt-image.png',mime_type:'image/png'}}]};
 const bp=new f.w.Provider(),bob=new f.w.Identity(bp,'edit-peer'),g=f.m.getGroup(f.cid),bundle=g.add_members(f.m.provider,f.m.identity,[bob.key_package_typed(bp)]);g.merge_pending_commit(f.m.provider);g.save_state(f.m.provider);f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:Number(g.epoch())});await f.m._writeMlsMutation(f.cid,null);const peer=f.w.Group.join(bp,bundle.welcome,g.export_ratchet_tree());
 try{
  await f.m.sendMessage('team',f.cid.slice(5),f.cid,'QAATT-original',id,{attachments:[manifest],e2ee_attachment_ids:[attachmentId]});
  const first=f.calls.at(-1).body.message.mls_ciphertext;peer.process_application_message(bp,first,undefined);
  const {ErmisChat,buildE2eeMessageAadV1}=require('../dist/index.cjs'),c=new ErmisChat('fixture','project','http://fixture.invalid',{browser:false,logger:()=>{}});c._setUser({id:f.user});c.deviceId=f.device;c.encryptionManager=f.m;f.m.client=c;const ch=c.channel('team',f.cid.slice(5));ch.data={mls_enabled:true};
  await ch.editMessage(id,{text:'QAATT-edited'});
  const row=await f.m.storage.loadPendingE2eeSend(id);assert.deepEqual(row.payload.attachments,[manifest],'caption edit must keep complete authenticated manifest');assert.deepEqual(row.e2ee_attachment_ids,[attachmentId]);assert.equal(row.operation_kind,'update');assert.notDeepEqual(row.mls_ciphertext,first);
  const processed=peer.process_application_message(bp,row.mls_ciphertext,undefined),payload=JSON.parse(new TextDecoder().decode(processed.content));assert.equal(payload.text,'QAATT-edited');assert.deepEqual(payload.attachments,[manifest]);assert.deepEqual(processed.aad,buildE2eeMessageAadV1({cid:f.cid,e2ee_group_id:f.cid,message_id:id,e2ee_attachment_ids:[attachmentId]}));
  const reopened=new IndexedDBEncryptionStorage(f.user);try{assert.deepEqual((await reopened.loadMessage(id)).attachments,[manifest]);assert.equal((await reopened.loadMessage(id)).text,'QAATT-edited');}finally{await reopened.close()}
 }finally{peer.free();bob.free();bp.free();await f.close()}
});

test('unsealed attachment caption edit retains authenticated manifest AAD after restart',async()=>{
 const f=await fixture(),id=randomUUID(),attachmentId=randomUUID(),assetId=randomUUID();let resumed,second;
 const manifest={version:1,attachment_id:attachmentId,attachment_type:'file',assets:[{asset_id:assetId,kind:'original',frame_size:262144,content_key:Buffer.alloc(32,7).toString('base64'),nonce_prefix:Buffer.alloc(8,3).toString('base64'),cipher_sha256:'a'.repeat(64),cipher_size:24,plaintext_size:0,display:{name:'qaatt-restart.txt',mime_type:'text/plain'}}]};
 const bp=new f.w.Provider(),bob=new f.w.Identity(bp,'edit-restart-peer'),g=f.m.getGroup(f.cid),bundle=g.add_members(f.m.provider,f.m.identity,[bob.key_package_typed(bp)]);g.merge_pending_commit(f.m.provider);g.save_state(f.m.provider);f.m._groupGenerations.set(f.cid,{...f.m._groupGenerations.get(f.cid),current_epoch:Number(g.epoch())});await f.m._writeMlsMutation(f.cid,null);const peer=f.w.Group.join(bp,bundle.welcome,g.export_ratchet_tree());
 try{
  await f.m.sendMessage('team',f.cid.slice(5),f.cid,'QAATT-before-restart',id,{attachments:[manifest],e2ee_attachment_ids:[attachmentId]});peer.process_application_message(bp,f.calls.at(-1).body.message.mls_ciphertext,undefined);
  f.m.storage.readyCheckpointVersion=undefined;
  await assert.rejects(f.m.updateMessage('team',f.cid.slice(5),f.cid,id,'QAATT-after-restart'));
  const held=await f.m.storage.loadPendingE2eeSend(id);assert.equal(held.unsealed_intent_version,1);assert.equal(held.mls_ciphertext,undefined);assert.equal(held.operation_kind,'update');
  resumed=await f.manager();f.loadGroup(resumed);resumed.e2eeClient=f.m.e2eeClient;
  resumed.client.channel=()=>({restorePendingE2eeAttachmentUpload:()=>{},updatePendingE2eeAttachmentUpload:()=>{},completePendingE2eeAttachmentUpload:()=>{},failPendingE2eeAttachmentUpload:()=>{}});
  // Explicitly failed edits are resubmitted through the edit API, never the
  // new-message retry endpoint (which intentionally rejects operation=update).
  await resumed.updateMessage('team',f.cid.slice(5),f.cid,id,'QAATT-after-restart');
  const updates=f.calls.filter(x=>x.kind==='update');assert.equal(updates.length,1);const processed=peer.process_application_message(bp,updates[0].body.message.mls_ciphertext,undefined),payload=JSON.parse(new TextDecoder().decode(processed.content));
  assert.equal(payload.text,'QAATT-after-restart');assert.deepEqual(payload.attachments,[manifest]);assert.equal(payload.old_texts.at(-1).text,'QAATT-before-restart');
  const {buildE2eeMessageAadV1}=require('../dist/index.cjs');const aad={cid:f.cid,e2ee_group_id:f.cid,message_id:id,e2ee_attachment_ids:[attachmentId]};assert.deepEqual(processed.aad,buildE2eeMessageAadV1(aad));
  // A process may die immediately after a queued intent is durably reserved.
  // Use the real reservation boundary; no failed status/Ready guard is relaxed.
  const now=Date.now();await resumed._reserveApplicationIntent({operation_kind:'update',message_id:id,cid:f.cid,e2ee_group_id:f.cid,channel_type:'team',channel_id:f.cid.slice(5),text:'QAATT-queued-restart',payload:{...payload,text:'QAATT-queued-restart',old_texts:[...payload.old_texts,{text:payload.text,created_at:'2026-10-01T00:00:00Z'}]},e2ee_attachment_ids:[attachmentId],aad_metadata:aad,send_envelope:{},retry_count:0,status:'sending',created_at:now,updated_at:now},true);
  second=await f.manager();f.loadGroup(second);second.e2eeClient=f.m.e2eeClient;second.client.channel=resumed.client.channel;
  let job;const process=second._processQueuedE2eeAttachmentMessage.bind(second);second._processQueuedE2eeAttachmentMessage=record=>(job=process(record));await second.resumePendingE2eeSends();assert.ok(job);await job;
  const last=f.calls.filter(x=>x.kind==='update').at(-1),restored=peer.process_application_message(bp,last.body.message.mls_ciphertext,undefined),latest=JSON.parse(new TextDecoder().decode(restored.content));assert.equal(latest.text,'QAATT-queued-restart');assert.deepEqual(latest.attachments,[manifest]);assert.deepEqual(latest.old_texts.map(x=>x.text),['QAATT-before-restart','QAATT-after-restart']);assert.deepEqual(restored.aad,buildE2eeMessageAadV1(aad));
 }finally{await second?.storage.close();await resumed?.storage.close();peer.free();bob.free();bp.free();await f.close()}
});
