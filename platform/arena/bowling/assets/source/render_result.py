"""Text-free portrait photograph of the original authored neon lane, Blender Cycles."""
import bpy,os,math
from mathutils import Vector
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def xyz(p):return(p[0],-p[2],p[1])
def mat(name,c,rough=.3,metal=0):
 m=bpy.data.materials.new(name);m.use_nodes=True;s=m.node_tree.nodes.get('Principled BSDF');s.inputs['Base Color'].default_value=(*c,1);s.inputs['Roughness'].default_value=rough;s.inputs['Metallic'].default_value=metal;return m
bpy.ops.wm.open_mainfile(filepath=os.path.join(ROOT,'source','neon-private-venue.blend'))
wood=mat('Polished maple parquet',(.36,.19,.075),.20,.1);nodes=wood.node_tree.nodes;tex=nodes.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=3;tex.inputs['Detail'].default_value=5;mapping=nodes.new('ShaderNodeMapping');mapping.inputs['Scale'].default_value=(7,.15,2);coord=nodes.new('ShaderNodeTexCoord');wood.node_tree.links.new(coord.outputs['Object'],mapping.inputs[0]);wood.node_tree.links.new(mapping.outputs[0],tex.inputs['Vector']);ramp=nodes.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].color=(.12,.051,.023,1);ramp.color_ramp.elements[1].color=(.54,.32,.14,1);wood.node_tree.links.new(tex.outputs['Fac'],ramp.inputs[0]);wood.node_tree.links.new(ramp.outputs[0],nodes.get('Principled BSDF').inputs['Base Color'])
def box(p,s,m):
 bpy.ops.mesh.primitive_cube_add(size=1,location=xyz(p));o=bpy.context.object;o.scale=(s[0],s[2],s[1]);o.data.materials.append(m)
box((0,-.08,-6),(2.7,.16,18),wood);dark=mat('Black approach surround',(.005,.006,.012),.25,.4);box((0,-.4,-6),(14,.25,27),dark)
# Append pin models and place the real triangular ten-pin arrangement.
with bpy.data.libraries.load(os.path.join(ROOT,'source','neon-competition-pin.blend'),link=False)as(a,b):b.objects=a.objects
pin=[o for o in b.objects if o]
for row in range(4):
 for col in range(row+1):
  x=(col-row/2)*.38;z=-12.7-row*.34
  for source in pin:o=source.copy();bpy.context.collection.objects.link(o);o.location+=Vector(xyz((x,.32,z)))
def light(name,p,c,power,size,target):
 bpy.ops.object.light_add(type='AREA',location=xyz(p));o=bpy.context.object;o.name=name;o.data.energy=power;o.data.color=c;o.data.shape='DISK';o.data.size=size;o.rotation_euler=(Vector(xyz(target))-o.location).to_track_quat('-Z','Y').to_euler()
for z in[0,-4,-8,-12]:
 light('Cobalt wallwash',(-2.25,2.2,z),(.05,.19,1),180,2.2,(0,.2,z));light('Violet wallwash',(2.25,2.2,z),(.39,.045,1),140,2.2,(0,.2,z))
light('Pin softbox',(0,3,-11.8),(.75,.84,1),260,2,(0,.3,-13));light('Approach softbox',(0,3.5,2),(.50,.35,1),180,3,(0,0,-3))
scene=bpy.context.scene;scene.world.use_nodes=True;scene.world.node_tree.nodes.get('Background').inputs[0].default_value=(.014,.008,.025,1);scene.world.node_tree.nodes.get('Background').inputs[1].default_value=.3;bpy.ops.object.camera_add(location=xyz((0,2.1,5.5)));camera=bpy.context.object;camera.rotation_euler=(Vector(xyz((0,1.0,-9)))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.lens=24;scene.camera=camera;scene.render.engine='CYCLES';scene.cycles.samples=40;scene.cycles.use_denoising=True;scene.render.resolution_x=768;scene.render.resolution_y=1152;scene.render.resolution_percentage=100;scene.view_settings.view_transform='AgX';scene.render.image_settings.file_format='PNG';scene.render.filepath=os.path.join(ROOT,'textures','neon-result-environment.png');scene.use_nodes=True;tree=scene.node_tree;tree.nodes.clear();r=tree.nodes.new('CompositorNodeRLayers');glare=tree.nodes.new('CompositorNodeGlare');glare.glare_type='FOG_GLOW';glare.quality='HIGH';glare.threshold=2;out=tree.nodes.new('CompositorNodeComposite');tree.links.new(r.outputs['Image'],glare.inputs['Image']);tree.links.new(glare.outputs['Image'],out.inputs['Image']);bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'source','neon-result-scene.blend'));bpy.ops.render.render(write_still=True)
