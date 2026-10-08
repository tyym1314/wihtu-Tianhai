/** Real browser HTTP cache arbitration. Hold headers, not only the body.
 * No routing/interception/cache disabling: these can hide Chromium's cache lock.
 * Local fixture proof only; not a public network or physical-device acceptance.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';

const root=resolve(new URL('..',import.meta.url).pathname);
const out=resolve(root,'review/room-read-cache-browser',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
await mkdir(out,{recursive:true});
const sources=['tests/room-read-cache-browser.mjs','arena/shared/client.mjs','arena/shared/run-room-poller.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(sources.map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
const sourceHashes=await hashes();
const bundle=await build({stdin:{contents:"import {api,authorize} from './arena/shared/client.mjs';import {startRunRoomPolling} from './arena/shared/run-room-poller.mjs';window.fixture={api,authorize,startRunRoomPolling};",resolveDir:root},bundle:true,write:false,format:'esm',logLevel:'silent'});
assert.deepEqual(await hashes(),sourceHashes,'source changed while bundling');
let active;
const server=createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/client.js"></script>');return;}
 if(req.url==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
 if(req.url!=='/api/pvp/rooms/cache-fixture'||!active){res.writeHead(404);res.end();return;}
 const state=active,index=state.arrivals.length+1,row={index,at:performance.now(),method:req.method,released:false};state.arrivals.push(row);
 const send=()=>{if(row.released)return;row.released=true;row.sentAt=performance.now();res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','X-Fixture-Request-Id':String(index)});res.end(JSON.stringify({id:'cache-fixture',me:'fixture-player',game_id:'run',version:index,server_now:index,game:{gameId:'run',me:'fixture-player'}}));};
 if(index===1)state.releaseFirst=send;else send();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const report={scope:'Real desktop Chromium/WebKit with local delayed-header HTTP fixture. Original URLs and browser cache stay enabled. Does not prove public or physical-device latency.',source_hashes:sourceHashes,cases:[],passed:false};
const waitUntil=async(fn,ms)=>{const end=performance.now()+ms;while(!fn()&&performance.now()<end)await new Promise(resolve=>setTimeout(resolve,10));return !!fn();};
let browser;
try{
 for(const name of ['chromium','webkit']){
  browser=await(name==='webkit'?webkit.launch({headless:true}):chromium.launch({channel:'chrome',headless:true}));
  for(const mode of ['default-control','no-store-control','production-client','production-poller']){
   const context=await browser.newContext(),page=await context.newPage();active={arrivals:[],releaseFirst:null};const errors=[];page.on('pageerror',error=>errors.push(error.message));
   const row={browser:name,browser_version:browser.version(),mode};
   try{
    await page.goto(origin);await page.waitForFunction(()=>window.fixture);
    await page.evaluate(mode=>{
     fixture.authorize('local-fixture-token');window.completed=[];window.failures=[];
     const path='/api/pvp/rooms/cache-fixture';
     window.read=()=>mode.startsWith('production')?fixture.api(path):fetch(path,{method:'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer local-fixture-token','X-Oasis-Known-Run-Game':'full'},credentials:'same-origin',...(mode==='no-store-control'?{cache:'no-store'}:{})}).then(response=>response.json());
     window.begin=()=>read().then(value=>completed.push(value.version),error=>failures.push(error.message));
     if(mode==='production-poller')window.stop=fixture.startRunRoomPolling({read:signal=>fixture.api(path,undefined,{signal}),roomId:'cache-fixture',playerKey:'fixture-player',initialDelay:0,interval:()=>150,onRoom:value=>{completed.push(value.version);if(value.version>=2)stop();},onError:error=>failures.push(error.message)});
     else begin();
    },mode);
    assert.ok(await waitUntil(()=>active.arrivals.length===1,3000),'first request never reached fixture');
    if(mode!=='production-poller')await page.evaluate(()=>{begin();});
    row.second_reached_before_first_headers=await waitUntil(()=>active.arrivals.length>=2,1200);
    if(row.second_reached_before_first_headers)await page.waitForFunction(()=>completed.includes(2)||failures.length,{},{timeout:3000});
    row.completed_before_release=await page.evaluate(()=>[...completed]);
    active.releaseFirst();
    await page.waitForFunction(()=>completed.includes(2)||failures.length,{},{timeout:3000});
    const result=await page.evaluate(()=>({completed,failures}));
    row.completed=result.completed;row.errors=[...errors,...result.failures];row.arrivals=structuredClone(active.arrivals);
    assert.deepEqual(row.errors,[]);
    if(mode==='default-control'&&name==='chromium'){
     assert.equal(row.second_reached_before_first_headers,false,'Chromium negative control no longer reproduces HTTP cache serialization');
     assert.ok(!row.completed_before_release.includes(2));
    }
    if(mode!=='default-control'){
     assert.equal(row.second_reached_before_first_headers,true,'second GET was blocked behind first response headers');
     assert.ok(row.completed_before_release.includes(2),'fresh snapshot did not arrive while first response was held');
    }
    row.passed=true;
   }catch(error){row.passed=false;row.error=error.stack;row.arrivals=structuredClone(active.arrivals);}
   finally{active.releaseFirst?.();await page.evaluate(()=>window.stop?.()).catch(()=>{});await context.close();report.cases.push(row);active=null;}
  }
  await browser.close();browser=null;
 }
 assert.deepEqual(await hashes(),report.source_hashes,'source changed while browser test ran');
 report.passed=report.cases.length===8&&report.cases.every(row=>row.passed);
}catch(error){report.error=error.stack;}
finally{await browser?.close();active?.releaseFirst?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,report:resolve(out,'report.json'),cases:report.cases.map(({browser,mode,passed,second_reached_before_first_headers})=>({browser,mode,passed,second_reached_before_first_headers}))}));if(!report.passed)process.exitCode=1;}
