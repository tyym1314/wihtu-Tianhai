/** One-time empty-production bootstrap. Never imports the listening API or its seed. */
import {readFile,open,lstat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {ARENA_IDS} from '../../shared/games.mjs';

export const EMPTY_TABLES=['gp_players','gp_player_sessions','gp_player_app_ids','gp_sessions','gp_launch_intents','gp_launch_codes','gp_cycles','gp_operations','gp_plays','gp_admin_sessions','gp_partner_accounts','gp_partner_sessions','gp_nonces','pvp_rooms','pvp_operations','pvp_actions','pvp_active_users','pvp_presence','pvp_requests','pvp_run_input_decisions','wallet_users','wallet_ledger','wallet_operations','wallet_matches','wallet_reservations','wallet_probability','wallet_keys','wallet_math_profiles','wallet_nonces','wallet_events','wallet_operation_ids','gp_transfers','gp_transfer_bindings','gp_transfer_accounts','gp_transfer_outbox','wallet_transfer_clearing','gp_integration_checks'];
export function validateBootstrapConfig(env){
 if(env.OASIS_ENVIRONMENT!=='production'||env.NODE_ENV!=='production'||env.OASIS_START_WALLET!=='0'||env.OASIS_PRODUCTION_ADMISSION_ENABLED!=='0'||env.OASIS_API_PORT!=='18891')throw Error('BOOTSTRAP_ISOLATION_REQUIRED');
 const db=new URL(env.OASIS_DATABASE_URL);
 if(db.protocol!=='postgres:'||db.hostname!=='127.0.0.1'||db.port!=='18893'||db.pathname!=='/oasis_production'||decodeURIComponent(db.username)!=='oasis_prod_app'||!db.password||db.search||db.hash)throw Error('BOOTSTRAP_DATABASE_IDENTITY_INVALID');
 const origins=JSON.parse(env.OASIS_BOOTSTRAP_ALLOWED_ORIGINS||'null');
 if(!Array.isArray(origins)||!origins.length||new Set(origins).size!==origins.length||!origins.includes(env.OASIS_PUBLIC_ORIGIN)||origins.some(x=>{try{const u=new URL(x);return u.origin!==x||u.protocol!=='https:'||u.username||u.password;}catch{return true;}}))throw Error('BOOTSTRAP_ORIGINS_INVALID');
 if(env.OASIS_LOCAL_DIR!=='/opt/oasis/production-instance-private/state/')throw Error('BOOTSTRAP_LOCAL_DIRECTORY_INVALID');
 return {origins};
}
export function assertBootstrapEvidence(value){
 if(value.database!=='oasis_production'||value.role!=='oasis_prod_app'||value.environment!=='production'||value.admins!==1||value.apps!==1||value.keys!==1||value.wallet_scopes!==1||value.bindings!==1||value.bad_apps!==0||value.nonzero_scopes!==0||value.bad_bindings!==0||value.demo_admins!==0||value.not_empty!==0)throw Error('BOOTSTRAP_SEED_UNSAFE');
 return value;
}
export function evidenceSQL(){return `SELECT json_build_object(
 'database',current_database(),'role',current_user,
 'environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),
 'admins',(SELECT count(*) FROM gp_admins),'demo_admins',(SELECT count(*) FROM gp_admins WHERE id='admin_local' OR username='admin'),
 'apps',(SELECT count(*) FROM gp_apps),'keys',(SELECT count(*) FROM gp_keys),
 'wallet_scopes',(SELECT count(*) FROM wallet_scopes),'bindings',(SELECT count(*) FROM gp_wallet_bindings),
 'bad_apps',(SELECT count(*) FROM gp_apps WHERE environment!='production' OR status!='paused' OR partner_id!='partner_oasis_platform' OR wallet_url!='' OR game_ids!='${JSON.stringify(ARENA_IDS)}'::jsonb OR jsonb_array_length(allowed_origins)=0),
 'nonzero_scopes',(SELECT count(*) FROM wallet_scopes WHERE environment!='production' OR treasury_available!=0 OR treasury_reserved!=0 OR treasury_inbound!=0 OR fee_available!=0 OR fee_pending!=0 OR ledger_version!=0),
 'bad_bindings',(SELECT count(*) FROM gp_wallet_bindings b JOIN gp_apps a ON a.id=b.app_id WHERE b.provider!='platform' OR b.scope->>'environment' IS DISTINCT FROM 'production' OR b.wallet_url IS NOT NULL OR b.wallet_key_id IS NOT NULL OR b.scope->>'wallet_scope_id' IS DISTINCT FROM a.wallet_scope_id OR b.scope->>'partner_id' IS DISTINCT FROM a.partner_id OR b.scope->>'app_id' IS DISTINCT FROM a.id OR b.scope->>'currency_id' IS DISTINCT FROM a.currency_id),
 'not_empty',${EMPTY_TABLES.map(t=>`(SELECT count(*) FROM ${t})`).join('+')}) AS evidence;`;}

export async function bootstrap({credentialsFile,receiptFile,env=process.env}={}){
 const {origins}=validateBootstrapConfig(env);
 const s=await lstat(credentialsFile);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o777)!==0o600||s.nlink!==1)throw Error('BOOTSTRAP_CREDENTIAL_FILE_UNSAFE');
 const credential=JSON.parse(await readFile(credentialsFile,'utf8'));
 if(Object.keys(credential).sort().join(',')!=='password,username'||credential.username!=='operator'||typeof credential.password!=='string'||credential.password.length<32)throw Error('BOOTSTRAP_CREDENTIAL_INVALID');
 const {pool,closePools}=await import('../../server/db.mjs');
 const lock=await pool.connect();let locked=false;
 try{
  await lock.query('SELECT pg_advisory_lock(80261010,18891)');locked=true;
  const initial=(await lock.query("SELECT current_database() AS database,current_user AS role,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') AS tables,(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname=current_user) AS privileged")).rows[0];
  if(initial.database!=='oasis_production'||initial.role!=='oasis_prod_app'||initial.tables!==0||initial.privileged!==false)throw Error('BOOTSTRAP_DATABASE_NOT_EMPTY_OR_NOT_OWNED');
  const {runtime,preflightRuntime,migrateRuntime}=await import('../../server/runtime-mode.mjs');
  if(!runtime.production||runtime.admissionEnabled)throw Error('BOOTSTRAP_RUNTIME_INVALID');
  const {migrateWallet}=await import('../../server/wallet/index.mjs');
  const {migratePlatform,createApp}=await import('../../server/platform.mjs');
  await preflightRuntime(pool);await migrateWallet(pool);await migratePlatform();await migrateRuntime(pool);
  await (await import('../../server/portal.mjs')).migratePortal();
  await (await import('../../server/credentials.mjs')).migrateCredentials();
  await (await import('../../server/pvp/index.mjs')).migratePvp(pool);
  await (await import('../../server/overview-activity.mjs')).migrateOverviewActivity();
  await (await import('../../server/wallet-binding.mjs')).migrateWalletBindings(pool);
  await (await import('../../server/integration-checks.mjs')).migrateIntegrationChecks();
  await (await import('../../server/transfers/index.mjs')).migrateTransfers(pool);
  const {passwordMaterial}=await import('../../server/credentials.mjs'),{unseal}=await import('../../server/security.mjs');
  const material=await passwordMaterial(credential.password),adminId='admin_'+randomBytes(16).toString('hex');
  await pool.query('INSERT INTO gp_admins(id,username,salt,password_hash) VALUES($1,$2,$3,$4)',[adminId,credential.username,material.salt,material.password_hash]);
  const {app}=await createApp('OASIS',{partnerId:'partner_oasis_platform',actor:adminId,walletProvider:'platform'});
  await pool.query('UPDATE gp_apps SET allowed_origins=$2 WHERE id=$1',[app.id,JSON.stringify(origins)]);
  const evidence=assertBootstrapEvidence((await pool.query(evidenceSQL())).rows[0].evidence);
  const keys=(await pool.query('SELECT secret_enc FROM gp_keys')).rows;for(const key of keys)if(typeof unseal(key.secret_enc)!=='string')throw Error('BOOTSTRAP_KEY_INVALID');
  const receipt={schema:1,at:new Date().toISOString(),kind:'isolated-production-bootstrap',passed:true,app_id:app.id,origins,admission_enabled:false,players_created:0,coins_funded:'0',evidence};
  const fd=await open(receiptFile,'wx',0o600);try{await fd.chmod(0o600);await fd.writeFile(JSON.stringify(receipt,null,2)+'\n');await fd.sync();}finally{await fd.close();}
  return receipt;
 }finally{
  credential.password='';try{if(locked)await lock.query('SELECT pg_advisory_unlock(80261010,18891)');}finally{
   lock.release();try{await (await import('../../server/pvp/engine-pool.mjs')).closeEnginePool();}finally{await closePools();}
  }
 }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{if(process.getuid?.()!==0||process.argv.length!==4)throw Error('BOOTSTRAP_ARGUMENT_INVALID');await bootstrap({credentialsFile:process.argv[2],receiptFile:process.argv[3]});process.stdout.write('{"passed":true}\n');}
 catch(error){process.stderr.write((/^[A-Z0-9_]+$/.test(error.message)?error.message:'BOOTSTRAP_FAILED')+'\n');process.exitCode=2;}
}
