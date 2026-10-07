/** Real external HTTPS smoke. Fresh public-demo wallets; no action retries or result replacement. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isIP} from 'node:net';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {ARENA_IDS,LEGACY_IDS,RELEASED_IDS} from '../shared/games.mjs';
import {playOneArenaAction} from '../scripts/android-game-actions.mjs';
import {createSnapshotTransfer} from '../arena/shared/snapshot-transfer.mjs';
import {classifyReturningRoomBodyLoss,proveReturningRoomBodyLoss} from './public-smoke-observer.mjs';

const origin=new URL(process.env.OASIS_VERIFY_ORIGIN||'https://game.tianyahuyu.com').origin;
assert.equal(new URL(origin).protocol,'https:','Public verification requires HTTPS');
const runId=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8);
const out=pathToFileURL(resolve(process.env.OASIS_VERIFY_OUT||`review/deployment/public-${runId}`)+'/');
await fs.mkdir(out,{recursive:true});assert.equal((await fs.readdir(out)).length,0,'OUTPUT_ALREADY_EXISTS: keep the previous evidence and choose a fresh output directory');
const dnsPin=process.env.OASIS_VERIFY_DNS_IP;
if(dnsPin&&!isIP(dnsPin))throw new Error('OASIS_VERIFY_DNS_IP must be an IP literal');
const report={schema:'public-smoke-v3',runId,at:new Date().toISOString(),origin,scope:'External HTTPS; desktop Chrome, 390x844 touch/mobile viewport. Fresh independent public-demo test wallets. One accepted UI action per arena game and one UI spin/ACK per probability game; not physical iPhone, full gameplay or performance acceptance.',inputBoundary:'All possible controls use trusted touch taps. Shared helper still uses mouse drag for Darts and TowerLink; Match proves two-tap swap, not swipe.',games:[],errors:[],observerErrors:[],lifecycleReadBodyLosses:[],httpErrors:[],failedAssets:[],abortedAssets:[],externalAssets:[],practice:[],probability:[],cleanupErrors:[],passed:false};
if(dnsPin)report.browserDnsOverride={hostname:new URL(origin).hostname,address:dnsPin,reason:'Explicit resolver override; TLS certificate verification remains enabled. This run does not verify ordinary DNS resolution.'};
// Reserve the report name before launching a browser. Later writes update this run only.
await fs.writeFile(new URL('public-browser.json',out),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const internals=new Map(),requests=new WeakMap(),pendingObservers=new Set(),ownedRooms=new Map();
let browser,context,page,current=null,guestId=null,failed=false,closing=false,observationOrder=0;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const terminal=room=>['cancelled','settled','voided'].includes(room?.status);
const id=prefix=>prefix+'_'+randomUUID().replaceAll('-','');
const errorInfo=e=>({message:String(e.message||e).slice(0,3000),...(e.code?{code:e.code}:{}),...(e.status?{status:e.status}:{}),...(e.requestBody?{requestBody:e.requestBody}:{}),...(e.responseBody?{responseBody:e.responseBody}:{}),stack:e.stack});
const address=request=>{const u=new URL(request.url());return{origin:u.origin,path:u.pathname,type:request.resourceType()};};
const isAsset=request=>{const u=new URL(request.url());return /^https?:$/.test(u.protocol)&&(['script','stylesheet','image','font','media'].includes(request.resourceType())||/\.(?:m?js|css|webp|png|jpe?g|avif|gif|svg|ico|glb|gltf|bin|wasm|mp3|ogg|wav|mp4|woff2?|ttf|otf)$/i.test(u.pathname));};
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error('Timeout: '+label);}
async function drainObservers(){await until(()=>pendingObservers.size===0,'response observer drain',10000);}
async function flush(){await fs.writeFile(new URL('public-browser.json',out),JSON.stringify(report,null,2)+'\n');}
function rememberRoom(attempt,room,source){
 assert.equal(room.game_id,attempt.game,'Room belongs to another game');assert.equal(room.me,guestId,'Room belongs to another guest');
 const key=attempt.game+':'+room.id,old=ownedRooms.get(key);
 if(!old||Number(room.version)>=Number(old.room.version))ownedRooms.set(key,{attempt,room,source:old?.source||source});
 if(!attempt.room||attempt.room.id!==room.id||Number(room.version)>=Number(attempt.room.version))attempt.room=room;
 if(!attempt.roomIds.includes(room.id))attempt.roomIds.push(room.id);
}
function reconcileReadBodyLosses(){
 for(const loss of report.lifecycleReadBodyLosses){
  const attempt=report.games.find(value=>value.game===loss.game),internal=internals.get(attempt),owned=ownedRooms.get(loss.game+':'+loss.roomId);
  const proof=proveReturningRoomBodyLoss(loss,{attempt,ownedRoom:owned?.attempt===attempt?owned.room:null,frameDetached:internal?.gameFrame?.isDetached()===true,terminalReads:internal?.terminalReads});
  loss.reconciled=!!proof;if(proof)loss.readbackProof=proof;
 }
}
function observe(target){
 target.on('pageerror',e=>report.errors.push({game:current?.game||null,message:e.message}));
 target.on('request',request=>{try{
  const u=new URL(request.url()),attempt=current,internal=internals.get(attempt),entry={attempt,phase:attempt?.phase||'lobby'};requests.set(request,entry);
  if(isAsset(request)&&u.origin!==origin)report.externalAssets.push({...address(request),game:attempt?.game||null});
  if(u.origin!==origin||!attempt)return;
  if(u.pathname.startsWith('/api/pvp/rooms')){entry.snapshotTicket=internal.transfer.begin(u.pathname,request.method()==='GET');entry.frame=request.frame();}
  if(request.method()==='POST'&&new RegExp(`^/api/play/${attempt.game}/(spin|ack)$`).test(u.pathname)){
   const body=request.postDataJSON();entry.probability={type:u.pathname.endsWith('/spin')?'spin':'ack',phase:entry.phase,requestId:body.requestId||null,roundId:body.roundId||null,status:null};attempt.probabilityRequests.push(entry.probability);
  }
  if(request.method()==='POST'&&u.pathname==='/api/pvp/rooms'){
   const body=request.postDataJSON();entry.creation={requestId:body.request_id,game:body.game_id,practice:body.practice===true,clientRoomId:body.room_id||null,status:null,roomId:null,finished:false};attempt.creations.push(entry.creation);
  }
  if(request.method()==='POST'&&/^\/api\/pvp\/rooms\/[^/]+\/action$/.test(u.pathname)&&entry.phase!=='cleanup'){
   const body=request.postDataJSON();entry.action={path:u.pathname,requestId:body.request_id,sequence:body.seq,type:body.action?.type,status:null};attempt.actionRequests.push(entry.action);
  }
 }catch(e){report.observerErrors.push({stage:'request-observer',error:errorInfo(e)});}});
 target.on('requestfinished',request=>{const entry=requests.get(request);if(entry?.creation)entry.creation.finished=true;});
 target.on('requestfailed',request=>{
  const entry=requests.get(request);if(entry?.probability)entry.probability.transportError=request.failure()?.errorText||'REQUEST_FAILED';if(entry?.creation){entry.creation.finished=true;entry.creation.transportError=request.failure()?.errorText||'REQUEST_FAILED';}
  if(!isAsset(request))return;
  const row={...address(request),game:entry?.attempt?.game||null,phase:entry?.phase,error:request.failure()?.errorText||'REQUEST_FAILED'};
  // A cancelled transfer during a proved return/cleanup is preserved separately.
  // An aborted entry/playing request is still a failure, not silently ignored.
  if((closing||['returning','cleanup'].includes(entry?.attempt?.phase))&&/abort|cancel/i.test(row.error))report.abortedAssets.push(row);else report.failedAssets.push(row);
 });
 target.on('response',response=>{
  const request=response.request(),entry=requests.get(request),attempt=entry?.attempt,u=new URL(response.url());
  if(isAsset(request)&&response.status()>=400)report.failedAssets.push({...address(request),game:attempt?.game||null,status:response.status()});
  if(u.origin===origin&&/^\/(?:api|v1)\//.test(u.pathname)&&response.status()>=400)report.httpErrors.push({path:u.pathname,method:request.method(),status:response.status(),game:attempt?.game||null,phase:entry?.phase});
  if(entry?.creation)entry.creation.status=response.status();if(entry?.action)entry.action.status=response.status();if(entry?.probability)entry.probability.status=response.status();
  if(u.origin!==origin||!attempt||!response.ok())return;
  const task=(async()=>{
   const internal=internals.get(attempt);
   if(u.pathname==='/v1/launch/exchange'){
    const d=await response.json();assert.equal(d.game_id,attempt.game);assert.equal(d.external_user_id,guestId,'Exchange must use this fresh demo wallet');
    if(attempt.sessionId)assert.equal(d.session_id,attempt.sessionId,'Reauthorization replaced the session');
    if(internal.token!==d.access_token)internal.transfer.clear();internal.token=d.access_token;attempt.sessionId=d.session_id;attempt.guest=d.external_user_id;
   }
   if(u.pathname.startsWith('/api/pvp/rooms')){
    const body=await response.json(),raw=body.room||body;if(!raw.id)return;
    // Record every observed room, even if cache reconstruction fails afterwards.
    rememberRoom(attempt,raw,entry.creation?'create-response':'public-response');if(entry.creation)entry.creation.roomId=raw.id;
    try{const restored=internal.transfer.restore(entry.snapshotTicket||internal.transfer.begin(u.pathname,request.method()==='GET'),raw);rememberRoom(attempt,restored,'public-response');}
    catch(e){if(!['SESSION_CHANGED','SNAPSHOT_REFRESH_REQUIRED'].includes(e.code))throw e;attempt.snapshotNotes.push({code:e.code,path:u.pathname});}
   }
   if(entry.phase==='cleanup')return;
   if(u.pathname===`/api/play/${attempt.game}/spin`){const d=await response.json();attempt.spins.push({round:d.round.id,cycle:d.round.cycleId,status:d.round.settlementStatus,isFreeSpin:d.round.isFreeSpin===true,requestId:request.postDataJSON()?.requestId});}
   if(u.pathname===`/api/play/${attempt.game}/ack`){const d=await response.json();attempt.acknowledged.push({round:request.postDataJSON()?.roundId,httpStatus:response.status(),sessionId:d.session?.sessionId,pendingRound:d.session?.pendingRound?.id||null});}
  })().catch(e=>{
   const internal=internals.get(attempt),loss={game:attempt.game,path:u.pathname,method:request.method(),status:response.status(),requestPhase:entry.phase,phase:attempt.phase,gameFrameRequest:!!internal.gameFrame&&entry.frame===internal.gameFrame,returnStarted:internal.returnStarted===true,frameDetachedAtError:internal.gameFrame?.isDetached()===true,error:errorInfo(e),order:++observationOrder,reconciled:false};
   const roomId=classifyReturningRoomBodyLoss(loss),owned=roomId?ownedRooms.get(attempt.game+':'+roomId):null;
   if(roomId&&owned?.attempt===attempt)report.lifecycleReadBodyLosses.push({...loss,roomId});
   else report.observerErrors.push({game:attempt.game,path:u.pathname,method:request.method(),phase:attempt.phase,error:errorInfo(e)});
  });
  pendingObservers.add(task);task.finally(()=>pendingObservers.delete(task));
 });
}
async function api(attempt,path,body){
 const internal=internals.get(attempt);assert(internal?.token,'Missing token for owned test session');assert.equal(attempt.guest,guestId);
 // Browser-side fetch deliberately honors the optional browser DNS pin. Tokens
 // remain in memory and never enter reports, URLs, screenshots or a HAR file.
 const result=await page.evaluate(async({path,token,body})=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});return{status:response.status,body:await response.json()};}finally{clearTimeout(timer);}},{path,token:internal.token,body});
 if(result.status<200||result.status>=300)throw Object.assign(new Error(`${path}: HTTP ${result.status} ${result.body.error?.code||''}`),{status:result.status,code:result.body.error?.code});return result.body;
}
async function readRoom(attempt,roomId){const startedOrder=++observationOrder,data=await api(attempt,`/api/pvp/rooms/${roomId}`),room=data.room||data;assert.equal(room.id,roomId,'Authenticated readback returned another room');rememberRoom(attempt,room,'authenticated-readback');if(terminal(room))internals.get(attempt).terminalReads.push({startedOrder,roomId:room.id,game:room.game_id,sessionId:attempt.sessionId,me:room.me,status:room.status,practice:room.practice,entry:room.entry_minor});return room;}
async function readProbability(attempt){const state=await api(attempt,`/api/play/${attempt.game}/session`);assert.equal(state.sessionId,attempt.sessionId);return state;}
async function back(attempt,frame){
 attempt.phase='returning';internals.get(attempt).returnStarted=true;await page.locator('#back').tap();
 await until(async()=>{
  if(await page.locator('#home').isVisible()){assert(frame.isDetached(),'Host returned but game iframe remains');return true;}
  for(const button of [frame.getByRole('button',{name:'确认离开',exact:true}),frame.locator('[data-return="confirm"]')]){
   if(frame.isDetached())return false;
   try{if(await button.isVisible())await button.tap();}
   catch(error){
    // Returning can remove this iframe between the detached check and locator
    // execution. Keep that control observation; only a later visible #home plus
    // verified detach can complete the return. Transport/API errors are separate.
    if(!frame.isDetached()||!/^locator\.(?:isVisible|tap): Frame was detached(?:\n|$)/.test(String(error.message)))throw error;
    (attempt.hostReturnControlRaces??=[]).push({error:errorInfo(error),frameDetached:true,awaitingHostHome:true});
    return false;
   }
  }
  return false;
 },'host return '+attempt.game);attempt.returned=true;await drainObservers();
}
async function cleanupAttempt(attempt){
 if(attempt.cleanupComplete)return;assert(!attempt.cleanupAttempted,'Cleanup already attempted; do not retry or overwrite its failure');attempt.cleanupAttempted=true;attempt.phase='cleanup';const cleanup=attempt.cleanup??={rooms:[],probability:{acknowledged:[],freeContinuations:[],newPaidSpins:0},complete:false};
 const internal=internals.get(attempt);if(!internal?.token){assert.equal(attempt.creations.length,0,'Creation exists without a captured session token');assert.equal(attempt.probabilityRequests.length,0,'Probability mutation exists without a captured session token');attempt.cleanupComplete=cleanup.complete=true;return;}
 if(ARENA_IDS.includes(attempt.game)){
  await drainObservers();
  // Recover a room whose creation response was lost. Never resend create.
  let session=await api(attempt,'/api/arena/session');assert.equal(session.session_id,attempt.sessionId);assert.equal(session.external_user_id,guestId);
  if(session.active_room_id)await readRoom(attempt,session.active_room_id);
  for(const record of [...ownedRooms.values()].filter(r=>r.attempt===attempt)){
   let room=await readRoom(attempt,record.room.id);assert.equal(room.practice,true,'Cleanup refuses non-practice room');assert.equal(room.entry_minor,'0','Cleanup refuses any paid room');assert.equal(room.me,guestId);
   const action={roomId:room.id,before:room.status,leaveSubmitted:false};cleanup.rooms.push(action);
   if(!terminal(room)){
    action.requestId=id('public_cleanup');action.leaveSubmitted=true;
    // Exactly one leave attempt. A transport failure is preserved; no new-ID retry.
    try{await api(attempt,`/api/pvp/rooms/${room.id}/leave`,{request_id:action.requestId});}catch(e){action.error=errorInfo(e);throw e;}
    await until(async()=>{room=await readRoom(attempt,room.id);return terminal(room);},'owned practice cleanup '+room.id,15000);
   }
   action.after=room.status;action.terminal=terminal(room);
  }
  session=await api(attempt,'/api/arena/session');cleanup.activeRoomId=session.active_room_id;cleanup.otherActiveGame=session.other_active_game;
  assert.equal(session.active_room_id,null,'Own active room remains');assert.equal(session.other_active_game,null,'Another test game left an active room');
  // A lost create response may commit after a readback. Such uncertainty is a
  // cleanup failure, never green evidence that no room was created.
  cleanup.unresolvedCreations=attempt.creations.filter(c=>!c.roomId&&!(c.status>=400&&c.status<500)).map(c=>({requestId:c.requestId,status:c.status,finished:c.finished,transportError:c.transportError||null}));
  if(cleanup.unresolvedCreations.length&&attempt.roomIds.length===1&&attempt.creations.length===1){cleanup.recoveredCreationRoomId=attempt.roomIds[0];cleanup.unresolvedCreations=[];}
  assert.deepEqual(cleanup.unresolvedCreations,[],'Uncertain room creation still requires readback');
 }else{
  // The UI has been removed. ACK and continue only this already-settled paid
  // cycle's remaining presentations. Never open another paid cycle for cleanup.
  let done=false;
  for(let n=0;n<300;n++){
   const state=await readProbability(attempt);
   if(state.pendingRound){const roundId=state.pendingRound.id;await api(attempt,`/api/play/${attempt.game}/ack`,{roundId});cleanup.probability.acknowledged.push(roundId);}
   else if(state.freeSpins>0){assert(state.betChoices?.includes(state.lockedBet),'Invalid locked bonus bet');const d=await api(attempt,`/api/play/${attempt.game}/spin`,{requestId:id('public_free'),bet:state.lockedBet,expectedVersion:state.stateVersion});if(d.round.isFreeSpin!==true)cleanup.probability.newPaidSpins++;assert.equal(d.round.isFreeSpin,true,'Cleanup opened a new paid cycle');assert.equal(d.round.settlementStatus,'SETTLED');if(attempt.spins.length)assert(attempt.spins.some(spin=>spin.cycle===d.round.cycleId),'Cleanup left the owned UI cycle');cleanup.probability.freeContinuations.push({round:d.round.id,cycle:d.round.cycleId});}
   else{cleanup.probability.finalReadback={sessionId:state.sessionId,pendingRound:state.pendingRound??null,freeSpins:state.freeSpins||0};done=true;break;}
  }
  assert(done,'Probability presentation cleanup exceeded 300 steps');assert.equal(cleanup.probability.newPaidSpins,0);
  cleanup.probability.uncertainSpinRequests=attempt.probabilityRequests.filter(r=>r.type==='spin'&&r.status!==200).map(r=>({requestId:r.requestId,status:r.status,transportError:r.transportError||null}));
  assert.deepEqual(cleanup.probability.uncertainSpinRequests,[],'Spin outcome uncertain; session presentation readback alone cannot prove cycle settlement');
 }
 attempt.cleanupComplete=cleanup.complete=true;
}

try{
 browser=await chromium.launch({channel:'chrome',headless:true,args:[...(process.platform==='darwin'?['--use-angle=metal']:[]),...(dnsPin?[`--host-resolver-rules=MAP ${new URL(origin).hostname} ${dnsPin}`]:[])]});
 report.browserVersion=browser.version();context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page=await context.newPage();page.setDefaultTimeout(45000);observe(page);
 await page.goto(origin+'/demo/');await until(async()=>await page.locator('[data-game]').count()===RELEASED_IDS.length,'complete game menu');assert.equal(await page.evaluate(()=>isSecureContext),true);
 const cookie=(await context.cookies(origin)).find(c=>c.name==='__Host-oasis_demo');guestId=cookie?.value.split('.')[0];assert.match(guestId||'',/^guest_[a-f0-9]{32}$/);report.testGuest=guestId;
 await page.screenshot({path:new URL('public-lobby-390.png',out).pathname,fullPage:true});
 const firstConfig=await page.evaluate(()=>fetch('/api/demo/config').then(r=>r.json()));
 const second=await browser.newContext();try{const secondPage=await second.newPage();observe(secondPage);const secondConfig=await secondPage.goto(origin+'/api/demo/config').then(r=>r.json());assert.notEqual(firstConfig.csrf,secondConfig.csrf);assert.notEqual(firstConfig.profile.name,secondConfig.profile.name);report.distinctGuests=true;}finally{await second.close();}
 for(const game of RELEASED_IDS){
  const attempt=current={game,phase:'entry',spins:[],acknowledged:[],creations:[],roomIds:[],actionRequests:[],probabilityRequests:[],snapshotNotes:[],launched:false,returned:false,cleanupComplete:false};report.games.push(attempt);internals.set(attempt,{token:null,transfer:createSnapshotTransfer(),terminalReads:[],gameFrame:null,returnStarted:false});await flush();
  await page.locator(`[data-game="${game}"]`).tap();await page.locator('#connection').filter({hasText:'已连接'}).waitFor();
  const frame=page.frames().find(f=>f.url()===origin+'/play/'+game);assert.ok(frame);internals.get(attempt).gameFrame=frame;await until(()=>!!attempt.sessionId,'session exchange '+game);attempt.launched=true;
  if(ARENA_IDS.includes(game)){
   await frame.locator('.lobby-settings').waitFor();await frame.getByRole('button',{name:'免费练习',exact:false}).tap();await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).tap();
   await until(()=>attempt.room?.status==='active','active '+game);await frame.locator('.arena-loading').waitFor({state:'hidden'});attempt.phase='playing';
   attempt.action=await playOneArenaAction(frame,game,()=>attempt.room,{touch:true});await drainObservers();
   assert.equal(attempt.action.httpStatus,200);assert.equal(attempt.action.sequenceAfter,attempt.action.sequenceBefore+1);assert.equal(attempt.actionRequests.length,1,'Expected exactly one UI action POST; no hidden action retry');
   const readback=await readRoom(attempt,attempt.action.roomId);assert.equal(readback.me_last_seq,attempt.action.sequenceAfter,'Public GET did not retain accepted personal sequence');
   attempt.action.publicReadback={roomId:readback.id,me:readback.me,meLastSeq:readback.me_last_seq,version:readback.version,status:readback.status};attempt.acceptedAction=true;
   assert.equal(readback.practice,true);assert.equal(readback.entry_minor,'0');assert.equal(attempt.creations.length,1,'Unexpected additional room creation');
   report.practice.push({game,room:readback.id,entry:readback.entry_minor,action:attempt.action,input:['darts','towerlink'].includes(game)?'mouse drag; touch used for menu/return':'trusted touch taps'});
  }else{
   assert(LEGACY_IDS.includes(game));await frame.locator('#spin').waitFor();await until(()=>frame.locator('#spin').isEnabled(),'spin ready '+game);const initial=await readProbability(attempt);assert.equal(initial.pendingRound,null);assert.equal(initial.freeSpins,0,'Fresh probability session already has a pending cycle');
   attempt.phase='playing';if(await frame.locator('[data-action="turbo"]').count())await frame.locator('[data-action="turbo"]').tap();await frame.locator('#spin').tap();
   await until(async()=>{const close=frame.locator(game==='tiger'?'#continue':'.celebration-close');if(await close.isVisible())await close.tap();return attempt.spins.length>0&&attempt.acknowledged.some(a=>a.round===attempt.spins[0].round);},'UI spin and matching ACK '+game,120000);
   await until(()=>frame.locator('#spin').isEnabled(),'presentation complete '+game,120000);await drainObservers();assert.equal(attempt.probabilityRequests.filter(r=>r.type==='spin'&&r.phase!=='cleanup').length,1,'Expected exactly one UI spin POST; no hidden spin retry');assert.equal(attempt.spins.length,1,'Smoke must open exactly one UI paid cycle');assert.equal(attempt.spins[0].isFreeSpin,false);assert.equal(attempt.spins[0].status,'SETTLED');
   const ack=attempt.acknowledged.find(a=>a.round===attempt.spins[0].round);assert.equal(ack.httpStatus,200);assert.equal(ack.sessionId,attempt.sessionId);const state=await readProbability(attempt);assert.equal(state.pendingRound,null,'UI ACK did not clear the pending round');
   report.probability.push({game,spins:attempt.spins,acknowledged:attempt.acknowledged,uiAckReadback:{pendingRound:state.pendingRound,freeSpins:state.freeSpins},remainingBonusPresentation:'If present, completed separately through the owned-session cleanup protocol after UI return.'});
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:new URL(`public-${game}-390.png`,out).pathname,fullPage:true});await back(attempt,frame);
  if(ARENA_IDS.includes(game)){const room=await readRoom(attempt,attempt.action.roomId);assert(terminal(room),'UI return did not release its practice room');attempt.returnReadback={roomId:room.id,status:room.status};}
  await cleanupAttempt(attempt);await drainObservers();reconcileReadBodyLosses();await flush();console.log(game+' HTTPS launch/action-or-spin/ACK/return passed');current=null;
 }
 const kit=await page.evaluate(async()=>{const r=await fetch('/downloads/oasis-partner-sandbox-kit.zip');return{status:r.status,bytes:(await r.arrayBuffer()).byteLength};});assert.equal(kit.status,200);assert.ok(kit.bytes>100000);report.partnerKit=true;await drainObservers();
 assert.equal(report.games.length,RELEASED_IDS.length);assert.equal(report.practice.length,ARENA_IDS.length);assert.equal(report.probability.length,LEGACY_IDS.length);assert(report.games.every(g=>g.launched&&g.returned&&g.cleanupComplete));
 reconcileReadBodyLosses();assert(report.lifecycleReadBodyLosses.every(loss=>loss.reconciled),'Lost GET response body lacks a detached frame and subsequent authenticated terminal cleanup proof');assert.deepEqual(report.errors,[]);assert.deepEqual(report.observerErrors,[]);assert.deepEqual(report.httpErrors,[]);assert.deepEqual(report.failedAssets,[]);assert.deepEqual(report.externalAssets,[],'Unexpected external runtime assets');report.functionalChecksPassed=true;
}catch(e){failed=true;report.failure=errorInfo(e);if(current)current.failure=errorInfo(e);await page?.screenshot({path:new URL('public-failure.png',out).pathname,fullPage:true}).catch(()=>{});}
finally{
 // Stop UI producers before protocol cleanup, so an auto/free presentation or
 // in-flight gesture cannot race another cleanup mutation. Never revisit games.
 if(page&&!page.isClosed()){
  if(current)current.phase='cleanup';
  let uiStopped=false;
  try{await page.goto(origin+'/demo/',{waitUntil:'domcontentloaded',timeout:15000});assert(!page.frames().some(frame=>frame.url().startsWith(origin+'/play/')),'Game iframe still attached');uiStopped=true;await drainObservers();}catch(e){report.cleanupErrors.push({stage:'stop-game-ui',error:errorInfo(e)});}
  for(const attempt of report.games.filter(g=>!g.cleanupComplete&&!g.cleanupAttempted)){
   if(!uiStopped){report.cleanupErrors.push({game:attempt.game,stage:'owned-session-cleanup',error:{message:'Skipped mutation because stopping game UI was not confirmed'}});continue;}
   current=attempt;
   try{await cleanupAttempt(attempt);}catch(e){report.cleanupErrors.push({game:attempt.game,stage:'owned-session-cleanup',error:errorInfo(e)});}
  }
 }
 try{await drainObservers();}catch(e){report.cleanupErrors.push({stage:'observer-drain',error:errorInfo(e)});}
 report.roomInventory=[...ownedRooms.values()].map(({attempt,room,source})=>({game:attempt.game,roomId:room.id,status:room.status,practice:room.practice,entry:room.entry_minor,me:room.me,source}));
 closing=true;try{if(browser){await browser.close();report.browserClosed=true;}else report.browserClosed=false;}catch(e){report.cleanupErrors.push({stage:'browser-close',error:errorInfo(e)});}
 try{await drainObservers();}catch(e){report.cleanupErrors.push({stage:'final-observer-drain',error:errorInfo(e)});}
 reconcileReadBodyLosses();report.finishedAt=new Date().toISOString();report.passed=!failed&&report.functionalChecksPassed===true&&report.browserClosed===true&&report.games.every(g=>g.cleanupComplete)&&report.lifecycleReadBodyLosses.every(loss=>loss.reconciled)&&report.cleanupErrors.length===0&&report.errors.length===0&&report.observerErrors.length===0&&report.httpErrors.length===0&&report.failedAssets.length===0&&report.externalAssets.length===0;
 await flush();console.log(JSON.stringify({report:new URL('public-browser.json',out).pathname,passed:report.passed,games:report.games.length,cleanupErrors:report.cleanupErrors.length}));if(!report.passed)process.exitCode=1;
}
