import test from 'node:test';import assert from 'node:assert/strict';
import * as game from '../arena/towerlink/engine.mjs';import * as legacy from '../arena/towerlink/engine-v2.1.mjs';
import {createBoard,LEVELS,LEVEL_VERSION} from '../arena/towerlink/levels.mjs';
import {getTrainingLesson} from '../arena/towerlink/training.mjs';
import {findSeed,graphMetrics,playMap} from '../arena/towerlink/qa/content-evidence.mjs';
const options=count=>({players:Array.from({length:count},(_,i)=>'p'+i)}),sort=a=>a.sort((a,b)=>a-b);
const rotated=(map,id)=>{const n=map.level.playerCount,o=map.board.outerCount,i=map.board.innerCount;return id===12?12:id<o?(id+o/n)%o:o+(id-o+i/n)%i;};
test('Six maps provide three graph families, including a real central supply choke',()=>{
 assert.equal(LEVELS.length,6);assert.equal(new Set(LEVELS.map(l=>l.topology)).size,3);
 for(const l of LEVELS){const m=createBoard(l.playerCount,l.variant),r=graphMetrics(m);assert.equal(l.contentVersion,LEVEL_VERSION);assert.deepEqual(r.components,[13]);
  if(l.topology==='bridgehead'){assert.equal(r.cycleRank,0);assert.equal(r.withoutCore.length,m.board.innerCount);assert.equal(r.leafCount,m.board.outerCount);}
  else{assert.deepEqual(r.withoutCore,[12]);assert.ok(r.cycleRank>=8);assert.equal(r.leafCount,0);assert.equal(r.innerEdges>0,l.topology==='supply-web');}
 }
});
test('All roads are legal and rotation preserves topology, travel times and starting positions',()=>{
 for(const l of LEVELS){const m=createBoard(l.playerCount,l.variant),rot=id=>rotated(m,id),lookup=new Map(m.roads.map(r=>[r.id,r.travelMs]));
  assert.deepEqual(m.starts.map(rot),[...m.starts.slice(1),m.starts[0]]);assert.equal(m.roads.length,m.edges.length);
  for(const t of m.towers){assert.deepEqual(sort(t.neighbors.map(rot)),m.towers[rot(t.id)].neighbors);assert.equal(t.kind,m.towers[rot(t.id)].kind);for(const n of t.neighbors){const[a,b]=sort([rot(t.id),rot(n)]);assert.equal(lookup.get(sort([t.id,n]).join(':')),lookup.get(`${a}:${b}`));}}
  for(const road of m.roads){assert.ok(road.travelMs>=2000&&road.travelMs<=5000);assert.equal(road.travelMs%game.RULES.stepMs,0);}
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for(let i=0;i<m.edges.length;i++)for(let j=i+1;j<m.edges.length;j++){const[a,b]=m.edges[i],[c,d]=m.edges[j];if([a,b].includes(c)||[a,b].includes(d))continue;assert.ok(!(cross(m.towers[a],m.towers[b],m.towers[c])*cross(m.towers[a],m.towers[b],m.towers[d])<-1e-9&&cross(m.towers[c],m.towers[d],m.towers[a])*cross(m.towers[c],m.towers[d],m.towers[b])<-1e-9));}
 }
});
test('Every map completes a legal 250ms worker replay with captures and upgrade decisions',()=>{
 for(const l of LEVELS){const r=playMap(l);assert.equal(r.status,'finished');assert.ok(r.actions.length>10);assert.ok(r.captures>=l.playerCount);assert.ok(r.upgrades>0);const idle=playMap(l,{idle:true});assert.equal(idle.captures,0);assert.equal(idle.finishedAt,181000);assert.notDeepEqual(r.ranks,idle.ranks);}
});
test('Rotated simultaneous orders have equal growth, capture and rank without a seat bonus',()=>{
 for(const l of LEVELS){const m=createBoard(l.playerCount,l.variant),s=game.createState(findSeed(l),1000,options(l.playerCount));let from=m.starts[0],to=m.towers[from].neighbors[0];for(let i=0;i<l.playerCount;i++){game.act(s,'p'+i,{type:'link',from,to},1000);from=rotated(m,from);to=rotated(m,to);}game.tick(s,25000);const ps=game.rank(s);assert.ok(ps.every(p=>p.towers===ps[0].towers&&p.totalTroops===ps[0].totalTroops&&p.rank===1));}
});
test('New serialized maps retain exact roads, pending armies and accepted results through recovery',()=>{
 for(const l of LEVELS){const s=game.createState(findSeed(l),1000,options(l.playerCount)),home=s.owners.indexOf('p0'),a={type:'link',from:home,to:s.towers[home].neighbors[0]};game.act(s,'p0',a,1000);game.tick(s,3000);assert.ok(s.armies.length);game.act(s,'p0',{type:'upgrade',towerId:home},3000);const b=JSON.parse(JSON.stringify(s)),geometry=structuredClone({level:s.level,edges:s.edges,roads:s.roads});game.shiftTime(s,1500);game.shiftTime(b,1500);game.tick(s,31000);game.tick(b,31000);assert.deepEqual(s,b);assert.deepEqual({level:s.level,edges:s.edges,roads:s.roads},geometry);assert.deepEqual(game.view(s,'p0'),game.view(b,'p0'));game.tick(s,s.deadlineAt);game.tick(b,b.deadlineAt);assert.deepEqual(game.rank(s),game.rank(b));assert.deepEqual(s,b);}
});
test('Pinned 2.1 waiting, active, pending and finished states execute the complete original branch',()=>{
 for(const count of[2,3,4]){const seed='01'.repeat(16),opts={...options(count),ruleVersion:legacy.RULE_VERSION,startAt:4000},a=legacy.createState(seed,1000,opts),b=game.createState(seed,1000,opts);assert.deepEqual(a,b);legacy.tick(a,4000);game.tick(b,4000);const id=a.owners.indexOf('p0'),action={type:'link',from:id,to:a.towers[id].neighbors[0]};assert.deepEqual(legacy.act(a,'p0',action,4000),game.act(b,'p0',action,4000));legacy.tick(a,6500);game.tick(b,6500);legacy.act(a,'p0',{type:'upgrade',towerId:id},6500);game.act(b,'p0',{type:'upgrade',towerId:id},6500);assert.ok(b.armies.length&&b.towers[id].upgrade);const restored=JSON.parse(JSON.stringify(b));legacy.shiftTime(a,2300);game.shiftTime(restored,2300);legacy.tick(a,24000);game.tick(restored,24000);assert.deepEqual(a,restored);assert.deepEqual(legacy.botAction(a,'p1',24000),game.botAction(restored,'p1',24000));assert.deepEqual(legacy.view(a,'p0'),game.view(restored,'p0'));legacy.forfeit(a,['p1'],24500);game.forfeit(restored,['p1'],24500);legacy.tick(a,a.deadlineAt);game.tick(restored,restored.deadlineAt);assert.deepEqual(a,restored);assert.deepEqual(legacy.rank(a),game.rank(restored));}
 assert.ok(game.supportsRuleVersion(game.RULE_VERSION));assert.ok(game.supportsRuleVersion(legacy.RULE_VERSION));for(const v of[null,undefined,'towerlink-v1.0.0','towerlink-v2.3.0']){assert.equal(game.supportsRuleVersion(v),false);if(v!==undefined)assert.throws(()=>game.createState('01'.repeat(16),1000,{...options(2),ruleVersion:v}),e=>e.code==='PINNED_RULE_UNAVAILABLE');}
});

test('Bridgehead supply upgrade strategy breaks the equal-bot central stalemate legally',()=>{for(const level of LEVELS.filter(l=>l.topology==='bridgehead')){const r=playMap(level,{centralRush:true});assert.equal(r.status,'finished');assert.ok(r.centralCapturedAt>1000&&r.centralCapturedAt<41000);assert.equal(r.ranks.find(p=>p.playerKey==='p0').rank,1);assert.ok(r.ranks.filter(p=>p.playerKey!=='p0').every(p=>p.rank>1));}});
test('All twelve training initial states preserve old geometry, objectives and entropy domain',()=>{for(let number=1;number<=12;number++)for(const seed of['00'.repeat(16),'03'.repeat(16)]){const trainingLessonId='lesson-'+String(number).padStart(2,'0'),count=getTrainingLesson(trainingLessonId).playerCount,opts={players:Array.from({length:count},(_,i)=>({key:'p'+i,isBot:i>0})),trainingLessonId};const a=legacy.createState(seed,1000,opts),b=game.createState(seed,1000,opts);b.ruleVersion=a.ruleVersion;assert.deepEqual(b,a);}});
