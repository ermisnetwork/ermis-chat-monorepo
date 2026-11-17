const test = require('node:test');
const assert = require('node:assert/strict');
const { E2eeClient } = require('../dist/encryption/index.cjs');
test('global scope transport uses baseline cursors and retains topic route CID', async () => {
  let captured;
  const parent='team:parent', topic='topic:child', cursor={created_at:'2026-11-17T00:00:00.000000001Z',event_id:'00000000-0000-0000-0000-000000000001'};
  const client={baseURL:'https://fixture.invalid',userID:'fixture',deviceId:'fixture',projectId:'fixture', _captureAuthScope:()=>({assertCurrent(){}}),
    doAxiosRequest:async(method,url,body)=>{captured={method,url,body};return {channels:{[parent]:{events:[{type:'application',cid:topic,parent_cid:parent,event_id:cursor.event_id,created_at:cursor.created_at,data:{id:'message',cid:topic,mls_ciphertext:'AQ==',group_generation:0}}],has_more:false,next_cursor:cursor}}};}};
  const api=new E2eeClient(client);
  const response=await api.scopeSync({[parent]:cursor});
  assert.deepEqual(captured.body.cursors,{[parent]:cursor});
  for(const key of ['bootstrap','live_anchor_version','protocol_cursors'])assert.equal(Object.hasOwn(captured.body,key),false);
  assert.equal(response.channels[parent].events[0].cid,topic);
  assert.deepEqual(response.channels[parent].next_cursor,cursor);
});
