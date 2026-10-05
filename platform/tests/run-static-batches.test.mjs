import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {batchRunScenery} from '../arena/run/static-batches.mjs';

test('bridge batches preserve original geometry, materials and every transformed placement',()=>{
 const geometry=new T.BoxGeometry(),material=new T.MeshStandardMaterial(),source=new T.Group();
 const beam=new T.Mesh(geometry,material);beam.position.set(1,.5,2);beam.rotation.y=.3;source.add(beam);
 const kit={clone:()=>source.clone(true)};
 const placements=[0,6,12,30].map((z,i)=>({name:'BridgeSupport',x:i%2,y:-.25,z,size:.8+i*.1,rotation:i*.2}));
 const batches=batchRunScenery(kit,placements);
 assert.equal(batches.length,2,'Only nearby repeated supports share an instance batch');
 const actual=[];for(const batch of batches)for(const mesh of batch.root.children){
  assert.equal(mesh.geometry,geometry);assert.equal(mesh.material,material);
  assert.ok(mesh.boundingSphere.radius>0);
  for(let i=0;i<mesh.count;i++){const matrix=new T.Matrix4();mesh.getMatrixAt(i,matrix);actual.push(matrix.elements);}
 }
 assert.equal(actual.length,placements.length);
 placements.forEach((p,i)=>{
  const expected=kit.clone();expected.position.set(p.x,p.y,-p.z);expected.scale.setScalar(p.size);expected.rotation.y=p.rotation;expected.updateMatrixWorld(true);
  assert.ok(actual[i].every((v,j)=>Math.abs(v-expected.children[0].matrixWorld.elements[j])<.00001));
 });
 geometry.dispose();material.dispose();
});
test('near scenery retains its individual visibility distance without widening its range',()=>{
 const batches=batchRunScenery({clone:()=>new T.Group()},[{name:'Palm',x:6,y:0,z:4,size:1},{name:'RockBank',x:-6,y:0,z:58,size:1}]);
 assert.deepEqual(batches.map(({z,span,prefab})=>({z,span,prefab})),[{z:4,span:undefined,prefab:'Palm'},{z:58,span:undefined,prefab:'RockBank'}]);
});
