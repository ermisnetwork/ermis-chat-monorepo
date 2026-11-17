// Local synthetic transport benchmark. No browser/render/Ready/crypto or datastore claim.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{gzipSync}=require('node:zlib');
const {fork}=require('node:child_process'),{performance}=require('node:perf_hooks');
const args=process.argv.slice(2),arg=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const port=Number(arg('--port','18764')),rounds=Number(arg('--rounds','20')),encoding=arg('--encoding','identity');
if(!['identity','gzip'].includes(encoding))throw Error('Unsupported benchmark content encoding');
const now='2026-11-17T00:00:00Z',wait=ms=>new Promise(r=>setTimeout(r,ms));
const users=Array.from({length:6},(_,i)=>({id:'fixture-user-'+i,name:'Benchmark user '+i,image:'https://fixture.invalid/avatar/'+i,project_id:'fixture'}));
function channel(id,type='team',parent){return{channel:{id,cid:type+':'+id,type,name:'Synthetic channel '+id,mls_enabled:true,
 last_message_at:now,created_at:now,updated_at:now,member_count:6,gate:false,...(parent?{parent_cid:parent,e2ee_group_id:parent}:{}),
 members:[users[0],...Array.from({length:5},(_,i)=>({id:'fixture-member-'+(parent||type+':'+id)+'-'+i,name:'Fixture member '+(parent||id)+' '+i,avatar:'https://fixture.invalid/avatar/'+(parent||id)+'/'+i,project_id:'fixture'}))].map(user=>({user_id:user.id,user,channel_role:'member',created_at:now}))},messages:[],read:[],watchers:[],membership:{user:users[0],user_id:users[0].id,channel_role:'member',created_at:now}};}
if(args.includes('--serve')){
 let metadata=[],messages=[],counts={channels:0,pages:0,unexpected:0},bytes=0;
 async function send(response,data,request){const decoded=Buffer.from(JSON.stringify(data));
  if(encoding==='gzip'&&!String(request.headers['accept-encoding']||'').includes('gzip'))throw Error('SDK did not negotiate gzip');
  const body=encoding==='gzip'?gzipSync(decoded):decoded;bytes+=body.length;await wait(100);
  response.writeHead(200,{'content-type':'application/json','content-length':body.length,'vary':'Accept-Encoding',...(encoding==='gzip'?{'content-encoding':'gzip'}:{})});
  const started=performance.now(),chunk=16384,rate=10_000_000/8;
  for(let offset=0;offset<body.length;offset+=chunk){await wait(Math.max(0,(Math.min(offset+chunk,body.length)/rate*1000)-(performance.now()-started)));if(response.destroyed)return;response.write(body.subarray(offset,offset+chunk));}
  response.end();}
 const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  if(req.url.split('?')[0]==='/channels'){if(body.message_limit!==0)throw Error('metadata history limit is not zero');counts.channels++;await send(res,{channels:metadata},req);}
  else if(req.url.split('?')[0].endsWith('/query')){if(body.messages_seq?.limit!==50)throw Error('requested page limit is not 50');counts.pages++;await send(res,{...metadata[0],messages:messages.slice(-50)},req);}
  else{counts.unexpected++;res.writeHead(400);res.end('{}');}
 }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}));}});
 process.on('message',async message=>{if(message.type==='fixture'){
  metadata=Array.from({length:message.n},(_,i)=>{const row=channel('fixture:'+String(i).padStart(5,'0'));row.topics=[channel(row.channel.id+'-topic-a','topic',row.channel.cid),channel(row.channel.id+'-topic-b','topic',row.channel.cid)];return row;});
  const cid=metadata[0].channel.cid;messages=Array.from({length:message.m},(_,i)=>({id:'00000000-0000-0000-0000-'+String(i+1).padStart(12,'0'),cid,type:'regular',user:users[i%users.length],created_at:new Date(Date.parse(now)+i*1000).toISOString(),updated_at:now,msg_seq:i+1,last_event_seq:i+1,
   ...(i<Math.floor(message.m/2)?{content_type:'standard',text:'Synthetic standard history '+i}:{content_type:'mls',text:'',mls_ciphertext:Buffer.alloc(512,7).toString('base64'),mls_epoch:Math.floor(i/100),group_generation:i%2?3:4,e2ee_group_id:cid})}));
  counts={channels:0,pages:0,unexpected:0};bytes=0;process.send({type:'fixture',metadata_bytes:Buffer.byteLength(JSON.stringify({channels:metadata})),page_bytes:Buffer.byteLength(JSON.stringify({...metadata[0],messages:messages.slice(-50)})),wire_metadata_bytes:encoding==='gzip'?gzipSync(Buffer.from(JSON.stringify({channels:metadata}))).length:Buffer.byteLength(JSON.stringify({channels:metadata})),server_fixture_rss:process.memoryUsage().rss});
 }else if(message.type==='counts')process.send({type:'counts',counts,bytes});else if(message.type==='stop')server.close(()=>process.exit(0));});
 server.listen(port,'127.0.0.1',()=>process.send({type:'ready'}));
}else{
 require('fake-indexeddb/auto');globalThis.crypto??=require('node:crypto').webcrypto;
 const {ErmisChat,IndexedDBEncryptionStorage,EncryptionManager}=require('../../dist/index.cjs');
 const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*p)-1)];
 async function main(){const child=fork(__filename,['--serve','--port',String(port),'--encoding',encoding],{stdio:['ignore','ignore','inherit','ipc']});
  const receive=type=>new Promise((resolve,reject)=>{const done=message=>{if(message.type===type){child.off('message',done);child.off('exit',dead);resolve(message);}};const dead=()=>{child.off('message',done);reject(Error('Fixture server exited'));};child.on('message',done);child.once('exit',dead);});
  const command=async data=>{const response=receive(data.type);child.send(data);return response;};
  const results=[];
  try{await receive('ready');for(const n of [10,100,1000])for(const m of [50,10000,100000]){
   const fixture=await command({type:'fixture',n,m}),list=[],page=[],selection=[],warmCounts=[],heap=[],rss=[],cpu=[];
   for(let round=0;round<rounds;round++){
    globalThis.gc?.();const startMemory=process.memoryUsage(),startCpu=process.cpuUsage();
    const account='bootsync-benchmark-'+n+'-'+m+'-'+round,storage=new IndexedDBEncryptionStorage(account),client=new ErmisChat('synthetic-key','fixture','http://127.0.0.1:'+port,{browser:false,logger:()=>{}});
    client._setUser(users[0]);client.tokenManager.setTokenOrProvider('synthetic-fixture-token',users[0]);client.state.users={[users[0].id]:users[0]};client.messageStorage=storage;
    try{let started=performance.now();const [channels,a,b]=await Promise.all([client.loadChannelMetadata({}),client.loadChannelMetadata({}),client.loadChannelMetadata({})]);
     list.push(performance.now()-started);if(channels!==a||channels!==b||channels.length!==n)throw Error('Metadata sharing failed');
     if(channels.some(c=>c.state.messages.length))throw Error('Metadata hydrated eager application messages');
     const manager=new EncryptionManager();manager.userId=users[0].id;manager.client=client;started=performance.now();const warm=manager._warmScopeCids(channels[0].cid);selection.push(performance.now()-started);
     warmCounts.push(warm.length);if(warm.length!==Math.min(6,n)||!warm.includes(channels[0].cid)||manager.groups.size!==0)throw Error('Warm metadata selection created unbounded/native groups');
     started=performance.now();const response=await channels[0].query({messages_seq:{limit:50}});page.push(performance.now()-started);
     if(response.messages.length!==50)throw Error('Page response is not exactly50');
     const deltaCpu=process.cpuUsage(startCpu);cpu.push((deltaCpu.user+deltaCpu.system)/1000);heap.push(process.memoryUsage().heapUsed-startMemory.heapUsed);rss.push(process.memoryUsage().rss);
    }finally{const name=storage.dbName;await storage.close();await new Promise((yes,no)=>{const req=indexedDB.deleteDatabase(name);req.onsuccess=yes;req.onerror=no;});}
   }
   const measured=await command({type:'counts'});if(measured.counts.channels!==rounds||measured.counts.pages!==rounds||measured.counts.unexpected!==0)throw Error('Unexpected transport fanout');
   const result={n,n_canonical_root_scopes:n,total_metadata_rows:3*n,member_entries:18*n,m,rounds,encoding,...fixture,...measured,sdk_first_list_p95_ms:percentile(list,.95),sdk_page_hydration_p95_ms:percentile(page,.95),warm_selection_p95_ms:percentile(selection,.95),client_cpu_p95_ms:percentile(cpu,.95),client_heap_delta_p95_bytes:percentile(heap,.95),client_rss_max_bytes:Math.max(...rss),warm_bound:6,warm_counts:[...new Set(warmCounts)],
    browser_render:'NOT_RUN',active_durable_ready:'NOT_RUN',backend_datastore_calls:'NOT_RUN',archive_material_and_ratchet_crypto:'NOT_RUN'};delete result.type;results.push(result);process.stdout.write(JSON.stringify({n,m,list_p95_ms:result.sdk_first_list_p95_ms,page_p95_ms:result.sdk_page_hydration_p95_ms,metadata_bytes:fixture.metadata_bytes})+'\n');
  }
  const output={kind:'synthetic loopback SDK transport microbenchmark; no browser/device/crypto/database acceptance',content_encoding:encoding,rtt_ms:100,bandwidth_bits_per_second:10_000_000,members_per_channel:6,member_profiles:'fresh cache; five unique members per root plus shared authenticated owner',topics_per_root:2,fixture_messages_materialized_in_separate_server_process:true,results};
  const target=arg('--output');if(target)fs.writeFileSync(path.resolve(target),JSON.stringify(output,null,2)+'\n');
  }finally{if(child.connected){child.send({type:'stop'});await new Promise(resolve=>child.once('exit',resolve));}}
 }
 main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
}
