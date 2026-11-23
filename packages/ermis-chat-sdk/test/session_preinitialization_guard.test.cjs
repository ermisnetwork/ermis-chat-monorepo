const test = require('node:test');
const assert = require('node:assert/strict');
const {ErmisChat} = require('../dist/index.cjs');
function fixture(encrypted = true) {
  const client = new ErmisChat('fixture', 'project', 'https://fixture.invalid', {browser:false, logger:()=>{}});
  client._setUser({id:'owner',name:'Owner'});
  const channel = client.channel('team','project:guard');
  channel.data = {cid:channel.cid,type:'team',mls_enabled:encrypted};
  channel.initialized = true;
  const calls=[];
  client.post=async (url,body)=>{calls.push({url,body});return {message:{id:'fixture-message',cid:channel.cid,text:'fixture',created_at:new Date().toISOString(),user:{id:'owner',name:'Owner'}}};};
  return {client,channel,calls};
}
for (const initialized of [undefined,false]) test('encrypted send before native initialization never reaches plaintext transport: '+initialized, async()=>{
  const {client,channel,calls}=fixture();
  if(initialized===false)client.encryptionManager={initialized:false};
  let admitted=0;
  await assert.rejects(channel.sendMessage({text:'fixture'}, {waitForLocalAdmission:true,onLocalEnqueued:()=>admitted++}),error=>error.code==='e2ee_not_initialized');
  assert.equal(calls.length,0);assert.equal(channel.state.messages.length,0);assert.equal(admitted,0);
});
test('encrypted edit before native initialization never reaches plaintext transport',async()=>{
  const {channel,calls}=fixture();
  await assert.rejects(channel.editMessage('fixture-message',{text:'fixture'}),error=>error.code==='e2ee_not_initialized');
  assert.equal(calls.length,0);
});
test('standard channel remains usable without encryption initialization',async()=>{
  const {channel,calls}=fixture(false);await channel.sendMessage({text:'fixture'});assert.equal(calls.length,1);
});
test('standard gated topic under an encrypted root uses its own standard lane',async()=>{
  const {client,calls}=fixture();
  const topic=client.channel('topic','project:plain');
  topic.data={cid:topic.cid,type:'topic',parent_cid:'team:project:guard',gate:true,e2ee_group_id:topic.cid,mls_enabled:false};
  topic.initialized=true;await topic.sendMessage({text:'fixture'});assert.equal(calls.length,1);
});
