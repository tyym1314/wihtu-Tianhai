import test from 'node:test';
import assert from 'node:assert/strict';
import {activityRoomState,canExercise,runContinuousActions} from '../scripts/mobile-continuous-driver.mjs';
import {playOneArenaAction} from '../scripts/android-game-actions.mjs';
const room=(game='match')=>({id:'room-a',game_id:game,status:'active',me:'a',me_last_seq:0,server_now:100,game:{status:'active',turnKey:'a',busyUntil:0}});
function driver(options={}){let time=0,current=room();const actions=[];return{actions,setRoom:r=>current=r,run:extra=>runContinuousActions({game:'match',roomId:'room-a',readRoom:()=>current,deadlineAt:6000,clock:()=>time,sleep:async ms=>time+=ms,minimumActionBudgetMs:1000,playAction:async controls=>{await controls.beforeAction();const before=current.me_last_seq;current.me_last_seq++;actions.push(time);return{roomId:current.id,sequenceBefore:before,sequenceAfter:current.me_last_seq};},...options,...extra})};}
test('continuous driver performs serial authority-confirmed actions without changing room',async()=>{const h=driver();const r=await h.run();assert.equal(r.reason,'deadline');assert.deepEqual(h.actions,[0,1000,2000,3000,4000,5000]);assert.equal(r.room_count,1);assert.equal(r.overrun_ms,0);});
test('driver stops immediately when room changes and never merges room durations',async()=>{const h=driver();h.setRoom({...room(),id:'room-b'});const r=await h.run();assert.equal(r.reason,'room-changed');assert.equal(h.actions.length,0);});
for(const [label,game]of [['finished',{status:'finished'}],['root forfeit',{forfeited:true}],['runner finished',{me:'a',players:[{key:'a',finishTick:5}]}],['eliminated',{players:[{key:'a',eliminated:true}]}],['bowler complete',{me:{completed:true}}]])test('driver preserves natural early finish: '+label,async()=>{const h=driver();h.setRoom({...room(),game});const r=await h.run();assert.equal(r.reason,'terminal');assert.equal(r.finished_at,0);assert.equal(h.actions.length,0);});
test('opponent turns are observed without submitting actions',async()=>{const r=room('ludo');r.game.turnKey='b';const h=driver({game:'ludo'});h.setRoom(r);const out=await h.run();assert.equal(out.actions.length,0);assert.equal(out.reason,'deadline');});
test('busy own player cannot trigger the helper',()=>{const r=room('bowling');r.game.me={busyUntil:200};assert.equal(canExercise('bowling',r),false);});
test('golf completed hole/intermission can resume only in the same room',()=>{const r=room('golf');r.game.me={completed:true,completedScores:[3]};assert.equal(activityRoomState(r,'golf','room-a'),'between-holes');r.game.me.completedScores=[3,3,3];assert.equal(activityRoomState(r,'golf','room-a'),'terminal');});
test('standing tower route without a new legal link does not leave helper waiting',()=>{const r=room('towerlink');r.game.legalActions=[{type:'unlink',from:0,to:1}];r.game.towers=[{id:0,troops:50}];assert.equal(canExercise('towerlink',r),false);});
test('near deadline driver does not begin a new gesture',async()=>{const h=driver();const r=await h.run({deadlineAt:500});assert.equal(r.actions.length,0);assert.equal(r.finished_at,500);});
test('pre-aborted driver never submits input',async()=>{const controller=new AbortController();controller.abort();const r=await driver({signal:controller.signal}).run();assert.equal(r.reason,'aborted');assert.equal(r.actions.length,0);});
test('authority guard is rechecked before actual input after a plan was chosen',async()=>{const h=driver();const r=await h.run({playAction:async controls=>{h.setRoom({...room(),status:'settled'});await controls.beforeAction();throw Error('must not execute');}});assert.equal(r.reason,'terminal');assert.equal(r.actions.length,0);assert.equal(r.rejections[0].code,'ACTION_STATE_CHANGED');});
test('driver drains an in-flight operation and reports overrun instead of returning with a live actor',async()=>{let time=0,drained=false;const r=await runContinuousActions({game:'match',roomId:'room-a',readRoom:()=>room(),deadlineAt:3000,clock:()=>time,sleep:async ms=>time+=ms,playAction:async()=>{time=3200;await Promise.resolve();drained=true;return{roomId:'room-a',sequenceBefore:0,sequenceAfter:1};}});assert(drained);assert.equal(r.overrun_ms,200);assert.equal(r.actions.length,1);});
test('unexpected action failure is retained and not retried to obtain a pass',async()=>{let calls=0;const r=await driver().run({playAction:async()=>{calls++;throw Object.assign(Error('physics fault'),{code:'PHYSICS_FAULT'});}});assert.equal(calls,1);assert.equal(r.reason,'action-failed');});
function uiHarness({enabled=true,onTap=()=>{},delayMs=0,status=200,bodyHang=false}={}){
 const listeners=new Map(),current=room('golf');let taps=0;
 const response={request:()=>({method:()=> 'POST',frame:()=>frame,postDataJSON:()=>({seq:1,action:{type:'shot'}})}),url:()=> 'http://localhost/api/pvp/rooms/room-a/action',status:()=>status,json:async()=>bodyHang?await new Promise(()=>{}):({...current,me_last_seq:1})};
 const target={isVisible:async()=>true,isEnabled:async()=>enabled,tap:async()=>{taps++;onTap();if(delayMs)await new Promise(r=>setTimeout(r,delayMs));listeners.get('response')?.(response);}};
 const page={on:(name,fn)=>listeners.set(name,fn),off:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}},frame={page:()=>page,locator:()=>target};
 return{frame,current,listeners,taps:()=>taps};
}
test('UI helper accepts old calls plus optional guard and exact next sequence',async()=>{const h=uiHarness();let guards=0;const r=await playOneArenaAction(h.frame,'golf',()=>h.current,{touch:true,beforeAction:()=>guards++});assert.equal(h.taps(),1);assert.equal(guards,1);assert.equal(r.sequenceAfter,1);assert.equal(h.listeners.size,0);});
test('UI helper cancellation before a gesture submits zero requests',async()=>{const h=uiHarness(),controller=new AbortController();controller.abort();await assert.rejects(()=>playOneArenaAction(h.frame,'golf',()=>h.current,{touch:true,signal:controller.signal}),{code:'ACTION_ABORTED'});assert.equal(h.taps(),0);});
test('UI helper checks authority immediately before the tap',async()=>{const h=uiHarness();await assert.rejects(()=>playOneArenaAction(h.frame,'golf',()=>h.current,{touch:true,beforeAction:()=>{throw Object.assign(Error('state changed'),{code:'ACTION_STATE_CHANGED'});}}),{code:'ACTION_STATE_CHANGED'});assert.equal(h.taps(),0);assert.equal(h.listeners.size,0);});
test('UI helper drains an already-started locator action on abort',async()=>{const controller=new AbortController(),h=uiHarness({delayMs:20,onTap:()=>controller.abort()});await assert.rejects(()=>playOneArenaAction(h.frame,'golf',()=>h.current,{touch:true,signal:controller.signal}),{code:'ACTION_ABORTED'});assert.equal(h.taps(),1);assert.equal(h.listeners.size,0);const taps=h.taps();await new Promise(r=>setTimeout(r,30));assert.equal(h.taps(),taps);});
test('UI helper readiness waiting ends at optional deadline without input',async()=>{const h=uiHarness({enabled:false});await assert.rejects(()=>playOneArenaAction(h.frame,'golf',()=>h.current,{touch:true,timeoutMs:20}),{code:'ACTION_DEADLINE'});assert.equal(h.taps(),0);});

test('expired authoritative turn does not authorize a new UI gesture',()=>{const r=room('ludo');r.game.turnDeadlineAt=100;assert.equal(canExercise('ludo',r),false);});

test('error response body waiting respects the helper deadline',async()=>{const h=uiHarness({status:409,bodyHang:true});await assert.rejects(()=>playOneArenaAction(h.frame,'golf',()=>h.current,{touch:true,timeoutMs:20}),{code:'ACTION_DEADLINE'});assert.equal(h.taps(),1);assert.equal(h.listeners.size,0);});

function inputFixture(){
 const current={...room('run'),practice:true,entry_minor:'0',game:{gameId:'run',me:'a',status:'active',ruleVersion:'pvp-run-v2.3.0',snapshotTick:30,
  players:[{key:'a',isBot:false,inputNo:2,finishTick:null},{key:'bot',isBot:true,inputNo:0,finishTick:null}]},
  run_inputs:{protocol:'run-practice-inputs-v1',ruleVersion:'pvp-run-v2.3.0',roomId:'room-a',playerKey:'a',clockEpoch:3,revision:7,headTick:30,serverTick:30,committedThroughTick:0,processedThroughCommandSeq:5,acceptedInputNo:2,decisions:[]}};
 const request={request_id:'exact_input_request',roomId:'room-a',playerKey:'a',clockEpoch:3,baseRevision:7,commands:[{commandSeq:6,type:'jump',executeTick:31}]};
 const after=structuredClone(current);after.request_id=request.request_id;Object.assign(after.run_inputs,{revision:8,processedThroughCommandSeq:6,acceptedInputNo:3,
  decisions:[{commandSeq:6,type:'jump',executeTick:31,clockEpoch:3,outcome:'accepted',code:null,acceptedInputNo:3,decidedAtServerTick:30,revision:8,duplicate:false}]});after.game.players[0].inputNo=3;
 return {current,request,after};
}
function inputUI({mutate=()=>{},method='POST',status=200,getFirst=false}={}){
 const f=inputFixture(),listeners=new Map();mutate(f);let taps=0;
 const page={on:(n,fn)=>listeners.set(n,fn),off:n=>listeners.delete(n)},frame={page:()=>page,locator:()=>({isVisible:async()=>true,isEnabled:async()=>true,tap:async()=>{
  taps++;const response=verb=>({url:()=> 'https://fixture.invalid/api/pvp/rooms/room-a/inputs',request:()=>({method:()=>verb,frame:()=>frame,postDataJSON:()=>f.request}),status:()=>status,json:async()=>f.after});
  if(getFirst)listeners.get('response')?.(response('GET'));listeners.get('response')?.(response(method));
 }})};return {...f,frame,listeners,taps:()=>taps};
}

test('V2.3 one UI gesture requires its exact POST decision and independent accepted counter',async()=>{
 const h=inputUI({getFirst:true}),r=await playOneArenaAction(h.frame,'run',()=>h.current,{touch:true});
 assert.equal(h.taps(),1);assert.equal(h.listeners.size,0);assert.equal(r.protocol,'run-practice-inputs-v1');
 assert.equal(r.sequenceBefore,5);assert.equal(r.sequenceAfter,6);assert.equal(r.inputEvidence.acceptedInputNoBefore,2);assert.equal(r.inputEvidence.acceptedInputNoAfter,3);
 assert.equal(r.inputEvidence.requestId,'exact_input_request');assert.equal(r.inputEvidence.executeTick,31);assert.equal(h.after.me_last_seq,0,'legacy wireSeq is not repurposed');
});
for(const [label,mutate]of [
 ['request id',f=>f.after.request_id='another_request'],['room',f=>f.request.roomId='another_room'],['player',f=>f.request.playerKey='other'],['epoch',f=>f.request.clockEpoch++],
 ['command gap',f=>f.request.commands[0].commandSeq++],['command type',f=>f.request.commands[0].type='left'],['missing tick',f=>delete f.request.commands[0].executeTick],
 ['extra command',f=>f.request.commands.push({...f.request.commands[0],commandSeq:7})],['missing decision',f=>f.after.run_inputs.decisions=[]],
 ['decision type',f=>f.after.run_inputs.decisions[0].type='left'],['decision tick',f=>f.after.run_inputs.decisions[0].executeTick++],['decision seq',f=>f.after.run_inputs.decisions[0].commandSeq++],
 ['decision epoch',f=>f.after.run_inputs.decisions[0].clockEpoch++],['decision duplicate',f=>f.after.run_inputs.decisions[0].duplicate=true],
 ['accepted number',f=>f.after.run_inputs.decisions[0].acceptedInputNo++],['outer counter',f=>f.after.run_inputs.acceptedInputNo++],['player counter',f=>f.after.game.players[0].inputNo++],
 ['cursor only GET-shaped body',f=>{delete f.after.request_id;f.after.run_inputs.decisions=[];}],['paid profile',f=>f.current.entry_minor='1000'],['wrong protocol',f=>f.current.run_inputs.protocol='unknown'],
 ['HTTP200 rejection',f=>Object.assign(f.after.run_inputs.decisions[0],{outcome:'rejected',code:'BUSY',acceptedInputNo:null})],
])test('V2.3 input evidence rejects '+label,async()=>{
 const h=inputUI({mutate});await assert.rejects(()=>playOneArenaAction(h.frame,'run',()=>h.current,{touch:true}),{code:'RUN_INPUT_PROOF_INVALID'});
 assert.ok(h.taps()<=1);assert.equal(h.listeners.size,0);
});
test('V2.3 GET cannot impersonate a POST ACK or cause another gesture',async()=>{
 const h=inputUI({method:'GET'});await assert.rejects(()=>playOneArenaAction(h.frame,'run',()=>h.current,{touch:true,timeoutMs:20}),/deadline/);
 assert.equal(h.taps(),1);assert.equal(h.listeners.size,0);
});
test('V2.3 HTTP and business rejections preserve the first body without a retry',async()=>{
 for(const status of [409,200]){const h=inputUI({status,mutate:f=>Object.assign(f.after.run_inputs.decisions[0],{outcome:'rejected',code:'BUSY',acceptedInputNo:null})});
  await assert.rejects(()=>playOneArenaAction(h.frame,'run',()=>h.current,{touch:true}),e=>e.status===status&&e.responseBody.run_inputs.decisions[0].code==='BUSY');assert.equal(h.taps(),1);
 }
});
