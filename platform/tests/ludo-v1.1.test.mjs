import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../arena/ludo/engine.mjs';
import * as legacy from '../arena/ludo/engine-v1.mjs';
import {randomInt} from '../arena/boardkit/engine-utils.mjs';
import {supportsRules} from '../server/pvp/rule-support.mjs';
import {createEnginePool} from '../server/pvp/engine-pool.mjs';
const players=[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1,isBot:true}];
const make=(ruleVersion=E.RULE_VERSION,hex='41')=>E.createState(hex.repeat(32),1000,{players,ruleVersion});
function fixed(dice,{thirdSix=false}={}){const s=make();s.dice=dice;s.thirdSix=thirdSix;s.sixes=thirdSix?3:dice===6?1:0;s.turnKey='p0';s.pendingNext=null;s.revealed=false;s.busyUntil=1000;s.turnDeadlineAt=21000;return s;}

test('v1.1 every initial result is hidden and offers exactly one roll before any forced pass',()=>{
 for(let die=1;die<=6;die++){
  const s=fixed(die),count=s.rollCount,seed=s.seed;
  assert.equal(E.view(s,'p0').dice,null);assert.deepEqual(E.view(s,'p0').legalActions,[{type:'roll'}]);assert.deepEqual(E.view(s,'p1').legalActions,[]);
  E.tick(s,1100);assert.equal(s.turnKey,'p0');assert.equal(s.pendingNext,null);assert.equal(s.revealed,false);
  const response=E.act(s,'p0',{type:'roll',dice:7},1200);
  assert.equal(response.event.type,'roll');assert.equal(response.event.dice,die);assert.equal(s.rollCount,count);assert.equal(s.seed,seed);
  if(die===6){assert.equal(s.pendingNext,null);assert.equal(E.view(s,'p0').legalActions.length,2);assert.throws(()=>E.act(s,'p0',{type:'roll'},1201),{code:'ALREADY_REVEALED'});}
  else{assert.equal(response.event.autoPassReason,'no-moves');assert.equal(s.busyUntil,1850);assert.equal(s.players[0].timeouts,0);assert.deepEqual(E.view(s,'p0').legalActions,[]);assert.throws(()=>E.act(s,'p0',{type:'roll'},1201),{code:'BUSY'});E.tick(s,1849);assert.equal(s.turnKey,'p0');E.tick(s,1850);assert.equal(s.turnKey,'p1');assert.equal(s.revealed,false);}
 }
});
test('third six is revealed once then forfeits only this die without undoing earlier moves',()=>{
 const s=fixed(6,{thirdSix:true});s.players[0].pieces=[4,7];const before=structuredClone(s.players);
 assert.deepEqual(E.view(s,'p0').legalActions,[{type:'roll'}]);assert.equal(E.view(s,'p0').sixes,null);
 const {event}=E.act(s,'p0',{type:'roll'},1100);assert.equal(event.autoPassReason,'third-six');assert.equal(s.pendingNext.key,'p1');assert.deepEqual(s.players,before);
 E.tick(s,1750);assert.equal(s.turnKey,'p1');assert.deepEqual(s.players,before);
});
test('timely no-move reveal does not extend the deadline or invent an animation-tail timeout',()=>{
 const s=fixed(2);s.players[0].timeouts=2;E.act(s,'p0',{type:'roll'},20999);assert.equal(s.turnDeadlineAt,21000);E.tick(s,21000);assert.equal(s.players[0].timeouts,2);assert.equal(s.turnKey,'p0');E.tick(s,21649);assert.equal(s.players[0].timeouts,2);assert.equal(s.players[0].forfeited,false);assert.equal(s.turnKey,'p1');
 const t=fixed(2);t.players[0].timeouts=2;E.tick(t,21000);assert.equal(t.players[0].forfeited,true);
});
test('v1.1 keeps v1 seeded dice domain for every tested seed and roll index',()=>{
 for(let i=0;i<24;i++){const hex=i.toString(16).padStart(2,'0'),s=make(E.RULE_VERSION,hex);for(let count=0;count<80;count++){s.rollCount=count;s.sixes=0;E.testing.beginTurn(s,'p0',1000,false);assert.equal(s.dice,randomInt(s.seed,'pvp-ludo-v1.0.0:dice',count,6)+1);assert.equal(s.rollCount,count+1);assert.equal(s.revealed,false);assert.equal(s.pendingNext,null);}}
});
test('legacy creation and complete serialized games delegate without changing old states or events',()=>{
 for(const n of[2,4]){const roster=Array.from({length:n},(_,seatIndex)=>({key:'p'+seatIndex,seatIndex})),options={players:roster,ruleVersion:legacy.RULE_VERSION},a=legacy.createState('41'.repeat(32),1000,options),b=E.createState('41'.repeat(32),1000,options);assert.deepEqual(b,a);
  for(let now=1000;a.status==='active'&&now<600000;now+=700){legacy.tick(a,now);E.tick(b,now);assert.deepEqual(b,a);for(const p of a.players){const action=legacy.botAction(a,p.key,now);assert.deepEqual(E.botAction(b,p.key,now),action);if(action){assert.deepEqual(E.act(b,p.key,action,now),legacy.act(a,p.key,action,now));}}assert.deepEqual(E.view(b,'p0'),legacy.view(a,'p0'));}
  assert.equal(a.status,'finished');assert.deepEqual(E.rank(b),legacy.rank(a));assert.deepEqual(JSON.parse(JSON.stringify(b)),b);
 }
 const a=legacy.createState('42'.repeat(32),1000,{players}),b=structuredClone(a);legacy.shiftTime(a,1000);E.shiftTime(b,1000);assert.deepEqual(b,a);assert.deepEqual(E.forfeit(b,['p1'],2500),legacy.forfeit(a,['p1'],2500));
});
test('explicit versions are accepted through real worker dispatch; unsupported or mismatched jobs reject',async()=>{
 const pool=createEnginePool({size:1});
 try{for(const version of[legacy.RULE_VERSION,E.RULE_VERSION]){assert.equal(supportsRules(E,version),true);const s=make(version);s.turnKey='p0';s.dice=2;s.revealed=false;s.pendingNext=null;s.busyUntil=1000;s.turnDeadlineAt=21000;const action={type:'roll'},expected=E.act(structuredClone(s),'p0',action,1100);assert.deepEqual(await pool.run({kind:'act',gameId:'ludo',ruleVersion:version,state:s,playerKey:'p0',action,now:1100}),expected);}
  for(const version of['pvp-ludo-v9.0.0','pvp-ludo-v1.2.0']){assert.equal(supportsRules(E,version),false);assert.throws(()=>make(version),{code:'PINNED_RULE_UNAVAILABLE'});}
  await assert.rejects(pool.run({kind:'advance',gameId:'ludo',ruleVersion:E.RULE_VERSION,state:make(legacy.RULE_VERSION),now:1100}),{code:'PINNED_RULE_UNAVAILABLE'});
 }finally{await pool.close();}
});
