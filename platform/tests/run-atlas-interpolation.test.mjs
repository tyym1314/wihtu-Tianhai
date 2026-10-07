import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundle=await build({
 entryPoints:[new URL('../arena/run/atlas-characters.mjs',import.meta.url).pathname],
 bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',
 plugins:[{name:'atlas-test-assets',setup(b){
  b.onResolve({filter:/\?url$/},a=>({path:a.path,namespace:'atlas-url'}));
  b.onLoad({filter:/.*/,namespace:'atlas-url'},a=>({contents:`export default ${JSON.stringify(a.path)}`,loader:'js'}));
  b.onResolve({filter:/asset-loading\.mjs$/},a=>({path:a.path,namespace:'atlas-loader'}));
  b.onLoad({filter:/.*/,namespace:'atlas-loader'},()=>({contents:`
   import {Texture} from 'three';
   export const createRunSourceCache=load=>load;
   export const prepareRunAssets=tasks=>Promise.all(tasks.map(task=>task({})));
   export async function loadRunTexture(){return new Texture({width:400,height:200});}
  `,loader:'js',resolveDir:new URL('../',import.meta.url).pathname}));
 }}]
});
const bundleUrl=`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`;

test('run atlas blends adjacent poses without adding a second sprite',async()=>{
 const {createIllustratedRunner,RUN_CYCLE_FRAMES}=await import(`${bundleUrl}#blend-on`);
 const runner=createIllustratedRunner('fox');await runner.ready;
 const sprite=runner.root.children.find(child=>child.isSprite);
 assert.equal(runner.root.children.filter(child=>child.isSprite).length,1);
 assert.equal(runner.root.userData.frameBlendEnabled,true);
 assert.equal(RUN_CYCLE_FRAMES,8);
 const shader={uniforms:{},fragmentShader:'#include <map_pars_fragment>\nvoid main(){#include <map_fragment>}' };
 sprite.material.onBeforeCompile(shader);
 assert.match(shader.fragmentShader,/if \(runFrameBlend > 0\.0\)/);
 assert.match(shader.fragmentShader,/texture2D\(map, vMapUv \+ runNextUvDelta\)/);
 const seen=new Set();let blendedSamples=0;
 for(let i=0;i<60;i++){
  runner.pose('run',i/60*8/4.4);
  seen.add(runner.root.userData.frame);
  if(runner.root.userData.frameBlend>.05&&runner.root.userData.frameBlend<.95)blendedSamples++;
 }
 assert.equal(seen.size,8);
 assert.ok(blendedSamples>=10,`60 Hz motion should include visible intermediate samples; got ${blendedSamples}`);
 runner.pose('run',(7+.75)/8);
 assert.equal(runner.root.userData.frame,7);
 assert.ok(runner.root.userData.frameBlend>.4);
 assert.deepEqual(shader.uniforms.runNextUvDelta.value.toArray(),[-.75,.5]);
 runner.pose('run',1);
 assert.equal(runner.root.userData.frame,0);
 assert.equal(runner.root.userData.frameBlend,0);
 runner.pose('jump',.3);
 assert.equal(runner.root.userData.frameBlend,0);
 runner.dispose();
});

test('URL fallback restores the original one-sample sprite shader',async()=>{
 globalThis.window={location:{search:'?runAtlasBlend=0'}};
 try{
  const {createIllustratedRunner}=await import(`${bundleUrl}#blend-off`);
  const runner=createIllustratedRunner('fox');await runner.ready;
  runner.pose('run',.09);
  assert.equal(runner.root.userData.frameBlendEnabled,false);
  assert.equal(runner.root.userData.frameBlend,0);
  const sprite=runner.root.children.find(child=>child.isSprite);
  assert.doesNotMatch(sprite.material.onBeforeCompile.toString(),/runFrameBlend/);
  runner.dispose();
 }finally{delete globalThis.window;}
});
