"""Original Blender mesh assets for interactive PLAY pieces; no reference pixels are used."""
import bpy,math,os
from mathutils import Vector
OUT=os.path.dirname(os.path.abspath(__file__));JACK=os.path.abspath(os.path.join(OUT,'../../../jackaroo/assets/v3'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=48;s.render.resolution_x=384;s.render.resolution_y=384;s.render.resolution_percentage=100;s.render.film_transparent=True;s.render.image_settings.file_format='PNG';s.render.image_settings.color_mode='RGBA';s.world.color=(.16,.18,.2);s.view_settings.view_transform='AgX'
def mat(name,rgb,metal=.1,rough=.22):
 m=bpy.data.materials.new(name);m.use_nodes=True;n=m.node_tree.nodes.get('Principled BSDF');n.inputs['Base Color'].default_value=(*rgb,1);n.inputs['Metallic'].default_value=metal;n.inputs['Roughness'].default_value=rough;n.inputs['Coat Weight'].default_value=.4;n.inputs['Coat Roughness'].default_value=.18;return m
colors=[mat('Coral red lacquer',(.65,.032,.028)),mat('Sapphire blue lacquer',(.013,.26,.68)),mat('Jade green lacquer',(.018,.43,.11)),mat('Honey gold lacquer',(.74,.43,.04),.48)]
gold=mat('Gold fine inlay',(.7,.43,.10),.75)
def lathe(profile,m):
 n=128;verts=[(r*math.cos(i*2*math.pi/n),r*math.sin(i*2*math.pi/n),z)for r,z in profile for i in range(n)];faces=[(k*n+i,k*n+(i+1)%n,(k+1)*n+(i+1)%n,(k+1)*n+i)for k in range(len(profile)-1)for i in range(n)];mesh=bpy.data.meshes.new('turned-lacquer-pawn');mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new('turned-lacquer-pawn',mesh);bpy.context.collection.objects.link(o);o.data.materials.append(m)
 for p in mesh.polygons:p.use_smooth=True
 return o
def ring(r,z):
 bpy.ops.mesh.primitive_torus_add(major_segments=96,minor_segments=10,major_radius=r,minor_radius=.012,location=(0,0,z));o=bpy.context.object;o.data.materials.append(gold)
 for p in o.data.polygons:p.use_smooth=True
bpy.ops.object.camera_add(location=(0,-5.8,8.5));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,.65))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=2.7;s.camera=cam
for pos,energy,size,color in [((-3,-4,6),450,3,(1,.9,.73)),((4,1,5),240,3,(.68,.86,1)),((-2,4,4),400,2,(1,.9,.72))]:
 bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=energy;o.data.size=size;o.data.color=color;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
keep=set(bpy.data.objects.keys())
for i,m in enumerate(colors):
 lathe([(0,0),(.51,0),(.56,.045),(.56,.11),(.52,.17),(.43,.21),(.41,.29),(.38,.31),(.30,.48),(.23,.72),(.2,.91),(.21,1.04),(0,1.06)],m);ring(.523,.15);ring(.40,.295)
 bpy.ops.mesh.primitive_uv_sphere_add(segments=64,ring_count=32,radius=.285,location=(0,0,1.245));o=bpy.context.object;o.data.materials.append(m)
 for p in o.data.polygons:p.use_smooth=True
 s.render.filepath=os.path.join(OUT,'pawn-'+str(i)+'.png');bpy.ops.render.render(write_still=True)
 if i==0:bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'ludo-pawn-source.blend'))
 for o in list(bpy.data.objects):
  if o.name not in keep:bpy.data.objects.remove(o,do_unlink=True)
cam.location=(0,-.7,8);cam.rotation_euler=(Vector((0,0,0))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=2.6
for name,rgb,metal in [('emerald',(.005,.22,.09),.25),('ivory',(.78,.66,.43),.08)]:
 m=mat(name,rgb,metal,.16);n=m.node_tree.nodes;links=m.node_tree.links;noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=4.0;noise.inputs['Detail'].default_value=3;ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].color=(*[x*.45 for x in rgb],1);ramp.color_ramp.elements[1].color=(*rgb,1);links.new(noise.outputs['Fac'],ramp.inputs[0]);links.new(ramp.outputs[0],n.get('Principled BSDF').inputs['Base Color'])
 bpy.ops.mesh.primitive_uv_sphere_add(segments=96,ring_count=64,radius=1);o=bpy.context.object;o.data.materials.append(m)
 for p in o.data.polygons:p.use_smooth=True
 s.render.filepath=os.path.join(JACK,'marble-'+name+'.png');bpy.ops.render.render(write_still=True)
 if name=='ivory':bpy.ops.wm.save_as_mainfile(filepath=os.path.join(JACK,'jackaroo-marble-source.blend'))
 bpy.data.objects.remove(o,do_unlink=True)
