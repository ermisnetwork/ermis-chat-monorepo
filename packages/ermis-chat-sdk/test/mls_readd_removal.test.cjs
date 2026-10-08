const assert=require('node:assert/strict');const test=require('node:test');
const {EncryptionManager}=require('../dist/index.cjs');
const cid='team:readd';
function harness(role='member',created='2026-10-06T00:00:02.000000001Z'){
 const m=new EncryptionManager();m.userId='bob';
 const membership={user_id:'bob',channel_role:role,created_at:created};
 m.client={activeChannels:{[cid]:{state:{members:{bob:membership},membership},data:{}}}};
 m.groups.set(cid,{});return m;
}
test('old removal/tombstone cannot delete a newer membership or its installed group',async()=>{
 const m=harness();await m._processRemovedChannelTombstone({cid,removed_at:'2026-10-06T00:00:02.000000000Z'});
 assert.equal(m.groups.has(cid),true);assert.ok(m.client.activeChannels[cid]);
 m.leaveGroup(cid,'2026-10-06T00:00:01Z');assert.equal(m.groups.has(cid),true);
});
test('equal/newer removal, unknown time or unknown membership is not ignored',()=>{
 const m=harness();for(const time of ['2026-10-06T00:00:02.000000001Z','2026-10-06T00:00:03Z',undefined,'bad'])assert.equal(m.isObsoleteMlsRemoval(cid,'bob',time),false);
 assert.equal(m.isObsoleteMlsRemoval(cid,'unknown','2026-10-06T00:00:01Z'),false);
});
test('rejected or historical membership does not prove an active re-add',()=>{
 const m=harness('rejected');assert.equal(m.isObsoleteMlsRemoval(cid,'bob','2026-10-06T00:00:01Z'),false);
});
test('queued ghost removal refreshes metadata and preserves a member who rejoined',async()=>{
 const m=harness();m.userId='alice';let queries=0;
 m._pendingEvictions.set(cid,new Set(['bob']));m.groups.set(cid,{members_by_user_id:()=>[{}]});
 m._persistPendingEvictions=async()=>{};m._removePendingEviction=async()=>{};
 m.client.activeChannels[cid].watch=async()=>{queries++;};
 assert.deepEqual(await m._collectPendingGhosts(cid),[]);assert.equal(queries,1);
});
