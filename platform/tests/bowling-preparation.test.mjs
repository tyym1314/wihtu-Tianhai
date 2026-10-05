import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import * as bowling from '../arena/bowling/engine.mjs';
import {createEnginePool,runEngineTask,enginePoolStats,closeEnginePool} from '../server/pvp/engine-pool.mjs';
import {executeEngineTask} from '../server/pvp/engine-worker.mjs';
import {createBowlingPreparationManager} from '../server/pvp/bowling-preparation.mjs';
const normal={type:'roll',offset:0,angle:0,power:.78,spin:0};
const make=(n=4)=>bowling.createState('12'.repeat(32),1000,{players:Array.from({length:n},(_,i)=>({key:'p'+i,seatIndex:i}))});
const worker=createEnginePool({size:4});
after(async()=>{await worker.close();await closeEnginePool();});
function job(state,action=normal,key='p0',now=2000){return{kind:'act',gameId:'bowling',ruleVersion:bowling.RULE_VERSION,state,playerKey:key,action,now};}
async function prepared(state,action=normal,key='p0'){
 const proof=bowling.rollPreparationProof(state,key,action);assert.ok(proof);
 const result=await worker.run({kind:'prepare-bowling-roll',gameId:'bowling',ruleVersion:proof.ruleVersion,physicsVersion:proof.physicsVersion,standing:proof.standing,action:proof.action});return{proof,result};
}
function context(state=make(),action=normal,key='p0'){
 return{room:{id:'room_fixture',app_id:'app_fixture',game_id:'bowling',rule_version:bowling.RULE_VERSION,status:'active',game_state:state,players:state.players.map(p=>({external_user_id:p.key,bot:false,last_seq:0,forfeited:false}))},session:{app_id:'app_fixture',game_id:'bowling',external_user_id:key},body:{request_id:'request_'+key,seq:1,action},digest:'digest_'+key};
}
for(const [label,action,standing] of [
 ['centre',normal],['right pocket',{...normal,offset:.05,angle:.01}],['left pocket',{...normal,offset:-.05,angle:-.01}],
 ['gutter',{...normal,offset:.85,angle:.2,spin:1}],['minimum power',{...normal,power:.25}],['maximum power',{...normal,power:1}],
 ['negative limits',{...normal,offset:-.85,angle:-.2,spin:-1}],['partial rack',normal,[4,7]],['ordered rack',normal,[7,4]],['single pin',{...normal,angle:.025},[10]],
])test(`prepared ${label} matches the complete original worker state/event and JSON reload`,async()=>{
 const state=make();if(standing)state.players[0].standing=standing;
 const initial=structuredClone(state),p=await prepared(state,action),actual=executeEngineTask({...job(state,action),state:structuredClone(state),kind:'act-prepared',prepared:p});
 assert.deepEqual(actual,await worker.run(job(state,action)));assert.deepEqual(state,initial);
 assert.deepEqual(executeEngineTask({...job(JSON.parse(JSON.stringify(state)),action),kind:'act-prepared',prepared:JSON.parse(JSON.stringify(p))}),actual);
 const before=structuredClone(actual.state);bowling.tick(actual.state,actual.state.players[0].busyUntil);bowling.tick(before,before.players[0].busyUntil);assert.deepEqual(actual.state,before);
});
for(const rolls of [[10,10,10],[0,0,0,0,7,3],[0,0,0,0,10,7]])test(`prepared third-frame/fill-ball ${rolls} preserves original scoring`,async()=>{
 const state=make(),p=state.players[0];for(const count of rolls)bowling.recordRoll(p,count,p.standing.slice(count),1500);
 const prep=await prepared(state),actual=executeEngineTask({...job(structuredClone(state)),kind:'act-prepared',prepared:prep});assert.deepEqual(actual,await worker.run(job(state)));
});
test('prepare always dispatches off-thread; matching apply is only an inexpensive current-state operation',async()=>{
 const state=make(),proof=bowling.rollPreparationProof(state,'p0',normal),start=enginePoolStats().submitted||0;
 const result=await runEngineTask({kind:'prepare-bowling-roll',gameId:'bowling',ruleVersion:proof.ruleVersion,physicsVersion:proof.physicsVersion,standing:proof.standing,action:normal});
 assert.equal(enginePoolStats().submitted-start,1);
 const actual=await runEngineTask({...job(state),kind:'act-prepared',prepared:{proof,result}});assert.equal(enginePoolStats().submitted-start,1);assert.deepEqual(actual,await worker.run(job(state)));assert.deepEqual(state,make());
});
test('another lane and room version advance do not invalidate a prepared result or restore old state',async()=>{
 const state=make(),p=await prepared(state);const other=await worker.run(job(state,{...normal,angle:.02},'p1',1800));other.state.version+=100;
 const expected=await worker.run(job(other.state)),actual=executeEngineTask({...job(structuredClone(other.state)),kind:'act-prepared',prepared:p});assert.deepEqual(actual,expected);assert.equal(actual.state.players[1].shotId,1);
});
for(const [label,mutate] of [
 ['rack',s=>{s.players[0].standing=[4,7];}],['rack order',s=>s.players[0].standing.reverse()],['frames',s=>{s.players[0].frames[0]=[1];}],
 ['shot',s=>s.players[0].shotId++],['deadline',s=>s.players[0].shotDeadlineAt++],['timeout',s=>s.players[0].timeouts++],['shared pause',s=>bowling.shiftTime(s,500)],
])test(`changed ${label} discards proof and leaves the caller snapshot untouched`,async()=>{
 const c=context(),manager=createBowlingPreparationManager({run:runEngineTask}),token=manager.begin(c);mutate(c.room.game_state);const before=structuredClone(c.room.game_state);
 try{assert.deepEqual(await manager.act(token,c,2000),await worker.run(job(c.room.game_state)));assert.equal(manager.stats().stale,1);assert.equal(manager.stats().hits,0);assert.deepEqual(c.room.game_state,before);}finally{manager.release(token);}
});
for(const [label,edit,at,expected] of [
 ['invalid action',(s,a)=>{a.score=10;},2000,'INVALID_ACTION'],['missing player',()=>{},2000,'NOT_A_PLAYER'],
 ['completed',s=>{s.players[0].completed=true;},2000,'NOT_ACTIVE'],['forfeited',s=>{s.players[0].forfeited=true;},2000,'NOT_ACTIVE'],
 ['total deadline',()=>{},181000,'NOT_ACTIVE'],['clock rewind',()=>{},999,'CLOCK_REWIND'],
])test(`prepared gate preserves ${label} error precedence`,async()=>{
 const state=make(),p=await prepared(state),action={...normal};edit(state,action);const key=label==='missing player'?'absent':'p0';
 const task=job(state,action,key,at);await assert.rejects(worker.run(task),{code:expected});assert.throws(()=>executeEngineTask({...task,state:structuredClone(state),kind:'act-prepared',prepared:p}),{code:expected});
});
test('old pending is not prepared, never recomputed, and busy boundary follows original act',async()=>{
 const state=(await worker.run(job(make()))).state,end=state.players[0].busyUntil,old=structuredClone(state.players[0].pending);
 assert.equal(bowling.rollPreparationProof(state,'p0',normal),null);
 for(const at of [end-1,end,end+1]){const c=context(structuredClone(state)),manager=createBowlingPreparationManager({run:runEngineTask});assert.equal(manager.begin(c),null);if(at<end)await assert.rejects(manager.act(null,c,at),{code:'BUSY'});else assert.deepEqual(await manager.act(null,c,at),await worker.run(job(state,normal,'p0',at)));}assert.deepEqual(state.players[0].pending,old);
});
test('server-only capability cannot be supplied or rebound by request JSON or another room/player/id',async()=>{
 const c=context(),manager=createBowlingPreparationManager({run:runEngineTask}),token=manager.begin(c);
 const forged=context(make(),{...normal,prepared:token});assert.equal(manager.begin(forged),null);await assert.rejects(manager.act({},forged,2000),{code:'INVALID_ACTION'});
 const other=structuredClone(c);other.room.id='another_room';assert.deepEqual(await manager.act(token,other,2000),await worker.run(job(other.room.game_state)));assert.equal(manager.stats().hits,0);manager.release(token);
});
test('same request shares bounded pure computation; conflicting id/input and full capacity skip it',async()=>{
 let finish;const pending=new Promise(r=>finish=r),jobs=[];const manager=createBowlingPreparationManager({maxActive:1,run:task=>{jobs.push(task);return pending;}}),c=context();
 const first=manager.begin(c),repeat=manager.begin(structuredClone(c));assert.equal(jobs.length,1);assert.equal(manager.stats().shared,1);
 const conflict=structuredClone(c);conflict.body.request_id='different_id';assert.equal(manager.begin(conflict),null);const other=context(make(),normal,'p1');assert.equal(manager.begin(other),null);
 assert.equal(manager.stats().conflictSkipped,1);assert.equal(manager.stats().capacitySkipped,1);manager.release(first);manager.release(repeat);assert.equal(manager.stats().active,1,'unfinished worker stays bounded after early replay/exit');finish(null);await pending;await new Promise(r=>setImmediate(r));assert.equal(manager.stats().active,0);assert.equal(manager.stats().discarded,2);
});
test('preparation worker failure is caught and falls back to exactly one ordinary authoritative act',async()=>{
 const kinds=[],manager=createBowlingPreparationManager({run:task=>{kinds.push(task.kind);return task.kind==='prepare-bowling-roll'?Promise.reject(Object.assign(new Error('lost'),{code:'ENGINE_WORKER_LOST'})):runEngineTask(task);}}),c=context(),token=manager.begin(c);
 try{assert.deepEqual(await manager.act(token,c,2000),await worker.run(job(c.room.game_state)));assert.deepEqual(kinds,['prepare-bowling-roll','act']);assert.equal(manager.stats().failed,1);}finally{manager.release(token);}assert.equal(manager.stats().active,0);
});
test('early release catches queue rejection without unhandled promise or a retained active record',async()=>{
 const manager=createBowlingPreparationManager({run:()=>Promise.reject(Object.assign(new Error('full'),{code:'ENGINE_QUEUE_FULL'}))}),token=manager.begin(context());manager.release(token);await new Promise(r=>setImmediate(r));assert.equal(manager.stats().active,0);assert.equal(manager.stats().failed,1);
});
test('prepared fault keeps the exact original fault application without consuming a shot',()=>{
 const state=make(),proof=bowling.rollPreparationProof(state,'p0',normal),result={physicsVersion:bowling.PHYSICS_VERSION,outcome:'fault'};
 const response=executeEngineTask({...job(state),kind:'act-prepared',prepared:{proof,result}});assert.deepEqual(response.event,{code:'PHYSICS_TIMEOUT',at:2000});assert.equal(response.state.players[0].shotId,0);assert.equal(response.state.phase,'fault');
});
for(const offset of [-1,0,1])test(`shot deadline ${offset} ms performs original tick before proof consumption`,async()=>{
 const c=context(),at=c.room.game_state.players[0].shotDeadlineAt+offset,manager=createBowlingPreparationManager({run:runEngineTask}),token=manager.begin(c);
 try{assert.deepEqual(await manager.act(token,c,at),await worker.run(job(c.room.game_state,normal,'p0',at)));assert.equal(manager.stats().hits,offset<0?1:0);assert.equal(manager.stats().stale,offset<0?0:1);}finally{manager.release(token);}
});
test('out-of-order preparation completion cannot reorder accepted actions or restore another lane',async()=>{
 const c=context(),manager=createBowlingPreparationManager({run:task=>{
  if(task.kind!=='prepare-bowling-roll')return runEngineTask(task);
  let release;const gate=new Promise(r=>release=r);const record={release,ready:false};records.push(record);
  return worker.run(task).then(async result=>{record.ready=true;await gate;return result;});
 }}),records=[],contexts=[0,1,2].map(i=>({...c,session:{...c.session,external_user_id:'p'+i},body:{request_id:'out_of_order_'+i,seq:1,action:{...normal,angle:i*.005}},digest:'out_of_order_'+i})),tokens=contexts.map(x=>manager.begin(x)),order=[];
 let chain=Promise.resolve();const results=contexts.map((ctx,i)=>chain=chain.then(async()=>{const result=await manager.act(tokens[i],ctx,2000+i);c.room.game_state=result.state;c.room.players[i].last_seq=1;order.push(i);return result;}));
 try{while(!records.every(r=>r.ready))await new Promise(r=>setTimeout(r,5));records[2].release();records[1].release();await new Promise(r=>setImmediate(r));assert.deepEqual(order,[]);records[0].release();await Promise.all(results);assert.deepEqual(order,[0,1,2]);assert.equal(manager.stats().hits,3);
  let expected=make();for(let i=0;i<3;i++)expected=(await worker.run(job(expected,contexts[i].body.action,'p'+i,2000+i))).state;assert.deepEqual(c.room.game_state,expected);
 }finally{records.forEach(r=>r.release());await Promise.allSettled(results);tokens.forEach(t=>manager.release(t));}assert.equal(manager.stats().active,0);
});
for(const failure of ['crash','timeout','queue-full'])test(`real worker ${failure} is a caught preparation miss followed by normal worker fallback`,async()=>{
 const broken=createEnginePool({size:1,maxQueue:1,taskTimeoutMs:failure==='timeout'?20:1000,workerUrl:new URL('./pvp-engine-worker-fixture.mjs',import.meta.url)}),busy=[];
 if(failure==='queue-full'){busy.push(broken.run({delay:150,value:1}),broken.run({value:2}));}
 const manager=createBowlingPreparationManager({run:task=>task.kind==='prepare-bowling-roll'?broken.run(failure==='crash'?{crash:true}:failure==='timeout'?{delay:200}:{value:3}):runEngineTask(task)}),c=context(),token=manager.begin(c);
 try{assert.deepEqual(await manager.act(token,c,2000),await worker.run(job(c.room.game_state)));assert.equal(manager.stats().failed,1);assert.equal(manager.stats().hits,0);assert.equal(manager.stats().fallback,1);}finally{manager.release(token);await Promise.allSettled(busy);await broken.close();}assert.equal(manager.stats().active,0);
});
