/** Real Thunder DOM/CSS, local presentation-only session; no spin or wallet. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import {localizeLegacyFonts} from '../shared/fonts/legacy-fonts.mjs';

const platform=resolve(dirname(fileURLToPath(import.meta.url)),'..'),repo=dirname(platform);
const out=resolve(process.env.THUNDER_LAYOUT_OUT||resolve(platform,'review/thunder-layout-'+Date.now()));
await mkdir(out,{recursive:true});
const responsive=process.env.THUNDER_LAYOUT_CSS||resolve(platform,'legacy/art/thunder-responsive.css');
const baseline=process.env.THUNDER_LAYOUT_BASELINE==='1',engine=process.env.THUNDER_LAYOUT_BROWSER||'chromium';
assert.ok(['chromium','webkit'].includes(engine));
const hashes={};
const bundle=await build({stdin:{contents:`import ${JSON.stringify(resolve(repo,'src/main.ts'))};import ${JSON.stringify(responsive)};`,loader:'ts',resolveDir:repo},bundle:true,format:'esm',target:'es2022',outdir:'/fixture',write:false,external:['/assets/*'],loader:{'.woff2':'file'},assetNames:'fonts/[name]',plugins:[{name:'local-platform-fonts',setup(build){
 build.onLoad({filter:/\.(?:ts|css|mjs)$/},async args=>{
  let text=await readFile(args.path,'utf8');hashes[relative(repo,args.path)]=createHash('sha256').update(text).digest('hex');
  if(args.path===resolve(repo,'src/style.css'))text=localizeLegacyFonts(text,'thunder').replaceAll("'../fonts/","'"+resolve(platform,'shared/fonts')+'/');
  return{contents:text,loader:args.path.endsWith('.css')?'css':'ts',resolveDir:dirname(args.path)};
 });
}}]});
const files=new Map(bundle.outputFiles.map(f=>['/'+relative('/fixture',f.path),f.contents]));
const errors=[],requests=[],checks=[];
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;requests.push({method:req.method,path});
 try{
  if(req.method!=='GET')throw Error('NO_BUSINESS_MUTATIONS_ALLOWED');
  if(path==='/api/session'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({mode:'demo',sessionId:'layout-only',epoch:1,stateVersion:0,balance:12000,betChoices:[100,200,500],freeSpins:0,freeMultiplier:0,lockedBet:null,pendingRound:null}));}
  if(path==='/api/history'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({rounds:[]}));}
  if(path==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(path==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/stdin.css"></head><body><div id="app"></div><script type="module" src="/stdin.js"></script></body></html>');}
  let bytes=files.get(path);
  if(!bytes&&/^\/assets\/[a-zA-Z0-9._-]+$/.test(path))bytes=await readFile(resolve(repo,'public',path.slice(1)));
  if(!bytes)throw Error('UNKNOWN_FIXTURE_RESOURCE '+path);
  const type=path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':path.endsWith('.woff2')?'font/woff2':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.webp')?'image/webp':'image/png';
  res.writeHead(200,{'content-type':type});res.end(bytes);
 }catch(error){errors.push(error.message);res.writeHead(500);res.end('fixture failure');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await({chromium,webkit}[engine]).launch({headless:true});
const report={scope:'Local desktop browser, real Thunder DOM and presentation CSS, synthetic read-only session. No physical Android, wallet, spin, or exact reconstruction of missing device DOM measurements.',engine,baseline,hashes,checks,errors,requests,passed:false};
try{
 const cases=[[320,568],[360,560],[360,592],[360,640],[390,664],[390,844],[430,932],[480,780],[480,781],[360,560,'en'],[360,560,'ar'],[360,640,'zh',24,24],[390,844,'zh',47,34]];
 for(const [width,height,locale='zh',safeTop=0,safeBottom=0] of cases){
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true,isMobile:true,reducedMotion:'reduce'}),page=await context.newPage();
  await context.addInitScript(locale=>localStorage.setItem('tt-language',locale),locale);
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(errors.push('NONLOCAL_REQUEST'),route.abort()));
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(origin);await page.locator('#spin').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#spin').disabled);await page.evaluate(()=>document.fonts.ready);
  if(safeTop||safeBottom)await page.addStyleTag({content:`.game-shell{--thunder-safe-top:${safeTop}px;--thunder-safe-bottom:${safeBottom}px}`});
  const dimensions=await page.evaluate(()=>{
   const rect=selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return{selector,x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
   const controls=['#spin','#bet-value','[data-action="minus"]','[data-action="plus"]','[data-action="turbo"]','[data-action="auto"]','.topbar [data-action="rules"]','.topbar [data-action="language"]','.topbar [data-action="sound"]','[data-action="audio-start"]','.bottom-nav [data-action="rules"]','.bottom-nav [data-action="history"]','.bottom-nav [data-action="settings"]'];
   return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,bodyHeight:document.body.scrollHeight,sections:['.game-shell','.hero','.feature-bar','.board','.round-message','.stats','.spin-dock','.bottom-nav','.game-footer'].map(rect),controls:controls.map(selector=>{const r=rect(selector),e=document.querySelector(selector),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{...r,reachable:Boolean(hit&&(hit===e||e.contains(hit)))};}),cells:[...document.querySelectorAll('.cell')].map(e=>{const r=e.getBoundingClientRect();return{width:r.width,height:r.height,bottom:r.bottom,right:r.right};})};
  });
  const board=dimensions.sections.find(r=>r.selector==='.board');
  const row={width,height,locale,safeTop,safeBottom,dimensions,single_screen:dimensions.scrollWidth<=width+1&&dimensions.scrollHeight<=height+1&&dimensions.bodyHeight<=height+1,controls_reachable:dimensions.controls.every(r=>r.reachable&&r.x>=-1&&r.y>=safeTop-1&&r.right<=width+1&&r.bottom<=height-safeBottom+1),touch_targets:dimensions.controls.every(r=>r.width>=44&&r.height>=44),square_board:dimensions.cells.length===30&&dimensions.cells.every(r=>Math.abs(r.width-r.height)<=1&&r.right<=board.right+1&&r.bottom<=board.bottom+1)};checks.push(row);
  await page.screenshot({path:resolve(out,`${width}x${height}-${locale}-${safeTop}-${safeBottom}.png`)});
  if(!baseline){assert.equal(row.single_screen,true,`${width}x${height} overflow`);assert.equal(row.controls_reachable,true,`${width}x${height} controls clipped`);assert.equal(row.touch_targets,true,`${width}x${height} 44px target`);assert.equal(row.square_board,true,'All 30 square cells remain inside board');}
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==='GET'));report.passed=!baseline;
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{await browser.close();await new Promise(r=>server.close(r));await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({out,baseline,engine,checks:checks.length,passed:report.passed,failure:report.failure?.split('\n')[0]}));
