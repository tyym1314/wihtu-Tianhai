import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {validateBuildConfiguration} from '../android-player/build-config.mjs';
import {ARENA_IDS,LEGACY_IDS,RELEASED_IDS} from '../shared/games.mjs';
import {validateNativeHealthProducerSelection,validateNativeHealthProducerContract,validateSource15NativeDeploymentEvidence} from '../deploy/native-browser-checks.mjs';
import {statistics} from './mobile-quality-metrics.mjs';

export const playerEvidenceHash=value=>createHash('sha256').update(value).digest('hex');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const terminal=status=>['settled','cancelled','voided'].includes(status);
export const PLAYER_FREE_PROFILE='firstparty-free-v1';
export const PLAYER_INTERNAL_PROFILE='firstparty-internal-games-v1';
export function playerCatalog(profile=PLAYER_FREE_PROFILE){assert.ok([PLAYER_FREE_PROFILE,PLAYER_INTERNAL_PROFILE].includes(profile),'PLAYER_ADMISSION_PROFILE_REQUIRED');return profile===PLAYER_INTERNAL_PROFILE?RELEASED_IDS:ARENA_IDS;}
export function assertPlayerDeviceSelection(options){
 assert.equal(options.adbPort,5037,'AUTHORIZED_ADB_PORT_REQUIRED');const role=options.deviceRole??'physical';assert.ok(['physical','cloud'].includes(role),'EXPLICIT_DEVICE_ROLE_REQUIRED');
 if(role==='physical')assert.equal(options.serial,'46dcfd25','AUTHORIZED_PHYSICAL_SERIAL_REQUIRED');else{assert.match(options.serial??'',/^localhost:[1-9][0-9]{0,4}$/,'EXPLICIT_VMOS_SERIAL_REQUIRED');assert.ok(Number(options.serial.split(':')[1])<=65535,'VMOS_PORT_OUT_OF_RANGE');}
 return role;
}
export function assertPlayerDeviceTransport(devices,options){const role=assertPlayerDeviceSelection(options),rows=devices.split(/\r?\n/).filter(line=>line.split(/\s+/)[0]===options.serial);assert.equal(rows.length,1,'UNIQUE_ANDROID_TARGET_REQUIRED');assert.equal(rows[0].split(/\s+/)[1],'device','ANDROID_TARGET_NOT_AUTHORIZED');assert.equal(/\busb:\S+/.test(rows[0]),role==='physical','ANDROID_TRANSPORT_ROLE_MISMATCH');return{role,serial:options.serial,physicalDevice:role==='physical',originalDeviceLine:rows[0]};}

export function playerAcceptanceArguments(argv){
 const result={mode:'basic',run:false,profile:PLAYER_FREE_PROFILE,deviceRole:'physical'};
 const keys={'--metadata':'metadata','--credentials-file':'credentialsFile','--platform-manifest':'platformManifest','--health-producer-contract':'healthProducerContract','--apksigner':'apksigner','--output':'output','--adb-port':'adbPort','--serial':'serial','--mode':'mode','--games':'games','--profile':'profile','--device-role':'deviceRole'};
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
 const catalog=playerCatalog(result.profile);if(result.run)assertPlayerDeviceSelection(result);
 if(result.games){result.games=result.games.split(',');assert.ok(result.games.length&&new Set(result.games).size===result.games.length&&result.games.every(game=>catalog.includes(game)),result.profile===PLAYER_FREE_PROFILE?'ONLY_EXPLICIT_ARENA_GAMES':'ONLY_EXPLICIT_RELEASED_GAMES');}
 if(result.mode==='lifecycle')assert.equal(result.profile,PLAYER_FREE_PROFILE,'INTERNAL_LIFECYCLE_NOT_IMPLEMENTED');
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
 let contract=validateNativeHealthProducerSelection(value,{origin});
 const manifest=await readStable(contract.release_manifest.path,{limit:2*1024*1024});assert.equal(manifest.sha256,contract.release_manifest.sha256,'HEALTH_PRODUCER_ACTUAL_MANIFEST_MISMATCH');
 const raw=JSON.parse(manifest.bytes),sourcePins={};
 for(const [name,expected]of Object.entries(contract.source_sha256)){
  assert.equal(raw?.[name],expected,'HEALTH_PRODUCER_ACTUAL_MANIFEST_SOURCE_MISMATCH');
  const source=await readStable(join(root,name.slice('platform/'.length)),{limit:2*1024*1024});assert.equal(source.sha256,expected,'HEALTH_PRODUCER_ACTUAL_SOURCE_MISMATCH');sourcePins[name]=source.sha256;
 }
 const deployment=await readStable(contract.deployment_evidence.path,{limit:8*1024*1024});assert.equal(deployment.sha256,contract.deployment_evidence.sha256,'HEALTH_PRODUCER_ACTUAL_DEPLOYMENT_EVIDENCE_MISMATCH');
 if(contract.schema==='root-source15-native-health-producer-contract-v1'){
  validateSource15NativeDeploymentEvidence(JSON.parse(deployment.bytes),{origin,manifestSha256:manifest.sha256});contract=validateNativeHealthProducerContract(contract,{origin,manifestSha256:manifest.sha256,sourcePins,deploymentEvidenceSha256:deployment.sha256});
  return Object.freeze({contract,sha256:input.sha256,provenance:Object.freeze({contract_path:contractPath,contract_metadata:input.metadata,release_manifest:{...contract.release_manifest,metadata:manifest.metadata},source_sha256:sourcePins,deployment_evidence:{...contract.deployment_evidence,metadata:deployment.metadata},selection:'Actual Source15 internal13 open receipt and exact three producer source bodies; local reader is not a fresh remote observation',fresh_deployment_confirmation:false,live_confirmation_owner:'Root execution; not local contract reader',consumer_mode:'producer-bound-native-arraybuffer',runtime_byte_cap:false,producer_max_body_bytes:42,post_read_body_limit_bytes:16384})});
 }
 contract=validateNativeHealthProducerContract(contract,{origin,manifestSha256:manifest.sha256,sourcePins});
 // These paths were read from the original e520 receipt, not guessed from the
 // local build stamp. A failed capacity receipt cannot satisfy this authority.
 const authority=JSON.parse(deployment.bytes);assert.equal(authority.schema,1,'HEALTH_PRODUCER_DEPLOYMENT_SCHEMA_INVALID');assert.equal(authority.passed,true,'HEALTH_PRODUCER_DEPLOYMENT_NOT_CONFIRMED');assert.equal(authority.phase,'complete_free_open','HEALTH_PRODUCER_DEPLOYMENT_NOT_CONFIRMED');
 assert.equal(authority.target_manifest_sha256,manifest.sha256,'HEALTH_PRODUCER_DEPLOYMENT_MANIFEST_MISMATCH');assert.equal(authority.target_release,'/opt/oasis/releases/20261011-01','HEALTH_PRODUCER_DEPLOYMENT_RELEASE_MISMATCH');
 assert.equal(authority.final?.inspection?.environment,'production','HEALTH_PRODUCER_DEPLOYMENT_ENVIRONMENT_MISMATCH');assert.equal(authority.final?.https?.passed,true,'HEALTH_PRODUCER_DEPLOYMENT_TLS_UNPROVEN');assert.equal(authority.final.https.origin,origin,'HEALTH_PRODUCER_DEPLOYMENT_ORIGIN_MISMATCH');
 assert.equal(authority.final?.state?.runtime_profile?.manifest_sha256,manifest.sha256,'HEALTH_PRODUCER_RUNTIME_MANIFEST_MISMATCH');assert.equal(authority.final.state.runtime_profile.public_origin,origin,'HEALTH_PRODUCER_RUNTIME_ORIGIN_MISMATCH');assert.equal(authority.final.state.runtime_profile.release,authority.target_release,'HEALTH_PRODUCER_RUNTIME_RELEASE_MISMATCH');
 return Object.freeze({contract,sha256:input.sha256,provenance:Object.freeze({contract_path:contractPath,contract_metadata:input.metadata,release_manifest:{...contract.release_manifest,metadata:manifest.metadata},source_sha256:sourcePins,deployment_evidence:{...contract.deployment_evidence,metadata:deployment.metadata},selection:'Explicit frozen source08 production producer contract',fresh_deployment_confirmation:false,live_confirmation_owner:'Root execution wrapper; not this local contract reader',consumer_mode:'producer-bound-native-arraybuffer',runtime_byte_cap:false,producer_max_body_bytes:42,post_read_body_limit_bytes:16384})});
}

export function assertPlayerLobbyBaseline({metadata,session,wallet,recovery,appId,username,profile=PLAYER_FREE_PROFILE}){
 assert.equal(metadata?.admission_open,true,'PRODUCTION_APP_ADMISSION_CLOSED');assert.ok(typeof metadata.name==='string'&&Array.isArray(metadata.game_ids),'PLAYER_CATALOG_REQUIRED');
 assert.deepEqual([...metadata.game_ids].sort(),[...playerCatalog(profile)].sort(),'PRODUCTION_ADMITTED_CATALOG_REQUIRED');
 if(profile===PLAYER_INTERNAL_PROFILE){assert.equal(metadata.admission_profile,profile,'INTERNAL_PLAYER_PROFILE_REQUIRED');for(const key of ['internal_game_coins','financial_admission_enabled','probability_admission_enabled'])assert.equal(metadata[key],true,'INTERNAL_PLAYER_CAPABILITY_REQUIRED');for(const key of ['external_financial_admission_enabled','thirdparty_financial_admission_enabled','deposit_enabled','withdrawal_enabled'])assert.equal(metadata[key],false,'EXTERNAL_MONEY_CAPABILITY_REFUSED');assert.equal(metadata.coin_scope,'internal-nonredeemable','INTERNAL_COIN_SCOPE_REQUIRED');}
 assert.ok(id(session?.player?.id)&&session.player.username===username,'ORIGINAL_PLAYER_LOGIN_REQUIRED');
 assert.ok(Array.isArray(recovery?.sessions),'PLAYER_RECOVERY_BASELINE_REQUIRED');assert.deepEqual(recovery.sessions,[],'INHERITED_OBLIGATIONS_PRESERVED');
 assertPlayerWallet(wallet,appId,null,{profile});return Object.freeze({appId,profile,playerId:session.player.id,externalUserId:wallet.balance.external_user_id,partnerId:wallet.partner_id,walletScopeId:wallet.wallet_scope_id,currencyId:wallet.currency_id,currencyScale:wallet.balance.currency_scale,ledgerVersion:wallet.balance.ledger_version,availableMinor:wallet.balance.available_minor});
}

export function assertPlayerZeroWallet(wallet,appId,baseline=null){
 return assertPlayerWallet(wallet,appId,baseline,{profile:PLAYER_FREE_PROFILE});
}
export function assertPlayerWallet(wallet,appId,baseline=null,{profile=baseline?.profile??PLAYER_FREE_PROFILE}={}){
 playerCatalog(profile);
 assert.equal(wallet?.app_id,appId,'PLAYER_WALLET_APP_MISMATCH');assert.equal(wallet.environment,'production','REAL_PRODUCTION_WALLET_REQUIRED');
 for(const key of ['partner_id','wallet_scope_id','currency_id'])assert.ok(id(wallet[key]),'PLAYER_WALLET_SCOPE_REQUIRED');
 const b=wallet.balance;assert.ok(id(b?.external_user_id),'PLAYER_WALLET_IDENTITY_REQUIRED');
 assert.ok(typeof b.available_minor==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(b.available_minor)&&BigInt(b.available_minor)<=9223372036854775807n,'PLAYER_AVAILABLE_BALANCE_REQUIRED');
 if(profile===PLAYER_FREE_PROFILE)assert.equal(b.available_minor,'0','REAL_ZERO_BALANCE_REQUIRED');assert.equal(b.reserved_minor,'0','ZERO_RESERVED_BALANCE_REQUIRED');
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
 const probability=LEGACY_IDS.includes(state.game);if(probability)assertOwnedPlayerProbabilityState(state,baseline);else assertOwnedPlayerArenaState(state,baseline);assert.equal(result.ui_stopped,true,'PLAYER_GAME_UI_NOT_STOPPED');assert.equal(result.cleanup?.passed,true,'PLAYER_OWNED_CLEANUP_UNPROVEN');
 assert.equal(session?.player?.id,baseline.playerId,'PLAYER_LOGIN_CHANGED');assert.deepEqual(recovery?.sessions,[],'ACTIVE_OBLIGATION_REMAINS');assertPlayerWallet(wallet,baseline.appId,baseline);
 assert.ok(result.wallet_refresh?.status===200&&result.wallet_refresh.after_return===true,'ACTUAL_UI_WALLET_REFRESH_REQUIRED');
 if(probability){assert.equal(result.cleanup.probability?.new_paid_spins,0,'CLEANUP_NEW_PAID_CYCLE_REFUSED');assert.equal(result.cleanup.probability?.final_readback?.session_id,state.sessionId);assert.equal(result.cleanup.probability.final_readback.pendingRound,null);assert.equal(result.cleanup.probability.final_readback.freeSpins,0);assert.ok(result.probability?.cycleId,'REAL_PROBABILITY_CYCLE_REQUIRED');}
 else{assert.equal(state.creations.length,1,'EXACTLY_ONE_OWNED_PRACTICE_REQUIRED');assert.ok(state.room&&terminal(state.room.status)||result.cleanup.rooms?.length===1&&result.cleanup.rooms[0].terminal===true,'OWNED_ROOM_TERMINAL_REQUIRED');}
}
export function assertOwnedPlayerProbabilityState(state,baseline){
 assert.equal(baseline.profile,PLAYER_INTERNAL_PROFILE,'INTERNAL_PROBABILITY_PROFILE_REQUIRED');assert.ok(LEGACY_IDS.includes(state.game)&&state.androidBaseline,'PLAYER_PROBABILITY_BASELINE_REQUIRED');
 for(const key of ['game','sessionId','playerId','appId'])assert.equal(state[key],state.androidBaseline[key],'PLAYER_ORIGINAL_PROBABILITY_CHANGED');assert.equal(state.appId,baseline.appId);assert.equal(state.playerId,baseline.externalUserId);
 assert.equal((state.creations?.length||0)+(state.actionRequests?.length||0)+(state.inputsRequests?.length||0),0,'ARENA_MUTATION_IN_PROBABILITY_REFUSED');assert.equal(state.ownedRooms.size,0,'PROBABILITY_ROOM_REFUSED');
}
export function assertPlayerProbabilitySession(session,{state,baseline,complete=false}){
 assertOwnedPlayerProbabilityState(state,baseline);assert.equal(session?.sessionId,state.sessionId,'ORIGINAL_PROBABILITY_SESSION_CHANGED');assert.equal(session.mode,'production');assert.equal(session.platformMode,'production');assert.equal(session.unitsPerCoin,10**baseline.currencyScale,'PROBABILITY_PRECISION_CHANGED');assert.equal(session.admission_profile,PLAYER_INTERNAL_PROFILE);
 assert.ok(Number.isSafeInteger(session.stateVersion)&&session.stateVersion>=0&&Number.isSafeInteger(session.freeSpins)&&session.freeSpins>=0,'PROBABILITY_AUTHORITY_INVALID');assert.ok(Number.isFinite(session.balance)&&session.balance>=0,'REAL_PROBABILITY_BALANCE_REQUIRED');if(complete){assert.equal(session.pendingRound,null,'OWNED_PENDING_ROUND_REMAINS');assert.equal(session.freeSpins,0,'OWNED_BONUS_REMAINS');}return session;
}
export function probabilityCoinsToMinor(value,scale){
 assert.ok(Number.isFinite(value)&&value>=0&&Number.isInteger(scale)&&scale>=0&&scale<=6,'PROBABILITY_COIN_AMOUNT_INVALID');const text=String(value),match=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);assert.ok(match&&(match[2]?.length??0)<=scale,'PROBABILITY_COIN_PRECISION_INVALID');const minor=BigInt(match[1])*10n**BigInt(scale)+BigInt((match[2]??'').padEnd(scale,'0')||'0');assert.ok(minor<=9223372036854775807n,'PROBABILITY_COIN_CAPACITY_INVALID');return minor.toString();
}
/** Lightweight observation in the original probability realm. No inputs,
 * business requests, screenshot loops or replacements of browser functions. */
export function installProbabilityPerformanceProbe({origin,game,nonce,entryUrl}){
 if(location.href!==origin+'/play/'+game||!['thunder','tiger'].includes(game)||parent.location.href!==entryUrl||typeof nonce!=='string')throw Error('PROBABILITY_PERFORMANCE_OWNER_REQUIRED');
 if(globalThis.__oasisProbabilityNormalFrames)throw Error('PROBABILITY_PERFORMANCE_ALREADY_INSTALLED');
 const p={schema:'probability-normal-presentation-frames-v1',nonce,game,url:location.href,parentUrl:parent.location.href,timeOrigin:performance.timeOrigin,documentId:Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join(''),startAt:null,endAt:null,frames:[],longTasks:[],hidden:document.visibilityState!=='visible',dropped:0,longTaskSupported:typeof PerformanceObserver==='function'&&PerformanceObserver.supportedEntryTypes.includes('longtask'),stopped:false};
 let previous,raf,observer;const tick=at=>{if(previous!==undefined&&p.startAt!==null){if(p.frames.length<30000)p.frames.push({at,ms:at-previous,visible:document.visibilityState==='visible'});else p.dropped++;}previous=at;if(!p.stopped)raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);
 const visibility=()=>{if(document.visibilityState!=='visible')p.hidden=true;};document.addEventListener('visibilitychange',visibility);
 if(p.longTaskSupported){observer=new PerformanceObserver(list=>{for(const e of list.getEntries())if(p.startAt!==null){if(p.longTasks.length<2000)p.longTasks.push({at:e.startTime,ms:e.duration});else p.dropped++;}});observer.observe({type:'longtask',buffered:false});}
 Object.defineProperty(p,'start',{value:()=>{if(p.startAt!==null||p.stopped)throw Error('PROBABILITY_PERFORMANCE_START_REPEATED');p.startAt=performance.now();}});Object.defineProperty(p,'stop',{value:()=>{if(!p.stopped){p.endAt=performance.now();p.stopped=true;cancelAnimationFrame(raf);observer?.disconnect();document.removeEventListener('visibilitychange',visibility);}return p;}});globalThis.__oasisProbabilityNormalFrames=p;
 return{schema:p.schema,nonce:p.nonce,documentId:p.documentId,url:p.url,timeOrigin:p.timeOrigin};
}
export function summarizeProbabilityPerformance(probe,{identity,thresholds}){
 assert.equal(probe?.schema,'probability-normal-presentation-frames-v1');for(const key of ['nonce','documentId','url','timeOrigin'])assert.equal(probe[key],identity[key],'PROBABILITY_PERFORMANCE_DOCUMENT_CHANGED');assert.equal(probe.stopped,true,'PROBABILITY_PERFORMANCE_NOT_STOPPED');assert.ok(Number.isFinite(probe.startAt)&&Number.isFinite(probe.endAt)&&probe.endAt>=probe.startAt,'PROBABILITY_PERFORMANCE_INTERVAL_REQUIRED');
 assert.ok(Array.isArray(probe.frames)&&probe.frames.length<=30000&&probe.frames.every(f=>Number.isFinite(f.at)&&Number.isFinite(f.ms)&&f.ms>0&&typeof f.visible==='boolean'),'PROBABILITY_FRAME_OBSERVATION_INVALID');assert.ok(Array.isArray(probe.longTasks)&&probe.longTasks.length<=2000&&probe.longTasks.every(f=>Number.isFinite(f.at)&&Number.isFinite(f.ms)&&f.ms>0),'PROBABILITY_LONGTASK_OBSERVATION_INVALID');
 const rows=probe.frames.filter(f=>f.at-f.ms>=probe.startAt&&f.at<=probe.endAt&&f.visible),frames=statistics(rows.map(f=>f.ms)),longTasks=statistics(probe.longTasks.filter(f=>f.at>=probe.startAt&&f.at+f.ms<=probe.endAt).map(f=>f.ms)),over50Percent=rows.length?rows.filter(f=>f.ms>50).length/rows.length*100:null;
 const violations=[];for(const [key,value,bound]of [['p95',frames.p95_ms,thresholds.frame_p95_ms],['p99',frames.p99_ms,thresholds.frame_p99_ms],['max',frames.max_ms,thresholds.frame_max_ms],['over50Percent',over50Percent,thresholds.frames_over_50ms_percent]])if(value!==null&&value>bound)violations.push({key,value,bound});
 const complete=rows.length>=2&&probe.hidden===false&&probe.dropped===0&&probe.longTaskSupported===true;
 return{schema:'probability-normal-presentation-performance-v1',scope:'Only this original paid cycle presentation and its natural bonus UI; RAF callback intervals are not GPU or physical panel FPS',status:violations.length?'fail':complete?'within-observed-limits':'insufficient',observedPresentationComplete:complete,frames,longTasks,over50Percent,violations,durationMs:probe.endAt-probe.startAt,minimumFormalSampleMs:thresholds.minimum_active_sample_ms,formalSampleDurationMet:probe.endAt-probe.startAt>=thresholds.minimum_active_sample_ms,formalPhysicalPerformanceAccepted:false,raw:probe};
}
/** Complete original game-frame spin responses, never inferred from screenshots
 * or a balance change. The server settles the whole cycle before presentation. */
export function playerProbabilityResultEvidence(rows,{state,baseline,origin}){
 assertOwnedPlayerProbabilityState(state,baseline);assert.ok(state.spins.length>0&&state.spins.filter(s=>!s.isFreeSpin).length===1,'EXACTLY_ONE_REAL_PAID_CYCLE_REQUIRED');const cycles=new Set(state.spins.map(s=>s.cycleId));assert.equal(cycles.size,1,'EXACTLY_ONE_REAL_CYCLE_REQUIRED');assert.equal(new Set(state.spins.map(s=>s.id)).size,state.spins.length,'DUPLICATE_PRESENTATION_ROUND_REFUSED');
 return state.spins.map(spin=>{assert.equal(spin.status,'SETTLED','REAL_CYCLE_NOT_SETTLED');assert.ok(state.acks.has(spin.id),'REAL_ROUND_ACK_REQUIRED');const matching=rows.filter(row=>row.path==='/api/play/'+state.game+'/spin'&&row.method==='POST'&&row.status===200&&row.frame===origin+'/play/'+state.game&&row.body?.round?.id===spin.id);assert.equal(matching.length,1,'EXACT_ORIGINAL_SPIN_RESPONSE_REQUIRED');const row=matching[0],r=row.body.round;assert.ok(sha(row.original_sha256)&&row.original_bytes>0,'ORIGINAL_SPIN_BODY_PIN_REQUIRED');assert.equal(row.body.session?.sessionId,state.sessionId);assert.equal(r.cycleId,spin.cycleId);assert.equal(r.settlementStatus,'SETTLED');assert.equal(r.isFreeSpin,spin.isFreeSpin);assert.equal(r.balanceScope,'complete_cycle');assert.ok(id(r.requestId)&&state.probabilityRequests.some(p=>p.type==='spin'&&p.request_id===r.requestId&&p.status===200&&!p.transport_error),'ORIGINAL_SPIN_REQUEST_REQUIRED');assert.ok(record(r.engine)&&Number.isSafeInteger(r.engine.totalWin)&&r.engine.totalWin>=0,'REAL_ENGINE_RESULT_REQUIRED');assert.equal(probabilityCoinsToMinor(r.win,baseline.currencyScale),String(r.engine.totalWin),'REAL_ENGINE_PAYOUT_PRECISION_CHANGED');probabilityCoinsToMinor(r.bet,baseline.currencyScale);probabilityCoinsToMinor(r.balanceBefore,baseline.currencyScale);probabilityCoinsToMinor(r.balanceAfter,baseline.currencyScale);return{roundId:r.id,cycleId:r.cycleId,requestId:r.requestId,isFreeSpin:r.isFreeSpin,settlementStatus:r.settlementStatus,bet:r.bet,win:r.win,balanceBefore:r.balanceBefore,balanceAfter:r.balanceAfter,engine:r.engine,originalBodySha256:row.original_sha256,originalBodyBytes:row.original_bytes};});
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
  else if(name.startsWith('platform/legacy/dist/'))path='/legacy/'+name.slice('platform/legacy/dist/'.length);
  else if(name.startsWith('platform/dist/'))path='/'+name.slice('platform/dist/'.length);
  if(path)expected.set(path,digest);
 }
 assert.ok(expected.has('/index.html')&&expected.has('/arena/index.html'),'PLAYER_AND_ARENA_OUTPUT_PINS_REQUIRED');
 return{expected,inputs:raw.inputs};
}

export const playerResourcePath=path=>path==='/player'?'/index.html':/^\/play\/(thunder|tiger)$/.test(path)?'/legacy/'+path.split('/').at(-1)+'.html':/^\/play\/[a-z]+$/.test(path)?'/arena/index.html':path;
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
