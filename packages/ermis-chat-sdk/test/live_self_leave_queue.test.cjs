const test = require('node:test');
const assert = require('node:assert/strict');
const { ErmisChat, EncryptionManager } = require('../dist/index.cjs');
function fixture() {
 const c = new ErmisChat('qa','qa','https://example.test',{browser:false,logger:()=>{}});
 c.userID='owner'; c.user={id:'owner'};
 const ch=c.channel('team','live-leave',{mls_enabled:true,created_by:{id:'owner'}});
 c.activeChannels[ch.cid]=ch;
 ch.state.members={owner:{user_id:'owner',channel_role:'owner'},peer:{user_id:'peer',created_at:'2026-10-20T00:00:00Z'}};
 const m=new EncryptionManager(); Object.assign(m,{initialized:true,userId:'owner',deviceId:'device',identity:{},storage:{},client:c,e2eeClient:{}});c.encryptionManager=m;
 const calls=[];m.queuePendingEviction=async(cid,user)=>{calls.push([cid,user]);return true;};
 m.evictMember=async()=>{calls.push(['FORBIDDEN_HTTP']);};
 m.ownsE2eeGroup=cid=>cid==='topic:owned';
 return {c,ch,m,calls,event:{type:'member.removed',mls_enabled:true,self_remove:true,user:{id:'peer'},member:{user_id:'peer'},created_at:'2026-10-20T00:00:01Z',topic_cids:['topic:owned','topic:foreign']}};
}
test('live self-leave queues parent and owned topics without submitting a drain-only commit',async()=>{
 const h=fixture();await h.ch._handleChannelEvent(h.event);
 assert.deepEqual(h.calls,[[h.ch.cid,'peer'],['topic:owned','peer']]);
 assert.equal(h.ch.state.members.peer,undefined);
});
test('admin kick does not queue or issue another removal commit',async()=>{
 const h=fixture();await h.ch._handleChannelEvent({...h.event,self_remove:false,user:{id:'owner'}});
 assert.deepEqual(h.calls,[]);assert.equal(h.ch.state.members.peer,undefined);
});
test('delayed self-leave older than active re-add changes neither membership nor crypto',async()=>{
 const h=fixture(),readded={user_id:'peer',created_at:'2026-10-20T00:00:02Z'};h.ch.state.members.peer=readded;
 await h.ch._handleChannelEvent(h.event);assert.equal(h.ch.state.members.peer,readded);assert.deepEqual(h.calls,[]);
});
test('active re-add during durable queue save is fenced before late membership deletion',async()=>{
 const h=fixture();let release,entered;
 const started=new Promise(r=>entered=r);h.m.queuePendingEviction=async()=>{entered();await new Promise(r=>release=r);return true;};
 const work=h.ch._handleChannelEvent(h.event);const failure=assert.rejects(work,e=>e.code==='recovery_scope_changed');
 await started;const readded={user_id:'peer',created_at:'2026-10-20T00:00:02Z'};h.ch.state.members.peer=readded;release();await failure;
 assert.equal(h.ch.state.members.peer,readded);
});
