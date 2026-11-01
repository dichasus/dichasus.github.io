#!/usr/bin/env python3
"""Pack existing ray columns into independently compressed position blocks.

Range-capable hosts transfer one small gzip member. Plain hosts transfer one
compressed column, which is cached and sliced locally. Geometry is unchanged.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
from validate_paths import validate_records
from path_binary import encode as encode_binary
from pack_channels import publish_grid_config

ROOT = Path(__file__).resolve().parents[3] / 'static/visualization/adxx'


def pack(source,output,index_path,spec_path,block_rows=4,block_format=None,max_reflections=None):
    if not 1<=block_rows<=201:raise ValueError('Invalid block size')
    if max_reflections is not None and (not isinstance(max_reflections,int) or max_reflections<0):raise ValueError('Invalid reflection limit')
    antennas=json.loads(spec_path.read_text())['antennas']
    output.mkdir(parents=True,exist_ok=True)
    manifest={'version':2,'columns':351,'rows':201,'blockRows':block_rows,'minX':-15,'minY':-35,'step':.1,'files':[]}
    generation_path=source/'generation.json'
    generation=None
    generated_files={}
    grid=None
    if generation_path.exists():
        generation=json.loads(generation_path.read_text())
        grid=generation.get('grid')
        if grid is not None:
            if not isinstance(grid['rows'],int) or not 1 <= grid['rows'] <= 4096 or grid['columns']!=351 or grid['minY']!=-35 or grid['step']!=.1:raise ValueError('Unsupported generation grid')
            manifest.update(rows=grid['rows'], minX=grid['minX'])
        if generation['datasetSpecSha256']!=hashlib.sha256(spec_path.read_bytes()).hexdigest():raise ValueError('Path generation specification does not match')
        generated_files={item['file']:item for item in generation['outputs']}
        manifest['generationSha256']=hashlib.sha256(generation_path.read_bytes()).hexdigest()
        if generation.get('coverageSourceSha256'):manifest['measurementSourceSha256']=generation['coverageSourceSha256']
    block_format=block_format or ('binary' if generation is not None else 'json')
    if block_format not in ('binary','json'):raise ValueError('Invalid path block format')
    manifest['blockFormat']='binary-v1' if block_format=='binary' else 'json'
    source_bytes=0
    packed_bytes=0
    input_paths=0
    retained_paths=0
    if max_reflections is not None:manifest['displayMaxReflections']=max_reflections
    for column in range(351):
        original=(source/f'paths_{column}.json').read_bytes()
        if generation is not None:
            declared=generated_files.get(f'paths_{column}.json')
            if not declared or declared['sha256']!=hashlib.sha256(original).hexdigest():raise ValueError(f'Column {column} does not match generation provenance')
        records=json.loads(original)
        validate_records(records,antennas,column,grid)
        input_paths+=sum(len(record['paths']) for record in records)
        if max_reflections is not None:
            records=[{**record,'paths':[path for path in record['paths'] if len(path['vertices'])<=max_reflections]} for record in records]
        retained_paths+=sum(len(record['paths']) for record in records)
        data=bytearray();offsets=[0]
        for first in range(0,manifest['rows'],block_rows):
            selected=records[first:first+block_rows]
            block=encode_binary(selected,antennas) if block_format=='binary' else json.dumps(selected,separators=(',',':'),allow_nan=False).encode()
            data.extend(gzip.compress(block,compresslevel=6,mtime=0))
            offsets.append(len(data))
        name=f'{hashlib.sha256(data).hexdigest()[:24]}.bin'
        target=output/name
        if not target.exists():target.write_bytes(data)
        # Nearby member lengths compress better than cumulative offsets. The
        # browser reconstructs exact byte boundaries once when loading the index.
        manifest['files'].append({'file':name,'lengths':[end-start for start,end in zip(offsets,offsets[1:])]})
        source_bytes+=len(original);packed_bytes+=len(data)
        if column%50==0:print(f'Packed column {column}/350',flush=True)
    manifest.update({'sourceBytes':source_bytes,'packedBytes':packed_bytes,'inputPaths':input_paths,'retainedPaths':retained_paths})
    encoded=gzip.compress(json.dumps(manifest,separators=(',',':')).encode(),compresslevel=9,mtime=0)
    index_path.parent.mkdir(parents=True,exist_ok=True)
    provenance=index_path.parent/'path-generation.json'
    if generation is not None:
        temporary=provenance.with_suffix('.tmp')
        temporary.write_bytes(generation_path.read_bytes());temporary.replace(provenance)
    else:provenance.unlink(missing_ok=True)
    temporary=index_path.with_suffix(index_path.suffix+'.tmp')
    temporary.write_bytes(encoded);temporary.replace(index_path)
    publish_grid_config(index_path.parent)
    print(f'{source_bytes:,} source bytes → {packed_bytes:,} packed bytes; {len(encoded):,}-byte manifest',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=Path.home()/'Downloads/dichasus-adxx/generated-paths')
    parser.add_argument('--output',type=Path,default=ROOT/'Paths/packed')
    parser.add_argument('--index',type=Path,default=ROOT/'data/path-chunks.json.gz')
    parser.add_argument('--spec',type=Path,default=ROOT/'data/dataset-spec.json')
    parser.add_argument('--block-rows',type=int,default=4)
    parser.add_argument('--block-format',choices=['json','binary'],help='Default: binary for generated paths with provenance, JSON for legacy files')
    parser.add_argument('--max-reflections',type=int,help='Keep only paths up to this reflection order in the display pack; original simulations are preserved')
    args=parser.parse_args()
    pack(args.source,args.output,args.index,args.spec,args.block_rows,args.block_format,args.max_reflections)
