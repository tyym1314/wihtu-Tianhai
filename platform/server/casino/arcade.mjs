/**
 * Arcade shooters (Monster archery, MoleStar whack-a-mole). A play session is one wallet cycle:
 * open = authorize+accept `shots x bet` (ammo); every shot is resolved on the server with a
 * deterministic RNG; close = settle wins + refund of unused ammo.
 *
 * A weapon costs `cost` bets and strikes up to `targets` targets. Each struck target with
 * multiplier m is captured with probability rtp*cost/(targets*m) and pays m*bet, so every shot
 * returns rtp of its cost whatever the player aims at: choosing targets changes variance, not value.
 */
import {randomBytes,createHash} from 'node:crypto';
import {pool,tx} from '../db.mjs';
import {id,seal,unseal,fail} from '../security.mjs';
import {appById,scope} from '../platform.mjs';
import {command} from '../cycles.mjs';
import {openProbability} from './funding.mjs';
import {assertNewFinancialAdmission} from '../production-admission.mjs';
import {CASINO_GAMES} from '../../shared/casino-games.mjs';
import {createRng} from './rng.mjs';

const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const sha=v=>createHash('sha256').update(v).digest('hex');
const IDLE_MS=120000,MAX_SHOTS=500;

export function arcadeModel(game){
 const a=game.arcade,config={family:'arcade',...a,rng:'HMAC-SHA256 counter'};
 const maxM=Math.max(...a.targets.map(t=>t.max??t.multiplier));
 // A session can win at most every shot hitting the best targets with the widest weapon.
 const liability=Math.ceil(maxM*Math.max(...a.weapons.map(w=>w.targets/w.cost)));
 const hash=sha(canonical(config));
 return Object.freeze({gameId:game.id,version:`${game.id}-arcade-v1-${hash.slice(0,12)}`,hash,maxMultiplier:liability,targetRtp:a.rtp,config});
}
import {RTP_TIERS,tierGame} from './rtp.mjs';
const models=Object.fromEntries(Object.values(CASINO_GAMES).filter(g=>g.family==='arcade').map(g=>[g.id,arcadeModel(g)]));
// Return-rate tiers (see rtp.mjs): extra pinned models per (game, tier).
const tierModels=Object.fromEntries(Object.values(CASINO_GAMES).filter(g=>g.family==='arcade').flatMap(g=>RTP_TIERS.map(t=>{const v=tierGame(g,t);return v?[[`${g.id}:${t}`,arcadeModel(v)]]:[];}).flat()));
const byVersion=new Map([...Object.values(models),...Object.values(tierModels)].map(m=>[m.version,m]));
export const arcadeModels=()=>[...byVersion.values()];
export const arcadeModelFor=(gameId,tier)=>tierModels[`${gameId}:${tier}`]||models[gameId];
export const isArcadeGame=gameId=>CASINO_GAMES[gameId]?.family==='arcade';

/** Resolve one shot: which struck targets are captured and what each pays (multiple of bet x100). */
export function resolveShot(model,seedHex,seq,weaponId,targetIds){
 const c=model.config,w=c.weapons.find(x=>x.id===weaponId);if(!w)fail(400,'INVALID_WEAPON');
 if(!Array.isArray(targetIds)||!targetIds.length||targetIds.length>w.targets)fail(400,'INVALID_TARGETS');
 const rng=createRng(seedHex,`${model.version}:shot:${seq}`),hits=[];
 for(const tid of targetIds){
  const t=c.targets.find(x=>x.id===tid);if(!t)fail(400,'INVALID_TARGET');
  // Ranged targets (treasure wheels) pay a uniform multiplier in [min,max]; capture uses the mean.
  const mean=t.multiplier??(t.min+t.max)/2,p=c.rtp*w.cost/(w.targets*mean);
  if(rng.int(1_000_000)<Math.round(p*1_000_000)){const m=t.multiplier??t.min+rng.int(t.max-t.min+1);hits.push({target:tid,multiplier:m});}
  else rng.int(2);
 }
 return {cost:w.cost,hits,win_x100:hits.reduce((a,h)=>a+h.multiplier*100,0)};
}

export async function migrateArcade(db=pool){
 await db.query(`CREATE TABLE IF NOT EXISTS casino_arcade (
  id text PRIMARY KEY, app_id text NOT NULL REFERENCES gp_apps(id), session_id text NOT NULL, external_user_id text NOT NULL, request_id text NOT NULL,
  game_id text NOT NULL, bet_minor bigint NOT NULL CHECK(bet_minor>0), shots integer NOT NULL CHECK(shots>0), used integer NOT NULL DEFAULT 0,
  win_minor bigint NOT NULL DEFAULT 0, math_version text NOT NULL, math_hash text NOT NULL, seed_enc text NOT NULL, commitment text NOT NULL,
  status text NOT NULL CHECK(status IN ('AUTHORIZING','OPEN','CLOSING','SETTLED','REJECTED')), last_shot_at timestamptz NOT NULL DEFAULT now(), error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id,external_user_id,request_id));
 CREATE TABLE IF NOT EXISTS casino_arcade_shots (arcade_id text NOT NULL REFERENCES casino_arcade(id), seq integer NOT NULL, weapon text NOT NULL, cost integer NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(arcade_id,seq));
 CREATE INDEX IF NOT EXISTS casino_arcade_app_created ON casino_arcade(app_id,created_at);
 CREATE INDEX IF NOT EXISTS casino_arcade_open ON casino_arcade(status,last_shot_at) WHERE status NOT IN ('SETTLED','REJECTED');`);
}

const base=(app,a)=>({...scope(app),authorization_id:'auth_'+a.id,cycle_id:a.id});
const view=a=>({id:a.id,status:a.status,bet_minor:String(a.bet_minor),shots:a.shots,used:a.used,win_minor:String(a.win_minor),commitment:a.commitment,...(a.status==='SETTLED'?{seed:unseal(a.seed_enc)}:{})});

/** Ammo purchase: authorize + accept, idempotent by request id; a wallet rejection (or an expired hold) rejects the session. */
async function authorize(app,a){
 const model=byVersion.get(a.math_version);if(!model||model.hash!==a.math_hash)fail(503,'PINNED_MATH_UNAVAILABLE');
 const stake=BigInt(a.bet_minor)*BigInt(a.shots);
 try{
  await openProbability(app,a.id,{...base(app,a),external_user_id:a.external_user_id,game_id:a.game_id,math_version:model.version,math_config_hash:model.hash,
   stake_minor:String(stake),max_payout_minor:String(stake*BigInt(model.maxMultiplier)),expires_at:new Date(Date.now()+60000).toISOString()});
  return (await pool.query("UPDATE casino_arcade SET status='OPEN',last_shot_at=now(),updated_at=now() WHERE id=$1 AND status='AUTHORIZING' RETURNING *",[a.id])).rows[0]||(await pool.query('SELECT * FROM casino_arcade WHERE id=$1',[a.id])).rows[0];
 }catch(e){
  if(e.status===409)return (await pool.query("UPDATE casino_arcade SET status='REJECTED',error=$2,updated_at=now() WHERE id=$1 AND status='AUTHORIZING' RETURNING *",[a.id,e.code||'WALLET_REJECTED'])).rows[0]||(await pool.query('SELECT * FROM casino_arcade WHERE id=$1',[a.id])).rows[0];
  if(e.status===503&&e.code==='PINNED_MATH_UNAVAILABLE')throw e;
  await pool.query('UPDATE casino_arcade SET updated_at=now() WHERE id=$1',[a.id]);return a;
 }
}

export async function openArcade(session,body){
 const game=CASINO_GAMES[session.game_id];if(game?.family!=='arcade')fail(403,'GAME_SESSION_REQUIRED');
 if(!/^[A-Za-z0-9_-]{8,128}$/.test(body.request_id||'')||!game.arcade.bets.includes(body.bet_minor)||!Number.isSafeInteger(body.shots)||body.shots<1||body.shots>MAX_SHOTS)fail(400,'INVALID_REQUEST');
 const app=await appById(session.app_id),model=tierModels[`${game.id}:${app.math_profile}`]||models[game.id];
 let a=(await pool.query('SELECT * FROM casino_arcade WHERE app_id=$1 AND external_user_id=$2 AND request_id=$3',[app.id,session.external_user_id,body.request_id])).rows[0];
 if(a&&(String(a.bet_minor)!==body.bet_minor||a.shots!==body.shots))fail(409,'IDEMPOTENCY_CONFLICT');
 if(!a){
  await assertNewFinancialAdmission(pool,app,{gameId:game.id});
  if((await pool.query("SELECT 1 FROM casino_arcade WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 AND status IN ('AUTHORIZING','OPEN','CLOSING')",[app.id,session.external_user_id,game.id])).rowCount)fail(409,'ARCADE_OPEN');
  const seed=randomBytes(32).toString('hex');
  a=(await pool.query("INSERT INTO casino_arcade(id,app_id,session_id,external_user_id,request_id,game_id,bet_minor,shots,math_version,math_hash,seed_enc,commitment,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'AUTHORIZING') RETURNING *",
   [id('arc'),app.id,session.id,session.external_user_id,body.request_id,game.id,body.bet_minor,body.shots,model.version,model.hash,seal(seed),sha(seed)])).rows[0];
 }
 if(a.status==='AUTHORIZING'){a=await authorize(app,a);if(a.status==='AUTHORIZING')fail(503,'WALLET_PENDING');}
 if(a.status==='REJECTED')fail(409,a.error||'WALLET_REJECTED');
 return view(a);
}

export async function shoot(session,body){
 const game=CASINO_GAMES[session.game_id];if(game?.family!=='arcade')fail(403,'GAME_SESSION_REQUIRED');
 if(typeof body.arcade_id!=='string'||!Number.isSafeInteger(body.seq)||body.seq<1)fail(400,'INVALID_REQUEST');
 return tx(async c=>{
  const a=(await c.query('SELECT * FROM casino_arcade WHERE id=$1 AND app_id=$2 AND external_user_id=$3 FOR UPDATE',[body.arcade_id,session.app_id,session.external_user_id])).rows[0];
  if(!a)fail(404,'ARCADE_NOT_FOUND');
  const prior=(await c.query('SELECT * FROM casino_arcade_shots WHERE arcade_id=$1 AND seq=$2',[a.id,body.seq])).rows[0];
  if(prior)return {seq:prior.seq,...prior.result,used:a.used,win_minor:String(a.win_minor)};
  if(a.status!=='OPEN')fail(409,'ARCADE_CLOSED');
  if(body.seq!==await nextSeq(c,a.id))fail(409,'SHOT_OUT_OF_ORDER');
  const model=byVersion.get(a.math_version);if(!model||model.hash!==a.math_hash)fail(503,'PINNED_MATH_UNAVAILABLE');
  const r=resolveShot(model,unseal(a.seed_enc),body.seq,body.weapon,body.targets);
  if(a.used+r.cost>a.shots)fail(409,'OUT_OF_AMMO');
  const win=BigInt(a.bet_minor)*BigInt(r.win_x100)/100n;
  await c.query('INSERT INTO casino_arcade_shots(arcade_id,seq,weapon,cost,result) VALUES($1,$2,$3,$4,$5)',[a.id,body.seq,body.weapon,r.cost,r]);
  const u=(await c.query('UPDATE casino_arcade SET used=used+$2,win_minor=win_minor+$3,last_shot_at=now(),updated_at=now() WHERE id=$1 RETURNING used,win_minor',[a.id,r.cost,String(win)])).rows[0];
  return {seq:body.seq,...r,win_minor_shot:String(win),used:u.used,win_minor:String(u.win_minor)};
 });
}
const nextSeq=async(c,id)=>Number((await c.query('SELECT COALESCE(max(seq),0)+1 n FROM casino_arcade_shots WHERE arcade_id=$1',[id])).rows[0].n);

/** Close: credit wins plus unused ammo in one settle. Idempotent; recovery closes idle sessions. */
export async function closeArcade(session,body){
 const a=(await pool.query('SELECT * FROM casino_arcade WHERE id=$1 AND app_id=$2 AND external_user_id=$3',[body.arcade_id,session.app_id,session.external_user_id])).rows[0];
 if(!a)fail(404,'ARCADE_NOT_FOUND');return view(await settle(await appById(a.app_id),a));
}
async function settle(app,a){
 if(a.status==='OPEN')a=(await pool.query("UPDATE casino_arcade SET status='CLOSING',updated_at=now() WHERE id=$1 AND status='OPEN' RETURNING *",[a.id])).rows[0]||(await pool.query('SELECT * FROM casino_arcade WHERE id=$1',[a.id])).rows[0];
 if(a.status!=='CLOSING')return a;
 const model=byVersion.get(a.math_version),stake=BigInt(a.bet_minor)*BigInt(a.shots),gross=BigInt(a.win_minor)+BigInt(a.bet_minor)*BigInt(a.shots-a.used);
 const shots=(await pool.query('SELECT seq,weapon,result FROM casino_arcade_shots WHERE arcade_id=$1 ORDER BY seq',[a.id])).rows;
 await command(app,a.id,'/wallet/v1/probability/settle',{...base(app,a),request_id:'settle_'+a.id,game_id:a.game_id,math_version:model.version,math_config_hash:model.hash,
  stake_minor:String(stake),gross_payout_minor:String(gross),result_hash:sha(JSON.stringify(shots))});
 return (await pool.query("UPDATE casino_arcade SET status='SETTLED',updated_at=now() WHERE id=$1 RETURNING *",[a.id])).rows[0];
}
export async function recoverArcade(){
 const open=(await pool.query("SELECT * FROM casino_arcade WHERE (status='OPEN' AND last_shot_at<now()-$1::int*interval '1 millisecond') OR (status='CLOSING' AND updated_at<now()-interval '3 seconds') LIMIT 50",[IDLE_MS])).rows;
 for(const a of open){try{await settle(await appById(a.app_id),a);}catch{}}
 // An ammo purchase whose wallet outcome was unknown is retried with the same request ids.
 for(const a of (await pool.query("SELECT * FROM casino_arcade WHERE status='AUTHORIZING' AND updated_at<now()-interval '3 seconds' ORDER BY updated_at LIMIT 50")).rows){try{await authorize(await appById(a.app_id),a);}catch{}}
}
