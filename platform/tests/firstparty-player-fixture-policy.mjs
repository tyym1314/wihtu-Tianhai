import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {ARENA_IDS} from '../shared/games.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixtureRelease='/opt/oasis/releases/20990101-99';
const fixtureManifest=digest({kind:'isolated-fixture-source-declaration',release:fixtureRelease,profile:'firstparty-free-v1',games:ARENA_IDS,production_approval:false});

/** Must run before importing runtime/server modules. No production identity,
 * filesystem release, source approval or financial capability is implied. */
export function firstpartyPlayerFixtureDeclaration({databaseName,origin,appId='app_fixture_'+randomBytes(16).toString('hex')}={}){
 assert.match(databaseName||'',/^oasis_release_test_\d+_[a-f0-9]{12}$/);
 assert.match(appId,/^app_fixture_[a-f0-9]{32}$/);
 const url=new URL(origin);assert.equal(url.origin,origin);assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');
 const evidence=Object.freeze({kind:'isolated-firstparty-free-fixture',database:databaseName,app_id:appId,origin,release:fixtureRelease,manifest_sha256:fixtureManifest,production_approval:false});
 return Object.freeze({appId,databaseName,origin,evidence,proofSha256:digest(evidence),runtimeEnv:Object.freeze({OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_ADMISSION_PROFILE:'firstparty-free-v1',OASIS_FIRSTPARTY_APP_ID:appId,OASIS_ADMISSION_RELEASE:fixtureRelease,OASIS_ADMISSION_MANIFEST_SHA256:fixtureManifest})});
}

/** Inserts a real policy and a real zero-money wallet in this fixture's DB.
 * The App and policy remain under the same lock order used by production. */
export async function installFirstpartyPlayerFixture(pool,declaration,{name='Isolated player fixture'}={}){
 assert.equal((await pool.query('SELECT current_database() name')).rows[0].name,declaration.databaseName);
 const {runtime}=await import('../server/runtime-mode.mjs');
 assert.equal(Object.isFrozen(runtime),true);assert.equal(runtime.admissionEnabled,false);assert.equal(runtime.firstpartyAppId,declaration.appId);assert.equal(runtime.admissionRelease,fixtureRelease);assert.equal(runtime.admissionManifest,fixtureManifest);
 const {createPlatformWallet}=await import('../server/platform-wallet.mjs');
 async function transaction(fn){const db=await pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
 const scope=app=>({partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id});
 await transaction(async db=>{
  const app=(await db.query(`INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,status,game_ids,allowed_origins)
   VALUES($1,$2,'partner_oasis_platform','production',$3,'','paused',$4,$5) RETURNING *`,[declaration.appId,name,'wallet_fixture_'+randomBytes(16).toString('hex'),JSON.stringify(ARENA_IDS),JSON.stringify([declaration.origin])])).rows[0];
  await createPlatformWallet(db,app,'isolated_fixture_operator');
  await db.query(`INSERT INTO gp_production_admission(app_id,profile,state,revision,scope,currency_scale,allowed_origins,game_ids,release,manifest_sha256,proof_sha256,approved_by,approved_at)
   VALUES($1,'firstparty-free-v1','closed',1,$2,$3,$4,$5,$6,$7,$8,'isolated_fixture_operator',now())`,[app.id,JSON.stringify(scope(app)),app.currency_scale,JSON.stringify(app.allowed_origins),JSON.stringify(ARENA_IDS),fixtureRelease,fixtureManifest,declaration.proofSha256]);
 });
 async function setAdmission(state){
  assert.ok(['open','closed'].includes(state));
  return transaction(async db=>{
   await db.query('SELECT id FROM gp_apps WHERE id=$1 FOR UPDATE',[declaration.appId]);
   await db.query('SELECT app_id FROM gp_production_admission WHERE app_id=$1 FOR UPDATE',[declaration.appId]);
   await db.query('UPDATE gp_apps SET status=$2 WHERE id=$1',[declaration.appId,state==='open'?'active':'paused']);
   await db.query('UPDATE gp_production_admission SET state=$2,revision=revision+1,updated_at=now() WHERE app_id=$1',[declaration.appId,state]);
   return(await db.query('SELECT * FROM gp_apps WHERE id=$1',[declaration.appId])).rows[0];
  });
 }
 return{app:await setAdmission('open'),setAdmission,admissionDeclaration:declaration.evidence};
}
