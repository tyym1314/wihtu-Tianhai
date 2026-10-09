"""Blender --background --factory-startup --disable-autoexec --python this.py -- OUTDIR.
Authored/mobile visual candidates only. Never overwrites original .blend/.glb sources.
"""
import bpy,json,hashlib,sys,math,struct
from pathlib import Path
from mathutils import Vector
from mathutils.bvhtree import BVHTree
SOURCE=Path(__file__).resolve().parent
OUTPUT=Path(sys.argv[sys.argv.index('--')+1]).resolve() if '--' in sys.argv else SOURCE.parents[3]/'review'/'golf-mobile-lod-candidates'
OUTPUT.mkdir(parents=True,exist_ok=True)

def digest(mesh):
 h=hashlib.sha256()
 for v in mesh.vertices:h.update(struct.pack('<3d',*v.co))
 for p in mesh.polygons:h.update(struct.pack('<II',len(p.vertices),p.material_index));h.update(struct.pack('<'+'I'*len(p.vertices),*p.vertices))
 for layer in mesh.uv_layers:
  h.update(layer.name.encode())
  for v in layer.data:h.update(struct.pack('<2d',*v.uv))
 for m in mesh.materials:h.update(m.name.encode())
 return h.hexdigest()

def triangles(obj):
 mesh=obj.data;mesh.calc_loop_triangles();return len(mesh.loop_triangles)

def shape(obj):
 mesh=obj.data;mesh.calc_loop_triangles();verts=[obj.matrix_world@v.co for v in mesh.vertices];faces=[list(t.vertices)for t in mesh.loop_triangles]
 return verts,faces

def samples(verts,faces):
 # Every vertex, edge midpoint and triangle barycenter: a reproducible dense
 # bidirectional surface error sample, not an exact global Hausdorff proof.
 yield from verts
 for f in faces:
  a,b,c=[verts[i]for i in f];yield(a+b+c)/3;yield(a+b)/2;yield(b+c)/2;yield(c+a)/2

def error(original,candidate):
 av,af=original;bv,bf=candidate;a=BVHTree.FromPolygons(av,af,all_triangles=True);b=BVHTree.FromPolygons(bv,bf,all_triangles=True)
 distances=[]
 for points,tree in[(samples(av,af),b),(samples(bv,bf),a)]:
  for point in points:
   nearest=tree.find_nearest(point)
   if nearest is not None:distances.append(nearest[3])
 return {'samples':len(distances),'maxUnits':max(distances,default=0),'meanUnits':sum(distances)/max(1,len(distances))}

report={'scope':'Offline visual candidate; collision/scoring sources untouched. Dense sampled surface error is not global Hausdorff. Source Blender units equal runtime course units.','courses':[]}
for index in[1,2,3]:
 path=SOURCE/f'oasis-course-{index}-editable.blend';before=hashlib.sha256(path.read_bytes()).hexdigest();bpy.ops.wm.open_mainfile(filepath=str(path),load_ui=False);objects=[o for o in bpy.context.scene.objects if o.type=='MESH'];rows=[];critical=[]
 for o in objects:
  original_hash=digest(o.data);original_triangles=triangles(o)
  selected=(o.name.startswith('Garden coast ')or o.name.startswith('Flower terrace rounded limestone'))and 'rounded limestone' in o.name
  if not selected:critical.append({'name':o.name,'meshSHA256':original_hash,'triangles':original_triangles});continue
  original=shape(o);modifier=o.modifiers.new('Mobile distant decorative bevel LOD','DECIMATE');modifier.ratio=.5;modifier.use_collapse_triangulate=True;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=modifier.name)
  rows.append({'name':o.name,'beforeTriangles':original_triangles,'afterTriangles':triangles(o),'error':error(original,shape(o))})
 for entry in critical:assert digest(bpy.data.objects[entry['name']].data)==entry['meshSHA256']
 total_before=sum(r['beforeTriangles']for r in rows)+sum(r['triangles']for r in critical);total_after=sum(triangles(o)for o in objects)
 bpy.ops.object.select_all(action='DESELECT')
 for o in objects:o.select_set(True)
 bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();bpy.context.object.name='Oasis artisan masonry'
 out=OUTPUT/f'oasis-course-{index}-mobile-lod-v1.glb';bpy.ops.export_scene.gltf(filepath=str(out),export_format='GLB',export_draco_mesh_compression_enable=True,export_draco_mesh_compression_level=6,export_draco_position_quantization=14,export_yup=True,export_apply=True,export_extras=True)
 assert hashlib.sha256(path.read_bytes()).hexdigest()==before
 data=out.read_bytes();n=struct.unpack_from('<I',data,12)[0];g=json.loads(data[20:20+n]);report['courses'].append({'source':str(path),'sourceSHA256':before,'sourceUnchanged':True,'output':str(out),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'beforeTriangles':total_before,'afterTriangles':total_after,'primitives':sum(len(m['primitives'])for m in g['meshes']),'criticalSourceGeometryUnchanged':True,'critical':critical,'changed':rows,'maximumSampledErrorUnits':max(r['error']['maxUnits']for r in rows)})
# Trunk is a narrow curved volume. Retain crown, petals and fern silhouettes.
path=SOURCE/'oasis-botanical-library.blend';before=hashlib.sha256(path.read_bytes()).hexdigest();bpy.ops.wm.open_mainfile(filepath=str(path),load_ui=False);trunk=bpy.data.objects['PalmTrunk'];original=shape(trunk);count=triangles(trunk);protected={o.name:digest(o.data)for o in bpy.context.scene.objects if o.type=='MESH' and o!=trunk};modifier=trunk.modifiers.new('Mobile palm trunk LOD','DECIMATE');modifier.ratio=.6;modifier.use_collapse_triangulate=True;bpy.context.view_layer.objects.active=trunk;bpy.ops.object.modifier_apply(modifier=modifier.name)
for name,d in protected.items():assert digest(bpy.data.objects[name].data)==d
out=OUTPUT/'oasis-botanical-library-mobile-lod-v1.glb';bpy.ops.export_scene.gltf(filepath=str(out),export_format='GLB',export_draco_mesh_compression_enable=True,export_draco_mesh_compression_level=6,export_draco_position_quantization=14,export_yup=True,export_apply=True,export_extras=True)
assert hashlib.sha256(path.read_bytes()).hexdigest()==before
report['botanicals']={'output':str(out),'bytes':out.stat().st_size,'beforeTrunkTriangles':count,'afterTrunkTriangles':triangles(trunk),'error':error(original,shape(trunk)),'protectedSourceGeometryUnchanged':True,'protected':protected,'sourceSHA256':before,'sourceUnchanged':True}
(OUTPUT/'lod-report.json').write_text(json.dumps(report,indent=2));print('GOLF_MOBILE_LOD_REPORT',OUTPUT/'lod-report.json')
