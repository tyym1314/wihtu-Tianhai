import assert from 'node:assert/strict';
import {readNativeLobbyWalletUi} from './android-player-lobby-wallet-readiness.mjs';
import {formatPlayerMinor} from '../src/pages/PlayerClient.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stages=new Set(['before-cold-reload','after-cold-reload','before-warm-click']);
const expression='(()=>({url:location.href,timeOrigin:performance.timeOrigin,ui:('+readNativeLobbyWalletUi.toString()+')()}))()';

/** Rendered UI prerequisite only. It does not prove any exact request/body. */
export function performanceLobbyWalletUiReady(observation,{artifact,baseline}){
 assert.equal(observation?.url,artifact.entryUrl,'PERFORMANCE_LOBBY_DOCUMENT_CHANGED');
 assert.ok(Number.isFinite(observation.timeOrigin)&&observation.timeOrigin>0,'PERFORMANCE_LOBBY_DOCUMENT_CLOCK_UNPROVEN');
 const ui=observation.ui;assert.equal(ui?.url,artifact.entryUrl,'PERFORMANCE_LOBBY_UI_DOCUMENT_CHANGED');
 assert.equal(ui.iframeCount,0,'PERFORMANCE_LOBBY_GAME_ALREADY_MOUNTED');
 assert.ok(ui.regionCount===0||ui.regionCount===1,'PERFORMANCE_LOBBY_BALANCE_AMBIGUOUS');
 assert.equal(ui.alertCount,0,'PERFORMANCE_LOBBY_WALLET_ERROR');
 assert.ok(ui.statusCount===0||ui.statusCount===1,'PERFORMANCE_LOBBY_STATUS_AMBIGUOUS');
 if(!ui.lobbyVisible||!ui.visible||ui.regionCount!==1||ui.statusCount!==1||ui.statusTag!=='DIV')return false;
 const available=formatPlayerMinor(baseline.availableMinor??'0',baseline.currencyScale)+' '+baseline.currencyId,zero=formatPlayerMinor('0',baseline.currencyScale)+' '+baseline.currencyId;
 assert.deepEqual(ui.paragraphs,['可用 '+available,'冻结 '+zero],baseline.profile==='firstparty-internal-games-v1'?'PERFORMANCE_LOBBY_BALANCE_UNPROVEN':'PERFORMANCE_LOBBY_ZERO_BALANCE_UNPROVEN');
 return true;
}

/** No probe installation, body read, network request, input or cache mutation.
 * Two consecutive reads allow the lobby's pending passive effect to render;
 * neither observation is claimed as a first-ready or request-completion time. */
export async function waitForPerformanceLobbyWallet({page,cdp,artifact,baseline,stage,diagnostic={},timeoutMs=45000,now=Date.now,wait=sleep}){
 assert.ok(stages.has(stage),'PERFORMANCE_LOBBY_STAGE_REQUIRED');
 assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=45000,'PERFORMANCE_LOBBY_DEADLINE_INVALID');
 const entry=new URL(artifact.entryUrl);assert.equal(entry.protocol,'https:','PERFORMANCE_LOBBY_REAL_ENTRY_REQUIRED');assert.equal(entry.searchParams.get('app_id'),artifact.appId,'PERFORMANCE_LOBBY_APP_CHANGED');
 assert.equal(baseline.appId,artifact.appId,'PERFORMANCE_LOBBY_BASELINE_APP_CHANGED');
 assert.ok(typeof baseline.currencyId==='string'&&baseline.currencyId.length>0&&Number.isInteger(baseline.currencyScale)&&baseline.currencyScale>=0&&baseline.currencyScale<=6,'PERFORMANCE_LOBBY_BASELINE_REQUIRED');
 const end=now()+timeoutMs,frame=page.mainFrame();let owner,consecutive=0;
 Object.assign(diagnostic,{schema:'performance-lobby-ui-prerequisite-v1',stage,passed:false,startedAtMs:now(),timeoutMs,observations:[],observationsOmitted:0,requiredConsecutiveReadyReads:2,requestBodyProven:false,scope:'Untimed rendered lobby UI prerequisite; original cold/warm entry timing and strict network observations remain unchanged'});
 const bounded=async work=>{const remaining=end-now();assert.ok(remaining>0,'PERFORMANCE_LOBBY_READY_TIMEOUT');let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PERFORMANCE_LOBBY_READY_TIMEOUT')),remaining);})]);}finally{clearTimeout(timer);}};
 const assertPage=()=>{assert.equal(page.mainFrame(),frame,'PERFORMANCE_LOBBY_MAIN_FRAME_CHANGED');assert.equal(page.url(),artifact.entryUrl,'PERFORMANCE_LOBBY_PARENT_CHANGED');assert.equal(frame.url(),artifact.entryUrl,'PERFORMANCE_LOBBY_FRAME_URL_CHANGED');};
 const readFrame=async()=>{
  assertPage();const {frameTree}=await bounded(()=>cdp.send('Page.getFrameTree'));assertPage();
  const top=frameTree?.frame;assert.equal(top?.url,artifact.entryUrl,'PERFORMANCE_LOBBY_CDP_PARENT_CHANGED');assert.ok(top.id&&top.loaderId&&!top.parentId,'PERFORMANCE_LOBBY_MAIN_DOCUMENT_UNPROVEN');assert.equal((frameTree.childFrames??[]).length,0,'PERFORMANCE_LOBBY_FOREIGN_FRAME');
  return {frameId:top.id,loaderId:top.loaderId,url:top.url};
 };
 try{
  while(now()<end){
   const before=await readFrame(),observed=await bounded(()=>frame.evaluate(expression)),after=await readFrame();assert.deepEqual(after,before,'PERFORMANCE_LOBBY_DOCUMENT_CHANGED');
   const current={...before,timeOrigin:observed.timeOrigin};if(owner)assert.deepEqual(current,owner,'PERFORMANCE_LOBBY_DOCUMENT_CHANGED');else{owner=current;diagnostic.owner={...owner};}
   const ready=performanceLobbyWalletUiReady(observed,{artifact,baseline});consecutive=ready?consecutive+1:0;
   const row={observedAtMs:now(),ready,consecutiveReadyReads:consecutive,ui:observed.ui};if(diagnostic.observations.length<16)diagnostic.observations.push(row);else diagnostic.observationsOmitted++;
   assert.ok(now()<end,'PERFORMANCE_LOBBY_READY_TIMEOUT');
   if(consecutive===2){diagnostic.passed=true;diagnostic.completedAtMs=now();return diagnostic;}
   await bounded(()=>wait(Math.min(100,Math.max(1,end-now()))));
  }
  throw Error('PERFORMANCE_LOBBY_READY_TIMEOUT');
 }catch(error){diagnostic.error=error.message;diagnostic.completedAtMs=now();throw error;}
}

/** The original cold reload/cache operations remain in the caller. Every
 * prerequisite completes before its caller starts the existing entry clock. */
export async function preparePerformanceLobbyForEntry({cacheMode,waitLobby,reloadCold,diagnostic}){
 assert.ok(cacheMode==='cold'||cacheMode==='warm','PERFORMANCE_LOBBY_CACHE_MODE_REQUIRED');
 Object.assign(diagnostic,{schema:'performance-lobby-entry-prerequisites-v1',requestBodyProven:false,stages:[]});
 const ready=async stage=>{const row={stage};diagnostic.stages.push(row);await waitLobby(stage,row);};
 if(cacheMode==='cold'){await ready('before-cold-reload');await reloadCold();await ready('after-cold-reload');}
 else await ready('before-warm-click');
}
