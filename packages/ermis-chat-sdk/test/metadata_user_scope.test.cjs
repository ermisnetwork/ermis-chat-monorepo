const test=require('node:test'),assert=require('node:assert/strict');
const {ErmisChat}=require('../dist/index.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(origin,owner='owner'){
 const c=new ErmisChat('synthetic-key','fixture',origin,{browser:false,logger:()=>{}});c._setUser({id:owner,name:'Owner'});
 const calls=[];let counter=0;
 c.post=async(_url,body)=>{
  const member=body.filter_conditions.fixture_member||'member';
  return{channels:[{channel:{id:'fixture-'+(++counter),cid:'team:fixture-'+counter,type:'team',mls_enabled:true,created_at:'2026-11-17T00:00:00Z',members:[{user_id:member,user:{id:member},channel_role:'member'}]},messages:[],read:[],membership:{user_id:owner,channel_role:'member'}}]};
 };
 c.getBatchUsers=async ids=>{calls.push([...ids]);const users=ids.map(id=>({id,name:'Name '+id}));c.state.updateUsers(users);return users;};
 return{c,calls};
}
test('metadata user batches cannot combine IDs from different backend/account clients',async()=>{
 const a=fixture('https://a.fixture.invalid','account-a'),b=fixture('https://b.fixture.invalid','account-b');
 await Promise.all([a.c.queryChannels({fixture_member:'member-a'},[],{message_limit:0}),b.c.queryChannels({fixture_member:'member-b'},[],{message_limit:0})]);
 assert.deepEqual(a.calls,[['member-a']]);assert.deepEqual(b.calls,[['member-b']]);
});
test('retired metadata timer sends no user lookup after account replacement',async()=>{
 const {c,calls}=fixture('https://retired.fixture.invalid');
 const old=c.queryChannels({fixture_member:'old-member'},[],{message_limit:0}).catch(error=>error);
 await tick();c._setUser({id:'replacement',name:'Replacement'});
 const result=await old;assert.ok(result instanceof Error);assert.equal(result.code,'recovery_scope_changed');assert.deepEqual(calls,[]);
});
test('profile IDs arriving while a batch is in flight are fetched for their waiting demand',async()=>{
 const {c,calls}=fixture('https://late.fixture.invalid');let entered,release;
 const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 c.getBatchUsers=async ids=>{calls.push([...ids]);if(calls.length===1){entered();await held;}const users=ids.map(id=>({id,name:'Name '+id}));c.state.updateUsers(users);return users;};
 const first=c.queryChannels({fixture_member:'one'},[],{message_limit:0});await started;
 const second=c.queryChannels({fixture_member:'two'},[],{message_limit:0});await tick();release();
 await Promise.all([first,second]);assert.deepEqual(calls,[['one'],['two']]);assert.equal(c.state.users.two.name,'Name two');
});
test('authoritative full member profiles in metadata need no redundant profile HTTP',async()=>{
 const {c}=fixture('https://complete.fixture.invalid');c.getBatchUsers=async()=>assert.fail('Metadata already contains full profiles');
 c.post=async()=>({channels:[{channel:{id:'full',cid:'team:full',type:'team',mls_enabled:true,created_at:'2026-11-17T00:00:00Z',members:[{user_id:'full-member',user:{id:'full-member',name:'Full member',avatar:'https://fixture.invalid/avatar'},channel_role:'member'}]},messages:[],read:[]}]});
 const rows=await c.queryChannels({},[],{message_limit:0});assert.equal(rows.length,1);assert.equal(c.state.users['full-member'].name,'Full member');
});
