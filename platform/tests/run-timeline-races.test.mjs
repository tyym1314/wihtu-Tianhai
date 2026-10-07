import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../arena/run/engine.mjs';
import {RUN_COURSES_V21} from '../arena/run/courses.mjs';
import {createRunTimeline} from '../arena/run/timeline.mjs';
import {makeRunActionReceipt} from '../shared/run-action-receipt.mjs';

const EPOCH=1791400000000,ROOM='pvp_timeline_full_race',KEY='human',FRAME_MS=1000/60;
const OUTBOUND=[45,55,35,65,50],INBOUND=[95,125,75,230,85,105,60,180];
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const physicalTypes=new Set(['hit','shield_hit','fall','respawn','finish']);
const close=(a,b)=>Math.abs(a-b)<1e-7;
function clientPublicationBefore(publications,actions,at){
 let latest=null;
 const consider=(publication,receivedAt)=>{if(publication&&receivedAt<=at&&(!latest||publication.version>latest.publication.version))latest={publication,receivedAt};};
 for(let sent=0,index=0;sent<=at;sent+=150,index++){
  const readAt=sent+OUTBOUND[index%OUTBOUND.length],receivedAt=readAt+INBOUND[index%INBOUND.length];
  if(receivedAt>at)continue;
  consider(publications.findLast(publication=>publication.at<=readAt),receivedAt);
 }
 for(const [index,action]of actions.entries())consider(publications.find(publication=>close(publication.at,action.at)),action.at+90+(index%3)*15);
 return latest;
}

/** Only the real complete engine produces game snapshots, accepted inputs and
 * collision evidence. The network below changes delivery time, never state. */
function authorityRace(courseIndex,drive){
 const seed=courseIndex.toString(16).padStart(8,'0').padEnd(64,'0');
 const state=E.createState(seed,EPOCH,{ruleVersion:E.PRACTICE_RULE_VERSION,startPolicy:E.RUN_SCENE_READY_POLICY,players:[{key:KEY,seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});
 E.armStart(state,EPOCH);
 const publications=[],actions=[],truth=[],physicalEvents=[];let serial=0,seenEvent=0,previousResolved=new Set();
 for(let tick=0;tick<=6000;tick++){
  const now=EPOCH+Math.ceil(tick*FRAME_MS);E.tick(state,now);
  if(drive&&tick>0&&tick%15===0&&state.status==='active'){
   for(const player of state.players){
    const action=E.botAction(state,player.key,now);
    if(!action)continue;
    // A human cannot press the item button before the response exposing the
    // pickup arrives. BOT advice is only a script; it does not bypass that UI.
    if(player.key===KEY&&action.type==='item'){
     const delivered=clientPublicationBefore(publications,actions,tick*FRAME_MS-60);
     if(delivered?.publication.game.players.find(p=>p.key===KEY)?.inventory!==player.inventory)continue;
    }
    const accepted=E.act(state,player.key,action,now);
    if(player.key===KEY){
     const seq=actions.length+1,request_id=`full_race_request_${seq}`,token=`full-race-token-${seq}`;
     const expected={roomId:ROOM,playerKey:KEY,request_id,seq,type:action.type,ruleVersion:state.ruleVersion};
     actions.push({at:tick*FRAME_MS,token,expected,pending:{...player.pendingInput},receipt:freeze(makeRunActionReceipt({...expected,event:accepted.event}))});
    }
   }
  }
  const player=state.players[0];
  truth.push({tick:state.tick,distance:player.distanceU/300,fallUntilTick:player.fallUntilTick,stunUntilTick:player.stunUntilTick,finishTick:player.finishTick,forfeited:player.forfeited});
  for(const event of state.events){if(event.id<=seenEvent)continue;if(event.playerKey===KEY&&physicalTypes.has(event.type))physicalEvents.push({...event});}
  // Immune obstacle contacts mutate resolvedObstacles without emitting a hit.
  // They are still real collision boundaries, not ordinary synchronization.
  if(player.resolvedObstacles.some(id=>!previousResolved.has(id))&&!physicalEvents.some(event=>event.tick===state.tick&&['hit','shield_hit'].includes(event.type)))physicalEvents.push({type:'collision',playerKey:KEY,tick:state.tick});
  previousResolved=new Set(player.resolvedObstacles);
  seenEvent=Math.max(seenEvent,...state.events.map(event=>event.id));
  if(tick%15===0||state.status!=='active')publications.push({at:tick*FRAME_MS,version:++serial,game:freeze(E.view(state,KEY))});
  if(state.status!=='active')break;
 }
 for(const action of actions){
  action.publication=publications.find(entry=>close(entry.at,action.at));
  assert.ok(action.publication,'an action receipt retains its exact authoritative publication');
  assert.deepEqual(action.publication.game.selfPrediction.pendingInput,action.pending);
 }
 assert.equal(state.status,'finished','fixture must cover a whole natural race or the 100-second limit');
 return {course:state.courseId,drive,publications,actions,truth,physicalEvents,endAt:publications.at(-1).at,final:state,authorityBytes:JSON.stringify(publications)};
}

function networkEvents(race){
 const events=[];
 // Polls are actually sent every 150 ms. A request reads the latest 250 ms
 // publication on arrival; a slow response can then arrive after a newer one.
 for(let sent=0,index=0;sent<=race.endAt+450;sent+=150,index++){
  const readAt=sent+OUTBOUND[index%OUTBOUND.length],receivedAt=readAt+INBOUND[index%INBOUND.length];
  const publication=race.publications[Math.min(Math.floor(readAt/250),race.publications.length-1)];
  events.push({kind:'receive',at:receivedAt,publication,sentAt:sent,readAt});
 }
 for(const [index,action]of race.actions.entries()){
  // The recorded action was independently admitted by the engine. Dispatch
  // precedes that admission by 60 ms, and its ACK takes another 90--120 ms.
  const dispatchedAt=action.at-60,receivedAt=action.at+90+(index%3)*15;
  events.push({kind:'dispatch',at:dispatchedAt,action});
  events.push({kind:'ack',at:receivedAt,action,publication:action.publication});
 }
 return events.sort((a,b)=>a.at-b.at||({dispatch:0,ack:1,receive:2}[a.kind]-{dispatch:0,ack:1,receive:2}[b.kind]));
}
function truthAt(race,tick){return race.truth[Math.max(0,Math.min(race.truth.length-1,Math.floor(tick)))];}
function classify(race,previous,next){
 const low=Math.min(previous.pose.tick,next.pose.tick),high=Math.max(previous.pose.tick,next.pose.tick);
 const transition=race.physicalEvents.find(event=>event.tick>low&&event.tick<=high);
 if(transition)return transition.type;
 const a=truthAt(race,previous.pose.tick),b=truthAt(race,next.pose.tick);
 if(a.fallUntilTick!==null||b.fallUntilTick!==null)return 'falling';
 if(a.tick<a.stunUntilTick||b.tick<b.stunUntilTick)return 'stunned';
 if(a.finishTick!==null||b.finishTick!==null)return 'finished';
 if(a.forfeited||b.forfeited)return 'forfeited';
 return 'ordinary';
}
function simulate(race){
 const timeline=createRunTimeline(),events=networkEvents(race);
 const stats={course:race.course,difficulty:RUN_COURSES_V21.find(course=>course.id===race.course).difficulty,drive:race.drive,durationMs:race.endAt,frames:0,receives:0,acceptedReceives:0,reorderedResponses:0,dispatches:0,rejectedDispatches:0,acks:0,rejectedAcks:0,itemInputs:race.actions.filter(action=>action.pending.type==='item').length,resyncs:0,resyncReasons:{},holdsByReason:{},ordinaryHoldsByReason:{},ordinaryForwardJumps:0,ordinaryBackwards:0,ordinaryLongHolds:0,maxOrdinaryStep:0,maxOrdinaryExcess:0,maxOrdinaryHoldMs:0,maxOrdinaryLagMs:0,p95OrdinaryLagMs:0,physicalTransitions:{},violations:[],worstForward:null};
 const context=[],ordinaryLag=[];let cursor=0,previous=null,latestVersion=-1,holdStart=null,holdReported=false;
 const remember=entry=>{context.push(entry);if(context.length>36)context.shift();};
 const violation=(kind,frame,extra={})=>{if(stats.violations.length<4)stats.violations.push({kind,frame,...extra,context:structuredClone(context)});};
 for(let frame=0;frame*FRAME_MS<=race.endAt+650;frame++){
  const at=frame*FRAME_MS;
  while(cursor<events.length&&events[cursor].at<=at+1e-7){
   const event=events[cursor++];
   if(event.kind==='dispatch'){
    const dispatch={token:event.action.token,...event.action.expected,dispatchedAtMs:event.at};
    const accepted=timeline.noteInput(dispatch);stats.dispatches++;if(!accepted)stats.rejectedDispatches++;
    remember({kind:'dispatch',at:event.at,accepted,...dispatch});
   }else{
    const publication=event.publication;
    if(event.kind==='ack'){
     const accepted=timeline.resolveInput({token:event.action.token,receipt:event.action.receipt});stats.acks++;if(!accepted)stats.rejectedAcks++;
     remember({kind:'ack',at:event.at,accepted,receipt:event.action.receipt});
    }
    stats.receives++;if(publication.version<latestVersion)stats.reorderedResponses++;
    const accepted=timeline.receive(publication.game,KEY,{roomId:ROOM,roomVersion:publication.version,receivedAtMs:event.at});if(accepted){stats.acceptedReceives++;latestVersion=publication.version;}
    remember({kind:'receive',at:event.at,sourceAt:publication.at,version:publication.version,tick:publication.game.snapshotTick,pending:publication.game.selfPrediction?.pendingInput,accepted});
   }
  }
  const sample=timeline.sample(at),pose=sample.pose;
  if(!pose)continue;
  stats.frames++;
  const current={at,mode:sample.mode,reason:sample.reason,baseTick:sample.baseTick,baseVersion:sample.baseVersion,displayTick:sample.displayTick,pose:{tick:pose.tick,distance:pose.distance,x:pose.x,y:pose.y,scale:pose.scale}};
  if(sample.mode==='resync'){stats.resyncs++;stats.resyncReasons[sample.reason]=(stats.resyncReasons[sample.reason]??0)+1;remember({kind:'resync',...current});}
  if(sample.mode==='hold')stats.holdsByReason[sample.reason]=(stats.holdsByReason[sample.reason]??0)+1;
  if(!Number.isFinite(pose.distance)||pose.distance<0||pose.distance>480+1e-7)violation('distance-outside-course',current);
  if(previous){
   const classification=classify(race,previous,current),delta=pose.distance-previous.pose.distance,dt=at-previous.at;
   if(classification==='ordinary'){
    // Even boost is only 9.6m/s. A further 1/300m accounts for integer units;
    // mode=resync and input-outcome-unknown are deliberately not exemptions.
    const excess=delta-9.6*dt/1000;
    if(at<=race.endAt){const lag=at-pose.tick*FRAME_MS;ordinaryLag.push(lag);stats.maxOrdinaryLagMs=Math.max(stats.maxOrdinaryLagMs,lag);}
    if(excess>stats.maxOrdinaryExcess+1e-7)stats.worstForward={frame:current,previous,delta,excess,context:structuredClone(context)};
    stats.maxOrdinaryStep=Math.max(stats.maxOrdinaryStep,delta);stats.maxOrdinaryExcess=Math.max(stats.maxOrdinaryExcess,excess);
    if(excess>1/300+1e-7){stats.ordinaryForwardJumps++;violation('ordinary-forward-jump',current,{previous,delta,excess});}
    if(delta<-1e-7){stats.ordinaryBackwards++;violation('ordinary-backward',current,{previous,delta});}
    if(Math.abs(delta)<1e-7){
     const reason=sample.reason??'unlabelled';stats.ordinaryHoldsByReason[reason]=(stats.ordinaryHoldsByReason[reason]??0)+1;
     if(holdStart===null)holdStart=previous.at;
     const duration=at-holdStart;stats.maxOrdinaryHoldMs=Math.max(stats.maxOrdinaryHoldMs,duration);
     if(duration>=100-1e-7&&!holdReported){stats.ordinaryLongHolds++;holdReported=true;violation('ordinary-hold-at-least-100ms',current,{duration,holdStart});}
    }else{holdStart=null;holdReported=false;}
   }else{stats.physicalTransitions[classification]=(stats.physicalTransitions[classification]??0)+1;holdStart=null;holdReported=false;}
  }
  previous=current;
 }
 ordinaryLag.sort((a,b)=>a-b);stats.p95OrdinaryLagMs=ordinaryLag[Math.floor(ordinaryLag.length*.95)]??0;
 assert.equal(JSON.stringify(race.publications),race.authorityBytes,'controller mutated frozen authoritative data');
 return stats;
}

for(let course=0;course<6;course++)for(const drive of [false,true]){
 test(`full race ${RUN_COURSES_V21[course].id}, ${drive?'legal actions and item ACKs':'idle collisions and respawns'}, delayed reordered snapshots`,t=>{
  const race=authorityRace(course,drive),stats=simulate(race);
  t.diagnostic(JSON.stringify(stats));
  assert.ok(stats.frames>2400,'test must cover sustained gameplay, not only the safe introduction');
  assert.ok(stats.reorderedResponses>0,'the network schedule must actually deliver an older response after a newer one');
  if(drive){assert.ok(stats.itemInputs>=2,'full legal play must include real held-item actions');assert.equal(stats.rejectedDispatches,0,'a valid scripted input was not tracked');assert.equal(stats.rejectedAcks,0,'the actual engine ACK was not tracked');}
  assert.equal(stats.violations.length,0,JSON.stringify({course:stats.course,drive,ordinaryForwardJumps:stats.ordinaryForwardJumps,ordinaryBackwards:stats.ordinaryBackwards,ordinaryLongHolds:stats.ordinaryLongHolds,maxOrdinaryHoldMs:stats.maxOrdinaryHoldMs,resyncReasons:stats.resyncReasons,firstViolation:stats.violations[0]}));
  assert.ok(stats.maxOrdinaryLagMs<=650,`ordinary display fell ${stats.maxOrdinaryLagMs}ms behind the engine`);
 });
}
test('same-version deliveries cannot renew a stalled publication projection budget',()=>{
 const race=authorityRace(0,false),publication=race.publications[1],timeline=createRunTimeline();
 assert.equal(timeline.receive(publication.game,KEY,{roomId:ROOM,roomVersion:publication.version,receivedAtMs:500}),true);
 for(let at=500;at<=1200;at+=FRAME_MS)timeline.sample(at);
 const held=timeline.sample(1250);assert.equal(held.mode,'hold');
 for(const at of [1500,2000,5000,10000]){
  assert.equal(timeline.receive(publication.game,KEY,{roomId:ROOM,roomVersion:publication.version,receivedAtMs:at}),false);
  const result=timeline.sample(at);assert.equal(result.mode,'hold');assert.deepEqual(result.pose,held.pose);assert.equal(result.displayTick,held.displayTick);
 }
});
