#!/usr/bin/env python3
"""Export the published dcxx GLB geometry for Sionna, excluding antenna meshes."""

import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import numpy as np
from model_geometry import primitives
from pack_models import read_gltf, pack, write_glb
from build_floorplan import build as build_floorplan


def export_scene(source, output):
    document, buffers = read_gltf(source)
    output.mkdir(parents=True, exist_ok=True)
    meshes = output / "meshes"
    meshes.mkdir(exist_ok=True)
    scene = ET.Element("scene", version="3.0.0")
    material = ET.SubElement(scene, "bsdf", type="twosided", id="mat-itu_concrete")
    ET.SubElement(material, "bsdf", type="diffuse")
    for index, (node, primitive, positions, faces, _) in enumerate(primitives(document, buffers)):
        name = document["nodes"][node].get("name", f"mesh-{node}")
        if name.startswith("antenna-array"):
            continue
        # glTF is Y-up; Sionna and the survey use Z-up.
        positions = positions[:, [0, 2, 1]] * [1, -1, 1]
        path = meshes / f"{name}-{index}.ply"
        header = (
            "ply\nformat binary_little_endian 1.0\n"
            f"element vertex {len(positions)}\nproperty float x\nproperty float y\nproperty float z\n"
            f"element face {len(faces)}\nproperty list uchar uint vertex_indices\nend_header\n"
        )
        triangles = np.empty(len(faces), dtype=[("count", "u1"), ("indices", "<u4", (3,))])
        triangles["count"] = 3
        triangles["indices"] = faces
        path.write_bytes(header.encode() + positions.astype("<f4").tobytes() + triangles.tobytes())
        shape = ET.SubElement(scene, "shape", type="ply", id=f"{name}-{index}")
        ET.SubElement(shape, "string", name="filename", value=path.relative_to(output).as_posix())
        ET.SubElement(shape, "ref", id="mat-itu_concrete", name="bsdf")
    ET.indent(scene)
    (output / "scene.xml").write_text(ET.tostring(scene, encoding="unicode") + "\n")
    (output / "source.json").write_text(
        json.dumps(
            {
                "file": source.name,
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "coordinateTransform": "glTF [x,y,z] to survey [x,-z,y]",
                "excluded": "antenna-array*",
            },
            indent=2,
        )
        + "\n"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--viewer-output", type=Path, help="Also publish the compressed visual model and minimap"
    )
    args = parser.parse_args()
    export_scene(args.source, args.output)
    if args.viewer_output:
        args.viewer_output.mkdir(parents=True, exist_ok=True)
        pack(args.source, args.viewer_output / "environment.glb")
        visual = args.viewer_output / "environment.glb"
        document, buffers = read_gltf(visual)
        # Keep dark flooring readable behind the ray lines under the viewer's lighting.
        for material in document.get("materials", []):
            if material.get("name") == "floor":
                material["pbrMetallicRoughness"]["baseColorFactor"] = [0.065, 0.075, 0.08, 1]
        write_glb(document, buffers[0], visual)
        build_floorplan(args.source, args.viewer_output / "floorplan.json")


if __name__ == "__main__":
    main()
