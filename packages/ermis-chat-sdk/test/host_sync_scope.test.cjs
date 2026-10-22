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

const {ErmisChat}=require('../dist/index.cjs');
function host(){
 const c=new ErmisChat('local-key','local-project','http://example.test',{browser:false,logger:()=>{}});
 const id='host-'+randomUUID(),storage=new IndexedDBEncryptionStorage(id),m=new EncryptionManager();
 Object.assign(m,{initialized:true,userId:id,deviceId:'device',identity:{},storage,client:c,e2eeClient:{},_wasmArtifactSha256:'local-fixture'});
 m.handleChannelsHydrated=()=>{};m.markSyncStart=()=>{};m.sync=async()=>{};
 c.userID=id;c.deviceId='device';c.messageStorage=storage;c.encryptionManager=m;
 const state={lastSyncedEventSeq:1,lastSyncedAt:null,hiddenEventSeqs:new Set(),hiddenMessageSeqs:new Set()};
 const channel={cid:'team:host',state,data:{mls_enabled:false},applySyncResult:async()=>{},syncUntilCaughtUp:async()=>{}};
 c.activeChannels={'team:host':channel};c.globalSync=async()=>({channels:{}});const events=[];c.dispatchEvent=e=>{events.push(e.type);};
 return{c,m,storage,channel,events,close:()=>storage.close()};
}
test('disabled synchronous APIs touch neither active nor durable crypto even while a checkpoint is unavailable',async()=>{
 const f=await fixture(),active=f.m._activeProvider,group=f.m.groups.get(f.cid),before=await f.m.storage.loadProviderCheckpoint(f.user,f.device),msg=f.message();
 f.m._providerCheckpointInFlight=true;
 assert.throws(()=>f.m.encryptMessage(f.cid,{text:'must not escape'}),e=>e.code==='client_upgrade_required');
 assert.throws(()=>f.m.decryptMessage(f.cid,msg.mls_ciphertext),e=>e.code==='client_upgrade_required');
 assert.equal(f.m._activeProvider,active);assert.equal(f.m.groups.get(f.cid),group);assert.deepEqual(await f.m.storage.loadProviderCheckpoint(f.user,f.device),before);assert.equal(await f.m.storage.loadMessage(msg.id),null);
 f.m._providerCheckpointInFlight=false;const result=await f.m.processE2eeMessage(f.cid,msg);assert.equal(result.text,'receiver');assert.equal((await f.m.storage.loadMessage(msg.id)).mls_application_checkpoint_version,1);await f.close();
});
test('same-scope duplicate host sync has one manager/HTTP run and waits for actual metadata persistence before completion',async()=>{
 const h=host(),entered=latch(),release=latch(),save=h.storage.saveSyncStateBatch.bind(h.storage);let crypto=0,http=0;
 h.m.sync=async()=>{crypto++;};h.c.globalSync=async()=>{http++;return{channels:{}};};h.storage.saveSyncStateBatch=async records=>{entered.open();await release.promise;return save(records);};
 const a=h.c.performSync(true),b=h.c.performSync(true);await entered.promise;assert.equal(crypto,1);assert.equal(http,1);assert.equal(h.events.includes('sync.completed'),false);assert.equal(h.c._lastSyncCompletedAt,0);release.open();await Promise.all([a,b]);assert.equal(h.events.filter(e=>e==='sync.completed').length,1);assert.equal((await h.storage.loadAllSyncStates())[0].lastSyncedEventSeq,1);assert.equal(h.c._syncPromise,null);await h.close();
});
test('failed metadata write blocks completion and success throttle without deleting existing durable cursor',async()=>{
 const h=host();await h.storage.saveSyncStateBatch([{version:2,cid:h.channel.cid,lastSyncedEventSeq:4,hiddenEventSeqs:[],hiddenMessageSeqs:[],updatedAt:new Date().toISOString()}]);
 h.storage.saveSyncStateBatch=async()=>{throw Error('local quota');};await assert.rejects(h.c.performSync(true),/local quota/);assert.equal(h.events.includes('sync.completed'),false);assert.equal(h.c._lastSyncCompletedAt,0);assert.equal((await h.storage.loadAllSyncStates())[0].lastSyncedEventSeq,4);await h.close();
});
test('strict startup restore failure stays retryable and never starts manager sync; default restore remains best effort',async()=>{
 const h=host();let sync=0;h.m.sync=async()=>{sync++;};h.storage.loadAllSyncStates=async()=>{throw Error('unavailable local store');};h.c._scheduleHydratedColdStartSync();await h.c._waitForHydratedColdStartSync();assert.equal(h.c._coldStartSyncState,'retryable');assert.equal(sync,0);await h.c.restoreSyncState();await assert.rejects(h.c.restoreSyncState({strict:true}),/unavailable/);await h.close();
});
for(const dimension of ['account','device','message_adapter','manager','signer','crypto_adapter','transport','artifact','channel_container','initialized'])test('late startup restore cannot start or publish into replaced '+dimension,async()=>{
 const h=host(),entered=latch(),release=latch();let sync=0,newSync=0;h.c.restoreSyncState=async()=>{entered.open();await release.promise;};h.m.sync=async()=>{sync++;};
 h.c._scheduleHydratedColdStartSync();const old=h.c._coldStartSyncPromise;await entered.promise;
 if(dimension==='account')h.c.userID+='-new';else if(dimension==='device')h.c.deviceId='new';else if(dimension==='message_adapter')h.c.messageStorage={};else if(dimension==='manager')h.c.encryptionManager={initialized:true,handleChannelsHydrated(){},markSyncStart(){},sync:async()=>{newSync++;}};else if(dimension==='signer')h.m.identity={};else if(dimension==='crypto_adapter')h.m.storage={};else if(dimension==='transport')h.m.e2eeClient={};else if(dimension==='artifact')h.m._wasmArtifactSha256='new';else if(dimension==='channel_container')h.c.activeChannels={...h.c.activeChannels};else h.m.initialized=false;
 release.open();await old;assert.equal(sync,0);assert.equal(newSync,0);assert.notEqual(h.c._coldStartSyncState,'ready');assert.equal(h.c._lastSyncCompletedAt,0);await h.close();
});
for(const failed of [false,true])test('late old host '+(failed?'failure':'success')+' cannot clear replacement promise, state or throttle',async()=>{
 const h=host(),oldEntered=latch(),oldRelease=latch(),newEntered=latch(),newRelease=latch();h.c._performSyncInternal=async()=>{};
 h.m.sync=async()=>{oldEntered.open();await oldRelease.promise;if(failed)throw Error('old scope failed');};const old=h.c.performSync(true);const oldResult=old.catch(e=>e);await oldEntered.promise;
 const replacement={initialized:true,markSyncStart(){},sync:async()=>{newEntered.open();await newRelease.promise;}};h.c.encryptionManager=replacement;
 const next=h.c.performSync(true);await newEntered.promise;const nextOwned=h.c._syncPromise;oldRelease.open();const outcome=await oldResult;assert.ok(outcome instanceof Error);assert.equal(h.c._syncPromise,nextOwned);assert.equal(h.c._syncInProgress,true);assert.equal(h.c._lastSyncCompletedAt,0);newRelease.open();await next;assert.equal(h.c._syncPromise,null);assert.equal(h.c._syncInProgress,false);assert.ok(h.c._lastSyncCompletedAt>0);await h.close();
});
test('late cold-start failure leaves a replacement cold-start owner running and reusable',async()=>{
 const h=host(),first=latch(),oldDone=latch(),second=latch(),newDone=latch();let runs=0;h.c.restoreSyncState=async()=>{};h.c.performSync=async()=>{if(++runs===1){first.open();await oldDone.promise;throw Error('old failed');}second.open();await newDone.promise;};h.c._scheduleHydratedColdStartSync();const old=h.c._coldStartSyncPromise;await first.promise;
 h.c.encryptionManager={initialized:true,handleChannelsHydrated(){}};h.c._scheduleHydratedColdStartSync();await second.promise;const next=h.c._coldStartSyncPromise;oldDone.open();await old;assert.equal(h.c._coldStartSyncPromise,next);assert.equal(h.c._coldStartSyncState,'running');assert.equal(h.c._waitForHydratedColdStartSync(),next);newDone.open();await next;assert.equal(h.c._coldStartSyncState,'ready');await h.close();
});
test('late persisted response and sync.started listener cannot apply events to a replacement session',async()=>{
 const h=host(),entered=latch(),release=latch();let apply=0;h.channel.applySyncResult=async()=>{apply++;};h.c.globalSync=async()=>{entered.open();await release.promise;return{channels:{[h.channel.cid]:{events:[{type:'message.new'}]}}};};const p=h.c.performSync(true);const observed=assert.rejects(p,e=>e.code==='recovery_scope_changed');await entered.promise;h.c.userID='replacement';release.open();await observed;assert.equal(apply,0);assert.equal(h.events.includes('sync.completed'),false);await h.close();
 const q=host();let http=0;q.c.globalSync=async()=>{http++;return{channels:{}};};q.c.dispatchEvent=e=>{if(e.type==='sync.started')q.c.userID='listener-switch';};await assert.rejects(q.c.performSync(true),e=>e.code==='recovery_scope_changed');assert.equal(http,0);await q.close();
});
test('captured restore/persist adapters do not touch replacement storage or channels after awaits',async()=>{
 const h=host(),entered=latch(),release=latch();let nextReads=0,nextWrites=0;h.storage.loadAllSyncStates=async()=>{entered.open();await release.promise;return[{version:2,cid:h.channel.cid,lastSyncedEventSeq:99}];};const restore=h.c.restoreSyncState({strict:true}),rejected=assert.rejects(restore,e=>e.code==='recovery_scope_changed');await entered.promise;h.c.messageStorage={loadRemovedSyncCursor:async()=>{nextReads++;}};release.open();await rejected;assert.equal(nextReads,0);assert.equal(h.channel.state.lastSyncedEventSeq,1);await h.close();
 const q=host(),saveEntered=latch(),saveDone=latch();q.c._removedSyncCursor={removed_at:'2026-10-11T00:00:00Z',event_id:'removed'};q.storage.saveSyncStateBatch=async()=>{saveEntered.open();await saveDone.promise;};const persist=q.c.persistSyncState(),failure=assert.rejects(persist,e=>e.code==='recovery_scope_changed');await saveEntered.promise;q.c.messageStorage={saveRemovedSyncCursor:async()=>{nextWrites++;}};saveDone.open();await failure;assert.equal(nextWrites,0);await q.close();
});
test('logout epoch invalidates host work before awaited manager destruction, including same account ABA',async()=>{
 const h=host(),entered=latch(),release=latch(),destroyed=latch(),cleanup=latch();h.c._performSyncInternal=async()=>{};h.m.sync=async()=>{entered.open();await release.promise;};h.m.destroy=async()=>{destroyed.open();await cleanup.promise;};h.c.closeConnection=async()=>{};h.channel._disconnect=()=>{};h.c.userCache=undefined;h.c._pausePendingStandardAttachmentUploads=()=>{};
 const old=h.c.performSync(true),oldRejected=assert.rejects(old,e=>e.code==='recovery_scope_changed');await entered.promise;const disconnect=h.c.disconnectUser();await destroyed.promise;release.open();await oldRejected;assert.equal(h.c._lastSyncCompletedAt,0);assert.equal(h.c._syncPromise,null);cleanup.open();await disconnect;
});
test('a completion listener replacing the session cannot stamp old success or clear the new sync owner',async()=>{
 const h=host(),entered=latch(),release=latch();let next;
 h.c.dispatchEvent=e=>{if(e.type==='sync.completed'&&!next){h.c.encryptionManager={initialized:true,markSyncStart(){},sync:async()=>{entered.open();await release.promise;}};next=h.c.performSync(true);}};
 const old=h.c.performSync(true),failure=assert.rejects(old,e=>e.code==='recovery_scope_changed');await entered.promise;const owned=h.c._syncPromise;await failure;assert.equal(h.c._lastSyncCompletedAt,0);assert.equal(h.c._syncPromise,owned);release.open();await next;await h.close();
});
test('late removed-channel cleanup cannot delete or publish a replacement channel with the same CID',async()=>{
 const h=host(),entered=latch(),release=latch();Object.assign(h.channel.state,{clearMessages(){},resetSyncState(){}});h.channel._disconnect=()=>{};
 h.c.globalSync=async()=>({channels:{},removed_channels:{events:[{cid:h.channel.cid}]}});h.storage.clearMessages=async()=>{entered.open();await release.promise;};
 const old=h.c.performSync(true),failure=assert.rejects(old,e=>e.code==='recovery_scope_changed');await entered.promise;const newer={...h.channel,state:{...h.channel.state}};h.c.activeChannels={...h.c.activeChannels,[h.channel.cid]:newer};release.open();await failure;assert.equal(h.c.activeChannels[h.channel.cid],newer);assert.equal(h.events.includes('channel.deleted'),false);assert.equal(h.events.includes('sync.completed'),false);await h.close();
});

function teardownHost(){
 const h=host(),calls=[];h.channel._disconnect=()=>{calls.push('channel');};
 h.c.wsConnection={disconnect:async timeout=>{calls.push('ws:'+timeout);}};
 h.c.userCache={close:async()=>{calls.push('cache');}};
 h.m.destroy=async()=>{calls.push('destroy');};
 const close=h.storage.close.bind(h.storage);h.storage.close=async()=>{calls.push('storage');await close();};
 h.c._pausePendingStandardAttachmentUploads=()=>{calls.push('pause');};
 const reset=h.c.tokenManager.reset;h.c.tokenManager.reset=()=>{calls.push('tokens');reset();};
 return{...h,calls};
}
function localLogin(c){
 c.browser=false;c._hydrateUserCacheFromStorage=async()=>{};c._restorePendingStandardAttachmentUploads=async()=>{};
 c.openConnection=async()=>{c.wsConnection={disconnect:async()=>{}};c.wsPromise=Promise.resolve();return undefined;};
 c.queryUser=async id=>({id,name:id});
}
test('duplicate teardown shares one owner and clears closed handles/cursors only after captured resources finish',async()=>{
 const h=teardownHost(),entered=latch(),release=latch();h.c._removedSyncCursor={event_id:'old',removed_at:'old'};h.c.setUserPromise=Promise.resolve();h.c.wsPromise=Promise.resolve();
 h.m.destroy=async()=>{h.calls.push('destroy');entered.open();await release.promise;};
 const a=h.c.disconnectUser(8),b=h.c.disconnectUser(19);assert.equal(a,b);await entered.promise;assert.equal(h.c._disconnectPromise,a);assert.equal(h.c.messageStorage,h.storage);assert.equal(h.calls.filter(x=>x==='destroy').length,1);
 release.open();await a;assert.equal(h.c._disconnectPromise,null);assert.equal(h.c.messageStorage,undefined);assert.equal(h.c.encryptionManager,undefined);assert.equal(h.c.wsConnection,null);assert.equal(h.c.setUserPromise,null);assert.equal(h.c.wsPromise,null);assert.equal(h.c._removedSyncCursor,undefined);assert.equal(h.calls.filter(x=>x==='storage').length,1);assert.equal(h.calls.includes('ws:8'),true);assert.equal(h.calls.includes('ws:19'),false);assert.equal(h.calls.at(-1),'tokens');
});
for(const same of [true,false])test('connectUser '+(same?'same-account ABA':'different-account')+' waits for teardown and no late token timer erases the new login',async()=>{
 const h=teardownHost(),entered=latch(),release=latch();localLogin(h.c);const user=h.c.userID;h.c.setUserPromise=Promise.resolve('old-connection');h.m.destroy=async()=>{entered.open();await release.promise;};
 const logout=h.c.disconnectUser(),login=h.c.connectUser({id:same?user:user+'-new'},'new-token');await entered.promise;assert.equal(h.c.userID,user);assert.equal(h.c.tokenManager.token,undefined);release.open();await logout;await login;await new Promise(r=>setTimeout(r,10));assert.equal(h.c.userID,same?user:user+'-new');assert.equal(h.c.tokenManager.token,'new-token');assert.equal(h.c.messageStorage,undefined);assert.notEqual(h.c.wsConnection,null);
});
for(const dimension of ['account','device','manager','message_adapter','cache','ws','channels','tokens'])test('old teardown cleans captured resources and preserves manual replacement '+dimension,async()=>{
 const h=teardownHost(),entered=latch(),release=latch();h.m.destroy=async()=>{h.calls.push('destroy');entered.open();await release.promise;};
 const old=h.c.disconnectUser(),rejected=assert.rejects(old,e=>e.code==='recovery_scope_changed');await entered.promise;
 const replacementCalls=[];
 if(dimension==='account')h.c.userID+='-new';else if(dimension==='device')h.c.deviceId='new';else if(dimension==='manager')h.c.encryptionManager={destroy:()=>replacementCalls.push('destroy')};else if(dimension==='message_adapter')h.c.messageStorage={close:()=>replacementCalls.push('storage')};else if(dimension==='cache')h.c.userCache={close:()=>replacementCalls.push('cache')};else if(dimension==='ws')h.c.wsConnection={disconnect:()=>replacementCalls.push('ws')};else if(dimension==='channels')h.c.activeChannels={'new':{_disconnect:()=>replacementCalls.push('channel')}};else h.c.tokenManager={reset:()=>replacementCalls.push('tokens'),token:'replacement'};
 const refs=[h.c.userID,h.c.deviceId,h.c.encryptionManager,h.c.messageStorage,h.c.userCache,h.c.wsConnection,h.c.activeChannels,h.c.tokenManager];release.open();await rejected;
 assert.deepEqual([h.c.userID,h.c.deviceId,h.c.encryptionManager,h.c.messageStorage,h.c.userCache,h.c.wsConnection,h.c.activeChannels,h.c.tokenManager],refs);assert.deepEqual(replacementCalls,[]);assert.equal(h.calls.includes('storage'),true);assert.equal(h.calls.includes('cache'),true);assert.equal(h.calls.some(x=>x.startsWith('ws:')),true);assert.equal(h.calls.includes('tokens'),false);assert.equal(h.c._disconnectPromise,null);
});
for(const failed of ['channel','destroy','storage','cache','ws'])test('teardown '+failed+' failure still attempts independent cleanup and blocks an already waiting login',async()=>{
 const h=teardownHost();localLogin(h.c);const boom=()=>{h.calls.push(failed);throw Error('failed '+failed);};
 if(failed==='channel')h.channel._disconnect=boom;else if(failed==='destroy')h.m.destroy=boom;else if(failed==='storage')h.storage.close=boom;else if(failed==='cache')h.c.userCache.close=boom;else h.c.wsConnection.disconnect=boom;
 const logout=h.c.disconnectUser(),loggedOut=assert.rejects(logout,new RegExp('failed '+failed));const login=h.c.connectUser({id:'new-login'},'new-token'),loginBlocked=assert.rejects(login,new RegExp('failed '+failed));await Promise.all([loggedOut,loginBlocked]);
 assert.equal(h.calls.includes('channel'),true);assert.equal(h.calls.includes('destroy'),true);assert.equal(h.calls.includes('storage'),true);assert.equal(h.calls.includes('cache'),true);assert.equal(h.calls.some(x=>x==='ws'||x.startsWith('ws:')),true);assert.equal(h.calls.includes('tokens'),true);assert.equal(h.c._disconnectPromise,null);assert.equal(h.c.userID,undefined);assert.equal(h.c.tokenManager.token,undefined);
 // Explicit retry after the failed teardown has settled; no automatic recovery/Ready.
 await h.c.connectUser({id:'explicit-retry'},'retry-token');assert.equal(h.c.userID,'explicit-retry');assert.equal(h.c.tokenManager.token,'retry-token');if(failed==='storage')await IndexedDBEncryptionStorage.prototype.close.call(h.storage);
});
test('token reset waits for old websocket acknowledgement and finishes before connect admission',async()=>{
 const h=teardownHost(),entered=latch(),release=latch();localLogin(h.c);h.c.tokenManager.token='old-token';h.c.wsConnection.disconnect=async()=>{entered.open();await release.promise;assert.equal(h.c.tokenManager.token,'old-token');};
 const logout=h.c.disconnectUser(),login=h.c.connectUser({id:'replacement'},'new-token');await entered.promise;assert.equal(h.calls.includes('tokens'),false);release.open();await Promise.all([logout,login]);assert.equal(h.c.tokenManager.token,'new-token');
});
test('real WASM provider/checkpoint/plaintext remain durable across host logout and fresh same-user manager reload',async()=>{
 const f=await fixture(),h=teardownHost();await h.storage.close();h.c.messageStorage=f.m.storage;h.c.encryptionManager=f.m;f.m.client=h.c;const msg=f.message();await f.m.processE2eeMessage(f.cid,msg);
 const before=await f.m.storage.loadProviderCheckpoint(f.user,f.device),row=await f.m.storage.loadMessage(msg.id);await h.c.disconnectUser();assert.equal(h.c.messageStorage,undefined);
 const n=await f.restart();const after=await n.storage.loadProviderCheckpoint(f.user,f.device);assert.notEqual(after.revision,before.revision);assert.deepEqual(n.provider.to_bytes(),after.provider_bytes);assert.deepEqual(n.identity.to_bytes(),await n.storage.loadIdentity(f.user,f.device));assert.deepEqual(await n.storage.loadMessage(msg.id),row);assert.equal((await n.processE2eeMessage(f.cid,msg)).text,row.text);assert.equal(n.getEpoch(f.cid),1);n.destroy();await f.close();
});
for(const added of [false,true])test('teardown captures channel handles at entry and preserves '+(added?'an added channel':'a replaced same-CID channel')+' inside the same container',async()=>{
 const h=teardownHost(),entered=latch(),release=latch();h.m.destroy=async()=>{entered.open();await release.promise;};
 const old=h.c.disconnectUser(),rejected=assert.rejects(old,e=>e.code==='recovery_scope_changed');await entered.promise;let disconnected=0;const replacement={_disconnect:()=>{disconnected++;}};const key=added?'team:added':h.channel.cid;h.c.activeChannels[key]=replacement;release.open();await rejected;assert.equal(h.c.activeChannels[key],replacement);assert.equal(disconnected,0);assert.equal(h.calls.filter(x=>x==='channel').length,1);assert.equal(h.calls.includes('tokens'),false);
});
