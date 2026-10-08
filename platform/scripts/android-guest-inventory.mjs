/** Read-only, exact Mock app/guest inventory. Executed via the explicitly configured SSH channel.
 * It does not import server startup, call an HTTP route, recover a cycle, or expose credentials.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const ANDROID_GUEST_INVENTORY_SQL=`WITH sessions AS (
 SELECT id,state,CASE WHEN state->>'nextIndex' ~ '^[0-9]{1,9}$' THEN (state->>'nextIndex')::int ELSE NULL END AS next_index
 FROM gp_sessions WHERE app_id=$1 AND external_user_id=$2
), cycles AS (
 SELECT c.*,CASE WHEN jsonb_typeof(c.result->'rounds')='array' THEN jsonb_array_length(c.result->'rounds') ELSE NULL END AS round_count
 FROM gp_cycles c WHERE c.app_id=$1 AND c.external_user_id=$2
), rooms AS (
 SELECT r.id,r.status FROM pvp_rooms r WHERE r.app_id=$1
 AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.players) p WHERE p->>'external_user_id'=$2)
)
SELECT
 (SELECT count(*) FROM sessions)::int AS sessions,
 (SELECT count(*) FROM cycles)::int AS cycles,
 (SELECT count(*) FROM rooms)::int AS rooms,
 (SELECT count(*) FROM sessions s LEFT JOIN cycles c ON c.id=s.state->>'cycleId' WHERE
 jsonb_typeof(s.state) IS DISTINCT FROM 'object' OR NOT (s.state ?& ARRAY['version','pendingPlay','cycleId','nextIndex'])
 OR jsonb_typeof(s.state->'version') IS DISTINCT FROM 'number' OR NOT COALESCE(s.state->>'version' ~ '^[0-9]{1,15}$',false)
 OR jsonb_typeof(s.state->'nextIndex') IS DISTINCT FROM 'number' OR s.next_index IS NULL
 OR jsonb_typeof(s.state->'pendingPlay') NOT IN ('null','string') OR jsonb_typeof(s.state->'cycleId') NOT IN ('null','string')
 OR (s.state->>'cycleId' IS NULL AND (s.next_index<>0 OR s.state->>'pendingPlay' IS NOT NULL))
 OR (s.state->>'cycleId' IS NOT NULL AND (c.id IS NULL OR c.session_id<>s.id OR c.round_count IS NULL OR c.round_count<1 OR s.next_index<1 OR s.next_index>c.round_count))
 )::int AS invalid_states,
 (SELECT count(*) FROM cycles c WHERE NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=c.session_id)
 OR (c.status='SETTLED' AND (c.round_count IS NULL OR c.round_count<1
 OR EXISTS(SELECT 1 FROM gp_plays p WHERE p.cycle_id=c.id AND (p.session_id<>c.session_id OR p.round_index<0 OR p.round_index>=c.round_count)))))::int AS invalid_cycles,
 (SELECT count(*) FROM pvp_active_users WHERE app_id=$1 AND external_user_id=$2)::int AS active_rooms,
 (SELECT count(*) FROM rooms WHERE status IS NULL OR status NOT IN ('settled','cancelled','voided'))::int AS nonterminal_rooms,
 (SELECT count(*) FROM sessions WHERE state->>'pendingPlay' IS NOT NULL)::int AS pending_rounds,
 (SELECT count(*) FROM gp_plays p JOIN sessions s ON s.id=p.session_id WHERE p.acknowledged IS DISTINCT FROM true)::int AS unacknowledged_rounds,
 (SELECT count(*) FROM sessions s LEFT JOIN cycles c ON c.id=s.state->>'cycleId'
 WHERE s.state->>'cycleId' IS NOT NULL AND (c.id IS NULL OR c.result IS NULL
 OR s.next_index IS NULL OR s.next_index<c.round_count
 OR COALESCE(c.result->'rounds'->GREATEST(0,s.next_index-1)->>'freeSpinsAfter','0')<>'0'))::int AS remaining_cycles,
 (SELECT count(*) FROM cycles c WHERE c.status IS NULL OR c.status NOT IN ('SETTLED','REJECTED') OR
 (c.status='SETTLED' AND (SELECT count(*) FROM gp_plays p WHERE p.cycle_id=c.id)<COALESCE(c.round_count,1)))::int AS unresolved_cycles,
 (SELECT count(*) FROM gp_operations o JOIN cycles c ON o.aggregate_id=c.id WHERE o.app_id=$1 AND o.state='PENDING')::int AS probability_operations,
 (SELECT count(*) FROM pvp_operations o JOIN rooms r ON o.room_id=r.id WHERE o.app_id=$1 AND o.state='PENDING')::int AS arena_operations`;
export const ANDROID_INVENTORY_COUNTERS=Object.freeze(['sessions','cycles','rooms','invalid_states','invalid_cycles','active_rooms','nonterminal_rooms','pending_rounds','unacknowledged_rounds','remaining_cycles','unresolved_cycles','probability_operations','arena_operations']);
export function validateAndroidInventoryInput(input){
 assert.equal(input.variant,'isolated-mock','STRICT_ANDROID_REQUIRES_ISOLATED_MOCK');
 const url=new URL(input.origin);assert.equal(url.protocol,'https:');assert.equal(url.origin,input.origin);assert.ok(!url.username&&!url.password);
 assert.match(input.release,/^\d{8}-\d{2}$/);assert.match(input.manifest_sha256,/^[a-f0-9]{64}$/);
 for(const key of ['app_id','guest_id','session_id','game_id'])assert.match(input[key],/^[A-Za-z0-9_-]{1,128}$/,'INVENTORY_IDENTITY_REQUIRED');
}
export function validateAndroidInventoryDatabase(value){
 const db=new URL(value);
 if(!(db.protocol==='postgres:'&&db.hostname==='127.0.0.1'&&db.port==='18983'&&db.pathname==='/oasis_android_mock'&&db.username==='oasis_mock_app'&&!db.search&&!db.hash))throw Error('INVENTORY_DATABASE_SCOPE_MISMATCH');
 return true;
}

// This function is serialized into stdin, never written to the remote release.
async function remoteInventory(input,sql,validateDatabase){
 const fs=await import('node:fs/promises'),crypto=await import('node:crypto'),{createRequire}=await import('node:module');
 const requireValue=(value,code)=>{if(!value)throw Error(code);};
 const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 const release='/opt/oasis/releases/'+input.release,platform=release+'/platform',pin='/opt/oasis/android-mock-current';
 requireValue(await fs.realpath(pin)===release,'INVENTORY_RELEASE_PIN_CHANGED');
 const manifestBytes=await fs.readFile(release+'/RELEASE-MANIFEST.json');requireValue(hash(manifestBytes)===input.manifest_sha256,'INVENTORY_MANIFEST_CHANGED');
 const manifest=JSON.parse(manifestBytes),files=manifest.files||manifest,sourceHashes={};
 for(const name of ['server/schema.sql','server/pvp/schema.sql','server/platform.mjs','server/cycles.mjs','server/pvp/index.mjs']){
  const value=hash(await fs.readFile(platform+'/'+name));requireValue(value===files['platform/'+name],'INVENTORY_SERVER_SOURCE_CHANGED');sourceHashes[name]=value;
 }
 const envPath='/opt/oasis/android-mock-private/runtime.env',stat=await fs.lstat(envPath);
 requireValue(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'INVENTORY_ENV_FILE_UNSAFE');
 const env={};for(const line of (await fs.readFile(envPath,'utf8')).split(/\r?\n/)){
  if(!line||line.startsWith('#'))continue;const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);requireValue(match&&!Object.hasOwn(env,match[1]),'INVENTORY_ENV_INVALID');env[match[1]]=match[2];
 }
 requireValue(env.MOCK_SANDBOX_KIND==='isolated-13-game-mock'&&env.OASIS_ENVIRONMENT==='sandbox'&&env.OASIS_PUBLIC_ORIGIN===input.origin,'INVENTORY_ENV_SCOPE_MISMATCH');
 validateDatabase(env.OASIS_DATABASE_URL);
 const {Pool}=createRequire(platform+'/package.json')('pg');
 const pool=new Pool({connectionString:env.OASIS_DATABASE_URL,max:1,connectionTimeoutMillis:5000});let client;
 try{
  client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='5s'");await client.query("SET LOCAL lock_timeout='1s'");
  const identity=(await client.query(`SELECT a.environment,a.wallet_url,s.game_id FROM gp_apps a JOIN gp_sessions s ON s.app_id=a.id
    WHERE a.id=$1 AND s.external_user_id=$2 AND s.id=$3`,[input.app_id,input.guest_id,input.session_id])).rows;
  requireValue(identity.length===1&&identity[0].environment==='sandbox'&&identity[0].wallet_url===env.OASIS_REFERENCE_WALLET_URL&&identity[0].wallet_url==='http://127.0.0.1:18982'&&identity[0].game_id===input.game_id,'INVENTORY_APP_GUEST_SESSION_MISMATCH');
  const schema=(await client.query("SELECT table_name,column_name,data_type,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,ordinal_position",[['gp_apps','gp_sessions','gp_cycles','gp_plays','gp_operations','pvp_rooms','pvp_active_users','pvp_operations']])).rows;
  requireValue(schema.length>0,'INVENTORY_SCHEMA_MISSING');
  const counts=(await client.query(sql,[input.app_id,input.guest_id])).rows[0];
  const current=(await client.query('SELECT count(*)::int AS cycles FROM gp_cycles WHERE app_id=$1 AND external_user_id=$2 AND session_id=$3',[input.app_id,input.guest_id,input.session_id])).rows[0];
  await client.query('ROLLBACK');
  requireValue(await fs.realpath(pin)===release&&hash(await fs.readFile(release+'/RELEASE-MANIFEST.json'))===input.manifest_sha256,'INVENTORY_RELEASE_CHANGED_DURING_READ');
  return{schema:'android-guest-inventory-v1',binding:input,observed_at:new Date().toISOString(),database:'oasis_android_mock',transaction:'repeatable-read/read-only',schema_sha256:hash(JSON.stringify(schema)),server_sources:sourceHashes,counts,current_session_cycles:current.cycles};
 }finally{client?.release();await pool.end();}
}
export function androidInventoryProgram(input){
 validateAndroidInventoryInput(input);
 const body=`const read=${remoteInventory.toString()};\nconst validateDatabase=${validateAndroidInventoryDatabase.toString()};\nconst sql=${JSON.stringify(ANDROID_GUEST_INVENTORY_SQL)};\nconst input=${JSON.stringify(input)};\n`;
 const reader_sha256=createHash('sha256').update(remoteInventory.toString()+validateAndroidInventoryDatabase.toString()+ANDROID_GUEST_INVENTORY_SQL).digest('hex');
 const program=body+`try{console.log(JSON.stringify({...await read(input,sql,validateDatabase),reader_sha256:${JSON.stringify(reader_sha256)}}));}catch{console.error('ANDROID_GUEST_INVENTORY_FAILED');process.exitCode=1;}\n`;
 return{command:'/usr/bin/node --input-type=module',input:program,reader_sha256,program_sha256:createHash('sha256').update(program).digest('hex')};
}
export function verifyAndroidInventory(proof,input,{reader_sha256,requireClean=true,previous}={}){
 validateAndroidInventoryInput(input);assert.equal(proof.schema,'android-guest-inventory-v1');assert.deepEqual(proof.binding,input,'INVENTORY_SCOPE_MISMATCH');
 assert.equal(proof.reader_sha256,reader_sha256,'INVENTORY_READER_MISMATCH');assert.match(proof.schema_sha256,/^[a-f0-9]{64}$/);
 assert.equal(proof.database,'oasis_android_mock');assert.equal(proof.transaction,'repeatable-read/read-only');assert.ok(Number.isFinite(Date.parse(proof.observed_at)));
 assert.deepEqual(Object.keys(proof.counts).sort(),[...ANDROID_INVENTORY_COUNTERS].sort());
 for(const value of Object.values(proof.counts))assert.ok(Number.isSafeInteger(value)&&value>=0,'INVALID_INVENTORY_COUNT');
 assert.ok(Number.isSafeInteger(proof.current_session_cycles)&&proof.current_session_cycles>=0);
 assert.deepEqual(Object.keys(proof.server_sources).sort(),['server/schema.sql','server/pvp/schema.sql','server/platform.mjs','server/cycles.mjs','server/pvp/index.mjs'].sort());for(const value of Object.values(proof.server_sources))assert.match(value,/^[a-f0-9]{64}$/);
 const clean=ANDROID_INVENTORY_COUNTERS.slice(3).every(key=>proof.counts[key]===0);
 if(requireClean)assert.equal(clean,true,'PERSISTENT_GUEST_OBLIGATIONS_PRESERVED');
 if(previous){
  assert.equal(previous.clean,true,'PREVIOUS_INVENTORY_NOT_CLEAN');assert.equal(previous.reader_sha256,reader_sha256);assert.equal(previous.schema_sha256,proof.schema_sha256);assert.deepEqual(previous.server_sources,proof.server_sources);
  for(const key of ['variant','origin','release','manifest_sha256','app_id','guest_id'])assert.equal(previous.binding[key],input[key],'PREVIOUS_INVENTORY_SCOPE_MISMATCH');
  assert.equal(proof.counts.cycles,previous.counts.cycles,'UNOBSERVED_CYCLE_BETWEEN_GAMES');assert.equal(proof.counts.rooms,previous.counts.rooms,'UNOBSERVED_ROOM_BETWEEN_GAMES');
 }
 return{...proof,clean};
}
