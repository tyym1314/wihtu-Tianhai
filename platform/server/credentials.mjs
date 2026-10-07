import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {pool,tx} from './db.mjs';
import {id,hash,seal,unseal,fail,send} from './security.mjs';
import {clientAddress,adminSessionCookie} from './proxy-context.mjs';

const derive=promisify(scrypt),attempts=new Map();
const accountFields='id,partner_id,name,username,active,created_at';
const stores={admin:{table:'gp_admins',sessions:'gp_admin_sessions',foreign:'admin_id',cookie:'oasis_admin'},partner:{table:'gp_partner_accounts',sessions:'gp_partner_sessions',foreign:'account_id',cookie:'oasis_partner'},player:{table:'gp_players',sessions:'gp_player_sessions',foreign:'player_id',cookie:'__Host-oasis_player'}};
const exact=(b,keys)=>{if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!keys.includes(k)))fail(400,'INVALID_REQUEST');};
const cookie=(req,name)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
const record=(db,actor,action,appId,detail={})=>db.query('INSERT INTO gp_audit(actor,action,app_id,detail) VALUES($1,$2,$3,$4)',[actor,action,appId,detail]);
export function credentialRate(req,key='password',limit=8){
 const now=Date.now(),address=clientAddress(req)||'unknown',bucket=key+':'+address;
 for(const[k,v]of attempts)if(v.until<=now)attempts.delete(k);
 if(attempts.size>=2000&&!attempts.has(bucket))fail(429,'RATE_LIMITED');
 const value=attempts.get(bucket)||{count:0,until:now+60000};attempts.set(bucket,value);if(++value.count>limit)fail(429,'RATE_LIMITED');
}
export function validateNewPassword(password){if(typeof password!=='string'||password.length<12||password.length>256)fail(400,'INVALID_PASSWORD','新密码需要 12–256 个字符');}
export async function passwordMaterial(password){validateNewPassword(password);const salt=randomBytes(16).toString('hex');return{salt,password_hash:(await derive(password,salt,64)).toString('hex')};}
export async function passwordMatches(password,account){
 if(typeof password!=='string'||password.length>256)return false;
 const actual=await derive(password,account?.salt||'oasis-credential-dummy-salt',64),expected=account?Buffer.from(account.password_hash,'hex'):Buffer.alloc(64);
 return Boolean(account&&expected.length===actual.length&&timingSafeEqual(actual,expected));
}

/** Reset/disable and login take the same row lock before session admission. */
export async function loginCredential(kind,username,password,authorize=null){
 const store=stores[kind];if(!store)throw Error('Unknown credential kind');
 if(typeof username!=='string'||username.length>64||typeof password!=='string'||password.length>256)fail(401,'LOGIN_FAILED','用户名或密码不正确');
 const snapshot=(await pool.query(`SELECT * FROM ${store.table} WHERE username=$1`,[username])).rows[0];
 if(!await passwordMatches(password,snapshot)||snapshot.active===false)fail(401,'LOGIN_FAILED','用户名或密码不正确');
 return tx(async db=>{
  const account=(await db.query(`SELECT * FROM ${store.table} WHERE id=$1 FOR UPDATE`,[snapshot.id])).rows[0];
  if(!account||account.active===false||account.password_hash!==snapshot.password_hash||account.salt!==snapshot.salt)fail(401,'LOGIN_FAILED','凭证已变更，请重新登录');
  if(authorize)await authorize(db,account);
  const token=randomBytes(32).toString('base64url');
  await db.query(`DELETE FROM ${store.sessions} WHERE expires_at<=now()`);
  await db.query(`INSERT INTO ${store.sessions}(token_hash,${store.foreign},expires_at) VALUES($1,$2,now()+interval '8 hours')`,[hash(token),account.id]);
  await record(db,account.id,kind+'.login',null,kind==='partner'?{partner_id:account.partner_id}:{});
  return{token,account};
 });
}

export async function migrateCredentials(){await pool.query(`
 ALTER TABLE gp_keys ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
 CREATE TABLE IF NOT EXISTS gp_key_issues (
  app_id text NOT NULL REFERENCES gp_apps(id),request_id text NOT NULL,actor text NOT NULL,
  key_id text NOT NULL REFERENCES gp_keys(id),response_enc text,expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(app_id,request_id)
 );
 CREATE INDEX IF NOT EXISTS gp_key_issues_expiry ON gp_key_issues(expires_at) WHERE response_enc IS NOT NULL;
 `);}

async function changePassword(kind,user,req,body){
 exact(body,['current_password','new_password']);
 if(typeof body.current_password!=='string'||body.current_password.length>256)fail(400,'INVALID_REQUEST');
 const store=stores[kind],snapshot=(await pool.query(`SELECT * FROM ${store.table} WHERE id=$1`,[user.id])).rows[0];
 if(!await passwordMatches(body.current_password,snapshot))fail(400,'CURRENT_PASSWORD_INVALID','当前密码不正确');
 if(body.current_password===body.new_password)fail(400,'PASSWORD_UNCHANGED','新密码不能与当前密码相同');
 const material=await passwordMaterial(body.new_password);
 await tx(async db=>{
  const account=(await db.query(`SELECT * FROM ${store.table} WHERE id=$1 FOR UPDATE`,[user.id])).rows[0];
  if(!account||account.active===false||account.password_hash!==snapshot.password_hash||account.salt!==snapshot.salt)fail(409,'CREDENTIAL_CHANGED','凭证已变更，请重新登录');
  const token=cookie(req,store.cookie);
  if(!token||!(await db.query(`SELECT 1 FROM ${store.sessions} WHERE token_hash=$1 AND ${store.foreign}=$2 AND expires_at>now()`,[hash(token),user.id])).rowCount)fail(401,'LOGIN_REQUIRED');
  await db.query(`UPDATE ${store.table} SET salt=$2,password_hash=$3 WHERE id=$1`,[user.id,material.salt,material.password_hash]);
  await db.query(`DELETE FROM ${store.sessions} WHERE ${store.foreign}=$1`,[user.id]);
  await record(db,user.id,kind+'.password_changed',null,{account_id:user.id,sessions_revoked:true});
 });
}

/** Dispatch before routePortal, which otherwise rejects unknown partner routes. */
export async function routeCredentials(req,res,path,body){
 const self=path.match(/^\/api\/(admin|partner)\/password$/),managed=path.match(/^\/api\/admin\/partner-accounts\/([A-Za-z0-9_-]+)(\/password)?$/);
 if(!self&&!managed)return false;
 const {adminUser,origin}=await import('./platform.mjs');
 const kind=self?.[1]||'admin',user=kind==='admin'?await adminUser(req):await(await import('./portal.mjs')).partnerUser(req);
 if(!user)fail(401,'LOGIN_REQUIRED');
 if(req.headers.origin!==origin)fail(403,'ORIGIN_FORBIDDEN');credentialRate(req);
 if(self){
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');
  await changePassword(kind,user,req,body);
  res.setHeader('set-cookie',kind==='admin'?adminSessionCookie('',origin,0):`oasis_partner=; Path=/api/partner; HttpOnly; SameSite=Strict; Max-Age=0${origin.startsWith('https://')?'; Secure':''}`);
  send(res,200,{ok:true,reauthenticate:true});return true;
 }
 const reset=Boolean(managed[2]);if(req.method!==(reset?'POST':'PATCH'))fail(405,'METHOD_NOT_ALLOWED');
 exact(body,reset?['new_password']:['active']);
 if(!reset&&typeof body.active!=='boolean')fail(400,'INVALID_REQUEST');
 const material=reset?await passwordMaterial(body.new_password):null;
 const account=await tx(async db=>{
  const current=(await db.query('SELECT * FROM gp_partner_accounts WHERE id=$1 FOR UPDATE',[managed[1]])).rows[0];if(!current)fail(404,'NOT_FOUND');
  const changed=(await db.query(reset?`UPDATE gp_partner_accounts SET salt=$2,password_hash=$3 WHERE id=$1 RETURNING ${accountFields}`:`UPDATE gp_partner_accounts SET active=$2 WHERE id=$1 RETURNING ${accountFields}`,reset?[current.id,material.salt,material.password_hash]:[current.id,body.active])).rows[0];
  if(reset||!body.active)await db.query('DELETE FROM gp_partner_sessions WHERE account_id=$1',[current.id]);
  await record(db,user.id,reset?'partner.password_reset':body.active?'partner.account_enabled':'partner.account_disabled',null,{account_id:current.id,partner_id:current.partner_id,sessions_revoked:reset||!body.active});
  return changed;
 });
 send(res,200,{account});return true;
}

export async function listPartnerKeys(appId){return(await pool.query("SELECT id,active,created_at,revoked_at FROM gp_keys WHERE app_id=$1 AND direction='partner-to-platform' ORDER BY created_at DESC,id",[appId])).rows;}
async function lockApp(db,appId,user){const app=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR UPDATE',[appId])).rows[0];if(!app||(user.role==='partner_developer'&&app.partner_id!==user.partner_id))fail(404,'NOT_FOUND');return app;}
export async function issuePartnerKey(appId,body,user){
 exact(body,['request_id']);if(!/^[A-Za-z0-9_-]{8,96}$/.test(body.request_id||''))fail(400,'INVALID_REQUEST','需要有效的 request_id');
 return tx(async db=>{
  await lockApp(db,appId,user);
  // Erase expired encrypted replay material while retaining the idempotency tombstone.
  await db.query('UPDATE gp_key_issues SET response_enc=NULL WHERE app_id=$1 AND response_enc IS NOT NULL AND expires_at<=now()',[appId]);
  const prior=(await db.query('SELECT *,expires_at>now() AS replayable FROM gp_key_issues WHERE app_id=$1 AND request_id=$2',[appId,body.request_id])).rows[0];
  if(prior){
   if(prior.actor!==user.id)fail(409,'IDEMPOTENCY_CONFLICT');
   const key=(await db.query('SELECT active FROM gp_keys WHERE id=$1',[prior.key_id])).rows[0];
   if(!key?.active)fail(409,'KEY_REVOKED','本次创建的密钥已撤销，请使用新的请求号');
   if(!prior.replayable||!prior.response_enc)fail(409,'KEY_RESPONSE_EXPIRED','密钥展示已过期；请核对列表并撤销未保存的密钥，再重新创建');
   return unseal(prior.response_enc);
  }
  const active=(await db.query("SELECT count(*)::int n FROM gp_keys WHERE app_id=$1 AND direction='partner-to-platform' AND active",[appId])).rows[0].n;
  if(active>=2)fail(409,'ACTIVE_KEY_LIMIT','最多保留两把有效密钥，请先确认后撤销旧密钥');
  const credentials={key_id:id('pk'),secret_base64:randomBytes(32).toString('base64')};
  const result={credentials,replay_expires_at:new Date(Date.now()+10*60*1000).toISOString()};
  await db.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'partner-to-platform',$3)",[credentials.key_id,appId,seal(credentials.secret_base64)]);
  await db.query('INSERT INTO gp_key_issues(app_id,request_id,actor,key_id,response_enc,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[appId,body.request_id,user.id,credentials.key_id,seal(result),result.replay_expires_at]);
  await record(db,user.id,'app.partner_key_issued',appId,{key_id:credentials.key_id,request_id:body.request_id});return result;
 });
}
export async function revokePartnerKey(appId,keyId,user){return tx(async db=>{
 await lockApp(db,appId,user);
 const key=(await db.query("SELECT id,active FROM gp_keys WHERE id=$1 AND app_id=$2 AND direction='partner-to-platform'",[keyId,appId])).rows[0];if(!key)fail(404,'NOT_FOUND');
 if(!key.active)return{ok:true,key_id:keyId};
 const count=(await db.query("SELECT count(*)::int n FROM gp_keys WHERE app_id=$1 AND direction='partner-to-platform' AND active",[appId])).rows[0].n;
 if(count<=1)fail(409,'LAST_ACTIVE_KEY','请先创建并切换新密钥，不能撤销最后一把有效密钥');
 await db.query('UPDATE gp_keys SET active=false,revoked_at=now() WHERE id=$1',[keyId]);
 await db.query('UPDATE gp_key_issues SET response_enc=NULL WHERE key_id=$1',[keyId]);
 await record(db,user.id,'app.partner_key_revoked',appId,{key_id:keyId});return{ok:true,key_id:keyId};
 });}
