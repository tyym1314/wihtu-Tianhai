import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRunTimeline} from '../arena/run/timeline.mjs';
import {proveRunHistory,RUN_CONFIRMED_HISTORY_LIMIT_TICKS,createRunSelfProjection} from '../arena/run/self-projection.mjs';

// Independent complete engine predating shared movement extraction. Resolve
// imports in memory only; these tests never use the predictor as an oracle.
const raw=await readFile(new URL('./fixtures/run-engine-before-runner-physics.mjs',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(raw).digest('hex'),'0c102a4160114510e20959a9f276186be5867247e93c4d1bfe5c098706b4c5e8');
const source=raw.replace(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL(p,new URL('../arena/run/engine.mjs',import.meta.url)).href}'`);
const E=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const KEY='self',ROOM='history-room',DT=1000/60,clone=structuredClone;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function state(course=0){const s=E.createState(course.toString(16).padStart(8,'0').padEnd(64,'0'),1000,{ruleVersion:E.PRACTICE_RULE_VERSION,startPolicy:E.RUN_SCENE_READY_POLICY,players:[{key:KEY,seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});E.armStart(s,1000);return s;}
function advance(s,tick){E.tick(s,s.startedAt+Math.ceil(tick*DT));return s;}
function view(s){const game=E.view(s,KEY),p=s.players[0];game.selfPrediction={schema:'run-self-projection-v1',resolvedObstacles:[...p.resolvedObstacles],pendingInput:clone(p.pendingInput),lastInputTick:p.lastInputTick};return game;}
const receive=(t,g,version,receivedAtMs,roomId=ROOM)=>t.receive(g,KEY,{roomId,roomVersion:version,receivedAtMs});
const input=e=>({type:e.type==='item_used'?'item':e.type,tick:e.tick,no:e.inputNo,item:e.item??null});
const accepted=(g,start)=>g.events.filter(e=>e.playerKey===KEY&&['left','right','jump','slide','item_used'].includes(e.type)&&e.tick>start).map(input);
const proof=(a,b,history=accepted(b,a.snapshotTick))=>proveRunHistory(a,b,KEY,{roomId:ROOM,fromVersion:1,toVersion:2,acceptedInputs:history});
function distanceSamples(t,start,end){const samples=[];for(let at=start;at<=end+1e-8;at+=DT)samples.push({at,...t.sample(at)});return samples;}
function continuous(samples,max=8){for(let i=1;i<samples.length;i++){const a=samples[i-1],b=samples[i],delta=b.pose.distance-a.pose.distance;assert.ok(delta>=-1e-7);assert.ok(delta<=max*(b.at-a.at)/1000+1e-7,`${delta}m over ${b.at-a.at}ms`);}}

test('46-tick fresh authority bridges complete history without a receive jump or a new lease',()=>{
 const s=state(),base=view(advance(s,100)),next=view(advance(s,146)),t=createRunTimeline();
 assert.ok(receive(t,base,1,0));distanceSamples(t,0,650);const held=t.sample(839.9);near(held.displayTick,139);assert.equal(held.reason,'projection-expired');
 assert.ok(receive(t,next,2,839.9));const same=t.sample(839.9);near(same.pose.distance,held.pose.distance);assert.equal(same.mode,'project');assert.equal(same.baseTick,100);assert.equal(same.baseVersion,1);
 continuous(distanceSamples(t,839.9,1489.9));const expiry=t.sample(1489.9);assert.equal(expiry.reason,'projection-expired');assert.ok(expiry.displayTick<=185);near(t.sample(1800).displayTick,expiry.displayTick);
 assert.ok(receive(t,next,3,1900));near(t.sample(2100).displayTick,expiry.displayTick);assert.equal(t.sample(2200).reason,'projection-expired');
});

test('actual Android accepted actions and calibrated prior phase reproduce the 1.856267m recovery defect',()=>{
 // Captured Android case 2026-10-07T23-30-40.193Z-bd5bd7db. These are real
 // accepted actions; source snapshots are rebuilt by the independent engine.
 // The three-delivery schedule calibrates observed display lag, not an
 // invented complete device callback trace.
 const s=state(4),actions=new Map([[275,'jump'],[515,'right'],[655,'jump'],[858,'slide']]),games=new Map();
 for(let tick=0;tick<=992;tick++){advance(s,tick);if(actions.has(tick+1))E.act(s,KEY,{type:actions.get(tick+1)},s.now);if([931,946,992].includes(tick))games.set(tick,view(s));}
 near(games.get(946).players[0].distance,119.86666666666666);near(games.get(992).players[0].distance,126);
 const t=createRunTimeline(),initialDelay=134.63333334519615,freshAt=initialDelay+839.9000000357628;
 receive(t,games.get(931),75,0);t.sample(0);t.sample(initialDelay);receive(t,games.get(946),76,initialDelay);distanceSamples(t,initialDelay,initialDelay+650);
 const before=t.sample(freshAt);
 // Retain the old same-tick distance/defect as a separate legacy oracle. The
 // candidate now displays the proven previous interval, not that old phase.
 const legacy=createRunSelfProjection();assert.ok(legacy.update(games.get(946),KEY,{roomId:ROOM,roomVersion:76}));
 const rawElapsed=(before.displayTick-946)*DT,old=legacy.sample(rawElapsed);
 near(old.distance,124.14373333342823);near(games.get(992).players[0].distance-old.distance,1.85626666657177);
 near(before.pose.distance,legacy.sample(rawElapsed-DT).distance);near(before.pose.tick,before.displayTick-1);
 receive(t,games.get(992),79,freshAt);const after=t.sample(freshAt);assert.equal(after.mode,'project');near(after.pose.distance,before.pose.distance);near(after.displayTick,978.0780000007118);
 continuous(distanceSamples(t,freshAt,freshAt+650));
});

for(let course=0;course<6;course++)test(`course ${course}: all 120 proven integer states match independent engine with accepted inputs`,()=>{
 const s=state(course),expected=new Map(),history=[];let from,to;
 for(let tick=0;tick<=390;tick++){
  advance(s,tick);if(tick===270)from=view(s);if(tick===390){to=view(s);expected.set(tick,clone(s.players[0]));break;}
  const action=E.botAction(s,KEY,s.now);if(action){E.act(s,KEY,action,s.now);if(tick>=270)history.push(clone(s.players[0].pendingInput));}
  if(tick>=270)expected.set(tick,clone(s.players[0]));
 }
 // Each history item is the independently admitted pending input, not an
 // HTTP receipt mislabeled as a movement event.
 const result=proof(from,to,history);assert.equal(result.ok,true,result.reason);assert.equal(result.fromTick,270);assert.equal(result.toTick,390);
 for(let tick=270;tick<=390;tick++){
  const got=result.projection.stateAtTick(tick),want=expected.get(tick);for(const field of Object.keys(got))if(field!=='tick')assert.deepEqual(got[field],want[field],`${course}/${tick}/${field}`);
  const posed=result.projection.sample((tick-270)*DT);near(posed.distance,want.distanceU/300);assert.equal(posed.hits,want.hits);assert.equal(posed.fallUntilTick,want.fallUntilTick);
 }
 assert.equal(result.projection.stateAtTick(391),null);near(result.projection.sample(10000).tick,390);
});

test('action after original 39-tick horizon is replayed, while incomplete or conflicting history fails closed',()=>{
 const s=state(),from=view(advance(s,100));advance(s,142);E.act(s,KEY,{type:'right'},s.now);const to=view(advance(s,146)),history=accepted(to,100);
 assert.equal(history[0].tick,143);assert.equal(proof(from,to,history).ok,true);
 assert.equal(proof(from,to,[]).ok,false);assert.equal(proof(from,to,[...history,...history]).ok,false);assert.equal(proof(from,to,[{...history[0],no:2}]).ok,false);
 const changed=clone(to);changed.players[0].immuneUntilTick=1;assert.equal(proof(from,changed,history).reason,'history-endpoint-mismatch');
 for(const bad of [Object.assign(clone(to),{events:[]}),changed]){const t=createRunTimeline();receive(t,from,1,0);t.sample(650);receive(t,bad,2,839.9);assert.equal(t.sample(839.9).mode,'resync');}
});

test('future pending is admitted separately; a same-tick higher version cannot renew an existing bridge lease',()=>{
 const s=state(),from=view(advance(s,100)),to=view(advance(s,146));E.act(s,KEY,{type:'jump'},s.now);const pending=view(s),proved=proof(from,pending);
 assert.equal(proved.ok,true,proved.reason);assert.equal(proved.projection.stateAtTick(146).pendingInput,null);assert.equal(proved.projection.stateAtTick(146).appliedInputNo,0);
 const t=createRunTimeline();receive(t,from,1,0);t.sample(650);receive(t,to,2,840);t.sample(840);receive(t,pending,3,850);const sample=t.sample(1100);assert.equal(sample.pose.appliedInputNo,1);assert.notEqual(sample.mode,'resync');
 const expired=t.sample(1490);receive(t,pending,4,2000);near(t.sample(2100).displayTick,expired.displayTick);assert.equal(t.sample(2100).reason,'projection-expired');
 const invalid=clone(pending);invalid.selfPrediction.pendingInput.type='item';invalid.selfPrediction.pendingInput.item='boost';assert.equal(proof(from,invalid).ok,false);
});

test('unknown dispatch remains unresolved; authoritative accepted history cannot claim HTTP completion',()=>{
 const s=state(),from=view(advance(s,100)),t=createRunTimeline(),d={token:'gap-input',roomId:ROOM,playerKey:KEY,request_id:'history_request',seq:1,type:'right',ruleVersion:from.ruleVersion,dispatchedAtMs:0};
 receive(t,from,1,0);assert.ok(t.noteInput(d));advance(s,142);E.act(s,KEY,{type:'right'},s.now);const to=view(advance(s,146));t.sample(650);receive(t,to,2,840);assert.notEqual(t.sample(840).mode,'resync');
 const receipt={roomId:ROOM,playerKey:KEY,request_id:d.request_id,seq:1,type:'right',ruleVersion:from.ruleVersion,inputNo:1,acceptedTick:143};
 assert.equal(t.resolveInput({token:d.token,receipt:{...receipt,request_id:'wrong_request'},resolvedAtMs:850}),false);
 assert.equal(t.resolveInput({token:d.token,receipt,resolvedAtMs:860}),true);
 // A second unacknowledged dispatch does not synthesize an accepted number.
 assert.ok(t.noteInput({...d,token:'unresolved-next',request_id:'unresolved_next',seq:2,type:'jump',dispatchedAtMs:870}));
 const output=t.sample(1200);assert.equal(output.pose.appliedInputNo,1);assert.equal(t.resolveInput({token:'unresolved-next',outcome:'unresolved',resolvedAtMs:1200}),true);
});

for(const [name,course,start]of [['hit',0,270],['fall and respawn',2,248]])test(`proved history preserves actual ${name}, including integer impact boundaries`,()=>{
 const s=state(course),from=view(advance(s,start)),states=new Map([[start,clone(s.players[0])]]);
 for(let tick=start+1;tick<=start+120;tick++){advance(s,tick);states.set(tick,clone(s.players[0]));}
 const to=view(s),result=proof(from,to);assert.equal(result.ok,true,result.reason);assert.ok(s.players[0].hits>0);
 for(let tick=start+1;tick<=start+120;tick++){
  const p=result.projection.sample((tick-start)*DT),oracle=states.get(tick);near(p.distance,oracle.distanceU/300);assert.equal(p.hits,oracle.hits);assert.equal(p.fallUntilTick,oracle.fallUntilTick);
  if(oracle.hits>states.get(tick-1).hits){const before=result.projection.sample((tick-start-.01)*DT);assert.equal(before.hits,states.get(tick-1).hits);}
 }
});

test('history work bound, display lag, mapping, scope and suspend remain explicit limits',()=>{
 assert.equal(RUN_CONFIRMED_HISTORY_LIMIT_TICKS,120);const s=state(),from=view(advance(s,100)),at220=view(advance(s,220)),at221=view(advance(s,221));
 assert.equal(proof(from,at220).ok,true);assert.equal(proof(from,at221).reason,'history-gap-too-large');
 const shifted=clone(at220);shifted.startedAt++;shifted.serverNow++;shifted.deadlineAt++;assert.equal(proof(from,shifted).reason,'history-mapping-changed');
 assert.equal(proveRunHistory(from,at220,'other',{roomId:ROOM,fromVersion:1,toVersion:2}).ok,false);
 assert.equal(proveRunHistory(from,at220,KEY,{roomId:ROOM,fromVersion:2,toVersion:2}).ok,false);
 const t=createRunTimeline();receive(t,from,1,0);t.sample(650);receive(t,at220,2,900);assert.equal(t.sample(900).reason,'authority-gap');
 const u=createRunTimeline();receive(u,from,1,0);u.sample(100);u.suspend('background');receive(u,from,2,200);assert.equal(u.sample(500).reason,'background');
 receive(u,at220,3,600);assert.equal(u.sample(600).reason,'resume-background');assert.equal(receive(u,at221,4,599),false);
 const changedRoom=createRunTimeline();receive(changedRoom,from,1,0);changedRoom.sample(650);receive(changedRoom,at220,1,900,'other-room');assert.equal(changedRoom.sample(900).baseTick,220);
});

test('terminal authority ends prediction instead of bridging or reopening an expired future',()=>{
 const s=state(),from=view(advance(s,100)),t=createRunTimeline();receive(t,from,1,0);t.sample(650);advance(s,146);E.forfeit(s,[KEY,'bot'],s.now+1);const to=view(s);
 assert.equal(proof(from,to).ok,false);receive(t,to,2,840);assert.equal(t.sample(840).reason,'authoritative-terminal');near(t.sample(2000).pose.distance,to.players[0].distance);
 const ordinary=createRunSelfProjection();assert.ok(ordinary.update(from,KEY,{roomId:ROOM,roomVersion:1}));near(ordinary.sample(2000).tick,139);assert.equal(ordinary.stateAtTick(140),null);
});

test('partial proofs cannot escape, inputs are owned, and oversized input histories are bounded',()=>{
 const s=state(),from=view(advance(s,100));advance(s,142);E.act(s,KEY,{type:'right'},s.now);const to=view(advance(s,146)),history=accepted(to,100),before=clone({from,to,history}),p=proof(from,to,history);
 assert.equal(p.ok,true);assert.deepEqual({from,to,history},before);const saved=p.projection.sample(46*DT);
 to.players[0].distance=0;from.players[0].lane=0;history[0].type='left';assert.deepEqual(p.projection.sample(46*DT),saved);
 assert.ok(Object.isFrozen(p.projection.stateAtTick(143)));assert.ok(Object.isFrozen(p.projection.stateAtTick(143).resolvedObstacles));
 const bad=proof(before.from,before.to,Array.from({length:10000},()=>before.history[0]));assert.equal(bad.ok,false);assert.equal('projection' in bad,false);
});

test('the authority queue still has a strict bound after a proven bridge',()=>{
 const s=state(),t=createRunTimeline();receive(t,view(advance(s,100)),1,0);t.sample(650);t.sample(840);receive(t,view(advance(s,146)),2,840);assert.equal(t.sample(840).mode,'project');
 // Many newer real authorities before any display frame must not retain an
 // unbounded historical queue, even when its oldest entry is a proof.
 for(let i=1;i<=15;i++)receive(t,view(advance(s,146+i)),2+i,840+i);
 const bounded=t.sample(855);assert.equal(bounded.mode,'resync');assert.equal(bounded.reason,'history-overflow');
});

test('repeated network gaps accumulate visible lag instead of secretly accelerating to recover it',()=>{
 const s=state(),t=createRunTimeline();receive(t,view(advance(s,100)),1,0);let now=0,tick=100,sawResync=false;
 for(let gap=0;gap<8;gap++){
  // Keeping each interarrival longer than the old lease necessarily loses
  // display time. The outstanding 39-tick limit remains a real failure.
  const nextAt=now+840;distanceSamples(t,now,nextAt-DT);const before=t.sample(nextAt);tick+=46;
  receive(t,view(advance(s,tick)),gap+2,nextAt);const after=t.sample(nextAt);
  if(after.mode==='resync'){assert.equal(after.reason,'authority-gap');assert.ok(tick-before.displayTick>39);sawResync=true;break;}
  near(after.displayTick,before.displayTick);near(after.pose.distance,before.pose.distance);now=nextAt;
 }
 assert.equal(sawResync,true,'unbounded accumulated delay must not masquerade as smooth recovery');
});

test('new authority arriving just after a RAF timestamp does not spend message time as display time',()=>{
 const s=state(),t=createRunTimeline();receive(t,view(advance(s,100)),1,0);t.sample(650);const held=t.sample(830);
 receive(t,view(advance(s,146)),2,839.9);const frame=t.sample(836.7);near(frame.displayTick-held.displayTick,6.7/DT);near(frame.pose.distance-held.pose.distance,6.7*.008);
 const next=t.sample(853.4);near(next.pose.distance-frame.pose.distance,16.7*.008);
});
