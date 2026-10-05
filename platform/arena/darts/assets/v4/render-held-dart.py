"""First-person ready pose from the original dart mesh; separate from the hit-anchored flight sprite."""
import bpy, os, json
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

OUT = os.path.dirname(os.path.abspath(__file__))
bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, '../v3/metal-dart-source.blend'))
scene = bpy.context.scene
camera = scene.camera
camera.data.type = 'PERSP'
camera.data.lens = 100
camera.location = (0, -2, -5.5)
target = Vector((0, 0, -.13))
camera.rotation_euler = (target-camera.location).to_track_quat('-Z', 'Y').to_euler()
scene.render.resolution_x = 720
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.cycles.samples = 64
# A broad cool rim on the tail, a warm grip highlight, and no baked background.
for obj in bpy.data.objects:
    if obj.type == 'LIGHT': obj.data.energy *= 1.2
bpy.ops.object.light_add(type='AREA', location=(0, -4, -2))
light = bpy.context.object
light.data.energy = 200
light.data.size = 3
light.data.color = (.7, .88, 1)
light.rotation_euler = (Vector((0, 0, -.7))-light.location).to_track_quat('-Z', 'Y').to_euler()
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
for _ in range(3):
    bpy.context.view_layer.update()
    points = [world_to_camera_view(scene, camera, obj.matrix_world @ v.co) for obj in bpy.data.objects if obj.type == 'MESH' for v in obj.data.vertices]
    left, right = min(p.x for p in points), max(p.x for p in points)
    bottom, top = min(p.y for p in points), max(p.y for p in points)
    camera.data.lens *= .86/max(right-left, top-bottom)
    bpy.context.view_layer.update()
    points = [world_to_camera_view(scene, camera, obj.matrix_world @ v.co) for obj in bpy.data.objects if obj.type == 'MESH' for v in obj.data.vertices]
    camera.data.shift_x += (min(p.x for p in points)+max(p.x for p in points))/2-.5
    camera.data.shift_y += ((min(p.y for p in points)+max(p.y for p in points))/2-.5)*scene.render.resolution_y/scene.render.resolution_x
scene.render.filepath = os.path.join(OUT, 'held-dart.png')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'held-dart-source.blend'))
bpy.ops.render.render(write_still=True)
tip = world_to_camera_view(scene, camera, Vector((0, 0, 1.65)))
json.dump({'source': '../v3/metal-dart-source.blend', 'purpose': 'ready-only first-person pose; never used as an authoritative hit anchor', 'tipU': tip.x, 'tipV': 1-tip.y, 'width': 720, 'height': 640}, open(os.path.join(OUT, 'provenance.json'), 'w'), indent=2)
