#!/usr/bin/env python3
"""Pack route overlays as lossless WebP and publish their colour scales."""

import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3] / 'static/visualization/adxx'


def read_plots(path):
    if not path.exists():
        return {}
    return json.loads(path.read_text()).get("plots", {})


def read_scales(source):
    provenance = source / "generation.json"
    if not provenance.exists():
        return {}

    scales = {}
    report = json.loads(provenance.read_text())
    for route, details in report["routes"].items():
        for quantity, scale in details["scales"].items():
            for style in ("Scatter", "Hexbin"):
                limits = scale.get(style, scale)
                scales[f"{quantity}_{style}_{route}"] = {
                    "min": limits["min"],
                    "max": limits["max"],
                    "units": scale["units"],
                    "sharedArrays": scale.get("sharedArrays", False),
                }
    return scales


def encode_image(path, output, source_hash):
    with Image.open(path) as image:
        original = image.convert("RGBA")
    buffer = io.BytesIO()
    original.save(buffer, "WEBP", lossless=True, exact=True, method=4)
    encoded = buffer.getvalue()
    with Image.open(io.BytesIO(encoded)) as restored:
        if restored.convert("RGBA").tobytes() != original.tobytes():
            raise ValueError(f"Lossless conversion failed: {path}")

    filename = hashlib.sha256(encoded).hexdigest()[:24] + ".webp"
    (output / filename).write_bytes(encoded)
    return {
        "file": filename,
        "bytes": len(encoded),
        "sourceBytes": path.stat().st_size,
        "sourceSha256": source_hash,
        "width": original.width,
        "height": original.height,
    }


def pack(source, output, manifest_path, merge=False):
    previous = read_plots(manifest_path)
    scales = read_scales(source)
    plots = dict(previous) if merge else {}
    images = sorted(source.glob("*.png"))
    if not images:
        raise ValueError(f"No route overlay PNG files found in {source}")
    output.mkdir(parents=True, exist_ok=True)

    for index, path in enumerate(images):
        source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        cached = previous.get(path.stem)
        reusable = (
            cached is not None
            and cached["sourceSha256"] == source_hash
            and (output / cached["file"]).is_file()
        )
        entry = dict(cached) if reusable else encode_image(path, output, source_hash)
        # Scale metadata can change without changing the encoded image.
        entry.pop("scale", None)
        if path.stem in scales:
            entry["scale"] = scales[path.stem]
        plots[path.stem] = entry
        if (index + 1) % 20 == 0:
            print(f"Packed {index + 1}/{len(images)} overlays", flush=True)

    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = manifest_path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"version": 1, "plots": plots}, separators=(",", ":")) + "\n"
    )
    temporary.replace(manifest_path)
    source_bytes = sum(plot["sourceBytes"] for plot in plots.values())
    packed_bytes = sum(plot["bytes"] for plot in plots.values())
    print(
        f"{len(plots)} lossless overlays: {source_bytes:,} → {packed_bytes:,} bytes",
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path.home() / 'Downloads/dichasus-adxx/route-plots')
    parser.add_argument("--output", type=Path, default=ROOT / "Plots/packed")
    parser.add_argument("--manifest", type=Path, default=ROOT / "data/plot-assets.json")
    parser.add_argument(
        "--merge",
        action="store_true",
        help="Keep existing overlays for other routes and quantities",
    )
    args = parser.parse_args()
    pack(args.source, args.output, args.manifest, args.merge)


if __name__ == "__main__":
    main()
