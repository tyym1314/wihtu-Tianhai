/** Build-time evidence only. Never writes or upgrades physical-device reports. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {RELEASED_IDS} from '../shared/games.mjs';

export function inspectAndroidSource(activity,manifest,mockSource){
 const version=manifest.match(/android:versionName="([0-9.]+)"/)?.[1];
 const versionCode=Number(manifest.match(/android:versionCode="([0-9]+)"/)?.[1]);
 assert.ok(version&&Number.isSafeInteger(versionCode)&&versionCode>0);
 assert.ok(activity.includes(`VERSION = "${version} (${versionCode})"`),'Activity and manifest versions differ');
 assert.ok(activity.includes(`OASISSmoke/${version} NativeLobby/1`),'WebView version differs');
 const catalog=[...activity.matchAll(/\{"([a-z]+)",\s*"[^"]+",\s*"[^"]+",\s*"(?:概率|竞技)",\s*"#[0-9A-Fa-f]{6}"\}/g)].map(match=>match[1]);
 assert.deepEqual(catalog,RELEASED_IDS,'Native cards must match the released catalogue');
 if(mockSource){
  const declarations=mockSource.match(/private static final String\[\] GAME_IDS\s*=\s*\{([\s\S]*?)\};/)?.[1];
  assert.ok(declarations,'Mock partner launch catalogue is missing');
  const mockGames=[...declarations.matchAll(/"([a-z]+)"/g)].map(match=>match[1]);
  assert.deepEqual(mockGames,RELEASED_IDS,'Mock partner launch catalogue must match the released catalogue');
  assert.match(activity,/mockPartnerApi\.selectGame\(identity\.userId, id\)/,'Game launch must pass through the local App mock');
  assert.doesNotMatch(mockSource,/java\.net\.|HttpURLConnection|Socket\b|https?:\/\//,'Mock App API must remain in-process');
 }

 // Evaluate the actual Java loop bounds (also valid JS), including odd-sized
 // catalogues. Out-of-range access throws instead of silently returning null.
 const outer=activity.match(/for \(int rowIndex = 0; ([^;]+); rowIndex \+= 2\)/)?.[1];
 const inner=activity.match(/for \(int column = 0; ([^;]+); column\+\+\)/)?.[1];
 assert.ok(outer&&inner,'Native grid bounds could not be inspected');
 const gridCases=[0,1,2,12,13,14].map(count=>{
  const visited=[];
  const GAMES=new Proxy(Array.from({length:count},(_,i)=>i),{get(target,key){
   if(/^\d+$/.test(String(key))&&Number(key)>=count)throw Error('Native grid array overrun');
   return Reflect.get(target,key);
  }});
  vm.runInNewContext(`for(let rowIndex=0;${outer};rowIndex+=2){for(let column=0;${inner};column++){visited.push(GAMES[rowIndex+column]);}}`,{GAMES,visited},{timeout:100});
  assert.deepEqual(visited,Array.from({length:count},(_,i)=>i));
  return{catalogSize:count,visited:visited.length,passed:true};
 });
 const source=activity.match(/String script = ([\s\S]+?);\s*try \{/)[1];
 const backScript=[...source.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match=>JSON.parse(match[0])).join('');
 const actualBackScriptCases=[
  ['trusted host calls requestBack','https://game.tianyahuyu.com','/demo/native/tiger','ok','handled',1],
  ['other game uses same host contract','https://game.tianyahuyu.com','/demo/native/towerlink','ok','handled',1],
  ['web lobby does not call native host','https://game.tianyahuyu.com','/demo/','ok','not-handled',0],
  ['wrong origin rejected','https://evil.test','/demo/native/tiger','ok','not-handled',0],
  ['missing host falls back','https://game.tianyahuyu.com','/demo/native/tiger','missing','not-handled',0],
  ['host exception falls back','https://game.tianyahuyu.com','/demo/native/tiger','throws','not-handled',0],
 ].map(([label,origin,pathname,host,expected,expectedCalls])=>{
  let calls=0;
  const window=host==='missing'?{}:{OasisNativeHost:{requestBack(){if(host==='throws')throw Error('fixture');calls++;}}};
  const result=vm.runInNewContext(backScript,{window,location:{origin,pathname}},{timeout:100});
  assert.equal(result,expected,label);assert.equal(calls,expectedCalls,label);
  return{case:label,result,calls};
 });
 return{version,versionCode,catalog,gridCases,actualBackScriptCases,mockPartnerApi:'deterministic in-process App fixture for identity/profile/display balance/game selection; platform game WebView uses separate real HTTPS sandbox'};
}

export async function writeBuildMetadata(){
 const root=new URL('./',import.meta.url);
 const [activity,manifest,mockSource]=await Promise.all([
  readFile(new URL('app/src/com/tianyahuyu/oasis/smoke/MainActivity.java',root),'utf8'),
  readFile(new URL('app/AndroidManifest.xml',root),'utf8'),
  readFile(new URL('app/src/com/tianyahuyu/oasis/smoke/MockPartnerApi.java',root),'utf8'),
 ]);
 const checks=inspectAndroidSource(activity,manifest,mockSource),apk=`oasis-android-smoke-${checks.version}-debug.apk`;
 const bytes=await readFile(new URL(`dist/${apk}`,root));
 const apkSha256=createHash('sha256').update(bytes).digest('hex');
 const metadata={...checks,apk,apkSha256,scope:'pure Java local MockPartnerApi contract, source contract and signed APK only; no physical Android verification performed'};
 await writeFile(new URL('dist/build-checks.json',root),JSON.stringify(metadata,null,2)+'\n');
 await writeFile(new URL('dist/SHA256SUMS',root),`${apkSha256}  ${apk}\n`);
 return metadata;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await writeBuildMetadata();console.log(`APK metadata verified: ${result.version} (${result.versionCode}), ${result.catalog.length} games, SHA256 ${result.apkSha256}`);
}
