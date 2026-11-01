#!/usr/bin/env python3
"""Write dcxx's dataset configuration from the published grids and survey."""

import argparse
import base64
import gzip
import hashlib
import json
import re
from pathlib import Path
from path_binary import record_summaries
import numpy as np

VARIANTS = {"no-walls": "dc01", "southwest-wall": "dc10", "northwest-wall": "dc20"}


def asset_files(directory, spec_hash=None):
    """Yield only referenced, verified assets; leave superseded chunks behind."""
    coverage = json.loads((directory / "data/coverage.json").read_text())
    rays = json.loads(gzip.decompress((directory / "data/path-chunks.json.gz").read_bytes()))
    plots = json.loads((directory / "data/plot-assets.json").read_text())
    if rays.get("measurementSourceSha256") != coverage["sourceSha256"]:
        raise ValueError("Paths and measurements belong to different builds")
    generation = directory / "data/path-generation.json"
    if hashlib.sha256(generation.read_bytes()).hexdigest() != rays["generationSha256"]:
        raise ValueError("Path provenance does not match the packed rays")
    if spec_hash is not None:
        path_details = json.loads(generation.read_text())
        channel_details = json.loads((directory / "data/channel-provenance.json").read_text())
        if (
            path_details["datasetSpecSha256"] != spec_hash
            or channel_details["specSha256"] != spec_hash
        ):
            raise ValueError("Survey metadata does not match the generated data")
    selected = {
        "data/coverage.json",
        "data/grid-config.js",
        "data/floorplan.json",
        "data/environment.glb.gz",
        "data/channel-provenance.json",
        "data/path-generation.json",
        "data/path-chunks.json.gz",
        "data/plot-assets.json",
    }
    selected.update("data/channels/" + name for name in coverage["chunks"] if name)
    selected.update("Paths/packed/" + entry["file"] for entry in rays["files"])
    selected.update("Plots/packed/" + entry["file"] for entry in plots["plots"].values())
    for name in sorted(selected):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe asset path")
        payload = (directory / relative).read_bytes()
        if (
            name.startswith(("data/channels/", "Paths/packed/", "Plots/packed/"))
            and relative.name.split(".")[0] != hashlib.sha256(payload).hexdigest()[:24]
        ):
            raise ValueError(f"Corrupt content-addressed asset: {relative}")
        yield name, payload


def install_data(source, viewer, spec, variants=VARIANTS):
    manifest = viewer / "release.json"
    previous = json.loads(manifest.read_text())
    old = {entry["path"] for entry in previous["files"]}
    if any(Path(name).is_absolute() or ".." in Path(name).parts for name in old):
        raise ValueError("Unsafe previous manifest")
    incoming = {
        f"variants/{variant}/{name}": payload
        for variant in variants
        for name, payload in asset_files(
            source / variant, hashlib.sha256(spec.read_bytes()).hexdigest()
        )
    }
    # Validate all source packs before replacing anything in the website.
    retained = old - {
        name for name in old if any(name.startswith(f"variants/{variant}/") for variant in variants)
    }
    incoming["data/dataset-spec.json"] = spec.read_bytes()
    for name, payload in incoming.items():
        target = viewer / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_bytes(payload)
        temporary.replace(target)
    write_config(viewer, spec)
    retained.update(incoming)
    retained.add("data/dataset-config.js")
    if (viewer / "index.html").exists():
        retained.add("index.html")
    for name in old - retained:
        (viewer / name).unlink(missing_ok=True)
    entries = []
    for name in sorted(retained):
        payload = (viewer / name).read_bytes()
        entries.append(
            dict(path=name, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        )
    previous.update(files=entries, bytes=sum(entry["bytes"] for entry in entries))
    manifest.write_text(json.dumps(previous, indent=2) + "\n")


def configuration(viewer, spec, variants=VARIANTS):
    antennas = json.loads(spec.read_text())["antennas"]
    for antenna in antennas:
        normal = np.asarray(antenna["direction"], dtype=float)
        normal /= np.linalg.norm(normal)
        right = np.cross([0.0, 0.0, 1.0], normal)
        right /= np.linalg.norm(right)
        antenna["rightvector"] = right.tolist()
        antenna["upvector"] = np.cross(normal, right).tolist()
    settings = {}
    for variant in variants:
        data = viewer / "variants" / variant / "data"
        coverage = json.loads((data / "coverage.json").read_text())
        packed = json.loads(gzip.decompress((data / "path-chunks.json.gz").read_bytes()))
        if packed.get("measurementSourceSha256") != coverage["sourceSha256"]:
            raise ValueError(f"{variant}: paths and channels belong to different builds")
        generation = json.loads((data / "path-generation.json").read_text())
        channels = json.loads((data / "channel-provenance.json").read_text())
        spec_hash = hashlib.sha256(spec.read_bytes()).hexdigest()
        if generation["datasetSpecSha256"] != spec_hash or channels["specSha256"] != spec_hash:
            raise ValueError(f"{variant}: survey metadata does not match the generated data")
        grid = json.loads((data / "grid-config.js").read_text().split("=", 1)[1].rstrip(";\n"))
        cells = base64.b64decode(coverage["occupancy"])
        # Prefer a measured cell in the lobby, near the centre of the model.
        from build_channels import configure_grid, bin_center

        configure_grid(coverage["bounds"], coverage["depth"])
        centers = [
            bin_center(i) for i in range(4 ** coverage["depth"]) if cells[i >> 3] & (1 << (i & 7))
        ]
        if not centers:
            raise ValueError(f"{variant}: no measured cells")
        centers.sort(key=lambda p: np.linalg.norm(p - [3.0, 0.0]))
        start = centers[0]
        for candidate in centers:
            row = round((candidate[0] - packed["minX"]) / packed["step"])
            column = round((candidate[1] - packed["minY"]) / packed["step"])
            block = row // packed["blockRows"]
            entry = packed["files"][column]
            offsets = entry.get("offsets")
            if offsets is None:
                offsets = np.r_[0, np.cumsum(entry["lengths"])]
            with (viewer / "variants" / variant / "Paths/packed" / entry["file"]).open(
                "rb"
            ) as stream:
                stream.seek(int(offsets[block]))
                records = record_summaries(
                    gzip.decompress(stream.read(int(offsets[block + 1] - offsets[block])))
                )
            if records[row % packed["blockRows"]][1]:
                start = candidate
                break
        prefix = f"variants/{variant}/"
        settings[variant] = dict(
            id="dcxx",
            variant=variant,
            antennas=antennas,
            grid=grid,
            dataPrefix=prefix,
            model=prefix + "data/environment.glb",
            modelVersion=hashlib.sha256((data / "environment.glb.gz").read_bytes()).hexdigest()[
                :24
            ],
            cameraPosition=[25, 30, 34],
            cameraTarget=[6, 0, 0],
            helpCameraPosition=[12, 17, 0],
            helpCameraTarget=[-1, 0, -11],
            robotStart=[float(start[0]), -0.14, float(-start[1])],
            groundHeight=-0.14,
            robotModel="../shared/assets/robot.glb",
            routes=coverage.get("recordings", [VARIANTS[variant]]),
            plotBounds=coverage["bounds"],
            plotHeight=-0.09,
            patternScale=2,
        )
    return settings


def write_config(viewer, spec, variants=VARIANTS):
    settings = configuration(viewer, spec, variants)
    target = viewer / "data/dataset-config.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "/* Generated from dcxx survey and channel/path manifests. */\n"
        "(function () {\n    const variants = "
        + json.dumps(settings, separators=(",", ":"))
        + ";\n"
        '    const selected = new URLSearchParams(location.search).get("variant");\n'
        '    window.DichasusDataset = variants[selected] || variants["no-walls"];\n'
        "})();\n"
    )

    page = viewer / "index.html"
    if page.exists():
        revision = hashlib.sha256(target.read_bytes()).hexdigest()[:24]
        page.write_text(
            re.sub(
                r'src="data/dataset-config\.js(?:\?[^" ]*)?"',
                f'src="data/dataset-config.js?v={revision}"',
                page.read_text(),
            )
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--viewer", type=Path, required=True)
    parser.add_argument("--spec", type=Path, required=True)
    args = parser.parse_args()
    write_config(args.viewer, args.spec)
