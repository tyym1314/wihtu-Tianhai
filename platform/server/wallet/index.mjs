import http from 'node:http';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { WalletError, parseRaw, sha256, verifyWalletRequest } from './security.mjs';
export { signWalletRequest } from './security.mjs';
const MAX=9223372036854775807n;
const fields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const scopeOf=s=>Object.fromEntries(fields.map(k=>[k,s[k]]));
const scopeId=s=>fields.map(k=>s[k]).join(':');
const iso=v=>v instanceof Date?v.toISOString():v;
const now=()=>new Date().toISOString();
function fail(code,message,status=409){throw new WalletError(code,message,status);}
function amount(v,positive=false){if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v))fail('AMOUNT_MISMATCH','Invalid integer amount',400);const n=BigInt(v);if(n>MAX||(positive&&n===0n))fail('AMOUNT_MISMATCH','Amount outside int64 range',400);return n;}
function capacity(n){if(n<0n||n>MAX)fail('AMOUNT_MISMATCH','Account amount/capacity outside range',400);}
function same(a,b){return JSON.stringify(sort(a))===JSON.stringify(sort(b));}
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
function checkScope(body,s){if(fields.some(k=>body[k]!==s[k]))fail('SCOPE_FORBIDDEN','Credential and requested scope differ',403);}
const spec=JSON.parse(await fs.readFile(new URL('../../specs/openapi.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);
const validators=new Map();
function validate(name,body){let v=validators.get(name);if(!v){v=ajv.compile({$ref:`#/components/schemas/${name}`,components:spec.components});validators.set(name,v);}if(!v(body))fail('INVALID_REQUEST','Schema validation failed: '+ajv.errorsText(v.errors).slice(0,600),400);}

export async function migrateWallet(pool){await pool.query(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));}
async function transaction(pool,fn){const db=await pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
// Queue within one process before checking out a transaction connection. The
// database lock below still serializes another process or another Pool. Pool
// identity keeps independent databases/tests from sharing an in-memory queue.
const scopeQueues=new WeakMap();
function scopeQueue(pool){let q=scopeQueues.get(pool);if(!q){q={scopes:new Map(),total:0,rejected:0,peak:0};scopeQueues.set(pool,q);}return q;}
async function scopeTransaction(pool,id,fn){
 const q=scopeQueue(pool),state=q.scopes.get(id)||{tail:undefined,depth:0};
 if(state.depth>=64||q.total>=2048){q.rejected++;fail('RATE_LIMITED','Wallet scope queue is full; retry the original operation',503);}
 const before=state.tail;let release;state.tail=new Promise(r=>release=r);state.depth++;q.total++;q.peak=Math.max(q.peak,q.total);q.scopes.set(id,state);
 try{await before;return await transaction(pool,fn);}
 finally{release();state.depth--;q.total--;if(!state.depth)q.scopes.delete(id);}
}
export const walletQueueStats=pool=>{const q=scopeQueues.get(pool);return{scopes:q?.scopes.size||0,admitted:q?.total||0,peak:q?.peak||0,rejected:q?.rejected||0,max_per_scope:64,max_total:2048};};
async function withScope(pool,id,fn,{expire=true}={}){
 return scopeTransaction(pool,id,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
  const s=(await db.query('SELECT * FROM wallet_scopes WHERE scope_id=$1 FOR UPDATE',[id])).rows[0];if(!s)fail('NOT_FOUND','Scope not provisioned',404);
  const ctx={db,s,id,users:new Map(),transactionId:'wl_'+randomUUID().replaceAll('-',''),operationId:'system',dirty:false};
  if(expire)await expireHolds(ctx);
  const result=await fn(ctx);
  if(ctx.dirty)await db.query('UPDATE wallet_scopes SET treasury_available=$2,treasury_reserved=$3,treasury_inbound=$4,fee_available=$5,fee_pending=$6,ledger_version=$7 WHERE scope_id=$1',[id,s.treasury_available,s.treasury_reserved,s.treasury_inbound,s.fee_available,s.fee_pending,s.ledger_version]);
  return result;
 });
}
async function user(c,id){if(c.users.has(id))return c.users.get(id);const u=(await c.db.query('SELECT * FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2',[c.id,id])).rows[0];if(!u)fail('NOT_FOUND','Wallet user does not exist',404);c.users.set(id,u);return u;}
async function saveUser(c,u){for(const k of ['available','reserved','credit_pending'])capacity(BigInt(u[k]));await c.db.query('UPDATE wallet_users SET available=$3,reserved=$4,credit_pending=$5 WHERE scope_id=$1 AND external_user_id=$2',[c.id,u.external_user_id,u.available,u.reserved,u.credit_pending]);}
function change(row,key,delta){row[key]=(BigInt(row[key])+delta).toString();capacity(BigInt(row[key]));}
function creditRoom(u,extra){capacity(BigInt(u.available)+BigInt(u.reserved)+BigInt(u.credit_pending)+extra);}
async function ledger(c,account,available=0n,reserved=0n,meta={},operationId=c.operationId){
 await c.db.query('INSERT INTO wallet_ledger(scope_id,operation_id,transaction_id,account,delta_available,delta_reserved,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,operationId,c.transactionId,account,available.toString(),reserved.toString(),JSON.stringify(meta)]);
 change(c.s,'ledger_version',1n);c.dirty=true;
}
/** Internal transfer adapter only. Uses the very same lock and transaction as
 * game spending; it is never exposed as a generic HTTP balance mutation. */
export async function withTransferLedger(pool,scope,operationId,fn){
 for(const field of fields)if(typeof scope?.[field]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(scope[field]))fail('INVALID_REQUEST','Invalid transfer scope',400);
 return withScope(pool,scopeId(scope),async c=>{
  c.operationId=operationId;
  return fn({db:c.db,scope:c.s,scopeId:c.id,transactionId:c.transactionId,
   async hold(userId,direction,value){
    const n=amount(value,true),u=await user(c,userId);
    if(direction==='IN'){creditRoom(u,n);change(u,'credit_pending',n);await ledger(c,'user:'+userId,0n,0n,{kind:'transfer_capacity_hold',credit_pending_delta:value});}
    else if(direction==='OUT'){if(BigInt(u.available)<n)fail('INSUFFICIENT_FUNDS','Insufficient available balance',422);change(u,'available',-n);change(u,'reserved',n);await ledger(c,'user:'+userId,-n,n,{kind:'transfer_hold'});}
    else fail('INVALID_REQUEST','Invalid transfer direction',400);
    await saveUser(c,u);
   },
   async finish(userId,direction,value,succeeded,clearingAccount){
    const n=amount(value,true),u=await user(c,userId);
    if(direction==='IN'){change(u,'credit_pending',-n);if(succeeded){change(u,'available',n);await ledger(c,'user:'+userId,n,0n,{kind:'transfer_in',credit_pending_delta:(-n).toString()});await ledger(c,clearingAccount,-n,0n,{kind:'transfer_in'});}else await ledger(c,'user:'+userId,0n,0n,{kind:'transfer_capacity_released',credit_pending_delta:(-n).toString()});}
    else if(direction==='OUT'){change(u,'reserved',-n);if(!succeeded)change(u,'available',n);await ledger(c,'user:'+userId,succeeded?0n:n,-n,{kind:succeeded?'transfer_out':'transfer_rejected'});if(succeeded)await ledger(c,clearingAccount,n,0n,{kind:'transfer_out'});}
    else fail('INVALID_REQUEST','Invalid transfer direction',400);
    await saveUser(c,u);
   }
  });
 },{expire:false});
}
async function match(c,id){return (await c.db.query('SELECT * FROM wallet_matches WHERE scope_id=$1 AND match_id=$2',[c.id,id])).rows[0];}
async function auth(c,id){return (await c.db.query('SELECT * FROM wallet_probability WHERE scope_id=$1 AND authorization_id=$2',[c.id,id])).rows[0];}
function reservationResource(s,r){return {...scopeOf(s),reservation_id:r.reservation_id,match_id:r.match_id,external_user_id:r.external_user_id,seat_index:r.seat_index,amount_minor:r.amount_minor,terms:r.terms,state:r.state,expires_at:iso(r.expires_at),updated_at:iso(r.updated_at)};}
function matchResource(s,m){const r={...scopeOf(s),match_id:m.match_id,state:m.state,captured_minor:m.captured_minor,fee_minor:m.fee_minor,updated_at:iso(m.updated_at)};for(const k of ['terms','participants','payouts','result_hash','capture_operation_id','settlement_operation_id'])if(m[k]!==null&&m[k]!==undefined)r[k]=m[k];return r;}
function authResource(s,a){const r={...scopeOf(s),authorization_id:a.authorization_id,cycle_id:a.cycle_id,state:a.state,updated_at:iso(a.updated_at)};for(const k of ['external_user_id','game_id','math_version','math_config_hash','stake_minor','max_payout_minor','gross_payout_minor','expires_at','accepted_at','result_hash'])if(a[k]!==null&&a[k]!==undefined)r[k]=iso(a[k]);return r;}
const receipt=(c,resource_type,resource)=>({resource_type,resource,ledger_transaction_id:c.transactionId,committed_at:now()});
async function expireHolds(c){
 const holds=(await c.db.query("SELECT * FROM wallet_reservations WHERE scope_id=$1 AND state='RESERVED' AND expires_at<=clock_timestamp()",[c.id])).rows;
 for(const r of holds){const u=await user(c,r.external_user_id),n=BigInt(r.amount_minor);change(u,'available',n);change(u,'reserved',-n);await saveUser(c,u);await c.db.query("UPDATE wallet_reservations SET state='EXPIRED',updated_at=now() WHERE scope_id=$1 AND reservation_id=$2",[c.id,r.reservation_id]);await ledger(c,'user:'+u.external_user_id,n,-n,{reason:'reservation_expired'},'expire_'+r.reservation_id);}
 const expired=(await c.db.query("SELECT * FROM wallet_probability WHERE scope_id=$1 AND state='AUTHORIZED' AND expires_at<=clock_timestamp()",[c.id])).rows;
 for(const a of expired)await releaseAuthorization(c,a,'EXPIRED','expire_'+a.authorization_id);
}
async function releaseAuthorization(c,a,state,operationId=c.operationId){
 const u=await user(c,a.external_user_id),stake=BigInt(a.stake_minor),max=BigInt(a.max_payout_minor);
 change(u,'available',stake);change(u,'reserved',-stake);change(u,'credit_pending',-max);await saveUser(c,u);
 change(c.s,'treasury_available',max);change(c.s,'treasury_reserved',-max);change(c.s,'treasury_inbound',-stake);
 await ledger(c,'user:'+u.external_user_id,stake,-stake,{reason:state},operationId);await ledger(c,'treasury',max,-max,{reason:state},operationId);
 await c.db.query('UPDATE wallet_probability SET state=$3,updated_at=now() WHERE scope_id=$1 AND authorization_id=$2',[c.id,a.authorization_id,state]);
}

export async function registerMathProfiles(pool,{scope,math_profiles=[]}){
 return withScope(pool,scopeId(scope),async c=>{for(const p of math_profiles){if(!['thunder','tiger'].includes(p.game_id)||!/^[a-f0-9]{64}$/.test(p.math_config_hash)||!/^[A-Za-z0-9_.-]{1,96}$/.test(p.math_version))fail('INVALID_REQUEST','Invalid approved math profile',400);amount(p.max_payout_multiplier);const old=(await c.db.query('SELECT * FROM wallet_math_profiles WHERE scope_id=$1 AND game_id=$2 AND math_version=$3',[c.id,p.game_id,p.math_version])).rows[0];if(old&&(old.math_config_hash!==p.math_config_hash||old.max_payout_multiplier!==p.max_payout_multiplier))fail('IDEMPOTENCY_CONFLICT','Immutable math version already registered');await c.db.query('INSERT INTO wallet_math_profiles(scope_id,game_id,math_version,math_config_hash,max_payout_multiplier) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[c.id,p.game_id,p.math_version,p.math_config_hash,p.max_payout_multiplier]);}return {registered:math_profiles.length};});
}
export async function provisionWallet(pool,{scope,key_id,secret_base64,users=[],treasury_minor,math_profiles=[],partnerOwnedScope=false}){
 // partnerOwnedScope: this reference implementation runs as a partner's own, separate wallet
 // (its own process and database), so it may hold that partner's production scope.
 if(scope?.environment!=='sandbox'&&partnerOwnedScope!==true)fail('REFERENCE_PROVISION_SANDBOX_ONLY','Reference opening balances are restricted to sandbox',403);
 for(const k of fields)if(typeof scope[k]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(scope[k]))fail('INVALID_REQUEST','Invalid scope',400);
 if(!['sandbox','production'].includes(scope.environment)||!/^[A-Za-z0-9_-]{1,128}$/.test(key_id)||typeof secret_base64!=='string'||Buffer.from(secret_base64,'base64').length<32)fail('INVALID_REQUEST','Invalid provision key',400);
 amount(treasury_minor);const id=scopeId(scope);
 await scopeTransaction(pool,id,async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);const createdScope=await db.query('INSERT INTO wallet_scopes(scope_id,partner_id,app_id,environment,wallet_scope_id,currency_id,treasury_available) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING scope_id',[id,...fields.map(k=>scope[k]),treasury_minor]);if(createdScope.rowCount)await provisionLedger(db,id,'treasury',treasury_minor);const existing=(await db.query('SELECT * FROM wallet_keys WHERE key_id=$1',[key_id])).rows[0];if(existing&&(existing.scope_id!==id||existing.secret_base64!==secret_base64))fail('IDEMPOTENCY_CONFLICT','Credential is already bound differently');await db.query('INSERT INTO wallet_keys(key_id,scope_id,secret_base64) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[key_id,id,secret_base64]);for(const u of users){if(!/^[A-Za-z0-9_-]{1,128}$/.test(u.external_user_id))fail('INVALID_REQUEST','Invalid user ID',400);amount(u.balance_minor);const createdUser=await db.query('INSERT INTO wallet_users(scope_id,external_user_id,available) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING external_user_id',[id,u.external_user_id,u.balance_minor]);if(createdUser.rowCount)await provisionLedger(db,id,'user:'+u.external_user_id,u.balance_minor);}});
 if(math_profiles.length)await registerMathProfiles(pool,{scope,math_profiles});
 return {scope_id:id,scope:scopeOf(scope),key_id};
}
function validateTerms(t){
 if(t.game_id==='towerlink'&&/^towerlink-v2\./.test(t.rule_version)&&t.player_count!==2)fail('INVALID_REQUEST','Tower Link v2 paid play requires exactly two participants',400);
 const individual={match:[2,3,4],golf:[2,3,4],darts:[2],ludo:[2,4],pool:[2],bowling:[2,3,4],domino:[2,4],run:[2,3,4],towerlink:[2,3,4]};
 const valid=t.game_id==='carrom'?((t.player_count===2&&t.team_size===1)||(t.player_count===4&&t.team_size===2)):t.game_id==='jackaroo'?(t.player_count===4&&t.team_size===2):individual[t.game_id]?.includes(t.player_count)&&t.team_size===1;
 if(!valid)fail('INVALID_REQUEST','Unsupported game player/team count',400);
}
function expiresWithin(value,seconds){const ms=Date.parse(value),delta=ms-Date.now();if(!Number.isFinite(ms)||delta<=0||delta>seconds*1000+1000)fail('INVALID_REQUEST','Expiry must be in permitted future window',400);}
async function reserve(c,b){
 validateTerms(b.terms);expiresWithin(b.expires_at,120);const n=amount(b.amount_minor,true);if(b.amount_minor!==b.terms.entry_minor||b.seat_index>=b.terms.player_count)fail('AMOUNT_MISMATCH','Entry/seat differ from fixed terms',400);
 let m=await match(c,b.match_id);if(m?.state==='CANCELLED')fail('CANCELLED_TOMBSTONE','Match was cancelled');if(m&&m.state!=='RESERVING')fail('INVALID_STATE','Match no longer accepts reservations');if(m&&!same(m.terms,b.terms))fail('INVALID_STATE','Match terms are immutable');
 const old=(await c.db.query('SELECT * FROM wallet_reservations WHERE scope_id=$1 AND (reservation_id=$2 OR (match_id=$3 AND (external_user_id=$4 OR seat_index=$5)))',[c.id,b.reservation_id,b.match_id,b.external_user_id,b.seat_index])).rows[0];if(old)fail('INVALID_STATE','Reservation/player/seat already used');
 const u=await user(c,b.external_user_id);if(BigInt(u.available)<n)fail('INSUFFICIENT_FUNDS','Insufficient available balance',422);
 if(!m)await c.db.query("INSERT INTO wallet_matches(scope_id,match_id,state,terms) VALUES($1,$2,'RESERVING',$3)",[c.id,b.match_id,JSON.stringify(b.terms)]);
 change(u,'available',-n);change(u,'reserved',n);await saveUser(c,u);await ledger(c,'user:'+u.external_user_id,-n,n,{match_id:b.match_id});
 const row=(await c.db.query("INSERT INTO wallet_reservations(scope_id,reservation_id,match_id,external_user_id,seat_index,amount_minor,terms,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'RESERVED',$8) RETURNING *",[c.id,b.reservation_id,b.match_id,b.external_user_id,b.seat_index,b.amount_minor,JSON.stringify(b.terms),b.expires_at])).rows[0];return receipt(c,'reservation',reservationResource(c.s,row));
}
async function capture(c,b){
 const m=await match(c,b.match_id);if(m?.state==='CANCELLED')fail('CANCELLED_TOMBSTONE','Match was cancelled');if(!m||m.state!=='RESERVING')fail('INVALID_STATE','Match not reserving');if(!same(m.terms,b.terms))fail('INVALID_STATE','Terms differ from reservations');
 validateTerms(b.terms);const ps=b.participants;if(ps.length!==b.terms.player_count||new Set(ps.map(p=>p.external_user_id)).size!==ps.length||new Set(ps.map(p=>p.seat_index)).size!==ps.length||new Set(ps.map(p=>p.reservation_id)).size!==ps.length)fail('INVALID_REQUEST','Roster must contain unique complete participants',400);
 if(b.terms.team_size===2){const teams=new Map();for(const p of ps){if(!p.team_id)fail('INVALID_REQUEST','2v2 requires team IDs',400);teams.set(p.team_id,(teams.get(p.team_id)||0)+1);}if(teams.size!==2||[...teams.values()].some(v=>v!==2))fail('INVALID_REQUEST','Exactly two teams of two required',400);}
 let total=0n;for(const p of ps){const r=(await c.db.query('SELECT * FROM wallet_reservations WHERE scope_id=$1 AND reservation_id=$2',[c.id,p.reservation_id])).rows[0];if(r?.state==='EXPIRED')fail('RESERVATION_EXPIRED','A reservation expired');if(!r||r.state!=='RESERVED'||r.match_id!==b.match_id||r.external_user_id!==p.external_user_id||r.seat_index!==p.seat_index||r.amount_minor!==p.entry_minor||p.entry_minor!==b.terms.entry_minor||!same(r.terms,b.terms))fail('INVALID_STATE','Invalid reservation roster');total+=BigInt(r.amount_minor);}
 capacity(total);const fee=total*BigInt(b.terms.fee_bps)/10000n,prize=total-fee;capacity(BigInt(c.s.fee_available)+BigInt(c.s.fee_pending)+fee);
 for(const p of ps)creditRoom(await user(c,p.external_user_id),prize);
 for(const p of ps){const u=await user(c,p.external_user_id);change(u,'reserved',-BigInt(p.entry_minor));change(u,'credit_pending',prize);await saveUser(c,u);await ledger(c,'user:'+u.external_user_id,0n,-BigInt(p.entry_minor),{match_id:b.match_id});const marked=await c.db.query("UPDATE wallet_reservations SET state='CAPTURED',updated_at=now() WHERE scope_id=$1 AND reservation_id=$2 AND state='RESERVED' AND expires_at>clock_timestamp() RETURNING reservation_id",[c.id,p.reservation_id]);if(!marked.rowCount)fail('RESERVATION_EXPIRED','Reservation expired before atomic capture');}
 change(c.s,'fee_pending',fee);await ledger(c,'match:'+b.match_id,total,0n);
 const row=(await c.db.query("UPDATE wallet_matches SET state='CAPTURED',participants=$3,captured_minor=$4,pool_minor=$4,expected_fee=$5,payout_capacity=$6,capture_operation_id=$7,updated_at=now() WHERE scope_id=$1 AND match_id=$2 RETURNING *",[c.id,b.match_id,JSON.stringify(ps),total.toString(),fee.toString(),prize.toString(),b.request_id])).rows[0];return receipt(c,'match',matchResource(c.s,row));
}
async function release(c,b){
 const m=await match(c,b.match_id);if(m&&['CAPTURED','SETTLED','VOIDED'].includes(m.state))fail('ALREADY_CAPTURED','Cannot release captured funds');
 const rs=(await c.db.query("SELECT * FROM wallet_reservations WHERE scope_id=$1 AND match_id=$2 AND state='RESERVED'",[c.id,b.match_id])).rows;
 for(const r of rs){const u=await user(c,r.external_user_id),n=BigInt(r.amount_minor);change(u,'available',n);change(u,'reserved',-n);await saveUser(c,u);await ledger(c,'user:'+u.external_user_id,n,-n,{match_id:b.match_id,reason:b.reason});}
 await c.db.query("UPDATE wallet_reservations SET state='RELEASED',updated_at=now() WHERE scope_id=$1 AND match_id=$2 AND state='RESERVED'",[c.id,b.match_id]);
 const row=(await c.db.query("INSERT INTO wallet_matches(scope_id,match_id,state) VALUES($1,$2,'CANCELLED') ON CONFLICT(scope_id,match_id) DO UPDATE SET state='CANCELLED',updated_at=now() RETURNING *",[c.id,b.match_id])).rows[0];return receipt(c,'match',matchResource(c.s,row));
}
async function settle(c,b){
 const m=await match(c,b.match_id);if(!m||m.state!=='CAPTURED')fail('INVALID_STATE','Match must be captured and unsettled');
 const ps=b.payouts,roster=m.participants;if(ps.length!==roster.length||new Set(ps.map(p=>p.external_user_id)).size!==ps.length||new Set(ps.map(p=>p.seat_index)).size!==ps.length)fail('AMOUNT_MISMATCH','Payouts must cover unique captured roster',400);
 for(const p of ps)if(!roster.some(r=>r.external_user_id===p.external_user_id&&r.seat_index===p.seat_index))fail('AMOUNT_MISMATCH','Unknown payout participant',400);
 const fee=amount(b.fee_minor),total=BigInt(m.captured_minor),sum=ps.reduce((s,p)=>s+amount(p.payout_minor),0n);if(sum+fee!==total)fail('AMOUNT_MISMATCH','Payout conservation failed',400);
 if(b.resolution==='void'){if(fee!==0n||!b.reason||ps.some(p=>p.payout_minor!==roster.find(r=>r.external_user_id===p.external_user_id).entry_minor))fail('AMOUNT_MISMATCH','Void must return every original entry without fee',400);}
 else{
  if(fee!==BigInt(m.expected_fee))fail('AMOUNT_MISMATCH','Locked fee differs',400);
  if(m.terms.team_size===2){for(const p of roster){const team=roster.filter(r=>r.team_id===p.team_id);if(new Set(team.map(r=>ps.find(x=>x.external_user_id===r.external_user_id).rank)).size!==1)fail('AMOUNT_MISMATCH','Team members must have equal rank',400);}}
  const best=Math.min(...ps.map(p=>p.rank)),winners=ps.filter(p=>p.rank===best).sort((a,b)=>a.seat_index-b.seat_index);const pot=total-fee,share=pot/BigInt(winners.length),remainder=Number(pot%BigInt(winners.length));
  for(const p of ps){const i=winners.indexOf(p),expected=i<0?0n:share+(i<remainder?1n:0n);if(BigInt(p.payout_minor)!==expected)fail('AMOUNT_MISMATCH','Winner/tie split differs from published template',400);}
 }
 for(const p of ps){const u=await user(c,p.external_user_id);change(u,'credit_pending',-BigInt(m.payout_capacity));change(u,'available',BigInt(p.payout_minor));await saveUser(c,u);await ledger(c,'user:'+u.external_user_id,BigInt(p.payout_minor),0n,{match_id:b.match_id,resolution:b.resolution});}
 change(c.s,'fee_pending',-BigInt(m.expected_fee));change(c.s,'fee_available',fee);await ledger(c,'match:'+b.match_id,-total,0n);await ledger(c,'fee',fee,0n);
 const row=(await c.db.query('UPDATE wallet_matches SET state=$3,pool_minor=0,fee_minor=$4,payouts=$5,result_hash=$6,settlement_operation_id=$7,updated_at=now() WHERE scope_id=$1 AND match_id=$2 RETURNING *',[c.id,b.match_id,b.resolution==='void'?'VOIDED':'SETTLED',b.fee_minor,JSON.stringify(ps),b.result_hash,b.request_id])).rows[0];return receipt(c,'match',matchResource(c.s,row));
}
async function authorize(c,b){
 expiresWithin(b.expires_at,60);const old=(await c.db.query('SELECT * FROM wallet_probability WHERE scope_id=$1 AND (authorization_id=$2 OR cycle_id=$3)',[c.id,b.authorization_id,b.cycle_id])).rows[0];if(old?.state==='CANCELLED')fail('CANCELLED_TOMBSTONE','Cycle already cancelled');if(old)fail('INVALID_STATE','Cycle/authorization already exists');
 const profile=(await c.db.query('SELECT * FROM wallet_math_profiles WHERE scope_id=$1 AND game_id=$2 AND math_version=$3',[c.id,b.game_id,b.math_version])).rows[0];if(!profile||profile.math_config_hash!==b.math_config_hash)fail('GAME_DISABLED','Unapproved math profile/hash',403);
 const stake=amount(b.stake_minor,true),max=amount(b.max_payout_minor);if(stake*BigInt(profile.max_payout_multiplier)!==max)fail('AMOUNT_MISMATCH','Full-cycle maximum must equal approved profile cap',400);
 const u=await user(c,b.external_user_id);if(BigInt(u.available)<stake)fail('INSUFFICIENT_FUNDS','Insufficient stake',422);if(BigInt(c.s.treasury_available)<max)fail('LIABILITY_CAPACITY_EXCEEDED','Full-cycle liability unavailable before acceptance',422);
 creditRoom(u,max);capacity(BigInt(c.s.treasury_available)+BigInt(c.s.treasury_reserved)+BigInt(c.s.treasury_inbound)+stake);
 change(u,'available',-stake);change(u,'reserved',stake);change(u,'credit_pending',max);await saveUser(c,u);change(c.s,'treasury_available',-max);change(c.s,'treasury_reserved',max);change(c.s,'treasury_inbound',stake);
 await ledger(c,'user:'+u.external_user_id,-stake,stake,{cycle_id:b.cycle_id});await ledger(c,'treasury',-max,max,{cycle_id:b.cycle_id});
 const row=(await c.db.query("INSERT INTO wallet_probability(scope_id,authorization_id,cycle_id,state,external_user_id,game_id,math_version,math_config_hash,stake_minor,max_payout_minor,expires_at) VALUES($1,$2,$3,'AUTHORIZED',$4,$5,$6,$7,$8,$9,$10) RETURNING *",[c.id,b.authorization_id,b.cycle_id,b.external_user_id,b.game_id,b.math_version,b.math_config_hash,b.stake_minor,b.max_payout_minor,b.expires_at])).rows[0];return receipt(c,'probability_authorization',authResource(c.s,row));
}
async function accept(c,b){
 const a=await auth(c,b.authorization_id);if(a?.state==='CANCELLED')fail('CANCELLED_TOMBSTONE','Authorization cancelled');if(a?.state==='EXPIRED')fail('AUTHORIZATION_EXPIRED','Authorization expired');if(!a||a.cycle_id!==b.cycle_id||a.state!=='AUTHORIZED')fail('INVALID_STATE','Authorization not available to accept');
 const row=(await c.db.query("UPDATE wallet_probability SET state='ACCEPTED',accepted_at=now(),updated_at=now() WHERE scope_id=$1 AND authorization_id=$2 AND state='AUTHORIZED' AND expires_at>clock_timestamp() RETURNING *",[c.id,b.authorization_id])).rows[0];if(!row)fail('AUTHORIZATION_EXPIRED','Authorization expired before atomic acceptance');return receipt(c,'probability_authorization',authResource(c.s,row));
}
async function cancelProbability(c,b){
 const a=(await c.db.query('SELECT * FROM wallet_probability WHERE scope_id=$1 AND (authorization_id=$2 OR cycle_id=$3)',[c.id,b.authorization_id,b.cycle_id])).rows[0];if(a&&(a.authorization_id!==b.authorization_id||a.cycle_id!==b.cycle_id))fail('INVALID_STATE','Authorization/cycle mismatch');if(a&&['ACCEPTED','SETTLED'].includes(a.state))fail('ALREADY_ACCEPTED','Accepted payout liability cannot be cancelled');
 if(a?.state==='AUTHORIZED')await releaseAuthorization(c,a,'CANCELLED');
 else if(!a)await c.db.query("INSERT INTO wallet_probability(scope_id,authorization_id,cycle_id,state) VALUES($1,$2,$3,'CANCELLED')",[c.id,b.authorization_id,b.cycle_id]);
 else if(a.state==='EXPIRED')await c.db.query("UPDATE wallet_probability SET state='CANCELLED',updated_at=now() WHERE scope_id=$1 AND authorization_id=$2",[c.id,b.authorization_id]);
 return receipt(c,'probability_authorization',authResource(c.s,await auth(c,b.authorization_id)));
}
async function settleProbability(c,b){
 const a=await auth(c,b.authorization_id);if(!a||a.state!=='ACCEPTED')fail('INVALID_STATE','Cycle must be accepted and unsettled');
 for(const k of ['cycle_id','game_id','math_version','math_config_hash','stake_minor'])if(a[k]!==b[k])fail('AMOUNT_MISMATCH','Accepted cycle terms are immutable',400);
 const payout=amount(b.gross_payout_minor),stake=BigInt(a.stake_minor),max=BigInt(a.max_payout_minor);if(payout>max)fail('AMOUNT_MISMATCH','Payout exceeds authorized full-cycle cap',400);
 const u=await user(c,a.external_user_id);change(u,'credit_pending',-max);change(u,'reserved',-stake);change(u,'available',payout);await saveUser(c,u);
 change(c.s,'treasury_reserved',-max);change(c.s,'treasury_inbound',-stake);change(c.s,'treasury_available',max-payout+stake);
 await ledger(c,'user:'+u.external_user_id,payout,-stake,{cycle_id:b.cycle_id});await ledger(c,'treasury',max-payout+stake,-max,{cycle_id:b.cycle_id});
 const row=(await c.db.query("UPDATE wallet_probability SET state='SETTLED',gross_payout_minor=$3,result_hash=$4,updated_at=now() WHERE scope_id=$1 AND authorization_id=$2 RETURNING *",[c.id,b.authorization_id,b.gross_payout_minor,b.result_hash])).rows[0];return receipt(c,'probability_authorization',authResource(c.s,row));
}
const commands={
 '/wallet/v1/reservations':['reserve','ReserveRequest',reserve],
 '/wallet/v1/matches/capture':['capture_match','CaptureMatchRequest',capture],
 '/wallet/v1/matches/release':['release_match','ReleaseMatchRequest',release],
 '/wallet/v1/matches/settle':['settle_match','SettleMatchRequest',settle],
 '/wallet/v1/probability/authorize':['authorize_probability','AuthorizeProbabilityRequest',authorize],
 '/wallet/v1/probability/accept':['accept_probability','AcceptProbabilityRequest',accept],
 '/wallet/v1/probability/cancel':['cancel_probability','CancelProbabilityRequest',cancelProbability],
 '/wallet/v1/probability/settle':['settle_probability','SettleProbabilityRequest',settleProbability]
};
const errorBody=(e,operation_id)=>({code:e instanceof WalletError?e.code:'INTERNAL_ERROR',message:e instanceof WalletError?e.message.slice(0,512):'Reference wallet temporarily unavailable',trace_id:'tr_'+randomUUID().replaceAll('-',''),...(operation_id?{operation_id}:{}),retryable:!(e instanceof WalletError)||e.status>=500});
async function execute(pool,key,path,raw,body){
 const [kind,schema,fn]=commands[path];validate(schema,body);checkScope(body,key.row);if(body.request_id!==key.request_id)fail('INVALID_REQUEST','Header/body request_id differ',400);
 const hash=sha256(raw);
 return withScope(pool,key.row.scope_id,async c=>{
  c.operationId=body.request_id;
  await c.db.query('INSERT INTO wallet_operation_ids(partner_id,app_id,environment,operation_id,scope_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[c.s.partner_id,c.s.app_id,c.s.environment,c.operationId,c.id]);
  const registry=(await c.db.query('SELECT scope_id FROM wallet_operation_ids WHERE partner_id=$1 AND app_id=$2 AND environment=$3 AND operation_id=$4',[c.s.partner_id,c.s.app_id,c.s.environment,c.operationId])).rows[0];if(registry.scope_id!==c.id)fail('IDEMPOTENCY_CONFLICT','Business ID is already used in another wallet scope');
  const old=(await c.db.query('SELECT * FROM wallet_operations WHERE scope_id=$1 AND operation_id=$2',[c.id,c.operationId])).rows[0];
  if(old){if(old.method!=='POST'||old.path!==path||old.body_sha256!==hash)fail('IDEMPOTENCY_CONFLICT','Business ID method/path/body differ');return {status:old.response_status,body:old.response_body};}
  const created=(await c.db.query("INSERT INTO wallet_operations(scope_id,operation_id,kind,method,path,body_sha256,state) VALUES($1,$2,$3,'POST',$4,$5,'PENDING') RETURNING created_at",[c.id,c.operationId,kind,path,hash])).rows[0].created_at;
  await c.db.query('SAVEPOINT wallet_business');const before={s:structuredClone(c.s),users:structuredClone([...c.users]),dirty:c.dirty};let state,status,response,operation;
  try{const r=await fn(c,body);state='SUCCEEDED';status=200;operation={...scopeOf(c.s),operation_id:c.operationId,kind,state,body_sha256:hash,receipt:r,created_at:iso(created),updated_at:now()};response=operation;}
  catch(e){if(!(e instanceof WalletError))throw e;await c.db.query('ROLLBACK TO SAVEPOINT wallet_business');Object.assign(c.s,before.s);c.users=new Map(before.users);c.dirty=before.dirty;state='REJECTED';status=200;const rejection=errorBody(e,c.operationId);operation={...scopeOf(c.s),operation_id:c.operationId,kind,state,body_sha256:hash,rejection,created_at:iso(created),updated_at:now()};response=operation;}
  await c.db.query('UPDATE wallet_operations SET state=$3,response_status=$4,response_body=$5,operation=$6,updated_at=now() WHERE scope_id=$1 AND operation_id=$2',[c.id,c.operationId,state,status,JSON.stringify(response),JSON.stringify(operation)]);
  return {status,body:response};
 });
}
async function query(pool,key,path){
 const op=path.match(/^\/wallet\/v1\/operations\/([A-Za-z0-9_-]{1,128})$/);if(op){const row=(await pool.query('SELECT operation FROM wallet_operations WHERE scope_id=$1 AND operation_id=$2',[key.row.scope_id,op[1]])).rows[0];if(!row)fail('NOT_FOUND','No visible operation record',404);return row.operation;}
 const m=path.match(/^\/wallet\/v1\/matches\/([A-Za-z0-9_-]{1,128})$/);if(m)return withScope(pool,key.row.scope_id,async c=>{const v=await match(c,m[1]);if(!v)fail('NOT_FOUND','No visible match',404);return matchResource(c.s,v);});
 const a=path.match(/^\/wallet\/v1\/probability\/authorizations\/([A-Za-z0-9_-]{1,128})$/);if(a)return withScope(pool,key.row.scope_id,async c=>{const v=await auth(c,a[1]);if(!v)fail('NOT_FOUND','No visible authorization',404);return authResource(c.s,v);});
 const b=path.match(/^\/wallet\/v1\/scopes\/([A-Za-z0-9_-]{1,128})\/currencies\/([A-Za-z0-9_-]{1,128})\/users\/([A-Za-z0-9_-]{1,128})\/balance$/);if(b){if(b[1]!==key.row.wallet_scope_id||b[2]!==key.row.currency_id)fail('SCOPE_FORBIDDEN','Credential scope/currency differs',403);return withScope(pool,key.row.scope_id,async c=>{const u=await user(c,b[3]);return {...scopeOf(c.s),balance:{external_user_id:u.external_user_id,available_minor:u.available,reserved_minor:u.reserved,currency_scale:c.s.currency_scale,ledger_version:c.s.ledger_version},as_of:now()};});}
 fail('NOT_FOUND','Unknown wallet endpoint',404);
}
export async function ledgerRequest(pool,{scope,method,path,raw='',requestId}){
 for(const field of fields)if(typeof scope?.[field]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(scope[field]))fail('INVALID_REQUEST','Invalid ledger scope',400);
 if(!['GET','POST'].includes(method)||!/^\/wallet\/v1(?:\/[A-Za-z0-9_-]+)+$/.test(path)||typeof raw!=='string'||Buffer.byteLength(raw)>65536||!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)||(method==='GET'&&raw))fail('INVALID_REQUEST','Invalid ledger request',400);
 const key={row:{...scope,scope_id:scopeId(scope)},request_id:requestId};
 if(method==='GET')return{status:200,body:await query(pool,key,path)};
 const body=parseRaw(Buffer.from(raw));
 if(path==='/wallet/v1/events'){
  validate('PartnerEvent',body);checkScope(body.scope,key.row);if(body.request_id!==requestId||body.request_id!==body.event_id)fail('INVALID_REQUEST','Event/request IDs must match',400);
  await withScope(pool,key.row.scope_id,async context=>{
   const old=(await context.db.query('SELECT body_sha256 FROM wallet_events WHERE scope_id=$1 AND event_id=$2',[context.id,body.event_id])).rows[0],digest=sha256(raw);
   if(old&&old.body_sha256!==digest)fail('IDEMPOTENCY_CONFLICT','Event reused with another body');
   await context.db.query('INSERT INTO wallet_events(scope_id,event_id,body_sha256,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[context.id,body.event_id,digest,JSON.stringify(body)]);
  },{expire:false});return{status:204,body:null};
 }
 if(!commands[path])fail('NOT_FOUND','Unknown wallet endpoint',404);
 return execute(pool,key,path,raw,body);
}
export function createWalletServer(pool){
 return http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  const reply=(status,body)=>{res.statusCode=status;res.end(status===204?'':JSON.stringify(body));};
  try{
   if(req.method==='GET'&&req.url==='/health'){await pool.query('SELECT 1');reply(200,{service:'reference-partner-wallet',status:'ok',deployment:'local-reference-not-a-partner-production-wallet'});return;}
   if(!['GET','POST'].includes(req.method)||/[?%#\\]/.test(req.url)||req.url.includes('//')||/\/(\.|\.\.)(\/|$)/.test(req.url))fail('INVALID_REQUEST','Unsupported method/path or query',400);
   if(req.headers['content-encoding'])fail('INVALID_REQUEST','Compressed request bodies unsupported',400);
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)fail('INVALID_REQUEST','Body too large',400);chunks.push(chunk);}const raw=Buffer.concat(chunks);
   if(req.method==='GET'&&raw.length)fail('INVALID_REQUEST','GET body forbidden',400);
   const key=await verifyWalletRequest(pool,req,raw);
   if(req.method==='GET'){reply(200,await query(pool,key,req.url));return;}
   const body=parseRaw(raw);
   if(req.url==='/wallet/v1/events'){
    validate('PartnerEvent',body);checkScope(body.scope,key.row);if(body.request_id!==key.request_id||body.request_id!==body.event_id)fail('INVALID_REQUEST','Event/request IDs must match',400);
    await withScope(pool,key.row.scope_id,async c=>{const old=(await c.db.query('SELECT body_sha256 FROM wallet_events WHERE scope_id=$1 AND event_id=$2',[c.id,body.event_id])).rows[0];const hash=sha256(raw);if(old&&old.body_sha256!==hash)fail('IDEMPOTENCY_CONFLICT','Event reused with another body');await c.db.query('INSERT INTO wallet_events(scope_id,event_id,body_sha256,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[c.id,body.event_id,hash,JSON.stringify(body)]);},{expire:false});reply(204);return;
   }
   if(!commands[req.url])fail('NOT_FOUND','Unknown wallet endpoint',404);
   const result=await execute(pool,key,req.url,raw,body);reply(result.status,result.body);
  }catch(e){const id=/^[A-Za-z0-9_-]{1,128}$/.test(req.headers['x-gp-request-id']||'')?req.headers['x-gp-request-id']:undefined;if(!(e instanceof WalletError))console.error('[reference-wallet]',e.code||e.name,e.message);reply(e instanceof WalletError?e.status:503,errorBody(e,id));}
 });
}

/** Test/reference-only database snapshot. No HTTP route exposes this capability. */
export async function readWalletSnapshot(pool,{scope}){
 return withScope(pool,scopeId(scope),async c=>({scope:scopeOf(c.s),treasury:{available_minor:c.s.treasury_available,reserved_minor:c.s.treasury_reserved,inbound_capacity_minor:c.s.treasury_inbound},fee_minor:c.s.fee_available,fee_pending_minor:c.s.fee_pending,users:(await c.db.query('SELECT external_user_id,available,reserved,credit_pending FROM wallet_users WHERE scope_id=$1 ORDER BY external_user_id',[c.id])).rows,ledger:(await c.db.query('SELECT operation_id,transaction_id,account,delta_available,delta_reserved,meta FROM wallet_ledger WHERE scope_id=$1 ORDER BY id',[c.id])).rows,operations:(await c.db.query('SELECT operation_id,state FROM wallet_operations WHERE scope_id=$1 ORDER BY created_at',[c.id])).rows}));
}
/** Represents the partner App's own gift debit, sharing exactly the game wallet lock/ledger. Never routed over HTTP. */
export async function giftForTest(pool,{scope,request_id,from_user_id,to_user_id,amount_minor}){
 const n=amount(amount_minor,true);if(from_user_id===to_user_id)fail('INVALID_REQUEST','Gift users must differ',400);
 return withScope(pool,scopeId(scope),async c=>{
  c.operationId=request_id;
  const old=(await c.db.query('SELECT meta FROM wallet_ledger WHERE scope_id=$1 AND operation_id=$2 LIMIT 1',[c.id,request_id])).rows[0];const identity={kind:'reference_gift',from_user_id,to_user_id,amount_minor};if(old){if(!same(old.meta,identity))fail('IDEMPOTENCY_CONFLICT','Gift business ID differs');return {state:'SUCCEEDED',replayed:true};}
  const sender=await user(c,from_user_id),receiver=await user(c,to_user_id);if(BigInt(sender.available)<n)fail('INSUFFICIENT_FUNDS','Reserved funds cannot be gifted',422);creditRoom(receiver,n);change(sender,'available',-n);change(receiver,'available',n);await saveUser(c,sender);await saveUser(c,receiver);await ledger(c,'user:'+from_user_id,-n,0n,identity);await ledger(c,'user:'+to_user_id,n,0n,identity);return {state:'SUCCEEDED',replayed:false};
 });
}

async function provisionLedger(db,id,account,value){const transaction_id='wl_'+randomUUID().replaceAll('-','');const operation_id='reference_provision:'+account;const metadata=JSON.stringify({kind:'reference_provision',note:'Local test virtual-coin opening balance, not external settlement'});await db.query('INSERT INTO wallet_ledger(scope_id,operation_id,transaction_id,account,delta_available,meta) VALUES($1,$2,$3,$4,$5,$6),($1,$2,$3,$7,$8,$6)',[id,operation_id,transaction_id,account,value,metadata,'reference_funding',(-BigInt(value)).toString()]);await db.query('UPDATE wallet_scopes SET ledger_version=ledger_version+2 WHERE scope_id=$1',[id]);}
