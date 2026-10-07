import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateMockOrigin} from '../android-smoke/prepare-mock-build.mjs';
import {RELEASED_IDS} from '../shared/games.mjs';

const platform=fileURLToPath(new URL('../',import.meta.url));
const liveOrigin='https://game.tianyahuyu.com';
const activity='com.tianyahuyu.oasis.smoke.MainActivity';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireValue=(value,code)=>{assert.ok(typeof value==='string'&&value.length>0,code);return value;};

export async function androidSourceFingerprint(root=platform,variant='historical-live'){
 assert.ok(['historical-live','isolated-mock'].includes(variant),'ANDROID_VARIANT_INVALID');
 const paths=['android-smoke/build.sh','android-smoke/build-metadata.mjs','shared/games.mjs'];
 if(variant==='isolated-mock')paths.push('android-smoke/build-mock.sh','android-smoke/prepare-mock-build.mjs','android-smoke/mock-build-metadata.mjs');
 async function walk(relative){
  for(const entry of await readdir(join(root,relative),{withFileTypes:true})){
   const name=relative+'/'+entry.name;
   assert.ok(!entry.isSymbolicLink(),'ANDROID_SOURCE_SYMLINK');
   if(entry.isDirectory())await walk(name);else{assert.ok(entry.isFile(),'ANDROID_SOURCE_INVALID');paths.push(name);}
  }
 }
 await walk('android-smoke/app');
 const entries=await Promise.all(paths.sort().map(async name=>[name,hash(await readFile(join(root,name)))]));
 return Object.fromEntries(entries);
}

export function androidArtifactMetadata(raw,{published=false}={}){
 const candidate=raw?.packageName==='com.tianyahuyu.oasis.mock'&&raw.schema_version===undefined;
 assert.ok(candidate||raw?.schema_version===2,'ANDROID_ARTIFACT_METADATA_REQUIRED');
 const result=candidate?{variant:'isolated-mock',distribution_status:'local-candidate',package_name:raw.packageName,launch_activity:activity,version:raw.version,version_code:raw.versionCode,origin:raw.origin,apk:raw.apk,sha256:raw.apkSha256,game_count:raw.catalog?.length}:Object.fromEntries(['variant','distribution_status','package_name','launch_activity','version','version_code','origin','apk','sha256','game_count'].map(key=>[key,raw[key]]));
 assert.ok(['historical-live','isolated-mock'].includes(result.variant),'ANDROID_VARIANT_INVALID');
 const mock=result.variant==='isolated-mock';
 assert.equal(result.package_name,mock?'com.tianyahuyu.oasis.mock':'com.tianyahuyu.oasis.smoke','ANDROID_PACKAGE_MISMATCH');
 assert.equal(result.launch_activity,activity,'ANDROID_ACTIVITY_MISMATCH');
 assert.match(result.version,/^\d+\.\d+\.\d+$/,'ANDROID_VERSION_INVALID');
 assert.ok(Number.isSafeInteger(result.version_code)&&result.version_code>0,'ANDROID_VERSION_CODE_INVALID');
 assert.equal(result.apk,`oasis-android-${mock?'mock':'smoke'}-${result.version}-debug.apk`,'ANDROID_APK_NAME_MISMATCH');
 assert.match(result.sha256,/^[a-f0-9]{64}$/,'ANDROID_APK_HASH_INVALID');
 assert.equal(result.game_count,RELEASED_IDS.length,'ANDROID_CATALOG_MISMATCH');
 if(candidate)assert.deepEqual(raw.catalog,RELEASED_IDS,'ANDROID_CATALOG_MISMATCH');
 if(mock)validateMockOrigin(result.origin);else assert.equal(result.origin,liveOrigin,'ANDROID_HISTORICAL_ORIGIN_MISMATCH');
 if(published){
  assert.equal(result.variant,'historical-live','ANDROID_PUBLIC_PROMOTION_NOT_APPROVED');
  assert.equal(result.distribution_status,'historical-qa','ANDROID_PUBLIC_PROMOTION_NOT_APPROVED');
  assert.ok(raw.source_sha256&&typeof raw.source_sha256==='object'&&!Array.isArray(raw.source_sha256),'ANDROID_REVIEWED_SOURCE_REQUIRED');
 }
 return Object.freeze(result);
}

export async function readAndroidArtifact(manifest,{published=false,root=platform}={}){
 const manifestPath=resolve(manifest),info=await lstat(manifestPath);
 assert.ok(info.isFile()&&!info.isSymbolicLink(),'ANDROID_ARTIFACT_METADATA_INVALID');
 const raw=JSON.parse(await readFile(manifestPath,'utf8')),artifact=androidArtifactMetadata(raw,{published});
 const apkPath=join(dirname(manifestPath),artifact.apk),apkInfo=await lstat(apkPath);
 assert.ok(apkInfo.isFile()&&!apkInfo.isSymbolicLink(),'ANDROID_APK_INVALID');
 assert.equal(hash(await readFile(apkPath)),artifact.sha256,'ANDROID_APK_HASH_MISMATCH');
 if(published)assert.deepEqual(raw.source_sha256,await androidSourceFingerprint(root,artifact.variant),'ANDROID_REVIEWED_APK_STALE: review a new artifact explicitly; build:release never rebuilds or replaces APKs');
 return Object.freeze({...artifact,apkPath});
}

export const verifyPublishedAndroidArtifact=(root=platform)=>readAndroidArtifact(join(root,'public/downloads/android-smoke-build.json'),{published:true,root});

export function androidVerificationTarget(env,artifact){
 const required=name=>requireValue(env['OASIS_ANDROID_'+name],'OASIS_ANDROID_'+name+'_REQUIRED');
 const serial=required('SERIAL'),adbPort=required('ADB_PORT'),origin=required('ORIGIN'),packageName=required('PACKAGE'),apkHash=required('APK_SHA256'),release=required('RELEASE'),sshHost=required('RELEASE_SSH_HOST'),sshKey=required('RELEASE_SSH_KEY');
 assert.match(serial,/^[A-Za-z0-9_.:-]+$/,'ANDROID_SERIAL_INVALID');
 assert.match(adbPort,/^[1-9]\d{0,4}$/,'ANDROID_ADB_PORT_INVALID');
 assert.ok(Number(adbPort)<=65535,'ANDROID_ADB_PORT_INVALID');
 assert.equal(origin,artifact.origin,'ANDROID_TARGET_ORIGIN_MISMATCH');
 assert.equal(packageName,artifact.package_name,'ANDROID_TARGET_PACKAGE_MISMATCH');
 assert.equal(apkHash,artifact.sha256,'ANDROID_TARGET_APK_HASH_MISMATCH');
 assert.match(release,/^\d{8}-\d{2}$/,'ANDROID_RELEASE_INVALID');
 assert.match(sshHost,/^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/,'ANDROID_RELEASE_SSH_HOST_INVALID');
 return Object.freeze({serial,adbPort:Number(adbPort),origin,packageName,apkHash,release,sshHost,sshKey:resolve(sshKey),component:packageName+'/'+artifact.launch_activity,variant:artifact.variant});
}

export const androidAdbArgs=(target,args,{device=true}={})=>['-H','127.0.0.1','-P',String(target.adbPort),...(device?['-s',target.serial]:[]),...args];

export function androidReleaseCommand(target){
 return target.variant==='isolated-mock'?'python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py status':'cat /opt/oasis/private/last-release.json';
}

export function verifyAndroidReleaseState(state,target){
 if(target.variant==='isolated-mock'){
  assert.equal(state.origin,target.origin,'ANDROID_RELEASE_ORIGIN_MISMATCH');
  assert.equal(state.release,'/opt/oasis/releases/'+target.release,'ANDROID_RELEASE_PIN_MISMATCH');
  assert.equal(state.status,'running','ANDROID_MOCK_NOT_RUNNING');
  assert.equal(state.healthy,true,'ANDROID_MOCK_UNHEALTHY');
  assert.equal(state.isolation,'verified','ANDROID_MOCK_ISOLATION_UNVERIFIED');
  return{version:target.release,origin:state.origin,pinned_release:state.release,isolation:'verified'};
 }
 assert.equal(state.current,'/opt/oasis/releases/'+target.release,'ANDROID_RELEASE_PIN_MISMATCH');
 assert.equal(state.health,'passed','ANDROID_RELEASE_UNHEALTHY');
 assert.ok(typeof state.activated_at==='string'&&Number.isFinite(Date.parse(state.activated_at)),'ANDROID_RELEASE_ACTIVATION_INVALID');
 return{version:basename(state.current),activated_at:state.activated_at};
}

export async function verifyInstalledAndroidArtifact(target,artifact,execute){
 const adb=async args=>(await execute('adb',androidAdbArgs(target,args),{timeout:45000,maxBuffer:4*1024*1024})).stdout.trim();
 const paths=(await adb(['shell','pm','path',target.packageName])).split(/\r?\n/);
 assert.equal(paths.length,1,'ANDROID_SPLIT_OR_MISSING_APK');
 assert.match(paths[0],/^package:\/data\/app\/[A-Za-z0-9_./=+~-]+\/base\.apk$/,'ANDROID_INSTALLED_APK_PATH_INVALID');
 const installedPath=paths[0].slice('package:'.length);
 const digest=(await adb(['shell','sha256sum',installedPath])).split(/\s+/)[0];
 assert.equal(digest,target.apkHash,'ANDROID_INSTALLED_APK_HASH_MISMATCH');
 const info=await adb(['shell','dumpsys','package',target.packageName]);
 const version=info.match(/\bversionName=([^\s]+)/)?.[1],versionCode=Number(info.match(/\bversionCode=(\d+)/)?.[1]);
 assert.equal(version,artifact.version,'ANDROID_INSTALLED_VERSION_MISMATCH');
 assert.equal(versionCode,artifact.version_code,'ANDROID_INSTALLED_VERSION_CODE_MISMATCH');
 return{package_name:target.packageName,version,version_code:versionCode,sha256:digest,verified:true};
}
