import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {pool,tx} from './db.mjs';
import {id,hash,send,fail} from './security.mjs';
import {adminUser,origin,createApp,createSession,scope,audit} from './platform.mjs';
import {runtime,assertProductionAppReady} from './runtime-mode.mjs';
import {RELEASED_IDS} from '../shared/games.mjs';
import {loginCredential} from './credentials.mjs';
import {clientAddress} from './proxy-context.mjs';
import {activityTimeZone,overviewActivity} from './overview-activity.mjs';
import {routeTransferOperations} from './transfer-operations.mjs';

const derive=promisify(scrypt),COOKIE='oasis_partner';
const appFields=['id','name','partner_id','environment','wallet_scope_id','currency_id','currency_scale','status','game_ids','math_profile','competitive_fee_bps','wallet_url','created_at'];
const accountFields='id,partner_id,name,username,active,created_at';
const loginAttempts=new Map();
const publicApp=app=>Object.fromEntries(appFields.filter(k=>Object.hasOwn(app,k)).map(k=>[k,app[k]]));
const principal=a=>({id:a.id,name:a.name,username:a.username,partner_id:a.partner_id,role:'partner_developer'});
const cookieToken=req=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
function checkOrigin(req){if(req.headers.origin!==origin)fail(403,'ORIGIN_FORBIDDEN');}
function exact(body,keys){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))fail(400,'INVALID_REQUEST');}
function identity(user){if(!user||user.role!=='partner_developer'||typeof user.partner_id!=='string')fail(401,'LOGIN_REQUIRED');}
function limited(req){const ip=clientAddress(req)||'unknown',now=Date.now();for(const [key,value]of loginAttempts)if(value.until<=now)loginAttempts.delete(key);if(loginAttempts.size>=2000&&!loginAttempts.has(ip))fail(429,'RATE_LIMITED');const entry=loginAttempts.get(ip)||{count:0,until:now+60000};loginAttempts.set(ip,entry);if(++entry.count>12)fail(429,'RATE_LIMITED');}
function setCookie(res,token,maxAge=28800){res.setHeader('set-cookie',`${COOKIE}=${token}; Path=/api/partner; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith('https://')?'; Secure':''}`);}
function safeDetail(value){if(Array.isArray(value))return value.map(safeDetail);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/secret|password|salt|token|launch_code|authorization|signature|raw_body|seed/i.test(k)?'[REDACTED]':safeDetail(v)]));return value;}

export async function migratePortal(){await pool.query(`
 CREATE TABLE IF NOT EXISTS gp_partner_accounts (
  id text PRIMARY KEY,partner_id text UNIQUE NOT NULL,name text NOT NULL,
  username text UNIQUE NOT NULL,salt text NOT NULL,password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS gp_partner_sessions (
  token_hash text PRIMARY KEY,account_id text NOT NULL REFERENCES gp_partner_accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS gp_partner_sessions_expiry ON gp_partner_sessions(expires_at);
 CREATE INDEX IF NOT EXISTS gp_apps_partner_scope ON gp_apps(partner_id,environment,id);
 `);}

export async function partnerUser(req){const token=cookieToken(req);if(!/^[A-Za-z0-9_-]{43}$/.test(token||''))return null;const r=await pool.query(`SELECT a.id,a.partner_id,a.name,a.username FROM gp_partner_sessions s JOIN gp_partner_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active`,[hash(token)]);return r.rowCount?principal(r.rows[0]):null;}
export async function requirePartnerApp(user,appId){identity(user);const app=(await pool.query("SELECT * FROM gp_apps WHERE id=$1 AND partner_id=$2",[appId,user.partner_id])).rows[0];if(!app)fail(404,'NOT_FOUND');return app;}

async function createAccount(body,admin){
 exact(body,['name','username','password']);
 const name=typeof body.name==='string'?body.name.trim():'',username=typeof body.username==='string'?body.username.trim().toLowerCase():'';
 if(name.length<2||name.length>60)fail(400,'INVALID_NAME','合作方名称需要 2–60 个字符');
 if(!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username))fail(400,'INVALID_USERNAME','用户名需要 3–64 个英文字母、数字、点、横线或下划线');
 if(typeof body.password!=='string'||body.password.length<12||body.password.length>256)fail(400,'INVALID_PASSWORD','密码需要 12–256 个字符');
 const salt=randomBytes(16).toString('hex'),passwordHash=(await derive(body.password,salt,64)).toString('hex');
 return tx(async db=>{let account;try{account=(await db.query(`INSERT INTO gp_partner_accounts(id,partner_id,name,username,salt,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${accountFields}`,[id('pa'),id('partner'),name,username,salt,passwordHash])).rows[0];}catch(e){if(e.code==='23505')fail(409,'USERNAME_TAKEN','用户名已存在');throw e;}await audit(admin.id,'partner.account_created',null,{account_id:account.id,partner_id:account.partner_id,name,username},db);return account;});
}
async function partnerLogin(body){
 exact(body,['username','password']);
 if(typeof body.username!=='string'||body.username.length>64||typeof body.password!=='string'||body.password.length>256)fail(401,'LOGIN_FAILED','用户名或密码不正确');
 const {token,account}=await loginCredential('partner',body.username.trim().toLowerCase(),body.password);
 return{token,user:principal(account)};
}

/** Returns true after sending a matched route; false leaves dispatch to the caller. */
export async function routePortal(req,res,path,body){
 if(path==='/api/admin/partner-accounts'){
  const admin=await adminUser(req);if(!admin||admin.role!=='platform_admin')fail(401,'LOGIN_REQUIRED');
  if(req.method==='GET'){send(res,200,{accounts:(await pool.query(`SELECT ${accountFields} FROM gp_partner_accounts ORDER BY created_at DESC`)).rows});return true;}
  if(req.method==='POST'){checkOrigin(req);send(res,201,{account:await createAccount(body,admin)});return true;}
  fail(405,'METHOD_NOT_ALLOWED');
 }
 if(!path.startsWith('/api/partner/'))return false;
 if(path==='/api/partner/login'&&req.method==='POST'){checkOrigin(req);limited(req);const result=await partnerLogin(body);setCookie(res,result.token);send(res,200,{user:result.user});return true;}
 const user=await partnerUser(req);
 if(path==='/api/partner/session'&&req.method==='GET'){send(res,200,{user,environment:runtime.environment});return true;}
 identity(user);
 if(await routeTransferOperations(req,res,path,user,{pool,environment:runtime.environment}))return true;
 if(req.method!=='GET')checkOrigin(req);
 if(path==='/api/partner/logout'&&req.method==='POST'){await pool.query('DELETE FROM gp_partner_sessions WHERE token_hash=$1',[hash(cookieToken(req))]);setCookie(res,'',0);send(res,200,{ok:true});return true;}
 if(path==='/api/partner/apps'&&req.method==='GET'){const apps=(await pool.query("SELECT * FROM gp_apps WHERE partner_id=$1 ORDER BY created_at",[user.partner_id])).rows;send(res,200,{apps:apps.map(publicApp)});return true;}
 if(path==='/api/partner/apps'&&req.method==='POST'){exact(body,['name','wallet_provider']);const created=await createApp(body.name,{partnerId:user.partner_id,actor:user.id,walletProvider:body.wallet_provider});send(res,201,{app:publicApp(created.app),credentials:created.credentials});return true;}
 const match=path.match(/^\/api\/partner\/apps\/([A-Za-z0-9_-]+)(\/launch)?$/);
 if(match){
  const app=await requirePartnerApp(user,match[1]);
  if(!match[2]&&req.method==='GET'){send(res,200,{app:publicApp(app)});return true;}
  if(match[2]&&req.method==='POST'){
   if(runtime.production)fail(403,'PRODUCTION_LAUNCH_REQUIRES_PARTNER_BACKEND');
   exact(body,['game_id','external_user_id','locale']);
   const request={...scope(app),request_id:id('launch'),external_user_id:body.external_user_id||'demo_player',game_id:body.game_id,locale:body.locale||'en',host_platform:'web'};
   const result=await createSession(app,request,JSON.stringify(request));await audit(user.id,'partner.sandbox_launched',app.id,{game_id:request.game_id,external_user_id:request.external_user_id,session_id:result.session_id});send(res,200,result);return true;
  }
  if(!match[2]&&req.method==='PATCH'){
   exact(body,['name','status','game_ids']);if(!Object.keys(body).length)fail(400,'INVALID_REQUEST');
   if(body.name!==undefined&&(typeof body.name!=='string'||body.name.trim().length<2||body.name.trim().length>60))fail(400,'INVALID_NAME');
   if(body.status!==undefined&&!['active','paused'].includes(body.status))fail(400,'INVALID_STATUS');
   if(body.game_ids!==undefined&&(!Array.isArray(body.game_ids)||body.game_ids.some(g=>!RELEASED_IDS.includes(g))||new Set(body.game_ids).size!==body.game_ids.length))fail(400,'INVALID_GAMES');
   const updated=await tx(async db=>{const locked=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR UPDATE',[app.id])).rows[0];if(body.status==='active'||(locked.status==='active'&&body.game_ids))await assertProductionAppReady(db,{...locked,...body},{intent:'activate'});const result=await db.query(`UPDATE gp_apps SET name=COALESCE($3,name),status=COALESCE($4,status),game_ids=COALESCE($5::jsonb,game_ids) WHERE id=$1 AND partner_id=$2 RETURNING *`,[app.id,user.partner_id,body.name?.trim()??null,body.status??null,body.game_ids===undefined?null:JSON.stringify(body.game_ids)]);if(!result.rowCount)fail(404,'NOT_FOUND');await audit(user.id,'partner.app_configured',app.id,body,db);return result.rows[0];});send(res,200,{app:publicApp(updated)});return true;
  }
  fail(405,'METHOD_NOT_ALLOWED');
 }
 if(path==='/api/partner/overview'&&req.method==='GET'){
  const apps=(await pool.query("SELECT count(*)::int n FROM gp_apps WHERE partner_id=$1",[user.partner_id])).rows[0];
  const cycles=(await pool.query(`SELECT count(*)::int n,count(*) FILTER(WHERE c.status NOT IN ('SETTLED','REJECTED'))::int pending FROM gp_cycles c JOIN gp_apps a ON a.id=c.app_id WHERE a.partner_id=$1`,[user.partner_id])).rows[0];
  const rooms=(await pool.query(`SELECT count(*)::int n,count(*) FILTER(WHERE r.status NOT IN ('settled','cancelled','voided'))::int pending,COALESCE(sum((r.result->>'fee_minor')::bigint) FILTER(WHERE r.status='settled' AND NOT r.practice),0)::text fee FROM pvp_rooms r JOIN gp_apps a ON a.id=r.app_id WHERE a.partner_id=$1`,[user.partner_id])).rows[0];
  send(res,200,{apps_count:apps.n,games_count:RELEASED_IDS.length,cycles_count:cycles.n+rooms.n,pending_count:cycles.pending+rooms.pending,fee_minor:rooms.fee,environment:runtime.environment,wallet_status:'app_scoped',released_games:RELEASED_IDS.length});return true;
 }
 if(path==='/api/partner/overview-activity'&&req.method==='GET'){
  send(res,200,await overviewActivity(activityTimeZone(req),user.partner_id));return true;
 }
 if(path==='/api/partner/rounds'&&req.method==='GET'){
  const rows=(await pool.query(`SELECT c.id,c.app_id,c.game_id,c.external_user_id,c.status,c.stake_minor,c.payout_minor,c.math_version,c.created_at,c.result_hash,'settle_'||c.id operation_id,'probability' category,false practice FROM gp_cycles c JOIN gp_apps a ON a.id=c.app_id WHERE a.partner_id=$1
   UNION ALL SELECT r.id,r.app_id,r.game_id,(SELECT string_agg(p->>'external_user_id',', ') FROM jsonb_array_elements(r.players) p),upper(r.status),r.entry_minor,(CASE WHEN r.result IS NOT NULL THEN (SELECT sum((p->>'payout_minor')::bigint) FROM jsonb_array_elements(r.result->'payouts') p) ELSE NULL END)::bigint,r.rule_version,r.created_at,r.result_hash,'settle_'||r.id,'competitive',r.practice FROM pvp_rooms r JOIN gp_apps a ON a.id=r.app_id WHERE a.partner_id=$1 ORDER BY created_at DESC LIMIT 200`,[user.partner_id])).rows;send(res,200,{rounds:rows});return true;
 }
 if(path==='/api/partner/operations'&&req.method==='GET'){
  const rows=(await pool.query(`SELECT o.id,o.app_id,o.aggregate_id,o.path,o.state,o.attempts,o.response,o.created_at,o.updated_at FROM gp_operations o JOIN gp_apps a ON a.id=o.app_id WHERE a.partner_id=$1
   UNION ALL SELECT o.id,o.app_id,o.room_id,o.path,o.state,o.attempts,o.response,o.created_at,o.updated_at FROM pvp_operations o JOIN gp_apps a ON a.id=o.app_id WHERE a.partner_id=$1 ORDER BY created_at DESC LIMIT 200`,[user.partner_id])).rows;send(res,200,{operations:rows.map(safeDetail)});return true;
 }
 if(path==='/api/partner/audit'&&req.method==='GET'){
  const rows=(await pool.query(`SELECT e.id,e.actor,e.action,e.app_id,e.detail,e.created_at FROM gp_audit e LEFT JOIN gp_apps a ON a.id=e.app_id WHERE (a.partner_id=$1) OR (e.app_id IS NULL AND e.actor=$2) ORDER BY e.id DESC LIMIT 100`,[user.partner_id,user.id])).rows;send(res,200,{events:rows.map(safeDetail)});return true;
 }
 if(path==='/api/partner/health'&&req.method==='GET'){
  await pool.query('SELECT 1');send(res,200,{api:'ok',database:'ok',wallet:'app_check_required',environment:runtime.environment,production_enabled:runtime.production&&runtime.admissionEnabled,scope:'partner',partner_id:user.partner_id});return true;
 }
 fail(404,'NOT_FOUND');
}
