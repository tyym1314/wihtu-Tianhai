/** Built platform Tiger, optionally with candidate CSS. No real wallet or spin. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium,webkit} from 'playwright';
const platform=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=resolve(process.env.TIGER_LAYOUT_SOURCE||resolve(platform,'legacy/dist'));
const cssPath=resolve(platform,'legacy/art/tiger-restoration.css');
const baseline=process.env.TIGER_LAYOUT_BASELINE==='1',engine=process.env.TIGER_LAYOUT_BROWSER||'chromium';
const built=process.env.TIGER_LAYOUT_BUILT==='1';
assert.ok(!(baseline&&built),'BASELINE_AND_BUILT_ARE_DISTINCT_MODES');
assert.ok(['chromium','webkit'].includes(engine));
const out=resolve(process.env.TIGER_LAYOUT_OUT||resolve(platform,'review/tiger-layout-'+Date.now()+'-'+engine));
await mkdir(out,{recursive:false});
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const css=await readFile(cssPath,'utf8'),manifestPath=process.env.TIGER_LAYOUT_MANIFEST;
const manifest=manifestPath?JSON.parse(await readFile(resolve(manifestPath),'utf8')):null;
const requests=[],errors=[],hashes={},checks=[];
const host=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;}iframe{display:block;width:100%;height:100%;border:0}</style><iframe src="/play/tiger"></iframe><script>window.addEventListener('message',e=>{const f=document.querySelector('iframe');if(e.source!==f.contentWindow||e.origin!==location.origin)return;const d=e.data;if(d?.type==='oasis.ready')f.contentWindow.postMessage({...d,type:'oasis.launch',launch_code:'layout_fixture_only',host_state:{muted:true}},location.origin);});</script>`;
const server=createServer(async(req,res)=>{
 const p=new URL(req.url,'http://localhost').pathname;requests.push({method:req.method,path:p});
 const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
 try{
  if(p==='/v1/launch/exchange'&&req.method==='POST')return json({access_token:'layout_fixture_only',game_id:'tiger',session_id:'layout_fixture_session'});
  assert.equal(req.method,'GET','NO_BUSINESS_MUTATIONS_ALLOWED');
  if(p==='/api/play/tiger/config')return json({version:'layout-only',targetRtp:.99,payoutScale:{numerator:1,denominator:1}});
  if(p==='/api/play/tiger/session')return json({mode:'demo',sessionId:'layout_fixture_session',epoch:1,stateVersion:0,mathVersion:'layout-only',balance:12000,betChoices:[10,100,500],pendingRound:null});
  if(p==='/api/play/tiger/history')return json({rounds:[]});
  if(p==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(p==='/'){res.setHeader('content-type','text/html');return res.end(host);}
  const local=p==='/play/tiger'?'tiger.html':p.startsWith('/legacy/')?decodeURIComponent(p.slice('/legacy/'.length)):null;
  assert.ok(local&&!local.split('/').includes('..'),'UNKNOWN_LOCAL_RESOURCE');
  const path=resolve(source,local);assert.ok(path.startsWith(source+sep));
  const raw=await readFile(path);hashes[relative(platform,path)]=sha(raw);
  if(manifest)assert.equal(sha(raw),manifest['platform/legacy/dist/'+local],'FROZEN_MOCK20_ASSET_DRIFT '+local);
  const type=local.endsWith('.html')?'text/html':local.endsWith('.css')?'text/css':local.endsWith('.js')?'text/javascript':local.endsWith('.woff2')?'font/woff2':local.endsWith('.svg')?'image/svg+xml':local.endsWith('.webp')?'image/webp':'image/png';
  res.writeHead(200,{'content-type':type});res.end(raw);
 }catch(error){errors.push(error.message);res.writeHead(500);res.end('fixture failure');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await({chromium,webkit}[engine]).launch({headless:true});
const report={scope:`Desktop browser at touch mobile viewports, actual built platform Tiger DOM/bridge/assets with a loopback synthetic read-only session; ${baseline||built?'no candidate CSS overlay':'candidate CSS explicitly overlaid after load'}. No paid spin, ACK, server, device or performance claim.`,engine,baseline,built,source,manifest:manifestPath||null,css_sha256:sha(css),hashes,checks,errors,requests,passed:false};
function measure(){
 const rect=selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return{selector,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth};};
 const controls=['#spin','#bet-value','[data-action="minus"]','[data-action="plus"]','[data-action="turbo"]','[data-action="auto"]','.topbar [data-action="language"]','.topbar [data-action="sound"]','[data-action="music-start"]','.utility-row [data-action="rules"]','.utility-row [data-action="history"]','.utility-row [data-action="settings"]'];
 return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,bodyHeight:document.body.scrollHeight,sections:['.tiger-game','.tiger-hero','.reel-stage','#tiger-reels','.message-bar','#game-message','.control-panel','.wallet-row','.spin-row','.utility-row','.control-panel footer'].map(rect),controls:controls.map(s=>{const r=rect(s),e=document.querySelector(s),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{...r,reachable:!!hit&&(hit===e||e.contains(hit))};}),cells:[...document.querySelectorAll('.reel-cell')].map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})};
}
try{
 for(const [width,height,locale='zh',safeTop=0,safeBottom=0] of [[360,640],[390,664],[390,844],[430,932],[320,568],[360,640,'en'],[360,640,'ar'],[360,640,'zh',24,24],[390,844,'zh',47,34]]){
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  await context.addInitScript(locale=>{localStorage.setItem('golden-tiger:locale',locale);localStorage.setItem('golden-tiger:sound','false');localStorage.setItem('golden-tiger:music','false');},locale);
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(errors.push('NONLOCAL_REQUEST'),route.abort()));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(origin);const frame=page.frames().find(f=>f.url()===origin+'/play/tiger');assert.ok(frame);
  await frame.waitForFunction(()=>document.querySelector('#spin')&&!document.querySelector('#spin').disabled);
  await frame.evaluate(()=>document.fonts.ready);
  if(!baseline&&!built)await frame.addStyleTag({content:css});
  if(safeTop||safeBottom)await frame.addStyleTag({content:`.tiger-game{--tiger-safe-top:${safeTop}px;--tiger-safe-bottom:${safeBottom}px}`});
  await frame.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const dimensions=await frame.evaluate(measure),board=dimensions.sections.find(s=>s.selector==='#tiger-reels');
  const row={width,height,locale,safeTop,safeBottom,dimensions,single_screen:dimensions.scrollWidth<=width+1&&dimensions.scrollHeight<=height+1&&dimensions.bodyHeight<=height+1,controls_reachable:dimensions.controls.every(r=>r.reachable&&r.x>=-1&&r.y>=safeTop-1&&r.right<=width+1&&r.bottom<=height-safeBottom+1),touch_targets:dimensions.controls.every(r=>r.width>=44&&r.height>=44),reels_visible:dimensions.cells.length===9&&dimensions.cells.every(r=>r.width>=35&&r.height>=35&&r.x>=board.x-1&&r.y>=board.y-1&&r.right<=board.right+1&&r.bottom<=board.bottom+1)};
  checks.push(row);
  await page.screenshot({path:resolve(out,`${width}x${height}-${locale}-${safeTop}-${safeBottom}.png`)});
  if(!baseline){assert.ok(row.single_screen,'SINGLE_SCREEN '+width+'x'+height);assert.ok(row.controls_reachable,'CONTROLS_VISIBLE '+width+'x'+height);assert.ok(row.touch_targets,'44PX_TARGET '+width+'x'+height);assert.ok(row.reels_visible,'NINE_REELS_VISIBLE');}
  // Existing result elements only, synthetic labels; never invoke spin/playRound/ack.
  await frame.evaluate(()=>{const e=document.querySelector('.celebration');e.hidden=false;e.querySelector('.celebration-note').textContent='LAYOUT FIXTURE';e.querySelector('.celebration-title').textContent='超级大奖';e.querySelector('.celebration-amount').textContent='12,345.67';e.querySelector('.celebration-multiple').textContent='100 ×';});
  row.celebration=await frame.evaluate(()=>['.celebration-title','.celebration-amount','#continue'].map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{selector,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,reachable:!!hit&&(hit===e||e.contains(hit))};}));
  await page.screenshot({path:resolve(out,`${width}x${height}-${locale}-${safeTop}-${safeBottom}-result.png`)});
  if(!baseline){assert.ok(row.celebration.every(r=>r.x>=0&&r.y>=safeTop&&r.right<=width&&r.bottom<=height-safeBottom&&r.reachable),'RESULT_VISIBLE');const button=row.celebration.find(r=>r.selector==='#continue');assert.ok(button.width>=44&&button.height>=44,'CONTINUE_44PX');}
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==='GET'||r.path==='/v1/launch/exchange'));report.passed=!baseline;
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{await browser.close();await new Promise(r=>server.close(r));report.browserClosed=true;report.serverClosed=true;await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({out,engine,baseline,checks:checks.length,passed:report.passed,failure:report.failure?.split('\n')[0]}));
