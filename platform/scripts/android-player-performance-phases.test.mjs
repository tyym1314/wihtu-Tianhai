import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {ownedPerformanceFailureDOM,capturePerformanceRoundFailure,assertPerformanceRoundContinuation,ownedContinuousSampleBoundary,beginOwnedMotionProof,capturePerformanceMotionPhase,partitionPerformanceRoundActions,ownedNativeTapEventDOM,prepareOwnedNativeTapReceipt,readOwnedNativeTapReceipt,removeOwnedNativeTapReceipt,assertOwnedNativeTapReceipt,classifyOwnedNativeTapOutcomes,createPhysicalNetworkCollector} from './android-player-performance.mjs';
import {installPhysicalProbe,evaluateAndroidPerformance} from './android-player-performance-checks.mjs';

const origin='https://owned-player.example',game='run',nonce='actual-owned-probe-test',url=origin+'/play/run',timeOrigin=1000;
const thresholds=JSON.parse(await readFile(new URL('../specs/mobile-quality-v1.json',import.meta.url))).thresholds;
function authority(){
 const identity={game,sessionId:'original_session',playerId:'human',appId:'actual_app'},own={key:'human',isBot:false,inputNo:10,appliedInputNo:10,jumpStartTick:null,fallUntilTick:null,finishTick:null,stunUntilTick:0,slideUntilTick:0};
 const room={id:'original_room',game_id:game,me:'human',practice:true,entry_minor:'0',fee_bps:0,capacity:2,status:'active',version:111,server_now:2000,me_last_seq:0,game:{status:'active',phase:'racing',ruleVersion:'pvp-run-v2.4.0',snapshotTick:1500,players:[own,{key:'bot',isBot:true}]},run_inputs:{clockEpoch:1,revision:111,headTick:1500,processedThroughCommandSeq:10,acceptedInputNo:10}};
 return {state:{...identity,androidBaseline:{...identity},ownedRooms:new Set([room.id]),room,token:'private-token-never-retained',probabilityRequests:[],creations:[]},baseline:{appId:identity.appId,externalUserId:'human'}};
}
function realm(){
 let time=0,id=0;const callbacks=new Map(),listeners=new Map(),events=key=>({addEventListener(type,fn){if(!listeners.has(key+type))listeners.set(key+type,new Set());listeners.get(key+type).add(fn);},removeEventListener(type,fn){listeners.get(key+type)?.delete(fn);if(listeners.get(key+type)?.size===0)listeners.delete(key+type);}});
 const element=(testId,data={},disabled=false)=>({tagName:'BUTTON',dataset:data,disabled,getAttribute(name){return name==='data-testid'?testId:name==='aria-disabled'?'false':null;}}),button=element('run-jump',{},false),scene=element('run-scene',{inputReady:'true'}),track=element('run-track',{practiceMode:'provisional',authorityExpired:'false',provisionalTick:'1504',revision:'111'}),status={textContent:'Recovering'};
 const document={...events('doc'),visibilityState:'visible',hasFocus:()=>true,querySelector(selector){return selector==='[data-testid="run-scene"]'?scene:selector==='[data-testid="run-track"]'?track:null;},querySelectorAll(selector){return selector==='button[data-testid]'?[button]:selector==='[role="status"]'?[status]:selector==='canvas'?[{}]:[];}};
 const context=vm.createContext({URL,crypto:webcrypto,location:new URL(url),performance:{timeOrigin,now:()=>time,setResourceTimingBufferSize(){}},document,window:events('win'),requestAnimationFrame:fn=>{callbacks.set(++id,fn);return id;},cancelAnimationFrame:key=>callbacks.delete(key)});
 vm.runInContext('('+installPhysicalProbe.toString()+')('+JSON.stringify({origin,nonce})+')',context);
 const p=context.__oasisPhysicalPerf,args={expectedUrl:url,nonce,documentId:p.documentId};
 return {context,p,args,button,scene,track,callbacks,listeners,invoke(fn,options){return vm.runInContext('('+fn.toString()+')('+JSON.stringify(options)+','+ownedPerformanceFailureDOM.toString()+')',context);},step(at){time=at;const pending=[...callbacks.values()];callbacks.clear();for(const fn of pending)fn(at);},now:()=>time,collector:{evaluate:async expression=>JSON.parse(JSON.stringify(await vm.runInContext(expression,context)))}};
}

test('failure keeps the original deadline, exact own authority and bounded DOM before cleanup; private token never leaves memory',async()=>{
 const f=realm(),{state,baseline}=authority();f.step(0);f.step(16);const round={documentId:f.p.documentId,documentTimeOrigin:timeOrigin,sampleStartedAt:new Date(1000).toISOString(),observerErrors:[]},error=Object.assign(Error('run: no action response before deadline'),{code:'ACTION_DEADLINE'});
 const observation=await capturePerformanceRoundFailure({round,error,collector:f.collector,state,baseline,origin,game,nonce,now:()=>2000});
 assert.equal(observation.stage,'Before UI stop and original-session cleanup');assert.equal(round.probePreservedAfterFailure,true);assert.equal(observation.dom.track.data.practiceMode,'provisional');assert.equal(observation.dom.controls[0].disabled,false);assert.equal(observation.authorityBeforeDOM.runInputs.acceptedInputNo,10);assert.equal(observation.authorityAfterDOM.room.status,'active');assert.doesNotMatch(JSON.stringify(observation),/private-token|original_session|original_room/);
 round.cleanup={passed:true};assert.throws(()=>assertPerformanceRoundContinuation(round),error=>error.message==='run: no action response before deadline'&&error.code==='ACTION_DEADLINE');assert.equal(round.cleanup.passed,true);
 round.cleanup={passed:false,error:'secondary own cleanup failure'};assert.throws(()=>assertPerformanceRoundContinuation(round),/no action response/);assert.equal(round.cleanup.error,'secondary own cleanup failure');
});

test('failure observations cannot block cleanup forever or borrow a replaced document/foreign authority',async()=>{
 const f=realm(),{state,baseline}=authority(),round={documentId:f.p.documentId,documentTimeOrigin:timeOrigin,observerErrors:[]};const start=Date.now();
 const observation=await capturePerformanceRoundFailure({round,error:Error('original missing ACK'),collector:{evaluate:()=>new Promise(()=>{})},state,baseline,origin,game,nonce,timeoutMs:20});assert.ok(Date.now()-start<500);assert.match(observation.probeError,/TIMEOUT/);assert.match(observation.domError,/TIMEOUT/);assert.equal(round.error,'original missing ACK');
 const wrong={documentId:'b'.repeat(32),documentTimeOrigin:timeOrigin,observerErrors:[]};state.room.me='other';const rejected=await capturePerformanceRoundFailure({round:wrong,error:Error('original missing ACK'),collector:f.collector,state,baseline,origin,game,nonce});assert.match(rejected.authorityError,/UNOWNED|IDENTITY|PLAYER|human|other/);assert.match(rejected.domError,/DOCUMENT_UNPROVEN/);assert.equal(rejected.dom,undefined);
 assert.match(rejected.probeError,/GAME_PROBE_EVALUATION_FAILED|DOCUMENT_UNPROVEN/);assert.equal(f.callbacks.size,1,'A foreign document read must not stop the original probe');
});

test('failure during post-proof preserves the already ended exact continuous interval',async()=>{
 const f=realm(),{state,baseline}=authority();f.p.sampleStartAt=100;f.p.sampleEndAt=200;f.step(300);const round={documentId:f.p.documentId,documentTimeOrigin:timeOrigin,sampleStartedAt:new Date(1100).toISOString(),sampleWallMs:100,sampleBoundaries:{end:{epochMs:1200}},observerErrors:[]};
 await capturePerformanceRoundFailure({round,error:Error('post-proof capture failed'),collector:f.collector,state,baseline,origin,game,nonce,now:()=>9999});assert.equal(round.sampleWallMs,100);assert.equal(round.probe.sampleEndAt,200);
});

test('continuous start/end are real same-document RAF boundaries; every original interval is retained and a genuine in-window hitch still fails',async()=>{
 const f=realm();f.step(0);f.step(400);const start=f.invoke(ownedContinuousSampleBoundary,{...f.args,stage:'start',motion:{active:true,moving:true}});f.step(416);const beginning=await start;assert.equal(beginning.at,416);assert.equal(f.p.sampleStartAt,416);
 f.step(432);f.step(682);const end=f.invoke(ownedContinuousSampleBoundary,{...f.args,stage:'end',motion:{active:true,moving:true}});f.step(698);const ending=await end;assert.equal(ending.at,698);assert.equal(ending.probe.frames.length,5);assert.equal(ending.probe.frames[0].ms,400);assert.equal(ending.probe.frames[3].ms,250);assert.equal(f.callbacks.size,0);
 const result=evaluateAndroidPerformance(game,[{probe:JSON.parse(JSON.stringify(ending.probe)),motion:{pairs:[]},actions:[],cleanup:{passed:true},observerErrors:[]}],thresholds);assert.equal(result.frames.foreground.max_ms,250);assert.equal(result.status,'fail');
 const wrong=f.invoke(ownedContinuousSampleBoundary,{...f.args,nonce:'foreign',stage:'start',motion:{active:true,moving:true}});await assert.rejects(wrong,/DOCUMENT_UNPROVEN/);
 const duplicate=f.invoke(ownedContinuousSampleBoundary,{...f.args,stage:'start',motion:{active:true,moving:true}});f.step(714);await assert.rejects(duplicate,/ALREADY_STARTED/);
});

test('screenshots have separate complete pre/post interval probes; no screenshot is possible in the continuous phase',async()=>{
 const f=realm();f.step(0);const round={documentId:f.p.documentId,documentTimeOrigin:timeOrigin,measurementPhase:'before',motion:{pairs:[]}};let shots=0;
 const target={count:async()=>1,isVisible:async()=>true,screenshot:async()=>{shots++;f.step(f.now()+400);return Buffer.from([shots]);}},decode=bytes=>({width:2,height:2,data:Buffer.alloc(16,bytes[0]%2?0:30)});
 const options={round,collector:f.collector,target,decode,writePair:async()=>{},readMotion:()=>({active:true,moving:true}),readAuthority:()=>({actual:'own retained reply'}),origin,game,nonce,wait:async ms=>f.step(f.now()+ms),now:f.now};
 const before=await capturePerformanceMotionPhase({...options,phase:'before'});assert.equal(before.pairs.length,2);assert.equal(before.probe.closed,true);assert.ok(before.probe.frames.some(frame=>frame.ms===400));assert.equal(round.motion.pairs.filter(pair=>pair.moved).length,2);assert.equal(Object.hasOwn(f.context,'__oasisOwnedMotionProof'),false);
 round.measurementPhase='continuous';const count=shots;await assert.rejects(capturePerformanceMotionPhase({...options,phase:'before'}),/SCREENSHOT_DURING_CONTINUOUS/);assert.equal(shots,count);
 const start=f.invoke(ownedContinuousSampleBoundary,{...f.args,stage:'start',motion:{active:true,moving:true}});f.step(f.now()+16);const begin=await start;round.sampleBoundaries={start:begin};f.step(f.now()+16);const end=f.invoke(ownedContinuousSampleBoundary,{...f.args,stage:'end',motion:{active:false,moving:false}});f.step(f.now()+16);const finish=await end;round.sampleBoundaries.end=finish;round.measurementPhase='after';const retained=f.p.frames.length;
 const after=await capturePerformanceMotionPhase({...options,phase:'after',readMotion:()=>({active:false,moving:false})});assert.equal(after.pairs.length,1);assert.equal(after.pairs[0].moved,false);assert.equal(after.pairs[0].authorityMovingAfter,false);assert.ok(after.probe.frames.some(frame=>frame.ms===400));assert.equal(f.p.frames.length,retained);assert.equal(f.callbacks.size,0);
});

test('screenshot failure closes only the owned proof RAF; idle screenshots cannot supply missing visible-motion evidence',async()=>{
 const f=realm(),round={documentId:f.p.documentId,documentTimeOrigin:timeOrigin,measurementPhase:'before',motion:{pairs:[]}},options={phase:'before',round,collector:f.collector,target:{count:async()=>1,isVisible:async()=>true,screenshot:async()=>{throw Error('actual capture failed');}},decode:()=>{},writePair:async()=>{},readMotion:()=>({active:false,moving:false}),readAuthority:()=>({}),origin,game,nonce};
 await assert.rejects(capturePerformanceMotionPhase(options),/actual capture failed/);assert.equal(Object.hasOwn(f.context,'__oasisOwnedMotionProof'),false);assert.equal(round.motion.proofPhases[0].probe.closed,true);assert.equal(f.callbacks.size,1);
 assert.throws(()=>f.invoke(beginOwnedMotionProof,{...f.args,phase:'before',documentId:'c'.repeat(32)}),/DOCUMENT_UNPROVEN/);
});

test('only wholly continuous trusted gestures and accepted replies count; proof-phase/boundary/unproven inputs remain visible and cannot satisfy long testing',()=>{
 const action=(g,r,f)=>({accepted:true,gestureCompletedEpochMs:g,requestStartedEpochMs:r,responseFinishedEpochMs:f,dispatchMs:r-g,confirmMs:f-r});
 const round={sampleBoundaries:{start:{epochMs:1000},end:{epochMs:2000}},actions:[action(500,510,600),action(1100,1110,1150),action(2100,2110,2150),action(990,1005,1020),{accepted:true,dispatchMs:10,confirmMs:20}]};const phases=partitionPerformanceRoundActions(round);assert.equal(round.actions.length,1);assert.equal(round.allObservedActions.length,5);for(const list of Object.values(phases))assert.equal(list.length,1);
 const outside={sampleBoundaries:round.sampleBoundaries,actions:[action(500,510,600)],motion:{pairs:[{moved:true},{moved:true}]},cleanup:{passed:true},probe:{frames:[],longTasks:[],longTaskSupported:true,dropped:0}};partitionPerformanceRoundActions(outside);const result=evaluateAndroidPerformance(game,[outside],thresholds,{sampleMs:900000});assert.equal(result.actions,0);assert.equal(result.gates.find(g=>g.id==='SUSTAINED-PHYSICAL').status,'insufficient');assert.notEqual(result.status,'pass');
});

test('the original screenshot failure survives a secondary proof close failure and retains both diagnostics',async()=>{
 const f=realm(),round={documentId:f.p.documentId,documentTimeOrigin:timeOrigin,measurementPhase:'before',motion:{pairs:[]}},collector={evaluate:expression=>expression==='globalThis.__oasisOwnedMotionProof.stop()'?Promise.reject(Error('secondary proof close failed')):f.collector.evaluate(expression)};
 await assert.rejects(capturePerformanceMotionPhase({phase:'before',round,collector,target:{count:async()=>1,isVisible:async()=>true,screenshot:async()=>{throw Error('original screenshot failed');}},decode:()=>{},writePair:async()=>{},readMotion:()=>({active:true,moving:true}),readAuthority:()=>({}),origin,game,nonce}),/original screenshot failed/);
 assert.equal(round.motion.proofPhases[0].captureError,'original screenshot failed');assert.equal(round.motion.proofPhases[0].probeError,'secondary proof close failed');
 f.invoke(function(options,readDOM){readDOM(options);return globalThis.__oasisOwnedMotionProof.stop();},f.args);assert.equal(f.callbacks.size,1);
});

function nativeTapRealm(){
 const f=realm(),child={tagName:'B'},d=f.context.document;f.button.ownerDocument=d;d.defaultView=f.context;d.elementFromPoint=()=>child;f.button.contains=node=>node===child;f.button.getBoundingClientRect=()=>({x:299,y:728,width:94,height:94});f.context.__target=f.button;
 const performanceScope={nonce,documentId:f.p.documentId,timeOrigin,url,frameId:'cdp-frame'},key='__actualOwnedNativeReceipt',authorityAtInstallation={schema:'owned-performance-failure-authority-v1',authoritySha256:'a'.repeat(64),roomIdHash:'r'.repeat(64),room:{version:111},runInputs:{revision:111,headTick:1500,clockEpoch:1},recordedAtEpochMs:999,clockSource:'Separate collector host snapshot clock'};
 const call=(fn,args)=>JSON.parse(JSON.stringify(vm.runInContext('('+fn.toString()+')(__target,'+JSON.stringify(args)+')',f.context)));
 function install(scope=performanceScope){return JSON.parse(JSON.stringify(vm.runInContext('('+prepareOwnedNativeTapReceipt.toString()+')(__target,'+JSON.stringify({key,expectedUrl:url,performanceScope:scope,authorityAtInstallation})+',(element,args)=>('+ownedNativeTapEventDOM.toString()+')(element,args,'+ownedPerformanceFailureDOM.toString()+'))',f.context)));}
 const dispatch=(type,isTrusted=true)=>{const event={type,target:child,isTrusted,clientX:346,clientY:775,pointerId:7,pointerType:'touch',isPrimary:true};for(const fn of [...(f.listeners.get('doc'+type)??[])])fn(event);};
 return {...f,performanceScope,key,authorityAtInstallation,call,install,dispatch};
}

test('owned trusted capture preserves the click-time control/scene/track state, not a later fall, and explicitly brackets asynchronous original authority',()=>{
 const f=nativeTapRealm(),before=[...f.listeners.values()].reduce((n,set)=>n+set.size,0);f.step(10);const installation=f.install();assert.equal(installation.testId,'run-jump');f.step(20);f.dispatch('pointerdown');f.step(21);f.dispatch('pointerup');f.track.dataset.revision='112';f.track.dataset.clip='run';f.scene.dataset.inputReady='true';f.step(22);f.dispatch('click');
 f.button.disabled=true;f.track.dataset.clip='fall';f.track.dataset.revision='113';f.scene.dataset.inputReady='false';f.step(1000);
 const receipt=f.call(readOwnedNativeTapReceipt,{key:f.key,expectedUrl:url}),click=receipt.events.find(event=>event.type==='click');assert.equal(click.at,22);assert.equal(click.dom.control.disabled,false);assert.equal(click.dom.scene.data.inputReady,'true');assert.equal(click.dom.track.data.clip,'run');assert.equal(click.dom.track.data.revision,'112');assert.equal(click.authorityReference.authorityRevision,111);assert.equal(click.authorityReference.domRevision,'112');assert.match(click.authorityReference.source,/not an atomic click-time/);assert.equal(click.authorityReference.snapshot.authoritySha256,'a'.repeat(64));assert.equal(click.dom.hostRequest.available,false);assert.match(click.dom.hostRequest.reason,/does not expose/);assertOwnedNativeTapReceipt(receipt,{key:f.key,expectedUrl:url,performanceScope:f.performanceScope});
 assert.deepEqual(f.call(removeOwnedNativeTapReceipt,{key:f.key,expectedUrl:url}),{removed:true,missing:false});assert.equal(Object.hasOwn(f.button,f.key),false);assert.equal([...f.listeners.values()].reduce((n,set)=>n+set.size,0),before);assert.equal(f.p.gestures.length,1,'Original trusted physical probe still receives its event');
});

test('replaced probe identity is recorded as unavailable without throwing into the real click handler; synthetic, foreign and overflow receipts cannot certify evidence',()=>{
 const wrong=nativeTapRealm();assert.throws(()=>wrong.install({...wrong.performanceScope,timeOrigin:timeOrigin+1}),/DOCUMENT_CLOCK_CHANGED/);assert.equal(Object.hasOwn(wrong.button,wrong.key),false);
 const f=nativeTapRealm();f.install();f.step(10);f.dispatch('pointerdown');f.step(11);f.dispatch('pointerup');f.p.documentId='b'.repeat(32);f.step(12);assert.doesNotThrow(()=>f.dispatch('click'));const receipt=f.call(readOwnedNativeTapReceipt,{key:f.key,expectedUrl:url});assert.match(receipt.events.at(-1).observationError,/DOCUMENT_UNPROVEN/);assert.throws(()=>assertOwnedNativeTapReceipt(receipt,{key:f.key,expectedUrl:url,performanceScope:f.performanceScope}),/EVENT_DOM_UNPROVEN/);f.call(removeOwnedNativeTapReceipt,{key:f.key,expectedUrl:url});
 const synthetic=nativeTapRealm();synthetic.install();synthetic.dispatch('click',false);const fake=synthetic.call(readOwnedNativeTapReceipt,{key:synthetic.key,expectedUrl:url});assert.throws(()=>assertOwnedNativeTapReceipt(fake,{key:synthetic.key,expectedUrl:url,performanceScope:synthetic.performanceScope}),/UNTRUSTED/);for(let i=0;i<9;i++)synthetic.dispatch('pointerdown');assert.equal(synthetic.call(readOwnedNativeTapReceipt,{key:synthetic.key,expectedUrl:url}).overflow,true);synthetic.call(removeOwnedNativeTapReceipt,{key:synthetic.key,expectedUrl:url});
});

test('native outcome diagnostics distinguish unsent/disabled, real clicks without POST, original pending/rejected POST and accepted reply; none create a successful action',()=>{
 const scope={nonce,documentId:'d'.repeat(32),timeOrigin:1000,url,frameId:'own-frame'},owner={nonce,documentId:scope.documentId,timeOrigin:1000,url},event=(type,at)=>({type,at,isTrusted:true,x:1,y:1,dom:{schema:'owned-native-tap-event-dom-v1',owner}}),receipt=(sequence,at)=>({sequence,roundId:'own',measurementPhase:'continuous',nativeRole:'game-action',performanceScope:scope,nativeInput:{exit:0},completed:true,authorityAtInstallation:{roomIdHash:'own-room'},trustedReceipt:{events:[event('pointerup',at),event('click',at+1)],observationErrors:[]}}),req=(digest,at,more={})=>({cdpRequestId:digest,frameId:'own-frame',roomIdHash:'own-room',requestSha256:digest,requestStartedEpochMs:at,responseStatus:null,transferFinished:false,failed:false,...more});
 const receipts=[{sequence:1,nativeInput:null,nativeNotSentReason:'disabled-before-native-input'},{sequence:2,nativeInput:null},receipt(3,100),receipt(4,200),receipt(5,300)],requests=[req('good',1205),req('rejected',1305,{responseStatus:409,failed:false,transferFinished:true}),req('foreign',1105,{frameId:'foreign-frame'}),req('wrong-room',1105,{roomIdHash:'foreign-room'})],actions=[{accepted:true,requestSha256:'good',cursorBefore:0,cursorAfter:1,proof:{commandSeq:1}}],before=JSON.stringify(actions);
 const output=classifyOwnedNativeTapOutcomes({receipts,requests,actions,observationStage:'At original deadline'});assert.deepEqual(output.map(value=>value.outcome),['disabled-native-input-not-sent','native-input-not-sent','trusted-click-no-action-post-observed','trusted-click-action-accepted','trusted-click-action-post-without-proven-accepted-response']);assert.equal(output[2].nativeInputSent,true);assert.equal(output[2].requests.length,0);assert.equal(output[3].acceptedActions.length,1);assert.equal(output[4].requests[0].responseStatus,409);assert.equal(JSON.stringify(actions),before);
 const ambiguous=classifyOwnedNativeTapOutcomes({receipts:[receipt(4,200)],requests:[req('one',1205),req('two',1210)],actions:[]});assert.equal(ambiguous[0].outcome,'trusted-click-action-request-binding-ambiguous');
 const pending=classifyOwnedNativeTapOutcomes({receipts:[receipt(4,200)],requests:[req('one',1205)],actions:[]});assert.equal(pending[0].outcome,'trusted-click-action-post-without-proven-accepted-response');assert.equal(pending[0].requests[0].transferFinished,false);
 const replaced=receipt(4,200);replaced.trustedReceipt.events.at(-1).dom.owner={...owner,documentId:'foreign'};assert.equal(classifyOwnedNativeTapOutcomes({receipts:[replaced],requests:[req('good',1205)],actions})[0].outcome,'trusted-click-observation-unproven');
});

test('original authenticated pending and aborted action POST diagnostics retain request clocks and SHA without exposing token/body, and exclude foreign requests',async()=>{
 const cdp=new EventEmitter(),{state,baseline}=authority(),frameId='own-frame';cdp.send=async()=>({});cdp.detach=async()=>{};const collector=await createPhysicalNetworkCollector({context:{newCDPSession:async()=>cdp},page:{url:()=>origin+'/player'},origin,game,state,baseline,manifest:{expected:new Map()},nonce,round:{},entryUrl:origin+'/player'});
 cdp.emit('Page.frameNavigated',{frame:{id:frameId,url}});const payload={requestId:'actual-request',commands:[{commandSeq:11,type:'jump',executeTick:1505}]},request=(id,frame=frameId,token=state.token)=>cdp.emit('Network.requestWillBeSent',{requestId:id,frameId:frame,type:'Fetch',timestamp:1,wallTime:1.205,request:{url:origin+'/api/pvp/rooms/'+state.room.id+'/inputs',method:'POST',headers:{Authorization:'Bearer '+token},postData:JSON.stringify(payload)}});
 request('actual-own');request('ignored-foreign','foreign-frame');request('bad-auth',frameId,'other-token');const pending=collector.actionRequestDiagnostics();assert.equal(pending.length,1);assert.equal(pending[0].cdpRequestId,'actual-own');assert.equal(pending[0].requestStartedEpochMs,1205);assert.equal(pending[0].transferFinished,false);assert.match(pending[0].requestSha256,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(pending),/private-token|other-token|actual-request|executeTick|Authorization/);
 cdp.emit('Network.loadingFailed',{requestId:'actual-own',errorText:'net::ERR_ABORTED',canceled:true});assert.equal(collector.actionRequestDiagnostics()[0].failed,true);assert.equal(collector.actionRequestDiagnostics()[0].canceled,true);await collector.close();assert.ok(collector.errors.some(error=>error.includes('ORIGINAL_ACTION_TOKEN_REQUIRED')));assert.ok(collector.errors.some(error=>error.includes('ERR_ABORTED')));assert.equal(cdp.listenerCount('Network.requestWillBeSent'),0);
});
