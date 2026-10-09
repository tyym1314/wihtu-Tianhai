"""Blender 4.5 LTS: derived visual LODs only; never save over editable sources.

Run from any directory:
  blender --background --factory-startup --disable-autoexec --python build-mobile-lod.py
Collision shape/physics constants remain in the authoritative Cannon simulation.
"""
import bpy
import hashlib
import json
from pathlib import Path
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / 'models'
SOURCES = ROOT / 'source'
REPORT = ROOT / 'mobile-lod-report.json'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def triangles(objects):
    return sum(len(poly.vertices) - 2 for obj in objects for poly in obj.data.polygons)


def export(source_name, output_name, ratio=None, strip_resin=False):
    source = SOURCES / (source_name + '.blend')
    before_sha = sha(source)
    bpy.ops.wm.open_mainfile(filepath=str(source))
    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    before = triangles(objects)
    deviation = {}
    for obj in objects:
        # The neck bands remain untouched. Material boundaries protect the
        # real recessed finger sockets in the ball from crossing enamel/resin.
        if ratio is not None and obj.name in ('PinBody', 'PearlBall'):
            original_points = [vertex.co.copy() for vertex in obj.data.vertices]
            original_faces = [tuple(poly.vertices) for poly in obj.data.polygons]
            original_surface = BVHTree.FromPolygons(original_points, original_faces)
            bpy.context.view_layer.objects.active = obj
            modifier = obj.modifiers.new('Mobile visual LOD', 'DECIMATE')
            modifier.decimate_type = 'COLLAPSE'
            modifier.ratio = ratio
            modifier.use_collapse_triangulate = True
            modifier.delimit = {'MATERIAL'}
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            candidate_points = [vertex.co.copy() for vertex in obj.data.vertices]
            candidate_faces = [tuple(poly.vertices) for poly in obj.data.polygons]
            candidate_surface = BVHTree.FromPolygons(candidate_points, candidate_faces)
            # A bounded vertex sample, not a full surface Hausdorff guarantee.
            # It complements actual-camera visual comparison of silhouette/holes.
            errors = sorted([
                candidate_surface.find_nearest(point)[3] for point in original_points
            ] + [original_surface.find_nearest(point)[3] for point in candidate_points])
            deviation[obj.name] = dict(
                samples=len(errors), max_m=errors[-1],
                p95_m=errors[min(len(errors)-1, int(len(errors)*.95))],
            )
        if strip_resin:
            # The web renderer supplies pearl-resin-imagegen.webp and a black
            # bore material. Shipping the original PNG decodes unused pixels.
            for material in obj.data.materials:
                if not material or not material.use_nodes:
                    continue
                for node in list(material.node_tree.nodes):
                    if node.type == 'TEX_IMAGE':
                        material.node_tree.nodes.remove(node)
    after = triangles(objects)
    material_faces = {}
    for obj in objects:
        for polygon in obj.data.polygons:
            name = obj.data.materials[polygon.material_index].name
            material_faces[name] = material_faces.get(name, 0) + len(polygon.vertices) - 2
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    output = MODELS / (output_name + '.glb')
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format='GLB', export_yup=True,
        export_apply=True, export_extras=True,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
    )
    assert sha(source) == before_sha, 'Editable source changed'
    return dict(source=source.name, source_sha256=before_sha,
                output=output.name, sha256=sha(output), bytes=output.stat().st_size,
                source_triangles=before, triangles=after,
                material_triangles=material_faces,
                sampled_surface_distance_m=deviation,
                removed_unused_embedded_image=strip_resin)


report = {
    'blender': bpy.app.version_string,
    'scope': 'Visual geometry only; exact source transforms/material slots and authoritative physics preserved',
    'assets': [
        export('neon-competition-pin', 'neon-competition-pin-mobile-v1', ratio=.28),
        export('neon-pearl-ball', 'neon-pearl-ball-runtime-v1', strip_resin=True),
        export('neon-pearl-ball', 'neon-pearl-ball-mobile-v1', ratio=.38, strip_resin=True),
    ],
}
REPORT.write_text(json.dumps(report, indent=2) + '\n')
print('MOBILE_LOD_COMPLETE', json.dumps(report))
