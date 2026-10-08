import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRunSelfProjection,RUN_SELF_PROJECTION_SCHEMA} from '../arena/run/self-projection.mjs';
import {resolveRunCourse} from '../arena/run/courses.mjs';
import {RUN_PROJECTION_LIMIT_MS} from '../arena/run/presentation.mjs';

// This is the complete pre-extraction engine, not the shared predictor step.
// Keep its original bytes hashed; only resolve its imports in memory.
const source=await readFile(new URL('./fixtures/run-engine-before-runner-physics.mjs',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'0c102a4160114510e20959a9f276186be5867247e93c4d1bfe5c098706b4c5e8');
const oracleBase=new URL('../arena/run/engine.mjs',import.meta.url);
const resolved=source.replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,oracleBase).href}'`)+ '\n//# sourceURL=run-self-projection-full-engine-oracle.mjs';
const E=await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const clone=value=>structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-7,`${message}: ${actual} != ${expected}`);
function state(index=0,version=E.RULE_VERSION){
 const s=E.createState(index.toString(16).padStart(8,'0').padEnd(64,'0'),1000,{ruleVersion:version,startPolicy:E.RUN_SCENE_READY_POLICY,players:[{key:'self',seatIndex:0},{key:'other',seatIndex:1,isBot:true}]});
 E.armStart(s,1000);E.tick(s,s.startedAt);return s;
}
function place(s,distance,lane=1,tick=500){
 s.tick=tick;s.now=s.startedAt+Math.ceil(tick*1000/60);
 const p=s.players[0];p.distanceU=Math.round(distance*300);p.checkpointU=Math.floor(distance/30)*9000;p.lane=lane;p.fromLane=lane;return p;
}
function view(s,key='self'){
 const game=E.view(s,key),p=s.players.find(p=>p.key===key);
 game.selfPrediction={schema:RUN_SELF_PROJECTION_SCHEMA,resolvedObstacles:[...p.resolvedObstacles],pendingInput:clone(p.pendingInput),lastInputTick:p.lastInputTick};
 return game;
}
function update(model,game,roomVersion=1,roomId='room',key='self'){return model.update(game,key,{roomId,roomVersion});}
function visual(s){
 const p=s.players[0],pose=E.pose(p,s.tick);let y=pose.y,scale=1;
 if(p.fallUntilTick!==null){const progress=Math.max(0,Math.min(1,(s.tick-p.fallStartTick)/90));y=-Math.min(2.4,progress*5);scale=Math.max(.15,1-progress*.9);}
 return{x:pose.x,y,scale,sliding:pose.sliding,distance:p.distanceU/300,checkpoint:p.checkpointU/300,inventory:p.inventory,hits:p.hits,appliedInputNo:p.appliedInputNo,
  fallStartTick:p.fallStartTick,fallUntilTick:p.fallUntilTick,stunUntilTick:p.stunUntilTick,immuneUntilTick:p.immuneUntilTick,shieldUntilTick:p.shieldUntilTick,boostUntilTick:p.boostUntilTick,finishTick:p.finishTick,claimedItemCount:p.claimedItems.length,resolvedObstacleCount:p.resolvedObstacles.length};
}
function differential(s,label='scenario'){
 const game=freeze(view(s)),before=JSON.stringify(game),model=createRunSelfProjection();
 assert.equal(update(model,game),true,label);
 const reference=clone(s),steps=Math.min(39,s.endTick-s.tick);
 for(let offset=0;offset<=steps;offset++){
  if(offset)E.testing.step(reference);
  const actual=model.sample(offset*1000/60),expected=visual(reference);
  const canonical=model.stateAtTick(reference.tick);
  for(const [field,value]of Object.entries(canonical)){if(field==='tick')assert.equal(value,reference.tick);else assert.deepEqual(value,reference.players[0][field],`${label} canonical ${reference.tick} ${field}`);}
  for(const [field,value]of Object.entries(expected))typeof value==='number'?near(actual[field],value,`${label} tick ${reference.tick} ${field}`):assert.equal(actual[field],value,`${label} tick ${reference.tick} ${field}`);
  near(actual.tick,reference.tick,`${label} tick`);
 }
 assert.equal(JSON.stringify(game),before,'frozen authoritative input was not changed');
 return model;
}

test('all six V2.1 and V2.2 routes match the independent complete engine at 40 integer samples',()=>{
 for(const version of [E.RULE_VERSION,E.PRACTICE_RULE_VERSION])for(let index=0;index<6;index++)differential(state(index,version),`${version} course ${index}`);
});
test('accepted next-tick inputs, including item use, match the full engine without inventing an ACK',()=>{
 for(const type of ['left','right','jump','slide','shield','boost']){
  const s=state(),p=place(s,31);
  if(type==='shield'||type==='boost')p.inventory=type;
  E.act(s,'self',{type},s.now);const model=differential(s,type);
  assert.equal(model.sample(0).appliedInputNo,0);assert.equal(model.sample(1000/60).appliedInputNo,1);
 }
 const noInput=differential(state(),'no accepted input');assert.equal(noInput.sample(650).appliedInputNo,0);
});
test('obstacle hit, shield use, immunity, jumping and beam sliding match every integer step',()=>{
 for(const mode of ['hit','shield','immune','jump','slide']){
  const s=state(),course=resolveRunCourse(s),obstacle=course.obstacles.find(o=>o.type===(mode==='slide'?'beam':'crate'));
  const p=place(s,obstacle.z-obstacle.depth/2-.27-.05,obstacle.lane);
  if(mode==='shield')p.shieldUntilTick=s.tick+100;
  if(mode==='immune')p.immuneUntilTick=s.tick+60;
  if(mode==='jump')p.jumpStartTick=s.tick-24;
  if(mode==='slide')p.slideUntilTick=s.tick+30;
  differential(s,mode);
 }
});
test('all route gaps, fall animation and checkpoint respawn follow integer authority',()=>{
 for(let index=0;index<6;index++){
  const s=state(index),gap=resolveRunCourse(s).gaps[0];if(!gap)continue;
  place(s,gap.start-.27*.35-.04,gap.lanes[0]);differential(s,`gap ${index}`);
 }
 const s=state(),p=place(s,49,1);p.checkpointU=9000;p.fallUntilTick=s.tick+3;p.fallStartTick=p.fallUntilTick-90;p.hits=1;
 p.resolvedObstacles=resolveRunCourse(s).obstacles.filter(o=>o.z<50).map(o=>o.id);
 differential(s,'respawn removes obsolete resolved obstacles');
});
test('stun recovery, boost expiry, item pickup and full inventory skips match the engine',()=>{
 const stunned=state();place(stunned,31).stunUntilTick=stunned.tick+3;differential(stunned,'stun expiry');
 const boosted=state();place(boosted,31).boostUntilTick=boosted.tick+4;differential(boosted,'boost expiry');
 for(const [distance,inventory]of [[59.95,null],[179.95,'shield'],[299.95,null]]){const s=state();place(s,distance).inventory=inventory;differential(s,`item ${distance}`);}
});
test('own finish stops at 480m and known global deadline stops before the 39 tick horizon',()=>{
 const s=state();place(s,479.8);const model=differential(s,'finish');assert.equal(model.sample(650).distance,480);assert.notEqual(model.sample(650).finishTick,null);assert.equal(model.sample(650).visualPlayer.finishTick,null);assert.equal('visualWinner'in model.sample(650).visualPlayer,false);
 const deadline=state();place(deadline,31,1,5998);const capped=differential(deadline,'time limit');assert.equal(capped.sample(650).tick,6000);
 const finishWindow=state();place(finishWindow,31,1,1398);finishWindow.firstFinishTick=500;finishWindow.phase='finish-window';finishWindow.endTick=1400;finishWindow.deadlineAt=finishWindow.startedAt+1400*1000/60;
 assert.equal(differential(finishWindow,'finish window').sample(650).tick,1400);
});
test('forfeited self stays static even if a previously accepted input was discarded',()=>{
 const s=state();place(s,31);E.act(s,'self',{type:'jump'},s.now);const p=s.players[0];p.forfeited=true;p.pendingInput=null;
 const model=differential(s,'forfeit');assert.equal(model.sample(650).distance,p.distanceU/300);assert.equal(model.sample(650).appliedInputNo,0);
});
test('fractional samples do not interpolate across obstacle, fall, respawn, stun recovery or finish boundaries',()=>{
 const scenarios=[];
 const hit=state(),obstacle=resolveRunCourse(hit).obstacles.find(o=>o.type==='crate');place(hit,obstacle.z-obstacle.depth/2-.27-.05,obstacle.lane);scenarios.push([hit,'hit']);
 const fall=state(),gap=resolveRunCourse(fall).gaps[0];place(fall,gap.start-.27*.35-.04,gap.lanes[0]);scenarios.push([fall,'fall']);
 const respawn=state(),rp=place(respawn,49);rp.checkpointU=9000;rp.fallUntilTick=respawn.tick+1;rp.fallStartTick=rp.fallUntilTick-90;rp.hits=1;scenarios.push([respawn,'respawn']);
 const recovery=state();place(recovery,31).stunUntilTick=recovery.tick+1;scenarios.push([recovery,'recovery']);
 const finish=state();place(finish,480-40/300);scenarios.push([finish,'finish']);
 for(const [s,boundary]of scenarios){const model=differential(s,boundary),left=model.sample(0),half=model.sample(500/60),at=model.sample(1000/60);assert.equal(at.boundary,boundary);assert.equal(half.boundary,boundary);for(const field of ['x','y','distance','scale','inventory','hits','finishTick'])assert.equal(half[field],left[field],`${boundary} ${field}`);assert.notEqual(at.distance,left.distance);}
});
test('ordinary fractional motion interpolates between bounded integer states and never exceeds the horizon',()=>{
 const s=state(),model=differential(s);near(model.sample(500/60).distance,40/600,'half step');
 assert.deepEqual(model.sample(-1),model.sample(0));assert.deepEqual(model.sample(650),model.sample(1000000));
 assert.equal(model.sample(650).tick,39);assert.equal(model.sample(Infinity),null);assert.equal(model.sample(NaN),null);assert.equal(RUN_PROJECTION_LIMIT_MS,650);
});
test('same-tick newer room version adopts precise pending input, duplicate version never reconstructs',()=>{
 const s=state(),model=createRunSelfProjection();assert.equal(update(model,view(s),1),true);const noInput=model.sample(650);
 E.act(s,'self',{type:'jump'},s.now);const pending=view(s);
 assert.equal(update(model,pending,1),false);assert.deepEqual(model.sample(650),noInput);
 assert.equal(update(model,pending,2),true);assert.ok(model.sample(200).y>0);assert.equal(model.sample(1000/60).appliedInputNo,1);
 const after=model.sample(650);assert.equal(update(model,view(state()),1),false);assert.deepEqual(model.sample(650),after);
});
test('old ticks cannot replace an accepted trajectory, even when their room version is higher',()=>{
 const s=state(),model=createRunSelfProjection();place(s,31);assert.equal(update(model,view(s),10),true);const before=model.sample(650);
 assert.equal(update(model,view(state()),11),false);assert.deepEqual(model.sample(650),before);
});
test('room and viewer switches reset tick/version scope; mismatched viewer fails closed',()=>{
 const s=state(),model=createRunSelfProjection();place(s,31);assert.equal(update(model,view(s),50),true);
 const fresh=state();assert.equal(update(model,view(fresh),1,'new-room'),true);assert.equal(model.sample(0).distance,0);
 assert.equal(update(model,view(fresh,'other'),1,'new-room','other'),true);assert.equal(model.sample(0).sourceVersion,1);
 assert.equal(update(model,view(fresh),2,'new-room','other'),false);assert.equal(model.sample(0),null);
 model.clear();assert.equal(model.sample(0),null);
});
test('new invalid authority clears old prediction and cannot be undone by older versions',()=>{
 const model=createRunSelfProjection(),game=view(state());assert.equal(update(model,game),true);
 const invalid=clone(game);delete invalid.selfPrediction;assert.equal(update(model,invalid,2),false);assert.equal(model.sample(0),null);
 assert.equal(update(model,game,1),false);assert.equal(model.sample(0),null);assert.equal(update(model,game,3),true);
});
test('changing a pinned course or rules within one room fails closed',()=>{
 const model=createRunSelfProjection();assert.equal(update(model,view(state(0))),true);
 assert.equal(update(model,view(state(1)),2),false);assert.equal(model.sample(0),null);
 assert.equal(update(model,view(state(1)),1,'another-room'),true);
});
test('missing private fields, unknown profiles, malformed values and out-of-range coordinates fail closed',()=>{
 const base=view(state()),mutations=[
  g=>delete g.selfPrediction,g=>delete g.selfPrediction.resolvedObstacles,g=>delete g.selfPrediction.pendingInput,g=>delete g.selfPrediction.lastInputTick,
  g=>g.selfPrediction.schema='next-version',g=>g.selfPrediction.extra=true,g=>g.selfPrediction.resolvedObstacles=['unknown'],g=>g.selfPrediction.resolvedObstacles=null,
  g=>g.ruleVersion='pvp-run-v2.0.0',g=>g.ruleVersion='pvp-run-v3.0.0',g=>g.physicsVersion='unknown',g=>g.courseId='unknown',g=>g.contentVersion='unknown',g=>g.levelVersion='unknown',
  g=>g.trackLength=500,g=>g.gameId='other',g=>g.me='other',g=>g.status='finished',g=>g.phase='countdown',g=>g.snapshotTick=-1,g=>g.snapshotTick=.5,g=>g.serverNow+=1,g=>g.deadlineAt+=1,
  g=>g.players[0].distance=480.01,g=>g.players[0].distance=Infinity,g=>g.players[0].distance=.001,g=>g.players[0].checkpoint=30,g=>g.players[0].lane=3,g=>g.players[0].fromLane=-1,
  g=>g.players[0].changeEndTick=13,g=>g.players[0].jumpStartTick=-1,g=>g.players[0].slideUntilTick=10000,g=>g.players[0].stunUntilTick=null,g=>g.players[0].fallUntilTick=90,
  g=>g.players[0].inventory='laser',g=>g.players[0].claimedItems=['unknown'],g=>g.players[0].hits=-1,g=>g.players[0].speed=9.6,g=>g.players[0].x=.1,g=>g.players[0].y=.1,
  g=>g.players[0].finishTick=1,g=>g.players[0].inputNo=1,g=>g.selfPrediction.lastInputTick=1,g=>g.players.push(clone(g.players[0])),
 ];
 for(const [index,mutate]of mutations.entries()){const game=clone(base);mutate(game);const model=createRunSelfProjection();assert.equal(update(model,game),false,`mutation ${index}`);assert.equal(model.sample(0),null,`mutation ${index}`);}
 for(const scope of [{roomId:null,roomVersion:1},{roomId:'room',roomVersion:-1},{roomId:'room',roomVersion:.5}]){const model=createRunSelfProjection();assert.equal(model.update(base,'self',scope),false);assert.equal(model.sample(0),null);}
});
test('malformed or impossible accepted inputs are never inferred or applied',()=>{
 const s=state();E.act(s,'self',{type:'jump'},s.now);const base=view(s);
 const mutations=[g=>g.selfPrediction.pendingInput.tick++,g=>g.selfPrediction.pendingInput.no++,g=>g.selfPrediction.pendingInput.type='boost',g=>g.selfPrediction.pendingInput.item='boost',g=>g.selfPrediction.pendingInput.local=true,g=>delete g.selfPrediction.pendingInput.item,g=>g.selfPrediction.lastInputTick++,g=>g.players[0].appliedInputNo=1];
 for(const mutate of mutations){const game=clone(base);mutate(game);const model=createRunSelfProjection();assert.equal(update(model,game),false);assert.equal(model.sample(650),null);}
 const edge=state();place(edge,31,0);const game=view(edge);game.players[0].inputNo=1;game.selfPrediction.lastInputTick=edge.tick+1;game.selfPrediction.pendingInput={type:'left',tick:edge.tick+1,no:1,item:null};assert.equal(update(createRunSelfProjection(),game),false);
});
test('per-frame sampling never reads or advances the authoritative snapshot again',()=>{
 const game=view(state()),model=createRunSelfProjection();assert.equal(update(model,game),true);
 for(const key of Object.keys(game))Object.defineProperty(game,key,{get(){throw Error(`sample touched authority ${key}`);},configurable:true});
 for(let frame=0;frame<2000;frame++){const pose=model.sample(frame);assert.ok(pose.distance<=5.2);assert.ok(pose.tick<=39);}
});
test('visual animation state is precomputed, immutable and never aliases authority',()=>{
 const s=state();E.act(s,'self',{type:'jump'},s.now);const game=freeze(view(s)),model=createRunSelfProjection();assert.equal(update(model,game),true);
 const before=model.sample(0),jump=model.sample(1000/60);assert.equal(before.visualPlayer.jumpStartTick,null);assert.equal(jump.visualPlayer.jumpStartTick,1);assert.ok(Object.isFrozen(jump.visualPlayer));assert.notEqual(jump.visualPlayer,game.players[0]);assert.equal(model.sample(1000/60).visualPlayer,jump.visualPlayer);assert.throws(()=>{jump.visualPlayer.jumpStartTick=999;},TypeError);
});
test('a forfeited falling runner remains valid after the original respawn tick without resuming movement',()=>{
 const s=state(),p=place(s,49);p.checkpointU=9000;p.fallStartTick=400;p.fallUntilTick=490;p.forfeited=true;p.hits=1;
 const model=differential(s,'forfeited past respawn');assert.equal(model.sample(650).distance,49);assert.equal(model.sample(650).fallUntilTick,490);
});
test('complete legal bot and idle race snapshots on every current course restore without false rejection',()=>{
 let accepted=0,pending=0,falling=0,finishing=0;
 for(const version of [E.RULE_VERSION,E.PRACTICE_RULE_VERSION])for(let index=0;index<6;index++)for(const drive of [false,true]){
  const s=state(index,version),model=createRunSelfProjection();let roomVersion=0;
  for(let step=0;step<=6000&&s.status==='active';step+=6){
   const now=s.startedAt+Math.ceil(step*1000/60);E.tick(s,now);
   if(drive&&s.status==='active')for(const p of s.players){const action=E.botAction(s,p.key,now);if(action)E.act(s,p.key,action,now);}
   if(s.status!=='active')break;
   const game=freeze(view(s));assert.equal(update(model,game,++roomVersion),true,`${version} ${index} ${drive} tick ${s.tick}`);accepted++;
   pending+=Number(game.selfPrediction.pendingInput!==null);falling+=Number(game.players[0].fallUntilTick!==null);finishing+=Number(game.players[0].finishTick!==null);
   if(step%150===0)differential(s,`complete race ${version} ${index} ${drive} ${s.tick}`);
  }
 }
 assert.ok(accepted>15000);assert.ok(pending>100);assert.ok(falling>1000);assert.equal(finishing,0,'equal bot finishers end the whole room together');
});

function historyModel(game,acceptedInputs,roomVersion=1){
 const model=createRunSelfProjection();assert.equal(model.update(game,'self',{roomId:'history-room',roomVersion,acceptedInputs}),true);return model;
}
function assertOwnedState(actual,p,tick){
 assert.equal(actual.tick,tick);
 for(const field of Object.keys(actual))if(field!=='tick')assert.deepEqual(actual[field],p[field],`state tick ${tick} ${field}`);
}
test('two complete accepted historical inputs replay against the full engine including pre-apply pending state',()=>{
 const s=state(),base=freeze(view(s)),history=[];
 E.act(s,'self',{type:'jump'},s.now);history.push(clone(s.players[0].pendingInput));
 E.tick(s,s.startedAt+100);E.act(s,'self',{type:'left'},s.now);history.push(clone(s.players[0].pendingInput));
 const model=historyModel(base,freeze(history)),reference=state();
 for(let tick=0;tick<=39;tick++){
  const input=history.find(input=>input.tick===tick+1);
  if(input)E.act(reference,'self',{type:input.type},reference.startedAt+Math.ceil(tick*1000/60));
  assertOwnedState(model.stateAtTick(tick),reference.players[0],tick);
  const pose=visual(reference),actual=model.sample(tick*1000/60);
  for(const field of ['x','y','distance','scale'])near(actual[field],pose[field],`history ${tick} ${field}`);
  if(tick<39)E.testing.step(reference);
 }
 assert.deepEqual(model.stateAtTick(0).pendingInput,history[0]);assert.deepEqual(model.stateAtTick(6).pendingInput,history[1]);
 assert.equal(model.stateAtTick(7).appliedInputNo,2);assert.equal(model.stateAtTick(7).pendingInput,null);
});
test('exact duplicate of base pending is deduplicated while a later accepted input is replayed once',()=>{
 const s=state();E.act(s,'self',{type:'jump'},s.now);const base=freeze(view(s)),first=clone(s.players[0].pendingInput);
 E.tick(s,s.startedAt+100);E.act(s,'self',{type:'left'},s.now);const second=clone(s.players[0].pendingInput);
 const withDuplicate=historyModel(base,[first,second]),withoutDuplicate=historyModel(base,[second]);
 for(let tick=0;tick<=39;tick++)assert.deepEqual(withDuplicate.stateAtTick(tick),withoutDuplicate.stateAtTick(tick));
 assert.equal(withDuplicate.stateAtTick(39).inputNo,2);
});
test('stateAtTick returns owned immutable complete physics state only inside its scope and horizon',()=>{
 const s=state();E.act(s,'self',{type:'jump'},s.now);const game=freeze(view(s)),model=historyModel(game,[]),owned=model.stateAtTick(0);
 assertOwnedState(owned,s.players[0],0);assert.ok(Object.isFrozen(owned));assert.ok(Object.isFrozen(owned.claimedItems));assert.ok(Object.isFrozen(owned.resolvedObstacles));assert.ok(Object.isFrozen(owned.pendingInput));
 assert.notEqual(owned.pendingInput,game.selfPrediction.pendingInput);assert.notEqual(owned.claimedItems,game.players[0].claimedItems);assert.equal(model.stateAtTick(0),owned);
 assert.throws(()=>owned.resolvedObstacles.push('invented'),TypeError);assert.throws(()=>{owned.pendingInput.no=99;},TypeError);
 for(const tick of [-1,.5,40,NaN,Infinity])assert.equal(model.stateAtTick(tick),null);
 const later=state();place(later,31);assert.equal(model.update(view(later),'self',{roomId:'another',roomVersion:1}),true);assert.equal(model.stateAtTick(0),null);assert.notEqual(model.stateAtTick(500),null);
 model.clear();assert.equal(model.stateAtTick(500),null);
});
test('wrong order, gaps, duplicates, conflicts and records outside the bounded history fail closed',()=>{
 const game=view(state()),first={type:'jump',tick:1,no:1,item:null},second={type:'left',tick:7,no:2,item:null};
 const histories=[null,{},[second],[second,first],[first,first],[first,{...second,no:3}],[first,{...second,tick:1}],[{...first,tick:0}],[{...first,tick:40}],[{...first,type:'boost',item:'boost'}],[{...first,item:'boost'}],[{...first,local:true}],[{type:'jump',tick:1,no:1}]];
 for(const acceptedInputs of histories){const model=createRunSelfProjection();assert.equal(model.update(game,'self',{roomId:'room',roomVersion:1,acceptedInputs}),false);assert.equal(model.sample(100),null);assert.equal(model.stateAtTick(0),null);}
 const pending=state();E.act(pending,'self',{type:'jump'},pending.now);const base=view(pending);
 for(const acceptedInputs of [[{...first,type:'left'}],[first,first],[second,first]]){const model=createRunSelfProjection();assert.equal(model.update(base,'self',{roomId:'room',roomVersion:1,acceptedInputs}),false);assert.equal(model.stateAtTick(0),null);}
});
test('every historical action is rechecked against legal rate, lane, animation and held-item state',()=>{
 const invalid=[
  [{type:'jump',tick:1,no:1,item:null},{type:'left',tick:6,no:2,item:null}],
  [{type:'left',tick:1,no:1,item:null},{type:'left',tick:13,no:2,item:null}],
  [{type:'left',tick:1,no:1,item:null},{type:'right',tick:7,no:2,item:null}],
  [{type:'jump',tick:1,no:1,item:null},{type:'jump',tick:7,no:2,item:null}],
  [{type:'jump',tick:1,no:1,item:null},{type:'slide',tick:7,no:2,item:null}],
  [{type:'slide',tick:1,no:1,item:null},{type:'jump',tick:7,no:2,item:null}],
  [{type:'item',tick:1,no:1,item:'shield'}],
 ];
 for(const acceptedInputs of invalid){const model=createRunSelfProjection();assert.equal(model.update(view(state()),'self',{roomId:'room',roomVersion:1,acceptedInputs}),false);assert.equal(model.stateAtTick(0),null);}
 const item=state();item.players[0].inventory='shield';const model=createRunSelfProjection();assert.equal(model.update(view(item),'self',{roomId:'room',roomVersion:1,acceptedInputs:[{type:'item',tick:1,no:1,item:'boost'}]}),false);
});
test('a collision, fall or finish before a later claimed accepted input invalidates the whole history',()=>{
 const hit=state(),obstacle=resolveRunCourse(hit).obstacles.find(o=>o.type==='crate');place(hit,obstacle.z-obstacle.depth/2-.27-.05,obstacle.lane);
 const fall=state(),gap=resolveRunCourse(fall).gaps[0];place(fall,gap.start-.27*.35-.04,gap.lanes[0]);
 const finish=state();place(finish,479.95);
 for(const s of [hit,fall,finish]){const model=createRunSelfProjection();assert.equal(model.update(view(s),'self',{roomId:'room',roomVersion:1,acceptedInputs:[{type:'left',tick:s.tick+7,no:1,item:null}]}),false);assert.equal(model.stateAtTick(s.tick),null);assert.equal(model.sample(0),null);}
});
test('historical item acceptance uses inventory acquired by preceding physics and respects deadline',()=>{
 const s=state();place(s,59.8);const base=freeze(view(s));E.tick(s,s.startedAt+Math.ceil((s.tick+3)*1000/60));assert.equal(s.players[0].inventory,'shield');E.act(s,'self',{type:'item'},s.now);
 const input=clone(s.players[0].pendingInput),model=historyModel(base,[input]);assert.equal(model.stateAtTick(input.tick-1).inventory,'shield');assert.equal(model.stateAtTick(input.tick-1).pendingInput.item,'shield');assert.equal(model.stateAtTick(input.tick).inventory,null);assert.equal(model.stateAtTick(input.tick).shieldUntilTick,input.tick+480);
 const deadline=state();place(deadline,31,1,5998);const denied=createRunSelfProjection();assert.equal(denied.update(view(deadline),'self',{roomId:'room',roomVersion:1,acceptedInputs:[{type:'jump',tick:6001,no:1,item:null}]}),false);assert.equal(denied.stateAtTick(5998),null);
});
