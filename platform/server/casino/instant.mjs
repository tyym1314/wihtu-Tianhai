/**
 * Instant casino games (slots): each paid spin is one wallet probability cycle.
 * authorize (stake + max payout) -> accept -> fix the complete result (base + free spins) -> settle.
 * The result is fixed only after acceptance is persisted; recovery replays the same operations.
 */
import {randomBytes,createHash} from 'node:crypto';
import {pool} from '../db.mjs';
import {id,seal,unseal,fail} from '../security.mjs';
import {appById,scope} from '../platform.mjs';
import {command,walletBalance} from '../cycles.mjs';
import {assertNewFinancialAdmission} from '../production-admission.mjs';
import {CASINO_GAMES} from '../../shared/casino-games.mjs';
import {slotModel,playSlotCycle} from './slots.mjs';
import {linesModel,playLinesCycle} from './slot-lines.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
// Slot pay types: 'anywhere' tumbles (slots.mjs); 'lines' and 'ways' (slot-lines.mjs).
const engines={anywhere:{model:slotModel,play:playSlotCycle},lines:{model:linesModel,play:playLinesCycle},ways:{model:linesModel,play:playLinesCycle}};
const engineOf=g=>engines[g.slot.pay];
const models=Object.fromEntries(Object.values(CASINO_GAMES).filter(g=>g.kind==='instant').map(g=>[g.id,engineOf(g).model(g)]));
export const instantModels=()=>Object.values(models);
export const isInstantGame=gameId=>CASINO_GAMES[gameId]?.kind==='instant';

export async function migrateInstant(db=pool){
 await db.query(`CREATE TABLE IF NOT EXISTS casino_spins (
  id text PRIMARY KEY, app_id text NOT NULL REFERENCES gp_apps(id), session_id text NOT NULL, external_user_id text NOT NULL, request_id text NOT NULL,
  game_id text NOT NULL, stake_minor bigint NOT NULL CHECK(stake_minor>0), math_version text NOT NULL, math_hash text NOT NULL,
  status text NOT NULL,
  seed_enc text, result jsonb, payout_minor bigint, error text, attempts integer NOT NULL DEFAULT 0, mode text NOT NULL DEFAULT 'normal', base_stake_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id,external_user_id,request_id));
 ALTER TABLE casino_spins ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'normal';
 ALTER TABLE casino_spins ADD COLUMN IF NOT EXISTS base_stake_minor bigint;
 ALTER TABLE casino_spins DROP CONSTRAINT IF EXISTS casino_spins_status_check;
 ALTER TABLE casino_spins ADD CONSTRAINT casino_spins_status_check CHECK(status IN ('AUTHORIZING','ACCEPTED','CHOOSING','RESULT_FIXED','SETTLED','REJECTED'));
 CREATE INDEX IF NOT EXISTS casino_spins_open ON casino_spins(status,updated_at) WHERE status NOT IN ('SETTLED','REJECTED');`);
}

const view=s=>({id:s.id,request_id:s.request_id,status:s.status,mode:s.mode||'normal',stake_minor:String(s.stake_minor),base_stake_minor:String(s.base_stake_minor??s.stake_minor),
 ...(s.result&&['RESULT_FIXED','SETTLED','CHOOSING'].includes(s.status)?{result:s.result,payout_minor:s.status==='CHOOSING'?null:String(s.payout_minor)}:{}),error:s.error||null});

export async function instantState(session,{balance=false}={}){
 const app=await appById(session.app_id);
 const recent=(await pool.query("SELECT * FROM casino_spins WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 ORDER BY created_at DESC LIMIT 1",[app.id,session.external_user_id,session.game_id])).rows[0];
 const out={game_id:session.game_id,kind:'instant',server_now:Date.now(),me:session.external_user_id,last_spin:recent?view(recent):null};
 if(balance){try{out.balance=(await walletBalance(app,session.external_user_id)).balance;}catch{out.balance=null;}}
 return out;
}

export async function spin(session,body){
 const game=CASINO_GAMES[session.game_id];if(game?.kind!=='instant')fail(403,'GAME_SESSION_REQUIRED');
 if(!/^[A-Za-z0-9_-]{8,128}$/.test(body.request_id||'')||typeof body.stake_minor!=='string')fail(400,'INVALID_REQUEST');
 if(!game.stakes.includes(body.stake_minor))fail(400,'INVALID_STAKE');
 if(body.buy!==undefined&&(body.buy!==true||!game.slot?.buy))fail(400,'INVALID_REQUEST');
 // stake_minor is the base stake; a feature buy debits base x price.
 const mode=body.buy?'buy':'normal',walletStake=mode==='buy'?BigInt(body.stake_minor)*BigInt(game.slot.buy.price_x100)/100n:BigInt(body.stake_minor);
 const app=await appById(session.app_id),model=models[game.id];
 let s=(await pool.query('SELECT * FROM casino_spins WHERE app_id=$1 AND external_user_id=$2 AND request_id=$3',[app.id,session.external_user_id,body.request_id])).rows[0];
 if(s&&(s.game_id!==game.id||String(s.base_stake_minor??s.stake_minor)!==body.stake_minor||(s.mode||'normal')!==mode))fail(409,'IDEMPOTENCY_CONFLICT');
 if(!s){
  await assertNewFinancialAdmission(pool,app,{gameId:game.id});
  const busy=(await pool.query("SELECT 1 FROM casino_spins WHERE app_id=$1 AND external_user_id=$2 AND status NOT IN ('SETTLED','REJECTED') LIMIT 1",[app.id,session.external_user_id])).rowCount;
  if(busy)fail(409,'SPIN_PENDING');
  s=(await pool.query("INSERT INTO casino_spins(id,app_id,session_id,external_user_id,request_id,game_id,stake_minor,math_version,math_hash,status,mode,base_stake_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'AUTHORIZING',$10,$11) RETURNING *",
   [id('spin'),app.id,session.id,session.external_user_id,body.request_id,game.id,String(walletStake),model.version,model.hash,mode,body.stake_minor])).rows[0];
 }
 s=await advance(app,s);
 if(s.status==='REJECTED')fail(409,s.error||'WALLET_REJECTED');
 if(!['RESULT_FIXED','SETTLED','CHOOSING'].includes(s.status))fail(503,'WALLET_PENDING');
 return view(s);
}

async function advance(app,s){
 const model=models[s.game_id];if(!model||model.version!==s.math_version||model.hash!==s.math_hash)fail(503,'PINNED_MATH_UNAVAILABLE');
 const base={...scope(app),authorization_id:'auth_'+s.id,cycle_id:s.id};
 try{
  if(s.status==='AUTHORIZING'){
   await command(app,s.id,'/wallet/v1/probability/authorize',{...base,request_id:'authorize_'+s.id,external_user_id:s.external_user_id,game_id:s.game_id,math_version:model.version,math_config_hash:model.hash,
    stake_minor:String(s.stake_minor),max_payout_minor:String(BigInt(s.stake_minor)*BigInt(model.maxMultiplier)),expires_at:new Date(Date.now()+60000).toISOString()});
   await command(app,s.id,'/wallet/v1/probability/accept',{...base,request_id:'accept_'+s.id});
   s=(await pool.query("UPDATE casino_spins SET status='ACCEPTED',updated_at=now() WHERE id=$1 AND status='AUTHORIZING' RETURNING *",[s.id])).rows[0]||(await pool.query('SELECT * FROM casino_spins WHERE id=$1',[s.id])).rows[0];
  }
  if(s.status==='ACCEPTED'){
   // No RNG before acceptance is persisted; afterwards every caller reads this one result.
   const seed=randomBytes(32).toString('hex'),result=engineOf(CASINO_GAMES[s.game_id]).play(model,seed,String(s.base_stake_minor??s.stake_minor),{buy:s.mode==='buy'});
   if(BigInt(result.gross_payout_minor)>BigInt(s.stake_minor)*BigInt(model.maxMultiplier))throw new Error('casino liability invariant');
   // A feature with a player choice waits in CHOOSING; the seed is fixed, so the base spin never changes.
   s=(await pool.query("UPDATE casino_spins SET status=$5,seed_enc=$2,result=$3,payout_minor=$4,updated_at=now() WHERE id=$1 AND status='ACCEPTED' RETURNING *",[s.id,seal(seed),result,result.gross_payout_minor,result.pending?'CHOOSING':'RESULT_FIXED'])).rows[0]||(await pool.query('SELECT * FROM casino_spins WHERE id=$1',[s.id])).rows[0];
  }
  if(s.status==='RESULT_FIXED'){
   await command(app,s.id,'/wallet/v1/probability/settle',{...base,request_id:'settle_'+s.id,game_id:s.game_id,math_version:model.version,math_config_hash:model.hash,
    stake_minor:String(s.stake_minor),gross_payout_minor:String(s.payout_minor),result_hash:sha(JSON.stringify(s.result))});
   s=(await pool.query("UPDATE casino_spins SET status='SETTLED',error=NULL,updated_at=now() WHERE id=$1 RETURNING *",[s.id])).rows[0];
  }
 }catch(e){
  if(e.status===409&&s.status==='AUTHORIZING')return (await pool.query("UPDATE casino_spins SET status='REJECTED',error=$2,updated_at=now() WHERE id=$1 AND status='AUTHORIZING' RETURNING *",[s.id,e.code||'WALLET_REJECTED'])).rows[0]||s;
  await pool.query('UPDATE casino_spins SET error=$2,attempts=attempts+1,updated_at=now() WHERE id=$1',[s.id,String(e.code||e.message).slice(0,80)]);
 }
 return s;
}

/** Pick a free spins option for a CHOOSING spin; the complete result is then fixed and settled. */
export async function choose(session,body){
 const s=(await pool.query('SELECT * FROM casino_spins WHERE id=$1 AND app_id=$2 AND external_user_id=$3',[body.spin_id,session.app_id,session.external_user_id])).rows[0];
 if(!s)fail(404,'SPIN_NOT_FOUND');if(s.status!=='CHOOSING'){if(['RESULT_FIXED','SETTLED'].includes(s.status))return view(s);fail(409,'SPIN_NOT_CHOOSING');}
 if(!Number.isSafeInteger(body.choice))fail(400,'INVALID_CHOICE');
 return view(await decide(s,body.choice));
}
async function decide(s,choice){
 const model=models[s.game_id],result=engineOf(CASINO_GAMES[s.game_id]).play(model,unseal(s.seed_enc),String(s.base_stake_minor??s.stake_minor),{choice});
 if(BigInt(result.gross_payout_minor)>BigInt(s.stake_minor)*BigInt(model.maxMultiplier))throw new Error('casino liability invariant');
 const fixed=(await pool.query("UPDATE casino_spins SET status='RESULT_FIXED',result=$2,payout_minor=$3,updated_at=now() WHERE id=$1 AND status='CHOOSING' RETURNING *",[s.id,result,result.gross_payout_minor])).rows[0]||(await pool.query('SELECT * FROM casino_spins WHERE id=$1',[s.id])).rows[0];
 return advance(await appById(fixed.app_id),fixed);
}

/** Recovery: resume spins whose wallet steps did not finish (the client sees the result once fixed). */
export async function recoverInstant(){
 const open=(await pool.query("SELECT * FROM casino_spins WHERE status NOT IN ('SETTLED','REJECTED','CHOOSING') AND updated_at<now()-interval '3 seconds' ORDER BY updated_at LIMIT 50")).rows;
 for(const s of open){try{await advance(await appById(s.app_id),s);}catch{}}
 // An unanswered choice falls back to the first option after a minute.
 for(const s of (await pool.query("SELECT * FROM casino_spins WHERE status='CHOOSING' AND updated_at<now()-interval '60 seconds' LIMIT 50")).rows){try{await decide(s,0);}catch{}}
}
export {unseal};
