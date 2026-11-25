const test = require('node:test');
const assert = require('node:assert/strict');
const {ErmisChat, EncryptionManager} = require('../dist/index.cjs');
const deferred = () => {let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function until(predicate) {for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('fixture continuation did not settle');}
function clientFixture() {
  const client=new ErmisChat('fixture','project','https://fixture.invalid',{browser:false,logger:()=>{}});
  client._setUser({id:'owner',name:'Owner'});
  return client;
}
function row(type,id,encrypted=true,extra={}) {
  return {channel:{type,id,cid:type+':'+id,mls_enabled:encrypted,created_at:'2026-11-20T00:00:00Z',
    topics_enabled:true,member_capabilities:['send-message'],members:[{user_id:'owner',channel_role:'member'}],...extra},
    membership:{user_id:'owner',channel_role:'member'},messages:[],read:[]};
}
test('serial preparation keeps counts internal until session catch-up starts without changing its cycle',()=>{
 const client=clientFixture(),p=client._sessionReadinessOwner().progress;
 p.record('standard|plain','ready');p.finish(p.begin(),new Map([['plain','standard|plain'],['secure','secure']]),()=>{});
 const cycle=p.snapshot().cycle_id;
 assert.equal(p.snapshot().phase,'preparing');assert.equal(p.snapshot().ready_channels,1);
 const point=client._beginSessionProgress('syncing');client._finishSessionProgress(point,false);
 assert.equal(p.snapshot().phase,'preparing','a point read or a finished job cannot start the global counter');
 client._startSessionReadinessSync();assert.equal(p.snapshot().phase,'readiness');assert.equal(p.snapshot().cycle_id,cycle);
 client._startSessionReadinessSync();p.finish(p.begin(),new Map([['plain','standard|plain'],['secure','secure']]),()=>{});
 assert.equal(p.snapshot().phase,'readiness');assert.equal(p.snapshot().cycle_id,cycle);
 p.record('secure','blocked');assert.equal(p.snapshot().status,'partial');assert.equal(p.snapshot().ready_channels,1);
 client._setUser({id:'replacement'});const next=client._sessionReadinessOwner().progress;
 next.finish(next.begin(),new Map([['new','new']]),()=>{});assert.equal(next.snapshot().phase,'preparing');
});
test('native inventory barrier waits for durable full inventory and rejects incomplete inventory without claiming Ready',async()=>{
 const client=clientFixture(),owner=client._sessionReadinessOwner(),gate=deferred(),ticket=owner.progress.begin();
 owner.work=gate.promise;let settled=false;
 const wait=client._waitForSessionInventory().then(()=>{settled=true;});await tick();assert.equal(settled,false);
 owner.progress.finish(ticket,new Map([['team:secure','team:secure']]),()=>{});gate.resolve();await wait;
 assert.equal(owner.progress.snapshot().ready_channels,0);
 const failed=owner.progress.begin();owner.progress.fail(failed,()=>{});owner.work=undefined;
 await assert.rejects(client._waitForSessionInventory(),e=>e.code==='session_inventory_unavailable');
});
test('channel progress weights shared scopes, includes standard, and never counts job completion as Ready',()=>{
  const client=clientFixture(), owner=client._sessionReadinessOwner(), p=owner.progress;
  const ticket=p.begin();assert.equal(p.snapshot().total_channels,undefined);
  const inventory=new Map([['team:secure','team:secure'],['topic:shared','team:secure'],['team:plain','standard|team:plain'],['team:blocked','team:blocked']]);
  p.record('standard|team:plain','ready');p.finish(ticket,inventory,()=>{});
  const job=client._beginSessionProgress('joining');client._finishSessionProgress(job,false);
  assert.equal(p.snapshot().ready_channels,1);assert.equal(p.snapshot().total_channels,4);
  assert.equal(p.snapshot().total_scopes,2);assert.equal(p.snapshot().standard_channels,1);
  p.record('team:secure','ready');p.record('team:secure','ready');p.record('team:secure','pending');
  p.record('team:blocked','failed');
  assert.equal(p.snapshot().ready_channels,3);assert.equal(p.snapshot().status,'partial');
  const history=client._beginSessionProgress('restoring_page');client._finishSessionProgress(history,true);
  assert.equal(client.getSessionSyncProgress().readiness,true);assert.equal(client.getSessionSyncProgress().ready_channels,3);
  p.exclude('team:blocked');assert.equal(p.snapshot().status,'done');assert.equal(p.snapshot().total_channels,3);
});
test('empty inventory completes, dismissal is presentation only, and retired callbacks cannot replace a session',()=>{
  const client=clientFixture(), old=client._sessionReadinessOwner(), ticket=old.progress.begin();
  old.progress.finish(ticket,new Map(),()=>{});assert.equal(client.getSessionSyncProgress().status,'done');
  client.dismissSessionSyncProgress(client.getSessionSyncProgress().cycle_id);assert.equal(client.getSessionSyncProgress(),null);
  client._setUser({id:'replacement',name:'Replacement'});
  const replacement=client._sessionReadinessOwner();replacement.progress.finish(replacement.progress.begin(),new Map([['team:new','team:new']]),()=>{});
  old.progress.record('team:old','ready');client._recordSessionReadiness('team:old','ready');
  assert.equal(client.getSessionSyncProgress().total_channels,1);assert.equal(client.getSessionSyncProgress().ready_channels,0);
});
test('an inventory response begun before deletion cannot restore its retired application channel',()=>{
 const client=clientFixture(),p=client._sessionReadinessOwner().progress,inventory=new Map([['team:a','team:a'],['team:b','team:b']]);
 p.finish(p.begin(),inventory,()=>{});p.record('team:a','ready');p.record('team:b','blocked');
 const pending=p.begin();p.exclude('team:b');p.finish(pending,inventory,()=>{});
 assert.equal(p.snapshot().total_channels,1);assert.equal(p.snapshot().ready_channels,1);assert.equal(p.snapshot().status,'done');
});
test('native initialization replacement must not reuse an old account inventory',async()=>{
  const client=clientFixture(), old=client._sessionReadinessOwner();let queries=0;
  old.roots=Promise.resolve([]);old.retryInventory=()=>{};client._queryChannelsInternal=async()=>{queries++;return [];};
  client._setUser({id:'replacement',name:'Replacement'});
  client.setSessionEncryptionInitialization(Promise.resolve(),async()=>{});await tick();
  assert.equal(queries,0);assert.equal(client.getSessionSyncProgress(),null);
});
test('full metadata inventory finishes all topic pages without scroll while root rows and standard messaging stay available',async()=>{
  const client=clientFixture(), native=deferred(), topicGate=deferred(), persisted=deferred(), targets=[], offsets=[];
  client.restoreSyncState=async()=>{};client._persistSyncState=async()=>{};client._scheduleHydratedColdStartSync=()=>{};
  client._waitForHydratedColdStartSync=async()=>{};
  const roots=Array.from({length:12},(_,i)=>row('team','root-'+i));roots.push(row('team','plain',false));
  roots[0].topics=[row('topic','shared-1',true,{parent_cid:'team:root-0',e2ee_group_id:'team:root-0'}),row('topic','shared-2',true,{parent_cid:'team:root-0',e2ee_group_id:'team:root-0'})];
  roots[12].topics=[row('topic','plain-child',false,{parent_cid:'team:plain'})];
  const topics=Array.from({length:145},(_,i)=>row('topic','gated-'+i,true,{parent_cid:'team:root-0',gate:true,e2ee_group_id:'topic:gated-'+i}));
  client.post=async(_url,body)=>{
    if(body.filter_conditions?.type?.includes?.('topic')) {offsets.push(body.filter_conditions.offset||0);await topicGate.promise;return {channels:topics.slice(body.filter_conditions.offset||0,(body.filter_conditions.offset||0)+body.filter_conditions.limit)};}
    return {channels:roots};
  };
  client.messageStorage={saveChannelMetadata:async(_key,value)=>{if(value.length>13)await persisted.promise;}};
  client.setSessionEncryptionInitialization(native.promise,async()=>{});
  const first=client.loadChannelMetadata({type:['team']},[],{},{sessionReadiness:true});
  const second=client.loadChannelMetadata({type:['team']},[],{},{sessionReadiness:true});
  assert.equal((await first).length,13);assert.equal((await second).length,13);
  assert.equal(client.getSessionSyncProgress().total_channels,undefined,'a temporary page is not the denominator');
  topicGate.resolve();await until(()=>offsets.length===2);await tick();
  assert.equal(client.getSessionSyncProgress().total_channels,undefined,'metadata must persist before publication');
  persisted.resolve();await until(()=>client.getSessionSyncProgress()?.total_channels!==undefined);
  let progress=client.getSessionSyncProgress();assert.deepEqual(offsets,[0,100]);
  assert.equal(progress.total_channels,161);assert.equal(progress.total_scopes,157);assert.equal(progress.standard_channels,2);assert.equal(progress.ready_channels,2);
  client.encryptionManager={initialized:true,sync:async()=>{targets.push(...client._sessionReadiness.progress.incomplete.filter(cid=>!cid.startsWith('standard|')));}};
  native.resolve();await until(()=>client.getSessionSyncProgress()?.status==='partial');
  progress=client.getSessionSyncProgress();assert.equal(new Set(targets).size,157);assert.equal(targets.length,157);
  assert.equal(progress.ready_channels,2,'job results cannot mint Ready without the durable guard hook');
  assert.equal(progress.blocked_channels,159);assert.ok(targets.every(cid=>!cid.startsWith('standard|')));
});

test('topic metadata omission inherits current parent capabilities while explicit empty and denied parent stay denied',()=>{
  const client=clientFixture();
  const allowed=row('team','allowed',false),denied=row('team','denied',false,{member_capabilities:[]});
  const missing=row('topic','missing',false,{parent_cid:'team:allowed'});delete missing.channel.member_capabilities;
  const explicit=row('topic','explicit',false,{parent_cid:'team:allowed',member_capabilities:[]});
  const deniedChild=row('topic','denied-child',false,{parent_cid:'team:denied'});delete deniedChild.channel.member_capabilities;
  client.hydrateChannels([allowed,denied]);client.hydrateChannels([missing,explicit,deniedChild]);
  assert.deepEqual(client.activeChannels['topic:missing'].data.member_capabilities,['send-message']);
  assert.deepEqual(client.activeChannels['topic:explicit'].data.member_capabilities,[]);
  assert.deepEqual(client.activeChannels['topic:denied-child'].data.member_capabilities,[]);
  client.hydrateChannels([row('team','allowed',false,{member_capabilities:[]})]);
  delete missing.channel.member_capabilities;client.hydrateChannels([missing]);
  assert.deepEqual(client.activeChannels['topic:missing'].data.member_capabilities,[],'parent revocation must replace previous inheritance');
});
test('opened queued scopes overtake background work with bounded fairness and duplicate opens coalesce',async()=>{
  const client=clientFixture(), m=new EncryptionManager(), entered=deferred(), release=deferred(), order=[];
  client.encryptionManager=m;
  Object.assign(m,{client,userId:'owner',deviceId:'fixture-device',initialized:true,storage:{}});
  const cids=Array.from({length:9},(_,i)=>'team:scope-'+i);
  for(const cid of cids){const c=client.channel('team',cid.slice(5));c.initialized=true;c.data=row('team',cid.slice(5)).channel;c.state.members.owner={user_id:'owner',channel_role:'member'};m._generationRecoveryAttempted.add(cid);}
  m._scopeSyncBlockedResult=async()=>undefined;m._scheduleScopeSyncRetry=()=>{};m._markKnownChannelsPendingRecoveryUnlock=async()=>{};
  m._ensureChannelReadyCore=async(_type,_id,cid)=>{order.push(cid);if(cid===cids[0]){entered.resolve();await release.promise;}return {cid,status:'needs_retry',error:'fixture-not-ready'};};
  const work=m.bootstrapKnownE2eeChannels({targetCids:cids});await entered.promise;
  const opens=[8,7,6,8,8].map(i=>m.ensureChannelReady('team',cids[i].slice(5),cids[i],{source:'open'}));
  release.resolve();await work;await Promise.all(opens);
  assert.deepEqual(order,[0,8,7,1,6,2,3,4,5].map(i=>cids[i]));assert.equal(m._foregroundReadiness.size,0);
});

test('membership/deletion revision removes inherited routes without claiming Ready or removing independent gated scopes',async()=>{
  const client=clientFixture();
  const rows=[row('team','plain',false),row('topic','child',false,{parent_cid:'team:plain'}),row('topic','gated',true,{parent_cid:'team:plain',gate:true,e2ee_group_id:'topic:gated'})];
  client.hydrateChannels(rows);const p=client._sessionReadinessOwner().progress;
  p.finish(p.begin(),new Map([['team:plain','standard|team:plain'],['topic:child','standard|topic:child'],['topic:gated','topic:gated']]),()=>{});
  p.record('standard|team:plain','ready');p.record('standard|topic:child','ready');
  client.dispatchEvent({type:'member.removed',cid:'team:plain',member:{user_id:'owner'}});await tick();
  assert.equal(p.snapshot().total_channels,1);assert.equal(p.snapshot().ready_channels,0);assert.equal(p.snapshot().status,'running');
  client.dispatchEvent({type:'channel.topic.closed',cid:'topic:gated'});await tick();
  assert.equal(p.snapshot().total_channels,0);assert.equal(p.snapshot().status,'done');
});

test('quiet restart emits terminal Done when unfinished work already showed its progress cycle',()=>{
 const client=clientFixture(),owner=client._sessionReadinessOwner(),events=[];
 client.on('e2ee.session_progress',event=>events.push(event));owner.bootstrapResolved=true;owner.quietBootstrap=true;
 owner.progress.finish(owner.progress.begin(),new Map([['team:first','team:first'],['team:tail','team:tail']]),()=>{});
 owner.progress.record('team:first','ready');assert.equal(events.at(-1).ready_channels,1);
 owner.progress.record('team:tail','ready');
 assert.equal(events.at(-1).status,'done','a visible running cycle must receive its terminal transition');
 assert.equal(events.at(-1).ready_channels,2);assert.equal(client.getSessionSyncProgress().status,'done');
});
test('fully restored quiet restart remains invisible when no progress cycle was presented',()=>{
 const client=clientFixture(),owner=client._sessionReadinessOwner(),events=[];
 client.on('e2ee.session_progress',event=>events.push(event));owner.bootstrapResolved=false;owner.quietBootstrap=true;
 owner.progress.finish(owner.progress.begin(),new Map([['team:done','team:done']]),()=>{});
 client._restoreSessionBootstrapMilestones(['team:done']);
 assert.equal(client.getSessionSyncProgress(),null);assert.equal(events.length,0);
});

test('quiet retained startup publishes idle when its visible history page settles', () => {
 const client = clientFixture(), owner = client._sessionReadinessOwner(), events = [];
 client.on('e2ee.session_progress', event => events.push(event));
 owner.bootstrapResolved = false;
 owner.progress.finish(owner.progress.begin(), new Map([['team:done','team:done']]), () => {});
 client._restoreSessionBootstrapMilestones(['team:done']);
 const page = client._beginSessionProgress('restoring_page');
 assert.equal(events.at(-1).phase, 'restoring_page');
 client._finishSessionProgress(page, false);
 assert.equal(events.at(-1).status, 'idle');
 assert.equal(client.getSessionSyncProgress(), null);
});
