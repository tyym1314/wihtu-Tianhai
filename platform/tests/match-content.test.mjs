import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../arena/match/engine.mjs';
import * as V1 from '../arena/match/engine-v1.mjs';
import {objectiveWaveProgress} from '../arena/match/objectives.mjs';
const players=[{key:'a',seatIndex:0},{key:'b',seatIndex:1}],clone=x=>JSON.parse(JSON.stringify(x)),seed=i=>i.toString(16).padStart(8,'0').padEnd(64,'0');
test('three objectives have real legal completion traces with same starting boards and independent identical streams',()=>{
 for(let i=0;i<3;i++){let state=E.createState(seed(i),0,{players}),now=0;assert.deepEqual(state.players.a.board,state.players.b.board);while(now<90000){const action=E.botAction(state,'a',now);assert.ok(action);const a=E.act(state,'a',action,now),b=E.act(state,'b',action,now);assert.ok(a.event.valid);assert.deepEqual(a.event.finalBoard,b.event.finalBoard);assert.equal(a.event.objectiveProgress,b.event.objectiveProgress);assert.deepEqual(state.players.a.refillCounters,state.players.b.refillCounters);state=clone(state);now=a.event.busyUntil;}E.tick(state,Math.max(now,90000));assert.equal(state.status,'finished');assert.ok(E.view(state,'a').objectiveComplete,state.objective.id);assert.equal(E.rank(state)[0].rank,1);assert.equal(E.rank(state)[1].rank,1);}
});
test('objectives genuinely change standings and goal-directed move decisions',()=>{
 const choices=[];
 for(let i=0;i<3;i++){const s=E.createState(seed(i),0,{players});s.players.a.score=200;s.players.b.score=100;s.players.a.objectiveProgress=3;s.players.b.objectiveProgress=4;assert.equal(E.rank(s)[0].playerKey,i===0?'a':'b');}
 const s=E.createState(seed(1),0,{players});let difference=false,now=0;
 for(let i=0;i<40&&!difference;i++){const collect=E.botAction(s,'a',now),score=clone(s);score.objective.id='score';const other=E.botAction(score,'a',now);difference=JSON.stringify(collect)!==JSON.stringify(other);choices.push([collect,other]);now=E.act(s,'a',collect,now).event.busyUntil;}
 assert.ok(difference,JSON.stringify(choices));
});
test('progress counts removed original colors and triggered old specials once, never creations or reshuffles',()=>{
 const wave={before:[{color:2,special:'row'},{color:2,special:null},{color:null,special:'rainbow'}],removed:[0,1,2],created:[{index:1,tile:{special:'bomb'}}],effects:[{index:0,special:'row'},{index:2,special:'rainbow'}]};assert.equal(objectiveWaveProgress(wave,{id:'collect',color:2}),2);assert.equal(objectiveWaveProgress(wave,{id:'special'}),2);
 for(let i=0;i<3;i++){const s=E.createState(seed(i),0,{players}),p=s.players.a;p.board=Array.from({length:36},(_,id)=>({id,color:0,special:id===35?'column':null}));p.objectiveProgress=8;p.score=250;E.testing.reshuffle(s,p,'test-no-moves');assert.equal(p.objectiveProgress,8);assert.equal(p.score,250);assert.equal(E.matches(p.board).length,0);assert.ok(E.legalMoves(p.board).length);}
});
test('each objective rejects invalid swaps without progress and settles pre-deadline effects without losing them',()=>{
 for(let i=0;i<3;i++){const s=E.createState(seed(i),0,{players}),p=s.players.a,legal=E.legalMoves(p.board);let invalid;for(let from=0;from<35&&!invalid;from++)if(from%6<5&&!legal.some(m=>m.from===from&&m.to===from+1))invalid={type:'swap',from,to:from+1};assert.ok(invalid);const bad=E.act(s,'a',invalid,0);assert.equal(bad.event.valid,false);assert.equal(p.objectiveProgress,0);const event=E.act(s,'a',E.botAction(s,'a',89999),89999).event,progress=E.view(s,'a').objectiveProgress;assert.equal(E.tick(s,90000).state.status,'active');assert.throws(()=>E.act(s,'b',E.legalMoves(s.players.b.board)[0],90000),{code:'DEADLINE_PASSED'});E.tick(s,event.busyUntil);assert.equal(s.status,'finished');assert.equal(E.view(s,'a').objectiveProgress,progress);const serialized=JSON.stringify(E.view(s,'a'));for(const hidden of ['seed','refillCounters','shuffleCounter','nextTileId'])assert.ok(!serialized.includes('"'+hidden+'"'));}
});
test('v1 persisted RNG, last accepted cascade, pause, score, ranks and private view remain byte-for-byte equivalent',()=>{
 const options={players,ruleVersion:V1.RULE_VERSION};let a=E.createState(seed(2),1000,options),b=V1.createState(seed(2),1000,options),now=1000;assert.deepEqual(a,b);
 for(let i=0;i<45;i++){const move=V1.legalMoves(b.players.a.board)[i%V1.legalMoves(b.players.a.board).length],x=E.act(a,'a',move,now),y=V1.act(b,'a',move,now);assert.deepEqual(x,y);now=x.event.busyUntil;a=clone(a);assert.deepEqual(E.view(a,'a'),V1.view(b,'a'));assert.deepEqual(E.rank(a),V1.rank(b));}
 E.shiftTime(a,1000);V1.shiftTime(b,1000);assert.deepEqual(a,b);assert.deepEqual(E.tick(a,100000),V1.tick(b,100000));assert.deepEqual(E.forfeit(a,['b'],100000),V1.forfeit(b,['b'],100000));
 for(const version of [undefined,'','pvp-match-v3.0.0',V1.RULE_VERSION+'x'])assert.equal(E.supportsRuleVersion(version),false);assert.throws(()=>E.createState(seed(0),0,{players,ruleVersion:'unknown'}),{code:'PINNED_RULE_UNAVAILABLE'});
});
