#!/usr/bin/env python3
"""Validate viewer path JSON geometry, coordinates, and optional physical delays."""
import argparse
import base64
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3] / 'static/visualization/adxx'
SPEED_OF_LIGHT = 299792458.0


def vector(value, context):
    if not isinstance(value, list) or len(value) != 3 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in value):
        raise ValueError(f'{context}: expected three finite coordinates')
    return value


def has_measurement(position, cells, coverage=None):
    x,y=position[:2]
    left,right,bottom,top=coverage['bounds'] if coverage else (-13.,10.,-35.,0.)
    if not left<=x<=right or not bottom<=y<=top:return False
    index=0
    for _ in range(coverage['depth'] if coverage else 6):
        cx,cy=(left+right)/2,(bottom+top)/2
        high_x,high_y=x>cx,y>cy
        index=index*4+int(high_x)+2*int(high_y)
        if high_x:left=cx
        else:right=cx
        if high_y:bottom=cy
        else:top=cy
    return bool(cells[index>>3]&(1<<(index&7)))


def validate_records(records, antennas, column=None, grid=None, coverage_cells=None, coverage=None):
    if not isinstance(records, list): raise ValueError('Expected an array of positions')
    grid = grid or {'rows': 201, 'minX': -15, 'minY': -35, 'step': .1, 'height': 1.07}
    if not isinstance(grid['rows'], int) or grid['rows'] < 1 or not all(math.isfinite(grid[k]) for k in ['minX', 'minY', 'step', 'height']) or grid['step'] <= 0: raise ValueError('Invalid path grid')
    if column is not None and len(records) != grid['rows']: raise ValueError(f"A complete grid column needs {grid['rows']} positions")
    count = 0
    max_depth = 0
    max_delay_error = 0.0
    for row, record in enumerate(records):
        position = vector(record.get('coordinates'), f'row {row}')
        if 'delay_reference_seconds' in record:
            reference = record['delay_reference_seconds']
            if not isinstance(reference, (int, float)) or not math.isfinite(reference) or reference < 0: raise ValueError(f'row {row}: invalid delay reference')
        if column is not None:
            expected = [grid['minX'] + row * grid['step'], grid['minY'] + column * grid['step'], grid['height']]
            if math.dist(position, expected) > 1e-4: raise ValueError(f'row {row}: coordinate/grid mismatch')
        paths = record.get('paths')
        if not isinstance(paths, list): raise ValueError(f'row {row}: missing path array')
        if paths and coverage_cells is not None and not has_measurement(position,coverage_cells,coverage):raise ValueError(f'row {row}: simulated paths without measured coverage')
        for path in paths:
            if 'relative_power_db' in path:
                power = path['relative_power_db']
                if not isinstance(power, (int, float)) or not math.isfinite(power) or power > 1e-4: raise ValueError(f'row {row}: invalid relative path power')
            tx = path.get('tx_index')
            if not isinstance(tx, int) or not 0 <= tx < len(antennas): raise ValueError(f'row {row}: invalid array index')
            source = vector(path.get('source'), f'row {row} source')
            target = vector(path.get('target'), f'row {row} target')
            if math.dist(source, antennas[tx]['location']) > 1e-4: raise ValueError(f'row {row}: source/array mismatch')
            if math.dist(target, position) > 1e-4: raise ValueError(f'row {row}: target/position mismatch')
            vertices = path.get('vertices')
            if not isinstance(vertices, list): raise ValueError(f'row {row}: missing vertices')
            if len(path.get('objects', [])) != len(vertices): raise ValueError(f'row {row}: object/vertex count mismatch')
            for point in vertices: vector(point, f'row {row} reflection')
            if 'delay_seconds' in path:
                points = [source, *vertices, target]
                calculated = sum(math.dist(a, b) for a, b in zip(points, points[1:])) / SPEED_OF_LIGHT
                delay = path['delay_seconds']
                if not isinstance(delay, (int, float)) or not math.isfinite(delay) or delay < 0: raise ValueError(f'row {row}: invalid delay')
                error = abs(calculated - delay)
                if error > 1e-10: raise ValueError(f'row {row}: delay disagrees with geometric length')
                max_delay_error = max(max_delay_error, error)
            max_depth = max(max_depth, len(vertices))
            count += 1
    return {'positions': len(records), 'paths': count, 'maxDepth': max_depth, 'maxDelayErrorSeconds': max_delay_error}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, nargs='?', default=Path.home() / 'Downloads/dichasus-adxx/generated-paths')
    parser.add_argument('--spec', type=Path, default=ROOT / 'data/dataset-spec.json')
    parser.add_argument('--coverage',type=Path,help='Also reject nonempty ray records outside the measured occupancy mask')
    args = parser.parse_args()
    antennas = json.loads(args.spec.read_text())['antennas']
    files = sorted(args.source.glob('paths_*.json')) if args.source.is_dir() else [args.source]
    if not files: raise SystemExit('No path files found')
    generation = (args.source if args.source.is_dir() else args.source.parent) / 'generation.json'
    metadata = json.loads(generation.read_text()) if generation.exists() else {}
    grid = metadata.get('grid')
    cells=None
    coverage=None
    if args.coverage:
        coverage=json.loads(args.coverage.read_text())
        cells=base64.b64decode(coverage['occupancy'],validate=True)
        if not isinstance(coverage['depth'],int) or not 1<=coverage['depth']<=10 or len(cells)!=(4**coverage['depth']+7)//8:raise ValueError('Invalid measured coverage grid')
        if metadata.get('coverageSourceSha256') and metadata['coverageSourceSha256']!=coverage['sourceSha256']:raise ValueError('Paths and measurements belong to different builds')
    total = {'files': 0, 'positions': 0, 'paths': 0, 'maxDepth': 0, 'maxDelayErrorSeconds': 0}
    for file in files:
        column = int(file.stem.split('_')[1]) if file.stem.startswith('paths_') else None
        result = validate_records(json.loads(file.read_bytes()), antennas, column, grid, cells, coverage)
        total['files'] += 1
        for key in ['positions', 'paths']: total[key] += result[key]
        for key in ['maxDepth', 'maxDelayErrorSeconds']: total[key] = max(total[key], result[key])
        if total['files'] % 50 == 0: print(f"Validated {total['files']} files", flush=True)
    print(json.dumps(total, indent=2))


if __name__ == '__main__': main()
