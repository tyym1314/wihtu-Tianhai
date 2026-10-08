import {createHash} from 'node:crypto';
import * as engine from '../../arena/run/engine.mjs';

// Server-internal core for the explicit V2.3 HTTP opt-in (not yet deployed;
// the default UI still uses the previous profile).
// The coordinator must persist the returned envelope and decisions atomically.
// Never accept an envelope, serverTick, stakes or roster from a client.
// The unkeyed integrity hash detects damaged/incomplete stored history; it is
// not a client authentication mechanism. New public rooms must use the explicit
// V2.3 input rule; V2.2 remains allowed for mechanism fixtures only, never auto-
// adopted/upgraded by this core. Pause/epoch rotation is a trusted server call.
// A full decision tail fails closed. Only the server coordinator's explicit
// same-transaction durable-prefix declaration can compact it; old retries then
// require exact DB-ledger validation, never automatic re-admission here.
export const RUN_PRACTICE_INPUT_PROTOCOL='run-practice-inputs-v1';
export const RUN_PRACTICE_REPLAY_LIMITS=Object.freeze({historyTicks:120,advanceTicks:120,batch:8,decisions:128,revisions:128,envelopeBytes:262144});
export const RUN_PRACTICE_WORK_LIMITS=Object.freeze({ticks:240,admissions:1024,botDecisions:768,temporaryStates:12});
const L=RUN_PRACTICE_REPLAY_LIMITS,MAX_TICK=6000,types=new Set(['left','right','jump','slide','item']);
const practiceRules=new Set([engine.PRACTICE_RULE_VERSION,engine.PRACTICE_INPUT_RULE_VERSION].filter(v=>typeof v==='string'));
const copy=value=>structuredClone(value);
const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const id=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
function fail(code){throw Object.assign(new Error(code),{code});}
function exact(object,keys){return object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).length===keys.length&&keys.every(k=>Object.hasOwn(object,k));}
const at=(s,tick)=>Math.ceil(s.startedAt+tick*1000/engine.RULES.hz);
// PostgreSQL jsonb may reorder object keys at every depth. Canonicalize objects
// only, retaining array order and ordinary JSON value/omission semantics. This
// is deterministic integrity checking, not signing/authenticating client data.
const canonicalJSON=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)
 ?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
const digest=e=>createHash('sha256').update(canonicalJSON(e)).digest('hex');
function seal(e){delete e.integrity;const text=JSON.stringify(e);if(Buffer.byteLength(text)>L.envelopeBytes)fail('HISTORY_CAPACITY');return {...e,integrity:digest(e)};}
function scope(e){
 const s=e.anchor,players=s?.players;
 return e.protocol===RUN_PRACTICE_INPUT_PROTOCOL&&e.practice===true&&e.entryMinor==='0'&&id(e.roomId)&&id(e.playerKey)
  &&practiceRules.has(s?.ruleVersion)&&Array.isArray(players)&&players.length>=2&&players.length<=4
  &&players.filter(p=>p.isBot===false).length===1&&players.some(p=>p.key===e.playerKey&&p.isBot===false)
  &&players.every(p=>p.key===e.playerKey||p.isBot===true);
}
function validate(input,work){
 if(!input||typeof input!=='object')fail('INVALID_HISTORY');
 const {integrity,...raw}=input;
 if(Buffer.byteLength(JSON.stringify(raw))>L.envelopeBytes||integrity!==digest(raw))fail('INVALID_HISTORY');
 if(!scope(raw)||!integer(raw.clockEpoch,1)||!integer(raw.serverTick,0,MAX_TICK+L.historyTicks)||!integer(raw.revision)
  ||!integer(raw.lastCommandSeq)||!integer(raw.durableThrough,0,raw.lastCommandSeq)||!integer(raw.committedThroughTick,0,raw.serverTick)||!Array.isArray(raw.commands)||raw.commands.length>L.decisions
  ||!Array.isArray(raw.decisions)||raw.decisions.length>L.decisions||!Array.isArray(raw.revisions)||raw.revisions.length>L.revisions)fail('INVALID_HISTORY');
 if(raw.decisions.length!==raw.lastCommandSeq-raw.durableThrough||raw.decisions.some((d,i)=>d.commandSeq!==raw.durableThrough+i+1
  ||!integer(d.clockEpoch,1,raw.clockEpoch)||i>0&&d.clockEpoch<raw.decisions[i-1].clockEpoch))fail('INVALID_HISTORY');
 work.recordCopy(raw.anchor);work.recordCopy(raw.current);
 return copy(raw);
}
function own(s,key){return s.players.find(p=>p.key===key);}
function workContext(options={}){
 const maxTicks=options.maxWorkTicks??RUN_PRACTICE_WORK_LIMITS.ticks;
 if(!integer(maxTicks,0,RUN_PRACTICE_WORK_LIMITS.ticks)||options.measureWorkBytes!==undefined&&typeof options.measureWorkBytes!=='boolean')fail('INVALID_WORK_LIMIT');
 const stats={ticks:0,admissions:0,botDecisions:0,stateCopies:0,temporaryStatesPeak:0,copiedStateBytes:options.measureWorkBytes?0:null,temporaryStateBytesPeak:options.measureWorkBytes?0:null};
 const recordCopy=s=>{if(s?.players){stats.stateCopies++;if(options.measureWorkBytes)stats.copiedStateBytes+=Buffer.byteLength(JSON.stringify(s));}};
 return {stats,recordCopy,measureBytes:options.measureWorkBytes===true,charge(key){stats[key]++;if(stats[key]>(key==='ticks'?maxTicks:RUN_PRACTICE_WORK_LIMITS[key]))fail('WORK_BUDGET_EXCEEDED');},
  clone(s){recordCopy(s);return copy(s);},
  live(n,states=[]){stats.temporaryStatesPeak=Math.max(stats.temporaryStatesPeak,n);if(n>RUN_PRACTICE_WORK_LIMITS.temporaryStates)fail('WORK_BUDGET_EXCEEDED');
   if(options.measureWorkBytes)stats.temporaryStateBytesPeak=Math.max(stats.temporaryStateBytesPeak,[...new Set(states)].reduce((sum,s)=>sum+Buffer.byteLength(JSON.stringify(s)),0));}};
}
// Stable human-first then BOT seat order. BOT decisions happen every six ticks,
// including tick zero, regardless of worker/HTTP batching. engine.act performs
// admission; engine.tick supplies the actual shared physics and terminal rules.
function prepare(e,s,work){
 if(s.status!=='active')return;
 const next=s.tick+1,now=at(s,s.tick);
 for(const command of e.commands.filter(c=>c.executeTick===next)){
  work.charge('admissions');
  try{engine.act(s,e.playerKey,{type:command.type,observed_tick:s.tick},now);}
  catch{fail('ACCEPTED_HISTORY_CONFLICT');}
  if(own(s,e.playerKey).inputNo!==command.acceptedInputNo)fail('ACCEPTED_HISTORY_CONFLICT');
 }
 if(s.tick%engine.RULES.inputRateTicks===0)for(const bot of s.players.filter(p=>p.isBot).sort((a,b)=>a.seatIndex-b.seatIndex)){
  work.charge('botDecisions');const action=engine.botAction(s,bot.key,now);
  if(action){work.charge('admissions');engine.act(s,bot.key,action,now);}
 }
}
function step(s,work){work.charge('ticks');engine.tick(s,at(s,s.tick+1));}
// Only <=8 admission checkpoints and the anchor are retained, not a complete
// state for every tick. Ordered commands traverse the mutable suffix once.
// A later rejected command may precede an earlier accepted tick in seq order;
// preserve that business rule, invalidate its future checkpoints, and charge
// any repeated work to the SAME 240-tick atomic budget.
function cursor(e,points,work){
 let current=work.clone(e.anchor);prepare(e,current,work);
 const wanted=new Set(points),checkpoints=new Map();
 if(wanted.has(current.tick))checkpoints.set(current.tick,work.clone(current));
 // Includes the envelope's anchor/head, mutable cursor and admission copy.
 const live=extra=>work.live(checkpoints.size+4,work.measureBytes?[e.anchor,e.current,current,...checkpoints.values(),...(extra?[extra]:[])]:[]);
 live();
 function read(target){
  if(target<current.tick){const saved=checkpoints.get(target);if(!saved)fail('MISSING_ADMISSION_CHECKPOINT');const out=work.clone(saved);live(out);return out;}
  while(current.tick<target&&current.status==='active'){
   step(current,work);prepare(e,current,work);
   if(wanted.has(current.tick)){checkpoints.set(current.tick,work.clone(current));live();}
   else if(work.measureBytes)live();
  }
  const out=work.clone(current);live(out);return out;
 }
 return {read,adopt(state){
  for(const tick of checkpoints.keys())if(tick>=state.tick)checkpoints.delete(tick);
  current=state;checkpoints.set(state.tick,work.clone(state));live();
 }};
}
function result(e,decisions=[],correction=null,work){
 const authorized=e.current.status==='finished'&&e.current.tick<=e.committedThroughTick;
 return {envelope:seal(e),decisions:copy(decisions),correction,work:copy(work.stats),
  // Stable authorization key, NOT a payment or an exactly-once DB operation.
  resultAuthorization:authorized?{key:`${e.roomId}/${e.clockEpoch}/${e.current.tick}`,clockEpoch:e.clockEpoch,
   terminalTick:e.current.tick,committedThroughTick:e.committedThroughTick,revision:e.revision,
   outcome:e.current.outcome,winnerKeys:copy(e.current.winnerKeys),ranks:engine.rank(e.current)}:null};
}
function refreshAnchor(e,serverTick,work){
 if(!integer(serverTick,e.serverTick,Math.min(MAX_TICK+L.historyTicks,e.serverTick+L.advanceTicks)))fail('INVALID_SERVER_TICK');
 const watermark=Math.max(e.committedThroughTick,serverTick-L.historyTicks);
 if(watermark>e.anchor.tick){
  const next=work.clone(e.anchor);work.live(3,work.measureBytes?[e.anchor,e.current,next]:[]);
  while(next.tick<watermark&&next.status==='active'){prepare(e,next,work);step(next,work);if(work.measureBytes)work.live(3,[e.anchor,e.current,next]);}
  e.anchor=next;
 }
 e.serverTick=serverTick;e.committedThroughTick=watermark;
 e.commands=e.commands.filter(c=>c.executeTick>e.anchor.tick);
 e.revisions=e.revisions.filter(r=>r.serverTick>=e.committedThroughTick);
}
function publish(e){e.revision++;e.revisions.push({revision:e.revision,serverTick:e.serverTick});e.revisions=e.revisions.slice(-L.revisions);}

/** New server-created, already armed tick-zero free BOT rooms only. Existing
 * active rooms cannot be adopted without their real history. An outer new
 * V2.3 pinned profile must opt in; V2.2 acceptance is for local mechanism tests.
 */
export function createRunPracticeInputs({roomId,playerKey,practice,entryMinor,clockEpoch,state}={},options={}){
 const work=workContext(options);
 const e={protocol:RUN_PRACTICE_INPUT_PROTOCOL,roomId,playerKey,practice,entryMinor,clockEpoch,
  revision:0,serverTick:0,committedThroughTick:0,lastCommandSeq:0,durableThrough:0,lastAcceptedExecuteTick:0,
  anchor:work.clone(state),current:work.clone(state),commands:[],decisions:[],revisions:[{revision:0,serverTick:0}]};
 if(!scope(e)||!integer(clockEpoch,1))fail('INVALID_PRACTICE_SCOPE');
 if(state.tick!==0||state.status!=='active'||state.phase!=='racing'||state.now!==state.startedAt
  ||state.players.some(p=>p.inputNo!==0||p.pendingInput!==null||p.distanceU!==0||p.forfeited||p.finishTick!==null))fail('MISSING_INITIAL_HISTORY');
 e.current=cursor(e,[],work).read(0);
 return result(e,[],null,work);
}

export function advanceRunPracticeInputs(input,serverTick,options={}){
 const work=workContext(options),e=validate(input,work),changed=serverTick!==e.serverTick;
 refreshAnchor(e,serverTick,work);e.current=cursor(e,[],work).read(Math.min(serverTick,MAX_TICK));if(changed)publish(e);
 return result(e,[],null,work);
}

/** Trusted coordinator operation, NEVER a client ACK or HTTP payload API.
 * Call only after every decision through `throughSeq` has been inserted and
 * exact-payload checked in the durable ledger in the SAME DB transaction that
 * will persist this returned envelope. A rollback must discard both changes.
 * This pure function cannot observe or prove a database write/commit.
 *
 * Compaction changes no physics, history, sequence or published revision. The
 * private durableThrough cursor is only the coordinator's declaration. A retry
 * at/below it still throws DECISION_EXPIRED in applyRunPracticeInputs: look it
 * up in the DB, verify room/player/epoch/type/executeTick exactly, then return
 * that original decision. For a mixed prefix+new-tail request, the coordinator
 * must first validate the old prefix and pass only the remaining tail here.
 */
export function compactRunPracticeDecisions(input,declaration,options={}){
 const work=workContext(options),e=validate(input,work);
 if(!exact(declaration,['throughSeq'])||!integer(declaration.throughSeq,e.durableThrough,e.lastCommandSeq))fail('INVALID_DURABLE_PREFIX');
 work.live(2,work.measureBytes?[e.anchor,e.current]:[]);
 e.decisions=e.decisions.slice(declaration.throughSeq-e.durableThrough);
 e.durableThrough=declaration.throughSeq;
 return result(e,[],null,work);
}

/** Trusted shared server pause, not an input timestamp supplied by a client.
 * Shift the active history anchor and rebuild the same logical head. In
 * particular engine.shiftTime(current) alone would ignore a speculative
 * finished head and corrupt the anchor/head time mapping. Historical decision
 * receipts keep their original epoch; neither seq nor inputNo is reset. The
 * coordinator must finish an already committed terminal instead of pausing it.
 */
export function shiftRunPracticeInputs(input,declaration,options={}){
 const work=workContext(options),e=validate(input,work);
 if(!declaration||typeof declaration!=='object'||Array.isArray(declaration)
  ||Object.keys(declaration).some(k=>!['pauseMs','clockEpoch'].includes(k))||!integer(declaration.pauseMs,1,60000))fail('INVALID_PAUSE');
 const epoch=declaration.clockEpoch===undefined?e.clockEpoch+1:declaration.clockEpoch;
 if(!integer(epoch,1)||epoch!==e.clockEpoch+1)fail('INVALID_CLOCK_EPOCH');
 if(e.anchor.status==='finished'&&e.anchor.tick<=e.committedThroughTick)fail('TERMINAL_COMMITTED');
 engine.shiftTime(e.anchor,declaration.pauseMs);
 e.current=cursor(e,[],work).read(Math.min(e.serverTick,MAX_TICK));
 e.clockEpoch=epoch;e.revisions=[];publish(e);
 return result(e,[],null,work);
}

/** Business denials consume commandSeq and are durable decisions. Structural,
 * scope, sequence-gap, conflicting-duplicate or unknown-history failures throw
 * without mutating input. One batch is an atomic proposed state transition.
 * acceptedInputNo is exclusively the existing engine's successful input count.
 * executeTick may be the next tick, but never a more distant client future.
 */
export function applyRunPracticeInputs(input,request,serverTick,options={}){
 const work=workContext(options),e=validate(input,work);
 if(!exact(request,['roomId','playerKey','clockEpoch','baseRevision','commands'])||request.roomId!==e.roomId||request.playerKey!==e.playerKey)fail('INVALID_INPUT_SCOPE');
 if(request.clockEpoch!==e.clockEpoch)fail('STALE_CLOCK_EPOCH');
 if(!integer(request.baseRevision)||request.baseRevision>e.revision)fail('UNKNOWN_BASE_REVISION');
 if(!Array.isArray(request.commands)||request.commands.length<1||request.commands.length>L.batch)fail('INVALID_BATCH');
 for(const c of request.commands)if(!exact(c,['commandSeq','type','executeTick'])||!integer(c.commandSeq,1)||typeof c.type!=='string'||!integer(c.executeTick,1,MAX_TICK+1))fail('INVALID_COMMAND');
 if(request.commands.some((c,i)=>i>0&&c.commandSeq!==request.commands[i-1].commandSeq+1))fail('COMMAND_SEQUENCE_GAP');
 const oldTick=e.serverTick,oldRevision=e.revision,oldState=e.current,answers=[];
 // Duplicate receipts survive history expiry. Their exact payload must match;
 // they neither re-admit an action nor require an obsolete snapshot revision.
 const newCommands=request.commands.filter(c=>c.commandSeq>e.lastCommandSeq);
 if(e.decisions.length+new Set(newCommands.map(c=>c.commandSeq)).size>L.decisions)fail('DECISION_CAPACITY');
 refreshAnchor(e,serverTick,work);
 if(newCommands.length&&!e.revisions.some(r=>r.revision===request.baseRevision))fail('BASE_REVISION_EXPIRED');
 const replay=cursor(e,newCommands.map(c=>c.executeTick-1).filter(t=>t>=e.anchor.tick&&t<=serverTick),work);
 let changed=oldTick!==serverTick,earliest=null;
 for(const command of request.commands){
  if(command.commandSeq<=e.lastCommandSeq){
   const prior=e.decisions.find(d=>d.commandSeq===command.commandSeq);
   if(!prior)fail('DECISION_EXPIRED');
   if(prior.clockEpoch!==e.clockEpoch)fail('DECISION_EPOCH_MISMATCH');
   if(prior.type!==command.type||prior.executeTick!==command.executeTick)fail('COMMAND_CONFLICT');
   answers.push({...copy(prior),duplicate:true});continue;
  }
  if(command.commandSeq!==e.lastCommandSeq+1)fail('COMMAND_SEQUENCE_GAP');
  let code=null,acceptedInputNo=null;
  if(e.anchor.status==='finished'&&e.anchor.tick<=e.committedThroughTick)code='TERMINAL_COMMITTED';
  else if(command.executeTick<=e.committedThroughTick)code='INPUT_EXPIRED';
  else if(command.executeTick>serverTick+1)code='FUTURE_INPUT';
  else if(command.executeTick<=e.lastAcceptedExecuteTick)code='EXECUTION_ORDER';
  else if(!types.has(command.type))code='INVALID_ACTION';
  else {
   const admission=replay.read(command.executeTick-1);
   work.charge('admissions');
   try{engine.act(admission,e.playerKey,{type:command.type,observed_tick:command.executeTick-1},at(admission,command.executeTick-1));acceptedInputNo=own(admission,e.playerKey).inputNo;}
   catch(error){code=error.code??'ADMISSION_FAILED';}
   if(!code)replay.adopt(admission);
  }
  const decision={...copy(command),clockEpoch:e.clockEpoch,outcome:code?'rejected':'accepted',code,acceptedInputNo,decidedAtServerTick:serverTick,revision:oldRevision+1};
  e.lastCommandSeq=command.commandSeq;e.decisions.push(decision);changed=true;
  if(!code){
   e.commands.push({...copy(command),acceptedInputNo});e.lastAcceptedExecuteTick=command.executeTick;
   earliest=Math.min(earliest??command.executeTick,command.executeTick);
  }
  answers.push({...copy(decision),duplicate:false});
 }
 e.current=replay.read(Math.min(serverTick,MAX_TICK));
 if(changed)publish(e);
 const correction=earliest!==null&&earliest<=oldTick?{revision:e.revision,previousRevision:oldRevision,fromTick:earliest,toTick:e.current.tick,
  stateChanged:JSON.stringify(oldState)!==JSON.stringify(e.current),eventsRequireRevision:true}:null;
 return result(e,answers,correction,work);
}
