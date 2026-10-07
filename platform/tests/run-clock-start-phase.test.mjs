import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {createRunSnapshotClock,projectedPose,RUN_PROJECTION_LIMIT_MS} from '../arena/run/presentation.mjs';
import {createRunInputPresentation,RUN_INPUT_RECONCILE_MS} from '../arena/run/input-presentation.mjs';
const base=()=>engine.view(engine.createState('02'.repeat(32),10000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]}),'p0');
const game=(tick=0,extra={})=>({...base(),ruleVersion:'pvp-run-v2.2.0',snapshotTick:tick,serverNow:10000+tick*1000/60,...extra});
const owner={roomId:'room-a',playerKey:'p0'};
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('long arming cannot become projected racing time when racing starts at the same tick',()=>{
 const c=createRunSnapshotClock();c.receive(game(0,{phase:'arming'}),0,owner);
 c.receive(game(0,{phase:'arming'}),1500,owner);near(c.elapsed(2000),0);
 c.receive(game(0),2000,owner);near(c.elapsed(2000),0);
 c.receive(game(15),2250,owner);near(c.elapsed(2250),0);
 near(projectedPose(game(15).players[0],game(15),c.elapsed(2250)).tick,15);
});

test('multiplayer countdown and its changed start time do not carry unrendered preparation time',()=>{
 const c=createRunSnapshotClock();c.receive(game(0,{phase:'arming'}),0,owner);
 const countdown=game(0,{phase:'countdown',startedAt:15000,serverNow:15000});
 c.receive(countdown,2000,owner);c.receive(countdown,4900,owner);near(c.elapsed(5000),0);
 c.receive({...countdown,phase:'racing'},5000,owner);near(c.elapsed(5000),0);
 c.receive({...countdown,phase:'racing',snapshotTick:15,serverNow:15250},5250,owner);near(c.elapsed(5250),0);
});

test('first racing publication after arming starts at authority even when tick zero was never observed racing',()=>{
 const c=createRunSnapshotClock();c.receive(game(0,{phase:'arming'}),0,owner);
 c.receive(game(12),2000,owner);near(c.elapsed(2000),0);
 near(projectedPose(game(12).players[0],game(12),c.elapsed(2000)).tick,12);
});

for(const [name,extra] of Object.entries({
 unknownRule:{ruleVersion:'future'},unknownPhysics:{physicsVersion:'future'},unknownPhase:{phase:'future'},prototypePhase:{phase:'constructor'},
 inactiveStatus:{status:'finished'},unknownStatus:{status:'future'},beforeStart:{serverNow:9999},
}))test(`${name} is held by the same clock and pose gate and cannot donate phase when active resumes`,()=>{
 const c=createRunSnapshotClock(),held=game(20,extra);c.receive(held,0,owner);
 near(c.elapsed(2000),0);const p=projectedPose(held.players[0],held,2000);near(p.tick,20);near(p.distance,held.players[0].distance);
 c.receive(game(20),2000,owner);near(c.elapsed(2000),0);
 c.receive(game(35),2250,owner);near(c.elapsed(2250),0);
});

test('continuous active carry and duplicate reads preserve the original bounded budget',()=>{
 const c=createRunSnapshotClock();c.receive(game(42),0,owner);c.receive(game(60),400,owner);near(c.elapsed(400),100);
 c.receive(game(60),500,owner);near(c.elapsed(500),200);
 // startedAt is simulation time, not room identity: it cannot refresh an active duplicate.
 c.receive(game(60,{startedAt:10100,serverNow:11100}),600,owner);near(c.elapsed(600),300);
 assert.equal(c.receive(game(59,{startedAt:12000,serverNow:13000}),650,owner),false);
 near(c.elapsed(950),650);near(c.elapsed(1000),700);
 near(projectedPose(game(60).players[0],game(60),c.elapsed(10000)).tick,99);
 assert.equal(RUN_PROJECTION_LIMIT_MS,650);
});

test('same-tick old arming/countdown and old receive times cannot reopen a racing budget',()=>{
 const c=createRunSnapshotClock();c.receive(game(0),2000,owner);
 assert.equal(c.receive(game(0,{phase:'arming',startedAt:9000}),2300,owner),false);
 assert.equal(c.receive(game(0,{phase:'countdown'}),2400,owner),false);
 assert.equal(c.receive(game(0),1900,owner),false);
 near(c.elapsed(2650),650);
 c.receive(game(0),2700,owner);near(c.elapsed(2700),700);
});

test('only actual room or viewer changes reset a lower tick scope',()=>{
 const c=createRunSnapshotClock();c.receive(game(100),0,owner);
 assert.equal(c.receive(game(0),100,owner),false);
 assert.equal(c.receive(game(0),100,{...owner,roomId:'room-b'}),true);near(c.elapsed(100),0);
 c.receive(game(30),700,{...owner,roomId:'room-b'});near(c.elapsed(700),100);
 assert.equal(c.receive(game(0),800,{roomId:'room-b',playerKey:'p1'}),true);near(c.elapsed(800),0);
});

test('race finish holds presentation and does not let older active phases re-enable it',()=>{
 const c=createRunSnapshotClock();c.receive(game(100),0,owner);
 const done=game(100,{phase:'finished',status:'finished'});c.receive(done,100,owner);near(c.elapsed(2000),0);
 assert.equal(c.receive(game(100),3000,owner),false);near(c.elapsed(4000),0);
});

// Sanitized tick/input metadata and relative receive times from physical run04,
// report SHA bd8d2d23c36795cc42b274cdab3e4220d9168fef53b4a5f4430f119e83922fe8.
// GET pose fields/phase were not captured. Only the one receipt/event jump is
// reconstructed; all sampled hits/fall/stun are zero/null and speed is8m/s.
const actual=[
 [3077.8,0,0,0],[3453.4,0,0,0],[3707.7,0,0,0],[3872.5,0,0,0],[4000.6,0,0,0],
 [4145.1,12,0,0],[4308.1,12,0,0],[4469.5,27,0,0],[4569.4,42,0,0],[4756.7,42,0,0],
 [4932.7,57,0,0],[5076.6,72,0,0],[5220.1,72,0,0],[5403.9,87,0,0],[5537.3,87,0,0],
 [5713.1,102,0,0],[5848.2,117,0,0],[6002.7,117,0,0],[6181,132,0,0],[6325.1,147,0,0],
 [6426.8,147,0,0],[6639.5,162,0,0],[6791,162,0,0],[6935.4,177,0,0],[7098,177,0,0],
 [7218.9,192,0,0],[7395.2,207,0,0],[7525.5,207,0,0],[7680.9,222,0,0],
 [7880.9,237,0,0],[7965.3,247,1,0],[7996.4,247,1,0],[8174.4,247,1,0],[8329.1,247,1,0],
 [8495.3,267,1,1],[8611.4,282,1,1],
];
test('captured first-jump timing retains its confirmed prediction until authority and uses existing100ms handoff',()=>{
 for(const initialAt of [2784.028,3708.840])for(const transitionAt of [3872.5,4000.6,4145.1]){
  let now=initialAt;const c=createRunSnapshotClock(),model=createRunInputPresentation({now:()=>now});
  const rowGame=([at,tick,inputNo,appliedInputNo])=>{
   const g=game(tick,{phase:at<transitionAt?'arming':'racing'});
   g.players=g.players.map(p=>({...p,distance:tick*40/300,inputNo,appliedInputNo,jumpStartTick:appliedInputNo?248:null}));return g;
  };
  let g=rowGame([initialAt,0,0,0]);const update=()=>{c.receive(g,now,owner);model.update(g,'p0',{...owner,at:now,elapsed:c.elapsed(now)});};update();
  const receipt={...owner,request_id:'actual-jump-fixture',seq:1,type:'jump',ruleVersion:g.ruleVersion,inputNo:1,acceptedTick:248};
  const intent={...receipt,token:'first-jump'};delete intent.inputNo;delete intent.acceptedTick;
  const events=actual.filter(r=>r[0]>=initialAt).map(row=>({at:row[0],kind:'room',row}));
  events.push({at:7865.5,kind:'begin'},{at:7965.3,kind:'accept'});
  for(let at=Math.ceil(initialAt/5)*5;at<=8700;at+=5)events.push({at,kind:'frame'});
  events.sort((a,b)=>a.at-b.at||(a.kind==='accept'?-1:b.kind==='accept'?1:0));
  let lastVisual,firstApplied,correctionStart,correctionEnd,authorityCopies=[];
  for(const e of events){now=e.at;
   if(e.kind==='room'){g=rowGame(e.row);authorityCopies.push([g,JSON.stringify(g)]);update();}
   else if(e.kind==='begin')assert.equal(model.beginInput(intent),true);
   else if(e.kind==='accept')assert.equal(model.acceptInput({token:intent.token,receipt}),true);
   else{const pose=projectedPose(g.players[0],g,c.elapsed(now)),v=model.sample(pose,{at:now,elapsed:c.elapsed(now)});
    if(now>7950&&now<8495.3){assert(v.y>.1,`premature landing ${initialAt}/${transitionAt} at${now}`);assert.equal(model.state().records[0]?.state,now<7965.3?'predicted':'confirmed');}
    if(now>=8495.3&&!firstApplied){firstApplied=v;near(v.y,lastVisual.y);}
    if(model.state().correcting)correctionStart??=now;
    else if(correctionStart&&correctionEnd===undefined)correctionEnd=now;
    lastVisual=v;
   }
  }
  assert(firstApplied);assert.equal(correctionEnd-correctionStart,RUN_INPUT_RECONCILE_MS);assert.equal(model.state().active,0);
  for(const [authority,copy] of authorityCopies)assert.equal(JSON.stringify(authority),copy,'rendering must not change authority');
 }
});
