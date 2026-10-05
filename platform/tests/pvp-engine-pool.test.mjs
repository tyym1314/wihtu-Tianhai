import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnginePool} from '../server/pvp/engine-pool.mjs';
import {engines} from '../server/pvp/engines.mjs';
import {executeEngineTask} from '../server/pvp/engine-worker.mjs';

const fixtureUrl=new URL('./pvp-engine-worker-fixture.mjs',import.meta.url);
const players=Array.from({length:2},(_,i)=>({key:'p'+i,name:'P'+i,seatIndex:i,teamId:i?'team_b':'team_a',isBot:true}));
const fresh=game=>engines[game].createState('12'.repeat(32),1000,{players});
for(const gameId of ['bowling','pool','carrom','golf'])test(`${gameId} worker action and BOT advance exactly match authoritative synchronous rules`,async()=>{
  const pool=createEnginePool({size:1});
  try{
    const engine=engines[gameId],state=fresh(gameId),key=state.turnKey||'p0',action=engine.botAction(state,key,2000);
    assert.ok(action);const job={gameId,ruleVersion:engine.RULE_VERSION,kind:'act',state,playerKey:key,action,now:2000};
    const expected=executeEngineTask(structuredClone(job)),actual=await pool.run(job);assert.deepEqual(actual,expected);assert.deepEqual(state,fresh(gameId));
    const tick={gameId,ruleVersion:engine.RULE_VERSION,kind:'advance',state:fresh(gameId),now:2000,bots:players.map(p=>({key:p.key,lastBotAt:0})),forfeits:[]};
    assert.deepEqual(await pool.run(tick),executeEngineTask(structuredClone(tick)));
    assert.equal(pool.stats().completed,2);
  }finally{await pool.close();}
});
test('bounded queue rejects excess work and preserves timers on the HTTP event loop',async()=>{
  const pool=createEnginePool({size:1,maxQueue:1,workerUrl:fixtureUrl});let ticks=0;const timer=setInterval(()=>ticks++,5);
  try{
    const first=pool.run({delay:150,value:1}),second=pool.run({value:2});
    await assert.rejects(pool.run({value:3}),e=>e.code==='ENGINE_QUEUE_FULL'&&e.status===503&&e.engineUnavailable);
    assert.deepEqual(await first,{value:1});assert.deepEqual(await second,{value:2});assert.ok(ticks>=5,'heavy computation must not block main-thread timers');
    assert.equal(pool.stats().maxRunning,1);assert.equal(pool.stats().rejected,1);
  }finally{clearInterval(timer);await pool.close();}
});
test('queue timeout discards waiting work; task timeout replaces failed worker',async()=>{
  const pool=createEnginePool({size:1,workerUrl:fixtureUrl,queueTimeoutMs:30,taskTimeoutMs:500});
  try{const first=pool.run({delay:150,value:1});await assert.rejects(pool.run({value:2}),{code:'ENGINE_QUEUE_TIMEOUT'});await first;assert.deepEqual(await pool.run({value:3}),{value:3});}finally{await pool.close();}
  const timeout=createEnginePool({size:1,workerUrl:fixtureUrl,taskTimeoutMs:100});
  try{await assert.rejects(timeout.run({delay:500}),{code:'ENGINE_TASK_TIMEOUT'});assert.deepEqual(await timeout.run({value:4}),{value:4});assert.equal(timeout.stats().restarts,1);}finally{await timeout.close();}
});
test('worker crashes and unexpected replies cannot report a successful game action',async()=>{
  const pool=createEnginePool({size:1,workerUrl:fixtureUrl});
  try{
    await assert.rejects(pool.run({crash:true}),{code:'ENGINE_WORKER_LOST'});
    await assert.rejects(pool.run({wrongId:true}),{code:'ENGINE_WORKER_PROTOCOL'});
    assert.deepEqual(await pool.run({value:'recovered'}),{value:'recovered'});assert.equal(pool.stats().completed,1);
  }finally{await pool.close();}
});
test('close rejects running/queued tasks and prohibits new admission',async()=>{
  const pool=createEnginePool({size:1,workerUrl:fixtureUrl});
  const first=assert.rejects(pool.run({delay:500}),{code:'ENGINE_POOL_CLOSED'}),second=assert.rejects(pool.run({value:2}),{code:'ENGINE_POOL_CLOSED'});
  await pool.close();await Promise.all([first,second]);await assert.rejects(pool.run({value:3}),{code:'ENGINE_POOL_CLOSED'});assert.equal(pool.stats().workers,0);
});
test('rule-version mismatch and illegal inputs retain authoritative error codes',async()=>{
  const pool=createEnginePool({size:1}),state=fresh('bowling');
  try{
    const job={gameId:'bowling',kind:'act',state,playerKey:'p0',now:2000,action:{type:'roll',score:10}};
    await assert.rejects(pool.run({...job,ruleVersion:'wrong'}),{code:'PINNED_RULE_UNAVAILABLE'});
    await assert.rejects(pool.run({...job,ruleVersion:engines.bowling.RULE_VERSION}),{code:'INVALID_ACTION'});
  }finally{await pool.close();}
});
