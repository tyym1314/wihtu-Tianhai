/** A database belongs to one runtime environment; there is no in-place promotion. */
import {productionAdmissionConfiguration,readProductionAdmission,installProductionAdmissionRuntime} from './production-admission.mjs';
export function runtimeConfiguration(env=process.env){
 const environment=env.OASIS_ENVIRONMENT||'sandbox';
 if(!['sandbox','production'].includes(environment))throw Error('INVALID_RUNTIME_ENVIRONMENT');
 if(environment==='production'){
  let origin;try{origin=new URL(env.OASIS_PUBLIC_ORIGIN);}catch{throw Error('PRODUCTION_HTTPS_ORIGIN_REQUIRED');}
  if(origin.protocol!=='https:'||origin.origin!==env.OASIS_PUBLIC_ORIGIN||origin.username||origin.password)throw Error('PRODUCTION_HTTPS_ORIGIN_REQUIRED');
  if(!env.OASIS_DATABASE_URL||!env.OASIS_LOCAL_DIR||env.OASIS_START_WALLET!=='0')throw Error('PRODUCTION_ISOLATION_CONFIG_REQUIRED');
 }
 return Object.freeze({environment,production:environment==='production',admissionEnabled:environment!=='production',publicOrigin:env.OASIS_PUBLIC_ORIGIN||null,...productionAdmissionConfiguration(env,environment==='production')});
}
export const runtime=runtimeConfiguration();
installProductionAdmissionRuntime(runtime);
export async function preflightRuntime(pool){
 const tables=(await pool.query("SELECT to_regclass('public.gp_runtime_identity') AS identity,to_regclass('public.gp_apps') AS apps")).rows[0];
 if(tables.identity){const identity=(await pool.query('SELECT environment FROM gp_runtime_identity WHERE singleton')).rows[0];if(identity&&identity.environment!==runtime.environment)throw Error('DATABASE_ENVIRONMENT_MISMATCH');}
 if(tables.apps&&(await pool.query('SELECT 1 FROM gp_apps WHERE environment<>$1 LIMIT 1',[runtime.environment])).rowCount)throw Error('DATABASE_ENVIRONMENT_MISMATCH');
}
export async function migrateRuntime(pool){
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('runtime-identity',0))");
  await db.query(`CREATE TABLE IF NOT EXISTS gp_runtime_identity (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),environment text NOT NULL CHECK(environment IN ('sandbox','production')))`);
  const mixed=(await db.query('SELECT 1 FROM gp_apps WHERE environment<>$1 LIMIT 1',[runtime.environment])).rowCount;
  if(mixed)throw Error('DATABASE_ENVIRONMENT_MISMATCH');
  await db.query('INSERT INTO gp_runtime_identity(singleton,environment) VALUES(true,$1) ON CONFLICT DO NOTHING',[runtime.environment]);
  const identity=(await db.query('SELECT environment FROM gp_runtime_identity WHERE singleton')).rows[0];
  if(identity.environment!==runtime.environment)throw Error('DATABASE_ENVIRONMENT_MISMATCH');
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function assertProductionAppReady(db,app,options={}){
 if(app.environment!=='production')return;
 return readProductionAdmission(db,app,options);
}
