#!/usr/bin/env python3
"""Rebuild the measured-channel grid from current adxx CSI and REFTX offsets.

Large intermediate files stay beside the downloaded recordings. The numerical
pipeline follows BuildRadiationQuadtree.ipynb, with bounded working memory,
explicit invalid-record handling, and reproducible provenance.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor
from collections import deque
import hashlib
import json
import os
import platform
import sys
from pathlib import Path
import tempfile
import time

import numpy as np

BOUNDS = (-13., 10., -35., 0.)
DEPTH = 6
TAPS = 30
SHAPE = (4, 2, 8, TAPS)


def configure_grid(bounds, depth, shape=None):
    global BOUNDS, DEPTH, SHAPE
    if len(bounds) != 4 or not np.isfinite(bounds).all() or bounds[0] >= bounds[1] or bounds[2] >= bounds[3]:
        raise ValueError('Expected finite ordered grid bounds')
    if not isinstance(depth, int) or not 1 <= depth <= 10:
        raise ValueError('Grid depth must be between 1 and 10')
    BOUNDS, DEPTH = tuple(bounds), depth
    if shape is not None:
        if len(shape) != 4 or np.prod(shape[:3]) != 64 or shape[-1] != TAPS:
            raise ValueError("Expected 64 antennas and 30 delay taps")
        SHAPE = tuple(shape)


def position_bin(position, bounds=None, depth=None):
    x, y = position[:2]
    left, right, bottom, top = BOUNDS if bounds is None else bounds
    depth = DEPTH if depth is None else depth
    if not np.isfinite(position).all() or not left <= x <= right or not bottom <= y <= top:
        return None
    index = 0
    for _ in range(depth):
        cx, cy = (left + right) / 2, (bottom + top) / 2
        high_x, high_y = x > cx, y > cy
        index = index * 4 + int(high_x) + 2 * int(high_y)
        if high_x: left = cx
        else: right = cx
        if high_y: bottom = cy
        else: top = cy
    return index


def bin_center(index):
    left, right, bottom, top = BOUNDS
    for level in range(DEPTH - 1, -1, -1):
        digit = (index // 4**level) % 4
        cx, cy = (left + right) / 2, (bottom + top) / 2
        if digit & 1: left = cx
        else: right = cx
        if digit & 2: bottom = cy
        else: top = cy
    return np.array([(left + right) / 2, (bottom + top) / 2])


def calibration_matrix(offsets, size=1024):
    sto, cpo = np.asarray(offsets['sto']), np.asarray(offsets['cpo'])
    if sto.shape != (64,) or cpo.shape != (64,) or not np.isfinite(sto).all() or not np.isfinite(cpo).all():
        raise ValueError('Expected 64 finite STO and CPO offsets')
    return np.exp(1j * (sto[:, None] * 2 * np.pi * np.arange(size) / size + cpo[:, None])).astype(np.complex64)


def calibrated_taps(raw, correction, assignments):
    """Raw subcarrier order -> common STO removal -> REFTX -> ordered CIR."""
    csi = np.fft.fftshift(raw[..., 0] + 1j * raw[..., 1], axes=-1)
    slope = np.angle(np.sum(csi[..., 1:] * csi[..., :-1].conj(), axis=(-2, -1)))
    csi *= np.exp(-1j * slope[..., None, None] * np.arange(1024))
    csi *= correction
    cir = np.fft.fftshift(np.fft.ifft(np.fft.fftshift(csi, axes=-1), axis=-1), axes=-1)[..., 505:535]
    return cir[..., assignments, :].astype(np.complex64)


def estimate_delay(channel):
    """Forward/backward root-MUSIC with fitted-power selection on array A0."""
    covariance = np.einsum('rms,rmt->st', channel[0], channel[0].conj())
    covariance = (covariance + np.flip(covariance.conj(), axis=(0, 1))) / 2
    eigenvalues, vectors = np.linalg.eigh(covariance)
    eigenvalues, vectors = eigenvalues[::-1].real, vectors[:, ::-1]
    if eigenvalues[0] <= 0 or not np.isfinite(eigenvalues).all(): return None
    values = np.maximum(eigenvalues[:TAPS // 2], eigenvalues[0] * 1e-12)
    count = len(values)
    mdl = []
    for k in range(count):
        tail = values[k:]
        mdl.append(-10 * (count - k) * (np.log(tail).mean() - np.log(tail.mean())) + .25 * k * (2 * count - k + 1) * np.log(10))
    sources = int(np.argmin(mdl))
    if not sources: return None
    noise = vectors[:, sources:]
    projection = noise @ noise.conj().T
    coefficients = np.array([np.trace(projection, offset=i) for i in range(1, TAPS)])
    roots = np.roots(np.r_[coefficients[::-1], np.trace(projection), coefficients.conj()])
    roots = roots[np.abs(roots) < 1]
    if not len(roots): return None
    roots = roots[np.argsort(np.abs(roots))[::-1]][:sources]
    delays = -TAPS * np.angle(roots) / (2 * np.pi)
    # Root proximity to the unit circle measures estimation confidence, not
    # received power. Fit path amplitudes before rejecting weak arrivals.
    steering = np.exp(-1j * 2 * np.pi * np.arange(TAPS)[:, None] * delays / TAPS)
    amplitudes = np.linalg.lstsq(steering, channel[0].reshape(-1, TAPS).T, rcond=1e-6)[0]
    powers = np.mean(np.abs(amplitudes) ** 2, axis=1)
    strongest = np.argsort(powers)[::-1][:5]
    significant = strongest[powers[strongest] >= powers.max() * .01]
    return float(np.min(delays[significant])) if len(significant) else None


def align_batch(task):
    positions, taps = task
    output = []
    rejected = 0
    for position, cir in zip(positions, taps):
        index = position_bin(position)
        if index is None: continue
        if not np.isfinite(cir).all():
            rejected += 1
            continue
        spectrum = np.fft.fftshift(np.fft.fft(np.fft.fftshift(cir, axes=-1), axis=-1), axes=-1)
        delay = estimate_delay(spectrum)
        if delay is None:
            rejected += 1
            continue
        shift = -delay - TAPS // 2 + 8
        spectrum *= np.exp(-1j * 2 * np.pi * shift / TAPS * np.arange(-TAPS // 2, TAPS // 2))
        aligned = np.fft.fftshift(np.fft.ifft(np.fft.fftshift(spectrum, axes=-1), axis=-1), axes=-1)
        output.append((index, aligned.astype('<c8'), position))
    return output, rejected


def interpolate_bin(channels, iterations=10):
    """Phase-aligned spatial average independently for each array and delay tap."""
    # [record,array,row,column,tap] -> [array,tap,record,antenna]
    arrays, rows, columns, _ = channels.shape[1:]
    samples = channels.transpose(1, 4, 0, 2, 3).reshape(arrays, TAPS, len(channels), rows * columns)
    phase = np.zeros(samples.shape[:-1], dtype=np.float32)
    for _ in range(iterations):
        average = np.mean(np.exp(-1j * phase)[..., None] * samples, axis=2)
        phase = np.angle(np.einsum('ati,atni->atn', average.conj(), samples))
    cir = average.reshape(arrays, TAPS, rows, columns).transpose(0, 2, 3, 1)
    return np.fft.fft(np.fft.fftshift(cir, axes=-1), axis=-1).astype('<c8')


def digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def record_batches(path, batch_size, limit):
    import tensorflow as tf
    def parse(proto):
        fields = tf.io.parse_single_example(proto, {'csi': tf.io.FixedLenFeature([], tf.string), 'pos-tachy': tf.io.FixedLenFeature([], tf.string)})
        return tf.ensure_shape(tf.io.parse_tensor(fields['csi'], tf.float32), (64, 1024, 2)), tf.ensure_shape(tf.io.parse_tensor(fields['pos-tachy'], tf.float64), (3,))
    dataset = tf.data.TFRecordDataset(str(path))
    if limit: dataset = dataset.take(limit)
    options = tf.data.Options()
    options.threading.private_threadpool_size = 2
    dataset = dataset.with_options(options).map(parse, num_parallel_calls=2).batch(batch_size).prefetch(1)
    for csi, position in dataset: yield csi.numpy(), position.numpy()


def bounded_map(pool, function, tasks, capacity):
    """Backpressure without requiring Python 3.14 Executor.map(buffersize)."""
    iterator = iter(tasks)
    pending = deque()
    for _ in range(capacity):
        try: pending.append(pool.submit(function, next(iterator)))
        except StopIteration: break
    while pending:
        yield pending.popleft().result()
        try: pending.append(pool.submit(function, next(iterator)))
        except StopIteration: pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset-dir', type=Path, default=Path.home() / 'Downloads/dichasus-adxx')
    parser.add_argument('--spec', type=Path, help='Dataset specification including configuration variants')
    parser.add_argument('--routes', nargs='+', default=['ad07', 'ad08', 'ad10', 'ad11', 'ad18', 'ad19'])
    parser.add_argument('--bounds', type=float, nargs=4, default=[-70, 10, -35, 0], metavar=('MIN_X', 'MAX_X', 'MIN_Y', 'MAX_Y'))
    parser.add_argument('--depth', type=int, default=7)
    parser.add_argument('--reference-gain', type=float, default=67, help='Normalize recorded RX gains to this reference in dB')
    parser.add_argument('--output', type=Path, default=Path.home() / 'Downloads/dichasus-adxx/processed/quadtree.bin')
    parser.add_argument('--workers', type=int, default=min(8, os.cpu_count() or 1))
    parser.add_argument('--limit', type=int, help='Development subset per route; recorded in provenance')
    args = parser.parse_args()
    if args.workers < 1 or (args.limit is not None and args.limit < 1): parser.error('workers and limit must be positive')
    if args.output.exists(): parser.error('Output exists; choose a new output path')
    configure_grid(args.bounds, args.depth)
    directory = args.dataset_dir.expanduser()
    spec_path = args.spec or directory / 'spec.json'
    spec = json.loads(spec_path.read_text())
    assignments = np.array([a['assignments'] for a in spec['antennas']])
    if assignments.ndim != 3 or sorted(assignments.ravel()) != list(range(64)): raise ValueError('Invalid antenna assignments')
    configure_grid(args.bounds, args.depth, (*assignments.shape, TAPS))
    variants = {Path(record['filename']).name:record['configurationVariant'] for record in spec['tfrecords']}
    selected_variants = {variants.get(f'dichasus-{route}.tfrecords') for route in args.routes}
    if None in selected_variants:
        raise ValueError('A selected recording has no configuration metadata')
    if len(selected_variants) > 1 and not all(name.startswith(('no-wall-', 'no-walls-')) for name in selected_variants):
        raise ValueError('Do not mix recordings with and without the reflector wall')
    variant_details = spec['configuration']['variants']
    gains = {name: float(variant_details[name]['rxgain']) for name in selected_variants}
    if not np.isfinite([args.reference_gain, *gains.values()]).all():
        raise ValueError('Receiver gains must be finite')
    files = [(directory / f'dichasus-{route}.tfrecords', directory / f'reftx-offsets-dichasus-{route}.json') for route in args.routes]
    for pair in files:
        for path in pair:
            if not path.is_file(): raise FileNotFoundError(path)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    manifest = {'pythonVersion': platform.python_version(), 'numpyVersion': np.__version__, 'routes': args.routes, 'configurationVariant': next(iter(selected_variants)) if len(selected_variants) == 1 else 'no-wall-gain-normalized', 'configurationVariants': sorted(selected_variants), 'referenceGainDb': args.reference_gain, 'limitPerRoute': args.limit, 'bounds': BOUNDS, 'depth': DEPTH, 'shape': SHAPE, 'dtype': 'complex64-le', 'sourceBandwidthHz': spec['bandwidth'], 'viewerBandwidthHz': 50000000, 'alignment': 'A0 forward/backward root-MUSIC; earliest of up to five strongest fitted paths within 20 dB of peak; first arrival at tap 8', 'aggregation': '10 phase-aligned iterations independently per array and delay tap', 'specSha256': digest(spec_path), 'scriptSha256': digest(Path(__file__)), 'sources': []}
    counts = np.zeros(4 ** DEPTH, dtype=np.uint32)
    sample_positions = np.full((4 ** DEPTH, 3), np.nan)
    sample_channels = np.zeros((4 ** DEPTH, *SHAPE), dtype='<c8')
    sample_distances = np.full(4 ** DEPTH, np.inf)
    sample_routes = np.full(4 ** DEPTH, -1, dtype=np.int16)
    centers = np.array([bin_center(index) for index in range(4 ** DEPTH)])
    import multiprocessing
    with tempfile.TemporaryDirectory(prefix='channel-stage-', dir=directory) as temporary, ProcessPoolExecutor(args.workers, mp_context=multiprocessing.get_context('spawn'), initializer=configure_grid, initargs=(args.bounds, args.depth, SHAPE)) as pool:
        stage = Path(temporary)
        for route_index, (path, offsets_path) in enumerate(files):
            correction = calibration_matrix(json.loads(offsets_path.read_text()))
            variant = variants[path.name]
            amplitude_scale = 10 ** ((args.reference_gain - gains[variant]) / 20)
            stats = {'file': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path), 'offsets': offsets_path.name, 'offsetsSha256': digest(offsets_path), 'processed': 0, 'accepted': 0, 'rejectedAlignment': 0, 'configurationVariant': variant, 'rxGainDb': gains[variant], 'amplitudeScale': amplitude_scale}
            def tasks():
                for raw, positions in record_batches(path, 32, args.limit):
                    stats['processed'] += len(raw)
                    yield positions, calibrated_taps(raw, correction, assignments) * amplitude_scale
            for records, rejected in bounded_map(pool, align_batch, tasks(), args.workers * 2):
                stats['rejectedAlignment'] += rejected
                for index, cir, position in records:
                    with (stage / f'{index}.bin').open('ab') as stream: stream.write(cir.tobytes())
                    counts[index] += 1
                    distance = np.sum((position[:2] - centers[index]) ** 2)
                    if distance < sample_distances[index]:
                        sample_distances[index] = distance
                        sample_positions[index] = position
                        sample_channels[index] = np.fft.fft(np.fft.fftshift(cir, axes=-1), axis=-1)
                        sample_routes[index] = route_index
                stats['accepted'] += len(records)
                if stats['processed'] % 1024 < 32: print(f"{path.name}: {stats['processed']} read, {stats['accepted']} aligned", flush=True)
            stats['outsideBounds'] = stats['processed'] - stats['accepted'] - stats['rejectedAlignment']
            manifest['sources'].append(stats)
            print(stats, flush=True)
        temporary_output = args.output.with_suffix('.bin.part')
        with temporary_output.open('xb') as output:
            for index, count in enumerate(counts):
                channel = interpolate_bin(np.fromfile(stage / f'{index}.bin', dtype='<c8').reshape(int(count), *SHAPE)) if count else np.zeros(SHAPE, dtype='<c8')
                output.write(channel.tobytes())
        os.replace(temporary_output, args.output)
    sample_file = args.output.with_suffix('.samples.npz')
    valid = counts > 0
    np.savez_compressed(sample_file, bins=np.flatnonzero(valid), positions=sample_positions[valid], spectrum=sample_channels[valid], routes=sample_routes[valid])
    manifest['tensorflowVersion'] = sys.modules['tensorflow'].__version__
    manifest['calibrationSamples'] = {'file': sample_file.name, 'sha256': digest(sample_file), 'selection': 'One actual aligned measurement nearest each occupied cell center; positions retain the recorded prism height'}
    manifest.update({'validBins': int(np.count_nonzero(counts)), 'recordsPerBin': counts.tolist(), 'outputSha256': digest(args.output), 'elapsedSeconds': time.monotonic() - started})
    args.output.with_suffix('.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"Built {args.output}: {manifest['validBins']} measured cells", flush=True)


if __name__ == '__main__': main()
