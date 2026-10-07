import {send,fail} from './security.mjs';
import {pool} from './db.mjs';
import {credentialRate} from './credentials.mjs';
import {appById,createSession,origin,scope} from './platform.mjs';
import {runtime,assertProductionAppReady} from './runtime-mode.mjs';
import {PLAYER_COOKIE,registerPlayer,loginPlayer,playerSession,csrfFor,requirePlayerCsrf,revokePlayerSession,appPlayerId} from './player-records.mjs';

const exact=(body,keys)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!keys.includes(key)))fail(400,'INVALID_REQUEST');};
const exactOrigin=req=>{if(req.headers.origin!==origin)fail(403,'ORIGIN_FORBIDDEN');};
const cookie=(token,maxAge)=>`${PLAYER_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

/** Browser-facing platform BFF. The player credential never enters partner HMAC. */
export async function routePlayer(req,res,path,body,raw){
 if(!path.startsWith('/api/player/'))return false;
 if(!runtime.production)fail(404,'NOT_FOUND');
 if(path==='/api/player/register'){
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');exactOrigin(req);credentialRate(req,'player-register',6);exact(body,['app_id','username','password']);
  if(typeof body.app_id!=='string')fail(400,'INVALID_REQUEST');const app=await appById(body.app_id);
  await assertProductionAppReady(pool,app);if(app.status!=='active')fail(409,'APP_PAUSED');
  send(res,201,{player:await registerPlayer(body.username,body.password,app.id)});return true;
 }
 if(path==='/api/player/login'){
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');exactOrigin(req);credentialRate(req,'player-login',8);exact(body,['username','password','app_id']);
  if(typeof body.app_id!=='string')fail(400,'INVALID_REQUEST');const app=await appById(body.app_id);
  const {token,player}=await loginPlayer(body.username,body.password,app.id),externalUserId=await appPlayerId(pool,app.id,player.id);
  res.setHeader('set-cookie',cookie(token,28800));
  send(res,200,{player,app_id:app.id,external_user_id:externalUserId,csrf_token:csrfFor(token),expires_in:28800});return true;
 }
 const session=await playerSession(req);if(!session)fail(401,'LOGIN_REQUIRED');
 if(path==='/api/player/session'){
  if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
  send(res,200,{player:{id:session.id,username:session.username},csrf_token:csrfFor(session.token),expires_at:session.expires_at});return true;
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
