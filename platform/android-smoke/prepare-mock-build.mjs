/** Generate a distinct Android mock variant without changing the historical 1.2 APK source. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {isIP} from 'node:net';

const historicalOrigin='https://game.tianyahuyu.com';
const oldSandboxOrigin='https://oasis.43.98.202.236.sslip.io';
const packageName='com.tianyahuyu.oasis.mock';
const version='1.3.0',versionCode=6;
const sourceDir=fileURLToPath(new URL('./app/src/com/tianyahuyu/oasis/smoke/',import.meta.url));
const generatedDir=fileURLToPath(new URL('./build/mock/generated/',import.meta.url));

export function validateMockOrigin(input,liveOrigin=historicalOrigin){
 if(typeof input!=='string'||!input)throw Error('OASIS_ANDROID_MOCK_ORIGIN_REQUIRED');
 let url;try{url=new URL(input);}catch{throw Error('OASIS_ANDROID_MOCK_ORIGIN_INVALID');}
 const host=url.hostname.toLowerCase(),ipHost=host.replace(/^\[/,'').replace(/\]$/,'');
 const reserved=/(?:^|\.)(?:localhost|invalid|test|example)$/.test(host)||/^(?:.+\.)?example\.(?:com|org|net)$/.test(host);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==input||!host||reserved||isIP(ipHost))throw Error('OASIS_ANDROID_MOCK_ORIGIN_INVALID');
 const live=new URL(liveOrigin),old=new URL(oldSandboxOrigin);
 if(url.hostname===live.hostname||url.hostname===old.hostname||url.hostname===new URL(historicalOrigin).hostname)throw Error('OASIS_ANDROID_MOCK_ORIGIN_MUST_BE_ISOLATED');
 return Object.freeze({origin:url.origin,host:url.hostname,port:Number(url.port||443)});
}

function replaceExactlyOnce(source,from,to){
 assert.equal(source.split(from).length,2,`Historical source contract changed: ${from.slice(0,48)}`);
 return source.replace(from,to);
}

export function generateMockSources(activity,manifest,endpoint){
 let main=activity;
 main=replaceExactlyOnce(main,'private static final String ORIGIN = "https://game.tianyahuyu.com";','private static final String ORIGIN = MockOrigin.ORIGIN;');
 main=replaceExactlyOnce(main,'private static final String VERSION = "1.2.0 (5)";','private static final String VERSION = "1.3.0 (6)";');
 main=replaceExactlyOnce(main,'OASISSmoke/1.2.0 NativeLobby/1','OASISSmoke/1.3.0 NativeLobby/1');
 main=replaceExactlyOnce(main,'"game.tianyahuyu.com".equalsIgnoreCase(uri.getHost())','MockOrigin.HOST.equalsIgnoreCase(uri.getHost())');
 main=replaceExactlyOnce(main,'(uri.getPort() == -1 || uri.getPort() == 443)','(MockOrigin.PORT == 443 ? (uri.getPort() == -1 || uri.getPort() == 443) : uri.getPort() == MockOrigin.PORT)');
 main=replaceExactlyOnce(main,"location.origin!=='https://game.tianyahuyu.com'","location.origin!=='\" + ORIGIN + \"'");
 assert.ok(!main.includes('game.tianyahuyu.com'),'Generated mock source must not refer to the live host');
 let generatedManifest=manifest;
 generatedManifest=replaceExactlyOnce(generatedManifest,'package="com.tianyahuyu.oasis.smoke"',`package="${packageName}"`);
 generatedManifest=replaceExactlyOnce(generatedManifest,'android:versionCode="5"',`android:versionCode="${versionCode}"`);
 generatedManifest=replaceExactlyOnce(generatedManifest,'android:versionName="1.2.0"',`android:versionName="${version}"`);
 generatedManifest=replaceExactlyOnce(generatedManifest,'android:name=".MainActivity"','android:name="com.tianyahuyu.oasis.smoke.MainActivity"');
 const originJava=`package com.tianyahuyu.oasis.smoke;\n\n/** Build-time bound HTTPS origin. No runtime URL override or fallback. */\nfinal class MockOrigin {\n    static final String ORIGIN = "${endpoint.origin}";\n    static final String HOST = "${endpoint.host}";\n    static final int PORT = ${endpoint.port};\n    private MockOrigin() {}\n}\n`;
 return {main,manifest:generatedManifest,originJava};
}

export async function prepareMockBuild(env=process.env){
 const endpoint=validateMockOrigin(env.OASIS_ANDROID_MOCK_ORIGIN,env.OASIS_LIVE_PUBLIC_ORIGIN||historicalOrigin);
 const [activity,manifest]=await Promise.all([readFile(path.join(sourceDir,'MainActivity.java'),'utf8'),readFile(new URL('./app/AndroidManifest.xml',import.meta.url),'utf8')]);
 const generated=generateMockSources(activity,manifest,endpoint),javaDir=path.join(generatedDir,'src/com/tianyahuyu/oasis/smoke');
 await mkdir(javaDir,{recursive:true});
 await Promise.all([
  writeFile(path.join(javaDir,'MainActivity.java'),generated.main),
  writeFile(path.join(javaDir,'MockOrigin.java'),generated.originJava),
  writeFile(path.join(generatedDir,'AndroidManifest.xml'),generated.manifest),
  writeFile(path.join(generatedDir,'endpoint.json'),JSON.stringify({packageName,version,versionCode,...endpoint},null,2)+'\n')
 ]);
 return {packageName,version,versionCode,...endpoint,generatedDir};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await prepareMockBuild();console.log(`Android mock source prepared: ${result.packageName} ${result.version} ${result.origin}`);}
 catch(error){console.error(error.message);process.exitCode=1;}
}
