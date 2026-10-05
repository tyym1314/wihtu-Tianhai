import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,mkdir,writeFile,stat,utimes,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serveGameAsset} from '../server/game-assets.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'oasis-game-assets-')),arenaRoot=join(root,'arena'),legacyRoot=join(root,'legacy');
  await Promise.all([mkdir(join(arenaRoot,'assets','restoration'),{recursive:true}),mkdir(join(legacyRoot,'assets','tiger'),{recursive:true}),mkdir(join(legacyRoot,'bundles'),{recursive:true})]);
  const assets={
    'arena/index.html':'<html>arena</html>','legacy/tiger.html':'<html>tiger</html>',
    'arena/assets/scene-Ab12_cdE.glb':Buffer.from([0x67,0x6c,0x54,0x46,0,255,128,42]),
    'arena/assets/decoder-Ab12_cdE.wasm':Buffer.from([0,0x61,0x73,0x6d,1,0,0,0]),
    'arena/assets/model.gltf':'{"asset":{"version":"2.0"}}',
    'arena/assets/index-Ab12_cdE.js':'export const version=1;',
    'legacy/bundles/tiger-Ab12_cdE.js':'export const game="tiger";',
    'arena/assets/restoration/player-portraits-v2.webp':'first-image',
    'arena/assets/match-palace-mobile-09ad602636.webp':'mobile-palace',
    'legacy/assets/tiger/character-idle-mobile-012345abcd.webp':'mobile-tiger',
    'arena/assets/restoration/example-mobile-not-a-hash.webp':'mutable-name',
  };
  await Promise.all(Object.entries(assets).map(([name,value])=>writeFile(join(root,name),value)));
  const server=createServer((req,res)=>{serveGameAsset(req,res,req.url,{arenaRoot,legacyRoot}).catch(error=>{if(res.headersSent){res.destroy();return;}res.writeHead(error.status||500,{'content-type':'application/json'});res.end(JSON.stringify({code:error.code}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const send=(path,{method='GET',headers={}}={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers,agent:false},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});
    req.on('error',reject);req.end();
  });
  return{root,assets,send};
}

test('models and decoders keep exact bytes and MIME types eligible for ingress compression',async t=>{
  const f=await fixture(t);
  for(const [path,type] of [['arena/assets/scene-Ab12_cdE.glb','model/gltf-binary'],['arena/assets/decoder-Ab12_cdE.wasm','application/wasm'],['arena/assets/model.gltf','model/gltf+json'],['arena/assets/index-Ab12_cdE.js','text/javascript']]){
    const r=await f.send('/'+path);assert.equal(r.status,200);assert.equal(r.headers['content-type'],type);assert.deepEqual(r.body,Buffer.from(f.assets[path]));assert.equal(Number(r.headers['content-length']),r.body.length);
  }
});

test('hashed build assets are immutable while mutable copied assets must revalidate',async t=>{
  const f=await fixture(t);
  for(const path of ['/arena/assets/scene-Ab12_cdE.glb','/legacy/bundles/tiger-Ab12_cdE.js','/arena/assets/match-palace-mobile-09ad602636.webp','/legacy/assets/tiger/character-idle-mobile-012345abcd.webp'])assert.equal((await f.send(path)).headers['cache-control'],'public,max-age=31536000,immutable');
  for(const path of ['/arena/assets/model.gltf','/arena/assets/restoration/player-portraits-v2.webp','/arena/assets/restoration/example-mobile-not-a-hash.webp']){
    const r=await f.send(path);assert.equal(r.headers['cache-control'],'public,max-age=0,must-revalidate');assert.match(r.headers.etag,/^W\/"[^\"]+"$/);assert.ok(Number.isFinite(Date.parse(r.headers['last-modified'])));
  }
});

test('ETag revalidation returns empty 304 and takes precedence over modification dates',async t=>{
  const f=await fixture(t),path='/arena/assets/restoration/player-portraits-v2.webp',initial=await f.send(path);
  for(const tag of [initial.headers.etag,initial.headers.etag.replace(/^W\//,''),'"older", '+initial.headers.etag,'*']){
    const r=await f.send(path,{headers:{'if-none-match':tag}});assert.equal(r.status,304);assert.equal(r.body.length,0);assert.equal(r.headers.etag,initial.headers.etag);assert.equal(r.headers['content-length'],undefined);
  }
  const mismatch=await f.send(path,{headers:{'if-none-match':'"different"','if-modified-since':initial.headers['last-modified']}});
  assert.equal(mismatch.status,200);assert.deepEqual(mismatch.body,initial.body);
});

test('Last-Modified revalidation handles a matching date and ignores malformed dates',async t=>{
  const f=await fixture(t),path='/arena/assets/model.gltf',initial=await f.send(path);
  assert.equal((await f.send(path,{headers:{'if-modified-since':initial.headers['last-modified']}})).status,304);
  assert.equal((await f.send(path,{headers:{'if-modified-since':'not-a-date'}})).status,200);
  assert.equal((await f.send(path,{headers:{'if-modified-since':'Thu, 01 Jan 1970 00:00:00 GMT'}})).status,200);
});

test('rewriting a mutable same-size asset invalidates its ETag even with restored mtime',async t=>{
  const f=await fixture(t),path='/arena/assets/restoration/player-portraits-v2.webp',file=join(f.root,path.slice(1));
  const oldStat=await stat(file),initial=await f.send(path);
  await writeFile(file,'other-image');await utimes(file,oldStat.atime,oldStat.mtime);
  const updated=await f.send(path,{headers:{'if-none-match':initial.headers.etag}});
  assert.equal(updated.status,200);assert.equal(updated.body.toString(),'other-image');assert.notEqual(updated.headers.etag,initial.headers.etag);
  assert.equal((await f.send(path,{headers:{'if-none-match':updated.headers.etag}})).status,304);
});

test('HTML entry routes always use no-store and never respond with cached 304',async t=>{
  const f=await fixture(t);
  for(const path of ['/play/run','/play/tiger','/arena/index.html','/legacy/tiger.html']){
    const r=await f.send(path,{headers:{'if-none-match':'*','if-modified-since':'Wed, 01 Jan 2098 00:00:00 GMT'}});
    assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers.etag,undefined);assert.equal(r.headers['last-modified'],undefined);assert.match(r.body.toString(),/<html>/);
  }
});

test('HEAD has GET metadata without a body and supports conditional 304',async t=>{
  const f=await fixture(t),path='/arena/assets/scene-Ab12_cdE.glb',get=await f.send(path),head=await f.send(path,{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(head.body.length,0);
  for(const key of ['content-type','content-length','cache-control','etag','last-modified'])assert.equal(head.headers[key],get.headers[key]);
  const cached=await f.send(path,{method:'HEAD',headers:{'if-none-match':get.headers.etag}});assert.equal(cached.status,304);assert.equal(cached.body.length,0);
});

test('unsupported methods, traversal and missing files remain rejected',async t=>{
  const f=await fixture(t);
  assert.equal((await f.send('/arena/index.html',{method:'POST'})).status,405);
  for(const path of ['/arena/../legacy/tiger.html','/arena/%2e%2e/legacy/tiger.html','/arena/assets/../../legacy/tiger.html','/arena/assets/\\secret'])assert.ok([400,404].includes((await f.send(path)).status));
  for(const path of ['/arena/missing.glb','/arena/assets','/play/missing'])assert.equal((await f.send(path)).status,404);
});
