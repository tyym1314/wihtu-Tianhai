import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertPlayerWallet} from './android-player-acceptance-checks.mjs';
import {formatPlayerMinor} from '../src/pages/PlayerClient.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const events=(raw,event,id)=>raw.filter(row=>row.event===event&&row.value.requestId===id).map(row=>row.value);

/** Exact protocol identity and the release-pinned UI wallet initiator distinguish
 * this read from diagnostic evaluate() GETs. No nearest clock/body association. */
export function inspectNativeLobbyWallet({artifact,owner,raw,network,responses}){
 const url=artifact.origin+'/api/player/wallet?app_id='+encodeURIComponent(artifact.appId);
 const starts=raw.filter(row=>row.event==='Network.requestWillBeSent').map(row=>row.value);
 const candidates=[];
 for(const start of starts){
  if(start.frameId!==owner.frameId||start.loaderId!==owner.loaderId||start.type!=='Fetch')continue;
  const parsed=new URL(start.request.url);if(parsed.pathname!=='/api/player/wallet')continue;
  const calls=start.initiator?.stack?.callFrames?.filter(call=>call.functionName==='wallet')||[];
  if(!calls.length)continue;
  assert.equal(start.request.method,'GET','LOBBY_WALLET_UI_METHOD_CHANGED');
  assert.equal(start.request.url,url,'LOBBY_WALLET_UI_URL_CHANGED');
  const sources=responses.filter(row=>calls.some(call=>call.url===row.url)&&row.frame===artifact.entryUrl&&row.resourceType==='script'&&row.method==='GET'&&row.status===200&&row.pin?.source==='Exact HTTP response body bound to release-build-manifest.outputs'&&new URL(row.url).origin===artifact.origin&&row.pin.sha256===row.original_sha256&&row.pin.bytes===row.original_bytes&&row.original_bytes>0&&!row.body_error);
  if(!sources.length)return{ready:false,reason:'UI_SCRIPT_BODY_PENDING'};
  assert.equal(sources.length,1,'LOBBY_WALLET_UI_SCRIPT_AMBIGUOUS');
  const mapped=network.filter(row=>row.id===start.requestId&&row.frame_id===owner.probeFrameId&&row.document_id===owner.documentId&&row.frame.endsWith(':'+owner.frameId));
  if(!mapped.length)return{ready:false,reason:'UI_DOCUMENT_BINDING_PENDING'};
  assert.equal(mapped.length,1,'LOBBY_WALLET_DOCUMENT_AMBIGUOUS');
  candidates.push({start,source:sources[0],mapped:mapped[0]});
 }
 if(!candidates.length)return{ready:false,reason:'UI_WALLET_REQUEST_PENDING'};
 assert.equal(candidates.length,1,'LOBBY_WALLET_UI_REQUEST_AMBIGUOUS');
 const {start,source,mapped}=candidates[0],id=start.requestId;
 assert.equal(starts.filter(row=>row.requestId===id).length,1,'LOBBY_WALLET_REDIRECTED');
 assert.ok(!start.redirectResponse&&!mapped.redirected,'LOBBY_WALLET_REDIRECTED');
 assert.ok(!mapped.error&&!events(raw,'Network.loadingFailed',id).length,'LOBBY_WALLET_UI_REQUEST_FAILED');
 const received=events(raw,'Network.responseReceived',id),finished=events(raw,'Network.loadingFinished',id);
 if(!received.length||!finished.length)return{ready:false,reason:'UI_WALLET_TRANSFER_PENDING',requestId:id};
 assert.equal(received.length,1,'LOBBY_WALLET_RESPONSE_AMBIGUOUS');assert.equal(finished.length,1,'LOBBY_WALLET_FINISH_AMBIGUOUS');
 assert.equal(received[0].response.status,200,'LOBBY_WALLET_HTTP_NOT_200');
 assert.equal(mapped.response_status,200,'LOBBY_WALLET_HTTP_NOT_200');
 assert.equal(received[0].response.url,url,'LOBBY_WALLET_RESPONSE_URL_CHANGED');
 assert.equal(received[0].frameId,owner.frameId,'LOBBY_WALLET_RESPONSE_FRAME_CHANGED');
 assert.ok(mapped.response_seen===true&&Number.isFinite(finished[0].timestamp)&&finished[0].timestamp>=start.timestamp,'LOBBY_WALLET_TRANSFER_UNPROVEN');
 return{ready:true,requestId:id,url,frameId:owner.frameId,source:{url:source.url,sha256:source.pin.sha256},finishedMonotonic:finished[0].timestamp};
}

/** Read actual UI after native response.json -> validation -> setWallet. Fetch
 * fulfilled alone only proves headers. This function does not alter the page. */
export function readNativeLobbyWalletUi(){
 const visible=node=>{if(!node)return false;const style=getComputedStyle(node),r=node.getBoundingClientRect();return style.visibility==='visible'&&style.display!=='none'&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
 const regions=[...document.querySelectorAll('section[aria-label="账户余额"]')],region=regions[0],statuses=region?[...region.querySelectorAll('[role="status"]')]:[];
 return{url:location.href,lobbyVisible:visible(document.querySelector('.player-lobby')),iframeCount:document.querySelectorAll('iframe').length,regionCount:regions.length,visible:visible(region),alertCount:region?.querySelectorAll('[role="alert"]').length||0,statusCount:statuses.length,statusTag:statuses[0]?.tagName,paragraphs:statuses[0]?[...statuses[0].querySelectorAll('p')].map(p=>p.innerText.trim().replace(/\s+/g,' ')):[]};
}

export function assertLobbyWalletBodyAndUi(bytes,ui,{artifact,baseline}){
 assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0,'LOBBY_WALLET_BODY_MISSING');
 const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));assertPlayerWallet(body,artifact.appId,baseline);
 assert.equal(ui.url,artifact.entryUrl,'LOBBY_WALLET_UI_DOCUMENT_CHANGED');assert.equal(ui.iframeCount,0,'LOBBY_WALLET_GAME_ALREADY_MOUNTED');
 assert.equal(ui.regionCount,1,'LOBBY_WALLET_UI_AMBIGUOUS');assert.equal(ui.alertCount,0,'LOBBY_WALLET_UI_ERROR');
 const available=formatPlayerMinor(body.balance.available_minor,body.balance.currency_scale)+' '+body.currency_id,reserved=formatPlayerMinor(body.balance.reserved_minor,body.balance.currency_scale)+' '+body.currency_id;
 return{ready:ui.lobbyVisible===true&&ui.visible===true&&ui.statusCount===1&&ui.statusTag==='DIV'&&ui.paragraphs.length===2&&ui.paragraphs[0]==='可用 '+available&&ui.paragraphs[1]==='冻结 '+reserved,bytes:bytes.length,sha256:hash(bytes)};
}

/** Untimed basic prerequisite only. It neither launches nor sends another GET. */
export async function waitForNativeLobbyWallet({page,evidence,probe,artifact,baseline,diagnostic,timeoutMs=45000,now=Date.now,wait=sleep}){
 assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=45000,'LOBBY_WALLET_DEADLINE_INVALID');
 const end=now()+timeoutMs,frame=page.mainFrame(),probeFrameId=probe.frameId(frame);let owner,body,selected;
 Object.assign(diagnostic,{passed:false,startedAtMs:now(),timeoutMs,observations:[],observationsOmitted:0,scope:'Untimed basic lobby prerequisite; no launch/action or cold-performance timing'});
 const bounded=async work=>{let timer;const remaining=end-now();assert.ok(remaining>0,'LOBBY_WALLET_READY_TIMEOUT');try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('LOBBY_WALLET_READY_TIMEOUT')),remaining);})]);}finally{clearTimeout(timer);}};
 const observe=reason=>{if(diagnostic.observations.length<16)diagnostic.observations.push({atMs:now(),reason});else diagnostic.observationsOmitted++;};
 const currentOwner=async()=>{
  assert.equal(page.mainFrame(),frame,'LOBBY_WALLET_MAIN_FRAME_CHANGED');assert.equal(page.url(),artifact.entryUrl,'LOBBY_WALLET_PARENT_CHANGED');const prior=probe.observations().length;
  await bounded(()=>probe.flush(page));assert.deepEqual(probe.errors,[],'LOBBY_WALLET_PROBE_ERROR');const added=probe.observations().slice(prior).filter(row=>row.frame_id===probeFrameId&&row.kind==='checkpoint');
  assert.equal(added.length,1,'LOBBY_WALLET_CURRENT_DOCUMENT_UNPROVEN');assert.ok(probe.hasDocument(frame,added[0].document_id,artifact.entryUrl),'LOBBY_WALLET_CURRENT_DOCUMENT_UNPROVEN');
  const navigated=evidence.raw.filter(row=>row.event==='Page.frameNavigated'&&!row.value.frame.parentId).at(-1)?.value.frame;
  assert.equal(navigated?.url,artifact.entryUrl,'LOBBY_WALLET_MAIN_FRAME_UNPROVEN');
  const current={probeFrameId,documentId:added[0].document_id,frameId:navigated.id,loaderId:navigated.loaderId};
  if(owner)assert.deepEqual(current,owner,'LOBBY_WALLET_DOCUMENT_CHANGED');else{owner=current;diagnostic.owner={...owner};}
 };
 try{
  while(now()<end){
   await currentOwner();
   const candidate=inspectNativeLobbyWallet({artifact,owner,raw:evidence.raw,network:probe.networkObservations(),responses:evidence.responses});
   if(candidate.ready){
    if(selected)assert.equal(candidate.requestId,selected.requestId,'LOBBY_WALLET_REQUEST_CHANGED');else{selected=candidate;diagnostic.request={...candidate};}
    if(!body){const read=await bounded(()=>evidence.readCompletePlayerWalletBody({requestId:selected.requestId,url:selected.url,frameId:selected.frameId,timeoutMs:Math.max(1,end-now())}));assert.equal(read.requestId,selected.requestId,'LOBBY_WALLET_BODY_ID_CHANGED');assert.equal(read.url,selected.url,'LOBBY_WALLET_BODY_URL_CHANGED');assert.equal(read.frameId,selected.frameId,'LOBBY_WALLET_BODY_FRAME_CHANGED');body=read.bytes;}
    const ui=await bounded(()=>page.evaluate(readNativeLobbyWalletUi)),complete=assertLobbyWalletBodyAndUi(body,ui,{artifact,baseline});diagnostic.body={bytes:complete.bytes,sha256:complete.sha256,source:'Exact completed UI CDP request body'};diagnostic.ui=ui;
    if(complete.ready){await currentOwner();assert.deepEqual(inspectNativeLobbyWallet({artifact,owner,raw:evidence.raw,network:probe.networkObservations(),responses:evidence.responses}),selected,'LOBBY_WALLET_REQUEST_CHANGED');assert.ok(now()<end,'LOBBY_WALLET_READY_TIMEOUT');diagnostic.passed=true;diagnostic.nativeBodyCompletion='Real visible wallet UI rendered after the release-pinned native response.json/validation';diagnostic.completedAtMs=now();return diagnostic;}
    observe('NATIVE_WALLET_UI_PENDING');
   }else observe(candidate.reason);
   await bounded(()=>wait(Math.min(100,Math.max(1,end-now()))));
  }
  throw Error('LOBBY_WALLET_READY_TIMEOUT');
 }catch(error){diagnostic.error=error.message;diagnostic.completedAtMs=now();throw error;}
}
