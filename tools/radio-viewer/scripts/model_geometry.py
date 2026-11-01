"""Small glTF geometry reader used by scan texture and floorplan preprocessing."""
import numpy as np
from scipy.spatial.transform import Rotation

DTYPES = {5120: 'i1', 5121: 'u1', 5122: '<i2', 5123: '<u2', 5125: '<u4', 5126: '<f4'}
WIDTHS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def is_planar_surface(positions, tolerance=1e-5):
    """Identify zero-thickness surfaces in world metres, including tilted boards."""
    points = np.asarray(positions, dtype=float)
    if len(points) < 3:
        return False
    centered = points - points.mean(axis=0)
    _, singular, axes = np.linalg.svd(centered, full_matrices=False)
    return bool(singular[1] > tolerance and np.max(np.abs(centered @ axes[-1])) <= tolerance)


def accessor(document, buffers, index):
    item = document['accessors'][index]
    if 'sparse' in item: raise ValueError('Sparse accessors are unsupported')
    view = document['bufferViews'][item['bufferView']]
    dtype, width = np.dtype(DTYPES[item['componentType']]), WIDTHS[item['type']]
    offset = view.get('byteOffset', 0) + item.get('byteOffset', 0)
    stride = view.get('byteStride', dtype.itemsize * width)
    result = np.ndarray((item['count'], width), dtype=dtype, buffer=buffers[view['buffer']], offset=offset, strides=(stride, dtype.itemsize)).copy()
    return result[:, 0] if width == 1 else result


def node_transform(node):
    if 'matrix' in node: return np.array(node['matrix']).reshape(4, 4).T
    transform = np.eye(4)
    transform[:3, :3] = Rotation.from_quat(node.get('rotation', [0,0,0,1])).as_matrix() @ np.diag(node.get('scale', [1,1,1]))
    transform[:3, 3] = node.get('translation', [0,0,0])
    return transform


def primitives(document, buffers):
    def visit(index, parent):
        node = document['nodes'][index]
        world = parent @ node_transform(node)
        if 'mesh' in node:
            for primitive in document['meshes'][node['mesh']]['primitives']:
                if primitive.get('mode', 4) != 4: continue
                positions = accessor(document, buffers, primitive['attributes']['POSITION'])
                world_positions = positions @ world[:3, :3].T + world[:3, 3]
                indices = accessor(document, buffers, primitive['indices']).reshape(-1, 3)
                yield index, primitive, world_positions, indices, world
        for child in node.get('children', []): yield from visit(child, world)
    for index in document['scenes'][document.get('scene', 0)]['nodes']: yield from visit(index, np.eye(4))
