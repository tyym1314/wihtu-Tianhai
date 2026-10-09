import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

export const ROOT=fileURLToPath(new URL('./',import.meta.url));
export const VERSION='1.0.0';

export function parseBuildArguments(argv){
 const result={contractFixture:false};
 for(let index=0;index<argv.length;index++){
  const flag=argv[index];
  if(flag==='--contract-fixture'){
   if(result.contractFixture)throw Error('Duplicate --contract-fixture');
   result.contractFixture=true;continue;
  }
  const key={'--variant':'variant','--origin':'origin','--app-id':'appId'}[flag];
  if(!key)throw Error('Unknown build argument');
  if(result[key]!==undefined)throw Error('Duplicate build argument');
  const value=argv[++index];
  if(typeof value!=='string'||value.startsWith('--'))throw Error('Missing explicit build argument');
  result[key]=value;
 }
 return validateBuildConfiguration(result);
}

export function validateBuildConfiguration(input){
 if(!input||!['release','qa'].includes(input.variant))throw Error('Explicit --variant release or qa required');
 if(typeof input.origin!=='string'||!input.origin)throw Error('Explicit --origin required');
 if(typeof input.appId!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(input.appId))throw Error('Explicit valid --app-id required');
 if(input.contractFixture!==undefined&&typeof input.contractFixture!=='boolean')throw Error('Contract fixture flag must be boolean');
 let url;try{url=new URL(input.origin);}catch{throw Error('Canonical HTTPS origin required');}
 if(url.protocol!=='https:'||url.origin!==input.origin||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port==='0')throw Error('Canonical HTTPS origin required');
 const host=url.hostname,labels=host.split('.');
 if(host.length>253||labels.length<2||host.includes(':')||/^[0-9.]+$/.test(host)
   ||labels.some(label=>!/^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/.test(label))
   ||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal'))throw Error('Public DNS HTTPS origin required');
 const reserved=host.endsWith('.invalid')||host.endsWith('.test')||host.endsWith('.example')
   ||['example.com','example.org','example.net'].some(domain=>host===domain||host.endsWith('.'+domain));
 if(input.contractFixture){
  if(input.variant!=='qa'||!host.endsWith('.invalid'))throw Error('Contract fixture requires qa and an unresolvable .invalid origin');
 }else if(reserved)throw Error('Reserved placeholder origin requires explicit qa contract fixture');
 const variant=input.variant,contractFixture=Boolean(input.contractFixture);
 const flavor=contractFixture?'qa-contract':variant;
 return{variant,contractFixture,origin:input.origin,appId:input.appId,entryUrl:input.origin+'/player?app_id='+input.appId,
  flavor,version:variant==='qa'?VERSION+'-qa':VERSION,versionCode:1,
  packageName:variant==='qa'?'com.tianyahuyu.oasis.player.qa':'com.tianyahuyu.oasis.player',
  debuggable:variant==='qa',appName:contractFixture?'OASIS 合约验证（无后端）':variant==='qa'?'OASIS 玩家 QA':'OASIS 游戏',
  apkName:`oasis-player-${VERSION}-${flavor}.apk`};
}

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function sourceEvidence(){
 const files={};
 const visit=async(relative='')=>{
  for(const entry of (await readdir(path.join(ROOT,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(['build','dist','.local'].includes(entry.name))continue;
   const name=relative?relative+'/'+entry.name:entry.name;
   if(entry.isSymbolicLink())throw Error('Source symlinks are not supported');
   if(entry.isDirectory())await visit(name);
   else if(entry.isFile())files[name]=sha256(await readFile(path.join(ROOT,name)));
  }
 };
 await visit();
 const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
 assert.match(revision,/^[0-9a-f]{40}$/);
 return{baseRevision:revision,sourceSha256:sha256(JSON.stringify(files)),files};
}

export async function prepareBuild(argv){
 const config=parseBuildArguments(argv),evidence=await sourceEvidence();
 const buildDirectory=path.join(ROOT,'build',config.flavor),generated=path.join(buildDirectory,'generated');
 await mkdir(generated,{recursive:true});
 await mkdir(path.join(generated,'res','values'),{recursive:true});
 const [template,strings]=await Promise.all([
  readFile(path.join(ROOT,'app','AndroidManifest.xml'),'utf8'),
  readFile(path.join(ROOT,'app','res','values','strings.xml'),'utf8')
 ]);
 const manifest=template.replace('@@PACKAGE@@',config.packageName).replace('@@VERSION@@',config.version).replace('@@DEBUGGABLE@@',String(config.debuggable));
 const resources=strings.replace('@@APP_NAME@@',config.appName);
 if(manifest.includes('@@')||resources.includes('@@'))throw Error('Unresolved Android template marker');
 const java=`package com.tianyahuyu.oasis.player;\npublic final class PlayerBuildConfig {\n`
  +` public static final String PUBLIC_ORIGIN=${JSON.stringify(config.origin)};\n`
  +` public static final String PUBLIC_APP_ID=${JSON.stringify(config.appId)};\n`
  +` public static final String VERSION=${JSON.stringify(config.version)};\n`
  +` public static final boolean QA=${config.debuggable};\n`
  +` public static final boolean CONTRACT_FIXTURE=${config.contractFixture};\n`
  +` private PlayerBuildConfig() {}\n}\n`;
 const specification={...config,sourceEvidence:evidence,generatedSha256:{manifest:sha256(manifest),resources:sha256(resources),configuration:sha256(java)}};
 await Promise.all([
  writeFile(path.join(generated,'AndroidManifest.xml'),manifest),
  writeFile(path.join(generated,'res','values','strings.xml'),resources),
  writeFile(path.join(generated,'PlayerBuildConfig.java'),java),
  writeFile(path.join(buildDirectory,'build-config.json'),JSON.stringify(specification,null,2)+'\n')
 ]);
 return config.flavor;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(await prepareBuild(process.argv.slice(2)));}
 catch(error){console.error('Player APK configuration rejected: '+error.message);process.exitCode=1;}
}
