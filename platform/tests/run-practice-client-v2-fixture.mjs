import * as engine from '../arena/run/engine.mjs';
import {RUN_PRACTICE_PROFILES as P} from '../shared/run-practice-profiles.mjs';
import {createRunPracticeInputs,advanceRunPracticeInputs,applyRunPracticeInputs} from '../server/pvp/run-practice-inputs.mjs';
export const MS=1000/60,ROOM='client_v2_room',SELF='self';
export const OWN_FIELDS=['key','distanceU','checkpointU','lane','fromLane','changeStartTick','changeEndTick','jumpStartTick','slideUntilTick','stunUntilTick','immuneUntilTick','fallStartTick','fallUntilTick','shieldUntilTick','boostUntilTick','inventory','claimedItems','resolvedObstacles','hits','inputNo','appliedInputNo','lastInputTick','pendingInput','finishTick','finishedAt','forfeited'];
export const owned=p=>Object.fromEntries(OWN_FIELDS.map(k=>[k,structuredClone(p[k])]));
export function start({profile=P.v2,course='sunrise-arches',bots=3}={}){
 const state=engine.createState('00'.repeat(32),1000,{ruleVersion:profile.ruleVersion,startPolicy:engine.RUN_SCENE_READY_POLICY,practiceCourseId:course,
  players:[{key:SELF,seatIndex:0,isBot:false},...Array.from({length:bots},(_,i)=>({key:'bot_'+i,seatIndex:i+1,isBot:true}))]});
 engine.armStart(state,1000);
 return createRunPracticeInputs({roomId:ROOM,playerKey:SELF,practice:true,entryMinor:'0',clockEpoch:1,state,protocol:profile.protocol,...(profile.profileId?{profileId:profile.profileId,feeBps:0}:{})}).envelope;
}
export function advance(e,tick){while(e.serverTick<tick)e=advanceRunPracticeInputs(e,Math.min(tick,e.serverTick+120)).envelope;return e;}
export function apply(e,handle,tick=e.serverTick){return applyRunPracticeInputs(e,handle.payload,tick);}
export function publicRoom(e,{decisions=[],correction=null}={}){
 const profile=e.profileId?P.v2:P.v1,p=e.current.players.find(p=>p.key===SELF),authorization=e.current.status==='finished'&&e.current.tick<=e.committedThroughTick;
 const game=engine.view(e.current,SELF);game.resultCommitted=authorization;if(!authorization)game.winnerKeys=[];
 return {id:ROOM,game_id:'run',practice:true,entry_minor:'0',fee_bps:0,capacity:e.current.players.length,status:authorization?'settled':'active',me:SELF,version:e.revision+1,
  run_input_profile:{rule_version:profile.ruleVersion,protocol:profile.protocol,profile_id:profile.profileId},game,
  run_inputs:{protocol:e.protocol,ruleVersion:profile.ruleVersion,...(profile.profileId?{profileId:profile.profileId,committedOwnEvents:structuredClone(e.anchor.practiceOwnEvents.filter(e=>e.playerKey===SELF))}:{}),roomId:ROOM,playerKey:SELF,clockEpoch:e.clockEpoch,
   revision:e.revision,headTick:e.current.tick,serverTick:e.serverTick,committedThroughTick:e.committedThroughTick,processedThroughCommandSeq:e.lastCommandSeq,acceptedInputNo:p.inputNo,decisions:structuredClone(decisions),correction:structuredClone(correction),
   resultAuthorization:authorization?{key:`${ROOM}/${e.clockEpoch}/${e.current.tick}`,clockEpoch:e.clockEpoch,terminalTick:e.current.tick,committedThroughTick:e.committedThroughTick,revision:e.revision}:null,
   selfReplay:{schema:'run-practice-self-replay-v1',anchorTick:e.anchor.tick,player:owned(e.anchor.players.find(p=>p.key===SELF)),acceptedCommands:e.commands.map(({commandSeq,type,executeTick,acceptedInputNo})=>({commandSeq,type,executeTick,acceptedInputNo}))}}};
}
export function knownFall(){
 let e=advance(start(),37);
 e=applyRunPracticeInputs(e,{roomId:ROOM,playerKey:SELF,clockEpoch:1,baseRevision:e.revision,commands:[{commandSeq:1,type:'jump',executeTick:13}]},37).envelope;
 return e;
}
