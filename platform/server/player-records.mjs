import {timingSafeEqual} from 'node:crypto';
import {pool,tx} from './db.mjs';
import {id,hash,fail} from './security.mjs';
import {loginCredential,passwordMaterial} from './credentials.mjs';
import {assertProductionAppReady} from './runtime-mode.mjs';

export const PLAYER_COOKIE='__Host-oasis_player';
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;

export function playerCookie(req){
 const pair=req.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith(PLAYER_COOKIE+'='));
 const token=pair?.slice(PLAYER_COOKIE.length+1);
 return tokenPattern.test(token||'')?token:null;
}

export async function registerPlayer(username,password,appId){
 const normalized=typeof username==='string'?username.trim().toLowerCase():'';
 if(!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(normalized))fail(400,'INVALID_USERNAME');
 const material=await passwordMaterial(password);
 return tx(async db=>{
  // Admission is checked under the App row lock, so a concurrent pause cannot
  // create an account after the App has stopped accepting new players.
  const app=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR SHARE',[appId])).rows[0];
  if(!app)fail(404,'NOT_FOUND');
  await assertProductionAppReady(db,app);
  if(app.status!=='active')fail(409,'APP_PAUSED');
  const playerId=id('player');
  try{await db.query('INSERT INTO gp_players(id,username,salt,password_hash) VALUES($1,$2,$3,$4)',[playerId,normalized,material.salt,material.password_hash]);}
  catch(error){if(error.code==='23505')fail(409,'USERNAME_TAKEN');throw error;}
  await db.query("INSERT INTO gp_audit(actor,action,detail) VALUES($1,'player.registered',$2)",[playerId,{player_id:playerId}]);
  return{id:playerId,username:normalized};
 });
}

export async function loginPlayer(username,password,appId){
 const normalized=typeof username==='string'?username.trim().toLowerCase():'';
 const {token,account}=await loginCredential('player',normalized,password,async(db,player)=>{
  const app=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR SHARE',[appId])).rows[0];if(!app)fail(404,'NOT_FOUND');
  // A paused App may reauthenticate an already accepted player to finish an
  // obligation. It must not bind new players while production is closed.
  const accepted=(await db.query('SELECT 1 FROM gp_sessions WHERE app_id=$1 AND player_id=$2 LIMIT 1',[appId,player.id])).rowCount;
  if(!accepted){await assertProductionAppReady(db,app);if(app.status!=='active')fail(409,'APP_PAUSED');}
 });
 return{token,player:{id:account.id,username:account.username}};
}

export async function playerSession(req){
 const token=playerCookie(req);if(!token)return null;
 const row=(await pool.query(`SELECT p.id,p.username,s.expires_at FROM gp_player_sessions s
  JOIN gp_players p ON p.id=s.player_id WHERE s.token_hash=$1 AND s.expires_at>now() AND p.active`,[hash(token)])).rows[0];
 return row?{...row,token}:null;
}

export function csrfFor(token){return hash('oasis-player-csrf-v1:'+token);}
export function requirePlayerCsrf(req,session){
 const supplied=req.headers['x-oasis-csrf'],expected=csrfFor(session.token);
 if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))fail(403,'CSRF_FORBIDDEN');
}

export async function revokePlayerSession(session){await pool.query('DELETE FROM gp_player_sessions WHERE token_hash=$1',[hash(session.token)]);}

/** Called only by the trusted platform BFF inside the launch transaction. */
export async function appPlayerId(db,appId,playerId){
 const player=(await db.query('SELECT id FROM gp_players WHERE id=$1 AND active FOR SHARE',[playerId])).rows[0];
 if(!player)fail(401,'LOGIN_REQUIRED');
 const accepted=(await db.query('SELECT DISTINCT external_user_id FROM gp_sessions WHERE app_id=$1 AND player_id=$2',[appId,playerId])).rows;
 if(accepted.length>1)fail(409,'PLAYER_IDENTITY_CONFLICT');
 const mapped=(await db.query('SELECT external_user_id FROM gp_player_app_ids WHERE app_id=$1 AND player_id=$2',[appId,playerId])).rows[0];
 if(mapped){if(accepted.length&&mapped.external_user_id!==accepted[0].external_user_id)fail(409,'PLAYER_IDENTITY_CONFLICT');return mapped.external_user_id;}
 if(!accepted.length){
  const app=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR SHARE',[appId])).rows[0];
  if(!app)fail(404,'NOT_FOUND');
  await assertProductionAppReady(db,app);
  if(app.status!=='active')fail(409,'APP_PAUSED');
 }
 await db.query('INSERT INTO gp_player_app_ids(app_id,player_id,external_user_id) VALUES($1,$2,$3) ON CONFLICT(app_id,player_id) DO NOTHING',[appId,playerId,accepted[0]?.external_user_id||id('player')]);
 const result=(await db.query('SELECT external_user_id FROM gp_player_app_ids WHERE app_id=$1 AND player_id=$2',[appId,playerId])).rows[0].external_user_id;
 if(accepted.length&&result!==accepted[0].external_user_id)fail(409,'PLAYER_IDENTITY_CONFLICT');
 return result;
}
