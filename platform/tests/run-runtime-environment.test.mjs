import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';

const assets=new URL('../arena/run/assets/environment/',import.meta.url);
const source=readFileSync(new URL('oasis-kit.glb',assets));
const runtime=readFileSync(new URL('oasis-kit-runtime-v1.glb',assets));
const manifest=JSON.parse(readFileSync(new URL('oasis-kit-runtime-v1.json',assets)));
const script=fileURLToPath(new URL('../arena/run/assets/source/prune_environment.py',import.meta.url));
const retained=['Palm','RockBank','BridgeSupport','FinishGate'];
const sha=data=>createHash('sha256').update(data).digest('hex');
function parse(bytes){
 assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
 const n=bytes.readUInt32LE(12);assert.equal(bytes.readUInt32LE(16),0x4e4f534a);
 const end=20+n;assert.equal(bytes.readUInt32LE(end+4),0x004e4942);assert.equal(end+8+bytes.readUInt32LE(end),bytes.length);
 return{doc:JSON.parse(bytes.subarray(20,end)),bin:bytes.subarray(end+8)};
}
function encode({doc,bin}){
 let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
 bin=Buffer.concat([bin,Buffer.alloc((4-bin.length%4)%4)]);
 const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const binaryHeader=Buffer.alloc(8);binaryHeader.writeUInt32LE(bin.length,0);binaryHeader.writeUInt32LE(0x004e4942,4);
 return Buffer.concat([header,json,binaryHeader,bin]);
}
// Independent semantic expansion: references become their complete value and
// each buffer view's original bytes, so changed indices/offsets cannot hide loss.
function semantic({doc,bin},root){
 const accessor=i=>{const {bufferView,...value}=doc.accessors[i],{buffer,byteOffset=0,...layout}=doc.bufferViews[bufferView];assert.equal(buffer,0);return{...value,view:{...layout,bytes:bin.subarray(byteOffset,byteOffset+layout.byteLength).toString('hex')}};};
 const mesh=i=>{const {primitives,...value}=doc.meshes[i];return{...value,primitives:primitives.map(({attributes,indices,material,...p})=>({...p,attributes:Object.fromEntries(Object.entries(attributes).map(([key,ref])=>[key,accessor(ref)])),indices:accessor(indices),material:doc.materials[material]}))};};
 const node=i=>{const {mesh:meshId,children,...value}=doc.nodes[i];return{...value,...(meshId===undefined?{}:{mesh:mesh(meshId)}),...(children?{children:children.map(node)}:{})};};
 return node(doc.scenes[doc.scene??0].nodes.find(i=>doc.nodes[i].name===root));
}
function runPruner(bytes){return spawnSync('python3',['-B','-c','import runpy,sys; helper=runpy.run_path(sys.argv[1]); sys.stdout.buffer.write(helper["prune_environment"](sys.stdin.buffer.read()))',script],{input:bytes,maxBuffer:4*1024*1024});}

test('Runtime GLB is exactly reproducible and its manifest binds the preserved source',()=>{
 assert.equal(sha(source),'611065e6fa1a1174c6a5095e997383fe7f467bc0c33273ed33aecde5b3cd90f0');
 assert.equal(manifest.source_sha256,sha(source));assert.equal(manifest.source_bytes,source.length);
 assert.equal(manifest.sha256,sha(runtime));assert.equal(manifest.bytes,runtime.length);
 assert.deepEqual(manifest.prefabs,retained);assert.deepEqual(manifest.omitted_prefabs,['Palace']);
 const regenerated=runPruner(source);assert.equal(regenerated.status,0,regenerated.stderr.toString());assert.deepEqual(regenerated.stdout,runtime);
 assert.equal(source.length-runtime.length,410848);
});

test('Only the four used root trees remain, with every buffer byte, transform and material unchanged',()=>{
 const a=parse(source),b=parse(runtime);
 assert.deepEqual(b.doc.scenes[0].nodes.map(i=>b.doc.nodes[i].name),retained);
 assert.equal(b.doc.nodes.length,17);assert.equal(b.doc.meshes.length,13);
 for(const name of retained)assert.deepEqual(semantic(b,name),semantic(a,name),name);
 assert.equal(b.doc.nodes.some(n=>n.name.startsWith('Palace')),false);
 assert.equal(a.doc.buffers[0].byteLength-b.doc.buffers[0].byteLength,405768);
 const environment=readFileSync(new URL('../arena/run/environment.mjs',import.meta.url),'utf8');assert.match(environment,/import kitUrl from '\.\/assets\/environment\/oasis-kit-runtime-v1\.glb\?url'/);
});

test('Actual GLTFLoader reconstructs identical retained prefab meshes and transforms',async()=>{
 const load=bytes=>new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const [before,after]=await Promise.all([load(source),load(runtime)]);
 const snapshot=root=>{const rows=[];root.updateMatrixWorld(true);root.traverse(o=>{const row={name:o.name,type:o.type,matrix:o.matrix.elements,matrixWorld:o.matrixWorld.elements};if(o.isMesh){row.attributes=Object.fromEntries(Object.entries(o.geometry.attributes).map(([k,a])=>[k,{itemSize:a.itemSize,normalized:a.normalized,array:Array.from(a.array)}]));row.index=Array.from(o.geometry.index.array);const materials=Array.isArray(o.material)?o.material:[o.material];row.materials=materials.map(m=>({name:m.name,type:m.type,side:m.side,color:m.color.toArray(),metalness:m.metalness,roughness:m.roughness,opacity:m.opacity,transparent:m.transparent,alphaTest:m.alphaTest}));}rows.push(row);});return rows;};
 try{for(const name of retained)assert.deepEqual(snapshot(after.scene.getObjectByName(name)),snapshot(before.scene.getObjectByName(name)),name);assert.equal(after.scene.getObjectByName('Palace'),undefined);}
 finally{for(const gltf of[before,after])gltf.scene.traverse(o=>{o.geometry?.dispose();for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[])m.dispose();});}
});

for(const [label,mutate,error]of[
 ['external buffer',d=>{d.buffers[0].uri='elsewhere.bin';},'Unsupported buffer fields'],
 ['extension references',d=>{d.extensionsUsed=['KHR_draco_mesh_compression'];},'Unsupported document fields'],
 ['material texture',d=>{d.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};},'Unsupported material PBR fields'],
 ['unexpected root',d=>{d.nodes[d.scenes[0].nodes[0]].name='Replacement';},'Unexpected prefab roots'],
 ['duplicate child ownership',d=>{d.nodes[d.scenes[0].nodes[1]].children.push(d.nodes[d.scenes[0].nodes[0]].children[0]);},'Cyclic or multiply owned node'],
 ['accessor outside buffer',d=>{d.accessors[0].count=999999999;},'Accessor exceeds buffer view'],
 ['buffer view outside BIN',d=>{d.bufferViews[0].byteOffset=d.buffers[0].byteLength;},'Invalid buffer view bounds'],
 ['dangling child',d=>{d.nodes[d.scenes[0].nodes[0]].children.push(9999);},'Invalid child node'],
 ['morph targets',d=>{d.meshes[0].primitives[0].targets=[{POSITION:0}];},'Unsupported primitive fields'],
])test(`Pruner refuses ${label} instead of dropping unrecognized source semantics`,()=>{
 const value=parse(source);mutate(value.doc);const result=runPruner(encode(value));assert.notEqual(result.status,0);assert.match(result.stderr.toString(),new RegExp(error));assert.equal(result.stdout.length,0);
});

test('Writer rejects overwriting the editable source before any write',()=>{
 const path=fileURLToPath(new URL('oasis-kit.glb',assets));
 const result=spawnSync('python3',['-B','-c','import runpy,sys; runpy.run_path(sys.argv[1])["write_runtime_assets"](sys.argv[2],sys.argv[2])',script,path],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Runtime output must not overwrite source/);assert.deepEqual(readFileSync(path),source);
});
