const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {getLastMessagePreview}=require('../dist/index.cjs');
function mount(){
 const slots=[],listeners=new Map();let cursor=0;const on=(key,fn)=>{let set=listeners.get(key);if(!set)listeners.set(key,set=new Set());set.add(fn);return{unsubscribe:()=>set.delete(fn)}};
 const client={state:{users:{}},activeChannels:{},on:(type,fn)=>on('*:'+type,fn)};
 const row=(cid,at,text)=>({cid,data:{name:cid},state:{latestMessages:[{id:cid,created_at:new Date(at),text,content_type:'mls',mls_ciphertext:new Uint8Array([1])}]},getClient:()=>client,on:(type,fn)=>on(cid+':'+type,fn)});
 const parent=row('team:parent','2026-11-18T07:00:00Z','parent'),topic=row('topic:child','2026-11-18T08:00:00Z','');parent.state.topics=[topic];client.activeChannels={[parent.cid]:parent,[topic.cid]:topic};
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],fn=>{slots[i]=typeof fn==='function'?fn(slots[i]):fn}]},useMemo(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((x,n)=>!Object.is(x,old.deps[n])))slots[i]={deps,value:fn()};return slots[i].value},useCallback(fn,deps){return react.useMemo(()=>fn,deps)},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((x,n)=>!Object.is(x,old.deps[n]))){old?.cleanup?.();slots[i]={deps,cleanup:fn()}}}};
 const filename=path.resolve(__dirname,'../src/hooks/useTopicGroupUpdates.ts'),module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{exports:module.exports,module,Date,console,require(name){if(name==='react')return react;if(name==='../utils')return{getLastMessagePreview};if(name==='../channelRoleUtils')return{isPendingMember:()=>false,isSkippedMember:()=>false};if(name==='../channelTypeUtils')return{isDirectChannel:()=>false};if(name==='./useChatCore')return{useChatCore:()=>({client,activeChannel:null})};if(name==='../channelListActivity')return requireSourceActivity();if(name==='@ermis-network/ermis-chat-sdk')return{};throw Error(name)}},{filename});
 function requireSourceActivity(){const file=path.resolve(__dirname,'../src/channelListActivity.ts'),mod={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;vm.runInNewContext(code,{exports:mod.exports,module:mod,Date,require:()=>({})});return mod.exports;}
 const render=()=>{cursor=0;return module.exports.useTopicGroupUpdates(parent,'fixture',{encryptedMessageLabel:'Encrypted message'})};
 return{parent,topic,client,render,emit(type,cid){for(const key of ['*:'+type,cid+':'+type])for(const fn of listeners.get(key)||[])fn({type,cid})}};
}
for(const event of ['sync.completed','sync.failed','e2ee.sync_state','message.updated'])test(event+' publishes already-decrypted topic state into a memoized group preview',()=>{
 const h=mount();assert.equal(h.render().latestMessagePreview.text,'Encrypted message');
 h.topic.state.latestMessages[0]={...h.topic.state.latestMessages[0],text:'authenticated fixture'};h.emit(event,h.topic.cid);
 assert.equal(h.render().latestMessagePreview.text,'authenticated fixture');
});
test('group preview resolves the current active topic after metadata replaced its instance',()=>{
 const h=mount();h.render();h.client.activeChannels[h.topic.cid]={...h.topic,state:{...h.topic.state,latestMessages:[{...h.topic.state.latestMessages[0],text:'replacement fixture'}]}};
 h.emit('e2ee.local_messages_loaded',h.topic.cid);assert.equal(h.render().latestMessagePreview.text,'replacement fixture');
});
