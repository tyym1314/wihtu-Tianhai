import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observeNativeBrowser,cleanupNativeSession,createNativeCleanupApi,runNativeActionOnce,nativeErrorsEmpty,reserveNativeReportDirectory} from '../deploy/native-browser-checks.mjs';

const origin='https://fixture.invalid';
const knownLoss='response.json: Protocol error (Network.getResponseBody): No data found for resource with given identifier';
const state=(overrides={})=>({game:'run',token:'memory-only',sessionId:'original_session',playerId:'owned_player',phase:'playing',returning:false,ownedRooms:new Set(),practiceRequested:false,spins:[],acks:new Set(),creations:[],actionRequests:[],probabilityRequests:[],...overrides});
const request=({path='/api/pvp/rooms/owned',method='GET',type='fetch',body={},failure='net::ERR_FAILED'}={})=>({url:()=>origin+path,method:()=>method,resourceType:()=>type,postDataJSON:()=>body,failure:()=>({errorText:failure})});
function observation(overrides={}){
 const page=new EventEmitter(),current=state(overrides),result={};
 return{page,state:current,result,drain:observeNativeBrowser(page,{origin,state:current,result})};
}
function response(fixture,req,{status=200,json=async()=>({})}={}){
 fixture.page.emit('request',req);
 fixture.page.emit('response',{url:req.url,request:()=>req,status:()=>status,ok:()=>status>=200&&status<300,json});
}
const room=(overrides={})=>({id:'owned',game_id:'run',me:'owned_player',entry_minor:'0',practice:true,status:'cancelled',version:1,...overrides});
const arenaSession=(overrides={})=>({session_id:'original_session',external_user_id:'owned_player',game_id:'run',active_room_id:null,other_active_game:null,...overrides});
const probability=(overrides={})=>({sessionId:'original_session',pendingRound:null,freeSpins:0,...overrides});
function cleanupFixture(current,steps){
 const calls=[];
 const run=()=>cleanupNativeSession({state:current,arenaGames:['run'],newId:()=> 'cleanup_fixture_id',until:async fn=>assert.ok(await fn(),'fixture did not reach terminal state'),api:async(path,body)=>{
  calls.push({path,body});const next=steps.shift();assert.ok(next,`Unexpected cleanup request ${path}`);assert.equal(path,next.path);if(next.error)throw next.error;return next.value;
 }});
 return{run,calls,steps};
}

for(const sample of [
 {name:'playing GET known body loss',path:'/api/pvp/rooms/owned',message:knownLoss},
 {name:'playing POST action generic resource loss',path:'/api/pvp/rooms/owned/action',method:'POST',message:'No resource with given identifier'},
 {name:'returning POST leave invalid JSON',path:'/api/pvp/rooms/owned/leave',method:'POST',phase:'returning',message:'Unexpected end of JSON input'},
 {name:'playing invalid JSON control',path:'/api/pvp/rooms/owned',message:'Unexpected end of JSON input'},
 {name:'returning exact GET loss without reconciliation proof',path:'/api/pvp/rooms/owned',phase:'returning',message:knownLoss},
 {name:'closed target during cleanup',path:'/api/pvp/rooms/owned',phase:'cleanup',message:'Target page, context or browser has been closed'},
])test(`observer retains ${sample.name}`,async()=>{
 const fixture=observation({phase:sample.phase||'playing',returning:sample.phase==='returning'});
 response(fixture,request(sample),{json:async()=>{throw new Error(sample.message);}});await fixture.drain();
 assert.equal(fixture.result.observer_errors.length,1);assert.equal(fixture.result.observer_errors[0].message,sample.message);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

test('request phase cannot be rewritten by a later return flag',async()=>{
 const fixture=observation();let reject;
 response(fixture,request(),{json:()=>new Promise((_resolve,r)=>{reject=r;})});
 fixture.state.returning=true;fixture.state.phase='returning';reject(new Error('Unexpected end of JSON input'));await fixture.drain();
 assert.equal(fixture.result.observer_errors[0].phase,'playing');assert.equal(fixture.result.observer_errors.length,1);
});

for(const status of [302,409,500])test(`fetch HTTP ${status} is recorded without console output`,async()=>{
 const fixture=observation();response(fixture,request(),{status});await fixture.drain();
 assert.equal(fixture.result.http_errors.length,1);assert.equal(fixture.result.http_errors[0].status,status);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

for(const sample of [{phase:'playing',type:'fetch',path:'/api/pvp/rooms/owned'},{phase:'returning',type:'fetch',path:'/api/pvp/rooms/owned'},{phase:'returning',type:'image',path:'/art.png'}])test(`transport failure retained for ${sample.phase} ${sample.type}`,async()=>{
 const fixture=observation({phase:sample.phase,returning:sample.phase==='returning'}),req=request({...sample,failure:'net::ERR_ABORTED'});
 fixture.page.emit('request',req);fixture.page.emit('requestfailed',req);await fixture.drain();
 assert.equal(fixture.result[sample.type==='fetch'?'network_errors':'resource_errors'].length,1);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

test('normal owned create, action and response pass with request evidence',async()=>{
 const fixture=observation();
 response(fixture,request({path:'/api/pvp/rooms',method:'POST',body:{request_id:'create_one',game_id:'run',practice:true,entry_minor:'0'}}),{json:async()=>room({status:'active'})});
 response(fixture,request({path:'/api/pvp/rooms/owned/action',method:'POST',body:{request_id:'action_one',seq:1,action:{type:'jump'}}}),{json:async()=>room({status:'active',version:2})});await fixture.drain();
 assert.equal(nativeErrorsEmpty(fixture.result),true);assert.equal(fixture.state.practiceRequested,true);assert.equal(fixture.state.creations[0].room_id,'owned');assert.equal(fixture.state.ownedRooms.has('owned'),true);
 assert.equal(fixture.result.action_requests.length,1);assert.equal(fixture.result.action_requests[0].status,200);assert.equal(fixture.result.action_requests[0].type,'jump');
});

test('launch exchange may refresh a token but cannot replace the original session',async()=>{
 const fixture=observation();response(fixture,request({path:'/v1/launch/exchange',method:'POST'}),{json:async()=>({game_id:'run',session_id:'another_session',external_user_id:'owned_player',access_token:'another_token'})});await fixture.drain();
 assert.equal(fixture.state.sessionId,'original_session');assert.equal(fixture.state.token,'memory-only');assert.equal(fixture.result.observer_errors.length,1);
});

test('observer drains work added while an earlier response is pending',async()=>{
 const fixture=observation();let finishFirst,finishSecond;
 response(fixture,request(),{json:()=>new Promise(resolve=>{finishFirst=resolve;})});
 const drained=fixture.drain();response(fixture,request(),{json:()=>new Promise(resolve=>{finishSecond=resolve;})});finishFirst(room());
 let complete=false;void drained.then(()=>{complete=true;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(complete,false);
 finishSecond(room());await drained;assert.equal(nativeErrorsEmpty(fixture.result),true);
});

test('observer drain has a bounded failure for an unread response',async()=>{
 const page=new EventEmitter(),current=state(),result={};let finish;
 const drain=observeNativeBrowser(page,{origin,state:current,result,drainTimeoutMs:10});
 response({page},request(),{json:()=>new Promise(resolve=>{finish=resolve;})});
 await assert.rejects(drain(),/drain timed out/);finish(room());await drain();
});

test('Run first 409 fails the gate and is retained; it is not retried',async()=>{
 let count=0;const result={};const rejection=Object.assign(new Error('temporarily busy'),{status:409,code:'BUSY'});
 await assert.rejects(runNativeActionOnce(async()=>{count++;throw rejection;},result),{code:'BUSY'});
 assert.equal(count,1);assert.equal(result.action_attempts.length,1);assert.equal(result.action_attempts[0].http_status,409);assert.equal(result.action_attempts[0].code,'BUSY');assert.equal(result.action_attempts[0].passed,false);
});

test('normal first action records success',async()=>{
 const result={},accepted={httpStatus:200,sequenceBefore:0,sequenceAfter:1};assert.equal(await runNativeActionOnce(async()=>accepted,result),accepted);assert.equal(result.action_attempts[0].passed,true);
});

test('participant forfeiture alone is not terminal cleanup',async()=>{
 const fixture=cleanupFixture(state({practiceRequested:true,ownedRooms:new Set(['owned'])}),[
  {path:'/api/arena/session',value:arenaSession({active_room_id:'owned',other_active_game:'run'})},
  {path:'/api/pvp/rooms/owned',value:room({status:'active',players:[{external_user_id:'owned_player',forfeited:true}]})},
  {path:'/api/pvp/rooms/owned',value:room({status:'active',players:[{external_user_id:'owned_player',forfeited:true}]})},
  {path:'/api/pvp/rooms/owned/leave',value:{}},
  {path:'/api/pvp/rooms/owned',value:room({status:'active'})},
 ]);
 const result=await fixture.run();assert.equal(result.passed,false);assert.equal(result.rooms[0].terminal,false);assert.ok(fixture.calls.some(call=>call.path.endsWith('/leave')));
});

for(const override of [{active_room_id:'owned'},{other_active_game:'bowling'},{session_id:'another_session'},{external_user_id:'another_player'},{game_id:'bowling'}])test(`final arena readback rejects ${Object.keys(override)[0]}`,async()=>{
 const fixture=cleanupFixture(state({ownedRooms:new Set(['owned'])}),[
  {path:'/api/arena/session',value:arenaSession()},{path:'/api/pvp/rooms/owned',value:room()},{path:'/api/arena/session',value:arenaSession(override)}
 ]);assert.equal((await fixture.run()).passed,false);
});

for(const override of [{me:'another_player'},{game_id:'bowling'},{id:'another_room'},{entry_minor:'100'},{practice:false}])test(`cleanup refuses room ${Object.keys(override)[0]} mismatch before mutation`,async()=>{
 const fixture=cleanupFixture(state({ownedRooms:new Set(['owned'])}),[{path:'/api/arena/session',value:arenaSession()},{path:'/api/pvp/rooms/owned',value:room(override)}]);
 assert.equal((await fixture.run()).passed,false);assert.ok(fixture.calls.every(call=>call.body===undefined));
});

test('normal original session, terminal owned room and empty active links pass',async()=>{
 const fixture=cleanupFixture(state({ownedRooms:new Set(['owned']),creations:[{room_id:'owned',status:200}]}),[
  {path:'/api/arena/session',value:arenaSession()},{path:'/api/pvp/rooms/owned',value:room()},{path:'/api/arena/session',value:arenaSession()}
 ]);const result=await fixture.run();assert.equal(result.passed,true);assert.equal(result.rooms[0].terminal,true);assert.equal(result.final_readback.active_room_id,null);assert.equal(result.final_readback.other_active_game,null);
});

test('empty active links cannot prove a lost room creation did not commit',async()=>{
 const fixture=cleanupFixture(state({creations:[{request_id:'uncertain',status:null,room_id:null}]}),[{path:'/api/arena/session',value:arenaSession()},{path:'/api/arena/session',value:arenaSession()}]);
 const result=await fixture.run();assert.equal(result.passed,false);assert.equal(result.unresolved_creations.length,1);
});

test('pendingRound null with freeSpins remaining cannot pass or open an unidentified cycle',async()=>{
 const fixture=cleanupFixture(state({game:'thunder'}),[{path:'/api/play/thunder/session',value:probability({freeSpins:10})}]);
 const result=await fixture.run();assert.equal(result.passed,false);assert.equal(fixture.calls.length,1);assert.equal(result.probability.new_paid_spins,0);
});

test('zero-free-spin original probability session passes without any spin request',async()=>{
 const fixture=cleanupFixture(state({game:'thunder'}),[{path:'/api/play/thunder/session',value:probability()}]);const result=await fixture.run();
 assert.equal(result.passed,true);assert.deepEqual(result.probability.final_readback,{session_id:'original_session',pendingRound:null,freeSpins:0});assert.equal(fixture.calls.length,1);
});

test('only an existing owned free continuation and ACK can be completed during cleanup',async()=>{
 const continuation={id:'free_round',cycleId:'owned_cycle',isFreeSpin:true,settlementStatus:'SETTLED'};
 const fixture=cleanupFixture(state({game:'thunder',spins:[{id:'base',cycleId:'owned_cycle'}],probabilityRequests:[{type:'spin',status:200}]}),[
  {path:'/api/play/thunder/session',value:probability({freeSpins:1,lockedBet:10,betChoices:[10],stateVersion:3})},
  {path:'/api/play/thunder/spin',value:{round:continuation,session:probability({pendingRound:continuation})}},
  {path:'/api/play/thunder/session',value:probability({pendingRound:continuation})},
  {path:'/api/play/thunder/ack',value:{session:probability()}},
  {path:'/api/play/thunder/session',value:probability()},
 ]);const result=await fixture.run();assert.equal(result.passed,true);assert.equal(result.probability.new_paid_spins,0);assert.equal(result.probability.free_continuations.length,1);assert.deepEqual(fixture.calls.find(call=>call.path.endsWith('/spin')).body,{requestId:'cleanup_fixture_id',bet:10,expectedVersion:3});
});

for(const override of [{isFreeSpin:false},{cycleId:'another_cycle'},{settlementStatus:'PENDING'}])test(`existing free continuation rejects ${Object.keys(override)[0]} mismatch`,async()=>{
 const fixture=cleanupFixture(state({game:'thunder',spins:[{cycleId:'owned_cycle'}]}),[
  {path:'/api/play/thunder/session',value:probability({freeSpins:1,lockedBet:10,betChoices:[10],stateVersion:3})},
  {path:'/api/play/thunder/spin',value:{session:probability(),round:{id:'free',cycleId:'owned_cycle',isFreeSpin:true,settlementStatus:'SETTLED',...override}}},
 ]);const result=await fixture.run();assert.equal(result.passed,false);assert.equal(result.probability.new_paid_spins,override.isFreeSpin===false?1:0);assert.equal(fixture.calls.length,2);
});

test('probability final readback must retain the original session after ACK',async()=>{
 const pending={id:'pending',cycleId:'owned_cycle',settlementStatus:'SETTLED'};
 const fixture=cleanupFixture(state({game:'tiger'}),[
  {path:'/api/play/tiger/session',value:probability({pendingRound:pending})},{path:'/api/play/tiger/ack',value:{session:probability()}},{path:'/api/play/tiger/session',value:probability({sessionId:'another_session'})}
 ]);assert.equal((await fixture.run()).passed,false);
});

test('empty presentation cannot erase an uncertain spin request',async()=>{
 const fixture=cleanupFixture(state({game:'tiger',probabilityRequests:[{type:'spin',request_id:'uncertain',status:null,transport_error:'NETWORK_ERROR'}]}),[{path:'/api/play/tiger/session',value:probability()}]);
 const result=await fixture.run();assert.equal(result.passed,false);assert.equal(result.probability.uncertain_spins.length,1);
});

for(const sample of ['http','transport','json'])test(`cleanup API retains ${sample} failures`,async()=>{
 const result={},page={request:{fetch:async()=>{if(sample==='transport')throw new Error('connection lost');return{ok:()=>sample!=='http',status:()=>sample==='http'?500:200,json:async()=>{throw new Error('invalid JSON');}};}}};
 const api=createNativeCleanupApi({page,origin,state:state(),result});await assert.rejects(api('/api/arena/session'));
 assert.equal(result.cleanup_requests.length,1);assert.equal(result[sample==='http'?'http_errors':sample==='transport'?'network_errors':'observer_errors'].length,1);
});

test('cleanup API does not follow redirects or put its bearer token into evidence',async()=>{
 const result={};let options;
 const page={request:{fetch:async(_url,input)=>{options=input;return{ok:()=>false,status:()=>302};}}};
 const api=createNativeCleanupApi({page,origin,state:state(),result});await assert.rejects(api('/api/pvp/rooms/owned/leave',{request_id:'original_cleanup'}),/302/);
 assert.equal(options.maxRedirects,0);assert.equal(options.headers.authorization,'Bearer memory-only');assert.equal(result.cleanup_requests[0].request_id,'original_cleanup');assert.equal(JSON.stringify(result).includes('memory-only'),false);
});

test('report reservation refuses nonempty directories without replacing old evidence',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'native-browser-checks-'));try{
  await fs.writeFile(join(root,'first-failure.png'),'first failure');await assert.rejects(reserveNativeReportDirectory(root,{passed:false}),/OUTPUT_ALREADY_EXISTS/);
  assert.equal(await fs.readFile(join(root,'first-failure.png'),'utf8'),'first failure');await assert.rejects(fs.stat(join(root,'native-browser.json')),{code:'ENOENT'});
  const fresh=join(root,'fresh');await reserveNativeReportDirectory(fresh,{passed:false});const original=await fs.readFile(join(fresh,'native-browser.json'),'utf8');
  await assert.rejects(reserveNativeReportDirectory(fresh,{passed:true}),/OUTPUT_ALREADY_EXISTS/);assert.equal(await fs.readFile(join(fresh,'native-browser.json'),'utf8'),original);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
