# 3D radio propagation viewer

Run `hugo server` at the site root. Both datasets use the same HTML template in
`layouts/visualization/viewer.html` and JavaScript/CSS in `static/visualization/shared/`.
Their data lives in the neighbouring `adxx/` and `dcxx/` folders. There is no JS build step.

Run the commands below from this directory. Downloads and intermediate files stay
in `~/Downloads`; only the packed viewer data is published.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
python3 -m venv .venv-rt
.venv-rt/bin/pip install -r requirements-rt.txt
```

## adxx

```sh
.venv/bin/python scripts/download_dataset.py --routes ad07 ad08 ad10 ad11 ad18 ad19 --include-csi --download
.venv/bin/python scripts/build_channels.py
.venv/bin/python scripts/pack_channels.py
.venv/bin/python scripts/build_route_plots.py --all-routes --download-missing --discard-downloads
.venv/bin/python scripts/pack_plots.py
.venv-rt/bin/python scripts/generate_paths.py --comparison raytracer-selection.json --coverage ../../static/visualization/adxx/data/coverage.json --all-columns --batch-size 32 --max-depth 1 --min-relative-power-db -30
.venv-rt/bin/python scripts/pack_paths.py --max-reflections 1
```

Patterns combine six recordings with offset and gain corrections. The 2D plots
cover all 27 recordings; cached metrics avoid repeat downloads.
`--discard-downloads` removes only recordings downloaded by that run.
The Sionna scene is in `scene/`; use `--resume` after an interrupted simulation.

## dcxx

```sh
.venv/bin/python scripts/download_dataset.py --dataset dcxx --include-csi --download
.venv/bin/python scripts/build_dcxx.py --stage measurements --site ../..
.venv-rt/bin/python scripts/build_dcxx.py --stage rays --site ../..
.venv/bin/python scripts/build_dcxx.py --stage publish --site ../..
```

The three configurations use dc01, dc10 and dc20, with their models and offset
estimates from the dataset page. Simulations use ITU material estimates and at
most one reflection. Each configuration has separate measurements, rays and plots.
`--variants no-walls` (or `southwest-wall`, `northwest-wall`) limits a rebuild.

Data: [adxx](https://doi.org/10.18419/darus-4062),
[dcxx](https://doi.org/10.18419/darus-3831), CC BY 4.0.
Software: Florian Euchner (AI-assisted), Johannes Sommerer.
Original adxx 3D model: Darius Siebert.
