/**
 * Shared-round casino games. Every App has its own continuous round per game:
 * betting -> drawing (result fixed, animation) -> settled. A round is created only while
 * someone in that App is watching. Each bet is one wallet probability cycle:
 * authorize+accept at bet time (debits the stake), settle after the result (credits the payout).
 */
import {randomBytes,createHash} from 'node:crypto';
import {pool,tx} from '../db.mjs';
import {id,seal,unseal,fail} from '../security.mjs';
import {appById,scope} from '../platform.mjs';
import {command,walletBalance} from '../cycles.mjs';
import {openProbability,MERGED_PROBABILITY} from './funding.mjs';
import {assertNewFinancialAdmission} from '../production-admission.mjs';
import {CASINO_GAMES,isCasinoGame} from '../../shared/casino-games.mjs';
import {wheelModel,drawWheel,wheelPayout} from './wheel.mjs';
import {crashModel,drawCrash,crashPayout,multiplierAt,timeToReach} from './crash.mjs';
import {cards3Model,drawCards3,cards3Payout} from './cards3.mjs';
import {getProfile,PROFILE_NAMES} from '../math/index.ts';
import {RTP_TIERS,tierGame} from './rtp.mjs';
import {instantModels,instantState,isInstantGame} from './instant.mjs';
import {arcadeModels,isArcadeGame} from './arcade.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
// settleAtClose: bets resolve when betting closes (result shown at once).
// Otherwise (crash) the result stays hidden until reveal_at and bets resolve then.
const families={
 wheel:{model:wheelModel,draw:drawWheel,payout:(g,r,b)=>wheelPayout(g,r,b.option_id,b.stake_minor),settleAtClose:true},
 cards3:{model:cards3Model,draw:drawCards3,payout:cards3Payout,settleAtClose:true},
 crash:{model:crashModel,draw:drawCrash,payout:crashPayout,settleAtClose:false,oneBetPerOption:true,
  timing:(game,result,r)=>{const reveal=r.bet_until+timeToReach(result.crash_x100);return{reveal_at:reveal,ends_at:reveal+game.round.showMs};}},
};
const models=Object.fromEntries(Object.values(CASINO_GAMES).filter(g=>!g.kind).map(g=>[g.id,families[g.family].model(g)]));
// Return-rate tiers: one extra pinned model per (game, tier) where the family allows it.
const tierModels=Object.fromEntries(Object.values(CASINO_GAMES).filter(g=>!g.kind).flatMap(g=>RTP_TIERS.map(t=>{const v=tierGame(g,t);return v?[[`${g.id}:${t}`,families[g.family].model(v)]]:[];}).flat()));
const byVersion=new Map([...Object.values(models),...Object.values(tierModels)].map(m=>[m.version,m]));
/** Model for new rounds of this App (its tier when the game supports it, else the default). */
export const roundModelFor=(gameId,tier)=>tierModels[`${gameId}:${tier}`]||models[gameId];
/** The pinned model of an existing round. */
function pinned(version,hash){const m=byVersion.get(version);if(!m||(hash&&m.hash!==hash))throw Object.assign(new Error('pinned casino math unavailable'),{status:503,code:'PINNED_MATH_UNAVAILABLE'});return m;}
export const casinoProfile=(gameId,tier)=>roundModelFor(gameId,tier);
export const casinoProfiles=()=>[...byVersion.values(),...instantModels(),...arcadeModels()];
const ACTIVE_MS=60000,HISTORY=20,CLOSE_GUARD_MS=300;
const watchers=new Map();

export async function migrateCasino(db=pool){
 await db.query(`CREATE TABLE IF NOT EXISTS casino_rounds (
  id text PRIMARY KEY, app_id text NOT NULL REFERENCES gp_apps(id), game_id text NOT NULL, seq bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('betting','drawing','settled')), math_version text NOT NULL, math_hash text NOT NULL,
  commitment text NOT NULL, seed_enc text NOT NULL, result jsonb,
  starts_at bigint NOT NULL, bet_until bigint NOT NULL, reveal_at bigint NOT NULL, ends_at bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id,game_id,seq));
 CREATE INDEX IF NOT EXISTS casino_rounds_open ON casino_rounds(status,bet_until) WHERE status<>'settled';
 CREATE INDEX IF NOT EXISTS casino_rounds_latest ON casino_rounds(app_id,game_id,seq DESC);
 CREATE TABLE IF NOT EXISTS casino_bets (
  id text PRIMARY KEY, round_id text NOT NULL REFERENCES casino_rounds(id), app_id text NOT NULL, session_id text NOT NULL,
  external_user_id text NOT NULL, request_id text NOT NULL, option_id text NOT NULL, stake_minor bigint NOT NULL CHECK(stake_minor>0),
  status text NOT NULL CHECK(status IN ('PENDING','ACCEPTED','REJECTED','VOIDING','VOIDED','SETTLING','SETTLED')),
  payout_minor bigint, error text, auto_x100 integer, cashout_x100 integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(app_id,external_user_id,request_id));
 ALTER TABLE casino_bets ADD COLUMN IF NOT EXISTS auto_x100 integer;
 ALTER TABLE casino_bets ADD COLUMN IF NOT EXISTS cashout_x100 integer;
 ALTER TABLE casino_bets ADD COLUMN IF NOT EXISTS jackpot_minor bigint;
 CREATE INDEX IF NOT EXISTS casino_bets_round_user ON casino_bets(round_id,external_user_id);
 CREATE INDEX IF NOT EXISTS casino_bets_app_wins ON casino_bets(app_id,created_at) WHERE status='SETTLED' AND payout_minor>0;
 CREATE TABLE IF NOT EXISTS casino_jackpots (app_id text NOT NULL REFERENCES gp_apps(id), game_id text NOT NULL, pool_minor bigint NOT NULL DEFAULT 0 CHECK(pool_minor>=0), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(app_id,game_id));
ALTER TABLE casino_jackpots ADD COLUMN IF NOT EXISTS seeded_minor bigint NOT NULL DEFAULT 0;
 CREATE INDEX IF NOT EXISTS casino_bets_round ON casino_bets(round_id,status);
 CREATE INDEX IF NOT EXISTS casino_bets_app_created ON casino_bets(app_id,created_at);
 CREATE INDEX IF NOT EXISTS casino_bets_open ON casino_bets(status,updated_at) WHERE status IN ('PENDING','VOIDING','SETTLING');`);
}

/** Register each casino math profile in a wallet ledger scope (platform/simple escrow ledgers). */
export async function registerCasinoProfiles(db,scopeId){
 const legacy=['thunder','tiger'].flatMap(g=>PROFILE_NAMES.map(p=>getProfile(g,p)));
 for(const m of [...casinoProfiles(),...legacy])await db.query('INSERT INTO wallet_math_profiles(scope_id,game_id,math_version,math_config_hash,max_payout_multiplier) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[scopeId,m.gameId,m.version,m.hash,String(m.maxMultiplier)]);
}

function newRound(app,game,seq,start){
 const seed=randomBytes(32).toString('hex'),m=roundModelFor(game.id,app.math_profile),r=game.round,draw=r.drawMs||0;
 // Crash rounds get their real reveal/end times when betting closes; these are placeholders.
 return {id:id('rnd'),app_id:app.id,game_id:game.id,seq,status:'betting',math_version:m.version,math_hash:m.hash,commitment:sha(seed),seed_enc:seal(seed),
  starts_at:start,bet_until:start+r.betMs,reveal_at:start+r.betMs+draw,ends_at:start+r.betMs+draw+r.showMs};
}
async function insertRound(c,r){
 await c.query(`INSERT INTO casino_rounds(id,app_id,game_id,seq,status,math_version,math_hash,commitment,seed_enc,starts_at,bet_until,reveal_at,ends_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[r.id,r.app_id,r.game_id,r.seq,r.status,r.math_version,r.math_hash,r.commitment,r.seed_enc,r.starts_at,r.bet_until,r.reveal_at,r.ends_at]);
 return r;
}
const num=r=>r&&({...r,seq:Number(r.seq),starts_at:Number(r.starts_at),bet_until:Number(r.bet_until),reveal_at:Number(r.reveal_at),ends_at:Number(r.ends_at)});

/** The App's current round for this game; opens the next one when the last has ended. */
export async function currentRound(app,gameId,now=Date.now()){
 watchers.set(`${app.id}:${gameId}`,now);
 const latest=num((await pool.query('SELECT * FROM casino_rounds WHERE app_id=$1 AND game_id=$2 ORDER BY seq DESC LIMIT 1',[app.id,gameId])).rows[0]);
 if(latest&&latest.ends_at>now)return latest;
 return tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`casino:${app.id}:${gameId}`]);
  const again=num((await c.query('SELECT * FROM casino_rounds WHERE app_id=$1 AND game_id=$2 ORDER BY seq DESC LIMIT 1',[app.id,gameId])).rows[0]);
  if(again&&again.ends_at>now)return again;
  return insertRound(c,newRound(app,CASINO_GAMES[gameId],(again?.seq||0)+1,now));
 });
}

function view(r,now){
 const family=families[CASINO_GAMES[r.game_id].family],hidden=!family.settleAtClose&&(r.status==='betting'||now<r.reveal_at);
 // A crash round never exposes its crash time (reveal_at) or result while the rocket flies.
 return {id:r.id,seq:r.seq,status:r.status,starts_at:r.starts_at,bet_until:r.bet_until,reveal_at:hidden?null:r.reveal_at,ends_at:hidden?null:r.ends_at,commitment:r.commitment,
  ...(r.result&&!hidden&&now>=r.bet_until?{result:r.result}:{}),...(r.result&&now>=r.reveal_at?{seed:unseal(r.seed_enc)}:{})};
}
const betView=b=>({id:b.id,request_id:b.request_id,option_id:b.option_id,stake_minor:String(b.stake_minor),status:b.status,payout_minor:b.payout_minor===null?null:String(b.payout_minor),jackpot_minor:b.jackpot_minor?String(b.jackpot_minor):null,
 auto_x100:b.auto_x100??null,cashout_x100:b.cashout_x100??null,error:b.error||null});

// Shared per App/game state, recomputed at most every SNAPSHOT_MS (single flight) for all pollers.
const SNAPSHOT_MS=Number(process.env.OASIS_CASINO_SNAPSHOT_MS??400),TODAY_MS=SNAPSHOT_MS?5000:0,APP_MS=SNAPSHOT_MS?2000:0;
const snapshots=new Map(),todays=new Map(),apps=new Map();
async function cachedApp(appId){const hit=apps.get(appId);if(hit&&hit.until>Date.now())return hit.app;const app=await appById(appId);apps.set(appId,{app,until:Date.now()+APP_MS});return app;}
function sharedSnapshot(app,gameId,now){
 if(!SNAPSHOT_MS)return buildSnapshot(app,gameId,now);
 const key=app.id+':'+gameId,hit=snapshots.get(key);
 if(hit&&(hit.pending||(now-hit.at<(CASINO_GAMES[gameId].family==='crash'?200:SNAPSHOT_MS)&&hit.value.round.ends_at>now)))return hit.pending||hit.value;
 const pending=buildSnapshot(app,gameId,now).then(value=>{snapshots.set(key,{at:now,value});return value;},e=>{snapshots.delete(key);throw e;});
 snapshots.set(key,{...(hit||{}),pending});return pending;
}
async function buildSnapshot(app,gameId,now){
 const round=await currentRound(app,gameId,now),game=CASINO_GAMES[gameId];
 const [totals,history,winners,today]=await Promise.all([
  pool.query("SELECT option_id,sum(stake_minor)::text total,count(DISTINCT external_user_id)::int players FROM casino_bets WHERE round_id=$1 AND status IN ('ACCEPTED','SETTLING','SETTLED') GROUP BY option_id",[round.id]),
  pool.query("SELECT seq,result->>'outcome' outcome FROM casino_rounds WHERE app_id=$1 AND game_id=$2 AND result IS NOT NULL AND reveal_at<=$3 AND status<>'betting' ORDER BY seq DESC LIMIT $4",[app.id,gameId,now,HISTORY]),
  pool.query(`SELECT b.external_user_id,sum(b.payout_minor)::text payout FROM casino_bets b JOIN casino_rounds r ON r.id=b.round_id
   WHERE r.app_id=$1 AND r.game_id=$2 AND r.seq=$3 AND b.status='SETTLED' AND b.payout_minor>0 GROUP BY 1 ORDER BY sum(b.payout_minor) DESC LIMIT 3`,[app.id,gameId,round.status==='betting'?round.seq-1:round.seq]),
  todayWinners(app.id,gameId,now),
 ]);
 return {round,totals:Object.fromEntries(totals.rows.map(t=>[t.option_id,{stake_minor:t.total,players:t.players}])),
  history:history.rows.map(h=>({seq:Number(h.seq),outcome:h.outcome})),winners:winners.rows.map(w=>({external_user_id:w.external_user_id,payout_minor:w.payout})),today,
  cashouts:game.family==='crash'?(await pool.query('SELECT external_user_id,stake_minor::text stake_minor,cashout_x100 FROM casino_bets WHERE round_id=$1 AND cashout_x100 IS NOT NULL ORDER BY cashout_x100 LIMIT 30',[round.id])).rows:undefined,
  jackpot:game.bonus?.jackpot?await seedJackpot(app.id,gameId):undefined};
}
// Today's (UTC) biggest winners in this App and game, by total payout of revealed rounds.
async function todayWinners(appId,gameId,now){
 const key=appId+':'+gameId,hit=todays.get(key);if(hit&&now-hit.at<TODAY_MS)return hit.value;
 const rows=(await pool.query(`SELECT b.external_user_id,sum(b.payout_minor)::text payout FROM casino_bets b JOIN casino_rounds r ON r.id=b.round_id
   WHERE b.app_id=$1 AND r.app_id=$1 AND r.game_id=$2 AND b.status='SETTLED' AND b.payout_minor>0 AND r.reveal_at<=$3 AND b.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
   GROUP BY 1 ORDER BY sum(b.payout_minor) DESC LIMIT 3`,[appId,gameId,now])).rows.map(w=>({external_user_id:w.external_user_id,payout_minor:w.payout}));
 todays.set(key,{at:now,value:rows});return rows;
}

export async function casinoState(session,{balance=false}={}){
 if(!isCasinoGame(session.game_id))fail(403,'GAME_SESSION_REQUIRED');
 if(isInstantGame(session.game_id))return instantState(session,{balance});
 if(isArcadeGame(session.game_id))return arcadeState(session,{balance});
 const app=await cachedApp(session.app_id),now=Date.now(),snap=await sharedSnapshot(app,session.game_id,now),round=snap.round;
 // Only the player's own bets are read per request; everything shared comes from the App/game snapshot.
 const mine=await pool.query('SELECT * FROM casino_bets WHERE round_id=$1 AND app_id=$2 AND external_user_id=$3 ORDER BY created_at',[round.id,app.id,session.external_user_id]);
 const out={game_id:session.game_id,server_now:now,me:session.external_user_id,round:view(round,now),
  totals:snap.totals,my_bets:mine.rows.map(betView),history:snap.history,cashouts:snap.cashouts,
  // Last finished round's top winners are only shown once its reveal has played.
  top_winners:round.status==='betting'||now>=round.reveal_at?snap.winners:[],
  today_winners:snap.today,...(snap.jackpot!==undefined?{jackpot_minor:snap.jackpot}:{})};
 if(balance){try{out.balance=(await walletBalance(app,session.external_user_id)).balance;}catch{out.balance=null;}}
 return out;
}

async function arcadeState(session,{balance}){
 const app=await appById(session.app_id),open=(await pool.query("SELECT id,status,bet_minor::text bet_minor,shots,used,win_minor::text win_minor,commitment FROM casino_arcade WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 AND status IN ('OPEN','CLOSING') ORDER BY created_at DESC LIMIT 1",[app.id,session.external_user_id,session.game_id])).rows[0];
 const out={game_id:session.game_id,kind:'arcade',server_now:Date.now(),me:session.external_user_id,open:open||null};
 if(balance){try{out.balance=(await walletBalance(app,session.external_user_id)).balance;}catch{out.balance=null;}}
 return out;
}

/** The player's recent bets (round games) or spins (instant games) in this game, newest first. */
export async function casinoHistory(session,{limit=30}={}){
 if(!isCasinoGame(session.game_id))fail(403,'GAME_SESSION_REQUIRED');
 const n=Math.min(100,Math.max(1,Number(limit)||30));
 if(isInstantGame(session.game_id)){
  const rows=(await pool.query("SELECT id,mode,stake_minor::text stake,payout_minor::text payout,status,created_at,result->>'outcome' outcome,(result->>'free_spins')::int free_spins FROM casino_spins WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 AND status IN ('SETTLED','RESULT_FIXED') ORDER BY created_at DESC LIMIT $4",[session.app_id,session.external_user_id,session.game_id,n])).rows;
  return {game_id:session.game_id,kind:'instant',records:rows.map(r=>({id:r.id,at:r.created_at,mode:r.mode,stake_minor:r.stake,payout_minor:r.payout,outcome:r.outcome,free_spins:r.free_spins||0}))};
 }
 // Group bets by round; only rounds whose result has been revealed are shown.
 const rows=(await pool.query(`SELECT r.seq,r.id round_id,r.result->>'outcome' outcome,b.option_id,b.stake_minor::text stake,b.payout_minor::text payout,b.status,b.created_at FROM casino_bets b JOIN casino_rounds r ON r.id=b.round_id
  WHERE b.app_id=$1 AND b.external_user_id=$2 AND r.game_id=$3 AND r.reveal_at<=$4 AND b.status IN ('SETTLED','VOIDED','SETTLING') ORDER BY b.created_at DESC LIMIT 400`,[session.app_id,session.external_user_id,session.game_id,Date.now()])).rows;
 const rounds=[];for(const b of rows){let r=rounds.find(x=>x.round_id===b.round_id);if(!r){if(rounds.length>=n)break;r={round_id:b.round_id,seq:Number(b.seq),outcome:b.outcome,at:b.created_at,stake_minor:0n,payout_minor:0n,bets:[]};rounds.push(r);}
  r.bets.push({option_id:b.option_id,stake_minor:b.stake,payout_minor:b.payout,status:b.status});if(b.status!=='VOIDED'){r.stake_minor+=BigInt(b.stake);r.payout_minor+=BigInt(b.payout||0);}}
 return {game_id:session.game_id,kind:'round',records:rounds.map(r=>({...r,stake_minor:String(r.stake_minor),payout_minor:String(r.payout_minor)}))};
}

/**
 * Platform-funded starting pool: tops the pool up by (seedMinor - already seeded) once per App/game,
 * so raising the seed later only adds the difference. Returns the current pool.
 */
async function seedJackpot(appId,gameId,db=pool){
 const seed=String(CASINO_GAMES[gameId].bonus.jackpot.seedMinor||0);
 return (await db.query(`INSERT INTO casino_jackpots(app_id,game_id,pool_minor,seeded_minor) VALUES($1,$2,$3,$3)
  ON CONFLICT(app_id,game_id) DO UPDATE SET pool_minor=casino_jackpots.pool_minor+GREATEST(0,$3::bigint-casino_jackpots.seeded_minor),seeded_minor=GREATEST(casino_jackpots.seeded_minor,$3::bigint),updated_at=now()
  RETURNING pool_minor::text p`,[appId,gameId,seed])).rows[0].p;
}

function walletBase(app,bet){return {...scope(app),authorization_id:'auth_'+bet.id,cycle_id:bet.id};}

export async function placeBet(session,body){
 if(!isCasinoGame(session.game_id)||isInstantGame(session.game_id)||isArcadeGame(session.game_id))fail(403,'GAME_SESSION_REQUIRED');
 const game=CASINO_GAMES[session.game_id];
 if(!/^[A-Za-z0-9_-]{8,128}$/.test(body.request_id||'')||typeof body.round_id!=='string'||typeof body.option_id!=='string'||typeof body.stake_minor!=='string')fail(400,'INVALID_REQUEST');
 if(!game.options.some(o=>o.id===body.option_id))fail(400,'INVALID_OPTION');
 if(!game.chips.includes(body.stake_minor))fail(400,'INVALID_STAKE');
 const family=families[game.family];let auto=null;
 if(body.auto_x100!==undefined&&body.auto_x100!==null){
  if(game.family!=='crash'||!Number.isSafeInteger(body.auto_x100)||body.auto_x100<game.autoCashout.min_x100||body.auto_x100>game.autoCashout.max_x100)fail(400,'INVALID_AUTO_CASHOUT');auto=body.auto_x100;}
 const app=await appById(session.app_id);
 const prior=(await pool.query('SELECT * FROM casino_bets WHERE app_id=$1 AND external_user_id=$2 AND request_id=$3',[app.id,session.external_user_id,body.request_id])).rows[0];
 let bet=prior;
 if(prior){if(prior.round_id!==body.round_id||prior.option_id!==body.option_id||String(prior.stake_minor)!==body.stake_minor||(prior.auto_x100??null)!==auto)fail(409,'IDEMPOTENCY_CONFLICT');}
 else{
  await assertNewFinancialAdmission(pool,app,{gameId:game.id});
  bet=await tx(async c=>{
   const round=num((await c.query('SELECT * FROM casino_rounds WHERE id=$1 AND app_id=$2 AND game_id=$3 FOR UPDATE',[body.round_id,app.id,game.id])).rows[0]);
   if(!round)fail(404,'ROUND_NOT_FOUND');
   if(round.status!=='betting'||Date.now()>=round.bet_until-CLOSE_GUARD_MS)fail(409,'BETTING_CLOSED');
   const mine=(await c.query("SELECT option_id,stake_minor FROM casino_bets WHERE round_id=$1 AND external_user_id=$2 AND status NOT IN ('REJECTED','VOIDED','VOIDING')",[round.id,session.external_user_id])).rows;
   if(family.oneBetPerOption&&mine.some(b=>b.option_id===body.option_id))fail(409,'OPTION_ALREADY_BET');
   const options=new Set([...mine.map(b=>b.option_id),body.option_id]);
   if(options.size>game.maxOptionsPerRound)fail(409,'TOO_MANY_OPTIONS');
   if(mine.reduce((a,b)=>a+BigInt(b.stake_minor),0n)+BigInt(body.stake_minor)>BigInt(game.maxStakePerRound))fail(409,'ROUND_STAKE_LIMIT');
   return (await c.query("INSERT INTO casino_bets(id,round_id,app_id,session_id,external_user_id,request_id,option_id,stake_minor,status,auto_x100) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9) RETURNING *",
    [id('bet'),round.id,app.id,session.id,session.external_user_id,body.request_id,body.option_id,body.stake_minor,auto])).rows[0];
  });
 }
 if(bet.status==='PENDING'){const r=(await pool.query('SELECT math_version,math_hash FROM casino_rounds WHERE id=$1',[bet.round_id])).rows[0];bet=await fundBet(app,pinned(r.math_version,r.math_hash),bet);}
 if(bet.status==='REJECTED')fail(409,bet.error||'WALLET_REJECTED');
 return betView(bet);
}

async function fundBet(app,model,bet){
 const base=walletBase(app,bet);
 try{
  await openProbability(app,bet.id,{...base,external_user_id:bet.external_user_id,game_id:model.gameId,math_version:model.version,math_config_hash:model.hash,
   stake_minor:String(bet.stake_minor),max_payout_minor:String(BigInt(bet.stake_minor)*BigInt(model.maxMultiplier)),expires_at:new Date(Date.now()+60000).toISOString()});
  // Acceptance may race the close of betting; only a still-open round takes the bet.
  const accepted=(await pool.query("UPDATE casino_bets b SET status='ACCEPTED',updated_at=now() FROM casino_rounds r WHERE b.id=$1 AND b.status='PENDING' AND r.id=b.round_id AND r.status='betting' RETURNING b.*",[bet.id])).rows[0];
  const jp=CASINO_GAMES[model.gameId].bonus?.jackpot;
  if(accepted&&jp)await seedJackpot(app.id,model.gameId);
  if(accepted&&jp)await pool.query('INSERT INTO casino_jackpots(app_id,game_id,pool_minor) VALUES($1,$2,$3) ON CONFLICT(app_id,game_id) DO UPDATE SET pool_minor=casino_jackpots.pool_minor+EXCLUDED.pool_minor,updated_at=now()',[app.id,model.gameId,String(BigInt(accepted.stake_minor)*BigInt(jp.contributionBps)/10000n)]);
  return accepted||(await pool.query('SELECT * FROM casino_bets WHERE id=$1',[bet.id])).rows[0];
 }catch(e){
  if(e.status===409){return (await pool.query("UPDATE casino_bets SET status='REJECTED',error=$2,updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING *",[bet.id,e.code||'WALLET_REJECTED'])).rows[0]||(await pool.query('SELECT * FROM casino_bets WHERE id=$1',[bet.id])).rows[0];}
  // Unknown wallet outcome: the bet stays PENDING; if betting closes first it is voided and refunded.
  return (await pool.query('SELECT * FROM casino_bets WHERE id=$1',[bet.id])).rows[0];
 }
}

/** Close betting, fix results, settle bets, refund bets that missed the close, open next rounds. */
export async function tickCasino(now=Date.now()){
 const closing=(await pool.query("SELECT id FROM casino_rounds WHERE status='betting' AND bet_until<=$1 ORDER BY bet_until LIMIT 50",[now])).rows;
 for(const {id:roundId} of closing){
  await tx(async c=>{
   const r=num((await c.query("SELECT * FROM casino_rounds WHERE id=$1 AND status='betting' FOR UPDATE",[roundId])).rows[0]);if(!r)return;
   const game=CASINO_GAMES[r.game_id],model=pinned(r.math_version,r.math_hash);
   const family=families[game.family],result=family.draw(model,unseal(r.seed_enc)),timing=family.timing?.(game,result,r)||{reveal_at:r.reveal_at,ends_at:r.ends_at};
   await c.query("UPDATE casino_rounds SET status='drawing',result=$2,reveal_at=$3,ends_at=$4 WHERE id=$1",[r.id,result,timing.reveal_at,timing.ends_at]);
   await c.query("UPDATE casino_bets SET status='VOIDING',error='BETTING_CLOSED',updated_at=now() WHERE round_id=$1 AND status='PENDING'",[r.id]);
   if(family.settleAtClose)await resolveAccepted(c,game,result,r.id);
  });
 }
 // Crash rounds resolve remaining bets (auto cash-out or lost) at the crash moment.
 const crashed=(await pool.query("SELECT r.id,r.game_id,r.result FROM casino_rounds r WHERE r.status='drawing' AND r.reveal_at<=$1 AND EXISTS (SELECT 1 FROM casino_bets b WHERE b.round_id=r.id AND b.status='ACCEPTED') LIMIT 50",[now])).rows;
 for(const r of crashed)await tx(c=>resolveAccepted(c,CASINO_GAMES[r.game_id],r.result,r.id));
 await settleOpenBets();
 await pool.query(`UPDATE casino_rounds r SET status='settled' WHERE r.status='drawing' AND NOT EXISTS (SELECT 1 FROM casino_bets b WHERE b.round_id=r.id AND b.status IN ('PENDING','SETTLING','VOIDING','ACCEPTED'))`);
 for(const [key,seen] of watchers){
  if(now-seen>ACTIVE_MS){watchers.delete(key);continue;}
  const [appId,gameId]=key.split(':');
  const latest=(await pool.query('SELECT ends_at FROM casino_rounds WHERE app_id=$1 AND game_id=$2 ORDER BY seq DESC LIMIT 1',[appId,gameId])).rows[0];
  if(!latest||Number(latest.ends_at)<=now){const app=await appById(appId);if(app?.status==='active'||app?.environment!=='production')await currentRound(app,gameId,seen);}
 }
}

async function resolveAccepted(c,game,result,roundId){
 const bets=(await c.query("SELECT * FROM casino_bets WHERE round_id=$1 AND status='ACCEPTED' FOR UPDATE",[roundId])).rows;
 const base=new Map(bets.map(b=>[b.id,families[game.family].payout(game,result,b)]));
 const shares=result.bonus?.type==='jackpot'&&game.bonus?.jackpot?await jackpotShares(c,game,roundId,bets.filter(b=>base.get(b.id)>0n)):new Map();
 // One statement for the whole round (thousands of bets) instead of one round trip per bet.
 if(!bets.length)return;
 const ids=bets.map(b=>b.id),pay=bets.map(b=>String(base.get(b.id)+(shares.get(b.id)||0n))),jack=bets.map(b=>shares.get(b.id)?String(shares.get(b.id)):null);
 await c.query("UPDATE casino_bets b SET status='SETTLING',payout_minor=v.pay,jackpot_minor=v.jack,updated_at=now() FROM unnest($1::text[],$2::bigint[],$3::bigint[]) AS v(id,pay,jack) WHERE b.id=v.id",[ids,pay,jack]);
}

/**
 * Jackpot draw: each winning bet takes pool x tier% (tier by its player's winning stake this round)
 * x its share of all winning stake, capped so the bet stays within its reserved wallet liability.
 */
async function jackpotShares(c,game,roundId,winning){
 const r=(await c.query('SELECT app_id FROM casino_rounds WHERE id=$1',[roundId])).rows[0];
 const row=(await c.query('SELECT pool_minor FROM casino_jackpots WHERE app_id=$1 AND game_id=$2 FOR UPDATE',[r.app_id,game.id])).rows[0];
 const poolMinor=BigInt(row?.pool_minor||0),total=winning.reduce((a,b)=>a+BigInt(b.stake_minor),0n),shares=new Map();
 if(!poolMinor||!total)return shares;
 const byUser={};for(const b of winning)byUser[b.external_user_id]=(byUser[b.external_user_id]||0n)+BigInt(b.stake_minor);
 const pct=stake=>BigInt(game.bonus.jackpot.tiers.filter(([min])=>stake>=BigInt(min)).at(-1)[1]);
 const maxBase=BigInt(Math.max(...game.options.map(o=>o.multiplier)))*BigInt(Math.max(1,...game.bonus.table.filter(x=>x.type==='multiplier').map(x=>x.value)));
 let paid=0n;
 for(const b of winning){
  const stake=BigInt(b.stake_minor),cap=stake*(BigInt(game.bonus.liabilityMultiplier)-maxBase);
  let s=poolMinor*pct(byUser[b.external_user_id])*stake/(100n*total);if(s>cap)s=cap;
  if(s>0n){shares.set(b.id,s);paid+=s;}
 }
 await c.query('UPDATE casino_jackpots SET pool_minor=pool_minor-$3,updated_at=now() WHERE app_id=$1 AND game_id=$2',[r.app_id,game.id,String(paid)]);
 await c.query(`UPDATE casino_rounds SET result=result||jsonb_build_object('jackpot',jsonb_build_object('pool_minor',$2::text,'paid_minor',$3::text)) WHERE id=$1`,[roundId,String(poolMinor),String(paid)]);
 return shares;
}

/** Crash: cash out an accepted bet at the server's current multiplier, if the rocket is still flying. */
export async function cashOut(session,body){
 const game=CASINO_GAMES[session.game_id];
 if(game?.family!=='crash')fail(403,'GAME_SESSION_REQUIRED');
 if(typeof body.bet_id!=='string')fail(400,'INVALID_REQUEST');
 const bet=await tx(async c=>{
  const b=(await c.query('SELECT * FROM casino_bets WHERE id=$1 AND app_id=$2 AND external_user_id=$3 FOR UPDATE',[body.bet_id,session.app_id,session.external_user_id])).rows[0];
  if(!b)fail(404,'BET_NOT_FOUND');if(b.cashout_x100)return b;
  const r=num((await c.query('SELECT * FROM casino_rounds WHERE id=$1 FOR SHARE',[b.round_id])).rows[0]),now=Date.now();
  if(b.status!=='ACCEPTED'||r.status!=='drawing'||now<r.bet_until)fail(409,'CASHOUT_UNAVAILABLE');
  const x=multiplierAt(now-r.bet_until);
  if(now>=r.reveal_at||x>=r.result.crash_x100)fail(409,'CRASHED');
  return (await c.query("UPDATE casino_bets SET status='SETTLING',cashout_x100=$2,payout_minor=$3,updated_at=now() WHERE id=$1 RETURNING *",[b.id,x,String(BigInt(b.stake_minor)*BigInt(x)/100n)])).rows[0];
 });
 return betView(bet);
}

/** Run fn over items with at most n in flight. */
async function mapLimit(items,n,fn){let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length)await fn(items[i++]);}));}
const SETTLE_CONCURRENCY=Number(process.env.OASIS_CASINO_SETTLE_CONCURRENCY||12);
async function settleOpenBets(){
 const open=(await pool.query("SELECT b.*,r.game_id,r.result,r.math_version,r.math_hash FROM casino_bets b JOIN casino_rounds r ON r.id=b.round_id WHERE b.status IN ('SETTLING','VOIDING') AND (b.error IS NULL OR b.error='BETTING_CLOSED' OR b.updated_at<now()-interval '3 seconds') ORDER BY b.updated_at LIMIT 2000")).rows;
 const apps=new Map();
 for(const b of open)if(!apps.has(b.app_id))apps.set(b.app_id,await appById(b.app_id));
 // Each bet is its own wallet cycle on a different player row, so settlements run in parallel.
 await mapLimit(open,SETTLE_CONCURRENCY,async b=>{
  const app=apps.get(b.app_id);
  const model=pinned(b.math_version,b.math_hash),base=walletBase(app,b);
  try{
   if(b.status==='SETTLING'){
    const resultHash=sha(JSON.stringify({round_id:b.round_id,result:b.result,bet_id:b.id,option_id:b.option_id}));
    await command(app,b.id,'/wallet/v1/probability/settle',{...base,request_id:'settle_'+b.id,game_id:model.gameId,math_version:model.version,math_config_hash:model.hash,stake_minor:String(b.stake_minor),gross_payout_minor:String(b.payout_minor),result_hash:resultHash});
    await pool.query("UPDATE casino_bets SET status='SETTLED',updated_at=now() WHERE id=$1 AND status='SETTLING'",[b.id]);
   }else{
    // Refund a bet that missed the close: cancel before accept, or settle the stake back after accept.
    let ops=(await pool.query("SELECT id,state,path,raw_body FROM gp_operations WHERE aggregate_id=$1",[b.id])).rows;
    // A merged authorize+accept with an unknown outcome is replayed (idempotently) before deciding:
    // it either succeeded (the stake is held: refund it) or was rejected (nothing to refund).
    const merged=ops.find(o=>o.path===MERGED_PROBABILITY);
    if(merged&&!['SUCCEEDED','REJECTED'].includes(merged.state)){
     try{await command(app,b.id,MERGED_PROBABILITY,JSON.parse(merged.raw_body));}catch(e){if(e.status!==409)throw e;}
     ops=(await pool.query("SELECT id,state,path FROM gp_operations WHERE aggregate_id=$1",[b.id])).rows;
    }
    const state=Object.fromEntries(ops.map(o=>[o.id.split('_')[0],o.state]));
    const refund=()=>command(app,b.id,'/wallet/v1/probability/settle',{...base,request_id:'settle_'+b.id,game_id:model.gameId,math_version:model.version,math_config_hash:model.hash,stake_minor:String(b.stake_minor),gross_payout_minor:String(b.stake_minor),result_hash:sha('void:'+b.id)});
    if(state.accept==='SUCCEEDED')await refund();
    else if(state.authorize&&state.authorize!=='REJECTED'){
     // The wallet may have accepted even though our accept response was lost: then refund the stake by settlement.
     try{await command(app,b.id,'/wallet/v1/probability/cancel',{...base,request_id:'cancel_'+b.id,reason:'authorization_timeout'});}
     catch(e){if(e.code!=='ALREADY_ACCEPTED')throw e;await refund();}
    }
    await pool.query("UPDATE casino_bets SET status='VOIDED',updated_at=now() WHERE id=$1 AND status='VOIDING'",[b.id]);
   }
  }catch(e){
   // A cancel that lost the race to accept is retried next tick as a stake refund.
   if(e.code==='CANCELLED_TOMBSTONE'&&b.status==='VOIDING')await pool.query("UPDATE casino_bets SET status='VOIDED',updated_at=now() WHERE id=$1 AND status='VOIDING'",[b.id]);
   else await pool.query('UPDATE casino_bets SET error=$2,updated_at=now() WHERE id=$1',[b.id,String(e.code||e.message).slice(0,80)]);
  }
 });
}
