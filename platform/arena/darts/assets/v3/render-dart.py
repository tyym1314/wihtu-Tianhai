"""Original lathed metal dart with three folded flights; transparent PLAY/MOMENT sprite."""
import bpy,math,os,json
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
OUT=os.path.dirname(os.path.abspath(__file__))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=48;s.render.resolution_x=512;s.render.resolution_y=1024;s.render.resolution_percentage=100;s.render.film_transparent=True;s.render.image_settings.file_format='PNG';s.render.image_settings.color_mode='RGBA';s.world.color=(.15,.18,.23);s.view_settings.view_transform='AgX'
def mat(name,rgb,metal=.6,rough=.2):
 m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*rgb,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough;return m
silver=mat('Brushed tungsten',(.42,.46,.48),.85,.24);gold=mat('Champagne ring',(.7,.42,.10),.8,.2);blue=mat('Midnight blue flight',(.008,.09,.17),.35,.25)
def lathe(name,profile,m):
 n=96;v=[(r*math.cos(i*math.tau/n),r*math.sin(i*math.tau/n),z)for r,z in profile for i in range(n)];f=[(k*n+i,k*n+(i+1)%n,(k+1)*n+(i+1)%n,(k+1)*n+i)for k in range(len(profile)-1)for i in range(n)];mesh=bpy.data.meshes.new(name);mesh.from_pydata(v,[],f);mesh.update();o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);o.data.materials.append(m)
 for p in mesh.polygons:p.use_smooth=True
lathe('Steel needle',[(0,1.65),(.025,1.02),(.02,.95)],silver)
lathe('Tungsten barrel',[(.026,1.02),(.067,.94),(.075,.18),(.055,.1),(.018,.06)],silver)
for i in range(15):
 z=.2+i*.045;lathe('Machined grip ring',[(.075,z),(.085,z+.006),(.085,z+.019),(.075,z+.026)],gold if i%4==0 else silver)
lathe('Rear shaft',[(.019,.12),(.022,-1.38),(0,-1.44)],gold)
for q in range(3):
 a=q*math.tau/3+.25;pts=[(0,-.62),(.42,-.98),(.36,-1.57),(0,-1.36)];vertices=[(r*math.cos(a),r*math.sin(a),z)for r,z in pts];mesh=bpy.data.meshes.new('Flight mesh');mesh.from_pydata(vertices,[],[(0,1,2,3)]);mesh.update();o=bpy.data.objects.new('Folded blue flight',mesh);bpy.context.collection.objects.link(o);o.data.materials.append(blue);sol=o.modifiers.new('Fold thickness','SOLIDIFY');sol.thickness=.017;be=o.modifiers.new('Soft edge','BEVEL');be.width=.006;be.segments=2
 curve=bpy.data.curves.new('gold flight edge','CURVE');curve.dimensions='3D';curve.bevel_depth=.009;curve.bevel_resolution=3;sp=curve.splines.new('POLY');sp.points.add(4)
 for p,co in zip(sp.points,vertices+[vertices[0]]):p.co=(*co,1)
 ob=bpy.data.objects.new('gold flight edge',curve);bpy.context.collection.objects.link(ob);ob.data.materials.append(gold)
bpy.ops.object.camera_add(location=(.5,-8,2));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,0))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=3.7;s.camera=cam
for pos,en,size,col in [((-3,-4,5),650,3,(1,.9,.73)),((3,-1,1),450,2,(.55,.8,1)),((0,4,3),600,2,(1,.8,.44))]:
 bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=en;o.data.size=size;o.data.color=col;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
s.render.filepath=os.path.join(OUT,'metal-dart.png');bpy.ops.render.render(write_still=True);bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'metal-dart-source.blend'));p=world_to_camera_view(s,cam,Vector((0,0,1.65)));json.dump({'tipU':p.x,'tipV':1-p.y,'imageWidth':512,'imageHeight':1024},open(os.path.join(OUT,'metal-dart-anchor.json'),'w'),indent=2)
