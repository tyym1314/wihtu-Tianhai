import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,extname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const platform=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const tmp=await mkdtemp(join(tmpdir(),'oasis-dd-ui-'));
const out=join(platform,'arena/darts/review'),domout=join(platform,'arena/domino/review');
await mkdir(out,{recursive:true});await mkdir(domout,{recursive:true});
// esbuild does not rewrite new URL('./asset', import.meta.url) by itself. Convert only
// static local image URLs to file-loader imports, mirroring Vite without editing UI source.
const assetURLPlugin={name:'review-static-image-urls',setup(bundler){
 bundler.onLoad({filter:/\.[cm]?[jt]sx?$/},async args=>{
  if(!args.path.startsWith(join(platform,'arena')+sep))return;
  const source=await readFile(args.path,'utf8'),imports=[];
  const contents=source.replace(/new URL\(\s*(['"])(\.{1,2}\/[^'"]+\.(?:png|webp|jpe?g|svg))\1\s*,\s*import\.meta\.url\s*\)\.href/g,(_match,_quote,path)=>{
   const variable=`__reviewAsset${imports.length}`;imports.push(`import ${variable} from ${JSON.stringify(path)};`);return variable;
  });
  return {contents:imports.join('\n')+'\n'+contents,loader:args.path.endsWith('x')?'jsx':'js',resolveDir:dirname(args.path)};
 });
}};
const bundle=await build({absWorkingDir:platform,entryPoints:['arena/darts/review-harness.jsx'],outfile:join(tmp,'bundle.js'),bundle:true,format:'esm',jsx:'automatic',sourcemap:false,metafile:true,assetNames:'assets/[name]-[hash]',publicPath:'/',loader:{'.png':'file','.webp':'file','.jpg':'file','.jpeg':'file','.svg':'file'},external:['/arena/assets/*'],plugins:[assetURLPlugin]});
const files=new Map(Object.keys(bundle.metafile.outputs).map(path=>{const full=resolve(platform,path);return['/'+relative(tmp,full).split(sep).join('/'),full];}));
const mime={'.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml'};
const html='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{margin:0;background:#041221}button{touch-action:manipulation}</style><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script>';
const assetResponses=[];
const server=createServer(async(req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
  let file=files.get(pathname);
  if(!file&&pathname.startsWith('/arena/assets/')){
   const publicRoot=join(platform,'arena/public/assets');
   const candidate=resolve(publicRoot,pathname.slice('/arena/assets/'.length));
   if(candidate.startsWith(publicRoot+sep)&&mime[extname(candidate)])file=candidate;
  }
  if(file){res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.end(await readFile(file));return;}
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  res.statusCode=404;res.end('Not found');
 }catch(error){res.statusCode=error.code==='ENOENT'?404:500;res.end('Review resource unavailable');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[],errors=[],failedRequests=[];
async function readyAssets(page,selector){
 await page.locator(selector).waitFor();
 // Decode actual CSS image URLs before screenshots: a 200 response alone is not a drawn image.
 const decoded=await page.evaluate(async()=>{
  const urls=new Set();
  for(const node of document.querySelectorAll('*'))for(const match of getComputedStyle(node).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g))urls.add(new URL(match[1],location.href).href);
  await Promise.all([...urls].map(url=>new Promise((ok,bad)=>{const image=new Image();image.onload=()=>image.decode().then(ok,bad);image.onerror=()=>bad(Error('Image failed: '+url));image.src=url;})));
  return [...urls].map(url=>new URL(url).pathname);
 });
 assert(decoded.length>=2,'environment and portrait assets are decoded');
 await page.waitForTimeout(100);return decoded;
}
async function drag(page,x,finalY){
 await page.mouse.move(x,finalY+30);await page.mouse.down();
 for(let i=1;i<=6;i++){await page.waitForTimeout(65);await page.mouse.move(x,finalY+30-i*5);}
 await page.mouse.up();
}
async function settledDart(page,event){
 assert.equal(event.busyUntil-event.at,650,'the real engine flight contract is 650 ms');
 const landed=page.getByTestId('darts-landed');await landed.waitFor({state:'attached',timeout:1800});
 await page.getByTestId('darts-flight').waitFor({state:'detached',timeout:1800});
 assert.equal(Number(await landed.getAttribute('data-hit-x')),event.hit.x);
 assert.equal(Number(await landed.getAttribute('data-hit-y')),event.hit.y);
 assert.equal(await page.locator('.da-hit-marker').count(),1);
 await page.waitForTimeout(100);
}
try{
 for(const width of [390,360]){
  const page=await browser.newPage({viewport:{width,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('requestfailed',request=>failedRequests.push({url:request.url(),failure:request.failure()?.errorText}));
  page.on('response',response=>{if(/\.(png|webp|jpe?g|svg)(?:\?|$)/.test(response.url()))assetResponses.push({path:new URL(response.url()).pathname,status:response.status(),mime:response.headers()['content-type']});});
  await page.goto(base+'/?game=darts');const dartAssets=await readyAssets(page,'.da-board');
  await page.screenshot({path:join(out,`darts-${width}-before.png`)});
  const box=await page.locator('.da-board').boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
  await drag(page,x,y);await page.waitForFunction(()=>window.review.actions.length===1);
  const shot=await page.evaluate(()=>window.review.actions[0]);
  assert.equal(shot.action.type,'throw');assert.ok(shot.action.gesture.length>=3);assert.ok(shot.event.hit.score>=0);
  await settledDart(page,shot.event);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(out,`darts-${width}-hit.png`)});
  assert.ok((await page.evaluate(()=>window.review.sounds)).includes('shot'));
  await drag(page,x,y-.585*box.width/2.5);await page.waitForFunction(()=>window.review.actions.length===2);
  const triple=await page.evaluate(()=>window.review.actions[1]);
  const flight=page.getByTestId('darts-flight');await flight.waitFor({state:'attached',timeout:600});
  assert.equal(await flight.count(),1);assert.equal(await flight.locator('.da-metal-dart').count(),1);
  assert.equal(Number(await flight.getAttribute('data-hit-x')),triple.event.hit.x);assert.equal(Number(await flight.getAttribute('data-hit-y')),triple.event.hit.y);
  await page.screenshot({path:join(out,`darts-${width}-flight.png`)});
  await settledDart(page,triple.event);
  assert.equal(triple.event.hit.label,'T20');assert.match(await page.locator('.da-score-flash').textContent(),/TRIPLE 20/);
  await page.screenshot({path:join(out,`darts-${width}-triple20.png`)});
  results.push({game:'darts',width,gestureSamples:shot.action.gesture.length,durationMs:shot.event.hit.durationMs,serverHit:shot.event.hit.label,remaining:shot.event.remaining,impactVisible:true,horizontalOverflow:false,secondPointerHit:triple.event.hit.label,tripleLabelCorrect:true,flightAnimationObserved:true,flightMs:triple.event.busyUntil-triple.event.at,flightEndpointMatchesAuthority:true,decodedAssets:dartAssets});
  for(const n of [2,4]){
   await page.goto(base+`/?game=domino&n=${n}`);const dominoAssets=await readyAssets(page,'.do-chain');await page.waitForTimeout(650);
   await page.screenshot({path:join(domout,`domino-${width}-${n}p-before.png`)});
   const initial=await page.evaluate(()=>window.review.view()),move=initial.game.legalMoves[0];assert.ok(move,'initial actor can play');
   await page.getByTestId(`domino-tile-${move.tileId}`).click();assert.equal(await page.getByTestId(`domino-${move.end}`).isEnabled(),true);await page.getByTestId(`domino-${move.end}`).click();
   await page.waitForFunction(()=>window.review.actions.length===1);
   assert.equal(await page.locator('.do-tile-land').count(),1);
   // The restored tile travels from the real hand first; the old immediate do-land
   // animation is intentionally deferred until the 560 ms flight layer is removed.
   assert.equal(await page.locator('.do-flight-tile:not(.is-draw)').count(),1);
   assert.ok(await page.evaluate(()=>document.getAnimations().some(a=>a.animationName==='do-hand-flight'&&a.playState==='running')));
   await page.screenshot({path:join(domout,`domino-${width}-${n}p-moving.png`)});
   await page.locator('.do-flight-tile').waitFor({state:'detached',timeout:1500});
   assert.ok(await page.evaluate(()=>document.getAnimations().some(a=>a.animationName==='do-land'&&a.playState==='running')),'real placement animation follows hand-to-chain flight');
   const after=await page.evaluate(()=>window.review.view());
   assert.equal(after.game.hand.length,initial.game.hand.length-1);assert.equal(after.game.chain.length,initial.game.chain.length+1);assert.equal(await page.locator(`.do-chain [data-tile="${move.tileId}"]`).count(),1);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.waitForTimeout(450);await page.screenshot({path:join(domout,`domino-${width}-${n}p-play.png`)});
   await page.evaluate(()=>window.review.bot());await page.waitForTimeout(100);const peer=await page.evaluate(()=>window.review.view().game.lastEvent);
   assert.ok(peer.id>after.game.lastEvent.id);assert.notEqual(peer.playerKey,initial.game.turnKey);assert.equal(await page.locator('.do-toast').count(),1);
   results.push({game:'domino',width,players:n,action:move,handBefore:initial.game.hand.length,handAfter:after.game.hand.length,chainAfter:after.game.chain.length,horizontalOverflow:false,placementAnimationRunning:true,handToChainFlightObserved:true,peerEventViaView:peer.type,peerEventId:peer.id,decodedAssets:dominoAssets});
  }
  await page.goto(base+'/?game=domino');await readyAssets(page,'.do-chain');await page.evaluate(()=>window.review.drawFixture());
  await page.getByTestId('domino-draw').click();await page.waitForFunction(()=>window.review.actions.length===1);
  const draw=await page.evaluate(()=>window.review.view());assert.equal(draw.game.hand.length,3);assert.equal(draw.game.stockCount,1);assert.equal(draw.game.lastEvent.count,2);
  await page.locator('.do-flight-tile').waitFor({state:'detached',timeout:1500});await page.screenshot({path:join(domout,`domino-${width}-draw.png`)});
  await page.evaluate(()=>window.review.longFixture());await page.waitForTimeout(200);assert.equal(await page.locator('.do-chain [data-tile]').count(),28);
  const chain=await page.evaluate(()=>window.review.view().game.chain);assert.ok(chain.slice(1).every((t,i)=>chain[i].right===t.left));
  await page.screenshot({path:join(domout,`domino-${width}-long-chain.png`)});
  results.push({game:'domino',width,drawStopsAtFirstPlayable:true,drawn:2,remainingStock:1,longChainUnique:28,longChainAllLinksMatch:true});
  await page.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(failedRequests,[]);assert(assetResponses.length>0);assert(assetResponses.every(asset=>asset.status===200&&asset.mime?.startsWith('image/')),'every actual image request succeeds with an image MIME type');
 const report={time:new Date().toISOString(),runtime:'Chromium desktop mobile viewport emulation; actual pointer events + actual engine; isolated loopback HTTP esbuild harness with static image URL bundling',network:'No production server, coins, partner wallet or physical device involved',results,errors,failedRequests,assetResponses};
 await writeFile(join(out,'ui-validation.json'),JSON.stringify(report,null,2));await writeFile(join(domout,'ui-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));await rm(tmp,{recursive:true,force:true});}
