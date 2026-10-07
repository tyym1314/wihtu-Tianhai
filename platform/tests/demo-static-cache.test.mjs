import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readdir,readFile,rm,stat,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDemoHost} from '../deploy/demo-host.mjs';

const origin='https://cache-fixture.example.test';

async function fixture(t,config={}){
 const localDir=config.localDir===undefined?await mkdtemp(join(tmpdir(),'oasis-demo-cache-fixture-')):config.localDir;
 if(config.localDir===undefined)t.after(()=>rm(localDir,{recursive:true,force:true}));
 const backend={games:async()=>({games:[]}),launch:async()=>{throw new Error('launch is not needed');}};
 const server=await createDemoHost({origin,...config,localDir},{backend,key:Buffer.alloc(32,31)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return(path,{method='GET',headers={}}={})=>new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:server.address().port,path,method,headers:{host:new URL(origin).host,...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
  });req.on('error',reject);req.end();
 });
}

const pathFrom=(body,pattern)=>{
 const match=body.match(pattern);assert(match,`Missing static URL matching ${pattern}`);return match[1];
};

test('demo HTML and identity API remain no-store while byte-fingerprinted public assets are immutable',async t=>{
 const send=await fixture(t);
 const lobby=await send('/demo/'),html=lobby.body.toString();
 assert.equal(lobby.status,200);assert.equal(lobby.headers['cache-control'],'no-store');assert.equal(lobby.headers.etag,undefined);
 const script=pathFrom(html,/src="(\/demo\/static\/[a-f0-9]{64}\/host\.mjs)"/);
 const css=pathFrom(html,/href="(\/demo\/static\/[a-f0-9]{64}\/host\.css)"/);
 const native=await send('/demo/native/match'),nativeHtml=native.body.toString();
 assert.equal(native.headers['cache-control'],'no-store');
 const boot=pathFrom(nativeHtml,/src="(\/demo\/static\/[a-f0-9]{64}\/native-game-host-boot\.mjs)"/);
 const nativeCss=pathFrom(nativeHtml,/href="(\/demo\/static\/[a-f0-9]{64}\/native-game-host\.css)"/);
 for(const route of [script,css,boot,nativeCss]){
  const first=await send(route),head=await send(route,{method:'HEAD'}),again=await send(route,{headers:{'if-none-match':first.headers.etag}});
  assert.equal(first.status,200,route);assert.equal(first.headers['cache-control'],'public,max-age=2592000,immutable');
  assert.match(first.headers.etag,/^"[a-f0-9]{64}"$/);assert.equal(first.headers['set-cookie'],undefined);
  assert.equal(Number(first.headers['content-length']),first.body.length);
  assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers.etag,first.headers.etag);
  assert.equal(again.status,304);assert.equal(again.body.length,0);
 }
 const hostSource=(await send(script)).body.toString(),sdk=pathFrom(hostSource,/from '(\/demo\/static\/[a-f0-9]{64}\/oasis-h5\.mjs)'/);
 const bootSource=(await send(boot)).body.toString(),nativeModule=pathFrom(bootSource,/from '(\/demo\/static\/[a-f0-9]{64}\/native-game-host\.mjs)'/);
 assert(bootSource.includes(sdk));
 for(const route of [sdk,nativeModule])assert.equal((await send(route)).headers['cache-control'],'public,max-age=2592000,immutable');
 const config=await send('/api/demo/config');assert.equal(config.headers['cache-control'],'no-store');assert(config.headers['set-cookie']);
});

test('an in-memory-only host never advertises durable immutable caching',async t=>{
 const send=await fixture(t,{localDir:null});
 const html=(await send('/demo/')).body.toString();
 const script=pathFrom(html,/src="(\/demo\/static\/[a-f0-9]{64}\/host\.mjs)"/);
 assert.equal((await send(script)).headers['cache-control'],'public,max-age=0,must-revalidate');
});

test('previous release URLs survive startup and rollback through a bounded public-only archive',async t=>{
 const localDir=await mkdtemp(join(tmpdir(),'oasis-demo-cache-')),archive=join(localDir,'demo-public-static-v1');
 t.after(()=>rm(localDir,{recursive:true,force:true}));
 await mkdir(archive,{mode:0o700});
 const former=Buffer.from('export const priorRelease = true;'),digest=createHash('sha256').update(former).digest('hex');
 await writeFile(join(archive,digest+'-host.mjs'),former,{mode:0o600});
 const renamed=Buffer.from('export const oldFilename = true;'),renamedDigest=createHash('sha256').update(renamed).digest('hex');
 await writeFile(join(archive,renamedDigest+'-retired-host.mjs'),renamed,{mode:0o600});
 const stale=Buffer.from('export const stale = true;'),staleDigest=createHash('sha256').update(stale).digest('hex');
 const staleFile=join(archive,staleDigest+'-host.mjs');await writeFile(staleFile,stale,{mode:0o600});
 const corruptDigest=createHash('sha256').update('expected').digest('hex');
 await writeFile(join(archive,corruptDigest+'-host.mjs'),'tampered',{mode:0o600});
 const staleTime=new Date(Date.now()-46*86400000);await utimes(staleFile,staleTime,staleTime);
 const send=await fixture(t,{localDir}),historical='/demo/static/'+digest+'/host.mjs';
 const requests=await Promise.all(Array.from({length:24},()=>send(historical)));
 for(const response of requests){assert.equal(response.status,200);assert.deepEqual(response.body,former);assert.equal(response.headers['cache-control'],'public,max-age=2592000,immutable');}
 const retired=await send('/demo/static/'+renamedDigest+'/retired-host.mjs');
 assert.equal(retired.status,200);assert.equal(retired.headers['content-type'],'text/javascript; charset=utf-8');assert.deepEqual(retired.body,renamed);
 assert.equal((await send('/demo/static/'+staleDigest+'/host.mjs')).status,404);
 assert.equal((await send('/demo/static/'+corruptDigest+'/host.mjs')).status,404);
 const current=pathFrom((await send('/demo/')).body.toString(),/src="(\/demo\/static\/[a-f0-9]{64}\/host\.mjs)"/);
 const currentDigest=current.split('/')[3],currentFile=join(archive,currentDigest+'-host.mjs');
 await utimes(currentFile,staleTime,staleTime);
 // A second host using the same private runtime directory models both a
 // release switch and a rollback: old content-addressed URLs remain valid.
 const sendAfterSwitch=await fixture(t,{localDir});assert.deepEqual((await sendAfterSwitch(historical)).body,former);
 assert.equal((await sendAfterSwitch(current)).status,200);assert(Date.now()-(await stat(currentFile)).mtimeMs<60000);
 const names=await readdir(archive);assert(names.every(name=>/^[a-f0-9]{64}-[a-z0-9-]+\.(?:mjs|css)$/.test(name)));
 assert(!names.some(name=>name.endsWith('.html')||name.includes('guest')||name.includes('config')));
 const file=await stat(join(archive,digest+'-host.mjs'));assert.equal(file.mode&0o777,0o600);
 assert.deepEqual(await readFile(join(archive,digest+'-host.mjs')),former);
});

test('archive failure prevents startup before any immutable URL is advertised',async t=>{
 const localDir=await mkdtemp(join(tmpdir(),'oasis-demo-cache-fail-'));
 t.after(()=>rm(localDir,{recursive:true,force:true}));
 await writeFile(join(localDir,'demo-public-static-v1'),'occupied');
 await assert.rejects(fixture(t,{localDir}),/EEXIST/);
});

test('day-44 GET and 304 renew the service window beyond the original day 45',async t=>{
 const localDir=await mkdtemp(join(tmpdir(),'oasis-demo-cache-age-')),archive=join(localDir,'demo-public-static-v1');
 t.after(()=>rm(localDir,{recursive:true,force:true}));await mkdir(archive,{mode:0o700});
 const old=Buffer.from('export const day44 = true;'),digest=createHash('sha256').update(old).digest('hex');
 const location=join(archive,digest+'-retired-host.mjs');await writeFile(location,old,{mode:0o600});
 const day44=new Date(Date.now()-44*86400000);await utimes(location,day44,day44);
 const url='/demo/static/'+digest+'/retired-host.mjs',send=await fixture(t,{localDir});
 const first=await send(url);assert.equal(first.status,200);assert.equal(first.headers['cache-control'],'public,max-age=2592000,immutable');
 assert(Date.now()-(await stat(location)).mtimeMs<60000,'GET must renew archive retention before advertising 30 days');
 await utimes(location,day44,day44);
 const revalidated=await send(url,{headers:{'if-none-match':first.headers.etag}});assert.equal(revalidated.status,304);
 assert(Date.now()-(await stat(location)).mtimeMs<60000,'304 must also renew archive retention');
 const day29AfterLastResponse=new Date(Date.now()-29*86400000);await utimes(location,day29AfterLastResponse,day29AfterLastResponse);
 const afterSwitch=await fixture(t,{localDir});assert.equal((await afterSwitch(url)).status,200);
});

test('archive capacity admits exactly 512 files and fails closed before evicting a promised old URL',async t=>{
 const localDir=await mkdtemp(join(tmpdir(),'oasis-demo-cache-cap-')),archive=join(localDir,'demo-public-static-v1');
 t.after(()=>rm(localDir,{recursive:true,force:true}));await mkdir(archive,{mode:0o700});
 const prior=[];
 for(let i=0;i<506;i++){
  const bytes=Buffer.from('historical-'+i),digest=createHash('sha256').update(bytes).digest('hex');
  const filename=digest+'-retired-host.mjs';await writeFile(join(archive,filename),bytes,{mode:0o600});prior.push({filename,digest,bytes});
 }
 const send=await fixture(t,{localDir}),html=await send('/demo/');
 assert.equal(html.status,200);
 assert.equal((await readdir(archive)).length,512);
 const current=pathFrom(html.body.toString(),/src="(\/demo\/static\/[a-f0-9]{64}\/host\.mjs)"/);
 assert.equal((await send(current)).status,200);
 const oldest='/demo/static/'+prior[0].digest+'/retired-host.mjs';assert.deepEqual((await send(oldest)).body,prior[0].bytes);
 const excessBytes=Buffer.from('one-more-live-url'),excessDigest=createHash('sha256').update(excessBytes).digest('hex');
 const excessFile=join(archive,excessDigest+'-retired-host.mjs');await writeFile(excessFile,excessBytes,{mode:0o600});
 await assert.rejects(fixture(t,{localDir}),/DEMO_STATIC_ARCHIVE_CAPACITY/);
 assert.equal((await readdir(archive)).length,513,'no unexpired historical file may be evicted');
 assert.deepEqual((await send(oldest)).body,prior[0].bytes,'the already running host still serves its old URL');
 const expired=new Date(Date.now()-46*86400000);await utimes(excessFile,expired,expired);
 await fixture(t,{localDir});assert.equal((await readdir(archive)).length,512);
});

test('archive byte budget fails closed without deleting recent public assets',async t=>{
 const localDir=await mkdtemp(join(tmpdir(),'oasis-demo-cache-bytes-')),archive=join(localDir,'demo-public-static-v1');
 t.after(()=>rm(localDir,{recursive:true,force:true}));await mkdir(archive,{mode:0o700});
 const names=[];
 for(let i=0;i<16;i++){
  const bytes=Buffer.alloc(1024*1024,i),digest=createHash('sha256').update(bytes).digest('hex');
  const filename=digest+'-retired-host.mjs';await writeFile(join(archive,filename),bytes,{mode:0o600});names.push(filename);
 }
 await assert.rejects(fixture(t,{localDir}),/DEMO_STATIC_ARCHIVE_CAPACITY/);
 const remaining=new Set(await readdir(archive));assert(names.every(name=>remaining.has(name)));
});

test('unversioned compatibility URLs revalidate, and fabricated fingerprints cannot read content',async t=>{
 const send=await fixture(t);
 for(const route of ['/demo/host.mjs','/demo/host.css','/demo/sdk/oasis-h5.mjs','/demo/native-game-host-boot.mjs']){
  const first=await send(route);assert.equal(first.status,200);assert.equal(first.headers['cache-control'],'public,max-age=0,must-revalidate');
  assert.equal((await send(route,{headers:{'if-none-match':first.headers.etag}})).status,304);
 }
 assert.equal((await send('/demo/static/0000000000000000/host.mjs')).status,404);
 assert.equal((await send('/demo/static/%2e%2e/host.mjs')).status,404);
 assert.equal((await send('/demo/static/0000000000000000/private.key')).status,404);
 assert.equal((await send('/demo/static/'+'0'.repeat(64)+'/retired-host.json')).status,404);
});
