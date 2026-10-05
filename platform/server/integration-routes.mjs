import {pool,tx} from './db.mjs';
import {fail,send} from './security.mjs';
import {adminUser,appById,origin,audit,scope} from './platform.mjs';
import {partnerUser,requirePartnerApp} from './portal.mjs';
import {normalizeAllowedOrigins} from './launch-policy.mjs';
import {getWalletStatus,configureWallet,probeWallet} from './wallet-binding.mjs';
import {listIntegrationChecks,startIntegrationCheck} from './integration-checks.mjs';
import {listPartnerKeys,issuePartnerKey,revokePartnerKey,credentialRate} from './credentials.mjs';

export async function routeIntegration(req,res,path,body){
 const match=path.match(/^\/api\/(admin|partner)\/apps\/([A-Za-z0-9_-]+)\/integration(?:\/(origins|wallet|probe|checks|keys)(?:\/([A-Za-z0-9_-]+)\/(revoke))?)?$/);if(!match)return false;
 const user=match[1]==='admin'?await adminUser(req):await partnerUser(req);if(!user)fail(401,'LOGIN_REQUIRED');
 const app=match[1]==='admin'?await appById(match[2]):await requirePartnerApp(user,match[2]);
 if(req.method!=='GET'&&req.headers.origin!==origin)fail(403,'ORIGIN_FORBIDDEN');
 const route=match[3];
 if(match[4]&&route!=='keys')fail(404,'NOT_FOUND');
 if(route==='keys'){
  if(!match[4]&&req.method==='GET'){send(res,200,{keys:await listPartnerKeys(app.id)});return true;}
  if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');credentialRate(req,'key-management',20);
  if(match[4]){if(Object.keys(body).length)fail(400,'INVALID_REQUEST');send(res,200,await revokePartnerKey(app.id,match[4],user));return true;}
  send(res,201,await issuePartnerKey(app.id,body,user));return true;
 }
 if(!route&&req.method==='GET'){
  const key=(await pool.query("SELECT id FROM gp_keys WHERE app_id=$1 AND direction='partner-to-platform' AND active ORDER BY created_at DESC LIMIT 1",[app.id])).rows[0];
  send(res,200,{app_id:app.id,status:app.status,scope:scope(app),platform_origin:origin,allowed_origins:normalizeAllowedOrigins(app.allowed_origins,origin),partner_key_id:key?.id||null,wallet:await getWalletStatus(app.id),checks:await listIntegrationChecks(app.id),production_enabled:false});return true;
 }
 if(route==='origins'&&req.method==='POST'){
  if(Object.keys(body).some(k=>k!=='allowed_origins'))fail(400,'INVALID_REQUEST');const allowed=normalizeAllowedOrigins(body.allowed_origins,origin);
  await tx(async c=>{await c.query('SELECT id FROM gp_apps WHERE id=$1 FOR UPDATE',[app.id]);await c.query('UPDATE gp_apps SET allowed_origins=$2 WHERE id=$1',[app.id,JSON.stringify(allowed)]);await audit(user.id,'app.host_origins_configured',app.id,{allowed_origins:allowed},c);});
  send(res,200,{app_id:app.id,allowed_origins:allowed});return true;
 }
 if(route==='wallet'&&req.method==='POST'){send(res,200,await configureWallet(app.id,body,user.id));return true;}
 if(route==='probe'&&req.method==='POST'){
  if(Object.keys(body).some(k=>k!=='external_user_id'))fail(400,'INVALID_REQUEST');send(res,200,await probeWallet(app.id,{external_user_id:body.external_user_id||'demo_player'}));return true;
 }
 if(route==='checks'&&req.method==='GET'){send(res,200,{checks:await listIntegrationChecks(app.id)});return true;}
 if(route==='checks'&&req.method==='POST'){send(res,202,{check:await startIntegrationCheck(app.id,body,user.id)});return true;}
 fail(405,'METHOD_NOT_ALLOWED');
}
