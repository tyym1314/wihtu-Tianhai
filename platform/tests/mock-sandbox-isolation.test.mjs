import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseEnvironmentFile,validateIsolationConfig,validatePrivateKeys,probeDistinctDatabases,preflight} from '../deploy/mock-sandbox/isolation.mjs';

const live={
 OASIS_PUBLIC_ORIGIN:'https://game.tianyahuyu.com',
 OASIS_DATABASE_URL:'postgres://live:p@127.0.0.1:5432/oasis_live',
 OASIS_LOCAL_DIR:'/private/live',
 OASIS_API_PORT:'18881',OASIS_WALLET_PORT:'18882',OASIS_DEMO_PORT:'18885'
};
const mock={
 MOCK_SANDBOX_KIND:'isolated-13-game-mock',OASIS_ENVIRONMENT:'sandbox',OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_START_WALLET:'1',
 OASIS_PUBLIC_ORIGIN:'https://mock-stage.tianyahuyu.com',
 OASIS_DATABASE_URL:'postgres://mock:p@127.0.0.1:5432/oasis_android_mock',
 OASIS_LOCAL_DIR:'/private/mock',
 OASIS_API_PORT:'18981',OASIS_WALLET_PORT:'18982',OASIS_DEMO_PORT:'18985',
 OASIS_REFERENCE_WALLET_URL:'http://127.0.0.1:18982'
};
const changed=(value,updates)=>({...value,...updates});

test('mock config requires distinct exact HTTPS host, database and loopback ports',()=>{
 assert.equal(validateIsolationConfig(mock,live).mockOrigin,mock.OASIS_PUBLIC_ORIGIN);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_PUBLIC_ORIGIN:live.OASIS_PUBLIC_ORIGIN}),live),/MOCK_ORIGIN_SHARED_WITH_LIVE/);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_PUBLIC_ORIGIN:'https://game.tianyahuyu.com:8443'}),live),/MOCK_ORIGIN_SHARED_WITH_LIVE/);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_PUBLIC_ORIGIN:'http://mock-game.example.test'}),live),/MOCK_ORIGIN_INVALID/);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_PUBLIC_ORIGIN:'https://mock-game.example.invalid'}),live),/MOCK_ORIGIN_INVALID/);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_PUBLIC_ORIGIN:'https://127.0.0.1'}),live),/MOCK_ORIGIN_INVALID/);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_DATABASE_URL:'postgres://another:p@127.0.0.1:5432/oasis_live'}),live),/MOCK_DATABASE_SHARED_WITH_LIVE/);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_API_PORT:live.OASIS_API_PORT}),live),/MOCK_PORT_SHARED_WITH_LIVE/);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_WALLET_PORT:'18981'}),live),/MOCK_PORTS_CONFLICT/);
 assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_REFERENCE_WALLET_URL:'http://127.0.0.1:18882'}),live),/MOCK_WALLET_ROUTE_INVALID/);
 for(const update of [{OASIS_ENVIRONMENT:'production'},{OASIS_START_WALLET:'0'},{OASIS_PRODUCTION_ADMISSION_ENABLED:'1'},{MOCK_SANDBOX_KIND:'other'}])assert.throws(()=>validateIsolationConfig(changed(mock,update),live),/MOCK_MODE_REQUIRED/);
});

test('mock wallet allowlist permits only its own reference wallet, including the runtime empty-list default',()=>{
 for(const allowed of [undefined,'',' , ',mock.OASIS_REFERENCE_WALLET_URL,mock.OASIS_REFERENCE_WALLET_URL+'/',` ${mock.OASIS_REFERENCE_WALLET_URL}, ${mock.OASIS_REFERENCE_WALLET_URL}/ `]){
  assert.equal(validateIsolationConfig(changed(mock,{OASIS_WALLET_ALLOWED_ORIGINS:allowed}),live).mockOrigin,mock.OASIS_PUBLIC_ORIGIN);
 }
 for(const allowed of [
  'http://127.0.0.1:18882',
  'https://live-wallet.tianyahuyu.com',
  `${mock.OASIS_REFERENCE_WALLET_URL},http://127.0.0.1:18882`,
  `https://live-wallet.tianyahuyu.com,${mock.OASIS_REFERENCE_WALLET_URL}`,
  `${mock.OASIS_REFERENCE_WALLET_URL},https://other-wallet.example.org`,
  'http://localhost:18982',
  'http://[::1]:18982',
  'not-an-origin',
  18982
 ])assert.throws(()=>validateIsolationConfig(changed(mock,{OASIS_WALLET_ALLOWED_ORIGINS:allowed}),live),/MOCK_WALLET_ALLOWED_ORIGINS_INVALID/);
});

test('strict environment parser rejects duplicate names and shell execution syntax',()=>{
 assert.equal(parseEnvironmentFile('A=one\nB="two"\n# comment\n').B,'two');
 for(const source of ['A=1\nA=2','export A=1','A=$(command)','A=`command`','A="unfinished'])assert.throws(()=>parseEnvironmentFile(source),/MOCK_ENV_FILE_INVALID/);
});

test('private paths and both 32-byte keys cannot be reused from live',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'oasis-mock-keys-'));
 const liveDir=path.join(root,'live'),mockDir=path.join(root,'mock');
 try{
  await Promise.all([mkdir(liveDir),mkdir(mockDir)]);
  for(const name of ['master.key','hosted-demo-guest.key']){
   await writeFile(path.join(liveDir,name),Buffer.alloc(32,1),{mode:0o600});
   await writeFile(path.join(mockDir,name),Buffer.alloc(32,2),{mode:0o600});
  }
  const config=validateIsolationConfig(changed(mock,{OASIS_LOCAL_DIR:mockDir}),changed(live,{OASIS_LOCAL_DIR:liveDir}));
  await validatePrivateKeys(config);
  await assert.rejects(validatePrivateKeys({...config,mockPrivateDir:liveDir}),/MOCK_PRIVATE_DIR_SHARED_WITH_LIVE/);
  await writeFile(path.join(mockDir,'master.key'),Buffer.alloc(32,1),{mode:0o600});
  await assert.rejects(validatePrivateKeys(config),/MOCK_PRIVATE_KEY_SHARED_WITH_LIVE/);
  await writeFile(path.join(mockDir,'master.key'),Buffer.alloc(32,3),{mode:0o600});
  await rm(path.join(mockDir,'hosted-demo-guest.key'));
  await assert.rejects(validatePrivateKeys(config),/MOCK_PRIVATE_KEY_MISSING/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('actual DB alias challenge fails closed and never logs connection strings',async()=>{
 const traces=[];
 class FakeClient{
  constructor({connectionString}){this.connectionString=connectionString;traces.push(['construct',connectionString]);}
  async connect(){traces.push(['connect',this.connectionString]);}
  async query(sql){traces.push(['query',sql]);if(sql.includes('pg_try_advisory_xact_lock'))return{rows:[{acquired:false}]};return{rows:[]};}
  async end(){traces.push(['end']);}
 }
 const config=validateIsolationConfig(mock,live);
 await assert.rejects(probeDistinctDatabases(config,{Client:FakeClient}),/MOCK_DATABASE_SHARED_WITH_LIVE/);
 assert.equal(traces.filter(row=>row[1]==='ROLLBACK').length,2);
 assert.ok(traces.some(row=>String(row[1]).includes('pg_advisory_xact_lock')));
 class UnreachableClient extends FakeClient{async connect(){throw Error('password from URL must stay private');}}
 await assert.rejects(probeDistinctDatabases(config,{Client:UnreachableClient}),error=>error.message==='MOCK_DATABASE_PROBE_FAILED');
});

test('PostgreSQL challenge rejects two different URLs for the same physical local database',async()=>{
 const liveDatabase=process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres';
 const alias=new URL(liveDatabase);
 alias.searchParams.set('application_name','oasis_mock_alias_probe');
 await assert.rejects(probeDistinctDatabases({liveDatabase,mockDatabase:alias.href}),/MOCK_DATABASE_SHARED_WITH_LIVE/);
});

test('PostgreSQL challenge accepts the release suite owned database as distinct',async context=>{
 const liveDatabase=process.env.OASIS_TEST_ADMIN_DATABASE_URL;
 const mockDatabase=process.env.OASIS_DATABASE_URL;
 if(!liveDatabase||!mockDatabase){context.skip('requires the isolated release-suite database');return;}
 await probeDistinctDatabases({liveDatabase,mockDatabase});
});

test('preflight succeeds only after configuration, private key and database checks',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'oasis-mock-preflight-'));
 const liveDir=path.join(root,'live'),mockDir=path.join(root,'mock');
 try{
  await Promise.all([mkdir(liveDir),mkdir(mockDir)]);
  for(const [directory,fill] of [[liveDir,1],[mockDir,2]])for(const name of ['master.key','hosted-demo-guest.key'])await writeFile(path.join(directory,name),Buffer.alloc(32,fill),{mode:0o600});
  class DistinctClient{async connect(){}async query(sql){return sql.includes('pg_try_advisory_xact_lock')?{rows:[{acquired:true}]}:{rows:[]};}async end(){}}
  const result=await preflight(changed(mock,{OASIS_LOCAL_DIR:mockDir}),changed(live,{OASIS_LOCAL_DIR:liveDir}),{Client:DistinctClient});
  assert.deepEqual(result,{origin:mock.OASIS_PUBLIC_ORIGIN,gameCount:13,databaseIsolation:'proven',keyIsolation:'proven'});
 }finally{await rm(root,{recursive:true,force:true});}
});
