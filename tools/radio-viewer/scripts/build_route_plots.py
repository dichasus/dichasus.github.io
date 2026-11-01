#!/usr/bin/env python3
"""Stream adxx CSI into power / RMS-delay route overlays and reusable metrics."""
import argparse
import hashlib
import json
import inspect
import os
from pathlib import Path
import tempfile

os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
os.environ.setdefault('CUDA_VISIBLE_DEVICES', '-1')
os.environ.setdefault('MPLCONFIGDIR', str(Path(tempfile.gettempdir()) / 'dichasus-matplotlib'))
import numpy as np

BOUNDS = (-70., 12., -35., 0.)
VERSION = 1


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''): h.update(block)
    return h.hexdigest()


def rms_delay(power, step_ns=20.):
    times = np.arange(power.shape[-1]) * step_ns
    total = power.sum(axis=-1)
    mean = np.divide((power * times).sum(axis=-1), total, out=np.zeros_like(total), where=total > 0)
    variance = np.divide((power * (times - mean[..., None])**2).sum(axis=-1), total,
                         out=np.zeros_like(total), where=total > 0)
    return np.sqrt(variance)


def batch_metrics(raw, correction, assignments):
    csi = np.fft.fftshift(raw[..., 0] + 1j * raw[..., 1], axes=-1)
    # Sum all 16 antennas in each array; frequency average is proportional to RX power.
    power = np.mean(np.abs(csi[:, assignments])**2, axis=-1).sum(axis=(2, 3))
    slope = np.angle(np.sum(csi[..., 1:] * csi[..., :-1].conj(), axis=(-2, -1)))
    csi *= np.exp(-1j * slope[:, None, None] * np.arange(csi.shape[-1]))
    csi *= correction
    cir = np.fft.fftshift(np.fft.ifft(np.fft.fftshift(csi, axes=-1), axis=-1), axes=-1)
    # Wider than the viewer's 30 taps: retain late arrivals for the route RMS statistic.
    pdp = np.mean(np.abs(cir[:, assignments, 495:555])**2, axis=(2, 3))
    return power, rms_delay(pdp)


ALL_ROUTES = tuple(f"ad{i:02}" for i in range(28) if i != 20)
DEFAULT_ROUTES = ("ad10", "ad11", "ad18", "ad19")
PLOT_STYLES = ("Scatter", "Hexbin")
MIN_POWER_RANGE_DB = 10
HEX_WIDTH_METERS = 0.75


def write_json(path, value):
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def cache_identity(raw_path, spec_path, offsets_path):
    from build_channels import calibration_matrix, record_batches

    helper_source = inspect.getsource(calibration_matrix) + inspect.getsource(record_batches)
    calculation_source = inspect.getsource(batch_metrics) + inspect.getsource(rms_delay)
    identity = {
        "version": VERSION,
        "specSha256": sha256(spec_path),
        "offsetsSha256": sha256(offsets_path),
        "calculationSha256": hashlib.sha256(calculation_source.encode()).hexdigest(),
        "calibrationHelpersSha256": hashlib.sha256(helper_source.encode()).hexdigest(),
    }
    if raw_path.exists():
        stat = raw_path.stat()
        identity.update(rawBytes=stat.st_size, rawMtimeNs=stat.st_mtime_ns)
    return identity


def read_cached_metrics(data_path, provenance_path, identity):
    if not data_path.exists() or not provenance_path.exists():
        return None

    provenance = json.loads(provenance_path.read_text())
    previous = provenance.get("cacheIdentity", {})
    if any(previous.get(key) != value for key, value in identity.items()):
        return None

    # Raw recordings may have been discarded after processing. Their checksums
    # remain in provenance; calibration and calculation hashes must still match.
    if (
        "metricsSha256" in provenance
        and sha256(data_path) != provenance["metricsSha256"]
    ):
        raise ValueError(f"Metric cache checksum mismatch: {data_path}")
    with np.load(data_path) as saved:
        values = {key: saved[key] for key in saved.files}
    return values, provenance


def metrics(root, route, cache):
    from build_channels import calibration_matrix, record_batches

    raw_path = root / f"dichasus-{route}.tfrecords"
    spec_path = root / "spec.json"
    offsets_path = root / f"reftx-offsets-dichasus-{route}.json"
    spec = json.loads(spec_path.read_text())
    assignments = np.asarray([array["assignments"] for array in spec["antennas"]])
    if assignments.ndim != 3 or sorted(assignments.ravel()) != list(range(64)):
        raise ValueError("Expected disjoint rectangular arrays covering all 64 antennas")

    identity = cache_identity(raw_path, spec_path, offsets_path)
    cache.mkdir(parents=True, exist_ok=True)
    data_path = cache / f"{route}.npz"
    provenance_path = cache / f"{route}.json"
    cached = read_cached_metrics(data_path, provenance_path, identity)
    if cached is not None:
        return cached
    if not raw_path.exists():
        raise FileNotFoundError(
            f"Download {raw_path.name}: no matching metric cache is available"
        )

    correction = calibration_matrix(json.loads(offsets_path.read_text()))
    positions, powers, spreads = [], [], []
    rejected = 0
    for raw_batch, position in record_batches(raw_path, 32, None):
        valid = np.isfinite(raw_batch).all(axis=(1, 2, 3)) & np.isfinite(position).all(
            axis=1
        )
        rejected += int((~valid).sum())
        if not valid.any():
            continue
        power, spread = batch_metrics(raw_batch[valid], correction, assignments)
        positions.append(position[valid])
        powers.append(power)
        spreads.append(spread)
    if not positions:
        raise ValueError(f"No finite measurements in {route}")

    values = {
        "positions": np.concatenate(positions),
        "power": np.concatenate(powers),
        "rms": np.concatenate(spreads),
    }
    np.savez_compressed(data_path, **values)
    provenance = {
        "cacheIdentity": identity,
        "recording": route,
        "rawSha256": sha256(raw_path),
        "metricsSha256": sha256(data_path),
        "records": len(values["positions"]),
        "rejectedNonfinite": rejected,
        "power": "Frequency-mean squared CSI magnitude, summed over the antennas in each array; uncalibrated linear units.",
        "delaySpread": "Power-weighted RMS over calibrated CIR taps 495:555 after common delay removal; 20 ns/tap.",
        "boundsXY": list(BOUNDS),
    }
    write_json(provenance_path, provenance)
    print(f"{route}: {len(values['positions'])} records", flush=True)
    return values, provenance


def plot_normalization(quantity, samples, array_peak, mode):
    from matplotlib.colors import LogNorm, Normalize

    is_array_power = quantity.startswith("PowerArray")
    is_power = quantity.startswith("Power")
    reference = array_peak if is_array_power else float(samples.max())

    if is_power and mode != "legacy":
        reference = max(float(samples.max()), np.finfo(float).tiny)
        positive = samples[samples > 0]
        lower_sample = float(np.percentile(positive, 1)) if len(positive) else reference
        span = 10 * np.log10(reference / max(lower_sample, np.finfo(float).tiny))
        range_db = max(MIN_POWER_RANGE_DB, 5 * np.ceil(span / 5))
        floor = reference * 10 ** (-range_db / 10)
        norm = LogNorm(floor, reference, clip=True)
        scale = {
            "min": -float(range_db),
            "max": 0,
            "units": "dB relative to recording peak",
            "referenceLinear": reference,
            "sharedArrays": False,
            "lowerPercentile": 1,
            "aggregation": "Mean linear power before logarithmic colour mapping",
        }
        return norm, scale

    lower = 0.0 if is_array_power else float(samples.min())
    upper = reference if reference > lower else lower + 1
    norm = Normalize(lower, upper) if is_array_power else None
    scale = {
        "min": lower,
        "max": upper,
        "units": "linear CSI power" if is_power else "ns",
    }
    return norm, scale



def hexbin_layout():
    # Matplotlib's hexagons have side length sy/3; sy=sqrt(3)*sx makes
    # all six sides equal in metres, regardless of a recording's footprint.
    sx = HEX_WIDTH_METERS
    sy = np.sqrt(3) * sx
    nx = int(np.ceil((BOUNDS[1] - BOUNDS[0]) / sx))
    ny = int(np.ceil((BOUNDS[3] - BOUNDS[2]) / sy))
    extent = (BOUNDS[0], BOUNDS[0] + nx * sx, BOUNDS[2], BOUNDS[2] + ny * sy)
    return {"gridsize": (nx, ny), "extent": extent}


def draw_overlay(positions, samples, quantity, style, mode, norm, destination):
    import matplotlib.pyplot as plt

    width, height = 2460, 1050
    if mode != "legacy":
        aspect = (BOUNDS[1] - BOUNDS[0]) / (BOUNDS[3] - BOUNDS[2])
        width, height = (2460, round(2460 / aspect)) if aspect >= 1 else (round(2460 * aspect), 2460)
    marker_size = 4
    if mode == "legacy":
        # These canvas and marker sizes reproduce the original bundled plots.
        if quantity.startswith("Power"):
            width, height, marker_size = 3808, 1617, 81
        else:
            width, height, marker_size = 4920, 2100, 2

    figure = plt.figure(figsize=(width / 100, height / 100), dpi=100)
    try:
        axes = figure.add_axes([0, 0, 1, 1])
        axes.set_axis_off()
        if style == "Scatter":
            artist = axes.scatter(
                positions[:, 0],
                positions[:, 1],
                c=samples,
                s=marker_size,
                cmap="viridis",
                norm=norm,
                linewidths=0,
            )
        else:
            # Bin linear power before applying LogNorm. Averaging dB values
            # instead would produce a geometric mean and change the statistic.
            artist = axes.hexbin(
                positions[:, 0],
                positions[:, 1],
                C=samples,
                **({"gridsize": 30} if mode == "legacy" else hexbin_layout()),
                reduce_C_function=np.mean,
                mincnt=1,
                cmap="viridis",
                norm=norm,
                linewidths=0,
            )
        axes.set_xlim(BOUNDS[:2])
        axes.set_ylim(BOUNDS[2:])
        figure.savefig(destination, transparent=True, dpi=100)
        return {"min": float(artist.norm.vmin), "max": float(artist.norm.vmax)}
    finally:
        plt.close(figure)


def render(values, output, route, mode="compact", only_array_power=False):
    import matplotlib

    matplotlib.use("Agg")

    output.mkdir(parents=True, exist_ok=True)
    positions = values["positions"]
    inside = (
        (positions[:, 0] >= BOUNDS[0])
        & (positions[:, 0] <= BOUNDS[1])
        & (positions[:, 1] >= BOUNDS[2])
        & (positions[:, 1] <= BOUNDS[3])
    )
    positions = positions[inside]
    power = values["power"][inside]
    spread = values["rms"][inside]
    if not len(positions):
        raise ValueError("No samples inside overlay bounds")

    quantities = {f"PowerArray{array}": power[:, array] for array in range(power.shape[1])}
    if not only_array_power:
        quantities["Power"] = power.sum(axis=1)
        quantities.update(
            {f"DelaySpreadArray{array}": spread[:, array] for array in range(power.shape[1])}
        )

    scales = {}
    for quantity, samples in quantities.items():
        norm, scale = plot_normalization(quantity, samples, float(power.max()), mode)
        for style in PLOT_STYLES:
            destination = output / f"{quantity}_{style}_{route}.png"
            limits = draw_overlay(
                positions, samples, quantity, style, mode, norm, destination
            )
            if "referenceLinear" in scale:
                limits = {"min": scale["min"], "max": scale["max"]}
            scale[style] = limits
        scales[quantity] = scale
    return scales


def download_manifest(routes, dataset):
    import urllib.parse
    import urllib.request
    from download_dataset import API, DOI, select_files, download_file

    url = f"{API}/datasets/:persistentId/versions/3.0?" + urllib.parse.urlencode(
        {"persistentId": DOI}
    )
    with urllib.request.urlopen(url, timeout=30) as response:
        version = json.load(response)["data"]
    files = {file["filename"]: file for file in select_files(version, routes, True)}
    dataset.mkdir(parents=True, exist_ok=True)
    download_file(files["spec.json"], dataset)
    return files


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset", type=Path, default=Path.home() / "Downloads/dichasus-adxx"
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--routes", nargs="+")
    selection.add_argument(
        "--all-routes",
        action="store_true",
        help="Process all 27 available adxx recordings",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.home() / "Downloads/dichasus-adxx/route-plots",
    )
    parser.add_argument(
        "--mode",
        choices=["legacy", "compact"],
        default="compact",
        help="Original linear plots or compact plots with dB power colours",
    )
    parser.add_argument("--only-array-power", action="store_true")
    parser.add_argument(
        "--download-missing",
        action="store_true",
        help="Download and checksum-verify missing version-3.0 inputs",
    )
    parser.add_argument(
        "--discard-downloads",
        action="store_true",
        help="Remove only newly downloaded raw recordings after saving metrics and plots",
    )
    parser.add_argument("--bounds", type=float, nargs=4, default=BOUNDS)
    args = parser.parse_args()
    if args.discard_downloads and not args.download_missing:
        parser.error("--discard-downloads requires --download-missing")
    args.routes = ALL_ROUTES if args.all_routes else (args.routes or DEFAULT_ROUTES)
    return args



def existing_reports(output, mode):
    path = output / "generation.json"
    if not path.exists():
        return {}
    report = json.loads(path.read_text())
    if report.get("mode") != mode:
        raise ValueError("Use a separate output directory for compact and legacy plots")
    return report.get("routes", {})


def main():
    from download_dataset import download_file

    global BOUNDS
    args = parse_args()
    BOUNDS = tuple(args.bounds)
    if not np.isfinite(BOUNDS).all() or BOUNDS[0] >= BOUNDS[1] or BOUNDS[2] >= BOUNDS[3]:
        raise ValueError("Invalid plot bounds")
    downloads = (
        download_manifest(args.routes, args.dataset) if args.download_missing else None
    )
    reports = existing_reports(args.output, args.mode)
    args.output.mkdir(parents=True, exist_ok=True)
    for route in args.routes:
        raw = args.dataset / f"dichasus-{route}.tfrecords"
        created_raw = False
        if downloads:
            download_file(
                downloads[f"reftx-offsets-dichasus-{route}.json"], args.dataset
            )
        try:
            values, provenance = metrics(
                args.dataset, route, args.dataset / "route-metrics"
            )
        except FileNotFoundError:
            if not downloads:
                raise
            created_raw = not raw.exists()
            download_file(downloads[raw.name], args.dataset)
            values, provenance = metrics(
                args.dataset, route, args.dataset / "route-metrics"
            )

        scales = render(values, args.output, route, args.mode, args.only_array_power)
        reports[route] = {"source": provenance, "scales": scales}
        if downloads:
            reports[route]["datasetFile"] = downloads[raw.name]
        write_json(
            args.output / "generation.json",
            {
                "version": VERSION,
                "mode": args.mode,
                "routes": reports,
            },
        )
        if created_raw and args.discard_downloads:
            raw.unlink()
        print(f"Rendered {route}", flush=True)


if __name__ == "__main__":
    main()
