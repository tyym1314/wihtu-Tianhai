import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateMockOrigin,generateMockSources} from '../android-smoke/prepare-mock-build.mjs';
import {inspectMockSources} from '../android-smoke/mock-build-metadata.mjs';

const platform=fileURLToPath(new URL('../',import.meta.url));
const android=path.join(platform,'android-smoke');
const fixtureOrigin='https://mock-stage.tianyahuyu.com';

test('1.3 mock APK build fails before packaging when exact HTTPS mock origin is absent',()=>{
 const env={...process.env};delete env.OASIS_ANDROID_MOCK_ORIGIN;
 const result=spawnSync('bash',[path.join(android,'build-mock.sh')],{env,cwd:android,encoding:'utf8',timeout:5000});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/OASIS_ANDROID_MOCK_ORIGIN_REQUIRED/);
});

test('1.3 mock origin rejects live/demo and malformed URLs',()=>{
 assert.equal(validateMockOrigin(fixtureOrigin).origin,fixtureOrigin);
 for(const bad of [
  '', 'http://mock-game.example.test','https://mock-game.example.test/',
  'https://mock-game.example.test/path','https://mock-game.example.test?x=1',
  'https://mock-game.example.test#section','https://u:p@mock-game.example.test',
  'https://game.tianyahuyu.com','https://game.tianyahuyu.com:8443',
  'https://oasis.43.98.202.236.sslip.io','https://localhost:8443',
  'https://mock-game.example.invalid','https://mock-game.example.test',
  'https://mock-game.example','https://mock-game.example.com',
  'https://127.0.0.1','https://[::1]'
 ])assert.throws(()=>validateMockOrigin(bad),/OASIS_ANDROID_MOCK_ORIGIN_(?:REQUIRED|INVALID|MUST_BE_ISOLATED)/,bad);
 assert.throws(()=>validateMockOrigin(fixtureOrigin,fixtureOrigin),/MUST_BE_ISOLATED/);
});

test('1.3 generated manifest, metadata and WebView allowlist bind to one mock host',async()=>{
 const [activity,manifest]=await Promise.all([
  readFile(path.join(android,'app/src/com/tianyahuyu/oasis/smoke/MainActivity.java'),'utf8'),
  readFile(path.join(android,'app/AndroidManifest.xml'),'utf8')
 ]);
 const endpoint={packageName:'com.tianyahuyu.oasis.mock',version:'1.3.0',versionCode:6,...validateMockOrigin('https://mock-stage.tianyahuyu.com:8443')};
 const generated=generateMockSources(activity,manifest,endpoint);
 const result=inspectMockSources(generated.main,generated.manifest,generated.originJava,endpoint);
 assert.equal(result.catalog.length,13);
 assert.equal(result.origin,endpoint.origin);
 assert.match(generated.main,/uri\.getPort\(\) == MockOrigin\.PORT/);
 assert.doesNotMatch(generated.main,/game\.tianyahuyu\.com/);
 assert.match(generated.manifest,/android:name="com\.tianyahuyu\.oasis\.smoke\.MainActivity"/);
 assert.match(generated.originJava,/static final int PORT = 8443;/);
});
