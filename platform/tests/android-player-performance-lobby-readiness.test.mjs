import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readNativeLobbyWalletUi} from '../scripts/android-player-lobby-wallet-readiness.mjs';
import {performanceLobbyWalletUiReady,waitForPerformanceLobbyWallet,preparePerformanceLobbyForEntry} from '../scripts/android-player-performance-lobby-readiness.mjs';

const artifact={appId:'actual_app',entryUrl:'https://perf-lobby-fixture.invalid/player?app_id=actual_app'},baseline={appId:artifact.appId,currencyId:'CNY',currencyScale:2};
const balance='<div role="status"><p>可用 <strong>0.00 CNY</strong></p><p>冻结 0.00 CNY</p></div>',loading='<p role="status">正在读取余额…</p>';
const markup=content=>'<div class="player-lobby"><section aria-label="账户余额">'+content+'</section></div>';
const ui={url:artifact.entryUrl,lobbyVisible:true,iframeCount:0,regionCount:1,visible:true,alertCount:0,statusCount:1,statusTag:'DIV',paragraphs:['可用 0.00 CNY','冻结 0.00 CNY']};

async function browserFixture(fn){
 const browser=await chromium.launch({headless:true});try{
  const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:markup(balance)}));
  const page=await context.newPage();await page.goto(artifact.entryUrl);const cdp=await context.newCDPSession(page);
  await fn({page,cdp});
 }finally{await browser.close();}
}

test('real Chromium balance DIV and exact baseline zeros are required; loading/null/error/nonzero are rejected',async()=>{
 await browserFixture(async({page})=>{
  const read=async()=>({url:page.url(),timeOrigin:await page.evaluate(()=>performance.timeOrigin),ui:await page.evaluate(readNativeLobbyWalletUi)});
  assert.equal(performanceLobbyWalletUiReady(await read(),{artifact,baseline}),true);
  for(const content of [loading,'']){await page.setContent(markup(content));assert.equal(performanceLobbyWalletUiReady(await read(),{artifact,baseline}),false);}
  await page.setContent(markup('<p role="alert">余额暂不可用。</p>'));let observed=await read();assert.throws(()=>performanceLobbyWalletUiReady(observed,{artifact,baseline}),/WALLET_ERROR/);
  for(const content of [balance.replace('可用 <strong>0.00','可用 <strong>1.00'),balance.replace('冻结 0.00','冻结 1.00'),balance.replaceAll('CNY','USD')]){await page.setContent(markup(content));observed=await read();assert.throws(()=>performanceLobbyWalletUiReady(observed,{artifact,baseline}),/ZERO_BALANCE_UNPROVEN/);}
  await page.setContent(markup(balance)+markup(balance));observed=await read();assert.throws(()=>performanceLobbyWalletUiReady(observed,{artifact,baseline}),/BALANCE_AMBIGUOUS/);
  await page.setContent(markup(balance)+'<iframe src="about:blank"></iframe>');observed=await read();assert.throws(()=>performanceLobbyWalletUiReady(observed,{artifact,baseline}),/GAME_ALREADY_MOUNTED/);
 });
});

test('real same-document Chromium waiting observes pending UI before two ready reads without installing a probe',async()=>{
 await browserFixture(async({page,cdp})=>{
  await page.evaluate(content=>{document.querySelector('section').innerHTML=content;setTimeout(()=>{document.querySelector('section').innerHTML='<div role="status"><p>可用 <strong>0.00 CNY</strong></p><p>冻结 0.00 CNY</p></div>';},150);},loading);
  const diagnostic={};await waitForPerformanceLobbyWallet({page,cdp,artifact,baseline,stage:'after-cold-reload',diagnostic,timeoutMs:2000});
  assert.equal(diagnostic.passed,true);assert.equal(diagnostic.requestBodyProven,false);assert.ok(diagnostic.observations.some(row=>!row.ready));assert.equal(diagnostic.observations.at(-1).consecutiveReadyReads,2);
  assert.equal(diagnostic.owner.timeOrigin,await page.evaluate(()=>performance.timeOrigin));assert.equal(await page.evaluate(()=>globalThis.__oasisPhysicalPerf===undefined),true);
 });
});

function runtime({read=async()=>({url:artifact.entryUrl,timeOrigin:1000,ui}),tree=()=>({frame:{id:'main',loaderId:'current-document',url:artifact.entryUrl}}),wait=async()=>{}}={}){
 const frame={url:()=>artifact.entryUrl,evaluate:read},page={mainFrame:()=>frame,url:()=>artifact.entryUrl},cdp={send:async method=>{assert.equal(method,'Page.getFrameTree');return{frameTree:tree()};}};
 return{page,cdp,artifact,baseline,stage:'before-warm-click',diagnostic:{},timeoutMs:2000,wait};
}

test('return commit showing old zeros cannot pass when its pending effect renders between consecutive reads',async()=>{
 let reads=0;const r=runtime({read:async()=>({url:artifact.entryUrl,timeOrigin:1000,ui:++reads===2?{...ui,statusTag:'P',paragraphs:[]}:ui})});
 await waitForPerformanceLobbyWallet(r);assert.deepEqual(r.diagnostic.observations.map(row=>row.consecutiveReadyReads),[1,0,1,2]);assert.equal(reads,4);
});

test('frame, loader, main-frame object, URL and document clock changes fail rather than follow a new document',async()=>{
 for(const kind of ['loader','frame','clock','url','main-object','child']){
  let trees=0,reads=0;const r=runtime({tree:()=>{trees++;return{frame:{id:kind==='frame'&&trees>1?'foreign':'main',loaderId:kind==='loader'&&trees>1?'new-loader':'current-document',url:artifact.entryUrl},...(kind==='child'?{childFrames:[{frame:{id:'foreign',url:'about:blank'}}]}:{})};},read:async()=>({url:kind==='url'?'https://foreign.invalid/':artifact.entryUrl,timeOrigin:kind==='clock'&&++reads>1?2000:1000,ui})});
  if(kind==='main-object'){let calls=0;r.page.mainFrame=()=>++calls>1?{}:r.page.savedFrame;r.page.savedFrame={url:()=>artifact.entryUrl,evaluate:async()=>({url:artifact.entryUrl,timeOrigin:1000,ui})};}
  await assert.rejects(waitForPerformanceLobbyWallet(r),/PERFORMANCE_LOBBY_.*(CHANGED|FOREIGN_FRAME)/);assert.equal(r.diagnostic.passed,false);
 }
});

test('actual remaining deadline bounds hung CDP/evaluate/wait and continuously loading UI',async()=>{
 for(const stage of ['cdp','evaluate','wait','loading']){
  const never=()=>new Promise(()=>{}),r=runtime({read:stage==='evaluate'?never:async()=>({url:artifact.entryUrl,timeOrigin:1000,ui:{...ui,statusTag:'P',paragraphs:[]}}),wait:stage==='wait'?never:ms=>new Promise(resolve=>setTimeout(resolve,ms))});r.timeoutMs=30;if(stage==='cdp')r.cdp.send=never;
  const start=Date.now();await assert.rejects(waitForPerformanceLobbyWallet(r),/READY_TIMEOUT/);assert.equal(r.diagnostic.passed,false);assert.ok(Date.now()-start<1000,'deadline must bound the pending operation');
 }
});

test('cold prerequisites finish old wallet before reload and new wallet before entry; warm waits before click',async()=>{
 const calls=[];let oldComplete=false,newComplete=false,aborts=0,document=0;
 const waitLobby=async(stage,diagnostic)=>{
  const complete=()=>document===0?oldComplete:newComplete;
  setTimeout(()=>{if(document===0)oldComplete=true;else newComplete=true;calls.push(stage+':native-ui-complete');},10);
  const r=runtime({read:async()=>({url:artifact.entryUrl,timeOrigin:1000+document,ui:complete()?ui:{...ui,statusTag:'P',paragraphs:[]}}),tree:()=>({frame:{id:'main',loaderId:'doc-'+document,url:artifact.entryUrl}}),wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
  await waitForPerformanceLobbyWallet({...r,stage,diagnostic});calls.push(stage+':passed');
 };
 const diagnostic={};await preparePerformanceLobbyForEntry({cacheMode:'cold',diagnostic,waitLobby,reloadCold:async()=>{if(!oldComplete)aborts++;calls.push('clear-cache-and-reload');document++;}});calls.push('second-cache-clear/start/tap');
 assert.equal(aborts,0);assert.equal(newComplete,true);assert.deepEqual(diagnostic.stages.map(row=>row.stage),['before-cold-reload','after-cold-reload']);assert.equal(diagnostic.requestBodyProven,false);
 assert.deepEqual(calls,['before-cold-reload:native-ui-complete','before-cold-reload:passed','clear-cache-and-reload','after-cold-reload:native-ui-complete','after-cold-reload:passed','second-cache-clear/start/tap']);
 const warm={};await preparePerformanceLobbyForEntry({cacheMode:'warm',diagnostic:warm,waitLobby:async(stage,row)=>{calls.push(stage);row.passed=true;},reloadCold:()=>assert.fail('warm must retain cache')});calls.push('warm-start/tap');assert.deepEqual(calls.slice(-2),['before-warm-click','warm-start/tap']);assert.equal(warm.stages.length,1);
});

test('failed prerequisite never reloads or starts a later stage and preserves the original failure',async()=>{
 const diagnostic={},failure=Error('original failure');let reloads=0;
 await assert.rejects(preparePerformanceLobbyForEntry({cacheMode:'cold',diagnostic,waitLobby:async()=>{throw failure;},reloadCold:async()=>reloads++}),error=>error===failure);
 assert.equal(reloads,0);assert.equal(diagnostic.stages.length,1);
});
