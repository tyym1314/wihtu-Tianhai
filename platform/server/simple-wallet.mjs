/**
 * Simple partner wallet protocol (simple-v1): the partner implements only
 *   GET  /wallet/simple/v1/users/{external_user_id}/balance
 *   POST /wallet/simple/v1/debit    (idempotent by request_id; may reject INSUFFICIENT_FUNDS)
 *   POST /wallet/simple/v1/credit   (idempotent by request_id; never rejects)
 *
 * The platform keeps every escrow state (reserve, capture, release, settle, probability
 * liability) in its own internal ledger for this App. Money enters the user's internal
 * transit account only through a confirmed partner debit ("in" leg), and every amount
 * that becomes available again (payouts, refunds, cancelled stakes) is held and returned
 * through a partner credit ("out" leg). Transit balances therefore net back to zero.
 */
import {randomUUID} from 'node:crypto';
import {ledgerRequest,withTransferLedger} from './wallet/index.mjs';
import {WalletError} from './wallet/security.mjs';
import {fail} from './security.mjs';
import {getProfile} from './math/index.ts';
import {signedPartnerRequest} from './wallet-binding.mjs';

export const SIMPLE_PROTOCOL='simple-v1';
const fields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const scopeOf=app=>({partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id});
const scopeId=app=>fields.map(k=>scopeOf(app)[k]).join(':');
const CLEARING='clearing:partner-wallet';
// Internal accounting only: liability holds never limit play; the partner is the house.
const INTERNAL_TREASURY='4000000000000000000';
const DEPOSIT_GRACE='2 minutes';
const retryDelay=attempts=>Math.min(300000,2000*2**Math.min(7,attempts));
const id=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const amount=s=>typeof s==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(s);

export async function migrateSimpleWallet(db){
 await db.query(`CREATE TABLE IF NOT EXISTS gp_simple_wallet_legs (
  id text PRIMARY KEY, app_id text NOT NULL REFERENCES gp_apps(id), direction text NOT NULL CHECK(direction IN ('in','out')),
  operation_id text, external_user_id text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
  reason text NOT NULL, reference_id text, game_id text,
  state text NOT NULL CHECK(state IN ('PENDING','APPLIED','FORWARDED','REJECTED','HELD','DONE')),
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS gp_simple_wallet_legs_due ON gp_simple_wallet_legs(state,next_attempt_at) WHERE state IN ('PENDING','HELD');
  CREATE INDEX IF NOT EXISTS gp_simple_wallet_legs_user ON gp_simple_wallet_legs(app_id,external_user_id,state);`);
}

/** Inside the binding transaction: open this App's internal escrow ledger. */
export async function createSimpleWalletScope(db,app){
 await db.query(`INSERT INTO wallet_scopes(scope_id,partner_id,app_id,environment,wallet_scope_id,currency_id,currency_scale,treasury_available)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[scopeId(app),app.partner_id,app.id,app.environment,app.wallet_scope_id,app.currency_id,app.currency_scale,INTERNAL_TREASURY]);
 for(const game of ['thunder','tiger'])for(const tier of ['98','99']){const m=getProfile(game,tier);
  await db.query('INSERT INTO wallet_math_profiles(scope_id,game_id,math_version,math_config_hash,max_payout_multiplier) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[scopeId(app),game,m.version,m.hash,String(m.maxMultiplier)]);}
}

async function internal(db,app,method,path,raw,requestId){
 try{return(await ledgerRequest(db,{scope:scopeOf(app),method,path,raw,requestId})).body;}
 catch(error){if(error instanceof WalletError)fail(error.status,error.code,error.message);throw error;}
}

/** One signed partner call. Returns {outcome:'SUCCEEDED'|'REJECTED'|'UNKNOWN', code, body}. */
async function partner(app,binding,path,body){
 const raw=JSON.stringify(body);
 try{
  const {status,body:res}=await signedPartnerRequest(app,binding,'POST',path,raw,body.request_id);
  if(res?.request_id!==body.request_id||!['SUCCEEDED','REJECTED'].includes(res?.status))return{outcome:'UNKNOWN',code:'WALLET_INVALID_RESPONSE'};
  if(res.status==='SUCCEEDED'&&status<300)return{outcome:'SUCCEEDED',body:res};
  if(res.status==='REJECTED')return{outcome:'REJECTED',code:typeof res.code==='string'?res.code.slice(0,64):'WALLET_REJECTED'};
  return{outcome:'UNKNOWN',code:'WALLET_INVALID_RESPONSE'};
 }catch(error){return{outcome:'UNKNOWN',code:error.code||'WALLET_UNKNOWN'};}
}
async function ensureUser(db,app,user){await db.query('INSERT INTO wallet_users(scope_id,external_user_id,available) VALUES($1,$2,0) ON CONFLICT DO NOTHING',[scopeId(app),user]);}
async function backoff(db,leg,code){await db.query("UPDATE gp_simple_wallet_legs SET attempts=attempts+1,next_attempt_at=now()+$2::int*interval '1 millisecond',last_error=$3,updated_at=now() WHERE id=$1",[leg.id,retryDelay(leg.attempts),code]);}

async function attemptDebit(db,app,binding,leg){
 const r=await partner(app,binding,'/wallet/simple/v1/debit',{request_id:leg.id,external_user_id:leg.external_user_id,amount_minor:String(leg.amount_minor),currency_id:app.currency_id,reason:leg.reason,reference_id:leg.reference_id,game_id:leg.game_id});
 if(r.outcome==='UNKNOWN'){await backoff(db,leg,r.code);return{...leg,state:'PENDING'};}
 if(r.outcome==='REJECTED'){await db.query("UPDATE gp_simple_wallet_legs SET state='REJECTED',last_error=$2,updated_at=now() WHERE id=$1 AND state='PENDING'",[leg.id,r.code]);return{...leg,state:'REJECTED',code:r.code};}
 await ensureUser(db,app,leg.external_user_id);
 await withTransferLedger(db,scopeOf(app),leg.id,async t=>{
  const current=(await t.db.query('SELECT state FROM gp_simple_wallet_legs WHERE id=$1 FOR UPDATE',[leg.id])).rows[0];if(current?.state!=='PENDING')return;
  await t.hold(leg.external_user_id,'IN',String(leg.amount_minor));await t.finish(leg.external_user_id,'IN',String(leg.amount_minor),true,CLEARING);
  await t.db.query("UPDATE gp_simple_wallet_legs SET state='APPLIED',updated_at=now() WHERE id=$1",[leg.id]);
 });
 return{...leg,state:'APPLIED'};
}

async function attemptCredit(db,app,binding,leg){
 const r=await partner(app,binding,'/wallet/simple/v1/credit',{request_id:leg.id,external_user_id:leg.external_user_id,amount_minor:String(leg.amount_minor),currency_id:app.currency_id,reason:leg.reason,reference_id:leg.reference_id,game_id:leg.game_id});
 // A credit is a payment owed to the player: it is retried until the partner confirms it.
 if(r.outcome!=='SUCCEEDED'){await backoff(db,leg,r.code);return false;}
 await withTransferLedger(db,scopeOf(app),leg.id,async t=>{
  const current=(await t.db.query('SELECT state FROM gp_simple_wallet_legs WHERE id=$1 FOR UPDATE',[leg.id])).rows[0];if(current?.state!=='HELD')return;
  await t.finish(leg.external_user_id,'OUT',String(leg.amount_minor),true,CLEARING);
  await t.db.query("UPDATE gp_simple_wallet_legs SET state='DONE',updated_at=now() WHERE id=$1",[leg.id]);
 });
 return true;
}

/** Return a user's whole internal available balance to the partner, unless a fresh deposit awaits its command. */
export async function sweepUser(db,app,binding,user,{reason='payout',reference=null,game=null}={}){
 const busy=(await db.query(`SELECT 1 FROM gp_simple_wallet_legs WHERE app_id=$1 AND external_user_id=$2 AND direction='in' AND state='APPLIED' AND updated_at>now()-interval '${DEPOSIT_GRACE}' LIMIT 1`,[app.id,user])).rowCount;
 if(busy)return null;
 const legId='out_'+randomUUID().replaceAll('-','');let held=null;
 try{
  await withTransferLedger(db,scopeOf(app),legId,async t=>{
   const row=(await t.db.query('SELECT available FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2',[scopeId(app),user])).rows[0];
   if(!row||BigInt(row.available)<=0n)return;
   await t.hold(user,'OUT',String(row.available));
   await t.db.query("INSERT INTO gp_simple_wallet_legs(id,app_id,direction,external_user_id,amount_minor,reason,reference_id,game_id,state) VALUES($1,$2,'out',$3,$4,$5,$6,$7,'HELD')",[legId,app.id,user,String(row.available),reason,reference,game]);
   held={id:legId,app_id:app.id,external_user_id:user,amount_minor:String(row.available),reason,reference_id:reference,game_id:game,attempts:0};
  });
 }catch(error){if(error.code==='INSUFFICIENT_FUNDS')return null;throw error;}
 if(held)await attemptCredit(db,app,binding,held);
 return held;
}

const DEBITS={'/wallet/v1/reservations':b=>({amount:b.amount_minor,reason:'match_entry',reference:b.match_id,game:b.terms?.game_id}),
 '/wallet/v1/probability/authorize':b=>({amount:b.stake_minor,reason:'spin_bet',reference:b.cycle_id,game:b.game_id})};
const CREDIT_REASON={'/wallet/v1/matches/release':'match_refund','/wallet/v1/matches/settle':'match_payout','/wallet/v1/probability/settle':'spin_win','/wallet/v1/probability/cancel':'spin_refund'};

/** The rich command protocol, served by the internal ledger and funded through simple-v1. */
export async function simpleWalletRequest(db,app,binding,method,path,raw,requestId){
 const balance=path.match(/^\/wallet\/v1\/scopes\/([A-Za-z0-9_-]+)\/currencies\/([A-Za-z0-9_-]+)\/users\/([A-Za-z0-9_-]+)\/balance$/);
 if(method==='GET'&&balance){
  if(balance[1]!==app.wallet_scope_id||balance[2]!==app.currency_id)fail(403,'SCOPE_FORBIDDEN');
  const user=balance[3],{status,body}=await signedPartnerRequest(app,binding,'GET',`/wallet/simple/v1/users/${user}/balance`,'',requestId);
  if(status!==200||body?.external_user_id!==user||!amount(body.available_minor))fail(503,'WALLET_INVALID_BALANCE');
  if(body.currency_scale!==undefined&&body.currency_scale!==app.currency_scale)fail(503,'WALLET_INVALID_BALANCE');
  return{...scopeOf(app),balance:{external_user_id:user,available_minor:body.available_minor,reserved_minor:'0',currency_scale:app.currency_scale,ledger_version:'0'},as_of:new Date().toISOString()};
 }
 if(method==='GET')return internal(db,app,method,path,raw,requestId);
 const body=JSON.parse(raw),debit=DEBITS[path];
 if(debit){
  const d=debit(body);if(!id(body.external_user_id)||!amount(d.amount)||d.amount==='0')fail(400,'INVALID_REQUEST');
  const done=(await db.query("SELECT 1 FROM wallet_operations WHERE scope_id=$1 AND operation_id=$2 AND state<>'PENDING'",[scopeId(app),requestId])).rowCount;
  if(!done){
   const legId='in_'+requestId;
   await db.query("INSERT INTO gp_simple_wallet_legs(id,app_id,direction,operation_id,external_user_id,amount_minor,reason,reference_id,game_id,state) VALUES($1,$2,'in',$3,$4,$5,$6,$7,$8,'PENDING') ON CONFLICT DO NOTHING",[legId,app.id,requestId,body.external_user_id,d.amount,d.reason,d.reference||null,d.game||null]);
   let leg=(await db.query('SELECT * FROM gp_simple_wallet_legs WHERE id=$1',[legId])).rows[0];
   if(leg.app_id!==app.id||leg.external_user_id!==body.external_user_id||String(leg.amount_minor)!==d.amount)fail(409,'IDEMPOTENCY_CONFLICT');
   if(leg.state==='PENDING')leg=await attemptDebit(db,app,binding,leg);
   if(leg.state==='PENDING')fail(503,'WALLET_UNKNOWN','Partner debit outcome is unknown; the original request is retried');
  }
  // A rejected partner debit leaves no transit funds, so the internal ledger rejects with INSUFFICIENT_FUNDS.
  const result=await internal(db,app,method,path,raw,requestId);
  await db.query("UPDATE gp_simple_wallet_legs SET state='FORWARDED',updated_at=now() WHERE id=$1 AND state='APPLIED'",['in_'+requestId]);
  if(result?.state==='REJECTED')await sweepUser(db,app,binding,body.external_user_id,{reason:'refund',reference:d.reference,game:d.game}).catch(()=>{});
  return result;
 }
 const result=await internal(db,app,method,path,raw,requestId);
 if(result?.state==='SUCCEEDED'&&CREDIT_REASON[path]){
  const users=(await db.query("SELECT DISTINCT substr(account,6) AS user FROM wallet_ledger WHERE scope_id=$1 AND operation_id=$2 AND account LIKE 'user:%' AND delta_available>0",[scopeId(app),requestId])).rows;
  for(const {user} of users)await sweepUser(db,app,binding,user,{reason:CREDIT_REASON[path],reference:body.match_id||body.cycle_id||null,game:body.game_id||null}).catch(()=>{});
 }
 return result;
}

/** Background: settle uncertain debits, retry owed credits, return any stranded transit funds. */
export async function recoverSimpleWallets(db,loadBinding){
 const legs=(await db.query("SELECT l.* FROM gp_simple_wallet_legs l WHERE l.state IN ('PENDING','HELD') AND l.next_attempt_at<=now() ORDER BY l.next_attempt_at LIMIT 50")).rows;
 for(const leg of legs){
  const ctx=await loadBinding(leg.app_id);if(!ctx)continue;
  try{if(leg.state==='PENDING')await attemptDebit(db,ctx.app,ctx.binding,leg);else await attemptCredit(db,ctx.app,ctx.binding,leg);}catch{}
 }
 const stranded=(await db.query(`SELECT b.app_id,u.external_user_id FROM gp_wallet_bindings b JOIN wallet_users u
  ON u.scope_id=concat_ws(':',b.scope->>'partner_id',b.scope->>'app_id',b.scope->>'environment',b.scope->>'wallet_scope_id',b.scope->>'currency_id')
  WHERE b.provider='simple' AND u.available>0 LIMIT 50`)).rows;
 for(const s of stranded){const ctx=await loadBinding(s.app_id);if(ctx)try{await sweepUser(db,ctx.app,ctx.binding,s.external_user_id,{reason:'refund'});}catch{}}
}
