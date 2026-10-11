import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {arenaFeedbackPlanForInput,arenaFeedbackInputFrame,visibleFeedbackScopeForRound,capturePerformanceVisibleFeedbackPhase,partitionPerformanceRoundActions} from '../scripts/android-player-performance.mjs';
import {playOneArenaAction} from '../scripts/android-game-actions.mjs';
import {createState,legalMoves} from '../arena/match/engine.mjs';
import {VISIBLE_FEEDBACK_PROTOCOL_SHA256} from '../scripts/android-player-visible-feedback.mjs';

const origin='https://owned-arena.example',topUrl=origin+'/player',nonce='own-native-proof',documentId='a'.repeat(32),epoch=1791700000000;
const room=game=>({id:'own-room',game_id:game,me:'human',me_last_seq:10,status:'active',game:{phase:game==='jackaroo'?'exchange':'aiming'}});
const board=createState('12'.repeat(32),0).players.player_1.board,move=legalMoves(board)[0];
const variants=[['golf',{testId:'golf-shoot'},'shot'],['bowling',{testId:'bowling-roll'},'roll'],['carrom',{testId:'carrom-shoot'},'shot'],['pool',{testId:'pool-shoot'},'shot'],['ludo',{action:'ludo-roll'},'roll'],['ludo',{action:'ludo-move'},'move'],['jackaroo',{action:'jack-confirm'},'pass'],['domino',{testId:'domino-left'},'play'],['domino',{testId:'domino-draw'},'draw'],['domino',{testId:'domino-pass'},'pass'],['match',{selectedCell:move.from,cell:move.to},'swap']];
test('only actual final submitting controls select their own typed feedback plan; preparation and invalid swaps remain unarmed',()=>{
 for(const [game,descriptor,type]of variants){const r=room(game);if(game==='match')r.game.board=board;const p=arenaFeedbackPlanForInput({game,kind:'tap',descriptor,room:r});assert.equal(p.game,game);assert.equal(p.actionType,type);assert.equal(p.locale,'zh');}
 for(const game of ['darts','towerlink'])assert.equal(arenaFeedbackPlanForInput({game,kind:'drag',room:room(game)}).gesture,'release');
 for(const [game,descriptor]of [['jackaroo',{testId:'jack-card'}],['domino',{testId:'domino-tile-1'}],['pool',{testId:'pool-board'}],['match',{cell:move.from}],['match',{selectedCell:move.from,cell:move.from}],['ludo',{action:'select-pawn'}]]){const r=room(game);if(game==='match')r.game.board=board;assert.equal(arenaFeedbackPlanForInput({game,kind:'tap',descriptor,room:r}),null);}
 assert.throws(()=>arenaFeedbackPlanForInput({game:'golf',kind:'tap',descriptor:variants[0][1],room:room('pool')}),/OWN_ACTIVE_ROOM_REQUIRED/);
 for(const game of ['run','slot','aviator'])assert.throws(()=>arenaFeedbackPlanForInput({game,kind:'tap',room:room(game)}),/GAME_UNSUPPORTED/);
});

function inputFixture(game,descriptors={}){
 const calls=[],page=new EventEmitter();page.mouse={down:async()=>calls.push('original-down'),up:async()=>calls.push('original-up'),move:async()=>calls.push('original-move')};
 const frame={page:()=>page,locator:selector=>({isVisible:async()=>true,isEnabled:async()=>true,evaluate:async()=>descriptors[selector]??{},scrollIntoViewIfNeeded:async()=>calls.push('original-ui-scroll:'+selector),tap:async()=>calls.push('original-tap:'+selector)})};return {frame,page,calls};
}
test('the existing UI driver keeps its exact own-frame POST/ACK through the observation proxy and removes listeners on rejection',async()=>{
 for(const rejected of [false,true]){
  const f=inputFixture('golf',{'[data-testid="golf-shoot"]':{testId:'golf-shoot'}}),r=room('golf');let preparations=0;
  const wrapped=arenaFeedbackInputFrame({frame:f.frame,game:'golf',readRoom:()=>r,beforeSubmit:async plan=>{assert.equal(plan.actionType,'shot');preparations++;f.calls.push('start-original-capture');}});
  f.frame.locator=selector=>({isVisible:async()=>true,isEnabled:async()=>true,evaluate:async()=>({testId:'golf-shoot'}),scrollIntoViewIfNeeded:async()=>f.calls.push('original-ui-scroll'),tap:async()=>{f.calls.push('original-native-tap');f.page.emit('response',{url:()=>origin+'/api/pvp/rooms/own-room/action',request:()=>({method:()=> 'POST',frame:()=>f.frame,postDataJSON:()=>({seq:11,action:{type:'shot'}})}),status:()=>rejected?409:200,json:async()=>rejected?{error:{code:'BUSY'}}:{room:{...r,me_last_seq:11}}});}});
  const act=()=>playOneArenaAction(wrapped.frame,'golf',()=>r,{touch:true,timeoutMs:500});
  if(rejected)await assert.rejects(act,e=>e.status===409&&e.code==='BUSY'&&e.requestBody.seq===11);else assert.equal((await act()).sequenceAfter,11);
  assert.equal(preparations,1);assert.deepEqual(f.calls,['original-ui-scroll','start-original-capture','original-native-tap']);assert.equal(f.page.listenerCount('response'),0);wrapped.assertClosed();
 }
});
test('card preparation passes unchanged and drag capture arms before the original down, with no fabricated input',async()=>{
 const f=inputFixture('jackaroo',{card:{},confirm:{action:'jack-confirm'}}),plans=[],wrapped=arenaFeedbackInputFrame({frame:f.frame,game:'jackaroo',readRoom:()=>room('jackaroo'),beforeSubmit:async p=>{plans.push(p);f.calls.push('capture');}});
 await wrapped.frame.locator('card').tap();assert.equal(plans.length,0);await wrapped.frame.locator('confirm').tap();assert.equal(plans[0].actionType,'pass');assert.deepEqual(f.calls,['original-tap:card','original-ui-scroll:confirm','capture','original-tap:confirm']);await assert.rejects(()=>wrapped.frame.locator('confirm').tap(),/MULTIPLE_SUBMISSIONS/);
 const d=inputFixture('darts'),drag=arenaFeedbackInputFrame({frame:d.frame,game:'darts',readRoom:()=>room('darts'),beforeSubmit:async p=>{assert.equal(p.actionType,'throw');d.calls.push('capture');}});await drag.frame.page().mouse.move(1,2);await drag.frame.page().mouse.down();await drag.frame.page().mouse.up();assert.deepEqual(d.calls,['original-move','capture','original-down','original-up']);
});

function phaseFixture(game,descriptor,kind='tap'){
 const input=inputFixture(game,{final:descriptor}),r={id:game+'-cold',game,measurementPhase:'before',documentId,documentTimeOrigin:epoch,context:{frameId:'own-'+game,contextId:7,url:origin+'/play/'+game},actions:[]},own={nonce,documentId,timeOrigin:epoch,url:r.context.url};let clock=0,plan;
 const tree={frame:{id:'top',loaderId:'top-loader',url:topUrl},childFrames:[{frame:{id:r.context.frameId,parentId:'top',loaderId:'own-loader',url:r.context.url}}]},requests=[],actions=[],calls=[];
 const capture={schema:'owned-visible-feedback-capture-v1',phase:'feedbackProof',phaseId:r.id+'-feedback-1',before:{at:0},after:{at:300},frames:[{index:1,pngSha256:'b'.repeat(64),sink:{path:'own-original-1.png'}},{index:2,pngSha256:'c'.repeat(64),sink:{path:'own-original-2.png'}}],started:true,closed:false,errors:[],dropped:0};
 const collector={cdp:{send:async()=>({frameTree:tree})},bind:async()=>r.context,actions,actionRequestDiagnostics:()=>requests,evaluate:async expression=>{
  if(expression.includes('function beginOwnedMotionProof')){calls.push('begin-own-proof');return {};}
  if(expression.includes('function installOwnedArenaFeedbackObservation')){calls.push('install-own-observer');return {};}
  if(expression.includes('function readOwnedArenaFeedbackObservation')){calls.push('remove-own-observer');return {schema:'owned-visible-arena-feedback-observation-v1',scope:capture.scope,plan,removed:true,presentations:[]};}
  if(expression==='globalThis.__oasisOwnedMotionProof.stop()'){calls.push('stop-own-proof');return {phase:'feedbackProof',closed:true,dropped:0,owner:own};}
  assert.fail('Unexpected realm expression');
 }};
 const args={round:r,collector,origin,nonce,topUrl,protocol:{available:true,receipt:{schema:'visible-feedback-official-protocol-v1',sha256:VISIBLE_FEEDBACK_PROTOCOL_SHA256}},readTop:async()=>({}),arenaFrame:input.frame,readRoom:()=>({...room(game),game:{...room(game).game,...(game==='match'?{board}:{})}}),readAuthority:()=>({source:'Original retained response only'}),writeFrame:async()=>assert.fail('Lifecycle stubs cannot manufacture PNG evidence'),wait:async()=>{},now:()=>epoch+(clock+=10),createCapture:async parameters=>{assert.equal(r.measurementPhase,'feedbackProof');assert.equal(parameters.session,collector.cdp);plan=parameters.arenaPlan;assert.equal(plan.game,game);capture.scope=parameters.scope;calls.push('capture-original-png');return {capture,close:async()=>{calls.push('close-original-png');capture.closed=true;return capture;}};},runAction:async frame=>{if(kind==='drag'){await frame.page().mouse.down();await frame.page().mouse.up();}else await frame.locator('final').tap();requests.push({frameId:r.context.frameId,requestStartedEpochMs:epoch+60,requestSha256:'e'.repeat(64)});actions.push({accepted:true,requestSha256:'e'.repeat(64),gestureCompletedEpochMs:epoch+55,requestStartedEpochMs:epoch+60,responseFinishedEpochMs:epoch+150});return {actionType:plan.actionType,sequenceBefore:10,sequenceAfter:11};},drainOriginal:async()=>calls.push('drain-original-ack')};return {args,r,capture,calls,collector,input,tree};
}
test('ten real game dispatches isolate their own proof before continuous, retain ACK/request association and refuse missing PNGs',async()=>{
 const seen=new Set();for(const [game,descriptor]of variants){if(seen.has(game))continue;seen.add(game);const f=phaseFixture(game,descriptor),entry=await capturePerformanceVisibleFeedbackPhase(f.args);assert.equal(entry.plan.game,game);assert.equal(entry.acceptedActions.length,1);assert.equal(entry.originalRequests.length,1);assert.equal(entry.finalized,true);assert.equal(entry.analysis.status,'insufficient','A lifecycle test without original pixels never satisfies display feedback');assert.equal(f.r.measurementPhase,'before');assert.equal(f.r.sampleBoundaries,undefined);assert.deepEqual(f.calls,['begin-own-proof','install-own-observer','capture-original-png','drain-original-ack','remove-own-observer','close-original-png','stop-own-proof']);f.r.actions=f.collector.actions;partitionPerformanceRoundActions(f.r);assert.equal(f.r.actions.length,0);assert.equal(f.r.actionPhases.feedbackProof.length,1);}
 for(const game of ['darts','towerlink']){const f=phaseFixture(game,{},'drag'),entry=await capturePerformanceVisibleFeedbackPhase(f.args);assert.equal(entry.plan.game,game);assert.equal(entry.analysis.status,'insufficient');assert.equal(entry.finalized,true);seen.add(game);}assert.equal(seen.size,10);
});
test('real Pool placement/call preparation stays outside shot capture and cannot supply its feedback ACK',async()=>{
 const f=phaseFixture('pool',{testId:'pool-shoot'}),shot=f.args.runAction;let attempts=0;
 f.args.runAction=async frame=>{attempts++;if(attempts===3)return shot(frame);const type=attempts===1?'place':'call';await frame.locator('pool-board').tap();assert.equal(f.calls.length,0,'Preparation sends no capture/observer');f.collector.actions.push({accepted:true,requestSha256:String(attempts).repeat(64),gestureCompletedEpochMs:epoch-120+attempts*10,requestStartedEpochMs:epoch-119+attempts*10,responseFinishedEpochMs:epoch-100+attempts*10});return {actionType:type,sequenceBefore:8+attempts-1,sequenceAfter:8+attempts};};
 const entry=await capturePerformanceVisibleFeedbackPhase(f.args);assert.equal(attempts,3);assert.deepEqual(entry.preparatoryUiActions.map(a=>a.actionType),['place','call']);assert.equal(entry.uiAction.actionType,'shot');assert.equal(entry.acceptedActions.length,1);assert.equal(entry.acceptedActions[0].requestSha256,'e'.repeat(64));assert.equal(entry.originalRequests.length,1);assert.equal(entry.analysis.status,'insufficient');
 f.r.sampleBoundaries={start:{epochMs:epoch+1000},end:{epochMs:epoch+2000}};f.r.actions=f.collector.actions;partitionPerformanceRoundActions(f.r);assert.equal(f.r.actionPhases.feedbackProof.length,1);assert.equal(f.r.actionPhases.before.length,2);assert.equal(f.r.actions.length,0);
});
test('arena phase preserves the exact fatal action/ERR_ABORTED before independent close failures and makes no input without protocol',async()=>{
 const f=phaseFixture('golf',{testId:'golf-shoot'}),first=Object.assign(Error('net::ERR_ABORTED original action'),{code:'ERR_ABORTED'});f.args.runAction=async frame=>{await frame.locator('final').tap();throw first;};const create=f.args.createCapture;f.args.createCapture=async p=>{const c=await create(p);c.close=async()=>{f.calls.push('failed-original-close');throw Error('secondary original capture close');};return c;};
 await assert.rejects(()=>capturePerformanceVisibleFeedbackPhase(f.args),e=>e===first);const entry=f.r.visibleFeedbackPhases[0];assert.equal(entry.actionError.code,'ERR_ABORTED');assert.equal(entry.finalized,false);assert.equal(entry.analysis.status,'insufficient');assert.ok(entry.errors.some(e=>e.message==='secondary original capture close'));assert.ok(f.calls.includes('remove-own-observer'));assert.ok(f.calls.includes('stop-own-proof'));assert.equal(f.r.measurementPhase,'before');
 const no=phaseFixture('golf',{testId:'golf-shoot'});no.args.protocol={available:false,error:'Original official receipt absent'};assert.equal((await capturePerformanceVisibleFeedbackPhase(no.args)).analysis.status,'insufficient');assert.deepEqual(no.input.calls,[]);assert.deepEqual(no.calls,[]);
 const active=phaseFixture('golf',{testId:'golf-shoot'});active.r.sampleBoundaries={start:{epochMs:epoch}};await assert.rejects(()=>capturePerformanceVisibleFeedbackPhase(active.args),/DURING_CONTINUOUS_REFUSED/);
});
test('explicit arena scope cannot substitute another game, default realm or loader/frame',()=>{
 const f=phaseFixture('golf',{testId:'golf-shoot'}),plan=arenaFeedbackPlanForInput({game:'golf',kind:'tap',descriptor:{testId:'golf-shoot'},room:room('golf')}),args={tree:f.tree,context:f.r.context,round:f.r,origin,nonce,topUrl,arenaPlan:plan};assert.equal(visibleFeedbackScopeForRound(args).frameId,'own-golf');
 for(const change of [{arenaPlan:null},{arenaPlan:{...plan,game:'bowling'}},{context:{...f.r.context,contextId:8}},{context:{...f.r.context,url:origin+'/play/run'}},{tree:{...f.tree,childFrames:[]}}])assert.throws(()=>visibleFeedbackScopeForRound({...args,...change}));
});
