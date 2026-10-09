/** Root-reviewed first-party training admission. No money capability is implied. */
import {ARENA_IDS,allowedCapacity} from '../shared/games.mjs';

export const FIRSTPARTY_FREE_PROFILE='firstparty-free-v1';
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const release=value=>typeof value==='string'&&/^\/opt\/oasis\/releases\/\d{8}-\d{2}$/.test(value);
const fields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const scopeOf=app=>({partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id});
const sameList=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&[...a].sort().every((value,index)=>value===[...b].sort()[index]);
const origins=values=>Array.isArray(values)&&values.length>0&&new Set(values).size===values.length&&values.every(value=>{try{const u=new URL(value);return u.origin===value&&u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}});
const games=values=>Array.isArray(values)&&new Set(values).size===values.length&&sameList(values,ARENA_IDS);
const reject=code=>{throw Object.assign(new Error(code),{status:409,code});};
const require=(value,code)=>{if(!value)reject(code);};
const revision=value=>typeof value==='number'?Number.isSafeInteger(value)&&value>0:typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
let configuredRuntime=null;
export function installProductionAdmissionRuntime(config){
 if(configuredRuntime&&configuredRuntime!==config)throw Error('ADMISSION_RUNTIME_ALREADY_INSTALLED');
 configuredRuntime=config;
}

export function productionAdmissionConfiguration(env,production){
 if(!production)return{admissionProfile:'sandbox',firstpartyAppId:null,admissionRelease:null,admissionManifest:null};
 if(env.OASIS_PRODUCTION_ADMISSION_ENABLED!==undefined&&env.OASIS_PRODUCTION_ADMISSION_ENABLED!=='0')throw Error('GENERIC_PRODUCTION_ADMISSION_FORBIDDEN');
 const profile=env.OASIS_ADMISSION_PROFILE||'closed';
 if(!['closed',FIRSTPARTY_FREE_PROFILE].includes(profile))throw Error('INVALID_ADMISSION_PROFILE');
 if(profile==='closed'){
  if(['OASIS_FIRSTPARTY_APP_ID','OASIS_ADMISSION_RELEASE','OASIS_ADMISSION_MANIFEST_SHA256'].some(key=>env[key]!==undefined))throw Error('CLOSED_ADMISSION_CONFIG_AMBIGUOUS');
  return{admissionProfile:'closed',firstpartyAppId:null,admissionRelease:null,admissionManifest:null};
 }
 if(!identifier(env.OASIS_FIRSTPARTY_APP_ID)||!env.OASIS_FIRSTPARTY_APP_ID.startsWith('app_')||!release(env.OASIS_ADMISSION_RELEASE)||!sha(env.OASIS_ADMISSION_MANIFEST_SHA256))throw Error('FIRSTPARTY_ADMISSION_CONFIG_REQUIRED');
 return{admissionProfile:profile,firstpartyAppId:env.OASIS_FIRSTPARTY_APP_ID,admissionRelease:env.OASIS_ADMISSION_RELEASE,admissionManifest:env.OASIS_ADMISSION_MANIFEST_SHA256};
}

export function validateFirstpartyAdmission({config,app,policy,binding,walletScope,intent='session',gameId,practice,entryMinor,room}={}){
 require(['activate','register','session','room','existing-ready','recovery','metadata'].includes(intent),'INVALID_ADMISSION_INTENT');
 require(config?.production===true&&config.admissionEnabled===false&&config.admissionProfile===FIRSTPARTY_FREE_PROFILE,'PRODUCTION_ACCEPTANCE_REQUIRED');
 require(app?.id===config.firstpartyAppId&&app.environment==='production'&&app.partner_id==='partner_oasis_platform'&&fields.every(field=>identifier(scopeOf(app)[field])),'FIRSTPARTY_APP_REQUIRED');
 require(policy?.app_id===app.id&&policy.profile===FIRSTPARTY_FREE_PROFILE&&['closed','open'].includes(policy.state)&&revision(policy.revision),'FIRSTPARTY_POLICY_REQUIRED');
 const actualScope=scopeOf(app);
 require(policy.scope&&Object.keys(policy.scope).length===fields.length&&fields.every(field=>policy.scope[field]===actualScope[field]),'FIRSTPARTY_SCOPE_CHANGED');
 require(Number.isInteger(app.currency_scale)&&app.currency_scale>=0&&app.currency_scale<=6&&policy.currency_scale===app.currency_scale,'FIRSTPARTY_SCOPE_CHANGED');
 require(origins(policy.allowed_origins)&&sameList(policy.allowed_origins,app.allowed_origins)&&policy.allowed_origins.includes(config.publicOrigin),'FIRSTPARTY_HOST_CHANGED');
 require(games(policy.game_ids)&&sameList(policy.game_ids,app.game_ids),'FIRSTPARTY_GAMES_CHANGED');
 require(release(policy.release)&&policy.release===config.admissionRelease&&sha(policy.manifest_sha256)&&policy.manifest_sha256===config.admissionManifest&&sha(policy.proof_sha256)&&identifier(policy.approved_by)&&(policy.approved_at instanceof Date||typeof policy.approved_at==='string'&&policy.approved_at.length>0)&&Number.isFinite(new Date(policy.approved_at).getTime()),'FIRSTPARTY_SOURCE_APPROVAL_REQUIRED');
 require(binding?.provider==='platform'&&app.wallet_url===''&&binding.wallet_url===null&&binding.wallet_key_id===null&&fields.every(field=>binding.scope?.[field]===actualScope[field]),'PRODUCTION_WALLET_REQUIRED');
 require(walletScope&&walletScope.scope_id===fields.map(field=>actualScope[field]).join(':')&&fields.every(field=>walletScope[field]===actualScope[field])&&walletScope.currency_scale===app.currency_scale,'PRODUCTION_WALLET_REQUIRED');
 require(['treasury_available','treasury_reserved','treasury_inbound','fee_available','fee_pending','ledger_version'].every(field=>walletScope[field]==='0'||walletScope[field]===0),'FIRSTPARTY_FINANCIAL_STATE_NOT_EMPTY');
 require(['active','paused'].includes(app.status),'FIRSTPARTY_APP_REQUIRED');
 const info={profile:FIRSTPARTY_FREE_PROFILE,state:policy.state,open:policy.state==='open'&&app.status==='active',revision:String(policy.revision),app,game_ids:[...policy.game_ids],release:policy.release,manifest_sha256:policy.manifest_sha256,proof_sha256:policy.proof_sha256};
 if(intent==='metadata'||intent==='recovery')return info;
 if(intent==='existing-ready'){
  require(room?.terms?.admission_profile===FIRSTPARTY_FREE_PROFILE&&revision(room.terms.admission_revision)&&BigInt(room.terms.admission_revision)<=BigInt(info.revision)&&room.terms.admission_release===info.release&&room.terms.admission_manifest_sha256===info.manifest_sha256&&room.terms.admission_proof_sha256===info.proof_sha256,'FIRSTPARTY_ROOM_NOT_ACCEPTED');
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
 require(config?.production&&config.admissionProfile===FIRSTPARTY_FREE_PROFILE,'PRODUCTION_ACCEPTANCE_REQUIRED');
 const current=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR SHARE',[app.id])).rows[0];
 require(current&&fields.every(field=>scopeOf(current)[field]===scopeOf(app)[field])&&current.currency_scale===app.currency_scale&&current.wallet_url===app.wallet_url&&sameList(current.allowed_origins,app.allowed_origins)&&sameList(current.game_ids,app.game_ids),'FIRSTPARTY_APP_CONFIG_CHANGED');
 const policy=(await db.query('SELECT * FROM gp_production_admission WHERE app_id=$1 FOR SHARE',[app.id])).rows[0];
 const binding=(await db.query('SELECT * FROM gp_wallet_bindings WHERE app_id=$1 FOR SHARE',[app.id])).rows[0];
 const walletScope=(await db.query('SELECT * FROM wallet_scopes WHERE partner_id=$1 AND app_id=$2 AND environment=$3 AND wallet_scope_id=$4 AND currency_id=$5 FOR SHARE',fields.map(field=>scopeOf(current)[field]))).rows[0];
 return validateFirstpartyAdmission({...options,config,app:current,policy,binding,walletScope});
}

export function productionAdmissionSnapshot(info){return info?.profile===FIRSTPARTY_FREE_PROFILE?{admission_profile:info.profile,admission_revision:info.revision,admission_release:info.release,admission_manifest_sha256:info.manifest_sha256,admission_proof_sha256:info.proof_sha256}:{};}
export function publicAdmissionCapability(info){return{admission_profile:info?.profile||'closed',admission_open:info?.open===true,free_training_only:info?.profile===FIRSTPARTY_FREE_PROFILE,financial_admission_enabled:false,allowed_room_modes:info?.profile===FIRSTPARTY_FREE_PROFILE?['bot-practice']:[],game_ids:info?.game_ids||[]};}
export async function assertNewFinancialAdmission(_db,app){if(app?.environment==='production')reject('PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED');}
