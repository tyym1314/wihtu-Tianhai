import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createPhysicalNetworkCollector,waitForOwnedNativeTapEnabled,waitForSettledNativeTapFrame,settledNativeTapGeometry,assertOwnedNativeTapReceipt,createOwnedNativeTapEvaluators,checkOwnedNativeTapBeforeDispatch,prepareOwnedNativeTapReceipt,annotateOwnedNativeTapInstallationError} from '../scripts/android-player-performance.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),origin='https://owned.example',entryUrl=origin+'/player',image=origin+'/arena/assets/image.webp',body=Buffer.from('actual consumed binary'),nonce='nonce-public-fixture-012345',documentId='a'.repeat(32),frameId='cdp-frame',contextId=7,timeOrigin=1000,blobUrl='blob:'+origin+'/00000001-0000-0000-0000-000000000000';
function evidence(){return{schema:'owned-player-resource-evidence-v1',game:'run',identity:{nonce,documentId,timeOrigin,url:origin+'/play/run',parentUrl:entryUrl},phase:'loading',pendingTasks:0,totalHashedBytes:body.length,errors:[],receipts:[{id:1,sourceUrl:image,status:200,type:'basic',bytes:body.length,sha256:hash(body),createdAt:1,completedAt:4,hashDurationMs:3,hashStarted:true,hashComplete:true,blobUrls:[{url:blobUrl,createdAt:2,revokedAt:null}]}]};}
async function fixture({wrongBody=false,noEvidence=false,wrongContext=false}={}){
 const cdp=new EventEmitter(),calls=[],round={documentId},manifest={expected:new Map([['/arena/assets/image.webp',hash(body)]])};let snap=evidence();if(noEvidence){snap.receipts=[];snap.totalHashedBytes=0;}if(wrongContext)snap.identity.documentId='b'.repeat(32);
 cdp.send=async(method,args)=>{calls.push({method,args});if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'top',url:entryUrl},childFrames:[{frame:{id:frameId,parentId:'top',url:origin+'/play/run'}}]}};if(method==='Network.getResponseBody')return{body:wrongBody==='blob-only'?(args.requestId==='blobGET'?'wrong blob bytes':''):wrongBody?'wrong nonempty':'',base64Encoded:false};if(method==='Runtime.evaluate'){let value;if(args.expression.includes('__oasisPhysicalPerf'))value={schema:'android-physical-performance-v1',nonce,documentId,url:origin+'/play/run',timeOrigin,frames:[],longTasks:[],gestures:[]};else{if(args.expression.includes('.freeze'))snap.phase='sampling';if(args.expression.includes('.stop'))snap.phase='closed';value=snap;}return{result:{value}};}return{};};cdp.detach=async()=>{calls.push({method:'detach'});};
 const collector=await createPhysicalNetworkCollector({context:{async newCDPSession(){return cdp;}},page:{url:()=>entryUrl},origin,game:'run',state:{},baseline:{},manifest,nonce,round,entryUrl});
 cdp.emit('Page.frameNavigated',{frame:{id:frameId,parentId:'top',url:origin+'/play/run'}});cdp.emit('Runtime.executionContextCreated',{context:{id:contextId,origin,auxData:{isDefault:true,frameId}}});await collector.bind();
 const transfer=(id,url,type)=>{cdp.emit('Network.requestWillBeSent',{requestId:id,frameId,type,timestamp:1,wallTime:100,request:{url,method:'GET'}});cdp.emit('Network.responseReceived',{requestId:id,response:{status:200,protocol:'h2',mimeType:'image/webp',fromDiskCache:true}});cdp.emit('Network.loadingFinished',{requestId:id,timestamp:2,encodedDataLength:0});};
 return{cdp,calls,collector,round,transfer};
}
test('real loadingFinished clears transfer pending synchronously; cached empty/unknown blob remains explicit diagnostic until actual linked proof',async()=>{
 const f=await fixture();f.transfer('sourceGET',image,'Fetch');f.transfer('blobGET',blobUrl,'Image');assert.equal(f.collector.pendingStatic(),0);await f.collector.drain();assert.equal(f.collector.summary().rawBodyDiagnostics.length,2);assert.equal(f.collector.summary().rawBodyDiagnostics.every(d=>d.resolvedByIndependentDelivery===false),true);
 await f.collector.verifyResourceEvidence({freeze:true});assert.equal(f.collector.summary().rawBodyDiagnostics.every(d=>d.resolvedByIndependentDelivery),true);assert.equal(f.collector.summary().bodyPinsOnly,false);assert.equal(f.collector.summary().records.filter(r=>r.deliveryProof).length,2);assert.equal(f.round.resourceEvidence.hashingDuringFrameSampling,false);await f.collector.verifyResourceEvidence({finish:true});await f.collector.close();assert.deepEqual(f.collector.errors,[]);assert.equal(f.cdp.listenerCount('Network.loadingFinished'),0);
});
test('cache flags alone/no Blob proof, foreign document, nonempty CDP SHA conflict and unknown blob all fail',async()=>{
 for(const opts of[{noEvidence:true},{wrongContext:true}]){const f=await fixture(opts);f.transfer('sourceGET',image,'Fetch');await f.collector.drain();await assert.rejects(f.collector.verifyResourceEvidence({freeze:true}));await f.collector.close();assert.ok(f.collector.errors.length);}
 const bad=await fixture({wrongBody:true});bad.transfer('sourceGET',image,'Fetch');await bad.collector.drain();assert.ok(bad.collector.errors.some(e=>e.includes('BODY_SHA_MISMATCH')));await bad.collector.close();
 const unknown=await fixture();unknown.transfer('sourceGET',image,'Fetch');unknown.transfer('unrelated','blob:'+origin+'/11111111-0000-0000-0000-000000000000','Image');await unknown.collector.drain();await assert.rejects(unknown.collector.verifyResourceEvidence({freeze:true}),/UNPROVEN/);await unknown.collector.close();assert.ok(unknown.collector.errors.length);
});
test('official driver imported real tap helpers: temporary disabled waits, settle remains bounded, exact original scale and untrusted click rejects',async()=>{
 let now=0,reads=0,evidence={};await waitForOwnedNativeTapEnabled({read:async()=>({visible:true,enabled:++reads===2}),now:()=>now,wait:async ms=>{now+=ms;},evidence});assert.equal(evidence.observedDisabled,true);assert.equal(reads,2);let waited;await waitForSettledNativeTapFrame({twoRAF:async()=>{},wait:async ms=>{waited=ms;}});assert.equal(waited,300);
 const point=settledNativeTapGeometry({bounds:{x:200,y:400,width:207.333333,height:348},webview:{attached:true,visible:true,width:1236,height:2550,screenX:0,screenY:152},viewport:{width:412,height:850,dpr:3}});assert.ok(point.x>=0&&point.y>=152);
 assert.throws(()=>assertOwnedNativeTapReceipt({schema:'owned-native-tap-receipt-v1',key:'own',url:entryUrl,overflow:false,events:[{type:'click',isTrusted:false,x:1,y:1,at:1}]},{key:'own',expectedUrl:entryUrl}),/UNTRUSTED/);
});

test('nonempty blob CDP bytes conflicting with consumed Blob SHA cannot be resolved by good source evidence',async()=>{const f=await fixture({wrongBody:'blob-only'});f.transfer('sourceGET',image,'Fetch');f.transfer('blobGET',blobUrl,'Image');await f.collector.drain();await assert.rejects(f.collector.verifyResourceEvidence({freeze:true}),/RESOURCE_NONEMPTY_CDP_BODY_CONFLICT/);await f.collector.close();assert.ok(f.collector.errors.some(e=>e.includes('RESOURCE_NONEMPTY_CDP_BODY_CONFLICT')));});

// Pure realm/handle contract fixture. It executes the maintained serialized
// evaluator but opens no browser and sends no ADB or network input.
function dispatchFixture({changeAfterEnabled=()=>{},scoped=true}={}){
 const calls=[],key='own-dispatch-slot',url=origin+'/play/run',scope=scoped?{nonce,documentId,timeOrigin,url,frameId}:null,clock={timeOrigin,now:()=>7},location={href:url};
 const doc={visibilityState:'visible',hasFocus:()=>true,querySelectorAll:()=>[],querySelector:()=>null,defaultView:{location,performance:clock}},attrs=new Map([['data-testid','run-jump']]);
 const element={ownerDocument:doc,tagName:'BUTTON',dataset:{},disabled:false,isConnected:true,getAttribute:name=>attrs.get(name)??null,matches:selector=>{assert.equal(selector,':disabled');return element.disabled;}};
 const installation={schema:'owned-native-tap-receipt-v1',key,url,documentTimeOrigin:timeOrigin,visibility:'visible',performanceScope:scope};
 element[key]={...installation,events:[],overflow:false,observationErrors:[],focusedBefore:true,authorityAtInstallation:null};
 const evaluators=createOwnedNativeTapEvaluators(),readControl=runInNewContext('('+evaluators.dispatchControl.toString()+')',{document:doc,location,performance:clock,__oasisPhysicalPerf:{schema:'android-physical-performance-v1',nonce,documentId,timeOrigin,url}});
 const handle={isVisible:async()=>{calls.push('same-handle-visible');return true;},isEnabled:async()=>{calls.push('same-handle-enabled');changeAfterEnabled({element,doc,attrs,clock,location});return true;},evaluate:async(fn,args)=>{assert.equal(fn,evaluators.dispatchControl);calls.push('same-handle-original-slot-and-dom');return JSON.parse(JSON.stringify(readControl(element,args)));}};
 let epoch=10;const evidence={},args={handle,evaluators,installation,key,expectedUrl:url,performanceScope:scope,evidence,now:()=>epoch+=10};
 return{args,evidence,calls,element,doc,attrs,clock,location,key};
}

test('dispatch guard reads the installed original handle and scope after preparation, retaining both clocks',async()=>{
 const f=dispatchFixture();await checkOwnedNativeTapBeforeDispatch(f.args);f.calls.push('unique-native-input');
 assert.deepEqual(f.calls,['same-handle-visible','same-handle-enabled','same-handle-original-slot-and-dom','unique-native-input']);
 assert.equal(f.evidence.startedAtEpochMs,20);assert.equal(f.evidence.checkedAtEpochMs,30);assert.equal(f.evidence.control.document.at,7);assert.equal(f.evidence.control.document.timeOrigin,timeOrigin);assert.deepEqual(f.evidence.control.dom.owner,{nonce,documentId,timeOrigin,url:origin+'/play/run'});assert.deepEqual(f.evidence.control.slot.events,[]);
 const entry=dispatchFixture({scoped:false});await checkOwnedNativeTapBeforeDispatch(entry.args);assert.equal(entry.evidence.control.dom,null);assert.equal(entry.evidence.control.slot.performanceScope,null);
});

test('a real control change after the earlier enabled read refuses dispatch without sending or retrying the gesture',async()=>{
 for(const change of [({element})=>{element.disabled=true;},({attrs})=>attrs.set('aria-disabled','true'),({element})=>{element.isConnected=false;},({doc})=>{doc.visibilityState='hidden';}]){
  const f=dispatchFixture({changeAfterEnabled:change});let sent=0;
  await assert.rejects(async()=>{await checkOwnedNativeTapBeforeDispatch(f.args);sent++;},error=>error.code==='ACTION_STATE_CHANGED'&&error.nativeInputSent===false);
  assert.equal(sent,0);assert.equal(f.evidence.enabled,true);assert.equal(f.evidence.checkedAtEpochMs,30);assert.deepEqual(f.calls,['same-handle-visible','same-handle-enabled','same-handle-original-slot-and-dom']);
 }
 const invisible=dispatchFixture();invisible.args.handle.isVisible=async()=>false;await assert.rejects(checkOwnedNativeTapBeforeDispatch(invisible.args),error=>error.code==='ACTION_STATE_CHANGED'&&error.nativeInputSent===false);assert.equal(invisible.evidence.visible,false);
});

test('final dispatch preserves original slot, event and document-scope refusal gates',async()=>{
 const events=dispatchFixture();events.element[events.key].events.push({type:'click'});await assert.rejects(checkOwnedNativeTapBeforeDispatch(events.args),/PRE_INPUT_EVENTS_PRESENT/);
 const foreign=dispatchFixture();foreign.element[foreign.key].performanceScope={...foreign.args.performanceScope,nonce:'foreign'};await assert.rejects(checkOwnedNativeTapBeforeDispatch(foreign.args),/INSTALLED_SLOT_SCOPE_CHANGED/);
 for(const change of [f=>{f.clock.timeOrigin++;},f=>{f.location.href+='?foreign';},f=>{f.element[f.key].key='foreign';}]){const f=dispatchFixture();change(f);await assert.rejects(checkOwnedNativeTapBeforeDispatch(f.args),/RECEIPT_IDENTITY_CHANGED|DOCUMENT_UNPROVEN/);}
 const both=dispatchFixture({changeAfterEnabled:({element})=>{element.disabled=true;}});both.element[both.key].performanceScope={...both.args.performanceScope,nonce:'foreign'};await assert.rejects(checkOwnedNativeTapBeforeDispatch(both.args),error=>error.code!=='ACTION_STATE_CHANGED'&&/INSTALLED_SLOT_SCOPE_CHANGED/.test(error.message));
 const hiddenEvents=dispatchFixture({changeAfterEnabled:({doc})=>{doc.visibilityState='hidden';}});hiddenEvents.element[hiddenEvents.key].events.push({type:'click'});await assert.rejects(checkOwnedNativeTapBeforeDispatch(hiddenEvents.args),error=>error.code!=='ACTION_STATE_CHANGED'&&/PRE_INPUT_EVENTS_PRESENT/.test(error.message));
 const unknown=dispatchFixture({changeAfterEnabled:({doc})=>{doc.visibilityState='prerender';}});await assert.rejects(checkOwnedNativeTapBeforeDispatch(unknown.args),error=>error.code!=='ACTION_STATE_CHANGED'&&/VISIBILITY_UNPROVEN/.test(error.message));
});

test('only original installation prefixes proving hidden or disabled receive not-sent metadata; original diagnostic stays exact',()=>{
 for(const change of [f=>{f.doc.visibilityState='hidden';},f=>{f.element.disabled=true;},f=>f.attrs.set('aria-disabled','true')]){
  const f=dispatchFixture();change(f);let original;try{prepareOwnedNativeTapReceipt(f.element,f.args,()=>assert.fail('State guard must precede DOM scope installation'));}catch(error){original=error;}assert.ok(original);
  const error=Error('elementHandle.evaluate: Error: '+original.message+'\n    at maintained browser evaluator'),message=error.message,evidence={};assert.equal(annotateOwnedNativeTapInstallationError(error,evidence),error);assert.equal(error.message,message);assert.equal(error.code,'ACTION_STATE_CHANGED');assert.equal(error.nativeInputSent,false);assert.equal(JSON.stringify(evidence.guardDiagnostic),original.message.split(' | guard-diagnostic=')[1]);
 }
 for(const change of [f=>{f.location.href+='?foreign';},f=>{f.doc.visibilityState='prerender';},f=>{f.doc.visibilityState='unknown';}]){
  const f=dispatchFixture();change(f);let error;try{prepareOwnedNativeTapReceipt(f.element,f.args,()=>assert.fail());}catch(original){error=original;}assert.ok(error);const message=error.message,evidence={};annotateOwnedNativeTapInstallationError(error,evidence);assert.equal(error.message,message);assert.equal(error.code,undefined);assert.equal(error.nativeInputSent,undefined);assert.deepEqual(evidence,{});
 }
 for(const message of ['disabled without original diagnostic','OWNED_NATIVE_TAP_DOCUMENT_CLOCK_CHANGED','FAILED_ROUND_DOM_DOCUMENT_UNPROVEN']){const error=Error(message),evidence={};annotateOwnedNativeTapInstallationError(error,evidence);assert.equal(error.code,undefined);assert.deepEqual(evidence,{});}
});

test('actual native preparation checks foreground before control work and ends with final guard directly before its sole dispatch',async()=>{
 const source=await readFile(new URL('../scripts/android-player-performance.mjs',import.meta.url),'utf8'),start=source.indexOf(' const tap=async(target,'),end=source.indexOf(' const stopUI=async round=>',start),tap=source.slice(start,end);
 const foreground=tap.indexOf("androidForeground(await adb('shell','dumpsys','activity','activities'))"),scroll=tap.indexOf('await target.scrollIntoViewIfNeeded()'),slot=tap.indexOf('assertOwnedNativeTapInstalledSlot(receipt.installedSlot,'),guard=tap.indexOf('await checkOwnedNativeTapBeforeDispatch('),dispatch=tap.indexOf("await execute('adb',physicalAdbArgs(options,['shell','input','tap'");
 assert.ok(start>=0&&end>start&&foreground>=0&&scroll>foreground&&slot>scroll&&guard>slot&&dispatch>guard);assert.equal(tap.match(/physicalAdbArgs\(options,\['shell','input','tap'/g)?.length,1);assert.equal(tap.slice(guard,dispatch).match(/\bawait\b/g)?.length,1);
});
