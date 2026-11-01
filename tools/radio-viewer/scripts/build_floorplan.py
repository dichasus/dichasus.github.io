#!/usr/bin/env python3
"""Slice the factory model at robot height to create a small minimap floorplan."""
import argparse
import json
from pathlib import Path
import numpy as np
from pack_models import read_gltf
from model_geometry import primitives

ROOT = Path(__file__).resolve().parents[3] / 'static/visualization/adxx'


def triangle_slice(triangle, height):
    points = []
    for a, b in zip(triangle, np.roll(triangle, -1, axis=0)):
        if (a[1] <= height < b[1]) or (b[1] <= height < a[1]):
            point = a + (b - a) * (height - a[1]) / (b[1] - a[1])
            points.append([float(point[0]), float(-point[2])])
    return points if len(points) == 2 else None


def build(source, output, height=1):
    document, buffers = read_gltf(source)
    lines = set()
    for _, _, positions, indices, _ in primitives(document, buffers):
        for triangle in positions[indices]:
            line = triangle_slice(triangle, height)
            if line is None: continue
            line = tuple(sorted(tuple(round(c,3) for c in p) for p in line))
            if line[0] != line[1]: lines.add(line)
    output.write_text(json.dumps({'height':height,'segments':sorted(lines)}, separators=(',', ':'))+'\n')
    print(f'{len(lines)} floorplan segments: {output.stat().st_size} bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT/'ARENA2036.gltf')
    parser.add_argument('--output', type=Path, default=ROOT/'data/floorplan.json')
    args = parser.parse_args()
    build(args.source,args.output)
