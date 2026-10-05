import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RELEASED_IDS,ARENA_IDS} from '../shared/games.mjs';
import {NATIVE_GAME_IDS} from '../deploy/native-game-host.mjs';
import {inspectAndroidSource} from '../android-smoke/build-metadata.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const platform=dirname(root);
const android=join(platform,'android-smoke');
// Independent product boundary: adding a released ID requires an explicit
// native host/card review, not just deriving both sides from the same module.
const expected=['thunder','tiger','match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run','towerlink'];

const text=async path=>readFile(path,'utf8');
const exactSet=(actual,expectedValue,label)=>{
 assert.deepEqual(actual,expectedValue,label+' must preserve the complete ordered catalogue');
 assert.equal(new Set(actual).size,actual.length,label+' must not contain duplicate game IDs');
};

test('Android smoke APK and native integration boundary cover all thirteen games',async()=>{
 const [activity,manifest,host,driver,metadata,hashes]=await Promise.all([
  text(join(android,'app/src/com/tianyahuyu/oasis/smoke/MainActivity.java')),
  text(join(android,'app/AndroidManifest.xml')),
  text(join(platform,'deploy/native-game-host.mjs')),
  text(join(platform,'scripts/verify-android-webview.mjs')),
  text(join(android,'dist/build-checks.json')).then(JSON.parse),
  text(join(android,'dist/SHA256SUMS')),
 ]);
 const activityGames=[...activity.matchAll(/\{"([a-z]+)",\s*"[^"]+",\s*"[^"]+",\s*"(?:概率|竞技)",\s*"#[0-9A-Fa-f]{6}"\}/g)].map(match=>match[1]);
 const hostGames=host.match(/NATIVE_GAME_IDS\s*=\s*Object\.freeze\(\[([^\]]+)\]/)?.[1]
  ?.match(/'([a-z]+)'/g)?.map(value=>value.slice(1,-1));
 exactSet(RELEASED_IDS,expected,'Released catalogue');
 exactSet(activityGames,expected,'MainActivity native cards');
 exactSet(hostGames,expected.slice(2).concat(expected.slice(0,2)), 'Native host routes');
 exactSet(NATIVE_GAME_IDS,[...ARENA_IDS,'thunder','tiger'],'Executable native host routes');
 assert.match(driver,/const catalog=RELEASED_IDS;/,'USB verifier must use the released catalogue');
 assert.match(driver,/full_catalog:selected\.length===catalog\.length/);
 exactSet(metadata.catalog,expected,'APK build metadata');
 assert.match(activity,/private static final String ORIGIN = "https:\/\/game\.tianyahuyu\.com";/);
 assert.doesNotMatch(activity,/http:\/\/(?!127\.0\.0\.1|localhost)/,'APK source must not contain a cleartext external endpoint');
 assert.match(manifest,/android\.permission\.INTERNET/,'APK must declare Internet access for HTTPS game loading');
 assert.doesNotMatch(manifest,/READ_|WRITE_|ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|READ_PHONE_STATE|RECORD_AUDIO|CAMERA/,'test APK must not request unrelated App permissions');
 assert.match(manifest,/android:name="\.MainActivity"/);
 assert.match(host,/\/api\/demo\/config/);
 assert.match(host,/\/api\/demo\/launch/);
 assert.doesNotMatch(host,/\/api\/(?:app|partner|wallet)\//,'native mock host must not require a separate App backend endpoint');
 assert.match(driver,/existing sandbox\/test wallets|existing sandbox\/test wallets/i);
 assert.equal(metadata.apk,'oasis-android-smoke-1.1.1-debug.apk');
 const apk=await readFile(join(android,'dist',metadata.apk));
 const actualHash=createHash('sha256').update(apk).digest('hex');
 assert.equal(actualHash,metadata.apkSha256,'APK metadata hash must match the checked artifact');
 assert.match(hashes,new RegExp('^'+actualHash+'\\s+oasis-android-smoke-1\\.1\\.1-debug\\.apk$','m'));
});

test('Android smoke build metadata records the return and fallback contract',async()=>{
 const metadata=JSON.parse(await text(join(android,'dist/build-checks.json')));
 const cases=new Map(metadata.actualBackScriptCases.map(item=>[item.case,item.result]));
 for(const [label,result] of [
  ['trusted host calls requestBack','handled'],
  ['other game uses same host contract','handled'],
  ['web lobby does not call native host','not-handled'],
  ['wrong origin rejected','not-handled'],
  ['missing host falls back','not-handled'],
  ['host exception falls back','not-handled'],
 ])assert.equal(cases.get(label),result,label);
 assert.equal(metadata.version,'1.1.1');
 assert.equal(metadata.versionCode,4);
});

test('actual native loop bounds cover odd and even catalogues without out-of-bounds access',async()=>{
 const [activity,manifest]=await Promise.all([
  text(join(android,'app/src/com/tianyahuyu/oasis/smoke/MainActivity.java')),
  text(join(android,'app/AndroidManifest.xml')),
 ]);
 const inspected=inspectAndroidSource(activity,manifest);
 assert.deepEqual(inspected.gridCases.map(item=>item.catalogSize),[0,1,2,12,13,14]);
 assert.ok(inspected.gridCases.every(item=>item.visited===item.catalogSize&&item.passed));
 assert.throws(()=>inspectAndroidSource(activity.replace('column < 2 && rowIndex + column < GAMES.length','column < 2'),manifest),/Native grid array overrun/);
 const metadata=JSON.parse(await text(join(android,'dist/build-checks.json')));
 assert.deepEqual(metadata.actualBackScriptCases,inspected.actualBackScriptCases);
 assert.deepEqual(metadata.gridCases,inspected.gridCases);
});
