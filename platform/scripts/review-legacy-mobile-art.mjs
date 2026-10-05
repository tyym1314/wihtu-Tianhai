import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {webkit} from 'playwright';
import {serveGameAsset} from '../server/game-assets.mjs';

// Presentation-only fixture: production boot image gate, real TigerCharacter,
// and production Thunder CSS. It never simulates a bet or changes game math.
const out=resolve(process.env.OASIS_PROFILE_OUT||'review/deep-mobile-20260928/legacy-mobile-art');
await mkdir(out,{recursive:true});
const stage=resolve('.local/legacy-src'),assets=JSON.parse(await readFile('mobile-assets.json','utf8')).filter(a=>a.source.startsWith('public/'));
const responses=[],errors=[],checks=[],bundles=new Map();
for(const game of ['tiger','thunder']){
 const boot=await readFile(resolve(stage,`boot-${game}.ts`),'utf8'),start=boot.indexOf('const artReady='),end=boot.indexOf('void artReady.catch');
 assert(start>=0&&end>start,'production image gate exists');
 const gate=boot.slice(start,end);
 const source=game==='tiger'?`import {TigerCharacter} from './src/tiger/character';\n${gate}\nawait artReady;let character;const mount=()=>{character?.dispose();character=new TigerCharacter(document.querySelector('.tiger-stage'));};mount();document.querySelector('#win').onclick=()=>character.react('win');document.querySelector('#remount').onclick=mount;document.body.dataset.ready='true';`:`import './src/style.css';\n${gate}\nawait artReady;document.querySelector('#free').onclick=()=>document.querySelector('.game-shell').classList.toggle('bonus-mode');document.body.dataset.ready='true';`;
 const result=await build({stdin:{contents:source,loader:'ts',resolveDir:stage},bundle:true,format:'esm',target:'es2022',outdir:'fixture',write:false,external:['/legacy/*']});
 for(const file of result.outputFiles)bundles.set(`/${game}.${file.path.endsWith('.css')?'css':'js'}`,file.contents);
}
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 let headers={};const writeHead=res.writeHead;res.writeHead=function(status,...args){headers=args.find(value=>value&&typeof value==='object')||{};return writeHead.call(this,status,...args);};
 res.on('finish',()=>responses.push({url:path,status:res.statusCode,entityBytes:res.statusCode===200?Number(headers['content-length']||0):0,cacheControl:headers['cache-control']||null}));
 try{
  if(path.startsWith('/legacy/'))return await serveGameAsset(req,res,path);
  if(bundles.has(path)){const body=bundles.get(path);res.writeHead(200,{'content-type':path.endsWith('.css')?'text/css':'text/javascript','content-length':body.length,'cache-control':'no-store'});return res.end(body);}
  const game=path==='/thunder'?'thunder':'tiger';
  const body=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${game}.css"><style>body{margin:0;background:#18202b;color:white;font:16px sans-serif}nav{padding:12px;display:flex;gap:12px}button{padding:12px;color:black;background:#ffe9ac;border-radius:8px}.tiger-stage{position:relative;height:350px;width:390px}.game-shell{margin:auto}.hero{height:500px}</style></head><body>${game==='tiger'?'<nav><button id="win">Win presentation</button><button id="remount">Remount</button></nav><div class="tiger-stage"></div>':'<nav><button id="free">Free mode artwork</button></nav><div class="game-shell"><div class="hero"><div class="hero-art"></div></div></div>'}<script type="module" src="/${game}.js"></script></body></html>`;
  res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(body);
 }catch(error){errors.push(error.message);res.writeHead(500);res.end('fixture failed');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,browser=await webkit.launch({headless:true});
const report={scope:'Desktop WebKit 390x844. Actual local HTTP with browser cache enabled, no routing or request interception. Isolated presentation only, not a phone or probability/settlement test.',checks,responses,errors};
try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/tiger');await page.waitForFunction(()=>document.querySelector('.tiger-stage')?.dataset.characterReady==='true');
 await page.screenshot({path:resolve(out,'tiger-idle.png')});
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.tiger-part-blink')).opacity==='1');
 await page.screenshot({path:resolve(out,'tiger-blink.png')});checks.push('real TigerCharacter constructor loads all three mapped poses; native idle blink becomes visible');
 await page.locator('#win').tap();assert.equal(await page.locator('.tiger-mascot').getAttribute('data-action'),'win');
 assert.match(await page.locator('.tiger-part-body').evaluate(e=>getComputedStyle(e).backgroundImage),/character-win-mobile-/);
 await page.screenshot({path:resolve(out,'tiger-win.png')});checks.push('trusted button tap invokes real TigerCharacter.react(win), production cheering CSS displays win art');
 for(let i=0;i<10;i++){await page.locator('#remount').tap();await page.waitForFunction(()=>document.querySelector('.tiger-stage')?.dataset.characterReady==='true');assert.equal(await page.locator('.tiger-mascot').count(),1);}
 await page.reload();await page.waitForFunction(()=>document.querySelector('.tiger-stage')?.dataset.characterReady==='true');checks.push('ten dispose/remounts and a warm reload reuse the same image entities');
 await page.goto(base+'/thunder');await page.waitForFunction(()=>document.body.dataset.ready==='true');
 await page.locator('#free').tap();assert.match(await page.locator('.hero-art').evaluate(e=>getComputedStyle(e).backgroundImage),/thunder-free-mobile-945e9aec53.webp/);
 await page.screenshot({path:resolve(out,'thunder-free.png')});
 await page.locator('#free').tap();await page.locator('#free').tap();checks.push('trusted presentation-only toggle activates production Thunder bonus CSS using the optimized free artwork');
 const images=responses.filter(r=>/\.(png|webp)$/.test(r.url));
 for(const asset of assets){const url='/legacy'+asset.optimized_url,hits=images.filter(r=>r.url===url&&r.status===200);assert.equal(hits.length,1,`${url} must transfer exactly one entity`);assert.equal(hits[0].entityBytes,asset.target_bytes);assert.equal(images.filter(r=>r.url==='/legacy'+asset.original_url).length,0,'no original PNG request');}
 report.imageEntityBytes=images.reduce((n,r)=>n+r.entityBytes,0);report.imageEntityCounts=Object.fromEntries(assets.map(a=>['/legacy'+a.optimized_url,images.filter(r=>r.url==='/legacy'+a.optimized_url&&r.status===200).length]));
 checks.push('all ten expected images transferred once each; zero original PNG requests; later poses/free mode/remount/reload transfer no duplicate image entity');
 assert.deepEqual(errors,[]);await context.close();
}finally{await browser.close();await new Promise(r=>server.close(r));await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({checks,imageEntityBytes:report.imageEntityBytes,errors}));
