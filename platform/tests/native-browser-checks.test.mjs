import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {observeNativeBrowser,createNativeFetchEvidence,installNativeFetchProbe,cleanupNativeSession,createNativeCleanupApi,runNativeActionOnce,nativeErrorsEmpty,reserveNativeReportDirectory} from '../deploy/native-browser-checks.mjs';
import {replayNativeFetchReport} from './native-fetch-cancellation-replay.mjs';

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
const room=(overrides={})=>({id:'owned',game_id:'run',me:'owned_player',entry_minor:'0',practice:true,status:'cancelled',version:1,game:{gameId:'run',me:'owned_player',ruleVersion:'run-fixture',physicsVersion:'physics-fixture',snapshotTick:1},...overrides});
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

function cancellationFixture({requestOptions={},stateOptions={},traceOptions={},timing=115,frameUrl=origin+'/play/run',redirected=false}={}){
 const page=new EventEmitter(),current=state({ownedRooms:new Set(['owned']),...stateOptions}),result={},probe=createNativeFetchEvidence(),frame={url:()=>frameUrl};
 const req={...request({failure:'net::ERR_ABORTED',...requestOptions}),frame:()=>frame,postData:()=>requestOptions.method==='POST'?'{}':null,timing:()=>({startTime:timing}),redirectedFrom:()=>redirected?{}:null,redirectedTo:()=>null};
 const reason={name:'AbortError',message:'OASIS_ROOM_POLL_STOPPED'},base={document_id:'fixture-document'};
 const trace=[
  {...base,event_seq:1,at_ms:100,kind:'document',frame_url:frameUrl},
  {...base,event_seq:2,at_ms:110,kind:'start',attempt_id:1,url:req.url(),method:req.method(),body_present:false,supported:true,frame_url:frameUrl,...traceOptions.start},
  {...base,event_seq:3,at_ms:130,kind:'abort',attempt_id:1,reason,already_aborted:false,...traceOptions.abort},
  {...base,event_seq:4,at_ms:135,kind:'rejected',attempt_id:1,signal_aborted:true,reject_is_signal_reason:true,sync_throw:false,reason,error:reason,...traceOptions.end},
 ];
 const drain=observeNativeBrowser(page,{origin,state:current,result,fetchProbe:probe});
 const deliver=(events=trace,target=frame)=>{for(const event of events)probe.receive(target,event);};
 const fail=()=>{page.emit('request',req);page.emit('requestfailed',req);};
 return{page,state:current,result,probe,frame,req,trace,deliver,fail,drain};
}

for(const message of ['OASIS_ROOM_POLL_STOPPED','OASIS_ROOM_POLL_BACKGROUND'])test(`actual first ${message} rejection has a separate lifecycle classification and immutable raw failure`,async()=>{
 const reason={name:'AbortError',message},fixture=cancellationFixture({traceOptions:{abort:{reason},end:{reason,error:reason}}});
 fixture.deliver();fixture.fail();assert.equal(nativeErrorsEmpty(fixture.result),false);await fixture.drain();
 assert.equal(nativeErrorsEmpty(fixture.result),true);assert.equal(fixture.result.lifecycle_cancellations.length,1);assert.equal(fixture.result.network_observations.length,1);assert.equal(Object.isFrozen(fixture.result.network_observations[0]),true);assert.equal(fixture.result.fetch_observations.length,4);
 assert.equal(fixture.result.lifecycle_cancellations[0].reason.message,message);assert.equal(fixture.result.lifecycle_cancellations[0].fetch_attempt_id,1);
});

for(const [name,options] of [
 ['timeout first',{traceOptions:{abort:{reason:{name:'TimeoutError',message:'OASIS_ROOM_POLL_TIMEOUT'}}}}],
 ['unknown reason',{traceOptions:{abort:{reason:{name:'AbortError',message:'UNKNOWN'}}}}],
 ['different rejection',{traceOptions:{end:{error:{name:'TypeError',message:'Failed to fetch'}}}}],
 ['rejection not actual reason',{traceOptions:{end:{reject_is_signal_reason:false}}}],
 ['pre-aborted signal',{traceOptions:{abort:{already_aborted:true}}}],
 ['no aborted signal',{traceOptions:{end:{signal_aborted:false}}}],
 ['synchronous throw',{traceOptions:{end:{sync_throw:true}}}],
 ['unsupported fetch input',{traceOptions:{start:{supported:false}}}],
 ['request body',{traceOptions:{start:{body_present:true}}}],
 ['POST mutation',{requestOptions:{method:'POST',path:'/api/pvp/rooms/owned/action'}}],
 ['arena session GET',{requestOptions:{path:'/api/arena/session'}}],
 ['unowned room',{requestOptions:{path:'/api/pvp/rooms/another'}}],
 ['query parameters',{requestOptions:{path:'/api/pvp/rooms/owned?unexpected=1'}}],
 ['non-abort transport error',{requestOptions:{failure:'net::ERR_EMPTY_RESPONSE'}}],
 ['wrong frame URL',{frameUrl:origin+'/play/bowling'}],
 ['missing session',{stateOptions:{sessionId:null}}],
 ['missing player',{stateOptions:{playerId:null}}],
 ['missing network time',{timing:undefined}],
 ['negative network time',{timing:-1}],
 ['redirected request',{redirected:true}],
 ['wrong full URL',{traceOptions:{start:{url:origin+'/api/pvp/rooms/owned?other=1'}}}],
 ['abort time before fetch',{traceOptions:{abort:{at_ms:109}}}],
])test(`lifecycle classifier fails closed for ${name}`,async()=>{
 const fixture=cancellationFixture(options);if(name==='missing network time')fixture.req.timing=()=>({});fixture.deliver();fixture.fail();await fixture.drain();
 assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);assert.equal(fixture.result.network_observations.length,1);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

test('later room ownership cannot be used to classify an earlier request',async()=>{
 const fixture=cancellationFixture({stateOptions:{ownedRooms:new Set()}});fixture.deliver();fixture.page.emit('request',fixture.req);fixture.state.ownedRooms.add('owned');fixture.page.emit('requestfailed',fixture.req);await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);
});

test('response headers and JSON body loss cannot be reclassified even with an abort trace',async()=>{
 const fixture=cancellationFixture();fixture.deliver();response(fixture,fixture.req,{json:async()=>{throw new Error(knownLoss);}});fixture.page.emit('requestfailed',fixture.req);await fixture.drain();
 assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors[0].classification_failure,'RESPONSE_HEADERS_OBSERVED');assert.equal(fixture.result.observer_errors.length,1);
});

test('missing first abort or terminal event cannot classify a network failure',async()=>{
 for(const omitted of ['abort','rejected','document']){
  const fixture=cancellationFixture();fixture.deliver(fixture.trace.filter(event=>event.kind!==omitted));fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);
 }
});

test('trace from another Frame cannot classify the request',async()=>{
 const fixture=cancellationFixture();fixture.deliver(fixture.trace,{url:()=>origin+'/play/run'});fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);
});

test('duplicate telemetry sequence is a strict observer failure',async()=>{
 const fixture=cancellationFixture();fixture.deliver();fixture.deliver([fixture.trace[1]]);fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.observer_errors[0].message,'CONFLICTING_FETCH_PROBE_EVENT');
});

test('a successful or unsupported overlapping fetch also prevents unique matching',async()=>{
 for(const supported of [true,false]){
  const fixture=cancellationFixture();fixture.deliver();fixture.deliver([
   {...fixture.trace[0],document_id:'second-document'},
   {...fixture.trace[1],document_id:'second-document',supported},
   {...fixture.trace[3],document_id:'second-document',event_seq:3,kind:'fulfilled'},
  ]);fixture.fail();await fixture.drain();assert.equal(fixture.result.network_errors[0].classification_failure,supported?'AMBIGUOUS_FETCH_ATTEMPT':'UNSUPPORTED_COMPETING_FETCH');assert.equal(fixture.result.lifecycle_cancellations.length,0);
 }
});

test('one fetch proof cannot classify two network requests',async()=>{
 const fixture=cancellationFixture();fixture.deliver();fixture.fail();const other={...fixture.req};fixture.page.emit('request',other);fixture.page.emit('requestfailed',other);await fixture.drain();assert.equal(fixture.result.network_errors.length,2);assert.ok(fixture.result.network_errors.every(error=>error.classification_failure==='AMBIGUOUS_NETWORK_REQUEST'));
});

test('late evidence destroying uniqueness revokes exemption and retains original observation',async()=>{
 const fixture=cancellationFixture();fixture.deliver();fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,1);
 fixture.deliver(fixture.trace.map(event=>({...event,document_id:'late-document'})));await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);assert.equal(fixture.result.network_observations.length,1);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

test('evidence received during drain is considered before classification',async()=>{
 const fixture=cancellationFixture();fixture.probe.flush=async()=>{await new Promise(resolve=>setTimeout(resolve,5));fixture.deliver();};fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,1);
});

test('once missing proof failed a drain, later evidence cannot erase that failure',async()=>{
 const fixture=cancellationFixture();fixture.fail();await fixture.drain();fixture.deliver();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

function networkProof(fixture,overrides={}){
 fixture.probe.receiveNetworkDocument('protocol-frame',fixture.trace[0]);
 fixture.probe.network.set('protocol-request',{id:'protocol-request',frame:'protocol-frame',url:fixture.req.url(),method:fixture.req.method(),type:'Fetch',started_at_ms:115,failed_at_ms:132,response_seen:false,redirected:false,error:'net::ERR_ABORTED',cancelled:true,...overrides});
}

test('zero Playwright timing requires an independently joined document and actual CDP network clock',async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();networkProof(fixture);fixture.fail();await fixture.drain();
 assert.equal(fixture.result.lifecycle_cancellations.length,1);assert.equal(fixture.result.lifecycle_cancellations[0].network_timing_source,'cdp');assert.equal(fixture.result.lifecycle_cancellations[0].network_protocol_id,'protocol-request');assert.equal(fixture.result.network_protocol_observations.length,1);
});

for(const [name,override] of [['wrong URL',{url:origin+'/api/pvp/rooms/owned?different=1'}],['wrong method',{method:'POST'}],['wrong frame',{frame:'other-frame'}],['non-fetch',{type:'XHR'}],['not cancelled',{cancelled:false}],['headers seen',{response_seen:true}],['redirect',{redirected:true}],['invalid failure time',{failed_at_ms:100}]])test(`CDP fallback refuses ${name}`,async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();networkProof(fixture,override);fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);
});

test('CDP document identity must match the independent Playwright binding exactly',async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();fixture.probe.receiveNetworkDocument('protocol-frame',{...fixture.trace[0],at_ms:99});fixture.probe.network.set('protocol-request',{id:'protocol-request',frame:'protocol-frame',url:fixture.req.url(),method:'GET',type:'Fetch',started_at_ms:115,failed_at_ms:132,error:'net::ERR_ABORTED',cancelled:true});fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);
});

test('multiple CDP failures with the same URL and frame cannot be guessed by arrival order',async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();networkProof(fixture);fixture.probe.network.set('another',{...fixture.probe.network.get('protocol-request'),id:'another',started_at_ms:120});fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors[0].classification_failure,'AMBIGUOUS_CDP_NETWORK_FAILURE');
});

test('302 successful polls with displaced Playwright clocks cannot become CDP failure candidates',async()=>{
 const fixture=cancellationFixture({timing:0}),trace=[fixture.trace[0]];
 for(let index=0;index<302;index++){
  const start=200+index*20,id=`successful-${index}`;
  trace.push({...fixture.trace[1],event_seq:trace.length+1,at_ms:start,attempt_id:index+2});
  trace.push({...fixture.trace[3],event_seq:trace.length+1,at_ms:start+10,attempt_id:index+2,kind:'fulfilled',signal_aborted:false,reason:null});
  const previous={...fixture.req,timing:()=>({startTime:start+1.646})};
  response(fixture,previous,{json:async()=>room()});
  fixture.probe.network.set(id,{id,frame:'protocol-frame',url:fixture.req.url(),method:'GET',type:'Fetch',started_at_ms:start,response_seen:true,redirected:false});
 }
 for(const event of fixture.trace.slice(1))trace.push({...event,event_seq:trace.length+1,at_ms:event.at_ms+10000});
 fixture.deliver(trace);networkProof(fixture,{started_at_ms:10115,failed_at_ms:10132});fixture.fail();await fixture.drain();
 assert.equal(fixture.result.network_protocol_observations.length,303);
 assert.equal(fixture.result.lifecycle_cancellations.length,1);assert.equal(fixture.result.lifecycle_cancellations[0].network_protocol_id,'protocol-request');
 assert.equal(fixture.result.unmatched_fetch_rejections.length,0);assert.equal(nativeErrorsEmpty(fixture.result),true);
});

for(const [name,override] of [
 ['unfinished earlier request',{started_at_ms:105}],
 ['second explicit non-abort failure',{error:'net::ERR_CONNECTION_RESET',cancelled:false}],
 ['headers followed by body failure',{response_seen:true,error:'net::ERR_ABORTED',cancelled:true}],
])test(`zero timing retains ambiguity for ${name}`,async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();networkProof(fixture);
 fixture.probe.network.set('competitor',{id:'competitor',frame:'protocol-frame',url:fixture.req.url(),method:'GET',type:'Fetch',started_at_ms:112,response_seen:false,redirected:false,...override});
 fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors[0].classification_failure,'AMBIGUOUS_CDP_NETWORK_FAILURE');
});

for(const [name,options] of [
 ['POST',{requestOptions:{method:'POST',path:'/api/pvp/rooms/owned/action'}}],
 ['timeout',{traceOptions:{abort:{reason:{name:'TimeoutError',message:'OASIS_ROOM_POLL_TIMEOUT'}},end:{reason:{name:'TimeoutError',message:'OASIS_ROOM_POLL_TIMEOUT'},error:{name:'TimeoutError',message:'OASIS_ROOM_POLL_TIMEOUT'}}}}],
 ['unknown reason',{traceOptions:{abort:{reason:{name:'AbortError',message:'UNKNOWN'}},end:{reason:{name:'AbortError',message:'UNKNOWN'},error:{name:'AbortError',message:'UNKNOWN'}}}}],
])test(`unique zero-timing CDP failure does not exempt ${name}`,async()=>{
 const fixture=cancellationFixture({timing:0,...options});fixture.deliver();networkProof(fixture);fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);
});

test('zero timing with only successful CDP records remains missing proof',async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();networkProof(fixture,{response_seen:true,error:undefined});fixture.fail();await fixture.drain();
 assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors[0].classification_failure,'MISSING_CDP_NETWORK_PROOF');
});

test('zero-timing failure with response headers and JSON loss cannot become a lifecycle cancellation',async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();networkProof(fixture,{response_seen:true});
 response(fixture,fixture.req,{json:async()=>{throw new Error(knownLoss);}});fixture.page.emit('requestfailed',fixture.req);await fixture.drain();
 assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors[0].classification_failure,'RESPONSE_HEADERS_OBSERVED');assert.equal(fixture.result.observer_errors.length,1);
});

test('CDP document cannot borrow a different document abort in the same frame',async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();networkProof(fixture);
 const replacement={...fixture.trace[0],document_id:'replacement-document',at_ms:108};
 fixture.deliver([replacement]);fixture.probe.receiveNetworkDocument('protocol-frame',replacement);
 fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors[0].classification_failure,'CONFLICTING_NETWORK_DOCUMENT');
});

function attachmentFixture(){
 const sessions=[],context=Object.assign(new EventEmitter(),{pages:()=>[],exposeBinding:async()=>{},addInitScript:async()=>{},newCDPSession:async()=>{const session=new EventEmitter();session.commands=[];session.send=async(method,args)=>session.commands.push({method,args});sessions.push(session);return session;}});
 return{context,sessions};
}
test('CDP request/frame identities are isolated across attachment sessions',async()=>{
 const {context,sessions}=attachmentFixture(),probe=await installNativeFetchProbe(context),page=()=>({isClosed:()=>false});
 await probe.attach(page());await probe.attach(page());
 for(const session of sessions)session.emit('Network.requestWillBeSent',{requestId:'shared-id',frameId:'shared-frame',request:{url:origin+'/api/pvp/rooms/owned',method:'GET'},wallTime:1,timestamp:1,type:'Fetch'});
 sessions[0].emit('Network.loadingFailed',{requestId:'shared-id',timestamp:1.01,errorText:'net::ERR_ABORTED',canceled:true});sessions[1].emit('Network.responseReceived',{requestId:'shared-id'});
 const rows=[...probe.network.values()];assert.equal(rows.length,2);assert.notEqual(rows[0].session_id,rows[1].session_id);assert.notEqual(rows[0].frame,rows[1].frame);
 assert.equal(rows[0].error,'net::ERR_ABORTED');assert.equal(rows[1].error,undefined);assert.equal(rows[0].response_seen,false);assert.equal(rows[1].response_seen,true);
 await probe.networkFlush();assert.ok(sessions.every(session=>session.commands.some(value=>value.method==='Runtime.evaluate')));
});

test('duplicate concurrent attachment fails closed before creating a second observer',async()=>{
 const {context,sessions}=attachmentFixture(),probe=await installNativeFetchProbe(context),page={isClosed:()=>false};
 const first=probe.attach(page);await assert.rejects(probe.attach(page),/DUPLICATE_NETWORK_PAGE_ATTACHMENT/);await first;
 assert.equal(sessions.length,1);assert.deepEqual(probe.errors,['DUPLICATE_NETWORK_PAGE_ATTACHMENT']);
});

test('one document observed from two CDP sessions cannot acquire a guessed owner',()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();fixture.probe.receiveNetworkDocument('session-one:frame',fixture.trace[0]);fixture.probe.receiveNetworkDocument('session-two:frame',fixture.trace[0]);
 assert.deepEqual(fixture.probe.errors,['CONFLICTING_NETWORK_DOCUMENT']);
 assert.deepEqual(fixture.probe.classify({},[]),{eligible:false,reason:'FETCH_PROBE_PROTOCOL_ERROR'});
});

test('offline replay normalizes origin without changing the source verdict or evidence',()=>{
 const fixture=cancellationFixture({timing:0});networkProof(fixture);
 const report={origin:origin+'/',passed:false,initial_session:{game_id:'run',session_id:'original_session',external_user_id:'owned_player'},room:{id:'owned'},requests:[{id:1,url:fixture.req.url(),method:'GET',type:'fetch',frame_url:origin+'/play/run',transport_error:'net::ERR_ABORTED',timing:{startTime:0}}],network:{fetch_observations:fixture.trace.map(event=>({...event,frame_id:'frame-1'})),network_protocol_observations:[{...fixture.probe.network.get('protocol-request'),frame_id:'frame-1',document_id:'fixture-document'}],network_observations:[{observation_id:'network-1',path:'/api/pvp/rooms/owned',method:'GET',frame_id:'frame-1',session_id:'original_session',player_id:'owned_player',game_frame_request:true,error:'net::ERR_ABORTED'}]}};
 const before=JSON.stringify(report),replay=replayNativeFetchReport(report);
 assert.equal(replay.original_report_passed,false);assert.equal(replay.associations[0].classification.eligible,true);assert.equal(replay.associations[0].classification.proof.network_session_id,null);assert.equal(replay.unmatched_fetch_rejections.length,0);assert.equal(JSON.stringify(report),before);
 report.origin='https://unrelated.invalid';assert.equal(replayNativeFetchReport(report).associations[0].classification.eligible,false);
});

test('one CDP failure cannot explain multiple Playwright failures',async()=>{
 const fixture=cancellationFixture({timing:0});fixture.deliver();networkProof(fixture);fixture.fail();const other={...fixture.req};fixture.page.emit('request',other);fixture.page.emit('requestfailed',other);await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,2);
});

test('missing request-start observation never acquires ownership at failure time',async()=>{
 const fixture=cancellationFixture();fixture.deliver();fixture.page.emit('requestfailed',fixture.req);await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);
});

test('clock quantization expands every candidate interval and never chooses the nearest fetch',async()=>{
 const fixture=cancellationFixture({timing:109.9});fixture.deliver();fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,1);assert.equal(fixture.result.lifecycle_cancellations[0].clock_uncertainty_ms,1);
 fixture.deliver([
  {...fixture.trace[0],document_id:'previous-document',at_ms:95},
  {...fixture.trace[1],document_id:'previous-document',at_ms:105},
  {...fixture.trace[3],document_id:'previous-document',kind:'fulfilled',event_seq:3,at_ms:109.5},
 ]);await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors[0].classification_failure,'AMBIGUOUS_FETCH_ATTEMPT');
});

test('an unsupported fetch with unknown URL is never excluded from temporal ambiguity',async()=>{
 const fixture=cancellationFixture();fixture.deliver();fixture.deliver([
  {...fixture.trace[0],document_id:'unsupported-document'},
  {...fixture.trace[1],document_id:'unsupported-document',supported:false,url:'',method:''},
 ]);fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors[0].classification_failure,'UNSUPPORTED_COMPETING_FETCH');
});

for(const contradiction of ['headers','headers without failure event','different failure','duplicate failure','uncancelled','redirect','clock'])test(`usable Playwright timing cannot ignore later CDP ${contradiction}`,async()=>{
 const fixture=cancellationFixture();fixture.deliver();networkProof(fixture);fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,1);
 const record=fixture.probe.network.get('protocol-request');
 if(contradiction==='headers')record.response_seen=true;
 if(contradiction==='headers without failure event'){record.response_seen=true;delete record.error;}
 if(contradiction==='different failure')record.error='net::ERR_CONNECTION_RESET';
 if(contradiction==='duplicate failure')fixture.probe.network.set('duplicate',{...record,id:'duplicate'});
 if(contradiction==='uncancelled')record.cancelled=false;
 if(contradiction==='redirect')record.redirected=true;
 if(contradiction==='clock')record.started_at_ms=105;
 await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);assert.ok(fixture.result.network_errors[0].previous_lifecycle_classification);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

test('failed telemetry drain remains a recorded observer failure after later successful drains',async()=>{
 const fixture=cancellationFixture();fixture.deliver();fixture.fail();fixture.probe.flush=async()=>{throw new Error('lost probe checkpoint');};await assert.rejects(fixture.drain(),/lost probe/);fixture.probe.flush=async()=>{};await fixture.drain();assert.equal(fixture.result.observer_errors.length,1);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

for(const reason of [{name:'TimeoutError',message:'OASIS_ROOM_POLL_TIMEOUT'},{name:'AbortError',message:'OASIS_ROOM_POLL_STOPPED'},{name:'TypeError',message:'Invalid GET body'}])test(`networkless caught ${reason.name} fetch rejection remains a failure`,async()=>{
 const fixture=cancellationFixture({traceOptions:{abort:{already_aborted:true,reason},end:{reason,error:reason}}});fixture.deliver();await fixture.drain();assert.equal(fixture.result.network_observations.length,0);assert.equal(fixture.result.unmatched_fetch_rejections.length,1);assert.equal(fixture.result.observer_errors.length,1);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

test('an earlier networkless timeout cannot hide behind a later valid same-URL cancellation',async()=>{
 const fixture=cancellationFixture();fixture.deliver();fixture.fail();await fixture.drain();assert.equal(nativeErrorsEmpty(fixture.result),true);
 const reason={name:'TimeoutError',message:'OASIS_ROOM_POLL_TIMEOUT'};fixture.deliver(fixture.trace.map(event=>({...event,document_id:'earlier-document',at_ms:event.at_ms-50,...(event.reason?{reason}:{}),...(event.error?{error:reason}:{})})));await fixture.drain();
 assert.equal(fixture.result.lifecycle_cancellations.length,1);assert.equal(fixture.result.unmatched_fetch_rejections.length,1);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

for(const type of ['fetch','xhr'])test(`${type} resource failures outside API paths stay strict`,async()=>{
 const fixture=observation(),req=request({path:'/arena/assets/model-1234abcd.glb',type,failure:'net::ERR_ABORTED'});response(fixture,req);fixture.page.emit('requestfailed',req);await fixture.drain();assert.equal(fixture.result.network_errors.length,1);assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

for(const type of ['fetch','xhr'])test(`${type} resource HTTP errors outside API paths stay strict`,async()=>{
 const fixture=observation();response(fixture,request({path:'/arena/assets/model-1234abcd.glb',type}),{status:404});await fixture.drain();assert.equal(fixture.result.http_errors.length,1);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

test('orphan rejected telemetry without a start or network event is a permanent failure',async()=>{
 const fixture=cancellationFixture();fixture.deliver([fixture.trace[3]]);await fixture.drain();assert.equal(fixture.result.network_observations.length,0);assert.equal(fixture.result.unmatched_fetch_rejections.length,1);assert.equal(fixture.result.unmatched_fetch_rejections[0].started_at_ms,null);assert.equal(nativeErrorsEmpty(fixture.result),false);
});

test('foreign-origin fetch with an owned room pathname cannot use the lifecycle exemption',async()=>{
 const fixture=cancellationFixture();fixture.req.url=()=> 'https://another.invalid/api/pvp/rooms/owned';fixture.trace[1].url=fixture.req.url();fixture.deliver();fixture.fail();await fixture.drain();assert.equal(fixture.result.lifecycle_cancellations.length,0);assert.equal(fixture.result.network_errors.length,1);assert.equal(fixture.result.network_errors[0].classification_failure,'NOT_OWNED_READ_ONLY_ROOM_POLL');
});

function nativeInputFixture(){
 const before=room({status:'active',game:{gameId:'run',me:'owned_player',physicsVersion:'fixture',ruleVersion:'pvp-run-v2.3.0',snapshotTick:1,
  players:[{key:'owned_player',isBot:false,inputNo:0},{key:'bot',isBot:true,inputNo:0}]},
  run_inputs:{protocol:'run-practice-inputs-v1',ruleVersion:'pvp-run-v2.3.0',roomId:'owned',playerKey:'owned_player',clockEpoch:1,revision:1,headTick:1,serverTick:1,committedThroughTick:0,processedThroughCommandSeq:0,acceptedInputNo:0,decisions:[]}});
 const body={request_id:'input_request_exact',roomId:'owned',playerKey:'owned_player',clockEpoch:1,baseRevision:1,commands:[{commandSeq:1,type:'jump',executeTick:2}]};
 const after=structuredClone(before);after.version=2;after.request_id=body.request_id;after.game.players[0].inputNo=1;
 Object.assign(after.run_inputs,{revision:2,processedThroughCommandSeq:1,acceptedInputNo:1,decisions:[{commandSeq:1,type:'jump',executeTick:2,clockEpoch:1,outcome:'accepted',code:null,acceptedInputNo:1,decidedAtServerTick:1,revision:2,duplicate:false}]});
 const req={...request({path:'/api/pvp/rooms/owned/inputs',method:'POST',body}),frame:()=>({url:()=>origin+'/play/run'})};
 return{before,body,after,req};
}
test('native observer records V2.3 inputs separately and binds its exact accepted receipt',async()=>{
 const f=nativeInputFixture(),h=observation({room:f.before,ownedRooms:new Set(['owned'])});
 response(h,f.req,{json:async()=>f.after});await h.drain();
 assert.equal(nativeErrorsEmpty(h.result),true);assert.equal(h.state.actionRequests.length,0);assert.equal(h.state.inputsRequests.length,1);
 const observed=h.result.inputs_requests[0];assert.equal(observed.status,200);assert.equal(observed.validated,true);
 assert.equal(observed.proof.requestId,f.body.request_id);assert.equal(observed.proof.acceptedInputNoBefore,0);assert.equal(observed.proof.acceptedInputNoAfter,1);
});
for(const [label,change]of [
 ['wrong response request id',f=>f.after.request_id='wrong_request_id'],
 ['no exact decision',f=>f.after.run_inputs.decisions=[]],
 ['business rejection',f=>Object.assign(f.after.run_inputs.decisions[0],{outcome:'rejected',code:'BUSY',acceptedInputNo:null})],
 ['wrong input number',f=>f.after.run_inputs.decisions[0].acceptedInputNo=2],
 ['wrong epoch',f=>f.after.run_inputs.clockEpoch=2],
 ['wrong frame',f=>f.req.frame=()=>({url:()=>origin+'/demo/'})],
])test('native observer never treats 2xx '+label+' as accepted input',async()=>{
 const f=nativeInputFixture();change(f);const h=observation({room:f.before,ownedRooms:new Set(['owned'])});response(h,f.req,{json:async()=>f.after});await h.drain();
 assert.equal(h.result.inputs_requests.length,1);assert.equal(h.result.inputs_requests[0].status,200);assert.equal(nativeErrorsEmpty(h.result),false);assert.ok(h.result.observer_errors.length);
});
test('GET progress has no input request or accepted POST evidence',async()=>{
 const f=nativeInputFixture(),h=observation({room:f.before});delete f.after.request_id;f.after.run_inputs.decisions=[];
 response(h,request(),{json:async()=>f.after});await h.drain();assert.equal(nativeErrorsEmpty(h.result),true);
 assert.equal(h.state.inputsRequests.length,0);assert.equal(h.state.actionRequests.length,0);assert.equal(h.state.room.run_inputs.acceptedInputNo,1);
});
test('input body loss, HTTP failure and transport cancellation remain strict failures',async()=>{
 for(const kind of ['body','http','transport']){
  const f=nativeInputFixture(),h=observation({room:f.before});
  if(kind==='transport'){h.page.emit('request',f.req);h.page.emit('requestfailed',f.req);}
  else response(h,f.req,{status:kind==='http'?409:200,json:async()=>{if(kind==='body')throw Error(knownLoss);return f.after;}});
  await h.drain();assert.equal(nativeErrorsEmpty(h.result),false);assert.equal(h.state.inputsRequests.length,1);assert.equal(h.state.inputsRequests[0].validated,false);
 }
});
test('overlapping or repeated input POSTs retain two independent requests instead of deduping evidence',async()=>{
 const f=nativeInputFixture(),h=observation({room:f.before});response(h,f.req,{json:async()=>f.after});response(h,{...f.req},{json:async()=>f.after});await h.drain();
 assert.equal(h.state.inputsRequests.length,2);assert.equal(h.state.actionRequests.length,0);
});

test('original init function initializes about: without randomUUID and preserves fetch',async()=>{
 const {context}=attachmentFixture();let init,args;
 context.addInitScript=async(fn,values)=>{init=fn;args=values;};await installNativeFetchProbe(context);
 const events=[],response={fixture:true},fetch=function(...values){assert.equal(values[0],'/fixture');return Promise.resolve(response);};
 const sandbox={crypto:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},fetch,URL,Request,AbortSignal,location:{href:'about:blank'},performance:{timeOrigin:1000,now:()=>1},[args.bindingName]:async event=>events.push(event)};
 vm.runInNewContext(`(${init.toString()})(${JSON.stringify(args)})`,sandbox);
 assert.equal(events[0].kind,'document');assert.equal(events[0].frame_url,'about:blank');assert.match(events[0].document_id,/^[0-9a-f]{32}$/);
 assert.equal(await sandbox.fetch('/fixture'),response);const proof=await sandbox[args.flushName]();
 assert.equal(proof.fetch_wrapper_intact,true);assert.equal(proof.lost,false);assert.equal(events.at(-1).kind,'checkpoint');
 sandbox.fetch=fetch;assert.equal((await sandbox[args.flushName]()).fetch_wrapper_intact,false);
});

test('page creation errors before the main observer are retained once and future errors are live',async()=>{
 const {context}=attachmentFixture(),probe=await installNativeFetchProbe(context),page=Object.assign(new EventEmitter(),{url:()=> 'about:blank'});
 context.emit('page',page);page.emit('pageerror',new Error('initial realm failure'));
 const result={},drain=observeNativeBrowser(page,{origin,state:state(),result,fetchProbe:probe});
 assert.deepEqual(result.js_errors,['initial realm failure']);page.emit('pageerror',new Error('later failure'));
 page.emit('console',{type:()=> 'error',text:()=> 'early console error'});probe.flush=async()=>{};
 await drain();await drain();assert.deepEqual(result.js_errors,['initial realm failure','later failure','early console error']);
 assert.equal(result.page_error_observations.length,3);assert.equal(result.page_error_observations[0].page_url,'about:blank');
});

for(const mode of ['missing','lost','overwritten','wrong-url','unknown-document','installed'])test(`game-frame installation proof: ${mode}`,async()=>{
 const {context}=attachmentFixture(),probe=await installNativeFetchProbe(context),url='about:blank',id='a'.repeat(32);
 const value={document_id:id,frame_url:url,lost:false,fetch_wrapper_intact:true};
 if(mode==='lost')value.lost=true;if(mode==='overwritten')value.fetch_wrapper_intact=false;if(mode==='wrong-url')value.frame_url=origin+'/play/other';
 const frame={url:()=>url,evaluate:async()=>mode==='missing'?null:value};
 if(mode!=='unknown-document')probe.receive(frame,{kind:'document',document_id:id,event_seq:1,at_ms:1,frame_url:url});
 if(mode==='installed'){assert.equal((await probe.requireInstalled(frame)).document_id,id);assert.equal(probe.errors.length,0);}
 else{await assert.rejects(probe.requireInstalled(frame),/FETCH_PROBE_NOT_INSTALLED/);assert.deepEqual(probe.errors,['FETCH_PROBE_NOT_INSTALLED']);}
});

test('later unfinished GET defers zero-clock attribution and closes without erasing its decision history',async()=>{
 const f=cancellationFixture({timing:0});f.deliver();networkProof(f);f.fail();
 const later={id:'later',frame:'protocol-frame',url:f.req.url(),method:'GET',type:'Fetch',started_at_ms:2500,response_seen:false};f.probe.network.set('later',later);
 await f.drain({final:false});assert.equal(f.result.network_errors.length,0);assert.equal(f.result.unmatched_fetch_rejections.length,0);
 assert.equal(f.result.pending_network_observations,1);assert.equal(f.result.pending_fetch_rejections.length,1);assert.equal(nativeErrorsEmpty(f.result),false);
 const original=JSON.stringify(f.result.network_binding_decisions[0]);assert.equal(f.result.network_binding_decisions[0].binding.candidates.length,2);
 later.response_seen=true;await f.drain({final:true});assert.equal(f.result.lifecycle_cancellations.length,1);assert.equal(nativeErrorsEmpty(f.result),true);
 assert.equal(f.result.pending_fetch_rejections.length,0);assert.equal(JSON.stringify(f.result.network_binding_decisions[0]),original);
 assert.deepEqual(f.result.network_binding_decisions.map(row=>row.verdict),['pending','lifecycle']);assert.equal(f.result.network_observations.length,1);
});

test('final drain fails an unresolved pending association and later success cannot erase the failure',async()=>{
 const f=cancellationFixture({timing:0});f.deliver();networkProof(f);f.fail();
 const later={id:'later',frame:'protocol-frame',url:f.req.url(),method:'GET',type:'Fetch',started_at_ms:2500,response_seen:false};f.probe.network.set('later',later);
 await f.drain({final:false});await f.drain({final:true});assert.equal(f.result.network_errors[0].classification_failure,'AMBIGUOUS_CDP_NETWORK_FAILURE');assert.equal(f.result.unmatched_fetch_rejections.length,1);
 later.response_seen=true;await f.drain();assert.equal(f.result.lifecycle_cancellations.length,0);assert.equal(nativeErrorsEmpty(f.result),false);
});

function addSecondCancellation(f){
 const next={...f.req,timing:()=>({startTime:0})};
 f.deliver(f.trace.slice(1).map(event=>({...event,event_seq:event.event_seq+3,attempt_id:2,at_ms:event.at_ms+100})));
 f.probe.network.set('second',{...f.probe.network.get('protocol-request'),id:'second',started_at_ms:215,failed_at_ms:232});
 f.page.emit('request',next);f.page.emit('requestfailed',next);
}

test('a previously unique CDP identity survives a later sequential same-URL zero-clock abort',async()=>{
 const f=cancellationFixture({timing:0});f.deliver();networkProof(f);f.fail();await f.drain({final:false});
 const original=f.result.lifecycle_cancellations[0];addSecondCancellation(f);await f.drain({final:true});
 assert.equal(f.result.lifecycle_cancellations.length,2);assert.equal(f.result.lifecycle_cancellations[0].network_protocol_id,original.network_protocol_id);
 assert.equal(new Set(f.result.lifecycle_cancellations.map(row=>row.network_protocol_id)).size,2);assert.equal(nativeErrorsEmpty(f.result),true);
 assert.equal(f.result.network_binding_decisions[1].binding.retained_identity.id,'protocol-request');
});

test('two complete zero-clock failures without a prior unique binding remain ambiguous',async()=>{
 const f=cancellationFixture({timing:0});f.deliver();networkProof(f);f.fail();addSecondCancellation(f);await f.drain({final:false});await f.drain({final:true});
 assert.equal(f.result.network_errors.length,2);assert.ok(f.result.network_errors.every(row=>row.classification_failure==='AMBIGUOUS_CDP_NETWORK_FAILURE'));
 assert.equal(f.result.lifecycle_cancellations.length,0);assert.equal(nativeErrorsEmpty(f.result),false);
});

for(const change of ['id','session','clock','headers','redirect','duplicate'])test(`retained zero-clock binding detects later ${change} contradiction`,async()=>{
 const f=cancellationFixture({timing:0});f.deliver();networkProof(f);f.fail();await f.drain({final:false});const record=f.probe.network.get('protocol-request');
 if(change==='id')record.id='changed';if(change==='session')record.session_id='changed';if(change==='clock')record.started_at_ms=116;
 if(change==='headers')record.response_seen=true;if(change==='redirect')record.redirected=true;
 if(change==='duplicate')f.probe.network.set('duplicate',{...record,id:'duplicate'});
 await f.drain({final:true});assert.equal(f.result.lifecycle_cancellations.length,0);assert.equal(f.result.network_errors.length,1);assert.equal(nativeErrorsEmpty(f.result),false);
});

test('late pre-watermark CDP evidence revokes a retained binding instead of pretending a new request',async()=>{
 const f=cancellationFixture({timing:0});f.deliver();networkProof(f);f.fail();await f.drain({final:false});
 f.probe.network.set('late-old',{...f.probe.network.get('protocol-request'),id:'late-old',started_at_ms:120,failed_at_ms:134});
 await f.drain({final:true});assert.equal(f.result.lifecycle_cancellations.length,0);
 assert.equal(f.result.network_errors[0].classification_failure,'LATE_COMPETING_CDP_EVIDENCE');assert.equal(nativeErrorsEmpty(f.result),false);
});

test('already observed competing zero-clock request prevents initial binding before its late failure',async()=>{
 const f=cancellationFixture({timing:0});f.deliver();networkProof(f);f.fail();const other={...f.req};f.page.emit('request',other);
 await f.drain({final:false});assert.equal(f.result.lifecycle_cancellations.length,0);
 assert.equal(f.result.network_errors[0].classification_failure,'UNKNOWN_COMPETING_NETWORK_REQUEST');assert.equal(f.result.network_binding_decisions[0].binding_anchor,null);
 f.probe.network.set('late',{...f.probe.network.get('protocol-request'),id:'late',started_at_ms:120});f.page.emit('requestfailed',other);
 await f.drain({final:true});assert.equal(f.result.lifecycle_cancellations.length,0);assert.equal(f.result.network_errors.length,2);
});

for(const variant of ['valid','missing-start','missing-end','wrong-status','two-network-requests','wrong-frame','wrong-method','lost-prefix'])test(`installation challenge requires complete exact evidence: ${variant}`,()=>{
 const probe=createNativeFetchEvidence(),frame={},doc='challenge-document',frameUrl=origin+'/play/tiger',url=origin+'/health';
 const events=[{kind:'document',event_seq:1,at_ms:100,frame_url:frameUrl},{kind:'checkpoint',event_seq:2,at_ms:105},
  {kind:'start',event_seq:3,at_ms:110,attempt_id:1,url,method:'GET',supported:true,body_present:false,frame_url:frameUrl},
  {kind:'fulfilled',event_seq:4,at_ms:120,attempt_id:1,signal_aborted:false,reason:null},{kind:'checkpoint',event_seq:5,at_ms:125}].map(event=>({document_id:doc,...event}));
 for(const event of events)if(!(variant==='missing-start'&&event.kind==='start')&&!(variant==='missing-end'&&event.kind==='fulfilled')&&!(variant==='lost-prefix'&&event.event_seq===2))probe.receive(frame,event);
 probe.receiveNetworkDocument('frame',events[0]);
 const record={id:'network',frame:'frame',url,method:'GET',type:'Fetch',started_at_ms:111,response_seen:true,response_status:200,redirected:false};
 if(variant==='wrong-status')record.response_status=404;if(variant==='wrong-frame')record.frame='other';if(variant==='wrong-method')record.method='POST';
 probe.network.set('network',record);if(variant==='two-network-requests')probe.network.set('second',{...record,id:'second'});
 const summary=probe.inspectChallenge(frame,doc,url,2,5);assert.equal(summary.passed,variant==='valid');assert.equal(summary.network_statuses[0],record.response_status);
});
