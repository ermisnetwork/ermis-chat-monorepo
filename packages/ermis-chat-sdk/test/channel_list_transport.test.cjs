const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {ErmisChat}=require('../dist/index.cjs');
test('partial HTTP200 channel list fails within read budget and explicit retry loads complete result',{timeout:12000},async()=>{
 const sockets=new Set();let partial,posts=0,complete=false;
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{posts++;assert.equal(req.url.split('?')[0],'/channels');res.writeHead(200,{'content-type':'application/json'});if(complete){res.end('{"channels":[]}');return}partial=res;res.write('{"channels":[')})});
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
 let work;
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new ErmisChat('fixture','project','http://127.0.0.1:'+server.address().port,{browser:false,logger:()=>{}});
  c._setUser({id:'fixture-user'});c.deviceId='fixture-device';await c.tokenManager.setTokenOrProvider('fixture-access',{id:'fixture-user'});c.axiosInstance.defaults.proxy=false;
  const before=c.activeChannels,start=Date.now();work=c.queryChannels({type:'team'}).then(value=>({ok:true,value}),e=>({ok:false,code:e.code}));
  const result=await Promise.race([work,new Promise(r=>setTimeout(()=>r({pending:true}),5700))]);
  assert.equal(result.pending,undefined,'a partial response must not strand initial channel loading');assert.equal(result.ok,false);assert(Date.now()-start<5700);
  assert.equal(posts,1,'no hidden channel-list retries');assert.equal(c.activeChannels,before);assert.equal(Object.keys(before).length,0);assert.equal(c.userID,'fixture-user');
  partial.destroy();complete=true;assert.deepEqual(await c.queryChannels({type:'team'}),[]);assert.equal(posts,2);
 }finally{partial?.destroy();for(const s of sockets)s.destroy();await work;await new Promise(r=>server.close(r))}
});
for(const config of [{timeout:100},{axiosRequestConfig:{timeout:100}}])test('channel list preserves a shorter caller read budget '+JSON.stringify(config),{timeout:3000},async()=>{
 const sockets=new Set();let partial,posts=0;const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{posts++;partial=res;res.writeHead(200,{'content-type':'application/json'});res.write('{"channels":[')})});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
 try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new ErmisChat('fixture','project','http://127.0.0.1:'+server.address().port,{browser:false,logger:()=>{},...config});c._setUser({id:'fixture-user'});c.deviceId='device';await c.tokenManager.setTokenOrProvider('fixture-access',{id:'fixture-user'});c.axiosInstance.defaults.proxy=false;const started=Date.now();await assert.rejects(c.queryChannels({type:'team'}));assert(Date.now()-started<1500);assert.equal(posts,1);assert.equal(Object.keys(c.activeChannels).length,0)}finally{partial?.destroy();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r))}
});
test('late channel body from retired account cannot hydrate replacement account',{timeout:3000},async()=>{
 let arrived,partial;const entered=new Promise(r=>arrived=r),sockets=new Set();const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{partial=res;res.writeHead(200,{'content-type':'application/json'});res.write('{"channels":');arrived()})});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
 try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new ErmisChat('fixture','project','http://127.0.0.1:'+server.address().port,{browser:false,logger:()=>{}});c._setUser({id:'before'});c.deviceId='device';await c.tokenManager.setTokenOrProvider('fixture-access',{id:'before'});c.axiosInstance.defaults.proxy=false;const work=c.queryChannels({type:'team'}),rejected=assert.rejects(work,e=>e.code==='recovery_scope_changed');await entered;c._setUser({id:'after'});partial.end('[]}');await rejected;assert.equal(c.userID,'after');assert.equal(Object.keys(c.activeChannels).length,0)}finally{partial?.destroy();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r))}
});
