"""Shared array orientation and explicitly hypothetical RF material groups."""
import numpy as np
from scipy.spatial.transform import Rotation


def array_orientation(antenna):
    # Local Sionna axes: X=boresight, Y=right, Z=up. Dataset vectors are
    # rounded, so orthonormalize without changing their handedness.
    right=np.array(antenna['rightvector'],dtype=float)
    right/=np.linalg.norm(right)
    up=np.array(antenna['upvector'],dtype=float)
    up-=right*np.dot(up,right)
    up/=np.linalg.norm(up)
    normal=np.cross(right,up)
    return Rotation.from_matrix(np.column_stack((normal,right,up))).as_euler('ZYX')


def material_kind(name,semantic):
    if not semantic:return 'concrete'
    name=name.lower()
    if 'window' in name:return 'glass'
    if any(word in name for word in ['container','metal','crane','beam','pillar','framework','shelf','locker','barrier','roll-up','roof']):return 'metal'
    if 'table' in name:return 'wood'
    return 'concrete'

