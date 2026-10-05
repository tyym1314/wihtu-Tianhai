// Frozen 2.1 fixtures remain legacy regressions; current 2.2 maps/flows are covered by content, training and layout suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as game from '../arena/towerlink/engine-v2.1.mjs';

const make=()=>game.createState('01'.repeat(16),1000,{players:['p0','p1','p2','p3']});
const home=s=>s.towers.find(t=>s.owners[t.id]==='p0');
const routes=(s,id)=>game.view(s,'p0').orders.filter(order=>order.from===id);
const sent=(s,id,since=0)=>s.armies.filter(a=>a.from===id&&a.departedAt>=since).reduce((total,a)=>total+a.count,0);
function ready({level=3,scarce=false,citadel=false}={}){
  const s=make(),tower=citadel?s.towers[12]:s.towers.filter(t=>t.kind==='barracks').sort((a,b)=>b.neighbors.length-a.neighbors.length)[0];
  s.owners[tower.id]='p0';tower.level=level;tower.troops=scarce?5:1000;
  // Keep real dispatches in flight so arrival combat cannot distort counts.
  for(const road of s.roads)road.travelMs=100000;
  const limit=citadel?2:level,neighbors=tower.neighbors.slice(0,limit);
  let now=1000;for(const to of neighbors){game.act(s,'p0',{type:'link',from:tower.id,to},now);now+=150;}
  return{s,id:tower.id,neighbors,now};
}

for(const level of [1,2,3])test(`Lv.${level} supports exactly ${level} routes sharing ${level} soldiers per second`,()=>{
  const {s,id,neighbors}=ready({level});assert.equal(neighbors.length,level);
  assert.deepEqual(routes(s,id).map(order=>order.to),neighbors);
  const extra=s.towers[id].neighbors.find(to=>!neighbors.includes(to)),before=structuredClone(s);
  if(extra!==undefined){assert.throws(()=>game.act(s,'p0',{type:'link',from:id,to:extra},1500),e=>e.code==='ROUTE_LIMIT_REACHED');assert.deepEqual(s,before);}
  game.tick(s,2000);const initial=sent(s,id);game.tick(s,12000);assert.equal(sent(s,id)-initial,10*level);
  const counts=neighbors.map(to=>s.armies.filter(a=>a.from===id&&a.to===to&&a.departedAt>2000).reduce((n,a)=>n+a.count,0));assert.deepEqual(counts,neighbors.map(()=>10));
  const v=game.view(s,'p0');assert.equal(v.towers[id].dispatchRate,level);assert.equal(v.towers[id].routeLimit,level);assert.ok(v.legalActions.filter(a=>a.from===id).every(a=>a.type==='unlink'));
});

test('The central citadel stays at two soldiers per second and two routes independently of its level field',()=>{
  const {s,id,neighbors}=ready({citadel:true});const v=game.view(s,'p0');assert.equal(v.towers[id].productionRate,2);assert.equal(v.towers[id].productionCap,60);assert.equal(v.towers[id].dispatchRate,2);assert.equal(v.towers[id].routeLimit,2);
  const extra=s.towers[id].neighbors.find(to=>!neighbors.includes(to));assert.throws(()=>game.act(s,'p0',{type:'link',from:id,to:extra},1500),e=>e.code==='ROUTE_LIMIT_REACHED');game.tick(s,11000);assert.equal(sent(s,id),20);
});

test('A single route receives the entire level allowance rather than one soldier per road',()=>{
  for(const level of [1,2,3]){const s=make(),id=home(s).id;home(s).level=level;game.act(s,'p0',{type:'link',from:id,to:home(s).neighbors[0]},1000);game.tick(s,2000);assert.equal(sent(s,id),level);assert.equal(s.armies.length,1);}
});

test('Lv.3 with two active routes rotates its odd remainder with exact long-term equality',()=>{
  const {s,id,neighbors}=ready();game.act(s,'p0',{type:'unlink',from:id,to:neighbors[2]},1450);game.tick(s,3000);
  const counts=neighbors.slice(0,2).map(to=>s.armies.filter(a=>a.from===id&&a.to===to).reduce((n,a)=>n+a.count,0));assert.deepEqual(counts,[3,3]);
  assert.deepEqual(s.armies.filter(a=>a.from===id&&a.departedAt===2000).map(a=>a.count).sort(),[1,2]);
});

test('When attacks leave only one dispatchable soldier, all active routes take turns fairly and preserve five defenders',()=>{
  const {s,id,neighbors}=ready({scarce:true});
  for(let at=2000;at<=10000;at+=1000){s.armies.push({id:`damage:${at}`,ownerKey:'p1',from:99,to:id,count:2,departedAt:at-500,arrivesAt:at});game.tick(s,at);assert.equal(s.towers[id].troops,5);}
  const counts=neighbors.map(to=>s.armies.filter(a=>a.from===id&&a.to===to).reduce((n,a)=>n+a.count,0));assert.deepEqual(counts,[3,3,3]);assert.ok(s.armies.filter(a=>a.from===id).every(a=>a.count===1));
});

test('Duplicate link is valid even at the route limit, preserves activation time and does not duplicate allocation',()=>{
  const {s,id,neighbors}=ready({level:2});game.act(s,'p0',{type:'link',from:id,to:neighbors[0]},1300);assert.equal(routes(s,id).length,2);assert.equal(routes(s,id)[0].since,1000);
  game.tick(s,2000);assert.deepEqual(s.armies.filter(a=>a.from===id).map(a=>a.count),[1,1]);const departed=structuredClone(s.armies);
  game.act(s,'p0',{type:'unlink',from:id,to:neighbors[0]},2000);assert.deepEqual(routes(s,id).map(r=>r.to),[neighbors[1]]);assert.equal(s.orders[id].to,neighbors[1]);
  game.act(s,'p0',{type:'unlink',from:id,to:neighbors[0]},2150);game.tick(s,3000);assert.deepEqual(s.armies.slice(0,2),departed);assert.equal(s.armies.at(-1).to,neighbors[1]);assert.equal(s.armies.at(-1).count,2);
  game.act(s,'p0',{type:'stop',towerId:id},3000);game.tick(s,4000);assert.deepEqual(routes(s,id),[]);assert.equal(s.orders[id],null);assert.equal(sent(s,id),4);
});

test('Repeated link/unlink commands cannot borrow old dispatches or reset a tower allowance',()=>{
  const s=make(),id=home(s).id,[a,b]=s.towers[id].neighbors;home(s).level=2;home(s).troops=1000;game.act(s,'p0',{type:'link',from:id,to:a},1000);
  for(const [at,type,to]of [[1150,'link',b],[1300,'unlink',a],[1450,'link',a],[1600,'unlink',b],[1750,'link',b],[1900,'link',b]])game.act(s,'p0',{type,from:id,to},at);
  game.tick(s,2000);assert.equal(sent(s,id),2);game.tick(s,3000);assert.equal(sent(s,id),4);
  for(const r of routes(s,id))assert.ok(s.armies.filter(a=>a.from===id&&a.to===r.to).every(a=>a.departedAt>r.since));
});

test('A route created exactly at a dispatch boundary cannot receive the already elapsed batch',()=>{
  const s=make(),id=home(s).id,[a,b]=s.towers[id].neighbors;home(s).level=2;game.act(s,'p0',{type:'link',from:id,to:a},1000);game.act(s,'p0',{type:'link',from:id,to:b},2000);
  assert.equal(sent(s,id),2);assert.ok(!s.armies.some(a=>a.from===id&&a.to===b));game.tick(s,3000);assert.equal(s.armies.find(a=>a.from===id&&a.to===b).departedAt,3000);
});

test('Construction pauses all routes while permitting edits within the completed level limit',()=>{
  const {s,id,neighbors}=ready({level:2});game.act(s,'p0',{type:'upgrade',towerId:id},1300);game.act(s,'p0',{type:'unlink',from:id,to:neighbors[0]},1450);
  const extra=s.towers[id].neighbors.find(to=>!neighbors.includes(to));game.act(s,'p0',{type:'link',from:id,to:extra},1600);
  const before=structuredClone(s);assert.throws(()=>game.act(s,'p0',{type:'link',from:id,to:neighbors[0]},1750),e=>e.code==='ROUTE_LIMIT_REACHED');assert.deepEqual(s,before);
  game.tick(s,5250);assert.equal(sent(s,id),0);assert.equal(s.towers[id].troops,970);game.tick(s,5500);assert.equal(s.towers[id].level,3);assert.equal(sent(s,id),0);
  game.act(s,'p0',{type:'link',from:id,to:neighbors[0]},5500);game.tick(s,6000);assert.equal(sent(s,id),3);assert.equal(routes(s,id).length,3);
});

test('Unused dispatch allowance never banks up during idle or construction intervals',()=>{
  const s=make(),id=home(s).id;home(s).level=3;home(s).troops=1000;game.tick(s,31000);game.act(s,'p0',{type:'link',from:id,to:home(s).neighbors[0]},31000);assert.equal(sent(s,id),0);game.tick(s,32000);assert.equal(sent(s,id),3);
});

test('Capturing or forfeiting a multi-route tower clears all lines and its round-robin cursor',()=>{
  const {s,id}=ready();s.towers[id].troops=0;s.armies.push({id:'capture-fixture',ownerKey:'p1',from:99,to:id,count:10,departedAt:1000,arrivesAt:1750});game.tick(s,1750);
  assert.equal(s.owners[id],'p1');assert.equal(s.orders[id],null);assert.equal(s.towers[id].dispatchCursor,0);assert.ok(!game.view(s,'p1').orders.some(r=>r.from===id));
  const {s:f,id:fid}=ready();game.forfeit(f,['p0'],1750);assert.equal(f.orders[fid],null);assert.equal(f.towers[fid].dispatchCursor,0);assert.ok(!f.armies.some(a=>a.ownerKey==='p0'));
});

test('JSON persistence and common pause preserve every activation and odd-remainder rotation',()=>{
  const {s,id,neighbors}=ready();game.act(s,'p0',{type:'unlink',from:id,to:neighbors[2]},1450);game.tick(s,2500);const restored=JSON.parse(JSON.stringify(s)),shifted=JSON.parse(JSON.stringify(s)),before=routes(s,id);game.shiftTime(shifted,7000);
  assert.deepEqual(routes(shifted,id),before.map(r=>({...r,since:r.since+7000})));game.tick(s,14000);game.tick(restored,14000);game.tick(shifted,21000);assert.deepEqual(restored,s);
  assert.deepEqual(shifted.armies.map(a=>({...a,departedAt:a.departedAt-7000,arrivesAt:a.arrivesAt-7000})),s.armies);assert.equal(shifted.towers[id].dispatchCursor,s.towers[id].dispatchCursor);
});

test('Public routes stay detached and flat while public rules describe all rates and limits',()=>{
  const {s,id}=ready(),v=game.view(s,'p0');assert.equal(v.orders.length,3);assert.equal(v.towers[id].dispatchCursor,undefined);for(const r of v.orders)assert.deepEqual(Object.keys(r).sort(),['from','ownerKey','since','to']);
  assert.equal(v.rules.dispatchIntervalMs,1000);assert.deepEqual(v.rules.dispatchByLevel,[1,2,3]);assert.deepEqual(v.rules.routesByLevel,[1,2,3]);assert.equal(v.rules.citadelRouteLimit,2);assert.equal(v.rules.dispatchPerSecond,undefined);
  v.orders[0].to=999;assert.notEqual(routes(s,id)[0].to,999);
});

test('Unlink rejects enemy and non-adjacent towers atomically under the same command rate limit',()=>{
  const s=make(),id=home(s).id,bad=s.towers.find(t=>t.id!==id&&!s.towers[id].neighbors.includes(t.id)).id,enemy=s.towers.find(t=>s.owners[t.id]==='p1');
  for(const action of [{type:'unlink',from:id,to:bad},{type:'unlink',from:enemy.id,to:enemy.neighbors[0]},{type:'unlink',from:id,to:s.towers[id].neighbors[0],extra:true}]){const before=structuredClone(s);assert.throws(()=>game.act(s,'p0',action,1500));assert.deepEqual(s,before);}
});

test('Bots respect each level route capacity and open multiple useful fronts after upgrading',()=>{
  for(const level of [1,2,3]){const s=make(),id=home(s).id;home(s).level=level;home(s).troops=30;
    for(let n=0;n<level;n++){const now=1000+n*150,action=game.botAction(s,'p0',now);assert.equal(action.type,'link');assert.ok(!routes(s,id).some(r=>r.to===action.to));game.act(s,'p0',action,now);}
    assert.equal(routes(s,id).length,level);assert.equal(game.botAction(s,'p0',1000+level*150),null);
  }
});
