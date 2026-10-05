import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {RELEASED_IDS} from '../shared/games.mjs';
import {sign,id,hash} from '../server/security.mjs';
import {gzipSync} from 'node:zlib';
const api='http://127.0.0.1:18997',wallet='http://127.0.0.1:18998',proxyURL='http://127.0.0.1:18999';
const root=resolve(import.meta.dirname,'..'),dir=resolve(root,'.local/backend-test-'+Date.now());
const dbname='oasis_test_'+process.pid+'_'+Date.now(),admin=new pg.Pool({connectionString:'postgres://oasis_local@127.0.0.1:5487/postgres'});
let db,child,apps,cookie,logs='',dropSettles=false,proxy,completed=[],created=false;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){child=spawn(process.execPath,['--import','tsx','server/index.mjs'],{cwd:root,env:{...process.env,OASIS_DATABASE_URL:`postgres://oasis_local@127.0.0.1:5487/${dbname}`,OASIS_API_PORT:'18997',OASIS_WALLET_PORT:'18998',OASIS_REFERENCE_WALLET_URL:wallet,OASIS_WALLET_ALLOWED_ORIGINS:proxyURL,OASIS_LOCAL_DIR:dir,OASIS_PUBLIC_ORIGIN:api},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<100;i++){try{const r=await fetch(api+'/health');if(r.ok)return;}catch{}if(child.exitCode!==null)throw Error(logs);await delay(100);}throw Error('Backend did not start: '+logs);}
async function stop(){if(child&&child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await ended;}}
async function request(path,body,headers={},method=body===undefined?'GET':'POST'){const r=await fetch(api+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),origin:api,...headers},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();return {status:r.status,data,headers:r.headers};}
const s=a=>({partner_id:a.partner_id,app_id:a.id,environment:a.environment,wallet_scope_id:a.wallet_scope_id,currency_id:a.currency_id});
async function partner(item,path,body,overrides={}){const raw=body===undefined?'':JSON.stringify(body),method=body===undefined?'GET':'POST',request_id=body?.request_id||id('query'),headers=sign({...item.credentials,path,raw,method,request_id,...overrides});const r=await fetch(api+path,{method,headers,body:raw||undefined});return {status:r.status,data:await r.json(),headers};}
async function launch(item,game='tiger',extra={}){const body={...s(item.app),request_id:id('launch'),external_user_id:'demo_player',game_id:game,locale:'en',host_platform:'web',...extra};const r=await partner(item,'/v1/sessions',body);assert.equal(r.status,201,JSON.stringify(r.data));const x=await request('/v1/launch/exchange',{launch_code:r.data.launch_code,client_instance_id:id('client')});assert.equal(x.status,200,JSON.stringify(x.data));return {create:r.data,token:x.data.access_token,session_id:x.data.session_id,body};}
const play=(l,game,path,body)=>request(`/api/play/${game}/${path}`,body,{authorization:'Bearer '+l.token});
before(async()=>{
  mkdirSync(dir,{recursive:true,mode:0o700});await admin.query(`CREATE DATABASE ${dbname}`);created=true;db=new pg.Pool({connectionString:`postgres://oasis_local@127.0.0.1:5487/${dbname}`});
  proxy=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);if(dropSettles&&req.method==='GET'&&req.url.startsWith('/wallet/v1/operations/')){res.destroy();return;}const r=await fetch(wallet+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:raw});const text=await r.text();if(dropSettles&&req.url.endsWith('/probability/settle')){res.destroy();return;}res.writeHead(r.status,{'content-type':'application/json'});res.end(text);}catch{res.destroy();}});await new Promise(r=>proxy.listen(18999,'127.0.0.1',r));
  await start();apps=JSON.parse(readFileSync(dir+'/sandbox-app-credentials.json'));const creds=JSON.parse(readFileSync(dir+'/development-credentials.json'));const r=await request('/api/admin/login',creds);assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];
});
after(async()=>{try{await stop();if(proxy?.listening)await new Promise(r=>proxy.close(r));await db?.end();if(created)await dropOwnedTestDatabase(admin,dbname,{created});}finally{await admin.end();}mkdirSync(resolve(root,'review'),{recursive:true});writeFileSync(resolve(root,'review/backend-validation.json'),JSON.stringify({at:new Date().toISOString(),checks:completed,logs,scope:'isolated PostgreSQL database; local HTTP and restart fault injection'},null,2));});
test('admin authentication, CSRF, credential-once creation and persistence',async()=>{
  assert.equal((await request('/api/admin/apps')).status,401);assert.equal((await request('/api/admin/apps',undefined,{cookie})).data.apps.length,2);
  const bad=await fetch(api+'/api/admin/apps',{method:'POST',headers:{cookie,'content-type':'application/json',origin:'https://evil.invalid'},body:'{"name":"bad"}'});assert.equal(bad.status,403);
  const created=await request('/api/admin/apps',{name:'API integration test'},{cookie});assert.equal(created.status,201);assert.ok(created.data.credentials.secret_base64);
  const listing=await request('/api/admin/apps',undefined,{cookie});assert.equal(listing.data.apps.length,3);assert.equal(JSON.stringify(listing.data).includes('secret_base64'),false);
  assert.equal((await request('/api/admin/apps',{name:'production',environment:'production'},{cookie})).status,400);completed.push('admin login/CSRF/persistence/one-time secret');
});
test('HMAC rejects raw-body tampering, nonce replay, expired clocks and cross-App scope',async()=>{
  const a=apps[0],body={...s(a.app),request_id:id('launch'),external_user_id:'demo_player',game_id:'tiger',locale:'en',host_platform:'web'};
  const first=await partner(a,'/v1/sessions',body);assert.equal(first.status,201);
  const replay=await fetch(api+'/v1/sessions',{method:'POST',headers:first.headers,body:JSON.stringify(body)});assert.equal(replay.status,401);
  const same=await partner(a,'/v1/sessions',body);assert.equal(same.data.launch_code,first.data.launch_code);
  assert.equal((await partner(a,'/v1/sessions',{...body,external_user_id:'other'})).status,409);
  assert.equal((await partner(a,'/v1/sessions',{...body,...s(apps[1].app),request_id:id('bad')})).status,403);
  assert.equal((await partner(a,'/v1/sessions',{...body,request_id:id('old')},{timestamp:'1000000000'})).status,401);
  const raw=JSON.stringify({...body,request_id:id('tamper')}),headers=sign({...a.credentials,path:'/v1/sessions',raw,request_id:JSON.parse(raw).request_id});
  assert.equal((await fetch(api+'/v1/sessions',{method:'POST',headers,body:raw+' '})).status,401);completed.push('nine-line HMAC/body/nonce/time/scope/idempotent session');
});
test('launch is atomic one-use, expires, and reauthorization invalidates old token',async()=>{
  const l=await launch(apps[0]);assert.equal((await request('/v1/launch/exchange',{launch_code:l.create.launch_code,client_instance_id:id('client')})).status,401);
  const expired=await partner(apps[0],'/v1/sessions',{...l.body,request_id:id('expired')});await db.query("UPDATE gp_launch_codes SET expires_at=now()-interval '1 second' WHERE code_hash=$1",[hash(expired.data.launch_code)]);assert.equal((await request('/v1/launch/exchange',{launch_code:expired.data.launch_code,client_instance_id:id('client')})).status,401);
  const newer=await launch(apps[0],'tiger',{resume_session_id:l.session_id});assert.equal(newer.session_id,l.session_id);assert.equal((await play(l,'tiger','session')).status,401);assert.equal((await play(newer,'thunder','session')).status,403);
  const foreign=await partner(apps[1],'/v1/sessions',{...s(apps[1].app),request_id:id('foreign'),external_user_id:'demo_player',game_id:'tiger',locale:'en',host_platform:'web',resume_session_id:l.session_id});assert.equal(foreign.status,403);completed.push('single-use/expiry/token rotation/game scope/foreign resume');
});
test('both existing game render contracts settle once across twenty-four concurrent retries',async()=>{
  for(const game of ['tiger','thunder']){
    const l=await launch(apps[0],game),before=(await play(l,game,'session')).data;assert.equal(typeof before.balance,'number');
    const body={requestId:id('spin'),bet:10,expectedVersion:0};const responses=await Promise.all(Array.from({length:24},()=>play(l,game,'spin',body)));for(const r of responses)assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(new Set(responses.map(r=>r.data.round.id)).size,1);
    const cycle=(await db.query('SELECT * FROM gp_cycles WHERE session_id=$1',[l.session_id])).rows[0];assert.equal(cycle.status,'SETTLED');assert.equal(Math.round(responses[0].data.session.balance*100),Math.round(before.balance*100)-1000+Number(cycle.payout_minor));
    assert.equal((await db.query('SELECT count(*)::int n FROM gp_operations WHERE aggregate_id=$1',[cycle.id])).rows[0].n,3);
    assert.equal((await play(l,game,'spin',{...body,bet:50})).status,409);
    await play(l,game,'ack',{roundId:responses[0].data.round.id});await play(l,game,'ack',{roundId:responses[0].data.round.id});
    assert.equal((await play(l,game,'history')).data.rounds.length,1);
    const op='settle_'+cycle.id;assert.equal((await partner(apps[1],'/v1/operations/'+op)).status,404);assert.equal((await partner(apps[0],'/v1/operations/'+op)).data.state,'SUCCEEDED');
  }
  completed.push('Thunder/Tiger 24 concurrent retries, exactly 3 wallet effects, App isolation, ack without money');
});
test('committed settlement with lost response survives process restart and restores same fixed result',async()=>{
  const l=await launch(apps[1]),body={requestId:id('lost'),bet:10,expectedVersion:0};await db.query('UPDATE gp_apps SET wallet_url=$1 WHERE id=$2',[proxyURL,apps[1].app.id]);dropSettles=true;
  const result=await play(l,'tiger','spin',body);assert.equal(result.status,503);
  const prior=(await db.query('SELECT * FROM gp_cycles WHERE session_id=$1',[l.session_id])).rows[0];assert.equal(prior.status,'RESULT_FIXED');assert.ok(prior.result_hash);
  const actual=(await db.query('SELECT state FROM wallet_probability WHERE cycle_id=$1',[prior.id])).rows[0];assert.equal(actual.state,'SETTLED');
  await stop();dropSettles=false;await start();
  const recovered=await play(l,'tiger','session');assert.equal(recovered.status,200,JSON.stringify(recovered.data));assert.equal(recovered.data.pendingRound.cycleId,prior.id);
  const current=(await db.query('SELECT * FROM gp_cycles WHERE id=$1',[prior.id])).rows[0];assert.equal(current.status,'SETTLED');assert.equal(current.result_hash,prior.result_hash);assert.deepEqual(current.result,prior.result);
  assert.equal((await play(l,'tiger','spin',body)).data.round.id,recovered.data.pendingRound.id);
  assert.equal((await db.query('SELECT count(*)::int n FROM wallet_operations WHERE operation_id=$1',['settle_'+prior.id])).rows[0].n,1);completed.push('wallet commit + response loss + process SIGKILL/restart: same result, same receipt, one payout');
});
test('insufficient treasury refuses before RNG; paused App cannot start new cycles',async()=>{
  const l=await launch(apps[1]);await db.query('UPDATE wallet_scopes SET treasury_available=0 WHERE app_id=$1',[apps[1].app.id]);const r=await play(l,'tiger','spin',{requestId:id('capacity'),bet:10,expectedVersion:0});assert.equal(r.status,409,JSON.stringify(r.data));
  const cycle=(await db.query('SELECT * FROM gp_cycles WHERE session_id=$1',[l.session_id])).rows[0];assert.equal(cycle.status,'REJECTED');assert.equal(cycle.seed_enc,null);assert.equal(cycle.result,null);
  await db.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[apps[0].app.id]);const rejected=await partner(apps[0],'/v1/sessions',{...s(apps[0].app),request_id:id('paused'),external_user_id:'demo_player',game_id:'tiger',locale:'en',host_platform:'web'});assert.equal(rejected.status,403);completed.push('capacity rejected before RNG; paused App blocks new sessions');
});

test('Phase D catalog, partner HMAC launch and arena identity cover all seven competitive games',async()=>{
 const games=['carrom','darts','ludo','jackaroo','domino'],item=(await request('/api/admin/apps',{name:'Phase D launch fixture'},{cookie})).data;const catalog=await partner(item,'/v1/games');assert.equal(catalog.status,200);assert.deepEqual(catalog.data.games.filter(g=>g.available).map(g=>g.game_id).sort(),[...RELEASED_IDS].sort());
 for(const game of games){const l=await launch(item,game),context=await request('/api/arena/session',undefined,{authorization:'Bearer '+l.token});assert.equal(context.status,200);assert.equal(context.data.game_id,game);assert.equal(context.data.external_user_id,'demo_player');assert.equal((await play(l,'tiger','session')).status,403);}
 completed.push('Phase D signed catalog retained: current catalogue available, five table-game one-use launches, arena identity and probability boundary');
});
test('Phase D upgrade expands only unchanged default grants and preserves credentials and balances',async()=>{
 const created=await request('/api/admin/apps',{name:'Phase D custom grant'},{cookie}),custom=created.data.app;assert.equal(custom.game_ids.length,RELEASED_IDS.length);
 await db.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[custom.id,JSON.stringify(['thunder','carrom'])]);await db.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[apps[0].app.id,JSON.stringify(['thunder','tiger','match','golf'])]);
 const admins=(await db.query('SELECT * FROM gp_admins ORDER BY id')).rows;const users=(await db.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows;
 await db.query("DELETE FROM gp_migrations WHERE id='arena-phase-d-v1'");await stop();await start();
 assert.deepEqual((await db.query('SELECT game_ids FROM gp_apps WHERE id=$1',[custom.id])).rows[0].game_ids,['thunder','carrom']);assert.equal((await db.query('SELECT game_ids FROM gp_apps WHERE id=$1',[apps[0].app.id])).rows[0].game_ids.length,9);
 assert.deepEqual((await db.query('SELECT * FROM gp_admins ORDER BY id')).rows,admins);assert.deepEqual((await db.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows,users);assert.equal((await request('/api/admin/session',undefined,{cookie})).data.user.id,'admin_local');completed.push('Phase D idempotent migration preserves custom grants, admin hash/session and all wallet balances');
});


test('Phase E catalog and signed launches expose the complete released catalogue with exact supported player modes',async()=>{
 const item=(await request('/api/admin/apps',{name:'Phase E launch fixture'},{cookie})).data;
 const catalog=await partner(item,'/v1/games');assert.equal(catalog.status,200);assert.deepEqual(catalog.data.games.filter(g=>g.available).map(g=>g.game_id).sort(),[...RELEASED_IDS].sort());
 for(const [game,counts]of [['pool',[2]],['bowling',[2,3,4]],['run',[2,3,4]]]){
  const meta=catalog.data.games.find(g=>g.game_id===game);assert.deepEqual(meta.modes[0].player_counts,counts);assert.equal(meta.modes[0].team_size,1);
  const l=await launch(item,game),context=await request('/api/arena/session',undefined,{authorization:'Bearer '+l.token});assert.equal(context.status,200);assert.equal(context.data.game_id,game);assert.equal((await play(l,'tiger','session')).status,403);
 }
 completed.push('Phase E signed catalog, launch exchange and arena identity for pool/bowling/run');
});
test('Phase E migration upgrades only the nine-game default once and preserves admin, sessions and money',async()=>{
 const created=await request('/api/admin/apps',{name:'Phase E custom grant'},{cookie}),custom=created.data.app;
 const previous=['thunder','tiger','match','golf','carrom','darts','ludo','jackaroo','domino'];
 await db.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[custom.id,JSON.stringify(['thunder','pool'])]);
 await db.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[apps[0].app.id,JSON.stringify(previous)]);
 const admins=(await db.query('SELECT * FROM gp_admins ORDER BY id')).rows,users=(await db.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows;
 await db.query("DELETE FROM gp_migrations WHERE id='arena-phase-e-v1'");await stop();await start();
 assert.deepEqual((await db.query('SELECT game_ids FROM gp_apps WHERE id=$1',[custom.id])).rows[0].game_ids,['thunder','pool']);
 assert.deepEqual((await db.query('SELECT game_ids FROM gp_apps WHERE id=$1',[apps[0].app.id])).rows[0].game_ids,[...previous,'pool','bowling','run'],'Phase E must only grant its own three games, never future games');
 assert.deepEqual((await db.query('SELECT * FROM gp_admins ORDER BY id')).rows,admins);assert.deepEqual((await db.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows,users);
 assert.equal((await request('/api/admin/session',undefined,{cookie})).data.user.id,'admin_local');
 const audits=(await db.query("SELECT count(*) FROM gp_audit WHERE action='arena.sports_games_enabled' AND app_id=$1",[apps[0].app.id])).rows[0].count;
 await stop();await start();assert.equal((await db.query("SELECT count(*) FROM gp_audit WHERE action='arena.sports_games_enabled' AND app_id=$1",[apps[0].app.id])).rows[0].count,audits);
 completed.push('Phase E default-grant upgrade is idempotent and retains credentials, session, custom grants and all wallet balances');
});


test('Phase F grants Tower Link only to the unchanged twelve-game sandbox default and is idempotent',async()=>{
 const item=(await request('/api/admin/apps',{name:'Phase F launch fixture'},{cookie})).data;
 const meta=(await partner(item,'/v1/games')).data.games.find(game=>game.game_id==='towerlink');
 assert.ok(meta?.available);assert.ok(meta.modes.every(m=>m.rule_version==='towerlink-v2.2.0'));assert.deepEqual(meta.modes.map(m=>[m.mode_id,m.player_counts]),[['competitive',[2]],['social',[2,3,4]],['practice',[2,3,4]]]);
 const launched=await launch(item,'towerlink');
 const context=await request('/api/arena/session',undefined,{authorization:'Bearer '+launched.token});
 assert.equal(context.status,200);assert.equal(context.data.game_id,'towerlink');
 const custom=(await request('/api/admin/apps',{name:'Phase F custom grant'},{cookie})).data.app;
 const previous=['thunder','tiger','match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run'];
 await db.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[item.app.id,JSON.stringify(previous)]);
 await db.query('UPDATE gp_apps SET game_ids=$2 WHERE id=$1',[custom.id,JSON.stringify(['thunder','pool'])]);
 const admins=(await db.query('SELECT * FROM gp_admins ORDER BY id')).rows;
 const users=(await db.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows;
 await db.query("DELETE FROM gp_migrations WHERE id='arena-phase-f-v1'");await stop();await start();
 assert.deepEqual((await db.query('SELECT game_ids FROM gp_apps WHERE id=$1',[item.app.id])).rows[0].game_ids,[...previous,'towerlink']);
 assert.deepEqual((await db.query('SELECT game_ids FROM gp_apps WHERE id=$1',[custom.id])).rows[0].game_ids,['thunder','pool']);
 assert.deepEqual((await db.query('SELECT * FROM gp_admins ORDER BY id')).rows,admins);
 assert.deepEqual((await db.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows,users);
 assert.equal((await request('/api/admin/session',undefined,{cookie})).data.user.id,'admin_local');
 assert.equal((await request('/api/arena/session',undefined,{authorization:'Bearer '+launched.token})).status,200);
 const audits=(await db.query("SELECT count(*) FROM gp_audit WHERE action='arena.towerlink_enabled' AND app_id=$1",[item.app.id])).rows[0].count;
 assert.equal(audits,'1');await stop();await start();
 assert.equal((await db.query("SELECT count(*) FROM gp_audit WHERE action='arena.towerlink_enabled' AND app_id=$1",[item.app.id])).rows[0].count,audits);
 completed.push('Phase F Tower Link launch and idempotent default-only migration preserve custom grants, admin/session and wallet balances');
});

test('Jackaroo authenticated snapshots omit only an acknowledged unchanged action set and preserve old clients',async()=>{
 const item=(await request('/api/admin/apps',{name:'Snapshot transfer HTTP'},{cookie})).data;
 const launched=await launch(item,'jackaroo'),auth={authorization:'Bearer '+launched.token};let room;
 try{
  const created=await request('/api/pvp/rooms',{request_id:id('delta_create'),game_id:'jackaroo',capacity:4,entry_minor:'0',practice:true},auth);assert.equal(created.status,201);room=created.data;
  assert.equal((await request(`/api/pvp/rooms/${room.id}/ready`,{request_id:id('delta_ready')},auth)).status,200);
  for(let i=0;i<100;i++){room=(await request(`/api/pvp/rooms/${room.id}`,undefined,auth)).data;if(room.status==='active')break;await delay(25);}assert.equal(room.status,'active');
  // Explicit legal complex-midgame fixture in this owned isolated database.
  const stored=(await db.query('SELECT game_state FROM pvp_rooms WHERE id=$1',[room.id])).rows[0].game_state,me=stored.players.find(p=>p.key===room.me),others=stored.players.filter(p=>p!==me);
  const cards=[...stored.deck,...stored.discard,...stored.players.flatMap(p=>p.hand)],sevens=cards.filter(c=>c.rank===7),rest=cards.filter(c=>c.rank!==7);assert.equal(sevens.length,4);
  me.hand=sevens;for(const p of others)p.hand=rest.splice(0,4);stored.deck=rest;stored.discard=[];stored.phase='play';stored.turnKey=me.key;stored.pendingNext=false;stored.passes={};stored.busyUntil=Date.now();stored.now=Date.now();stored.turnDeadlineAt=Date.now()+20000;stored.version++;
  for(const p of stored.players)p.pieces.forEach((piece,i)=>{piece.progress=p===me?i*10:-1;piece.protected=false;});
  await db.query('UPDATE pvp_rooms SET game_state=$2,version=version+1,last_tick_at=$3 WHERE id=$1',[room.id,stored,Date.now()]);
  const path=`/api/pvp/rooms/${room.id}`,full=await request(path,undefined,auth);assert.equal(full.status,200);assert.equal(full.data.game.legalActions.length,3664);assert.match(full.data.legal_actions_key,/^[a-f0-9]{64}$/);
  const hint={'X-Oasis-Known-Actions':full.data.legal_actions_key},compact=await request(path,undefined,{...auth,...hint});assert.equal(compact.status,200);assert.equal(compact.data.game.legalActions,undefined);assert.equal(compact.data.game.legalActionsOmitted,true);assert.equal(compact.data.legal_actions_key,full.data.legal_actions_key);assert(compact.data.server_now>=full.data.server_now);
  const again=await request(path,undefined,auth);assert.deepEqual(again.data.game.legalActions,full.data.game.legalActions);assert.equal((await request(path,undefined,hint)).status,401);
  const outsider=await launch(item,'jackaroo',{external_user_id:'delta_outsider'});assert.equal((await request(path,undefined,{authorization:'Bearer '+outsider.token,...hint})).status,403);
  const command={request_id:id('delta_action'),seq:1,action:full.data.game.legalActions[0]},acted=await request(path+'/action',command,{...auth,...hint});assert.equal(acted.status,200,JSON.stringify(acted.data));assert.equal(acted.data.game.legalActionsOmitted,undefined);assert(Array.isArray(acted.data.game.legalActions));
  assert.deepEqual((await request(path+'/action',command,auth)).data,acted.data);const changed=await request(path,undefined,{...auth,...hint});assert.equal(changed.status,200);assert.equal(changed.data.game.legalActionsOmitted,undefined);assert(Array.isArray(changed.data.game.legalActions));
  const bytes=r=>Buffer.byteLength(JSON.stringify(r)),gzip=r=>gzipSync(JSON.stringify(r)).length;
  mkdirSync(resolve(root,'review/deep-mobile-20260928'),{recursive:true});writeFileSync(resolve(root,'review/deep-mobile-20260928/jackaroo-transfer-http.json'),JSON.stringify({checked_at:new Date().toISOString(),scope:'Real authenticated HTTP over isolated local DB; four-sevens legal midgame fixture. Gzip byte figures are deterministic re-encoding, not captured network wire.',actions:3664,full_json_bytes:bytes(full.data),compact_json_bytes:bytes(compact.data),full_gzip_bytes:gzip(full.data),compact_gzip_bytes:gzip(compact.data),checks:['legacy full response','opt-in unchanged actions omitted','authorization still required','outside-room identity forbidden','fresh clocks','accepted action invalidates key','POST replay unchanged']},null,2));
 }finally{if(room?.id)await request(`/api/pvp/rooms/${room.id}/leave`,{request_id:id('delta_leave')},auth);}
});
test('Tower Link v2.2 authenticated HTTP preserves multiple routes and retries unlink exactly once',async()=>{
 const item=(await request('/api/admin/apps',{name:'Tower multi-route HTTP'},{cookie})).data;
 const launched=await launch(item,'towerlink'),auth={authorization:'Bearer '+launched.token};let room;
 const read=async()=>{const r=await request(`/api/pvp/rooms/${room.id}`,undefined,auth);assert.equal(r.status,200,JSON.stringify(r.data));room=r.data;return room;};
 try{
  const created=await request('/api/pvp/rooms',{request_id:id('multi_create'),game_id:'towerlink',capacity:2,entry_minor:'0',practice:true,training_lesson_id:'lesson-02'},auth);assert.equal(created.status,201,JSON.stringify(created.data));room=created.data;
  const ready=await request(`/api/pvp/rooms/${room.id}/ready`,{request_id:id('multi_ready')},auth);assert.equal(ready.status,200,JSON.stringify(ready.data));
  for(let i=0;i<100;i++){await read();if(room.status==='active'&&room.game?.legalActions.length)break;await delay(100);}
  assert.equal(room.game.ruleVersion,'towerlink-v2.2.0');assert.ok(room.game.legalActions.length);
  const home=room.game.towers.find(t=>room.game.owners[t.id]===room.me),links=room.game.legalActions.filter(a=>a.type==='link'&&a.from===home.id);assert.ok(links.length>=2);
  const command=async(seq,action,retries=1)=>{
   const body={request_id:id('multi_action'),seq,action};
   const replies=await Promise.all(Array.from({length:retries},()=>request(`/api/pvp/rooms/${room.id}/action`,body,auth)));
   for(const r of replies){assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.me_last_seq,seq);assert.deepEqual(r.data,replies[0].data);}return replies[0].data;
  };
  room=await command(1,links[0],3);await delay(175);
  const capped=await request(`/api/pvp/rooms/${room.id}/action`,{request_id:id('route_limit'),seq:2,action:links[1]},auth);assert.equal(capped.status,409,JSON.stringify(capped.data));assert.equal(capped.data.error.code,'ROUTE_LIMIT_REACHED');
  room=await command(2,{type:'upgrade',towerId:home.id},3);
  for(let i=0;i<60;i++){await read();if(room.game.towers.find(t=>t.id===home.id).level===2)break;await delay(100);}
  const upgraded=room.game.towers.find(t=>t.id===home.id);assert.equal(upgraded.level,2);assert.equal(upgraded.routeLimit,2);assert.equal(upgraded.dispatchRate,2);
  room=await command(3,links[1],3);
  assert.deepEqual(room.game.orders.filter(o=>o.from===home.id).map(o=>o.to).sort((a,b)=>a-b),links.slice(0,2).map(o=>o.to).sort((a,b)=>a-b));
  await delay(175);room=await command(4,{type:'unlink',from:home.id,to:links[0].to},3);
  assert.deepEqual(room.game.orders.filter(o=>o.from===home.id).map(o=>o.to),[links[1].to]);
  await read();assert.equal(room.me_last_seq,4);assert.deepEqual(room.game.orders.filter(o=>o.from===home.id).map(o=>o.to),[links[1].to]);
  const bad=await request(`/api/pvp/rooms/${room.id}/action`,{request_id:id('bad_unlink'),seq:5,action:{type:'unlink',from:home.id,to:9999}},auth);assert.equal(bad.status,400,JSON.stringify(bad.data));
  await delay(175);room=await command(5,{type:'stop',towerId:home.id},2);assert.equal(room.game.orders.filter(o=>o.from===home.id).length,0);
  const actions=(await db.query('SELECT seq,action FROM pvp_actions WHERE room_id=$1 ORDER BY seq',[room.id])).rows;
  assert.deepEqual(actions.map(a=>[Number(a.seq),a.action.type]),[[1,'link'],[2,'upgrade'],[3,'link'],[4,'unlink'],[5,'stop']]);
 }finally{
  if(room){const left=await request(`/api/pvp/rooms/${room.id}/leave`,{request_id:id('multi_leave')},auth);assert.equal(left.status,200,JSON.stringify(left.data));assert.equal(left.data.status,'cancelled');}
 }
 assert.equal((await db.query('SELECT count(*)::int n FROM pvp_active_users WHERE app_id=$1',[item.app.id])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM wallet_operations o JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1',[item.app.id])).rows[0].n,0);
 completed.push('Tower Link v2.2 real signed launch/HTTP multi-line add, exact unlink retries, public readback, rejected action seq preservation, stop-all and no wallet effects');
});


test('admin grant and revoke of Tower Link preserve the exact custom list and reject unknown IDs',async()=>{
 const item=(await request('/api/admin/apps',{name:'Admin Tower grant fixture'},{cookie})).data;
 const path=`/api/admin/apps/${item.app.id}`,custom=['golf','domino'];
 const readback=async()=>{
  const listing=await request('/api/admin/apps',undefined,{cookie});assert.equal(listing.status,200);
  return listing.data.apps.find(app=>app.id===item.app.id).game_ids;
 };
 const patch=async games=>request(path,{game_ids:games},{cookie},'PATCH');
 let response=await patch(custom);assert.equal(response.status,200);assert.deepEqual(response.data.app.game_ids,custom);assert.deepEqual(await readback(),custom);
 response=await patch([...custom,'towerlink']);assert.equal(response.status,200);assert.deepEqual(response.data.app.game_ids,[...custom,'towerlink']);assert.deepEqual(await readback(),[...custom,'towerlink']);
 const launched=await launch(item,'towerlink');assert.ok(launched.token);
 response=await patch(custom);assert.equal(response.status,200);assert.deepEqual(response.data.app.game_ids,custom);assert.deepEqual(await readback(),custom);
 const rejected=await partner(item,'/v1/sessions',{...s(item.app),request_id:id('revoked_tower'),external_user_id:'demo_player',game_id:'towerlink',locale:'en',host_platform:'web'});assert.equal(rejected.status,403);
 for(const invalid of [[...custom,'unknown_game'],[...custom,'towerlink','towerlink']]){
  response=await patch(invalid);assert.equal(response.status,400);assert.equal(response.data.error.code,'INVALID_GAMES');assert.deepEqual(await readback(),custom);
 }
 completed.push('Admin Tower Link grant/revoke uses released IDs; custom selections persist and invalid IDs fail atomically');
});
