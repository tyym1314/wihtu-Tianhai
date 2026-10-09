import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Vector2} from 'three';
import {createVisualCaptureCadence} from '../render-cadence.mjs';
import {CachedBowlingBloomPass} from '../cached-bloom.mjs';

test('capture policy retains 60Hz scene motion while bounding secondary captures',()=>{
 const policy=createVisualCaptureCadence(),pose=[0,2,3.8,0,0,0,1,48];
 const captures=Array.from({length:60},(_,i)=>policy.shouldCapture(i*1000/60,{active:true,pose})).filter(Boolean).length;
 assert.equal(captures,30);
 const idle=createVisualCaptureCadence();
 assert.equal(Array.from({length:60},(_,i)=>idle.shouldCapture(i*1000/60,{pose})).filter(Boolean).length,8);
});
test('first frame, camera cut, resize, resume and clock rewind immediately refresh',()=>{
 const policy=createVisualCaptureCadence(),pose=[0,2,3.8,0,0,0,1,48];
 assert.equal(policy.shouldCapture(100,{pose}),true);
 assert.equal(policy.shouldCapture(116,{pose}),false);
 assert.equal(policy.shouldCapture(117,{pose:[1,...pose.slice(1)]}),true);
 policy.invalidate();assert.equal(policy.shouldCapture(118,{pose}),true);
 assert.equal(policy.shouldCapture(0,{pose}),true);
});
test('cached HDR bloom blends onto current scene without clearing it or rerunning mip chain',()=>{
 const bloom=new CachedBowlingBloomPass(new Vector2(128,192),.045,.48,.65);
 const target={texture:{}},calls=[];
 bloom.cacheReady=true;bloom.capture=false;
 const renderer={autoClear:true,setRenderTarget:t=>calls.push(['target',t])};
 bloom._fsQuad.render=r=>{assert.equal(r.autoClear,false);calls.push(['quad',bloom._fsQuad.material]);};
 bloom.render(renderer,{},target,1/60,false);
 assert.equal(renderer.autoClear,true);
 assert.deepEqual(calls,[['target',target],['quad',bloom.blendMaterial]]);
 assert.equal(bloom.copyUniforms.tDiffuse.value,bloom.renderTargetsHorizontal[0].texture);
 assert.equal(bloom.captureCount,0);assert.equal(bloom.nMips,5);
 bloom.setSize(128,192);assert.equal(bloom.cacheReady,false);
 bloom.dispose();
});
function jsonGLB(bytes){assert.equal(bytes.readUInt32LE(0),0x46546c67);return JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());}
function triangles(gltf){return gltf.meshes.flatMap(mesh=>mesh.primitives).reduce((n,p)=>n+gltf.accessors[p.indices].count/3,0);}
const base=new URL('../assets/',import.meta.url);
test('derived mobile GLBs preserve colored neck bands and bored ball materials without embedded PNG',async()=>{
 const report=JSON.parse(await readFile(new URL('mobile-lod-report.json',base)));
 for(const entry of report.assets){
  const bytes=await readFile(new URL('models/'+entry.output,base)),gltf=jsonGLB(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
  assert.equal(bytes.length,entry.bytes);assert.equal(triangles(gltf),entry.triangles);
  assert.ok(gltf.extensionsRequired.includes('KHR_draco_mesh_compression'));
  for(const sample of Object.values(entry.sampled_surface_distance_m)){
   assert.ok(sample.samples>5000);assert.ok(sample.max_m<.001,'Visual LOD sampled deviation stays under 1 mm');
  }
  const source=await readFile(new URL('source/'+entry.source,base));
  assert.equal(createHash('sha256').update(source).digest('hex'),entry.source_sha256);
  if(entry.output.includes('pin')){
   assert.equal(entry.material_triangles['Competition red enamel'],256);
   assert.ok(gltf.materials.some(m=>/enamel/i.test(m.name)));
   assert.ok(entry.triangles<3000);
  }else{
   assert.equal(gltf.images?.length||0,0);assert.equal(gltf.textures?.length||0,0);
   assert.ok(gltf.meshes.flatMap(mesh=>mesh.primitives).every(p=>Number.isInteger(p.attributes.TEXCOORD_0)),
    'Removing the embedded PNG must preserve UVs for the actual external resin map');
   assert.ok(gltf.materials.some(m=>/bore/i.test(m.name)));
   assert.ok(entry.material_triangles['Recessed finger bore charcoal']>200);
  }
 }
 const originalPin=jsonGLB(await readFile(new URL('models/neon-competition-pin.glb',base)));
 const originalBall=jsonGLB(await readFile(new URL('models/neon-pearl-ball.glb',base)));
 assert.equal(triangles(originalPin),8960);assert.equal(triangles(originalBall),9626);
});
