"""Original physical disc sprites. Run with Blender 4.5 --background --python this_file."""
import bpy, math, os
from mathutils import Vector
OUT=os.path.dirname(os.path.abspath(__file__))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.engine='CYCLES';scene.cycles.samples=32
scene.render.resolution_x=384;scene.render.resolution_y=384;scene.render.resolution_percentage=100
scene.render.film_transparent=True;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.world.color=(.22,.24,.25)
scene.view_settings.view_transform='AgX'
def material(name,color,metal=.0,rough=.3):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;n=m.node_tree.nodes.get('Principled BSDF');n.inputs['Base Color'].default_value=(*color,1);n.inputs['Metallic'].default_value=metal;n.inputs['Roughness'].default_value=rough;n.inputs['Coat Weight'].default_value=.28
 return m
gold=material('Warm engraved brass',(.62,.39,.10),.78,.23)
materials={'white':material('Polished ivory',(.88,.79,.58),.07,.27),'black':material('Black lacquer',(.018,.023,.019),.16,.23),'queen':material('Ruby queen lacquer',(.43,.013,.035),.20,.22),'striker':material('Champagne striker',(.72,.55,.24),.45,.25)}
def lathe(name,profile,mat):
 verts=[];faces=[];count=128
 for radius,z in profile:
  verts += [(radius*math.cos(i*2*math.pi/count),radius*math.sin(i*2*math.pi/count),z) for i in range(count)]
 for k in range(len(profile)-1):
  for i in range(count):j=(i+1)%count;faces.append((k*count+i,k*count+j,(k+1)*count+j,(k+1)*count+i))
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update();obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);obj.data.materials.append(mat)
 for p in mesh.polygons:p.use_smooth=True
 return obj
def ring(name,r,z,minor,mat):
 bpy.ops.mesh.primitive_torus_add(major_segments=128,minor_segments=12,location=(0,0,z),major_radius=r,minor_radius=minor)
 o=bpy.context.object;o.name=name;o.data.materials.append(mat)
 for p in o.data.polygons:p.use_smooth=True
 return o
def line(name,points,mat,thickness=.012):
 curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.bevel_depth=thickness;curve.bevel_resolution=3;spline=curve.splines.new('POLY');spline.points.add(len(points)-1)
 for p,co in zip(spline.points,points):p.co=(*co,1)
 obj=bpy.data.objects.new(name,curve);bpy.context.collection.objects.link(obj);obj.data.materials.append(mat);return obj
bpy.ops.object.camera_add(location=(0,-1.5,12));camera=bpy.context.object;camera.rotation_euler=(Vector((0,0,.12))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=2.65;scene.camera=camera
for name,location,energy,size,color in [('Key',(-3,-4,7),600,4,(1,.86,.66)),('Fill',(4,1,5),300,3,(.68,.85,1)),('Rim',(-1,4,4),450,2,(1,.92,.77))]:
 bpy.ops.object.light_add(type='AREA',location=location);o=bpy.context.object;o.name=name;o.data.energy=energy;o.data.shape='DISK';o.data.size=size;o.data.color=color;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
base_names=set(bpy.data.objects.keys())
for kind,mat in materials.items():
 profile=[(0,.03),(.92,.03),(.98,.06),(1,.10),(1,.18),(.976,.225),(.91,.24),(.83,.24),(.815,.227),(.78,.227),(.765,.24),(.65,.24),(.635,.227),(.60,.227),(.585,.24),(0,.24)]
 lathe(kind+' sculpted body',profile,mat)
 ring('outer polished edge',.947,.232,.009,gold if kind=='striker' else mat)
 if kind in ('queen','striker'):
  for i in range(8):
   angle=i*math.pi/4;points=[]
   for j in range(49):
    t=j/48*math.pi*2;r=.18+.19*(1-math.cos(t));a=angle+.11*math.sin(t);points.append((math.cos(a)*r,math.sin(a)*r,.246))
   line('engraved petal',points,gold,.009)
  ring('emblem medallion',.145,.247,.012,gold)
 scene.render.filepath=os.path.join(OUT,'disc-'+kind+'.png');bpy.ops.render.render(write_still=True)
 if kind=='striker':bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'carrom-disc-source.blend'))
 for obj in list(bpy.data.objects):
  if obj.name not in base_names:bpy.data.objects.remove(obj,do_unlink=True)
