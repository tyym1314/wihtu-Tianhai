/** Real HTTP/PG policy check; run only inside profile-mobile-isolated.mjs. No browser. */
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
const [harnessPath,outputPath]=process.argv.slice(2);
assert(harnessPath&&outputPath,'usage: node tests/tower-practice-start-http.mjs <active-harness.json> <new-report.json>');
try{await lstat(outputPath);throw Error('OUTPUT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
const harness=JSON.parse(await readFile(harnessPath,'utf8')),origin=process.env.OASIS_PROFILE_ORIGIN;
assert.equal(origin,harness.origin);assert.equal(new URL(origin).hostname,'localhost');
assert.match(harness.isolation.database,/^oasis_release_test_[0-9]+_[a-f0-9]{12}$/);
const url=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));url.pathname='/'+harness.isolation.database;
const db=new pg.Pool({connectionString:url.href,max:2}),sleep=ms=>new Promise(r=>setTimeout(r,ms)),rid=()=>randomUUID().replaceAll('-','');
const report={schema_version:'tower-practice-start-http-v1',started_at:new Date().toISOString(),browser_started:false,physical_device:false,performance_acceptance:false,cases:[],requests:[],cleanup:[],source_sha256:{}};
const rooms=[];
async function api(token,method,path,body,expected){
 const response=await fetch(origin+path,{method,headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)}),json=await response.json();
 report.requests.push({method,path,status:response.status,error:json.error?.code??null});
 if(expected!==undefined)assert.equal(response.status,expected,JSON.stringify(json));else assert(response.ok,JSON.stringify(json));
 return json;
}
async function auth(){
 const response=await fetch(origin+'/api/demo/config'),config=await response.json(),cookie=response.headers.get('set-cookie')?.split(';')[0];assert(response.ok&&cookie&&config.csrf);
 const launched=await fetch(origin+'/api/demo/launch',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-host-csrf':config.csrf},body:JSON.stringify({game_id:'towerlink',request_id:rid()})}),ticket=await launched.json();assert(launched.ok,JSON.stringify(ticket));
 return(await api(null,'POST','/v1/launch/exchange',{game_id:'towerlink',launch_code:ticket.launch_code,client_instance_id:rid(),host_origin:origin})).access_token;
}
const read=async id=>(await db.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
async function mutateFixture(id,change){
 const client=await db.connect();try{await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['pvp:'+id]);const row=(await client.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];assert.equal(row.status,'waiting');await change(client,row);}finally{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['pvp:'+id]);client.release();}
}
async function waitActive(token,id){
 const until=Date.now()+5000;while(Date.now()<until){const room=await api(token,'GET','/api/pvp/rooms/'+id);if(room.status==='active')return room;assert.equal(room.status,'funding');await sleep(40);}throw Error('START_TIMEOUT');
}
async function leave(row){
 if(row.left)return;const result=await api(row.token,'POST','/api/pvp/rooms/'+row.id+'/leave',{request_id:rid()});assert(['cancelled','settled','voided'].includes(result.status));row.left=true;report.cleanup.push({room_id:row.id,status:result.status});
}
try{
 assert.equal((await db.query('SELECT current_database() n')).rows[0].n,harness.isolation.database);
 for(const path of['server/pvp/index.mjs','server/pvp/tower-start-policy.mjs','arena/towerlink/engine.mjs'])report.source_sha256[path]=createHash('sha256').update(await readFile(resolve(path))).digest('hex');
 const token=await auth();assert(token);
 for(const kind of['new-practice','old-waiting','old-funding','unknown-stored-policy']){
  const create={request_id:rid(),game_id:'towerlink',capacity:2,practice:true,entry_minor:'0',start_delay_ms:0,game_options:{start_policy:'attacker',start_delay_ms:0}},created=await api(token,'POST','/api/pvp/rooms',create,201),tracked={token,id:created.id,left:false};rooms.push(tracked);
  const original=await read(created.id);assert.deepEqual(original.game_options,{start_policy:'towerlink-practice-start-v1',start_delay_ms:1000});
  if(kind!=='new-practice')await mutateFixture(created.id,async(client,row)=>{
   const options=kind==='unknown-stored-policy'?{start_policy:'towerlink-practice-start-future',start_delay_ms:1000}:{};
   if(kind==='old-funding'){for(const p of row.players)p.ready=true;await client.query("UPDATE pvp_rooms SET game_options=$2,status='funding',players=$3 WHERE id=$1",[created.id,options,JSON.stringify(row.players)]);}
   else await client.query('UPDATE pvp_rooms SET game_options=$2 WHERE id=$1',[created.id,options]);
  });
  if(kind!=='old-funding')await api(token,'POST','/api/pvp/rooms/'+created.id+'/ready',{request_id:rid()});
  const room=await waitActive(token,created.id),stored=await read(created.id),startReference=stored.players.find(p=>p.bot).last_seen_at,expectedDelay=kind==='new-practice'?1000:3000;
  assert.equal(Number(stored.starts_at)-startReference,expectedDelay);assert.equal(room.game.startedAt,room.starts_at);assert.equal(room.end_at-room.starts_at,180000);assert(room.server_now<room.starts_at);assert.deepEqual(room.game.legalActions,[]);
  const own=room.game.towers.find(t=>room.game.owners[t.id]===room.me),early=await api(token,'POST','/api/pvp/rooms/'+created.id+'/action',{request_id:rid(),seq:1,action:{type:'upgrade',towerId:own?.id??0}},409);assert.equal(early.error?.code,'GAME_NOT_STARTED');
  const replay=await api(token,'POST','/api/pvp/rooms',create,201);assert.deepEqual(replay,created);assert.deepEqual((await read(created.id)).game_options,stored.game_options);
  await sleep(Math.max(0,room.starts_at-Date.now()+100));
  let begun;for(let n=0;n<20;n++){begun=await api(token,'GET','/api/pvp/rooms/'+created.id);if(begun.game.legalActions.length)break;await sleep(30);}assert(begun.game.legalActions.length);
  const move=begun.game.legalActions.find(a=>a.type==='link');assert(move);
  const accepted=await api(token,'POST','/api/pvp/rooms/'+created.id+'/action',{request_id:rid(),seq:1,action:move});assert.equal(accepted.me_last_seq,1);
  const reread=await api(token,'GET','/api/pvp/rooms/'+created.id);assert.equal(reread.starts_at,room.starts_at);assert.equal(reread.end_at,room.end_at);
  report.cases.push({kind,room_id:created.id,delay_ms:expectedDelay,start_reference_ms:startReference,starts_at:room.starts_at,end_at:room.end_at,stored_options:stored.game_options,client_policy_ignored:true,early_rejection:early.error.code,accepted_sequence:accepted.me_last_seq,create_replay_preserved:true,active_start_preserved:true});
  await leave(tracked);
 }
 const counts=await db.query('SELECT (SELECT count(*)::int FROM wallet_operations) wallet_operations,(SELECT count(*)::int FROM pvp_operations) pvp_operations,(SELECT count(*)::int FROM pvp_active_users) active_users');report.final_counts=counts.rows[0];assert.deepEqual(report.final_counts,{wallet_operations:0,pvp_operations:0,active_users:0});report.completed=true;
}catch(error){report.completed=false;report.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
finally{
 for(const room of rooms)if(!room.left)try{await leave(room);}catch(error){report.cleanup.push({room_id:room.id,error:error.message});process.exitCode=1;}
 await db.end();report.finished_at=new Date().toISOString();await writeFile(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({completed:report.completed,cases:report.cases.map(c=>({kind:c.kind,delay_ms:c.delay_ms})),cleanup:report.cleanup,failure:report.failure}));
}
