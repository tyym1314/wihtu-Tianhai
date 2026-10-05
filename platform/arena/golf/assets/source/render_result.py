"""Render the authored playable scenery as a text-free portrait result plate."""
import bpy,os,math,json
from mathutils import Vector
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def xyz(p):return(p[0],-p[2],p[1])
def mat(name,c,rough=.7,metal=0):
 m=bpy.data.materials.new(name);m.use_nodes=True;s=m.node_tree.nodes.get('Principled BSDF');s.inputs['Base Color'].default_value=(*c,1);s.inputs['Roughness'].default_value=rough;s.inputs['Metallic'].default_value=metal;return m
index=int(os.environ.get('OASIS_ART_HOLE','0'));bpy.ops.wm.open_mainfile(filepath=os.path.join(ROOT,'source','oasis-course-'+str(index+1)+'.blend'))
level=json.load(open(os.path.join(ROOT,'source','course-topology.json')))[index]
grass=mat('Fine living grass',(.23,.41,.075),.91);nodes=grass.node_tree.nodes;noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=280;bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.25;bump.inputs['Distance'].default_value=.01;grass.node_tree.links.new(noise.outputs['Fac'],bump.inputs['Height']);grass.node_tree.links.new(bump.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal'])
def flat(points,name):
 d=bpy.data.meshes.new(name);d.from_pydata([xyz((p['x'],.185,p['z']))for p in points],[],[tuple(range(len(points)))]);d.materials.append(grass);d.update();
 if d.polygons[0].normal.z<0:d.flip_normals()
 o=bpy.data.objects.new(name,d);bpy.context.collection.objects.link(o)
flat(level['polygon'],'Exact playable fairway')
with bpy.data.libraries.load(os.path.join(ROOT,'source','oasis-botanical-library.blend'),link=False)as(a,b):b.objects=a.objects
library={o.name:o for o in b.objects if o}
# The source objects remain unlinked. Every displayed clone retains the editable mesh hierarchy.
def plant(name,x,z,size):
 root=library[name];items=[root]+list(root.children_recursive)
 copies={o:o.copy()for o in items}
 for original,copy in copies.items():
  bpy.context.collection.objects.link(copy)
  if original.parent in copies:copy.parent=copies[original.parent]
 copies[root].location=xyz((x,.23,z));copies[root].scale=(size,size,size)
for j,(x,z,r,size)in enumerate([[-5,8,1.6,1],[4.9,5,1.55,.8],[-5.7,1,1.9,1.15],[4.8,-2,1.7,1.05],[-5.3,-6.4,2,1.2],[5.2,-10.5,2.5,1.5],[-6.7,-13.5,2.9,1.35]]):
 flat([{'x':x+math.cos(i*math.tau/72)*r*.89*(1+.10*math.sin(i*math.tau/72*3+j)+.06*math.sin(i*math.tau/72*5-j*.4)),'z':z+math.sin(i*math.tau/72)*r*.89*(1+.10*math.sin(i*math.tau/72*3+j)+.06*math.sin(i*math.tau/72*5-j*.4))}for i in range(72)],'Island meadow');plant('Palm',x-.2,z-.25,size);plant('Flowers',x+.6,z+.5,.8);plant('Flowers',x-.6,z+.5,.7);plant('Fern',x,z+.6,.5)
for t in [.04,.18,.53,.76,.94]:
 q=level['samples'][int(t*(len(level['samples'])-1))];side=-1 if t>.5 else 1;x=q['x']+q['nx']*(q['width']+.6)*side;z=q['z']+q['nz']*(q['width']+.6)*side;plant('Flowers',x,z,.9)
water=mat('Lagoon clear turquoise',(.014,.24,.23),.16,.35);nodes=water.node_tree.nodes;n=nodes.new('ShaderNodeTexNoise');n.inputs['Scale'].default_value=1.4;n.inputs['Detail'].default_value=5;n.inputs['Roughness'].default_value=.7;b=nodes.new('ShaderNodeBump');b.inputs['Strength'].default_value=.20;b.inputs['Distance'].default_value=.09;water.node_tree.links.new(n.outputs['Fac'],b.inputs['Height']);water.node_tree.links.new(b.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal']);bpy.ops.mesh.primitive_plane_add(size=250,location=(0,0,-1.15));bpy.context.object.data.materials.append(water)
# Lit flag and physical hole complete the photographed landscape without interface text.
gold=mat('Flag warm brass',(.74,.47,.10),.24,.8);x=level['cup']['x'];z=level['cup']['z'];bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=level['holeRadius'],depth=.01,location=xyz((x,.195,z)));bpy.context.object.data.materials.append(mat('Cup darkness',(.006,.018,.012),.9));bpy.ops.mesh.primitive_cylinder_add(vertices=20,radius=.026,depth=1.7,location=xyz((x,1.05,z)));bpy.context.object.data.materials.append(gold)
def light(name,pos,color,energy,size):
 bpy.ops.object.light_add(type='AREA',location=xyz(pos));o=bpy.context.object;o.name=name;o.data.energy=energy;o.data.color=color;o.data.shape='DISK';o.data.size=size;o.rotation_euler=(Vector((0,0,0))-o.location).to_track_quat('-Z','Y').to_euler()
light('Soft warm sky',(-12,22,7),(1,.83,.59),5500,12);light('Turquoise sky fill',(9,16,-8),(.56,.83,1),2400,10)
bpy.ops.object.light_add(type='SUN',location=(0,0,20));bpy.context.object.rotation_euler=(.45,-.3,-.45);bpy.context.object.data.energy=2;bpy.context.object.data.angle=.13
scene=bpy.context.scene;scene.world.use_nodes=True;scene.world.node_tree.nodes.get('Background').inputs[0].default_value=(.27,.48,.53,1);scene.world.node_tree.nodes.get('Background').inputs[1].default_value=.55
bpy.ops.object.camera_add(location=xyz((3.4,20.7,24.8)));camera=bpy.context.object;camera.rotation_euler=(Vector(xyz((0,0,-.6)))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.lens=43;scene.camera=camera;scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True;scene.render.resolution_x=768;scene.render.resolution_y=1152;scene.render.resolution_percentage=100;scene.view_settings.view_transform='AgX';scene.render.image_settings.file_format='PNG';scene.render.filepath=os.path.join(ROOT,'textures','oasis-result-environment.png')
# Actual Cycles contact AO baked onto all grass with one stable global world UV atlas.
ao=bpy.data.images.new('Oasis contact AO '+str(index+1),width=1024,height=1024);ao.generated_color=(1,1,1,1);target=grass.node_tree.nodes.new('ShaderNodeTexImage');target.image=ao;grass.node_tree.nodes.active=target
bpy.ops.object.select_all(action='DESELECT');greens=[]
for o in scene.objects:
 if o.type=='MESH' and o.data.materials and o.data.materials[0]==grass:
  greens.append(o);uv=o.data.uv_layers.new(name='Global contact AO')
  for loop in o.data.loops:
   p=o.matrix_world@o.data.vertices[loop.vertex_index].co;uv.data[loop.index].uv=((p.x+10)/20,(p.y+12)/29)
  o.select_set(True)
bpy.context.view_layer.objects.active=greens[0];scene.render.bake.margin=4;scene.cycles.samples=24;bpy.ops.object.bake(type='AO');ao.filepath_raw=os.path.join(ROOT,'textures','course-'+str(index+1)+'-contact-ao.png');ao.file_format='PNG';ao.save()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'source','oasis-lighting-hole-'+str(index+1)+'.blend'))
if index==0 and os.environ.get('OASIS_AO_ONLY')!='1':
 bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'source','oasis-result-scene.blend'));bpy.ops.render.render(write_still=True)
