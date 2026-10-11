import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {validateBuildConfiguration} from '../android-player/build-config.mjs';
import {ARENA_IDS} from '../shared/games.mjs';
import {NATIVE_HEALTH_SOURCE08,validateNativeHealthProducerContract} from '../deploy/native-browser-checks.mjs';

export const playerEvidenceHash=value=>createHash('sha256').update(value).digest('hex');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const terminal=status=>['settled','cancelled','voided'].includes(status);

export function playerAcceptanceArguments(argv){
 const result={mode:'basic',run:false};
 const keys={'--metadata':'metadata','--credentials-file':'credentialsFile','--platform-manifest':'platformManifest','--health-producer-contract':'healthProducerContract','--apksigner':'apksigner','--output':'output','--adb-port':'adbPort','--serial':'serial','--mode':'mode','--games':'games'};
 const seen=new Set();
 for(let i=0;i<argv.length;i++){
  const flag=argv[i];assert.ok(!seen.has(flag),'DUPLICATE_ARGUMENT');seen.add(flag);
  if(flag==='--run'){result.run=true;continue;}
  const key=keys[flag];assert.ok(key,'UNKNOWN_ARGUMENT');const value=argv[++i];assert.ok(value&&!value.startsWith('--'),'ARGUMENT_VALUE_REQUIRED');result[key]=value;
 }
 for(const key of ['metadata','platformManifest','apksigner','output'])assert.ok(result[key],key.toUpperCase()+'_REQUIRED');
 if(result.run){assert.ok(result.credentialsFile,'PRIVATE_CREDENTIAL_FILE_REQUIRED');assert.ok(result.adbPort&&result.serial,'EXPLICIT_ADB_TARGET_REQUIRED');}
 if(result.adbPort!==undefined){assert.match(String(result.adbPort),/^[1-9][0-9]{0,4}$/);assert.ok(Number(result.adbPort)<=65535);result.adbPort=Number(result.adbPort);}
 if(result.serial!==undefined)assert.match(result.serial,/^[A-Za-z0-9_.:-]+$/);assert.ok(['basic','lifecycle'].includes(result.mode),'INVALID_MODE');
 if(result.games){result.games=result.games.split(',');assert.ok(result.games.length&&new Set(result.games).size===result.games.length&&result.games.every(game=>ARENA_IDS.includes(game)),'ONLY_EXPLICIT_ARENA_GAMES');}
 return result;
}

export function validatePlayerArtifactMetadata(value){
 assert.ok(record(value),'PLAYER_METADATA_REQUIRED');
 const config=validateBuildConfiguration(value);
 assert.equal(config.variant,'qa','REAL_QA_APK_REQUIRED');assert.equal(config.flavor,'qa','REAL_QA_APK_REQUIRED');
 assert.equal(value.contractFixture,false,'CONTRACT_FIXTURE_REFUSED');assert.equal(value.debuggable,true,'DEBUGGABLE_QA_REQUIRED');
 for(const key of ['entryUrl','flavor','version','versionCode','packageName','debuggable','apkName'])assert.equal(value[key],config[key],'PLAYER_BUILD_CONFIGURATION_MISMATCH');
 assert.ok(sha(value.apkSha256)&&sha(value.certificateSha256),'PLAYER_APK_AND_CERTIFICATE_HASH_REQUIRED');
 assert.ok(Number.isSafeInteger(value.apkBytes)&&value.apkBytes>0,'PLAYER_APK_SIZE_REQUIRED');
 assert.ok(Number.isFinite(Date.parse(value.builtAt)),'PLAYER_BUILD_TIME_REQUIRED');
 assert.equal(value.buildTools,'35.0.1');assert.equal(value.minSdk,26);assert.equal(value.targetSdk,35);assert.equal(value.compileSdk,35);
 assert.equal(value.checks?.configuration?.passed,true);assert.ok(Number.isSafeInteger(value.checks.configuration.groups)&&value.checks.configuration.groups>0);
 assert.equal(value.checks?.navigation?.passed,true);assert.equal(value.checks?.backBridge?.passed,true);
 const source=value.sourceEvidence;assert.ok(record(source)&&/^[a-f0-9]{40}$/.test(source.baseRevision)&&sha(source.sourceSha256)&&record(source.files),'PLAYER_SOURCE_PINS_REQUIRED');
 const names=Object.keys(source.files);assert.ok(names.length>0&&names.every(name=>!name.startsWith('/')&&!name.split('/').some(part=>['..','build','dist','.local'].includes(part))&&sha(source.files[name])),'PLAYER_SOURCE_PINS_INVALID');
 assert.equal(playerEvidenceHash(JSON.stringify(source.files)),source.sourceSha256,'PLAYER_SOURCE_AGGREGATE_MISMATCH');
 assert.ok(exact(value.generatedSha256,['manifest','resources','configuration'])&&Object.values(value.generatedSha256).every(sha),'PLAYER_GENERATED_PINS_REQUIRED');
 return Object.freeze({...config,apkSha256:value.apkSha256,certificateSha256:value.certificateSha256,apkBytes:value.apkBytes,sourceEvidence:source,generatedSha256:value.generatedSha256});
}

export async function playerShellSourcePins(root){
 const files={};
 async function visit(relative=''){
  for(const entry of (await readdir(join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(['build','dist','.local'].includes(entry.name))continue;
   assert.ok(!entry.isSymbolicLink(),'PLAYER_SOURCE_SYMLINK_REFUSED');const name=relative?relative+'/'+entry.name:entry.name;
   if(entry.isDirectory())await visit(name);else{assert.ok(entry.isFile(),'PLAYER_SOURCE_TYPE_INVALID');files[name]=playerEvidenceHash(await readFile(join(root,name)));}
  }
 }
 await visit();return files;
}

export async function readPlayerArtifact(metadataPath,{shellRoot,execute,apksigner}){
 const path=resolve(metadataPath),info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink(),'PLAYER_METADATA_FILE_INVALID');
 const bytes=await readFile(path),raw=JSON.parse(bytes),artifact=validatePlayerArtifactMetadata(raw),apkPath=join(dirname(path),artifact.apkName),apkInfo=await lstat(apkPath);
 assert.ok(apkInfo.isFile()&&!apkInfo.isSymbolicLink(),'PLAYER_APK_FILE_INVALID');const apk=await readFile(apkPath);
 assert.equal(apk.length,artifact.apkBytes,'PLAYER_APK_SIZE_MISMATCH');assert.equal(playerEvidenceHash(apk),artifact.apkSha256,'PLAYER_APK_HASH_MISMATCH');
 assert.deepEqual(await playerShellSourcePins(shellRoot),artifact.sourceEvidence.files,'PLAYER_APK_SOURCE_CHANGED');
 const signature=await execute(apksigner,['verify','--verbose','--print-certs',apkPath],{timeout:45000,maxBuffer:2*1024*1024});
 assert.match(signature.stdout,/Verified using v2 scheme \(APK Signature Scheme v2\): true/,'PLAYER_APK_SIGNATURE_UNVERIFIED');
 assert.equal(signature.stdout.match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})/)?.[1],artifact.certificateSha256,'PLAYER_CERTIFICATE_MISMATCH');
 assert.ok(!/Signer #2/.test(signature.stdout),'PLAYER_MULTIPLE_SIGNERS_REFUSED');
 return Object.freeze({...artifact,apkPath,metadataPath:path,metadataSha256:playerEvidenceHash(bytes)});
}

export function createPlayerEvidenceRedactor(initial=[]){
 const secrets=new Set();
 const add=value=>{if(typeof value==='string'&&value){secrets.add(value);secrets.add(JSON.stringify(value).slice(1,-1));secrets.add(encodeURIComponent(value));}};
 for(const value of initial)add(value);
 function remember(value,key=''){
  if(value&&typeof value==='object'){if(key==='player')add(value.id);for(const[k,v]of Object.entries(value))remember(v,k);return;}
  if(typeof value!=='string')return;
  if(/password|username|authorization|cookie|csrf|token|secret|launch_?code|session_?id|external_?user_?id|player_?id/i.test(key)){
   add(value);if(/authorization/i.test(key))add(value.replace(/^Bearer\s+/i,''));
   if(/cookie/i.test(key))for(const part of value.split(';')){const v=part.slice(part.indexOf('=')+1).trim();if(part.includes('=')&&v&&!/^(Path|SameSite|Expires|Max-Age)=/i.test(part.trim()))add(v);}
  }
 }
 const clean=value=>{let text=String(value);for(const secret of [...secrets].sort((a,b)=>b.length-a.length))text=text.split(secret).join('[redacted:'+playerEvidenceHash(secret).slice(0,12)+']');return text;};
 const sanitize=value=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='string'?clean(item):item));
 return Object.freeze({remember,add,clean,sanitize});
}

export async function readPlayerCredentials(path,redactor,{openFile=open,statPath=lstat}={}){
 const valid=info=>info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600&&info.uid===process.getuid()&&info.nlink===1;
 const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
 const info=await statPath(path);assert.ok(valid(info),'PRIVATE_0600_OWNED_CREDENTIAL_FILE_REQUIRED');
 assert.ok(info.size>0&&info.size<=4096,'CREDENTIAL_FILE_SIZE_INVALID');let bytes,handle;
 try{
  handle=await openFile(path,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=await handle.stat();assert.ok(valid(opened)&&same(info,opened),'PRIVATE_CREDENTIAL_FILE_REPLACED');
  bytes=await handle.readFile();const after=await handle.stat(),pathAfter=await statPath(path);assert.ok(valid(after)&&valid(pathAfter)&&same(opened,after)&&same(opened,pathAfter)&&bytes.length===opened.size,'PRIVATE_CREDENTIAL_FILE_CHANGED');
 }finally{await handle?.close();}
 redactor.add(bytes.toString());
 let value;try{value=JSON.parse(bytes);}catch{throw Error('PRIVATE_CREDENTIAL_JSON_INVALID');}redactor.remember(value);
 assert.ok(exact(value,['username','password'])&&typeof value.username==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(value.username)&&typeof value.password==='string'&&value.password.length>=12&&value.password.length<=256,'PRIVATE_CREDENTIAL_SCHEMA_INVALID');
 return Object.freeze(value);
}

/** Read one frozen local producer selection. Root must independently confirm the
 * live deployment; historical receipt/source hashes are not a fresh remote check. */
export async function readNativeHealthProducerContract(path,{root,origin,openFile=open,statPath=lstat}={}){
 const fields=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
 const same=(a,b)=>fields.every(key=>a[key]===b[key]);
 const metadata=info=>Object.fromEntries(fields.map(key=>[key,String(info[key])]));
 async function readStable(file,{limit,privateContract=false}={}){
  const valid=info=>info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n&&(!privateContract||(info.mode&0o7777n)===0o600n&&info.uid===BigInt(process.getuid()));
  const before=await statPath(file,{bigint:true});assert.ok(valid(before),'HEALTH_PRODUCER_FILE_IDENTITY_INVALID');assert.ok(before.size>0n&&before.size<=BigInt(limit),'HEALTH_PRODUCER_FILE_SIZE_INVALID');
  let handle;try{
   handle=await openFile(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const opened=await handle.stat({bigint:true});assert.ok(valid(opened)&&same(before,opened),'HEALTH_PRODUCER_FILE_REPLACED');
   const buffer=Buffer.alloc(Number(opened.size)+1);let size=0;
   while(size<buffer.length){const {bytesRead}=await handle.read(buffer,size,buffer.length-size,size);if(bytesRead===0)break;size+=bytesRead;}
   const after=await handle.stat({bigint:true}),pathAfter=await statPath(file,{bigint:true});assert.ok(valid(after)&&valid(pathAfter)&&same(opened,after)&&same(opened,pathAfter)&&BigInt(size)===opened.size,'HEALTH_PRODUCER_FILE_CHANGED');
   const bytes=buffer.subarray(0,size);return{bytes,sha256:playerEvidenceHash(bytes),metadata:metadata(after)};
  }finally{await handle?.close();}
 }
 const contractPath=resolve(path),input=await readStable(contractPath,{limit:16384,privateContract:true});
 let value;try{value=JSON.parse(input.bytes);}catch{throw Error('HEALTH_PRODUCER_CONTRACT_JSON_INVALID');}
 const contract=validateNativeHealthProducerContract(value,{origin});
 const manifest=await readStable(contract.release_manifest.path,{limit:2*1024*1024});assert.equal(manifest.sha256,contract.release_manifest.sha256,'HEALTH_PRODUCER_ACTUAL_MANIFEST_MISMATCH');
 const raw=JSON.parse(manifest.bytes),sourcePins={};
 for(const [name,expected]of Object.entries(NATIVE_HEALTH_SOURCE08.sourceSha256)){
  assert.equal(raw?.[name],expected,'HEALTH_PRODUCER_ACTUAL_MANIFEST_SOURCE_MISMATCH');
  const source=await readStable(join(root,name.slice('platform/'.length)),{limit:2*1024*1024});assert.equal(source.sha256,expected,'HEALTH_PRODUCER_ACTUAL_SOURCE_MISMATCH');sourcePins[name]=source.sha256;
 }
 validateNativeHealthProducerContract(contract,{origin,manifestSha256:manifest.sha256,sourcePins});
 const deployment=await readStable(contract.deployment_evidence.path,{limit:8*1024*1024});assert.equal(deployment.sha256,contract.deployment_evidence.sha256,'HEALTH_PRODUCER_ACTUAL_DEPLOYMENT_EVIDENCE_MISMATCH');
 // These paths were read from the original e520 receipt, not guessed from the
 // local build stamp. A failed capacity receipt cannot satisfy this authority.
 const authority=JSON.parse(deployment.bytes);assert.equal(authority.schema,1,'HEALTH_PRODUCER_DEPLOYMENT_SCHEMA_INVALID');assert.equal(authority.passed,true,'HEALTH_PRODUCER_DEPLOYMENT_NOT_CONFIRMED');assert.equal(authority.phase,'complete_free_open','HEALTH_PRODUCER_DEPLOYMENT_NOT_CONFIRMED');
 assert.equal(authority.target_manifest_sha256,manifest.sha256,'HEALTH_PRODUCER_DEPLOYMENT_MANIFEST_MISMATCH');assert.equal(authority.target_release,'/opt/oasis/releases/20261011-01','HEALTH_PRODUCER_DEPLOYMENT_RELEASE_MISMATCH');
 assert.equal(authority.final?.inspection?.environment,'production','HEALTH_PRODUCER_DEPLOYMENT_ENVIRONMENT_MISMATCH');assert.equal(authority.final?.https?.passed,true,'HEALTH_PRODUCER_DEPLOYMENT_TLS_UNPROVEN');assert.equal(authority.final.https.origin,origin,'HEALTH_PRODUCER_DEPLOYMENT_ORIGIN_MISMATCH');
 assert.equal(authority.final?.state?.runtime_profile?.manifest_sha256,manifest.sha256,'HEALTH_PRODUCER_RUNTIME_MANIFEST_MISMATCH');assert.equal(authority.final.state.runtime_profile.public_origin,origin,'HEALTH_PRODUCER_RUNTIME_ORIGIN_MISMATCH');assert.equal(authority.final.state.runtime_profile.release,authority.target_release,'HEALTH_PRODUCER_RUNTIME_RELEASE_MISMATCH');
 return Object.freeze({contract,sha256:input.sha256,provenance:Object.freeze({contract_path:contractPath,contract_metadata:input.metadata,release_manifest:{...contract.release_manifest,metadata:manifest.metadata},source_sha256:sourcePins,deployment_evidence:{...contract.deployment_evidence,metadata:deployment.metadata},selection:'Explicit frozen source08 production producer contract',fresh_deployment_confirmation:false,live_confirmation_owner:'Root execution wrapper; not this local contract reader',consumer_mode:'producer-bound-native-arraybuffer',runtime_byte_cap:false,producer_max_body_bytes:42,post_read_body_limit_bytes:16384})});
}

export function assertPlayerLobbyBaseline({metadata,session,wallet,recovery,appId,username}){
 assert.equal(metadata?.admission_open,true,'PRODUCTION_APP_ADMISSION_CLOSED');assert.ok(typeof metadata.name==='string'&&Array.isArray(metadata.game_ids),'PLAYER_CATALOG_REQUIRED');
 assert.deepEqual([...metadata.game_ids].sort(),[...ARENA_IDS].sort(),'PRODUCTION_ARENA_CATALOG_REQUIRED');
 assert.ok(id(session?.player?.id)&&session.player.username===username,'ORIGINAL_PLAYER_LOGIN_REQUIRED');
 assert.ok(Array.isArray(recovery?.sessions),'PLAYER_RECOVERY_BASELINE_REQUIRED');assert.deepEqual(recovery.sessions,[],'INHERITED_OBLIGATIONS_PRESERVED');
 assertPlayerZeroWallet(wallet,appId);return Object.freeze({appId,playerId:session.player.id,externalUserId:wallet.balance.external_user_id,partnerId:wallet.partner_id,walletScopeId:wallet.wallet_scope_id,currencyId:wallet.currency_id,currencyScale:wallet.balance.currency_scale,ledgerVersion:wallet.balance.ledger_version});
}

export function assertPlayerZeroWallet(wallet,appId,baseline=null){
 assert.equal(wallet?.app_id,appId,'PLAYER_WALLET_APP_MISMATCH');assert.equal(wallet.environment,'production','REAL_PRODUCTION_WALLET_REQUIRED');
 for(const key of ['partner_id','wallet_scope_id','currency_id'])assert.ok(id(wallet[key]),'PLAYER_WALLET_SCOPE_REQUIRED');
 const b=wallet.balance;assert.ok(id(b?.external_user_id),'PLAYER_WALLET_IDENTITY_REQUIRED');
 assert.equal(b.available_minor,'0','REAL_ZERO_BALANCE_REQUIRED');assert.equal(b.reserved_minor,'0','ZERO_RESERVED_BALANCE_REQUIRED');
 assert.ok(typeof b.ledger_version==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(b.ledger_version)&&BigInt(b.ledger_version)<=9223372036854775807n,'PLAYER_LEDGER_VERSION_REQUIRED');
 assert.ok(Number.isInteger(b.currency_scale)&&b.currency_scale>=0&&b.currency_scale<=6&&Number.isFinite(Date.parse(wallet.as_of)),'PLAYER_WALLET_PRECISION_REQUIRED');
 if(baseline){assert.equal(b.external_user_id,baseline.externalUserId,'PLAYER_WALLET_IDENTITY_CHANGED');assert.equal(wallet.partner_id,baseline.partnerId,'PLAYER_PARTNER_CHANGED');assert.equal(wallet.wallet_scope_id,baseline.walletScopeId,'PLAYER_WALLET_SCOPE_CHANGED');assert.equal(wallet.currency_id,baseline.currencyId,'PLAYER_CURRENCY_CHANGED');assert.equal(b.currency_scale,baseline.currencyScale,'PLAYER_PRECISION_CHANGED');assert.ok(BigInt(b.ledger_version)>=BigInt(baseline.ledgerVersion),'PLAYER_LEDGER_REGRESSED');}
 return wallet;
}

export function assertOwnedPlayerArenaState(state,baseline){
 assert.ok(state?.androidBaseline,'PLAYER_ARENA_BASELINE_REQUIRED');
 assert.equal(state.appId,baseline.appId,'PLAYER_ARENA_APP_CHANGED');assert.equal(state.playerId,baseline.externalUserId,'PLAYER_ARENA_IDENTITY_CHANGED');
 for(const key of ['game','sessionId','playerId','appId'])assert.equal(state[key],state.androidBaseline[key],'PLAYER_ORIGINAL_ARENA_CHANGED');
 assert.equal(state.probabilityRequests?.length||0,0,'PROBABILITY_MUTATION_REFUSED');
 for(const creation of state.creations||[]){assert.equal(creation.game,state.game);assert.equal(creation.practice,true);assert.equal(creation.entry,'0');}
 if(state.room){assert.equal(state.room.fee_bps,0,'ZERO_FEE_BOT_ROOM_REQUIRED');assert.equal(state.room.practice,true);assert.equal(state.room.entry_minor,'0');assert.equal(state.room.me,state.playerId);assert.equal(state.room.game_id,state.game);assert.ok(state.ownedRooms.has(state.room.id),'UNOWNED_ROOM_PRESERVED');}
}

export function assertPlayerReturnReadback({state,result,session,recovery,wallet,baseline}){
 assertOwnedPlayerArenaState(state,baseline);assert.equal(result.ui_stopped,true,'PLAYER_GAME_UI_NOT_STOPPED');assert.equal(result.cleanup?.passed,true,'PLAYER_OWNED_CLEANUP_UNPROVEN');
 assert.equal(session?.player?.id,baseline.playerId,'PLAYER_LOGIN_CHANGED');assert.deepEqual(recovery?.sessions,[],'ACTIVE_OBLIGATION_REMAINS');assertPlayerZeroWallet(wallet,baseline.appId,baseline);
 assert.ok(result.wallet_refresh?.status===200&&result.wallet_refresh.after_return===true,'ACTUAL_UI_WALLET_REFRESH_REQUIRED');
 assert.equal(state.creations.length,1,'EXACTLY_ONE_OWNED_PRACTICE_REQUIRED');assert.ok(state.room&&terminal(state.room.status)||result.cleanup.rooms?.length===1&&result.cleanup.rooms[0].terminal===true,'OWNED_ROOM_TERMINAL_REQUIRED');
}

/** A stale in-memory room does not prove background recovery. Bind a successful
 * new iframe GET, its body, original room/session and a newer server head. */
export function playerRunResumeEvidence(rows,{origin,after,token,sessionId,roomId,serverNow,playerId,appId}){
 const row=rows.find(row=>row.request_at>=after&&row.status===200&&row.method==='GET'&&row.request_headers?.authorization==='Bearer '+token&&row.frame===origin+'/play/run'&&row.path==='/api/pvp/rooms/'+roomId&&row.body?.room?.id===roomId&&row.body.room.game_id==='run'&&row.body.room.me===playerId&&row.body.room.status==='active'&&Number.isFinite(row.body.room.server_now)&&row.body.room.server_now>serverNow);
 if(!row)return null;
 assert.ok(sessionId&&appId,'ORIGINAL_RUN_SESSION_REQUIRED');
 return Object.freeze({request_id:row.request_id,requested_at:row.request_at,response_sha256:row.original_sha256,room_id:roomId,session_id:sessionId,app_id:appId,server_now:row.body.room.server_now});
}

export function playerResourceManifest(raw){
 assert.equal(raw?.format,1,'RELEASE_BUILD_MANIFEST_REQUIRED');assert.ok(record(raw.inputs)&&record(raw.outputs),'RELEASE_BUILD_PINS_REQUIRED');
 const expected=new Map();
 for(const[name,digest]of Object.entries(raw.outputs)){
  if(!sha(digest))throw Error('RELEASE_OUTPUT_HASH_INVALID');let path;
  if(name.startsWith('platform/arena/dist/'))path='/arena/'+name.slice('platform/arena/dist/'.length);
  else if(name.startsWith('platform/dist/'))path='/'+name.slice('platform/dist/'.length);
  if(path)expected.set(path,digest);
 }
 assert.ok(expected.has('/index.html')&&expected.has('/arena/index.html'),'PLAYER_AND_ARENA_OUTPUT_PINS_REQUIRED');
 return{expected,inputs:raw.inputs};
}

export const playerResourcePath=path=>path==='/player'?'/index.html':/^\/play\/[a-z]+$/.test(path)?'/arena/index.html':path;
export function assertPlayerResourceBody(url,bytes,{origin,manifest}){
 const parsed=new URL(url);if(parsed.origin!==origin)return null;
 const path=playerResourcePath(parsed.pathname),expected=manifest.expected.get(path);assert.ok(expected,'UNPINNED_PLAYER_RESOURCE: '+path);
 assert.equal(playerEvidenceHash(bytes),expected,'PLAYER_RESOURCE_BODY_SHA_MISMATCH: '+path);return{path,sha256:expected,bytes:bytes.length,source:'Exact HTTP response body bound to release-build-manifest.outputs'};
}

export function assertInstalledPlayerArtifact(info,artifact){
 assert.equal(info.apkSha256,artifact.apkSha256,'INSTALLED_PLAYER_APK_HASH_MISMATCH');assert.equal(info.version,artifact.version,'INSTALLED_PLAYER_VERSION_MISMATCH');assert.equal(info.versionCode,artifact.versionCode,'INSTALLED_PLAYER_VERSION_CODE_MISMATCH');assert.equal(info.debuggable,true,'INSTALLED_PLAYER_QA_NOT_DEBUGGABLE');
 return info;
}

export const playerArtifactName=artifact=>basename(artifact.apkPath);
