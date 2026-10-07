import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../arena/run/engine.mjs';
import {projectedPose,RUN_PROJECTION_LIMIT_MS} from '../arena/run/presentation.mjs';
import {createRunInputGuard,RUN_INPUT_FRESH_MS} from '../arena/run/input-readiness.mjs';
import {createRunInputPresentation,RUN_INPUT_RECONCILE_MS} from '../arena/run/input-presentation.mjs';

function fixture(){
 let time=0;
 const state=E.createState('02'.repeat(32),10000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]});
 let game=E.view(state,'p0');const model=createRunInputPresentation({now:()=>time});
 const sample=(at=time,elapsed=at)=>{time=at;const base=projectedPose(game.players[0],game,elapsed);return{base,visual:model.sample(base,{at,elapsed})};};
 const update=(next,at=time,options={})=>{time=at;game=next;return model.update(next,'p0',{roomId:'room-a',at,inputFreshUntil:at+RUN_INPUT_FRESH_MS,...options});};
 const dispatch=(type='jump',extra={})=>({token:'owner:1',roomId:'room-a',playerKey:'p0',request_id:'request_0001',seq:1,type,ruleVersion:game.ruleVersion,...extra});
 const receipt=(input,extra={})=>{const {token,...fields}=input;return{...fields,inputNo:1,acceptedTick:1,...extra};};
 update(game);sample(0);
 return{model,state,dispatch,receipt,sample,update,setTime:value=>{time=value},game:()=>game};
}

for(const type of ['left','right','jump','slide'])test(type+' changes only render pose/clip on the next local frame before ACK',()=>{
 const f=fixture(),before=JSON.stringify(f.game());assert.equal(f.model.beginInput(f.dispatch(type)),true);
 const {base,visual}=f.sample(16);
 if(type==='jump')assert.ok(visual.y>0);
 else if(type==='slide')assert.equal(visual.visualAction.type,'slide');
 else assert.equal(Math.sign(visual.x),type==='left'?-1:1);
 assert.equal(visual.feedback.state,'predicted');assert.equal(visual.feedback.startedAt,0);
 assert.deepEqual(Object.keys(visual).sort(),['feedback','visualAction','x','y']);assert.equal(JSON.stringify(f.game()),before);
 assert.equal(base.distance,16*.008);assert.equal(f.game().players[0].inputNo,0);
});

for(const ackMs of [300,450])test(`a ${ackMs}ms exact ACK preserves the already visible motion until applied authority arrives`,()=>{
 const f=fixture(),input=f.dispatch('jump');f.model.beginInput(input);f.sample(16);
 const result=E.act(f.state,'p0',{type:'jump',observed_tick:0},10000+ackMs/2);
 f.setTime(ackMs);const before=f.sample(ackMs).visual;
 assert.equal(f.model.acceptInput({token:input.token,receipt:f.receipt(input,{acceptedTick:result.event.acceptedTick})}),true);
 f.update(E.view(f.state,'p0'),ackMs);const confirmed=f.sample(ackMs,0).visual;
 assert.equal(confirmed.y,before.y);assert.equal(confirmed.feedback.state,'confirmed');
 E.tick(f.state,10000+ackMs+100);const applied=E.view(f.state,'p0'),frozen=JSON.stringify(applied);
 f.update(applied,ackMs+100);f.sample(ackMs+100,0);
 const {base,visual}=f.sample(ackMs+100+RUN_INPUT_RECONCILE_MS,RUN_INPUT_RECONCILE_MS);
 assert.equal(visual.x,base.x);assert.equal(visual.y,base.y);assert.equal(f.model.state().active,0);assert.equal(JSON.stringify(applied),frozen);
});

test('only a dispatched identity in the current room/player/profile can begin',()=>{
 for(const change of [{roomId:'other'},{playerKey:'other'},{ruleVersion:'unknown'},{request_id:''},{seq:0},{type:'item'},{type:'boost'},{token:''}]){
  const f=fixture();assert.equal(f.model.beginInput(f.dispatch('jump',change)),false);
 }
 const f=fixture(),input=f.dispatch();assert.equal(f.model.beginInput(input),true);assert.equal(f.model.beginInput(f.dispatch('left',{token:'owner:2'})),false);f.model.cancelInput(input.token);assert.equal(f.model.beginInput(input),false,'Cancelled tokens cannot be reused');
});

for(const field of ['roomId','playerKey','request_id','seq','type','ruleVersion','inputNo','acceptedTick'])test('receipt mismatch '+field+' cannot confirm or prolong a prediction',()=>{
 const f=fixture(),input=f.dispatch();f.model.beginInput(input);const receipt=f.receipt(input);receipt[field]=typeof receipt[field]==='number'?999:receipt[field]+'x';
 assert.equal(f.model.acceptInput({token:input.token,receipt}),false);assert.equal(f.model.state().active,0);assert.equal(f.sample(20).visual.y,0);
});
test('missing receipt cancels; unrelated late token cannot cancel a newer dispatch',()=>{
 const f=fixture(),first=f.dispatch();f.model.beginInput(first);assert.equal(f.model.acceptInput({token:first.token}),false);
 const next=f.dispatch('left',{token:'owner:2',request_id:'request_0002'});assert.equal(f.model.beginInput(next),true);
 assert.equal(f.model.acceptInput({token:first.token,receipt:f.receipt(first)}),false);assert.equal(f.model.state().active,1);
});

test('an applied snapshot arriving before HTTP ACK takes over without treating inputNo alone as an HTTP receipt',()=>{
 const f=fixture(),input=f.dispatch();f.model.beginInput(input);f.sample(100);E.act(f.state,'p0',{type:'jump',observed_tick:0},10050);E.tick(f.state,10200);
 f.update(E.view(f.state,'p0'),200);assert.equal(f.model.state().active,0);
 assert.equal(f.model.acceptInput({token:input.token,receipt:f.receipt(input,{acceptedTick:4})}),false);
 f.sample(200,0);const {base,visual}=f.sample(300,100);assert.equal(base.y,visual.y);
});

test('confirmed jump and the next admitted lateral action retain independent visual axes without an execution queue',()=>{
 const f=fixture(),jump=f.dispatch();f.model.beginInput(jump);f.sample(100);f.setTime(150);f.model.acceptInput({token:jump.token,receipt:f.receipt(jump)});
 const lane=f.dispatch('left',{token:'owner:2',request_id:'request_0002',seq:2});assert.equal(f.model.beginInput(lane),true);
 const visual=f.sample(200).visual;assert.ok(visual.x<0);assert.ok(visual.y>0);assert.equal(visual.visualAction.type,'jump');assert.equal(f.model.state().active,2);
});

test('a lateral prediction during an authoritative jump preserves height and leaves its native jump clip in control',()=>{
 const f=fixture();E.act(f.state,'p0',{type:'jump',observed_tick:0},10000);E.tick(f.state,10200);f.update(E.view(f.state,'p0'),200);f.sample(200,0);
 assert.equal(f.model.beginInput(f.dispatch('left')),true);const {base,visual}=f.sample(216,16);
 assert.ok(base.y>0);assert.equal(visual.y,base.y);assert.ok(visual.x<0);assert.equal(visual.visualAction,null);
});

test('late-token cancellation and another axis rejection do not erase authority reconciliation',()=>{
 const f=fixture(),jump=f.dispatch();f.model.beginInput(jump);f.sample(100);E.act(f.state,'p0',{type:'jump',observed_tick:0},10050);E.tick(f.state,10200);f.update(E.view(f.state,'p0'),200);f.sample(200,0);
 assert.equal(f.model.state().correcting,true);f.model.cancelInput(jump.token,'receipt-arrived-after-snapshot');assert.equal(f.model.state().correcting,true);
 const lane=f.dispatch('left',{token:'owner:2',request_id:'request_0002',seq:2});assert.equal(f.model.beginInput(lane),true);f.model.cancelInput(lane.token,'rejected');assert.equal(f.model.state().correcting,true);
 const intermediate=f.sample(250,50);assert.notEqual(intermediate.visual.y,intermediate.base.y);
 const final=f.sample(300,100);assert.equal(final.visual.y,final.base.y);assert.equal(f.model.state().correcting,false);
});

for(const reason of ['rejected','unresolved','disconnect','background'])test(reason+' immediately restores authority with no residual correction',()=>{
 const f=fixture(),input=f.dispatch();f.model.beginInput(input);f.sample(100);f.model.cancelInput(input.token,reason);
 const {base,visual}=f.sample(101);assert.equal(visual.x,base.x);assert.equal(visual.y,base.y);assert.equal(f.model.state().correcting,false);
});

for(const mutate of [p=>{p.fallStartTick=1;p.fallUntilTick=91;},p=>{p.hits++;p.stunUntilTick=80;},p=>{p.finishTick=1;},p=>{p.forfeited=true;}])test('authoritative injury/finish/forfeit interrupts predictions on the next frame',()=>{
 const f=fixture(),input=f.dispatch('left');f.model.beginInput(input);f.sample(100);
 const next=structuredClone(f.game());next.snapshotTick=6;mutate(next.players[0]);f.update(next,100);const {base,visual}=f.sample(101,1);
 assert.equal(visual.x,base.x);assert.equal(visual.y,base.y);assert.equal(visual.feedback,null);
});
test('a new respawn event interrupts even when the latest snapshot is already recovered',()=>{
 const f=fixture();f.model.beginInput(f.dispatch('left'));f.sample(100);const next=structuredClone(f.game());next.snapshotTick=6;next.events=[{id:1,playerKey:'p0',type:'respawn'}];f.update(next,100);assert.equal(f.model.state().active,0);
});

test('same-tick polling and a receipt never renew the input admission deadline',()=>{
 const f=fixture(),input=f.dispatch();f.model.beginInput(input);f.setTime(300);f.model.acceptInput({token:input.token,receipt:f.receipt(input)});f.update(structuredClone(f.game()),600);
 assert.ok(f.sample(649).visual.y>0);assert.ok(f.sample(650).visual.feedback);assert.ok(f.sample(1499).visual.feedback);
 assert.equal(f.sample(1500).visual.feedback,null);assert.equal(f.model.state().reason,'stale');
});
test('unconfirmed prediction expires after 650ms even while unrelated new authority ticks arrive',()=>{
 const f=fixture(),input=f.dispatch();f.model.beginInput(input);const next=structuredClone(f.game());next.snapshotTick=30;f.update(next,500);f.sample(649,149);assert.equal(f.sample(650,150).visual.y,0);
 assert.equal(f.model.state().reason,'unconfirmed-expired');assert.equal(f.model.acceptInput({token:input.token,receipt:f.receipt(input)}),false);
});
test('forward phase carry cannot erase a newly dispatched legal input at the first frame',()=>{
 for(const at of [649,650,729.0667]){
  const f=fixture();f.setTime(at);assert.equal(f.model.beginInput(f.dispatch()),true);
  const first=f.sample(at+16.7,at+16.7);
  assert.ok(first.visual.y>0);assert.equal(first.visual.feedback.state,'predicted');
  assert.equal(first.base.distance,Math.min(at+16.7,RUN_PROJECTION_LIMIT_MS)*.008,'forward projection still stops at650ms');
  assert.equal(f.sample(at+650).visual.feedback,null,'unconfirmed dispatch still expires after650ms');
 }
});

test('input presentation uses the guard deadline including server age and cannot renew it on duplicate reads',()=>{
 const f=fixture(),guard=createRunInputGuard(),g=f.game();
 guard.receive(g,g.serverNow+875,100);guard.sceneReady(true);
 const next=structuredClone(g);next.snapshotTick++;next.serverNow+=1000/60;
 guard.receive(next,next.serverNow+875,100);
 const freshness=guard.current(100);assert.equal(freshness.freshUntil,725);
 f.update(next,100,{inputFreshUntil:freshness.freshUntil});f.sample(700,600);
 f.setTime(708.3);assert.equal(guard.current(708.3).ready,true);assert.equal(f.model.beginInput(f.dispatch()),true);
 assert.ok(f.sample(724.9,649).visual.feedback);
 f.update(next,724.9,{inputFreshUntil:2224.9});
 assert.equal(guard.current(725).ready,false);assert.equal(f.sample(725,650).visual.feedback,null);
 assert.equal(f.model.state().reason,'stale');
});

test('missing, nonfinite or overlong input freshness cannot authorize a render prediction',()=>{
 for(const inputFreshUntil of [undefined,NaN,Infinity,-Infinity,1500.01]){
  const f=fixture(),next=structuredClone(f.game());next.snapshotTick++;
  f.update(next,0,{inputFreshUntil});f.sample(0);
  assert.equal(f.model.beginInput(f.dispatch()),false);
 }
});

test('an old RAF timestamp cannot extend the absolute input or unconfirmed deadline',()=>{
 for(const {dispatchAt,callbackAt,frameAt} of [
  {dispatchAt:1000,callbackAt:1520,frameAt:1499.5},
  {dispatchAt:500,callbackAt:1151,frameAt:1149.5},
 ]){
  const f=fixture();f.setTime(dispatchAt);assert.equal(f.model.beginInput(f.dispatch()),true);
  f.setTime(callbackAt);
  const visual=f.model.sample(projectedPose(f.game().players[0],f.game(),frameAt),{at:frameAt});
  assert.equal(visual.feedback,null);
 }
});
test('new authority past an accepted tick without its applied watermark fails closed',()=>{
 const f=fixture(),input=f.dispatch();f.model.beginInput(input);f.model.acceptInput({token:input.token,receipt:f.receipt(input)});const next=structuredClone(f.game());next.snapshotTick=2;f.update(next,40);assert.equal(f.model.state().active,0);assert.equal(f.model.state().reason,'inconsistent-authority');
});
test('unknown rule or physics profiles never predict; scene owner change/disposal cannot revive old ACKs',()=>{
 for(const change of [{ruleVersion:'future'},{physicsVersion:'future'}]){const f=fixture();f.update({...f.game(),...change});f.sample();assert.equal(f.model.beginInput(f.dispatch()),false);}
 for(const change of [{roomId:'room-b'},null]){
  const f=fixture(),input=f.dispatch();f.model.beginInput(input);if(change)f.update(f.game(),100,change);else f.model.dispose();
  assert.equal(f.model.acceptInput({token:input.token,receipt:f.receipt(input)}),false);assert.equal(f.model.state().active,0);
 }
 const f=fixture(),input=f.dispatch();f.model.beginInput(input);f.model.suspend();assert.equal(f.model.beginInput(f.dispatch('left',{token:'owner:2'})),false);assert.equal(f.model.acceptInput({token:input.token,receipt:f.receipt(input)}),false);
});

for(const ruleVersion of [E.RULE_VERSION,E.PRACTICE_RULE_VERSION])test(ruleVersion+' can render a dispatched action without modifying even deeply frozen authority',()=>{
 const f=fixture(),game={...f.game(),ruleVersion};
 const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};freeze(game);
 f.update(game);f.sample();const original=JSON.stringify(game),input=f.dispatch('left');assert.equal(f.model.beginInput(input),true);assert.ok(f.sample(16).visual.x<0);
 assert.equal(f.model.acceptInput({token:input.token,receipt:f.receipt(input)}),true);assert.equal(JSON.stringify(game),original);
});
