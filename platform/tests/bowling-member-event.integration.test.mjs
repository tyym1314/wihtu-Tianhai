// Real HTTP + production authentication/route + PostgreSQL, in a disposable DB.
// This adapter does not claim to retest server/index.mjs bootstrap/rate middleware.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {engines} from '../server/pvp/engines.mjs';
import {executeEngineTask} from '../server/pvp/engine-worker.mjs';
const uid=p=>p+'_'+randomBytes(8).toString('hex');
const dbname='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),dbURL=new URL(adminURL);dbURL.pathname='/'+dbname;
const origin='http://127.0.0.1:18743';
const envNames=['OASIS_DATABASE_URL','OASIS_LOCAL_DIR','OASIS_PUBLIC_ORIGIN'];
const prior=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
let admin,pool,closePools,closeEnginePool,routePvp,tickPvp,createSession,api,base,localDir,created=false,child;
before(async()=>{
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(adminURL.hostname));
  admin=new pg.Pool({connectionString:adminURL.href});await admin.query(`CREATE DATABASE "${dbname}"`);created=true;
  localDir=await mkdtemp(join(tmpdir(),'oasis-bowling-members-'));
  process.env.OASIS_DATABASE_URL=dbURL.href;process.env.OASIS_LOCAL_DIR=localDir;process.env.OASIS_PUBLIC_ORIGIN=origin;
  ({pool,closePools}=await import('../server/db.mjs'));assert.equal((await pool.query('SELECT current_database() n')).rows[0].n,dbname);
  const platform=await import('../server/platform.mjs');await platform.migratePlatform();createSession=platform.createSession;
  const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp(pool);({routePvp,tickPvp}=pvp);
  ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
  const{readBody,send}=await import('../server/security.mjs');
  api=createServer(async(req,res)=>{try{
    if(req.method==='POST'&&req.headers.origin!==origin)throw Object.assign(Error('ORIGIN_FORBIDDEN'),{status:403,code:'ORIGIN_FORBIDDEN'});
    const{body}=await readBody(req);
    if(req.url==='/v1/launch/exchange'){send(res,200,await platform.exchange(body));return;}
    const result=await routePvp(await platform.playSession(req),req.method,req.url,body);send(res,result.status,result.body);
  }catch(e){send(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR'}});}});
  await new Promise(r=>api.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+api.address().port;
});
after(async()=>{
  try{
    if(child&&child.exitCode===null&&!child.signalCode){const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await stopped;}
    if(api?.listening)await new Promise(r=>api.close(r));await closeEnginePool?.();await closePools?.();
    if(created)await dropOwnedTestDatabase(admin,dbname,{created});
  }finally{await admin?.end();if(localDir)await rm(localDir,{recursive:true,force:true});for(const k of envNames)if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}
});
async function request(token,path,body){
  const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:res.status,body:await res.json()};
}
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
async function fixture(game='bowling',capacity=4){
  const appId=uid('member_app');
  const app=(await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[appId,'member event fixture',uid('partner'),'sandbox',uid('scope'),'https://no-wallet.invalid',JSON.stringify([game])])).rows[0];
  const session={app_id:app.id,external_user_id:uid('player'),game_id:game};
  const body={partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id,external_user_id:session.external_user_id,request_id:uid('launch'),game_id:game,locale:'en',host_platform:'web'};
  const launch=await createSession(app,body,JSON.stringify(body));
  const exchanged=await request(null,'/v1/launch/exchange',{launch_code:launch.launch_code,client_instance_id:uid('client')});assert.equal(exchanged.status,200);const token=exchanged.body.access_token;
  const create=await request(token,'/api/pvp/rooms',{request_id:uid('create'),game_id:game,capacity,practice:true});assert.equal(create.status,201);const id=create.body.id;
  const ready=await request(token,`/api/pvp/rooms/${id}/ready`,{request_id:uid('ready')});assert.equal(ready.status,200);
  await tickPvp({roomIds:[id]});assert.equal((await read(id)).status,'active');
  return{session,token,id};
}
async function finish(f){
  const row=await read(f.id);
  await routePvp(f.session,'POST',`/api/pvp/rooms/${f.id}/leave`,{request_id:uid('leave')},{now:Math.max(Number(row.last_tick_at),Date.now()),skipGap:true});
  assert.equal((await read(f.id)).status,'cancelled');
  assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[f.id])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM pvp_operations WHERE room_id=$1',[f.id])).rowCount,0);
}
function metadata(event){const{trajectory,events,...rest}=event;return rest;}

test('Bowling HTTP accepts one full physical result; only the newly accepted member copy shrinks',async t=>{
  const f=await fixture();
  try{
    let before=await read(f.id);
    for(const bot of before.players.filter(p=>p.bot)){
      const authoritative=before.game_state.players.find(p=>p.key===bot.external_user_id);
      assert.ok(authoritative.trajectory.length>0);assert.ok(authoritative.pending);
      assert.equal(bot.last_event.type,'roll');assert.equal('trajectory'in bot.last_event,false);assert.equal('events'in bot.last_event,false);
    }
    // An old full event on another member must survive untouched until that
    // member actually accepts a new shot, including across unrelated saves.
    const legacy=before.players.find(p=>p.bot),botState=before.game_state.players.find(p=>p.key===legacy.external_user_id);
    legacy.last_event={...legacy.last_event,trajectory:botState.trajectory,events:botState.events,legacy_marker:'retained'};
    await pool.query('UPDATE pvp_rooms SET players=$2 WHERE id=$1',[f.id,JSON.stringify(before.players)]);
    before=await read(f.id);
    const body={request_id:uid('roll'),seq:1,action:{type:'roll',offset:0,angle:0,power:.78,spin:0}};
    const first=await request(f.token,`/api/pvp/rooms/${f.id}/action`,body);assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.me_last_seq,1);
    const after=await read(f.id),mine=after.players.find(p=>p.external_user_id===f.session.external_user_id),p=after.game_state.players.find(p=>p.key===f.session.external_user_id);
    const audit=(await pool.query('SELECT event,action,accepted_at FROM pvp_actions WHERE room_id=$1',[f.id])).rows;assert.equal(audit.length,1);
    const expected=engines.bowling.act(structuredClone(before.game_state),f.session.external_user_id,body.action,first.body.server_now);
    assert.deepEqual(audit[0].event,expected.event);assert.deepEqual(audit[0].action,body.action);
    assert.deepEqual(p,expected.state.players.find(p=>p.key===f.session.external_user_id));
    assert.deepEqual(mine.last_event,metadata(expected.event));assert.deepEqual(first.body.game.me.trajectory,p.trajectory);assert.deepEqual(first.body.game.me.events,p.events);
    assert.deepEqual(after.players.find(p=>p.external_user_id===legacy.external_user_id).last_event,legacy.last_event,'unrelated legacy member event remains full');
    assert.deepEqual((await pool.query('SELECT response FROM pvp_requests WHERE app_id=$1 AND external_user_id=$2 AND request_id=$3',[f.session.app_id,f.session.external_user_id,body.request_id])).rows[0].response,first.body);
    const repeats=await Promise.all(Array.from({length:3},()=>request(f.token,`/api/pvp/rooms/${f.id}/action`,body)));for(const replay of repeats)assert.deepEqual(replay,first);
    const conflict=await request(f.token,`/api/pvp/rooms/${f.id}/action`,{...body,action:{...body.action,power:.79}});assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await pool.query('SELECT count(*)::int n FROM pvp_actions WHERE room_id=$1',[f.id])).rows[0].n,1);
    const bytes={fullMemberEvent:Buffer.byteLength(JSON.stringify(expected.event)),compactMemberEvent:Buffer.byteLength(JSON.stringify(mine.last_event))};assert.ok(bytes.compactMemberEvent<bytes.fullMemberEvent);t.diagnostic(JSON.stringify({memberEventBytes:bytes,latency:'unmeasured'}));
    // Reload the exact old-format human member event, without rewriting state,
    // audit or response. A new OS process must replay the original response.
    after.players.find(v=>v.external_user_id===f.session.external_user_id).last_event=expected.event;
    await pool.query('UPDATE pvp_rooms SET players=$2 WHERE id=$1',[f.id,JSON.stringify(after.players)]);
    child=spawn(process.execPath,['--import','tsx','tests/bowling-member-event-restart-child.mjs',JSON.stringify({session:f.session,roomId:f.id,body})],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const code=await new Promise((r,j)=>{child.once('exit',r);child.once('error',j);});assert.equal(code,0,stderr);assert.deepEqual(JSON.parse(stdout),{replay:true,actions:1,unchanged:true});
    const restored=await read(f.id);assert.deepEqual(restored.game_state,after.game_state);assert.deepEqual(restored.players,after.players);
    // Explicit server clocks test the same persisted pending roll before and at
    // reveal. Any BOT newly enabled at the boundary stays in the shared worker.
    for(const now of [p.busyUntil-1,p.busyUntil]){
      const priorRow=await read(f.id);
      const expectedAdvance=executeEngineTask({kind:'advance',gameId:'bowling',ruleVersion:priorRow.rule_version,state:structuredClone(priorRow.game_state),now,forfeits:[],bots:priorRow.players.filter(v=>v.bot).map(v=>({key:v.external_user_id,lastBotAt:v.last_bot_at||0}))});
      const visible=await routePvp(f.session,'GET',`/api/pvp/rooms/${f.id}`,{},{now,skipGap:true});assert.equal(visible.status,200);
      assert.deepEqual((await read(f.id)).game_state,expectedAdvance.state);assert.deepEqual(visible.body.game.me.trajectory,p.trajectory);
      assert.equal(visible.body.game.me.frames[0].length,now<p.busyUntil?0:1);
    }
  }finally{await finish(f);}
});
for(const game of ['match','golf'])test(`${game} member events and public override keep their complete accepted event`,async()=>{
  const f=await fixture(game,2);
  try{
    const state=(await read(f.id)).game_state,action=engines[game].botAction(state,f.session.external_user_id,state.serverNow??state.now??Date.now());assert.ok(action);
    const accepted=await request(f.token,`/api/pvp/rooms/${f.id}/action`,{request_id:uid('control'),seq:1,action});assert.equal(accepted.status,200,JSON.stringify(accepted));
    const row=await read(f.id),mine=row.players.find(p=>p.external_user_id===f.session.external_user_id),event=(await pool.query('SELECT event FROM pvp_actions WHERE room_id=$1',[f.id])).rows[0].event;
    assert.deepEqual(mine.last_event,event);assert.deepEqual(accepted.body.game.lastEvent,event);
  }finally{await finish(f);}
});
