#!/usr/bin/env python3
"""Compare conventional and smoothed Capon azimuth cuts on synthetic and published CSI."""

from pathlib import Path
import tempfile
import argparse, json, gzip, os

os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / 'dichasus-matplotlib'))
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.signal import find_peaks

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--viewer", type=Path, default=Path(__file__).resolve().parents[3] / 'static/visualization/adxx')
parser.add_argument(
    "--output",
    type=Path,
    default=Path.home() / "Downloads/dichasus-beamformer-comparison",
)
args = parser.parse_args()
root = args.viewer
args.output.mkdir(parents=True, exist_ok=True)
angles = np.linspace(-80, 80, 641)


def steering(columns):
    return np.exp(
        -1j
        * np.pi
        * np.sin(np.deg2rad(angles))[:, None]
        * np.tile(np.arange(columns), 2)
    )


def spectra(x, loading=0.05):
    conventional = np.mean(abs(x @ steering(8).conj().T) ** 2, axis=0)
    sub = np.stack(
        [
            x[:, np.r_[np.arange(k, k + 6), np.arange(8 + k, 8 + k + 6)]]
            for k in range(3)
        ]
    )
    r = np.einsum("sti,stj->ij", sub, sub.conj()) / (len(x) * 3)
    r = (r + r[::-1, ::-1].conj()) / 2
    load = loading * np.trace(r).real / 12
    inv = np.linalg.inv(r + max(load, 1e-20) * np.eye(12))
    a = steering(6)
    denom = np.einsum("ai,ij,aj->a", a.conj(), inv, a).real
    capon = 256 * np.maximum(0, 1 / np.maximum(denom, 1e-20) - load / 12)
    return conventional, capon


rng = np.random.default_rng(9)
# Coherent equal-strength arrivals, representative of unresolved multipath.
x = np.exp(-1j * np.pi * np.sin(np.deg2rad(-6)) * np.tile(np.arange(8), 2)) + np.exp(
    -1j * np.pi * np.sin(np.deg2rad(6)) * np.tile(np.arange(8), 2)
)
x = np.tile(x, (30, 1)) + 0.03 * (
    rng.normal(size=(30, 16)) + 1j * rng.normal(size=(30, 16))
)
cases = [("Coherent arrivals at -6° / +6°", x)]
cov = json.loads((root / "data/coverage.json").read_text())


def bin_for(x, y):
    lo, hi, bot, top = cov["bounds"]
    b = 0
    for _ in range(cov["depth"]):
        mx, my = (lo + hi) / 2, (bot + top) / 2
        hx, hy = x > mx, y > my
        b = 4 * b + hx + 2 * hy
        if hx:
            lo = mx
        else:
            hi = mx
        if hy:
            bot = my
        else:
            top = my
    return b


for px, py in [(-5, -7.5), (-8, -15), (0, -20)]:
    b = bin_for(px, py)
    name = cov["chunks"][b]
    if not name:
        continue
    raw = np.frombuffer(
        gzip.decompress((root / "data/channels" / name).read_bytes()), dtype="<c8"
    ).reshape(4, 16, 30)
    for i in [0, 1]:
        cases.append((f"Measured ({px}, {py}) · A{i}", raw[i].T))
fig, axes = plt.subplots(
    len(cases), 1, figsize=(9, len(cases) * 2.2), layout="constrained"
)
report = []
for ax, (name, x) in zip(axes, cases):
    curves = spectra(x)
    for values, label in zip(curves, ["Conventional", "Capon, 5% loading"]):
        ax.plot(angles, np.sqrt(values / max(curves[0].max(), 1e-20)), label=label)
    ax.set(title=name, xlim=(-80, 80), ylabel="Relative amplitude")
    ax.grid(alpha=0.2)
    peaks = [
        angles[find_peaks(v, prominence=0.1 * v.max())[0]].tolist() for v in curves
    ]
    report.append(dict(name=name, peaks=peaks))
axes[0].legend()
axes[-1].set_xlabel("Local azimuth [degrees]")
fig.savefig(args.output / "comparison.png", dpi=130)
(args.output / "comparison.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
