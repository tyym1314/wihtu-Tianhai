import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

test('worker timeout writes no action or forfeit; a fresh process retries the same request and settles once',async()=>{
  const name='oasis_enginepool_test_'+process.pid+'_'+randomBytes(8).toString('hex');
  const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),url=new URL(adminURL);url.pathname='/'+name;
  const admin=new pg.Pool({connectionString:adminURL.href}),prior={...process.env};let pool,closePools,closeEnginePool,dir,wallet,workerChild,created=false;
  try{
    await admin.query(`CREATE DATABASE "${name}"`);created=true;dir=await mkdtemp(join(tmpdir(),'oasis-enginepool-test-'));
    process.env.OASIS_DATABASE_URL=url.href;process.env.OASIS_LOCAL_DIR=dir;process.env.OASIS_ENGINE_TASK_TIMEOUT_MS='1';process.env.OASIS_ENGINE_WORKERS='1';
    ({pool,closePools}=await import('../server/db.mjs'));assert.equal((await pool.query('SELECT current_database() n')).rows[0].n,name);
    const{seal}=await import('../server/security.mjs'),{migratePlatform}=await import('../server/platform.mjs');
    const{migrateWallet,provisionWallet,createWalletServer,readWalletSnapshot}=await import('../server/wallet/index.mjs');
    const{migratePvp,routePvp,tickPvp}=await import('../server/pvp/index.mjs');({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
    await migratePlatform();await migrateWallet(pool);await migratePvp(pool);await(await import('../server/wallet-binding.mjs')).migrateWalletBindings(pool);
    wallet=createWalletServer(pool);await new Promise(r=>wallet.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+wallet.address().port;process.env.OASIS_WALLET_ALLOWED_ORIGINS=origin;
    const app='engine_pool_fixture',scope={partner_id:'partner_fixture',app_id:app,environment:'sandbox',wallet_scope_id:'wallet_fixture',currency_id:'COIN'},key='wallet_fixture_key',secret=randomBytes(32).toString('base64');
    await pool.query("INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url) VALUES($1,'Engine pool fixture',$2,'sandbox',$3,$4)",[app,scope.partner_id,scope.wallet_scope_id,origin]);
    await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'platform-to-wallet',$3)",[key,app,seal(secret)]);
    await provisionWallet(pool,{scope,key_id:key,secret_base64:secret,users:[0,1].map(i=>({external_user_id:'player_'+i,balance_minor:'100000'})),treasury_minor:'100000000'});
    const sessions=[0,1].map(i=>({id:'session_'+i,app_id:app,external_user_id:'player_'+i,game_id:'bowling'}));
    const call=(s,path,body)=>routePvp(s,'POST',path,body);
    const room=(await call(sessions[0],'/api/pvp/rooms',{request_id:'create_engine_pool_fixture',game_id:'bowling',capacity:2,entry_minor:'1000'})).body;
    await call(sessions[1],`/api/pvp/rooms/${room.code}/join`,{request_id:'join_engine_pool_fixture'});
    for(let i=0;i<2;i++)await call(sessions[i],`/api/pvp/rooms/${room.id}/ready`,{request_id:'ready_engine_pool_fixture_'+i});
    await tickPvp({roomIds:[room.id]}); // No new physics: clock-only advancement stays inline.
    const before=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[room.id])).rows[0];assert.equal(before.status,'active');assert.equal(before.captured,true);
    const body={request_id:'original_failed_engine_action',seq:1,action:{type:'roll',offset:0,angle:0,power:.78,spin:0}};
    await assert.rejects(call(sessions[0],`/api/pvp/rooms/${room.id}/action`,body),{code:'ENGINE_TASK_TIMEOUT'});
    const failed=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[room.id])).rows[0];assert.equal(failed.status,'active');assert.deepEqual(failed.game_state.players,before.game_state.players);assert.equal(failed.players[0].last_seq,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pvp_actions')).rows[0].n,0);assert.equal((await pool.query('SELECT 1 FROM pvp_requests WHERE request_id=$1',[body.request_id])).rowCount,0);
    await closeEnginePool();
    const child=workerChild=spawn(process.execPath,['--import','tsx','tests/pvp-engine-retry-child.mjs',JSON.stringify({sessions,roomId:room.id,body})],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,OASIS_ENGINE_TASK_TIMEOUT_MS:'5000'},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const exit=await new Promise((r,j)=>{child.once('exit',r);child.once('error',j);});assert.equal(exit,0,err);assert.deepEqual(JSON.parse(out),{status:200,seq:1});
    const done=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[room.id])).rows[0];assert.equal(done.status,'settled');assert.equal((await pool.query('SELECT count(*)::int n FROM pvp_actions')).rows[0].n,1);
    const snap=await readWalletSnapshot(pool,{scope});assert.equal(snap.operations.filter(o=>o.operation_id==='settle_'+room.id).length,1);assert.equal(snap.ledger.reduce((n,l)=>n+BigInt(l.delta_available)+BigInt(l.delta_reserved),0n),0n);
    // This old sandbox paid room has no accepted first-party source/proof. It
    // cannot become an admitted production room by changing its isolated App.
    // Actual previously accepted free BOT readiness is checked in a fresh
    // runtime below, without changing this fixture's frozen sandbox runtime.
    const waiting=(await call(sessions[0],'/api/pvp/rooms',{request_id:'create_waiting_gate_fixture',game_id:'bowling',capacity:4,entry_minor:'1000'})).body;
    await pool.query("UPDATE gp_apps SET environment='production' WHERE id=$1",[app]);
    await assert.rejects(call(sessions[1],`/api/pvp/rooms/${waiting.code}/join`,{request_id:'closed_gate_join'}),{code:'FIRSTPARTY_FREE_PRACTICE_ONLY'});
    await assert.rejects(call(sessions[0],`/api/pvp/rooms/${waiting.id}/ready`,{request_id:'closed_gate_ready'}),{code:'PRODUCTION_ACCEPTANCE_REQUIRED'});
    const untouched=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[waiting.id])).rows[0];assert.equal(untouched.status,'waiting');assert.equal(untouched.players.length,1);assert.equal(untouched.players[0].ready,false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pvp_operations WHERE room_id=$1',[waiting.id])).rows[0].n,0);
    assert.equal((await call(sessions[0],`/api/pvp/rooms/${waiting.id}/leave`,{request_id:'closed_gate_leave'})).status,200);
  }finally{
    try{
      if(workerChild&&workerChild.exitCode===null&&!workerChild.signalCode){const ended=new Promise(r=>workerChild.once('exit',r));workerChild.kill('SIGKILL');await ended;}
      await closeEnginePool?.();if(wallet?.listening)await new Promise(r=>wallet.close(r));await closePools?.();
      if(created)await dropOwnedTestDatabase(admin,name,{created});
    }finally{await admin.end();if(dir)await rm(dir,{recursive:true,force:true});for(const key of['OASIS_DATABASE_URL','OASIS_LOCAL_DIR','OASIS_ENGINE_TASK_TIMEOUT_MS','OASIS_ENGINE_WORKERS','OASIS_WALLET_ALLOWED_ORIGINS'])if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
  }
});

test('closed real first-party policy refuses new join/create but drains its already accepted free BOT room',async()=>{
  // A fresh process is required: the worker/math fixture above deliberately
  // imported a frozen sandbox runtime. This child owns a different disposable
  // production-shaped DB and declares only synthetic local policy approval.
  const source=String.raw`
    import assert from 'node:assert/strict';
    import {createPlayerFixture} from './tests/player-hosted-fixture.mjs';
    const f=await createPlayerFixture();
    try{
      assert.equal(f.runtime.admissionEnabled,false);
      assert.equal(f.admissionDeclaration.production_approval,false);
      const platform=await import('./server/platform.mjs'),pvp=await import('./server/pvp/index.mjs');
      async function acceptedPlayer(username){
        const body={app_id:f.app.id,username,password:'Local-engine-pool-fixture-password-2026!'};
        assert.equal((await f.request('/api/player/register',{body})).status,201);
        const login=await f.request('/api/player/login',{body});assert.equal(login.status,200);
        const launch=await f.request('/api/player/launch',{cookie:login.cookie,headers:{'x-oasis-csrf':login.body.csrf_token},body:{app_id:f.app.id,request_id:'launch_'+username,game_id:'bowling',locale:'en',host_platform:'web'}});
        assert.equal(launch.status,201);
        const exchanged=await f.request('/v1/launch/exchange',{body:{launch_code:launch.body.launch_code,client_instance_id:'client_'+username,host_origin:f.origin,game_id:'bowling'}});
        assert.equal(exchanged.status,200);
        const session=await platform.playSession({headers:{authorization:'Bearer '+exchanged.body.access_token}});
        assert.equal(session.admission_profile,'firstparty-free-v1');assert.ok(session.player_id);return session;
      }
      const owner=await acceptedPlayer('engine_owner'),other=await acceptedPlayer('engine_other');
      const call=(session,path,body)=>pvp.routePvp(session,'POST',path,body);
      const creation={request_id:'accepted_waiting_free_fixture',game_id:'bowling',capacity:2,entry_minor:'0',practice:true};
      const made=await call(owner,'/api/pvp/rooms',creation);assert.equal(made.status,201);
      const id=made.body.id,path='/api/pvp/rooms/'+id;
      const accepted=(await f.pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
      assert.equal(accepted.status,'waiting');assert.equal(accepted.practice,true);assert.equal(accepted.entry_minor,'0');assert.equal(accepted.fee_bps,0);
      assert.equal(accepted.players.filter(player=>player.bot===false).length,1);assert.equal(accepted.players.filter(player=>player.bot===true).length,1);
      assert.equal(accepted.terms.admission_profile,'firstparty-free-v1');assert.equal(accepted.terms.admission_release,f.admissionDeclaration.release);assert.equal(accepted.terms.admission_manifest_sha256,f.admissionDeclaration.manifest_sha256);
      const tables=['gp_players','gp_player_app_ids','gp_sessions','pvp_rooms','pvp_requests','pvp_operations','wallet_ledger','wallet_operations'];
      const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await f.pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n])));
      const before=await counts();
      await f.setAdmission('closed');
      assert.equal((await f.pool.query('SELECT status FROM gp_apps WHERE id=$1',[f.app.id])).rows[0].status,'paused');
      const policy=(await f.pool.query('SELECT state,revision,proof_sha256 FROM gp_production_admission WHERE app_id=$1',[f.app.id])).rows[0];
      assert.equal(policy.state,'closed');assert.ok(BigInt(policy.revision)>BigInt(accepted.terms.admission_revision));assert.equal(policy.proof_sha256,accepted.terms.admission_proof_sha256);
      await assert.rejects(call(other,'/api/pvp/rooms/'+made.body.code+'/join',{request_id:'refused_new_human_join'}),{code:'FIRSTPARTY_FREE_PRACTICE_ONLY'});
      await assert.rejects(call(other,'/api/pvp/rooms',{...creation,request_id:'refused_new_free_room'}),{code:'PRODUCTION_ACCEPTANCE_REQUIRED'});
      assert.deepEqual(await counts(),before);
      assert.deepEqual(await call(owner,'/api/pvp/rooms',creation),made,'original accepted create replays after closure');
      const readyBody={request_id:'drain_original_free_ready'};
      const ready=await call(owner,path+'/ready',readyBody);assert.equal(ready.status,200);assert.deepEqual(await call(owner,path+'/ready',readyBody),ready);
      await pvp.tickPvp({roomIds:[id]});
      const running=(await f.pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
      assert.equal(running.status,'active');assert.deepEqual(running.terms,accepted.terms);assert.deepEqual(running.scope,accepted.scope);assert.equal(running.rule_version,accepted.rule_version);assert.equal(running.seed_enc,accepted.seed_enc);
      assert.equal((await call(owner,path+'/leave',{request_id:'drain_original_free_leave'})).status,200);
      const terminal=(await f.pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[id])).rows[0];assert.equal(terminal.status,'cancelled');
      assert.equal((await f.pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[id])).rowCount,0);
      assert.equal((await f.pool.query('SELECT 1 FROM wallet_ledger')).rowCount,0);assert.equal((await f.pool.query('SELECT 1 FROM pvp_operations')).rowCount,0);
      const money=(await f.pool.query('SELECT available,reserved,credit_pending FROM wallet_users')).rows;assert.equal(money.length,2);assert.ok(money.every(row=>row.available==='0'&&row.reserved==='0'&&row.credit_pending==='0'));
      assert.equal((await counts()).pvp_rooms,1);
      process.stdout.write(JSON.stringify({passed:true,admissionEnabled:f.runtime.admissionEnabled,acceptedRooms:1,newRooms:0,moneyWritten:false}));
    }finally{await f.close();}
  `;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',source],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env},stdio:['ignore','pipe','pipe']});
  let out='',err='',timer;
  child.stdout.on('data',body=>out+=body);child.stderr.on('data',body=>err+=body);
  try{
    const exit=await new Promise((resolveExit,reject)=>{timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('OWNED_FIRSTPARTY_FIXTURE_TIMEOUT'));},30000);child.once('exit',resolveExit);child.once('error',reject);});
    assert.equal(exit,0,err);assert.deepEqual(JSON.parse(out),{passed:true,admissionEnabled:false,acceptedRooms:1,newRooms:0,moneyWritten:false});
  }finally{
    clearTimeout(timer);
    if(child.exitCode===null&&!child.signalCode){const ended=new Promise(resolveExit=>child.once('exit',resolveExit));child.kill('SIGTERM');await ended;}
  }
});
