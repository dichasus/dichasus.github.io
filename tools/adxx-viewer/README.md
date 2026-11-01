# adxx 3D viewer

The viewer lives in `static/visualization/adxx/`. Run `hugo server` at the site
root to preview it. There is no JavaScript build step.

To rebuild the data, run the commands below from this directory. Downloads and
intermediate files go in `~/Downloads/dichasus-adxx`; the scripts accept other
locations through command-line options.

## Measurements and plots

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/download_dataset.py --version 3.0 --routes ad07 ad08 ad10 ad11 ad18 ad19 --include-csi --download
.venv/bin/python scripts/build_channels.py
.venv/bin/python scripts/pack_channels.py
.venv/bin/python scripts/build_route_plots.py --all-routes --download-missing --discard-downloads
.venv/bin/python scripts/pack_plots.py
```

The 3D patterns combine these six recordings with their calibration offsets and
receiver gains corrected. The 2D plots cover all 27 recordings. Plot metrics are
cached, so changing the plots does not require another download.
`--discard-downloads` removes only recordings downloaded by that run.

## Sionna RT

```sh
python3 -m venv .venv-rt
.venv-rt/bin/pip install -r requirements-rt.txt
.venv-rt/bin/python scripts/generate_paths.py --comparison raytracer-selection.json --coverage ../../static/visualization/adxx/data/coverage.json --all-columns --batch-size 32 --max-depth 1 --min-relative-power-db -30
.venv-rt/bin/python scripts/pack_paths.py --max-reflections 1
```

The scene is in `scene/`. Rays include at most one reflection and are generated
only where measurements exist. Rebuild them if measurement coverage changes;
use `--resume` to continue an interrupted simulation.

Data: [DICHASUS adxx](https://doi.org/10.18419/darus-4062), CC BY 4.0.
Software: Florian Euchner (AI-assisted), Johannes Sommerer.
Original 3D model: Darius Siebert.
