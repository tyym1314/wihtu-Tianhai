import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const guides=JSON.parse(await readFile(new URL('../arena/golf/qa/ordinary-shot-guides.json',import.meta.url),'utf8'));
import * as golf from '../arena/golf/engine.mjs';
import * as legacy from '../arena/golf/engine-v1.mjs';
import {LEVELS,insideCourse,nearestOnSegment,BALL_RADIUS,WALL_HALF_WIDTH} from '../arena/golf/levels-v1.mjs';
import {GOLF_HOLES,CONTENT_VERSION,roundGolfHole,selectGolfHoles} from '../arena/golf/content.mjs';
const players=Array.from({length:4},(_,i)=>({key:'p'+i,seatIndex:i}));
const seedFor=k=>Math.floor(k/2).toString(16).padStart(8,'0')+(k%2).toString(16).padStart(8,'0')+'00'.repeat(24);

test('nine physical layouts preserve authored walls/cups and keep tees/obstacles clear',()=>{
 assert.equal(GOLF_HOLES.length,9);assert.equal(new Set(GOLF_HOLES.map(h=>h.id)).size,9);
 for(const difficulty of['easy','medium','hard'])assert.equal(GOLF_HOLES.filter(h=>h.difficulty===difficulty).length,3);
 for(const h of GOLF_HOLES){
  const base=LEVELS[h.artIndex];assert.equal(h.polygon,base.polygon);assert.equal(h.walls,base.walls);assert.equal(h.cup,base.cup);assert.equal(h.bridgeAt,base.bridgeAt);
  assert(insideCourse(h,h.tee.x,h.tee.z));for(const w of h.walls){const q=nearestOnSegment(h.tee.x,h.tee.z,w.a,w.b);assert(Math.hypot(q.x-h.tee.x,q.z-h.tee.z)>BALL_RADIUS+WALL_HALF_WIDTH,`${h.id} tee wall clearance`);}
  for(const b of h.bumpers){assert(Math.hypot(b.x-h.tee.x,b.z-h.tee.z)>b.r+BALL_RADIUS+.1);assert(Math.hypot(b.x-h.cup.x,b.z-h.cup.z)>b.r+h.holeRadius+.1);for(let a=0;a<Math.PI*2;a+=Math.PI/8)assert(insideCourse(h,b.x+Math.sin(a)*(b.r+.1),b.z+Math.cos(a)*(b.r+.1)),`${h.id} obstacle inside authored green`);}
 }
 assert.equal(new Set(GOLF_HOLES.map(h=>JSON.stringify([h.tee,h.bumpers]))).size,9);
});
test('server seed pins three difficulties and distinct art layouts; all nine appear across rounds',()=>{
 const seen=new Set(),orders=new Set();for(let k=0;k<6;k++){
  const seed=seedFor(k),s=golf.createState(seed,100000,{players});assert.deepEqual(s.holeIds,selectGolfHoles(seed));orders.add(s.holeIds.join(','));assert.equal(s.contentVersion,CONTENT_VERSION);
  assert.deepEqual(s.holeIds.map((id,i)=>roundGolfHole(s,i).difficulty),['easy','medium','hard']);assert.equal(new Set(s.holeIds.map((id,i)=>roundGolfHole(s,i).artIndex)).size,3);s.holeIds.forEach(id=>seen.add(id));
  const view=golf.view(s,'p0');assert.deepEqual(view.holeIds,s.holeIds);view.holeIds.reverse();assert.notDeepEqual(view.holeIds,s.holeIds);
 }
 assert.equal(seen.size,9);assert.equal(orders.size,6);
});
test('all nine holes finish through accepted 0.01-radian/0.01-power guide shots with no ball or score edits',()=>{
 const seen=new Set();for(let k=0;k<6;k++){
  const s=golf.createState(seedFor(k),100000,{players});let now=100000;
  for(let i=0;i<400&&s.status==='active';i++){
   for(const p of s.players){const can=golf.botAction(s,p.key,now);if(can){const a=guides[s.holeIds[s.holeIndex]][p.strokes];assert(a,'guide must finish before its actions end');golf.act(s,p.key,a,now);}}
   now+=500;golf.tick(s,now);
  }
  assert.equal(s.outcome,'completed');for(const p of s.players){assert.equal(p.completedScores.length,3);assert(p.completedScores.every(n=>n>0&&n<=10),`${s.holeIds}: ${p.completedScores}`);assert.equal(p.lastEvent.type,'hole');}s.holeIds.forEach(id=>seen.add(id));assert.deepEqual(golf.rank(s).map(p=>p.rank),[1,1,1,1]);
 }
 assert.equal(seen.size,9);
});
test('pinned v1 delegation preserves state, accepted pending trajectory and all public operations',()=>{
 const seed=seedFor(0),a=legacy.createState(seed,100000,{players}),b=golf.createState(seed,100000,{players,ruleVersion:legacy.RULE_VERSION});assert.deepEqual(b,a);
 const action={type:'shot',angle:.07,power:.58};assert.deepEqual(golf.act(b,'p0',action,100000),legacy.act(a,'p0',action,100000));
 const restored=JSON.parse(JSON.stringify(b));assert.deepEqual(golf.view(restored,'p0'),legacy.view(a,'p0'));assert.deepEqual(golf.botAction(restored,'p1',100000),legacy.botAction(a,'p1',100000));
 golf.tick(restored,102000);legacy.tick(a,102000);assert.deepEqual(restored,a);golf.shiftTime(restored,1500);legacy.shiftTime(a,1500);assert.deepEqual(restored,a);
 golf.forfeit(restored,['p0','p1','p2'],103500);legacy.forfeit(a,['p0','p1','p2'],103500);assert.deepEqual(restored,a);assert.deepEqual(golf.rank(restored),legacy.rank(a));
});
test('unchanged default direction/power needs more strokes than a deliberate guide on every hole',()=>{
 for(const h of GOLF_HOLES){let ball={...h.tee},strokes=0,outcome='stopped';const angle=Math.atan2(h.cup.x-h.tee.x,h.tee.z-h.cup.z);while(strokes<10&&outcome!=='hole'){const shot=golf.simulateShot(h,ball,angle,.58);strokes+=shot.outcome==='water'?2:1;ball=shot.ball;outcome=shot.outcome;}assert((outcome==='hole'?strokes:12)>guides[h.id].length,h.id);}
});
test('practice bots finish all six seeded rounds through the same legal act API',()=>{
 for(let k=0;k<6;k++){const s=golf.createState(seedFor(k),100000,{players});let now=100000;for(let i=0;i<400&&s.status==='active';i++){for(const p of s.players){const action=golf.botAction(s,p.key,now);if(action)golf.act(s,p.key,action,now);}now+=500;golf.tick(s,now);}assert.equal(s.outcome,'completed');assert(s.players.every(p=>p.completedScores.length===3&&p.completedScores.every(n=>n<=10)&&p.lastEvent.type==='hole'));}
});
test('new round JSON recovery preserves selected content and accepted trajectory; unavailable versions fail closed',()=>{
 const s=golf.createState(seedFor(0),100000,{players});golf.act(s,'p0',{type:'shot',angle:.2,power:.4},100000);const restored=JSON.parse(JSON.stringify(s)),pending=structuredClone(restored.players[0].pending);
 golf.tick(restored,restored.players[0].busyUntil);assert.deepEqual(restored.players[0].trajectory,pending.trajectory);assert.deepEqual(restored.holeIds,s.holeIds);
 const wrong={...s,ruleVersion:'pvp-golf-future'};for(const f of[()=>golf.act(wrong,'p0',{},100000),()=>golf.tick(wrong,100000),()=>golf.view(wrong,'p0'),()=>golf.rank(wrong),()=>golf.forfeit(wrong,[],100000),()=>golf.shiftTime(wrong,100),()=>golf.botAction(wrong,'p0',100000)])assert.throws(f,e=>e.code==='PINNED_RULE_UNAVAILABLE');
 assert.throws(()=>golf.createState(seedFor(0),100000,{players,ruleVersion:'future'}),e=>e.code==='PINNED_RULE_UNAVAILABLE');assert.throws(()=>golf.view({...s,holeIds:['missing',...s.holeIds.slice(1)]},'p0'),e=>e.code==='PINNED_CONTENT_UNAVAILABLE');
});
