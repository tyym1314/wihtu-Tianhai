import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
function probabilityCoinsToMinor(value,scale){
 assert.ok(Number.isFinite(value)&&value>=0&&Number.isInteger(scale)&&scale>=0&&scale<=6,'PROBABILITY_COIN_AMOUNT_INVALID');const text=String(value),match=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);assert.ok(match&&(match[2]?.length??0)<=scale,'PROBABILITY_COIN_PRECISION_INVALID');const minor=BigInt(match[1])*10n**BigInt(scale)+BigInt((match[2]??'').padEnd(scale,'0')||'0');assert.ok(minor<=9223372036854775807n,'PROBABILITY_COIN_CAPACITY_INVALID');return minor.toString();
}

let fixtureSequence=0;
const clone=value=>structuredClone(value);
const rows=value=>({rows:value,rowCount:value.length});
const normalized=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='createdAt'?undefined:item));

// Execute the full production cycles module; replace only its six external
// dependency imports with per-test DB/wallet/math transports. No database
// connection, HTTP listener or application bootstrap is opened.
async function loadFixture(options={}){
 const bytes=await readFile(new URL('../server/cycles.mjs',import.meta.url));
 const key='oasis-cycle-balance-fixture-'+(++fixtureSequence),f=createFixture(options);globalThis[key]=f;
 const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
 const prefix=`const f=globalThis[${JSON.stringify(key)}];`;
 const dependencies={
  './db.mjs':prefix+'export const pool={query:(...args)=>f.query(...args)};export const tx=fn=>f.tx(fn);export const locked=(key,fn)=>f.locked(key,fn);',
  './security.mjs':prefix+'export const id=prefix=>f.id(prefix);export const hash=value=>f.hash(value);export const seal=value=>f.seal(value);export const unseal=value=>value;export const fail=(status,code,message)=>f.fail(status,code,message);',
  './platform.mjs':prefix+'export const appById=id=>f.appById(id);export const scope=app=>f.scope(app);export const audit=(...args)=>f.audit(...args);export const validate=(...args)=>f.validate(...args);',
  './math/index.ts':prefix+'export const getProfile=(...args)=>f.getProfile(...args);export const playCycle=(...args)=>f.playCycle(...args);export const getProfileByVersion=()=>undefined;',
  './wallet-binding.mjs':prefix+'export const walletRequest=(...args)=>f.walletRequest(...args);export const validatedWalletBalance=(...args)=>f.validatedWalletBalance(...args);',
  './production-admission.mjs':prefix+'export const partnerProfile=profile=>profile==="partner-external-v1";export const unitsPerCoin=scale=>{if(!Number.isInteger(scale)||scale<0||scale>6)throw Error("INTERNAL_COIN_PRECISION_INVALID");return 10**scale;};export const assertNewFinancialAdmission=(...args)=>f.assertNewFinancialAdmission(...args);export const publicAdmissionCapability=info=>f.publicAdmissionCapability(info);',
 };
 const rewritten=bytes.toString().replace(/from '(\.\/[^']+)'/g,(_match,specifier)=>{assert.ok(dependencies[specifier],'UNEXPECTED_RELATIVE_IMPORT');return `from '${data(dependencies[specifier])}'`;});
 try{return{module:await import(data(rewritten)),fixture:f,dispose(){delete globalThis[key];}};}catch(error){delete globalThis[key];throw error;}
}

function createFixture(options){
 const game=options.game||'thunder',app={id:'app_fixture',partner_id:'partner_fixture',environment:options.production?'production':'sandbox',wallet_scope_id:'scope_fixture',currency_id:'COIN',currency_scale:options.scale??2,status:'active',game_ids:['thunder','tiger'],math_profile:options.profile||'99'};
 const f={trace:[],balanceReads:0,appReads:0,playWrites:0,idSequence:0,locks:[],tails:new Map(),cycles:new Map(),plays:new Map(),operations:new Map(),app};
 const result={gameId:game,mathVersion:game+'-platform-99-v1',mathConfigHash:'a'.repeat(64),grossPayoutMinor:options.grossPayoutMinor??500,rounds:clone(options.rounds||[{totalWin:300,freeSpinsBefore:0,freeSpinsAfter:1,nextFreeMultiplier:2},{totalWin:200,freeSpinsBefore:1,freeSpinsAfter:0,nextFreeMultiplier:0}])};
 const makeCycle=id=>({id,session_id:'session_fixture',app_id:app.id,external_user_id:'player_fixture',game_id:game,request_id:'request_old',stake_minor:'1000',math_profile:'99',math_version:result.mathVersion,math_hash:result.mathConfigHash,max_payout_minor:'10000000',payout_minor:String(result.grossPayoutMinor),status:'SETTLED',result:clone(result)});
 const old=options.continuation?'cycle_free':options.previous?'cycle_old':null;if(old)f.cycles.set(old,makeCycle(old));
 f.session={id:'session_fixture',app_id:app.id,external_user_id:'player_fixture',game_id:game,state:{version:0,pendingPlay:options.pending?'round_pending':null,cycleId:old,nextIndex:options.continuation?1:options.previous?2:0},...(options.freeProfile?{admission_profile:'firstparty-free-v1',admission_revision:'7'}:{})};
 if(options.replay){const payload={id:'round_existing',requestId:'request_fixture',bet:10,engine:clone(result.rounds[0]),balanceAfter:7};f.plays.set('round_existing',{id:'round_existing',session_id:f.session.id,request_id:'request_fixture',bet:options.replayBet??10,payload});}
 f.event=(kind,detail={})=>f.trace.push({kind,...detail,locks:[...f.locks]});
 f.id=prefix=>prefix+'_'+(++f.idSequence);
 f.hash=value=>createHash('sha256').update(value).digest('hex');f.seal=value=>'sealed-'+f.hash(value);
 f.fail=(status,code,message)=>{throw Object.assign(new Error(message||code),{status,code});};
 f.scope=a=>Object.fromEntries(['partner_id','environment','wallet_scope_id','currency_id'].map(k=>[k,a[k]]).concat([['app_id',a.id]]));
 f.appById=async id=>{f.event('app.read');assert.equal(id,app.id);f.appReads++;return clone(app);};
 f.audit=async()=>f.event('audit.write');
 f.validate=(name,body)=>{assert.equal(name,'Operation');assert.ok(body.operation_id&&(body.receipt||body.state==='REJECTED'));};
 f.assertNewFinancialAdmission=async(_db,a)=>{f.event('admission.check');if(a.environment==='production')f.fail(403,'PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED');};
 f.publicAdmissionCapability=info=>({admission_profile:info?.profile||'closed',admission_open:info?.open===true,free_training_only:info?.profile==='firstparty-free-v1',financial_admission_enabled:false,allowed_room_modes:info?.profile==='firstparty-free-v1'?['bot-practice']:[],game_ids:info?.game_ids||[]});
 f.getProfile=(id,profile='99')=>{f.event('math.profile',{game:id,profile});if(!['thunder','tiger'].includes(id))throw new RangeError('Unknown probability game');if(!['98','99'].includes(profile))throw new RangeError('Unknown math profile');return{version:id+'-platform-'+profile+'-v1',hash:'a'.repeat(64),maxMultiplier:10000,config:{stakeMinorChoices:[1000,5000,10000,20000,50000]}};};
 f.playCycle=()=>{f.event('math.compute');assert.ok([...f.operations.values()].some(op=>op.path.endsWith('/accept')&&op.state==='SUCCEEDED'),'NO_MATH_BEFORE_CONFIRMED_ACCEPT');return clone(result);};
 f.validatedWalletBalance=async(a,user)=>{f.balanceReads++;f.event('wallet.balance',{number:f.balanceReads});assert.equal(a.id,app.id);assert.deepEqual(f.scope(a),f.scope(app));assert.equal(user,f.session.external_user_id);if(options.balanceErrorAt===f.balanceReads)f.fail(503,'WALLET_INVALID_SCOPE');if(options.missingBalanceAt===f.balanceReads)return{balance:{}};return{balance:{available_minor:(options.balances||['123456','234567'])[f.balanceReads-1]||'345678'}};};
 f.walletRequest=async(a,method,path,raw,requestId)=>{
  assert.deepEqual(f.scope(a),f.scope(app));assert.equal(method,'POST');const body=JSON.parse(raw),kind=path.split('/').at(-1);f.event('wallet.'+kind);assert.ok(f.locks.includes('session:'+f.session.id)&&f.locks.some(key=>key.startsWith('cycle:')));
  if(options.walletReject===kind)return{state:'REJECTED',operation_id:requestId,body_sha256:f.hash(raw),...f.scope(a),rejection:{code:'WALLET_REJECTED'}};
  return{state:'SUCCEEDED',operation_id:requestId,body_sha256:f.hash(raw),...f.scope(a),receipt:{resource_type:'probability_authorization',resource:{...body,state:{authorize:'AUTHORIZED',accept:'ACCEPTED',settle:'SETTLED'}[kind]}}};
 };
 f.tx=async fn=>{const before=clone({session:f.session,plays:f.plays,cycles:f.cycles,operations:f.operations,playWrites:f.playWrites});f.event('tx.begin');try{const value=await fn({query:f.query});f.event('tx.commit');return value;}catch(error){Object.assign(f,before);f.event('tx.rollback');throw error;}};
 f.locked=async(key,fn)=>{const before=f.tails.get(key);let release;const tail=new Promise(resolve=>release=resolve);f.tails.set(key,tail);await before;f.locks.push(key);f.event('lock.enter',{key});try{return await fn();}finally{f.event('lock.leave',{key});assert.equal(f.locks.pop(),key);release();if(f.tails.get(key)===tail)f.tails.delete(key);}};
 f.query=async(sql,args=[])=>{
  f.event('sql',{sql});
  if(sql==='SELECT * FROM gp_apps WHERE id=$1 FOR SHARE'){assert.equal(args.length,1);assert.equal(args[0],app.id);return rows([clone(app)]);}
  if(sql.startsWith('SELECT * FROM gp_sessions')){assert.equal(args[0],f.session.id);return rows([clone(f.session)]);}
  if(sql==='SELECT * FROM gp_plays WHERE id=$1 AND session_id=$2')return rows([...f.plays.values()].filter(p=>p.id===args[0]&&p.session_id===args[1]).map(clone));
  if(sql.startsWith('SELECT * FROM gp_plays'))return rows([...f.plays.values()].filter(p=>p.session_id===args[0]&&p.request_id===args[1]).map(clone));
  if(sql.startsWith('SELECT payload FROM gp_plays'))return rows(f.plays.has(args[0])?[{payload:clone(f.plays.get(args[0]).payload)}]:[]);
  if(sql.startsWith('SELECT * FROM gp_cycles WHERE id='))return rows(f.cycles.has(args[0])?[clone(f.cycles.get(args[0]))]:[]);
  if(sql.startsWith('SELECT * FROM gp_cycles WHERE session_id='))return rows([...f.cycles.values()].filter(c=>c.session_id===args[0]&&c.request_id===args[1]).map(clone));
  if(sql.startsWith('SELECT id FROM gp_cycles'))return rows([]);
  if(sql.startsWith('INSERT INTO gp_cycles')){const [id,session_id,app_id,external_user_id,game_id,request_id,stake_minor,math_profile,math_version,math_hash,max_payout_minor]=args;const cycle={id,session_id,app_id,external_user_id,game_id,request_id,stake_minor,math_profile,math_version,math_hash,max_payout_minor,status:'AUTHORIZING'};f.cycles.set(id,cycle);f.event('cycle.insert');return rows([clone(cycle)]);}
  if(sql.startsWith('INSERT INTO gp_operations')){const [id,app_id,aggregate_id,path,raw_body]=args;if(!f.operations.has(id))f.operations.set(id,{id,app_id,aggregate_id,path,raw_body,state:'NEW',attempts:0});return rows([]);}
  if(sql.startsWith('SELECT * FROM gp_operations'))return rows([clone(f.operations.get(args[0]))]);
  if(sql.startsWith('UPDATE gp_operations SET state=')){Object.assign(f.operations.get(args[2]),{state:args[0],response:clone(args[1]),attempts:1});return rows([]);}
  if(sql.startsWith('UPDATE gp_cycles SET status=')){const id=args.at(-1),c=f.cycles.get(id);if(sql.includes("status='RESULT_FIXED'")){Object.assign(c,{status:'RESULT_FIXED',seed_enc:args[0],result:clone(args[1]),result_hash:args[2],payout_minor:args[3]});f.event('result.fixed');}else if(sql.includes("status='SETTLED'")){c.status='SETTLED';f.event('cycle.settled');}else if(sql.includes("status='AUTHORIZED'"))c.status='AUTHORIZED';else if(sql.includes("status='ACCEPTED'"))c.status='ACCEPTED';else if(sql.includes('jsonb_build_object')){f.cycles.get(args[2]).status=args[0];}else throw Error('UNHANDLED_CYCLE_UPDATE');return rows([]);}
  if(sql.startsWith('SELECT 1 FROM gp_operations'))return rows([...f.operations.values()].some(op=>op.aggregate_id===args[0]&&op.state==='REJECTED')?[{}]:[]);
  if(sql.startsWith('INSERT INTO gp_plays')){const [id,session_id,request_id,cycle_id,round_index,bet,payload]=args;f.plays.set(id,{id,session_id,request_id,cycle_id,round_index,bet,payload:clone(payload)});f.playWrites++;f.event('play.insert');return rows([]);}
  if(sql==='UPDATE gp_plays SET acknowledged=true WHERE id=$1'){f.plays.get(args[0]).acknowledged=true;f.event('play.acknowledge');return rows([]);}
  if(sql==="UPDATE gp_sessions SET state=jsonb_set(state,'{pendingPlay}','null') WHERE id=$1 AND state->>'pendingPlay'=$2"){assert.equal(args[0],f.session.id);if(f.session.state.pendingPlay===args[1])f.session.state.pendingPlay=null;f.event('session.acknowledge');return rows([]);}
  if(sql.startsWith('UPDATE gp_sessions SET state=')){assert.equal(args[1],f.session.id);if(options.failPlayCommit)throw Object.assign(Error('fixture commit unavailable'),{code:'P0001'});f.session.state=clone(args[0]);f.event('session.update');return rows([]);}
  throw Error('UNHANDLED_FIXTURE_QUERY:'+sql);
 };
 return f;
}

const request={requestId:'request_fixture',bet:10,expectedVersion:0};
const count=(f,kind)=>f.trace.filter(row=>row.kind===kind).length;
const submit=l=>l.module.spin(l.fixture.session,request);

// Source20 physical Tiger row 32: wallet 988840, stake 1000, payout/engine 1820.
// Its old divided-Number inverse exposed balanceBefore=9880.199999999999.
for(const amounts of [
  {scale:2,available:'988840',payout:1820,bet:10,before:'988020',after:9888.4,prior:9880.2,win:18.2,replay:'988941',latest:'989999'},
  {scale:6,available:'10000',payout:1,bet:.001,before:'10999',after:.01,prior:.010999,win:.000001,replay:'10001',latest:'10002'},
 ])test(`Tiger witnessed settlement at scale ${amounts.scale} projects integer minor amounts exactly and freezes the stored round across fresh-balance replay`,async()=>{
  const l=await loadFixture({game:'tiger',scale:amounts.scale,grossPayoutMinor:amounts.payout,rounds:[{totalWin:amounts.payout,freeSpinsBefore:0,freeSpinsAfter:0,nextFreeMultiplier:0}],balances:[amounts.available,amounts.replay,amounts.latest]});try{
   const body={...request,bet:amounts.bet},first=await l.module.spin(l.fixture.session,body),f=l.fixture,round=clone(first.round);
   assert.equal(round.balanceBefore,amounts.prior);assert.equal(round.balanceAfter,amounts.after);assert.equal(round.win,amounts.win);
   assert.equal(probabilityCoinsToMinor(round.balanceBefore,amounts.scale),amounts.before);
   assert.equal(probabilityCoinsToMinor(round.balanceAfter,amounts.scale),amounts.available);
   assert.equal(probabilityCoinsToMinor(round.bet,amounts.scale),'1000');assert.equal(probabilityCoinsToMinor(round.win,amounts.scale),String(amounts.payout));
   assert.equal(round.engine.totalWin,amounts.payout);assert.equal(round.isFreeSpin,false);assert.equal(round.balanceScope,'complete_cycle');
   assert.equal(first.session.balance,round.balanceAfter);assert.equal(first.session.pendingRound.id,round.id);
   const persisted=f.plays.get(round.id);assert.deepEqual(persisted.payload,round);assert.equal(persisted.round_index,0);assert.equal(persisted.bet,amounts.bet);
   const cycle=clone([...f.cycles.values()][0]),operations=clone([...f.operations.values()]);
   assert.equal(cycle.status,'SETTLED');assert.equal(cycle.stake_minor,'1000');assert.equal(cycle.payout_minor,String(amounts.payout));assert.equal(cycle.result.grossPayoutMinor,amounts.payout);
   assert.equal(JSON.parse(operations.find(op=>op.path.endsWith('/settle')).raw_body).gross_payout_minor,String(amounts.payout));
   const replay=await l.module.spin(f.session,body),latest=await l.module.publicSession(f.session);
   assert.equal(probabilityCoinsToMinor(replay.session.balance,amounts.scale),amounts.replay);assert.equal(probabilityCoinsToMinor(latest.balance,amounts.scale),amounts.latest);
   assert.deepEqual(replay.round,round);assert.deepEqual(f.plays.get(round.id).payload,round);assert.deepEqual([...f.cycles.values()],[cycle]);assert.deepEqual([...f.operations.values()],operations);
   assert.equal(f.balanceReads,3);assert.equal(f.playWrites,1);assert.equal(f.plays.size,1);assert.equal(f.cycles.size,1);
   for(const kind of ['wallet.authorize','wallet.accept','math.compute','result.fixed','wallet.settle'])assert.equal(count(f,kind),1);
   assert.ok(f.trace.findIndex(row=>row.kind==='wallet.settle')<f.trace.findIndex(row=>row.kind==='wallet.balance'));
  }finally{l.dispose();}
});

test('Thunder natural bonus continuation retains one settled cycle and does not reconstruct a second charged balance',async()=>{
 const l=await loadFixture({game:'thunder',grossPayoutMinor:1820,rounds:[{totalWin:1800,freeSpinsBefore:0,freeSpinsAfter:1,nextFreeMultiplier:2},{totalWin:20,freeSpinsBefore:1,freeSpinsAfter:0,nextFreeMultiplier:0}],balances:['988840','988841','988942','989999','990000','990001']});try{
  const first=await submit(l),f=l.fixture,paid=clone(first.round),cycle=clone([...f.cycles.values()][0]),operations=clone([...f.operations.values()]);
  assert.equal(probabilityCoinsToMinor(paid.balanceBefore,2),'988020');assert.equal(first.session.freeSpins,1);assert.equal(first.session.lockedBet,10);
  const ack=await l.module.acknowledge(f.session,{roundId:paid.id});assert.equal(ack.session.pendingRound,null);assert.equal(ack.session.stateVersion,1);
  const body={requestId:'request_bonus',bet:10,expectedVersion:1},bonus=await l.module.spin(f.session,body),frozen=clone(bonus.round);
  assert.equal(bonus.round.cycleId,paid.cycleId);assert.equal(bonus.round.isFreeSpin,true);assert.equal(bonus.round.freeSpinsBefore,1);assert.equal(bonus.round.freeSpinsAfter,0);
  assert.equal(bonus.round.win,.2);assert.equal(bonus.round.engine.totalWin,20);
  assert.equal(bonus.round.balanceBefore,9889.42);assert.equal(bonus.round.balanceAfter,9889.42);assert.equal(bonus.session.balance,9889.42);
  assert.equal(probabilityCoinsToMinor(bonus.round.balanceBefore,2),'988942');assert.equal(bonus.session.freeSpins,0);assert.equal(bonus.session.lockedBet,null);
  assert.deepEqual(f.plays.get(paid.id).payload,paid);assert.deepEqual(f.plays.get(bonus.round.id).payload,frozen);assert.equal(f.plays.get(bonus.round.id).round_index,1);
  const replay=await l.module.spin(f.session,body);assert.equal(replay.session.balance,9899.99);assert.deepEqual(replay.round,frozen);
  assert.equal((await l.module.publicSession(f.session)).balance,9900);
  const done=await l.module.acknowledge(f.session,{roundId:bonus.round.id});assert.equal(done.session.pendingRound,null);assert.equal(done.session.freeSpins,0);assert.equal(done.session.stateVersion,2);assert.equal(done.session.balance,9900.01);
  assert.deepEqual([...f.cycles.values()],[cycle]);assert.deepEqual([...f.operations.values()],operations);assert.deepEqual(f.plays.get(bonus.round.id).payload,frozen);
  assert.equal(f.balanceReads,6);assert.equal(f.playWrites,2);assert.equal(f.plays.size,2);assert.equal(f.cycles.size,1);assert.equal(count(f,'play.acknowledge'),2);
  for(const kind of ['wallet.authorize','wallet.accept','math.compute','result.fixed','wallet.settle'])assert.equal(count(f,kind),1);
 }finally{l.dispose();}
});

test('settled spin uses one fresh balance for its frozen round and response, after wallet settlement',async()=>{
 for(const options of [{},{previous:true},{continuation:true}]){
  const l=await loadFixture(options);try{
   const response=await submit(l),f=l.fixture;
   assert.equal(f.balanceReads,1);assert.equal(f.playWrites,1);
   assert.equal(response.round.balanceAfter,1234.56);assert.equal(response.session.balance,response.round.balanceAfter);
   assert.equal(response.session.stateVersion,1);assert.equal(response.round.settlementStatus,'SETTLED');
   assert.deepEqual(f.plays.get(response.round.id).payload,response.round);
   const phases=f.trace.map(row=>row.kind);
   if(!options.continuation){
    for(const kind of ['wallet.authorize','wallet.accept','math.compute','result.fixed','wallet.settle','cycle.settled'])assert.equal(count(f,kind),1);
    assert.ok(phases.indexOf('wallet.settle')<phases.indexOf('wallet.balance'));
   }else{
    assert.equal(response.round.isFreeSpin,true);assert.equal(response.round.freeSpinsBefore,1);
    assert.equal(count(f,'wallet.authorize'),0);assert.equal(count(f,'math.compute'),0);
   }
   assert.ok(phases.indexOf('wallet.balance')<phases.indexOf('play.insert'));
   assert.ok(f.trace.slice(phases.indexOf('wallet.balance'),phases.indexOf('play.insert')).some(row=>row.kind==='math.profile'));
  }finally{l.dispose();}
 }
});

test('replays and independent session GETs read the latest wallet without changing the frozen round',async()=>{
 const options={balances:['1000','2500','4400'],balanceErrorAt:4},l=await loadFixture(options);try{
  const first=await submit(l),round=structuredClone(first.round),replay=await submit(l);
  assert.equal(first.session.balance,10);assert.equal(replay.session.balance,25);assert.deepEqual(replay.round,round);
  assert.equal((await l.module.publicSession(l.fixture.session)).balance,44);assert.equal(l.fixture.balanceReads,3);
  await assert.rejects(submit(l),e=>e.code==='WALLET_INVALID_SCOPE');
  options.balanceErrorAt=0;options.balances.push('8000','7000');
  assert.equal((await l.module.publicSession(l.fixture.session)).balance,70);
  assert.equal(l.fixture.balanceReads,5);assert.equal(l.fixture.playWrites,1);assert.equal(count(l.fixture,'math.compute'),1);
  assert.deepEqual([...l.fixture.operations.values()].map(v=>v.state),['SUCCEEDED','SUCCEEDED','SUCCEEDED']);
  assert.deepEqual(l.fixture.plays.get(round.id).payload,round);
 }finally{l.dispose();}
});

test('request bodies and publicSession arguments cannot inject the private balance or tenant context',async()=>{
 const l=await loadFixture({continuation:true,balances:['4000','5000']});try{
  const response=await l.module.spin(l.fixture.session,{...request,balance:999999,app_id:'foreign_app',external_user_id:'foreign_user',minor:'999999',app:{id:'foreign_app'}});
  assert.equal(response.session.balance,40);assert.equal(response.round.balanceAfter,40);
  const read=await l.module.publicSession(l.fixture.session,{app:{id:'foreign_app',currency_scale:9},minor:'999999'});
  assert.equal(read.balance,50);assert.equal(l.fixture.appReads,3);assert.equal(l.fixture.balanceReads,2);
  assert.equal(Object.hasOwn(l.module,'readSessionBalance'),false);assert.equal(Object.hasOwn(l.module,'serializePublicSession'),false);
 }finally{l.dispose();}
});

test('concurrent retries settle once and return one round; a conflicting bet makes no further writes',async()=>{
 const l=await loadFixture({balances:Array(4).fill('9000')});try{
  const replies=await Promise.all(Array.from({length:4},()=>submit(l))),f=l.fixture;
  for(const response of replies)assert.deepEqual(normalized(response),normalized(replies[0]));
  assert.equal(f.playWrites,1);assert.equal(f.plays.size,1);assert.equal(f.cycles.size,1);assert.equal(f.operations.size,3);
  for(const kind of ['wallet.authorize','wallet.accept','math.compute','result.fixed','wallet.settle'])assert.equal(count(f,kind),1);
  assert.equal(f.balanceReads,4);assert.equal(f.tails.size,0);assert.deepEqual(f.locks,[]);
  const before=structuredClone({session:f.session,plays:f.plays,cycles:f.cycles,operations:f.operations});
  await assert.rejects(l.module.spin(f.session,{...request,bet:50}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  assert.deepEqual({session:f.session,plays:f.plays,cycles:f.cycles,operations:f.operations},before);
 }finally{l.dispose();}
});

test('invalid fresh wallet or current math profile rejects before the play transaction',async()=>{
 for(const options of [{balanceErrorAt:1},{missingBalanceAt:1},{profile:'invalid'}]){
  const l=await loadFixture({continuation:true,...options});try{
   await assert.rejects(submit(l),e=>['WALLET_INVALID_SCOPE','WALLET_INVALID_BALANCE'].includes(e.code)||e.message==='Unknown math profile');
   assert.equal(l.fixture.playWrites,0);assert.equal(l.fixture.plays.size,0);assert.equal(l.fixture.balanceReads,1);
   assert.equal(count(l.fixture,'tx.begin'),0);assert.equal(count(l.fixture,'wallet.authorize'),0);assert.deepEqual(l.fixture.locks,[]);
  }finally{l.dispose();}
 }
});

test('new cycles check current financial admission and enabled game before authorizing money',async()=>{
 const prod=await loadFixture({production:true});try{
  await assert.rejects(submit(prod),e=>e.code==='PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED');
  assert.equal(prod.fixture.balanceReads,0);assert.equal(count(prod.fixture,'wallet.authorize'),0);assert.equal(prod.fixture.cycles.size,0);
 }finally{prod.dispose();}
 const disabled=await loadFixture();try{
  disabled.fixture.app.game_ids=[];await assert.rejects(submit(disabled),e=>e.code==='GAME_DISABLED');
  assert.equal(count(disabled.fixture,'admission.check'),1);assert.equal(count(disabled.fixture,'wallet.authorize'),0);assert.equal(disabled.fixture.cycles.size,0);
 }finally{disabled.dispose();}
});

test('wallet rejection at authorize, accept or settle preserves the operation and creates no accepted play',async()=>{
 for(const kind of ['authorize','accept','settle']){
  const l=await loadFixture({walletReject:kind});try{
   await assert.rejects(submit(l),e=>e.code===(kind==='settle'?'SETTLEMENT_PENDING':'WALLET_REJECTED'));
   assert.equal(l.fixture.playWrites,0);assert.equal(l.fixture.balanceReads,0);assert.equal(count(l.fixture,'math.compute'),kind==='settle'?1:0);
   const rejected=[...l.fixture.operations.values()].filter(op=>op.state==='REJECTED');
   assert.equal(rejected.length,1);assert.equal(rejected[0].path.split('/').at(-1),kind);
  }finally{l.dispose();}
 }
});

test('play commit failure rolls back play/session; retry reuses the settled result and exact operation bytes',async()=>{
 const options={failPlayCommit:true,balances:Array(2).fill('8000')},l=await loadFixture(options);try{
  await assert.rejects(submit(l),e=>e.code==='P0001');const f=l.fixture;
  assert.equal(f.plays.size,0);assert.equal(f.playWrites,0);assert.equal(f.session.state.version,0);
  assert.equal([...f.cycles.values()][0].status,'SETTLED');const before=structuredClone([...f.operations.values()]);
  assert.equal(count(f,'math.compute'),1);options.failPlayCommit=false;
  const result=await submit(l);assert.equal(result.session.stateVersion,1);assert.equal(f.plays.size,1);
  assert.equal(count(f,'math.compute'),1);assert.equal(count(f,'wallet.settle'),1);assert.deepEqual([...f.operations.values()],before);
  assert.equal(f.balanceReads,2);assert.equal(count(f,'tx.rollback'),1);
 }finally{l.dispose();}
});
