/** Loopback HTTP → real PvP router → isolated PostgreSQL. Sessions are fixture-owned;
 * this checks version persistence/replay, not launch authentication or timing. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import * as current from '../arena/ludo/engine.mjs';
import * as legacy from '../arena/ludo/engine-v1.mjs';
let admin,pool,closePools,routePvp,tickPvp,seal,localDir,server,origin,created=false;
const name='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const previous={database:process.env.OASIS_DATABASE_URL,local:process.env.OASIS_LOCAL_DIR};
const out=resolve('review/deep-mobile-20261004/ludo'),sessions=new Map(),rooms=[];
const report={scope:'Actual loopback HTTP, production PvP router and isolated PostgreSQL; fixture-owned sessions and explicit persisted historical fixtures. No production services, browser, authentication or performance claim.',isolation:{database:name},requests:[],checks:[],cleanup:{}};
const uid=p=>p+'_'+randomBytes(8).toString('hex');
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
before(async()=>{
 await mkdir(out,{recursive:true});admin=new pg.Pool({connectionString:adminUrl.href,max:2});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-ludo-http-'));process.env.OASIS_DATABASE_URL=databaseUrl.href;process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,closePools}=await import('../server/db.mjs'));assert.equal((await pool.query('SELECT current_database() n')).rows[0].n,name);
 ({seal}=await import('../server/security.mjs'));await(await import('../server/platform.mjs')).migratePlatform();const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp();({routePvp,tickPvp}=pvp);
 server=createServer(async(req,res)=>{try{
  const session=sessions.get(req.headers['x-ludo-qa-session']);assert(session,'Unknown fixture session');let text='';for await(const chunk of req)text+=chunk;
  const result=await routePvp(session,req.method,req.url,text?JSON.parse(text):{});report.requests.push({method:req.method,path:req.url.replace(/rooms\/[^/]+/,'rooms/[owned]'),status:result.status,ruleVersion:result.body?.game?.ruleVersion||null});res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.body));
 }catch(error){res.writeHead(error.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:error.code||'TEST_HTTP_ERROR',message:error.message}}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
 const errors=[];
 try{for(const f of rooms){const row=await read(f.id);if(!['cancelled','settled','voided'].includes(row.status))await call(f,'POST',`/api/pvp/rooms/${f.id}/leave`);}report.cleanup.unfinished_rooms=Number((await pool.query("SELECT count(*) n FROM pvp_rooms WHERE status NOT IN ('cancelled','settled','voided')")).rows[0].n);report.cleanup.active_users=Number((await pool.query('SELECT count(*) n FROM pvp_active_users')).rows[0].n);report.cleanup.wallet_operations=Number((await pool.query('SELECT count(*) n FROM pvp_operations')).rows[0].n);assert.equal(report.cleanup.unfinished_rooms,0);assert.equal(report.cleanup.active_users,0);assert.equal(report.cleanup.wallet_operations,0);}catch(e){errors.push(e);}
 try{if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}report.cleanup.http_server_closed=true;await closePools?.();if(created){await dropOwnedTestDatabase(admin,name,{created});report.cleanup.database_dropped=true;}}catch(e){errors.push(e);}
 finally{await admin?.end();if(localDir){await rm(localDir,{recursive:true,force:true});report.cleanup.private_directory_removed=true;}for(const[k,v]of[['OASIS_DATABASE_URL',previous.database],['OASIS_LOCAL_DIR',previous.local]])if(v===undefined)delete process.env[k];else process.env[k]=v;report.checked_at=new Date().toISOString();report.cleanup.errors=errors.map(e=>e.message);await writeFile(join(out,'http.json'),JSON.stringify(report,null,2)+'\n');}
 if(errors.length)throw new AggregateError(errors,'Owned Ludo HTTP cleanup failed');
});
async function fixture(){const app=uid('ludo_app'),key=uid('session'),session={id:key,app_id:app,game_id:'ludo',external_user_id:'human'};sessions.set(key,session);await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[app,'Ludo pinned HTTP fixture','test_partner','sandbox','test_scope','https://no-wallet.invalid','["ludo"]']);const f={key,session},room=await call(f,'POST','/api/pvp/rooms',{game_id:'ludo',capacity:2,practice:true});f.id=room.id;rooms.push(f);return f;}
async function call(f,method,path,body={}){const response=await fetch(origin+path,{method,headers:{'content-type':'application/json','x-ludo-qa-session':f.key},...(method==='POST'?{body:JSON.stringify({request_id:uid('req'),...body})}:{})});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;}
async function version(f,expected){const row=await read(f.id),room=await call(f,'GET',`/api/pvp/rooms/${f.id}`);assert.equal(row.rule_version,expected);assert.equal(row.terms.rule_version,expected);if(row.game_state){assert.equal(row.game_state.ruleVersion,expected);assert.equal(room.game.ruleVersion,expected);}return{row,room};}

test('new HTTP create and ready use v1.1; seed-fixed unrevealed turns remain awaiting explicit roll',async()=>{
 const f=await fixture();await version(f,current.RULE_VERSION);await call(f,'POST',`/api/pvp/rooms/${f.id}/ready`);await tickPvp({roomIds:[f.id]});let {row,room}=await version(f,current.RULE_VERSION);assert.equal(room.status,'active');assert.equal(row.game_state.ruleVersion,current.RULE_VERSION);
 // Seats are randomized by the actual ready handler. Advance only the normal
 // bot/turn engine until the human's first turn, never force a die or turn key.
 for(let i=0;row.game_state.turnKey!=='human'&&i<40;i++){await tickPvp({roomIds:[f.id],now:Number(row.last_tick_at)+1300,skipGap:true});({row,room}=await version(f,current.RULE_VERSION));}
 assert.equal(row.game_state.turnKey,'human');assert.equal(room.game.dice,null);assert.equal(row.game_state.revealed,false);assert.deepEqual(room.game.legalActions,[{type:'roll'}]);
 const die=row.game_state.dice,count=row.game_state.rollCount;const rolled=await call(f,'POST',`/api/pvp/rooms/${f.id}/action`,{seq:1,action:{type:'roll'}});assert.equal(rolled.game.dice,die);assert.equal((await read(f.id)).game_state.rollCount,count);assert.equal(rolled.game.lastEvent.type,'roll');
 report.checks.push({case:'new-create',passed:true,version:current.RULE_VERSION});
});
test('persisted legacy waiting room starts under v1 and survives another module instance',async()=>{
 const f=await fixture();
 // This represents a waiting room created by the old release, not a client-set rule override.
 await pool.query("UPDATE pvp_rooms SET rule_version=$2,terms=jsonb_set(terms,'{rule_version}',to_jsonb($2::text)) WHERE id=$1",[f.id,legacy.RULE_VERSION]);
 await call(f,'POST',`/api/pvp/rooms/${f.id}/ready`);await tickPvp({roomIds:[f.id]});await version(f,legacy.RULE_VERSION);
 const restored=await import('../server/pvp/index.mjs?ludo-http-reload='+uid('reload'));routePvp=restored.routePvp;const before=(await read(f.id)).game_state;await version(f,legacy.RULE_VERSION);assert.deepEqual((await read(f.id)).game_state,before);
 report.checks.push({case:'legacy-waiting-start-and-reload',passed:true,version:legacy.RULE_VERSION});
});
test('persisted v1 active state restores exact dice/board; HTTP roll/move and same-request replay stay legacy',async()=>{
 const f=await fixture(),row=await read(f.id),now=Date.now(),roster=row.players.map((p,i)=>({...p,seat_index:i,ready:true,last_seen_at:now,last_bot_at:now}));
 let state;for(let i=0;i<256;i++){const candidate=legacy.createState(i.toString(16).padStart(2,'0').repeat(32),now,{players:roster.map(p=>({key:p.external_user_id,seatIndex:p.seat_index,name:p.name,isBot:p.bot}))});if(candidate.dice===6){state=candidate;break;}}assert(state);
 // Complete old-release active state, stored as JSON exactly as a process restart would read it.
 await pool.query("UPDATE pvp_rooms SET status='active',rule_version=$2,terms=jsonb_set(terms,'{rule_version}',to_jsonb($2::text)),players=$3,game_state=$4,seed_enc=$5,starts_at=$6,end_at=$7,last_tick_at=$6 WHERE id=$1",[f.id,legacy.RULE_VERSION,JSON.stringify(roster),state,seal(state.seed),now,state.deadlineAt]);
 routePvp=(await import('../server/pvp/index.mjs?ludo-active-reload='+uid('reload'))).routePvp;await version(f,legacy.RULE_VERSION);assert.deepEqual((await read(f.id)).game_state,state);
 const request={request_id:uid('roll_once'),seq:1,action:{type:'roll'}},rolled=await call(f,'POST',`/api/pvp/rooms/${f.id}/action`,request),again=await call(f,'POST',`/api/pvp/rooms/${f.id}/action`,request);assert.deepEqual(again,rolled);assert.equal(rolled.game.dice,6);assert.equal(rolled.game.ruleVersion,legacy.RULE_VERSION);assert.equal(Number((await pool.query('SELECT count(*) n FROM pvp_actions WHERE room_id=$1',[f.id])).rows[0].n),1);
 const expected=structuredClone(state);legacy.tick(expected,rolled.game.lastEvent.at);legacy.act(expected,'human',{type:'roll'},rolled.game.lastEvent.at);assert.deepEqual((await read(f.id)).game_state,expected);
 const moved=await call(f,'POST',`/api/pvp/rooms/${f.id}/action`,{seq:2,action:{type:'move',piece:0}});assert.equal(moved.game.ruleVersion,legacy.RULE_VERSION);assert.equal(moved.game.players.find(p=>p.key==='human').pieces[0],0);await version(f,legacy.RULE_VERSION);
 report.checks.push({case:'legacy-active-json-restore-roll-move-idempotent-replay',passed:true,version:legacy.RULE_VERSION});
});
