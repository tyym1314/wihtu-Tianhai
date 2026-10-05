import test from 'node:test';
import assert from 'node:assert/strict';
import {createPresentationClock,syncGamePresentationClock,bindPresentationClock} from '../arena/shared/presentation-clock.mjs';

function fixture(options={}){let local=0;const clock=createPresentationClock({localNow:()=>local,...options});return{clock,at(value){local=value;return clock.now();},set(value){local=value;}};}
test('jittered snapshots never rewind the same trajectory and correction is smooth',()=>{
 const f=fixture();f.clock.sync(10000,{through:20000});let prior=10000,maxFrame=0;
 const arrivals=new Map([[500,10490],[1100,10800],[1600,11550],[2200,11900]]);
 for(let local=10;local<=3000;local+=10){f.set(local);if(arrivals.has(local))f.clock.sync(arrivals.get(local),{through:20000});const now=f.clock.now();assert(now>=prior);maxFrame=Math.max(maxFrame,now-prior);prior=now;}
 assert(maxFrame<=11.00001,'no response-arrival jump within live stream');
});
test('repeated control renders and out-of-order responses do not re-anchor time',()=>{
 const f=fixture();f.clock.sync(10000,{through:20000});assert.equal(f.at(800),10800);
 assert.equal(f.clock.sync(10000,{through:20000}),false);assert.equal(f.clock.sync(9990),false);
 assert.equal(f.at(900),10900);
});
test('unknown future freezes at bounded horizon instead of running indefinitely',()=>{
 const f=fixture();f.clock.sync(10000);assert.equal(f.at(1500),11500);assert.equal(f.at(100000),11500);
});
test('known complete trajectory keeps playing across 2.3 second polling gaps',()=>{
 const f=fixture();f.clock.sync(10000,{through:18000});assert.equal(f.at(2300),12300);assert.equal(f.at(8000),18000);assert.equal(f.at(60000),18000);
});
test('fresh response after long outage catches up once and cannot go backwards',()=>{
 const f=fixture();f.clock.sync(10000);f.at(8000);f.clock.sync(17900);assert.equal(f.clock.now(),17900);assert.equal(f.at(8100),18000);
});
test('new room or authoritative pause epoch can reset a timeline, then is monotonic',()=>{
 const f=fixture();f.clock.sync(10000,{key:'room-a'});f.at(700);
 f.clock.sync(5000,{key:'room-b'});assert.equal(f.clock.now(),5000);assert.equal(f.at(800),5100);
});
test('pause freezes; a visible fresh sample resumes without replaying the hidden duration',()=>{
 const f=fixture();f.clock.sync(10000,{through:20000});f.at(300);f.clock.suspend('hidden',true);assert.equal(f.at(10000),10300);
 f.clock.sync(20000,{through:25000});assert.equal(f.clock.now(),10300);f.clock.suspend('hidden',false);assert.equal(f.at(10100),10300);
 assert.equal(f.clock.sync(20000),false);f.clock.sync(20100,{through:25000});assert.equal(f.clock.now(),20100);assert.equal(f.at(10200),20200);
});
test('overlapping game pause, visibility and blur do not prematurely resume',()=>{
 const f=fixture();f.clock.sync(10000);f.clock.suspend('game',true);f.clock.suspend('hidden',true);f.clock.suspend('game',false);f.at(500);f.clock.sync(10500);assert.equal(f.clock.now(),10000);
 f.clock.suspend('hidden',false);f.at(600);f.clock.sync(10600);assert.equal(f.clock.now(),10600);
});
test('visibility/focus listeners freeze and clean up without leaving stale event handlers',()=>{
 const f=fixture(),doc=new EventTarget(),win=new EventTarget();doc.hidden=false;const dispose=bindPresentationClock(f.clock,doc,win);
 f.clock.sync(10000);f.at(100);win.dispatchEvent(new Event('blur'));assert.equal(f.at(700),10100);win.dispatchEvent(new Event('focus'));f.clock.sync(10700);assert.equal(f.clock.now(),10700);
 doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(f.at(900),10700);dispose();f.clock.sync(10900);assert.equal(f.clock.now(),10900);
 win.dispatchEvent(new Event('blur'));assert.equal(f.at(1000),11000);
});
test('invalid samples and backwards local timer readings stay finite and monotonic',()=>{
 const f=fixture();assert.equal(f.clock.sync(NaN),false);assert.equal(f.clock.now(),0);f.clock.sync(10000);f.at(500);assert.equal(f.at(400),10500);assert.equal(f.clock.sync(Infinity),false);
});
test('new shot starts at its own timestamp without replaying the preceding shot',()=>{
 const f=fixture(),game={gameId:'pool',deadlineAt:600000,players:[],shotId:1,shotStartedAt:10000,trajectory:[{t:0},{t:3000}]};
 syncGamePresentationClock(f.clock,game,10000,'room');assert.equal(f.at(2800)-game.shotStartedAt,2800);
 const next={...game,shotId:2,shotStartedAt:12800};syncGamePresentationClock(f.clock,next,12800,'room');assert.equal(f.clock.now()-next.shotStartedAt,0);assert.equal(f.at(2900)-next.shotStartedAt,100);
});
test('authoritative pause shifts the epoch and shot start together, preserving shot progress',()=>{
 const f=fixture(),game={gameId:'pool',phase:'rolling',deadlineAt:600000,players:[],shotId:1,shotStartedAt:10000,trajectory:[{t:0},{t:3000}]};
 syncGamePresentationClock(f.clock,game,10000,'room');assert.equal(f.at(400),10400);
 syncGamePresentationClock(f.clock,{...game,phase:'fault'},10400,'room');assert.equal(f.at(5400),10400);
 const resumed={...game,deadlineAt:605000,shotStartedAt:15000};syncGamePresentationClock(f.clock,resumed,15400,'room');assert.equal(f.clock.now()-resumed.shotStartedAt,400);
});
for(const gameId of ['pool','carrom','bowling','golf'])test(`${gameId}: game adapter preserves known trajectory and resets on match/hole restart`,()=>{
 const f=fixture(),actor={key:'p0',shotStartedAt:10000,trajectory:[{t:0},{t:6000}],lastEvent:{type:'shot',at:10000}};
 const game={gameId,status:'active',phase:'rolling',serverNow:10000,deadlineAt:600000,players:[actor]};
 if(gameId==='pool'||gameId==='carrom')Object.assign(game,actor);
 syncGamePresentationClock(f.clock,game,10000,'one');assert.equal(f.at(2300),12300);
 assert.equal(f.at(100000),16000+(gameId==='bowling'?3400:gameId==='golf'?2600:1000));
 const restarted={...game,deadlineAt:500000,serverNow:5000};syncGamePresentationClock(f.clock,restarted,5000,'two');assert.equal(f.clock.now(),5000);
});
