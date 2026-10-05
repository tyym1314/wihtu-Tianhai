"""Original editable bowling production assets. Blender 4.5; no physics data changed."""
import bpy,math,random,os
from mathutils import Vector
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));MODELS=os.path.join(ROOT,'models');random.seed(437)
def xyz(p):return(p[0],-p[2],p[1])
def clean():bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def material(name,c,rough=.3,metal=0,emission=0):
 m=bpy.data.materials.new(name);m.use_nodes=True;s=m.node_tree.nodes.get('Principled BSDF');s.inputs['Base Color'].default_value=(*c,1);s.inputs['Roughness'].default_value=rough;s.inputs['Metallic'].default_value=metal
 if emission:s.inputs['Emission Color'].default_value=(*c,1);s.inputs['Emission Strength'].default_value=emission
 if 'Coat Weight' in s.inputs:s.inputs['Coat Weight'].default_value=.45;s.inputs['Coat Roughness'].default_value=.15
 return m
def mesh(name,v,f,mat,smooth=False):
 d=bpy.data.meshes.new(name);d.from_pydata([xyz(p)for p in v],[],f);d.update();d.materials.append(mat);o=bpy.data.objects.new(name,d);bpy.context.collection.objects.link(o)
 if smooth:
  for p in d.polygons:p.use_smooth=True
 return o
def bevel(o,w=.02):
 m=o.modifiers.new('Machined softened edge','BEVEL');m.width=w;m.segments=3;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
 return o
def box(name,p,s,m,bev=.02):
 bpy.ops.mesh.primitive_cube_add(size=1,location=xyz(p));o=bpy.context.object;o.name=name;o.scale=(s[0],s[2],s[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(m)
 if bev:bevel(o,bev)
 return o
def lathe(name,profile,material,segments=64):
 verts=[];faces=[]
 for radius,y in profile:
  for i in range(segments):a=i*math.tau/segments;verts.append((radius*math.cos(a),y-.32,radius*math.sin(a)))
 for j in range(len(profile)-1):
  for i in range(segments):a=j*segments+i;b=j*segments+(i+1)%segments;faces.append((a,a+segments,b+segments,b))
 return mesh(name,verts,faces,material,True)
def export(name):
 bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'source',name+'.blend'));meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
 bpy.ops.object.select_all(action='DESELECT')
 for obj in meshes:obj.select_set(True)
 bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join()
 bpy.ops.export_scene.gltf(filepath=os.path.join(MODELS,name+'.glb'),export_format='GLB',export_draco_mesh_compression_enable=True,export_draco_mesh_compression_level=6,export_draco_position_quantization=14,export_yup=True,export_apply=True,export_extras=True);print('ART_EXPORTED',name)
white=material('Pin polished porcelain',(.92,.91,.87),.17,.025);red=material('Competition red enamel',(.61,.01,.024),.23,.02);dark=material('Night anodized steel',(.008,.012,.035),.26,.65);chrome=material('Brushed titanium',(.16,.19,.31),.2,.91);panel=material('Deep violet acoustic wall',(.023,.013,.061),.5,.2);cushion=material('Indigo stitched leather',(.024,.023,.086),.47,.1);blue=material('Electric blue diffuser',(.012,.08,1),.2,.2,5);violet=material('Violet neon glass',(.34,.008,1),.2,.2,4);warm=material('Brass edge',(.68,.42,.12),.28,.8)
clean();profile=[(.075,0),(.092,.015),(.104,.05),(.116,.13),(.119,.20),(.114,.28),(.098,.35),(.075,.425),(.056,.50),(.044,.57),(.043,.635),(.054,.663),(.068,.69),(.073,.72),(.070,.753),(.055,.78),(.031,.799),(0,.803)];o=lathe('PinBody',profile,white);m=o.modifiers.new('Silhouette polish','SUBSURF');m.levels=1;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
for i,y in enumerate([.566,.616]):lathe('Red neck band '+str(i),[(.048,y),(.048,y+.033)],red)
export('neon-competition-pin')
# A polished resin sphere with actual boolean recesses (not black spheres attached outside).
clean();ballmat=material('Violet pearl bowling resin',(.052,.014,.25),.105,.40)
import numpy as np
N=512;y,x=np.mgrid[0:N,0:N];rng=np.random.default_rng(437);flow=np.sin(x*.031+np.sin(y*.022)*2.6)+np.sin(y*.046+x*.011);flow=(flow+2)/4;rgb=np.stack([.06+flow*.16,.025+flow*.05,.19+flow*.36],-1);spark=rng.random((N,N))>.998;rgb[spark]=(.55,.37,.9);rgba=np.ones((N,N,4),np.float32);rgba[:,:,:3]=rgb;im=bpy.data.images.new('Pearl resin original albedo',width=N,height=N);im.pixels.foreach_set(rgba.ravel());im.filepath_raw=os.path.join(ROOT,'textures','violet-pearl-albedo.png');im.file_format='PNG';im.save();nodes=ballmat.node_tree.nodes;tex=nodes.new('ShaderNodeTexImage');tex.image=im;ballmat.node_tree.links.new(tex.outputs['Color'],nodes.get('Principled BSDF').inputs['Base Color'])
bpy.ops.mesh.primitive_uv_sphere_add(segments=80,ring_count=48,radius=.215);ball=bpy.context.object;ball.name='PearlBall';ball.data.materials.append(ballmat);bore=material('Recessed finger bore charcoal',(.003,.002,.009),.78,0);ball.data.materials.append(bore)
for p in ball.data.polygons:p.use_smooth=True
for i,(xx,zz,r)in enumerate([(-.047,-.025,.027),(.047,-.025,.027),(0,.067,.032)]):
 bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=r,depth=.20,location=xyz((xx,.18,zz)));c=bpy.context.object;c.name='Finger bore cutter';c.data.materials.append(ballmat);c.data.materials.append(bore)
 for face in c.data.polygons:face.material_index=1
 mod=ball.modifiers.new('True recessed finger socket '+str(i),'BOOLEAN');mod.operation='DIFFERENCE';mod.object=c;bpy.context.view_layer.objects.active=ball;bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(c,do_unlink=True)
bevel(ball,.0018);export('neon-pearl-ball')
clean();
# Side walls, inset lit vaults and stepped trim are geometrically authored and editable.
for side in[-1,1]:
 x=side*2.65;box('Dark wall slab',(x,1.46,-6.5),(.15,2.92,24),panel)
 for j,z in enumerate([2,-1.1,-4.2,-7.3,-10.4,-13.5]):
  box('Titanium rib',(x-side*.06,1.46,z),(.27,2.92,.30),chrome)
  box('Recessed cobalt LED',(x-side*.18,1.49,z+.09),(.14,2.57,.065),blue,.007)
  box('Rib gold foot',(x-side*.07,.24,z),(.2,.46,.25),warm)
  box('Upper violet cornice',(x-side*.07,2.63,z-1.35),(.19,.065,2.94),violet,.012)
  box('Blue wall datum',(x-side*.075,.62,z-1.35),(.08,.03,2.65),blue,.006)
  # Quiet dark acoustic panels; broad plastic-looking vertical fins omitted.
 for z in[-3,-9]:
  box('Banquette brass plinth',(side*2.16,.11,z),(.78,.10,2.3),warm)
  for n in[-1,0,1]:
   box('Plush velvet seat',(side*2.16,.33,z+n*.72),(.76,.38,.70),cushion,.10)
   box('Tufted backrest',(side*2.45,.73,z+n*.72),(.20,.60,.70),cushion,.08)
for z in[2,-1.1,-4.2,-7.3,-10.4,-13.5]:
 box('Ceiling cross vault',(0,2.95,z),(5.35,.17,.25),dark)
 box('Violet indirect vault light',(0,2.83,z+.065),(5.1,.025,.045),violet,.006)
 box('Cobalt recessed vault light',(0,2.79,z-.06),(4.4,.024,.045),blue,.005)
box('Actual dark ceiling',(0,3.06,-6.5),(5.45,.11,24),panel)
for side in[-1,1]:
 box('Continuous cove housing',(side*2.42,2.86,-6.5),(.22,.12,23.7),dark)
 box('Continuous cobalt cove',(side*2.34,2.79,-6.5),(.045,.026,23.7),blue,.008)
 box('Continuous violet inner cove',(side*1.93,2.91,-6.5),(.026,.026,23.7),violet,.006)
box('Rear midnight wall',(0,1.46,-15.65),(5.45,2.92,.22),dark)
box('Recessed sign surround',(0,1.60,-15.495),(3.15,1.24,.05),panel,.045)
for y in[2.65]:box('Rear crown light',(0,y,-15.48),(4.2,.042,.06),blue,.008)
for x in[-2.1,2.1]:box('Rear pilaster',(x,1.55,-15.46),(.05,2.2,.06),violet,.008)
# Flush gutters and rail packages remain outside the exact 2.7m lane.
for side in[-1,1]:
 for z in[-11,-5,1]:
  box('Gutter outer chrome',(side*1.65,.03,z),(.14,.18,6.01),chrome)
  box('Lane edge LED',(side*1.58,.11,z),(.026,.018,6.01),blue,.005)
export('neon-private-venue');print('NEON_BUILD_COMPLETE')
