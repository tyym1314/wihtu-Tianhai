import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ROOT,sourceEvidence,sha256,validateBuildConfiguration} from './build-config.mjs';

const flavor=process.argv[2];
assert.ok(['release','qa','qa-contract'].includes(flavor),'Invalid metadata build flavor');
const build=path.join(ROOT,'build',flavor),output=path.join(ROOT,'dist',flavor);
const configuration=JSON.parse(await readFile(path.join(build,'build-config.json'),'utf8'));
const config=validateBuildConfiguration(configuration);
assert.equal(config.flavor,flavor);
assert.deepEqual(await sourceEvidence(),configuration.sourceEvidence,'Source changed during the build; rebuild before using this APK');
const [manifest,resources,java,badging,signature,bytes,navigation,bridge,configurationChecks,apkManifest]=await Promise.all([
 readFile(path.join(build,'generated','AndroidManifest.xml'),'utf8'),
 readFile(path.join(build,'generated','res','values','strings.xml'),'utf8'),
 readFile(path.join(build,'generated','PlayerBuildConfig.java'),'utf8'),
 readFile(path.join(build,'apk-badging.txt'),'utf8'),
 readFile(path.join(build,'signature-checks.txt'),'utf8'),
 readFile(path.join(output,config.apkName)),
 readFile(path.join(build,'navigation-checks.json'),'utf8'),
 readFile(path.join(build,'back-checks.json'),'utf8'),
 readFile(path.join(build,'configuration-checks.tap'),'utf8'),
 readFile(path.join(build,'apk-manifest.txt'),'utf8')
]);
assert.deepEqual({manifest:sha256(manifest),resources:sha256(resources),configuration:sha256(java)},configuration.generatedSha256);
assert.ok(badging.includes(`package: name='${config.packageName}' versionCode='1' versionName='${config.version}'`));
assert.equal(badging.includes('application-debuggable'),config.debuggable,'APK debuggable state differs from the selected variant');
assert.match(badging,/(?:minSdkVersion|sdkVersion):'26'/);
assert.match(badging,/targetSdkVersion:'35'/);
assert.deepEqual([...badging.matchAll(/uses-permission: name='([^']+)'/g)].map(match=>match[1]),['android.permission.INTERNET']);
for(const attribute of ['allowBackup','fullBackupContent','usesCleartextTraffic'])assert.match(apkManifest,new RegExp(`android:${attribute}[^\\n]*=(?:false|0x0)\\b`));
assert.match(signature,/Verified using v2 scheme \(APK Signature Scheme v2\): true/);
const certificateSha256=signature.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/)?.[1];
assert.match(certificateSha256||'',/^[0-9a-f]{64}$/);
assert.match(configurationChecks,/# fail 0\b/);
const configurationPasses=Number(configurationChecks.match(/# pass ([0-9]+)/)?.[1]);
assert.ok(configurationPasses>0);
const checks={configuration:{passed:true,groups:configurationPasses},navigation:JSON.parse(navigation),backBridge:JSON.parse(bridge)};
assert.equal(checks.navigation.passed,true);
assert.equal(checks.backBridge.passed,true);
const metadata={...config,apkSha256:sha256(bytes),certificateSha256,apkBytes:bytes.length,
 buildTools:'35.0.1',compileSdk:35,minSdk:26,targetSdk:35,builtAt:new Date().toISOString(),
 sourceEvidence:configuration.sourceEvidence,generatedSha256:configuration.generatedSha256,checks,
 scope:config.contractFixture?'Unresolvable contract fixture only; no real-backend or device acceptance':'Signed native shell only; real-backend and physical-device acceptance remain separate',
 realBackendVerified:false,physicalDeviceVerified:false,
 auth:'Server HttpOnly player session; no bundled account, password, HMAC or wallet balance',
 returnContract:'OasisPlayerHost.requestBack boolean; game return remains subject to H5/SDK authority'};
await writeFile(path.join(output,'build-metadata.json'),JSON.stringify(metadata,null,2)+'\n');
await writeFile(path.join(output,'SHA256SUMS'),`${metadata.apkSha256}  ${config.apkName}\n`);
console.log(JSON.stringify({packageName:config.packageName,flavor,contractFixture:config.contractFixture,apkSha256:metadata.apkSha256,sourceSha256:metadata.sourceEvidence.sourceSha256}));
