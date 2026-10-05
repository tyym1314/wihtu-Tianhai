// Frozen 2.1 fixtures remain legacy regressions; current 2.2 maps/flows are covered by content, training and layout suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as game from '../arena/towerlink/engine-v2.1.mjs';
import {LEVELS,createBoard} from '../arena/towerlink/levels-v2.1.mjs';
import {executeEngineTask} from '../server/pvp/engine-worker.mjs';

const seed='0123456789abcdef0123456789abcdef';
const create=(count=2,at=1000,options={})=>game.createState(seed,at,{players:Array.from({length:count},(_,seatIndex)=>({key:'p'+seatIndex,seatIndex})),...options});
const code=expected=>error=>error.code===expected;
const home=(s,key='p0')=>s.towers.find(t=>s.owners[t.id]===key);
const route=(s,key='p0')=>{const t=home(s,key);return{type:'link',from:t.id,to:t.neighbors[0]};};
const totals=s=>s.towers.reduce((n,t)=>n+t.troops,0)+s.armies.reduce((n,a)=>n+a.count,0);
const packet=(s,{ownerKey='p0',from=0,to=12,count=1,departedAt=1000,arrivesAt=2000,...rest}={})=>{const a={id:`fixture:${s.armies.length}`,ownerKey,from,to,count,departedAt,arrivesAt,...rest};s.armies.push(a);return a;};

for(const count of [2,3,4])test(`${count} seats: both 13-tower maps are connected, rotationally fair and road-planar`,()=>{
  assert.deepEqual(create(count),create(count));assert.equal(create(count).towers.length,13);
  assert.equal(LEVELS.filter(l=>l.playerCount===count).length,2);
  for(let variant=0;variant<2;variant++){
    const map=createBoard(count,variant),{outerCount:outer,innerCount:inner}=map.board;
    const rotate=id=>id===12?12:id<outer?(id+outer/count)%outer:outer+(id-outer+inner/count)%inner;
    const lookup=new Map(map.roads.map(r=>[`${r.from}:${r.to}`,r.travelMs]));
    for(const t of map.towers){
      const rotated=map.towers[rotate(t.id)];assert.equal(rotated.kind,t.kind);assert.deepEqual(t.neighbors.map(rotate).sort((a,b)=>a-b),rotated.neighbors);
      assert.ok(t.neighbors.length>=2);assert.ok(t.x>=.07&&t.x<=.93&&t.y>=.07&&t.y<=.93);
      for(const n of t.neighbors){const [a,b]=[rotate(t.id),rotate(n)].sort((a,b)=>a-b);assert.equal(lookup.get(`${Math.min(t.id,n)}:${Math.max(t.id,n)}`),lookup.get(`${a}:${b}`));}
    }
    assert.deepEqual(map.starts.map(rotate),[...map.starts.slice(1),map.starts[0]]);
    const connected=new Set([0]),queue=[0];for(const id of queue)for(const n of map.towers[id].neighbors)if(!connected.has(n)){connected.add(n);queue.push(n);}assert.equal(connected.size,13);
    // Removing any single edge must not disconnect the map.
    for(const removed of map.edges){const visited=new Set([0]),q=[0];for(const id of q)for(const n of map.towers[id].neighbors){if((id===removed[0]&&n===removed[1])||(id===removed[1]&&n===removed[0]))continue;if(!visited.has(n)){visited.add(n);q.push(n);}}assert.equal(visited.size,13);}
    const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    for(let i=0;i<map.edges.length;i++)for(let j=i+1;j<map.edges.length;j++){
      const [a,b]=map.edges[i],[c,d]=map.edges[j];if([a,b].some(id=>id===c||id===d))continue;
      assert.ok(!(cross(map.towers[a],map.towers[b],map.towers[c])*cross(map.towers[a],map.towers[b],map.towers[d])<-1e-9&&cross(map.towers[c],map.towers[d],map.towers[a])*cross(map.towers[c],map.towers[d],map.towers[b])<-1e-9),'roads cannot cross without a tower');
    }
  }
  assert.notDeepEqual(createBoard(count,0).edges,createBoard(count,1).edges);
});

test('Map selection uses entropy only; six descriptors give two maps per player count',()=>{
  for(const count of [2,3,4]){const selected=new Set();for(let i=0;i<40;i++)selected.add(game.createState(i.toString(16).padStart(32,'0'),1000,{players:Array.from({length:count},(_,n)=>'p'+n)}).level.id);assert.deepEqual([...selected].sort(),LEVELS.filter(l=>l.playerCount===count).map(l=>l.id).sort());}
  assert.deepEqual(create(2,1000,{level:'forged'}),create());
  assert.throws(()=>createBoard(4,2),RangeError);
});

test('Initial reserves, neutral garrisons and shared countdown match public rules',()=>{
  const s=create(2,1000,{startAt:4000});assert.equal(s.startedAt,4000);assert.equal(s.deadlineAt,184000);
  assert.equal(home(s).troops,30);assert.equal(s.towers[12].troops,20);assert.ok(s.towers.filter(t=>!s.owners[t.id]&&!t.core).every(t=>t.troops===10));
  game.tick(s,3999);assert.equal(home(s).troops,30);assert.equal(s.simulationAt,4000);assert.equal(game.botAction(s,'p0',3999),null);assert.deepEqual(game.view(s,'p0').legalActions,[]);
  const before=structuredClone(s);assert.throws(()=>game.act(s,'p0',route(s),3999),code('GAME_NOT_STARTED'));assert.deepEqual(s,before);
  game.tick(s,5000);assert.equal(home(s).troops,31);assert.equal(s.towers[12].troops,20);
});

test('Automatic production caps natural growth but retains all overflow reinforcements',()=>{
  const s=create(),t=home(s);game.tick(s,12000);assert.equal(t.troops,40);
  packet(s,{to:t.id,count:27,arrivesAt:12125});game.tick(s,12125);assert.equal(t.troops,67);
  game.tick(s,18000);assert.equal(t.troops,67);assert.equal(game.view(s,'p0').players[0].totalTroops,67);
  t.troops=38;game.tick(s,20000);assert.equal(t.troops,40);
});

test('Lv.1 links create persistent routes, send one soldier per second and keep five',()=>{
  const s=create(),a=route(s);const neutral=s.owners[a.to];game.act(s,'p0',a,1000);assert.equal(s.owners[a.to],neutral);assert.equal(s.armies.length,0);
  game.tick(s,1500);assert.equal(s.armies.reduce((sum,a)=>sum+a.count,0),0);assert.equal(home(s).troops,30);
  game.tick(s,2000);assert.equal(s.armies.reduce((sum,a)=>sum+a.count,0),1);assert.equal(home(s).troops,30);
  game.tick(s,4000);assert.equal(s.owners[a.to],neutral,'first army must travel the entire road');
  game.tick(s,18000);assert.ok(home(s).troops>=5);assert.equal(s.orders[a.from].to,a.to);assert.equal(s.owners[a.to],'p0');
});

test('Adding and stopping routes preserves departed armies and cannot reset dispatch cadence',()=>{
  const s=create(),a=route(s),other=home(s).neighbors.find(id=>id!==a.to);home(s).level=2;game.act(s,'p0',a,1000);game.tick(s,2000);const first=structuredClone(s.armies[0]);
  game.act(s,'p0',{type:'link',from:a.from,to:other},2150);game.tick(s,3000);assert.deepEqual(s.armies[0],first);assert.deepEqual(s.armies.slice(1).map(a=>a.to).sort((a,b)=>a-b),[a.to,other].sort((a,b)=>a-b));assert.equal(s.armies.reduce((n,a)=>n+a.count,0),4);
  game.act(s,'p0',{type:'stop',towerId:a.from},3150);game.tick(s,3500);assert.equal(s.orders[a.from],null);assert.equal(s.armies.length,3);
});

test('Friendly relay receives before re-dispatching and never teleports to the final target',()=>{
  const s=create(),a=route(s),middle=s.towers[a.to],next=middle.neighbors.find(id=>id!==a.from);s.owners[middle.id]='p0';middle.troops=5;
  game.act(s,'p0',{type:'link',from:middle.id,to:next},1000);s.armies=[];packet(s,{from:a.from,to:middle.id,count:12,arrivesAt:2000});s.towers.forEach(t=>t.productionCredit=0);
  game.tick(s,2000);assert.equal(s.towers[middle.id].troops,17);assert.equal(s.armies.length,1);assert.equal(s.armies[0].from,middle.id);assert.equal(s.armies[0].count,1);assert.ok(s.armies[0].arrivesAt>2000);assert.equal(s.owners[next],null);
});

test('Enemy towers are attackable; 20 against 15 captures with five and clears old commands',()=>{
  const s=create(3),target=home(s,'p1');target.troops=15;target.productionAt=100000;s.orders[target.id]={from:target.id,to:target.neighbors[0],ownerKey:'p1',since:1000};
  packet(s,{ownerKey:'p0',to:target.id,count:20,arrivesAt:1125});game.tick(s,1125);
  assert.equal(s.owners[target.id],'p0');assert.equal(target.troops,5);assert.equal(s.orders[target.id],null);assert.equal(target.productionCredit,0);assert.ok(s.events.some(e=>e.type==='capture'&&e.towerId===target.id));
});

test('Equal attack leaves a zero-garrison tower with original owner, able to produce again',()=>{
  const s=create(3),target=home(s,'p1');target.troops=15;
  packet(s,{ownerKey:'p0',to:target.id,count:15,arrivesAt:1125});game.tick(s,1125);assert.equal(s.owners[target.id],'p1');assert.equal(target.troops,0);
  game.tick(s,2125);assert.equal(target.troops,1);
});

test('Opposing soldiers cancel on their actual road and survivors continue travelling',()=>{
  const s=create(3),[from,to]=s.edges[0];packet(s,{from,to,count:7,departedAt:1000,arrivesAt:3000});packet(s,{ownerKey:'p1',from:to,to:from,count:3,departedAt:1000,arrivesAt:3000});
  game.tick(s,1875);assert.equal(s.armies.length,2);game.tick(s,2000);assert.equal(s.armies.length,1);assert.equal(s.armies[0].ownerKey,'p0');assert.equal(s.armies[0].count,4);assert.equal(s.armies[0].arrivesAt,3000);
  assert.equal(s.events.find(e=>e.type==='road-battle').casualties,6);assert.equal(s.towers[to].troops,10,'no tower damage before arrival');
});

test('Different roads do not fight; arriving friendly packets merge without a troop cap',()=>{
  const s=create(3),target=home(s);target.troops=80;packet(s,{from:1,to:target.id,count:20,arrivesAt:2000});packet(s,{ownerKey:'p1',from:3,to:4,count:30,arrivesAt:3000});
  game.tick(s,2000);assert.equal(target.troops,100);assert.equal(s.armies[0].count,30);assert.ok(!s.events.some(e=>e.type==='road-battle'));
});

test('Three-way arrivals use coalition cancellation and are independent of insertion/seat ordering',()=>{
  for(const counts of [[5,4,2],[12,4,2]]){
    const make=reverse=>{const s=create(3),target=s.towers.find(t=>s.owners[t.id]===null&&!t.core);target.troops=0;const batch=counts.map((count,i)=>({ownerKey:'p'+i,from:i+20,to:target.id,count,arrivesAt:1125}));for(const a of reverse?batch.reverse():batch)packet(s,a);game.tick(s,1125);return{s,target};};
    const a=make(false),b=make(true);assert.equal(a.target.troops,b.target.troops);assert.equal(a.s.owners[a.target.id],b.s.owners[b.target.id]);
    assert.equal(a.target.troops,counts[0]===5?0:6);assert.equal(a.s.owners[a.target.id],counts[0]===5?null:'p0');
  }
});

test('Upgrade spends local troops, freezes production/dispatch, accepts aid, completes with new rate',()=>{
  const s=create(),id=home(s).id,a=route(s);game.act(s,'p0',a,1000);game.act(s,'p0',{type:'upgrade',towerId:id},1150);
  assert.equal(s.towers[id].troops,10);assert.equal(s.towers[id].upgrade.completesAt,4150);
  packet(s,{from:a.to,to:id,count:7,arrivesAt:2000});game.tick(s,4000);assert.equal(s.towers[id].troops,17);assert.equal(s.armies.length,0);assert.equal(s.towers[id].level,1);
  game.tick(s,4250);assert.equal(s.towers[id].level,2);assert.equal(s.towers[id].upgrade,null);assert.equal(s.towers[id].troops,17);
  game.act(s,'p0',{type:'stop',towerId:id},4250);game.tick(s,5250);assert.equal(s.towers[id].troops,19);assert.equal(game.view(s,'p0').towers[id].productionCap,60);
});

test('Upgrading requires reserve, disallows duplicate cost, max level and citadel upgrades atomically',()=>{
  const s=create(),id=home(s).id;s.towers[id].troops=24;
  let before=structuredClone(s);assert.throws(()=>game.act(s,'p0',{type:'upgrade',towerId:id},1000),code('INSUFFICIENT_TROOPS'));assert.deepEqual(s,before);
  s.towers[id].troops=25;game.act(s,'p0',{type:'upgrade',towerId:id},1000);assert.equal(s.towers[id].troops,5);before=structuredClone(s);
  assert.throws(()=>game.act(s,'p0',{type:'upgrade',towerId:id},1200),code('ALREADY_UPGRADING'));assert.deepEqual(s,before);
  game.tick(s,4000);s.towers[id].troops=35;game.act(s,'p0',{type:'upgrade',towerId:id},4000);assert.equal(s.towers[id].troops,5);assert.equal(s.towers[id].upgrade.completesAt,8000);
  game.tick(s,8000);assert.equal(s.towers[id].level,3);before=structuredClone(s);assert.throws(()=>game.act(s,'p0',{type:'upgrade',towerId:id},8200),code('MAX_LEVEL'));assert.deepEqual(s,before);
  s.owners[12]='p0';before=structuredClone(s);assert.throws(()=>game.act(s,'p0',{type:'upgrade',towerId:12},8200),code('NOT_UPGRADABLE'));assert.deepEqual(s,before);
});

test('Capturing a construction site cancels unfinished work, keeps completed level and never gifts the upgrade',()=>{
  const s=create(3),id=home(s).id;s.towers[id].level=2;s.towers[id].troops=40;
  game.act(s,'p0',{type:'upgrade',towerId:id},1000);packet(s,{ownerKey:'p1',from:home(s,'p1').id,to:id,count:16,arrivesAt:1125});game.tick(s,1125);
  assert.equal(s.owners[id],'p1');assert.equal(s.towers[id].troops,6);assert.equal(s.towers[id].level,2);assert.equal(s.towers[id].upgrade,null);
  game.tick(s,6000);assert.equal(s.towers[id].level,2);
});

test('A long clock jump equals many irregular observations with identical command history',()=>{
  const a=create(4),b=create(4);for(const key of Object.keys(a.players)){game.act(a,key,route(a,key),1000);game.act(b,key,route(b,key),1000);}
  game.tick(a,31017);for(let now=1031;now<31017;now+=173)game.tick(b,now);game.tick(b,31017);assert.deepEqual(a,b);
  const restored=JSON.parse(JSON.stringify(b));game.tick(a,81000);game.tick(restored,81000);assert.deepEqual(a,restored,'persisted snapshot resumes identically');
});

test('Troop conservation accounts only for production, upgrade cost and real casualties',()=>{
  const s=create(3),before=totals(s),id=home(s).id;game.act(s,'p0',{type:'upgrade',towerId:id},1000);assert.equal(totals(s),before-20);
  // Only the two unupgraded home towers produce for the next two seconds.
  game.act(s,'p1',route(s,'p1'),1000);game.tick(s,3000);assert.equal(totals(s),before-20+4);
  const a=create(3),target=a.towers.find(t=>!a.owners[t.id]&&!t.core);target.troops=10;packet(a,{from:30,to:target.id,count:7,arrivesAt:1125});const initial=totals(a);game.tick(a,1125);assert.equal(totals(a),initial-14);
});

test('Time-up ranks tower count first, total live troops second and preserves true ties',()=>{
  const s=create(4),a=home(s,'p0'),b=home(s,'p1');a.troops=90;b.troops=90;home(s,'p2').troops=1000;const neutral=s.towers.find(t=>!s.owners[t.id]&&!t.core);s.owners[neutral.id]='p0';
  assert.deepEqual(game.rank(s).map(p=>p.rank),[1,3,2,4]);
  s.owners[neutral.id]=null;home(s,'p2').troops=90;home(s,'p3').troops=90;game.tick(s,s.deadlineAt);assert.deepEqual(s.winnerKeys,['p0','p1','p2','p3']);assert.ok(game.rank(s).every(p=>p.rank===1));
});

test('At exactly 180s combat freezes and late arriving armies count but never capture',()=>{
  const s=create(3),target=home(s,'p1');game.tick(s,s.deadlineAt-125);packet(s,{to:target.id,count:100,departedAt:s.deadlineAt-2000,arrivesAt:s.deadlineAt});
  const before=structuredClone(s);assert.throws(()=>game.act(s,'p0',route(s),s.deadlineAt),code('DEADLINE_PASSED'));assert.deepEqual(s,before);
  game.tick(s,s.deadlineAt);assert.equal(s.status,'finished');assert.equal(s.finishReason,'deadline');assert.equal(s.owners[target.id],'p1');assert.equal(s.armies[0].count,100);
  const frozen={towers:structuredClone(s.towers),armies:structuredClone(s.armies),owners:[...s.owners],winners:[...s.winnerKeys]};game.tick(s,s.deadlineAt+10000);assert.deepEqual({towers:s.towers,armies:s.armies,owners:s.owners,winners:s.winnerKeys},frozen);
});

test('Losing the final tower does not eliminate a player with troops still travelling',()=>{
  const s=create(3),id=home(s).id;s.owners[id]='p1';packet(s,{from:id,to:s.towers[id].neighbors[0],count:20,arrivesAt:3000});game.tick(s,1125);assert.equal(s.players.p0.eliminated,false);assert.equal(s.players.p0.towers,0);
  game.tick(s,3000);assert.equal(s.players.p0.towers,1);assert.equal(s.players.p0.eliminated,false);
  s.owners[s.towers.find(t=>s.owners[t.id]==='p2').id]='p1';game.tick(s,3125);assert.equal(s.players.p2.eliminated,true);assert.equal(s.status,'active');
});

test('One remaining army/territory faction wins early without clearing neutral towers',()=>{
  const s=create(),enemy=home(s,'p1');s.owners[enemy.id]='p0';game.tick(s,1125);assert.equal(s.status,'finished');assert.equal(s.finishReason,'conquest');assert.deepEqual(s.winnerKeys,['p0']);assert.ok(s.owners.includes(null));
});

test('Forfeit neutralizes towers, cancels orders/construction/armies; simultaneous exits void',()=>{
  const s=create(3),id=home(s).id;game.act(s,'p0',{type:'upgrade',towerId:id},1000);packet(s,{ownerKey:'p0',count:8});game.forfeit(s,['p0'],1100);
  assert.equal(s.owners[id],null);assert.equal(s.towers[id].troops,10);assert.equal(s.towers[id].upgrade,null);assert.equal(s.armies.length,0);assert.equal(game.rank(s)[0].rank,null);
  game.forfeit(s,['p1'],1150);assert.equal(s.outcome,'forfeit');assert.deepEqual(s.winnerKeys,['p2']);
  const all=create(4);game.forfeit(all,['p0','p1','p2','p3'],1000);assert.equal(all.outcome,'void');assert.deepEqual(all.winnerKeys,[]);
  const intact=create(),before=structuredClone(intact);assert.throws(()=>game.forfeit(intact,['p1','unknown'],1500),code('INVALID_PLAYERS'));assert.deepEqual(intact,before);
});

test('Common recovery pause shifts troop travel, simulation, production, construction and events together',()=>{
  const a=create(3),b=create(3);for(const s of [a,b]){game.act(s,'p0',route(s),1000);game.act(s,'p1',{type:'upgrade',towerId:home(s,'p1').id},1000);game.tick(s,2000);}
  game.shiftTime(b,10000);assert.equal(b.armies[0].arrivesAt,a.armies[0].arrivesAt+10000);assert.equal(home(b,'p1').upgrade.completesAt,home(a,'p1').upgrade.completesAt+10000);assert.equal(b.events[0].at,a.events[0].at+10000);
  game.tick(a,7000);game.tick(b,17000);const unshifted=structuredClone(b);for(const field of ['startedAt','serverNow','simulationAt','deadlineAt'])unshifted[field]-=10000;
  assert.deepEqual(a.owners,unshifted.owners);assert.deepEqual(a.towers.map(t=>[t.troops,t.level]),unshifted.towers.map(t=>[t.troops,t.level]));assert.deepEqual(a.armies.map(a=>[a.ownerKey,a.from,a.to,a.count]),unshifted.armies.map(a=>[a.ownerKey,a.from,a.to,a.count]));
  for(const delta of [-1,.5,60001,NaN]){const before=structuredClone(b);assert.throws(()=>game.shiftTime(b,delta),code('INVALID_PAUSE'));assert.deepEqual(b,before);}
});

test('Invalid commands and future-state ownership rejection never mutate the input',()=>{
  const s=create(),a=route(s);
  for(const action of [null,{type:'link',from:-1,to:0},{type:'link',from:0,to:999},{type:'link',from:0,to:.5},{...a,score:999},{...a,timestamp:0},{type:'capture',from:a.from,to:a.to},{type:'upgrade',towerId:0,level:3},{type:'stop',from:0}]){const before=structuredClone(s);assert.throws(()=>game.act(s,'p0',action,1700));assert.deepEqual(s,before);}
  const missing=s.towers.find(t=>t.id!==a.from&&!s.towers[a.from].neighbors.includes(t.id));assert.throws(()=>game.act(s,'p0',{type:'link',from:a.from,to:missing.id},1000),code('INVALID_LINK'));
  for(const key of ['outsider','toString','__proto__','constructor']){assert.throws(()=>game.act(s,key,a,1000),code('NOT_A_PLAYER'));assert.throws(()=>game.view(s,key),code('NOT_A_PLAYER'));}
  const contested=create(3);packet(contested,{ownerKey:'p1',to:home(contested).id,count:90,arrivesAt:1125});const before=structuredClone(contested);assert.throws(()=>game.act(contested,'p0',route(contested),1250),code('NOT_YOUR_TOWER'));assert.deepEqual(contested,before);
});

test('Identity, entropy, action rate and all timed entry points are validated atomically',()=>{
  for(const ps of [[],['a'],['a','b','c','d','e'],['a','a'],['a','__proto__'],['a','constructor'],[null,{}],[{key:'a',seatIndex:1},{key:'b',seatIndex:1}],['a','x'.repeat(129)]])assert.throws(()=>game.createState(seed,1000,{players:ps}),code('INVALID_PLAYERS'));
  for(const value of ['',null,'g'.repeat(32),'a'.repeat(31)])assert.throws(()=>game.createState(value,1000,{players:['a','b']}),code('INVALID_SEED'));
  const s=create();for(const now of [-1,NaN,Infinity,1.2,999])for(const fn of [()=>game.act(s,'p0',route(s),now),()=>game.tick(s,now),()=>game.forfeit(s,['p1'],now),()=>game.botAction(s,'p0',now)]){const before=structuredClone(s);assert.throws(fn,code(now===999?'CLOCK_REWIND':'INVALID_TIME'));assert.deepEqual(s,before);}
  game.act(s,'p0',route(s),1000);const before=structuredClone(s);assert.throws(()=>game.act(s,'p0',{type:'stop',towerId:home(s).id},1149),code('BUSY'));assert.deepEqual(s,before);
});

for(const count of [2,3,4])test(`${count}-player bots use only legal public rules, finish and keep state bounded`,()=>{
  const s=create(count);let packets=0;
  for(let now=1000;now<=s.deadlineAt&&s.status==='active';now+=1200){game.tick(s,now);for(const key of Object.keys(s.players)){const action=game.botAction(s,key,now);if(action){assert.ok(game.view(s,key).legalActions.some(a=>JSON.stringify(a)===JSON.stringify(action)));game.act(s,key,action,now);}}packets=Math.max(packets,s.armies.length);}
  game.tick(s,s.deadlineAt);assert.equal(s.status,'finished');assert.ok(s.turn>count);assert.ok(s.events.length<=game.RULES.maxEvents);assert.ok(packets<=130);assert.ok(JSON.stringify(s).length<60000);
  for(const p of Object.values(s.players)){assert.equal(p.towers,s.owners.filter(key=>key===p.key).length);assert.equal(p.totalTroops,s.towers.filter(t=>s.owners[t.id]===p.key).reduce((n,t)=>n+t.troops,0)+s.armies.filter(a=>a.ownerKey===p.key).reduce((n,a)=>n+a.count,0));}
});

test('Public snapshots omit private state, retain seat colors across JSONB, and are detached',()=>{
  const s=game.createState(seed,1000,{players:[{key:'human_long_account',seatIndex:0},{key:'bot_1',seatIndex:1},{key:'bot_2',seatIndex:2}]});const v=game.view(s,'human_long_account');assert.equal(v.seed,undefined);assert.equal(v.events,undefined);assert.equal(v.towers[0].productionCredit,undefined);assert.equal(v.towers[0].productionAt,undefined);
  const restored=JSON.parse(JSON.stringify(s));restored.players=Object.fromEntries(Object.entries(restored.players).sort(([a],[b])=>a.length-b.length));assert.deepEqual(game.view(restored,'human_long_account').players,v.players);
  v.owners[0]='changed';v.towers[0].neighbors.length=0;v.players[0].score=999;assert.equal(s.owners[0],'human_long_account');assert.ok(s.towers[0].neighbors.length);assert.equal(s.players.human_long_account.score,1);
  const {event}=game.act(s,'human_long_account',route(s,'human_long_account'),1000);event.to=999;assert.notEqual(s.lastEvent.to,999);
});

test('Worker integrates bot orders and v2 actions while refusing any persisted v1 rule',()=>{
  const s=create(3),result=executeEngineTask({kind:'advance',gameId:'towerlink',ruleVersion:game.RULE_VERSION,state:s,now:2200,bots:[{key:'p1'},{key:'p2'}]});assert.equal(result.botUpdates.length,2);
  executeEngineTask({kind:'act',gameId:'towerlink',ruleVersion:game.RULE_VERSION,state:s,now:2200,playerKey:'p0',action:route(s)});assert.ok(s.orders[home(s).id]);
  assert.throws(()=>executeEngineTask({kind:'advance',gameId:'towerlink',ruleVersion:'towerlink-v1.1.0',state:s,now:2200}),code('PINNED_RULE_UNAVAILABLE'));
  for(const version of ['towerlink-v1.1.0','towerlink-v2.0.0'])assert.throws(()=>game.tick({...create(),ruleVersion:version},2200),code('PINNED_RULE_UNAVAILABLE'));
});

test('An off-grid upgrade completed before the arrival is kept by the capturing player',()=>{
  const s=create(3),id=home(s).id;game.act(s,'p0',{type:'upgrade',towerId:id},1060);
  packet(s,{ownerKey:'p1',from:home(s,'p1').id,to:id,count:20,arrivesAt:4125});game.tick(s,4125);
  assert.equal(s.owners[id],'p1');assert.equal(s.towers[id].level,2);assert.equal(s.towers[id].upgrade,null);
  assert.ok(s.events.some(e=>e.type==='upgrade-complete'&&e.at===4060));
});

test('Same-place three-way road combat is coalition-based rather than packet-order-based',()=>{
  const run=reverse=>{const s=create(3),[from,to]=s.edges[0],fixtures=[{ownerKey:'p0',from,to,count:5},{ownerKey:'p1',from:to,to:from,count:4},{ownerKey:'p2',from:to,to:from,count:2}];
    for(const a of reverse?fixtures.reverse():fixtures)packet(s,{...a,departedAt:1000,arrivesAt:3000});game.tick(s,2000);return s;};
  const a=run(false),b=run(true);assert.equal(a.armies.length,0);assert.equal(b.armies.length,0);assert.equal(a.events.find(e=>e.type==='road-battle').casualties,11);
});

test('The valid player ID "null" never receives neutral towers, troops, production or an unearned win',()=>{
  const s=game.createState(seed,1000,{players:['null','peer']});
  const neutrals=s.towers.filter(t=>s.owners[t.id]===null).map(t=>({id:t.id,troops:t.troops}));
  const initial=game.rank(s);assert.deepEqual(initial.map(p=>[p.playerKey,p.towers,p.totalTroops,p.rank]),[['null',1,30,1],['peer',1,30,1]]);
  const v=game.view(s,'null');assert.equal(v.players[0].towers,1);assert.equal(v.players[0].totalTroops,30);assert.ok(v.legalActions.every(a=>a.type!=='link'||s.owners[a.from]==='null'));
  game.tick(s,5000);assert.deepEqual(game.rank(s).map(p=>[p.towers,p.totalTroops,p.rank]),[[1,34,1],[1,34,1]]);
  for(const neutral of neutrals)assert.equal(s.towers[neutral.id].troops,neutral.troops,'neutral garrisons cannot produce for a string-named player');
  const restored=JSON.parse(JSON.stringify(s));game.tick(restored,restored.deadlineAt);assert.deepEqual(restored.winnerKeys,['null','peer']);assert.deepEqual(game.rank(restored).map(p=>[p.towers,p.totalTroops,p.rank]),[[1,40,1],[1,40,1]]);
});

test('A "null"-named player captures neutrals by real combat, while neutral defenders stay a separate coalition',()=>{
  const s=game.createState(seed,1000,{players:['null','peer','third']}),target=s.towers.find(t=>s.owners[t.id]===null&&!t.core);target.troops=10;
  packet(s,{ownerKey:'null',from:30,to:target.id,count:15,arrivesAt:1125});game.tick(s,1125);
  assert.equal(s.owners[target.id],'null');assert.equal(s.towers[target.id].troops,5);assert.equal(game.rank(s).find(p=>p.playerKey==='null').towers,2);
  const second=s.towers.find(t=>s.owners[t.id]===null&&!t.core);second.troops=10;
  packet(s,{ownerKey:'null',from:31,to:second.id,count:7,departedAt:1125,arrivesAt:1250});packet(s,{ownerKey:'peer',from:32,to:second.id,count:2,departedAt:1125,arrivesAt:1250});game.tick(s,1250);
  assert.equal(s.owners[second.id],null);assert.equal(second.troops,1,'10 neutral defenders minus 7 and 2 invaders leaves one neutral defender');
  assert.equal(game.rank(s).find(p=>p.playerKey==='null').towers,2);
});

test('Elimination and forfeit of a "null"-named player cannot inherit remaining neutral territory',()=>{
  const s=game.createState(seed,1000,{players:['null','peer','third']}),base=home(s,'null');s.owners[base.id]='peer';game.tick(s,1125);
  const eliminated=game.rank(s).find(p=>p.playerKey==='null');assert.equal(eliminated.towers,0);assert.equal(eliminated.totalTroops,0);assert.equal(eliminated.eliminated,true);assert.ok(s.owners.includes(null));
  const forfeited=game.createState(seed,1000,{players:['null','peer','third']});game.forfeit(forfeited,['null'],1000);
  const p=game.rank(forfeited).find(p=>p.playerKey==='null');assert.equal(p.towers,0);assert.equal(p.totalTroops,0);assert.equal(p.rank,null);assert.equal(forfeited.owners.filter(owner=>owner===null).length,11);
  game.tick(forfeited,forfeited.deadlineAt);assert.deepEqual(forfeited.winnerKeys,['peer','third']);
});

test('Nullable or non-string bot identities cannot coerce to legal string-named players',()=>{
  const s=game.createState(seed,1000,{players:['null','undefined','0']}),before=structuredClone(s);
  for(const identity of [null,undefined,0,{},['null']])assert.equal(game.botAction(s,identity,1000),null);
  assert.deepEqual(s,before);for(const key of ['null','undefined','0'])assert.ok(game.botAction(s,key,1000));
  assert.deepEqual(game.rank(s).map(p=>[p.towers,p.totalTroops]),[[1,30],[1,30],[1,30]]);
});
