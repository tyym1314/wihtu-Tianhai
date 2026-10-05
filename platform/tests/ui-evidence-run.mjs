/** Evidence plumbing only. Does not change a game, fixture state, gesture or assertion. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,relative,extname,sep,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const platform=fileURLToPath(new URL('../',import.meta.url)),repo=resolve(platform,'..');
const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hashFile(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
const sourceExtensions=new Set(['.mjs','.js','.jsx','.cjs','.ts','.tsx','.css','.html','.json','.wasm','.glb','.gltf','.bin','.png','.webp','.jpg','.jpeg','.avif','.svg','.ico','.woff','.woff2','.ttf','.otf','.mp3','.ogg','.wav']);
const fixtureExtensions=new Set(['.mjs','.js','.jsx','.cjs','.ts','.tsx','.css','.html']);
const excluded=new Set(['dist','node_modules','.local','.git','__pycache__','performance']);
const trees=['src','public','platform/arena','platform/shared','platform/server','platform/src','platform/public','platform/tests'];
const explicit=['package.json','package-lock.json','index.html','tiger.html','platform/package.json','platform/package-lock.json','platform/mobile-assets.json'];
const errorInfo=e=>({name:e.name,message:String(e.message||e),code:e.code,stack:e.stack});
async function snapshot(){
 const files=new Set();
 async function walk(dir){let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const entry of entries){const file=resolve(dir,entry.name),parts=relative(repo,file).split(sep);if(parts.some(p=>excluded.has(p)))continue;if(entry.isDirectory()){await walk(file);continue;}if(!entry.isFile()||!sourceExtensions.has(extname(file)))continue;if(parts.includes('qa')&&!fixtureExtensions.has(extname(file)))continue;files.add(file);}
 }
 for(const tree of trees)await walk(resolve(repo,tree));for(const file of explicit)try{if((await fs.stat(resolve(repo,file))).isFile())files.add(resolve(repo,file));}catch(e){if(e.code!=='ENOENT')throw e;}
 const hashes={};for(const file of [...files].sort())hashes[relative(repo,file).split(sep).join('/')]=await hashFile(file);return hashes;
}
export async function beginUiEvidence({suite,games,scope}){
 const runId=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8);
 const root=resolve(process.env.OASIS_UI_REVIEW_OUT||resolve(platform,'review','ui-gestures',runId,suite));
 // This guard runs before any fixture server, browser or snapshot work starts.
 await fs.mkdir(root,{recursive:true});assert.equal((await fs.readdir(root)).length,0,'OUTPUT_ALREADY_EXISTS: use a new empty OASIS_UI_REVIEW_OUT; never overwrite historical evidence');
 const url=pathToFileURL(root+'/'),result={schema:'ui-gesture-evidence-v1',suite,runId,expectedSamplesPerGame:suite==='board'?4:2,startedAt:new Date().toISOString(),scope,node:process.version,physicalDevice:false,passed:false,stage:null,failures:[],cleanup:[],pageErrors:[],resourceErrors:[],requestFailures:[],network:[],events:[],servedBundles:[],sourceBinding:{completeForDeclaredTrees:true,trees,explicit,sourceExtensions:[...sourceExtensions],excludedDirectories:[...excluded],qaBoundary:'Only executable fixture source/CSS/HTML under qa is included. Prior QA images/JSON/text evidence is excluded. Product assets outside qa are hashed. node_modules bodies and final production dist are not part of these isolated fixture tests.'}};
 await fs.writeFile(new URL('run.json',url),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 for(const game of games)await fs.mkdir(resolve(root,game));
 const before=await snapshot(),beforeBytes=JSON.stringify(before,null,2)+'\n';await fs.writeFile(new URL('source-sha256-before.json',url),beforeBytes);result.sourceBinding.before={file:'source-sha256-before.json',sha256:hashBytes(beforeBytes),files:Object.keys(before).length};
 const pending=new Set(),browsers=new Set(),contexts=new Set(),pages=new Set(),servers=new Set();let failed=false,closing=false;
 const write=async()=>fs.writeFile(new URL('run.json',url),JSON.stringify(result,null,2)+'\n');
 const path=(game,file='')=>pathToFileURL(resolve(root,game,file)+(file?'':'/')); 
 const rememberFailure=error=>{failed=true;result.failures.push({stage:result.stage,error:errorInfo(error)});process.exitCode=1;};
 await write();
 return{
  root,result,path,
  stage(value){result.stage=value;},
  event(kind,details={}){result.events.push({at:new Date().toISOString(),kind,stage:result.stage,...details});},
  fail:rememberFailure,
  server(value,label){if(value)servers.add({value,label});return value;},
  browser(value,engine){browsers.add(value);result.browsers??=[];result.browsers.push({engine,version:value.version()});return value;},
  context(value){contexts.add(value);return value;},
  page(value,engine){pages.add(value);const requests=new WeakMap();
   value.on('pageerror',e=>result.pageErrors.push({at:new Date().toISOString(),engine,stage:result.stage,pageUrl:value.url(),name:e.name,message:e.message,stack:e.stack}));
   value.on('framenavigated',frame=>{if(frame===value.mainFrame())result.events.push({at:new Date().toISOString(),kind:'main-frame-navigated',engine,stage:result.stage,url:frame.url()});});
   value.on('request',request=>{const entry={id:result.network.length+1,startedAt:new Date().toISOString(),engine,stage:result.stage,pageUrl:value.url(),url:request.url(),method:request.method(),type:request.resourceType()};requests.set(request,entry);result.network.push(entry);});
   value.on('requestfinished',request=>{const entry=requests.get(request);if(entry)entry.finishedAt=new Date().toISOString();});
   // Diagnostic ledger includes every failed request, even explicit lifecycle
   // cancellation. Do not silently relabel a generic Load failed as cancellation.
   value.on('requestfailed',request=>{const entry=requests.get(request),failure={at:new Date().toISOString(),engine,stage:result.stage,pageUrl:value.url(),requestId:entry?.id,startedAt:entry?.startedAt,startStage:entry?.stage,startPageUrl:entry?.pageUrl,url:request.url(),method:request.method(),type:request.resourceType(),failure:request.failure()};if(entry){entry.failedAt=failure.at;entry.failure=failure.failure;}result.requestFailures.push(failure);});
   value.on('response',response=>{const request=response.request(),u=new URL(response.url()),entry=requests.get(request);if(entry){entry.responseAt=new Date().toISOString();entry.status=response.status();}if(response.status()>=400)result.resourceErrors.push({engine,origin:u.origin,path:u.pathname,status:response.status(),type:request.resourceType()});
    if(!response.ok()||!['script','stylesheet'].includes(request.resourceType()))return;
    const task=response.body().then(body=>result.servedBundles.push({engine,origin:u.origin,path:u.pathname,type:request.resourceType(),bytes:body.length,sha256:hashBytes(body)})).catch(e=>{if(!closing)result.resourceErrors.push({engine,path:u.pathname,type:'bundle-evidence',error:e.message});});pending.add(task);task.finally(()=>pending.delete(task));
   });return value;
  },
  async failureScreenshot(page,engine){if(page&&!page.isClosed())try{await page.screenshot({path:resolve(root,`failure-${engine}.png`),fullPage:true,timeout:10000});await fs.writeFile(resolve(root,`failure-${engine}-page.json`),JSON.stringify({stage:result.stage,url:page.url(),events:await page.evaluate(()=>window.__gestureEvents??window.__touchEvents??window.__inputEvents??[])},null,2)+'\n');}catch(e){result.failures.push({stage:'failure-screenshot',error:errorInfo(e)});}},
  async closeBrowser(browser,context){closing=true;for(const [kind,resource]of[['context',context],['browser',browser]])if(resource)try{await resource.close();(kind==='context'?contexts:browsers).delete(resource);result.cleanup.push({kind,closed:true});}catch(e){result.cleanup.push({kind,closed:false,error:errorInfo(e)});rememberFailure(e);}closing=false;},
  async closeServers(){closing=true;for(const context of contexts)try{await context.close();result.cleanup.push({kind:'context-fallback',closed:true});}catch(e){rememberFailure(e);}contexts.clear();for(const browser of browsers)try{await browser.close();result.cleanup.push({kind:'browser-fallback',closed:true});}catch(e){rememberFailure(e);}browsers.clear();for(const record of servers){try{await record.value.close();let refused=false;try{await fetch(record.value.origin,{signal:AbortSignal.timeout(1500)});}catch{refused=true;}assert(refused,'Fixture listener still reachable: '+record.label);result.cleanup.push({kind:'server',label:record.label,origin:record.value.origin,closed:true,connectionRefused:true});}catch(e){result.cleanup.push({kind:'server',label:record.label,closed:false,error:errorInfo(e)});rememberFailure(e);}}servers.clear();closing=false;},
  async finish(reports){
   // Also covers partial browser/context setup failures before test-local finally.
   for(const context of contexts)try{await context.close();result.cleanup.push({kind:'context-fallback',closed:true});}catch(e){rememberFailure(e);}contexts.clear();
   for(const browser of browsers)try{await browser.close();result.cleanup.push({kind:'browser-fallback',closed:true});}catch(e){rememberFailure(e);}browsers.clear();
   await Promise.allSettled([...pending]);
   let after;
   try{after=await snapshot();const afterBytes=JSON.stringify(after,null,2)+'\n';await fs.writeFile(new URL('source-sha256-after.json',url),afterBytes);result.sourceBinding.after={file:'source-sha256-after.json',sha256:hashBytes(afterBytes),files:Object.keys(after).length};const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(file=>before[file]!==after[file]);result.sourceBinding.changedDuringRun=changed;result.sourceBinding.stable=changed.length===0;if(changed.length)rememberFailure(new Error('SOURCE_CHANGED_DURING_RUN: '+changed.join(', ')));}catch(e){rememberFailure(e);}
   if(result.pageErrors.length||result.resourceErrors.length)rememberFailure(new Error('PAGE_OR_RESOURCE_ERRORS: see run.json'));
   for(const game of games){const samples=reports[game]||[],gameReport={checkedAt:new Date().toISOString(),scope,passed:!failed&&samples.length===result.expectedSamplesPerGame,sourceBinding:result.sourceBinding,failures:result.failures,samples};await fs.writeFile(path(game,'report.json'),JSON.stringify(gameReport,null,2)+'\n');}
   result.finishedAt=new Date().toISOString();result.passed=!failed&&games.every(game=>reports[game]?.length===result.expectedSamplesPerGame)&&result.sourceBinding.stable===true;await write();console.log(JSON.stringify({suite,report:resolve(root,'run.json'),passed:result.passed,sourceFiles:Object.keys(before).length}));if(!result.passed)process.exitCode=1;
  }
 };
}
