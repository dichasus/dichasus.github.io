#!/usr/bin/env python3
"""Rebuild the three dcxx environments using the shared viewer processors."""

import argparse
from pathlib import Path
import subprocess
import sys

from configure_dcxx import VARIANTS, install_data


def run(script, *arguments):
    subprocess.run(
        [sys.executable, str(Path(__file__).with_name(script)), *map(str, arguments)], check=True
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=["measurements", "rays", "publish"], required=True)
    parser.add_argument("--site", type=Path, required=True, help="DichasusDatasetSite checkout")
    parser.add_argument("--dataset", type=Path, default=Path.home() / "Downloads/dichasus-dcxx")
    parser.add_argument(
        "--output",
        type=Path,
        help="Compact staging assets; defaults to Downloads/dichasus-dcxx/viewer",
    )
    parser.add_argument("--variants", nargs="+", choices=VARIANTS, default=list(VARIANTS))
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    source = args.site / "content/datasets/data/dichasus-dcxx"
    output = args.output or args.dataset / "viewer"
    args.dataset.mkdir(parents=True, exist_ok=True)
    spec = args.dataset / "viewer-spec.json"
    # The website's metadata adds variant assignments to the deposited specification.
    spec.write_bytes((source / "metadata.json").read_bytes())
    if args.stage == "publish":
        install_data(output, args.site / "static/visualization/dcxx", spec, args.variants)
        return
    for variant in args.variants:
        route = VARIANTS[variant]
        processed = args.dataset / "processed" / variant
        assets = output / variant
        data = assets / "data"
        data.mkdir(parents=True, exist_ok=True)
        if args.stage == "measurements":
            offsets = f"reftx-offsets-dichasus-{route}.json"
            (args.dataset / offsets).write_bytes((source / offsets).read_bytes())
            run(
                "build_dcxx_scene.py",
                "--source",
                source / f"3dmodel/inue-{variant}.glb",
                "--output",
                args.dataset / "scenes" / variant,
                "--viewer-output",
                data,
            )
            run(
                "build_channels.py",
                "--dataset-dir",
                args.dataset,
                "--spec",
                spec,
                "--routes",
                route,
                "--bounds",
                -9,
                29,
                -24,
                28,
                "--depth",
                7,
                "--reference-gain",
                58,
                "--workers",
                args.workers,
                "--output",
                processed / "quadtree.bin",
            )
            run("pack_channels.py", "--source", processed / "quadtree.bin", "--output", data)
            plots = processed / "plots"
            run(
                "build_route_plots.py",
                "--dataset",
                args.dataset,
                "--routes",
                route,
                "--bounds",
                -9,
                29,
                -24,
                28,
                "--output",
                plots,
            )
            run(
                "pack_plots.py",
                "--source",
                plots,
                "--output",
                assets / "Plots/packed",
                "--manifest",
                data / "plot-assets.json",
            )
        else:
            rays = processed / "paths"
            arguments = ["--resume"] if (rays / "generation.json").exists() else []
            run(
                "generate_paths.py",
                "--scene",
                args.dataset / "scenes" / variant / "scene.xml",
                "--spec",
                spec,
                "--output",
                rays,
                "--coverage",
                data / "coverage.json",
                "--all-columns",
                "--step",
                0.2,
                "--height",
                0.93,
                "--max-depth",
                1,
                "--semantic-materials",
                "--min-relative-power-db",
                -20,
                "--batch-size",
                32,
                *arguments,
            )
            run(
                "pack_paths.py",
                "--source",
                rays,
                "--spec",
                spec,
                "--output",
                assets / "Paths/packed",
                "--index",
                data / "path-chunks.json.gz",
                "--max-reflections",
                1,
            )


if __name__ == "__main__":
    main()
