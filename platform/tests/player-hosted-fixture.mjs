import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {firstpartyPlayerFixtureDeclaration,installFirstpartyPlayerFixture} from './firstparty-player-fixture-policy.mjs';

export async function createPlayerFixture(){
 const name=`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`,adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname));
 assert.equal(adminUrl.pathname,'/postgres','INDEPENDENT_ADMIN_DATABASE_REQUIRED');
 const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
 const origin='https://hosted-player.example.invalid',admin=new pg.Pool({connectionString:adminUrl.href,max:1}),previous={...process.env};
 const declaration=firstpartyPlayerFixtureDeclaration({databaseName:name,origin});
 let created=false,dir,pool,closePools,closeEnginePool,server;
 async function close(){
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  await closeEnginePool?.();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});await admin.end();if(dir)await rm(dir,{recursive:true,force:true});
  for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
 }
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  dir=await mkdtemp(join(tmpdir(),'oasis-hosted-player-'));await writeFile(join(dir,'master.key'),randomBytes(32),{mode:0o600});
  Object.assign(process.env,{OASIS_DATABASE_URL:databaseUrl.href,OASIS_ENVIRONMENT:'production',OASIS_LOCAL_DIR:dir,OASIS_START_WALLET:'0',OASIS_PUBLIC_ORIGIN:origin,...declaration.runtimeEnv});
  ({pool,closePools}=await import('../server/db.mjs'));
  const platform=await import('../server/platform.mjs'),binding=await import('../server/wallet-binding.mjs'),wallet=await import('../server/wallet/index.mjs'),mode=await import('../server/runtime-mode.mjs'),pvp=await import('../server/pvp/index.mjs');
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
  await wallet.migrateWallet(pool);await platform.migratePlatform();await pvp.migratePvp(pool);await binding.migrateWalletBindings(pool);await mode.migrateRuntime(pool);
  ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
  const {app,setAdmission,admissionDeclaration}=await installFirstpartyPlayerFixture(pool,declaration,{name:'真实玩家入口测试（隔离夹具）'}),{routePlayer}=await import('../server/player-routes.mjs'),{send}=await import('../server/security.mjs');
  const launches=[];
  server=createServer(async(req,res)=>{try{
   let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
   if(req.url==='/api/player/launch')launches.push(body);
   if(await routePlayer(req,res,req.url,body,raw))return;
   if(req.url==='/v1/launch/exchange'&&req.method==='POST'&&req.headers.origin===origin)return send(res,200,await platform.exchange(body));
   if(req.url==='/api/arena/session'){
    const accepted=await platform.playSession(req),active=(await pool.query('SELECT room_id FROM pvp_active_users WHERE app_id=$1 AND external_user_id=$2',[accepted.app_id,accepted.external_user_id])).rows[0];
    return send(res,200,{session_id:accepted.id,active_room_id:active?.room_id||null,...(accepted.admission_profile==='firstparty-free-v1'?{admission_profile:accepted.admission_profile,admission_revision:accepted.admission_revision,free_training_only:true,financial_admission_enabled:false,allowed_room_modes:['bot-practice']}:{} )});
   }
   if(req.url.startsWith('/api/pvp/')){
    if(req.method!=='GET'&&req.headers.origin!==origin)return send(res,403,{error:{code:'ORIGIN_FORBIDDEN'}});
    const accepted=await platform.playSession(req),result=await pvp.routePvp(accepted,req.method,req.url,body);
    if(req.url.endsWith('/ready')&&result.status===200)await pvp.tickPvp({roomIds:[result.body.id]});
    return send(res,result.status,result.body);
   }
   send(res,404,{error:{code:'NOT_FOUND'}});
  }catch(error){send(res,error.status||500,{error:{code:error.code||'INTERNAL_ERROR'}});}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  async function request(path,{body,cookie,headers={},method=body===undefined?'GET':'POST'}={}){
   const response=await fetch(base+path,{method,headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
   return{status:response.status,body:await response.json(),headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  return{origin,base,app,pool,launches,runtime:mode.runtime,request,setAdmission,admissionDeclaration,close};
 }catch(error){await close();throw error;}
}
