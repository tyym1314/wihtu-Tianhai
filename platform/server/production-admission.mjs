/** Production admission: only third-party Apps, each settling through its own HTTPS simple-v1 wallet. */
import {PROBABILITY_IDS} from '../shared/games.mjs';

export const PARTNER_EXTERNAL_PROFILE='partner-external-v1';
export const partnerProfile=profile=>profile===PARTNER_EXTERNAL_PROFILE;
export function unitsPerCoin(scale){require(Number.isInteger(scale)&&scale>=0&&scale<=6,'COIN_PRECISION_INVALID');return 10**scale;}
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const fields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const scopeOf=app=>({partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id});
const reject=code=>{throw Object.assign(new Error(code),{status:409,code});};
const require=(value,code)=>{if(!value)reject(code);};
let configuredRuntime=null;
export function installProductionAdmissionRuntime(config){
 if(configuredRuntime&&configuredRuntime!==config)throw Error('ADMISSION_RUNTIME_ALREADY_INSTALLED');
 configuredRuntime=config;
}

export function productionAdmissionConfiguration(env,production){
 if(!production)return{admissionProfile:'sandbox',partnerAdmission:false};
 if(env.OASIS_PRODUCTION_ADMISSION_ENABLED!==undefined&&env.OASIS_PRODUCTION_ADMISSION_ENABLED!=='0')throw Error('GENERIC_PRODUCTION_ADMISSION_FORBIDDEN');
 if(env.OASIS_PARTNER_ADMISSION!==undefined&&!['0','1'].includes(env.OASIS_PARTNER_ADMISSION))throw Error('INVALID_PARTNER_ADMISSION');
 if(![undefined,'closed'].includes(env.OASIS_ADMISSION_PROFILE))throw Error('INVALID_ADMISSION_PROFILE');
 if(['OASIS_FIRSTPARTY_APP_ID','OASIS_ADMISSION_RELEASE','OASIS_ADMISSION_MANIFEST_SHA256'].some(key=>env[key]!==undefined))throw Error('FIRSTPARTY_CONFIG_REMOVED');
 // Third-party Apps: partner-signed sessions settle only through their own HTTPS wallet.
 return{admissionProfile:'closed',partnerAdmission:env.OASIS_PARTNER_ADMISSION==='1'};
}

/** A third-party production App: active, partner-owned and bound to its own HTTPS wallet. */
export function isPartnerApp(config,app){return config?.production===true&&config.partnerAdmission===true&&app?.environment==='production';}
export function validatePartnerAdmission({config,app,binding,intent='session',gameId,room}={}){
 require(['activate','register','session','room','existing-ready','recovery','metadata'].includes(intent),'INVALID_ADMISSION_INTENT');
 require(isPartnerApp(config,app)&&fields.every(field=>identifier(scopeOf(app)[field])),'PARTNER_APP_REQUIRED');
 const info={profile:PARTNER_EXTERNAL_PROFILE,state:'open',open:app.status==='active',revision:'1',app,game_ids:[...app.game_ids],release:null,manifest_sha256:null,proof_sha256:null};
 if(intent==='metadata'||intent==='recovery')return info;
 // Partner players are the partner's own users; the hosted platform account flow is first-party only.
 if(intent==='register')reject('PLAYER_BFF_NOT_AVAILABLE');
 require(binding?.provider==='simple'&&typeof binding.wallet_url==='string'&&binding.wallet_url.startsWith('https://')&&binding.wallet_key_id&&app.wallet_url===binding.wallet_url&&fields.every(field=>binding.scope?.[field]===scopeOf(app)[field]),'PRODUCTION_EXTERNAL_WALLET_REQUIRED');
 if(intent==='existing-ready'){
  require(fields.every(field=>room?.scope?.[field]===scopeOf(app)[field])&&info.game_ids.includes(room.game_id),'PARTNER_ROOM_NOT_ACCEPTED');
  return info;
 }
 require(intent==='activate'||app.status==='active','APP_PAUSED');
 if(gameId!==undefined)require(info.game_ids.includes(gameId),'GAME_DISABLED');
 return info;
}

/** Call with a transaction client: admission reads the App and binding rows FOR SHARE. */
export async function readProductionAdmission(db,app,options={}){
 const config=options.runtimeConfig||configuredRuntime;
 if(app?.environment!=='production')return{profile:'sandbox',state:'open',open:true,revision:null,app,game_ids:app?.game_ids||[]};
 require(isPartnerApp(config,app),'PARTNER_APP_REQUIRED');
 const current=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR SHARE',[app.id])).rows[0];
 require(current&&fields.every(field=>scopeOf(current)[field]===scopeOf(app)[field])&&current.currency_scale===app.currency_scale,'PARTNER_APP_CONFIG_CHANGED');
 const binding=(await db.query('SELECT * FROM gp_wallet_bindings WHERE app_id=$1 FOR SHARE',[app.id])).rows[0];
 // Activation validates the requested status/game grant against the locked row.
 return validatePartnerAdmission({...options,config,app:options.intent==='activate'?{...current,status:app.status,game_ids:app.game_ids}:current,binding});
}

// Partner rooms send these terms to the partner wallet, whose terms schema is closed.
export function productionAdmissionSnapshot(){return{};}
export function publicAdmissionCapability(info){
 if(partnerProfile(info?.profile))return{admission_profile:info.profile,admission_open:info.open===true,free_training_only:false,financial_admission_enabled:info.open===true,probability_admission_enabled:info.open===true,internal_game_coins:false,coin_scope:'partner-wallet',allowed_room_modes:['bot-practice','paid','social'],game_ids:info.game_ids||[]};
 return{admission_profile:info?.profile||'closed',admission_open:false,free_training_only:false,financial_admission_enabled:false,probability_admission_enabled:false,internal_game_coins:false,allowed_room_modes:[],game_ids:info?.game_ids||[]};
}
export async function assertNewFinancialAdmission(db,app,{gameId}={}){
 if(app?.environment!=='production')return;
 const info=await readProductionAdmission(db,app,{intent:'session',gameId});require(PROBABILITY_IDS.includes(gameId),'PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED');return info;
}
/** Platform-hosted cash routes do not exist: partners keep balances in their own wallets. */
export function assertExternalFinancialRouteAllowed(config,path){
 if(config?.production&&/^\/api\/(?:player\/)?(?:deposit|withdraw|withdrawal|recharge)(?:\/|$)/.test(path))reject('EXTERNAL_FINANCIAL_ADMISSION_DISABLED');
}
