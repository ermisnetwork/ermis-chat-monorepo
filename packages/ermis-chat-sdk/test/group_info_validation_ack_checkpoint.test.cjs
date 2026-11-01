const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{webcrypto}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {EncryptionManager,IndexedDBEncryptionStorage,E2eeClient,sha256Hex}=require('../dist/encryption/index.cjs');
let sequence=0,wasmPromise;
const incident='00000000-0000-4000-8000-000000000001',secondIncident='00000000-0000-4000-8000-000000000002';
const tick=()=>new Promise(r=>setTimeout(r,0));
async function until(read){for(let i=0;i<100;i++){if(read())return;await tick();}throw Error('Fixture timeout');}
async function fixture(){
  const file=path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm');
  const artifact=sha256Hex(fs.readFileSync(file));
  const wasm=await(wasmPromise??=(async()=>{const w=await import(pathToFileURL(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm.js')));
    await w.default({module_or_path:fs.readFileSync(file)});return w;})());
  const user=`ack-user-${++sequence}`,device='ack-device',cid=`team:ack-${sequence}`,storage=new IndexedDBEncryptionStorage(user),events=[];
  async function manager(){const m=new EncryptionManager();Object.assign(m,{storage,userId:user,deviceId:device,_injectedWasm:wasm,_wasmArtifactSha256:artifact});
    await m._initWasm();await m._initIdentity();await m._persistProviderStrict();m.initialized=true;m._armValidationAckRetry=()=>{};
    m.client={activeChannels:{},dispatchEvent:e=>events.push(e)};m._channelE2ee.set(cid,{cid,group_generation:0,group_id:null,epoch:0,group_info:{status:"validation_required",ready:false,epoch:0,last_uploaded_at:null},recovery:null});return m;}
  const m=await manager(),group=wasm.Group.create_with_cid(m.provider,m.identity,cid);
  const marker={cid,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1};
  m.groups.set(cid,group);m._groupGenerations.set(cid,marker);await m._persistProviderStrict();await storage.saveGroupState(cid,marker);
  const info=()=>{const bytes=group.export_group_info(m.provider,m.identity,true);return{group_info:bytes,group_generation:0,group_id:null,epoch:0,hash:sha256Hex(bytes),is_stale:false};};
  const state=(revision='1',id=incident,action='repair')=>({group_generation:0,group_id:null,current_epoch:0,membership_version:'1',state:'repairing',
    reason:'group_info_invalid',retryable:true,incident_id:id,recovery_action:action,recovery_revision:revision,
    repair_retry_until:new Date(Date.now()+900000).toISOString(),capability:{protocol_version:1,automatic_enabled:false,
      repair_timeout_seconds:900,max_group_info_bytes:1048576,max_ratchet_tree_bytes:1048576,max_welcome_recipients:1000,max_welcome_bytes:1048576}});
  await m._applyRecoveryControl(cid,state());requireValidationMetadata(m,cid);
  const accepted=(revision='2')=>({accepted:true,idempotent:false,recovery_action:'none',recovery_revision:revision});
  return{m,manager,wasm,storage,user,device,cid,group,marker,info,state,accepted,events,artifact};
}

test('actual producer validation and atomic durable proof/readback precede exact bounded ACK; ACK never creates Ready',async()=>{
  const f=await fixture();let observed,posts=0;
  f.m.e2eeClient={getGroupInfo:async()=>f.info(),acknowledgeGroupInfoValidation:async body=>{
    posts++;observed=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device);
    assert.equal(observed.attempts,1);assert.equal(observed.outcome,'pending');assert.deepEqual(body,observed.request);
    assert.equal(JSON.stringify(body).includes('provider'),false);assert.ok(Buffer.byteLength(JSON.stringify(body))<1024);return f.accepted();
  }};
  const before=sha256Hex(f.m.provider.to_bytes());
  await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);await f.m._drainGroupInfoValidationAcks();
  assert.equal(posts,1);assert.equal((await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device)).outcome,'accepted');
  assert.equal(sha256Hex(f.m.provider.to_bytes()),before);assert.equal(f.m.groups.get(f.cid),f.group);
  assert.equal(f.events.some(e=>e.state==='ready'),false);assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'repair');
  await f.storage.close();
});

test('unknown ACK reserves attempts durably across restart; repeated validation cannot reset the three-POST budget',async()=>{
  const f=await fixture();let posts=0;const realNow=Date.now;let now=realNow();Date.now=()=>now;
  try{
    const client={getGroupInfo:async()=>f.info(),acknowledgeGroupInfoValidation:async()=>{posts++;throw Error('lost ACK');}};f.m.e2eeClient=client;
    await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);await f.m._drainGroupInfoValidationAcks();assert.equal(posts,1);
    const restarted=await f.manager();restarted.e2eeClient=client;await restarted._restoreGroupsLocally();for(const cid of restarted.groups.keys())requireValidationMetadata(restarted,cid);
    await restarted._drainGroupInfoValidationAcks();assert.equal(posts,1);
    for(let i=0;i<2;i++){now+=30001;await restarted._drainGroupInfoValidationAcks();}
    const job=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device);
    assert.equal(posts,3);assert.equal(job.attempts,3);assert.equal(job.outcome,'exhausted');
    now+=30001;await restarted.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);await restarted._drainGroupInfoValidationAcks();
    assert.equal(posts,3);assert.equal((await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device)).attempts,3);
  }finally{Date.now=realNow;await f.storage.close();}
});

test('typed stale409 rediscovery does not resolve a newer incident or publish Ready',async()=>{
  const f=await fixture();let discoveries=0;
  f.m.e2eeClient={getGroupInfo:async()=>f.info(),acknowledgeGroupInfoValidation:async()=>{throw{response:{status:409,data:{reason:'group_info_validation_ack_stale'}}};},
    discoverMlsRecovery:async()=>{discoveries++;return{protocol_version:1,capability:{protocol_version:1},states:{[f.cid]:{result:'state',
      generation:{...f.state('2',secondIncident),reason:'group_info_missing'},group_info_refresh:null}}};}};
  await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);await f.m._drainGroupInfoValidationAcks();
  await until(()=>f.m.getRecoveryControlSnapshot(f.cid).incident_id===secondIncident);
  assert.equal(discoveries,1);assert.equal((await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device)).outcome,'stale');
  assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'repair');assert.equal(f.events.some(e=>e.state==='ready'),false);
  await f.storage.close();
});

test('storage quota, committed readback failure and concurrent provider/control guards send no ACK',async()=>{
  for(const fault of ['quota','readback','provider','control']){
    const f=await fixture();let posts=0;
    f.m.e2eeClient={getGroupInfo:async()=>f.info(),acknowledgeGroupInfoValidation:async()=>{posts++;return f.accepted();}};
    if(fault==='quota')f.storage.saveValidationAckWork=async()=>{throw Error('quota');};
    if(fault==='readback'){
      const save=f.storage.saveValidationAckWork.bind(f.storage);
      f.storage.saveValidationAckWork=async(...args)=>{const db=await f.storage.openDB(),original=db.transaction.bind(db);let committed=false;
        db.transaction=(...params)=>{const tx=original(...params);if(params[1]==='readwrite')tx.addEventListener('complete',()=>committed=true);if(committed&&params[1]==='readonly')queueMicrotask(()=>tx.abort());return tx;};
        try{return await save(...args);}finally{db.transaction=original;}};
    }
    if(fault==='provider')f.m.e2eeClient.getGroupInfo=async()=>{await f.storage.saveProviderState(f.user,f.device,Uint8Array.of(1));return f.info();};
    if(fault==='control')f.m.e2eeClient.getGroupInfo=async()=>{const c=await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device);
      await f.storage.saveRecoveryControlCheckpoint({...c,recovery_revision:'2',recovery_action:'manual_intervention_required'});return f.info();};
    await assert.rejects(f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid));assert.equal(posts,0);
    assert.equal(f.m.groups.get(f.cid),f.group);await f.storage.close();
  }
});

test('clock, signature, same-epoch fork, metadata, artifact and legacy adapter failures remain distinct; no ACK or private provider mutation',async()=>{
  for(const fault of ['clock','signature','fork','metadata','artifact','legacy']){
    const f=await fixture(),before=sha256Hex(f.m.provider.to_bytes());let posts=0;const realNow=Date.now;
    f.m.e2eeClient={getGroupInfo:async()=>{const info=f.info();if(fault==='signature'){info.group_info=new Uint8Array(info.group_info);info.group_info[info.group_info.length-1]^=1;info.hash=sha256Hex(info.group_info);}
      if(fault==='fork'){
        const p=new f.wasm.Provider(),i=new f.wasm.Identity(p,'another-fork-owner'),g=f.wasm.Group.create_with_cid(p,i,f.cid);
        info.group_info=g.export_group_info(p,i,true);info.hash=sha256Hex(info.group_info);g.free();i.free();p.free();
      }
      if(fault==='metadata')info.epoch=1;if(fault==='clock')Date.now=()=>NaN;return info;},acknowledgeGroupInfoValidation:async()=>{posts++;return f.accepted();}};
    if(fault==='artifact')f.m._wasmArtifactSha256=null;if(fault==='legacy')f.storage.validationAckWorkCheckpointVersion=undefined;
    try{await assert.rejects(f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid),e=>{
      const expected=fault==='clock'?'invalid_clock':fault==='signature'?'group_info_invalid':['metadata','fork'].includes(fault)?'validation_ack_head_mismatch':'client_upgrade_required';
      return e.code===expected;
    });assert.equal(posts,0);assert.equal(sha256Hex(f.m.provider.to_bytes()),before);}
    finally{Date.now=realNow;await f.storage.close();}
  }
});

test('newer incident retains exact ambiguous ACK evidence and admits a new tuple; old account cannot settle the replacement',async()=>{
  const f=await fixture();let release,posts=0;const pending=new Promise(r=>release=r),publicInfo=f.info();
  f.m.e2eeClient={getGroupInfo:async()=>publicInfo,acknowledgeGroupInfoValidation:async()=>{posts++;return pending;}};
  await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);await until(()=>posts===1);
  const old=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),oldWork=f.m._validationAckWork;
  const oldRejected=assert.rejects(oldWork,e=>e.code==='recovery_scope_changed');
  await f.m._applyRecoveryControl(f.cid,f.state('2',secondIncident));
  await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);
  const next=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device);assert.equal(next.request.incident_id,secondIncident);assert.notEqual(next.job_id,old.job_id);
  const db=await f.storage.openDB(),prefix='recovery_work_disposition:v1:'+encodeURIComponent(f.device)+':';
  const retained=await new Promise((yes,no)=>{const tx=db.transaction('meta','readonly'),r=tx.objectStore('meta').getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));tx.oncomplete=()=>yes(r.result);tx.onabort=()=>no(tx.error);});
  assert.equal(retained.length,1);assert.equal(retained[0].reason,'superseded');assert.deepEqual(retained[0].source,old);
  f.m.userId='switched-account';release(f.accepted());await oldRejected;
  assert.deepEqual(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),next);assert.equal(posts,1);f.m.userId=f.user;await f.storage.close();
});

test('two managers preserve one reserved ACK; stale private owner fails closed and manual control suppresses transport',async()=>{
  const f=await fixture();let posts=0,release;const publicInfo=f.info();
  const client={getGroupInfo:async()=>publicInfo,acknowledgeGroupInfoValidation:async()=>{posts++;return new Promise(r=>release=r);}};f.m.e2eeClient=client;
  await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);await until(()=>posts===1);const reserved=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device);
  const second=await f.manager();second.e2eeClient=client;await second._restoreGroupsLocally();await second._saveEncryptionSyncCheckpoint();
  await second._drainGroupInfoValidationAcks();assert.equal(posts,1);release(f.accepted());await assert.rejects(f.m._drainGroupInfoValidationAcks());
  assert.equal(f.m._providerPersistenceUncertain,true);assert.deepEqual(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),reserved);
  await second._applyRecoveryControl(f.cid,f.state('2',secondIncident,'manual_intervention_required'));
  await second._drainGroupInfoValidationAcks();assert.equal(posts,1);assert.equal(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),null);
  const db=await f.storage.openDB(),prefix='recovery_work_disposition:v1:'+encodeURIComponent(f.device)+':';
  const dispositions=await new Promise((resolve,reject)=>{const tx=db.transaction('meta','readonly'),r=tx.objectStore('meta').getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);});
  assert.equal(dispositions.length,1);assert.equal(dispositions[0].reason,'superseded');assert.deepEqual(dispositions[0].source,reserved);assert.deepEqual(dispositions[0].primary,reserved);
  assert.equal(second.getRecoveryControlSnapshot(f.cid).recovery_action,'manual_intervention_required');await f.storage.close();
});

test('ACK HTTP contract disables hidden POST retry and bounds request timeout/payload',async()=>{
  let captured;const client=new E2eeClient({baseURL:'https://fixture.invalid',deviceId:'bound-device',doAxiosRequest:async(...args)=>{captured=args;return{accepted:true,idempotent:false,recovery_action:'none',recovery_revision:'2'};}},()=>({userId:'fixture',projectId:incident,deviceId:'bound-device',identity:{},assertCurrent(){},assertRegistrationCurrent(){},async verifyDurable(){}}));
  const body={version:1,cid:'team:fixture',group_generation:0,epoch:7,hash:'a'.repeat(64),incident_id:incident};
  await client.acknowledgeGroupInfoValidation(body);assert.equal(captured[0],'post');assert.equal(captured[1],'https://fixture.invalid/v1/e2ee/group_info/validation_ack');
  assert.deepEqual(captured[2],body);assert.equal(captured[3].timeout,5000);assert.equal(captured[3].maxBodyLength,1024);
  assert.equal(captured[3].__tokenRefreshAttempted,true);assert.equal(captured[3].headers['X-Device-ID'],'bound-device');
});

test('seven real channel checkpoints drain six ACK POSTs then the remaining lane; concurrent preparation admits at most six',async()=>{
  const f=await fixture(),infos=new Map(),cids=[];
  for(let i=0;i<7;i++){
    const cid=`${f.cid}-batch-${i}`,group=f.wasm.Group.create_with_cid(f.m.provider,f.m.identity,cid);
    const marker={...f.marker,cid};f.m.groups.set(cid,group);f.m._groupGenerations.set(cid,marker);
    await f.storage.saveGroupState(cid,marker);await f.m._persistProviderStrict();await f.m._applyRecoveryControl(cid,f.state());requireValidationMetadata(f.m,cid);cids.push(cid);
    const bytes=group.export_group_info(f.m.provider,f.m.identity,true);infos.set(cid,{group_info:bytes,group_generation:0,group_id:null,epoch:0,hash:sha256Hex(bytes),is_stale:false});
  }
  await f.m._persistProviderStrict();let posts=0;
  f.m.e2eeClient={getGroupInfo:async(_type,id)=>infos.get(`team:${id}`),acknowledgeGroupInfoValidation:async()=>{posts++;return f.accepted();}};
  const drain=f.m._drainGroupInfoValidationAcks.bind(f.m);f.m._drainGroupInfoValidationAcks=async()=>{};
  for(const cid of cids)await f.m.validateAndQueueGroupInfoAck('team',cid.slice(5),cid);
  f.m._drainGroupInfoValidationAcks=drain;await drain();assert.equal(posts,6);
  assert.equal((await f.storage.listDueGroupInfoValidationAcks(f.device,Date.now()+30000,50)).length,1);
  await drain();assert.equal(posts,7);assert.equal((await f.storage.listDueGroupInfoValidationAcks(f.device,Date.now()+30000,50)).length,0);
  let release,reads=0;const gate=new Promise(r=>release=r);
  f.m.e2eeClient.getGroupInfo=async(_type,id)=>{reads++;await gate;return infos.get(`team:${id}`);};
  const work=cids.map(cid=>f.m.validateAndQueueGroupInfoAck('team',cid.slice(5),cid));
  const settled=Promise.allSettled(work);await until(()=>reads===6);release();
  const results=await settled;assert.equal(results.filter(r=>r.status==='fulfilled').length,6);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'validation_ack_busy');assert.equal(reads,6);assert.equal(posts,7);
  await f.storage.close();
});


test('automatic admission journals before GI GET, drains six fairly and recovers the unadmitted seventh from durable control after restart',async()=>{
  const f=await fixture(),infos=new Map(),cids=[];
  for(let i=0;i<7;i++){
    const cid=`${f.cid}-fair-${i}`,group=f.wasm.Group.create_with_cid(f.m.provider,f.m.identity,cid),marker={...f.marker,cid};
    f.m.groups.set(cid,group);f.m._groupGenerations.set(cid,marker);await f.storage.saveGroupState(cid,marker);await f.m._persistProviderStrict();await f.m._applyRecoveryControl(cid,f.state());requireValidationMetadata(f.m,cid);
    const bytes=group.export_group_info(f.m.provider,f.m.identity,true);infos.set(cid,{group_info:bytes,group_generation:0,group_id:null,epoch:0,hash:sha256Hex(bytes),is_stale:false});cids.push(cid);
  }
  await f.m._persistProviderStrict();let gets=0,posts=0;
  const client={getGroupInfo:async(_type,id)=>{gets++;const admission=await f.storage.loadGroupInfoValidationAdmission(`team:${id}`,f.device);
    assert.equal(admission.attempts,1);assert.equal(admission.outcome,'pending');return infos.get(`team:${id}`);},acknowledgeGroupInfoValidation:async()=>{posts++;return f.accepted();}};
  f.m.e2eeClient=client;f.m._validationAckAdmissionNextAt=Date.now()+30_000;
  // Scope initialization resets the deadline, so initialize before setting the fixture gate.
  f.m._validationAckAdmissionScope=[f.user,f.device,f.m.identity,f.storage,client,f.artifact];
  for(const cid of cids)f.m._queueGroupInfoValidationAck(cid);assert.equal(f.m._validationAckAdmissions.size,7);
  f.m._validationAckAdmissionNextAt=0;await f.m._drainValidationAckAdmissions();assert.equal(gets,6);assert.equal(posts,6);assert.equal(f.m._validationAckAdmissions.size,1);
  const restarted=await f.manager();restarted.e2eeClient=client;await restarted._restoreGroupsLocally();for(const cid of restarted.groups.keys())requireValidationMetadata(restarted,cid);
  restarted._validationAckAdmissionScope=[f.user,f.device,restarted.identity,f.storage,client,f.artifact];restarted._validationAckAdmissionNextAt=Date.now()+30_000;
  for(const cid of cids)restarted._queueGroupInfoValidationAck(cid);
  restarted._validationAckAdmissionNextAt=0;await restarted._drainValidationAckAdmissions();
  assert.equal(gets,6);assert.equal(posts,6);
  const realNow=Date.now;Date.now=()=>realNow()+30_001;try{await restarted._drainValidationAckAdmissions();}finally{Date.now=realNow;}
  assert.equal(gets,7);assert.equal(posts,7);assert.equal(restarted._validationAckAdmissions.size,0);
  assert.equal((await f.storage.loadGroupInfoValidationAdmission(cids[6],f.device)).outcome,'prepared');assert.equal(f.events.some(e=>e.state==='ready'),false);
  await f.storage.close();
});

test('GI preparation transport failures have a durable three-attempt budget across restart; repeated discovery cannot reset it',async()=>{
  const f=await fixture(),realNow=Date.now;let now=realNow(),gets=0;Date.now=()=>now;
  try{
    const client={getGroupInfo:async()=>{gets++;throw Error('transport');},acknowledgeGroupInfoValidation:async()=>{throw Error('must not POST');}};f.m.e2eeClient=client;
    f.m._queueGroupInfoValidationAck(f.cid);await f.m._drainValidationAckAdmissions();assert.equal(gets,1);
    now+=30_001;await f.m._drainValidationAckAdmissions();assert.equal(gets,2);
    const restarted=await f.manager();restarted.e2eeClient=client;await restarted._restoreGroupsLocally();for(const cid of restarted.groups.keys())requireValidationMetadata(restarted,cid);now+=30_001;
    restarted._queueGroupInfoValidationAck(f.cid);await restarted._drainValidationAckAdmissions();assert.equal(gets,3);
    const job=await f.storage.loadGroupInfoValidationAdmission(f.cid,f.device);assert.equal(job.attempts,3);assert.equal(job.outcome,'exhausted');
    now+=30_001;const third=await f.manager();third.e2eeClient=client;await third._restoreGroupsLocally();third._queueGroupInfoValidationAck(f.cid);await third._drainValidationAckAdmissions();
    assert.equal(gets,3);assert.equal(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),null);
  }finally{Date.now=realNow;await f.storage.close();}
});

test('automatic GI admission rejects manual/quota guards before HTTP, and late completion cannot clear a newer public reservation',async()=>{
  const f=await fixture();let gets=0;f.m.e2eeClient={getGroupInfo:async()=>{gets++;return f.info();},acknowledgeGroupInfoValidation:async()=>f.accepted()};
  const reserve=f.storage.reserveGroupInfoValidationAdmission.bind(f.storage),saveAdmission=f.storage.saveValidationAdmissionWork.bind(f.storage);f.storage.saveValidationAdmissionWork=async()=>{throw Error('quota');};
  f.m._queueGroupInfoValidationAck(f.cid);await f.m._drainValidationAckAdmissions();assert.equal(gets,0);f.storage.saveValidationAdmissionWork=saveAdmission;
  const base={version:1,job_id:'00000000-0000-4000-8000-000000000010',user_id:f.user,device_id:f.device,signing_identity_sha256:sha256Hex(f.m.identity.signature_public_key()),
    cid:f.cid,group_generation:0,epoch:0,incident_id:incident,recovery_revision:'1',artifact_sha256:f.artifact,policy:'verify',attempts:0,retry_at:Date.now(),outcome:'pending'};
  const first=await reserve(base,Date.now());assert.equal(first.attempts,1);
  await f.m._applyRecoveryControl(f.cid,f.state('2',secondIncident));
  const next=await reserve({...base,job_id:'00000000-0000-4000-8000-000000000011',recovery_revision:'2',incident_id:secondIncident},Date.now());
  await f.storage.finishGroupInfoValidationAdmission(f.cid,f.device,first.job_id,1,true);assert.equal((await f.storage.loadGroupInfoValidationAdmission(f.cid,f.device)).job_id,next.job_id);
  await f.m._applyRecoveryControl(f.cid,f.state('3',secondIncident,'manual_intervention_required'));
  assert.equal(await reserve({...base,recovery_revision:'3',incident_id:secondIncident},Date.now()),null);assert.equal(gets,0);await f.storage.close();
});

test('explicit manual ACK journals intent before GET and proof before POST; only durable discovery may clear manual',async()=>{
  const f=await fixture();await f.m._applyRecoveryControl(f.cid,f.state('2',incident,'manual_intervention_required'));
  let gets=0,posts=0,discoveries=0,release;
  const discovery=new Promise(r=>release=r);
  f.m._discoverMlsRecoveryStates=async()=>{discoveries++;await discovery;await f.m._applyRecoveryControl(f.cid,{...f.state('3',incident,'none'),incident_id:null,repair_retry_until:null});return{};};
  f.m.e2eeClient={getGroupInfo:async()=>{gets++;const intent=await f.storage.loadGroupInfoValidationAdmission(f.cid,f.device);
    assert.equal(intent.trigger,'manual');assert.equal(intent.attempts,1);return f.info();},acknowledgeGroupInfoValidation:async body=>{
    posts++;const proof=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device);assert.equal(proof.trigger,'manual');assert.equal(proof.attempts,1);
    assert.deepEqual(body,proof.request);assert.equal('trigger' in body,false);return f.accepted('3');}};
  await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);f.m._queueGroupInfoValidationAck(f.cid);
  assert.equal(gets,0);assert.equal(posts,0);
  await f.m.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid);await f.m._drainGroupInfoValidationAcks();
  assert.equal(gets,1);assert.equal(posts,1);assert.equal(discoveries,1);
  assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'manual_intervention_required');
  assert.equal((await f.storage.loadGroupInfoValidationAdmission(f.cid,f.device)).outcome,'prepared');
  assert.equal(f.events.some(e=>e.state==='ready'),false);release();
  await until(()=>f.m.getRecoveryControlSnapshot(f.cid).recovery_action==='none');
  assert.equal(f.events.some(e=>e.state==='ready'),false);assert.equal(f.m.groups.get(f.cid),f.group);await f.storage.close();
});

test('manual lost ACK retries exact intent after restart with three POSTs and at most three GI proofs, repeated clicks cannot reset budgets',async()=>{
  const f=await fixture();await f.m._applyRecoveryControl(f.cid,f.state('2',incident,'manual_intervention_required'));
  const realNow=Date.now;let now=realNow(),gets=0,posts=0,bodies=[];Date.now=()=>now;
  try{
    const publicInfo=f.info();const client={getGroupInfo:async()=>{gets++;return publicInfo;},acknowledgeGroupInfoValidation:async body=>{posts++;bodies.push(body);throw Error('lost manual ACK');}};
    f.m.e2eeClient=client;await f.m.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid);await f.m._drainGroupInfoValidationAcks();assert.equal(posts,1);
    const restarted=await f.manager();restarted.e2eeClient=client;await restarted._restoreGroupsLocally();for(const cid of restarted.groups.keys())requireValidationMetadata(restarted,cid);
    await restarted._drainGroupInfoValidationAcks();assert.equal(posts,1);
    for(let i=0;i<2;i++){now+=30001;await restarted._drainGroupInfoValidationAcks();}
    assert.equal(posts,3);assert.ok(gets<=3);for(const body of bodies)assert.deepEqual(body,bodies[0]);
    const proof=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device);assert.equal(proof.trigger,'manual');assert.equal(proof.attempts,3);assert.equal(proof.outcome,'exhausted');
    const before=gets;now+=30001;await restarted.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid);await restarted._drainGroupInfoValidationAcks();
    assert.equal(gets,before);assert.equal(posts,3);assert.equal(restarted.getRecoveryControlSnapshot(f.cid).recovery_action,'manual_intervention_required');
    assert.equal(f.events.some(e=>e.state==='ready'),false);
  }finally{Date.now=realNow;await f.storage.close();}
});

test('manual GI preparation failure persists the three-attempt budget across restart before any ACK proof exists',async()=>{
  const f=await fixture();await f.m._applyRecoveryControl(f.cid,f.state('2',incident,'manual_intervention_required'));
  const realNow=Date.now;let now=realNow(),gets=0,posts=0;Date.now=()=>now;
  try{
    const client={getGroupInfo:async()=>{gets++;const admission=await f.storage.loadGroupInfoValidationAdmission(f.cid,f.device);assert.equal(admission.trigger,'manual');assert.equal(admission.attempts,gets);throw Error('network');},
      acknowledgeGroupInfoValidation:async()=>{posts++;return f.accepted('3');}};
    let manager=f.m;manager.e2eeClient=client;
    for(let i=0;i<3;i++){
      await assert.rejects(manager.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid));
      const next=await f.manager();next.e2eeClient=client;await next._restoreGroupsLocally();manager=next;now+=30001;
    }
    const record=await f.storage.loadGroupInfoValidationAdmission(f.cid,f.device);assert.equal(record.attempts,3);assert.equal(record.outcome,'exhausted');
    await assert.rejects(manager.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid),e=>e.code==='validation_ack_retry_deferred');
    assert.equal(gets,3);assert.equal(posts,0);assert.equal(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),null);
  }finally{Date.now=realNow;await f.storage.close();}
});

test('manual validation still rejects signature/fork/head/adapter/clock/quota and changed durable control without ACK or Ready',async()=>{
  for(const fault of ['signature','fork','head','adapter','clock','quota','control']){
    const f=await fixture();await f.m._applyRecoveryControl(f.cid,f.state('2',incident,'manual_intervention_required'));let posts=0;const realNow=Date.now;
    f.m.e2eeClient={getGroupInfo:async()=>{const info=f.info();
      if(fault==='signature'){info.group_info=new Uint8Array(info.group_info);info.group_info[info.group_info.length-1]^=1;info.hash=sha256Hex(info.group_info);}
      if(fault==='fork'){const p=new f.wasm.Provider(),i=new f.wasm.Identity(p,'manual-fork'),g=f.wasm.Group.create_with_cid(p,i,f.cid);info.group_info=g.export_group_info(p,i,true);info.hash=sha256Hex(info.group_info);g.free();i.free();p.free();}
      if(fault==='head')info.epoch=1;if(fault==='clock')Date.now=()=>NaN;
      if(fault==='control'){const control=await f.storage.loadRecoveryControlCheckpoint(f.cid,f.device);await f.storage.saveRecoveryControlCheckpoint({...control,incident_id:secondIncident,recovery_revision:'3'});}
      return info;},acknowledgeGroupInfoValidation:async()=>{posts++;return f.accepted('3');}};
    if(fault==='adapter')f.storage.reserveGroupInfoValidationAdmission=undefined;
    if(fault==='quota')f.storage.saveValidationAckWork=async()=>{throw Error('quota');};
    try{await assert.rejects(f.m.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid),error=>{
      if(fault==='quota')return error.message==='quota';if(fault==='control')return error.code==='validation_ack_checkpoint_uncertain' && error.recovery_owner_conflict==='scope';
      const expected=fault==='signature'?'group_info_invalid':['fork','head'].includes(fault)?'validation_ack_head_mismatch':fault==='clock'?'invalid_clock':'client_upgrade_required';
      return error.code===expected;
    });assert.equal(posts,0);assert.equal(f.events.some(e=>e.state==='ready'),false);assert.equal(f.m.groups.get(f.cid),f.group);}
    finally{Date.now=realNow;await f.storage.close();}
  }
});

test('manual repeated intent across two managers reserves one GET/POST; newer manual incident is never cleared by old ACK',async()=>{
  const f=await fixture();await f.m._applyRecoveryControl(f.cid,f.state('2',incident,'manual_intervention_required'));let gets=0,posts=0,release;
  const publicInfo=f.info();const client={getGroupInfo:async()=>{gets++;return publicInfo;},acknowledgeGroupInfoValidation:async()=>{posts++;return new Promise(r=>release=r);}};f.m.e2eeClient=client;
  const second=await f.manager();second.e2eeClient=client;await second._restoreGroupsLocally();await second._saveEncryptionSyncCheckpoint();
  const results=await Promise.allSettled([f.m.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid),second.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid)]);
  assert.ok(results.some(r=>r.status==='fulfilled'));await until(()=>posts===1);assert.equal(gets,1);assert.equal(posts,1);
  const intent=await f.storage.loadGroupInfoValidationAdmission(f.cid,f.device);assert.equal(intent.attempts,1);
  await assert.rejects(f.m._applyRecoveryControl(f.cid,f.state('3',secondIncident,'manual_intervention_required')),e=>f.m._providerPersistenceUncertain&&e.message==='[Encryption] Provider scope changed or persistence needs reconciliation');
  await second._applyRecoveryControl(f.cid,f.state('3',secondIncident,'manual_intervention_required'));await f.m._loadRecoveryControl(f.cid);requireValidationMetadata(f.m,f.cid);
  f.m._discoverMlsRecoveryStates=async()=>({});release(f.accepted('4'));await second._drainGroupInfoValidationAcks().catch(()=>{});
  assert.equal(f.m.getRecoveryControlSnapshot(f.cid).incident_id,secondIncident);assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'manual_intervention_required');
  assert.equal(f.events.some(e=>e.state==='ready'),false);await f.storage.close();
});

test('manual late GET under replaced account/storage/client retains durable intent without sending stale ACK',async()=>{
  for(const replacement of ['user','storage','client']){
    const f=await fixture();await f.m._applyRecoveryControl(f.cid,f.state('2',incident,'manual_intervention_required'));let release,posts=0,getEntered=false;
    const gate=new Promise(r=>release=r);f.m.e2eeClient={getGroupInfo:async()=>{getEntered=true;await gate;return f.info();},acknowledgeGroupInfoValidation:async()=>{posts++;return f.accepted('3');}};
    const work=f.m.validateManualGroupInfoAck('team',f.cid.slice(5),f.cid),failure=assert.rejects(work,e=>e.code==='recovery_scope_changed');
    await until(()=>getEntered);
    if(replacement==='user')f.m.userId='another-account';if(replacement==='storage')f.m.storage={...f.storage};if(replacement==='client')f.m.e2eeClient={};
    release();await failure;assert.equal(posts,0);assert.equal((await f.storage.loadGroupInfoValidationAdmission(f.cid,f.device)).attempts,1);
    assert.equal(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),null);await f.storage.close();
  }
});

test('manual control rejects legacy automatic or invalid-trigger admission/proof even with matching incident/head',async()=>{
  const f=await fixture();f.m._drainGroupInfoValidationAcks=async()=>{};
  f.m.e2eeClient={getGroupInfo:async()=>f.info(),acknowledgeGroupInfoValidation:async()=>f.accepted()};
  await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);
  const auto=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device);
  await f.m._applyRecoveryControl(f.cid,f.state('2',incident,'manual_intervention_required'));
  const next={...auto,recovery_revision:'2',job_id:'00000000-0000-4000-8000-000000000099'};
  const bytes=await f.storage.loadProviderState(f.user,f.device);
  await assert.rejects(f.storage.saveGroupInfoValidationAckCheckpoint(next,bytes,auto.job_id),/control CAS failed/);
  await assert.rejects(f.storage.saveGroupInfoValidationAckCheckpoint({...next,trigger:'automatic'},bytes,auto.job_id),e=>e.code==='validation_ack_checkpoint_invalid');
  const admission={version:1,job_id:next.job_id,user_id:f.user,device_id:f.device,signing_identity_sha256:auto.signing_identity_sha256,
    cid:f.cid,group_generation:0,epoch:0,incident_id:incident,recovery_revision:'2',artifact_sha256:f.artifact,policy:'verify',attempts:0,retry_at:Date.now(),outcome:'pending'};
  assert.equal(await f.storage.reserveGroupInfoValidationAdmission(admission,Date.now()),null);
  await assert.rejects(f.storage.reserveGroupInfoValidationAdmission({...admission,trigger:'unknown'},Date.now()),e=>e.code==='validation_ack_admission_invalid');
  assert.equal(await f.storage.reserveGroupInfoValidationAckAttempt(f.cid,f.device,auto.job_id,Date.now()),null);
  assert.equal(f.m.getRecoveryControlSnapshot(f.cid).recovery_action,'manual_intervention_required');await f.storage.close();
});

test('public replay repair defaults preserve manual suppression; opt-in user repair validates retained group and awaits discovery without reset',async()=>{
  const f=await fixture();await f.m._applyRecoveryControl(f.cid,f.state('2',incident,'manual_intervention_required'));
  let gets=0,posts=0,replays=0;
  f.m._withScopeRepairLock=async(_cid,work)=>work();
  f.m._replayEncryptedChannelState=async()=>{replays++;return{status:f.m.getRecoveryControlSnapshot(f.cid).recovery_action};};
  f.m._resetEncryptedChannelState=async()=>assert.fail('manual validation reset private state');
  f.m.e2eeClient={getGroupInfo:async()=>{gets++;return f.info();},acknowledgeGroupInfoValidation:async()=>{posts++;return f.accepted('3');}};
  let discovery;f.m._discoverMlsRecoveryStates=()=>discovery??=(async()=>{await f.m._applyRecoveryControl(f.cid,{...f.state('3',incident,'none'),incident_id:null,repair_retry_until:null});return{};})();
  const plain=await f.m.repairEncryptedChannel('team',f.cid.slice(5));assert.equal(plain.status,'manual_intervention_required');assert.equal(posts,0);assert.equal(gets,0);
  const explicit=await f.m.repairEncryptedChannel('team',f.cid.slice(5),{validateManualGroupInfo:true});assert.equal(explicit.status,'none');
  assert.equal(replays,2);assert.equal(gets,1);assert.equal(posts,1);assert.equal(f.m.groups.get(f.cid),f.group);assert.equal(f.events.some(e=>e.state==='ready'),false);await f.storage.close();
});

test('late public repair completion/failure cannot publish callbacks into a replacement account or client',async()=>{
  for(const outcome of ['success','failure'])for(const replacement of ['user','client']){
    const f=await fixture();let release;const gate=new Promise(r=>release=r),newEvents=[];
    f.m._withScopeRepairLock=async(_cid,work)=>work();f.m._replayEncryptedChannelState=async()=>{await gate;if(outcome==='failure')throw Error('old-scope failure');return{status:'ready'};};
    const work=f.m.repairEncryptedChannel('team',f.cid.slice(5)),rejected=assert.rejects(work);
    assert.equal(f.events.at(-1).type,'e2ee.repair_started');
    if(replacement==='user')f.m.userId='new-account';else f.m.client={dispatchEvent:e=>newEvents.push(e)};
    release();await rejected;assert.equal(f.events.some(e=>['e2ee.repair_completed','e2ee.repair_failed'].includes(e.type)),false);assert.deepEqual(newEvents,[]);await f.storage.close();
  }
});


test('delayed repair lock acquisition rejects replaced account/client/adapter before replay and releases the original adapter only',async()=>{
  for(const replacement of ['user','client','storage'])for(const mode of ['replay','reset_local_state']){
    const f=await fixture();let release,entered=false,replays=0,released=0;const gate=new Promise(r=>release=r),newEvents=[];
    f.storage.tryAcquireRepairLock=async()=>{entered=true;await gate;return true;};
    f.storage.releaseRepairLock=async()=>{released++;};
    f.m._replayEncryptedChannelState=async()=>{replays++;return{status:'ready'};};
    f.m._resetEncryptedChannelState=async()=>{replays++;return{status:'ready'};};
    const work=f.m.repairEncryptedChannel('team',f.cid.slice(5),{mode}),rejected=assert.rejects(work,e=>e.code==='recovery_scope_changed');
    await until(()=>entered);
    if(replacement==='user')f.m.userId='new-account';
    if(replacement==='client')f.m.client={dispatchEvent:e=>newEvents.push(e)};
    if(replacement==='storage')f.m.storage={releaseRepairLock:async()=>assert.fail('released replacement adapter lock')};
    release();await rejected;assert.equal(replays,0);assert.equal(released,1);assert.equal(f.m.isScopeRepairing(f.cid),false);
    assert.equal(f.events.some(e=>['e2ee.repair_completed','e2ee.repair_failed'].includes(e.type)),false);assert.deepEqual(newEvents,[]);await f.storage.close();
  }
});

test('durable ACK defer preserves exact body and budget across restart, CAS replacement and actual abort',async()=>{
 const f=await fixture();f.m._drainGroupInfoValidationAcks=async()=>{};f.m.e2eeClient={getGroupInfo:async()=>f.info(),acknowledgeGroupInfoValidation:async()=>f.accepted()};
 await f.m.validateAndQueueGroupInfoAck('team',f.cid.slice(5),f.cid);const job=await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),now=Date.now();
 await f.storage.deferGroupInfoValidationAck(job,now,()=>{});const deferred=await new IndexedDBEncryptionStorage(f.user).loadGroupInfoValidationAckCheckpoint(f.cid,f.device);
 assert.deepEqual(deferred,{...job,retry_at:Math.max(job.retry_at,now+30000)});assert.deepEqual(deferred.request,job.request);assert.equal(deferred.attempts,0);
 await assert.rejects(f.storage.deferGroupInfoValidationAck(deferred,now+30001,()=>{throw Error('replacement owner');}));assert.deepEqual(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),deferred);
 await f.storage.deferGroupInfoValidationAck(job,now+60000,()=>{});assert.deepEqual(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),deferred);
 const db=await f.storage.openDB(),orig=db.transaction.bind(db);db.transaction=(...args)=>{const tx=orig(...args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
 await assert.rejects(f.storage.deferGroupInfoValidationAck(deferred,now+60000,()=>{}));db.transaction=orig;assert.deepEqual(await f.storage.loadGroupInfoValidationAckCheckpoint(f.cid,f.device),deferred);await f.storage.close();
});

test('51 actual private groups: deferring bounded first ACK page exposes remaining peers without deleting obligations',async()=>{
 const f=await fixture(),rows=[],now=Date.now(),controls=[];
 for(let i=0;i<51;i++){const cid='team:ack-fair-'+String(i).padStart(3,'0'),group=f.wasm.Group.create_with_cid(f.m.provider,f.m.identity,cid),marker={...f.marker,cid};f.m.groups.set(cid,group);f.m._groupGenerations.set(cid,marker);await f.storage.saveGroupState(cid,marker);controls.push({...f.m.getRecoveryControlSnapshot(f.cid),cid});}
 await f.m._persistProviderStrict();const bytes=f.m.provider.to_bytes();
 for(const control of controls){await f.storage.saveRecoveryControlCheckpoint(control);const group=f.m.groups.get(control.cid),info=group.export_group_info(f.m.provider,f.m.identity,true);const job={version:1,job_id:require('node:crypto').randomUUID(),user_id:f.user,device_id:f.device,signing_identity_sha256:control.signing_identity_sha256,request:{version:1,cid:control.cid,group_generation:0,epoch:0,hash:sha256Hex(info),incident_id:incident},recovery_revision:'1',marker:f.m._groupGenerations.get(control.cid),provider_sha256:sha256Hex(bytes),artifact_sha256:f.artifact,policy:'verify',attempts:0,retry_at:now,outcome:'pending'};await f.storage.saveGroupInfoValidationAckCheckpoint(job,bytes,null);rows.push(job);}
 const first=await f.storage.listDueGroupInfoValidationAcks(f.device,now,50);assert.equal(first.length,50);
 for(const job of first)await f.storage.deferGroupInfoValidationAck(job,now,()=>{});
 const remaining=await f.storage.listDueGroupInfoValidationAcks(f.device,now,50);assert.equal(remaining.length,1);assert.equal(remaining[0].request.cid,rows[50].request.cid);
 const restarted=new IndexedDBEncryptionStorage(f.user);assert.equal((await restarted.listDueGroupInfoValidationAcks(f.device,now+30000,50)).length,50);for(const job of rows){const actual=await restarted.loadGroupInfoValidationAckCheckpoint(job.request.cid,f.device);assert.deepEqual(actual.request,job.request);assert.equal(actual.attempts,0);assert.equal(actual.outcome,'pending');}await restarted.close();await f.storage.close();
});

// Explicit crypto-invalid fixture metadata; missing/stale GI alone never authorizes ACK work.
function requireValidationMetadata(m,cid) {
 const marker=m._groupGenerations.get(cid),control=m._recoveryControls.get(cid);if(!marker||!control)return;
 m._channelE2ee.set(cid,{cid,group_generation:marker.group_generation,group_id:marker.group_id?Buffer.from(marker.group_id).toString('base64'):null,epoch:marker.current_epoch,
  group_info:{status:'validation_required',ready:false,epoch:marker.current_epoch,last_uploaded_at:null,refresh_requested:false},
  recovery:{action:control.recovery_action,incident_id:control.incident_id,revision:control.recovery_revision,repair_retry_until:control.repair_retry_until}});
}
