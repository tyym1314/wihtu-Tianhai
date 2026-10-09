import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,symlink,rm,readFile,link,rename,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {ARENA_IDS} from '../shared/games.mjs';
import {validateBuildConfiguration} from '../android-player/build-config.mjs';
import {playerAcceptanceArguments,validatePlayerArtifactMetadata,playerEvidenceHash,playerShellSourcePins,readPlayerArtifact,createPlayerEvidenceRedactor,readPlayerCredentials,assertPlayerLobbyBaseline,assertPlayerZeroWallet,assertOwnedPlayerArenaState,assertPlayerReturnReadback,playerResourceManifest,assertPlayerResourceBody,assertInstalledPlayerArtifact,playerRunResumeEvidence} from '../scripts/android-player-acceptance-checks.mjs';
import {playerAdbArgs,playerTouchFrame,collectPlayerEvidence,closePlayerObservation} from '../scripts/android-player-acceptance.mjs';
import {cleanupOwnedAndroidSession} from '../scripts/android-webview-checks.mjs';

const artifact=()=>{
 const config=validateBuildConfiguration({variant:'qa',origin:'https://player.tianyahuyu.com',appId:'actual_player_app'}),files={'Main.java':playerEvidenceHash('public-fixture-source')};
 return{...config,apkSha256:playerEvidenceHash('unsigned-unit-fixture-not-an-apk'),certificateSha256:'1'.repeat(64),apkBytes:32,builtAt:'2026-10-10T00:00:00.000Z',buildTools:'35.0.1',minSdk:26,targetSdk:35,compileSdk:35,sourceEvidence:{baseRevision:'0'.repeat(40),files,sourceSha256:playerEvidenceHash(JSON.stringify(files))},generatedSha256:{manifest:'a'.repeat(64),resources:'b'.repeat(64),configuration:'c'.repeat(64)},checks:{configuration:{passed:true,groups:1},navigation:{passed:true},backBridge:{passed:true}}};
};
const wallet=()=>({app_id:'actual_player_app',environment:'production',partner_id:'partner',wallet_scope_id:'own_scope',currency_id:'COIN',as_of:'2026-10-10T00:00:00Z',balance:{external_user_id:'owned_player',available_minor:'0',reserved_minor:'0',ledger_version:'0',currency_scale:6}});
const lobby=()=>({metadata:{name:'Actual arena',admission_open:true,game_ids:[...ARENA_IDS]},session:{player:{id:'player_identity',username:'unit_user'}},wallet:wallet(),recovery:{sessions:[]},appId:'actual_player_app',username:'unit_user'});

test('explicit APK metadata paths and run gate; no credential/env/default backend injection',()=>{
 const args=['--metadata','/ignored/build-metadata.json','--platform-manifest','/ignored/manifest.json','--apksigner','/local/apksigner','--output','/ignored/new-report'];
 const parsed=playerAcceptanceArguments(args);assert.equal(parsed.run,false);assert.equal(parsed.adbPort,undefined);assert.equal(parsed.serial,undefined);
 assert.throws(()=>playerAcceptanceArguments([...args,'--run']),/PRIVATE_CREDENTIAL_FILE_REQUIRED/);
 assert.throws(()=>playerAcceptanceArguments([...args,'--run','--credentials-file','/private/file']),/EXPLICIT_ADB_TARGET_REQUIRED/);
 assert.throws(()=>playerAcceptanceArguments([...args,'--password','value']),/UNKNOWN_ARGUMENT/);
 assert.throws(()=>playerAcceptanceArguments([...args,'--metadata','again']),/DUPLICATE_ARGUMENT/);
 assert.throws(()=>playerAcceptanceArguments([...args,'--games','thunder']),/ONLY_EXPLICIT_ARENA_GAMES/);
 const run=playerAcceptanceArguments([...args,'--run','--credentials-file','/private/file','--adb-port','5037','--serial','46dcfd25']);assert.deepEqual(playerAdbArgs(run,['shell','pidof','owned.package']),['-H','127.0.0.1','-P','5037','-s','46dcfd25','shell','pidof','owned.package']);
});

test('real QA metadata rejects contract/sandbox/release, missing source/cert pins and weakened native checks',()=>{
 assert.equal(validatePlayerArtifactMetadata(artifact()).contractFixture,false);
 for(const mutate of [v=>v.contractFixture=true,v=>v.variant='release',v=>v.flavor='qa-contract',v=>v.debuggable=false,v=>v.origin='http://player.tianyahuyu.com',v=>v.entryUrl+='&token=bad',v=>v.certificateSha256=null,v=>v.apkSha256='wrong',v=>v.sourceEvidence.files['../private']='a'.repeat(64),v=>v.sourceEvidence.sourceSha256='0'.repeat(64),v=>v.checks.navigation.passed=false,v=>v.checks.backBridge.passed=false,v=>delete v.generatedSha256.configuration]){
  const v=artifact();mutate(v);assert.throws(()=>validatePlayerArtifactMetadata(v));
 }
});

test('actual file SHA, independently verified cert and exact current shell files bind artifact preflight',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'player-apk-unit-'));
 try{
  const shell=join(dir,'shell'),output=join(dir,'artifact');await mkdir(shell);await mkdir(output);await writeFile(join(shell,'Main.java'),'public-fixture-source');
  const v=artifact(),bytes=Buffer.from('unsigned-unit-fixture-not-an-apk');v.apkBytes=bytes.length;await writeFile(join(output,v.apkName),bytes);const metadata=join(output,'build-metadata.json');await writeFile(metadata,JSON.stringify(v));
  let calls=0;const execute=async(bin,args)=>{calls++;assert.equal(bin,'fixture-apksigner');assert.deepEqual(args,['verify','--verbose','--print-certs',join(output,v.apkName)]);return{stdout:'Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: '+v.certificateSha256};};
  const result=await readPlayerArtifact(metadata,{shellRoot:shell,execute,apksigner:'fixture-apksigner'});assert.equal(calls,1);assert.equal(result.apkSha256,v.apkSha256);
  await assert.rejects(readPlayerArtifact(metadata,{shellRoot:shell,execute:async()=>({stdout:'Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: '+'2'.repeat(64)}),apksigner:'fixture-apksigner'}),/PLAYER_CERTIFICATE_MISMATCH/);
  await writeFile(join(shell,'Main.java'),'changed');await assert.rejects(readPlayerArtifact(metadata,{shellRoot:shell,execute,apksigner:'fixture-apksigner'}),/PLAYER_APK_SOURCE_CHANGED/);assert.equal(calls,1);
  await writeFile(join(shell,'Main.java'),'public-fixture-source');await writeFile(join(output,v.apkName),'changed');await assert.rejects(readPlayerArtifact(metadata,{shellRoot:shell,execute,apksigner:'fixture-apksigner'}),/PLAYER_APK_SIZE_MISMATCH/);
  await symlink(join(shell,'Main.java'),join(shell,'linked'));await assert.rejects(playerShellSourcePins(shell),/PLAYER_SOURCE_SYMLINK_REFUSED/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('credentials only come from owned0600 regular file, and malformed JSON never exposes a password fragment',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'player-credentials-unit-')),path=join(dir,'credentials.json'),redactor=createPlayerEvidenceRedactor();
 try{
  const value={username:'unit_user',password:'unit"\\password$$123'};await writeFile(path,JSON.stringify(value),{mode:0o600});assert.deepEqual(await readPlayerCredentials(path,redactor),value);
  for(const text of [value.password,JSON.stringify(value),encodeURIComponent(value.password)])assert.ok(!redactor.clean(text).includes(value.password)&&!redactor.clean(text).includes(JSON.stringify(value.password).slice(1,-1)));
  redactor.remember({authorization:'Bearer secret-access-token',headers:{'set-cookie':'own=secret-cookie; Path=/; Secure; HttpOnly'},sessionId:'private_session_id'});
  assert.doesNotMatch(JSON.stringify(redactor.sanitize({request:{postData:JSON.stringify(value),authorization:'Bearer secret-access-token'},cookie:'own=secret-cookie',sessionId:'private_session_id'})),/secret-access-token|secret-cookie|private_session_id|unit_user/);
  await chmod(path,0o640);await assert.rejects(readPlayerCredentials(path,redactor),/PRIVATE_0600_OWNED_CREDENTIAL_FILE_REQUIRED/);await chmod(path,0o600);
  const symlinkPath=join(dir,'link');await symlink(path,symlinkPath);await assert.rejects(readPlayerCredentials(symlinkPath,redactor),/PRIVATE_0600_OWNED_CREDENTIAL_FILE_REQUIRED/);
  await writeFile(path,'{"password":"do-not-expose-fragment",broken');await assert.rejects(readPlayerCredentials(path,redactor),e=>e.message==='PRIVATE_CREDENTIAL_JSON_INVALID');
  await writeFile(path,JSON.stringify(value));const hardlink=join(dir,'hardlink');await link(path,hardlink);await assert.rejects(readPlayerCredentials(path,redactor),/PRIVATE_0600_OWNED_CREDENTIAL_FILE_REQUIRED/);await rm(hardlink);
  const swap=join(dir,'replacement');await writeFile(swap,JSON.stringify(value),{mode:0o600});let first=true;
  await assert.rejects(readPlayerCredentials(path,redactor,{statPath:async name=>{const info=await lstat(name);if(first){first=false;await rename(swap,path);}return info;}}),/PRIVATE_CREDENTIAL_FILE_REPLACED/);
  await writeFile(swap,JSON.stringify(value),{mode:0o600});first=true;await assert.rejects(readPlayerCredentials(path,redactor,{statPath:async name=>{const info=await lstat(name);if(first){first=false;await rm(path);await symlink(swap,path);}return info;}}),error=>error.code==='ELOOP');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('zero-wallet production catalog and readonly inherited obligation baseline fail closed before gameplay',()=>{
 const baseline=assertPlayerLobbyBaseline(lobby());assert.equal(baseline.currencyScale,6);
 for(const mutate of [v=>v.metadata.admission_open=false,v=>v.metadata.game_ids.push('thunder'),v=>v.metadata.game_ids.pop(),v=>v.session.player.username='different_user',v=>v.recovery.sessions.push({session_id:'inherited',game_id:'run'}),v=>v.wallet.environment='sandbox',v=>v.wallet.app_id='other_app',v=>v.wallet.balance.available_minor='1',v=>v.wallet.balance.reserved_minor='1',v=>v.wallet.balance.currency_scale=7,v=>v.wallet.balance.external_user_id='']){
  const v=lobby();mutate(v);assert.throws(()=>assertPlayerLobbyBaseline(v));
 }
 const changed=wallet();changed.balance.external_user_id='other';assert.throws(()=>assertPlayerZeroWallet(changed,'actual_player_app',baseline),/PLAYER_WALLET_IDENTITY_CHANGED/);
 for(const field of ['partner_id','wallet_scope_id']){const changed=wallet();changed[field]='other';assert.throws(()=>assertPlayerZeroWallet(changed,'actual_player_app',baseline));}
});

test('identity redaction precedes an invalid wallet/recovery baseline without hiding protocol observation IDs',()=>{
 const redactor=createPlayerEvidenceRedactor(),v=lobby();v.session.player.id='private-first-login-id';v.recovery.sessions=[{session_id:'private-old-session-id',game_id:'run'}];
 redactor.remember(v.session);redactor.remember(v.recovery);assert.throws(()=>assertPlayerLobbyBaseline(v),/INHERITED_OBLIGATIONS_PRESERVED/);
 const saved=redactor.sanitize({session:v.session,recovery:v.recovery,raw:{id:'network-observation-1',requestId:'cdp-request-2'}});
 assert.doesNotMatch(JSON.stringify(saved),/private-first-login-id|private-old-session-id|unit_user/);assert.equal(saved.raw.id,'network-observation-1');assert.equal(saved.raw.requestId,'cdp-request-2');
});

test('return requires UI stop, own original session, one proved free BOT creation and actual UI wallet refresh',()=>{
 const baseline=assertPlayerLobbyBaseline(lobby()),state={game:'run',sessionId:'own_session',playerId:baseline.externalUserId,appId:baseline.appId,creations:[{game:'run',practice:true,entry:'0'}],probabilityRequests:[],ownedRooms:new Set(['own_room']),room:{id:'own_room',game_id:'run',me:baseline.externalUserId,fee_bps:0,practice:true,entry_minor:'0',status:'settled'}};state.androidBaseline={game:state.game,sessionId:state.sessionId,playerId:state.playerId,appId:state.appId};
 const input={state,result:{ui_stopped:true,cleanup:{passed:true,rooms:[{terminal:true}]},wallet_refresh:{status:200,after_return:true}},session:lobby().session,recovery:{sessions:[]},wallet:wallet(),baseline};assertPlayerReturnReadback(input);
 for(const mutate of [v=>v.state.sessionId='changed',v=>v.state.room.fee_bps=1,v=>v.state.ownedRooms.clear(),v=>v.state.probabilityRequests.push({type:'spin'}),v=>v.result.ui_stopped=false,v=>v.result.cleanup.passed=false,v=>v.result.wallet_refresh.after_return=false,v=>v.recovery.sessions.push({session_id:'unknown'}),v=>v.state.creations.push({...v.state.creations[0]})]){
  const v=structuredClone(input);mutate(v);assert.throws(()=>assertPlayerReturnReadback(v));
 }
 const foreign=structuredClone(state);foreign.room.id='inherited';assert.throws(()=>assertOwnedPlayerArenaState(foreign,baseline),/UNOWNED_ROOM_PRESERVED/);
 const empty=structuredClone(input);empty.state.room.status='active';empty.result.cleanup.rooms=[];assert.throws(()=>assertPlayerReturnReadback(empty),/OWNED_ROOM_TERMINAL_REQUIRED/);
});

test('resource response byte SHA is pinned to actual release outputs, including player and arena HTML aliases',()=>{
 const bytes=Buffer.from('exact-public-file'),hash=playerEvidenceHash(bytes),manifest=playerResourceManifest({format:1,inputs:{},outputs:{'platform/dist/index.html':hash,'platform/arena/dist/index.html':hash,'platform/arena/dist/assets/model.glb':hash}});
 for(const path of ['/player?app_id=actual_player_app','/play/run','/arena/assets/model.glb'])assert.equal(assertPlayerResourceBody('https://player.tianyahuyu.com'+path,bytes,{origin:'https://player.tianyahuyu.com',manifest}).sha256,hash);
 assert.throws(()=>assertPlayerResourceBody('https://player.tianyahuyu.com/arena/assets/model.glb',Buffer.from('changed'),{origin:'https://player.tianyahuyu.com',manifest}),/PLAYER_RESOURCE_BODY_SHA_MISMATCH/);
 assert.throws(()=>assertPlayerResourceBody('https://player.tianyahuyu.com/other',bytes,{origin:'https://player.tianyahuyu.com',manifest}),/UNPINNED_PLAYER_RESOURCE/);
 assert.throws(()=>assertInstalledPlayerArtifact({apkSha256:'wrong',version:'1.0.0-qa',versionCode:1,debuggable:true},artifact()),/INSTALLED_PLAYER_APK_HASH_MISMATCH/);
});

test('trusted touch adapter uses native tap, releases gesture and preserves verifier frame identity/listener cleanup',async()=>{
 const page=new EventEmitter(),sent=[],target={tap(){throw Error('UNEXPECTED_BROWSER_TAP');},boundingBox(){return{x:1,y:2,width:10,height:20};}},frame={page:()=>page,locator:()=>target};
 const wrapped=playerTouchFrame(frame,{tap:async(value,options)=>{assert.equal(value,target);sent.push(['tap',options]);},touch:async(...values)=>sent.push(values)});
 await wrapped.frame.locator('button').tap({position:{x:3,y:4}});const mouse=wrapped.frame.page().mouse;await mouse.move(10,20);await mouse.down();await mouse.move(20,30,{steps:2});await wrapped.release();assert.deepEqual(sent.map(row=>row[0]),['tap','touchStart','touchMove','touchMove','touchEnd']);
 const handler=response=>assert.equal(response.request().frame(),wrapped.frame);wrapped.frame.page().on('response',handler);page.emit('response',{request:()=>({frame:()=>frame})});wrapped.frame.page().off('response',handler);assert.equal(page.listenerCount('response'),0);await wrapped.release();assert.equal(sent.length,5);
});

test('background resume requires a newly started authenticated iframe GET and newer authority head',()=>{
 const scope={origin:'https://player.tianyahuyu.com',after:100,token:'own-access-token',sessionId:'own_session',roomId:'own_room',serverNow:1000,playerId:'owned_player',appId:'actual_player_app'};
 const row={request_id:2,request_at:101,status:200,method:'GET',request_headers:{authorization:'Bearer own-access-token'},frame:scope.origin+'/play/run',path:'/api/pvp/rooms/own_room',original_sha256:'a'.repeat(64),body:{room:{id:'own_room',game_id:'run',me:'owned_player',status:'active',server_now:1001}}};
 assert.equal(playerRunResumeEvidence([row],scope).server_now,1001);
 for(const mutate of [v=>v.request_at=99,v=>v.status=500,v=>v.method='POST',v=>v.request_headers.authorization='Bearer other-token',v=>v.frame=scope.origin+'/player',v=>v.path='/api/pvp/rooms/other',v=>v.body.room.me='foreign',v=>v.body.room.server_now=1000,v=>v.body.room.status='settled']){const changed=structuredClone(row);mutate(changed);assert.equal(playerRunResumeEvidence([changed],scope),null);}
 assert.equal(playerRunResumeEvidence([],scope),null);
});

test('original-session cleanup is UI-stop then read, one owned leave, terminal and active-clear; inherited scope never posts',async()=>{
 const state={game:'run',sessionId:'own_session',playerId:'owned_player',appId:'actual_player_app',token:'own-token',ownedRooms:new Set(['own_room']),creations:[{game:'run',practice:true,entry:'0',status:201,room_id:'own_room'}],spins:[],probabilityRequests:[]};state.androidBaseline={game:state.game,sessionId:state.sessionId,playerId:state.playerId,appId:state.appId};
 const events=['UI_STOP'],room={id:'own_room',game_id:'run',me:state.playerId,entry_minor:'0',practice:true,status:'active'};let leaves=0;
 const api=async(path,body)=>{events.push((body?'POST ':'GET ')+path);if(path==='/api/arena/session')return{session_id:state.sessionId,external_user_id:state.playerId,game_id:'run',scope:{app_id:state.appId},active_room_id:room.status==='active'?room.id:null,other_active_game:null};if(path==='/api/pvp/rooms/own_room/leave'){leaves++;assert.equal(leaves,1);assert.equal(body.request_id,'cleanup-once');room.status='settled';return{room:{...room}};}if(path==='/api/pvp/rooms/own_room')return{room:{...room}};assert.fail('Unexpected path '+path);};
 const options={state,arenaGames:ARENA_IDS,api,until:async predicate=>assert.equal(await predicate(),true),newId:()=> 'cleanup-once',uiStopped:true};
 const result=await cleanupOwnedAndroidSession(options);assert.equal(result.passed,true);assert.equal(leaves,1);assert.deepEqual(events,['UI_STOP','GET /api/arena/session','GET /api/pvp/rooms/own_room','GET /api/pvp/rooms/own_room','POST /api/pvp/rooms/own_room/leave','GET /api/pvp/rooms/own_room','GET /api/arena/session']);assert.equal(result.final_readback.active_room_id,null);
 const rejected=await cleanupOwnedAndroidSession({...options,uiStopped:false});assert.equal(rejected.passed,false);assert.equal(leaves,1);
 const foreign=await cleanupOwnedAndroidSession({...options,api:async(path,body)=>{assert.equal(body,undefined);assert.equal(path,'/api/arena/session');return{session_id:state.sessionId,external_user_id:state.playerId,game_id:'run',scope:{app_id:state.appId},active_room_id:'inherited_room',other_active_game:null};}});assert.equal(foreign.passed,false);assert.match(foreign.error,/FOREIGN_ACTIVE_ROOM_PRESERVED/);assert.equal(leaves,1);
 const changed=structuredClone(state);changed.sessionId='other_session';const wrongSession=await cleanupOwnedAndroidSession({...options,state:changed,api:()=>assert.fail('No read or mutation with changed session')});assert.equal(wrongSession.passed,false);
});

test('late response/body loss during browser close is retained, final drain revokes pass and all owned listeners close',async()=>{
 const out=await mkdtemp(join(tmpdir(),'player-response-drain-unit-')),page=new EventEmitter(),cdp=new EventEmitter(),origin='https://player.tianyahuyu.com',redactor=createPlayerEvidenceRedactor();let detached=false;cdp.send=async()=>{};cdp.detach=async()=>{detached=true;};
 const result={passed:true,cleanup:{passed:true},observer_errors:[],js_errors:[],resource_errors:[],http_errors:[],network_errors:[],pending_network_observations:0},calls=[];
 const evidence=await collectPlayerEvidence({context:{newCDPSession:async()=>cdp},page,origin,manifest:playerResourceManifest({format:1,inputs:{},outputs:{'platform/dist/index.html':'a'.repeat(64),'platform/arena/dist/index.html':'b'.repeat(64)}}),out,redactor,result});
 const request={url:()=>origin+'/api/player/wallet?app_id=actual_player_app',method:()=> 'GET',frame:()=>({url:()=>origin+'/player?app_id=actual_player_app'}),headers:()=>({cookie:'real-private-cookie'}),postData:()=>null,resourceType:()=> 'fetch'};
 const response={url:request.url,request:()=>request,status:()=>200,ok:()=>true,allHeaders:async()=>({}),body:async()=>{await new Promise(resolve=>setTimeout(resolve,1));throw Error('REAL_RESPONSE_BODY_LOST');}};
 const browser={close:async()=>{calls.push('CLOSE');page.emit('request',request);page.emit('response',response);cdp.emit('Network.loadingFailed',{requestId:'preserved-raw-id',errorText:'net::ERR_ABORTED'});}};
 const holder={result,drain:async({final})=>{calls.push(final?'FINAL':'FENCE');if(final)result.observer_errors.push({stage:'response-body',message:'REAL_RESPONSE_BODY_LOST'});}},errors=[];
 try{await closePlayerObservation({browser,evidence,holder,errors,clean:redactor.clean});assert.deepEqual(calls,['FENCE','CLOSE','FINAL']);assert.equal(result.passed,false);assert.equal(result.post_close_drained,true);assert.ok(errors.includes('REAL_RESPONSE_BODY_LOST'));assert.equal(detached,true);assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('response'),0);
  const saved=await readFile(join(out,'network-bodies.json'),'utf8');assert.doesNotMatch(saved,/real-private-cookie/);assert.match(saved,/REAL_RESPONSE_BODY_LOST/);assert.match(await readFile(join(out,'raw-cdp.json'),'utf8'),/preserved-raw-id/);
 }finally{await rm(out,{recursive:true,force:true});}
});
