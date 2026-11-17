const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function fixture(){
 const values=new Map(),listeners=new Map(),cleanup=[];
 const client={baseURL:'https://fixture.invalid',projectId:'p',userID:'a',on:(event,fn)=>{listeners.set(event,fn);return{unsubscribe:()=>listeners.delete(event)}}};
 const scope=JSON.stringify([client.baseURL,client.projectId,client.userID]),key='recovery_gate_acknowledged_cids:v2:'+scope;
 global.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 global.window={addEventListener:()=>{},removeEventListener:()=>{}};
 const filename=path.resolve(__dirname,'../src/hooks/useRecoveryGateAcknowledgement.ts'),m=new Module(filename,module);
 m.require=name=>name==='react'?{useState:v=>[v,()=>{}],useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:fn=>{const end=fn();if(end)cleanup.push(end)}}:name==='@/utils/constants'?{STORAGE_KEYS:{RECOVERY_GATE_ACKNOWLEDGED_CIDS:'recovery_gate_acknowledged_cids'}}:require(name);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
 values.set(key,JSON.stringify(['*','team:one']));const h=m.exports.useRecoveryGateAcknowledgement(scope,client);
 return{values,listeners,client,key,h,close:()=>{cleanup.forEach(fn=>fn());delete global.localStorage;delete global.window;}};
}
test('Not now survives ordinary renders until explicit PIN unlock succeeds',()=>{const f=fixture();try{assert.equal(f.h.isAcknowledged('team:other'),true);assert.equal(f.values.has(f.key),true);f.listeners.get('e2ee.recovery_unlocked')();assert.equal(f.values.has(f.key),false);}finally{f.close()}});
test('late unlock from a replaced account cannot clear the prior account Not now',()=>{const f=fixture();try{f.client.userID='b';f.listeners.get('e2ee.recovery_unlocked')();assert.equal(f.values.has(f.key),true);}finally{f.close()}});
test('manual unlock clears only its captured backend project account preference and unsubscribes',()=>{const f=fixture();try{f.values.set('unrelated-account','keep');f.listeners.get('e2ee.recovery_unlocked')();assert.equal(f.values.get('unrelated-account'),'keep');}finally{f.close()}assert.equal(f.listeners.size,0)});
