import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
// Execute production modules with an in-memory pg driver. No sockets,
// migrations or server bootstrap run; AsyncLocalStorage is the real one.
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
let fixtureId=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function database(){
 const pools=[],events=[],names=['main','wallet','session','cycle','pvp','integration'];let number=0;
 const sqlError=Object.assign(Error('fixture SQL failure'),{code:'FIXTURE_SQL_FAILURE'});
 class Pool{
  constructor(config){this.config=config;this.name=names[pools.length];this.totalCount=0;this.idleCount=0;this.waitingCount=0;pools.push(this);}
  connect(callback){
   const client={pool:this.name,id:++number,released:false,
    query:async(input,values)=>{const text=typeof input==='string'?input:input.text;values=typeof input==='string'?values:input.values;assert.equal(client.released,false,'released lock client must never be reused');events.push({kind:'sql',pool:this.name,client:client.id,text,values:structuredClone(values)});if(text==='FAIL_SQL')throw sqlError;return {rows:[text.includes('pg_try_advisory_lock')?{locked:!this.refuseLock}:{pool:this.name,client:client.id,values}],rowCount:1};},
    release:error=>{assert.equal(client.released,false);client.released=true;events.push({kind:'release',pool:this.name,client:client.id,error});}};
   events.push({kind:'connect',pool:this.name,client:client.id});this.totalCount++;
   if(callback){queueMicrotask(()=>callback(null,client,client.release));return;}return Promise.resolve(client);
  }
  query(text,values,callback){if(typeof values==='function'){callback=values;values=undefined;}const work=(async()=>{const client=await this.connect();try{return await client.query(text,values);}finally{client.release();}})();if(callback){work.then(value=>callback(null,value),error=>callback(error));return;}return work;}
  end(){events.push({kind:'end',pool:this.name});return Promise.resolve();}
 }
 const key='__gameplayDbFixture'+(++fixtureId);globalThis[key]={Pool};
 const source=read('../server/db.mjs');assert.equal(source.split("import pg from 'pg';").length,2);
 const raw=source.replace("import pg from 'pg';",`const pg=globalThis[${JSON.stringify(key)}];`);
 try{const module=await import('data:text/javascript;base64,'+Buffer.from(raw+'\n// fixture '+fixtureId).toString('base64'));return{module,pools,events,sqlError};}finally{delete globalThis[key];}
}
test('borrowed autocommit uses only the held client; all six budgets and standalone queries remain',async()=>{
 const d=await database(),{module:m}=d;assert.deepEqual(d.pools.map(p=>p.config.max),[20,8,16,16,16,2]);assert.equal(d.pools.reduce((n,p)=>n+p.config.max,0),78);
 const result=await m.locked('pvp:roomA',async()=>{const a=await m.pool.query('SELECT own_read', ['appA','userA']);const b=await m.pool.query('UPDATE own_write',['appA','roomA']);assert.equal(a.rows[0].client,b.rows[0].client);return a.rows[0];});assert.equal(result.pool,'pvp');assert.equal(d.events.filter(e=>e.kind==='connect'&&e.pool==='main').length,0);
 const outside=await m.pool.query('SELECT outside',['appB']);assert.equal(outside.rows[0].pool,'main');await m.closePools();assert.equal(d.events.filter(e=>e.kind==='end').length,6);
});
test('nested and concurrent lock scopes do not share tenant parameters or clients',async()=>{
 const d=await database(),m=d.module,entered=deferred(),allow=deferred();let parent;
 const a=m.locked('session:A',async()=>{parent=(await m.pool.query('SELECT A',['appA','userA'])).rows[0];entered.resolve();await allow.promise;
  const child=await m.locked('cycle:A1',async()=>m.pool.query('SELECT child',['appA','cycleA']));assert.equal(child.rows[0].pool,'cycle');const after=await m.pool.query('SELECT A-after',['appA','userA']);assert.equal(after.rows[0].client,parent.client);});
 await entered.promise;const b=await m.locked('pvp:B',async()=>m.pool.query('SELECT B',['appB','userB']));assert.equal(b.rows[0].pool,'pvp');assert.notEqual(b.rows[0].client,parent.client);assert.deepEqual(b.rows[0].values,['appB','userB']);allow.resolve();await a;
 assert.equal(m.dbPoolStats().local_lock_keys,0);assert.equal(m.dbPoolStats().local_lock_waiters,0);
});
test('same-key FIFO, try-lock refusal and delayed branches preserve lock lifetime',async()=>{
 const d=await database(),m=d.module,entered=deferred(),allow=deferred(),late=deferred();let lateQuery,secondEntered=false;
 const first=m.locked('pvp:same',async()=>{entered.resolve();lateQuery=(async()=>{await late.promise;return m.pool.query('SELECT late',['appA']);})();await allow.promise;await m.pool.query('SELECT first',['appA']);});
 await entered.promise;const second=m.locked('pvp:same',async()=>{secondEntered=true;return m.pool.query('SELECT second',['appB']);});await Promise.resolve();assert.equal(secondEntered,false);assert.equal(d.events.filter(e=>e.kind==='connect'&&e.pool==='pvp').length,1);assert.equal(await m.tryLocked('pvp:same',()=>{throw Error('must not enter');}),undefined);
 allow.resolve();await first;await second;late.resolve();assert.equal((await lateQuery).rows[0].pool,'main');
 d.pools.find(p=>p.name==='cycle').refuseLock=true;let invoked=false;assert.equal(await m.tryLocked('cycle:refused',()=>{invoked=true;}),undefined);assert.equal(invoked,false);
});
test('transactions, callback APIs and explicit-client/integration callbacks keep original boundaries',async()=>{
 const d=await database(),m=d.module;
 await m.locked('session:transaction',async()=>{
  await m.pool.query('SELECT before');await m.tx(async c=>{assert.equal(c.pool,'main');await c.query('UPDATE in_tx',['appA']);const independent=await m.pool.query('SELECT independent');assert.equal(independent.rows[0].pool,'main');assert.notEqual(independent.rows[0].client,c.id);});
  assert.equal((await m.pool.query('SELECT after')).rows[0].pool,'session');
  assert.equal((await m.pool.query({text:'SELECT config',values:['appA']})).rows[0].pool,'main');
  assert.equal((await m.walletPool.query('SELECT wallet',['appA'])).rows[0].pool,'wallet');
  const independent=await m.pool.connect();assert.equal(independent.pool,'main');independent.release();
  await new Promise((resolve,reject)=>m.pool.query('SELECT callback',[],(error,value)=>{if(error)reject(error);else{assert.equal(value.rows[0].pool,'main');resolve();}}));
 });
 await m.locked('pvp:explicit',async client=>{assert.equal(client.pool,'pvp');assert.equal((await m.pool.query('SELECT explicit')).rows[0].pool,'main');});
 await m.locked('integration:check',async()=>{assert.equal((await m.pool.query('SELECT integration')).rows[0].pool,'main');});
 await m.locked('maintenance:check',async()=>{assert.equal((await m.pool.query('SELECT maintenance')).rows[0].pool,'main');});
 const commits=d.events.filter(e=>e.text==='BEGIN'||e.text==='COMMIT');assert.deepEqual(commits.map(e=>[e.pool,e.text]),[['main','BEGIN'],['main','COMMIT']]);assert.equal(commits[0].client,commits[1].client);
});
test('SQL failure preserves its original object, forbids fresh-checkout continuation and releases safely',async()=>{
 const d=await database(),m=d.module;
 await assert.rejects(m.locked('cycle:failed',async()=>{
  await assert.rejects(m.pool.query('FAIL_SQL'),e=>e===d.sqlError);
  await assert.rejects(m.pool.query('UPDATE after_failure'),e=>e===d.sqlError);
  await assert.rejects(m.pool.connect(),e=>e===d.sqlError);
  await assert.rejects(m.pool.query({text:'UPDATE config_after_failure'}),e=>e===d.sqlError);
  await new Promise(resolve=>m.pool.query('UPDATE callback_after_failure',[],error=>{assert.equal(error,d.sqlError);resolve();}));
  await assert.rejects(m.tx(()=>{throw Error('must not run');}),e=>e===d.sqlError);
  await new Promise(resolve=>m.pool.connect(error=>{assert.equal(error,d.sqlError);resolve();}));throw d.sqlError;
 }),e=>e===d.sqlError);
 assert.equal(d.events.some(e=>e.text?.includes('after_failure')),false);assert.equal(d.events.some(e=>e.pool==='main'),false);assert.equal(d.events.find(e=>e.kind==='release').error,d.sqlError);
 assert.equal(m.dbPoolStats().local_lock_waiters,0);assert.equal((await m.pool.query('SELECT next_request')).rows[0].pool,'main');
});

// Run the actual handler and token authenticator, omitting only top-level
// migration/listen calls and replacing the handler's external I/O seams.
function arenaHandler(){
 const source=read('../server/index.mjs'),start=source.indexOf('export function createPlatformServer()'),end=source.indexOf('\nawait preflightRuntime');assert.ok(start>=0&&end>start);
 const fn=source.slice(start,end).replace('export function','function');const originalPlatform=read('../server/platform.mjs');
 const match=originalPlatform.match(/export async function playSession\(req\)\{[^\n]+\}/);assert.ok(match);
 class ApiError extends Error{constructor(status,code,message){super(message||code);this.status=status;this.code=code;}}
 const fail=(status,code,message)=>{throw new ApiError(status,code,message);};const hash=value=>createHash('sha256').update(value).digest('hex');
 const apps=new Map(),sessions=new Map(),active=new Map(),calls=[];let balanceFailure=false;
 const authPool={query:async(sql,values)=>{calls.push({kind:'auth',sql,values});assert.match(sql,/token_hash=\$1 AND token_expires_at>now\(\)/);const s=sessions.get(values[0]);return{rows:s&&!s.expired?[s]:[]};}};
 const playSession=Function('pool','hash','fail',match[0].replace('export async','async')+';return playSession;')(authPool,hash,fail);
 const pool={query:async(sql,values)=>{calls.push({kind:'read',sql,values});assert.match(sql,/u\.app_id=a\.id AND u\.external_user_id=\$2/);assert.match(sql,/WHERE a\.id=\$1/);const app=apps.get(values[0]),r=active.get(values[0]+'/'+values[1]);return{rows:app?[{...app,__arena_active_id:r?.id??null,__arena_active_game:r?.game_id??null}]:[]};}};
 const scope=app=>({partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id});
 const walletBalance=async(app,user)=>{calls.push({kind:'wallet',app:{...app},user});assert.equal(Object.hasOwn(app,'__arena_active_id'),false);assert.equal(Object.hasOwn(app,'__arena_active_game'),false);if(balanceFailure)throw Error('fixture unavailable');return{...scope(app),balance:{external_user_id:user,available_minor:app.fixture_balance}};};
 const limiter={authenticate:(address,callback)=>{calls.push({kind:'authRate',address});return callback();},player:s=>calls.push({kind:'playerRate',app:s.app_id,user:s.external_user_id})};
 const env={createServer:callback=>callback,beginRoomReadTiming:()=>{},beginGameEntryTiming:()=>{},roomTimingSink:null,readBody:async()=>({raw:'',body:{}}),routePlayer:async()=>false,authenticated:(req,callback)=>limiter.authenticate('fixture-address',callback),playSession,limiter,ARENA_IDS:['run','match'],pool,walletBalance,scope,fail,send:(res,status,body)=>{res.status=status;res.body=body;return body;},ApiError,id:()=> 'fixture_trace',TRANSFER_PUBLIC_CODES:[],runtime:{environment:'production'},runPracticeProfileCapability:()=>[{profile_id:'real-contract-fixture'}],runPracticeCourseCapability:()=>({courses:[]}),RUN_PRACTICE_INPUT_PROTOCOL:'fixture-protocol'};
 const handler=Function(...Object.keys(env),fn+';return createPlatformServer();')(...Object.values(env));
 const request=async token=>{const res={headersSent:false,destroyed:false,setHeader(){}};await handler({url:'/api/arena/session',method:'GET',headers:{authorization:token}},res);return res;};
 return{request,apps,sessions,active,calls,hash,setBalanceFailure:value=>balanceFailure=value};
}
