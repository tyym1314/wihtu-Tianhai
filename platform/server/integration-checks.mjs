import {pool,tx,locked} from './db.mjs';
import {id,hash,unseal,fail} from './security.mjs';
import {appById,scope,origin,audit} from './platform.mjs';
import {walletRequest,validatedWalletBalance} from './wallet-binding.mjs';
import {OasisClient} from '../specs/examples/sdk-node.mjs';

const apiBase=()=>`http://127.0.0.1:${process.env.OASIS_API_PORT||8797}`;
const users=['demo_player','demo_player_2'];
const active=new Set();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(condition,code)=>{if(!condition)fail(409,code);};
export async function migrateIntegrationChecks(){await pool.query(`CREATE TABLE IF NOT EXISTS gp_integration_checks (
 id text PRIMARY KEY,app_id text NOT NULL REFERENCES gp_apps,request_id text NOT NULL,actor text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED',checks jsonb NOT NULL DEFAULT '[]',artifacts jsonb NOT NULL DEFAULT '{}',
 error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(app_id,request_id));
 CREATE UNIQUE INDEX IF NOT EXISTS gp_integration_one_active ON gp_integration_checks(app_id) WHERE status IN ('QUEUED','RUNNING');
 ALTER TABLE gp_integration_checks ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
 ALTER TABLE gp_integration_checks ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;`);}
export async function listIntegrationChecks(appId){return(await pool.query('SELECT * FROM gp_integration_checks WHERE app_id=$1 ORDER BY created_at DESC LIMIT 12',[appId])).rows;}
export async function startIntegrationCheck(appId,body,actor){
 if(!/^[A-Za-z0-9_-]{8,96}$/.test(body.request_id||'')||body.confirm_sandbox_wallet!==true||Object.keys(body).some(k=>!['request_id','confirm_sandbox_wallet'].includes(k)))fail(400,'INVALID_CHECK_REQUEST');
 const row=await tx(async c=>{
  const app=(await c.query('SELECT * FROM gp_apps WHERE id=$1 FOR UPDATE',[appId])).rows[0];if(!app)fail(404,'NOT_FOUND');
  check(app.environment==='sandbox'&&app.status==='active','CHECK_REQUIRES_ACTIVE_SANDBOX');
  const previous=(await c.query('SELECT * FROM gp_integration_checks WHERE app_id=$1 AND request_id=$2',[appId,body.request_id])).rows[0];if(previous)return previous;
  if((await c.query("SELECT 1 FROM gp_integration_checks WHERE app_id=$1 AND status IN ('QUEUED','RUNNING')",[appId])).rowCount)fail(409,'CHECK_ALREADY_RUNNING');
  if((await c.query('SELECT 1 FROM pvp_active_users WHERE app_id=$1 AND external_user_id=ANY($2)',[appId,users])).rowCount)fail(409,'TEST_USERS_BUSY');
  const row=(await c.query('INSERT INTO gp_integration_checks(id,app_id,request_id,actor) VALUES($1,$2,$3,$4) RETURNING *',[id('check'),appId,body.request_id,actor])).rows[0];
  await audit(actor,'integration.check_started',appId,{check_id:row.id,users,entry_minor:'10000'},c);return row;
 });
 if(['QUEUED','RUNNING'].includes(row.status))void runCheck(row.id);return row;
}
async function platformRequest(path,body,token){
 const r=await fetch(apiBase()+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)});
 const data=await r.json();if(!r.ok){const e=new Error('Platform check request failed');e.code=data.error?.code||data.code||'PLATFORM_REQUEST_FAILED';e.status=r.status;throw e;}return data;
}
async function runCheck(checkId){
 if(active.has(checkId))return;active.add(checkId);
 try{await locked('integration:'+checkId,async()=>{
  const row=(await pool.query('SELECT * FROM gp_integration_checks WHERE id=$1',[checkId])).rows[0];if(!row||!['QUEUED','RUNNING'].includes(row.status))return;
  if(new Date(row.next_attempt_at).getTime()>Date.now())return;
  const app=await appById(row.app_id),art=row.artifacts,checks=row.checks;
  const persist=()=>pool.query("UPDATE gp_integration_checks SET artifacts=$2,checks=$3,status='RUNNING',updated_at=now() WHERE id=$1",[checkId,art,JSON.stringify(checks)]);
  const step=async(key,title,fn)=>{if(checks.some(v=>v.key===key&&v.status==='passed'))return;art.current_step=title;await persist();const started=Date.now();const detail=await fn();checks.push({key,title,status:'passed',elapsed_ms:Date.now()-started,detail});await persist();};
  const key=(await pool.query("SELECT * FROM gp_keys WHERE app_id=$1 AND direction='partner-to-platform' AND active ORDER BY created_at DESC LIMIT 1",[app.id])).rows[0];
  if(!key)fail(409,'PARTNER_KEY_MISSING');
  const client=new OasisClient({baseUrl:apiBase(),keyId:key.id,secretBase64:unseal(key.secret_enc),scope:scope(app)});
  const balances=async()=>Promise.all(users.map(user=>validatedWalletBalance(app,user)));
  const money=b=>({available:b.balance.available_minor,reserved:b.balance.reserved_minor});
  const tokenFor=async(user,game='match',resume)=>{
   const launch=await client.createSession({requestId:id('verify_launch'),externalUserId:user,gameId:game,locale:'en',hostOrigin:origin,...(resume?{resumeSessionId:resume}:{})});
   const session=await platformRequest('/v1/launch/exchange',{launch_code:launch.launch_code,client_instance_id:id('verification'),host_origin:origin,game_id:game});
   return{token:session.access_token,sessionId:session.session_id,launch};
  };
  try{
   await persist();
   await step('catalog','签名目录与应用范围',async()=>{
    const catalog=await client.games(),available=catalog.games.filter(g=>g.available).map(g=>g.game_id);
    check(catalog.app_id===app.id&&catalog.partner_id===app.partner_id,'CATALOG_SCOPE_MISMATCH');check(available.includes('match'),'MATCH_REQUIRED_FOR_CHECK');art.games=available;
    return{available_games:available,app_id:app.id};
   });
   await step('balances','测试账号与签名余额',async()=>{
    const b=await balances();for(const v of b)check(BigInt(v.balance.available_minor)>=10000n&&v.balance.reserved_minor==='0','TEST_BALANCE_NOT_READY');
    art.before=b.map(money);return{users,before:art.before};
   });
   await step('launch','授权游戏启动码与单次兑换',async()=>{
    const launched=art.launched||[];for(const game of art.games.filter(g=>!launched.some(v=>v.game_id===g))){const item=await tokenFor(users[0],game);
     let rejected=false;try{await platformRequest('/v1/launch/exchange',{launch_code:item.launch.launch_code,client_instance_id:id('replay'),host_origin:origin,game_id:game});}catch(e){if(e.code!=='LAUNCH_CODE_INVALID')throw e;rejected=true;}check(rejected,'LAUNCH_REPLAY_ACCEPTED');
     launched.push({game_id:game,session_id:item.sessionId});art.launched=launched;await persist();
    }return{launched,replay_rejected:true};
   });
   await step('scope','拒绝伪造应用范围',async()=>{
    let rejected=false;try{await client.request('POST','/v1/sessions',{...scope(app),app_id:'foreign_'+app.id,request_id:id('foreign'),external_user_id:users[0],game_id:'match',locale:'en',host_platform:'web'});}catch(e){if(e.status!==403)throw e;rejected=true;}check(rejected,'FOREIGN_SCOPE_ACCEPTED');return{forged_scope_rejected:true};
   });
   // Each resumed execution gets a fresh token for the same durable sessions.
   const a=await tokenFor(users[0],'match',art.session_a),b=await tokenFor(users[1],'match',art.session_b);art.session_a=a.sessionId;art.session_b=b.sessionId;await persist();
   const req=(token,path,body)=>platformRequest(path,body,token);
   const command=(token,path,label,body={})=>req(token,path,{request_id:`${checkId}_${label}`,...body});
   await step('cancel','未成局取消与余额保留',async()=>{
    const roomId=checkId+'_cancel';art.cancel_room_id=roomId;await persist();
    await command(a.token,'/api/pvp/rooms','create_cancel',{room_id:roomId,game_id:'match',capacity:2,entry_minor:'10000'});
    await command(a.token,`/api/pvp/rooms/${roomId}/leave`,'cancel');
    let room;for(let i=0;i<50;i++){room=await req(a.token,`/api/pvp/rooms/${roomId}`);if(room.status==='cancelled')break;await sleep(100);}if(!['cancelled','settled','voided'].includes(room.status))fail(503,'CANCEL_CONFIRMATION_PENDING');check(room.status==='cancelled','CANCEL_NOT_CONFIRMED');
    const current=(await balances()).map(money);check(JSON.stringify(current)===JSON.stringify(art.before),'CANCEL_BALANCE_CHANGED');return{room_id:roomId,status:room.status,balance_unchanged:true};
   });
   await step('settlement','双人入场、退出判胜与钱包结算',async()=>{
    const roomId=checkId+'_match';art.room_id=roomId;await persist();
    await command(a.token,'/api/pvp/rooms','create_match',{room_id:roomId,game_id:'match',capacity:2,entry_minor:'10000'});
    await command(b.token,`/api/pvp/rooms/${roomId}/join`,'join');
    await command(a.token,`/api/pvp/rooms/${roomId}/ready`,'ready_a');await command(b.token,`/api/pvp/rooms/${roomId}/ready`,'ready_b');
    let room;for(let i=0;i<70;i++){room=await req(a.token,`/api/pvp/rooms/${roomId}`);if(['active','settled','voided'].includes(room.status))break;await sleep(100);}
    if(room.status==='active')await command(b.token,`/api/pvp/rooms/${roomId}/leave`,'forfeit_b');
    for(let i=0;i<70;i++){room=await req(a.token,`/api/pvp/rooms/${roomId}`);if(['settled','voided','cancelled'].includes(room.status))break;await sleep(100);}
    art.last_room_status=room.status;
    if(!['settled','voided','cancelled'].includes(room.status))fail(503,'TEST_SETTLEMENT_PENDING');
    check(room.status==='settled'&&room.result?.resolution==='completed','TEST_SETTLEMENT_FAILED');
    const fee=20000n*BigInt(room.fee_bps)/10000n,prize=20000n-fee;
    check(room.result.fee_minor===fee.toString()&&room.result.payouts.find(p=>p.external_user_id===users[0])?.payout_minor===prize.toString(),'TEST_PAYOUT_MISMATCH');
    const after=(await balances()).map(money);check(BigInt(after[0].available)===BigInt(art.before[0].available)-10000n+prize&&BigInt(after[1].available)===BigInt(art.before[1].available)-10000n&&after.every(v=>v.reserved==='0'),'POST_SETTLEMENT_BALANCE_MISMATCH');
    art.after=after;art.fee_minor=fee.toString();art.result_hash=room.result.result_hash;
    return{room_id:roomId,pool_minor:'20000',fee_minor:fee.toString(),winner_payout_minor:prize.toString(),after,path:'second_test_user_forfeit'};
   });
   await step('replay','扣款与派奖各重复十次',async()=>{
    const operations=(await pool.query("SELECT * FROM pvp_operations WHERE room_id=$1 AND path IN ('/wallet/v1/matches/capture','/wallet/v1/matches/settle') ORDER BY created_at",[art.room_id])).rows;
    check(operations.length===2,'EXPECTED_TWO_WALLET_OPERATIONS');
    for(const op of operations)for(let i=0;i<10;i++){const r=await walletRequest(app,'POST',op.path,op.raw_body,op.id);check(r.operation_id===op.id&&r.state==='SUCCEEDED'&&r.body_sha256===hash(op.raw_body),'REPLAY_RECEIPT_MISMATCH');}
    check(JSON.stringify((await balances()).map(money))===JSON.stringify(art.after),'REPLAY_CHANGED_BALANCE');
    return{operations:operations.map(op=>op.id),repeats_each:10,balance_unchanged:true};
   });
   await step('query','原业务号查单与钱包结果一致',async()=>{
    const opId='settle_'+art.room_id,receipt=await client.operation(opId),wallet=await walletRequest(app,'GET','/wallet/v1/operations/'+opId);
    check(receipt.state==='SUCCEEDED'&&wallet.state==='SUCCEEDED'&&receipt.body_sha256===wallet.body_sha256&&wallet.receipt?.resource?.result_hash===art.result_hash,'QUERY_RECEIPT_MISMATCH');
    return{operation_id:opId,result_hash:art.result_hash,matched:true};
   });
   await pool.query("UPDATE gp_integration_checks SET status='PASSED',checks=$2,artifacts=$3,error_code=NULL,finished_at=now(),updated_at=now() WHERE id=$1",[checkId,JSON.stringify(checks),art]);
   await audit(row.actor,'integration.check_passed',app.id,{check_id:checkId,room_id:art.room_id});
  }catch(e){
   const retryable=!e.status||e.status>=500||e.status===429,status=retryable?'RUNNING':'FAILED';
   const code=/^[A-Z0-9_]{1,80}$/.test(e.code||'')?e.code:retryable?'CHECK_NETWORK_PENDING':'CHECK_FAILED';
   const retrySeconds=e.status===429?65:Math.min(30,3*2**Math.min(row.attempts||0,4));
   await pool.query("UPDATE gp_integration_checks SET status=$2,checks=$3,artifacts=$4,error_code=$5,finished_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END,attempts=attempts+1,next_attempt_at=now()+($6*interval '1 second'),updated_at=now() WHERE id=$1",[checkId,status,JSON.stringify(checks),art,code,retrySeconds]);
   await audit(row.actor,retryable?'integration.check_pending':'integration.check_failed',app.id,{check_id:checkId,code});
  }
 });}catch(e){console.error('[integration check]',e.code||'CHECK_RUNNER_FAILED');}finally{active.delete(checkId);}
}
export async function recoverIntegrationChecks(){
 const rows=(await pool.query("SELECT id FROM gp_integration_checks WHERE status IN ('QUEUED','RUNNING') AND next_attempt_at<=now() ORDER BY created_at LIMIT 5")).rows;
 for(const r of rows)void runCheck(r.id);
}
