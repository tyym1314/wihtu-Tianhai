import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseBuildArguments,validateBuildConfiguration,ROOT} from '../build-config.mjs';
import path from 'node:path';

const valid={variant:'release',origin:'https://game.product-domain.com',appId:'app_actual_public_id'};
test('public configuration must be explicitly supplied, with no identity defaults',()=>{
 for(const input of [undefined,{}, {...valid,variant:undefined},{...valid,origin:undefined},{...valid,appId:undefined}, {...valid,appId:''}]){
  assert.throws(()=>validateBuildConfiguration(input));
 }
 assert.throws(()=>parseBuildArguments([]));
 for(const argv of [['--variant'],['--variant','release','--secret','anything'],['--variant','release','--variant','qa']])assert.throws(()=>parseBuildArguments(argv));
});

test('build-time origin rejects other schemes, URL decoration, local hosts and placeholders',()=>{
 for(const origin of ['http://game.product-domain.com','file:///game','https://user:password@game.product-domain.com',
  'https://game.product-domain.com/','https://game.product-domain.com/path','https://game.product-domain.com?app_id=foo',
  'https://game.product-domain.com#fragment','https://GAME.product-domain.com','https://game.product-domain.com:443','https://game.product-domain.com:0',
  'https://localhost','https://127.0.0.1','https://[::1]','https://app.localhost','https://app.local','https://app.internal',
  'https://a..com','https://-a.com','https://game.invalid','https://game.test','https://example.com','https://nested.example.org']){
  assert.throws(()=>validateBuildConfiguration({...valid,origin}));
 }
 for(const appId of ['app?x=1','app&id=1','../../admin','white space','newline\n','a'.repeat(129)])assert.throws(()=>validateBuildConfiguration({...valid,appId}));
});

test('release and QA packages, debugging state and filenames are distinct',()=>{
 const release=validateBuildConfiguration(valid),qa=validateBuildConfiguration({...valid,variant:'qa'});
 assert.equal(release.packageName,'com.tianyahuyu.oasis.player');assert.equal(release.debuggable,false);
 assert.equal(qa.packageName,'com.tianyahuyu.oasis.player.qa');assert.equal(qa.debuggable,true);
 assert.notEqual(qa.apkName,release.apkName);assert.notEqual(qa.appName,release.appName);
 assert.equal(release.entryUrl,valid.origin+'/player?app_id='+valid.appId);
});

test('an unresolvable contract fixture is explicitly QA-only',()=>{
 const fixture=validateBuildConfiguration({...valid,variant:'qa',origin:'https://apk-contract.invalid',contractFixture:true});
 assert.equal(fixture.flavor,'qa-contract');assert.match(fixture.appName,/无后端/);assert.match(fixture.apkName,/qa-contract/);
 assert.throws(()=>validateBuildConfiguration({...valid,origin:'https://apk-contract.invalid',contractFixture:true}));
 assert.throws(()=>validateBuildConfiguration({...valid,variant:'qa',contractFixture:true}));
 assert.throws(()=>validateBuildConfiguration({...valid,variant:'qa',origin:'https://apk-contract.invalid',contractFixture:'false'}));
 assert.throws(()=>parseBuildArguments(['--variant','qa','--origin','https://apk-contract.invalid','--app-id','fixture_app_01','--contract-fixture','--contract-fixture']));
});

test('native shell retains the TLS, backup, file, cookie and bridge boundaries',async()=>{
 const [manifest,activity]=await Promise.all([
  readFile(path.join(ROOT,'app','AndroidManifest.xml'),'utf8'),
  readFile(path.join(ROOT,'app','src','com','tianyahuyu','oasis','player','MainActivity.java'),'utf8')
 ]);
 for(const attribute of ['allowBackup','fullBackupContent','usesCleartextTraffic'])assert.ok(manifest.includes(`android:${attribute}="false"`));
 assert.match(manifest,/android:debuggable="@@DEBUGGABLE@@"/);
 assert.deepEqual([...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map(match=>match[1]),['android.permission.INTERNET']);
 for(const statement of ['setAllowFileAccess(false)','setAllowContentAccess(false)','setAllowFileAccessFromFileURLs(false)',
  'setAllowUniversalAccessFromFileURLs(false)','MIXED_CONTENT_NEVER_ALLOW','setAcceptThirdPartyCookies(view, false)',
  'handler.cancel()','request.deny()','PlayerBuildConfig.QA &&','policy.isPlayerPage(webView.getUrl())',
  'evaluateJavascript(policy.backScript()','CookieManager.getInstance().flush()','webView.onPause()','webView.onResume()'])assert.ok(activity.includes(statement),statement);
 assert.doesNotMatch(activity,/addJavascriptInterface|handler\.proceed|\.goBack\(|getIntent\(|MockPartnerApi|TEST_COIN|secret_base64/);
});
