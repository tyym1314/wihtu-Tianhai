/**
 * Desktop Chrome, mobile viewport, real public native-host/SDK integration.
 * This is NOT Android/iOS/APK acceptance and never reads or controls a device.
 * Usage: OASIS_VERIFY_ORIGIN=https://game.tianyahuyu.com
 *        OASIS_VERIFY_OUT=/absolute/report-directory node deploy/verify-native-browser.mjs
 * Each game gets a fresh guest context. Only zero-entry practice rooms and the
 * public demo's nonredeemable test coins are used. Tokens stay in memory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {chromium} from 'playwright';
import {RELEASED_IDS,ARENA_IDS} from '../shared/games.mjs';
import {playOneArenaAction} from '../scripts/android-game-actions.mjs';
import {observeNativeBrowser,installNativeFetchProbe,cleanupNativeSession,createNativeCleanupApi,runNativeActionOnce,nativeErrorsEmpty,reserveNativeReportDirectory} from './native-browser-checks.mjs';

const target=new URL(process.env.OASIS_VERIFY_ORIGIN||'https://game.tianyahuyu.com');
assert.ok(!process.env.NODE_TLS_REJECT_UNAUTHORIZED||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='1','STRICT_TLS_REQUIRED');
assert.ok(!target.username&&!target.password&&!target.search&&!target.hash&&target.pathname==='/','OASIS_VERIFY_ORIGIN must be an origin');
assert.ok(target.protocol==='https:'||target.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(target.hostname),'HTTPS or loopback HTTP required');
const runId=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8);
const origin=target.origin,out=resolve(process.env.OASIS_VERIFY_OUT||fileURLToPath(new URL(`../review/deployment/native-browser-${runId}/`,import.meta.url)));
const dnsPin=process.env.OASIS_VERIFY_DNS_IP;
if(dnsPin)assert.ok(isIP(dnsPin),'OASIS_VERIFY_DNS_IP must be an IP literal');
const viewport={width:390,height:844};
const requested=process.env.OASIS_VERIFY_GAMES?process.env.OASIS_VERIFY_GAMES.split(','):RELEASED_IDS;
assert.ok(requested.length&&new Set(requested).size===requested.length&&requested.every(id=>RELEASED_IDS.includes(id)),'OASIS_VERIFY_GAMES must contain unique released IDs');
const secrets=new Set(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={schema:'native-browser-v4',run_id:runId,started_at:new Date().toISOString(),origin,scope:'Desktop Chrome with a 390x844 mobile viewport. Real native-host pages, SDK launch and one UI action or paid-cycle spin against independent public sandbox guests. Original-session cleanup may present existing free continuations; it never opens another paid cycle. No physical phone, APK, iOS, production wallet or frame-rate acceptance.',observer_policy:'Original transport and fetch observations are retained. Event-driven proof-only attempts may preserve a complete unique CDP/document anchor before later requests; incomplete attempts never grant an exemption. The final drain still revalidates the complete evidence, including late competitors and clock conflicts. Only uniquely matched, owned-room GET fetch rejections before response headers, caused by the actual first OASIS_ROOM_POLL_STOPPED/BACKGROUND AbortError, are classified separately as lifecycle_cancellations. Missing or ambiguous proof, timeouts, mutations, body loss and every other observer/API/transport error fail; no automatic reconciliation or action retry.',physical_device:false,viewport,full_catalog:requested.length===RELEASED_IDS.length,requested_games:[...requested],games:[],passed:false};
let browser;

function clean(value){
 let text=String(value??'');
 for(const secret of secrets)if(secret.length>5)text=text.replaceAll(secret,'[redacted]');
 return text.replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [redacted]')
  .replace(/https?:\/\/[^\s"'<>]+/g,url=>{try{const parsed=new URL(url);return parsed.origin+parsed.pathname;}catch{return'[url]';}})
  .replace(/(?:ses|guest|pvp|round|cycle)_[A-Za-z0-9_-]+/g,'[private-id]').slice(0,700);
}
function remember(body){
 if(!body||typeof body!=='object')return;
 for(const [key,value] of Object.entries(body)){
  if(typeof value==='string'&&/(?:token|secret|cookie|csrf|launch_code|session_id|external_user_id)/i.test(key))secrets.add(value);
 }
}
async function until(fn,label,timeout=45000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await fn())return;await sleep(120);}
 throw new Error('Timeout: '+label);
}
async function writeReport(){await fs.writeFile(resolve(out,'native-browser.json'),JSON.stringify(report,(_key,value)=>typeof value==='string'?clean(value):value,2)+'\n');}

async function startPractice(frame,state,result){
 await frame.locator('.lobby-settings').waitFor();
 await frame.getByRole('button',{name:'免费练习',exact:false}).click();
 await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();
 await until(()=>state.room?.status==='active','active free practice');
 assert.equal(state.room.entry_minor,'0','Only free practice may run');
 assert.equal(state.room.practice,true,'Room must be practice');
 assert.ok(state.ownedRooms.has(state.room.id),'Room must have been created by this test');
 await frame.locator('.arena-loading').waitFor({state:'hidden'});
 result.practice={entry_minor:'0',active:true};
}
async function spinOnce(frame,state,result){
 const spin=frame.locator('#spin');await spin.waitFor();
 await until(()=>spin.isEnabled(),'spin enabled');
 const turbo=frame.locator('[data-action="turbo"]');if(await turbo.count())await turbo.click();
 await spin.click();
 await until(async()=>{
  const close=frame.locator(state.game==='tiger'?'#continue':'.celebration-close');
  if(await close.isVisible().catch(()=>false))await close.click();
  return state.spins.length>0&&state.spins.every(round=>state.acks.has(round.id));
 },'spin settles and matching ACK clears pending result',120000);
 assert.ok(state.spins.every(round=>round.status==='SETTLED'),'Every observed spin must be settled');
 assert.equal(state.spins.filter(round=>!round.isFreeSpin).length,1,'UI must open exactly one paid demo cycle');
 assert.equal(new Set(state.spins.map(round=>round.cycleId)).size,1,'UI spins left the original cycle');
 result.probability={settled_rounds:state.spins.length,matching_acknowledgements:state.spins.filter(round=>state.acks.has(round.id)).length,all_settled:true};
}
async function layout(page,frame){
 const measure=()=>({width:innerWidth,height:innerHeight,scroll_width:document.documentElement.scrollWidth,scroll_height:document.documentElement.scrollHeight,body_height:document.body.scrollHeight});
 const host=await page.evaluate(measure),game=await frame.evaluate(measure),iframe=await frame.frameElement(),box=await iframe.boundingBox();
 const single_screen=Boolean(box&&Math.abs(box.x)<=1&&Math.abs(box.y)<=1&&Math.abs(box.width-host.width)<=1&&Math.abs(box.height-host.height)<=1
  &&game.width===host.width&&game.height===host.height&&host.scroll_width<=host.width+1&&host.scroll_height<=host.height+1
  &&game.scroll_width<=game.width+1&&game.scroll_height<=game.height+1&&game.body_height<=game.height+1);
 return{host,game,iframe_bounds:box,single_screen};
}
async function hostReturn(page,frame,state,result){
 state.returning=true;state.phase='returning';
 // Same narrow host entry point called by the APK's back handler. This call
 // does not simulate an Android back key or certify native lifecycle handling.
 const handled=await page.evaluate(()=>window.OasisNativeHost?.requestBack());
 assert.equal(handled,true,'Native host must accept a back request');
 await until(async()=>{
  if(page.url()===origin+'/demo/native-return')return true;
  if(!frame.isDetached())for(const button of [frame.getByRole('button',{name:'确认离开',exact:true}),frame.locator('[data-return="confirm"]')]){
   if(await button.isVisible().catch(()=>false))await button.click();
  }
  return page.url()===origin+'/demo/native-return';
 },'SDK return to the exact native return URL');
 result.host_returned=true;
}

await reserveNativeReportDirectory(out,report);
try{
 // Chrome also inherits the OS proxy; clearing shell proxy variables is insufficient.
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server',...(process.platform==='darwin'?['--use-angle=metal']:[]),...(dnsPin?[`--host-resolver-rules=MAP ${target.hostname} ${dnsPin}`]:[])]});
 report.browser={name:'desktop Chrome',version:browser.version(),dns_override:Boolean(dnsPin),requested_proxy_bypass:'--no-proxy-server',proxy_claim:'Browser proxy bypass requested; this flag alone does not verify the actual peer or exclude OS/VPN intermediaries.'};
 for(const game of requested){
  const context=await browser.newContext({viewport,isMobile:true,hasTouch:true,ignoreHTTPSErrors:false}),fetchProbe=await installNativeFetchProbe(context,{clean}),page=await context.newPage();
  await fetchProbe.attach(page);
  page.setDefaultTimeout(45000);
  const state={game,token:null,sessionId:null,playerId:null,room:null,ownedRooms:new Set(),practiceRequested:false,spins:[],acks:new Set(),returning:false,phase:'entry'};
  const result={game,launch_exchange:false,host_returned:false,passed:false};
  report.games.push(result);const drain=observeNativeBrowser(page,{origin,state,result,clean,remember,fetchProbe});
  try{
   const response=await page.goto(origin+'/demo/native/'+game,{waitUntil:'domcontentloaded'});
   assert.equal(response?.status(),200,'Native host route must exist');
   assert.ok(await page.evaluate(()=>isSecureContext),'Host must be a secure context');
   await until(()=>Boolean(state.token&&state.sessionId),'SDK launch exchange');
   await until(()=>page.frames().some(frame=>frame.url()===origin+'/play/'+game),'single game frame');
   assert.equal(await page.locator('iframe').count(),1,'Exactly one selected-game frame expected');
   assert.equal(await page.locator('button[data-game]').count(),0,'Native host must not embed a web game lobby');
   const frame=page.frames().find(frame=>frame.url()===origin+'/play/'+game);
   result.fetch_probe_installation=await fetchProbe.requireInstalled(frame);
   if(ARENA_IDS.includes(game)){
    await startPractice(frame,state,result);
    state.phase='playing';
    const action=await runNativeActionOnce(()=>playOneArenaAction(frame,state.game,()=>state.room),result,clean);
    await drain({final:false});
    if(['run-practice-inputs-v1','run-practice-inputs-v2'].includes(action.protocol)){
     assert.equal(state.actionRequests.length,0,'Negotiated practice must not submit legacy actions');
     assert.equal(state.inputsRequests.length,1,'Expected exactly one UI input batch; no hidden retry');
     const observed=state.inputsRequests[0];assert.equal(observed.status,action.httpStatus);assert.equal(observed.validated,true,'Exact POST receipt was not validated');
     assert.deepEqual(observed.proof,action.inputEvidence,'UI response and independently observed input receipt differ');
    }else{assert.equal(state.actionRequests.length,1,'Expected exactly one UI action request; no hidden retry');assert.equal(state.inputsRequests.length,0,'Unexpected input-protocol mutation');}
    result.action={type:action.actionType,sequence_before:action.sequenceBefore,sequence_after:action.sequenceAfter,http_status:action.httpStatus,
     ...(action.inputEvidence?{protocol:action.protocol,input_evidence:action.inputEvidence}:{})};
   }else{state.phase='playing';await spinOnce(frame,state,result);}
   result.layout=await layout(page,frame);
   result.screenshot=game+'-390.png';await page.screenshot({path:resolve(out,result.screenshot)});
   assert.ok(result.layout.single_screen,'Active game does not fit in one mobile viewport');
   await hostReturn(page,frame,state,result);await drain({final:false});
   if(result.action?.input_evidence){assert.equal(state.inputsRequests.length,1,'Unexpected later input retry');assert.equal(state.actionRequests.length,0,'Unexpected later legacy action');}
   // Transport attribution may still be pending; only the final closed-page
   // drain below can determine the overall observer verdict.
   result.passed=true;
  }catch(error){
   result.error=clean(error.message);
   result.failure_screenshot=game+'-failure.png';
   await page.screenshot({path:resolve(out,result.failure_screenshot)}).catch(()=>{delete result.failure_screenshot;});
  }finally{
   state.returning=true;state.phase='cleanup';
   // Remove the game UI before API cleanup, including failed action attempts.
   // This prevents an autoplay or late gesture from racing a free continuation.
   let uiStopped=false;
   try{
    const hasGameFrame=()=>page.frames().some(frame=>frame.url().startsWith(origin+'/play/'));
    if(hasGameFrame())await page.goto(origin+'/demo/native-return',{waitUntil:'domcontentloaded',timeout:15000});
    assert.equal(hasGameFrame(),false,'Game UI remains attached');uiStopped=true;
   }catch(error){result.cleanup={attempted:false,passed:false,error:clean('Could not stop game UI: '+error.message)};}
   try{await drain({final:false});}catch(error){result.observer_errors.push({stage:'pre-cleanup-drain',message:clean(error.message)});}
   if(uiStopped)result.cleanup=await cleanupNativeSession({state,arenaGames:ARENA_IDS,api:createNativeCleanupApi({page,origin,state,result,clean}),until,newId:()=> 'browser_cleanup_'+randomUUID().replaceAll('-',''),clean});
   try{await context.close();}catch(error){result.observer_errors.push({stage:'context-close',message:clean(error.message)});}
   try{await drain({final:true});}catch(error){result.observer_errors.push({stage:'final-drain',message:clean(error.message)});}
   if(!result.cleanup?.passed||!nativeErrorsEmpty(result)){result.passed=false;result.error??='Observed JavaScript/resource/API/transport/response or cleanup errors; see retained evidence';}
   await writeReport();console.log(`${game}: ${result.passed?'passed':'failed'} (desktop mobile viewport; no phone)`);
  }
 }
 report.full_catalog=report.games.length===RELEASED_IDS.length;
 report.passed=report.games.length===requested.length&&report.games.every(result=>result.passed);
}catch(error){report.error=clean(error.message);}
finally{
 try{await browser?.close();report.browser_closed=Boolean(browser);}catch(error){report.passed=false;report.error=clean('Browser close failed: '+error.message);}
 report.finished_at=new Date().toISOString();await writeReport();
 if(!report.passed)process.exitCode=1;
 console.log(`Native-host browser report: ${resolve(out,'native-browser.json')}`);
}
