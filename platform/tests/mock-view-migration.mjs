/** Explicit local release-pair drill, intentionally outside *.test.mjs.
 * Run: node --import tsx --test tests/mock-view-migration.mjs
 * Requires the verified ignored 04/15 source trees; missing/drifted inputs FAIL.
 * No server, HTTP listener, live database, source-tree writes or product changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,lstat,mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MATERIALS=join(ROOT,'review/mock-release-views-20261008');
const SOURCES=join(MATERIALS,'sources');
const PINS=Object.freeze({
 mock04:'47e5cab2ff8c910e7821e6c1edbd92a26135944241fc5b0c1610a44952d883bc',
 public15:'6b4f3548a8382083d18ded796c9aec7ee09d5a82fcf1020267d3dc2b309db25f',
});
const NAME=/^oasis_release_test_\d+_[a-f0-9]{12}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const ident=value=>{assert.match(value,/^[a-z_][a-z0-9_]*$/);return '"'+value+'"';};
const newName=()=>`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`;
const requestId=()=>`migration_${randomBytes(12).toString('hex')}`;
const SCHEMAS=['platform/server/schema.sql','platform/server/wallet/schema.sql','platform/server/pvp/schema.sql'];

function localURL(value,expected='postgres'){
 const url=new URL(value);
 assert.equal(url.protocol,'postgres:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5487');
 assert.equal(url.pathname,'/'+expected);assert.equal(url.search,'');assert.equal(url.hash,'');
 return url;
}
async function verifiedSources({full=false}={}){
 const preparation=JSON.parse(await readFile(join(MATERIALS,'source-preparation.json'),'utf8'));
 assert.equal(preparation.schema,'mock-release-view-source-preparation-v1');
 assert.deepEqual(preparation.source_manifest_sha256,{new:PINS.public15,old:PINS.mock04});
 const result={};
 for(const [label,pin]of Object.entries(PINS)){
  const tree=join(SOURCES,label),treeInfo=await lstat(tree);assert(treeInfo.isDirectory()&&!treeInfo.isSymbolicLink());
  const raw=await readFile(join(tree,'RELEASE-MANIFEST.json'));
  assert.equal(sha(raw),pin,`${label} manifest drift`);const manifest=JSON.parse(raw);
  let checked=0;
  for(const [name,expected]of Object.entries(manifest)){
   assert.equal(typeof expected,'string');assert.match(expected,/^[a-f0-9]{64}$/);
   assert(!name.startsWith('/')&&!name.split('/').some(p=>!p||p==='.'||p==='..')&&!name.includes('\\'),'Unsafe manifest path');
   // Parent verifies every body. Each child rechecks executable/schema/spec
   // inputs before importing the frozen tree (including transitive modules).
   if(!full&&!/\.(?:mjs|cjs|js|jsx|ts|tsx|sql|json)$/.test(name))continue;
   const path=join(tree,name);let parent=tree;
   for(const part of name.split('/').slice(0,-1)){parent=join(parent,part);assert.equal((await lstat(parent)).isSymbolicLink(),false);}
   const info=await lstat(path);assert(info.isFile()&&!info.isSymbolicLink(),`${label}/${name}: not a regular file`);
   assert.equal(sha(await readFile(path)),expected,`${label}/${name}: body drift`);checked++;
  }
  for(const name of SCHEMAS)assert(manifest[name],`Missing schema: ${name}`);
  result[label]={tree,manifest,checked};
 }
 return result;
}

function run(executable,args,{env=process.env,input,timeout=60000}={}){
 return new Promise((ok,fail)=>{
  const child=spawn(executable,args,{cwd:ROOT,env,stdio:['pipe','pipe','pipe']});
  let out='',err='',timedOut=false,tooLarge=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  const collect=(target,chunk)=>{if(target==='out')out+=chunk;else err+=chunk;if(Buffer.byteLength(out)+Buffer.byteLength(err)>8*1024*1024){tooLarge=true;child.kill('SIGKILL');}};
  child.stdout.on('data',b=>collect('out',b));child.stderr.on('data',b=>collect('err',b));
  child.once('error',e=>{clearTimeout(timer);fail(e);});
  child.once('close',(code,signal)=>{clearTimeout(timer);if(code===0&&!timedOut&&!tooLarge)ok({out,err});else fail(new Error(`${executable} failed: exit=${code} signal=${signal} timeout=${timedOut} output_limit=${tooLarge}\n${err.slice(-12000)}`));});
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
function pgEnvironment(url){
 const env={...process.env,PGHOST:'127.0.0.1',PGPORT:'5487',PGUSER:decodeURIComponent(url.username),PGDATABASE:url.pathname.slice(1),PGCONNECT_TIMEOUT:'5'};
 delete env.PGSERVICE;delete env.PGSERVICEFILE;delete env.PGOPTIONS;delete env.PGHOSTADDR;
 if(url.password)env.PGPASSWORD=decodeURIComponent(url.password);else delete env.PGPASSWORD;
 return env;
}
async function childCall(label,url,privateDir,command){
 const env={...process.env,OASIS_DATABASE_URL:url.href,OASIS_EXPECT_TEST_DATABASE:url.pathname.slice(1),OASIS_LOCAL_DIR:privateDir,
  OASIS_ENVIRONMENT:'sandbox',OASIS_PRODUCTION_ADMISSION:'0',OASIS_START_WALLET:'0',OASIS_ENGINE_WORKERS:'1',OASIS_ENGINE_QUEUE:'16'};
 delete env.OASIS_ROOM_TIMING_FILE;
 const {out}=await run(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(import.meta.url),'--fixture-child'],{env,input:JSON.stringify({label,...command})});
 return JSON.parse(out);
}

async function schema(pool){
 const names=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename),tables={};
 for(const name of names){
  const columns=(await pool.query("SELECT column_name,data_type,udt_name,is_nullable,column_default,is_identity,identity_generation,is_generated,generation_expression FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[name])).rows;
  const constraints=(await pool.query("SELECT conname,contype,pg_get_constraintdef(oid) definition,convalidated FROM pg_constraint WHERE conrelid=to_regclass($1) ORDER BY conname",['public.'+name])).rows;
  const indexes=(await pool.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname",[name])).rows;
  tables[name]={columns,constraints,indexes};
 }
 const sequences=(await pool.query("SELECT sequence_name,data_type,start_value,minimum_value,maximum_value,increment,cycle_option FROM information_schema.sequences WHERE sequence_schema='public' ORDER BY sequence_name")).rows;
 return {tables,sequences};
}
async function rows(pool,shape){
 const result={};
 for(const [table,details]of Object.entries(shape.tables)){
  const columns=details.columns.map(c=>ident(c.column_name)).join(',');
  const {rows:[r]}=await pool.query(`SELECT count(*)::int count,COALESCE(jsonb_agg(to_jsonb(projected) ORDER BY to_jsonb(projected)::text),'[]'::jsonb)::text content FROM (SELECT ${columns} FROM ${ident(table)}) projected`);
  result[table]={count:r.count,sha256:sha(r.content)};
 }
 return result;
}
async function sequences(pool,shape){
 const values={};for(const {sequence_name:name}of shape.sequences)values[name]=(await pool.query(`SELECT last_value,is_called FROM ${ident(name)}`)).rows[0];return values;
}
async function applySchemas(pool,source){for(const name of SCHEMAS)await pool.query(await readFile(join(source.tree,name),'utf8'));}

async function fixtureChild(){
 const chunks=[];for await(const c of process.stdin)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());
 assert(Object.hasOwn(PINS,input.label));const expected=process.env.OASIS_EXPECT_TEST_DATABASE;assert.match(expected||'',NAME);
 localURL(process.env.OASIS_DATABASE_URL,expected);const sources=await verifiedSources();
 const tree=sources[input.label].tree,load=name=>import(pathToFileURL(join(tree,'platform',name)).href);
 const db=await load('server/db.mjs');let engines;
 try{
  assert.equal((await db.pool.query('SELECT current_database() name')).rows[0].name,expected);
  engines=await load('server/pvp/engine-pool.mjs');const {routePvp}=await load('server/pvp/index.mjs');
  const now=1000000,session={app_id:'mock_view_app',game_id:'run',external_user_id:'human'};
  const call=(s,method,path,body={},time=now)=>routePvp(s,method,path,method==='POST'?{request_id:requestId(),...body}:body,{now:time});
  let result;
  if(input.action==='seed04'){
   assert.equal(input.label,'mock04');
   const {seal}=await load('server/security.mjs'),wallet=await load('server/wallet/index.mjs');
   await db.pool.query("INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES('mock_view_app','Synthetic old Mock','mock_view_partner','sandbox','mock_view_scope','https://unused-wallet.invalid','[\"run\"]')");
   for(const user of ['human','legacy_human']){
    await db.pool.query('INSERT INTO gp_players(id,username,salt,password_hash) VALUES($1,$2,$3,$4)',['player_'+user,user,'synthetic-salt','synthetic-not-a-login-hash']);
    await db.pool.query("INSERT INTO gp_player_app_ids(app_id,player_id,external_user_id) VALUES('mock_view_app',$1,$2)",['player_'+user,user]);
    await db.pool.query("INSERT INTO gp_sessions(id,app_id,external_user_id,game_id,player_id) VALUES($1,'mock_view_app',$2,'run',$3)",['session_'+user,user,'player_'+user]);
   }
   await db.pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES('synthetic_key','mock_view_app','partner-to-platform',$1)",[seal(randomBytes(32).toString('base64'))]);
   const scope={partner_id:'mock_view_partner',app_id:'mock_view_app',environment:'sandbox',wallet_scope_id:'mock_view_scope',currency_id:'COIN'};
   await wallet.provisionWallet(db.pool,{scope,key_id:'synthetic_wallet_key',secret_base64:randomBytes(32).toString('base64'),treasury_minor:'1000000',users:[{external_user_id:'human',balance_minor:'12345'},{external_user_id:'legacy_human',balance_minor:'6789'}]});
   const legacy={...session,external_user_id:'legacy_human'};
   const room=(await call(legacy,'POST','/api/pvp/rooms',{game_id:'run',capacity:2,practice:true})).body,path='/api/pvp/rooms/'+room.id;
   await call(legacy,'POST',path+'/ready');await call(legacy,'POST',path+'/scene-ready');
   const terminal=(await call(legacy,'POST',path+'/leave')).body;
   assert.equal(terminal.status,'cancelled');assert.equal(terminal.game.ruleVersion,'pvp-run-v2.2.0');
   result={legacy,roomId:room.id,status:terminal.status,seedCommitment:terminal.seed_commitment};
  }else if(input.action==='create15'){
   assert.equal(input.label,'public15');const {RUN_PRACTICE_INPUT_PROTOCOL:protocol}=await load('server/pvp/run-practice-inputs.mjs');
   const room=(await call(session,'POST','/api/pvp/rooms',{game_id:'run',capacity:2,practice:true,run_input_protocol:protocol})).body,path='/api/pvp/rooms/'+room.id;
   await call(session,'POST',path+'/ready');const start=(await call(session,'POST',path+'/scene-ready')).body;
   assert.equal(start.game.ruleVersion,'pvp-run-v2.3.0');
   const body={request_id:requestId(),roomId:room.id,playerKey:'human',clockEpoch:start.run_inputs.clockEpoch,baseRevision:start.run_inputs.revision,commands:[{commandSeq:1,type:'jump',executeTick:1},{commandSeq:2,type:'slide',executeTick:7}]};
   const response=await call(session,'POST',path+'/inputs',body,now+300);
   assert.deepEqual(response.body.run_inputs.decisions.map(d=>d.outcome),['accepted','rejected']);
   assert.equal(response.body.run_inputs.decisions[1].code,'AIRBORNE');
   result={session,path,body,response,now};
  }else if(input.action==='replay15'){
   assert.equal(input.label,'public15');result=await call(input.session,'POST',input.path+'/inputs',input.body,input.now+900);
  }else if(input.action==='settle15'){
   assert.equal(input.label,'public15');let response;
   for(let delta=1000;delta<=120000;delta+=1000){response=(await call(input.session,'GET',input.path,{},input.now+delta)).body;if(response.result)break;}
   assert.equal(response.status,'settled');assert.ok(response.result);assert.equal(response.game.resultCommitted,true);
   result=response;
  }else if(input.action==='read04'){
   assert.equal(input.label,'mock04');result=(await call(input.session,'GET','/api/pvp/rooms/'+input.roomId,{},input.time??now+400)).body;
  }else throw Error('Unknown fixture child operation');
  process.stdout.write(JSON.stringify(result));
 }finally{await engines?.closeEnginePool();await db.closePools();}
}

if(process.argv[2]==='--fixture-child')await fixtureChild();
else test('frozen Mock04 → public15 additive schema and real dump/restore; old runtime boundaries remain explicit',{timeout:180000},async t=>{
 const adminURL=localURL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
 const names=[newName(),newName()],urls=names.map(name=>{const u=new URL(adminURL);u.pathname='/'+name;return u;});
 const admin=new pg.Pool({connectionString:adminURL.href,max:1,connectionTimeoutMillis:5000});
 const created=[],pools=[];let localDir,sources,oldShape,oldRows,newShape,input,legacy,snapshot,seqSnapshot,dumpSha;
 const step=async(name,fn)=>{let error;await t.test(name,async()=>{try{await fn();}catch(e){error=e;throw e;}});if(error)throw error;};
 try{
  await step('exact frozen inputs and local PostgreSQL utilities are available (never skipped)',async()=>{
   sources=await verifiedSources({full:true});
   for(const key of ['platform/server/schema.sql','platform/server/wallet/schema.sql','platform/package-lock.json'])assert.equal(sources.mock04.manifest[key],sources.public15.manifest[key]);
   assert.equal(sources.mock04.manifest[SCHEMAS[2]],'41bcb2151c87f031f848593f03430186502adfe32810b6e2a944ee52c176e3ad');
   assert.equal(sources.public15.manifest[SCHEMAS[2]],'eb7a9ebdf9862f4421af1941199b5ff1f07ec3fb646e03042fd4da1bae49817f');
   const server=Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
   for(const tool of ['pg_dump','pg_restore']){const v=(await run(tool,['--version'])).out;assert.match(v,/PostgreSQL/);assert.equal(Number(v.match(/PostgreSQL\) (\d+)/)[1]),Math.floor(server/10000),'Matching pg_dump/restore major required');}
   t.diagnostic(JSON.stringify({source_root:relative(ROOT,SOURCES),manifests:PINS,checked_bodies:{mock04:sources.mock04.checked,public15:sources.public15.checked},postgres_major:Math.floor(server/10000)}));
  });
  assert(sources,'Verified fixtures required');
  localDir=await mkdtemp(join(tmpdir(),'oasis-mock-view-migration-'));await chmod(localDir,0o700);
  const privateA=await mkdtemp(join(localDir,'private-a-')),privateB=await mkdtemp(join(localDir,'private-b-'));
  for(let i=0;i<names.length;i++){await admin.query(`CREATE DATABASE ${ident(names[i])}`);created.push(names[i]);pools[i]=new pg.Pool({connectionString:urls[i].href,max:2});assert.equal((await pools[i].query('SELECT current_database() name')).rows[0].name,names[i]);}
  const [a,b]=pools;
  await step('04 schema contains nonempty platform users, balanced sandbox wallet and real legacy Run room',async()=>{
   await applySchemas(a,sources.mock04);legacy=await childCall('mock04',urls[0],privateA,{action:'seed04'});
   oldShape=await schema(a);oldRows=await rows(a,oldShape);
   assert.equal(oldShape.tables.pvp_run_input_decisions,undefined);assert(!oldShape.tables.pvp_rooms.columns.some(c=>c.column_name==='run_input_state'));
   for(const table of ['gp_players','gp_player_app_ids','gp_sessions','gp_keys','wallet_users','wallet_ledger','pvp_rooms','pvp_requests'])assert(oldRows[table].count>0,table+' must not be empty');
   assert.equal((await a.query('SELECT sum(delta_available+delta_reserved)::text n FROM wallet_ledger')).rows[0].n,'0');
   assert.equal((await a.query("SELECT available FROM wallet_users WHERE external_user_id='human'")).rows[0].available,'12345');
  });
  await step('15 adds only nullable run_input_state plus decision table; every old-column row digest stays identical',async()=>{
   assert(oldShape&&oldRows);await applySchemas(a,sources.public15);newShape=await schema(a);
   assert.deepEqual(Object.keys(newShape.tables).filter(name=>!oldShape.tables[name]),['pvp_run_input_decisions']);
   const comparable=structuredClone(newShape);delete comparable.tables.pvp_run_input_decisions;
   const added=comparable.tables.pvp_rooms.columns.filter(c=>!oldShape.tables.pvp_rooms.columns.some(v=>v.column_name===c.column_name));
   assert.deepEqual(added,[{column_name:'run_input_state',data_type:'jsonb',udt_name:'jsonb',is_nullable:'YES',column_default:null,is_identity:'NO',identity_generation:null,is_generated:'NEVER',generation_expression:null}]);
   comparable.tables.pvp_rooms.columns=comparable.tables.pvp_rooms.columns.filter(c=>c.column_name!=='run_input_state');assert.deepEqual(comparable,oldShape);
   const decision=newShape.tables.pvp_run_input_decisions;
   assert.deepEqual(decision.columns.map(c=>[c.column_name,c.data_type,c.is_nullable]),[['room_id','text','NO'],['external_user_id','text','NO'],['command_seq','bigint','NO'],['decision','jsonb','NO'],['created_at','timestamp with time zone','NO']]);
   assert.deepEqual(decision.constraints.map(c=>[c.contype,c.definition]).sort(),[['c','CHECK ((command_seq > 0))'],['f','FOREIGN KEY (room_id) REFERENCES pvp_rooms(id) ON DELETE CASCADE'],['p','PRIMARY KEY (room_id, external_user_id, command_seq)']].sort());
   assert.equal((await a.query('SELECT count(*)::int n FROM pvp_rooms WHERE run_input_state IS NOT NULL')).rows[0].n,0);
   assert.deepEqual(await rows(a,oldShape),oldRows);
   await applySchemas(a,sources.public15);assert.deepEqual(await schema(a),newShape);assert.deepEqual(await rows(a,oldShape),oldRows);
  });
  await step('real frozen15 route atomically creates private history, accepted/rejected decisions and exact HTTP receipt',async()=>{
   assert(newShape);input=await childCall('public15',urls[0],privateA,{action:'create15'});
   const room=(await a.query('SELECT run_input_state,rule_version FROM pvp_rooms WHERE id=$1',[input.body.roomId])).rows[0];
   assert.equal(room.rule_version,'pvp-run-v2.3.0');assert.equal(room.run_input_state.durableThrough,2);assert.equal(room.run_input_state.lastCommandSeq,2);assert.ok(room.run_input_state.anchor);assert.ok(room.run_input_state.current);
   const decisions=(await a.query('SELECT command_seq,decision FROM pvp_run_input_decisions WHERE room_id=$1 ORDER BY command_seq',[input.body.roomId])).rows;
   assert.deepEqual(decisions.map(r=>r.command_seq),['1','2']);assert.deepEqual(decisions.map(r=>r.decision.outcome),['accepted','rejected']);
   const receipt=(await a.query('SELECT response,response_status FROM pvp_requests WHERE app_id=$1 AND external_user_id=$2 AND request_id=$3',[input.session.app_id,input.session.external_user_id,input.body.request_id])).rows[0];
   assert.equal(receipt.response_status,200);assert.deepEqual(receipt.response,input.response.body);
   snapshot=await rows(a,newShape);seqSnapshot=await sequences(a,newShape);
  });
  await step('actual pg_dump custom + pg_restore preserves every table, sequence and separately copied private key',async()=>{
   assert(input&&snapshot);const file=join(localDir,'owned-database.dump');await writeFile(file,'',{mode:0o600,flag:'wx'});
   await run('pg_dump',['--format=custom','--no-owner','--no-privileges','--file',file],{env:pgEnvironment(urls[0])});
   const info=await lstat(file);assert(info.size>0);assert.equal(info.mode&0o777,0o600);dumpSha=sha(await readFile(file));
   await run('pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-privileges','--dbname',names[1],file],{env:pgEnvironment(urls[1])});
   assert.deepEqual(await schema(b),newShape);assert.deepEqual(await rows(b,newShape),snapshot);assert.deepEqual(await sequences(b,newShape),seqSnapshot);
   const key=await readFile(join(privateA,'master.key'));assert.equal(key.length,32);await writeFile(join(privateB,'master.key'),key,{mode:0o600,flag:'wx'});assert.deepEqual(await readFile(join(privateB,'master.key')),key);
   t.diagnostic(JSON.stringify({dump_bytes:info.size,dump_sha256:dumpSha,tables:Object.keys(snapshot).length,old_projection_preserved:true,private_key:'synthetic fixture key copied separately; not logged'}));
  });
  await step('restored real route replays the original lost ACK byte-equivalent JSON without new command or row mutation',async()=>{
   assert(dumpSha);const replay=await childCall('public15',urls[1],privateB,{action:'replay15',...input});
   assert.deepEqual(replay,input.response);assert.deepEqual(await rows(b,newShape),snapshot);assert.deepEqual(await sequences(b,newShape),seqSnapshot);
  });
  await step('reapplying04 SQL preserves new schema/history/decisions/receipts; legacy terminal room still reads',async()=>{
   await applySchemas(b,sources.mock04);assert.deepEqual(await schema(b),newShape);assert.deepEqual(await rows(b,newShape),snapshot);
   const result=await childCall('mock04',urls[1],privateB,{action:'read04',session:legacy.legacy,roomId:legacy.roomId});
   assert.equal(result.id,legacy.roomId);assert.equal(result.status,'cancelled');assert.equal(result.game.ruleVersion,'pvp-run-v2.2.0');assert.equal(result.seed_commitment,legacy.seedCommitment);
   assert.deepEqual(await rows(b,newShape),snapshot);
  });
  await step('15 can settle restored V2.3; 04 reads committed result but explicitly has no V2.3 game view',async()=>{
   const terminal=await childCall('public15',urls[1],privateB,{action:'settle15',...input});
   const before=await rows(b,newShape),old=await childCall('mock04',urls[1],privateB,{action:'read04',session:input.session,roomId:input.body.roomId,time:input.now+121000});
   assert.equal(old.status,'settled');assert.deepEqual(old.result,terminal.result);assert.equal(old.game,null);assert.equal(old.run_inputs,undefined);
   assert.deepEqual(await rows(b,newShape),before);assert.equal((await b.query('SELECT count(*)::int n FROM pvp_active_users WHERE room_id=$1',[input.body.roomId])).rows[0].n,0);
  });
  await step('negative rollback boundary:04 cannot advance active V2.3, while private history/decisions stay intact',async()=>{
   const history=(await a.query('SELECT run_input_state FROM pvp_rooms WHERE id=$1',[input.body.roomId])).rows[0].run_input_state;
   const old=await childCall('mock04',urls[0],privateA,{action:'read04',session:input.session,roomId:input.body.roomId,time:input.now+400});
   assert.equal(old.status,'fault');assert.equal(old.error.code,'PINNED_RULE_UNAVAILABLE');assert.equal(old.game,null);
   assert.deepEqual((await a.query('SELECT run_input_state FROM pvp_rooms WHERE id=$1',[input.body.roomId])).rows[0].run_input_state,history);
   assert.equal((await a.query('SELECT count(*)::int n FROM pvp_run_input_decisions WHERE room_id=$1',[input.body.roomId])).rows[0].n,2);
   t.diagnostic('Scope: real routePvp + PostgreSQL/schema/dump/restore. No HTTP auth, old/new browser UI, live Mock DB, admission controller or production rollback validated. Active V2.3 rollback is forbidden; committed result API readability is not podium UI compatibility.');
  });
 }finally{
  const failures=[];for(const pool of pools)try{await pool.end();}catch(e){failures.push(e);}
  for(const name of created)try{await dropOwnedTestDatabase(admin,name,{created:true});t.diagnostic(`Owned database removed: ${name}`);}catch(e){failures.push(e);}
  await admin.end();if(localDir)await rm(localDir,{recursive:true,force:true});if(failures.length)throw new AggregateError(failures,'Owned fixture cleanup failed');
 }
});
