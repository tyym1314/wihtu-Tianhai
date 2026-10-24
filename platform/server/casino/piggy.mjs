/**
 * FishStar extras: tomorrow's piggy bank, game records and rankings.
 *
 * Piggy bank: a game with `arcade.piggy` keeps that share of every shot's return out of the shot (see
 * resolveShot) and accrues it here when the session settles, per player and day (Asia/Riyadh). The amount
 * accrued on a day can be claimed on the next day only; unclaimed amounts expire. A claim is one wallet
 * operation ('/wallet/v1/promotions/credit', house -> player), idempotent by its request id and retried until done.
 */
import {pool,tx} from '../db.mjs';
import {fail} from '../security.mjs';
import {appById,scope} from '../platform.mjs';
import {command} from '../cycles.mjs';
import {CASINO_GAMES} from '../../shared/casino-games.mjs';

const TZ='Asia/Riyadh';
const DAY=`(now() AT TIME ZONE '${TZ}')::date`;

export async function migratePiggy(db=pool){
 await db.query(`CREATE TABLE IF NOT EXISTS casino_piggy (
  app_id text NOT NULL REFERENCES gp_apps(id), external_user_id text NOT NULL, game_id text NOT NULL, day date NOT NULL,
  accrued_minor bigint NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLAIMING','PAID')),
  claimed_minor bigint, claimed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(app_id,external_user_id,game_id,day));
 CREATE INDEX IF NOT EXISTS casino_piggy_claiming ON casino_piggy(state,updated_at) WHERE state='CLAIMING';
 CREATE TABLE IF NOT EXISTS casino_players (app_id text NOT NULL REFERENCES gp_apps(id), external_user_id text NOT NULL,
  display_name text, avatar_url text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(app_id,external_user_id));`);
}

/** Accrue a settled session's piggy share (called once, in the settling transaction). */
export async function accruePiggy(c,a){
 const rate=CASINO_GAMES[a.game_id]?.arcade?.piggy;if(!rate)return;
 const amount=BigInt(Math.floor(Number(a.bet_minor)*a.used*rate));if(amount<=0n)return;
 await c.query(`INSERT INTO casino_piggy(app_id,external_user_id,game_id,day,accrued_minor) VALUES($1,$2,$3,${DAY},$4)
  ON CONFLICT(app_id,external_user_id,game_id,day) DO UPDATE SET accrued_minor=casino_piggy.accrued_minor+EXCLUDED.accrued_minor,updated_at=now()`,
  [a.app_id,a.external_user_id,a.game_id,String(amount)]);
}

const requirePiggy=s=>{if(!CASINO_GAMES[s.game_id]?.arcade?.piggy)fail(403,'GAME_SESSION_REQUIRED');};

export async function piggyState(s){
 requirePiggy(s);
 const rows=(await pool.query(`SELECT day=${DAY} today,accrued_minor,state,claimed_minor FROM casino_piggy WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 AND day>=${DAY}-1`,
  [s.app_id,s.external_user_id,s.game_id])).rows;
 const today=rows.find(r=>r.today),yesterday=rows.find(r=>!r.today);
 return {today_minor:String(today?.accrued_minor??0),claimable_minor:String(yesterday&&yesterday.state==='OPEN'?yesterday.accrued_minor:0),
  claimed_minor:String(yesterday&&yesterday.state!=='OPEN'?yesterday.claimed_minor:0),time_zone:TZ};
}

export async function claimPiggy(s){
 requirePiggy(s);
 const row=await tx(async c=>{
  const r=(await c.query(`SELECT * FROM casino_piggy WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 AND day=${DAY}-1 FOR UPDATE`,[s.app_id,s.external_user_id,s.game_id])).rows[0];
  if(!r||BigInt(r.accrued_minor)<=0n)fail(409,'NOTHING_TO_CLAIM');
  if(r.state!=='OPEN')return r;
  return (await c.query("UPDATE casino_piggy SET state='CLAIMING',claimed_minor=accrued_minor,claimed_at=now(),updated_at=now() WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 AND day=$4 RETURNING *",
   [r.app_id,r.external_user_id,r.game_id,r.day])).rows[0];
 });
 if(row.state==='CLAIMING')await pay(await appById(row.app_id),row);
 return piggyState(s);
}

const opId=r=>`piggy_${r.app_id}_${r.external_user_id}_${r.game_id}_${new Date(r.day).toISOString().slice(0,10).replaceAll('-','')}`.slice(0,128).replace(/[^A-Za-z0-9_-]/g,'_');
async function pay(app,r){
 const request_id=opId(r);
 await command(app,request_id,'/wallet/v1/promotions/credit',{...scope(app),request_id,external_user_id:r.external_user_id,amount_minor:String(r.claimed_minor),promotion_id:request_id,game_id:r.game_id});
 await pool.query("UPDATE casino_piggy SET state='PAID',updated_at=now() WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 AND day=$4 AND state='CLAIMING'",[r.app_id,r.external_user_id,r.game_id,r.day]);
}
/** Background: finish claims whose wallet credit did not complete. */
export async function recoverPiggy(){
 const rows=(await pool.query("SELECT * FROM casino_piggy WHERE state='CLAIMING' AND updated_at<now()-interval '5 seconds' LIMIT 50")).rows;
 for(const r of rows){try{await pay(await appById(r.app_id),r);}catch{}}
}

/** The host's display name / avatar for rankings (optional `player` on session creation). */
export async function rememberPlayer(db,appId,externalUserId,player){
 if(!player)return;
 await db.query(`INSERT INTO casino_players(app_id,external_user_id,display_name,avatar_url) VALUES($1,$2,$3,$4)
  ON CONFLICT(app_id,external_user_id) DO UPDATE SET display_name=EXCLUDED.display_name,avatar_url=EXCLUDED.avatar_url,updated_at=now()`,
  [appId,externalUserId,player.display_name??null,player.avatar_url??null]);
}

/** Last 30 sessions of this game: when, spent (shots used x bet), won. */
export async function arcadeRecords(s){
 const rows=(await pool.query("SELECT created_at,bet_minor,used,win_minor FROM casino_arcade WHERE app_id=$1 AND external_user_id=$2 AND game_id=$3 AND status='SETTLED' AND used>0 ORDER BY created_at DESC LIMIT 30",
  [s.app_id,s.external_user_id,s.game_id])).rows;
 return {records:rows.map(r=>({at:r.created_at,spent_minor:String(BigInt(r.bet_minor)*BigInt(r.used)),won_minor:String(r.win_minor)}))};
}

/** Rankings: today / this week by total won, hall of fame by the biggest single catch. Top 50. */
export async function arcadeRank(s,period){
 if(!['day','week','fame'].includes(period))fail(400,'INVALID_REQUEST');
 const since=period==='day'?`date_trunc('day',now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`:`date_trunc('week',now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
 const rows=period==='fame'
  ?(await pool.query(`SELECT a.external_user_id,max(a.bet_minor*(sh.result->>'win_x100')::bigint/100) amount FROM casino_arcade_shots sh JOIN casino_arcade a ON a.id=sh.arcade_id
     WHERE a.app_id=$1 AND a.game_id=$2 AND (sh.result->>'win_x100')::bigint>0 GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,[s.app_id,s.game_id])).rows
  :(await pool.query(`SELECT external_user_id,sum(win_minor) amount FROM casino_arcade WHERE app_id=$1 AND game_id=$2 AND status='SETTLED' AND updated_at>=${since}
     GROUP BY 1 HAVING sum(win_minor)>0 ORDER BY 2 DESC LIMIT 50`,[s.app_id,s.game_id])).rows;
 const names=new Map((await pool.query('SELECT external_user_id,display_name,avatar_url FROM casino_players WHERE app_id=$1 AND external_user_id=ANY($2)',[s.app_id,rows.map(r=>r.external_user_id)])).rows.map(r=>[r.external_user_id,r]));
 return {period,me:s.external_user_id,rows:rows.map((r,i)=>({rank:i+1,me:r.external_user_id===s.external_user_id,tag:'…'+r.external_user_id.slice(-4),name:names.get(r.external_user_id)?.display_name||null,
  avatar_url:names.get(r.external_user_id)?.avatar_url||null,amount_minor:String(r.amount)}))};
}
