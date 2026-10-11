import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPerformanceLoadTimeline,recordPerformanceLoadNativeTap,capturePerformanceEntryTiming,prepareOwnedNativeTapReceipt,readOwnedNativeTapReceipt,removeOwnedNativeTapReceipt} from '../scripts/android-player-performance.mjs';
import {evaluateAndroidPerformance,hash} from '../scripts/android-player-performance-checks.mjs';

const entryUrl='https://owned-player.example/player?app_id=actual_app',game='run',nonce='owned-load-timeline',documentId='a'.repeat(32),timeOrigin=1100;
function fixture(){
 let at=1200;const round={id:'run-cold-1',game,entry:null,documentId,documentTimeOrigin:timeOrigin,roomIdHash:hash('private-owned-room')};
 round.loadTimeline=createPerformanceLoadTimeline({roundId:round.id,game,nonce,entryUrl,startEpochMs:1000});
 round.loadTimeline.gameDocument={nonce,documentId,timeOrigin,url:'https://owned-player.example/play/run',frameId:'owned-frame',contextId:7};
 const state={room:{id:'private-owned-room',game_id:game,me:'private-own-player',status:'active',version:1,server_now:1200,game:{status:'active',phase:'arming'},start_protocol:{kind:'scene-ready-v1'},players:[{external_user_id:'private-own-player',scene_ready:false}]}};
 const ready={ready:true,scene_ready:true,enabled_control:true,time_origin:timeOrigin,at:210,scene_ready_at:130,turn_wait_ms:15,other_player_ready_wait_ms:25,rules_countdown_ms:60};
 const calls=[],collector={pendingStatic:()=>0,async drain(){calls.push('drain');at=1900;},async verifyResourceEvidence(options){calls.push(['verify',options]);at=2300;}};
 return {round,state,ready,calls,collector,now:()=>at,set(value){at=value;},args:{round,state,game,collector,frame:{},now:()=>at}};
}

test('entry separates the original playable and evidence boundaries without changing arithmetic or claiming first-ready time',async()=>{
 const f=fixture();const ready=await capturePerformanceEntryTiming({...f.args,waitPlayable:async(frame,id,options)=>{
  assert.equal(id,game);assert.equal(options.pendingStatic(),0);f.calls.push('wait');options.readRoom();f.set(1240);f.state.room.players[0].scene_ready=true;options.readRoom();f.set(1290);f.state.room.game.phase='countdown';options.readRoom();f.set(1310);f.state.room.game.phase='racing';options.readRoom();f.set(1350);return f.ready;
 }});
 assert.equal(ready,f.ready);assert.deepEqual(f.calls,['wait','drain',['verify',{freeze:true}]]);
 const timeline=f.round.loadTimeline;assert.equal(timeline.startEpochMs,1000);assert.equal(timeline.readiness.startedAtEpochMs,1200);assert.equal(timeline.readiness.returnedAtEpochMs,1350);assert.equal(timeline.actualPlayableAtEpochMs,1350);
 assert.deepEqual(timeline.readiness.reasonTransitions.map(r=>[r.observedAtEpochMs,r.reason]),[[1200,'scene-ready-pending'],[1240,'other-player-scene-ready'],[1290,'rules-countdown'],[1310,null]]);
 assert.equal(timeline.readiness.returnedObservation.observedAtEpochMs,1310);assert.equal(timeline.readiness.returnedObservation.documentClockMatchesBoundGame,true);assert.equal(timeline.readiness.returnedObservation.reportedSceneReadyAtRealmMs,130);assert.equal(timeline.productFirstConditionTimeProven,false);
 assert.deepEqual(timeline.drain,{startedAtEpochMs:1350,returnedAtEpochMs:1900,outcome:'returned'});assert.deepEqual(timeline.verifyResourceEvidence,{startedAtEpochMs:1900,returnedAtEpochMs:2300,outcome:'returned'});
 assert.equal(f.round.entry.actualPlayableMs,310);assert.equal(f.round.entry.elapsedMs,1260);assert.equal(f.round.entry.wallMs,1300);assert.equal(f.round.entry.actualPlayableWallMs,350);assert.equal(f.round.entry.evidenceReadyMs,1300);assert.equal(f.round.entry.evidenceCollectionAfterPlayableMs,950);assert.equal(f.round.entry.scene,f.ready);
 assert.doesNotMatch(JSON.stringify(timeline),/private-owned-room|private-own-player/);
});

test('readiness timeout preserves its original error and observed reason; no playable or evidence completion is invented',async()=>{
 const f=fixture(),error=Object.assign(Error('original readiness timeout'),{code:'READINESS_TIMEOUT',readiness:{gate:{wait_reason:'scene-ready-pending'}}});
 await assert.rejects(capturePerformanceEntryTiming({...f.args,waitPlayable:async(frame,id,options)=>{options.readRoom();f.set(1700);throw error;}}),value=>value===error);
 assert.equal(f.round.loadTimeline.readiness.outcome,'failed');assert.equal(f.round.loadTimeline.readiness.failedAtEpochMs,1700);assert.equal(f.round.loadTimeline.readiness.lastReasonObservation.reason,'scene-ready-pending');assert.equal(f.round.loadTimeline.readiness.returnedAtEpochMs,undefined);assert.equal(f.round.loadTimeline.actualPlayableAtEpochMs,undefined);assert.equal(f.round.entry,null);assert.deepEqual(f.calls,[]);
});

for(const stage of ['drain','verifyResourceEvidence'])test(`${stage} failure remains fatal with its original cause, while the observed playable boundary survives`,async()=>{
 const f=fixture(),error=Object.assign(Error('original '+stage+' failure'),{code:'ORIGINAL_FAILURE'});f.collector[stage]=async()=>{f.set(2450);throw error;};
 await assert.rejects(capturePerformanceEntryTiming({...f.args,waitPlayable:async()=>{f.set(1350);return f.ready;}}),value=>value===error);
 assert.equal(f.round.loadTimeline.actualPlayableAtEpochMs,1350);assert.equal(f.round.loadTimeline[stage].failedAtEpochMs,2450);assert.equal(f.round.loadTimeline[stage].outcome,'failed');assert.equal(f.round.loadTimeline[stage].returnedAtEpochMs,undefined);assert.equal(f.round.loadTimeline.evidenceReadyAtEpochMs,undefined);assert.equal(f.round.entry,null);
 if(stage==='drain')assert.equal(f.round.loadTimeline.verifyResourceEvidence,undefined);
});

test('reason transitions are bounded with explicit omission counts and the real final observation retained',async()=>{
 const f=fixture();await capturePerformanceEntryTiming({...f.args,waitPlayable:async(frame,id,options)=>{
  for(let i=0;i<300;i++){f.set(1200+i);f.state.room.game.phase=i%2?'racing':'arming';options.readRoom();}return f.ready;
 }});
 const r=f.round.loadTimeline.readiness;assert.equal(r.observationCount,300);assert.equal(r.reasonTransitions.length,128);assert.equal(r.reasonTransitionsOmitted,172);assert.equal(r.lastReasonObservation.observedAtEpochMs,1499);assert.equal(r.lastReasonObservation.reason,null);assert.equal(f.round.loadTimeline.productFirstConditionTimeProven,false);
});

test('load reason observations and native receipts cannot be borrowed from a different room or document',async()=>{
 const f=fixture();f.state.room.id='foreign-room';await assert.rejects(capturePerformanceEntryTiming({...f.args,waitPlayable:async(frame,id,options)=>{options.readRoom();return f.ready;}}),/LOAD_TIMELINE_ROOM_CHANGED/);assert.equal(f.round.loadTimeline.readiness.observationCount,0);assert.equal(f.round.entry,null);
 const different=fixture();different.round.loadTimeline.gameDocument.documentId='b'.repeat(32);await assert.rejects(capturePerformanceEntryTiming({...different.args,waitPlayable:async()=>assert.fail('foreign realm may not start readiness')}),/LOAD_TIMELINE_DOCUMENT_CHANGED/);
});

function tapReceipt(overrides={}){
 return {roundId:'run-cold-1',measurementPhase:'entry',sequence:3,nativeRole:'setup-or-navigation',completed:true,
  nativeTiming:{preparationStartedAtEpochMs:1001,preparationCompletedAtEpochMs:1400,commandDispatchedAtEpochMs:1401,commandCompletedAtEpochMs:1500,commandOutcome:'returned',trustedReceiptReadAtEpochMs:1510,finishedAtEpochMs:1520},
  performanceScope:{nonce,documentId,timeOrigin,url:'https://owned-player.example/play/run',frameId:'owned-frame'},
  trustedReceipt:{url:'https://owned-player.example/play/run',documentTimeOrigin:timeOrigin,overflow:false,events:[{type:'pointerdown',isTrusted:true,at:305},{type:'pointerup',isTrusted:true,at:306},{type:'click',isTrusted:true,at:307}]},...overrides};
}

test('native preparation/command/receipt clocks stay separate from exact original-realm event epochs and remain bounded',()=>{
 const f=fixture(),receipt=tapReceipt(),before=JSON.stringify(receipt),row=recordPerformanceLoadNativeTap(f.round.loadTimeline,receipt);
 assert.equal(row.preparationStartedAtEpochMs,1001);assert.equal(row.commandDispatchedAtEpochMs,1401);assert.equal(row.commandCompletedAtEpochMs,1500);assert.equal(row.trustedReceiptReadAtEpochMs,1510);assert.equal(row.document.timeOrigin,1100);assert.deepEqual(row.events.map(e=>[e.type,e.at,e.epochMs]),[['pointerdown',305,1405],['pointerup',306,1406],['click',307,1407]]);assert.equal(JSON.stringify(receipt),before);
 for(let i=0;i<70;i++)recordPerformanceLoadNativeTap(f.round.loadTimeline,tapReceipt({sequence:4+i}));assert.equal(f.round.loadTimeline.nativeTaps.length,64);assert.equal(f.round.loadTimeline.nativeTapsOmitted,7);
 for(const receipt of [tapReceipt({roundId:'foreign'}),tapReceipt({measurementPhase:'continuous'}),tapReceipt({performanceScope:{...tapReceipt().performanceScope,nonce:'foreign'}}),tapReceipt({trustedReceipt:{...tapReceipt().trustedReceipt,documentTimeOrigin:999}}),tapReceipt({trustedReceipt:{...tapReceipt().trustedReceipt,url:'https://foreign.example/play/run'}})])assert.throws(()=>recordPerformanceLoadNativeTap(f.round.loadTimeline,receipt),/LOAD_TIMELINE|Expected/);
});

test('unsent and incomplete native input does not create trusted events or estimate an absent realm clock',()=>{
 const f=fixture(),unsent=recordPerformanceLoadNativeTap(f.round.loadTimeline,tapReceipt({completed:false,nativeNotSentReason:'disabled-before-native-input',nativeTiming:{preparationStartedAtEpochMs:1200,finishedAtEpochMs:1300,commandOutcome:'not-sent'},performanceScope:null,trustedReceipt:null}));
 assert.equal(unsent.commandDispatchedAtEpochMs,null);assert.equal(unsent.commandCompletedAtEpochMs,null);assert.equal(unsent.document.timeOrigin,null);assert.deepEqual(unsent.events,[]);assert.equal(unsent.completed,false);assert.equal(unsent.commandOutcome,'not-sent');
 const incomplete=tapReceipt();delete incomplete.trustedReceipt.documentTimeOrigin;incomplete.trustedReceipt.events[1].isTrusted=false;const row=recordPerformanceLoadNativeTap(f.round.loadTimeline,incomplete);assert.equal(row.events[1].isTrusted,false);assert.equal(row.events[1].epochMs,null);assert.equal(row.document.timeOrigin,null);
});

test('the original element receipt supplies timeOrigin for top-realm handoff and refuses a changed realm clock',()=>{
 let at=5;const listeners=new Map(),w={location:{href:entryUrl},performance:{timeOrigin:900,now:()=>at}},d={defaultView:w,visibilityState:'visible',hasFocus:()=>true,elementFromPoint:()=>element,addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type,fn){if(listeners.get(type)===fn)listeners.delete(type);}},element={ownerDocument:d,tagName:'BUTTON',disabled:false,getAttribute:()=>null,getBoundingClientRect:()=>({x:10,y:10,width:44,height:44})};
 const args={key:'owned-receipt',expectedUrl:entryUrl},installed=prepareOwnedNativeTapReceipt(element,args);assert.equal(installed.documentTimeOrigin,900);
 for(const type of ['pointerdown','pointerup','click']){at++;listeners.get(type)({target:element,isTrusted:true,clientX:20,clientY:20});}
 const original=readOwnedNativeTapReceipt(element,args);assert.equal(original.documentTimeOrigin,900);assert.deepEqual(original.events.map(e=>e.at),[6,7,8]);
 const f=fixture(),row=recordPerformanceLoadNativeTap(f.round.loadTimeline,tapReceipt({nativeRole:'player-entry',performanceScope:null,installation:installed,trustedReceipt:original}));assert.equal(row.document.url,entryUrl);assert.deepEqual(row.events.map(e=>e.epochMs),[906,907,908]);w.performance.timeOrigin=901;assert.throws(()=>readOwnedNativeTapReceipt(element,args),/IDENTITY_CHANGED/);removeOwnedNativeTapReceipt(element,args);assert.equal(listeners.size,0);
});

test('the original LOAD gate still uses elapsedMs, so fast playable with slow evidence cannot become a pass',async()=>{
 const thresholds=JSON.parse(await readFile(new URL('../specs/mobile-quality-v1.json',import.meta.url))).thresholds;
 const rounds=Array.from({length:5},(_,i)=>({game,cacheMode:'cold',cache:{passed:true},entry:{ready:true,elapsedMs:6000,actualPlayableMs:2000,evidenceCollectionAfterPlayableMs:4000},actions:[],cleanup:{passed:true},returned:true,pendingWork:0,network:{},observerErrors:[]}));
 const gate=evaluateAndroidPerformance(game,rounds,thresholds,{networkCalibrated:true}).gates.find(g=>g.id==='LOAD-cold');assert.equal(gate.status,'fail');assert.equal(gate.p95Ms,6000);assert.equal(thresholds.cold_entry_p95_ms,5000);assert.equal(thresholds.warm_entry_p95_ms,2500);
});
