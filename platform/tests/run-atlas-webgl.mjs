/** Explicit browser smoke for the atlas shader; run with `node tests/run-atlas-webgl.mjs`. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root=new URL('../',import.meta.url).pathname;
const source=`
 import * as T from 'three';
 import {createIllustratedRunner} from './arena/run/atlas-characters.mjs';
 const renderer=new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
 renderer.setPixelRatio(1);renderer.setSize(128,128);document.body.append(renderer.domElement);
 const scene=new T.Scene();scene.background=new T.Color(0x000000);
 const camera=new T.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.set(0,.8,5);camera.lookAt(0,.8,0);
 const runner=createIllustratedRunner('fox');await runner.ready;scene.add(runner.root);
 const gl=renderer.getContext();
 window.sampleAtlas=phase=>{
  runner.pose('run',phase/8);renderer.render(scene,camera);
  const rgba=new Uint8Array(4);gl.readPixels(64,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
  return {rgba:[...rgba],blend:runner.root.userData.frameBlend,frame:runner.root.userData.frame,calls:renderer.info.render.calls};
 };
 window.atlasReady=true;
`;
const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'run-atlas-webgl-entry.mjs'},bundle:true,write:false,outdir:'/virtual-atlas-webgl',format:'esm',logLevel:'silent',plugins:[{name:'synthetic-atlas',setup(b){
 b.onResolve({filter:/\?url$/},a=>({path:a.path,namespace:'atlas-url'}));
 b.onLoad({filter:/.*/,namespace:'atlas-url'},a=>({contents:`export default ${JSON.stringify(a.path)}`,loader:'js'}));
 b.onResolve({filter:/asset-loading\.mjs$/},a=>({path:a.path,namespace:'atlas-loader'}));
 b.onLoad({filter:/.*/,namespace:'atlas-loader'},()=>({contents:`
  import {CanvasTexture} from 'three';
  export const createRunSourceCache=load=>load;
  export const prepareRunAssets=tasks=>Promise.all(tasks.map(task=>task({})));
  export async function loadRunTexture(url){
   const run=url.includes('run-'),canvas=document.createElement('canvas');canvas.width=256;canvas.height=run?128:256;
   const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);
   if(run){for(let i=0;i<8;i++){ctx.fillStyle=i===0?'#2020ff':i===7?'#ff2020':'#20ff20';ctx.fillRect((i%4)*64,Math.floor(i/4)*64,64,64);}}
   return new CanvasTexture(canvas);
  }
 `,loader:'js',resolveDir:root}));
}}]});
const js=bundle.outputFiles[0].contents;
const server=createServer((req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');res.end(js);return;}
 res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script type="module" src="/bundle.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{}),args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 for(const mode of ['1','0']){
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/?runAtlasBlend=${mode}`);
  await page.waitForFunction(()=>window.atlasReady===true,{timeout:10000});
  const [last,middle,next]=await page.evaluate(()=>[sampleAtlas(7),sampleAtlas(7.75),sampleAtlas(8)]);
  assert.deepEqual(errors,[],'browser shader must compile without errors');
  assert.equal(last.frame,7);assert.equal(middle.frame,7);assert.equal(next.frame,0);
  assert.ok(last.rgba[0]>180&&last.rgba[2]<80,`frame 7 is red: ${last.rgba}`);
  assert.ok(next.rgba[2]>180&&next.rgba[0]<80,`wrapped frame 0 is blue: ${next.rgba}`);
  if(mode==='1'){
   assert.ok(middle.blend>.3&&middle.blend<.6);
   assert.ok(middle.rgba[0]<last.rgba[0]-40&&middle.rgba[2]>last.rgba[2]+40,`7→0 crossfade is visible: ${middle.rgba}`);
  }else{
   assert.equal(middle.blend,0);
   assert.deepEqual(middle.rgba,last.rgba,'fallback keeps frame 7 until wrap');
  }
  assert.equal(middle.calls,last.calls,'crossfade uses the same draw calls');
  console.log(JSON.stringify({mode,last,middle,next,errors}));
  await page.close();
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
