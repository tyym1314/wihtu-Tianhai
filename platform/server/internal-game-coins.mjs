/** Once-only, balanced issuance of nonredeemable coins inside the existing ledger.
 * No HTTP endpoint, deposit, withdrawal, wallet key or third-party adapter. */
import {randomUUID,createHash} from 'node:crypto';
import {getProfile} from './math/index.ts';
import {FIRSTPARTY_INTERNAL_PROFILE,INTERNAL_GAME_COINS,unitsPerCoin} from './production-admission.mjs';
import {fail} from './security.mjs';

const fields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX=9223372036854775807n;
const require=(value,code)=>{if(!value)fail(409,code);};

export async function issueInternalGameCoins(db,admission,externalUserId,actor){
 require(admission?.profile===FIRSTPARTY_INTERNAL_PROFILE&&admission.open===true,'INTERNAL_COIN_POLICY_REQUIRED');
 require(typeof db.release==='function','INTERNAL_COIN_TRANSACTION_REQUIRED');
 const app=admission.app,scope=Object.fromEntries(fields.map(k=>[k,k==='app_id'?app.id:app[k]]));
 const id=fields.map(k=>scope[k]).join(':'),factor=BigInt(unitsPerCoin(app.currency_scale));
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
 const wallet=(await db.query('SELECT * FROM wallet_scopes WHERE scope_id=$1 FOR UPDATE',[id])).rows[0];
 require(wallet&&wallet.currency_scale===app.currency_scale&&fields.every(k=>wallet[k]===scope[k]),'INTERNAL_COIN_SCOPE_CHANGED');
 // Register exact kernels and maximum responsibilities; no RNG or wallet spend
 // may run until authorize confirms the complete-cycle liability reservation.
 for(const game of ['thunder','tiger'])for(const tier of ['98','99']){
  const m=getProfile(game,tier),previous=(await db.query('SELECT * FROM wallet_math_profiles WHERE scope_id=$1 AND game_id=$2 AND math_version=$3',[id,game,m.version])).rows[0];
  require(!previous||(previous.math_config_hash===m.hash&&previous.max_payout_multiplier===String(m.maxMultiplier)),'INTERNAL_COIN_MATH_CHANGED');
  await db.query('INSERT INTO wallet_math_profiles(scope_id,game_id,math_version,math_config_hash,max_payout_multiplier) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[id,game,m.version,m.hash,String(m.maxMultiplier)]);
 }
 async function issue(account,coins){
  const amount=(BigInt(coins)*factor).toString();
  const body={...scope,profile:FIRSTPARTY_INTERNAL_PROFILE,coin_scope:INTERNAL_GAME_COINS.coin_scope,account,amount_minor:amount,redeemable:false};
  const operationId='internal_coin_v1_'+digest({account}).slice(0,40),bodyHash=digest(body);
  await db.query('INSERT INTO wallet_operation_ids(partner_id,app_id,environment,operation_id,scope_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[scope.partner_id,scope.app_id,scope.environment,operationId,id]);
  const registry=(await db.query('SELECT scope_id FROM wallet_operation_ids WHERE partner_id=$1 AND app_id=$2 AND environment=$3 AND operation_id=$4',[scope.partner_id,scope.app_id,scope.environment,operationId])).rows[0];
  require(registry?.scope_id===id,'INTERNAL_COIN_IDEMPOTENCY_CONFLICT');
  const old=(await db.query('SELECT * FROM wallet_operations WHERE scope_id=$1 AND operation_id=$2',[id,operationId])).rows[0];
  if(old){require(old.kind==='issue_internal_coins'&&old.method==='POST'&&old.path==='/internal/game-coins/issue'&&old.body_sha256===bodyHash&&old.state==='SUCCEEDED','INTERNAL_COIN_IDEMPOTENCY_CONFLICT');return;}
  let available;
  if(account==='treasury'){
   available=BigInt(wallet.treasury_available)+BigInt(amount);require(available<=MAX,'INTERNAL_COIN_CAPACITY');
   await db.query('UPDATE wallet_scopes SET treasury_available=$2 WHERE scope_id=$1',[id,available.toString()]);wallet.treasury_available=available.toString();
  }else{
   const user=(await db.query('SELECT * FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2 FOR UPDATE',[id,externalUserId])).rows[0];
   require(user&&account==='user:'+user.external_user_id,'INTERNAL_COIN_USER_REQUIRED');
   available=BigInt(user.available)+BigInt(amount);require(available+BigInt(user.reserved)+BigInt(user.credit_pending)<=MAX,'INTERNAL_COIN_CAPACITY');
   await db.query('UPDATE wallet_users SET available=$3 WHERE scope_id=$1 AND external_user_id=$2',[id,externalUserId,available.toString()]);
  }
  const issued=BigInt(wallet.internal_coin_issued)+BigInt(amount);require(issued<=MAX,'INTERNAL_COIN_CAPACITY');
  await db.query('UPDATE wallet_scopes SET internal_coin_issued=$2 WHERE scope_id=$1',[id,issued.toString()]);wallet.internal_coin_issued=issued.toString();
  const transactionId='wl_'+randomUUID().replaceAll('-',''),at=new Date().toISOString();
  const meta={kind:'internal_coin_issuance',...body,approved_policy:{release:admission.release,manifest_sha256:admission.manifest_sha256,proof_sha256:admission.proof_sha256,revision:admission.revision}};
  await db.query('INSERT INTO wallet_ledger(scope_id,operation_id,transaction_id,account,delta_available,delta_reserved,meta) VALUES($1,$2,$3,$4,$5,0,$6),($1,$2,$3,$7,$8,0,$6)',[id,operationId,transactionId,account,amount,JSON.stringify(meta),'internal_coin_issuance',(-BigInt(amount)).toString()]);
  await db.query('UPDATE wallet_scopes SET ledger_version=ledger_version+2 WHERE scope_id=$1',[id]);
  const operation={...scope,operation_id:operationId,kind:'issue_internal_coins',state:'SUCCEEDED',body_sha256:bodyHash,receipt:{resource_type:'internal_coin_issuance',resource:body,ledger_transaction_id:transactionId,committed_at:at},created_at:at,updated_at:at};
  await db.query("INSERT INTO wallet_operations(scope_id,operation_id,kind,method,path,body_sha256,state,response_status,response_body,operation) VALUES($1,$2,'issue_internal_coins','POST','/internal/game-coins/issue',$3,'SUCCEEDED',200,$4,$4)",[id,operationId,bodyHash,JSON.stringify(operation)]);
  await db.query("INSERT INTO gp_audit(actor,action,app_id,detail) VALUES($1,'internal_coin.issued',$2,$3)",[actor,app.id,{operation_id:operationId,account,amount_minor:amount,coin_scope:INTERNAL_GAME_COINS.coin_scope,redeemable:false}]);
 }
 await issue('treasury',INTERNAL_GAME_COINS.initial_treasury_coins);
 await issue('user:'+externalUserId,INTERNAL_GAME_COINS.initial_player_coins);
}
