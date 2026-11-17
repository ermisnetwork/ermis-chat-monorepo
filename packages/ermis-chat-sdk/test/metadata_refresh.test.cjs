const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {ErmisChat} = require('../dist/index.cjs');
const deferred = () => {let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve};};
async function fixture(run) {
  let requests = 0;
  let respond = (_req, res) => res.end('{"channels":[]}');
  const sockets = new Set();
  const server = http.createServer((req,res) => {req.resume();req.on('end',()=>{requests++;res.setHeader('content-type','application/json');respond(req,res,requests);});});
  server.on('connection', socket => {sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const client = new ErmisChat('fixture','project','http://127.0.0.1:'+server.address().port,{browser:false,logger:()=>{}});
  client._setUser({id:'fixture'});client.deviceId='fixture';await client.tokenManager.setTokenOrProvider('fixture-access',{id:'fixture'});client.axiosInstance.defaults.proxy=false;
  try {await run({client,count:()=>requests,respond:fn=>respond=fn});}
  finally {for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
}
const refresh = client => client.loadChannelMetadata({type:'team'},[],{},{refresh:true});
test('baseline startup list obtains latest preview and recency before opening a channel',async()=>{
  const client=new ErmisChat('fixture','project','https://fixture.invalid',{browser:false,logger:()=>{}});
  client._setUser({id:'fixture',name:'Fixture'});
  let reads=0;
  const latest='2026-11-17T12:51:06Z';
  client.post=async(_url,body)=>{
    reads++;
    assert.equal(body.message_limit,1,'baseline backend needs a preview to derive last_message_at');
    assert.deepEqual(body.sort,[{field:'last_message_at',direction:-1}]);
    return {channels:[{channel:{id:'recency',cid:'team:recency',type:'team',created_at:'2026-01-01T00:00:00Z',last_message_at:latest,members:[]},messages:[{id:'newest',text:'QA3',created_at:latest}],read:[]}]};
  };
  const [rows,shared]=await Promise.all([client.loadChannelMetadata({type:'team'}),client.loadChannelMetadata({type:'team'})]);
  assert.equal(reads,1);
  assert.equal(rows[0],shared[0]);
  assert.equal(rows[0].state.latestMessages.at(-1).id,'newest');
  assert.equal(rows[0].state.last_message_at.toISOString(),'2026-11-17T12:51:06.000Z');
  await client.loadChannelMetadata({type:'team'});
  assert.equal(reads,1,'rendering the same list must not read history again');
});
test('startup shares completed metadata; explicit refresh reads again and becomes shared result',{timeout:5000},()=>fixture(async({client,count})=>{
  await Promise.all([client.loadChannelMetadata({type:'team'}),client.loadChannelMetadata({type:'team'})]);
  await client.loadChannelMetadata({type:'team'});assert.equal(count(),1);
  await refresh(client);assert.equal(count(),2,'explicit refresh must issue fresh HTTP');
  await client.loadChannelMetadata({type:'team'});assert.equal(count(),2);
  await refresh(client);assert.equal(count(),3,'later refresh must not reuse a completed refresh');
}));
test('refresh during startup waits for old read, coalesces refresh waiters and issues one new HTTP',{timeout:5000},()=>fixture(async({client,count,respond})=>{
  const entered=deferred(),release=deferred();
  respond((_req,res,n)=>{if(n===1){entered.resolve();release.promise.then(()=>res.end('{"channels":[]}'));}else res.end('{"channels":[]}');});
  const startup=client.loadChannelMetadata({type:'team'});await entered.promise;
  const first=refresh(client),second=refresh(client);assert.equal(count(),1);
  release.resolve();await Promise.all([startup,first,second]);assert.equal(count(),2);
}));
test('failed refresh evicts only its cache entry and allows a new request',{timeout:5000},()=>fixture(async({client,count,respond})=>{
  await client.loadChannelMetadata({type:'team'});
  respond((_req,res)=>{res.statusCode=400;res.end('{"code":4,"message":"fixture rejection"}');});
  await assert.rejects(refresh(client));assert.equal(count(),2);
  respond((_req,res)=>res.end('{"channels":[]}'));
  await client.loadChannelMetadata({type:'team'});assert.equal(count(),3);
}));
test('queued refresh from retired owner issues no HTTP and cannot remove replacement cache',{timeout:5000},()=>fixture(async({client,count,respond})=>{
  const entered=deferred(),release=deferred();
  respond((_req,res,n)=>{if(n===1){entered.resolve();release.promise.then(()=>res.end('{"channels":[]}'));}else res.end('{"channels":[]}');});
  const startup=client.loadChannelMetadata({type:'team'}),oldRejected=assert.rejects(startup,e=>e.code==='recovery_scope_changed');await entered.promise;
  const queued=refresh(client),queuedRejected=assert.rejects(queued,e=>e.code==='recovery_scope_changed');
  client._setUser({id:'replacement'});await client.tokenManager.setTokenOrProvider('replacement-access',{id:'replacement'});
  await client.loadChannelMetadata({type:'team'});assert.equal(count(),2);
  release.resolve();await Promise.all([oldRejected,queuedRejected]);
  await client.loadChannelMetadata({type:'team'});assert.equal(count(),2);
}));

test('reconnect retires completed startup metadata so a later list load reads current membership',{timeout:5000},()=>fixture(async({client,count})=>{
  await client.loadChannelMetadata({type:'team'});assert.equal(count(),1);
  await client.recoverState();
  await client.loadChannelMetadata({type:'team'});assert.equal(count(),2);
}));

test('successful refresh replaces cached channel membership, not only its HTTP count',{timeout:5000},()=>fixture(async({client,count,respond})=>{
  respond((_req,res,n)=>{const id=n===1?'before':'after';res.end(JSON.stringify({channels:[{channel:{id,cid:'team:'+id,type:'team',mls_enabled:false,created_at:'2026-11-17T00:00:00Z',members:[]},messages:[],read:[]}]}));});
  const before=await client.loadChannelMetadata({type:'team'});assert.deepEqual(before.map(c=>c.cid),['team:before']);
  const after=await refresh(client);assert.deepEqual(after.map(c=>c.cid),['team:after']);
  const shared=await client.loadChannelMetadata({type:'team'});assert.deepEqual(shared.map(c=>c.cid),['team:after']);assert.equal(count(),2);
}));
