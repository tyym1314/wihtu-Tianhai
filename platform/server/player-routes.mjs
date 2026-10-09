import {send,fail} from './security.mjs';
import {pool,tx} from './db.mjs';
import {credentialRate,changePassword} from './credentials.mjs';
import {appById,createSession,origin,scope} from './platform.mjs';
import {runtime,assertProductionAppReady} from './runtime-mode.mjs';
import {readProductionAdmission,publicAdmissionCapability} from './production-admission.mjs';
import {RELEASED_IDS} from '../shared/games.mjs';
import {validatedWalletBalance} from './wallet-binding.mjs';
import {PLAYER_COOKIE,registerPlayer,loginPlayer,playerSession,csrfFor,requirePlayerCsrf,revokePlayerSession,appPlayerId} from './player-records.mjs';

const exact=(body,keys)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!keys.includes(key)))fail(400,'INVALID_REQUEST');};
const exactOrigin=req=>{if(req.headers.origin!==origin)fail(403,'ORIGIN_FORBIDDEN');};
const cookie=(token,maxAge)=>`${PLAYER_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
const queryAppId=path=>{
 const query=new URL(path,origin).searchParams,appId=query.get('app_id');
 if([...query.keys()].some(key=>key!=='app_id')||query.getAll('app_id').length!==1||!/^[-A-Za-z0-9_]{1,128}$/.test(appId||''))fail(400,'INVALID_REQUEST');
 return appId;
};

/** Browser-facing platform BFF. The player credential never enters partner HMAC. */
export async function routePlayer(req,res,path,body,raw){
 if(!path.startsWith('/api/player/'))return false;
 if(!runtime.production)fail(404,'NOT_FOUND');
 if(path==='/api/player/app'||path.startsWith('/api/player/app?')){
  if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
  const appId=queryAppId(path);
  const app=await appById(appId);if(app.environment!=='production')fail(404,'NOT_FOUND');
  let admission=null;
  try{admission=await readProductionAdmission(pool,app,{intent:'metadata'});}catch(error){if(error.status!==409)throw error;}
  const capability=publicAdmissionCapability(admission);
  send(res,200,{name:app.name,...capability,game_ids:(admission?.game_ids||app.game_ids).filter(game=>RELEASED_IDS.includes(game))});return true;
 }
 if(path==='/api/player/register'){
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');exactOrigin(req);credentialRate(req,'player-register',6);exact(body,['app_id','username','password']);
  if(typeof body.app_id!=='string')fail(400,'INVALID_REQUEST');const app=await appById(body.app_id);
  await assertProductionAppReady(pool,app,{intent:'register'});if(app.status!=='active')fail(409,'APP_PAUSED');
  send(res,201,{player:await registerPlayer(body.username,body.password,app.id)});return true;
 }
 if(path==='/api/player/login'){
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');exactOrigin(req);credentialRate(req,'player-login',8);exact(body,['username','password','app_id']);
  if(typeof body.app_id!=='string')fail(400,'INVALID_REQUEST');const app=await appById(body.app_id);
  const {token,player}=await loginPlayer(body.username,body.password,app.id),externalUserId=await tx(db=>appPlayerId(db,app.id,player.id));
  res.setHeader('set-cookie',cookie(token,28800));
  send(res,200,{player,app_id:app.id,external_user_id:externalUserId,csrf_token:csrfFor(token),expires_in:28800});return true;
 }
 const session=await playerSession(req);if(!session)fail(401,'LOGIN_REQUIRED');
 if(path==='/api/player/wallet'||path.startsWith('/api/player/wallet?')){
  if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
  const app=await appById(queryAppId(path));if(app.environment!=='production')fail(404,'NOT_FOUND');
  // A balance read may finish an accepted obligation while admission is closed.
  // It never binds a new App, opens an account, or accepts a client-supplied user.
  const mapped=(await pool.query('SELECT external_user_id FROM gp_player_app_ids WHERE app_id=$1 AND player_id=$2',[app.id,session.id])).rows[0];
  if(!mapped)fail(403,'SCOPE_FORBIDDEN');
  send(res,200,await validatedWalletBalance(app,mapped.external_user_id));return true;
 }
 if(path==='/api/player/recovery'||path.startsWith('/api/player/recovery?')){
  if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
  const app=await appById(queryAppId(path));if(app.environment!=='production')fail(404,'NOT_FOUND');
  const {rows}=await pool.query(`SELECT DISTINCT ON (active.room_id) game_session.id AS session_id,game_session.game_id
   FROM gp_sessions game_session JOIN pvp_active_users active
   ON active.app_id=game_session.app_id AND active.external_user_id=game_session.external_user_id
   JOIN pvp_rooms room ON room.id=active.room_id AND room.app_id=game_session.app_id AND room.game_id=game_session.game_id
   WHERE game_session.app_id=$1 AND game_session.player_id=$2 AND room.status NOT IN ('cancelled','settled','voided')
   ORDER BY active.room_id,game_session.created_at DESC,game_session.id DESC`,[app.id,session.id]);
  send(res,200,{sessions:rows});return true;
 }
 if(path==='/api/player/session'){
  if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
  send(res,200,{player:{id:session.id,username:session.username},csrf_token:csrfFor(session.token),expires_at:session.expires_at});return true;
 }
 if(path==='/api/player/password'){
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');exactOrigin(req);requirePlayerCsrf(req,session);credentialRate(req,'player-password',8);
  // The platform identity is global: revoke its logins across Apps, never accepted game sessions.
  await changePassword('player',session,req,body);
  res.setHeader('set-cookie',cookie('',0));send(res,200,{ok:true,reauthenticate:true});return true;
 }
 if(path==='/api/player/logout'){
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');exactOrigin(req);requirePlayerCsrf(req,session);exact(body,[]);
  await revokePlayerSession(session);res.setHeader('set-cookie',cookie('',0));send(res,200,{ok:true});return true;
 }
 if(path==='/api/player/launch'){
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');exactOrigin(req);requirePlayerCsrf(req,session);
  exact(body,['app_id','request_id','game_id','locale','host_platform','resume_session_id','host_origin']);
  if(typeof body.app_id!=='string')fail(400,'INVALID_REQUEST');
  const app=await appById(body.app_id);
  const launch={...scope(app),...body,host_platform:body.host_platform||'web',locale:body.locale||'zh-CN'};
  send(res,201,await createSession(app,launch,raw,{playerId:session.id}));return true;
 }
 fail(404,'NOT_FOUND');
}
