import {randomBytes} from 'node:crypto';
import {pool,tx,locked} from './db.mjs';
import {id,hash,seal,unseal,fail} from './security.mjs';
import {appById,scope,audit,validate} from './platform.mjs';
import {getProfile,playCycle} from './math/index.ts';
import {walletRequest,validatedWalletBalance} from './wallet-binding.mjs';
import {assertNewFinancialAdmission,FIRSTPARTY_FREE_PROFILE,publicAdmissionCapability} from './production-admission.mjs';
export {walletRequest} from './wallet-binding.mjs';
export const walletBalance=validatedWalletBalance;
const recoveryBatchSize=20,recoveryLock='recovery:probability';
// Persist the schedule, so restarting a worker cannot reset an outage into a
// retry storm. Interactive retries still query the original operation at once.
const recoveryDelayMs=attempt=>Math.min(300000,3000*2**Math.min(7,Math.max(0,attempt-1)));
const recoveryCandidates=`SELECT c.id FROM gp_cycles c
  LEFT JOIN gp_operations o ON o.id=CASE c.status
    WHEN 'AUTHORIZING' THEN 'authorize_'||c.id
    WHEN 'AUTHORIZED' THEN 'accept_'||c.id
    WHEN 'RESULT_FIXED' THEN 'settle_'||c.id END
  WHERE c.status NOT IN ('SETTLED','REJECTED')
    AND COALESCE((c.error->>'next_attempt_at')::timestamptz,c.updated_at)<=now()
    AND (o.id IS NULL OR o.state<>'PENDING' OR o.next_attempt_at<=now())`;
export async function command(app,cycleId,path,body){
  const raw=JSON.stringify(body);await pool.query('INSERT INTO gp_operations(id,app_id,aggregate_id,path,raw_body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[body.request_id,app.id,cycleId,path,raw]);
  let op=(await pool.query('SELECT * FROM gp_operations WHERE id=$1',[body.request_id])).rows[0];
  if(op.path!==path)fail(409,'IDEMPOTENCY_CONFLICT');
  // Always reuse persisted bytes, including the original authorization expiry.
  if(op.state==='SUCCEEDED')return op.response;
  if(op.state==='REJECTED')fail(409,op.response?.rejection?.code||'WALLET_REJECTED');
  let result;
  try{
    if(op.attempts>0){try{result=await walletRequest(app,'GET','/wallet/v1/operations/'+op.id);}catch(e){if(e.status!==404)throw e;}}
    if(!result||result.state==='PENDING')result=await walletRequest(app,'POST',op.path,op.raw_body,op.id);
    try{validate('Operation',result);}catch{fail(503,'WALLET_INVALID_RESPONSE');}
    if(!['SUCCEEDED','REJECTED','PENDING'].includes(result.state)||result.operation_id!==op.id||result.body_sha256!==hash(op.raw_body))fail(503,'WALLET_INVALID_RESPONSE');
    for(const[k,v]of Object.entries(scope(app)))if(result[k]!==v)fail(503,'WALLET_INVALID_SCOPE');
    if(result.state==='SUCCEEDED'){
      const frozen=JSON.parse(op.raw_body),resource=result.receipt?.resource;
      if(!resource||result.receipt.resource_type!=='probability_authorization')fail(503,'WALLET_INVALID_RECEIPT');
      for(const k of ['cycle_id','authorization_id','game_id','math_version','math_config_hash','stake_minor','gross_payout_minor','result_hash'])if(frozen[k]!==undefined&&resource[k]!==frozen[k])fail(503,'WALLET_INVALID_RECEIPT');
      const expected={authorize:'AUTHORIZED',accept:'ACCEPTED',settle:'SETTLED',cancel:'CANCELLED'}[op.path.split('/').pop()];
      if(resource.state!==expected)fail(503,'WALLET_INVALID_RECEIPT');
    }
    await pool.query("UPDATE gp_operations SET state=$1,response=$2,attempts=attempts+1,updated_at=now(),next_attempt_at=now()+$4::int*interval '1 millisecond' WHERE id=$3",[result.state,result,op.id,result.state==='PENDING'?recoveryDelayMs(op.attempts+1):0]);
  }catch(e){await pool.query("UPDATE gp_operations SET attempts=attempts+1,updated_at=now(),next_attempt_at=now()+$2::int*interval '1 millisecond' WHERE id=$1",[op.id,recoveryDelayMs(op.attempts+1)]);throw e;}
  if(result.state==='REJECTED')fail(409,result.rejection?.code||'WALLET_REJECTED',result.rejection?.message);
  if(result.state!=='SUCCEEDED')fail(503,'WALLET_PENDING');return result;
}
async function advanceUnlocked(cycleId){
  let cycle=(await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[cycleId])).rows[0];if(!cycle||['SETTLED','REJECTED'].includes(cycle.status))return cycle;
  try{
    const app=await appById(cycle.app_id),s=scope(app),base={...s,authorization_id:'auth_'+cycle.id,cycle_id:cycle.id};
    if(cycle.status==='AUTHORIZING'){
      await command(app,cycle.id,'/wallet/v1/probability/authorize',{...base,request_id:'authorize_'+cycle.id,external_user_id:cycle.external_user_id,game_id:cycle.game_id,math_version:cycle.math_version,math_config_hash:cycle.math_hash,stake_minor:cycle.stake_minor,max_payout_minor:cycle.max_payout_minor,expires_at:new Date(Date.now()+60000).toISOString()});
      await pool.query("UPDATE gp_cycles SET status='AUTHORIZED',updated_at=now() WHERE id=$1",[cycle.id]);cycle.status='AUTHORIZED';
    }
    if(cycle.status==='AUTHORIZED'){
      await command(app,cycle.id,'/wallet/v1/probability/accept',{...base,request_id:'accept_'+cycle.id});
      await pool.query("UPDATE gp_cycles SET status='ACCEPTED',updated_at=now() WHERE id=$1",[cycle.id]);cycle.status='ACCEPTED';
    }
    if(cycle.status==='ACCEPTED'){
      // No RNG before a persisted, confirmed acceptance. Crash before this commit
      // exposes no result; after this commit every caller reads this exact result.
      const executable=getProfile(cycle.game_id,cycle.math_profile);
      if(executable.version!==cycle.math_version||executable.hash!==cycle.math_hash)fail(503,'PINNED_MATH_UNAVAILABLE','必须加载该周期冻结的数学版本才能恢复');
      const seed=randomBytes(32).toString('hex'),result=playCycle(cycle.game_id,Number(cycle.stake_minor),cycle.math_profile,seed);
      if(result.mathVersion!==cycle.math_version||result.mathConfigHash!==cycle.math_hash)throw Error('Math version invariant');
      if(!Number.isSafeInteger(result.grossPayoutMinor)||result.grossPayoutMinor<0||BigInt(result.grossPayoutMinor)>BigInt(cycle.max_payout_minor))throw Error('Math liability invariant');
      const digest=hash(JSON.stringify(result));
      await pool.query("UPDATE gp_cycles SET status='RESULT_FIXED',seed_enc=$1,result=$2,result_hash=$3,payout_minor=$4,updated_at=now() WHERE id=$5",[seal(seed),result,digest,String(result.grossPayoutMinor),cycle.id]);
      cycle={...cycle,status:'RESULT_FIXED',result,result_hash:digest,payout_minor:String(result.grossPayoutMinor)};
    }
    if(cycle.status==='RESULT_FIXED'){
      await command(app,cycle.id,'/wallet/v1/probability/settle',{...base,request_id:'settle_'+cycle.id,game_id:cycle.game_id,math_version:cycle.math_version,math_config_hash:cycle.math_hash,stake_minor:cycle.stake_minor,gross_payout_minor:cycle.payout_minor,result_hash:cycle.result_hash});
      await tx(async c=>{await c.query("UPDATE gp_cycles SET status='SETTLED',error=NULL,updated_at=now() WHERE id=$1",[cycle.id]);await audit('settlement-worker','cycle.settled',app.id,{cycle_id:cycle.id,result_hash:cycle.result_hash},c);});cycle.status='SETTLED';
    }
  }catch(e){
    const rejected=(await pool.query("SELECT 1 FROM gp_operations WHERE aggregate_id=$1 AND state='REJECTED'",[cycle.id])).rowCount;
    const terminal=rejected&&['AUTHORIZING','AUTHORIZED'].includes(cycle.status);
    // Include non-wallet failures (for example an unavailable pinned math
    // version) in the same durable schedule. Otherwise they can occupy every
    // oldest-first batch even when there is no pending wallet operation.
    const attempts=(Number(cycle.error?.recovery_attempts)||0)+1;
    await pool.query("UPDATE gp_cycles SET status=$1,error=jsonb_build_object('code',$2::text,'recovery_attempts',$4::int,'next_attempt_at',now()+$5::int*interval '1 millisecond'),updated_at=now() WHERE id=$3",[terminal?'REJECTED':cycle.status,e.code||'RECOVERY_PENDING',cycle.id,attempts,recoveryDelayMs(attempts)]);
    if(terminal)fail(409,e.code||'WALLET_REJECTED',e.message);
    fail(503,'SETTLEMENT_PENDING','结果处理中，请稍后重试原请求；系统将自动查单恢复');
  }
  return (await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[cycle.id])).rows[0];
}
export const advanceCycle=cycleId=>locked('cycle:'+cycleId,()=>advanceUnlocked(cycleId));
function balanceMinor(response){const b=response.balance||response;return b.available_minor??b.total_minor??b.balance_minor;}
export async function publicSession(s){
  const app=await appById(s.app_id),b=await walletBalance(app,s.external_user_id),minor=balanceMinor(b);if(minor===undefined)fail(503,'WALLET_INVALID_BALANCE');
  // Persisted session provenance describes this accepted session. New rooms
  // independently recheck current App and admission policy in their transaction.
  if(s.admission_profile===FIRSTPARTY_FREE_PROFILE)return{mode:'production',platformMode:'production',sessionId:s.id,epoch:0,stateVersion:s.state.version,balance:Number(minor)/10**app.currency_scale,betChoices:[],mathVersion:null,pendingRound:null,freeSpins:0,freeMultiplier:0,lockedBet:null,admission_profile:s.admission_profile,admission_revision:String(s.admission_revision),...publicAdmissionCapability({profile:s.admission_profile,game_ids:[]})};
  let pending=null,remaining=0,freeMultiplier=0,lockedBet=null,mathVersion=getProfile(s.game_id,app.math_profile).version;
  if(s.state.pendingPlay)pending=(await pool.query('SELECT payload FROM gp_plays WHERE id=$1',[s.state.pendingPlay])).rows[0]?.payload||null;
  if(s.state.cycleId){const cycle=(await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[s.state.cycleId])).rows[0];if(cycle?.result){if(s.state.pendingPlay||s.state.nextIndex<cycle.result.rounds.length)mathVersion=cycle.math_version;remaining=cycle.result.rounds[Math.max(0,s.state.nextIndex-1)]?.freeSpinsAfter||0;freeMultiplier=cycle.result.rounds[Math.max(0,s.state.nextIndex-1)]?.nextFreeMultiplier||0;lockedBet=remaining?Number(cycle.stake_minor)/100:null;}}
  return {mode:'demo',platformMode:'sandbox',sessionId:s.id,epoch:0,stateVersion:s.state.version,balance:Number(minor)/100,betChoices:[10,50,100,200,500],mathVersion,pendingRound:pending,freeSpins:remaining,freeMultiplier,lockedBet};
}
export async function spin(session,body){
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId||'')||![10,50,100,200,500].includes(body.bet)||!Number.isSafeInteger(body.expectedVersion))fail(400,'INVALID_REQUEST');
  return locked('session:'+session.id,async()=>{
    let s=(await pool.query('SELECT * FROM gp_sessions WHERE id=$1',[session.id])).rows[0];
    const prior=(await pool.query('SELECT * FROM gp_plays WHERE session_id=$1 AND request_id=$2',[s.id,body.requestId])).rows[0];
    if(prior){if(prior.bet!==body.bet)fail(409,'IDEMPOTENCY_CONFLICT');return {session:await publicSession(s),round:prior.payload};}
    if(s.state.pendingPlay)fail(409,'ROUND_PENDING','先完成当前回合演出');
    if(body.expectedVersion!==s.state.version)fail(409,'STATE_CHANGED','会话已更新，请恢复当前状态');
    const app=await appById(s.app_id);let cycle,index=0;
    if(s.state.cycleId){cycle=(await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[s.state.cycleId])).rows[0];if(cycle?.result&&s.state.nextIndex<cycle.result.rounds.length)index=s.state.nextIndex;else cycle=null;}
    if(!cycle){
      cycle=(await pool.query('SELECT * FROM gp_cycles WHERE session_id=$1 AND request_id=$2',[s.id,body.requestId])).rows[0];
      if(cycle&&Number(cycle.stake_minor)!==body.bet*100)fail(409,'IDEMPOTENCY_CONFLICT');
      if(!cycle){
        await assertNewFinancialAdmission(pool,app);
        if(app.status!=='active'||!app.game_ids.includes(s.game_id))fail(403,'GAME_DISABLED');
        const m=getProfile(s.game_id,app.math_profile),cid=id('cycle');
        // Exactly one unresolved cycle per session, even when a client changes request ID.
        const pending=(await pool.query("SELECT id FROM gp_cycles WHERE session_id=$1 AND (status NOT IN ('SETTLED','REJECTED') OR (status='SETTLED' AND NOT EXISTS(SELECT 1 FROM gp_plays p WHERE p.cycle_id=gp_cycles.id)))",[s.id])).rows[0];if(pending)fail(409,'ROUND_PENDING','有一局正在查单，请恢复原请求');
        cycle=(await pool.query('INSERT INTO gp_cycles(id,session_id,app_id,external_user_id,game_id,request_id,stake_minor,math_profile,math_version,math_hash,max_payout_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[cid,s.id,app.id,s.external_user_id,s.game_id,body.requestId,String(body.bet*100),app.math_profile,m.version,m.hash,String(BigInt(body.bet*100)*BigInt(m.maxMultiplier))])).rows[0];
      }
      if(cycle.status==='REJECTED')fail(409,cycle.error?.code||'WALLET_REJECTED');cycle=await advanceCycle(cycle.id);
    }else if(Number(cycle.stake_minor)!==body.bet*100)fail(409,'LOCKED_BET','免费转沿用已冻结的投注');
    const engine=cycle.result.rounds[index],stateBefore=await publicSession(s),roundId=id('round');
    const payload={id:roundId,requestId:body.requestId,epoch:0,bet:body.bet,win:engine.totalWin/100,balanceBefore:index===0?stateBefore.balance-Number(cycle.payout_minor)/100+body.bet:stateBefore.balance,balanceAfter:stateBefore.balance,balanceScope:'complete_cycle',createdAt:new Date().toISOString(),engine,isFreeSpin:index>0,freeSpinsBefore:engine.freeSpinsBefore||0,freeSpinsAfter:engine.freeSpinsAfter||0,cycleId:cycle.id,settlementStatus:'SETTLED'};
    const state={version:s.state.version+1,pendingPlay:roundId,cycleId:cycle.id,nextIndex:index+1};
    await tx(async c=>{await c.query('INSERT INTO gp_plays(id,session_id,request_id,cycle_id,round_index,bet,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',[roundId,s.id,body.requestId,cycle.id,index,body.bet,payload]);await c.query('UPDATE gp_sessions SET state=$1 WHERE id=$2',[state,s.id]);});
    s={...s,state};return {session:await publicSession(s),round:payload};
  });
}
export async function acknowledge(s,body){return locked('session:'+s.id,async()=>{
  const p=(await pool.query('SELECT * FROM gp_plays WHERE id=$1 AND session_id=$2',[body.roundId,s.id])).rows[0];if(!p)fail(404,'ROUND_NOT_FOUND');
  await tx(async c=>{await c.query('UPDATE gp_plays SET acknowledged=true WHERE id=$1',[p.id]);await c.query("UPDATE gp_sessions SET state=jsonb_set(state,'{pendingPlay}','null') WHERE id=$1 AND state->>'pendingPlay'=$2",[s.id,p.id]);});
  return {session:await publicSession((await pool.query('SELECT * FROM gp_sessions WHERE id=$1',[s.id])).rows[0])};
});}
let recovering=false;
export async function recoverPending(){
  if(recovering)return;recovering=true;
  let worker,ownsWorker=false,workerError;
  try{
    worker=await pool.connect();
    // The in-process guard also needs a database counterpart: rolling restarts
    // can otherwise run two workers over the same overdue batch.
    ownsWorker=(await worker.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[recoveryLock])).rows[0].locked;
    if(!ownsWorker)return;
    const rows=(await pool.query(recoveryCandidates+' ORDER BY c.updated_at,c.created_at,c.id LIMIT $1',[recoveryBatchSize])).rows;
    for(const r of rows){
      const key='cycle:'+r.id,ownsCycle=(await worker.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
      if(!ownsCycle)continue; // Never queue behind a slow interactive spin.
      try{
        // A manual retry may have finished or rescheduled this cycle after the
        // batch was selected. Recheck while holding its existing advisory lock.
        if((await pool.query(recoveryCandidates+' AND c.id=$1',[r.id])).rowCount)await advanceUnlocked(r.id);
      }catch{ /* Intent and retry deadline remain durable in the admin queue. */ }
      finally{await worker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
    }
    await pool.query("DELETE FROM gp_nonces WHERE created_at<now()-interval '11 minutes'");
  }catch(e){workerError=e;throw e;}
  finally{
    try{if(ownsWorker)await worker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[recoveryLock]);}
    catch(e){workerError=e;throw e;}
    // If an unlock failed, discard the connection instead of returning a
    // possibly still-locked session to the application pool.
    finally{worker?.release(workerError);recovering=false;}
  }
}
