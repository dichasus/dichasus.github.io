#!/usr/bin/env python3
"""Pack the existing glTF models as compact GLB files without changing geometry."""
import argparse
import base64
import hashlib
import gzip
import io
import json
import struct
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3] / 'static/visualization/adxx'


def stamp_model_version(output, meta_name):
    """Version a live model in HTML without adding a startup manifest request."""
    if output.resolve().parent != (ROOT/'assets').resolve():
        return
    digest = hashlib.sha256(output.with_suffix(output.suffix+'.gz').read_bytes()).hexdigest()
    page = ROOT/'index.html'
    pattern = rf'(<meta\s+name="{re.escape(meta_name)}"\s+content=")[^"]*(")'
    html, count = re.subn(pattern, lambda match:match[1]+digest[:16]+match[2], page.read_text())
    if count != 1:
        raise ValueError(f'Missing unique {meta_name} meta tag in index.html')
    page.write_text(html)


def read_gltf(path):
    if path.suffix == '.glb':
        data = path.read_bytes()
        magic, version, length = struct.unpack_from('<4sII', data)
        if magic != b'glTF' or version != 2 or length != len(data):
            raise ValueError('Invalid GLB header')
        json_length, json_type = struct.unpack_from('<II', data, 12)
        if json_type != 0x4E4F534A:
            raise ValueError('Missing GLB JSON chunk')
        document = json.loads(data[20:20 + json_length])
        offset = 20 + json_length
        binary_length, binary_type = struct.unpack_from('<II', data, offset)
        if binary_type != 0x004E4942 or offset + 8 + binary_length != len(data):
            raise ValueError('Invalid GLB binary chunk')
        return document, [data[offset + 8:]]
    document = json.loads(path.read_bytes())
    buffers = []
    for buffer in document['buffers']:
        uri = buffer['uri']
        if uri.startswith('data:'): buffers.append(base64.b64decode(uri.split(',', 1)[1]))
        else: buffers.append((path.parent / uri).read_bytes())
    return document, buffers


def write_glb(document, binary, output):
    document['buffers'] = [{'byteLength': len(binary)}]
    payload = json.dumps(document, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    payload += b' ' * (-len(payload) % 4)
    binary = bytes(binary) + b'\0' * (-len(binary) % 4)
    length = 12 + 8 + len(payload) + 8 + len(binary)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + '.tmp')
    with temporary.open('wb') as stream:
        stream.write(struct.pack('<4sII', b'glTF', 2, length))
        stream.write(struct.pack('<II', len(payload), 0x4E4F534A))
        stream.write(payload)
        stream.write(struct.pack('<II', len(binary), 0x004E4942))
        stream.write(binary)
    temporary.replace(output)
    compressed = output.with_suffix(output.suffix + '.gz')
    temporary = compressed.with_suffix(compressed.suffix + '.tmp')
    temporary.write_bytes(gzip.compress(output.read_bytes(), compresslevel=9, mtime=0))
    temporary.replace(compressed)


def pack(source, output, texture_size=512, quality=80):
    from PIL import Image
    from model_geometry import primitives, is_planar_surface
    document, buffers = read_gltf(source)
    two_sided = {}
    for _, primitive, positions, _, _ in primitives(document, buffers):
        original = primitive.get('material')
        if not is_planar_surface(positions) or (original is not None and document['materials'][original].get('doubleSided')):
            continue
        if original not in two_sided:
            material = dict(document['materials'][original]) if original is not None else {}
            material['doubleSided'] = True
            two_sided[original] = len(document.setdefault('materials', []))
            document['materials'].append(material)
        primitive['material'] = two_sided[original]
    replacements = {}
    image_stats = []
    for image in document.get('images', []):
        if 'bufferView' not in image: continue
        view = document['bufferViews'][image['bufferView']]
        raw = buffers[view['buffer']][view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']]
        decoded = Image.open(io.BytesIO(raw))
        original_size = decoded.size
        decoded.thumbnail((texture_size, texture_size), Image.Resampling.LANCZOS)
        encoded = io.BytesIO()
        if 'A' in decoded.getbands():
            decoded.save(encoded, format='PNG', optimize=True)
            image['mimeType'] = 'image/png'
        else:
            decoded.convert('RGB').save(encoded, format='JPEG', quality=quality, optimize=True)
            image['mimeType'] = 'image/jpeg'
        replacements[image['bufferView']] = encoded.getvalue()
        image_stats.append({'originalDimensions': original_size, 'dimensions': decoded.size, 'originalBytes': len(raw), 'bytes': len(encoded.getvalue())})
    binary = bytearray()
    for index, view in enumerate(document['bufferViews']):
        binary.extend(b'\0' * (-len(binary) % 4))
        payload = replacements.get(index)
        if payload is None:
            start = view.get('byteOffset', 0)
            payload = buffers[view['buffer']][start:start + view['byteLength']]
        view['buffer'] = 0
        view['byteOffset'] = len(binary)
        view['byteLength'] = len(payload)
        binary.extend(payload)
    write_glb(document, binary, output)
    return {'source': source.name, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'sourceBytes': source.stat().st_size, 'file': output.name, 'bytes': output.stat().st_size, 'gzipBytes': output.with_suffix(output.suffix + '.gz').stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'textures': image_stats}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'assets')
    parser.add_argument('--texture-size', type=int, default=512)
    parser.add_argument('--legacy-robot', action='store_true', help='Explicitly replace the photo-informed robot with the original glTF')
    args = parser.parse_args()
    if args.texture_size < 16: parser.error('texture-size must be at least 16')
    previous = json.loads((args.output/'models.json').read_text()) if (args.output/'models.json').exists() else {'models':[]}
    photo_robot = next((model for model in previous['models'] if model.get('file')=='robot.glb' and model.get('source')=='scripts/build_robot.py'),None)
    models = [pack(ROOT/'ARENA2036.gltf',args.output/'factory.glb',args.texture_size)]
    if photo_robot and not args.legacy_robot:
        if not (args.output/'robot.glb.gz').is_file() or hashlib.sha256((args.output/'robot.glb').read_bytes()).hexdigest()!=photo_robot['sha256']:
            raise ValueError('Photo-informed robot does not match its manifest; rebuild it with scripts/build_robot.py')
        models.append(photo_robot)
    else:
        models.append(pack(ROOT/'robot.gltf',args.output/'robot.glb',args.texture_size))
    (args.output / 'models.json').write_text(json.dumps({'version': 1, 'models': models}, indent=2) + '\n')
    stamp_model_version(args.output/'factory.glb', 'factory-model-version')
    stamp_model_version(args.output/'robot.glb', 'robot-model-version')
    for model in models:
        if 'sourceBytes' in model:
            print(f"{model['source']}: {model['sourceBytes']:,} → {model['bytes']:,} bytes ({100 * (1 - model['bytes'] / model['sourceBytes']):.1f}% smaller)")
        else:print(f"Retained photo-informed robot: {model['bytes']:,} bytes")


if __name__ == '__main__': main()
