const textureLoader = new THREE.TextureLoader();
const plotBounds = RadioCore.dataset.plotBounds || [-70, 12, -35, 0];
const plotGeometry = new THREE.PlaneGeometry(
    plotBounds[1] - plotBounds[0],
    plotBounds[3] - plotBounds[2],
);
plotGeometry.rotateX(-Math.PI / 2);
const plotMaterial = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
});
const plane = new THREE.Mesh(plotGeometry, plotMaterial);
plane.position.set(
    (plotBounds[0] + plotBounds[1]) / 2,
    RadioCore.dataset.plotHeight ?? 1.075,
    -(plotBounds[2] + plotBounds[3]) / 2,
);
plane.visible = false;
scene.add(plane);

const routeSelect = document.getElementById('plot-route');
const quantitySelect = document.getElementById('plot-quantity');
const styleSelect = document.getElementById('plot-style');
const showPlot = document.getElementById('show-plot');
const plotStatus = document.getElementById('plot-status');
const plotScale = document.getElementById('plot-scale');
let plotRevision = 0;
let activePlotName = null;
let plotAssetsPromise = null;
let plotRequest = null;

const plotRoutes =
    RadioCore.dataset.routes ||
    Array.from({ length: 28 }, (_, i) => `ad${String(i).padStart(2, '0')}`).filter(
        (route) => route !== 'ad20',
    );
for (const route of plotRoutes) routeSelect.add(new Option(route, route));
for (const option of [...quantitySelect.options]) {
    const array = option.value.match(/Array(\d+)$/);
    if (array && Number(array[1]) >= RadioCore.config.arrays) option.remove();
}

async function plotAssets() {
    if (!plotAssetsPromise) {
        plotAssetsPromise = fetch(`${RadioCore.dataPrefix}data/plot-assets.json`)
            .then(async (response) => {
                if (response.status === 404) return null;
                if (!response.ok) throw new Error('Route overlay index unavailable');
                const manifest = await response.json();
                if (
                    manifest.version !== 1 ||
                    !manifest.plots ||
                    typeof manifest.plots !== 'object'
                ) {
                    throw new Error('Invalid route overlay index');
                }
                return manifest.plots;
            })
            .catch((error) => {
                plotAssetsPromise = null;
                throw error;
            });
    }
    return plotAssetsPromise;
}

function availablePlotRoute(assets, quantity, style) {
    for (const option of routeSelect.options) {
        option.disabled = !!assets && !assets[`${quantity}_${style}_${option.value}`];
        option.hidden = option.disabled;
    }
    if (routeSelect.selectedOptions[0]?.disabled) {
        const available = [...routeSelect.options].find((option) => !option.disabled);
        if (!available) throw new Error('No overlays for this quantity');
        routeSelect.value = available.value;
    }
    return routeSelect.value;
}

function showPlotScale(scale) {
    const decibels = scale?.units === 'dB relative to recording peak';
    const delaySpread = scale?.units === 'ns';
    plotScale.hidden = !decibels && !delaySpread;
    if (plotScale.hidden) return;

    const unit = decibels ? 'dB' : 'ns';
    const format = (value) => Number(value.toFixed(1)).toString();
    const endpoints = plotScale.querySelectorAll('span');
    endpoints[0].textContent = `${format(scale.min)} ${unit}`;
    endpoints[1].textContent = `${format(scale.max)} ${unit}`;
    plotScale.setAttribute(
        'aria-label',
        `${delaySpread ? 'RMS delay spread' : 'Relative received power'}, ${format(scale.min)} to ${format(scale.max)} ${unit}`,
    );
    plotScale.title = delaySpread
        ? 'RMS delay spread in nanoseconds.'
        : scale.sharedArrays
          ? 'Array power relative to the strongest array sample in this recording; A0–A3 share one reference.'
          : `${quantitySelect.value.startsWith('PowerArray') ? 'This array’s' : 'Combined'} power relative to its strongest sample in this recording.`;
}

function hidePlot() {
    plane.visible = false;
    plotScale.hidden = true;
    invalidateScene();
}

async function loadPlotTexture(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Route overlay unavailable');
    const blob = await response.blob();
    signal.throwIfAborted();
    const imageUrl = URL.createObjectURL(blob);
    try {
        return await textureLoader.loadAsync(imageUrl);
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
}

async function updatePlot() {
    const revision = ++plotRevision;
    plotRequest?.abort();
    plotRequest = null;
    const quantity = quantitySelect.value;
    const style = styleSelect.value;
    if (!showPlot.checked) {
        hidePlot();
        plotStatus.textContent = '';
        return;
    }

    const failed = () => {
        if (revision !== plotRevision) return;
        showPlot.checked = false;
        hidePlot();
        plotStatus.textContent = 'This route overlay could not be loaded. Try again.';
    };

    try {
        const assets = await plotAssets();
        if (revision !== plotRevision) return;
        const route = availablePlotRoute(assets, quantity, style);
        const name = `${quantity}_${style}_${route}`;
        const entry = assets?.[name];
        const showLoadedPlot = () => {
            plane.visible = true;
            showPlotScale(entry?.scale);
            plotStatus.textContent = `Showing ${route} · ${style.toLowerCase()}`;
            invalidateScene();
        };
        if (name === activePlotName) {
            showLoadedPlot();
            return;
        }

        hidePlot();
        plotStatus.textContent = 'Loading route overlay…';
        let url = `${RadioCore.dataPrefix}Plots/${name}.png`;
        if (assets) {
            if (!/^[0-9a-f]{24}\.webp$/.test(entry?.file)) {
                throw new Error('Route overlay is missing from the index');
            }
            url = `${RadioCore.dataPrefix}Plots/packed/${entry.file}`;
        }
        const controller = new AbortController();
        plotRequest = controller;
        let texture;
        try {
            texture = await loadPlotTexture(url, controller.signal);
        } finally {
            if (plotRequest === controller) plotRequest = null;
        }
        // Image decoding may finish after a newer selection or Hide.
        if (revision !== plotRevision) {
            texture.dispose();
            return;
        }
        plotMaterial.map?.dispose();
        texture.encoding = THREE.sRGBEncoding;
        plotMaterial.map = texture;
        plotMaterial.needsUpdate = true;
        activePlotName = name;
        showLoadedPlot();
    } catch (_) {
        failed();
    }
}

showPlot.addEventListener('change', updatePlot);
for (const control of [quantitySelect, styleSelect, routeSelect]) {
    control.addEventListener('change', () => {
        showPlot.checked = true;
        updatePlot();
    });
}
document.getElementById('plot-opacity').addEventListener('input', (event) => {
    plotMaterial.opacity = Number(event.target.value);
    invalidateScene();
});
