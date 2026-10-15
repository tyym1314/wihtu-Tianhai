/** Root-reviewed first-party training admission. No money capability is implied. */
import {ARENA_IDS,LEGACY_IDS,RELEASED_IDS,allowedCapacity} from '../shared/games.mjs';

export const FIRSTPARTY_FREE_PROFILE='firstparty-free-v1';
export const FIRSTPARTY_INTERNAL_PROFILE='firstparty-internal-games-v1';
export const INTERNAL_GAME_COINS=Object.freeze({coin_scope:'internal-nonredeemable',initial_player_coins:'10000',initial_treasury_coins:'1000000000',external_financial_admission_enabled:false,deposit_enabled:false,withdrawal_enabled:false,thirdparty_financial_admission_enabled:false});
export const PARTNER_EXTERNAL_PROFILE='partner-external-v1';
export const firstpartyProfile=profile=>[FIRSTPARTY_FREE_PROFILE,FIRSTPARTY_INTERNAL_PROFILE].includes(profile);
export const partnerProfile=profile=>profile===PARTNER_EXTERNAL_PROFILE;
export function unitsPerCoin(scale){require(Number.isInteger(scale)&&scale>=0&&scale<=6,'INTERNAL_COIN_PRECISION_INVALID');return 10**scale;}
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const release=value=>typeof value==='string'&&/^\/opt\/oasis\/releases\/\d{8}-\d{2}$/.test(value);
const fields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const scopeOf=app=>({partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id});
const sameList=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&[...a].sort().every((value,index)=>value===[...b].sort()[index]);
const origins=values=>Array.isArray(values)&&values.length>0&&new Set(values).size===values.length&&values.every(value=>{try{const u=new URL(value);return u.origin===value&&u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}});
const games=(values,profile)=>Array.isArray(values)&&new Set(values).size===values.length&&sameList(values,profile===FIRSTPARTY_INTERNAL_PROFILE?RELEASED_IDS:ARENA_IDS);
const reject=code=>{throw Object.assign(new Error(code),{status:409,code});};
const require=(value,code)=>{if(!value)reject(code);};
const revision=value=>typeof value==='number'?Number.isSafeInteger(value)&&value>0:typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
let configuredRuntime=null;
export function installProductionAdmissionRuntime(config){
 if(configuredRuntime&&configuredRuntime!==config)throw Error('ADMISSION_RUNTIME_ALREADY_INSTALLED');
 configuredRuntime=config;
}

export function productionAdmissionConfiguration(env,production){
 if(!production)return{admissionProfile:'sandbox',firstpartyAppId:null,admissionRelease:null,admissionManifest:null,partnerAdmission:false};
 if(env.OASIS_PRODUCTION_ADMISSION_ENABLED!==undefined&&env.OASIS_PRODUCTION_ADMISSION_ENABLED!=='0')throw Error('GENERIC_PRODUCTION_ADMISSION_FORBIDDEN');
 if(env.OASIS_PARTNER_ADMISSION!==undefined&&!['0','1'].includes(env.OASIS_PARTNER_ADMISSION))throw Error('INVALID_PARTNER_ADMISSION');
 // Third-party Apps: partner-signed sessions settle only through their own HTTPS wallet.
 const partnerAdmission=env.OASIS_PARTNER_ADMISSION==='1';
 const profile=env.OASIS_ADMISSION_PROFILE||'closed';
 if(!['closed',FIRSTPARTY_FREE_PROFILE,FIRSTPARTY_INTERNAL_PROFILE].includes(profile))throw Error('INVALID_ADMISSION_PROFILE');
 if(profile==='closed'){
  if(['OASIS_FIRSTPARTY_APP_ID','OASIS_ADMISSION_RELEASE','OASIS_ADMISSION_MANIFEST_SHA256'].some(key=>env[key]!==undefined))throw Error('CLOSED_ADMISSION_CONFIG_AMBIGUOUS');
  return{admissionProfile:'closed',firstpartyAppId:null,admissionRelease:null,admissionManifest:null,partnerAdmission};
 }
 if(!identifier(env.OASIS_FIRSTPARTY_APP_ID)||!env.OASIS_FIRSTPARTY_APP_ID.startsWith('app_')||!release(env.OASIS_ADMISSION_RELEASE)||!sha(env.OASIS_ADMISSION_MANIFEST_SHA256))throw Error('FIRSTPARTY_ADMISSION_CONFIG_REQUIRED');
 return{admissionProfile:profile,firstpartyAppId:env.OASIS_FIRSTPARTY_APP_ID,admissionRelease:env.OASIS_ADMISSION_RELEASE,admissionManifest:env.OASIS_ADMISSION_MANIFEST_SHA256,partnerAdmission};
}

/** A third-party production App: active, partner-owned and bound to its own HTTPS wallet. */
export function isPartnerApp(config,app){return config?.production===true&&config.partnerAdmission===true&&app?.environment==='production'&&app.id!==config.firstpartyAppId&&app.partner_id!=='partner_oasis_platform';}
export function validatePartnerAdmission({config,app,binding,intent='session',gameId,room}={}){
 require(['activate','register','session','room','existing-ready','recovery','metadata'].includes(intent),'INVALID_ADMISSION_INTENT');
 require(isPartnerApp(config,app)&&fields.every(field=>identifier(scopeOf(app)[field])),'PARTNER_APP_REQUIRED');
 const info={profile:PARTNER_EXTERNAL_PROFILE,state:'open',open:app.status==='active',revision:'1',app,game_ids:[...app.game_ids],release:null,manifest_sha256:null,proof_sha256:null};
 if(intent==='metadata'||intent==='recovery')return info;
 // Partner players are the partner's own users; the hosted platform account flow is first-party only.
 if(intent==='register')reject('PLAYER_BFF_NOT_AVAILABLE');
 require(binding?.provider==='external'&&typeof binding.wallet_url==='string'&&binding.wallet_url.startsWith('https://')&&binding.wallet_key_id&&app.wallet_url===binding.wallet_url&&fields.every(field=>binding.scope?.[field]===scopeOf(app)[field]),'PRODUCTION_EXTERNAL_WALLET_REQUIRED');
 if(intent==='existing-ready'){
  require(fields.every(field=>room?.scope?.[field]===scopeOf(app)[field])&&info.game_ids.includes(room.game_id),'PARTNER_ROOM_NOT_ACCEPTED');
  return info;
 }
 require(intent==='activate'||app.status==='active','APP_PAUSED');
 if(gameId!==undefined)require(info.game_ids.includes(gameId),'GAME_DISABLED');
 return info;
}

export function validateFirstpartyAdmission({config,app,policy,binding,walletScope,intent='session',gameId,practice,entryMinor,room}={}){
 require(['activate','register','session','room','existing-ready','recovery','metadata'].includes(intent),'INVALID_ADMISSION_INTENT');
 require(config?.production===true&&config.admissionEnabled===false&&firstpartyProfile(config.admissionProfile),'PRODUCTION_ACCEPTANCE_REQUIRED');
 require(app?.id===config.firstpartyAppId&&app.environment==='production'&&app.partner_id==='partner_oasis_platform'&&fields.every(field=>identifier(scopeOf(app)[field])),'FIRSTPARTY_APP_REQUIRED');
 require(policy?.app_id===app.id&&policy.profile===config.admissionProfile&&['closed','open'].includes(policy.state)&&revision(policy.revision),'FIRSTPARTY_POLICY_REQUIRED');
 const actualScope=scopeOf(app);
 require(policy.scope&&Object.keys(policy.scope).length===fields.length&&fields.every(field=>policy.scope[field]===actualScope[field]),'FIRSTPARTY_SCOPE_CHANGED');
 require(Number.isInteger(app.currency_scale)&&app.currency_scale>=0&&app.currency_scale<=6&&policy.currency_scale===app.currency_scale,'FIRSTPARTY_SCOPE_CHANGED');
 require(origins(policy.allowed_origins)&&sameList(policy.allowed_origins,app.allowed_origins)&&policy.allowed_origins.includes(config.publicOrigin),'FIRSTPARTY_HOST_CHANGED');
 require(games(policy.game_ids,policy.profile)&&sameList(policy.game_ids,app.game_ids),'FIRSTPARTY_GAMES_CHANGED');
 require(release(policy.release)&&policy.release===config.admissionRelease&&sha(policy.manifest_sha256)&&policy.manifest_sha256===config.admissionManifest&&sha(policy.proof_sha256)&&identifier(policy.approved_by)&&(policy.approved_at instanceof Date||typeof policy.approved_at==='string'&&policy.approved_at.length>0)&&Number.isFinite(new Date(policy.approved_at).getTime()),'FIRSTPARTY_SOURCE_APPROVAL_REQUIRED');
 require(binding?.provider==='platform'&&app.wallet_url===''&&binding.wallet_url===null&&binding.wallet_key_id===null&&fields.every(field=>binding.scope?.[field]===actualScope[field]),'PRODUCTION_WALLET_REQUIRED');
 require(walletScope&&walletScope.scope_id===fields.map(field=>actualScope[field]).join(':')&&fields.every(field=>walletScope[field]===actualScope[field])&&walletScope.currency_scale===app.currency_scale,'PRODUCTION_WALLET_REQUIRED');
 const moneyFields=['treasury_available','treasury_reserved','treasury_inbound','fee_available','fee_pending','ledger_version'];
 if(policy.profile===FIRSTPARTY_FREE_PROFILE)require(moneyFields.every(field=>walletScope[field]==='0'||walletScope[field]===0),'FIRSTPARTY_FINANCIAL_STATE_NOT_EMPTY');
 else require(moneyFields.every(field=>/^(0|[1-9][0-9]{0,18})$/.test(String(walletScope[field]))&&BigInt(walletScope[field])<=9223372036854775807n),'INTERNAL_LEDGER_STATE_INVALID');
 require(['active','paused'].includes(app.status),'FIRSTPARTY_APP_REQUIRED');
 const info={profile:policy.profile,state:policy.state,open:policy.state==='open'&&app.status==='active',revision:String(policy.revision),app,game_ids:[...policy.game_ids],release:policy.release,manifest_sha256:policy.manifest_sha256,proof_sha256:policy.proof_sha256};
 if(intent==='metadata'||intent==='recovery')return info;
 if(intent==='existing-ready'){
  require(room?.terms?.admission_profile===info.profile&&revision(room.terms.admission_revision)&&BigInt(room.terms.admission_revision)<=BigInt(info.revision)&&room.terms.admission_release===info.release&&room.terms.admission_manifest_sha256===info.manifest_sha256&&room.terms.admission_proof_sha256===info.proof_sha256,'FIRSTPARTY_ROOM_NOT_ACCEPTED');
  require(fields.every(field=>room.scope?.[field]===actualScope[field]),'FIRSTPARTY_ROOM_NOT_ACCEPTED');
  require(info.game_ids.includes(room.game_id),'FIRSTPARTY_ROOM_NOT_ACCEPTED');assertFreePracticeRoom(room);return info;
 }
 require(policy.state==='open','PRODUCTION_ACCEPTANCE_REQUIRED');
 require(intent==='activate'||app.status==='active','APP_PAUSED');
 if(gameId!==undefined)require(info.game_ids.includes(gameId),'GAME_DISABLED');
 if(intent==='room')require(practice===true&&(entryMinor===undefined||entryMinor==='0'),'FIRSTPARTY_FREE_PRACTICE_ONLY');
 return info;
}

export function assertFreePracticeRoom(room){
 require(room?.practice===true&&room.entry_minor==='0'&&room.fee_bps===0&&ARENA_IDS.includes(room.game_id)&&room.terms?.entry_minor==='0'&&room.terms?.fee_bps===0,'FIRSTPARTY_FREE_PRACTICE_ONLY');
 require(Array.isArray(room.players)&&room.players.length===room.capacity&&allowedCapacity(room.game_id,room.capacity)&&room.players.filter(player=>player.bot===false).length===1&&room.players.filter(player=>player.bot===true).length===room.capacity-1&&new Set(room.players.map(player=>player.external_user_id)).size===room.capacity,'FIRSTPARTY_FREE_PRACTICE_ONLY');
 return room;
}

/** Call with a transaction client: admission serializes App then policy locks. */
export async function readProductionAdmission(db,app,options={}){
 const config=options.runtimeConfig||configuredRuntime;
 if(app?.environment!=='production')return{profile:'sandbox',state:'open',open:true,revision:null,app,game_ids:app?.game_ids||[]};
 if(isPartnerApp(config,app)){
  const current=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR SHARE',[app.id])).rows[0];
  require(current&&fields.every(field=>scopeOf(current)[field]===scopeOf(app)[field])&&current.currency_scale===app.currency_scale,'PARTNER_APP_CONFIG_CHANGED');
  const binding=(await db.query('SELECT * FROM gp_wallet_bindings WHERE app_id=$1 FOR SHARE',[app.id])).rows[0];
  // Activation validates the requested status/game grant against the locked row.
  return validatePartnerAdmission({...options,config,app:options.intent==='activate'?{...current,status:app.status,game_ids:app.game_ids}:current,binding});
 }
 require(config?.production&&firstpartyProfile(config.admissionProfile),'PRODUCTION_ACCEPTANCE_REQUIRED');
 const current=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR SHARE',[app.id])).rows[0];
 require(current&&fields.every(field=>scopeOf(current)[field]===scopeOf(app)[field])&&current.currency_scale===app.currency_scale&&current.wallet_url===app.wallet_url&&sameList(current.allowed_origins,app.allowed_origins)&&sameList(current.game_ids,app.game_ids),'FIRSTPARTY_APP_CONFIG_CHANGED');
 const policy=(await db.query('SELECT * FROM gp_production_admission WHERE app_id=$1 FOR SHARE',[app.id])).rows[0];
 const binding=(await db.query('SELECT * FROM gp_wallet_bindings WHERE app_id=$1 FOR SHARE',[app.id])).rows[0];
 const internalTransaction=config.admissionProfile===FIRSTPARTY_INTERNAL_PROFILE&&typeof db.release==='function';
 // Match ledgerRequest: scope advisory lock always precedes the wallet row.
 if(internalTransaction)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[fields.map(field=>scopeOf(current)[field]).join(':')]);
 const walletLock=internalTransaction?'UPDATE':'SHARE';
 const walletScope=(await db.query('SELECT * FROM wallet_scopes WHERE partner_id=$1 AND app_id=$2 AND environment=$3 AND wallet_scope_id=$4 AND currency_id=$5 FOR '+walletLock,fields.map(field=>scopeOf(current)[field]))).rows[0];
 return validateFirstpartyAdmission({...options,config,app:current,policy,binding,walletScope});
}

// Partner rooms send these terms to the partner wallet, whose terms schema is closed.
export function productionAdmissionSnapshot(info){if(partnerProfile(info?.profile))return{};return firstpartyProfile(info?.profile)?{admission_profile:info.profile,admission_revision:info.revision,admission_release:info.release,admission_manifest_sha256:info.manifest_sha256,admission_proof_sha256:info.proof_sha256}:{};}
export function publicAdmissionCapability(info){if(partnerProfile(info?.profile))return{admission_profile:info.profile,admission_open:info.open===true,free_training_only:false,financial_admission_enabled:info.open===true,probability_admission_enabled:info.open===true,internal_game_coins:false,coin_scope:'partner-wallet',allowed_room_modes:['bot-practice','paid','social'],game_ids:info.game_ids||[]};const internal=info?.profile===FIRSTPARTY_INTERNAL_PROFILE;return{admission_profile:info?.profile||'closed',admission_open:info?.open===true,free_training_only:info?.profile===FIRSTPARTY_FREE_PROFILE,financial_admission_enabled:internal&&info?.open===true,probability_admission_enabled:internal&&info?.open===true,internal_game_coins:internal,...INTERNAL_GAME_COINS,allowed_room_modes:firstpartyProfile(info?.profile)?['bot-practice']:[],game_ids:info?.game_ids||[]};}
export async function assertNewFinancialAdmission(db,app,{gameId}={}){if(app?.environment!=='production')return;if(isPartnerApp(configuredRuntime,app)){const info=await readProductionAdmission(db,app,{intent:'session',gameId});require(LEGACY_IDS.includes(gameId),'PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED');return info;}require(configuredRuntime?.admissionProfile===FIRSTPARTY_INTERNAL_PROFILE,'PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED');const info=await readProductionAdmission(db,app,{intent:'session',gameId});require(info.profile===FIRSTPARTY_INTERNAL_PROFILE&&LEGACY_IDS.includes(gameId),'PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED');return info;}

/** This internal-coin profile never authorizes cash or a third-party gateway. */
export function assertExternalFinancialRouteAllowed(config,path){
 if(config?.production&&config.admissionProfile===FIRSTPARTY_INTERNAL_PROFILE&&/^\/(?:v1\/(?:transfers|transfer-ledger)(?:\/|$)|api\/(?:player\/)?(?:deposit|withdraw|withdrawal|recharge)(?:\/|$))/.test(path))reject('EXTERNAL_FINANCIAL_ADMISSION_DISABLED');
}
