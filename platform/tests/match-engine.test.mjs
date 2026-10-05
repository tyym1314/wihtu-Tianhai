import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, act, tick, view, rank, forfeit, shiftTime, botAction, matches, legalMoves, testing, RULES, RULE_VERSION } from '../arena/match/engine-v1.mjs';
const seed='01'.repeat(32), roster=[{key:'a',seatIndex:0},{key:'b',seatIndex:1},{key:'c',seatIndex:2}];
const fresh=()=>createState(seed,1000,{players:roster});
const clone=value=>JSON.parse(JSON.stringify(value));
const base=()=>Array.from({length:36},(_,id)=>({id,color:(Math.floor(id/6)+2*(id%6))%5,special:null}));
const paint=(board,indices,color)=>indices.forEach(index=>{board[index].color=color;});
const code=value=>error=>error.code===value;

test('initial boards are equal, stable, playable; each player has independent persistent streams',()=>{
 for(let i=0;i<80;i++){
  const s=createState(i.toString(16).padStart(64,'0'),0,{players:roster});
  assert.equal(matches(s.players.a.board).length,0);assert.ok(legalMoves(s.players.a.board).length);assert.deepEqual(s.players.a.board,s.players.b.board);assert.notEqual(s.players.a.board,s.players.b.board);
 }
 const s=fresh(), before=clone(s.players.b);act(s,'a',legalMoves(s.players.a.board)[0],1000);assert.deepEqual(s.players.b,before);
});
test('identical inputs and timestamps replay identical scores, boards and column refill positions through JSON',()=>{
 let state=fresh(), now=1000;
 for(let i=0;i<35;i++){
  const move=legalMoves(state.players.a.board)[i%legalMoves(state.players.a.board).length];
  const a=act(state,'a',move,now);const b=act(state,'b',move,now);
  assert.deepEqual(state.players.a.board,state.players.b.board);assert.deepEqual(state.players.a.refillCounters,state.players.b.refillCounters);assert.equal(state.players.a.score,state.players.b.score);
  const restored=clone(state);assert.deepEqual(view(restored,'a'),view(state,'a'));state=restored;now=Math.max(a.event.busyUntil,b.event.busyUntil);
 }
});
test('private views cannot expose seed, other boards, refill counters or mutation references',()=>{
 const s=fresh(), v=view(s,'a');const serialized=JSON.stringify(v);for(const name of ['seed','refillCounters','shuffleCounter','players','nextTileId'])assert.ok(!serialized.includes('"'+name+'"'));
 v.board[0].color=99;assert.notEqual(s.players.a.board[0].color,99);assert.throws(()=>view(s,'outsider'),code('NOT_A_PLAYER'));assert.throws(()=>view(s,'__proto__'),code('NOT_A_PLAYER'));
});
test('invalid adjacent swaps bounce, score zero and still consume the server 150ms window',()=>{
 const s=fresh(), all=legalMoves(s.players.a.board);let move;
 for(let from=0;from<36&&!move;from++)for(const to of [from+1,from+6])if(to<36&&(to===from+6||Math.floor(from/6)===Math.floor(to/6))&&!all.some(m=>m.from===from&&m.to===to)){move={type:'swap',from,to};break;}
 assert.ok(move);const board=clone(s.players.a.board);const r=act(s,'a',move,1000);assert.equal(r.event.valid,false);assert.deepEqual(s.players.a.board,board);assert.equal(s.players.a.score,0);assert.equal(s.players.a.busyUntil,1150);assert.throws(()=>act(s,'a',move,1149),code('BUSY'));assert.doesNotThrow(()=>act(s,'a',move,1150));
});
test('rejects malformed, diagonal, wrapped, out-of-range, outsider and late actions',()=>{
 const s=fresh();for(const [from,to]of [[0,7],[5,6],[-1,0],[35,36],[1.1,2],[0,0]])assert.throws(()=>act(s,'a',{type:'swap',from,to},1000),code('INVALID_ACTION'));
 assert.throws(()=>act(s,'__proto__',{type:'swap',from:0,to:1},1000),code('NOT_A_PLAYER'));assert.throws(()=>act(s,'a',legalMoves(s.players.a.board)[0],999),code('NOT_STARTED'));assert.throws(()=>act(s,'a',legalMoves(s.players.a.board)[0],91000),code('DEADLINE_PASSED'));
 assert.throws(()=>createState(seed,0,{players:roster,durationMs:60000}),code('INVALID_DURATION'));
});
test('four line creates the correctly oriented stripe, target has priority and original earns points',()=>{
 const s=fresh(),p=s.players.a;p.board=base();paint(p.board,[13,14,15,16],0);const clusters=matches(p.board);assert.equal(clusters.length,1);assert.equal(clusters[0].special,'row');
 const wave=testing.settleWave(s,p,clusters,null,{from:13,to:15},0);assert.equal(wave.created.length,1);assert.equal(wave.created[0].index,15);assert.equal(wave.created[0].tile.special,'row');assert.equal(wave.score,40);assert.ok(wave.removed.includes(15));assert.equal(wave.effects.length,0);assert.ok(wave.after.some(tile=>tile.id===wave.created[0].tile.id));
 const vertical=base();paint(vertical,[1,7,13,19],2);assert.equal(matches(vertical).find(c=>c.cells.includes(13)).special,'column');
});
test('line five outranks a T/L bomb, and cascade creation uses row-major first cell',()=>{
 const cross=base();paint(cross,[12,13,14,15,16,2,8,20,26],0);assert.equal(matches(cross).find(c=>c.cells.includes(14)).special,'rainbow');
 const t=base();paint(t,[7,12,13,14,19],4);const c=matches(t).find(c=>c.cells.includes(13));assert.equal(c.special,'bomb');const s=fresh();s.players.a.board=t;const w=testing.settleWave(s,s.players.a,[c],null,null,0);assert.equal(w.created[0].index,Math.min(...c.cells));
});
test('intersecting runs clear each original only once; each connected cluster produces at most one special',()=>{
 const s=fresh(),p=s.players.a;p.board=base();paint(p.board,[7,12,13,14,19],4);const c=matches(p.board).find(x=>x.cells.includes(13));const w=testing.settleWave(s,p,[c],null,null,0);assert.equal(new Set(w.removed).size,w.removed.length);assert.equal(w.score,w.removed.length*10);assert.equal(w.created.length,1);
});
test('special effects chain once per old special and never double count hit cells',()=>{
 const s=fresh(),p=s.players.a;p.board=base();p.board[0].special='row';p.board[4].special='bomb';p.board[10].special='column';
 const w=testing.settleWave(s,p,[],{cells:[0],colors:{}},null,0);const expected=new Set([0,1,2,3,4,5,9,10,11,16,22,28,34]);assert.deepEqual(new Set(w.removed),expected);assert.equal(w.score,expected.size*10);assert.equal(w.effects.length,3);assert.equal(w.created.length,0);
});
test('rainbow swap clears the other color and also triggers an exchanged old stripe',()=>{
 const s=fresh(),p=s.players.a;p.board=base();p.board[0]={id:0,color:null,special:'rainbow'};p.board[1].special='column';
 const r=act(s,'a',{type:'swap',from:0,to:1},1000);const first=r.event.waves[0];const color=first.before[0].color;
 for(let i=0;i<36;i++)if(first.before[i].color===color||i%6===0||i===1)assert.ok(first.removed.includes(i));
 assert.ok(first.effects.some(e=>e.special==='rainbow'));assert.ok(first.effects.some(e=>e.special==='column'));
});
test('two rainbows clear all 36 original cells, and normal-special swaps work without a match',()=>{
 const s=fresh(),p=s.players.a;p.board=base();p.board[0].special='rainbow';p.board[0].color=null;p.board[1].special='rainbow';p.board[1].color=null;
 const r=act(s,'a',{type:'swap',from:0,to:1},1000);assert.equal(r.event.waves[0].removed.length,36);assert.equal(r.event.waves[0].score,360);
 const q=fresh();q.players.a.board=base();q.players.a.board[0].special='row';const swap=act(q,'a',{type:'swap',from:0,to:6},1000);assert.equal(swap.event.valid,true);assert.ok(swap.event.waves[0].removed.includes(11));
});
test('passive rainbow chooses most common color, resolving equal counts by fixed palette order',()=>{
 const s=fresh(),p=s.players.a;p.board=base();p.board[0]={id:0,color:0,special:'row'};p.board[3]={id:3,color:null,special:'rainbow'};
 const counts=[0,0,0,0,0];p.board.forEach(t=>{if(t.color!==null)counts[t.color]++;});const target=counts.indexOf(Math.max(...counts));const w=testing.settleWave(s,p,[],{cells:[0],colors:{}},null,0);for(let i=0;i<36;i++)if(w.before[i].color===target)assert.ok(w.removed.includes(i));
});
test('cascade multipliers cap at five and each following accepted swap restarts at one',()=>{
 const s=fresh(),p=s.players.a;
 for(let wave=0;wave<8;wave++){p.board=base();paint(p.board,[12,13,14],0);const w=testing.settleWave(s,p,matches(p.board),null,null,wave);assert.equal(w.multiplier,Math.min(wave+1,5));assert.equal(w.score,w.removed.length*10*Math.min(wave+1,5));}
 const a=fresh();let now=1000;for(let i=0;i<4;i++){const r=act(a,'a',legalMoves(a.players.a.board)[0],now);assert.equal(r.event.waves[0].multiplier,1);now=r.event.busyUntil;}
});
test('infinite refill fixture is bounded to 20 waves then non-scoring deterministic reshuffle',()=>{
 const s=fresh(),p=s.players.a;p.board=Array.from({length:36},(_,id)=>({id,color:0,special:null}));const event={waves:[],reshuffle:null};
 testing.resolve(s,p,matches(p.board),null,0,1,event,()=>0);assert.equal(event.waves.length,20);assert.equal(event.reshuffle.reason,'cascade-cap');assert.equal(p.score,event.waves.reduce((sum,w)=>sum+w.score,0));assert.equal(matches(p.board).length,0);assert.ok(legalMoves(p.board).length);assert.ok(event.waves.every(w=>w.multiplier<=5));
});
test('32-attempt shuffle fallback is playable, preserves special types and is reproducible without scoring',()=>{
 const a=fresh(),b=fresh();for(const s of[a,b]){s.players.a.board=Array.from({length:36},(_,id)=>({id,color:0,special:id===35?'column':null}));s.players.a.score=123;}
 const x=testing.reshuffle(a,a.players.a,'fixture'),y=testing.reshuffle(b,b.players.a,'fixture');assert.equal(x.fallback,true);assert.equal(x.attempts,32);assert.deepEqual(x,y);assert.equal(matches(a.players.a.board).length,0);assert.ok(legalMoves(a.players.a.board).length);assert.equal(a.players.a.board.filter(t=>t.special==='column').length,1);assert.equal(a.players.a.score,123);
});
test('deadline closes new actions but allows a previously accepted cascade to finish',()=>{
 const s=fresh();const r=act(s,'a',legalMoves(s.players.a.board)[0],90999);assert.ok(r.event.busyUntil>91000);assert.equal(tick(s,91000).state.status,'active');assert.throws(()=>act(s,'b',legalMoves(s.players.b.board)[0],91000),code('DEADLINE_PASSED'));assert.equal(tick(s,r.event.busyUntil).state.status,'finished');
});
test('ties remain ties, atomic forfeits cannot accidentally reward the last iterated player',()=>{
 const s=fresh();s.players.a.score=100;s.players.b.score=100;s.players.c.score=50;assert.deepEqual(rank(s).map(r=>r.rank),[1,1,3]);const all=forfeit(s,['a','b','c'],2000);assert.equal(all.state.status,'finished');assert.equal(all.state.finishReason,'all-forfeited');assert.ok(rank(s).every(r=>r.rank===null));
 const done=fresh();tick(done,91000);const before=clone(done);forfeit(done,['a','b','c'],92000);assert.deepEqual(done,before);
});
test('shared pause shifts absolute clocks, bot actions use normal legal action validation',()=>{
 const s=fresh();const first=botAction(s,'a',1000);assert.ok(first);const r=act(s,'a',first,1000);assert.equal(botAction(s,'a',1001),null);const busy=r.event.busyUntil;shiftTime(s,6000);assert.equal(s.deadlineAt,97000);assert.equal(s.players.a.busyUntil,busy+6000);assert.throws(()=>shiftTime(s,60001),code('INVALID_PAUSE'));assert.equal(RULE_VERSION,'pvp-match-v1.0.0');assert.equal(RULES.durationMs,90000);
});
