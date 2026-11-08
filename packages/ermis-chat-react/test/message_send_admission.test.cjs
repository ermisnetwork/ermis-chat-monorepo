const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('typescript');
const source=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../src/hooks/useMessageSend.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function latch(){let open,reject;const promise=new Promise((a,b)=>{open=a;reject=b});return{promise,open,reject}}
function fixture(){
 const refs=[];let slot=0;const module={exports:{}};vm.runInNewContext(source,{exports:module.exports,module,require:name=>name==='react'?{useState:()=>[false,()=>{}],useCallback:fn=>fn,useRef:value=>refs[slot++]??(refs[slot-1]={current:value})}: {buildAttachmentPayload:()=>assert.fail('no attachments')},console:{error:()=>{}},requestAnimationFrame:()=>{},URL,Promise});
 let resets=0,syncs=0,sends=0,admission,options;const transport=latch();
 const channel={data:{mls_enabled:true},sendMessage:(_m,o)=>{options=o;admission=o?.onLocalEnqueued;sends++;return transport.promise},stopTyping:()=>{}};
 const props={activeChannel:channel,editableRef:{current:null},files:[],setFiles:()=>{},hasContent:true,setHasContent:()=>{},isTeamChannel:false,buildPayload:()=>({text:'draft'}),reset:()=>resets++,syncMessages:()=>syncs++};
 const render=()=>{slot=0;return module.exports.useMessageSend(props)};
 return{render,props,channel,transport,ack:()=>admission?.(),get resets(){return resets},get sends(){return sends},get syncs(){return syncs},get options(){return options}};
}
test('composer retains the draft until durable admission then permits background transport',async()=>{
 const f=fixture(),hook=f.render(),work=hook.handleSend();await new Promise(setImmediate);assert.equal(f.resets,0);assert.equal(f.options.waitForLocalAdmission,true);
 await hook.handleSend();assert.equal(f.sends,1,'one draft waits for capacity');f.ack();await work;assert.equal(f.resets,1);f.transport.open({message:{id:'accepted'}});
});
test('failed local reservation preserves the draft for the user',async()=>{
 const f=fixture(),work=f.render().handleSend();await new Promise(setImmediate);f.transport.reject(Object.assign(Error('local storage failed'),{code:'provider_checkpoint_conflict'}));await work;assert.equal(f.resets,0);
});
test('late acknowledgment cannot clear a draft in a newly selected channel',async()=>{
 const f=fixture(),work=f.render().handleSend();await new Promise(setImmediate);f.props.activeChannel={...f.channel};f.render();f.ack();await work;assert.equal(f.resets,0);f.transport.reject(Error('late transport failure'));await new Promise(setImmediate);
});
