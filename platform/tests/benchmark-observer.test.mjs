import test from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkGameTag} from '../scripts/benchmark-observer.mjs';
test('benchmark game tags are bounded and probability paths must match',()=>{
 const tag=(value,path='/api/pvp/rooms/example/action')=>benchmarkGameTag({'x-oasis-benchmark-game':value},path);
 assert.equal(tag('bowling'),'bowling');assert.equal(tag('thunder','/api/play/thunder/spin'),'thunder');
 for(const value of [undefined,null,['bowling'],'other','bowling\nrun','platform'])assert.equal(tag(value),null);
 assert.equal(tag('tiger','/api/play/thunder/spin'),null);
 assert.equal(benchmarkGameTag({},'/v1/sessions'),null);
});

test('real HTTP observation preserves aggregate and independent per-game action counts',async()=>{
 const {createServer}=await import('node:http');
 const {installBenchmarkObserver}=await import('../scripts/benchmark-observer.mjs');
 const server=createServer((req,res)=>{setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end('{}');},5);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port,send=process.send,messages=[];
 process.send=message=>messages.push(message);const dispose=installBenchmarkObserver(port);
 try{
  process.emit('message',{type:'measure-start'});
  for(const game of ['bowling','bowling','run'])await (await fetch(`http://127.0.0.1:${port}/api/pvp/rooms/example/action`,{method:'POST',headers:{'x-oasis-benchmark-game':game}})).text();
  await (await fetch(`http://127.0.0.1:${port}/api/play/thunder/spin`,{method:'POST',headers:{'x-oasis-benchmark-game':'tiger'}})).text();
  process.emit('message',{type:'measure-stop'});
  const result=messages.find(m=>m.type==='measure-summary').result;
  assert.equal(result.routes.find(r=>r.route==='POST /api/pvp/rooms/:id/action').count,3);
  assert.equal(result.game_routes.find(r=>r.game==='bowling').count,2);
  assert.equal(result.game_routes.find(r=>r.game==='run').count,1);
  assert.equal(result.game_routes.some(r=>r.game==='tiger'),false);
  assert.equal(result.routes.find(r=>r.route==='POST /api/play/thunder/spin').count,1);
  assert(result.game_routes.every(r=>r.p95_ms>=1&&Number.isFinite(r.p99_ms)));
 }finally{dispose();if(send===undefined)delete process.send;else process.send=send;await new Promise(resolve=>server.close(resolve));}
});
