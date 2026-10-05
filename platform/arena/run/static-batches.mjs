import * as T from 'three';

export const RUN_SCENERY_CHUNK_METRES=24;
/** Keep original GLB mesh/material data, batch repeated cosmetics by spatial cell. */
export function batchRunScenery(kit,placements,resources){
 const chunks=new Map(),unbatched=[],instanceMatrix=new T.Matrix4();
 const clone=name=>{const root=kit.clone(name);return resources?resources.ownTree(root):root;};
 for(const p of placements){
  // These distant buildings were already permanently hidden by scene visibility.
  if(p.name==='Palace')continue;
  // Near palms and rocks keep their original per-placement visibility range.
  // Batching them by a large cell makes hidden high-detail trees render early.
  if(p.name!=='BridgeSupport'){
   const source=clone(p.name);source.position.set(p.x,p.y,-p.z);source.scale.setScalar(p.size);source.rotation.y=p.rotation||0;
   unbatched.push({root:source,z:p.z,prefab:p.name});continue;
  }
  const cell=Math.floor(p.z/RUN_SCENERY_CHUNK_METRES),key=p.name+':'+cell;
  let chunk=chunks.get(key);
  if(!chunk){chunk={root:new T.Group(),z:(cell+.5)*RUN_SCENERY_CHUNK_METRES,span:RUN_SCENERY_CHUNK_METRES/2,prefab:p.name,parts:new Map()};chunks.set(key,chunk);}
  const source=clone(p.name);source.position.set(p.x,p.y,-p.z);source.scale.setScalar(p.size);source.rotation.y=p.rotation||0;source.updateMatrixWorld(true);
  source.traverse(mesh=>{
   if(!mesh.isMesh)return;
   const id=mesh.geometry.uuid+':'+(Array.isArray(mesh.material)?mesh.material.map(m=>m.uuid).join(','):mesh.material.uuid);
   let part=chunk.parts.get(id);
   if(!part){part={geometry:mesh.geometry,material:mesh.material,matrices:[],castShadow:mesh.castShadow,receiveShadow:mesh.receiveShadow};chunk.parts.set(id,part);}
   part.matrices.push(mesh.matrixWorld.clone());
  });
 }
 return [...chunks.values()].map(chunk=>{
  for(const part of chunk.parts.values()){
   const mesh=new T.InstancedMesh(part.geometry,part.material,part.matrices.length);
   part.matrices.forEach((matrix,i)=>mesh.setMatrixAt(i,instanceMatrix.copy(matrix)));
   mesh.castShadow=part.castShadow;mesh.receiveShadow=part.receiveShadow;
   mesh.computeBoundingBox();mesh.computeBoundingSphere();chunk.root.add(mesh);
  }
  delete chunk.parts;return chunk;
 }).concat(unbatched);
}
