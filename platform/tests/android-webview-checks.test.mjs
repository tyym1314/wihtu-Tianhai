import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAndroidMeasurementBoundary,parseAndroidForwards,ownedAndroidForward,assertAndroidForwardsRestored,androidForeground,assertAndroidSessionBaseline,assertAndroidPaidCycle,assertAndroidOneAction,cleanupOwnedAndroidSession,androidStrictPassed,androidContinueLayoutDiagnostic} from '../scripts/android-webview-checks.mjs';
import {androidInventoryProgram,verifyAndroidInventory,ANDROID_INVENTORY_COUNTERS,validateAndroidInventoryDatabase} from '../scripts/android-guest-inventory.mjs';
const state=(overrides={})=>({game:'run',token:'in-memory-only',sessionId:'original',playerId:'guest',appId:'app',ownedRooms:new Set(),creations:[],probabilityRequests:[],actionRequests:[],inputsRequests:[],practiceRequested:false,spins:[],acks:new Set(),...overrides});
const session=(overrides={})=>({session_id:'original',external_user_id:'guest',game_id:'run',scope:{app_id:'app'},active_room_id:null,other_active_game:null,...overrides});
const probability=(overrides={})=>({sessionId:'original',pendingRound:null,freeSpins:0,...overrides});
const room=(overrides={})=>({id:'owned',me:'guest',game_id:'run',entry_minor:'0',practice:true,status:'active',...overrides});
const baseline=value=>{assertAndroidSessionBaseline(value,value.game==='run'?session():probability(),['run']);return value;};
for(const lateFirst of [true,false])test(`reload boundary excludes only an observed original request; old exchange ${lateFirst?'first':'last'}`,()=>{
 const page=new EventEmitter(),main={url:()=> 'https://mock.fixture.invalid/demo/native/match'},result={},oldFrame={},frame={url:()=> 'https://mock.fixture.invalid/play/match',parentFrame:()=>main};page.mainFrame=()=>main;page.frames=()=>[main,oldFrame];
 const make=(path,owner=frame,navigation=false)=>({url:()=> 'https://mock.fixture.invalid'+path,method:()=>navigation?'GET':'POST',frame:()=>owner,isNavigationRequest:()=>navigation,redirectedFrom:()=>null});
 const boundary=createAndroidMeasurementBoundary(page,{origin:'https://mock.fixture.invalid',game:'match',result}),old=make('/v1/launch/exchange',oldFrame);page.emit('request',old);
 let measuredSession=null;boundary.observedPage.on('response',response=>{if(response.session)measuredSession=response.session;});
 boundary.arm();const nav=make('/demo/native/match',main,true);page.emit('request',nav);page.emit('response',{request:()=>nav,status:()=>200});page.emit('framenavigated',main);boundary.verifyNavigation({request:()=>nav});
 const fresh=make('/v1/launch/exchange');page.emit('request',fresh);
 const oldResponse={request:()=>old,session:'old',status:()=>200},newResponse={request:()=>fresh,session:'new',status:()=>200};
 for(const response of lateFirst?[oldResponse,newResponse]:[newResponse,oldResponse])page.emit('response',response);
 assert.equal(measuredSession,'new');assert.equal(result.initial_request_boundary.length,1);assert.equal(result.observer_errors.length,0);
 const unknown=make('/v1/launch/exchange');page.emit('response',{request:()=>unknown,session:'unobserved'});assert.equal(measuredSession,'new');assert.match(result.observer_errors[0].message,/UNOBSERVED_REQUEST/);
 page.emit('response',{...oldResponse,status:()=>503});assert.equal(result.initial_request_boundary.at(-1).status,503);assert.equal(result.observer_errors.at(-1).stage,'initial-request-failure');
 assert.throws(()=>boundary.verifyNavigation({request:()=>make('/demo/native/match',main,true)}),/REQUEST_IDENTITY/);
});
test('old iframe new API after navigation, and old main API before commit, cannot enter measured state',()=>{
 const page=new EventEmitter(),origin='https://mock.fixture.invalid',main={url:()=>origin+'/demo/native/match'},old={url:()=>origin+'/play/match',parentFrame:()=>main},fresh={url:()=>origin+'/play/match',parentFrame:()=>main},result={};page.mainFrame=()=>main;page.frames=()=>[main,old];
 const make=(path,frame,navigation=false)=>({url:()=>origin+path,frame:()=>frame,method:()=>navigation?'GET':'POST',isNavigationRequest:()=>navigation,redirectedFrom:()=>null});
 const boundary=createAndroidMeasurementBoundary(page,{origin,game:'match',result}),accepted=[];boundary.observedPage.on('request',request=>accepted.push(request));boundary.arm();
 const nav=make('/demo/native/match',main,true);page.emit('request',nav);
 const oldMain=make('/api/demo/launch',main),oldEarly=make('/v1/launch/exchange',old);page.emit('request',oldMain);page.emit('request',oldEarly);assert.deepEqual(accepted,[nav]);assert.throws(()=>boundary.verifyNavigation({request:()=>nav}),/COMMIT_UNPROVEN/);
 page.emit('response',{request:()=>nav,status:()=>200});page.emit('framenavigated',main);boundary.verifyNavigation({request:()=>nav});
 const oldLate=make('/v1/launch/exchange',old),good=make('/v1/launch/exchange',fresh);page.emit('request',oldLate);page.emit('request',good);assert.deepEqual(accepted,[nav,good]);
 assert.deepEqual(result.observer_errors.map(row=>row.message),['REQUEST_BEFORE_MEASURED_DOCUMENT_COMMIT','REQUEST_BEFORE_MEASURED_DOCUMENT_COMMIT','OLD_FRAME_REQUEST_AFTER_MEASURED_NAVIGATION']);
});
function cleanup(current,steps,options={}){
 const calls=[];return{calls,run:()=>cleanupOwnedAndroidSession({state:current,arenaGames:['run'],uiStopped:true,newId:()=> 'cleanup_own',until:async fn=>assert.ok(await fn()),api:async(path,body)=>{calls.push({path,body});const next=steps.shift();assert.ok(next,'Unexpected API '+path);assert.equal(path,next.path);if(next.error)throw next.error;return next.value;},...options})};
}

test('persistent room, another game, pending result and free spins reject the baseline',()=>{
 for(const value of [session({active_room_id:'old'}),session({other_active_game:'match'}),session({session_id:'foreign'}),session({scope:{app_id:'foreign'}})])assert.throws(()=>assertAndroidSessionBaseline(state(),value,['run']));
 for(const value of [probability({pendingRound:{id:'old'}}),probability({freeSpins:2})])assert.throws(()=>assertAndroidSessionBaseline(state({game:'tiger'}),value,['run']));
 const changed=state({probabilityRequests:[{type:'spin'}]});assert.throws(()=>assertAndroidSessionBaseline(changed,session(),['run']),/MUTATION_BEFORE_BASELINE/);
});
test('an absent baseline or changed original identity can never clean inherited business',async()=>{
 for(const current of [state(),Object.assign(baseline(state()),{sessionId:'replacement'})]){const f=cleanup(current,[]);assert.equal((await f.run()).passed,false);assert.deepEqual(f.calls,[]);}
 const f=cleanup(baseline(state()),[],{uiStopped:false});assert.equal((await f.run()).passed,false);assert.deepEqual(f.calls,[]);
});
test('fresh-guest cleanup auto-adoption is blocked for an APK old room',async()=>{
 const f=cleanup(baseline(state()),[{path:'/api/arena/session',value:session({active_room_id:'old'})}]);const result=await f.run();assert.equal(result.passed,false);assert.match(result.error,/FOREIGN_ACTIVE_ROOM/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,undefined);
});
test('only original observed creation may be left and final empty session is mandatory',async()=>{
 const current=baseline(state());current.ownedRooms.add('owned');current.creations.push({game:'run',practice:true,entry:'0',room_id:'owned',status:201});
 const f=cleanup(current,[{path:'/api/arena/session',value:session({active_room_id:'owned'})},{path:'/api/pvp/rooms/owned',value:room()},{path:'/api/pvp/rooms/owned',value:room()},{path:'/api/pvp/rooms/owned/leave',value:{}},{path:'/api/pvp/rooms/owned',value:room({status:'cancelled'})},{path:'/api/arena/session',value:session()}]);
 assert.equal((await f.run()).passed,true);assert.deepEqual(f.calls.filter(v=>v.body).map(v=>v.path),['/api/pvp/rooms/owned/leave']);
 const incomplete=cleanup(current,[{path:'/api/arena/session',value:session()},{path:'/api/pvp/rooms/owned',value:room({status:'cancelled'})},{path:'/api/arena/session',value:session({active_room_id:'owned'})}]);assert.equal((await incomplete.run()).passed,false);
});
test('missing creation ACK remains unresolved and no unknown room is left',async()=>{
 const current=baseline(state());current.creations.push({game:'run',practice:true,entry:'0',room_id:null,status:null});
 const f=cleanup(current,[{path:'/api/arena/session',value:session()},{path:'/api/arena/session',value:session()}]);assert.equal((await f.run()).passed,false);assert.equal(f.calls.some(v=>v.body),false);
});
test('legacy pending/free-cycle state cannot be acknowledged or consumed',async()=>{
 for(const value of [probability({pendingRound:{id:'old',cycleId:'foreign',settlementStatus:'SETTLED'}}),probability({freeSpins:2})]){
  const f=cleanup(baseline(state({game:'tiger'})),[{path:'/api/play/tiger/session',value}]);assert.equal((await f.run()).passed,false);assert.equal(f.calls.some(v=>v.body),false);
 }
});
test('owned settled cycle cleanup ACKs and continues only free spins, never a new paid cycle',async()=>{
 const current=baseline(state({game:'tiger'}));current.spins.push({id:'paid',cycleId:'own-cycle',status:'SETTLED',isFreeSpin:false});current.acks.add('paid');
 const f=cleanup(current,[
  {path:'/api/play/tiger/session',value:probability({freeSpins:1,lockedBet:10,betChoices:[10],stateVersion:1})},
  {path:'/api/play/tiger/spin',value:{session:{sessionId:'original'},round:{id:'bonus',cycleId:'own-cycle',isFreeSpin:true,settlementStatus:'SETTLED'}}},
  {path:'/api/play/tiger/session',value:probability({pendingRound:{id:'bonus',cycleId:'own-cycle',settlementStatus:'SETTLED'}})},
  {path:'/api/play/tiger/ack',value:{session:probability()}},{path:'/api/play/tiger/session',value:probability()},
 ]);const result=await f.run();assert.equal(result.passed,true);assert.equal(result.probability.new_paid_spins,0);assert.equal(f.calls.filter(v=>v.path.endsWith('/spin')).length,1);
});
test('a cleanup exception or an uncertain spin cannot become success after an empty read',async()=>{
 const current=baseline(state({game:'tiger'}));current.probabilityRequests.push({type:'spin',status:null});
 assert.equal((await cleanup(current,[{path:'/api/play/tiger/session',value:probability()}]).run()).passed,false);
 assert.equal((await cleanup(baseline(state()),[{path:'/api/arena/session',error:Error('body unavailable')}]).run()).passed,false);
});
test('cycle gate requires one paid original cycle, all settled and exact ACKs',()=>{
 const current=baseline(state({game:'tiger'}));current.spins.push({id:'paid',cycleId:'own',status:'SETTLED',isFreeSpin:false});assert.throws(()=>assertAndroidPaidCycle(current),/NOT_ACKNOWLEDGED/);current.acks.add('paid');assert.equal(assertAndroidPaidCycle(current),'own');
 current.spins.push({id:'paid2',cycleId:'another',status:'SETTLED',isFreeSpin:false});assert.throws(()=>assertAndroidPaidCycle(current),/ONE_PAID_CYCLE/);
});
test('exact V2.3 ACK and independent observation agree; a retry or GET-only proof fails',()=>{
 const current=state(),action={protocol:'run-practice-inputs-v1',httpStatus:200,inputEvidence:{commandSeq:1}};assert.throws(()=>assertAndroidOneAction(current,action));
 current.inputsRequests.push({status:200,validated:true,proof:{commandSeq:1}});assert.doesNotThrow(()=>assertAndroidOneAction(current,action));current.inputsRequests.push(current.inputsRequests[0]);assert.throws(()=>assertAndroidOneAction(current,action),/NO_RETRY/);
});
test('dynamic forward is new and exactly bound; cleanup preserves both original mappings',()=>{
 const before=parseAndroidForwards('phone tcp:19220 localabstract:chrome\nphone tcp:19222 localabstract:other\n');const fresh={serial:'phone',local:'tcp:33333',remote:'localabstract:owned'};
 assert.deepEqual(ownedAndroidForward(before,[...before,fresh],{serial:'phone',port:33333,remote:fresh.remote}),fresh);
 assert.throws(()=>ownedAndroidForward(before,before,{serial:'phone',port:19220,remote:'localabstract:owned'}),/NOT_NEW/);
 assert.throws(()=>ownedAndroidForward(before,[fresh],{serial:'phone',port:33333,remote:fresh.remote}),/EXISTING_FORWARD_CHANGED/);
 assert.doesNotThrow(()=>assertAndroidForwardsRestored(before,[...before].reverse()));assert.throws(()=>assertAndroidForwardsRestored(before,[...before,fresh]));
});
test('foreground must be unambiguous and strict success includes cleanup/resources/full catalogue',()=>{
 assert.equal(androidForeground('topResumedActivity=ActivityRecord{123 u0 com.launcher/.Home t11}'),'com.launcher/.Home');assert.throws(()=>androidForeground('unknown'));
 const report={full_catalog:true,games:Array.from({length:13},()=>({passed:true,cleanup:{passed:true}})),inventory_final:{clean:true},resources:{passed:true}};assert.equal(androidStrictPassed(report),true);report.games[12].cleanup.passed=false;assert.equal(androidStrictPassed(report),false);
});

test('layout-only diagnostic preserves failure and cannot be promoted to strict acceptance',()=>{
 const report={layout_diagnostic:true,full_catalog:true,games:Array.from({length:13},()=>({passed:true,cleanup:{passed:true}})),inventory_final:{clean:true},resources:{passed:true,errors:[]}};
 const failed={error:'WEBVIEW_SINGLE_SCREEN_REQUIRED',layout:{single_screen:false},ui_stopped:true,cleanup:{passed:true},inventory_after:{clean:true}};
 assert.equal(androidContinueLayoutDiagnostic(report,failed,true),true);
 assert.equal(androidStrictPassed(report),false); // Even an all-green diagnostic is not strict acceptance.
 assert.equal(androidContinueLayoutDiagnostic({...report,layout_diagnostic:false},failed,true),false);
 assert.equal(androidContinueLayoutDiagnostic(report,failed,false),false);
 for(const mutation of [
  value=>{value.error='ACTION_REJECTED';},value=>{delete value.layout;},value=>{value.layout.single_screen=true;},
  value=>{value.ui_stopped=false;},value=>{value.cleanup.passed=false;},value=>{value.inventory_after.clean=false;},
  value=>{value.inventory_error='UNEXPECTED_CYCLE_COUNT';},value=>{value.screenshot_error='CDP_CLOSED';}
 ]){const value=structuredClone(failed);mutation(value);assert.equal(androidContinueLayoutDiagnostic(report,value,true),false);}
 assert.equal(androidContinueLayoutDiagnostic({...report,resources:{errors:['OWNED_FORWARD_REMAINS']}},failed,true),false);
 assert.equal(failed.error,'WEBVIEW_SINGLE_SCREEN_REQUIRED');
});

const inventoryInput={variant:'isolated-mock',origin:'https://mock.fixture.invalid',release:'20261008-16',manifest_sha256:'a'.repeat(64),app_id:'app',guest_id:'guest',session_id:'original',game_id:'match'};
const inventoryProof=()=>({schema:'android-guest-inventory-v1',binding:structuredClone(inventoryInput),observed_at:new Date(1000).toISOString(),database:'oasis_android_mock',transaction:'repeatable-read/read-only',reader_sha256:androidInventoryProgram(inventoryInput).reader_sha256,schema_sha256:'b'.repeat(64),server_sources:Object.fromEntries(['server/schema.sql','server/pvp/schema.sql','server/platform.mjs','server/cycles.mjs','server/pvp/index.mjs'].map(k=>[k,'c'.repeat(64)])),counts:Object.fromEntries(ANDROID_INVENTORY_COUNTERS.map(k=>[k,0])),current_session_cycles:0});
test('inventory binds exact app/guest/source and rejects every nonzero/unknown obligation counter',()=>{
 const proof=inventoryProof(),options={reader_sha256:proof.reader_sha256};assert.equal(verifyAndroidInventory(proof,inventoryInput,options).clean,true);
 for(const key of ANDROID_INVENTORY_COUNTERS.slice(3)){const bad=structuredClone(proof);bad.counts[key]=1;assert.throws(()=>verifyAndroidInventory(bad,inventoryInput,options),/OBLIGATIONS_PRESERVED/);}
 for(const key of ['guest_id','app_id','session_id','manifest_sha256']){const bad=structuredClone(proof);bad.binding[key]='wrong';assert.throws(()=>verifyAndroidInventory(bad,inventoryInput,options),/SCOPE_MISMATCH/);}
 const wrong=structuredClone(proof);delete wrong.counts.pending_rounds;assert.throws(()=>verifyAndroidInventory(wrong,inventoryInput,options));
});
test('unchanged counts cannot substitute another guest history; hidden cycles between games fail',()=>{
 const proof=inventoryProof(),options={reader_sha256:proof.reader_sha256},previous=verifyAndroidInventory(proof,inventoryInput,options);
 previous.binding.guest_id='foreign';assert.throws(()=>verifyAndroidInventory(proof,inventoryInput,{...options,previous}),/SCOPE_MISMATCH/);previous.binding.guest_id='guest';previous.counts.cycles=1;assert.throws(()=>verifyAndroidInventory(inventoryProof(),inventoryInput,{...options,previous}),/UNOBSERVED_CYCLE/);
});
test('PostgreSQL query override cannot redirect a nominally bound Mock connection',()=>{
 const good='postgres://oasis_mock_app:fixture@127.0.0.1:18983/oasis_android_mock';assert.equal(validateAndroidInventoryDatabase(good),true);
 for(const value of [good+'?host=192.0.2.1&port=5432&user=other',good+'#ignored',good.replace('18983','5487'),good.replace('oasis_android_mock','postgres')])assert.throws(()=>validateAndroidInventoryDatabase(value),/DATABASE_SCOPE_MISMATCH/);
 const program=androidInventoryProgram(inventoryInput);assert.equal(program.command,'/usr/bin/node --input-type=module');assert.match(program.input,/REPEATABLE READ READ ONLY/);assert.match(program.program_sha256,/^[a-f0-9]{64}$/);
});
