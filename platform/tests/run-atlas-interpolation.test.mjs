import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundleOptions={
 entryPoints:[new URL('../arena/run/atlas-characters.mjs',import.meta.url).pathname],
 bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',
 plugins:[{name:'atlas-test-assets',setup(b){
  b.onResolve({filter:/GLTFLoader\.js$/},a=>({path:a.path,namespace:'rig-loader'}));
  b.onLoad({filter:/.*/,namespace:'rig-loader'},()=>({contents:`import {Group,AnimationClip} from 'three';export class GLTFLoader{async loadAsync(){return{scene:new Group(),animations:['idle','run','jump','land','slide','hit','fall','recover','finish','celebrate'].map(name=>new AnimationClip(name,1,[]))};}}`,loader:'js',resolveDir:new URL('../',import.meta.url).pathname}));
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
};
const bundle=await build(bundleOptions);
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

const authority=extra=>({distance:8,visualDistance:8,visualHeight:0,finishTick:null,fallStartTick:null,fallUntilTick:null,stunUntilTick:0,slideUntilTick:0,jumpStartTick:null,speed:8,shieldUntilTick:0,...extra});
test('predicted animation selects one pose per frame without flipping between run and action textures',async()=>{
 const {createIllustratedRunner}=await import(`${bundleUrl}#single-predicted-pose`),runner=createIllustratedRunner('fox');await runner.ready;
 const sprite=runner.root.children.find(child=>child.isSprite),textures=runner.gpuTextures();let map=sprite.material.map,mapWrites=0,clip=runner.root.userData.clip,poseWrites=0;
 Object.defineProperty(sprite.material,'map',{configurable:true,get:()=>map,set:value=>{mapWrites++;map=value;}});
 Object.defineProperty(runner.root.userData,'clip',{configurable:true,get:()=>clip,set:value=>{poseWrites++;clip=value;}});
 const p=Object.freeze(authority({visualHeight:.7,visualAction:Object.freeze({type:'jump',elapsedMs:200})})),original=JSON.stringify(p);
 for(let i=0;i<60;i++)runner.animate(p,12+i/60,i/60);
 assert.equal(poseWrites,60,'each frame selects exactly one final pose');assert.equal(mapWrites,1,'action texture is selected once, not run→action every frame');assert.equal(clip,'jump');assert.equal(runner.root.userData.sheet,'action');assert.equal(runner.root.userData.clipTime,.2);assert.equal(JSON.stringify(p),original);
 assert.deepEqual(runner.gpuTextures(),textures);assert.ok(Math.abs(runner.root.userData.groundShadowHeight-.012)<1e-8);
 let disposed=0;for(const texture of textures)texture.addEventListener('dispose',()=>disposed++);runner.dispose();runner.dispose();assert.equal(disposed,textures.length);
});

test('finish, fall, stun and recovery have priority over render-only pose overrides',async()=>{
 const {createIllustratedRunner}=await import(`${bundleUrl}#prediction-priority`),visualAction={type:'jump',elapsedMs:100};
 for(const [fields,expected] of [[{finishTick:10},'finish'],[{fallStartTick:10,fallUntilTick:100},'fall'],[{stunUntilTick:60},'hit']]){
  const runner=createIllustratedRunner('fox');await runner.ready;runner.animate(authority({...fields,visualAction}),12,1);assert.equal(runner.root.userData.clip,expected);runner.dispose();
 }
 const runner=createIllustratedRunner('fox');await runner.ready;runner.animate(authority({fallStartTick:10,fallUntilTick:100}),12,1);runner.animate(authority({visualAction}),101,2);assert.equal(runner.root.userData.clip,'recover');runner.dispose();
});

test('lateral input with no vertical override retains the real jump and invalid overrides fall back to authority',async()=>{
 const {createIllustratedRunner}=await import(`${bundleUrl}#authority-jump`),runner=createIllustratedRunner('fox');await runner.ready;
 for(const visualAction of [null,{type:'unknown',elapsedMs:10},{type:'slide',elapsedMs:NaN},{type:'slide',elapsedMs:-1}]){
  runner.animate(authority({jumpStartTick:1,visualAction}),12,1);assert.equal(runner.root.userData.clip,'jump');assert.equal(runner.root.userData.clipTime,11/60);
 }
 runner.dispose();
});

test('recovery control time releases only stun animation while jump and shield retain causal time',async()=>{
 const {createIllustratedRunner}=await import(`${bundleUrl}#causal-recovery`),runner=createIllustratedRunner('fox');await runner.ready;
 runner.animate(authority({stunUntilTick:60,visualControlTick:59.99}),59.25,1);assert.equal(runner.root.userData.clip,'hit');
 runner.animate(authority({stunUntilTick:60,visualControlTick:60.25}),59.25,1);assert.equal(runner.root.userData.clip,'run');
 runner.animate(authority({stunUntilTick:60,visualControlTick:60.25,jumpStartTick:50,shieldUntilTick:60}),59.25,1);
 assert.equal(runner.root.userData.clip,'jump');assert.equal(runner.root.userData.clipTime,9.25/60);
 const shield=runner.root.children.find(child=>child.geometry?.type==='SphereGeometry');assert.ok(shield);assert.equal(shield.visible,true);
 runner.animate(authority({stunUntilTick:60,visualControlTick:61,jumpStartTick:50,shieldUntilTick:60}),60,1);assert.equal(shield.visible,false);
 runner.dispose();
});

test('rig compatibility selects one overridden mixer pose and still prioritizes authoritative injury',async()=>{
 const rigBundle=await build({...bundleOptions,entryPoints:[new URL('../arena/run/characters.mjs',import.meta.url).pathname]});
 const {createRigRunner}=await import(`data:text/javascript;base64,${Buffer.from(rigBundle.outputFiles[0].contents).toString('base64')}`),runner=createRigRunner('fox');await runner.ready;
 let clip=runner.root.userData.clip,poseWrites=0;Object.defineProperty(runner.root.userData,'clip',{configurable:true,get:()=>clip,set:value=>{poseWrites++;clip=value;}});
 const p=Object.freeze(authority({visualAction:Object.freeze({type:'slide',elapsedMs:200})}));for(let i=0;i<10;i++)runner.animate(p,12+i,i/60);
 assert.equal(poseWrites,10);assert.equal(clip,'slide');assert.equal(runner.root.userData.clipTime,.2);
 runner.animate(authority({stunUntilTick:80,visualAction:{type:'jump',elapsedMs:200}}),30,1);assert.equal(clip,'hit');runner.dispose();
});
