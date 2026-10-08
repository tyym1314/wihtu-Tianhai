import {fail} from '../security.mjs';
import {PRACTICE_INPUT_RULE_VERSION,RULES} from '../../arena/run/engine.mjs';
import {RUN_PRACTICE_INPUT_PROTOCOL,createRunPracticeInputs,compactRunPracticeDecisions} from './run-practice-inputs.mjs';
import {runEngineTask} from './engine-pool.mjs';

export {RUN_PRACTICE_INPUT_PROTOCOL};
export function isRunInputRoom(r){
  return r.game_id==='run'&&r.rule_version===PRACTICE_INPUT_RULE_VERSION&&r.practice===true&&String(r.entry_minor)==='0'&&r.fee_bps===0
    &&r.terms?.rule_version===PRACTICE_INPUT_RULE_VERSION&&Array.isArray(r.players)&&r.players.length>=2&&r.players.length<=4
    &&r.players.filter(p=>!p.bot).length===1&&r.players.every(p=>typeof p.bot==='boolean');
}
const keyOf=r=>r.players.find(p=>!p.bot).external_user_id;
const selfFields=['key','distanceU','checkpointU','lane','fromLane','changeStartTick','changeEndTick','jumpStartTick','slideUntilTick','stunUntilTick','immuneUntilTick','fallStartTick','fallUntilTick','shieldUntilTick','boostUntilTick','inventory','claimedItems','resolvedObstacles','hits','inputNo','appliedInputNo','lastInputTick','pendingInput','finishTick','finishedAt','forfeited'];
function assertBinding(r){
  const e=r.run_input_state;
  if(!isRunInputRoom(r)||!e||e.roomId!==r.id||e.playerKey!==keyOf(r)||e.protocol!==RUN_PRACTICE_INPUT_PROTOCOL)fail(503,'INVALID_PRACTICE_SCOPE');
  for(const state of [e.anchor,e.current]){
    if(state?.ruleVersion!==r.rule_version||state.players?.length!==r.players.length||r.players.some(p=>!state.players.some(q=>q.key===p.external_user_id&&q.seatIndex===p.seat_index&&q.isBot===p.bot)))fail(503,'INVALID_PRACTICE_SCOPE');
  }
}
const job=(r,operation,extra={})=>({kind:'run-practice-inputs',gameId:'run',ruleVersion:PRACTICE_INPUT_RULE_VERSION,operation,envelope:r.run_input_state,...extra});
export function initializeRunInputRoom(r){
  if(!isRunInputRoom(r)||r.run_input_state)fail(503,'INVALID_PRACTICE_SCOPE');
  r.run_input_state=createRunPracticeInputs({roomId:r.id,playerKey:keyOf(r),practice:true,entryMinor:'0',clockEpoch:1,state:r.game_state}).envelope;
  r.game_state=r.run_input_state.current;
}
export function runInputResultCommitted(r){
  const e=r.run_input_state;if(!e)return false;assertBinding(r);return e.current.status==='finished'&&e.current.tick<=e.committedThroughTick;
}
export async function shiftRunInputRoom(r,pauseMs){
  assertBinding(r);
  const result=await runEngineTask(job(r,'shift',{pause:{pauseMs,clockEpoch:r.run_input_state.clockEpoch+1}}));
  r.run_input_state=result.envelope;r.game_state=result.envelope.current;
}
export async function advanceRunInputRoom(r,now){
  assertBinding(r);
  if(now<r.last_tick_at)fail(400,'CLOCK_REWIND');
  const target=Math.min(6120,Math.max(0,Math.floor((now-r.run_input_state.anchor.startedAt)*RULES.hz/1000)));
  // Normal ticks catch up at most a five-second coordinator gap. Larger real
  // shared pauses must rotate the clock epoch before reaching this function.
  if(target-r.run_input_state.serverTick>360){const e=new Error('Replay catch-up requires clock recovery');Object.assign(e,{code:'RUN_REPLAY_CATCHUP_REQUIRED',status:503,engineUnavailable:true});throw e;}
  while(r.run_input_state.serverTick<target){
    const result=await runEngineTask(job(r,'advance',{serverTick:Math.min(target,r.run_input_state.serverTick+120)}));
    r.run_input_state=result.envelope;r.game_state=result.envelope.current;
  }
  r.last_tick_at=now;
}
export function runInputAuthority(r,decisions=[],correction=null){
  const e=r.run_input_state;if(!e)return null;
  assertBinding(r);
  const mine=e.current.players.find(p=>p.key===e.playerKey),committed=runInputResultCommitted(r);
  return {protocol:RUN_PRACTICE_INPUT_PROTOCOL,ruleVersion:PRACTICE_INPUT_RULE_VERSION,roomId:r.id,playerKey:e.playerKey,clockEpoch:e.clockEpoch,
    revision:e.revision,headTick:e.current.tick,serverTick:e.serverTick,committedThroughTick:e.committedThroughTick,
    processedThroughCommandSeq:e.lastCommandSeq,acceptedInputNo:mine.inputNo,decisions,correction,
    // Only this authenticated runner's replay proof. A head-only snapshot
    // cannot reconcile a still-unacknowledged input issued before that head.
    selfReplay:{schema:'run-practice-self-replay-v1',anchorTick:e.anchor.tick,
      player:structuredClone(Object.fromEntries(selfFields.map(key=>[key,e.anchor.players.find(p=>p.key===e.playerKey)[key]]))),
      acceptedCommands:e.commands.map(({commandSeq,type,executeTick,acceptedInputNo})=>({commandSeq,type,executeTick,acceptedInputNo}))},
    resultAuthorization:committed?{key:`${r.id}/${e.clockEpoch}/${e.current.tick}`,clockEpoch:e.clockEpoch,terminalTick:e.current.tick,committedThroughTick:e.committedThroughTick,revision:e.revision}:null};
}
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const denialCodes=new Set(['TERMINAL_COMMITTED','INPUT_EXPIRED','FUTURE_INPUT','EXECUTION_ORDER','INVALID_ACTION','NOT_ACTIVE','NOT_STARTED','STALE_INPUT','INPUT_PENDING','RATE_LIMIT','BUSY','CHANGING_LANE','TRACK_EDGE','ALREADY_JUMPING','SLIDING','AIRBORNE','NO_ITEM','WRONG_ITEM','BOOST_ACTIVE','ADMISSION_FAILED']);
function validDecision(d,e){
  return exact(d,['commandSeq','type','executeTick','clockEpoch','outcome','code','acceptedInputNo','decidedAtServerTick','revision'])
    &&integer(d.commandSeq,1)&&d.commandSeq<=e.lastCommandSeq&&typeof d.type==='string'&&d.type.length<=32&&integer(d.executeTick,1)&&d.executeTick<=6001
    &&integer(d.clockEpoch,1)&&d.clockEpoch<=e.clockEpoch&&integer(d.decidedAtServerTick)&&d.decidedAtServerTick<=e.serverTick&&integer(d.revision,1)&&d.revision<=e.revision
    &&(d.outcome==='accepted'&&d.code===null&&integer(d.acceptedInputNo,1)&&d.acceptedInputNo<=e.current.players.find(p=>p.key===e.playerKey).inputNo
      ||d.outcome==='rejected'&&denialCodes.has(d.code)&&d.acceptedInputNo===null);
}
const clientErrors=new Set(['STALE_CLOCK_EPOCH','UNKNOWN_BASE_REVISION','BASE_REVISION_EXPIRED','COMMAND_SEQUENCE_GAP','COMMAND_CONFLICT','DECISION_EPOCH_MISMATCH']);
export async function prepareRunInputBatch(r,playerKey,body,db){
  if(!isRunInputRoom(r)||!r.run_input_state)fail(409,'UNSUPPORTED_INPUT_PROTOCOL');
  assertBinding(r);
  const e=r.run_input_state;
  if(!exact(body,['request_id','roomId','playerKey','clockEpoch','baseRevision','commands'])||body.roomId!==r.id||body.playerKey!==playerKey||playerKey!==e.playerKey)fail(400,'INVALID_INPUT_SCOPE');
  if(body.clockEpoch!==e.clockEpoch)fail(409,'STALE_CLOCK_EPOCH');
  if(!integer(body.baseRevision)||body.baseRevision>e.revision)fail(409,'UNKNOWN_BASE_REVISION');
  const commands=body.commands;
  if(!Array.isArray(commands)||!commands.length||commands.length>8)fail(400,'INVALID_BATCH');
  if(commands.some(c=>!exact(c,['commandSeq','type','executeTick'])||!integer(c.commandSeq,1)||typeof c.type!=='string'||c.type.length>32||!integer(c.executeTick,1)||c.executeTick>6001))fail(400,'INVALID_COMMAND');
  if(commands.some((c,i)=>i&&c.commandSeq!==commands[i-1].commandSeq+1))fail(409,'COMMAND_SEQUENCE_GAP');
  const old=commands.filter(c=>c.commandSeq<=e.lastCommandSeq),fresh=commands.slice(old.length),repeated=[];
  if(old.length){
    const rows=(await db.query('SELECT command_seq,decision FROM pvp_run_input_decisions WHERE room_id=$1 AND external_user_id=$2 AND command_seq=ANY($3::bigint[])',[r.id,playerKey,old.map(c=>c.commandSeq)])).rows;
    for(const command of old){
      const saved=rows.find(row=>Number(row.command_seq)===command.commandSeq)?.decision;
      if(!saved)fail(503,'DURABLE_DECISION_MISSING');
      if(!validDecision(saved,e))fail(503,'INVALID_DURABLE_DECISION');
      if(saved.clockEpoch!==e.clockEpoch)fail(409,'DECISION_EPOCH_MISMATCH');
      if(saved.commandSeq!==command.commandSeq||saved.type!==command.type||saved.executeTick!==command.executeTick)fail(409,'COMMAND_CONFLICT');
      repeated.push({...saved,duplicate:true});
    }
  }
  let result={envelope:e,decisions:[],correction:null};
  if(fresh.length){
    try{result=await runEngineTask(job(r,'apply',{serverTick:e.serverTick,request:{roomId:r.id,playerKey,clockEpoch:e.clockEpoch,baseRevision:body.baseRevision,commands:fresh}}));}
    catch(error){if(clientErrors.has(error.code))error.status=409;else if(error.code==='WORK_BUDGET_EXCEEDED')error.status=422;throw error;}
  }
  return {...result,decisions:[...repeated,...result.decisions],newDecisions:result.decisions};
}
/** Caller owns the room lock AND a real DB transaction. Its save(room) and
 * exact HTTP response ledger must commit in this same transaction. */
export async function persistRunInputBatch(r,result,c){
  for(const decision of result.newDecisions){
    const {duplicate,...durable}=decision;
    await c.query('INSERT INTO pvp_run_input_decisions(room_id,external_user_id,command_seq,decision) VALUES($1,$2,$3,$4)',[r.id,keyOf(r),decision.commandSeq,durable]);
  }
  r.run_input_state=compactRunPracticeDecisions(result.envelope,{throughSeq:result.envelope.lastCommandSeq}).envelope;
  r.game_state=r.run_input_state.current;
}
