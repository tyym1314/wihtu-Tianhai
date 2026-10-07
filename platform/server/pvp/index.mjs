import {randomBytes,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pool as sharedPool,locked,tryLocked} from '../db.mjs';
import {id,hash,seal,unseal,fail} from '../security.mjs';
import {validate} from '../platform.mjs';
import {walletRequest} from '../wallet-binding.mjs';
import {engines} from './engines.mjs';
import {supportsRules} from './rule-support.mjs';
import {runEngineTask} from './engine-pool.mjs';
import {bowlingPreparations} from './bowling-preparation.mjs';
import {assertProductionAppReady} from '../runtime-mode.mjs';
import {ARENA_GAMES,allowedCapacity,teamSizeFor} from '../../shared/games.mjs';
import {getTrainingLesson} from '../../arena/towerlink/training.mjs';
import {RULE_VERSION as RUN_FAIR_RULE_VERSION,RUN_SCENE_READY_POLICY} from '../../arena/run/engine.mjs';
import {newTowerPracticeStartOptions,roomStartDelayMs} from './tower-start-policy.mjs';
const terminal=new Set(['settled','voided','cancelled']);
const RUN_SCENE_READY_PRESENCE_MS=2000;
function runSceneReadyFresh(p,now,heartbeatKey){
 const seenAt=p.external_user_id===heartbeatKey?now:Number(p.last_seen_at),presenceAge=now-seenAt,frameAge=now-Number(p.scene_ready_at);
 return p.scene_ready_at!=null&&presenceAge>=0&&presenceAge<=RUN_SCENE_READY_PRESENCE_MS&&frameAge>=0&&frameAge<=RUN_SCENE_READY_PRESENCE_MS;
}
// Free Tower Link invitation rooms contain real players, unlike BOT practice.
// Both have no wallet lifecycle; keep the distinction in the persisted roster.
const walletless=r=>r.practice||(r.game_id==='towerlink'&&r.entry_minor==='0');
let pool=sharedPool;
export async function migratePvp(db=sharedPool){pool=db;await pool.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));}
const scopeOf=a=>({partner_id:a.partner_id,app_id:a.id,environment:a.environment,wallet_scope_id:a.wallet_scope_id,currency_id:a.currency_id});
const appById=async appId=>(await pool.query('SELECT * FROM gp_apps WHERE id=$1',[appId])).rows[0];
// Bowling's authoritative state, action audit and idempotent response keep
// the full accepted trajectory. Only this redundant room-member copy shrinks;
// existing stored events stay untouched until that member accepts a new event.
function memberEvent(gameId,event){
 if(gameId!=='bowling'||event?.type!=='roll')return event||null;
 const{trajectory,events,...metadata}=event;return metadata;
}
const getRoom=async roomId=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[roomId])).rows[0];
const ms=value=>value===null?null:Number(value);
function hydrate(r){if(!r)return r;for(const k of ['starts_at','end_at','last_tick_at','fault_at','ready_deadline_at','expires_at','version'])r[k]=ms(r[k]);return r;}
async function mergePresence(r){
 const rows=(await pool.query('SELECT external_user_id,last_seen_at FROM pvp_presence WHERE room_id=$1',[r.id])).rows;
 for(const row of rows){const p=r.players.find(p=>p.external_user_id===row.external_user_id);if(p)p.last_seen_at=Math.max(p.last_seen_at,Number(row.last_seen_at));}
}
async function touchPresence(r,s,now){
 // Preserve the old advance-before-heartbeat disconnect boundary. A late poll
 // cannot revive a player whose 30-second lease expired while the server was
 // ticking normally; a shared server pause retains the existing recovery grace.
 await pool.query(`INSERT INTO pvp_presence(room_id,external_user_id,last_seen_at)
  SELECT r.id,$2,$3 FROM pvp_rooms r CROSS JOIN LATERAL jsonb_array_elements(r.players) p
  LEFT JOIN pvp_presence live ON live.room_id=r.id AND live.external_user_id=$2
  WHERE r.id=$1 AND p->>'external_user_id'=$2
   AND (r.status<>'active' OR $3-r.last_tick_at>5000
    OR $3<=GREATEST((p->>'last_seen_at')::bigint,COALESCE(live.last_seen_at,0))+30000)
  ON CONFLICT(room_id,external_user_id) DO UPDATE SET last_seen_at=GREATEST(pvp_presence.last_seen_at,EXCLUDED.last_seen_at)`,[r.id,s.external_user_id,now]);
}
// Sample only after the room lock/read: a queued request must not rewind a
// newer engine snapshot. Explicit test clocks retain their original semantics.
const roomNow=(r,explicitNow)=>explicitNow??Math.max(Date.now(),r?.last_tick_at??0);
async function transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function save(r,c=pool){r.version++;await c.query('UPDATE pvp_rooms SET status=$2,players=$3,game_state=$4,captured=$5,result=$6,result_hash=$7,starts_at=$8,end_at=$9,last_tick_at=$10,fault_at=$11,error=$12,ready_deadline_at=$13,version=$14,updated_at=now() WHERE id=$1',[r.id,r.status,JSON.stringify(r.players),r.game_state,r.captured,r.result,r.result_hash,r.starts_at,r.end_at,r.last_tick_at,r.fault_at,r.error,r.ready_deadline_at,r.version]);if(terminal.has(r.status))await c.query('DELETE FROM pvp_active_users WHERE room_id=$1',[r.id]);}
function checkSession(s){if(!s||!engines[s.game_id]||typeof s.external_user_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(s.external_user_id)||['__proto__','constructor','prototype'].includes(s.external_user_id))fail(403,'GAME_SESSION_REQUIRED');}
function checkNew(app,game){if(!app||app.status!=='active')fail(409,'APP_PAUSED');if(!app.game_ids.includes(game))fail(403,'GAME_NOT_ENABLED');}
function exactRecords(actual,expected){return Array.isArray(actual)&&actual.length===expected.length&&new Set(actual.map(p=>p.external_user_id)).size===actual.length&&new Set(actual.map(p=>p.seat_index)).size===actual.length&&expected.every(p=>actual.some(v=>Object.keys(v).length===Object.keys(p).length&&Object.keys(p).every(k=>v[k]===p[k])));}
function roster(r){return r.players.map(p=>({external_user_id:p.external_user_id,seat_index:p.seat_index,reservation_id:`res_${r.id}_${p.seat_index}`,entry_minor:r.entry_minor,...(r.terms.team_size===2?{team_id:p.team_id}:{})}));}
function personal(r,s,now=Date.now()){
 const rankings=r.result?.rankings||(r.game_state&&supportsRules(engines[r.game_id],r.rule_version)?engines[r.game_id].rank(r.game_state):[]),byKey=new Map(rankings.map(p=>[p.playerKey,p]));
 const mine=r.players.find(p=>p.external_user_id===s.external_user_id);
 const total=BigInt(r.entry_minor)*BigInt(r.capacity),fee=total*BigInt(r.fee_bps)/10000n;
 const view={id:r.id,code:r.code,game_id:r.game_id,status:r.status,capacity:r.capacity,practice:r.practice,team_size:r.terms.team_size,seed_commitment:hash(unseal(r.seed_enc)),me:s.external_user_id,me_last_seq:mine?.last_seq||0,entry_minor:r.entry_minor,fee_bps:r.fee_bps,pool_minor:total.toString(),prize_minor:(total-fee).toString(),server_now:now,starts_at:r.starts_at,end_at:r.end_at,ready_deadline_at:r.ready_deadline_at,result:r.result,error:r.error,version:r.version,
 players:r.players.map(p=>{const rank=byKey.get(p.external_user_id),result=r.result?.payouts.find(v=>v.external_user_id===p.external_user_id);return{external_user_id:p.external_user_id,name:p.name,seat_index:p.seat_index,team_id:p.team_id||null,ready:p.ready,...(r.game_id==='run'&&r.rule_version===RUN_FAIR_RULE_VERSION?{scene_ready:r.game_state?.phase==='arming'?runSceneReadyFresh(p,now):!!p.scene_ready_at}:{}),connected:p.bot||now-p.last_seen_at<=30000,bot:p.bot,forfeited:rank?.forfeited||p.forfeited||false,score:rank?.score||0,rank:rank?.forfeited?null:rank?.rank??null,payout_minor:result?.payout_minor||'0'};}),
 game:mine&&r.game_state&&supportsRules(engines[r.game_id],r.rule_version)?engines[r.game_id].view(r.game_state,s.external_user_id,{roomId:r.id}):null};
 if(r.game_id==='towerlink'){view.room_mode=r.practice?'practice':walletless(r)?'social':'competitive';view.training_lesson_id=r.game_options?.training_lesson_id||null;}
 if(r.game_id==='run'&&r.rule_version===RUN_FAIR_RULE_VERSION){const humans=r.players.filter(p=>!p.bot);view.start_protocol={kind:RUN_SCENE_READY_POLICY,phase:r.game_state?.phase||null,ready_count:humans.filter(p=>r.game_state?.phase==='arming'?runSceneReadyFresh(p,now):!!p.scene_ready_at).length,human_count:humans.length,ready_deadline_at:r.game_state?.armingDeadlineAt??null,starts_at:r.starts_at};}
 if(view.game&&mine.last_event&&['match','golf'].includes(r.game_id))view.game.lastEvent=mine.last_event;return view;
}
async function command(app,r,path,body){
 const raw=JSON.stringify(body);await pool.query('INSERT INTO pvp_operations(id,app_id,room_id,path,raw_body) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[body.request_id,app.id,r.id,path,raw]);
 const op=(await pool.query('SELECT * FROM pvp_operations WHERE id=$1',[body.request_id])).rows[0];if(op.app_id!==app.id||op.room_id!==r.id||op.path!==path)fail(409,'IDEMPOTENCY_CONFLICT');
 if(op.state==='SUCCEEDED')return op.response;
 if(op.state==='REJECTED'){const e=new Error(op.response.rejection.code);e.code=op.response.rejection.code;e.walletRejected=true;throw e;}
 if(op.attempts>0&&Date.parse(op.next_attempt_at)>Date.now())fail(503,'WALLET_PENDING');
 let response;try{
  if(op.attempts>0){try{response=await walletRequest(app,'GET','/wallet/v1/operations/'+op.id);}catch(e){if(e.status!==404)throw e;}}
  if(!response||response.state==='PENDING')response=await walletRequest(app,'POST',op.path,op.raw_body,op.id);
  try{validate('Operation',response);}catch{fail(503,'WALLET_INVALID_RESPONSE');}
  if(response.operation_id!==op.id||response.body_sha256!==hash(op.raw_body))fail(503,'WALLET_INVALID_RESPONSE');
  for(const[k,v]of Object.entries(r.scope))if(response[k]!==v)fail(503,'WALLET_INVALID_SCOPE');
  if(response.state==='SUCCEEDED'){
   const b=JSON.parse(op.raw_body),receipt=response.receipt,resource=receipt?.resource,kind=path.split('/').pop();
   if(!resource||receipt.resource_type!==(kind==='reservations'?'reservation':'match'))fail(503,'WALLET_INVALID_RECEIPT');
   for(const[k,v]of Object.entries(r.scope))if(resource[k]!==v)fail(503,'WALLET_INVALID_SCOPE');
   if(kind==='capture'&&resource.captured_minor!==(BigInt(r.entry_minor)*BigInt(r.capacity)).toString())fail(503,'WALLET_INVALID_RECEIPT');
   for(const k of ['match_id','reservation_id','external_user_id','seat_index','amount_minor','result_hash','fee_minor'])if(b[k]!==undefined&&resource[k]!==b[k])fail(503,'WALLET_INVALID_RECEIPT');
   const state={reservations:'RESERVED',capture:'CAPTURED',release:'CANCELLED',settle:b.resolution==='void'?'VOIDED':'SETTLED'}[kind];if(resource.state!==state)fail(503,'WALLET_INVALID_RECEIPT');
   if(b.terms&&JSON.stringify(resource.terms)!==JSON.stringify(b.terms)&&Object.keys(b.terms).some(k=>resource.terms?.[k]!==b.terms[k]))fail(503,'WALLET_INVALID_RECEIPT');
   if(['capture','settle'].includes(kind)){
    if(!exactRecords(resource.participants,roster(r)))fail(503,'WALLET_INVALID_RECEIPT');
    if(!resource.terms||Object.keys(r.terms).some(k=>resource.terms[k]!==r.terms[k]))fail(503,'WALLET_INVALID_RECEIPT');
    if(resource.captured_minor!==(BigInt(r.entry_minor)*BigInt(r.capacity)).toString())fail(503,'WALLET_INVALID_RECEIPT');
    if(resource.capture_operation_id!==`capture_${r.id}`)fail(503,'WALLET_INVALID_RECEIPT');
   }
   if(kind==='settle'&&(!exactRecords(resource.payouts,b.payouts)||resource.settlement_operation_id!==op.id))fail(503,'WALLET_INVALID_RECEIPT');
  }
  await pool.query('UPDATE pvp_operations SET state=$2,response=$3,attempts=attempts+1,error=NULL,updated_at=now() WHERE id=$1',[op.id,response.state,response]);
 }catch(e){await pool.query("UPDATE pvp_operations SET attempts=attempts+1,error=$2,next_attempt_at=now()+interval '1 second',updated_at=now() WHERE id=$1",[op.id,{code:e.code||'WALLET_UNKNOWN'}]);throw e;}
 if(response.state==='REJECTED'){const e=new Error(response.rejection.code);e.code=response.rejection.code;e.walletRejected=true;throw e;}
 if(response.state!=='SUCCEEDED')fail(503,'WALLET_PENDING');return response;
}
function fixResult(r,now,resolution='completed',reason){
 if(r.result)return;const ranking=r.game_state&&supportsRules(engines[r.game_id],r.rule_version)?engines[r.game_id].rank(r.game_state):[];
 const eligible=ranking.filter(p=>!p.forfeited&&p.rank!==null);if(resolution==='completed'&&!eligible.length){resolution='void';reason='all_players_forfeited';}
 // The wallet's completed settlement applies its frozen fee. A genuine Tower
 // Link 1v1 draw uses the existing full-return path with an explicit draw reason.
 if(resolution==='completed'&&r.game_id==='towerlink'&&!walletless(r)&&r.capacity===2&&eligible.length===2&&eligible[0].rank===eligible[1].rank){resolution='void';reason='tied_game';}
 const total=BigInt(r.entry_minor)*BigInt(r.players.length),fee=resolution==='void'?0n:total*BigInt(r.fee_bps)/10000n,prize=total-fee;
 const best=eligible.length?Math.min(...eligible.map(p=>p.rank)):null,winners=eligible.filter(p=>p.rank===best).map(p=>p.playerKey);
 const ordered=r.players.filter(p=>winners.includes(p.external_user_id)).sort((a,b)=>a.seat_index-b.seat_index);const count=BigInt(ordered.length||1);
 const payouts=r.players.map(p=>{const rank=ranking.find(v=>v.playerKey===p.external_user_id),index=ordered.findIndex(v=>v.external_user_id===p.external_user_id);return{external_user_id:p.external_user_id,seat_index:p.seat_index,...(resolution==='completed'?{rank:rank?.forfeited?r.capacity:rank?.rank||r.capacity}:{}),payout_minor:(resolution==='void'?BigInt(r.entry_minor):index<0?0n:prize/count+(BigInt(index)<prize%count?1n:0n)).toString()};});
 r.result={resolution,reason:reason||null,rankings:ranking,payouts,fee_minor:fee.toString(),pool_minor:total.toString(),fixed_at:now,rule_version:r.rule_version};r.result_hash=hash(JSON.stringify(r.result));r.result.result_hash=r.result_hash;r.status=walletless(r)?(resolution==='void'?'voided':'settled'):(resolution==='void'?'voiding':'settling');r.end_at=now;r.error=null;
}
function startGame(r,now){const fairRun=r.game_id==='run'&&r.rule_version===RUN_FAIR_RULE_VERSION,startAt=now+roomStartDelayMs(r);r.game_state=engines[r.game_id].createState(unseal(r.seed_enc),now,{ruleVersion:r.rule_version,players:r.players.map(p=>({key:p.external_user_id,seatIndex:p.seat_index,name:p.name,isBot:p.bot,teamId:p.team_id})),...(fairRun?{startPolicy:RUN_SCENE_READY_POLICY}:{}),...(r.game_id==='towerlink'?{startAt,...(r.game_options?.training_lesson_id?{trainingLessonId:r.game_options.training_lesson_id}:{})}:{})});r.status='active';r.starts_at=fairRun?null:startAt;r.end_at=fairRun?r.game_state.armingDeadlineAt:r.game_id==='towerlink'?r.game_state.deadlineAt:startAt+ARENA_GAMES[r.game_id].duration;r.last_tick_at=now;for(const p of r.players)p.last_seen_at=now;r.error=null;}
function allRunHumansPresent(r,now,heartbeatKey){
 return r.players.filter(p=>!p.bot).every(p=>runSceneReadyFresh(p,now,heartbeatKey));
}
function armRun(r,now){engines.run.armStart(r.game_state,now);r.starts_at=r.game_state.startedAt;r.end_at=r.game_state.deadlineAt;}
async function advance(r,now,{skipGap=false,forfeitKeys=[],heartbeat,ignorePresence=false}={}){
 const persist=async()=>{if(heartbeat){const p=r.players.find(p=>p.external_user_id===heartbeat.key);if(p)p.last_seen_at=now;heartbeat.written=true;}await save(r);};
 if(terminal.has(r.status))return r;if(r.status==='active'&&r.game_state&&(!supportsRules(engines[r.game_id],r.rule_version)||r.game_state.ruleVersion!==r.rule_version)){r.status='fault';r.fault_at??=now;r.error={code:'PINNED_RULE_UNAVAILABLE'};await persist();}let app;const walletApp=async()=>app??=await appById(r.app_id);const base={...r.scope,match_id:r.id};
 try{
  // A lobby can start only its explicitly supported pinned rules. Unsupported
  // terms must release, including after an uncertain capture response.
  if(['waiting','funding'].includes(r.status)&&!supportsRules(engines[r.game_id],r.rule_version)){r.status=walletless(r)?'cancelled':'cancelling';r.error={code:'PINNED_RULE_UNAVAILABLE'};await persist();}
  if(r.status==='waiting'&&(now>=r.expires_at||(r.ready_deadline_at&&now>=r.ready_deadline_at))){r.status=walletless(r)?'cancelled':'cancelling';r.error={code:'READY_TIMEOUT'};await persist();}
  if(r.status==='funding'){
   if(walletless(r)){startGame(r,now);await persist();}else{
    for(const p of r.players)await command(await walletApp(),r,'/wallet/v1/reservations',{...base,request_id:`reserve_${r.id}_${p.seat_index}`,reservation_id:`res_${r.id}_${p.seat_index}`,external_user_id:p.external_user_id,seat_index:p.seat_index,amount_minor:r.entry_minor,terms:r.terms,expires_at:new Date(Date.now()+60000).toISOString()});
    await command(await walletApp(),r,'/wallet/v1/matches/capture',{...base,request_id:`capture_${r.id}`,terms:r.terms,participants:roster(r)});
    r.captured=true;startGame(r,now);await persist();
   }
  }
  if(r.status==='cancelling'){
   try{if(!walletless(r))await command(await walletApp(),r,'/wallet/v1/matches/release',{...base,request_id:`release_${r.id}`,reason:'lobby_cancelled'});r.status='cancelled';await persist();}
   catch(e){if(e.walletRejected&&e.code==='ALREADY_CAPTURED'){r.captured=true;fixResult(r,now,'void','cancel_after_capture');await persist();}else throw e;}
  }
  if(r.status==='active'){
   // Presence is read while owning the room lock. A snapshot poll can never
   // replace a newer action, and a later stale heartbeat cannot rewind liveness.
   if(!ignorePresence)await mergePresence(r);
   const fairRun=r.game_id==='run'&&r.rule_version===RUN_FAIR_RULE_VERSION;
   const armingRun=fairRun&&r.game_state.phase==='arming';
   // Scene preparation has an absolute 15-second deadline. A missing room tick
   // is not proof of a platform outage, so it must never extend this deadline.
   if(!skipGap&&!armingRun&&now-r.last_tick_at>5000){const gap=now-r.last_tick_at;if(gap>60000){fixResult(r,now,'void','platform_outage_over_60s');await persist();}else{r.game_state=engines[r.game_id].shiftTime(r.game_state,gap);r.end_at+=gap;if(r.game_id==='towerlink'||fairRun&&r.starts_at!==null)r.starts_at+=gap;for(const p of r.players)p.last_seen_at+=gap;r.error={code:'RECOVERED_SHARED_PAUSE',duration_ms:gap};}}
   if(r.status==='active'){
    if(armingRun||fairRun&&r.game_state.phase==='countdown'&&now<r.game_state.startedAt&&forfeitKeys.length){
     if(forfeitKeys.length)fixResult(r,now,'void','scene_ready_aborted');
     else if(now>=r.game_state.armingDeadlineAt)fixResult(r,now,'void','scene_ready_timeout');
     else if(armingRun&&allRunHumansPresent(r,now,heartbeat?.key)){armRun(r,now);r.last_tick_at=now;}
     else r.last_tick_at=now;
     await persist();
    }else{
    const absent=r.players.filter(p=>!p.bot&&!p.forfeited&&now-p.last_seen_at>30000).map(p=>p.external_user_id);
    const result=await runEngineTask({kind:'advance',gameId:r.game_id,ruleVersion:r.rule_version,state:r.game_state,now,forfeits:[...new Set([...absent,...forfeitKeys])],bots:r.players.filter(p=>p.bot&&r.practice).map(p=>({key:p.external_user_id,lastBotAt:p.last_bot_at||0}))});
    const state=result.state;for(const update of result.botUpdates){const p=r.players.find(p=>p.external_user_id===update.key);p.last_event=memberEvent(r.game_id,update.lastEvent);p.last_bot_at=update.lastBotAt;}
    r.game_state=state;r.last_tick_at=now;
    if(state.phase==='fault'||state.fault){r.status='fault';r.fault_at=now;r.error=state.fault||{code:'SHARED_GAME_FAULT'};}
    else if(state.status==='finished')fixResult(r,now,state.outcome==='void'||state.finishReason==='all-forfeited'?'void':'completed');
    await persist();
    }
   }
  }
  if(r.status==='fault'&&now-r.fault_at>=60000){fixResult(r,now,'void','shared_fault_unrecoverable');await persist();}
  if(['settling','voiding'].includes(r.status)){
   const b={...base,request_id:`settle_${r.id}`,resolution:r.result.resolution,result_hash:r.result_hash,payouts:r.result.payouts,fee_minor:r.result.fee_minor};if(b.resolution==='void')b.reason=r.result.reason||'shared_fault';
   await command(await walletApp(),r,'/wallet/v1/matches/settle',b);r.status=b.resolution==='void'?'voided':'settled';r.error=null;await persist();
  }
 }catch(e){
  // Queue pressure or worker loss is a retryable infrastructure outcome, not a
  // game fault/forfeit. Do not persist a partially computed state or refund it.
  if(e.engineUnavailable)throw e;
  r.error={code:e.code||'RECOVERY_PENDING'};
  if(r.status==='funding'&&(e.walletRejected||r.captured))r.status='cancelling';
  else if(r.status==='active'){r.status='fault';r.fault_at=now;}
  await persist();
 }
 return r;
}
const working=new Set();
export async function tickPvp({now,roomIds,skipGap=false}={}){
 const rows=(await pool.query("SELECT id FROM pvp_rooms WHERE status NOT IN ('settled','voided','cancelled') AND ($1::text[] IS NULL OR id=ANY($1)) ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,updated_at LIMIT 200",[roomIds||null])).rows;
 await Promise.all(rows.map(async({id:roomId})=>{if(working.has(roomId))return;working.add(roomId);try{await(roomIds||now!==undefined?locked:tryLocked)('pvp:'+roomId,async()=>{const r=hydrate(await getRoom(roomId));if(r){const at=roomNow(r,now);if(!roomIds&&now===undefined&&r.status==='active'&&at-r.last_tick_at<200)return;await advance(r,at,{skipGap,ignorePresence:now!==undefined});}});}finally{working.delete(roomId);}}));
}
async function findRoom(s,key,identityOnly=false){const fields=identityOnly?'id':'*',r=(await pool.query(`SELECT ${fields} FROM pvp_rooms WHERE app_id=$1 AND game_id=$2 AND (id=$3 OR code=$3)`,[s.app_id,s.game_id,key])).rows[0];if(!r)fail(404,'ROOM_NOT_FOUND');return identityOnly?r:hydrate(r);}
function requestDigest(method,path,body){return hash(JSON.stringify([method,path,body]));}
async function replay(c,s,body,digest){const old=(await c.query('SELECT * FROM pvp_requests WHERE app_id=$1 AND external_user_id=$2 AND request_id=$3',[s.app_id,s.external_user_id,body.request_id])).rows[0];if(old&&old.digest!==digest)fail(409,'IDEMPOTENCY_CONFLICT');return old?{status:old.response_status,body:old.response}:null;}
async function remember(c,s,body,digest,r,response){await c.query('INSERT INTO pvp_requests(app_id,external_user_id,request_id,digest,room_id,response,response_status) VALUES($1,$2,$3,$4,$5,$6,$7)',[s.app_id,s.external_user_id,body.request_id,digest,r.id,response.body,response.status]);return response;}
function player(s,index,now,bot=false){return{external_user_id:s.external_user_id,name:bot?`BOT ${index}`:s.external_user_id,seat_index:index,ready:bot,bot,last_seq:0,last_seen_at:now,forfeited:false};}
export async function routePvp(session,method,path,body={},options={}){
 if(!path.startsWith('/api/pvp/rooms'))return null;checkSession(session);const s=session,app=method==='POST'?await appById(s.app_id):undefined;
 if(method==='POST'&&!/^[A-Za-z0-9_-]{8,128}$/.test(body.request_id||''))fail(400,'REQUEST_ID_REQUIRED');
 const digest=requestDigest(method,path,body);
 if(method==='POST'&&path==='/api/pvp/rooms'){
  if(body.game_id!==s.game_id||!allowedCapacity(s.game_id,body.capacity)||typeof body.practice!=='undefined'&&typeof body.practice!=='boolean')fail(400,'INVALID_ROOM');
  const practice=body.practice===true,entry=practice?'0':body.entry_minor,social=s.game_id==='towerlink'&&!practice&&entry==='0';if(!practice&&!social&&!['1000','5000','10000','20000','50000'].includes(entry))fail(400,'INVALID_ENTRY');
  if(s.game_id==='towerlink'&&!practice&&!social&&body.capacity!==2)fail(400,'TOWERLINK_PAID_1V1_ONLY');
  const gameOptions={};
  if(body.training_lesson_id!==undefined){
   if(s.game_id!=='towerlink'||!practice||(body.entry_minor!==undefined&&body.entry_minor!=='0'))fail(400,'INVALID_TRAINING_MODE');
   const lesson=getTrainingLesson(body.training_lesson_id);if(!lesson||lesson.playerCount!==body.capacity)fail(400,'INVALID_TRAINING_LESSON');
   gameOptions.training_lesson_id=lesson.id;
  }
  const roomId=body.room_id||id('pvp');if(!/^[A-Za-z0-9_-]{8,64}$/.test(roomId))fail(400,'INVALID_ROOM_ID');
  return transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`pvpcreate:${s.app_id}:${s.external_user_id}`]);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`pvpreq:${s.app_id}:${s.external_user_id}:${body.request_id}`]);const repeated=await replay(c,s,body,digest);if(repeated)return repeated;checkNew(app,s.game_id);
   await assertProductionAppReady(c,app);
   if((await c.query('SELECT 1 FROM pvp_active_users WHERE app_id=$1 AND external_user_id=$2',[s.app_id,s.external_user_id])).rowCount)fail(409,'ALREADY_IN_ROOM');
   const now=roomNow(null,options.now),fee=practice||social?0:Number(app.competitive_fee_bps??500);if(!practice&&!social&&![300,500,800,1000].includes(fee))fail(409,'INVALID_APP_FEE');
   const players=[player(s,0,now)];if(practice)for(let i=1;i<body.capacity;i++)players.push(player({external_user_id:`bot_${i}_${randomBytes(12).toString('hex')}`},i,now,true));
   const teamSize=teamSizeFor(s.game_id,body.capacity);if(teamSize===2)players.forEach((p,i)=>p.team_id=i%2?'team_b':'team_a');
   const terms={game_id:s.game_id,rule_version:engines[s.game_id].RULE_VERSION,payout_template_version:teamSize===2?'team-share-v1':'winner-all-v1',fee_bps:fee,entry_minor:entry,player_count:body.capacity,team_size:teamSize};
   // Freeze a server-owned policy only on new eligible BOT-practice rooms.
   // Existing waiting/funding rooms retain their stored options and default 3s.
   Object.assign(gameOptions,newTowerPracticeStartOptions({game_id:s.game_id,practice,entry_minor:entry,fee_bps:fee,capacity:body.capacity,players,terms,rule_version:engines[s.game_id].RULE_VERSION}));
   const r=hydrate((await c.query('INSERT INTO pvp_rooms(id,code,app_id,game_id,capacity,practice,entry_minor,fee_bps,terms,scope,players,rule_version,seed_enc,last_tick_at,expires_at,ready_deadline_at,game_options) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *',[roomId,randomBytes(5).toString('hex').toUpperCase(),s.app_id,s.game_id,body.capacity,practice,entry,fee,terms,scopeOf(app),JSON.stringify(players),engines[s.game_id].RULE_VERSION,seal(randomBytes(32).toString('hex')),now,now+300000,players.length===body.capacity?now+30000:null,gameOptions])).rows[0]);
   await c.query('INSERT INTO pvp_active_users(app_id,external_user_id,room_id) VALUES($1,$2,$3)',[s.app_id,s.external_user_id,roomId]);return remember(c,s,body,digest,r,{status:201,body:personal(r,s,now)});
  });
 }
 const route=path.match(/^\/api\/pvp\/rooms\/([A-Za-z0-9_-]+)(?:\/(join|ready|scene-ready|action|leave))?$/);if(!route)fail(404,'NOT_FOUND');const verb=route[2],prepareBowling=method==='POST'&&verb==='action'&&s.game_id==='bowling',initial=await findRoom(s,route[1],method==='POST'&&!prepareBowling);
 if(method==='GET'&&!verb&&options.now===undefined){
  const member=initial.players.find(p=>p.external_user_id===s.external_user_id);if(!member)fail(403,'NOT_A_PLAYER');
  const now=roomNow(initial);
  if(!terminal.has(initial.status)){await touchPresence(initial,s,now);await mergePresence(initial);}
  // No full-view cache or room lock: version and me_last_seq belong to this committed
  // snapshot. A GET started after an action ACK observes at least that commit;
  // a GET already in flight can be older, and clients discard its lower version.
  return{status:200,body:personal(initial,s,roomNow(initial))};
 }
 // Start only pure physics from this authenticated application's snapshot,
 // then enqueue the original room lock immediately, without awaiting physics
 // or sampling the action clock. All authority checks stay below the lock.
 const preparation=prepareBowling?bowlingPreparations.begin({room:initial,session:s,body,digest}):null;
 try{return await locked('pvp:'+initial.id,async()=>{
  let r=hydrate(await getRoom(initial.id));const now=roomNow(r,options.now),member=r.players.find(p=>p.external_user_id===s.external_user_id);
  if(method==='GET'&&!verb){if(!member)fail(403,'NOT_A_PLAYER');if(!terminal.has(r.status)){
   const heartbeat={key:s.external_user_id,written:false},lastSeen=member.last_seen_at;
   await advance(r,now,{skipGap:options.skipGap,heartbeat,ignorePresence:options.now!==undefined});member.last_seen_at=now;
   // Active snapshots already contain this heartbeat. Waiting/unchanged rooms
   // only refresh their small timestamp, at most once per five seconds.
   if(!heartbeat.written&&(now-lastSeen>=5000||options.now!==undefined)){const result=await pool.query("UPDATE pvp_rooms SET players=jsonb_set(players,ARRAY[$2::text,'last_seen_at'],to_jsonb($3::bigint)),version=version+1,updated_at=now() WHERE id=$1 RETURNING version",[r.id,String(r.players.indexOf(member)),now]);r.version=Number(result.rows[0].version);}
  }return{status:200,body:personal(r,s,now)};}
  if(method!=='POST'||!verb)fail(405,'METHOD_NOT_ALLOWED');
  const prior=await replay(pool,s,body,digest);if(prior)return prior;
  if(!member&&verb!=='join')fail(403,'NOT_A_PLAYER');
  if(r.status==='active'&&verb!=='leave')await advance(r,now,{skipGap:options.skipGap,ignorePresence:options.now!==undefined});
  let computedAction;
  if(verb==='action'){
   if(r.status!=='active')fail(409,'NOT_ACTIVE');if(!Number.isSafeInteger(body.seq)||body.seq!==member.last_seq+1)fail(409,'INVALID_SEQUENCE','Expected seq '+(member.last_seq+1));
   // A prepared Bowling shot applies only after rechecking this player's exact
   // proof against the current locked state. Other games retain the worker
   // path. The room lock and request ledger checks still cover the whole act.
   computedAction=prepareBowling?await bowlingPreparations.act(preparation,{room:r,session:s,body,digest},now):await runEngineTask({kind:'act',gameId:r.game_id,ruleVersion:r.rule_version,state:r.game_state,playerKey:s.external_user_id,action:body.action,now});
  }
  if(verb==='leave'&&r.status==='active'&&!r.practice){await advance(r,now,{skipGap:options.skipGap,forfeitKeys:[s.external_user_id],ignorePresence:options.now!==undefined});member.forfeited=true;}
  // A request lock prevents a client from reusing one ID across two room locks.
  return transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`pvpreq:${s.app_id}:${s.external_user_id}:${body.request_id}`]);const repeated=await replay(c,s,body,digest);if(repeated)return repeated;
   if(verb==='join'){
    checkNew(app,s.game_id);await assertProductionAppReady(c,app);if(r.status!=='waiting')fail(409,'ROOM_NOT_JOINABLE');if(now>=r.expires_at||r.ready_deadline_at&&now>=r.ready_deadline_at)fail(409,'READY_TIMEOUT');
    if(!member){if(r.players.length>=r.capacity)fail(409,'ROOM_FULL');if((await c.query('SELECT 1 FROM pvp_active_users WHERE app_id=$1 AND external_user_id=$2',[s.app_id,s.external_user_id])).rowCount)fail(409,'ALREADY_IN_ROOM');
     try{await c.query('INSERT INTO pvp_active_users(app_id,external_user_id,room_id) VALUES($1,$2,$3)',[s.app_id,s.external_user_id,r.id]);}catch(e){if(e.code==='23505')fail(409,'ALREADY_IN_ROOM');throw e;}
     const joined=player(s,r.players.length,now);if(r.terms.team_size===2)joined.team_id=r.players.length%2?'team_b':'team_a';r.players.push(joined);if(r.players.length===r.capacity)r.ready_deadline_at=now+30000;
    }
   }else{
    if(!member)fail(403,'NOT_A_PLAYER');member.last_seen_at=now;
    if(verb==='scene-ready'){
     if(r.game_id!=='run'||r.rule_version!==RUN_FAIR_RULE_VERSION||member.bot||r.game_state?.startPolicy!==RUN_SCENE_READY_POLICY)fail(409,'UNSUPPORTED_START_PROTOCOL');
     if(r.status!=='active')fail(409,'NOT_ACTIVE');
     if(r.game_state.phase==='arming'){
      if(now>=r.game_state.armingDeadlineAt)fail(409,'SCENE_READY_TIMEOUT');
      // Every distinct acknowledgement proves a recently rendered foreground
      // frame; an old first-frame ACK cannot start a match after tab suspension.
      member.scene_ready_at=now;
      if(allRunHumansPresent(r,now))armRun(r,now);
     }
     // A repeated acknowledgement after countdown/start is a no-op. It can
     // never move the shared start instant or extend a paid room's deadline.
    }else if(verb==='ready'){
     checkNew(app,s.game_id);await assertProductionAppReady(c,app);if(r.status!=='waiting')fail(409,'NOT_WAITING');if(now>=r.expires_at||r.ready_deadline_at&&now>=r.ready_deadline_at)fail(409,'READY_TIMEOUT');member.ready=true;
     if(r.players.length===r.capacity&&r.players.every(p=>p.ready)){const seats=Array.from({length:r.capacity},(_,i)=>i);for(let i=seats.length-1;i>0;i--){const j=randomInt(i+1);[seats[i],seats[j]]=[seats[j],seats[i]];}if(r.terms.team_size===2){const offset=randomInt(2);for(const [i,team]of ['team_a','team_b'].entries()){const positions=[(i+offset)%2,(i+offset)%2+2];if(randomInt(2))positions.reverse();const members=r.players.filter(p=>p.team_id===team);if(members.length!==2)fail(409,'INVALID_TEAM');members.forEach((p,j)=>p.seat_index=positions[j]);}}else if(r.game_id==='towerlink'&&r.game_options?.training_lesson_id)r.players.forEach((p,i)=>p.seat_index=i);else r.players.forEach((p,i)=>p.seat_index=seats[i]);r.status='funding';}
    }else if(verb==='leave'){
     if(r.practice&&!terminal.has(r.status)){r.status='cancelled';r.end_at=now;r.last_tick_at=now;r.error=null;}
     else if(r.status==='waiting'||r.status==='funding')r.status='cancelling';
     // Active paid forfeits were computed before entering this transaction.
    }else if(verb==='action'){
     if(r.status!=='active')fail(409,'NOT_ACTIVE');if(!Number.isSafeInteger(body.seq)||body.seq!==member.last_seq+1)fail(409,'INVALID_SEQUENCE','Expected seq '+(member.last_seq+1));
     const result=computedAction;r.game_state=result.state;member.last_seq=body.seq;member.last_event=memberEvent(r.game_id,result.event);
     await c.query('INSERT INTO pvp_actions(room_id,external_user_id,seq,action,event,accepted_at) VALUES($1,$2,$3,$4,$5,$6)',[r.id,s.external_user_id,body.seq,body.action,result.event||null,now]);
     if(r.game_state.phase==='fault'){r.status='fault';r.fault_at=now;r.error=r.game_state.fault;}else if(r.game_state.status==='finished')fixResult(r,now);
    }
   }
   await save(r,c);return remember(c,s,body,digest,r,{status:200,body:personal(r,s,now)});
  });
 });}finally{bowlingPreparations.release(preparation);}
}
export async function readPvpMatch(app,matchId){
 const r=hydrate((await pool.query('SELECT * FROM pvp_rooms WHERE id=$1 AND app_id=$2 AND NOT practice',[matchId,app.id])).rows[0]);if(!r||walletless(r))fail(404,'MATCH_NOT_FOUND');
 const states={waiting:'WAITING',funding:'CAPTURE_PENDING',active:'ACTIVE',fault:'ACTIVE',settling:'SETTLEMENT_PENDING',settled:'SETTLED',cancelling:'CANCEL_PENDING',cancelled:'CANCELLED',voiding:'VOID_PENDING',voided:'VOIDED'};
 const result={scope:r.scope,match_id:r.id,game_id:r.game_id,state:states[r.status],terms:r.terms,participants:roster(r),aggregate_version:String(r.version),updated_at:new Date(r.updated_at).toISOString()};
 if(r.captured)result.capture_operation_id=`capture_${r.id}`;if(r.result){result.result_hash=r.result_hash;result.payouts=r.result.payouts;result.fee_minor=r.result.fee_minor;}if(!walletless(r)&&['settled','voided'].includes(r.status))result.settlement_operation_id=`settle_${r.id}`;return result;
}
