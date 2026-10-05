import test from 'node:test';import assert from 'node:assert/strict';import * as T from 'three';
import {createRunSceneResources} from '../arena/run/scene-resources.mjs';
import {batchRunScenery} from '../arena/run/static-batches.mjs';
test('scene leases share clones within a scene but never share GPU objects with cached source or another scene',()=>{
 const texture=new T.Texture({width:2,height:2}),geometry=new T.BoxGeometry(),material=new T.MeshStandardMaterial({map:texture,normalMap:texture}),root=new T.Group();root.add(new T.Mesh(geometry,material));const kit={clone:()=>root.clone(true)},placements=[0,6,30].map(z=>({name:'BridgeSupport',x:0,y:0,z,size:1}));
 const a=createRunSceneResources(),b=createRunSceneResources(),first=batchRunScenery(kit,placements,a),second=batchRunScenery(kit,placements,b),mesh=first[0].root.children[0],other=second[0].root.children[0];
 assert.notEqual(mesh.geometry,geometry);assert.notEqual(mesh.material,material);assert.notEqual(mesh.material.map,texture);assert.equal(mesh.material.map.image,texture.image);assert.equal(mesh.material.map,mesh.material.normalMap);assert.equal(mesh.geometry,first[1].root.children[0].geometry);assert.notEqual(mesh.geometry,other.geometry);assert.notEqual(mesh.material.map,other.material.map);
 let count=0;for(const item of [mesh.geometry,mesh.material,mesh.material.map])item.addEventListener('dispose',()=>count++);a.dispose();a.dispose();assert.equal(count,3);assert.deepEqual(a.counts(),{geometries:0,materials:0,textures:0,disposed:true});assert.equal(b.counts().geometries,1);assert.throws(()=>a.ownTree(kit.clone()));b.dispose();geometry.dispose();material.dispose();texture.dispose();
});
