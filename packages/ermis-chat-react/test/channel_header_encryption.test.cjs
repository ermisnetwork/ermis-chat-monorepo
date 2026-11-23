const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');

function fixture(data = {}) {
 const source = fs.readFileSync(process.env.HEADER_SOURCE || path.join(__dirname, '../src/components/ChannelHeader.tsx'), 'utf8');
 const start = source.indexOf('  useEffect(() => {', source.indexOf('const [channelUpdateCount'));
 const end = source.indexOf('  // ── Direct Channel', start);
 assert.ok(start > 0 && end > start);
 const listeners = new Map(), channelListeners = new Map();
 let epoch = -1, renders = 0, shown = epoch, cleanup;
 const on = (map, name, cb) => { const bucket = map.get(name) || new Set(); bucket.add(cb); map.set(name,bucket); return {unsubscribe:()=>bucket.delete(cb)}; };
 const client = {userID:'header-owner',encryptionManager:{getEpoch:()=>epoch},on:(name,cb)=>on(listeners,name,cb)};
 const activeChannel = {cid:'team:channel',data,on:(name,cb)=>on(channelListeners,name,cb)};
 const code = ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{activeChannel,client,isDirectChannel:()=>false,
   useEffect:effect=>{cleanup=effect();},setChannelUpdateCount:()=>{renders++;shown=client.encryptionManager.getEpoch();}});
 return {client,activeChannel,epoch:value=>{epoch=value;},get shown(){return shown;},get renders(){return renders;},
   event:(name,value)=>{for(const cb of listeners.get(name)||[])cb(value);},
   callbacks:()=>[...listeners.values()].flatMap(set=>[...set]),cleanup:()=>cleanup()};
}

test('mounted header repaints an asynchronously loaded native epoch without leaving the channel',()=>{
 const h=fixture();assert.equal(h.shown,-1);h.epoch(59);
 h.event('e2ee.state_changed',{cid:h.activeChannel.cid,state:'ready',epoch:59});
 assert.equal(h.shown,59);assert.equal(h.renders,1);h.cleanup();
});
test('header follows its shared scope and ignores another channel',()=>{
 const h=fixture({parent_cid:'team:parent',gate:false});h.epoch(61);
 h.event('e2ee.channel_ready',{cid:'team:other'});assert.equal(h.renders,0);
 h.event('e2ee.channel_ready',{cid:'team:parent'});assert.equal(h.shown,61);
 h.epoch(62);h.event('e2ee.sync_state',{cid:'team:parent'});assert.equal(h.shown,62);h.cleanup();
});
test('retired header callbacks cannot repaint a replacement view or account',()=>{
 for(const retired of ['cleanup','account']){
  const h=fixture(),late=h.callbacks();h.epoch(65);
  if(retired==='cleanup')h.cleanup();else h.client.userID='replacement';
  for(const cb of late)cb({cid:h.activeChannel.cid});assert.equal(h.renders,0);
  if(retired!=='cleanup')h.cleanup();
 }
});
