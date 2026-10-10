/** Same-room UI exercise. It does not create rooms, submit API mutations or certify motion. */
import {roomAllowsAction} from './mobile-quality-metrics.mjs';
import {RULE_VERSION as RUN_VERSION,PREVIOUS_RULE_VERSION as PREVIOUS_RUN_VERSION,PRACTICE_RULE_VERSION,PRACTICE_INPUT_RULE_VERSION,PRACTICE_INPUT_V2_RULE_VERSION,RULES as RUN_RULES} from '../arena/run/engine.mjs';
import {RULE_VERSION as LEGACY_RUN_VERSION,RULES as LEGACY_RUN_RULES} from '../arena/run/engine-v1.mjs';
import {runPracticeInputBaseline} from './android-game-actions.mjs';
import {readRunPracticeRoomProfile} from '../arena/run/practice-profile-contract.mjs';
const runRules=new Map([[RUN_VERSION,RUN_RULES],[PREVIOUS_RUN_VERSION,RUN_RULES],[PRACTICE_RULE_VERSION,RUN_RULES],[PRACTICE_INPUT_RULE_VERSION,RUN_RULES],[PRACTICE_INPUT_V2_RULE_VERSION,RUN_RULES],[LEGACY_RUN_VERSION,LEGACY_RUN_RULES]]);

/** Conservative public-snapshot admission for the helper's actual action: jump. */
export function canExerciseRunJump(room){
 const g=room?.game,me=g?.players?.find?.(p=>p.key===room.me),rules=runRules.get(g?.ruleVersion),tick=g?.snapshotTick;
 if(!rules||!me||!roomAllowsAction('run',room)||!['racing','finish-window'].includes(g.phase)||!Number.isSafeInteger(tick)||tick<0)return false;
 if(room.game_id!=='run'||g.gameId!=='run'||g.me!==room.me||g.players.filter(p=>p.key===room.me).length!==1)return false;
 if(g.ruleVersion===PRACTICE_RULE_VERSION&&(room.practice!==true||room.entry_minor!=='0'||room.run_inputs||!g.players.every(p=>typeof p.isBot==='boolean')||g.players.filter(p=>!p.isBot).length!==1||me.isBot!==false))return false;
 if(g.ruleVersion===PRACTICE_INPUT_RULE_VERSION||g.ruleVersion===PRACTICE_INPUT_V2_RULE_VERSION){
  // Reuse the UI helper's canonical negotiated profile and exact own cursor.
  // A matching version alone does not authorize a paid/mixed/foreign input.
  try{if(!readRunPracticeRoomProfile(room)||!runPracticeInputBaseline(room))return false;}catch(error){if(error.code==='RUN_INPUT_PROOF_INVALID')return false;throw error;}
 }
 if(!Number.isFinite(room.server_now)||!Number.isFinite(g.startedAt)||room.server_now<g.startedAt||!Number.isFinite(g.deadlineAt)||room.server_now>=g.deadlineAt)return false;
 if(me.finishTick!==null||me.forfeited||me.fallUntilTick!==null)return false;
 if(!Number.isSafeInteger(me.inputNo)||!Number.isSafeInteger(me.appliedInputNo)||me.inputNo!==me.appliedInputNo)return false;
 if(!Number.isSafeInteger(me.slideUntilTick)||!Number.isSafeInteger(me.stunUntilTick)||me.jumpStartTick!==null&&!Number.isSafeInteger(me.jumpStartTick))return false;
 const next=tick+1;
 if(next<me.slideUntilTick||next<me.stunUntilTick||me.jumpStartTick!==null&&next<me.jumpStartTick+rules.jumpTicks)return false;
 // A public input event exposes the accepted simulation tick; a later hit/fall
 // instead remains blocked by the recovery fields above. Never extrapolate time.
 if(me.lastEvent?.inputNo===me.inputNo&&Number.isSafeInteger(me.lastEvent.tick)&&next<me.lastEvent.tick+rules.inputRateTicks)return false;
 return true;
}


export function activityRoomState(room,game,roomId){
 if(!room)return 'waiting-snapshot';
 if(room.id!==roomId||room.game_id!==game)return 'room-changed';
 const g=room.game||{},me=g.me&&typeof g.me==='object'?g.me:Array.isArray(g.players)?g.players.find(p=>p.key===room.me):g.players?.[room.me];
 if(room.status!=='active'||g.status==='finished'||g.phase==='fault'||g.forfeited||me?.forfeited||me?.eliminated||me?.finishTick!=null)return 'terminal';
 if(game==='golf'&&(g.phase==='intermission'||me?.completed)&&me?.completedScores?.length<3)return 'between-holes';
 if(me?.completed)return 'terminal';
 return 'active';
}
export function canExercise(game,room){
 if(!roomAllowsAction(game,room))return false;
 const g=room.game||{},me=g.me&&typeof g.me==='object'?g.me:g.players?.find?.(p=>p.key===room.me);
 if(Number(room.server_now)<Math.max(g.busyUntil||0,me?.busyUntil||0)||Number.isFinite(g.turnDeadlineAt)&&Number(room.server_now)>=g.turnDeadlineAt)return false;
 if(game==='run')return canExerciseRunJump(room);
 if(game==='towerlink')return g.legalActions?.some(a=>a.type==='link'&&g.towers?.some(t=>t.id===a.from&&t.troops>5))===true;
 if(game==='jackaroo')return g.phase==='exchange'?!g.passSubmitted&&g.hand?.length>0:g.legalActions?.length>0;
 return true;
}
export async function runContinuousActions({game,roomId,readRoom,playAction,deadlineAt,signal,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),pollMs=125,minimumActionBudgetMs=2500,actionIntervalMs=1000,initialSequence=null}){
 if(initialSequence!==null&&(!Number.isSafeInteger(initialSequence)||initialSequence<0))throw new Error('Invalid initial accepted sequence');
 const started=clock(),result={mode:'same-room-continuous-ui',room_count:1,initial_sequence:initialSequence,started_at:started,deadline_at:deadlineAt,actions:[],rejections:[],reason:null,overrun_ms:0};
 let nextActionAt=started,lastAcceptedSeq=initialSequence;
 const state=()=>activityRoomState(readRoom(),game,roomId);
 const guard=()=>{if(signal?.aborted)throw Object.assign(new Error('Continuous action aborted'),{code:'ACTION_ABORTED'});if(clock()>=deadlineAt)throw Object.assign(new Error('Continuous action deadline'),{code:'ACTION_DEADLINE'});if(state()!=='active'||!canExercise(game,readRoom()))throw Object.assign(new Error('Authority changed before UI action'),{code:'ACTION_STATE_CHANGED'});};
 while(clock()<deadlineAt){
  if(signal?.aborted){result.reason='aborted';break;}
  const status=state();
  if(status==='room-changed'||status==='terminal'){result.reason=status;break;}
  const room=readRoom(),remaining=deadlineAt-clock();
  if(status==='active'&&canExercise(game,room)&&clock()>=nextActionAt&&remaining>=minimumActionBudgetMs&&(lastAcceptedSeq===null||room.me_last_seq>=lastAcceptedSeq)){
   try{
    // This promise is always drained. No overlapping or abandoned helper may
    // continue clicking after this function returns.
    const action=await playAction({deadlineAt,timeoutMs:remaining,signal,beforeAction:guard});
    if(action.roomId!==roomId||action.sequenceAfter!==action.sequenceBefore+1)throw Object.assign(new Error('Continuous helper returned another room/sequence'),{code:'ACTION_EVIDENCE_INVALID'});
    lastAcceptedSeq=action.sequenceAfter;result.actions.push({...action,observed_at:clock()});
   }catch(e){
    result.rejections.push({at:clock(),code:e.code||null,status:e.status||null,message:e.message});
    if(e.code==='ACTION_STATE_CHANGED'){if(['terminal','room-changed'].includes(state())){result.reason=state();break;}}
    else if(['ACTION_DEADLINE','ACTION_ABORTED'].includes(e.code)){result.reason=e.code==='ACTION_DEADLINE'?'deadline':'aborted';break;}
    else if(!(e.status===409&&['BUSY','STALE_INPUT','INPUT_PENDING','RATE_LIMIT','NOT_YOUR_TURN','TURN_EXPIRED','NOT_ACTIVE'].includes(e.code))){result.reason='action-failed';break;}
    // A rejected action is recorded; any next attempt is a new trusted gesture
    // against a fresh authoritative state, never replaying an accepted POST.
   }
   nextActionAt=clock()+actionIntervalMs;
  }
  await sleep(Math.max(0,Math.min(pollMs,deadlineAt-clock())));
 }
 result.reason??='deadline';result.finished_at=clock();result.overrun_ms=Math.max(0,result.finished_at-deadlineAt);
 return result;
}
