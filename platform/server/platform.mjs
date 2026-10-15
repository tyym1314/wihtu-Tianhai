import {CASINO_GAMES} from '../shared/casino-games.mjs';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {pool,tx} from './db.mjs';
import {id,hash,seal,unseal,localDir,fail,verifySignature} from './security.mjs';
import {provisionWallet} from './wallet/index.mjs';
import {getProfile} from './math/index.ts';
import {ALL_GAME_IDS,ARENA_IDS,RELEASED_IDS} from '../shared/games.mjs';
import {FIRSTPARTY_FREE_PROFILE,FIRSTPARTY_INTERNAL_PROFILE,PARTNER_EXTERNAL_PROFILE,isPartnerApp} from './production-admission.mjs';
import {runtime,assertProductionAppReady} from './runtime-mode.mjs';
import {resolveHostOrigin,assertExchangeOrigin} from './launch-policy.mjs';
import {loginCredential} from './credentials.mjs';
import {appPlayerId} from './player-records.mjs';
import {createPlatformWallet} from './platform-wallet.mjs';
const spec=JSON.parse(readFileSync(new URL('../specs/openapi.json',import.meta.url),'utf8'));
const catalog=[...JSON.parse(readFileSync(new URL('../specs/game-catalog.json',import.meta.url),'utf8')).games,
 ...Object.values(CASINO_GAMES).map(g=>({id:g.id,name:g.zh,nameEn:g.name,category:'probability',family:g.family,status:'casino-shared-round',reference:g.reference}))];
const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);ajv.addSchema(spec,'contract');
const validators=new Map();
export function validate(name,body){let fn=validators.get(name);if(!fn){fn=ajv.compile({$ref:`contract#/components/schemas/${name}`});validators.set(name,fn);}if(!fn(body))fail(400,'INVALID_REQUEST',ajv.errorsText(fn.errors));}
export const origin=process.env.OASIS_PUBLIC_ORIGIN||'http://127.0.0.1:8795';
export const scope=app=>({partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id});
export async function audit(actor,action,app_id,detail={},db=pool){await db.query('INSERT INTO gp_audit(actor,action,app_id,detail) VALUES($1,$2,$3,$4)',[actor,action,app_id,detail]);}
export async function appById(appId){const r=await pool.query('SELECT * FROM gp_apps WHERE id=$1',[appId]);if(!r.rowCount)fail(404,'NOT_FOUND');return r.rows[0];}
export async function createApp(name,options='partner_oasis_demo') {
  const partner=typeof options==='string'?options:options.partnerId||'partner_oasis_demo',actor=typeof options==='object'?options.actor||'admin':'admin';
  // Third-party production Apps always settle through their own wallet.
  const walletProvider=typeof options==='object'&&options.walletProvider!==undefined?options.walletProvider:runtime.partnerAdmission?'external':undefined;
  if(walletProvider!==undefined&&(!runtime.production||!['platform','external'].includes(walletProvider)||runtime.partnerAdmission&&walletProvider!=='external'))fail(400,'INVALID_WALLET_PROVIDER');
  if(typeof partner!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(partner))fail(400,'INVALID_PARTNER');
  if(typeof name!=='string'||name.trim().length<2||name.length>60)fail(400,'INVALID_NAME','应用名称需要 2–60 个字符');
  if(runtime.production&&partner==='partner_oasis_demo')fail(400,'PRODUCTION_PARTNER_REQUIRED');
  const app={id:id('app'),name:name.trim(),partner_id:partner,environment:runtime.environment,wallet_scope_id:id('wallet'),currency_id:'COIN',currency_scale:2,status:'active',game_ids:[...RELEASED_IDS],competitive_fee_bps:500,wallet_url:process.env.OASIS_REFERENCE_WALLET_URL||'http://127.0.0.1:8798',math_profile:'99'};
  if(runtime.production){app.status='paused';app.game_ids=runtime.partnerAdmission?[...ALL_GAME_IDS]:[...ARENA_IDS];app.wallet_url='';}
  const credentials={key_id:id('pk'),secret_base64:randomBytes(32).toString('base64')};
  const walletKey={key_id:id('wk'),secret_base64:randomBytes(32).toString('base64')};
  // Idempotent reference-wallet provisioning precedes visibility of this new App.
  if(!runtime.production)await provisionWallet(pool,{scope:scope(app),...walletKey,users:[{external_user_id:'demo_player',balance_minor:'1200000'},{external_user_id:'demo_player_2',balance_minor:'1200000'},{external_user_id:'demo_player_3',balance_minor:'1200000'},{external_user_id:'demo_player_4',balance_minor:'1200000'}],treasury_minor:'1000000000000',math_profiles:['thunder','tiger'].flatMap(game=>['98','99'].map(p=>{const m=getProfile(game,p);return {game_id:game,math_version:m.version,math_config_hash:m.hash,max_payout_multiplier:String(m.maxMultiplier)};}))});
  await tx(async c=>{
    await c.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[app.id,app.name,partner,app.environment,app.wallet_scope_id,app.wallet_url,JSON.stringify(app.game_ids),app.status]);
    if(runtime.production&&walletProvider!=='external')await createPlatformWallet(c,app,actor);
    for(const [direction,key]of (runtime.production?[['partner-to-platform',credentials]]:[['partner-to-platform',credentials],['platform-to-wallet',walletKey]]))await c.query('INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,$3,$4)',[key.key_id,app.id,direction,seal(key.secret_base64)]);
    await audit(actor,'app.created',app.id,{name:app.name},c);
  });
  return {app,credentials};
}
export async function migratePlatform(){await pool.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));}
export async function seedPlatform(){
  if(!(await pool.query('SELECT 1 FROM gp_admins LIMIT 1')).rowCount){
    const password=randomBytes(18).toString('base64url'),salt=randomBytes(16).toString('hex');
    await pool.query('INSERT INTO gp_admins VALUES($1,$2,$3,$4)',['admin_local','admin',salt,scryptSync(password,salt,64).toString('hex')]);
    writeFileSync(localDir+'development-credentials.json',JSON.stringify({username:'admin',password,scope:'local sandbox only'},null,2),{mode:0o600});
  }
  if(!runtime.production&&!(await pool.query('SELECT 1 FROM gp_apps LIMIT 1')).rowCount){const apps=[await createApp('Majlis 沙箱','partner_majlis'),await createApp('Sahra 沙箱','partner_sahra')];writeFileSync(localDir+'sandbox-app-credentials.json',JSON.stringify(apps,null,2),{mode:0o600});}
}
export async function authenticatePartner(req,raw,body){
  const {rows}=await pool.query('SELECT k.*,a.* ,k.id as key_id FROM gp_keys k JOIN gp_apps a ON a.id=k.app_id WHERE k.id=$1 AND k.active AND k.direction=$2',[req.headers['x-gp-key-id'],'partner-to-platform']);
  if(!rows[0])fail(401,'SIGNATURE_INVALID');const key=rows[0];const info=verifySignature(req,raw,{secret_base64:unseal(key.secret_enc)},'partner-to-platform');
  const inserted=await pool.query('INSERT INTO gp_nonces(key_id,nonce) VALUES($1,$2) ON CONFLICT DO NOTHING',[key.key_id,info.nonce]);if(!inserted.rowCount)fail(401,'NONCE_REPLAY');
  if(req.method!=='GET'&&body.request_id!==info.request_id)fail(400,'REQUEST_ID_MISMATCH');
  const app=await appById(key.app_id);for(const [k,v]of Object.entries(scope(app)))if(body[k]!==undefined&&body[k]!==v)fail(403,'SCOPE_FORBIDDEN');return app;
}
export async function login(username,password){
  const {token,account}=await loginCredential('admin',username,password);
  return {token,user:{id:account.id,name:'平台管理员',role:'platform_admin'}};
}
export async function adminUser(req){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('oasis_admin='))?.split('=')[1];if(!token)return null;const r=await pool.query('SELECT a.id FROM gp_admin_sessions s JOIN gp_admins a ON a.id=s.admin_id WHERE token_hash=$1 AND expires_at>now()',[hash(token)]);return r.rowCount?{id:r.rows[0].id,name:'平台管理员',role:'platform_admin'}:null;}
export async function createSession(app,b,raw,{playerId=null}={}){
  // A first-party production player comes only from the platform BFF session.
  // A third-party production App authenticates its own users with its HMAC key
  // and settles through its own bound wallet.
  const hosted=runtime.production&&!!playerId;
  if(runtime.production&&!playerId&&!isPartnerApp(runtime,app))fail(403,'PLAYER_BFF_REQUIRED');
  if(hosted&&isPartnerApp(runtime,app))fail(403,'PLAYER_BFF_NOT_AVAILABLE');
  if(!hosted){validate('CreateSessionRequest',b);for(const[k,v]of Object.entries(scope(app)))if(b[k]!==v)fail(403,'SCOPE_FORBIDDEN');}
  return tx(async c=>{
    // Login takes the player row before the App row. Keep the same order here:
    // taking App FOR UPDATE first would deadlock with a concurrent login that
    // holds player FOR UPDATE and then checks App FOR SHARE.
    if(hosted){
      const player=(await c.query('SELECT id FROM gp_players WHERE id=$1 AND active FOR SHARE',[playerId])).rows[0];
      if(!player)fail(401,'LOGIN_REQUIRED');
    }
    // Configuration binding and session admission share this lock. A stale
    // authenticated App object cannot route a new session to an old wallet.
    app=(await c.query('SELECT * FROM gp_apps WHERE id=$1 FOR UPDATE',[app.id])).rows[0];if(!app)fail(404,'NOT_FOUND');
    const externalUserId=hosted?await appPlayerId(c,app.id,playerId):b.external_user_id;
    if(hosted&&b.external_user_id!==undefined&&b.external_user_id!==externalUserId)fail(403,'SCOPE_FORBIDDEN');
    const request=hosted?{...b,external_user_id:externalUserId}:b;
    validate('CreateSessionRequest',request);
    for(const[k,v]of Object.entries(scope(app)))if(request[k]!==v)fail(403,'SCOPE_FORBIDDEN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['launch:'+app.id+':'+request.request_id]);
    const prior=(await c.query('SELECT * FROM gp_launch_intents WHERE app_id=$1 AND request_id=$2',[app.id,request.request_id])).rows[0];
    if(prior){
      if(prior.digest!==hash(raw))fail(409,'IDEMPOTENCY_CONFLICT');
      const response=unseal(prior.response_enc);
      if(runtime.production){
        const owner=(await c.query('SELECT app_id,player_id,external_user_id FROM gp_sessions WHERE id=$1',[response.session_id])).rows[0];
        if(!owner||owner.app_id!==app.id||owner.player_id!==playerId||owner.external_user_id!==externalUserId)fail(403,'SCOPE_FORBIDDEN');
      }
      return response;
    }
    // Reauthorization for an existing accepted obligation remains possible after App pause.
    const hostOrigin=resolveHostOrigin(request.host_origin,app.allowed_origins,origin);
    const game=request.game_id||'lobby';let sid=request.resume_session_id;
    if(game==='lobby')fail(409,'GAME_NOT_RELEASED','大厅尚未开放，请指定已开放的 game_id');
    if(sid){const old=(await c.query('SELECT * FROM gp_sessions WHERE id=$1 FOR UPDATE',[sid])).rows[0];if(!old||old.app_id!==app.id||old.external_user_id!==externalUserId||old.game_id!==game||(runtime.production&&old.player_id!==playerId))fail(403,'SCOPE_FORBIDDEN');}
    else {
      const admission=await assertProductionAppReady(c,app,{intent:'session',gameId:game});
      if(app.status!=='active')fail(403,'APP_PAUSED');if(game!=='lobby'&&!app.game_ids.includes(game))fail(403,'GAME_DISABLED');if(!ALL_GAME_IDS.includes(game))fail(409,'GAME_NOT_RELEASED','此竞技游戏尚未发布');
      if(runtime.production&&admission.profile===FIRSTPARTY_FREE_PROFILE){
        const account=(await c.query('SELECT available,reserved,credit_pending FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2',[Object.values(scope(app)).join(':'),externalUserId])).rows[0];
        if(!account)fail(409,'PLAYER_WALLET_NOT_READY');
        if(['available','reserved','credit_pending'].some(key=>account[key]!=='0'))fail(409,'FIRSTPARTY_FINANCIAL_STATE_NOT_EMPTY');
      }
      sid=id('ses');await c.query('INSERT INTO gp_sessions(id,app_id,external_user_id,game_id,host_origin,player_id,admission_profile,admission_revision,locale) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[sid,app.id,externalUserId,game,hostOrigin,playerId,admission?.profile||null,admission?.revision||null,sessionLocale(request.locale)]);
    }
    const code=randomBytes(32).toString('base64url'),expires=new Date(Date.now()+60000).toISOString();const response={session_id:sid,launch_code:code,expires_in:60,expires_at:expires,entry_url:origin+'/play/'+game};
    await c.query('INSERT INTO gp_launch_codes(code_hash,session_id,expires_at,consumed_at,host_origin) VALUES($1,$2,$3,NULL,$4)',[hash(code),sid,expires,hostOrigin]);await c.query('INSERT INTO gp_launch_intents VALUES($1,$2,$3,$4)',[app.id,request.request_id,hash(raw),seal(response)]);await audit(playerId?'player':'partner','session.created',app.id,{session_id:sid,game_id:game,host_origin:hostOrigin},c);return response;
  });
}
const sessionLocale=value=>value==='zh-CN'||value==='zh'?'zh':value==='ar'?'ar':value==='en'?'en':null;
export async function exchange(b){validate('ExchangeLaunchRequest',b);return tx(async c=>{
  const code=(await c.query('SELECT * FROM gp_launch_codes WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',[hash(b.launch_code)])).rows[0];if(!code)fail(401,'LAUNCH_CODE_INVALID');
  const existing=(await c.query('SELECT * FROM gp_sessions WHERE id=$1 FOR UPDATE',[code.session_id])).rows[0];if(!existing)fail(401,'LAUNCH_CODE_INVALID');
  const hostOrigin=code.host_origin||origin;assertExchangeOrigin(b.host_origin,hostOrigin,origin);
  if(b.game_id!==undefined&&b.game_id!==existing.game_id)fail(403,'GAME_SCOPE_FORBIDDEN');
  const app=(await c.query('SELECT * FROM gp_apps WHERE id=$1',[existing.app_id])).rows[0];resolveHostOrigin(hostOrigin,app.allowed_origins,origin);
  await c.query('UPDATE gp_launch_codes SET consumed_at=now() WHERE code_hash=$1',[hash(b.launch_code)]);
  const token=randomBytes(32).toString('base64url');const s=(await c.query('UPDATE gp_sessions SET token_hash=$1,token_expires_at=now()+interval \'15 minutes\',host_origin=$3 WHERE id=$2 RETURNING *',[hash(token),code.session_id,hostOrigin])).rows[0];
  return {session_id:s.id,access_token:token,token_type:'Bearer',expires_in:900,game_entry_url:origin+'/play/'+s.game_id,scope:scope(app),external_user_id:s.external_user_id,host_origin:hostOrigin,game_id:s.game_id,locale:s.locale||null};
});}
export async function playSession(req){const token=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];if(!token)fail(401,'SESSION_REQUIRED');const s=(await pool.query('SELECT * FROM gp_sessions WHERE token_hash=$1 AND token_expires_at>now()',[hash(token)])).rows[0];if(!s)fail(401,'SESSION_EXPIRED','请返回应用重新打开游戏');return s;}
export function gamesFor(app){const partner=isPartnerApp(runtime,app);return {partner_id:app.partner_id,app_id:app.id,environment:app.environment,as_of:new Date().toISOString(),games:catalog.filter(g=>app.game_ids.includes(g.id)).map(g=>({game_id:g.id,title:g.name||g.title||g.id,category:g.category,available:app.status==='active'&&ALL_GAME_IDS.includes(g.id),configuration_version:partner?PARTNER_EXTERNAL_PROFILE:runtime.production&&runtime.admissionProfile===FIRSTPARTY_INTERNAL_PROFILE?FIRSTPARTY_INTERNAL_PROFILE:'sandbox-v1',modes:g.id==='towerlink'?[{mode_id:'competitive',player_counts:[2],team_size:1,rule_version:g.ruleVersion},{mode_id:'social',player_counts:[2,3,4],team_size:1,rule_version:g.ruleVersion},{mode_id:'practice',player_counts:[2,3,4],team_size:1,rule_version:g.ruleVersion}]:g.id==='carrom'?[{mode_id:'duel',player_counts:[2],team_size:1,rule_version:g.ruleVersion},{mode_id:'teams',player_counts:[4],team_size:2,rule_version:g.ruleVersion}]:[{mode_id:'default',player_counts:g.players||[1],team_size:g.id==='jackaroo'?2:1,rule_version:g.ruleVersion||'sandbox-v1'}],locales:['zh','en'],...(['thunder','tiger'].includes(g.id)?{math_profiles:['98','99'].map(p=>{const m=getProfile(g.id,p);return {math_version:m.version,math_config_hash:m.hash,target_rtp_bps:Number(p)*100,validation_status:partner?'statistical-model-uncertified':runtime.production&&runtime.admissionProfile===FIRSTPARTY_INTERNAL_PROFILE?'internal-coins-statistical-model-uncertified':'draft',max_cycle_payout_description:partner?`Partner wallet coins, maximum ${m.maxMultiplier} times stake; target RTP from 10M-cycle simulation, not third-party certified`:runtime.production&&runtime.admissionProfile===FIRSTPARTY_INTERNAL_PROFILE?`Internal nonredeemable game coins, maximum ${m.maxMultiplier} times stake; target RTP is not exact theoretical certification`:`Sandbox profile, maximum ${m.maxMultiplier} times stake; not approved for production`};})}:{})}))};}

// One-time local upgrade. Existing disabled/custom entitlement selections are preserved.
export async function upgradeArenaSandbox(){
 if(runtime.production)return;
 if(!(await pool.query("SELECT 1 FROM gp_migrations WHERE id='arena-phase-c-v1'")).rowCount){
 for(const app of (await pool.query('SELECT * FROM gp_apps')).rows){
  const key=(await pool.query("SELECT * FROM gp_keys WHERE app_id=$1 AND direction='platform-to-wallet' AND active LIMIT 1",[app.id])).rows[0];
  if(key&&app.wallet_url===(process.env.OASIS_REFERENCE_WALLET_URL||'http://127.0.0.1:8798'))await provisionWallet(pool,{scope:scope(app),key_id:key.id,secret_base64:unseal(key.secret_enc),users:[3,4].map(n=>({external_user_id:'demo_player_'+n,balance_minor:'1200000'})),treasury_minor:'1000000000000'});
  if(app.game_ids.length===2&&['thunder','tiger'].every(g=>app.game_ids.includes(g))){await tx(async c=>{await c.query("UPDATE gp_apps SET game_ids=game_ids||'[\"match\",\"golf\"]'::jsonb WHERE id=$1",[app.id]);await audit('system','arena.sandbox_enabled',app.id,{games:['match','golf']},c);});}
 }
 await pool.query("INSERT INTO gp_migrations(id) VALUES('arena-phase-c-v1') ON CONFLICT DO NOTHING");
 }
 await upgradeTableGamesSandbox();
 await upgradeSportsGamesSandbox();
 await upgradeTowerLinkSandbox();
}

// Phase D only expands the unchanged default grant, never an operator's custom selection.
export async function upgradeTableGamesSandbox(){
 if((await pool.query("SELECT 1 FROM gp_migrations WHERE id='arena-phase-d-v1'")).rowCount)return;
 const prior=['thunder','tiger','match','golf'],added=['carrom','darts','ludo','jackaroo','domino'];
 await tx(async c=>{
  const apps=(await c.query('SELECT * FROM gp_apps FOR UPDATE')).rows;
  for(const app of apps)if(app.game_ids.length===prior.length&&prior.every(g=>app.game_ids.includes(g))){
   await c.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[app.id,JSON.stringify([...prior,...added])]);
   await audit('system','arena.table_games_enabled',app.id,{games:added},c);
  }
  await c.query("INSERT INTO gp_migrations(id) VALUES('arena-phase-d-v1') ON CONFLICT DO NOTHING");
 });
}

// Phase E preserves operator-selected entitlements, settings, accounts and balances.
export async function upgradeSportsGamesSandbox(){
 if((await pool.query("SELECT 1 FROM gp_migrations WHERE id='arena-phase-e-v1'")).rowCount)return;
 const prior=['thunder','tiger','match','golf','carrom','darts','ludo','jackaroo','domino'],added=['pool','bowling','run'];
 await tx(async c=>{
  const apps=(await c.query('SELECT * FROM gp_apps FOR UPDATE')).rows;
  for(const app of apps)if(app.game_ids.length===prior.length&&prior.every(g=>app.game_ids.includes(g))){
   await c.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[app.id,JSON.stringify([...prior,...added])]);
   await audit('system','arena.sports_games_enabled',app.id,{games:added},c);
  }
  await c.query("INSERT INTO gp_migrations(id) VALUES('arena-phase-e-v1') ON CONFLICT DO NOTHING");
 });
}

// Phase F adds Tower Link only to the unchanged full sandbox grant.
export async function upgradeTowerLinkSandbox(){
 if((await pool.query("SELECT 1 FROM gp_migrations WHERE id='arena-phase-f-v1'")).rowCount)return;
 const prior=['thunder','tiger','match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run'];
 await tx(async c=>{
  const apps=(await c.query('SELECT * FROM gp_apps FOR UPDATE')).rows;
  for(const app of apps)if(app.game_ids.length===prior.length&&prior.every(g=>app.game_ids.includes(g))){
   await c.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[app.id,JSON.stringify([...prior,'towerlink'])]);
   await audit('system','arena.towerlink_enabled',app.id,{games:['towerlink']},c);
  }
  await c.query("INSERT INTO gp_migrations(id) VALUES('arena-phase-f-v1') ON CONFLICT DO NOTHING");
 });
}
