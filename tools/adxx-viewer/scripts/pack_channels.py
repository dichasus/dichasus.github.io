#!/usr/bin/env python3
"""Publish small lossless CSI chunks for ordinary static hosts, without HTTP Range."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[3] / 'static/visualization/adxx'
BYTES_PER_BIN = 4 * 2 * 8 * 30 * 8
BINS = 4096
BLOCK_BINS = 1



def publish_grid_config(output):
    """Keep browser grid constants derived from the two published manifests."""
    coverage_path = output / 'coverage.json'
    if not coverage_path.is_file():
        return
    coverage = json.loads(coverage_path.read_text())
    min_x, max_x, min_y, max_y = coverage['bounds']
    config = dict(depth=coverage['depth'], minX=min_x, maxX=max_x, minY=min_y, maxY=max_y, pathMinX=min_x, pathMaxX=max_x, pathMinY=min_y, pathMaxY=max_y, pathStep=.1)
    config['channelVersion'] = hashlib.sha256(coverage_path.read_bytes()).hexdigest()[:24]
    path_index = output / 'path-chunks.json.gz'
    if path_index.is_file():
        paths = json.loads(gzip.decompress(path_index.read_bytes()))
        config['pathVersion'] = hashlib.sha256(path_index.read_bytes()).hexdigest()[:24]
        if paths.get('measurementSourceSha256') == coverage['sourceSha256']:
            config.update(pathMinX=paths['minX'], pathMaxX=paths['minX']+(paths['rows']-1)*paths['step'],
                      pathMinY=paths['minY'], pathMaxY=paths['minY']+(paths['columns']-1)*paths['step'], pathStep=paths['step'])
    temporary = output / 'grid-config.js.tmp'
    temporary.write_text('window.DichasusGrid = '+json.dumps(config,separators=(',',':'))+';\n')
    temporary.replace(output / 'grid-config.js')
    # A changed grid must not reuse a browser's earlier configuration script.
    page = output.parent / 'index.html'
    if page.is_file():
        import re
        revision = hashlib.sha256((output / 'grid-config.js').read_bytes()).hexdigest()[:24]
        page.write_text(re.sub(r'src="data/grid-config\.js(?:\?[^" ]*)?"',
                              f'src="data/grid-config.js?v={revision}"', page.read_text()))


def pack(source, output, block_bins=BLOCK_BINS):
    if block_bins not in (1,4,16): raise ValueError("block_bins must be 1, 4 or 16")
    provenance = source.with_suffix('.json')
    details = json.loads(provenance.read_text()) if provenance.is_file() else {}
    depth = details.get('depth', 6)
    bounds = details.get('bounds', [-13, 10, -35, 0])
    if not isinstance(depth, int) or not 1 <= depth <= 10:
        raise ValueError('Invalid channel grid depth')
    if len(bounds) != 4 or not np.isfinite(bounds).all() or bounds[0] >= bounds[1] or bounds[2] >= bounds[3]:
        raise ValueError('Invalid channel grid bounds')
    bins = 4 ** depth
    if source.stat().st_size != bins * BYTES_PER_BIN:
        raise ValueError('Unexpected quadtree size')
    channels = np.memmap(source, dtype='<f4', mode='r', shape=(bins, BYTES_PER_BIN // 4))
    if not np.isfinite(channels).all(): raise ValueError('Non-finite CSI cannot be published')
    occupied = np.any(channels != 0, axis=1)
    mask = np.packbits(occupied, bitorder='little').tobytes()
    output.mkdir(parents=True, exist_ok=True)
    chunks_dir = output / 'channels'
    chunks_dir.mkdir(exist_ok=True)
    chunks, total = [], 0
    for first in range(0, bins, block_bins):
        if not occupied[first:first+block_bins].any():
            chunks.append(None)
            continue
        compressed = gzip.compress(channels[first:first+block_bins].tobytes(), compresslevel=6, mtime=0)
        name = f'{hashlib.sha256(compressed).hexdigest()[:24]}.bin.gz'
        target = chunks_dir / name
        if not target.exists(): target.write_bytes(compressed)
        chunks.append(name)
        total += len(compressed)
    with source.open('rb') as stream: source_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = {'version':1, 'depth':depth, 'bounds':bounds, 'sourceBytes':source.stat().st_size, 'sourceSha256':source_hash, 'validBins':int(occupied.sum()), 'occupancy':base64.b64encode(mask).decode(), 'chunkFormat':1, 'blockBins':block_bins, 'chunks':chunks, 'compressedBytes':total}
    if details:
        if details.get('outputSha256') != source_hash: raise ValueError('Channel provenance does not match source bytes')
        manifest['recordings'] = details.get('routes', [])
        manifest['configurationVariant'] = details.get('configurationVariant')
        manifest['subsetLimitPerRoute'] = details.get('limitPerRoute')
        (output/'channel-provenance.json').write_text(json.dumps(details,indent=2)+'\n')
    temporary = output/'coverage.json.tmp'
    temporary.write_text(json.dumps(manifest,separators=(',',':'))+'\n')
    temporary.replace(output/'coverage.json')
    publish_grid_config(output)
    print(f'{manifest["validBins"]} measured cells; {sum(chunk is not None for chunk in chunks)} chunks; {total:,} compressed bytes')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=Path.home()/'Downloads/dichasus-adxx/processed/quadtree.bin')
    parser.add_argument('--output',type=Path,default=ROOT/'data')
    parser.add_argument('--block-bins',type=int,choices=[1,4,16],default=BLOCK_BINS)
    args=parser.parse_args()
    pack(args.source,args.output,args.block_bins)
