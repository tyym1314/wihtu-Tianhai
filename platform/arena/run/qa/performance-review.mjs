/** Isolated renderer diagnostics. Fixed open-path snapshots; no gameplay/device claim. */
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import * as E from '../engine.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const label=process.argv[2]||'current';
const useWebKit=process.env.RUN_PERF_BROWSER==='webkit';
const out=fileURLToPath(new URL('./performance-20260928/',import.meta.url));
const players=['fox','cat','bear','rabbit'].map((character,i)=>({key:'p'+i,name:character,character,seatIndex:i}));
const fixture=E.view(E.createState('02'.repeat(32),10000,{players}),'p0');
const source=`import {resolveRunCourse} from './arena/run/courses.mjs';
import {createRunScene} from './arena/run/scene.mjs';
window.samples=[];window.longTasks=[];window.errors=[];
if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(e=>({at:e.startTime,ms:e.duration})))).observe({type:'longtask',buffered:true});
const begin=performance.now(),base=${JSON.stringify(fixture)},scene=createRunScene(document.querySelector('#track'),{course:resolveRunCourse(base),onReady(){window.readyAt=performance.now();},onError(e){window.errors.push(String(e));}});
window.createdMs=performance.now()-begin;let tick=0;
function snapshot(){const now=performance.now(),g=structuredClone(base);g.snapshotTick=Math.floor((now-begin)*.06);for(const [i,p] of g.players.entries()){p.distance=5+(now-begin)*.008+i*1.6;p.lane=p.fromLane=i%3;p.changeEndTick=p.changeStartTick=0;}scene.update(g,'p0');}
snapshot();const timer=setInterval(snapshot,400);window.stop=()=>{clearInterval(timer);scene.dispose();};`;
const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'run-perf.js',loader:'js'},bundle:true,write:false,outdir:'/virtual-run-perf',format:'esm',minify:true,logLevel:'silent',loader:{'.glb':'file','.webp':'file'},plugins:[{name:'observe-only',setup(b){
 b.onResolve({filter:/\.(glb|webp)\?url$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4))}));
 b.onLoad({filter:/\/run\/scene\.mjs$/},async a=>{
  let source=await readFile(a.path,'utf8');
  source=source.replace('renderer.render(scene,camera);',`const renderStart=performance.now();renderer.render(scene,camera);if(window.samples.length<3000)window.samples.push({at:time,distance:cameraDistance,renderMs:performance.now()-renderStart,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,programs:renderer.info.programs.length});`);
  return{contents:source,loader:'js',resolveDir:dirname(a.path)};
 });
}}]});
const files=new Map(bundle.outputFiles.map(f=>['/'+basename(f.path),f.contents]));
const js=basename(bundle.outputFiles.find(f=>f.path.endsWith('.js')).path);
const server=createServer((req,res)=>{const pathname=new URL(req.url,'http://local').pathname;if(files.has(pathname)){res.setHeader('content-type',pathname.endsWith('.webp')?'image/webp':pathname.endsWith('.glb')?'model/gltf-binary':'text/javascript');res.end(files.get(pathname));return;}res.setHeader('content-type','text/html');res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#track{width:390px;height:844px}</style><div id="track"></div><script type="module" src="/${js}"></script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));await mkdir(out,{recursive:true});
const browser=await(useWebKit?webkit.launch({headless:true}):chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']}));
const metrics=a=>{const sorted=[...a].sort((a,b)=>a-b);return{n:a.length,p50:sorted[Math.floor(a.length*.5)],p95:sorted[Math.floor(a.length*.95)],max:sorted.at(-1)};};
try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3}),page=await context.newPage();
 if(!useWebKit){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});}
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>window.readyAt>0);await page.waitForTimeout(6500);
 const raw=await page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return{samples,longTasks,errors,createdMs,readyAt,gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null};});
 await page.screenshot({path:resolve(out,label+'.png')});
 const samples=raw.samples.filter(s=>s.at>raw.readyAt+500),intervals=samples.slice(1).map((s,i)=>s.at-samples[i].at),moving=samples.slice(1).filter((s,i)=>Math.abs(s.distance-samples[i].distance)<.00001);
 const result={label,program_count:metrics(samples.map(s=>s.programs)),scope:`Desktop ${useWebKit?'Playwright WebKit without CPU throttle':'Chrome Metal CPU4'}, 390x844 DPR3 mobile quality; fixed open-path snapshots every 400ms; no phone, gameplay or production acceptance. Long Tasks unavailable on WebKit.`,gpu:raw.gpu,created_ms:raw.createdMs,ready_at_ms:raw.readyAt,frame_ms:metrics(intervals),render_submit_ms:metrics(samples.map(s=>s.renderMs)),calls:metrics(samples.map(s=>s.calls)),triangles:metrics(samples.map(s=>s.triangles)),still_frames:moving.length,sampled_frames:samples.length,still_percent:100*moving.length/(samples.length-1),startup_long_tasks:raw.longTasks.filter(s=>s.at<raw.readyAt),errors:[...errors,...raw.errors]};
 await writeFile(resolve(out,label+'-raw.json'),JSON.stringify(raw,null,2));await writeFile(resolve(out,label+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 await page.evaluate(()=>window.stop());await context.close();
}finally{await browser.close();await new Promise(r=>server.close(r));}
