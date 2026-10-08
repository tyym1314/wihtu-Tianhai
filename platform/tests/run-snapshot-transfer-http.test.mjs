/** Real API process and authentication over loopback, with a fresh owned DB.
 * Fixture tokens are inserted only in that DB; this does not test launch/UI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {createSnapshotTransfer} from '../arena/shared/snapshot-transfer.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex'),uid=()=>randomBytes(12).toString('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('Run negotiated GETs preserve authentication, current outer fields and exact POST receipt/replay over real HTTP',async()=>{
 const root=resolve(import.meta.dirname,'..'),adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
 assert(['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname));adminUrl.pathname='/postgres';
 const name=`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`,url=new URL(adminUrl);url.pathname='/'+name;
 const admin=new pg.Pool({connectionString:adminUrl.href,max:1});let created=false,dir,db,child,lock,roomId,logs='';
 const out=resolve(root,'review/run-snapshot-transfer',new Date().toISOString().replaceAll(':','-')+'-'+uid());
 const report={schema:'run-snapshot-transfer-http-v1',scope:'Real isolated loopback API+PostgreSQL/authentication and current Run v2.2 practice room. Fixture tokens bypass launch only. Byte figures are actual HTTP JSON plus local gzip re-encoding, not captured gzip transport, Android 05 bodies or latency acceptance.',checks:[],requests:[],sizes:[],cleanup:{},source_sha256:{}};
 const port=await freePort(),origin='http://127.0.0.1:'+port,requestIds=new Set(),entryRequestIds=new Set(),privateValues=[];
 async function request(path,{token,body,runKey,expected=200}={}){
  const method=body===undefined?'GET':'POST',response=await fetch(origin+path,{method,headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(runKey?{'X-Oasis-Known-Run-Game':runKey}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)}),raw=await response.text(),value=JSON.parse(raw);
  const timing=response.headers.get('server-timing'),requestId=response.headers.get('x-oasis-request-id');
  const roomRead=method==='GET'&&/^\/api\/pvp\/rooms\/[A-Za-z0-9_-]+$/.test(path);
  const entryWrite=method==='POST'&&path==='/api/pvp/rooms';
  if(roomRead||entryWrite){
   assert.match(timing,/^app;dur=\d+\.\d{3}$/);assert.match(requestId,/^[a-f0-9]{32}$/);assert(!requestIds.has(requestId)&&!entryRequestIds.has(requestId));
   (roomRead?requestIds:entryRequestIds).add(requestId);
  }else{assert.equal(timing,null);assert.equal(requestId,null);}
  report.requests.push({method,path:path.replace(/rooms\/[^/]+/,'rooms/[owned]'),status:response.status,omitted:value.run_game_transfer?.omitted??null,timing,request_id:requestId});
  assert.equal(response.status,expected,JSON.stringify(value));return{value,raw,headers:response.headers};
 }
 async function token(app,player){const value=randomBytes(32).toString('base64url');await db.query("INSERT INTO gp_sessions(id,app_id,external_user_id,game_id,token_hash,token_expires_at,host_origin) VALUES($1,$2,$3,'run',$4,now()+interval '15 minutes',$5)",[uid(),app,player,hash(value),origin]);return value;}
 async function freeze(){lock=await db.connect();await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['pvp:'+roomId]);}
 async function unfreeze(){if(!lock)return;await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['pvp:'+roomId]);lock.release();lock=null;}
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;dir=await mkdtemp(join(tmpdir(),'oasis-run-transfer-'));db=new pg.Pool({connectionString:url.href,max:3});
  child=spawn(process.execPath,['--import','tsx','server/index.mjs'],{cwd:root,env:{...process.env,OASIS_ENVIRONMENT:'sandbox',OASIS_DATABASE_URL:url.href,OASIS_LOCAL_DIR:dir,OASIS_API_PORT:String(port),OASIS_START_WALLET:'0',OASIS_PUBLIC_ORIGIN:origin,OASIS_REFERENCE_WALLET_URL:origin+'/fixture-wallet-unused',OASIS_ROOM_TIMING_FILE:join(dir,'room-timing.ndjson')},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);let ready=false;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Fixture server exited: '+logs);try{const r=await fetch(origin+'/health',{signal:AbortSignal.timeout(250)});if(r.ok){ready=true;break;}}catch{}await pause(50);}assert(ready,logs);
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name,name);
  const apps=(await db.query('SELECT id FROM gp_apps ORDER BY id')).rows;assert(apps.length>=2);
  const own=await token(apps[0].id,'run_transfer_human'),outsider=await token(apps[0].id,'run_transfer_outsider'),foreign=await token(apps[1].id,'run_transfer_human');
  privateValues.push(own,outsider,foreign,'run_transfer_human','run_transfer_outsider',url.href);
  const create={request_id:uid(),game_id:'run',capacity:2,practice:true};const made=await request('/api/pvp/rooms',{token:own,body:create,runKey:'full',expected:201});roomId=made.value.id;
  privateValues.push(roomId);
  assert.equal(made.value.run_game_transfer,undefined);
  const path='/api/pvp/rooms/'+roomId,readied=await request(path+'/ready',{token:own,body:{request_id:uid()},runKey:'full'});assert.equal(readied.value.game.phase,'arming');assert.equal(readied.value.game.ruleVersion,'pvp-run-v2.2.0');assert.equal(readied.value.run_game_transfer,undefined);
  await freeze();
  const legacy=await request(path,{token:own}),first=await request(path,{token:own,runKey:'full'}),key=first.value.run_game_transfer.key;
  assert.equal(legacy.value.run_game_transfer,undefined);assert.deepEqual(legacy.value.game,first.value.game);assert.equal(first.value.run_game_transfer.omitted,false);
  const cache=createSnapshotTransfer();await cache.restoreRun(cache.begin(path,true),first.value);
  await pause(5);const compact=await request(path,{token:own,runKey:key});assert.equal(Object.hasOwn(compact.value,'game'),false);assert.equal(compact.value.run_game_transfer.omitted,true);assert(compact.value.server_now>first.value.server_now);
  assert.deepEqual((await cache.restoreRun(cache.begin(path,true),compact.value)).game,legacy.value.game);
  assert.equal(compact.headers.get('cache-control'),'no-store');assert.equal((await request(path,{token:own})).value.run_game_transfer,undefined);
  for(const sample of [['arming-legacy',legacy],['arming-full',first],['arming-omitted',compact]])report.sizes.push({sample:sample[0],json_bytes:Buffer.byteLength(sample[1].raw),gzip_bytes:gzipSync(sample[1].raw).length});
  assert(Buffer.byteLength(compact.raw)<Buffer.byteLength(first.raw)*.65);
  assert(gzipSync(compact.raw).length<gzipSync(first.raw).length*.75);
  report.checks.push('legacy full, exact repeated game omitted, fresh outer time, no-store, exact client restoration');
  await request(path,{runKey:key,expected:401});await request(path,{token:outsider,runKey:key,expected:403});await request(path,{token:foreign,runKey:key,expected:404});
  report.checks.push('hint grants no authentication, room membership or cross-app access');
  // An impossible-to-trust version-only cache is attacked with an explicit
  // same-version DB fixture mutation while owning the room advisory lock.
  const before=(await lock.query('SELECT version,game_state FROM pvp_rooms WHERE id=$1',[roomId])).rows[0],changed=structuredClone(before.game_state);changed.players[0].claimedItems=['fixture_changed_same_version'];
  await lock.query('UPDATE pvp_rooms SET game_state=$2 WHERE id=$1',[roomId,changed]);
  const changedResponse=await request(path,{token:own,runKey:key});assert.equal(changedResponse.value.version,Number(before.version));assert.equal(changedResponse.value.run_game_transfer.omitted,false);assert.notEqual(changedResponse.value.run_game_transfer.key,key);
  assert.deepEqual((await cache.restoreRun(cache.begin(path,true),changedResponse.value)).game,changedResponse.value.game);
  await lock.query('UPDATE pvp_rooms SET game_state=$2 WHERE id=$1',[roomId,before.game_state]);report.checks.push('same version changed game is complete and independently hashed');
  await unfreeze();
  const started=await request(path+'/scene-ready',{token:own,body:{request_id:uid()},runKey:key});assert.equal(started.value.game.phase,'racing');assert.equal(started.value.run_game_transfer,undefined);
  const action={request_id:uid(),seq:1,action:{type:'jump'}},accepted=await request(path+'/action',{token:own,body:action,runKey:key});assert(accepted.value.game);assert.equal(accepted.value.run_game_transfer,undefined);assert.equal(accepted.value.action_receipt.request_id,action.request_id);
  const replay=await request(path+'/action',{token:own,body:action,runKey:key});assert.deepEqual(replay.value,accepted.value);
  assert.equal(Number((await db.query('SELECT count(*) n FROM pvp_actions WHERE room_id=$1',[roomId])).rows[0].n),1);
  const after=await request(path,{token:own,runKey:key});assert(after.value.game);assert.equal(after.value.run_game_transfer.omitted,false);assert.equal(after.value.action_receipt,undefined);
  report.checks.push('POST stays full, raw action receipt exact and replay identical; old GET key invalidated; GET has no action receipt');
  await freeze();
  const racingLegacy=await request(path,{token:own}),racingFull=await request(path,{token:own,runKey:'full'}),racingOmitted=await request(path,{token:own,runKey:racingFull.value.run_game_transfer.key});
  assert.equal(racingFull.value.game.phase,'racing');assert.deepEqual(racingFull.value.game,racingLegacy.value.game);assert.equal(racingOmitted.value.run_game_transfer.omitted,true);
  const racingCache=createSnapshotTransfer();await racingCache.restoreRun(racingCache.begin(path,true),racingFull.value);assert.deepEqual((await racingCache.restoreRun(racingCache.begin(path,true),racingOmitted.value)).game,racingLegacy.value.game);
  for(const sample of [['racing-legacy',racingLegacy],['racing-full',racingFull],['racing-omitted',racingOmitted]])report.sizes.push({sample:sample[0],json_bytes:Buffer.byteLength(sample[1].raw),gzip_bytes:gzipSync(sample[1].raw).length});
  assert(gzipSync(racingOmitted.raw).length<gzipSync(racingLegacy.raw).length*.75);
  await unfreeze();report.checks.push('racing snapshot after accepted input: exact restoration with full/legacy/omitted byte comparison');
  await request(path+'/leave',{token:own,body:{request_id:uid()}});
  assert.equal(Number((await db.query('SELECT count(*) n FROM pvp_active_users')).rows[0].n),0);report.cleanup.active_users=0;
  assert.equal(Number((await db.query('SELECT count(*) n FROM pvp_operations')).rows[0].n),0);report.cleanup.wallet_operations=0;
  report.passed=true;
 }catch(error){report.passed=false;report.failure={name:error.name,message:error.message};throw error;}
 finally{
  const errors=[];try{await unfreeze();}catch(e){errors.push(e.message);}
  try{if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);await done;clearTimeout(timeout);}report.cleanup.child_stopped=true;}catch(e){errors.push(e.message);}
  try{if(report.passed){
   assert.equal(child.exitCode,0,'API must finish its SIGTERM handler');assert.equal(child.signalCode,null,'SIGKILL fallback is not a clean diagnostic shutdown');
   const closed=logs.split('\n').filter(line=>line.startsWith('{')).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(row=>row?.event==='oasis.room_timing.closed');
   assert.equal(closed.length,1);assert.equal(closed[0].state,'closed');assert.equal(closed[0].incomplete,false);
   const raw=await readFile(join(dir,'room-timing.ndjson'),'utf8'),rows=raw.trim().split('\n').map(line=>JSON.parse(line)),requests=rows.filter(row=>row.kind==='request');
   assert.equal(rows[0].kind,'start');assert.equal(rows.at(-1).kind,'end');assert.equal(rows.at(-1).complete,true);
   assert.equal(closed[0].boot_id,rows[0].boot_id);assert.equal(closed[0].pid,rows[0].pid);assert.equal(rows[0].pid,child.pid);
   assert(privateValues.every(value=>!raw.includes(value)),'Timing file must exclude tokens, room/player identity and DB connection');
   assert.deepEqual(new Set(requests.map(row=>row.request_id)),requestIds);
   assert.equal(entryRequestIds.size,1);assert([...entryRequestIds].every(value=>!raw.includes(value)),'Header-only entry timing must not expand room trace logs');
   for(const requestId of requestIds){
    const phases=requests.filter(row=>row.request_id===requestId),expected=report.requests.find(row=>row.request_id===requestId);
    assert.deepEqual(phases.map(row=>row.phase),['entry','headers','finish']);
    assert.equal(phases[2].status,expected.status);
    assert(phases.every(row=>Number.isFinite(row.epoch_ms)&&Number.isFinite(row.mono_ms)));
    assert(phases[0].mono_ms<=phases[1].mono_ms&&phases[1].mono_ms<=phases[2].mono_ms);
    assert(Math.abs(phases[1].app_ms-(phases[1].mono_ms-phases[0].mono_ms))<.001);
   }
   await mkdir(out,{recursive:true});await writeFile(join(out,'server-timing.ndjson'),raw,{flag:'wx',mode:0o600});
   assert.equal(closed[0].confirmed_written_bytes,Buffer.byteLength(raw));assert.equal(closed[0].confirmed_written_records,rows.length);
   report.timing={rid_joins:requestIds.size,request_phases:requests.length,complete:true,close_result:closed[0],graceful_exit:child.exitCode,private_values_absent:true,bytes:Buffer.byteLength(raw),sha256:hash(raw)};
  }}catch(e){errors.push('Timing verification: '+e.message);}
  try{await db?.end();if(created){await dropOwnedTestDatabase(admin,name,{created});report.cleanup.database_dropped=true;}}catch(e){errors.push(e.message);}finally{await admin.end();}
  try{if(dir){await rm(dir,{recursive:true,force:true});report.cleanup.private_removed=true;}}catch(e){errors.push(e.message);}
  for(const file of ['shared/run-snapshot-transfer.mjs','arena/shared/snapshot-transfer.mjs','arena/shared/client.mjs','server/pvp/snapshot-transfer.mjs','server/index.mjs'])report.source_sha256[file]=hash(await readFile(resolve(root,file)));
  report.cleanup.errors=errors;report.finished_at=new Date().toISOString();if(errors.length)report.passed=false;
  await mkdir(out,{recursive:true});await writeFile(join(out,'http.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({report:join(out,'http.json'),passed:report.passed,sizes:report.sizes,cleanup:report.cleanup}));
  assert.deepEqual(errors,[],'Owned HTTP fixture cleanup');
 }
});
