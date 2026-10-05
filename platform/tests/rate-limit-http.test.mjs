import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {signedHeaders} from '../specs/examples/sdk-node.mjs';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

const root=resolve(import.meta.dirname,'..'),name='oasis_credentials_'+process.pid+'_'+randomBytes(6).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
assert(['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname));adminUrl.pathname='/postgres';
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const children=new Set();let admin,db,dir,api,apps,made=false;
const uid=()=>randomBytes(12).toString('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function launch(extra={}){
 const p=await port(),base='http://127.0.0.1:'+p;
 const child=spawn(process.execPath,['--import','tsx','server/index.mjs'],{cwd:root,env:{...process.env,OASIS_DATABASE_URL:databaseUrl.href,OASIS_LOCAL_DIR:dir,OASIS_ENVIRONMENT:'sandbox',OASIS_PUBLIC_ORIGIN:base,OASIS_START_WALLET:'0',OASIS_API_PORT:String(p),OASIS_TRUST_LOOPBACK_PROXY:'1',OASIS_RATE_PVP_READ_PER_MINUTE:'2',OASIS_RATE_PVP_ACTION_PER_MINUTE:'2',OASIS_RATE_PVP_ROOM_WRITE_PER_MINUTE:'2',OASIS_RATE_PROBABILITY_READ_PER_MINUTE:'2',OASIS_RATE_PROBABILITY_WRITE_PER_MINUTE:'2',OASIS_RATE_PARTNER_READ_PER_MINUTE:'2',OASIS_RATE_PARTNER_WRITE_PER_MINUTE:'2',OASIS_RATE_AUTH_FAILURE_IP_PER_MINUTE:'2',...extra},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',v=>logs+=v);child.stderr.on('data',v=>logs+=v);
 const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 const instance={child,base,ended,get logs(){return logs;}};children.add(instance);return instance;
}
async function stop(instance){if(instance.child.exitCode===null&&!instance.child.signalCode){instance.child.kill('SIGTERM');const timer=setTimeout(()=>instance.child.kill('SIGKILL'),5000);try{await instance.ended;}finally{clearTimeout(timer);}}children.delete(instance);}
async function request(path,{body,headers={},method=body===undefined?'GET':'POST'}={}){
 const response=await fetch(api.base+path,{method,headers:{Origin:api.base,'x-real-ip':'198.18.10.10',...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
 return{status:response.status,headers:response.headers,body:await response.json()};
}
async function player(app=apps[0],user=uid(),game='run'){
 const token=randomBytes(32).toString('base64url');
 await db.query("INSERT INTO gp_sessions(id,app_id,external_user_id,game_id,token_hash,token_expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')",['rate_'+uid(),app.app.id,user,game,createHash('sha256').update(token).digest('hex')]);
 return{authorization:'Bearer '+token};
}
async function partner(app,method='GET'){
 const path=method==='GET'?'/v1/games':'/v1/unknown',requestId=uid(),body=method==='GET'?undefined:{request_id:requestId};
 return request(path,{method,body,headers:signedHeaders({keyId:app.credentials.key_id,secretBase64:app.credentials.secret_base64,method,path,rawBody:body?JSON.stringify(body):'',requestId})});
}
before(async()=>{
 admin=new pg.Pool({connectionString:adminUrl.href,max:1});await admin.query(`CREATE DATABASE "${name}"`);made=true;
 db=new pg.Pool({connectionString:databaseUrl.href,max:2});dir=await mkdtemp(join(tmpdir(),'oasis-rate-http-'));api=await launch();
 let ready=false;for(let i=0;i<150;i++){if(api.child.exitCode!==null||api.child.signalCode)throw Error('API startup failed: '+api.logs);try{if((await fetch(api.base+'/health',{signal:AbortSignal.timeout(300)})).ok){ready=true;break;}}catch{}await sleep(60);}
 assert(ready,'API readiness timeout');assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name,name);
 apps=JSON.parse(await readFile(join(dir,'sandbox-app-credentials.json'),'utf8'));assert.equal(apps.length,2);
});
after(async()=>{
 const errors=[];for(const instance of children)try{await stop(instance);}catch(e){errors.push(e);}
 try{await db?.end();if(made)await dropOwnedTestDatabase(admin,name,{created:made});}catch(e){errors.push(e);}
 await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});if(errors.length)throw new AggregateError(errors,'Rate-limit fixture cleanup failed');
});

test('actual API isolates authenticated users and Apps sharing one IP, with read/action/room budgets',async()=>{
 const user=uid(),a=await player(apps[0],user),b=await player(apps[0]),c=await player(apps[1],user),path='/api/pvp/rooms/no_such_room';
 for(let i=0;i<2;i++)assert.equal((await request(path,{headers:a})).status,404);
 const denied=await request(path,{headers:a});assert.equal(denied.status,429);assert.equal(denied.body.error.code,'RATE_LIMITED');assert(Number(denied.headers.get('retry-after'))>0);
 for(const headers of [b,c])assert.equal((await request(path,{headers})).status,404);
 for(let i=0;i<2;i++)assert.equal((await request(path+'/action',{headers:a,body:{request_id:uid(),seq:1,action:{type:'jump'}}})).status,404);
 assert.equal((await request(path+'/action',{headers:a,body:{request_id:uid(),seq:1,action:{type:'jump'}}})).status,429);
 assert.equal((await request(path+'/leave',{headers:a,body:{request_id:uid()}})).status,404);
});

test('actual probability read/write budgets are separate and do not depend on other players',async()=>{
 const a=await player(apps[0],uid(),'tiger'),b=await player(apps[0],uid(),'tiger');
 for(let i=0;i<2;i++)assert.equal((await request('/api/play/tiger/history',{headers:a})).status,200);
 assert.equal((await request('/api/play/tiger/history',{headers:a})).status,429);
 assert.equal((await request('/api/play/tiger/ack',{headers:a,body:{roundId:'not_a_round'}})).status,404);
 assert.equal((await request('/api/play/tiger/history',{headers:b})).status,200);
});

test('signed partner requests on one IP have per-App read/write budgets and nonce verification',async()=>{
 for(let i=0;i<2;i++)assert.equal((await partner(apps[0])).status,200);
 const denied=await partner(apps[0]);assert.equal(denied.status,429);assert.equal(denied.body.code,'RATE_LIMITED');assert.equal(denied.body.retryable,true);assert(Number(denied.headers.get('retry-after'))>0);
 assert.equal((await partner(apps[1])).status,200);assert.equal((await partner(apps[0],'POST')).status,404);
 const path='/v1/games',headers=signedHeaders({keyId:apps[1].credentials.key_id,secretBase64:apps[1].credentials.secret_base64,method:'GET',path,requestId:uid()});
 assert.equal((await request(path,{headers})).status,200);
 const replay=await request(path,{headers});assert.equal(replay.status,401);assert.equal(replay.body.code,'NONCE_REPLAY');
});

test('invalid authentication hits its IP budget; a valid player on that IP still reaches the game',async()=>{
 const path='/api/pvp/rooms/no_such_room',headers={'x-real-ip':'198.18.10.11'};
 for(let i=0;i<2;i++)assert.equal((await request(path,{headers})).status,401);
 const denied=await request(path,{headers});assert.equal(denied.status,429);assert(Number(denied.headers.get('retry-after'))>0);
 assert.equal((await request(path,{headers:{...headers,...await player()}})).status,404);
});

test('invalid rate configuration aborts the actual API before migration/seed and listening',async()=>{
 const before=(await db.query('SELECT count(*)::int n FROM gp_apps')).rows[0].n;
 const invalid=await launch({OASIS_RATE_PVP_ACTION_PER_MINUTE:'0'}),timer=setTimeout(()=>invalid.child.kill('SIGKILL'),10000);
 let result;try{result=await invalid.ended;}finally{clearTimeout(timer);children.delete(invalid);}
 assert.notEqual(result.code,0);assert.equal(result.signal,null);assert.match(invalid.logs,/INVALID_RATE_LIMIT_CONFIG: OASIS_RATE_PVP_ACTION_PER_MINUTE/);
 assert.doesNotMatch(invalid.logs,/OASIS sandbox API/);assert.equal((await db.query('SELECT count(*)::int n FROM gp_apps')).rows[0].n,before);
});
