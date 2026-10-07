/** Real browser fetch/WebCrypto contract; local fixture HTTP, no gameplay or device claim. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import * as Run from '../arena/run/engine.mjs';
import {compactRoomSnapshot} from '../server/pvp/snapshot-transfer.mjs';

const root=resolve(new URL('..',import.meta.url).pathname),path='/api/pvp/rooms/run-room';
const out=resolve(root,'review/run-snapshot-transfer-browser',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
await mkdir(out,{recursive:true});
const sources=['tests/run-snapshot-transfer-browser.mjs','arena/shared/client.mjs','arena/shared/snapshot-transfer.mjs','shared/run-snapshot-transfer.mjs','server/pvp/snapshot-transfer.mjs'];
const source_hashes=Object.fromEntries(await Promise.all(sources.map(async p=>[p,createHash('sha256').update(await readFile(resolve(root,p))).digest('hex')])));
const bundle=await build({stdin:{contents:"import {api,authorize} from './arena/shared/client.mjs';window.client={api,authorize};",resolveDir:root},bundle:true,write:false,format:'esm',logLevel:'silent'});
function room(){const game=Run.view(Run.createState('12'.repeat(32),1000,{players:[{key:'human',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]}),'human');return {id:'run-room',code:'RUNROOM',game_id:'run',me:'human',version:12,server_now:1000,players:[{external_user_id:'human',connected:true}],game};}
let current,wire=[],held=[],hold=false,corrupt=0,status=200;
const session={app_id:'fixture-app',game_id:'run',external_user_id:'human'};
const server=createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<script type="module" src="/client.js"></script>');return;}
 if(req.url==='/client.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
 if(req.url!==path&&req.url!==path+'/action'){res.writeHead(404);res.end();return;}
 const row={method:req.method,hint:req.headers['x-oasis-known-run-game']??null,status};wire.push(row);
 let value=req.method==='POST'?{...current,action_receipt:{request_id:'unchanged'}}:compactRoomSnapshot(structuredClone(current),undefined,{runKey:req.headers['x-oasis-known-run-game'],session});
 if(status!==200)value={error:{code:'FIXTURE'}};
 if(corrupt-->0&&value.run_game_transfer)value.run_game_transfer.key='f'.repeat(64);
 row.omitted=value.run_game_transfer?.omitted??null;
 const body=JSON.stringify(value),responseStatus=status;
 res.writeHead(responseStatus,{'content-type':'application/json','cache-control':'no-store'});
 // Send no-store headers before delaying the body, so Chrome does not
 // serialize two identical in-flight GETs behind its HTTP cache lock.
 if(hold)res.flushHeaders();
 const send=()=>res.end(body);
 if(hold)held.push(send);else send();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const report={scope:'Local HTTP fixture with real client, fetch, WebCrypto and authorization generation. Not public-host, physical Safari, rendering or performance acceptance.',source_hashes,cases:[],passed:false};
async function until(fn){const limit=Date.now()+5000;while(!await fn()){assert.ok(Date.now()<limit,'fixture wait timed out');await new Promise(r=>setTimeout(r,10));}}
let browser;
try{
 for(const name of ['chromium','webkit']){
  browser=await(name==='webkit'?webkit.launch({headless:true}):chromium.launch({channel:'chrome',headless:true}));
  async function run(label,fn){current=room();wire=[];held=[];hold=false;corrupt=0;status=200;const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   try{await page.goto(origin);await page.waitForFunction(()=>window.client);await page.evaluate(()=>client.authorize('fixture-token-a'));await fn(page);assert.deepEqual(errors,[]);report.cases.push({browser:name,name:label,passed:true,wire:structuredClone(wire)});}
   catch(error){report.cases.push({browser:name,name:label,passed:false,wire:structuredClone(wire),errors,error:error.message});throw error;}
   finally{for(const send of held.splice(0))send();await page.close();}
  }
  const get=page=>page.evaluate(async path=>{const r=await client.api(path);return{version:r.version,distance:r.game.players[0].distance,server_now:r.server_now,connected:r.players[0].connected,frozen:Object.isFrozen(r.game.players[0])};},path);
  await run('full then omission preserves fresh envelope and exact immutable game',async page=>{
   assert.equal((await get(page)).frozen,true);current.server_now=2000;current.players[0].connected=false;
   const r=await get(page);assert.equal(r.server_now,2000);assert.equal(r.connected,false);assert.equal(r.frozen,true);
   assert.equal(wire[0].hint,'full');assert.match(wire[1].hint,/^[a-f0-9]{64}$/);assert.equal(wire[1].omitted,true);
   current.game.players[0].distance=7;assert.equal((await get(page)).distance,7);assert.equal(wire[2].omitted,false);
  });
  await run('bad digest retries full once and never retries mutation',async page=>{
   await get(page);corrupt=1;await get(page);assert.equal(wire.length,3);assert.equal(wire[2].hint,'full');
   const receipt=await page.evaluate(async path=>(await client.api(path+'/action',{seq:1})).action_receipt,path);assert.deepEqual(receipt,{request_id:'unchanged'});assert.equal(wire.at(-1).hint,null);
   status=409;const error=await page.evaluate(async path=>{try{await client.api(path+'/action',{seq:2});}catch(e){return{code:e.code,status:e.status};}},path);
   assert.deepEqual(error,{code:'FIXTURE',status:409});assert.equal(wire.length,5);
  });
  await run('authorization change rejects in-flight view and clears retained key',async page=>{
   await get(page);hold=true;
   await page.evaluate(path=>{window.pending=client.api(path).then(()=>({ok:true}),e=>({code:e.code}));},path);await until(()=>held.length===1);
   await page.evaluate(()=>client.authorize('fixture-token-b'));hold=false;held.shift()();assert.deepEqual(await page.evaluate(()=>pending),{code:'SESSION_CHANGED'});
   await get(page);assert.equal(wire.at(-1).hint,'full');
  });
  await run('older overlapping full response cannot replace newer retained game',async page=>{
   hold=true;await page.evaluate(path=>{window.older=client.api(path);},path);await until(()=>held.length===1);
   current.version++;current.game.players[0].distance=8;hold=false;assert.equal((await get(page)).distance,8);
   held.shift()();assert.equal(await page.evaluate(async()=>(await older).game.players[0].distance),0);
   assert.equal((await get(page)).distance,8);assert.equal(wire.at(-1).omitted,true);
  });
  for(const kind of ['unavailable','rejects'])await run('WebCrypto '+kind+' keeps complete GET fallback',async page=>{
   await page.evaluate(kind=>Object.defineProperty(globalThis,'crypto',{configurable:true,value:kind==='unavailable'?{}:{subtle:{digest:async()=>{throw Error('fixture');}}}}),kind);
   assert.equal((await get(page)).distance,0);assert.equal(wire.length,kind==='unavailable'?1:2);assert.equal(wire.at(-1).hint,null);
   await get(page);assert.equal(wire.at(-1).hint,null);
  });
  await run('aborted GET body is not retried',async page=>{
   hold=true;await page.evaluate(path=>{const original=globalThis.fetch;window.headersSeen=0;globalThis.fetch=(...args)=>original(...args).then(response=>{window.headersSeen++;return response;});window.controller=new AbortController();window.pending=client.api(path,undefined,{signal:controller.signal}).then(()=>({ok:true}),e=>({name:e.name,message:e.message}));},path);
   await until(()=>held.length===1);await page.waitForFunction(()=>headersSeen===1);await page.evaluate(()=>controller.abort());
   assert.deepEqual(await page.evaluate(()=>pending),{name:'Error',message:'Connection interrupted. Please reconnect to recover your room.'});assert.equal(await page.evaluate(()=>controller.signal.aborted),true);assert.equal(wire.length,1);
  });
  await browser.close();browser=null;
 }
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{await browser?.close();for(const send of held.splice(0))send();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,report:resolve(out,'report.json'),error:report.error}));}
