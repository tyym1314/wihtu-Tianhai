// Transport bookkeeping for the explicitly opted-in, free one-human BOT profile.
// No clocks, HTTP, physics admission, prediction lease or result authority live
// here. The caller supplies executeTick once and must enforce both its authority
// freshness and provisional-simulation budgets before enqueueing/sending.
export const RUN_PRACTICE_OUTBOX_PROTOCOL='run-practice-inputs-v1';
export const RUN_PRACTICE_OUTBOX_RULE_VERSION='pvp-run-v2.3.0';
export const RUN_PRACTICE_OUTBOX_LIMITS=Object.freeze({pendingCommands:32,batchCommands:8,inFlight:2,retainedBatches:32,attemptsPerBatch:8});
const L=RUN_PRACTICE_OUTBOX_LIMITS;
const types=new Set(['left','right','jump','slide','item']);
// Only durable business decisions consume a sequence. Structural batch errors
// (e.g. DECISION_CAPACITY, COMMAND_SEQUENCE_GAP) never belong in this set.
const denialCodes=new Set(['TERMINAL_COMMITTED','INPUT_EXPIRED','FUTURE_INPUT','EXECUTION_ORDER','INVALID_ACTION','NOT_ACTIVE','NOT_STARTED','STALE_INPUT','INPUT_PENDING','RATE_LIMIT','BUSY','CHANGING_LANE','TRACK_EDGE','ALREADY_JUMPING','SLIDING','AIRBORNE','NO_ITEM','WRONG_ITEM','BOOST_ACTIVE','ADMISSION_FAILED']);
const decisionKeys=['commandSeq','type','executeTick','clockEpoch','outcome','code','acceptedInputNo','decidedAtServerTick','revision','duplicate'];
const int=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const id=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const fail=reason=>Object.freeze({ok:false,reason});
const sameDecision=(a,b)=>decisionKeys.every(k=>k==='duplicate'||a[k]===b[k]);

function copyScope(s){
 if(!record(s)||s.protocol!==RUN_PRACTICE_OUTBOX_PROTOCOL||s.ruleVersion!==RUN_PRACTICE_OUTBOX_RULE_VERSION
  ||s.practice!==true||s.entryMinor!=='0'||!id(s.roomId)||!id(s.playerKey)||!int(s.clockEpoch,1)
  ||!Array.isArray(s.players)||s.players.length<2||s.players.length>4
  ||s.players.some(p=>!record(p)||!id(p.key)||typeof p.isBot!=='boolean')
  ||new Set(s.players.map(p=>p.key)).size!==s.players.length
  ||s.players.filter(p=>!p.isBot).length!==1||!s.players.some(p=>p.key===s.playerKey&&!p.isBot))throw new TypeError('INVALID_PRACTICE_SCOPE');
 return freeze({protocol:s.protocol,ruleVersion:s.ruleVersion,roomId:s.roomId,playerKey:s.playerKey,clockEpoch:s.clockEpoch,
  practice:true,entryMinor:'0',players:s.players.map(p=>({key:p.key,isBot:p.isBot}))});
}

/** One instance belongs to one immutable room/player/epoch. `initial` must come
 * from a trusted authority baseline, never the old wireSeq/action receipt.
 * `clear` permanently closes this instance; create a new one after exit/scope
 * changes. Tokens are object capabilities and cannot survive serialization.
 * Completed handles are held only by a WeakMap, not an ever-growing history.
 * Callers should release a failed transport then retry the same token, or retire
 * it explicitly. Retiring drops that token's ACK authority, never its commands.
 *
 * beginBatch/retry return the same immutable handle for an exact retry:
 * {ok,token,requestId,payload}. Send requestId as HTTP request_id and payload as
 * the core command batch. resolve expects {request_id,run_inputs:{scope fields,
 * revision,processedThroughCommandSeq,decisions}}. All decisions in THAT batch
 * must be present in order. GET histories are deliberately not an ACK API.
 */
export function createRunPracticeInputOutbox({scope,makeRequestId,initial={lastCommandSeq:0,acceptedInputNo:0,revision:0}}={}){
 const bound=copyScope(scope);
 if(typeof makeRequestId!=='function')throw new TypeError('REQUEST_ID_FACTORY_REQUIRED');
 if(!exact(initial,['lastCommandSeq','acceptedInputNo','revision'])||!int(initial.lastCommandSeq)
  ||!int(initial.acceptedInputNo,0,initial.lastCommandSeq)||!int(initial.revision))throw new TypeError('INVALID_INITIAL_SEQUENCE');
 const baseline={...initial},pending=new Map(),decisions=new Map(),retained=new Map();
 let batches=new WeakMap();
 let lastCommandSeq=baseline.lastCommandSeq,acceptedInputNo=baseline.acceptedInputNo,processedThrough=baseline.lastCommandSeq;
 let revision=baseline.revision,lastDecisionRevision=baseline.revision,lastDecisionTick=0,inFlight=0,dispatchAttempts=0,batchCount=0,suspended=false,closed=false;

 function pruneDecisions(){
  const needed=new Set([...retained.values()].flatMap(b=>b.handle.payload.commands.map(c=>c.commandSeq)));
  for(const seq of decisions.keys())if(!needed.has(seq))decisions.delete(seq);
 }

 function sendingGuard(){
  if(closed)return 'CLOSED';
  if(suspended)return 'SUSPENDED';
  if(inFlight>=L.inFlight)return 'IN_FLIGHT_LIMIT';
  if(dispatchAttempts===Number.MAX_SAFE_INTEGER)return 'COUNTER_EXHAUSTED';
  return null;
 }
 function enqueue(command){
  if(closed)return fail('CLOSED');
  if(suspended)return fail('SUSPENDED');
  if(!exact(command,['type','executeTick'])||!types.has(command.type)||!int(command.executeTick,1,6001))return fail('INVALID_COMMAND');
  if(lastCommandSeq===Number.MAX_SAFE_INTEGER)return fail('SEQUENCE_EXHAUSTED');
  if(pending.size>=L.pendingCommands)return fail('PENDING_LIMIT');
  const owned=Object.freeze({commandSeq:++lastCommandSeq,type:command.type,executeTick:command.executeTick});
  pending.set(owned.commandSeq,owned);return Object.freeze({ok:true,command:owned});
 }
 function beginBatch({baseRevision}={}){
  const error=sendingGuard();if(error)return fail(error);
  if(!int(baseRevision,baseline.revision))return fail('INVALID_BASE_REVISION');
  if(!pending.size)return fail('EMPTY');
  if(retained.size>=L.retainedBatches)return fail('BATCH_LIMIT');
  if(batchCount===Number.MAX_SAFE_INTEGER)return fail('COUNTER_EXHAUSTED');
  let prefix;try{prefix=makeRequestId();}catch{return fail('REQUEST_ID_FAILED');}
  if(!id(prefix)||prefix.length>96)return fail('INVALID_REQUEST_ID');
  // The ordinal prevents a broken injected RNG from reusing an ID in this
  // instance, without retaining every historical ID forever.
  const requestId=`${prefix}-${(batchCount+1).toString(36)}`;
  if(requestId.length<8)return fail('INVALID_REQUEST_ID');
  const commands=[...pending.values()].slice(0,L.batchCommands);
  const token=Object.freeze({});
  const payload=freeze({roomId:bound.roomId,playerKey:bound.playerKey,clockEpoch:bound.clockEpoch,baseRevision,commands});
  const handle=Object.freeze({ok:true,token,requestId,payload});
  const batch={handle,status:'in-flight',attempts:1,settledDecisions:null};
  batches.set(token,batch);retained.set(token,batch);
  batchCount++;dispatchAttempts++;inFlight++;return handle;
 }
 function release({token}={}){
  const batch=batches.get(token);
  if(closed||!batch||batch.status!=='in-flight')return fail(closed?'CLOSED':'NOT_IN_FLIGHT');
  batch.status='unresolved';inFlight--;return Object.freeze({ok:true});
 }
 function retire({token}={}){
  const batch=batches.get(token);
  if(closed||!batch||batch.status!=='unresolved')return fail(closed?'CLOSED':'NOT_RETIRABLE');
  batch.status='retired';retained.delete(token);pruneDecisions();return Object.freeze({ok:true});
 }
 function retry({token}={}){
  const error=sendingGuard();if(error)return fail(error);
  const batch=batches.get(token);
  if(!batch||batch.status!=='unresolved')return fail('NOT_RETRYABLE');
  if(batch.attempts>=L.attemptsPerBatch)return fail('RETRY_LIMIT');
  batch.status='in-flight';batch.attempts++;dispatchAttempts++;inFlight++;return batch.handle;
 }
 function validateReceipt(batch,receipt){
  const r=receipt?.run_inputs,commands=batch.handle.payload.commands;
  if(!record(receipt)||receipt.request_id!==batch.handle.requestId||!record(r)
   ||['protocol','ruleVersion','roomId','playerKey','clockEpoch'].some(k=>r[k]!==bound[k])
   ||!int(r.revision,batch.handle.payload.baseRevision)
   ||!int(r.processedThroughCommandSeq,commands.at(-1).commandSeq,lastCommandSeq)
   ||!Array.isArray(r.decisions)||r.decisions.length!==commands.length)return null;
  const owned=[],newDecisions=[];
  for(let i=0;i<commands.length;i++){
   const d=r.decisions[i],c=commands[i];
   if(!exact(d,decisionKeys)||d.commandSeq!==c.commandSeq||d.type!==c.type||d.executeTick!==c.executeTick
    ||d.clockEpoch!==bound.clockEpoch||!int(d.decidedAtServerTick,0,6120)||!int(d.revision,1,r.revision)
    ||typeof d.duplicate!=='boolean')return null;
   if(d.outcome==='accepted'){
    if(d.code!==null||!int(d.acceptedInputNo,1)||d.executeTick>d.decidedAtServerTick+1)return null;
   }else if(d.outcome!=='rejected'||!denialCodes.has(d.code)||d.acceptedInputNo!==null)return null;
   const value=Object.freeze(Object.fromEntries(decisionKeys.map(k=>[k,d[k]])));
   const prior=batch.settledDecisions?.[i]??decisions.get(d.commandSeq);
   if(d.commandSeq<=processedThrough){if(!prior||!sameDecision(prior,value))return null;}
   else {if(!pending.has(d.commandSeq))return null;newDecisions.push(value);}
   owned.push(value);
  }
  // No holes or invented successful input numbers: rejected commands consume
  // commandSeq but do not advance the independent engine acceptedInputNo.
  let next=processedThrough+1,inputNo=acceptedInputNo,lastRevision=lastDecisionRevision,lastTick=lastDecisionTick;
  for(const d of newDecisions){
   if(d.commandSeq!==next++||d.revision<lastRevision||d.decidedAtServerTick<lastTick)return null;
   if(d.outcome==='accepted'&&d.acceptedInputNo!==++inputNo)return null;
   lastRevision=d.revision;lastTick=d.decidedAtServerTick;
  }
  return {owned,newDecisions,inputNo,through:newDecisions.length?next-1:processedThrough,revision:r.revision,lastRevision,lastTick};
 }
 function resolve({token,receipt}={}){
  if(closed)return fail('CLOSED');
  const batch=batches.get(token);if(!batch)return fail('UNKNOWN_TOKEN');
  if(batch.status==='retired')return fail('RETIRED_TOKEN');
  let validated;try{validated=validateReceipt(batch,receipt);}catch{return fail('INVALID_RECEIPT');}
  // An invalid/partial response does not implicitly release a send slot. The
  // transport owner may explicitly release it after handling the failure.
  if(!validated)return fail('INVALID_RECEIPT');
  const newlyAcknowledged=[];
  for(const d of validated.newDecisions){decisions.set(d.commandSeq,d);pending.delete(d.commandSeq);newlyAcknowledged.push(d);}
  if(batch.status==='in-flight')inFlight--;
  batch.status='resolved';batch.settledDecisions=validated.owned;retained.delete(token);pruneDecisions();
  acceptedInputNo=validated.inputNo;processedThrough=validated.through;revision=Math.max(revision,validated.revision);
  lastDecisionRevision=validated.lastRevision;lastDecisionTick=validated.lastTick;
  return freeze({ok:true,newlyAcknowledged,processedThroughCommandSeq:processedThrough,acceptedInputNo,revision});
 }
 function suspend(){if(closed)return fail('CLOSED');suspended=true;return Object.freeze({ok:true});}
 function resume(){if(closed)return fail('CLOSED');suspended=false;return Object.freeze({ok:true});}
 function clear(){closed=true;suspended=true;inFlight=0;pending.clear();decisions.clear();retained.clear();batches=new WeakMap();return Object.freeze({ok:true});}
 function state(){return freeze({scope:bound,closed,suspended,lastCommandSeq,processedThroughCommandSeq:processedThrough,acceptedInputNo,revision,
  pendingCommands:[...pending.values()],inFlight,retainedBatches:retained.size,retainedDecisions:decisions.size,batchCount,dispatchAttempts});}
 return Object.freeze({enqueue,beginBatch,release,retry,retire,resolve,suspend,resume,clear,state});
}
