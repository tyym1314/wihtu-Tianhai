import test from 'node:test';
import assert from 'node:assert/strict';
import {ARENA_IDS,LEGACY_IDS,RELEASED_IDS} from '../shared/games.mjs';
import {BENCHMARK_ARENA_GAMES,BENCHMARK_PROBABILITY_GAMES,BENCHMARK_GAMES,planArenaGroups,benchmarkAction} from '../scripts/benchmark-workload.mjs';

const seed='0123456789abcdef'.repeat(4);
const now=1_000_000;
const players=(count=2)=>Array.from({length:count},(_,seatIndex)=>({key:`p${seatIndex+1}`,seatIndex}));

test('100-user workload seats every released arena game and both probability games',()=>{
 assert.deepEqual(BENCHMARK_ARENA_GAMES,ARENA_IDS);
 assert.deepEqual(BENCHMARK_PROBABILITY_GAMES,LEGACY_IDS);
 assert.deepEqual(BENCHMARK_GAMES,RELEASED_IDS);
 const groups=planArenaGroups(100);
 assert.equal(groups.reduce((sum,group)=>sum+group.capacity,0),80);
 assert.deepEqual(new Set(groups.map(group=>group.game)),new Set(ARENA_IDS));
 assert(groups.every(group=>group.entry_minor==='1000'&&group.practice===false));
 assert(groups.every(group=>group.capacity===(group.game==='jackaroo'?4:2)));
});

test('all supported user counts preserve the 80/20 mix and arena coverage',()=>{
 for(let users=100;users<=400;users+=20){
  const groups=planArenaGroups(users);
  assert.equal(groups.reduce((sum,group)=>sum+group.capacity,0),users*.8);
  assert.deepEqual(new Set(groups.map(group=>group.game)),new Set(ARENA_IDS));
 }
 for(const invalid of [0,80,101,401,NaN,Infinity,'100'])assert.throws(()=>planArenaGroups(invalid),/BENCHMARK_USERS_INVALID/);
});

test('each arena action plan comes from the public view and is accepted by its engine',async t=>{
 for(const game of ARENA_IDS){
  await t.test(game,async()=>{
   const engine=await import(`../arena/${game}/engine.mjs`);
   const state=engine.createState(seed,now,{players:players(game==='jackaroo'?4:2),...(game==='towerlink'?{startAt:now}:{})});
   const at=['darts','domino'].includes(game)?now+500:now;
   if(at>now)engine.tick(state,at);
   const key=state.turnKey||'p1';
   const room={status:'active',game_id:game,me:key,server_now:at,game:engine.view(state,key)};
   const action=benchmarkAction(room);
   assert(action,`no public-view action for ${game}`);
   assert.equal(typeof action.type,'string');
   assert.doesNotThrow(()=>engine.act(state,key,action,at),`rejected ${game} action ${JSON.stringify(action)}`);
  });
 }
});

test('no synthetic action is offered before the room or game is active',()=>{
 const active={status:'active',game_id:'run',me:'p1',server_now:now,game:{status:'active',phase:'racing',snapshotTick:0,players:[{key:'p1',forfeited:false,finishTick:null,fallUntilTick:null,stunUntilTick:0,y:0,sliding:false,inputNo:0,appliedInputNo:0}]}};
 assert.deepEqual(benchmarkAction(active),{type:'jump',observed_tick:0});
 assert.equal(benchmarkAction({...active,status:'funding'}),null);
 assert.equal(benchmarkAction({...active,game:{...active.game,phase:'arming'}}),null);
 assert.equal(benchmarkAction({...active,game:{...active.game,players:[{...active.game.players[0],fallUntilTick:12}]}}),null);
});
