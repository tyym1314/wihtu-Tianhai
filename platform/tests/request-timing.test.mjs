import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginRoomReadTiming,finishRoomReadTiming} from '../server/request-timing.mjs';

const path='/api/pvp/rooms/pvp_example',id='a'.repeat(32);
function response(){return{headers:{},setHeader(k,v){this.headers[k]=v;}};}
test('only exact room GETs are observed and caller correlation is ignored',()=>{
 for(const [method,url] of [['POST',path],['GET',path+'/action'],['GET','/health'],['GET',path+'?token=private'],['GET','/api/pvp/rooms/']]){
  const r=response();assert.equal(beginRoomReadTiming({method,url},r),false);assert.equal(finishRoomReadTiming(r),false);assert.deepEqual(r.headers,{});
 }
 const r=response();let time=10;
 assert.equal(beginRoomReadTiming({method:'GET',url:path,headers:{'x-oasis-request-id':'caller-secret'}},r,{now:()=>time,makeId:()=>id}),true);
 assert.equal(beginRoomReadTiming({method:'GET',url:path},r),false);
 time=22.5;assert.equal(finishRoomReadTiming(r),true);
 assert.deepEqual(r.headers,{'X-Oasis-Request-Id':id,'Server-Timing':'app;dur=12.500'});
 assert.equal(finishRoomReadTiming(r),false);
});
test('invalid clocks, unsafe generated IDs and committed or aborted responses emit no diagnostics',()=>{
 for(const clock of [NaN,Infinity])assert.equal(beginRoomReadTiming({method:'GET',url:path},response(),{now:()=>clock,makeId:()=>id}),false);
 for(const bad of ['','caller\r\nSet-Cookie: secret','not-hex',null])assert.equal(beginRoomReadTiming({method:'GET',url:path},response(),{makeId:()=>bad}),false);
 for(const flags of [{headersSent:true},{destroyed:true}]){const r=Object.assign(response(),flags);beginRoomReadTiming({method:'GET',url:path},r);assert.equal(finishRoomReadTiming(r),false);assert.deepEqual(r.headers,{});}
 for(const end of [-1,NaN,Infinity]){const r=response();let time=0;beginRoomReadTiming({method:'GET',url:path},r,{now:()=>time,makeId:()=>id});time=end;assert.equal(finishRoomReadTiming(r),false);assert.deepEqual(r.headers,{});}
});
test('disabled or declined sinks add no response listeners; diagnostic errors never escape',()=>{
 const req={method:'GET',url:path};
 for(const sink of [null,{record:()=>false},{record:()=>{throw Error('disk failure');}}]){
  const r=Object.assign(new EventEmitter(),response());let epochCalls=0;
  assert.equal(beginRoomReadTiming(req,r,{sink,epoch:()=>{epochCalls++;return 123;},makeId:()=>id}),true);
  assert.equal(r.listenerCount('finish'),0);assert.equal(r.listenerCount('close'),0);
  assert.equal(finishRoomReadTiming(r),true);
  assert.equal(epochCalls,sink?1:0);
 }
 for(const options of [{now:()=>{throw Error('clock');}},{makeId:()=>{throw Error('entropy');}}])assert.equal(beginRoomReadTiming(req,response(),options),false);
});
test('same random RID joins entry/headers/one terminal event without request fields',()=>{
 for(const terminal of ['finish','close']){
  const rows=[],r=Object.assign(new EventEmitter(),response(),{statusCode:409});let mono=10,epoch=1000;
  const req={method:'GET',url:path,headers:{authorization:'Bearer secret','x-oasis-request-id':'caller'},body:{player:'private'}};
  assert.equal(beginRoomReadTiming(req,r,{now:()=>mono,epoch:()=>epoch,makeId:()=>id,sink:{record:row=>{rows.push(row);return true;}}}),true);
  mono=13;epoch=1003;assert.equal(finishRoomReadTiming(r),true);
  mono=18;epoch=998;r.emit(terminal);r.emit(terminal==='finish'?'close':'finish');
  assert.deepEqual(rows,[{phase:'entry',request_id:id,epoch_ms:1000,mono_ms:10},{phase:'headers',request_id:id,epoch_ms:1003,mono_ms:13,app_ms:3},{phase:terminal,request_id:id,epoch_ms:998,mono_ms:18,status:409}]);
  assert.equal(r.listenerCount('finish'),0);assert.equal(r.listenerCount('close'),0);
  assert.equal(finishRoomReadTiming(r),false);
 }
});
test('premature close before serialization records no successful finish or headers',()=>{
 const rows=[],r=Object.assign(new EventEmitter(),response(),{statusCode:200});
 beginRoomReadTiming({method:'GET',url:path},r,{now:()=>10,epoch:()=>100,makeId:()=>id,sink:{record:row=>{rows.push(row);return true;}}});
 r.destroyed=true;r.emit('close');r.emit('finish');
 assert.deepEqual(rows.map(x=>x.phase),['entry','close']);assert.equal(finishRoomReadTiming(r),false);
});
test('real JSON responses include preparation timing without changing bytes or private-cache headers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oasis-timing-'));
 const prior=process.env.OASIS_LOCAL_DIR;process.env.OASIS_LOCAL_DIR=dir;
 let server;
 try{
  const {send}=await import('../server/security.mjs');
  server=createServer((req,res)=>{
   let at=0;beginRoomReadTiming(req,res,{now:()=>at,makeId:()=>id});
   if(req.url.endsWith('broken')){
    try{send(res,200,{toJSON(){at=9;throw Error('fixture');}});}catch{assert.equal(res.headersSent,false);send(res,500,{error:'serialization failed'});}
   }else send(res,200,{toJSON(){at=7.25;return{value:'汉字',status:'unchanged'};}});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const res=await fetch(base+path,{headers:{'X-Oasis-Request-Id':'must-not-reflect'}});
  assert.equal(await res.text(),'{"value":"汉字","status":"unchanged"}');
  assert.equal(res.headers.get('cache-control'),'no-store');assert.equal(res.headers.get('referrer-policy'),'no-referrer');
  assert.equal(res.headers.get('x-oasis-request-id'),id);assert.equal(res.headers.get('server-timing'),'app;dur=7.250');
  const other=await fetch(base+'/health');assert.equal(other.headers.get('server-timing'),null);await other.arrayBuffer();
  const broken=await fetch(base+'/api/pvp/rooms/broken');assert.equal(broken.status,500);assert.equal(broken.headers.get('server-timing'),'app;dur=9.000');assert.deepEqual(await broken.json(),{error:'serialization failed'});
 }finally{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(prior===undefined)delete process.env.OASIS_LOCAL_DIR;else process.env.OASIS_LOCAL_DIR=prior;
  await rm(dir,{recursive:true,force:true});
 }
});
