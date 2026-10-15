import {runPracticeProfileCapability} from '../shared/run-practice-profiles.mjs';
import {createServer} from 'node:http';
import {serveGameAsset as serveLegacy} from './game-assets.mjs';
import {pool,walletPool,tx,closePools} from './db.mjs';
import {id,hash,unseal,readBody,send,fail,ApiError} from './security.mjs';
import {migrateWallet,createWalletServer} from './wallet/index.mjs';
import {migratePlatform,seedPlatform,origin,login,adminUser,appById,createApp,audit,authenticatePartner,createSession,exchange,playSession,gamesFor,scope,upgradeArenaSandbox} from './platform.mjs';
import {publicSession,spin,acknowledge,recoverPending,walletRequest,walletBalance} from './cycles.mjs';
import {migratePvp,routePvp,tickPvp,readPvpMatch} from './pvp/index.mjs';
import {compactRoomSnapshot} from './pvp/snapshot-transfer.mjs';
import {runPracticeCourseCapability} from './pvp/run-course-policy.mjs';
import {RUN_PRACTICE_INPUT_PROTOCOL} from './pvp/run-practice-protocol.mjs';
import {getProfile} from './math/index.ts';
import {ARENA_IDS,RELEASED_IDS} from '../shared/games.mjs';
import {migratePortal,routePortal} from './portal.mjs';
import {migrateWalletBindings} from './wallet-binding.mjs';
import {migrateSimpleWallet,recoverSimpleWallets} from './simple-wallet.mjs';
import {routeIntegration} from './integration-routes.mjs';
import {migrateIntegrationChecks,recoverIntegrationChecks} from './integration-checks.mjs';
import {operationsStatus} from './operations-status.mjs';
import {unitsPerCoin,firstpartyProfile,partnerProfile,publicAdmissionCapability,assertExternalFinancialRouteAllowed} from './production-admission.mjs';
import {publicAdmissionStatus} from './admission-status.mjs';
import {enginePoolStats,closeEnginePool} from './pvp/engine-pool.mjs';
import {runtime,preflightRuntime,migrateRuntime,assertProductionAppReady} from './runtime-mode.mjs';
import {migrateCredentials,routeCredentials} from './credentials.mjs';
import {routePlayer} from './player-routes.mjs';
import {ApiRateLimits} from './rate-limit.mjs';
import {activityTimeZone,migrateOverviewActivity,overviewActivity} from './overview-activity.mjs';
import {clientAddress,adminSessionCookie} from './proxy-context.mjs';
import {beginRoomReadTiming,beginGameEntryTiming} from './request-timing.mjs';
import {startRequestTimingSink} from './request-timing-sink.mjs';
import {checkWalletDependencies} from './dependency-health.mjs';
import {createTransferService,migrateTransfers,TRANSFER_PUBLIC_CODES} from './transfers/index.mjs';
import {routeTransfers} from './transfers/routes.mjs';
import {routeTransferOperations} from './transfer-operations.mjs';
const PORT=Number(process.env.OASIS_API_PORT||8797),WALLET_PORT=Number(process.env.OASIS_WALLET_PORT||8798);
const limiter=new ApiRateLimits();
// No third-party financial protocol is registered until independently configured
// and reviewed. Ordinary App HMAC cannot enable or manufacture an adapter.
const transfers=createTransferService({pool:walletPool,environment:runtime.environment});
let roomTimingSink=null;
function rate(req,key,limit){limiter.ip(clientAddress(req),key,limit);}
const authenticated=(req,fn)=>limiter.authenticate(clientAddress(req),fn);
function checkOrigin(req){if(req.headers.origin!==origin)fail(403,'ORIGIN_FORBIDDEN');}
const allowedPatch=new Set(['name','status','game_ids','math_profile','competitive_fee_bps']);
async function adminRoutes(req,res,path,b){
  if(path==='/api/admin/login'&&req.method==='POST'){checkOrigin(req);rate(req,'login',12);const r=await login(b.username,b.password);res.setHeader('set-cookie',adminSessionCookie(r.token,origin));return send(res,200,{user:r.user});}
  const user=await adminUser(req);
  if(path==='/api/admin/session'&&req.method==='GET')return send(res,200,{user,environment:runtime.environment});if(!user)fail(401,'LOGIN_REQUIRED');
  if(await routeTransferOperations(req,res,path,user,{pool,environment:runtime.environment}))return;
  if(req.method!=='GET')checkOrigin(req);
  if(path==='/api/admin/logout'&&req.method==='POST'){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('oasis_admin='))?.split('=')[1];if(token)await pool.query('DELETE FROM gp_admin_sessions WHERE token_hash=$1',[hash(token)]);res.setHeader('set-cookie',adminSessionCookie('',origin,0));return send(res,200,{ok:true});}
  if(path==='/api/admin/operations-status'&&req.method==='GET')return send(res,200,await operationsStatus());
  if(path==='/api/admin/health'&&req.method==='GET'){
    await pool.query('SELECT 1');let dependencies;
    try{dependencies=await checkWalletDependencies(pool,{environment:runtime.environment,
      referenceOrigin:process.env.OASIS_REFERENCE_WALLET_URL||`http://127.0.0.1:${WALLET_PORT}`,
      allowedOrigins:(process.env.OASIS_WALLET_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean)},
      {request:async(url,{timeoutMs})=>{const r=await fetch(url,{signal:AbortSignal.timeout(timeoutMs),redirect:'error',cache:'no-store'});return{status:r.status,body:await r.json()};}});
    }catch{dependencies={status:'failed',codes:['DEPENDENCY_READ_FAILED']};}
    return send(res,200,{api:'ok',database:'ok',wallet:dependencies.status==='ok'?'ok':'unavailable',wallet_dependencies:dependencies,
      engine_pool:enginePoolStats(),environment:runtime.environment,production_enabled:runtime.production&&runtime.admissionEnabled,admission:await publicAdmissionStatus()});
  }
  if(path==='/api/admin/apps'&&req.method==='GET')return send(res,200,{apps:(await pool.query('SELECT * FROM gp_apps ORDER BY created_at')).rows});
  if(path==='/api/admin/apps'&&req.method==='POST'){if(Object.keys(b).some(k=>k!=='name'))fail(400,'INVALID_REQUEST');return send(res,201,await createApp(b.name));}
  const appMatch=path.match(/^\/api\/admin\/apps\/([A-Za-z0-9_-]+)(\/launch)?$/);
  if(appMatch){const app=await appById(appMatch[1]);
    if(appMatch[2]&&req.method==='POST'){if(runtime.production)fail(403,'PRODUCTION_LAUNCH_REQUIRES_PARTNER_BACKEND');const body={...scope(app),request_id:id('launch'),external_user_id:b.external_user_id||'demo_player',game_id:b.game_id,locale:'en',host_platform:'web'};return send(res,200,await createSession(app,body,JSON.stringify(body)));}
    if(!appMatch[2]&&req.method==='PATCH'){
      if(!Object.keys(b).length||Object.keys(b).some(k=>!allowedPatch.has(k)))fail(400,'INVALID_REQUEST');
      if(b.name!==undefined&&(typeof b.name!=='string'||b.name.trim().length<2||b.name.length>60))fail(400,'INVALID_NAME');
      if(b.status!==undefined&&!['active','paused'].includes(b.status))fail(400,'INVALID_STATUS');
      if(b.game_ids!==undefined&&(!Array.isArray(b.game_ids)||b.game_ids.some(g=>!RELEASED_IDS.includes(g))||new Set(b.game_ids).size!==b.game_ids.length))fail(400,'INVALID_GAMES');
      if(b.math_profile!==undefined&&!['98','99'].includes(b.math_profile))fail(400,'INVALID_PROFILE');
      if(b.competitive_fee_bps!==undefined&&![300,500,800,1000].includes(b.competitive_fee_bps))fail(400,'INVALID_FEE');
      const updated=await tx(async c=>{const locked=(await c.query('SELECT * FROM gp_apps WHERE id=$1 FOR UPDATE',[app.id])).rows[0];if(b.status==='active'||(locked.status==='active'&&(b.game_ids||b.math_profile)))await assertProductionAppReady(c,{...locked,...b},{intent:'activate'});const changed=(await c.query('UPDATE gp_apps SET name=$1,status=$2,game_ids=$3,math_profile=$4,competitive_fee_bps=$6 WHERE id=$5 RETURNING *',[b.name?.trim()||locked.name,b.status||locked.status,JSON.stringify(b.game_ids||locked.game_ids),b.math_profile||locked.math_profile,app.id,b.competitive_fee_bps??locked.competitive_fee_bps])).rows[0];await audit(user.id,'app.configured',app.id,b,c);return changed;});return send(res,200,{app:updated});
    }
  }
  if(path==='/api/admin/overview'&&req.method==='GET'){
    const a=(await pool.query('SELECT count(*)::int n FROM gp_apps')).rows[0].n;
    const c=(await pool.query("SELECT count(*)::int n,count(*) FILTER(WHERE status NOT IN ('SETTLED','REJECTED'))::int pending FROM gp_cycles")).rows[0];
    const p=(await pool.query("SELECT count(*)::int n,count(*) FILTER(WHERE status NOT IN ('settled','cancelled','voided'))::int pending,COALESCE(sum((result->>'fee_minor')::bigint) FILTER(WHERE status='settled' AND NOT practice),0)::text fee FROM pvp_rooms")).rows[0];
    return send(res,200,{apps_count:a,games_count:RELEASED_IDS.length,cycles_count:c.n+p.n,pending_count:c.pending+p.pending,fee_minor:p.fee,environment:runtime.environment,wallet_status:'app_scoped',released_games:RELEASED_IDS.length});
  }
  if(path==='/api/admin/overview-activity'&&req.method==='GET')return send(res,200,await overviewActivity(activityTimeZone(req)));
  if(path==='/api/admin/rounds'&&req.method==='GET')return send(res,200,{rounds:(await pool.query(`
    SELECT id,app_id,game_id,external_user_id,status,stake_minor,payout_minor,math_version,created_at,result_hash,'settle_'||id operation_id,'probability' category,false practice FROM gp_cycles
    UNION ALL SELECT id,app_id,game_id,(SELECT string_agg(p->>'external_user_id',', ') FROM jsonb_array_elements(players) p),upper(status),entry_minor,
    (CASE WHEN result IS NOT NULL THEN (SELECT sum((p->>'payout_minor')::bigint) FROM jsonb_array_elements(result->'payouts') p) ELSE NULL END)::bigint,rule_version,created_at,result_hash,'settle_'||id,'competitive',practice FROM pvp_rooms
    ORDER BY created_at DESC LIMIT 200`)).rows});
  if(path==='/api/admin/operations'&&req.method==='GET')return send(res,200,{operations:(await pool.query(`SELECT id,app_id,aggregate_id,path,state,attempts,response,created_at,updated_at FROM gp_operations UNION ALL SELECT id,app_id,room_id,path,state,attempts,response,created_at,updated_at FROM pvp_operations ORDER BY created_at DESC LIMIT 200`)).rows});
  if(path==='/api/admin/audit'&&req.method==='GET')return send(res,200,{events:(await pool.query('SELECT * FROM gp_audit ORDER BY id DESC LIMIT 100')).rows});
  if(path==='/api/admin/profiles'&&req.method==='GET')return send(res,200,{profiles:['thunder','tiger'].flatMap(g=>['98','99'].map(p=>getProfile(g,p)))});
  fail(404,'NOT_FOUND');
}
export function createPlatformServer(){return createServer(async(req,res)=>{beginRoomReadTiming(req,res,{sink:roomTimingSink});beginGameEntryTiming(req,res);try{
  const path=req.url||'/';assertExternalFinancialRouteAllowed(runtime,path);if(path.includes('?')&&path.startsWith('/v1/'))fail(400,'INVALID_TARGET');
  if(path==='/health/ready'&&req.method==='GET'){await pool.query('SELECT 1');return send(res,200,{status:'ok',environment:runtime.environment});}
  if(path==='/health'&&req.method==='GET')return send(res,200,{status:'ok',environment:runtime.environment});
  if(path.startsWith('/legacy/')||path.startsWith('/arena/')||path.startsWith('/play/'))return await serveLegacy(req,res,path);
  const {raw,body}=await readBody(req);
  if(await routePlayer(req,res,path,body,raw))return;
  if(path.startsWith('/api/admin/')||path.startsWith('/api/partner/')){
    if(path.endsWith('/login'))rate(req,'portal-login',12);
    if(path.includes('/integration/')&&req.method==='POST')rate(req,'integration-write',30);
    if(await routeCredentials(req,res,path,body))return;
    if(await routeIntegration(req,res,path,body))return;
    if(await routePortal(req,res,path,body))return;
  }
  if(path.startsWith('/api/admin/'))return await adminRoutes(req,res,path,body);
  if(path==='/v1/launch/exchange'&&req.method==='POST'){checkOrigin(req);rate(req,'exchange',limiter.config.EXCHANGE_IP);return send(res,200,await authenticated(req,()=>exchange(body)));}
  if(path.startsWith('/v1/')){
    const app=await authenticated(req,()=>authenticatePartner(req,raw,body));limiter.partner(app,req.method);
    const transfer=await routeTransfers(transfers,app,req,path,{raw});if(transfer)return send(res,transfer.status,transfer.body);
    if(path==='/v1/sessions'&&req.method==='POST')return send(res,201,await createSession(app,body,raw));
    if(path==='/v1/games'&&req.method==='GET')return send(res,200,gamesFor(app));
    const matchQuery=path.match(/^\/v1\/matches\/([A-Za-z0-9_-]+)$/);
    if(matchQuery&&req.method==='GET')return send(res,200,await readPvpMatch(app,matchQuery[1]));
    const op=path.match(/^\/v1\/operations\/([A-Za-z0-9_-]+)$/);
    if(op&&req.method==='GET'){const r=(await pool.query('SELECT id,app_id,path,raw_body,state,response,created_at,updated_at FROM gp_operations WHERE id=$1 AND app_id=$2 UNION ALL SELECT id,app_id,path,raw_body,state,response,created_at,updated_at FROM pvp_operations WHERE id=$1 AND app_id=$2',[op[1],app.id])).rows[0];if(!r)fail(404,'NOT_FOUND');if(r.response)return send(res,200,r.response);return send(res,202,{...scope(app),operation_id:r.id,state:'PENDING',kind:r.path.includes('probability')?r.path.split('/').pop()+'_probability':r.path.endsWith('/reservations')?'reserve':r.path.split('/').pop()+'_match',body_sha256:hash(r.raw_body),created_at:r.created_at,updated_at:r.updated_at});}
    fail(404,'NOT_FOUND');
  }
  if(path==='/api/arena/session'&&req.method==='GET'){
    const s=await authenticated(req,()=>playSession(req));limiter.player(s,'pvp','GET',path);if(!ARENA_IDS.includes(s.game_id))fail(403,'GAME_SESSION_REQUIRED');// One fresh snapshot binds both reads to the authenticated App and user.
    // No identity, balance or admission response is retained across requests.
    const found=(await pool.query(`SELECT a.*,r.id AS __arena_active_id,r.game_id AS __arena_active_game
      FROM gp_apps a LEFT JOIN pvp_active_users u ON u.app_id=a.id AND u.external_user_id=$2
      LEFT JOIN pvp_rooms r ON r.id=u.room_id WHERE a.id=$1`,[s.app_id,s.external_user_id])).rows[0];
    if(!found)fail(404,'NOT_FOUND');
    const {__arena_active_id:activeId,__arena_active_game:activeGame,...app}=found;
    const active=activeId==null?undefined:{id:activeId,game_id:activeGame};
    let balance=null,balance_error=null;try{balance=await walletBalance(app,s.external_user_id);}catch(e){balance_error='BALANCE_UNAVAILABLE';}
    return send(res,200,{session_id:s.id,external_user_id:s.external_user_id,game_id:s.game_id,locale:s.locale||null,scope:scope(app),balance,balance_error,competitive_fee_bps:app.competitive_fee_bps,
      ...(firstpartyProfile(s.admission_profile)||partnerProfile(s.admission_profile)?{...publicAdmissionCapability({profile:s.admission_profile,open:true,game_ids:app.game_ids}),admission_revision:String(s.admission_revision)}:{}),
      ...(s.game_id==='run'?{run_practice_input_protocol:RUN_PRACTICE_INPUT_PROTOCOL,run_practice_input_profiles:runPracticeProfileCapability(),run_practice_courses:runPracticeCourseCapability()}:{}),
      active_room_id:active?.game_id===s.game_id?active.id:null,other_active_game:active&&active.game_id!==s.game_id?active.game_id:null});
  }
  if(path.startsWith('/api/pvp/')){if(req.method==='POST')checkOrigin(req);const session=await authenticated(req,()=>playSession(req));limiter.player(session,'pvp',req.method,path);const r=await routePvp(session,req.method,path,body);if(!r)fail(404,'NOT_FOUND');return send(res,r.status,req.method==='GET'&&r.status===200?compactRoomSnapshot(r.body,req.headers['x-oasis-known-actions'],{runKey:req.headers['x-oasis-known-run-game'],session}):r.body);}
  const play=path.match(/^\/api\/play\/(thunder|tiger)\/(session|spin|ack|history|config)$/);
  if(play){const s=await authenticated(req,()=>playSession(req));limiter.player(s,'probability',req.method,path);if(req.method==='POST')checkOrigin(req);if(s.game_id!==play[1])fail(403,'SCOPE_FORBIDDEN');const route=play[2];
    if(route==='session'&&req.method==='GET'){
      // Reattach a result fixed/settled during a lost response or process restart.
      if(!s.state.pendingPlay){const lost=(await pool.query("SELECT c.* FROM gp_cycles c WHERE c.session_id=$1 AND c.status!='REJECTED' AND NOT EXISTS(SELECT 1 FROM gp_plays p WHERE p.cycle_id=c.id) ORDER BY c.created_at LIMIT 1",[s.id])).rows[0];if(lost){const r=await spin(s,{requestId:lost.request_id,bet:Number(lost.stake_minor)/unitsPerCoin((await appById(s.app_id)).currency_scale),expectedVersion:s.state.version});return send(res,200,r.session);}}
      return send(res,200,await publicSession(s));
    }
    if(route==='spin'&&req.method==='POST')return send(res,200,await spin(s,body));
    if(route==='ack'&&req.method==='POST')return send(res,200,await acknowledge(s,body));
    if(route==='history'&&req.method==='GET')return send(res,200,{rounds:(await pool.query('SELECT payload FROM gp_plays WHERE session_id=$1 ORDER BY created_at DESC LIMIT 20',[s.id])).rows.map(r=>r.payload)});
    if(route==='config'&&req.method==='GET'){const configured=await appById(s.app_id);let profile=configured.math_profile;if(s.state.cycleId){const current=(await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[s.state.cycleId])).rows[0];if(current?.result&&(s.state.pendingPlay||s.state.nextIndex<current.result.rounds.length))profile=current.math_profile;}return send(res,200,{...getProfile(s.game_id,profile),demoOnly:configured.environment!=='production',unitsPerCoin:unitsPerCoin(configured.currency_scale),...publicAdmissionCapability({profile:s.admission_profile,open:true,game_ids:configured.game_ids}),betChoices:getProfile(s.game_id,profile).config.stakeMinorChoices.map(value=>value/unitsPerCoin(configured.currency_scale))});}
    fail(405,'METHOD_NOT_ALLOWED');
  }
  fail(404,'NOT_FOUND');
}catch(e){if(res.headersSent||res.destroyed)return;const status=e.status||500;if(status===429)res.setHeader('retry-after',String(e.retryAfterSeconds||60));if(status>=500&&!(e instanceof ApiError))console.error('[platform]',e.code||e.message);const message=(e.status?e.message:'服务暂时不可用，请保留原请求重试').slice(0,512);if((req.url||'').startsWith('/v1/')){const allowed=['INVALID_REQUEST','AMOUNT_MISMATCH','SIGNATURE_INVALID','TIMESTAMP_EXPIRED','NONCE_REPLAY','LAUNCH_CODE_INVALID','SCOPE_FORBIDDEN','GAME_DISABLED','NOT_FOUND','IDEMPOTENCY_CONFLICT','INVALID_STATE','RATE_LIMITED','INTERNAL_ERROR'];const code=(allowed.includes(e.code)||TRANSFER_PUBLIC_CODES.includes(e.code))?e.code:status>=500?'INTERNAL_ERROR':status===403?'SCOPE_FORBIDDEN':status===409?'INVALID_STATE':'INVALID_REQUEST';send(res,status,{code,message,trace_id:id('trace'),retryable:status>=500||status===429});}else send(res,status,{error:{code:e.code||'INTERNAL_ERROR',message}});}});}
await preflightRuntime(pool);await migrateWallet(pool);await migratePlatform();await migrateRuntime(pool);await migratePortal();await migrateCredentials();await seedPlatform();await migratePvp(pool);await migrateOverviewActivity();await migrateWalletBindings(pool);await migrateSimpleWallet(pool);await migrateIntegrationChecks();await upgradeArenaSandbox();await migrateTransfers(pool);
// Fail before listening if persisted credentials cannot be decrypted with this instance key.
for(const key of (await pool.query('SELECT secret_enc FROM gp_keys')).rows)unseal(key.secret_enc);
const wallet=process.env.OASIS_START_WALLET==='0'?null:createWalletServer(walletPool);if(wallet)await new Promise(r=>wallet.listen(WALLET_PORT,'127.0.0.1',r));
roomTimingSink=await startRequestTimingSink().catch(()=>null);
roomTimingSink?.closed.then(result=>console.log(JSON.stringify({event:'oasis.room_timing.closed',boot_id:result.boot_id,pid:result.pid,
 state:result.state,reason:result.reason,incomplete:result.incomplete,confirmed_written_records:result.confirmed_written_records,
 confirmed_written_bytes:result.confirmed_written_bytes,dropped:result.dropped}))).catch(()=>{});
const server=createPlatformServer();await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const timer=setInterval(()=>recoverPending().catch(e=>console.error('[recovery]',e.code||e.message)),3000);timer.unref();
const pvpTimer=setInterval(()=>tickPvp().catch(e=>console.error('[arena recovery]',e.code||e.message)),250);pvpTimer.unref();
const integrationTimer=setInterval(()=>recoverIntegrationChecks().catch(e=>console.error('[integration recovery]',e.code||e.message)),3000);integrationTimer.unref();
const simpleBinding=async appId=>{const app=(await pool.query('SELECT * FROM gp_apps WHERE id=$1',[appId])).rows[0];const binding=(await pool.query("SELECT * FROM gp_wallet_bindings WHERE app_id=$1 AND provider='simple'",[appId])).rows[0];return app&&binding?{app,binding}:null;};
let simpleRecovering=false;const simpleTimer=setInterval(()=>{if(simpleRecovering)return;simpleRecovering=true;recoverSimpleWallets(walletPool,simpleBinding).catch(e=>console.error('[simple wallet recovery]',e.code||e.message)).finally(()=>{simpleRecovering=false;});},3000);simpleTimer.unref();
const transferTimer=setInterval(()=>transfers.recoverPending().catch(e=>console.error('[transfer recovery]',e.code||e.name)),3000);transferTimer.unref();
console.log(`OASIS ${runtime.environment} API http://127.0.0.1:${PORT}; reference wallet http://127.0.0.1:${WALLET_PORT}`);
console.log('Local admin credentials: platform/.local/development-credentials.json');
let stopping=false;
async function stop(){
 if(stopping)return;stopping=true;
 clearInterval(timer);clearInterval(pvpTimer);clearInterval(integrationTimer);clearInterval(transferTimer);
 await Promise.all([new Promise(r=>server.close(r)),wallet?new Promise(r=>wallet.close(r)):Promise.resolve()]);
 await roomTimingSink?.close({reason:'shutdown'}).catch(()=>{});
 await transfers.close();await closeEnginePool();await closePools();process.exit(0);
}process.on('SIGTERM',stop);process.on('SIGINT',stop);
