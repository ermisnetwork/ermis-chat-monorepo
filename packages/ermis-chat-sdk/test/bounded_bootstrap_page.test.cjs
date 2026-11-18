const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {EncryptionManager,IndexedDBEncryptionStorage,ErmisChat}=require('../dist/index.cjs');
let n=0;
function rows(m,count=1000){m.userId='user';m.client={baseURL:'https://fixture.invalid',projectId:'p',activeChannels:{},state:{users:{}},dispatchEvent:()=>{}};for(let i=0;i<count;i++){let cid='team:'+String(i).padStart(4,'0');m.client.activeChannels[cid]={type:'team',id:cid.slice(5),cid,data:{mls_enabled:true,last_message_at:new Date(100000+i*1000).toISOString(),updated_at:'2099-01-01T00:00:00Z'},state:{members:{user:{user_id:'user',channel_role:'member'}}}};}}
test('1000 metadata channels select warm scopes from existing last_message_at with updated_at fallback',()=>{const m=new EncryptionManager();rows(m);assert.deepEqual(m._warmScopeCids('team:0000'),['team:0000','team:0999','team:0998','team:0997','team:0996','team:0995']);assert.equal(m.groups.size,0);assert.equal(m._warmScopeCids().length,5);});
test('inherited topics share one MLS warm slot and active topic gives parent priority',()=>{const m=new EncryptionManager();rows(m,8);m.client.activeChannels['topic:active']={type:'topic',id:'active',data:{mls_enabled:true,e2ee_group_id:'team:0000',parent_cid:'team:0000',gate:false,last_message_at:'2026-11-16T00:00:00Z'},state:{members:{user:{user_id:'user',channel_role:'member'}}}};const selected=m._warmScopeCids('topic:active');assert.equal(selected[0],'team:0000');assert.equal(selected.length,6);assert.equal(new Set(selected).size,6);});
test('metadata ties use CID ascending and pending invitation consumes no warm slot',()=>{const m=new EncryptionManager();rows(m,8);for(const c of Object.values(m.client.activeChannels))c.data.last_message_at='2026-11-16T00:00:00Z';m.client.activeChannels['team:0000'].state.members.user.channel_role='pending';assert.deepEqual(m._warmScopeCids(),['team:0001','team:0002','team:0003','team:0004','team:0005']);});
test('fresh unopened state head enters warm set even when metadata activity is absent or older',()=>{
 const m=new EncryptionManager();rows(m,8);const channel=m.client.activeChannels['team:0000'];
 assert.equal(m._warmScopeCids().includes(channel.cid),false);
 for(const metadataTime of [undefined,'1970-01-01T00:00:01Z']){
  channel.data.last_message_at=metadataTime;channel.data.updated_at='1970-01-01T00:00:00Z';
  channel.state.last_message_at=new Date('2026-11-18T12:34:23Z');
  assert.equal(m._warmScopeCids()[0],channel.cid);
  assert.equal(m._warmScopeCids().length,5);
 }
 channel.state.last_message_at=null;
 channel.state.latestMessages=[{created_at:new Date('2026-11-18T12:34:23Z')}];
 assert.equal(m._warmScopeCids()[0],channel.cid);
 assert.equal(m.groups.size,0);
});
for(const namespace of ['backend-a/project-a','backend-b/project-b'])test('protected browser recovery key persists and authenticates namespace '+namespace,async()=>{const account='protected-'+(++n),s=new IndexedDBEncryptionStorage(account),key=webcrypto.getRandomValues(new Uint8Array(32));try{await s.saveProtectedRecoveryKey(namespace,'key-1',key,()=>{});await s.close();const reopened=new IndexedDBEncryptionStorage(account);try{assert.deepEqual(await reopened.loadProtectedRecoveryKey(namespace,'key-1',()=>{}),key);assert.equal(await reopened.loadProtectedRecoveryKey(namespace,'other-key',()=>{}),null);assert.equal(await reopened.loadProtectedRecoveryKey(namespace+'-other','key-1',()=>{}),null);const other=new IndexedDBEncryptionStorage(account+'-other');assert.equal(await other.loadProtectedRecoveryKey(namespace,'key-1',()=>{}),null);await other.close();}finally{await reopened.close();}}finally{key.fill(0);await s.close();}});
test('corrupt protected recovery key rejects; retired owner cannot save or receive key',async()=>{const s=new IndexedDBEncryptionStorage('corrupt-'+(++n));try{await s.saveProtectedRecoveryKey('scope','key',new Uint8Array(32),()=>{});const db=await s.openDB();await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite'),store=tx.objectStore('meta'),req=store.get('recovery_unlock:v1:scope');req.onsuccess=()=>{req.result.ciphertext[0]^=1;store.put(req.result,'recovery_unlock:v1:scope');};tx.oncomplete=yes;tx.onabort=no;});await assert.rejects(s.loadProtectedRecoveryKey('scope','key',()=>{}));await assert.rejects(s.saveProtectedRecoveryKey('scope','key',new Uint8Array(32),()=>{throw Error('retired');}),/retired/);}finally{await s.close();}});
test('metadata persistence excludes application content and is namespace scoped',async()=>{const s=new IndexedDBEncryptionStorage('metadata-'+(++n));try{const value=[{channel:{cid:'team:1',last_message_at:'2026-11-16T00:00:00Z'},topics:[]}];await s.saveChannelMetadata('backend/project/account',value,()=>{});assert.deepEqual(await s.loadChannelMetadata('backend/project/account'),value);assert.equal(await s.loadChannelMetadata('other/project/account'),null);}finally{await s.close();}});
test('successful startup metadata result is shared across sequential consumers and invalidated by account switch',async()=>{const c=new ErmisChat('key','p','https://fixture.invalid',{browser:false,logger:()=>{}});c.userID='one';let calls=0;c.queryChannels=async()=>{calls++;return[];};await Promise.all([c.loadChannelMetadata({}),c.loadChannelMetadata({})]);await c.loadChannelMetadata({});assert.equal(calls,1);c.userID='two';await c.loadChannelMetadata({});assert.equal(calls,2);});
test('page restore uses exact epoch material, zero ciphertext queries, and never marks epoch complete',async()=>{const m=new EncryptionManager(),s=new IndexedDBEncryptionStorage('page-'+(++n));Object.assign(m,{storage:s,userId:'user',deviceId:'device',_recoveryPrivateKey:new Uint8Array(32),_recoveryKeyId:'recovery'});rows(m,1);let queries=0;m.e2eeClient={queryEpochArchives:async(t,id,opt)=>{queries++;assert.equal(opt.epoch_from,7);assert.equal(opt.epoch_to,7);assert.equal(opt.list_epochs,undefined);return{blobs:[],wraps:[],snapshots:{}};},queryArchiveCiphertexts:async()=>assert.fail('whole epoch ciphertext fetch forbidden')};const row={id:'message',cid:'team:0000',content_type:'mls',mls_ciphertext:new Uint8Array([1,2]),mls_epoch:7,group_generation:3,created_at:'2026-11-16T00:00:00Z'};try{await m.restoreHistoryPage('team','0000',[row]);assert.equal(queries,1);const progress=await s.loadRestoreProgress('user','device','team:0000',3);assert.deepEqual(progress.completed_epochs,[]);assert.notEqual(progress.status,'done');assert.equal(m.groups.size,0);}finally{await s.close();}});
test('history page rejects malformed explicit generation and oversized requested pages',async()=>{const m=new EncryptionManager();m._recoveryPrivateKey=new Uint8Array(32);rows(m,1);m.e2eeClient={queryEpochArchives:async()=>assert.fail('invalid provenance must not fetch archives')};assert.deepEqual(await m.restoreHistoryPage('team','0000',[{id:'invalid-generation',group_generation:null,mls_epoch:1,mls_ciphertext:new Uint8Array([1]),created_at:'2026-11-16T00:00:00Z'}]),[]);await assert.rejects(m.restoreHistoryPage('team','0000',Array(51).fill({})),/exceeds 50/);});
test('archive material cache accounts replacement and evicts to at most16MiB',async()=>{const m=new EncryptionManager();rows(m,1);m._recoveryKeyId='key';let calls=0;m.e2eeClient={queryEpochArchives:async()=>{calls++;return{blobs:[{archive_blob_id:'blob',member_snapshot_hash:'snapshot',bytes:new Uint8Array(9*1024*1024)}],wraps:[{archive_blob_id:'blob'}],snapshots:{snapshot:{snapshot_bytes:new Uint8Array([1])}}};}};await m._historyPageMaterial('team','0000',0,1);await m._historyPageMaterial('team','0000',0,2);assert.ok(m._archivePageMaterialBytes<=16*1024*1024);assert.equal(m._archivePageMaterial.size,1);await m._historyPageMaterial('team','0000',0,2);assert.equal(calls,2);});

test('baseline omitted generation selects only legacy zero material even when live generation is newer',async()=>{
const m=new EncryptionManager(),s=new IndexedDBEncryptionStorage('legacy-page-'+(++n));
Object.assign(m,{storage:s,userId:'user',deviceId:'device',_recoveryPrivateKey:new Uint8Array(32),_recoveryKeyId:'recovery'});rows(m,1);
m._groupGenerations.set('team:0000',{group_generation:9});let queries=0;
m.e2eeClient={queryEpochArchives:async(t,id,opt)=>{queries++;assert.equal(opt.group_generation,0);assert.equal(opt.epoch_from,7);assert.equal(opt.epoch_to,7);return{blobs:[],wraps:[],snapshots:{}};},queryArchiveCiphertexts:async()=>assert.fail('whole epoch ciphertext fetch forbidden')};
try{await m.restoreHistoryPage('team','0000',[{id:'legacy-message',cid:'team:0000',content_type:'mls',mls_ciphertext:new Uint8Array([1,2]),mls_epoch:7,created_at:'2026-11-16T00:00:00Z'}]);assert.equal(queries,1);assert.equal(m._groupGenerations.get('team:0000').group_generation,9);assert.equal(m.groups.size,0);}finally{await s.close();}});

test('automatic channel page hydration normalizes base64 and legacy array ciphertexts before archive restoration',async()=>{
 const s=new IndexedDBEncryptionStorage('wire-page-'+(++n));const client=new ErmisChat('fixture-key','fixture-project','https://fixture.invalid',{browser:false,logger:()=>{}});
 client.userID='user';client.user={id:'user'};const m=new EncryptionManager();Object.assign(m,{client,storage:s,userId:'user',deviceId:'device',initialized:true,_recoveryPrivateKey:new Uint8Array(32),_recoveryKeyId:'recovery'});client.encryptionManager=m;rows(m,1);
 const ch=client.channel('team','0000');ch.data={cid:ch.cid,mls_enabled:true};let calls=0;
 m._restoreHistoricalMessagesInternal=async(type,id,options)=>{calls++;assert.equal(type,'team');assert.equal(id,'0000');assert.equal(options.groupGeneration,0);assert.equal(options.pageCiphertexts.length,3);for(const row of options.pageCiphertexts){assert.ok(row.mls_ciphertext instanceof Uint8Array);assert.deepEqual([...row.mls_ciphertext],[1,2]);}return[];};
 const restore=m.restoreHistoryPage.bind(m);let work;m.restoreHistoryPage=(...args)=>(work=restore(...args));
 try{await ch._hydrateE2eeMessagesFromLocalCache(['AQI=',[1,2],new Uint8Array([1,2])].map((cipher,i)=>({id:'wire-'+i,cid:ch.cid,content_type:'mls',mls_ciphertext:cipher,mls_epoch:7,created_at:'2026-11-16T00:00:00Z'})));await work;assert.equal(calls,1);}finally{await s.close();}
});


test('native vault setup and unlock notify consumers only after protected recovery key persistence',async()=>{
 const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
 const w=await import(pathToFileURL(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm.js')));
 await w.default({module_or_path:fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))});
 const s=new IndexedDBEncryptionStorage('unlock-notify-'+(++n)),m=new EncryptionManager();rows(m,1);
 Object.assign(m,{storage:s,deviceId:'device',_injectedWasm:w});await m._initWasm();await m._initIdentity();await m._persistProviderStrict();m.initialized=true;
 const order=[],events=[];let vault;
 m.client.dispatchEvent=e=>{if(e.type==='e2ee.recovery_unlocked'){events.push(e);order.push('notify');assert.equal(m.isRecoveryVaultUnlocked(),true);assert.deepEqual(Object.keys(e),['type']);}};
 m.e2eeClient={uploadRecoveryVault:async data=>{vault=data.vault_bytes;return{status:'created',revision:1};}};
 m._scheduleRecoveryPostUnlockMaintenance=()=>{};
 const save=s.saveProtectedRecoveryKey.bind(s);s.saveProtectedRecoveryKey=async(...args)=>{await save(...args);order.push('persist');};
 try{
  await m.setupRecoveryPin('12345678');assert.deepEqual(order,['persist','notify']);assert.ok(vault);
  m.clearRecoveryUnlock();order.length=0;await m.unlockRecoveryVault('12345678');assert.deepEqual(order,['persist','notify']);assert.equal(events.length,2);
  m.clearRecoveryUnlock();order.length=0;s.saveProtectedRecoveryKey=async()=>{throw Error('protected storage unavailable');};
  await assert.rejects(m.unlockRecoveryVault('12345678'),/protected storage unavailable/);assert.equal(events.length,2);assert.deepEqual(order,[]);
 }finally{m.destroy();await s.close();}
});


test('reopening an attempted history page is quiet; explicit retry and changed ciphertext are eligible',async()=>{
 const s=new IndexedDBEncryptionStorage('quiet-page-'+(++n)),m=new EncryptionManager();rows(m,1);
 Object.assign(m,{storage:s,deviceId:'device',initialized:true,_recoveryPrivateKey:new Uint8Array(32),_recoveryKeyId:'key'});
 const events=[];let calls=0;m.client._beginSessionProgress=()=>{events.push('begin');return 'page';};m.client._finishSessionProgress=(id,partial,retry)=>events.push({partial,retry});
 m._restoreHistoricalMessagesInternal=async()=>{calls++;return[{epoch:0,gap:true,reason:'no_archive'}]};
 const page=[{id:'quiet-message',cid:'team:0000',content_type:'mls',mls_ciphertext:new Uint8Array([1,2]),mls_epoch:0,group_generation:0,created_at:'2026-11-17T00:00:00Z'}];
 try{
  await m.restoreHistoryPage('team','0000',page);assert.equal(calls,1);assert.equal(events.length,2);assert.equal(events[1].partial,true);
  await m.restoreHistoryPage('team','0000',page);assert.equal(calls,1);assert.equal(events.length,2);
  await events[1].retry();assert.equal(calls,2);
  await m.restoreHistoryPage('team','0000',[{...page[0],mls_ciphertext:new Uint8Array([1,3])}]);assert.equal(calls,3);
 }finally{await s.close();}
});

test('bound cached plaintext skips archive work and progress; changed ciphertext cannot reuse it',async()=>{
 const s=new IndexedDBEncryptionStorage('cached-page-'+(++n)),m=new EncryptionManager();rows(m,1);
 Object.assign(m,{storage:s,deviceId:'device',initialized:true,_recoveryPrivateKey:new Uint8Array(32),_recoveryKeyId:'key'});
 let calls=0,progress=0;m.client._beginSessionProgress=()=>{progress++;return 'page';};m.client._finishSessionProgress=()=>{};
 m._restoreHistoricalMessagesInternal=async()=>{calls++;return[]};
 const row={id:'cached-message',cid:'team:0000',content_type:'mls',mls_ciphertext:new Uint8Array([1,2]),mls_epoch:0,group_generation:0,created_at:'2026-11-17T00:00:00Z'};
 try{
  await s.saveMessage(m._storedFromPayload('team:0000',{text:'already authenticated'},row));
  await m.restoreHistoryPage('team','0000',[row]);assert.equal(calls,0);assert.equal(progress,0);
  await m.restoreHistoryPage('team','0000',[{...row,mls_ciphertext:new Uint8Array([1,3])}]);assert.equal(calls,1);assert.equal(progress,1);
 }finally{await s.close();}
});


test('partial archive material is not pinned before a matching wrap and snapshot arrive',async()=>{
 const m=new EncryptionManager();rows(m,1);m._recoveryKeyId='key';let calls=0;
 const blob={archive_blob_id:'blob',member_snapshot_hash:'snapshot',epoch:1};
 m.e2eeClient={queryEpochArchives:async()=>{calls++;return calls===1?{blobs:[blob],wraps:[],snapshots:{}}:{blobs:[blob],wraps:[{archive_blob_id:'blob'}],snapshots:{snapshot:{snapshot_bytes:new Uint8Array([1])}}};}};
 const first=await m._historyPageMaterial('team','0000',0,1);assert.equal(first.wraps.length,0);
 const next=await m._historyPageMaterial('team','0000',0,1);assert.equal(calls,2);assert.equal(next.wraps.length,1);
});

test('explicit page retry refreshes epoch material while ordinary reopen remains quiet',async()=>{
 const s=new IndexedDBEncryptionStorage('retry-material-'+(++n)),m=new EncryptionManager();rows(m,1);
 Object.assign(m,{storage:s,userId:'user',deviceId:'device',_recoveryPrivateKey:new Uint8Array(32),_recoveryKeyId:'key'});
 let calls=0;m.e2eeClient={queryEpochArchives:async()=>{calls++;return{blobs:[{archive_blob_id:'blob',member_snapshot_hash:'snapshot',epoch:1}],wraps:[{archive_blob_id:'blob'}],snapshots:{snapshot:{snapshot_bytes:new Uint8Array([1])}}};}};
 m._restoreHistoricalMessagesInternal=async()=>{await m._historyPageMaterial('team','0000',0,1);return[{epoch:1,gap:true,reason:'missing_snapshot'}];};
 const page=[{id:'retry-message',cid:'team:0000',content_type:'mls',mls_ciphertext:new Uint8Array([1]),mls_epoch:1,created_at:'2026-11-18T00:00:00Z'}];
 try{await m.restoreHistoryPage('team','0000',page);await m.restoreHistoryPage('team','0000',page);assert.equal(calls,1);
 await m.restoreHistoryPage('team','0000',page,{retry:true});assert.equal(calls,2);}finally{await s.close();}
});


test('warm list preview demand restores one exact encrypted head and leaves normal scope state untouched',async()=>{
 const m=new EncryptionManager();rows(m,9);m._recoveryPrivateKey=new Uint8Array(32);m._recoveryKeyId='fixture';
 const selected=[];m.restoreHistoryPage=async(type,id,page)=>{selected.push({cid:type+':'+id,page});return[];};
 for(const channel of Object.values(m.client.activeChannels))channel.state.latestMessages=[{id:'older-'+channel.cid,mls_ciphertext:new Uint8Array([1]),created_at:new Date(0)},
 {id:'head-'+channel.cid,cid:channel.cid,mls_ciphertext:new Uint8Array([2]),mls_epoch:1,created_at:new Date(2000)}];
 await m._restoreWarmListPreviews();assert.equal(selected.length,5);
 assert.ok(selected.every(x=>x.page.length===1&&x.page[0].id==='head-'+x.cid));
 assert.equal(m._lastSyncStates.size,0);assert.equal(m.groups.size,0);
 m._providerPersistenceUncertain=true;await m._restoreWarmListPreviews();assert.equal(selected.length,5);
});


test('optional preview failure does not suppress later heads or fail the completed protocol sync',async()=>{
 const m=new EncryptionManager();rows(m,4);m._recoveryPrivateKey=new Uint8Array(32);m._recoveryKeyId='fixture';
 const attempted=[];
 for(const [i,channel] of Object.values(m.client.activeChannels).entries())channel.state.latestMessages=[{id:'head-'+i,mls_ciphertext:new Uint8Array([2]),created_at:new Date(i*1000)}];
 m.restoreHistoryPage=async(t,id,page)=>{attempted.push(page[0].id);if(attempted.length===1)throw new Error('archive transport unavailable');return[];};
 await m._restoreWarmListPreviews();assert.deepEqual(attempted,['head-3','head-2','head-1','head-0']);
 m._syncAndRestoreGroups=async()=>{};m._scheduleScopeSyncRetry=()=>assert.fail('preview must not retry protocol sync');
 await m.sync();assert.equal(m.isSyncing(),false);
});
