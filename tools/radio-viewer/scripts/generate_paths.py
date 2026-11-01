#!/usr/bin/env python3
"""Generate viewer-compatible geometric propagation paths with Sionna RT 2.2.

The supplied scene has visual diffuse materials, not measured RF materials.
This exporter explicitly assigns one configurable ITU material to those meshes.
Outputs include this assumption and all solver settings in a manifest.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3] / 'static/visualization/adxx'


def prepare_scene_xml(scene_path, material):
    tree = ET.parse(scene_path)
    root = tree.getroot()
    materials = {node.get('id') for node in root.findall('bsdf')}
    for node in root.findall('bsdf'):
        root.remove(node)
    bsdf = ET.Element('bsdf', {'type': 'twosided', 'id': f'mat-{material}'})
    ET.SubElement(bsdf, 'bsdf', {'type': 'diffuse'})
    root.insert(0, bsdf)
    for node in root.iter('ref'):
        if node.get('id') in materials: node.set('id', f'mat-{material}')
    for node in root.iter('string'):
        if node.get('name') == 'filename':
            path = (scene_path.parent / node.get('value')).resolve()
            if not path.is_file(): raise FileNotFoundError(path)
            node.set('value', str(path))
    return ET.tostring(root, encoding='unicode')


def serialize_paths(paths, positions, antennas, minimum_relative_db=None, object_id_map=None):
    """Export synthetic-array paths; Sionna axes are [RX, TX, path]."""
    import numpy as np
    valid = paths.valid.numpy()
    vertices = paths.vertices.numpy()
    objects = paths.objects.numpy()
    delays = paths.tau.numpy()
    if valid.ndim != 3 or valid.shape[:2] != (len(positions), len(antennas)):
        raise ValueError(f'Unexpected Sionna path shape: {valid.shape}; synthetic arrays are required')
    relative_db = None
    reference_delays = None
    if minimum_relative_db is not None:
        amplitudes, _ = paths.cir(normalize_delays=False, out_type='numpy')
        power = np.mean(np.abs(amplitudes[..., 0]) ** 2, axis=(1, 3))
        if power.shape != valid.shape: raise ValueError('Unexpected path amplitude shape')
        if not np.isfinite(power[valid]).all(): raise ValueError('Non-finite active path power')
        power = np.where(valid, power, 0)
        peak = power.max(axis=-1, keepdims=True) if power.shape[-1] else power
        relative_db = 10 * np.log10(np.maximum(power, 1e-30) / np.maximum(peak, 1e-30))
        reference_delays = []
        for rx, position in enumerate(positions):
            significant = valid[rx, 0] & (power[rx, 0] > 0) & (relative_db[rx, 0] >= -20)
            reference_delays.append(float(delays[rx, 0, significant].min()) if significant.any() else float(np.linalg.norm(np.array(position) - antennas[0]['location']) / 299792458.))
        valid = valid & (power > 0) & (relative_db >= minimum_relative_db)
    result = []
    for rx, position in enumerate(positions):
        record = {'coordinates': list(position), 'paths': []}
        if reference_delays is not None: record['delay_reference_seconds'] = reference_delays[rx]
        for tx, antenna in enumerate(antennas):
            for path_index in np.flatnonzero(valid[rx, tx]):
                ids = objects[:, rx, tx, path_index]
                mask = ids != np.iinfo(np.uint32).max
                points = vertices[:, rx, tx, path_index][mask]
                if not np.isfinite(points).all(): raise ValueError('Non-finite reflection vertex')
                record['paths'].append({
                    'path_index': int(path_index),
                    'tx_index': tx,
                    'rx_index': 0,
                    'source': antenna['location'],
                    'target': list(position),
                    'vertices': points.tolist(),
                    'objects': [object_id_map[int(value)] for value in ids[mask]] if object_id_map is not None else ids[mask].astype(int).tolist(),
                    'delay_seconds': float(delays[rx, tx, path_index]),
                })
                if relative_db is not None: record['paths'][-1]['relative_power_db'] = round(float(relative_db[rx, tx, path_index]), 5)
        result.append(record)
    return result


def atomic_json(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, separators=(',', ':'), allow_nan=False) + '\n')
    temporary.replace(path)


def resume_manifest(previous, current, directory):
    """Resume only outputs whose bytes and complete generation settings match."""
    for key in set(previous) | set(current):
        if key != 'outputs' and previous.get(key) != current.get(key):
            raise ValueError(f'Cannot resume: {key} differs')
    seen = set()
    for item in previous['outputs']:
        name = item['file']
        if Path(name).name != name or name in seen: raise ValueError('Invalid checkpoint output name')
        seen.add(name)
        output = directory / name
        if not output.is_file() or hashlib.sha256(output.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError(f'Cannot resume: {name} is missing or changed')
    current['outputs'] = previous['outputs']
    return seen


def run(args):
    # Do not place compiler caches or plotting configuration in the dataset tree.
    os.environ.setdefault('DRJIT_CACHE_DIR', str(Path(tempfile.gettempdir()) / 'dichasus-drjit-cache'))
    os.environ.setdefault('MPLCONFIGDIR', str(Path(tempfile.gettempdir()) / 'dichasus-mpl'))
    import numpy as np
    import mitsuba as mi
    mi.set_variant('llvm_ad_mono_polarized' if args.backend == 'cpu' else 'cuda_ad_mono_polarized')
    from sionna.rt import PlanarArray, Transmitter, Receiver, PathSolver, ITURadioMaterial
    from rt_scene import array_orientation, material_kind
    from sionna.rt.scene import load_scene_from_string
    spec = json.loads(args.spec.read_text())
    antennas = spec['antennas']
    selected = None
    selection_hash = None
    if args.comparison:
        report = json.loads(args.comparison.read_text())
        if report['sceneSha256'] != hashlib.sha256(args.scene.read_bytes()).hexdigest() or report['specSha256'] != hashlib.sha256(args.spec.read_bytes()).hexdigest(): raise ValueError('Comparison scene/specification does not match exporter inputs')
        if report['assumptions']['prismOffsetMeters'] is not None: raise ValueError('A prism-offset comparison cannot supply heights for unsurveyed grid positions')
        selected = next(item for item in report['candidates'] if item['settings']['name'] == report['selectedByTraining'])
        if selected['scores'] is None: raise ValueError('Cannot export a failed comparison candidate')
        selected = selected['settings']
        if args.max_depth is None: args.max_depth = selected['depth']
        args.samples, args.seed = selected['samples'], selected['seed']
        args.height = report['assumptions']['mobileHeightMeters']
        selection_hash = hashlib.sha256(args.comparison.read_bytes()).hexdigest()
    if args.max_depth is None: args.max_depth = 3
    xml = prepare_scene_xml(args.scene.resolve(), args.material)
    scene = load_scene_from_string(xml, merge_shapes=False)
    scene.frequency = spec['frequency']
    # Array-center rays are sufficient for the geometric viewer. No per-element
    # channel prediction or calibrated received-power claim is made here.
    for name in ['tx_array', 'rx_array']:
        setattr(scene, name, PlanarArray(num_rows=1, num_cols=1, vertical_spacing=0.5, horizontal_spacing=0.5, pattern='iso', polarization='V'))
    if selected or args.semantic_materials:
        spacing = antennas[0]['spacingX'] / (299792458. / spec['frequency'])
        scene.tx_array = PlanarArray(num_rows=len(antennas[0]['assignments']), num_cols=len(antennas[0]['assignments'][0]), horizontal_spacing=spacing, vertical_spacing=spacing, pattern=selected.get('pattern', 'iso') if selected else 'tr38901', polarization='V')
        materials = {kind: ITURadioMaterial(name=f'export-{kind}', itu_type=kind, scattering_coefficient=selected['scattering'] if selected else 0) for kind in ['concrete', 'metal', 'glass', 'wood', 'plasterboard']}
        for material in materials.values(): scene.add(material)
        for name, obj in scene.objects.items(): obj.radio_material = materials[material_kind(name, selected['semantic'] if selected else True)]
    for index, antenna in enumerate(antennas):
        scene.add(Transmitter(name=f'array_{index}', position=antenna['location'], orientation=array_orientation(antenna)))
    solver = PathSolver(deterministic=True)
    solver_settings = dict(max_depth=args.max_depth, samples_per_src=args.samples, max_num_paths_per_src=args.max_paths, synthetic_array=True, los=True, specular_reflection=True, diffuse_reflection=False, refraction=False, seed=args.seed)
    if selected:
        solver_settings.update(diffuse_reflection=selected['scattering'] > 0, diffraction=selected.get('diffraction', False), edge_diffraction=selected.get('diffraction', False))
    measured = None
    if args.coverage:
        import base64
        coverage = json.loads(args.coverage.read_text())
        if not isinstance(coverage['depth'], int) or not 1 <= coverage['depth'] <= 10: raise ValueError('Invalid coverage depth')
        measured = base64.b64decode(coverage['occupancy'], validate=True)
        if len(measured) != (4 ** coverage['depth'] + 7) // 8: raise ValueError('Invalid coverage mask')
    min_x = args.min_x if args.min_x is not None else (coverage['bounds'][0] if args.coverage else -15)
    max_x = args.max_x if args.max_x is not None else (coverage['bounds'][1] if args.coverage else 10)
    if not np.isfinite([min_x, max_x]).all() or min_x >= max_x: raise ValueError('Invalid path grid bounds')
    min_y = args.min_y if args.min_y is not None else (coverage['bounds'][2] if args.coverage else -35)
    max_y = args.max_y if args.max_y is not None else (coverage['bounds'][3] if args.coverage else 0)
    if not np.isfinite([min_y, max_y, args.step]).all() or min_y >= max_y or args.step <= 0:
        raise ValueError('Invalid path grid bounds or spacing')
    columns = round((max_y - min_y) / args.step) + 1
    if args.all_columns: args.columns = list(range(columns))
    if any(column < 0 or column >= columns for column in args.columns): raise ValueError('Column outside path grid')
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / 'generation.json'
    stable_names = {str(index): name for index, name in enumerate(sorted(scene.objects))}
    object_id_map = {int(scene.objects[name].object_id): int(index) for index, name in stable_names.items()}
    output_names = ['sample.json'] if args.point else [f'paths_{column}.json' for column in args.columns]
    if not args.overwrite and not args.resume:
        existing = [path for path in [manifest_path, *(args.output / name for name in output_names)] if path.exists()]
        if existing: raise FileExistsError(f'{existing[0]} already exists; use a new output directory or --overwrite')
    manifest = {
        'format': 'dichasus-geometric-paths-v1',
        'sionnaRtVersion': importlib.metadata.version('sionna-rt'),
        'pythonVersion': platform.python_version(),
        'backend': args.backend,
        'sceneSha256': hashlib.sha256(args.scene.read_bytes()).hexdigest(),
        'meshSha256': {node.get('value'): hashlib.sha256((args.scene.parent / node.get('value')).read_bytes()).hexdigest() for node in ET.parse(args.scene).getroot().iter('string') if node.get('name') == 'filename'},
        'implementationSha256': {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in ['generate_paths.py', 'rt_scene.py', 'build_channels.py']},
        'datasetSpecSha256': hashlib.sha256(args.spec.read_bytes()).hexdigest(),
        'frequencyHz': spec['frequency'],
        'materialAssumption': f'All scene surfaces use {args.material}; not measured RF material assignments.',
        'comparisonSha256': selection_hash,
        'selectedSettings': selected,
        'minimumRelativePowerDb': args.min_relative_power_db,
        'coverageSha256': hashlib.sha256(args.coverage.read_bytes()).hexdigest() if args.coverage else None,
        'coverageSourceSha256': coverage.get('sourceSha256') if args.coverage else None,
        'direction': 'Fixed array centers to mobile transmitter; geometric reciprocity.',
        'solver': solver_settings,
        'deterministic': True,
        'batchSize': args.batch_size,
        'point': args.point,
        'objectNames': stable_names,
        'grid': {'minX': min_x, 'minY': min_y, 'step': args.step, 'rows': round((max_x - min_x) / args.step) + 1, 'columns': columns, 'height': args.height},
        'outputs': [],
    }
    if args.semantic_materials: manifest['materialAssumption'] = 'Name-based concrete, plasterboard, glass, wood and metal hypotheses; not measured RF properties.'
    if selected: manifest['materialAssumption'] = 'Name-based material hypotheses from comparison; not measured RF material assignments.' if selected['semantic'] else 'All surfaces use ITU concrete; not measured RF material assignments.'
    completed = resume_manifest(json.loads(manifest_path.read_text()), manifest, args.output) if args.resume else set()
    atomic_json(manifest_path, manifest)
    jobs = [('sample.json', [[args.point[0], args.point[1], args.height]])] if args.point else [
        (f'paths_{column}.json', [[round(min_x + row * args.step, 10), round(min_y + column * args.step, 10), args.height] for row in range(manifest['grid']['rows'])])
        for column in args.columns
    ]
    for filename, positions in jobs:
        if filename in completed:
            print(f'Checkpoint verified: {filename}', flush=True)
            continue
        output = args.output / filename
        if output.exists() and not args.overwrite: raise FileExistsError(output)
        started = time.monotonic()
        records = [{'coordinates': position, 'paths': []} for position in positions]
        from build_channels import position_bin
        indices = [index for index, position in enumerate(positions) if measured is None or ((cell := position_bin(position, coverage['bounds'], coverage['depth'])) is not None and measured[cell >> 3] & (1 << (cell & 7)))]
        for first in range(0, len(indices), args.batch_size):
            batch_indices = indices[first:first + args.batch_size]
            batch = [positions[index] for index in batch_indices]
            names = []
            for index, position in enumerate(batch):
                name = f'robot_{index}'
                scene.add(Receiver(name=name, position=position))
                names.append(name)
            try:
                paths = solver(scene, **solver_settings)
                for index, record in zip(batch_indices, serialize_paths(paths, batch, antennas, args.min_relative_power_db, object_id_map)): records[index] = record
            finally:
                for name in names: scene.remove(name)
            print(f'{filename}: {min(first + args.batch_size, len(indices))}/{len(indices)} measured positions', flush=True)
        atomic_json(output, records)
        info = {'file': filename, 'positions': len(records), 'paths': sum(len(row['paths']) for row in records), 'seconds': round(time.monotonic() - started, 3), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}
        manifest['outputs'].append(info)
        atomic_json(manifest_path, manifest)
        print(json.dumps(info), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scene', type=Path, default=Path(__file__).resolve().parents[1] / 'scene/arena2036_complex.xml')
    parser.add_argument('--spec', type=Path, default=ROOT / 'data/dataset-spec.json')
    parser.add_argument('--output', type=Path, default=Path.home() / 'Downloads/dichasus-adxx/generated-paths')
    parser.add_argument('--point', type=float, nargs=2, metavar=('X', 'Y'), help='Export a single location to sample.json')
    parser.add_argument('--columns', type=int, nargs='+', default=[275], help='Zero-based grid columns to export')
    parser.add_argument('--all-columns', action='store_true', help='Export every column in the coverage bounds')
    parser.add_argument('--max-depth', type=int, help='Override the reflection depth, including when using a comparison report')
    parser.add_argument('--samples', type=int, default=200000)
    parser.add_argument('--max-paths', type=int, default=500000)
    parser.add_argument('--batch-size', type=int, default=8)
    parser.add_argument('--seed', type=int, default=41)
    parser.add_argument('--backend', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--material', default='itu_concrete', choices=['itu_concrete', 'itu_brick', 'itu_wood', 'itu_glass', 'itu_metal'])
    parser.add_argument('--comparison', type=Path, help='Use the selected settings and height from a completed comparison report')
    parser.add_argument('--coverage', type=Path, help='Coverage manifest; retain empty records and skip tracing unmeasured cells')
    parser.add_argument('--semantic-materials', action='store_true', help='Assign ITU materials by mesh name and use the surveyed array layout')
    parser.add_argument('--min-y', type=float)
    parser.add_argument('--max-y', type=float)
    parser.add_argument('--step', type=float, default=.1)
    parser.add_argument('--height', type=float, default=1.07)
    parser.add_argument('--min-x', type=float, help='Western edge; defaults to measured coverage')
    parser.add_argument('--max-x', type=float, help='Eastern edge; defaults to measured coverage')
    parser.add_argument('--min-relative-power-db', type=float, help='Omit paths weaker than this threshold relative to each array link peak')
    parser.add_argument('--overwrite', action='store_true')
    parser.add_argument('--resume', action='store_true', help='Resume a matching generation manifest after verifying completed output hashes')
    args = parser.parse_args()
    args.columns = [] if args.all_columns else list(dict.fromkeys(args.columns))
    if args.overwrite and args.resume: parser.error('Choose either --overwrite or --resume')
    if args.point and args.all_columns: parser.error('Choose either --point or --all-columns')
    if any(value < 0 for value in args.columns): parser.error('columns must be nonnegative')
    if (args.max_depth is not None and args.max_depth < 0) or args.samples < 1 or args.max_paths < 1 or args.batch_size < 1: parser.error('solver counts must be positive, and max-depth nonnegative')
    if args.point and not all(__import__('math').isfinite(value) for value in args.point): parser.error('point coordinates must be finite')
    if not __import__('math').isfinite(args.height): parser.error('height must be finite')
    if args.min_relative_power_db is not None and (not __import__('math').isfinite(args.min_relative_power_db) or args.min_relative_power_db > 0): parser.error('relative power threshold must be finite and nonpositive')
    run(args)


if __name__ == '__main__': main()
