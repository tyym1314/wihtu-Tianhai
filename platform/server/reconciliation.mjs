import {pool} from './db.mjs';
import {fail} from './security.mjs';

// Every kind of paid play, normalised to (stake, payout). Arcade stake = shots actually fired × bet
// (unused ammo is refunded, not staked). Thunder/Tiger cycles, round bets, instant spins, arcade sessions.
const PLAYS=`
 SELECT 'cycle' kind,c.id,c.app_id,c.game_id,c.external_user_id,c.stake_minor stake,c.payout_minor payout,upper(c.status) status,c.created_at FROM gp_cycles c
 UNION ALL SELECT 'bet',b.id,b.app_id,r.game_id,b.external_user_id,b.stake_minor,b.payout_minor,b.status,b.created_at FROM casino_bets b JOIN casino_rounds r ON r.id=b.round_id
 UNION ALL SELECT 'spin',s.id,s.app_id,s.game_id,s.external_user_id,s.stake_minor,s.payout_minor,s.status,s.created_at FROM casino_spins s
 UNION ALL SELECT 'arcade',a.id,a.app_id,a.game_id,a.external_user_id,a.bet_minor*a.used,a.win_minor,a.status,a.created_at FROM casino_arcade a`;
const VOID=`('REJECTED','VOIDED','CANCELLED','CANCELED')`,DONE=`('SETTLED','COMPLETED')`;
const DAY=86400000,MAX_RANGE=93*DAY;

function filters(q){
 const to=q.get('to')?new Date(q.get('to')):new Date(),from=q.get('from')?new Date(q.get('from')):new Date(to.getTime()-7*DAY);
 if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>=to)fail(400,'INVALID_RANGE','时间范围无效');
 if(to-from>MAX_RANGE)fail(400,'RANGE_TOO_LONG','一次最多查询 93 天');
 const text=(k,max=128)=>{const v=(q.get(k)||'').trim();if(v.length>max)fail(400,'INVALID_FILTER');return v||null;};
 return {app:text('app_id'),game:text('game_id',64),user:text('user',128),from,to};
}

/** Summary per game + wallet legs, and one page of plays, for the admin reconciliation page. */
export async function reconciliation(q){
 const f=filters(q),args=[f.app,f.game,f.user,f.from,f.to];
 const where=`($1::text IS NULL OR app_id=$1) AND ($2::text IS NULL OR game_id=$2) AND ($3::text IS NULL OR external_user_id=$3) AND created_at>=$4 AND created_at<$5`;
 const limit=Math.min(500,Math.max(1,Number(q.get('limit'))||100)),offset=Math.max(0,Number(q.get('offset'))||0);
 const [games,rows,legs]=await Promise.all([
  pool.query(`SELECT game_id,count(*) FILTER(WHERE status NOT IN ${VOID})::int plays,count(DISTINCT external_user_id) FILTER(WHERE status NOT IN ${VOID})::int players,
    COALESCE(sum(stake) FILTER(WHERE status NOT IN ${VOID}),0)::text stake_minor,COALESCE(sum(payout) FILTER(WHERE status IN ${DONE}),0)::text payout_minor,
    count(*) FILTER(WHERE status NOT IN ${VOID} AND status NOT IN ${DONE})::int open,count(*) FILTER(WHERE status IN ${VOID})::int voided
   FROM (${PLAYS}) p WHERE ${where} GROUP BY game_id ORDER BY sum(stake) DESC NULLS LAST`,args),
  pool.query(`SELECT kind,id,app_id,game_id,external_user_id,stake::text stake_minor,payout::text payout_minor,status,created_at,count(*) OVER()::int total
   FROM (${PLAYS}) p WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,args),
  // External-wallet legs: money actually taken from / returned to the partner wallet.
  pool.query(`SELECT COALESCE(sum(amount_minor) FILTER(WHERE direction='in' AND state IN ('APPLIED','FORWARDED','DONE')),0)::text debited_minor,
    COALESCE(sum(amount_minor) FILTER(WHERE direction='out' AND state='DONE'),0)::text credited_minor,
    count(*) FILTER(WHERE state IN ('PENDING','HELD'))::int pending
   FROM gp_simple_wallet_legs WHERE ($1::text IS NULL OR app_id=$1) AND ($2::text IS NULL OR game_id=$2) AND ($3::text IS NULL OR external_user_id=$3) AND created_at>=$4 AND created_at<$5`,args)
 ]);
 const total=games.rows.reduce((t,g)=>({plays:t.plays+g.plays,players:null,stake:t.stake+BigInt(g.stake_minor),payout:t.payout+BigInt(g.payout_minor),open:t.open+g.open}),{plays:0,players:null,stake:0n,payout:0n,open:0});
 const players=(await pool.query(`SELECT count(DISTINCT external_user_id)::int n FROM (${PLAYS}) p WHERE ${where} AND status NOT IN ${VOID}`,args)).rows[0].n;
 return {range:{from:f.from.toISOString(),to:f.to.toISOString()},
  summary:{plays:total.plays,players,stake_minor:String(total.stake),payout_minor:String(total.payout),net_minor:String(total.stake-total.payout),open:total.open},
  games:games.rows.map(g=>({...g,net_minor:String(BigInt(g.stake_minor)-BigInt(g.payout_minor))})),
  wallet:legs.rows[0],
  rows:rows.rows.map(({total,...r})=>r),total:rows.rows[0]?.total||0,limit,offset};
}
