const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{Module}=require('node:module');
const build=require('esbuild').buildSync({stdin:{contents:"export {bytesEqual} from './aad'; export {sameSyncCheckpointValue} from './checkpoint_value';",resolveDir:path.resolve(__dirname,'../src/encryption')},bundle:true,platform:'node',format:'cjs',write:false});
const compiled=new Module(__filename);compiled._compile(build.outputFiles[0].text,__filename);const {bytesEqual,sameSyncCheckpointValue}=compiled.exports;
test('exact checkpoint/AAD equality preserves offsets, word boundaries, tails and every single-byte difference',()=>{
 for(const length of [0,1,3,4,7,31,63,64,65,66,67,68,127,128,129,1027])for(let offset=0;offset<8;offset++){
  const left=new Uint8Array(new ArrayBuffer(length+offset+8),offset,length),right=new Uint8Array(new ArrayBuffer(length+offset+16),offset+3,length);
  for(let n=0;n<length;n++)left[n]=right[n]=(n*73+offset)&255;
  assert.equal(bytesEqual(left,right),true);assert.equal(sameSyncCheckpointValue({bytes:left},{bytes:right}),true);
  for(let n=0;n<length;n++){right[n]^=0x80;assert.equal(bytesEqual(left,right),false);assert.equal(sameSyncCheckpointValue(left,right),false);right[n]^=0x80;}
  assert.equal(bytesEqual(left,new Uint8Array(length+1)),false);
 }
});
test('structured checkpoint type, date, object and cycle semantics stay exact',()=>{
 const bytes=new Uint8Array([1,2,3,4]);assert.equal(sameSyncCheckpointValue(bytes,new Int8Array(bytes)),false);assert.equal(sameSyncCheckpointValue(bytes,bytes.buffer),false);
 assert.equal(sameSyncCheckpointValue(bytes.buffer,bytes.buffer.slice(0)),true);assert.equal(sameSyncCheckpointValue(new DataView(bytes.buffer),new DataView(bytes.buffer.slice(0))),true);
 assert.equal(sameSyncCheckpointValue({revision:'1',bytes},{bytes:new Uint8Array(bytes),revision:'1'}),true);assert.equal(sameSyncCheckpointValue({revision:'1',bytes},{revision:'2',bytes}),false);
 const a={at:new Date(123),items:[bytes]},b={at:new Date(123),items:[new Uint8Array(bytes)]};a.self=a;b.self=b;assert.equal(sameSyncCheckpointValue(a,b),true);b.at=new Date(124);assert.equal(sameSyncCheckpointValue(a,b),false);
 assert.equal(bytesEqual(null,null),false);assert.equal(bytesEqual(undefined,bytes),false);
});
test('large offset buffers and shared views compare actual byte ranges without digest equivalence',()=>{
 const size=1024*1024+3,a=new Uint8Array(size+9).subarray(7,7+size),b=new Uint8Array(size+13).subarray(11,11+size);a.fill(0x5a);b.fill(0x5a);
 assert.equal(sameSyncCheckpointValue(a,b),true);for(const n of [0,3,64,65535,size-3,size-1]){b[n]^=1;assert.equal(sameSyncCheckpointValue(a,b),false);b[n]^=1;}
 if(typeof SharedArrayBuffer!=='undefined'){const x=new Uint8Array(new SharedArrayBuffer(67)),y=new Uint8Array(new SharedArrayBuffer(67));assert.equal(bytesEqual(x,y),true);y[66]=1;assert.equal(bytesEqual(x,y),false);}
});
test('both-aligned word views compare every byte across distinct offsets, unsigned high bits and tails',()=>{
 for(const length of [64,65,66,67,68,127,128,129,1027])for(const offset of [0,4,8]){
  const a=new Uint8Array(length+offset+8).subarray(offset,offset+length),b=new Uint8Array(length+offset+20).subarray(offset+12,offset+12+length);
  for(let n=0;n<length;n++)a[n]=b[n]=(n*173+0x80)&255;
  assert.equal(bytesEqual(a,b),true);
  for(let n=0;n<length;n++){b[n]^=0x80;assert.equal(bytesEqual(a,b),false);b[n]^=0x80;}
  assert.equal(sameSyncCheckpointValue({bytes:a},{bytes:b}),true);
 }
});
test('aligned large and shared buffers preserve exact byte offsets and the non-word tail',()=>{
 const length=1024*1024+3,a=new Uint8Array(length+4).subarray(4),b=new Uint8Array(length+12).subarray(12);a.fill(0xff);b.fill(0xff);
 assert.equal(bytesEqual(a,b),true);for(const n of [0,3,4,65535,length-4,length-3,length-1]){b[n]^=0x80;assert.equal(bytesEqual(a,b),false);b[n]^=0x80;}
 if(typeof SharedArrayBuffer!=='undefined'){const x=new Uint8Array(new SharedArrayBuffer(75),4,67),y=new Uint8Array(new SharedArrayBuffer(79),8,67);x.fill(0x80);y.fill(0x80);assert.equal(bytesEqual(x,y),true);for(const n of [0,3,63,64,66]){y[n]^=1;assert.equal(bytesEqual(x,y),false);y[n]^=1;}}
});
