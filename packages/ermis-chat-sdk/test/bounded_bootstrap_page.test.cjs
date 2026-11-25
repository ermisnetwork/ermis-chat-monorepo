const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {EncryptionManager,IndexedDBEncryptionStorage,ErmisChat}=require('../dist/index.cjs');
let n=0;

test('message Info distinguishes denied epochs, absent material and an unrelated archive request error', async () => {
  const manager = new EncryptionManager();
  rows(manager, 1);
  const storage = new IndexedDBEncryptionStorage('message-info-' + (++n));
  Object.assign(manager, { storage, initialized: true, deviceId: 'device',
    _recoveryPrivateKey: new Uint8Array(32), _recoveryKeyId: 'key' });
  const cid = 'team:0000';
  const calls = [];
  manager.e2eeClient = {
    queryEpochArchives: async (_type, _id, request) => {
      const { epoch_from: epoch, epoch_to } = request;
      assert.equal(epoch, epoch_to);
      calls.push(epoch);
      if (epoch === 49) throw { response: { status: 400, data: {
        ermis_code: 6, message: "you don't have permision to restore this epoch range",
      } } };
      if (epoch === 50) throw { response: { status: 400, data: {
        ermis_code: 6, message: "you don't have permision to query this channel",
      } } };
      return { blobs: [], wraps: [], snapshots: {} };
    },
    queryArchiveCiphertexts: async () => assert.fail('must not fetch whole-epoch ciphertext'),
  };
  const makeMessage = (id, mls_epoch) => ({
    id, cid, mls_epoch, content_type: 'mls', group_generation: 0,
    created_at: new Date('2026-11-16T00:00:00Z'), mls_ciphertext: new Uint8Array([1, 2]),
  });
  const denied = makeMessage('denied', 49);
  const anotherDenied = makeMessage('another-denied', 49);
  const requestFailed = makeMessage('request-failed', 50);
  const noArchive = makeMessage('no-archive', 51);
  const lookup = message => manager.getMessageDecryptionReason(cid, message);
  try {
    assert.equal(await lookup(denied), 'unknown');
    await manager.restoreHistoryPage('team', '0000', [denied, anotherDenied, requestFailed, noArchive]);
    assert.deepEqual(calls, [49, 50, 51]);
    assert.equal(await lookup(denied), 'archive_access_denied');
    assert.equal(await lookup(anotherDenied), 'archive_access_denied');
    assert.equal(await lookup(requestFailed), 'archive_request_failed');
    assert.equal(await lookup(noArchive), 'no_archive');
    assert.equal(await lookup({ ...denied, updated_at: new Date('2026-11-17T00:00:00Z') }), 'unknown');
    assert.equal(await lookup({ ...denied, mls_ciphertext: new Uint8Array([2, 1]) }), 'unknown');
    assert.equal(await lookup({ ...denied, group_generation: 1 }), 'unknown');
    assert.equal(await lookup({ ...denied, mls_epoch: null }), 'invalid_envelope');
    assert.equal(await lookup({ ...denied, mls_ciphertext: '' }), 'invalid_envelope');
    assert.equal(await storage.loadRestoreProgress('user', 'device', cid, 0), null);
    assert.deepEqual(calls, [49, 50, 51]);
    manager._recoveryPrivateKey = null;
    assert.equal(await lookup(makeMessage('locked', 70)), 'unknown');
    manager._recoveryVaultKnown = false;
    assert.equal(await lookup(makeMessage('locked', 70)), 'no_recovery_vault');
    manager._recoveryVaultKnown = true;
    assert.equal(await lookup(makeMessage('locked', 70)), 'pin_locked');
  } finally {
    await storage.close();
  }
});

test('message Info uses persisted receive failures only for the exact message and epoch', async () => {
  const manager = new EncryptionManager();
  rows(manager, 1);
  const cid = 'team:0000';
  const message = { id: 'message', cid, group_generation: 3, mls_epoch: 4,
    created_at: '2026-11-16T00:00:00Z', mls_ciphertext: new Uint8Array([1]) };
  const issue = { message_id: message.id, message_version: manager._messageVersionKey(message),
    mls_epoch: 4, reason: 'missing_local_snapshot' };
  Object.assign(manager, { initialized: true, deviceId: 'device', _recoveryPrivateKey: new Uint8Array(32),
    storage: { loadRestoreProgress: async (_user, _device, _cid, generation) =>
      generation === 3 ? { repair_issues: [issue] } : null } });
  assert.equal(await manager.getMessageDecryptionReason(cid, message), 'missing_local_snapshot');
  assert.equal(await manager.diagnoseMessageDecryption(cid, message), 'missing_local_snapshot');
  assert.equal(await manager.getMessageDecryptionReason(cid, { ...message, mls_epoch: 5 }), 'unknown');
  assert.equal(await manager.getMessageDecryptionReason(cid, { ...message, group_generation: 4 }), 'unknown');
});

test('Info checks just the selected unobserved message without opening a repair or a progress ticket', async () => {
  const manager = new EncryptionManager();
  rows(manager, 1);
  const storage = new IndexedDBEncryptionStorage('message-info-on-demand-' + (++n));
  const cid = 'team:0000';
  Object.assign(manager, { storage, initialized: true, deviceId: 'device',
    _recoveryPrivateKey: new Uint8Array(32), _recoveryKeyId: 'key' });
  manager.client._beginSessionProgress = () => assert.fail('Info must not start a foreground progress ticket');
  const calls = [];
  manager.e2eeClient = {
    queryEpochArchives: async (type, id, request) => {
      const { group_generation, epoch_from, epoch_to, list_epochs } = request;
      calls.push([type, id, group_generation, epoch_from, epoch_to, list_epochs]);
      if (epoch_from === 49) {
        throw { response: { status: 400, data: {
          ermis_code: 6, message: "you don't have permision to restore this epoch range",
        } } };
      }
      return { blobs: [], wraps: [], snapshots: {} };
    },
    queryArchiveCiphertexts: async () => assert.fail('Info must not fetch epoch ciphertexts'),
  };
  const message = { id: 'older', cid, content_type: 'mls', mls_epoch: 48,
    group_generation: 0, created_at: new Date('2026-11-09T05:22:21Z'), updated_at: null,
    mls_ciphertext: Buffer.from([1, 2]).toString('base64') };
  try {
    assert.equal(await manager.getMessageDecryptionReason(cid, message), 'unknown');
    assert.deepEqual(await Promise.all([
      manager.diagnoseMessageDecryption(cid, message),
      manager.diagnoseMessageDecryption(cid, message),
    ]), ['no_archive', 'no_archive']);
    assert.equal(await manager.diagnoseMessageDecryption(cid, message), 'no_archive');
    assert.equal(await manager.diagnoseMessageDecryption(cid, { ...message, id: 'outside', mls_epoch: 49 }),
      'archive_access_denied');
    assert.equal(await manager.diagnoseMessageDecryption(cid, { ...message, group_generation: null }),
      'invalid_envelope');
    assert.deepEqual(calls, [
      ['team', '0000', 0, 48, 48, undefined],
      ['team', '0000', 0, 49, 49, undefined],
    ]);
    assert.equal(await storage.loadRestoreProgress('user', 'device', cid, 0), null);
    manager._recoveryPrivateKey = null;
    assert.equal(await manager.diagnoseMessageDecryption(cid, { ...message, mls_epoch: 51 }),
      'recovery_status_unavailable');
  } finally {
    await storage.close();
  }
});
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
test('page restore uses exact epoch material, zero ciphertext queries, and never marks epoch complete',async()=>{const m=new EncryptionManager(),s=new IndexedDBEncryptionStorage('page-'+(++n));Object.assign(m,{storage:s,userId:'user',deviceId:'device',_recoveryPrivateKey:new Uint8Array(32),_recoveryKeyId:'recovery'});rows(m,1);let queries=0;m.e2eeClient={queryEpochArchives:async(t,id,opt)=>{queries++;assert.equal(opt.epoch_from,7);assert.equal(opt.epoch_to,7);assert.equal(opt.list_epochs,undefined);return{blobs:[],wraps:[],snapshots:{}};},queryArchiveCiphertexts:async()=>assert.fail('whole epoch ciphertext fetch forbidden')};const row={id:'message',cid:'team:0000',content_type:'mls',mls_ciphertext:new Uint8Array([1,2]),mls_epoch:7,group_generation:3,created_at:'2026-11-16T00:00:00Z'};try{await m.restoreHistoryPage('team','0000',[row]);assert.equal(queries,1);assert.equal(await s.loadRestoreProgress('user','device','team:0000',3),null);assert.equal(m.groups.size,0);}finally{await s.close();}});
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

test('automatic inherited topic history uses query metadata and keeps cached ciphertext pending', async () => {
  const client = new ErmisChat('fixture-key', 'fixture-project', 'https://fixture.invalid', { browser: false, logger: () => {} });
  client.userID = 'user';
  const storage = new IndexedDBEncryptionStorage('topic-history-' + (++n));
  const manager = new EncryptionManager();
  Object.assign(manager, { client, storage, userId: 'user', deviceId: 'device', initialized: true,
    _recoveryPrivateKey: new Uint8Array(32), _recoveryKeyId: 'key' });
  client.encryptionManager = manager;
  const topic = client.channel('topic', 'inherited');
  topic.data = { cid: topic.cid, mls_enabled: true };
  const message = { id: 'historical', cid: topic.cid, content_type: 'mls', mls_ciphertext: 'AQI=',
    mls_epoch: 7, created_at: '2026-11-17T00:00:00Z' };
  const scopes = [];
  manager.e2eeClient = {
    queryEpochArchives: async (type, id, request) => {
      assert.equal(request.epoch_from, 7);
      assert.equal(request.epoch_to, 7);
      assert.equal(request.list_epochs, undefined);
      scopes.push(type + ':' + id);
      return { blobs: [], wraps: [], snapshots: {} };
    },
    queryArchiveCiphertexts: async () => assert.fail('automatic history must not run a Repair census'),
  };
  const restore = manager.restoreHistoryPage.bind(manager);
  let work;
  manager.restoreHistoryPage = (...args) => (work = restore(...args));
  try {
    await storage.saveMessage(message);
    // An earlier observation before authoritative topic metadata is available
    // must not settle the same page for the inherited parent scope.
    await manager.restoreHistoryPage(topic.type, topic.id, [message]);
    const metadata = { cid: topic.cid, mls_enabled: true, parent_cid: 'team:parent', e2ee_group_id: 'team:parent', gate: false };
    const page = await topic._hydrateE2eeMessagesFromLocalCache([message], metadata);
    await work;
    assert.deepEqual(scopes, ['topic:inherited', 'team:parent']);
    assert.equal(page[0].content_type, 'mls');
    assert.equal(topic.data.e2ee_group_id, undefined);
    assert.equal(await storage.loadRestoreProgress('user', 'device', topic.cid, 0), null);
  } finally {
    await storage.close();
  }
});

test('an automatic page can retry a temporary archive request failure on next open', async () => {
  const storage = new IndexedDBEncryptionStorage('transient-page-' + (++n));
  const manager = new EncryptionManager();
  rows(manager, 1);
  Object.assign(manager, { storage, deviceId: 'device', _recoveryPrivateKey: new Uint8Array(32), _recoveryKeyId: 'key' });
  let attempts = 0;
  manager._restoreHistoricalMessagesInternal = async () => [
    { epoch: 7, gap: true, reason: ++attempts === 1 ? 'archive_request_failed' : 'no_archive' },
  ];
  const page = [{ id: 'message', content_type: 'mls', mls_ciphertext: 'AQI=', mls_epoch: 7,
    created_at: '2026-11-17T00:00:00Z' }];
  try {
    await manager.restoreHistoryPage('team', '0000', page);
    await manager.restoreHistoryPage('team', '0000', page);
    await manager.restoreHistoryPage('team', '0000', page);
    assert.equal(attempts, 2);
  } finally {
    await storage.close();
  }
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
  m.clearRecoveryUnlock();order.length=0;await m._autoUnlockRecovery();assert.deepEqual(order,['notify']);assert.equal(events.length,3);
  m.clearRecoveryUnlock();order.length=0;s.saveProtectedRecoveryKey=async()=>{throw Error('protected storage unavailable');};
  await assert.rejects(m.unlockRecoveryVault('12345678'),/protected storage unavailable/);assert.equal(events.length,3);assert.deepEqual(order,[]);
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
  assert.equal(await m.diagnoseMessageDecryption('team:0000',row),'recovered');
  assert.equal(calls,0);assert.equal(progress,0);
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

test('full session prepares missing joins before batched sync instead of syncing each channel first',async()=>{
 const m=new EncryptionManager();rows(m,45);m.initialized=true;m.deviceId='fixture-device';
 const order=[],requests=[];
 m._finishStartupPublication=async()=>{};m._restoreGroupsLocally=async()=>{};
 m.storage={loadRemovedSyncCursor:async()=>null};m._loadAllScopeSyncCursors=async()=>({});
 m._discoverMlsRecoveryStates=async()=>({states:{},unsupported:false});
 m.bootstrapKnownE2eeChannels=async options=>{order.push('prepare');assert.equal(options.prepareOnly,true);return{results:[],status:'done'};};
 m._saveEncryptionSyncCheckpoint=async()=>{};m._emitSyncState=()=>{};
 m._flushPendingSnapshotsForScope=async()=>({pending:[]});m._replayLaggingEpochs=async()=>{};
 m._resumeExternalJoinCandidates=async()=>{};m._resumePendingMlsMutations=async()=>{};
 m._ensureWelcomeHistorySubscription=()=>{};m._drainWelcomeHistoryWork=async()=>{};
 m.e2eeClient={scopeSync:async cursors=>{
  assert.equal(order[0],'prepare','batch sync must follow existing missing-group join preparation');
  requests.push(Object.keys(cursors));return{channels:Object.fromEntries(Object.keys(cursors).map(cid=>[cid,{events:[],has_more:false}]))};
 }};
 await m._syncAndRestoreGroups();
 assert.deepEqual(requests.map(x=>x.length),[45]);assert.equal(new Set(requests.flat()).size,45);
 assert.equal(order.filter(x=>x==='prepare').length,1);
});

test('post-PIN replay accepts timestamps from formatted channel state', async () => {
 const storage = new IndexedDBEncryptionStorage('formatted-page-' + (++n));
 const manager = new EncryptionManager(); rows(manager, 1);
 Object.assign(manager, {storage, deviceId: 'device', _recoveryPrivateKey: new Uint8Array(32), _recoveryKeyId: 'key'});
 const cid = 'team:0000', created = new Date('2026-11-19T09:00:00Z'), updated = new Date('2026-11-19T09:01:00Z');
 let checked = false;
 manager._restoreHistoricalMessagesInternal = async (_type, _id, options) => {
  assert.equal(options.pageCiphertexts[0].created_at, created.toISOString());
  assert.equal(options.pageCiphertexts[0].updated_at, updated.toISOString());
  checked = true;
  return [];
 };
 try {
  await manager.restoreHistoryPage('team', '0000', [{id: 'message', cid, mls_epoch: 1, content_type: 'mls',
   mls_ciphertext: new Uint8Array([1]), created_at: created, updated_at: updated}]);
  assert.equal(checked, true);
 } finally { await storage.close(); }
});

test('optional archive previews do not hold the MLS sync gate', async () => {
 const manager = new EncryptionManager(); rows(manager, 1);
 let finishPreview;
 const preview = new Promise(resolve => { finishPreview = resolve; });
 manager._syncAndRestoreGroups = async () => {};
 manager._restoreWarmListPreviews = () => preview;
 try {
  const protocol = manager.sync();
  assert.equal(await Promise.race([protocol.then(() => 'settled'), new Promise(resolve =>
   setImmediate(() => resolve('held by preview')))]), 'settled');
  assert.equal(manager.isSyncing(), false);
 } finally { finishPreview(); }
});

test('archive preview cannot overwrite completed conversation coverage or show foreground progress', async () => {
 const manager = new EncryptionManager(); rows(manager, 1);
 const storage = new IndexedDBEncryptionStorage('preview-coverage-' + (++n));
 Object.assign(manager, {storage, deviceId: 'device', _recoveryPrivateKey: new Uint8Array(32), _recoveryKeyId: 'key'});
 manager.client._beginSessionProgress = () => assert.fail('preview must remain silent');
 manager.e2eeClient = {queryEpochArchives: async () => ({blobs: [], wraps: [], snapshots: {}})};
 const cid = 'team:0000';
 const progress = {...manager._newRestoreProgressRecord('team', '0000'), status: 'done', target_epochs: [1], completed_epochs: [1]};
 try {
  await storage.saveRestoreProgress(progress);
  const result = await manager.restoreHistoryPage('team', '0000', [{id: 'head', cid, mls_epoch: 2,
   created_at: '2026-11-19T09:00:00Z', mls_ciphertext: new Uint8Array([1])}], {isPreview: true});
  assert.equal(result[0].reason, 'no_archive');
  assert.deepEqual(await storage.loadRestoreProgress('user', 'device', cid, 0), progress);
 } finally { await storage.close(); }
});

test('a dormant foreground group is materialized at its completed batch response before later pages', async () => {
 const manager = new EncryptionManager(); rows(manager, 2);
 const cid = 'team:0000', tail = 'team:0001';
 manager._activeHistoryScope = cid;
 manager._finishStartupPublication = async () => {};
 manager._restoreBootstrapMilestones = async () => new Set([cid, tail]);
 manager._restoreGroupsLocally = async () => {};
 manager.storage = {loadRemovedSyncCursor: async () => null};
 manager._loadAllScopeSyncCursors = async () => ({});
 manager._discoverMlsRecoveryStates = async () => ({states: {}, unsupported: false});
 manager.bootstrapKnownE2eeChannels = async () => ({results: []});
 manager._saveEncryptionSyncCheckpoint = async () => {};
 manager._emitSyncState = () => {};
 manager._replayLaggingEpochs = async () => {};
 manager._resumeExternalJoinCandidates = async () => {};
 manager._resumePendingMlsMutations = async () => {};
 manager._ensureWelcomeHistorySubscription = () => {};
 manager._drainWelcomeHistoryWork = async () => {};
 const admitted = [];
 manager.ensureChannelReady = async (_type, _id, scope, options) => {
  assert.equal(scope, cid, 'background dormant group remains unloaded');
  assert.equal(options.batchSyncOnly, true);
  admitted.push(scope);
  manager.groups.set(scope, {});
  return {cid: scope, status: 'ready'};
 };
 manager.e2eeClient = {scopeSync: async () => ({channels: {
  [cid]: {events: [], has_more: false}, [tail]: {events: [], has_more: false},
 }})};
 await manager._syncAndRestoreGroups();
 assert.ok(admitted.includes(cid));
 assert.equal(manager.groups.has(tail), false);
});

test('an unlocked timeline page restores real MLS ciphertext while the live MLS provider is checkpointing', async () => {
 const fs = require('node:fs'), path = require('node:path'), {pathToFileURL} = require('node:url');
 const {createHash} = require('node:crypto');
 const wasmPath = path.resolve(__dirname, '../src/encryption/wasm');
 const wasm = await import(pathToFileURL(path.join(wasmPath, 'openmls_wasm.js')));
 await wasm.default({module_or_path: fs.readFileSync(path.join(wasmPath, 'openmls_wasm_bg.wasm'))});
 const manager = new EncryptionManager(); rows(manager, 1);
 const storage = new IndexedDBEncryptionStorage('wasm-unlock-page-' + (++n));
 Object.assign(manager, {storage, deviceId: 'device', _injectedWasm: wasm});
 await manager._initWasm();
 const founderProvider = new wasm.Provider(), recoveryProvider = new wasm.Provider();
 const founder = new wasm.Identity(founderProvider, 'user');
 const cid = 'team:0000', group = wasm.Group.create_with_cid(founderProvider, founder, cid);
 const client = new ErmisChat('fixture-key', 'fixture-project', 'https://fixture.invalid', {browser: false, logger: () => {}});
 client.userID = 'user'; client.user = {id: 'user'}; client.encryptionManager = manager;
 manager.client = client;
 const channel = client.channel('team', '0000');
 channel.data = {cid, mls_enabled: true};
 const encoder = new TextEncoder(), text = 'history from the earlier epoch';
 const created = new Date('2026-11-19T09:00:00Z');
 const blobId = '11111111-1111-4111-8111-111111111111', scope = 'account_owned';
 const epoch = group.epoch(), generation = 0;
 const archive = group.archive_epoch_v2();
 const snapshotHash = Buffer.from(archive.snapshot_hash).toString('hex');
 const recovery = wasm.generate_recovery_keypair(recoveryProvider);
 const aad = wasm.ArchiveBlobAad.forGeneration(cid, 0n, epoch, scope, blobId, snapshotHash);
 const info = wasm.ArchiveKeyWrapInfo.forGeneration(cid, 0n, epoch, scope, blobId, snapshotHash, recovery.key_id);
 const material = wasm.encrypt_archive_blob(founderProvider, archive.archive_bytes, aad);
 const wrap = wasm.wrap_archive_data_key(founderProvider, material.adk, recovery.public_key, info);
 const cipher = group.create_message(founderProvider, founder, encoder.encode(JSON.stringify({text})));
 const events = [];
 manager.client._beginSessionProgress = phase => { events.push(phase); return 'page'; };
 manager.client._finishSessionProgress = (ticket, partial) => { events.push({ticket, partial}); };
 manager.provider = recoveryProvider;
 manager.e2eeClient = {
  queryEpochArchives: async (_type, _id, query) => {
   assert.equal(query.epoch_from, Number(epoch));
   return {
    blobs: [{group_generation: generation, archive_blob_id: blobId, cid, epoch: Number(epoch), archive_scope: scope,
     member_snapshot_hash: snapshotHash, encrypted_archive_bytes: material.ciphertext, aead_nonce: material.nonce,
     aead_aad: material.aead_aad, created_at: created.toISOString()}],
    wraps: [{group_generation: generation, archive_blob_id: blobId, hpke_kem_output: wrap.kem_output,
     hpke_ciphertext: wrap.ciphertext, hpke_info: wrap.hpke_info}],
    snapshots: {[snapshotHash]: {group_generation: generation, snapshot_bytes: archive.snapshot_bytes}},
   };
  },
  queryArchiveCiphertexts: async () => assert.fail('exact page must not request whole-epoch ciphertexts'),
 };
 const row = {id: '22222222-2222-4222-8222-222222222222', cid, user: {id: 'user'},
  content_type: 'mls', created_at: created, mls_epoch: Number(epoch), group_generation: generation, mls_ciphertext: cipher};
 let enterCheckpoint, releaseCheckpoint, checkpoint;
 const checkpointEntered = new Promise(resolve => { enterCheckpoint = resolve; });
 const holdCheckpoint = new Promise(resolve => { releaseCheckpoint = resolve; });
 try {
  assert.deepEqual(await manager.restoreHistoryPage('team', '0000', [row]), []);
  manager._recoveryPrivateKey = recovery.private_key;
  manager._recoveryKeyId = recovery.key_id;
  checkpoint = manager._withProviderMutation(async () => {
   enterCheckpoint();
   await holdCheckpoint;
  });
  await checkpointEntered;
  assert.throws(() => manager.provider, {code: 'provider_mutation_busy'});
  const restored = await manager.restoreHistoryPage('team', '0000', [row]);
  assert.equal(restored[0]?.reason, undefined);
  assert.equal(restored[0]?.messageId, row.id);
  assert.deepEqual(events, ['restoring_page', {ticket: 'page', partial: false}]);
  const saved = await storage.loadMessage(row.id);
  assert.equal(saved.text, text);
  assert.equal(saved.mls_ciphertext_hash, createHash('sha256').update(cipher).digest('hex'));
  assert.equal(channel.state.findMessage(row.id)?.text, text);
  assert.equal(manager.getEpoch(cid), -1);
  assert.notEqual(manager._archiveCryptoProvider, recoveryProvider);
  assert.throws(() => manager.provider, {code: 'provider_mutation_busy'});
  assert.equal(await storage.loadRestoreProgress('user', 'device', cid, generation), null);
 } finally {
  releaseCheckpoint();
  await checkpoint;
  manager.destroy();
  await storage.close();
  wrap.free(); material.free(); info.free(); aad.free(); recovery.free(); archive.free();
  group.free(); founder.free(); founderProvider.free();
 }
});
