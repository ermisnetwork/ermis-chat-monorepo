const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function mount(initial){let cursor=0;const slots=[],effects=[],listeners=new Map(),timers=[];
 const client={userID:'owner',getSessionSyncProgress:()=>initial,isSessionSyncProgressDismissed:()=>false,on(type,fn){listeners.set(type,fn);return{unsubscribe(){listeners.delete(type)}}}};
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>slots[i]=v]},useRef(value){const i=cursor++;return slots[i]||={current:value}},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>!Object.is(v,old.deps[k]))){old?.cleanup?.();slots[i]={deps};effects.push(()=>slots[i].cleanup=fn())}}};
 const jsx=(type,props)=>({type,props}),t=(key,values)=>key.endsWith('preparing')?'Đang chuẩn bị…':key.includes('channels_')?`${key} ${values.ready}/${values.total}`:key;
 const file=path.resolve(__dirname,'../src/features/chat/SyncStatusBanner.tsx'),module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){},require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};if(name==='react-dom')return{createPortal:x=>x};if(name==='react-i18next')return{useTranslation:()=>({t})};if(name==='lucide-react')return{RefreshCw:'spinner',X:'close',CheckCircle2:'done',AlertCircle:'partial'};throw Error(name)}},{filename:file});
 const render=(props={})=>{cursor=0;const view=module.exports.SyncStatusBanner({client,...props});while(effects.length)effects.shift()();return view};
 render();return{render,emit:value=>listeners.get('e2ee.session_progress')(value),timers};
}
function text(node){if(node==null||typeof node==='boolean')return'';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(text).join(' ');return text(node.props?.children)}
const initial={cycle_id:'same-cycle',readiness:true,phase:'preparing',status:'running',total_channels:31,ready_channels:3};
test('actual popup hides3/31 during preparation then shows the same cycle counter at readiness',()=>{
 const h=mount(initial);let view=h.render();assert.match(text(view),/Đang chuẩn bị/);assert.doesNotMatch(text(view),/3\/31/);assert.equal(h.timers.length,0);
 h.emit({...initial,phase:'readiness'});view=h.render();assert.match(text(view),/3\/31/);assert.doesNotMatch(text(view),/Đang chuẩn bị/);assert.equal(view.props.children.props['data-cycle-id'],'same-cycle');
});
test('blocked preparation exposes truthful partial counts and never starts a done timer',()=>{
 const h=mount(initial);h.emit({...initial,phase:'readiness',status:'partial',ready_channels:8,total_channels:10,retry(){}});assert.match(text(h.render()),/8\/10/);assert.equal(h.timers.length,0);
});
test('zero-channel completion still gets the existing success timer',()=>{
 const h=mount({...initial,phase:'readiness',status:'done',total_channels:0,ready_channels:0});assert.match(text(h.render()),/0\/0/);assert.equal(h.timers.length,1);
});

test('a hidden quiet readiness snapshot removes an already visible history spinner', () => {
 const h = mount({cycle_id: 'history', phase: 'restoring_page', status: 'running'});
 assert.match(text(h.render()), /restoring_page/);
 h.emit({status: 'idle'});
 assert.equal(h.render(), null);
});

test('history progress only appears on its encrypted timeline', () => {
 const h = mount({cycle_id: 'p1', history_cid: 'team:secure', phase: 'restoring_page', status: 'running'});
 assert.match(text(h.render({activeCid: 'team:secure', activeEncrypted: true})), /restoring_page/);
 assert.equal(h.render({activeCid: 'team:other', activeEncrypted: true}), null);
 assert.equal(h.render({activeCid: 'topic:standard', activeEncrypted: false}), null);
 assert.equal(h.render(), null);
 h.emit({status: 'idle'});
 assert.equal(h.render({activeCid: 'team:secure', activeEncrypted: true}), null);
});
