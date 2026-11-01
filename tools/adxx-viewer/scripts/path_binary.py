"""Lossless binary encoding for generated synthetic-array path records.

Header: DICHPTH1, u16 records, u8 sources, u8 reserved, source xyz f64 triples.
Record: xyz f64, u8 flags, u32 paths, optional f64 delay reference.
Path: u32 index, u8 tx/rx/vertices/flags, optional f64 delay/power,
then vertex xyz f32 and object u32. All fields are little-endian.
"""
import math
import struct


def encode(records, antennas):
    if len(records)>65535 or len(antennas)!=4:raise ValueError('Unsupported binary path counts')
    result=bytearray(struct.pack('<8sHBB',b'DICHPTH1',len(records),len(antennas),0))
    sources=[antenna['location'] for antenna in antennas]
    for source in sources:result.extend(struct.pack('<3d',*source))
    for record in records:
        if set(record)-{'coordinates','paths','delay_reference_seconds'}:raise ValueError('Unsupported record fields; use JSON')
        reference='delay_reference_seconds' in record
        result.extend(struct.pack('<3dBI',*record['coordinates'],int(reference),len(record['paths'])))
        if reference:result.extend(struct.pack('<d',record['delay_reference_seconds']))
        for path in record['paths']:
            if set(path)-{'path_index','tx_index','rx_index','source','target','vertices','objects','delay_seconds','relative_power_db'} or path['rx_index']!=0:raise ValueError('Unsupported path fields; use JSON')
            if path['source']!=sources[path['tx_index']] or path['target']!=record['coordinates']:raise ValueError('Binary paths require exact array sources and record targets; use JSON for legacy coordinates')
            if len(path['vertices'])!=len(path['objects']) or len(path['vertices'])>255:raise ValueError('Unsupported path vertices')
            flags=int('delay_seconds' in path)|(int('relative_power_db' in path)<<1)
            result.extend(struct.pack('<IBBBB',path['path_index'],path['tx_index'],path['rx_index'],len(path['vertices']),flags))
            if flags&1:result.extend(struct.pack('<d',path['delay_seconds']))
            if flags&2:result.extend(struct.pack('<d',path['relative_power_db']))
            for point,object_id in zip(path['vertices'],path['objects']):
                packed=struct.pack('<3f',*point)
                if tuple(point)!=struct.unpack('<3f',packed) or not all(math.isfinite(value) for value in point):raise ValueError('Vertex is not losslessly representable as float32; use JSON')
                result.extend(packed)
                result.extend(struct.pack('<I',object_id))
    return bytes(result)
