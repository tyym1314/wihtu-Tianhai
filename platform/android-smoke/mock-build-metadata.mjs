/** Signed local mock APK evidence. Deployment and physical-device QA are separate gates. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {RELEASED_IDS} from '../shared/games.mjs';
import {validateMockOrigin} from './prepare-mock-build.mjs';

const root=fileURLToPath(new URL('./',import.meta.url));
const generated=path.join(root,'build/mock/generated');
const apk='oasis-android-mock-1.3.0-debug.apk';

export function inspectMockSources(main,manifest,originJava,endpoint){
 const bound=validateMockOrigin(endpoint.origin);
 assert.equal(endpoint.packageName,'com.tianyahuyu.oasis.mock');
 assert.equal(endpoint.version,'1.3.0');assert.equal(endpoint.versionCode,6);
 assert.equal(endpoint.host,bound.host);assert.equal(endpoint.port,bound.port);
 assert.match(manifest,/package="com\.tianyahuyu\.oasis\.mock"/);
 assert.match(manifest,/android:versionName="1\.3\.0"/);
 assert.match(manifest,/android:versionCode="6"/);
 assert.match(manifest,/android:name="com\.tianyahuyu\.oasis\.smoke\.MainActivity"/);
 assert.match(originJava,new RegExp(`static final String ORIGIN = "${endpoint.origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}";`));
 assert.match(originJava,new RegExp(`static final String HOST = "${endpoint.host.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}";`));
 assert.match(originJava,new RegExp(`static final int PORT = ${endpoint.port};`));
 assert.match(main,/private static final String ORIGIN = MockOrigin\.ORIGIN;/);
 assert.match(main,/MockOrigin\.HOST\.equalsIgnoreCase\(uri\.getHost\(\)\)/);
 assert.match(main,/MockOrigin\.PORT == 443/);
 assert.match(main,/location\.origin!=='.*\+ ORIGIN \+.*location\.pathname/);
 assert.match(main,/VERSION = "1\.3\.0 \(6\)"/);
 assert.match(main,/OASISSmoke\/1\.3\.0 NativeLobby\/1/);
 assert.doesNotMatch(main,/game\.tianyahuyu\.com/);
 const catalog=[...main.matchAll(/\{"([a-z]+)",\s*"[^"]+",\s*"[^"]+",\s*"(?:概率|竞技)",\s*"#[0-9A-Fa-f]{6}"\}/g)].map(match=>match[1]);
 assert.deepEqual(catalog,RELEASED_IDS);
 return {packageName:endpoint.packageName,version:endpoint.version,versionCode:endpoint.versionCode,origin:endpoint.origin,host:endpoint.host,port:endpoint.port,catalog};
}

export async function writeMockMetadata(){
 const endpoint=JSON.parse(await readFile(path.join(generated,'endpoint.json'),'utf8'));
 const [main,manifest,originJava,apkBytes]=await Promise.all([
  readFile(path.join(generated,'src/com/tianyahuyu/oasis/smoke/MainActivity.java'),'utf8'),
  readFile(path.join(generated,'AndroidManifest.xml'),'utf8'),
  readFile(path.join(generated,'src/com/tianyahuyu/oasis/smoke/MockOrigin.java'),'utf8'),
  readFile(path.join(root,'dist',apk))
 ]);
 const checked=inspectMockSources(main,manifest,originJava,endpoint),apkSha256=createHash('sha256').update(apkBytes).digest('hex');
 const metadata={...checked,apk,apkSha256,scope:'source, Java contract, signed local APK only; no isolated HTTPS deployment or physical Android acceptance'};
 await writeFile(path.join(root,'dist/mock-build-checks.json'),JSON.stringify(metadata,null,2)+'\n');
 await writeFile(path.join(root,'dist/mock-SHA256SUMS'),`${apkSha256}  ${apk}\n`);
 return metadata;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await writeMockMetadata();console.log(`Local mock APK metadata verified: ${result.version}, ${result.catalog.length} games, SHA256 ${result.apkSha256}`);}
 catch(error){console.error(error.message);process.exitCode=1;}
}
