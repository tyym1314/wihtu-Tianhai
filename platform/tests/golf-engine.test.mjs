import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,act,tick,view,rank,forfeit,simulateShot,shiftTime,botAction} from '../arena/golf/engine.mjs';
import {LEVELS,insideCourse} from '../arena/golf/levels.mjs';
const seed='42'.repeat(32),start=100000;
const fresh=(n=2)=>createState(seed,start,{ruleVersion:'pvp-golf-v1.0.0',players:Array.from({length:n},(_,i)=>({key:'p'+i,seatIndex:i,name:'Player '+i}))});
const angle=(a,b)=>Math.atan2(b.x-a.x,a.z-b.z);
test('three continuous shared courses contain tees/cups and deterministic fixed-step shots',()=>{
 for(const level of LEVELS){assert(insideCourse(level,level.tee.x,level.tee.z));assert(insideCourse(level,level.cup.x,level.cup.z));for(let a=-3;a<3;a+=.24){const one=simulateShot(level,level.tee,a,.85),two=simulateShot(level,level.tee,a,.85);assert.deepEqual(one,two);assert(one.duration<=8000);assert.notEqual(one.outcome,'fault');assert(one.trajectory.length<=242);}}
});
test('client cannot submit a position, score, out-of-bounds power, NaN, or shoot before busyUntil',()=>{
 const s=fresh();for(const action of [{type:'shot',angle:0,power:2},{type:'shot',angle:NaN,power:.5},{type:'shot',angle:0,power:.5,x:0},{type:'win',score:1}])assert.throws(()=>act(s,'p0',action,start),e=>e.code==='INVALID_ACTION');
 assert.equal(s.players[0].strokes,0);act(s,'p0',{type:'shot',angle:0,power:.5},start);assert.throws(()=>act(s,'p0',{type:'shot',angle:0,power:.5},start+1),e=>e.code==='BUSY');assert.equal(s.players[0].strokes,1);
});
test('falling through open boundary adds one shot plus one penalty and restores shot origin',()=>{
 const level=LEVELS[1],open=level.walls.filter(w=>!w.solid),edge=open[Math.floor(open.length/2)],mid={x:(edge.a.x+edge.b.x)/2,z:(edge.a.z+edge.b.z)/2},center=level.samples.reduce((best,p)=>Math.hypot(p.x-mid.x,p.z-mid.z)<Math.hypot(best.x-mid.x,best.z-mid.z)?p:best,level.samples[0]);
 const s=fresh();s.holeIndex=1;s.players[0].ball={x:center.x,z:center.z};const origin={...s.players[0].ball};const result=act(s,'p0',{type:'shot',angle:angle(origin,mid),power:.55},start);assert.equal(result.state.players[0].pending.outcome,'water');tick(s,s.players[0].busyUntil);assert.equal(s.players[0].strokes,2);assert.deepEqual(s.players[0].ball,origin);
});
test('tenth accepted shot that holes counts ten; a tenth miss records twelve',()=>{
 for(const success of [true,false]){const s=fresh(),p=s.players[0],cup=LEVELS[0].cup;p.strokes=9;p.ball={x:cup.x,z:cup.z+.5};act(s,'p0',{type:'shot',angle:success?0:Math.PI,power:.12},start);tick(s,p.busyUntil);assert.equal(p.completedScores[0],success?10:12);}
});
test('90-second deadline scores twelve even if the last accepted shot is still rolling',()=>{
 const s=fresh();for(const p of s.players){p.shotDeadlineAt=start+90000;p.timeouts=0;}act(s,'p0',{type:'shot',angle:0,power:1},start+89999);tick(s,start+90000);assert.equal(s.players[0].completedScores[0],12);assert.equal(s.phase,'intermission');assert.equal(s.nextHoleAt,start+95000);
});
test('twenty-second timeouts add one, third consecutive timeout forfeits all simultaneously',()=>{
 const s=fresh(4);tick(s,start+20000);assert(s.players.every(p=>p.strokes===1&&!p.forfeited));tick(s,start+60000);assert.equal(s.status,'finished');assert.equal(s.outcome,'void');assert.deepEqual(s.winnerKeys,[]);
});
test('three played holes progress through five-second intermissions, preserve ties, then end',()=>{
 const s=fresh(3);let now=start;
 for(let hole=0;hole<3;hole++){
  const cup=LEVELS[hole].cup;for(const p of s.players){p.ball={x:cup.x,z:cup.z+.5};act(s,p.key,{type:'shot',angle:0,power:.12},now);}
  now=Math.max(...s.players.map(p=>p.busyUntil));tick(s,now);
  if(hole<2){assert.equal(s.phase,'intermission');tick(s,now+4999);assert.equal(s.holeIndex,hole);now+=5000;tick(s,now);assert.equal(s.holeIndex,hole+1);}
 }
 assert.equal(s.status,'finished');assert(s.players.every(p=>p.completedScores.join(',')==='1,1,1'));assert.deepEqual(rank(s).map(p=>p.rank),[1,1,1]);assert.deepEqual(s.winnerKeys,['p0','p1','p2']);
 forfeit(s,['p0','p1','p2'],now+100000);assert.deepEqual(s.winnerKeys,['p0','p1','p2']);
});
test('ghost balls cannot change another shot, and JSON recovery retains exact outcome',()=>{
 const a=fresh(4),b=fresh(4);b.players[1].ball={...b.players[0].ball};b.players[2].ball={x:0,z:5};const action={type:'shot',angle:.08,power:.7};act(a,'p0',action,start);act(b,'p0',action,start);assert.deepEqual(a.players[0].pending,b.players[0].pending);const restored=JSON.parse(JSON.stringify(a));tick(a,a.players[0].busyUntil);tick(restored,restored.players[0].busyUntil);assert.deepEqual(a,restored);assert.equal(view(a,'p0').players.length,4);
});
test('forfeit batches never break ties by seat; pause shifting preserves relative animation time',()=>{
 const s=fresh(3);act(s,'p0',{type:'shot',angle:0,power:.3},start);const before=s.players[0].busyUntil-s.serverNow;shiftTime(s,2500);assert.equal(s.players[0].busyUntil-s.serverNow,before);forfeit(s,['p0','p1'],start+2500);assert.equal(s.status,'finished');assert.deepEqual(s.winnerKeys,['p2']);assert.equal(rank(s).find(p=>p.playerKey==='p2').rank,1);
});
test('all three islands are playable from tee to cup using ordinary legal actions, without position edits',()=>{
 const s=fresh(4);let now=start;
 for(let i=0;i<240&&s.status==='active';i++){for(const p of s.players){const action=botAction(s,p.key,now);if(action)act(s,p.key,action,now);}now+=1000;tick(s,now);}
 assert.equal(s.status,'finished');assert.equal(s.outcome,'completed');assert.equal(s.holeIndex,2);for(const p of s.players){assert.equal(p.completedScores.length,3);assert(p.completedScores.every(n=>n<=10));assert.equal(p.lastEvent.type,'hole');}assert.deepEqual(rank(s).map(p=>p.rank),[1,1,1,1]);
});
test('a third timeout and another player disconnecting in the same tick void together',()=>{
 const s=fresh();s.players[0].timeouts=2;forfeit(s,['p1'],start+20000);assert.equal(s.status,'finished');assert.equal(s.outcome,'void');assert.deepEqual(s.winnerKeys,[]);
});
test('the same batch still preserves a third-hole score fixed before simultaneous forfeits',()=>{
 const s=fresh(),cup=LEVELS[2].cup;s.holeIndex=2;for(const p of s.players)p.completedScores=[2,3];s.players[0].ball={x:cup.x,z:cup.z+.5};act(s,'p0',{type:'shot',angle:0,power:.12},start);const done=s.players[0].busyUntil;s.players[1].timeouts=2;s.players[1].shotDeadlineAt=done;forfeit(s,['p0','p1'],done);assert.equal(s.players[0].completedScores.length,3);assert.equal(s.players[0].forfeited,false);assert.deepEqual(s.winnerKeys,['p0']);assert.notEqual(s.outcome,'void');
});
test('third consecutive timeout cannot complete the final hole and beat an already valid finisher',()=>{
 const s=fresh();s.holeIndex=2;
 Object.assign(s.players[0],{completedScores:[1,1],strokes:7});
 Object.assign(s.players[1],{completedScores:[12,12,12],completed:true,completedAt:start,shotDeadlineAt:null});
 tick(s,start+60000);
 assert.equal(s.players[0].timeouts,3);assert.equal(s.players[0].strokes,10);assert.equal(s.players[0].forfeited,true);
 assert.equal(s.players[0].completed,false);assert.deepEqual(s.players[0].completedScores,[1,1]);assert.equal(s.players[0].lastEvent.type,'forfeit_timeout');
 assert.equal(s.status,'finished');assert.deepEqual(s.winnerKeys,['p1']);assert.equal(rank(s).find(p=>p.playerKey==='p0').eligible,false);
 assert.equal(s.players[1].forfeited,false);assert.deepEqual(s.players[1].completedScores,[12,12,12]);
});
test('same-tick third timeouts at the last-hole stroke limit void all players before awarding completed scores',()=>{
 for(const withExplicitForfeits of [false,true]){
  const s=fresh(4);s.holeIndex=2;for(const p of s.players)Object.assign(p,{completedScores:[1,1],strokes:9,timeouts:2});
  if(withExplicitForfeits)forfeit(s,['p2','p3'],start+20000);else tick(s,start+20000);
  assert.equal(s.status,'finished');assert.equal(s.outcome,'void');assert.deepEqual(s.winnerKeys,[]);
  for(const p of s.players){assert.equal(p.timeouts,3);assert.equal(p.forfeited,true);assert.equal(p.completed,false);assert.deepEqual(p.completedScores,[1,1]);}
  assert(rank(s).every(p=>!p.eligible&&p.forfeited));
 }
});
