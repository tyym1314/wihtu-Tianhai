"""Derive the runtime GLB without re-exporting or changing retained geometry.

This intentionally supports only the plain, embedded Blender scenery format.
Unknown reference-bearing features fail closed instead of being silently lost.
"""
import copy
import hashlib
import json
from pathlib import Path
import struct

KEEP = ('Palm', 'RockBank', 'BridgeSupport', 'FinishGate')
REMOVED = ('Palace',)
RUNTIME_NAME = 'oasis-kit-runtime-v1.glb'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, allowed, label):
    require(isinstance(value, dict) and not set(value) - set(allowed),
            'Unsupported ' + label + ' fields')


def index(value, values, label):
    require(type(value) is int and 0 <= value < len(values), 'Invalid ' + label)
    return value


def read_glb(data):
    require(len(data) >= 28, 'Truncated GLB')
    require(struct.unpack_from('<III', data) == (0x46546C67, 2, len(data)), 'Invalid GLB header')
    chunks, at = [], 12
    while at < len(data):
        require(at + 8 <= len(data), 'Truncated chunk header')
        size, kind = struct.unpack_from('<II', data, at)
        require(size % 4 == 0 and at + 8 + size <= len(data), 'Invalid GLB chunk')
        chunks.append((kind, data[at + 8:at + 8 + size]))
        at += 8 + size
    require([kind for kind, _ in chunks] == [0x4E4F534A, 0x004E4942], 'Expected JSON and embedded BIN only')
    return json.loads(chunks[0][1]), chunks[1][1]


def encode_glb(document, binary):
    body = json.dumps(document, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    body += b' ' * (-len(body) % 4)
    binary += b'\0' * (-len(binary) % 4)
    return (struct.pack('<III', 0x46546C67, 2, 28 + len(body) + len(binary))
            + struct.pack('<II', len(body), 0x4E4F534A) + body
            + struct.pack('<II', len(binary), 0x004E4942) + binary)


def prune_environment(data):
    doc, binary = read_glb(data)
    fields(doc, ('asset', 'scene', 'scenes', 'nodes', 'materials', 'meshes', 'accessors', 'bufferViews', 'buffers'), 'document')
    require(doc['asset'].get('version') == '2.0' and len(doc['scenes']) == 1 and doc.get('scene', 0) == 0, 'Expected one glTF 2 scene')
    require(len(doc['buffers']) == 1, 'Expected one embedded buffer')
    fields(doc['buffers'][0], ('byteLength',), 'buffer')
    length = doc['buffers'][0]['byteLength']
    require(type(length) is int and 0 <= len(binary) - length <= 3, 'Invalid buffer length')
    scene = doc['scenes'][0]
    fields(scene, ('name', 'nodes'), 'scene')
    nodes, meshes, accessors, views, materials = (doc[key] for key in ('nodes', 'meshes', 'accessors', 'bufferViews', 'materials'))
    roots = [index(i, nodes, 'scene node') for i in scene['nodes']]
    require(len(set(roots)) == len(KEEP) + len(REMOVED) == len(roots), 'Unexpected root count')
    require(sorted(nodes[i].get('name', '') for i in roots) == sorted(KEEP + REMOVED), 'Unexpected prefab roots')
    for node in nodes:
        fields(node, ('name', 'children', 'mesh', 'matrix', 'translation', 'rotation', 'scale'), 'node')
        if 'mesh' in node:
            index(node['mesh'], meshes, 'node mesh')
    for mesh in meshes:
        fields(mesh, ('name', 'primitives'), 'mesh')
        for primitive in mesh['primitives']:
            fields(primitive, ('attributes', 'indices', 'material', 'mode'), 'primitive')
            require(primitive.get('mode', 4) == 4, 'Expected triangles')
            for ref in primitive['attributes'].values():
                index(ref, accessors, 'attribute accessor')
            index(primitive['indices'], accessors, 'indices accessor')
            index(primitive['material'], materials, 'material')
    for accessor in accessors:
        fields(accessor, ('name', 'bufferView', 'byteOffset', 'componentType', 'normalized', 'count', 'type', 'min', 'max'), 'accessor')
        view = views[index(accessor['bufferView'], views, 'accessor buffer view')]
        size = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}.get(accessor['componentType'])
        count = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}.get(accessor['type'])
        require(size is not None and count is not None, 'Unsupported accessor type')
        offset, total, stride = accessor.get('byteOffset', 0), accessor['count'], view.get('byteStride', size * count)
        require(all(type(n) is int for n in (offset, total, stride)) and offset >= 0 and total > 0 and stride >= size * count, 'Invalid accessor layout')
        require(offset + (total - 1) * stride + size * count <= view['byteLength'], 'Accessor exceeds buffer view')
    for view in views:
        fields(view, ('name', 'buffer', 'byteOffset', 'byteLength', 'byteStride', 'target'), 'buffer view')
        offset, size = view.get('byteOffset', 0), view['byteLength']
        require(view['buffer'] == 0 and type(offset) is int and type(size) is int and offset >= 0 and size > 0 and offset + size <= length, 'Invalid buffer view bounds')
    for material in materials:
        fields(material, ('name', 'doubleSided', 'alphaMode', 'alphaCutoff', 'emissiveFactor', 'pbrMetallicRoughness'), 'material')
        fields(material.get('pbrMetallicRoughness', {}), ('baseColorFactor', 'metallicFactor', 'roughnessFactor'), 'material PBR')

    visited, kept = set(), set()
    def visit(i, retain):
        index(i, nodes, 'child node')
        require(i not in visited, 'Cyclic or multiply owned node')
        visited.add(i)
        if retain:
            kept.add(i)
        for child in nodes[i].get('children', []):
            visit(child, retain)
    for root in roots:
        visit(root, nodes[root]['name'] in KEEP)
    require(len(visited) == len(nodes), 'Unreachable source node')

    mesh_ids = {nodes[i]['mesh'] for i in kept if 'mesh' in nodes[i]}
    primitives = [p for i in mesh_ids for p in meshes[i]['primitives']]
    accessor_ids = {a for p in primitives for a in [*p['attributes'].values(), p['indices']]}
    view_ids = {accessors[i]['bufferView'] for i in accessor_ids}
    material_ids = {p['material'] for p in primitives}
    selections = {'nodes': kept, 'meshes': mesh_ids, 'accessors': accessor_ids, 'bufferViews': view_ids, 'materials': material_ids}
    maps = {key: {old: new for new, old in enumerate(sorted(ids))} for key, ids in selections.items()}
    out = copy.deepcopy(doc)
    for key, ids in selections.items():
        out[key] = [copy.deepcopy(doc[key][i]) for i in sorted(ids)]
    out['scenes'][0]['nodes'] = [maps['nodes'][i] for i in roots if i in kept]
    for node in out['nodes']:
        if 'mesh' in node:
            node['mesh'] = maps['meshes'][node['mesh']]
        if 'children' in node:
            node['children'] = [maps['nodes'][i] for i in node['children']]
    for mesh in out['meshes']:
        for p in mesh['primitives']:
            p['attributes'] = {key: maps['accessors'][i] for key, i in p['attributes'].items()}
            p['indices'] = maps['accessors'][p['indices']]
            p['material'] = maps['materials'][p['material']]
    for accessor in out['accessors']:
        accessor['bufferView'] = maps['bufferViews'][accessor['bufferView']]
    packed = bytearray()
    for view in out['bufferViews']:
        packed.extend(b'\0' * (-len(packed) % 4))
        offset = view.get('byteOffset', 0)
        view['byteOffset'] = len(packed)
        packed.extend(binary[offset:offset + view['byteLength']])
    out['buffers'][0]['byteLength'] = len(packed)
    return encode_glb(out, bytes(packed))


def write_runtime_assets(source, destination):
    source, destination = Path(source), Path(destination)
    require(source.resolve() != destination.resolve(), 'Runtime output must not overwrite source')
    data = source.read_bytes()
    runtime = prune_environment(data)
    metadata = {'schema': 'run-runtime-environment-v1', 'source': source.name,
                'source_sha256': hashlib.sha256(data).hexdigest(), 'source_bytes': len(data),
                'glb': destination.name, 'sha256': hashlib.sha256(runtime).hexdigest(), 'bytes': len(runtime),
                'prefabs': list(KEEP), 'omitted_prefabs': list(REMOVED),
                'method': 'Deterministic reachability pruning; retained accessor and buffer-view bytes unchanged.'}
    destination.write_bytes(runtime)
    destination.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return metadata


if __name__ == '__main__':
    directory = Path(__file__).resolve().parents[1] / 'environment'
    print(json.dumps(write_runtime_assets(directory / 'oasis-kit.glb', directory / RUNTIME_NAME), indent=2))
