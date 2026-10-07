import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {RELEASED_IDS} from '../shared/games.mjs';
import {androidSourceFingerprint,androidArtifactMetadata,readAndroidArtifact,verifyPublishedAndroidArtifact,androidVerificationTarget,androidAdbArgs,androidReleaseCommand,verifyAndroidReleaseState,verifyInstalledAndroidArtifact} from '../scripts/android-artifact.mjs';

const platform=fileURLToPath(new URL('../',import.meta.url));
const run=promisify(execFile);
const apkBytes=Buffer.from('fixture signed APK bytes'),sha256=createHash('sha256').update(apkBytes).digest('hex');
const historical={schema_version:2,variant:'historical-live',distribution_status:'historical-qa',package_name:'com.tianyahuyu.oasis.smoke',launch_activity:'com.tianyahuyu.oasis.smoke.MainActivity',version:'1.2.0',version_code:5,origin:'https://game.tianyahuyu.com',apk:'oasis-android-smoke-1.2.0-debug.apk',sha256,game_count:13,device_verification:'not_performed_by_build'};
const candidate={packageName:'com.tianyahuyu.oasis.mock',version:'1.3.0',versionCode:6,origin:'https://oasis-mock.43.98.202.236.sslip.io',apk:'oasis-android-mock-1.3.0-debug.apk',apkSha256:sha256,catalog:RELEASED_IDS};
const mock=androidArtifactMetadata(candidate);
const config=artifact=>({OASIS_ANDROID_SERIAL:'fixture-device',OASIS_ANDROID_ADB_PORT:'5038',OASIS_ANDROID_ORIGIN:artifact.origin,OASIS_ANDROID_PACKAGE:artifact.package_name,OASIS_ANDROID_APK_SHA256:artifact.sha256,OASIS_ANDROID_RELEASE:'20261007-04',OASIS_ANDROID_RELEASE_SSH_HOST:'root@43.98.202.236',OASIS_ANDROID_RELEASE_SSH_KEY:'/fixture/key'});

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'oasis-android-artifact-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const paths=['scripts/build-release.mjs','scripts/android-artifact.mjs','android-smoke/prepare-mock-build.mjs','shared/games.mjs','android-smoke/build.sh','android-smoke/build-metadata.mjs','android-smoke/app/AndroidManifest.xml'];
 for(const name of paths){await mkdir(join(root,name,'..'),{recursive:true});await copyFile(join(platform,name),join(root,name));}
 await mkdir(join(root,'public/downloads'),{recursive:true});
 const metadata={...historical,source_sha256:await androidSourceFingerprint(root)};
 const manifest=join(root,'public/downloads/android-smoke-build.json');
 await writeFile(manifest,JSON.stringify(metadata));await writeFile(join(root,'public/downloads',historical.apk),apkBytes);
 return{root,manifest,metadata};
}

test('release build keeps reviewed APK and metadata byte-for-byte without invoking an Android build',async t=>{
 const {root,manifest}=await fixture(t),bin=join(root,'bin'),log=join(root,'commands.log');
 await mkdir(bin);
 for(const command of ['npm','python3'])await writeFile(join(bin,command),'#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OASIS_TEST_LOG"\n',{mode:0o755});
 const before=await readFile(manifest);
 await run(process.execPath,[join(root,'scripts/build-release.mjs')],{env:{...process.env,PATH:bin,OASIS_TEST_LOG:log}});
 assert.deepEqual(await readFile(manifest),before);
 assert.deepEqual(await readFile(join(root,'public/downloads',historical.apk)),apkBytes);
 const commands=await readFile(log,'utf8');
 assert.match(commands,/run build:arena/);assert.match(commands,/deploy\/release_build\.py record/);assert.doesNotMatch(commands,/build:android/);
});

test('changed, added, or removed Android inputs invalidate the reviewed artifact',async t=>{
 const {root,metadata,manifest}=await fixture(t);
 await verifyPublishedAndroidArtifact(root);
 await writeFile(join(root,'android-smoke/app/AndroidManifest.xml'),'changed source');
 await assert.rejects(verifyPublishedAndroidArtifact(root),/ANDROID_REVIEWED_APK_STALE/);
 await copyFile(join(platform,'android-smoke/app/AndroidManifest.xml'),join(root,'android-smoke/app/AndroidManifest.xml'));
 await writeFile(join(root,'android-smoke/app/Unexpected.java'),'new code');
 await assert.rejects(verifyPublishedAndroidArtifact(root),/ANDROID_REVIEWED_APK_STALE/);
 await rm(join(root,'android-smoke/app/Unexpected.java'));
 await rm(join(root,'android-smoke/app/AndroidManifest.xml'));
 await assert.rejects(verifyPublishedAndroidArtifact(root),/ANDROID_REVIEWED_APK_STALE/);
 assert.deepEqual(JSON.parse(await readFile(manifest,'utf8')),metadata);
});

test('stale APK fails before release subprocesses or a freshness stamp can run',async t=>{
 const {root}=await fixture(t),bin=join(root,'bin'),log=join(root,'commands.log');await mkdir(bin);
 for(const command of ['npm','python3'])await writeFile(join(bin,command),'#!/bin/sh\nprintf touched > "$OASIS_TEST_LOG"\n',{mode:0o755});
 await writeFile(join(root,'release-build-manifest.json'),'old stamp');
 await writeFile(join(root,'android-smoke/app/AndroidManifest.xml'),'new source');
 await assert.rejects(run(process.execPath,[join(root,'scripts/build-release.mjs')],{env:{...process.env,PATH:bin,OASIS_TEST_LOG:log}}),/ANDROID_REVIEWED_APK_STALE/);
 await assert.rejects(readFile(log),{code:'ENOENT'});await assert.rejects(readFile(join(root,'release-build-manifest.json')),{code:'ENOENT'});
});

test('APK hash mismatch and accidental mock publication fail closed',async t=>{
 const {root,manifest}=await fixture(t);
 await writeFile(join(root,'public/downloads',historical.apk),'another APK');
 await assert.rejects(readAndroidArtifact(manifest,{published:true,root}),/ANDROID_APK_HASH_MISMATCH/);
 assert.throws(()=>androidArtifactMetadata({...mock,schema_version:2,source_sha256:{}},{published:true}),/ANDROID_PUBLIC_PROMOTION_NOT_APPROVED/);
 assert.throws(()=>androidArtifactMetadata({...historical,apk:'../other.apk'}),/ANDROID_APK_NAME_MISMATCH/);
 assert.throws(()=>androidArtifactMetadata({...candidate,origin:historical.origin}),/MUST_BE_ISOLATED/);
});

test('mock candidate can be explicitly selected without copying or publishing its bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'oasis-mock-candidate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const manifest=join(root,'mock-build-checks.json');await writeFile(manifest,JSON.stringify(candidate));await writeFile(join(root,candidate.apk),apkBytes);
 const selected=await readAndroidArtifact(manifest);assert.equal(selected.variant,'isolated-mock');assert.equal(selected.distribution_status,'local-candidate');assert.equal(selected.sha256,sha256);
});

test('each device and deployment target is explicit and must match the selected artifact',()=>{
 const env=config(mock),target=androidVerificationTarget(env,mock);
 for(const name of Object.keys(env)){const missing={...env};delete missing[name];assert.throws(()=>androidVerificationTarget(missing,mock),/_REQUIRED/);}
 for(const [key,value] of [['ORIGIN',historical.origin],['PACKAGE',historical.package_name],['APK_SHA256','0'.repeat(64)],['RELEASE','../current'],['ADB_PORT','0']])assert.throws(()=>androidVerificationTarget({...env,['OASIS_ANDROID_'+key]:value},mock));
 assert.equal(target.component,'com.tianyahuyu.oasis.mock/com.tianyahuyu.oasis.smoke.MainActivity');
 assert.deepEqual(androidAdbArgs(target,['devices','-l'],{device:false}),['-H','127.0.0.1','-P','5038','devices','-l']);
 assert.deepEqual(androidAdbArgs(target,['shell','pm','path',target.packageName]).slice(0,6),['-H','127.0.0.1','-P','5038','-s','fixture-device']);
});

test('mock release evidence must come from its own healthy guarded pin',()=>{
 const target=androidVerificationTarget(config(mock),mock),state={origin:mock.origin,release:'/opt/oasis/releases/20261007-04',status:'running',healthy:true,isolation:'verified'};
 assert.match(androidReleaseCommand(target),/android-mock-current/);assert.doesNotMatch(androidReleaseCommand(target),/private\/last-release/);
 assert.equal(verifyAndroidReleaseState(state,target).version,'20261007-04');
 for(const change of [{release:'/opt/oasis/releases/20261007-03'},{origin:historical.origin},{healthy:false},{isolation:'not_probed'}])assert.throws(()=>verifyAndroidReleaseState({...state,...change},target));
 const legacy=androidArtifactMetadata(historical),legacyTarget=androidVerificationTarget(config(legacy),legacy);
 assert.equal(androidReleaseCommand(legacyTarget),'cat /opt/oasis/private/last-release.json');
 assert.equal(verifyAndroidReleaseState({current:state.release,health:'passed',activated_at:'2026-10-07T15:35:27Z'},legacyTarget).version,'20261007-04');
 assert.throws(()=>verifyAndroidReleaseState({current:state.release,health:'passed'},target));
});

test('installed APK is hashed and versioned on the explicitly selected ADB server before launch',async()=>{
 const target=androidVerificationTarget(config(mock),mock),calls=[];
 const execute=async(command,args)=>{calls.push({command,args});return{stdout:args.includes('pm')?'package:/data/app/~~fixture=/com.tianyahuyu.oasis.mock-code=/base.apk\n':args.includes('sha256sum')?sha256+'  /data/app/fixture/base.apk\n':'versionCode=6 minSdk=26\nversionName=1.3.0\n'};};
 assert.equal((await verifyInstalledAndroidArtifact(target,mock,execute)).verified,true);
 assert.ok(calls.every(call=>call.command==='adb'&&call.args[3]==='5038'&&call.args[5]===target.serial));
 assert.ok(calls.every(call=>!call.args.includes('am')));
 await assert.rejects(verifyInstalledAndroidArtifact(target,mock,async(command,args)=>{const response=await execute(command,args);return args.includes('sha256sum')?{stdout:'0'.repeat(64)+' base.apk'}:response;}),/ANDROID_INSTALLED_APK_HASH_MISMATCH/);
 await assert.rejects(verifyInstalledAndroidArtifact(target,mock,async(command,args)=>{const response=await execute(command,args);return args.includes('dumpsys')?{stdout:'versionCode=5\nversionName=1.2.0'}:response;}),/ANDROID_INSTALLED_VERSION_MISMATCH/);
});

test('invoking the device verifier without artifact selection fails without calling ADB or SSH',async t=>{
 const root=await mkdtemp(join(tmpdir(),'oasis-no-device-'));t.after(()=>rm(root,{recursive:true,force:true}));const log=join(root,'commands.log');
 for(const command of ['adb','ssh'])await writeFile(join(root,command),'#!/bin/sh\nprintf touched > "$OASIS_TEST_LOG"\n',{mode:0o755});
 const env={...process.env,PATH:root,OASIS_TEST_LOG:log};for(const name of Object.keys(env))if(name.startsWith('OASIS_ANDROID_'))delete env[name];
 await assert.rejects(run(process.execPath,[join(platform,'scripts/verify-android-webview.mjs')],{env}),/OASIS_ANDROID_ARTIFACT_REQUIRED/);
 await assert.rejects(readFile(log),{code:'ENOENT'});
});
