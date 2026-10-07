import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createRunSnapshotObserver,runSnapshotRequest} from '../deploy/run-snapshot-observer.mjs';
import {observeNativeBrowser,nativeErrorsEmpty} from '../deploy/native-browser-checks.mjs';
import {compactRoomSnapshot} from '../server/pvp/snapshot-transfer.mjs';

const auth={token:'memory_only_token_A',sessionId:'session_A',playerId:'player_A',appId:'app_A'};
const origin='https://qa.invalid',path='/api/pvp/rooms/room_qa_0001',schema='oasis-run-game-v1';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const raw=()=>({id:'room_qa_0001',code:'ROOMQA01',game_id:'run',me:'player_A',version:7,status:'active',practice:true,entry_minor:'0',server_now:1000,game:{gameId:'run',me:'player_A',ruleVersion:'pvp-run-v2.2.0',physicsVersion:'run-60hz-v1.0.0',snapshotTick:60,serverNow:1000,phase:'racing',players:[{key:'player_A',distance:8,speed:8,hits:0}],nested:{different:'whole object hashed'}}});
function full(room=raw(),identity=auth){const scope=hash([schema,identity.appId,'run',identity.playerId]),key=hash([schema,scope,room.id,room.me,room.version,room.game]);return {...room,run_game_transfer:{schema,scope,key,omitted:false}};}
function omitted(value=full()){const {game,...rest}=structuredClone(value);return {...rest,server_now:1200,run_game_transfer:{...value.run_game_transfer,omitted:true}};}
function fixture(){const observer=createRunSnapshotObserver();observer.authorize(auth);return observer;}
function begin(observer,{hint='full',method='GET',target=path,identity=auth}={}){return observer.begin({path:target,method,authorization:'Bearer '+identity.token,hint});}
function prime(observer,value=full()){const ticket=begin(observer);assert.equal(observer.inspect(ticket,value).kind,'full');return value;}

test('independent SHA validates actual server encoding and records exact omitted proof without restoring game',()=>{
 const observer=fixture(),wire=compactRoomSnapshot(raw(),undefined,{runKey:'full',session:{app_id:auth.appId,game_id:'run',external_user_id:auth.playerId}});
 assert.deepEqual(wire,full());prime(observer,wire);
 const duplicate=observer.inspect(begin(observer,{hint:wire.run_game_transfer.key}),omitted(wire));
 assert.equal(duplicate.kind,'duplicate');assert.equal(duplicate.room,undefined);assert.equal(duplicate.evidence.version,7);assert.equal(duplicate.evidence.full_request_sequence,1);
 assert(!JSON.stringify(duplicate).includes(auth.token));
});

test('same-version game change needs a newly verified complete SHA; nested contents are included',()=>{
 const observer=fixture(),first=prime(observer),changed=raw();changed.game.nested.different='new authority';
 const next=full(changed);assert.notEqual(next.run_game_transfer.key,first.run_game_transfer.key);
 assert.equal(observer.inspect(begin(observer,{hint:first.run_game_transfer.key}),next).room.game.nested.different,'new authority');
 assert.equal(observer.inspect(begin(observer,{hint:next.run_game_transfer.key}),omitted(next)).kind,'duplicate');
});

for(const [label,mutate] of [
 ['bad key',r=>r.run_game_transfer.key='0'.repeat(64)],['bad scope',r=>r.run_game_transfer.scope='1'.repeat(64)],
 ['different player',r=>r.me='other'],['different room',r=>r.id='other'],['different version',r=>r.version++],
 ['conflicting game',r=>r.game={}],['unknown metadata field',r=>r.run_game_transfer.extra=true],
 ['wrong schema',r=>r.run_game_transfer.schema='future'],['nonboolean omitted',r=>r.run_game_transfer.omitted='true'],
 ['null metadata',r=>r.run_game_transfer=null],['array metadata',r=>r.run_game_transfer=[]],
 ['missing metadata',r=>delete r.run_game_transfer],['missing identity',r=>delete r.id],
])test('omission rejects '+label,()=>{
 const observer=fixture(),value=prime(observer),bad=omitted(value);mutate(bad);
 assert.throws(()=>observer.inspect(begin(observer,{hint:value.run_game_transfer.key}),bad),/RUN_SNAPSHOT_/);
});

for(const change of [r=>r.game.nested.different='tampered',r=>r.run_game_transfer.key='a'.repeat(64),r=>delete r.game,r=>r.game=null,r=>r.game.snapshotTick=-1,r=>r.game.me='other'])test('corrupt complete response never primes omission cache: '+String(change),()=>{
 const observer=fixture(),bad=full();change(bad);assert.throws(()=>observer.inspect(begin(observer),bad),/RUN_SNAPSHOT_/);
 assert.throws(()=>observer.inspect(begin(observer,{hint:full().run_game_transfer.key}),omitted()),/FULL_PROOF_MISSING/);
});

test('no preceding complete response is not an omission exemption',()=>{
 const observer=fixture();assert.throws(()=>observer.inspect(begin(observer,{hint:full().run_game_transfer.key}),omitted()),/FULL_PROOF_MISSING/);
});
for(const options of [{hint:null},{hint:'full'},{hint:'b'.repeat(64)},{hint:['full']},{method:'POST'},{target:path+'/action'},{target:'/api/pvp/rooms/another'}])test('actual request must prove exact GET negotiation '+JSON.stringify(options),()=>{
 const observer=fixture(),value=prime(observer);assert.throws(()=>observer.inspect(begin(observer,{hint:value.run_game_transfer.key,...options}),omitted(value)),/RUN_SNAPSHOT_/);
});

test('POST metadata is always refused; a complete ordinary POST and legacy GET remain unchanged',()=>{
 const observer=fixture();assert.throws(()=>observer.inspect(begin(observer,{method:'POST',target:path+'/action'}),full()),/NOT_ROOM_GET/);
 const room=raw();assert.equal(observer.inspect(begin(observer,{method:'POST',hint:null,target:path+'/action'}),room).room,room);
 assert.equal(observer.inspect(begin(observer,{hint:null}),room).room,room);
 const waiting={...room,status:'waiting',game:null};assert.equal(observer.inspect(begin(observer,{method:'POST',target:'/api/pvp/rooms'}),waiting).room,waiting);
 assert.throws(()=>observer.inspect(begin(observer),{...room,game:null}),/GAME_INVALID/);
 assert.equal(observer.inspect(begin(observer),{id:'other',game_id:'jackaroo',me:'player_A',version:1,game:{legalActionsOmitted:true}}).kind,'full');
});

test('auth rotation invalidates old tickets and complete proofs even for the same player and room',()=>{
 const observer=fixture(),value=prime(observer),old=begin(observer,{hint:value.run_game_transfer.key}),next={...auth,token:'token_B'};
 observer.authorize(next);assert.throws(()=>observer.inspect(old,omitted(value)),/AUTH_CHANGED/);
 assert.throws(()=>observer.inspect(begin(observer,{identity:next,hint:value.run_game_transfer.key}),omitted(value)),/FULL_PROOF_MISSING/);
 assert.equal(observer.inspect(begin(observer,{identity:next}),full(raw(),next)).kind,'full');
});
for(const field of ['sessionId','playerId','appId'])test('authorization '+field+' change clears prior generation',()=>{
 const observer=fixture(),value=prime(observer),old=begin(observer,{hint:value.run_game_transfer.key});observer.authorize({...auth,[field]:'new_'+field});
 assert.throws(()=>observer.inspect(old,omitted(value)),/AUTH_CHANGED/);
});

test('same validated authorization does not reset proof and an unknown credential cannot borrow it',()=>{
 const observer=fixture(),value=prime(observer);observer.authorize({...auth});assert.equal(observer.inspect(begin(observer,{hint:value.run_game_transfer.key}),omitted(value)).kind,'duplicate');
 assert.throws(()=>observer.inspect(begin(observer,{identity:{...auth,token:'unknown'},hint:value.run_game_transfer.key}),omitted(value)),/AUTH_CHANGED/);
});
test('late earlier exchange cannot replace the newer authorization or revive its cache',()=>{
 const observer=fixture(),oldExchange=observer.begin({path:'/v1/launch/exchange',method:'POST'}),newExchange=observer.begin({path:'/v1/launch/exchange',method:'POST'}),next={...auth,token:'token_B'};
 observer.authorize(next,newExchange);assert.throws(()=>observer.authorize(auth,oldExchange),/AUTH_RESPONSE_OUT_OF_ORDER/);
 assert.equal(observer.inspect(begin(observer,{identity:next}),full(raw(),next)).kind,'full');
});

test('late old complete observations cannot retrospectively prove an earlier omission request',()=>{
 const observer=fixture(),old=begin(observer,{hint:full().run_game_transfer.key});prime(observer);
 assert.throws(()=>observer.inspect(old,omitted()),/FULL_PROOF_MISSING/);
});

test('response-header order is preserved when complete JSON resolves after a duplicate JSON',async()=>{
 const observer=fixture(),first=begin(observer),second=begin(observer,{hint:full().run_game_transfer.key});let resolve;
 const a=observer.enqueue(new Promise(r=>resolve=r),body=>observer.inspect(first,body));
 const b=observer.enqueue(Promise.resolve(omitted()),body=>observer.inspect(second,body));resolve(full());
 assert.equal((await a).kind,'full');assert.equal((await b).kind,'duplicate');
});
test('an earlier failed body remains a failure and cannot authorize the later omission',async()=>{
 const observer=fixture(),first=begin(observer),second=begin(observer,{hint:full().run_game_transfer.key});let reject;
 const a=observer.enqueue(new Promise((_r,j)=>reject=j),body=>observer.inspect(first,body));
 const b=observer.enqueue(Promise.resolve(omitted()),body=>observer.inspect(second,body));
 const checked=assert.rejects(a,/body lost/),checkedB=assert.rejects(b,/FULL_PROOF_MISSING/);reject(new Error('body lost'));await Promise.all([checked,checkedB]);
});

function native(){
 const page=new EventEmitter(),result={},state={game:'run',token:auth.token,sessionId:auth.sessionId,playerId:auth.playerId,appId:auth.appId,phase:'playing',ownedRooms:new Set(),spins:[],acks:new Set()};
 let value=null,clock=0;const writes=[];Object.defineProperty(state,'room',{get:()=>value,set:r=>{value=r;writes.push({clock,room:r});}});
 const drain=observeNativeBrowser(page,{origin,state,result});
 const request=({method='GET',target=path,hint='full',identity=auth,body={}}={})=>({url:()=>origin+target,method:()=>method,resourceType:()=> 'fetch',headers:()=>({authorization:'Bearer '+identity.token,...(hint===null?{}:{'x-oasis-known-run-game':hint})}),postDataJSON:()=>body,failure:()=>({errorText:'net::ERR_ABORTED'})});
 const respond=(req,body,status=200)=>{page.emit('request',req);page.emit('response',{request:()=>req,url:req.url,status:()=>status,ok:()=>status>=200&&status<300,json:()=>Promise.resolve(body)});};
 return {page,result,state,drain,writes,request,respond,time:n=>clock=n};
}

test('native observer keeps exact authority reference and sample clock on duplicate; next complete response advances',async()=>{
 const f=native(),value=full();f.respond(f.request(),value);await f.drain();f.time(500);f.respond(f.request({hint:value.run_game_transfer.key}),omitted(value));await f.drain();
 assert.equal(f.state.room,value);assert.equal(f.writes.length,1);assert.equal(f.writes[0].clock,0);assert.equal(f.result.run_snapshot_duplicates.length,1);assert(nativeErrorsEmpty(f.result));
 const next=full({...raw(),version:8,game:{...raw().game,snapshotTick:61}});f.time(600);f.respond(f.request({hint:value.run_game_transfer.key}),next);await f.drain();assert.equal(f.state.room,next);assert.equal(f.writes[1].clock,600);
});
test('native observer queues full body validation before a fast duplicate body',async()=>{
 const f=native();let resolve;f.respond(f.request(),new Promise(r=>resolve=r));f.respond(f.request({hint:full().run_game_transfer.key}),omitted());resolve(full());await f.drain();
 assert(nativeErrorsEmpty(f.result));assert.equal(f.writes.length,1);assert.equal(f.result.run_snapshot_duplicates.length,1);
});
test('new authorization invalidates an older still-reading full response before it reaches the queue',async()=>{
 const f=native();let resolve;f.respond(f.request(),new Promise(r=>resolve=r));
 f.respond(f.request({method:'POST',target:'/v1/launch/exchange',hint:null}),{game_id:'run',session_id:auth.sessionId,external_user_id:auth.playerId,access_token:'token_B',scope:{app_id:auth.appId}});
 await new Promise(r=>setImmediate(r));resolve(full());await f.drain();assert.equal(f.writes.length,0);assert.equal(f.state.token,'token_B');assert.equal(f.result.observer_errors.length,1);assert.match(f.result.observer_errors[0].message,/AUTH_CHANGED/);
});
test('late exchange JSON can bind a subsequent actual request credential, but not an earlier unknown request',async()=>{
 const observer=createRunSnapshotObserver(),early=begin(observer),exchange=observer.begin({path:'/v1/launch/exchange',method:'POST'}),later=begin(observer);observer.authorize(auth,exchange);
 assert.equal(observer.inspect(later,full()).kind,'full');assert.throws(()=>observer.inspect(early,full()),/AUTH_CHANGED/);
});
test('bad create snapshot is a permanent error while owned room remains registered for cleanup',async()=>{
 const f=native();f.respond(f.request({method:'POST',target:'/api/pvp/rooms',hint:null,body:{request_id:'create_0001',game_id:'run',practice:true,entry_minor:'0'}}),full());await f.drain();
 assert.equal(f.state.ownedRooms.has(raw().id),true);assert.equal(f.state.creations[0].room_id,raw().id);assert.equal(f.writes.length,0);assert.equal(f.result.observer_errors.length,1);assert(!nativeErrorsEmpty(f.result));
});
test('malformed omitted response cannot reset authority or disappear as a note',async()=>{
 const f=native(),value=full();f.respond(f.request(),value);await f.drain();const bad=omitted(value);bad.run_game_transfer.extra=true;f.respond(f.request({hint:value.run_game_transfer.key}),bad);await f.drain();
 assert.equal(f.state.room,value);assert.equal(f.result.run_snapshot_duplicates.length,0);assert.equal(f.result.observer_errors.length,1);assert(!nativeErrorsEmpty(f.result));
});
test('metadata without a room id is still a native observer error',async()=>{
 const f=native(),bad=omitted();delete bad.id;f.respond(f.request({hint:full().run_game_transfer.key}),bad);await f.drain();assert.equal(f.result.observer_errors.length,1);assert(!nativeErrorsEmpty(f.result));
});
test('a malformed room GET cannot silently retain the previous sample even without metadata',async()=>{
 const f=native();f.respond(f.request(),full());await f.drain();f.respond(f.request(),{});await f.drain();assert.equal(f.result.observer_errors.length,1);assert.equal(f.writes.length,1);assert(!nativeErrorsEmpty(f.result));
});
for(const change of [r=>r.status='settled',r=>r.me_last_seq=42,r=>r.practice=false,r=>r.entry_minor='100'])test('identical game cannot hide outer authority change '+String(change),()=>{
 const observer=fixture(),value=prime(observer),bad=omitted(value);change(bad);assert.throws(()=>observer.inspect(begin(observer,{hint:value.run_game_transfer.key}),bad),/OUTER_AUTHORITY_CHANGED/);
});
test('ordinary complete response under old authorization cannot update the new generation',()=>{
 const observer=fixture(),old=begin(observer,{hint:null});observer.authorize({...auth,token:'token_B'});assert.throws(()=>observer.inspect(old,raw()),/AUTH_CHANGED/);
});
test('successful duplicate proof never suppresses HTTP or transport failures',async()=>{
 const f=native(),value=full();f.respond(f.request(),value);await f.drain();f.respond(f.request({hint:value.run_game_transfer.key}),omitted(value));await f.drain();
 f.respond(f.request(),{error:{code:'BUSY'}},409);const req=f.request();f.page.emit('request',req);f.page.emit('requestfailed',req);await f.drain();
 assert.equal(f.result.run_snapshot_duplicates.length,1);assert.equal(f.result.http_errors.length,1);assert.equal(f.result.network_errors.length,1);assert(!nativeErrorsEmpty(f.result));
});
test('request header capture only retains necessary credentials inside opaque tickets',()=>{
 const observer=fixture(),ticket=runSnapshotRequest(observer,{method:()=> 'GET',headers:()=>({authorization:'Bearer '+auth.token,'x-oasis-known-run-game':'full',cookie:'unrelated secret'})},path);
 assert.deepEqual(Object.keys(ticket),['sequence']);assert(!JSON.stringify(ticket).includes(auth.token));assert.equal(observer.inspect(ticket,full()).kind,'full');
});
