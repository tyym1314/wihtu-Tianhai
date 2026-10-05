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

const target=new URL(process.env.OASIS_VERIFY_ORIGIN||'https://game.tianyahuyu.com');
assert.ok(!target.username&&!target.password&&!target.search&&!target.hash&&target.pathname==='/','OASIS_VERIFY_ORIGIN must be an origin');
assert.ok(target.protocol==='https:'||target.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(target.hostname),'HTTPS or loopback HTTP required');
const origin=target.origin,out=resolve(process.env.OASIS_VERIFY_OUT||fileURLToPath(new URL('../review/deployment/native-browser/',import.meta.url)));
const dnsPin=process.env.OASIS_VERIFY_DNS_IP;
if(dnsPin)assert.ok(isIP(dnsPin),'OASIS_VERIFY_DNS_IP must be an IP literal');
const viewport={width:390,height:844},terminal=new Set(['cancelled','settled','voided']);
const requested=process.env.OASIS_VERIFY_GAMES?process.env.OASIS_VERIFY_GAMES.split(','):RELEASED_IDS;
assert.ok(requested.length&&new Set(requested).size===requested.length&&requested.every(id=>RELEASED_IDS.includes(id)),'OASIS_VERIFY_GAMES must contain unique released IDs');
const secrets=new Set(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={started_at:new Date().toISOString(),origin,scope:'Desktop Chrome with a 390x844 mobile viewport. Real native-host pages, SDK launch and UI actions against independent public sandbox guests. No physical phone, APK, iOS, production wallet or frame-rate acceptance.',physical_device:false,viewport,full_catalog:requested.length===RELEASED_IDS.length,requested_games:[...requested],games:[],passed:false};
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
function safePath(url){try{const parsed=new URL(url);return clean(parsed.origin+parsed.pathname);}catch{return'[invalid-url]';}}
async function until(fn,label,timeout=45000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await fn())return;await sleep(120);}
 throw new Error('Timeout: '+label);
}
async function writeReport(){await fs.writeFile(resolve(out,'native-browser.json'),JSON.stringify(report,(_key,value)=>typeof value==='string'?clean(value):value,2)+'\n');}

function observe(page,state,result){
 const tasks=new Set();
 const resourceTypes=new Set(['script','stylesheet','image','media','font']);
 page.on('pageerror',error=>result.js_errors.push(clean(error.message)));
 page.on('console',message=>{if(message.type()==='error')result.js_errors.push(clean(message.text()));});
 page.on('request',request=>{
  const url=new URL(request.url());
  if(url.origin===origin&&url.pathname==='/api/pvp/rooms'&&request.method()==='POST'){
   try{const body=request.postDataJSON();if(body.game_id===state.game&&body.practice===true&&body.entry_minor==='0')state.practiceRequested=true;}catch{}
  }
 });
 page.on('requestfailed',request=>{
  const reason=request.failure()?.errorText||'NETWORK_ERROR';
  if(state.returning&&/ABORTED/i.test(reason))return;
  if(resourceTypes.has(request.resourceType()))result.resource_errors.push({path:safePath(request.url()),error:clean(reason)});
 });
 page.on('response',response=>{
  const work=(async()=>{
   const url=new URL(response.url()),request=response.request(),path=url.pathname;
   if(response.status()>=400&&resourceTypes.has(request.resourceType()))result.resource_errors.push({path:safePath(response.url()),status:response.status()});
   if(url.origin!==origin)return;
   if(['/api/demo/config','/api/demo/launch','/v1/launch/exchange'].includes(path)&&response.ok()){
    const body=await response.json();remember(body);
    if(path==='/v1/launch/exchange'&&body.game_id===state.game){state.token=body.access_token;state.sessionId=body.session_id;state.playerId=body.external_user_id;result.launch_exchange=true;}
   }
   if(path.startsWith('/api/pvp/rooms')&&response.ok()){
    const body=await response.json(),room=body.room||body;
    if(room.id&&room.game_id===state.game){
     if(!state.room||state.room.id!==room.id||room.version>=state.room.version)state.room=room;
     if(path==='/api/pvp/rooms'&&request.method()==='POST'&&state.practiceRequested)state.ownedRooms.add(room.id);
    }
   }
   if(path===`/api/play/${state.game}/spin`&&response.ok()){
    const body=await response.json();
    if(body.round)state.spins.push({id:body.round.id,status:body.round.settlementStatus,httpStatus:response.status()});
   }
   if(path===`/api/play/${state.game}/ack`&&response.ok()){
    const body=await response.json(),requestBody=request.postDataJSON();
    if(body.session?.pendingRound===null&&body.session?.sessionId===state.sessionId)state.acks.add(requestBody.roundId);
   }
  })().catch(error=>{
   if(!state.returning&&!/No data found|No resource with given|navigated away|Target.*closed|body.*unavailable/i.test(error.message))result.observer_errors.push(clean(error.message));
  });
  tasks.add(work);work.finally(()=>tasks.delete(work));
 });
 return async()=>{await Promise.allSettled([...tasks]);};
}

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
async function arenaAction(frame,state){
 const retryable=new Set(['BUSY','STALE_INPUT','INPUT_PENDING','RATE_LIMIT']);
 for(let attempt=0;attempt<4;attempt++){
  try{return await playOneArenaAction(frame,state.game,()=>state.room);}
  catch(error){
   if(state.game!=='run'||error.status!==409||!retryable.has(error.code)||attempt===3)throw error;
   const tick=Number(state.room?.game?.snapshotTick??-1);
   await until(async()=>Number(state.room?.game?.snapshotTick??-1)>tick
    &&await frame.locator('[data-testid="run-scene"][data-input-ready="true"]').count()>0
    &&await frame.getByTestId('run-jump').isEnabled().catch(()=>false),'runner input recovery',10000);
  }
 }
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
 state.returning=true;
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

async function cleanup(page,state){
 const result={attempted:Boolean(state.token),passed:!state.practiceRequested&&!state.spins.length,scope:'Only this isolated guest and its free practice rooms / pending demo result acknowledgements'};
 if(!state.token)return result;
 const api=async(path,body)=>{
  const response=await page.request.fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+state.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{data:body}),timeout:12000,failOnStatusCode:false});
  if(!response.ok())throw new Error(`Cleanup ${response.status()} at ${path.replace(/\/rooms\/[^/]+/,'/rooms/[private-id]')}`);
  return response.json();
 };
 try{
  if(ARENA_IDS.includes(state.game)){
   if(state.practiceRequested){
    const session=await api('/api/arena/session');
    if(session.active_room_id)state.ownedRooms.add(session.active_room_id);
   }
   result.rooms=[];
   for(const id of state.ownedRooms){
    let room=await api(`/api/pvp/rooms/${id}`);room=room.room||room;
    assert.equal(room.game_id,state.game);assert.equal(room.entry_minor,'0');assert.equal(room.practice,true);
    const released=()=>terminal.has(room.status)||room.players?.find(player=>player.external_user_id===state.playerId)?.forfeited===true;
    if(!released()){
     const intent={request_id:'browser_cleanup_'+randomUUID().replaceAll('-','')};
     try{await api(`/api/pvp/rooms/${id}/leave`,intent);}catch{
      room=await api(`/api/pvp/rooms/${id}`);room=room.room||room;
      if(!released())await api(`/api/pvp/rooms/${id}/leave`,intent);
     }
     await until(async()=>{room=await api(`/api/pvp/rooms/${id}`);room=room.room||room;return released();},'free practice participant released',15000);
    }
    result.rooms.push({status:room.status,entry_minor:'0',participant_released:released()});
   }
   result.passed=result.rooms.every(room=>room.participant_released);
  }else{
   const session=await api(`/api/play/${state.game}/session`);
   assert.equal(session.sessionId,state.sessionId,'Cleanup session identity differs');
   if(session.pendingRound){
    const acknowledged=await api(`/api/play/${state.game}/ack`,{roundId:session.pendingRound.id});
    assert.equal(acknowledged.session?.sessionId,state.sessionId);
    assert.equal(acknowledged.session?.pendingRound,null);
    result.acknowledged_pending_result=true;
   }
   result.passed=(await api(`/api/play/${state.game}/session`)).pendingRound===null;
  }
 }catch(error){result.passed=false;result.error=clean(error.message);}
 return result;
}

await fs.mkdir(out,{recursive:true});
try{
 browser=await chromium.launch({channel:'chrome',headless:true,args:[...(process.platform==='darwin'?['--use-angle=metal']:[]),...(dnsPin?[`--host-resolver-rules=MAP ${target.hostname} ${dnsPin}`]:[])]});
 report.browser={name:'desktop Chrome',version:browser.version(),dns_override:Boolean(dnsPin)};
 for(const game of requested){
  const context=await browser.newContext({viewport,isMobile:true,hasTouch:true}),page=await context.newPage();
  page.setDefaultTimeout(45000);
  const state={game,token:null,sessionId:null,playerId:null,room:null,ownedRooms:new Set(),practiceRequested:false,spins:[],acks:new Set(),returning:false};
  const result={game,launch_exchange:false,host_returned:false,js_errors:[],resource_errors:[],observer_errors:[],passed:false};
  report.games.push(result);const drain=observe(page,state,result);
  try{
   const response=await page.goto(origin+'/demo/native/'+game,{waitUntil:'domcontentloaded'});
   assert.equal(response?.status(),200,'Native host route must exist');
   assert.ok(await page.evaluate(()=>isSecureContext),'Host must be a secure context');
   await until(()=>Boolean(state.token&&state.sessionId),'SDK launch exchange');
   await until(()=>page.frames().some(frame=>frame.url()===origin+'/play/'+game),'single game frame');
   assert.equal(await page.locator('iframe').count(),1,'Exactly one selected-game frame expected');
   assert.equal(await page.locator('button[data-game]').count(),0,'Native host must not embed a web game lobby');
   const frame=page.frames().find(frame=>frame.url()===origin+'/play/'+game);
   if(ARENA_IDS.includes(game)){
    await startPractice(frame,state,result);
    const action=await arenaAction(frame,state);
    result.action={type:action.actionType,sequence_before:action.sequenceBefore,sequence_after:action.sequenceAfter,http_status:action.httpStatus};
   }else await spinOnce(frame,state,result);
   result.layout=await layout(page,frame);
   result.screenshot=game+'-390.png';await page.screenshot({path:resolve(out,result.screenshot)});
   assert.ok(result.layout.single_screen,'Active game does not fit in one mobile viewport');
   await hostReturn(page,frame,state,result);await drain();
   assert.deepEqual(result.js_errors,[],'JavaScript errors');assert.deepEqual(result.resource_errors,[],'Resource errors');assert.deepEqual(result.observer_errors,[],'Response observation errors');
   result.passed=true;
  }catch(error){
   result.error=clean(error.message);
   result.failure_screenshot=game+'-failure.png';
   await page.screenshot({path:resolve(out,result.failure_screenshot)}).catch(()=>{delete result.failure_screenshot;});
  }finally{
   result.cleanup=await cleanup(page,state);if(!result.cleanup.passed)result.passed=false;
   state.returning=true;await drain();await context.close();
   if(result.js_errors.length||result.resource_errors.length||result.observer_errors.length)result.passed=false;
   await writeReport();console.log(`${game}: ${result.passed?'passed':'failed'} (desktop mobile viewport; no phone)`);
  }
 }
 report.full_catalog=report.games.length===RELEASED_IDS.length;
 report.passed=report.games.length===requested.length&&report.games.every(result=>result.passed);
}catch(error){report.error=clean(error.message);}
finally{
 await browser?.close();report.finished_at=new Date().toISOString();await writeReport();
 if(!report.passed)process.exitCode=1;
 console.log(`Native-host browser report: ${resolve(out,'native-browser.json')}`);
}
