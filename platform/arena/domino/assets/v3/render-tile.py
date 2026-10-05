"""Original blank ivory tile mesh. Pip values remain code-rendered live data."""
import bpy,os
from mathutils import Vector
OUT=os.path.dirname(os.path.abspath(__file__))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=40;s.render.resolution_x=768;s.render.resolution_y=384;s.render.resolution_percentage=100;s.render.film_transparent=True;s.render.image_settings.file_format='PNG';s.render.image_settings.color_mode='RGBA';s.world.color=(.13,.15,.19);s.view_settings.view_transform='AgX';s.view_settings.exposure=.45
def mat(name,rgb,rough=.27):
 m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*rgb,1);p.inputs['Roughness'].default_value=rough;p.inputs['Coat Weight'].default_value=.25;return m
ivory=mat('Warm carved ivory',(1,.91,.68));dark=mat('Deep blue enamel',(.007,.03,.04));brass=mat('Fine divider brass',(.27,.17,.06));ivory.node_tree.nodes.get('Principled BSDF').inputs['Subsurface Weight'].default_value=.035
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,.08));o=bpy.context.object;o.name='Ivory beveled tile';o.dimensions=(2,1,.16);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(ivory);mod=o.modifiers.new('Crafted bevels','BEVEL');mod.width=.065;mod.segments=6;mod=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,.161));o=bpy.context.object;o.name='Fine central divider';o.dimensions=(.012,.77,.002);o.data.materials.append(brass)
bpy.ops.object.camera_add(location=(0,-1.8,12));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,.08))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=2.18;s.camera=cam
for pos,en,size,col in [((-3,-4,7),600,4,(1,.91,.75)),((4,1,5),220,3,(.7,.87,1)),((-1,4,4),320,2,(1,.9,.7))]:
 bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=en;o.data.size=size;o.data.color=col;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
s.render.filepath=os.path.join(OUT,'ivory-tile.png');bpy.ops.render.render(write_still=True);bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'ivory-tile-source.blend'))
