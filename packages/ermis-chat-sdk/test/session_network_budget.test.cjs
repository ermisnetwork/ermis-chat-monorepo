const test=require('node:test'),assert=require('node:assert/strict');
const {ErmisChat}=require('../dist/index.cjs');
const latch=()=>{let open;const promise=new Promise(r=>open=r);return{promise,open};};
function fixture(){const c=new ErmisChat('fixture-key','fixture-project','http://fixture.invalid',{browser:false,logger:()=>{}});c._setUser({id:'owner'});c.tokenManager.setTokenOrProvider('synthetic-token',{id:'owner'});return c;}
test('one client admits two actual HTTP bodies; queued old owner cannot send after account replacement',async()=>{
 const c=fixture(),entered=latch(),release=latch();let active=0,maximum=0,posts=0;
 c.axiosInstance.post=async()=>{posts++;active++;maximum=Math.max(maximum,active);if(posts===2)entered.open();await release.promise;active--;return{status:200,data:{ok:true}};};
 const work=[0,1,2,3].map(n=>c.post(c.baseURL+'/fixture',{n}).catch(e=>e));await entered.promise;
 assert.equal(posts,2);assert.equal(maximum,2);c._setUser({id:'replacement'});release.open();
 const result=await Promise.all(work);assert.ok(result.every(x=>x instanceof Error));assert.equal(posts,2);
 c.axiosInstance.post=async()=>({status:200,data:{ok:true}});assert.deepEqual(await c.post(c.baseURL+'/fixture',{}),{ok:true});
});
test('queued deadline and cancellation never start HTTP and release no other request slot',async()=>{
 const c=fixture(),entered=latch(),release=latch();let calls=0;
 c.axiosInstance.post=async()=>{if(++calls===2)entered.open();await release.promise;return{status:200,data:{ok:true}};};
 const first=[c.post(c.baseURL+'/fixture',{}),c.post(c.baseURL+'/fixture',{})];await entered.promise;
 const abort=new AbortController();const cancelled=c.doAxiosRequest('post',c.baseURL+'/fixture',{}, {signal:abort.signal}).catch(e=>e);abort.abort();
 const deadline=await c.doAxiosRequest('post',c.baseURL+'/fixture',{}, {__mlsDeadline:Date.now()+30}).catch(e=>e);
 assert.equal(deadline.code,'key_package_ownership_deadline');assert.ok(await cancelled instanceof Error);assert.equal(calls,2);
 release.open();await Promise.all(first);await c.post(c.baseURL+'/fixture',{});assert.equal(calls,3);
});
