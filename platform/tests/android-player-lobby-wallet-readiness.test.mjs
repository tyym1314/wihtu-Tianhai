import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {collectPlayerEvidence} from '../scripts/android-player-acceptance.mjs';
import {inspectNativeLobbyWallet,assertLobbyWalletBodyAndUi,readNativeLobbyWalletUi,waitForNativeLobbyWallet} from '../scripts/android-player-lobby-wallet-readiness.mjs';

const origin='https://oasis-player.43.98.202.236.sslip.io',appId='app_fixture',artifact={origin,appId,entryUrl:origin+'/player?app_id='+appId};
const walletUrl=origin+'/api/player/wallet?app_id='+appId;
const owner={frameId:'B9AD16A66E8887DD8BF961189F905BB3',loaderId:'97A2A6886842CF006C12B7FF8B4BB7F4',probeFrameId:'frame-1',documentId:'cfeb9bf676a6ac9341c9a1e70beb0199'};
const bundleUrl=origin+'/assets/index-OoMNBbVV.js',bundleSha='ee7aad3cf99ef06bc204f1b6b293f8835e458eca87f34f123be688fa77c000c1';
const body={partner_id:'partner_fixture',app_id:appId,environment:'production',wallet_scope_id:'scope_fixture',currency_id:'CNY',balance:{external_user_id:'player_fixture',available_minor:'0',reserved_minor:'0',currency_scale:2,ledger_version:'0'},as_of:'2026-10-11T18:36:25.000Z'};
const bytes=Buffer.from(JSON.stringify(body));
const ui={url:artifact.entryUrl,lobbyVisible:true,iframeCount:0,regionCount:1,visible:true,alertCount:0,statusCount:1,statusTag:'DIV',paragraphs:['可用 0.00 CNY','冻结 0.00 CNY']};
const event=(event,value)=>({event,value});

function fixture({aborted=false}={}){
 // Request ID, document/frame/loader, script source and start/failure clocks are
 // the original a5 Jackaroo facts. Success is their explicit local inverse,
 // not a replacement for the preserved actual failed report.
 const start={requestId:'9735.21',frameId:owner.frameId,loaderId:owner.loaderId,type:'Fetch',timestamp:557496.840671,wallTime:1791743785.62358,request:{url:walletUrl,method:'GET'},initiator:{type:'script',stack:{callFrames:[{functionName:'wrappedFetch',url:''},{functionName:'wallet',url:bundleUrl,lineNumber:169,columnNumber:14792}]}}};
 const raw=[event('Page.frameNavigated',{frame:{id:owner.frameId,loaderId:owner.loaderId,url:artifact.entryUrl}}),event('Network.requestWillBeSent',start)];
 const record={id:start.requestId,frame:'cdp-session-1:'+owner.frameId,frame_id:owner.probeFrameId,document_id:owner.documentId,method:'GET',type:'Fetch',redirected:false,response_seen:!aborted,response_status:aborted?undefined:200};
 if(aborted){raw.push(event('Network.loadingFailed',{requestId:start.requestId,timestamp:557497.317534,errorText:'net::ERR_ABORTED',canceled:true}));record.error='net::ERR_ABORTED';}
 else raw.push(event('Network.responseReceived',{requestId:start.requestId,frameId:owner.frameId,response:{url:walletUrl,status:200}}),event('Network.loadingFinished',{requestId:start.requestId,timestamp:557497.317534}));
 // Diagnostic evaluate GET deliberately shares URL and clocks but has no UI
 // wallet initiator. A header/late diagnostic success must never select it.
 raw.push(event('Network.requestWillBeSent',{...structuredClone(start),requestId:'diagnostic-get',initiator:{type:'script',stack:{callFrames:[{functionName:'',url:''}]}}}),event('Network.responseReceived',{requestId:'diagnostic-get',frameId:owner.frameId,response:{url:walletUrl,status:200}}),event('Network.loadingFinished',{requestId:'diagnostic-get',timestamp:557497.317534}));
 const responses=[{url:bundleUrl,frame:artifact.entryUrl,resourceType:'script',method:'GET',status:200,original_sha256:bundleSha,original_bytes:406081,pin:{path:'/assets/index-OoMNBbVV.js',sha256:bundleSha,bytes:406081,source:'Exact HTTP response body bound to release-build-manifest.outputs'}}];
 return{artifact,owner,raw,network:[record],responses};
}

test('UI source and exact protocol ID exclude concurrent diagnostic GET without clock joining',()=>{
 const f=fixture(),selected=inspectNativeLobbyWallet(f);assert.equal(selected.ready,true);assert.equal(selected.requestId,'9735.21');assert.equal(selected.source.sha256,bundleSha);
 const diagnosticOnly=structuredClone(f);diagnosticOnly.raw=diagnosticOnly.raw.filter(row=>row.value.requestId!=='9735.21');assert.equal(inspectNativeLobbyWallet(diagnosticOnly).ready,false);
});

test('original a5 UI abort remains failed even with a completed diagnostic wallet read',()=>{
 assert.throws(()=>inspectNativeLobbyWallet(fixture({aborted:true})),/LOBBY_WALLET_UI_REQUEST_FAILED/);
});

test('headers, foreign owner, unpinned source, duplicate UI IDs, redirect and non200 cannot pass',()=>{
 const pending=fixture();pending.raw=pending.raw.filter(row=>row.event!=='Network.loadingFinished'||row.value.requestId!=='9735.21');assert.equal(inspectNativeLobbyWallet(pending).ready,false);
 for(const field of ['frame_id','document_id']){const f=fixture();f.network[0][field]='foreign';assert.equal(inspectNativeLobbyWallet(f).ready,false);}
 const foreign=fixture();foreign.owner.frameId='foreign-main';assert.equal(inspectNativeLobbyWallet(foreign).ready,false);
 const unpinned=fixture();unpinned.responses[0].pin.sha256='a'.repeat(64);assert.equal(inspectNativeLobbyWallet(unpinned).ready,false);
 const duplicate=fixture();duplicate.raw.push(event('Network.requestWillBeSent',{...structuredClone(duplicate.raw[1].value),requestId:'second-ui'}));duplicate.network.push({...duplicate.network[0],id:'second-ui'});assert.throws(()=>inspectNativeLobbyWallet(duplicate),/UI_REQUEST_AMBIGUOUS/);
 const redirect=fixture();redirect.raw[1].value.redirectResponse={status:302};assert.throws(()=>inspectNativeLobbyWallet(redirect),/REDIRECTED/);
 const denied=fixture();denied.raw.find(row=>row.event==='Network.responseReceived').value.response.status=401;assert.throws(()=>inspectNativeLobbyWallet(denied),/HTTP_NOT_200/);
 const wrongApp=fixture();wrongApp.raw[1].value.request.url=origin+'/api/player/wallet?app_id=foreign';assert.throws(()=>inspectNativeLobbyWallet(wrongApp),/UI_URL_CHANGED/);
});

test('complete bytes and both actual UI zero values are required; header evidence alone is insufficient',()=>{
 assert.equal(assertLobbyWalletBodyAndUi(bytes,ui,{artifact}).ready,true);
 for(const bad of [Buffer.alloc(0),Buffer.from('{'),Buffer.from([0xff]),Buffer.from(JSON.stringify({...body,app_id:'foreign'})),Buffer.from(JSON.stringify({...body,balance:{...body.balance,available_minor:'1'}}))])assert.throws(()=>assertLobbyWalletBodyAndUi(bad,ui,{artifact}));
 for(const changed of [{statusTag:'P',paragraphs:[]},{visible:false},{paragraphs:['可用 100.00 CNY','冻结 0.00 CNY']},{paragraphs:['可用 0.00 CNY','冻结 100.00 CNY']}])assert.equal(assertLobbyWalletBodyAndUi(bytes,{...ui,...changed},{artifact}).ready,false);
 for(const changed of [{url:origin+'/play/jackaroo'},{alertCount:1},{iframeCount:1}])assert.throws(()=>assertLobbyWalletBodyAndUi(bytes,{...ui,...changed},{artifact}));
});

test('native UI reader recognizes real balance markup and refuses loading/error markup',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();const markup=content=>'<div class="player-lobby"><section aria-label="账户余额">'+content+'</section></div>';
  await page.setContent(markup('<div role="status"><p>可用 <strong>0.00 CNY</strong></p><p>冻结 0.00 CNY</p></div>'));let observed=await page.evaluate(readNativeLobbyWalletUi);assert.equal(observed.visible,true);assert.deepEqual(observed.paragraphs,ui.paragraphs);assert.equal(observed.statusTag,'DIV');
  await page.setContent(markup('<p role="status">正在读取余额…</p>'));observed=await page.evaluate(readNativeLobbyWalletUi);assert.equal(observed.statusTag,'P');assert.deepEqual(observed.paragraphs,[]);
  await page.setContent(markup('<p role="alert">余额暂不可用。</p>'));assert.equal((await page.evaluate(readNativeLobbyWalletUi)).alertCount,1);
 }finally{await browser.close();}
});

function runtime(f=fixture()){
 let clock=0,checks=0,reads=0;const frame={},observations=[];
 const page={mainFrame:()=>frame,url:()=>artifact.entryUrl,evaluate:async()=>++checks===1?{...ui,statusTag:'P',paragraphs:[]}:ui};
 const probe={errors:[],frameId:()=>owner.probeFrameId,observations:()=>observations.slice(),hasDocument:(_frame,id)=>id===owner.documentId,networkObservations:()=>f.network,flush:async()=>{observations.push({frame_id:owner.probeFrameId,document_id:owner.documentId,kind:'checkpoint'});}};
 const evidence={raw:f.raw,responses:f.responses,readCompletePlayerWalletBody:async selected=>{reads++;assert.equal(selected.requestId,'9735.21');return{...selected,bytes};}};
 const diagnostic={};return{options:{page,evidence,probe,artifact,diagnostic,now:()=>clock,wait:async ms=>{clock+=ms;},timeoutMs:500},diagnostic,reads:()=>reads};
}

test('serial gate waits for actual native UI, reads only selected body once, and retains prerequisite evidence',async()=>{
 const r=runtime();await waitForNativeLobbyWallet(r.options);assert.equal(r.reads(),1);assert.equal(r.diagnostic.passed,true);assert.equal(r.diagnostic.request.requestId,'9735.21');assert.equal(r.diagnostic.body.bytes,bytes.length);assert.match(r.diagnostic.nativeBodyCompletion,/response.json/);assert.equal(r.diagnostic.observations[0].reason,'NATIVE_WALLET_UI_PENDING');
});

test('pending transfer times out without body read; foreign body and document drift stay failed',async()=>{
 const pending=fixture();pending.raw=pending.raw.filter(row=>row.event!=='Network.loadingFinished'||row.value.requestId!=='9735.21');const r=runtime(pending);await assert.rejects(waitForNativeLobbyWallet(r.options),/READY_TIMEOUT/);assert.equal(r.reads(),0);assert.equal(r.diagnostic.passed,false);
 const foreign=runtime();foreign.options.evidence.readCompletePlayerWalletBody=async selected=>({...selected,requestId:'diagnostic-get',bytes});await assert.rejects(waitForNativeLobbyWallet(foreign.options),/BODY_ID_CHANGED/);
 const drift=runtime();drift.options.page.evaluate=async()=>{drift.options.evidence.raw.push(event('Page.frameNavigated',{frame:{id:owner.frameId,loaderId:'new-loader',url:artifact.entryUrl}}));return ui;};await assert.rejects(waitForNativeLobbyWallet(drift.options),/DOCUMENT_CHANGED/);assert.equal(drift.diagnostic.passed,false);
});

test('collector exact body interface rejects incomplete/foreign/destroyed sources and does not send a GET',async()=>{
 const out=await mkdtemp(join(tmpdir(),'oasis-lobby-wallet-test-'));class CDP extends EventEmitter{calls=[];async send(method,args){this.calls.push({method,args});return method==='Network.getResponseBody'?{body:bytes.toString(),base64Encoded:false}:{};}async detach(){}}
 const cdp=new CDP(),page=new EventEmitter();page.url=()=>artifact.entryUrl;const evidence=await collectPlayerEvidence({context:{newCDPSession:async()=>cdp},page,origin,manifest:{expected:new Map()},out,redactor:{remember(){},add(){},sanitize:value=>value},result:{}});
 try{
  cdp.emit('Runtime.executionContextCreated',{context:{id:11,auxData:{isDefault:true,frameId:owner.frameId}}});cdp.emit('Network.requestWillBeSent',fixture().raw[1].value);cdp.emit('Network.responseReceived',{requestId:'9735.21',response:{status:200,fromServiceWorker:false}});
  const request={requestId:'9735.21',url:walletUrl,frameId:owner.frameId,timeoutMs:1000};await assert.rejects(evidence.readCompletePlayerWalletBody(request),/SOURCE_UNPROVEN/);
  cdp.emit('Network.loadingFinished',{requestId:'9735.21',timestamp:557497.317534});assert.deepEqual((await evidence.readCompletePlayerWalletBody(request)).bytes,bytes);
  await assert.rejects(evidence.readCompletePlayerWalletBody({...request,requestId:'diagnostic-get'}),/SOURCE_UNPROVEN/);await assert.rejects(evidence.readCompletePlayerWalletBody({...request,frameId:'foreign'}),/SOURCE_UNPROVEN/);
  cdp.emit('Runtime.executionContextDestroyed',{executionContextId:11});await assert.rejects(evidence.readCompletePlayerWalletBody(request),/SOURCE_UNPROVEN/);
  assert.equal(cdp.calls.filter(row=>row.method==='Network.getResponseBody').length,1);assert.ok(!cdp.calls.some(row=>/fetch|navigate|Input/.test(row.method)));
 }finally{await evidence.close();await rm(out,{recursive:true,force:true});}
});
