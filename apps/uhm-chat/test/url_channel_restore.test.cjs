const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),ts=require('typescript');
const filename=path.resolve(__dirname,'../src/utils/urlChannelRestore.ts'),fixture=new Module(filename,module);
fixture._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
const {beginUrlChannelRestore}=fixture.exports;
const settle=()=>new Promise(r=>setImmediate(r));
function harness(t){
 const timers=[],ready=[],errors=[];let cached,listener,slow=0,queries=0,unsubscribes=0,resolve,reject;
 const fallback=new Promise((a,b)=>{resolve=a;reject=b;});
 t.mock.method(globalThis,'setTimeout',callback=>{const timer={callback};timers.push(timer);return timer;});
 t.mock.method(globalThis,'clearTimeout',timer=>{timer.cleared=true;});
 const options={getCached:()=>cached,subscribe:fn=>{listener=fn;return()=>{listener=null;unsubscribes++;};},loadFallback:()=>{queries++;return fallback;},onReady:x=>ready.push(x),onSlow:()=>slow++,onError:()=>errors.push(true)};
 return {options,timers,ready,errors,setCached:x=>cached=x,event:()=>listener?.(),slow:()=>slow,queries:()=>queries,unsubscribes:()=>unsubscribes,resolve,reject};
}
test('late hydration survives the unchanged five-second soft notice and opens without a fallback',t=>{
 const h=harness(t),cancel=beginUrlChannelRestore(h.options);h.timers[0].callback();assert.equal(h.slow(),1);assert.deepEqual(h.ready,[]);
 const channel={cid:'team:late'};h.setCached(channel);h.event();assert.deepEqual(h.ready,[channel]);assert.equal(h.queries(),0);assert.deepEqual(h.errors,[]);assert.equal(h.unsubscribes(),1);assert.equal(h.timers[0].cleared,true);cancel();assert.equal(h.unsubscribes(),1);
});
test('already hydrated owner resolves synchronously with no subscription, timer or HTTP',t=>{
 const h=harness(t),channel={cid:'team:cached'};h.setCached(channel);beginUrlChannelRestore(h.options);assert.deepEqual(h.ready,[channel]);assert.equal(h.timers.length,0);assert.equal(h.unsubscribes(),0);assert.equal(h.queries(),0);
});
test('list miss issues one fallback and late success remains authoritative after soft notice',async t=>{
 const h=harness(t);beginUrlChannelRestore(h.options);h.event();h.event();await settle();assert.equal(h.queries(),1);h.timers[0].callback();assert.equal(h.slow(),1);const channel={cid:'team:off-page'};h.resolve(channel);await settle();assert.deepEqual(h.ready,[channel]);assert.deepEqual(h.errors,[]);
});
for(const outcome of ['success','error'])test('retired route/account ignores late fallback '+outcome,async t=>{
 const h=harness(t),cancel=beginUrlChannelRestore(h.options);h.event();await settle();cancel();if(outcome==='success')h.resolve({cid:'old-owner'});else h.reject(Error('old-owner'));await settle();h.timers[0].callback();assert.deepEqual(h.ready,[]);assert.deepEqual(h.errors,[]);assert.equal(h.slow(),0);
});
test('fallback failure ends only that owner and a new explicit retry can succeed',async t=>{
 const h=harness(t);beginUrlChannelRestore(h.options);h.event();await settle();h.reject(Error('transport'));await settle();assert.equal(h.errors.length,1);assert.deepEqual(h.ready,[]);const next={cid:'retry'};h.setCached(next);beginUrlChannelRestore(h.options);assert.deepEqual(h.ready,[next]);
});
test('hydration between initial read and subscription is resolved without a polling timer',t=>{
 const h=harness(t),subscribe=h.options.subscribe,channel={cid:'race'};h.options.subscribe=fn=>{h.setCached(channel);return subscribe(fn);};beginUrlChannelRestore(h.options);assert.deepEqual(h.ready,[channel]);assert.equal(h.queries(),0);assert.equal(h.timers[0].cleared,true);
});
test('synchronous subscription delivery cannot leave a live listener or duplicate selection',t=>{
 const h=harness(t),subscribe=h.options.subscribe,channel={cid:'sync'};h.options.subscribe=fn=>{const off=subscribe(fn);h.setCached(channel);fn();return off;};beginUrlChannelRestore(h.options);assert.deepEqual(h.ready,[channel]);assert.equal(h.unsubscribes(),1);h.event();assert.equal(h.ready.length,1);
});
