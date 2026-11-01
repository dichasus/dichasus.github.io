const coverageCanvas = document.getElementById('coverage-map');
const coverageContext = coverageCanvas.getContext('2d');
const coverageBase = document.createElement('canvas');
coverageBase.width = coverageCanvas.width;
coverageBase.height = coverageCanvas.height;
let coverageBaseDirty = true;
let coverageCells = null;
let floorplanSegments = [];
const mapExtent = {
    minX: RadioCore.config.minX - 1,
    maxX: RadioCore.config.maxX + 2,
    minY: RadioCore.config.minY - 1,
    maxY: RadioCore.config.maxY + 1.5,
};
const mapWidth = Math.min(
    mapExtent.maxX - mapExtent.minX,
    ((mapExtent.maxY - mapExtent.minY) * (coverageCanvas.width - 12)) /
        (coverageCanvas.height - 12),
);
const mapBounds = { ...mapExtent, minX: mapExtent.maxX - mapWidth };
function panMinimap(minX) {
    const next = THREE.MathUtils.clamp(minX, mapExtent.minX, mapExtent.maxX - mapWidth);
    if (Math.abs(next - mapBounds.minX) < 1e-6) return false;
    mapBounds.minX = next;
    mapBounds.maxX = next + mapWidth;
    coverageBaseDirty = true;
    return true;
}
function followMinimapRobot() {
    if (!model || mapPointer !== null) return;
    const margin = mapWidth * 0.18;
    if (model.position.x < mapBounds.minX + margin) panMinimap(model.position.x - margin);
    else if (model.position.x > mapBounds.maxX - margin)
        panMinimap(model.position.x + margin - mapWidth);
}
const arrayLocations = RadioCore.arrayGeometry.map((array) => array.location.slice(0, 2));

function coverageTransform() {
    const padding = 6;
    const scale = Math.min(
        (coverageCanvas.width - 2 * padding) / (mapBounds.maxX - mapBounds.minX),
        (coverageCanvas.height - 2 * padding) / (mapBounds.maxY - mapBounds.minY),
    );
    const left = (coverageCanvas.width - (mapBounds.maxX - mapBounds.minX) * scale) / 2;
    const top = (coverageCanvas.height - (mapBounds.maxY - mapBounds.minY) * scale) / 2;
    return {
        scale,
        left,
        top,
        x: (x) => left + (x - mapBounds.minX) * scale,
        y: (y) => top + (mapBounds.maxY - y) * scale,
    };
}
function redrawCoverageBase() {
    const ctx = coverageBase.getContext('2d'),
        transform = coverageTransform();
    ctx.clearRect(0, 0, coverageCanvas.width, coverageCanvas.height);
    ctx.fillStyle = '#222a30';
    ctx.fillRect(0, 0, coverageCanvas.width, coverageCanvas.height);
    ctx.fillStyle = '#363f45';
    const { pathMinX, pathMaxX, pathMinY, pathMaxY } = RadioCore.config;
    ctx.fillRect(
        transform.x(pathMinX),
        transform.y(pathMaxY),
        (pathMaxX - pathMinX) * transform.scale,
        (pathMaxY - pathMinY) * transform.scale,
    );
    if (coverageCells) {
        ctx.fillStyle = '#687e87';
        for (let bin = 0; bin < RadioCore.binCount; bin++) {
            if (!(coverageCells[bin >> 3] & (1 << (bin & 7)))) continue;
            const bounds = RadioCore.binBounds(bin);
            ctx.fillRect(
                transform.x(bounds.minX),
                transform.y(bounds.maxY),
                (bounds.maxX - bounds.minX) * transform.scale + 0.4,
                (bounds.maxY - bounds.minY) * transform.scale + 0.4,
            );
        }
    }
    ctx.strokeStyle = '#d5dadd';
    ctx.lineWidth = 1.8;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, coverageCanvas.width, coverageCanvas.height);
    ctx.clip();
    ctx.beginPath();
    for (const [a, b] of floorplanSegments) {
        ctx.moveTo(transform.x(a[0]), transform.y(a[1]));
        ctx.lineTo(transform.x(b[0]), transform.y(b[1]));
    }
    ctx.stroke();
    ctx.restore();
    const labelSize =
        (16 * coverageCanvas.width) / (coverageCanvas.clientWidth || coverageCanvas.width);
    ctx.font = `${labelSize}px system-ui`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#d5dadd';
    ctx.font = `${labelSize}px system-ui`;
    ctx.textAlign = 'left';
    ctx.fillText('X →', 65, coverageCanvas.height - 10);
    ctx.fillText('Y ↑', 10, coverageCanvas.height - 10);
    coverageBaseDirty = false;
}
function drawReceiverMarkers(ctx, transform) {
    const pixelScale = coverageCanvas.width / (coverageCanvas.clientWidth || coverageCanvas.width);
    const phase = arrayPanelMaterial.uniforms.phase.value;
    ctx.save();
    arrayLocations.forEach(([x, y], index) => {
        const px = transform.x(x),
            py = transform.y(y);
        if (px < -24 || px > coverageCanvas.width + 24) return;
        ctx.strokeStyle = arrayColorCss[index];
        ctx.lineWidth = 1.5 * pixelScale;
        for (let ring = 0; ring < 2; ring++) {
            const progress = (phase * 3 + ring * 0.5) % 1;
            ctx.globalAlpha = progress * 0.75;
            ctx.beginPath();
            ctx.arc(px, py, (1 - progress) * 18 * pixelScale, 0, 2 * Math.PI);
            ctx.stroke();
        }
    });
    ctx.restore();
    const labelSize = 16 * pixelScale;
    ctx.font = `${labelSize}px system-ui`;
    ctx.textAlign = 'left';
    arrayLocations.forEach(([x, y], index) => {
        const right = RadioCore.arrayGeometry[index].rightvector;
        ctx.save();
        ctx.translate(transform.x(x), transform.y(y));
        ctx.rotate(Math.atan2(-right[1], right[0]));
        ctx.fillStyle = arrayColorCss[index];
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.2;
        ctx.fillRect(-7, -2.5, 14, 5);
        ctx.strokeRect(-7, -2.5, 14, 5);
        ctx.restore();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#222a30';
        ctx.lineWidth = 4;
        const nearRight = transform.x(x) > coverageCanvas.width - 40;
        const labelX = transform.x(x) + (nearRight ? -9 : 9);
        const labelY = Math.max(20, Math.min(coverageCanvas.height - 20, transform.y(y) + 6));
        ctx.textAlign = nearRight ? 'right' : 'left';
        ctx.strokeText(`A${index}`, labelX, labelY);
        ctx.fillText(`A${index}`, labelX, labelY);
    });
}
function drawCoverageMap() {
    if (document.body.classList.contains('minimap-hidden')) return;
    followMinimapRobot();
    if (coverageBaseDirty) redrawCoverageBase();
    const ctx = coverageContext,
        transform = coverageTransform();
    ctx.clearRect(0, 0, coverageCanvas.width, coverageCanvas.height);
    ctx.drawImage(coverageBase, 0, 0);
    drawReceiverMarkers(ctx, transform);
    if (model) {
        const x = transform.x(model.position.x),
            y = transform.y(-model.position.z);
        const phase = txBeaconMaterial.uniforms.phase.value;
        const pixelScale =
            coverageCanvas.width / (coverageCanvas.clientWidth || coverageCanvas.width);
        ctx.save();
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 17 * pixelScale);
        glow.addColorStop(0, 'rgba(0,190,255,0.45)');
        glow.addColorStop(1, 'rgba(0,190,255,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 17 * pixelScale, y - 17 * pixelScale, 34 * pixelScale, 34 * pixelScale);
        for (let ring = 0; ring < 2; ring++) {
            const progress = (phase * 3 + ring * 0.5) % 1;
            ctx.strokeStyle = `rgba(0,190,255,${0.7 * (1 - progress)})`;
            ctx.lineWidth = 1.5 * pixelScale;
            ctx.beginPath();
            ctx.arc(x, y, (7 + 16 * progress) * pixelScale, 0, 2 * Math.PI);
            ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#101927';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y - 9);
        ctx.lineTo(x + 7, y);
        ctx.lineTo(x, y + 9);
        ctx.lineTo(x - 7, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
}
function nearestMeasuredPosition(x, y) {
    if (!coverageCells) return null;
    let nearest = null,
        distance = Infinity;
    for (let bin = 0; bin < RadioCore.binCount; bin++) {
        if (!(coverageCells[bin >> 3] & (1 << (bin & 7)))) continue;
        const cell = RadioCore.binBounds(bin);
        const squared = (cell.x - x) ** 2 + (cell.y - y) ** 2;
        if (squared < distance) {
            nearest = cell;
            distance = squared;
        }
    }
    return nearest;
}
function moveFromMinimap(event) {
    const rect = coverageCanvas.getBoundingClientRect(),
        transform = coverageTransform();
    const x = ((event.clientX - rect.left) / rect.width) * coverageCanvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * coverageCanvas.height;
    setRobotPosition(
        mapBounds.minX + (x - transform.left) / transform.scale,
        mapBounds.maxY - (y - transform.top) / transform.scale,
    );
}
let mapPointer = null;
let mapDragFrame = null;
let pendingMapPosition = null;
let previousMapDragTime = null;
function advanceMapDrag(timestamp) {
    if (mapPointer === null) return;
    const dt =
        previousMapDragTime === null ? 0 : Math.min((timestamp - previousMapDragTime) / 1000, 0.05);
    previousMapDragTime = timestamp;
    if (pendingMapPosition) {
        const rect = coverageCanvas.getBoundingClientRect();
        const fraction = (pendingMapPosition.clientX - rect.left) / rect.width;
        const edge = 0.18;
        const velocity =
            fraction < edge
                ? -Math.min(1, (edge - fraction) / edge)
                : fraction > 1 - edge
                  ? Math.min(1, (fraction - 1 + edge) / edge)
                  : 0;
        const moved = panMinimap(mapBounds.minX + velocity * mapWidth * 0.35 * dt);
        moveFromMinimap(pendingMapPosition);
        if (moved) drawCoverageMap();
    }
    mapDragFrame = requestAnimationFrame(advanceMapDrag);
}
function finishMapDrag(event) {
    if (event.pointerId !== mapPointer) return;
    if (event.type === 'pointerup') moveFromMinimap(event);
    mapPointer = null;
    pendingMapPosition = null;
    previousMapDragTime = null;
    if (mapDragFrame !== null) cancelAnimationFrame(mapDragFrame);
    mapDragFrame = null;
    if (coverageCanvas.hasPointerCapture(event.pointerId))
        coverageCanvas.releasePointerCapture(event.pointerId);
    drawCoverageMap();
}
coverageCanvas.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || mapPointer !== null) return;
    event.preventDefault();
    coverageCanvas.focus({ preventScroll: true });
    mapPointer = event.pointerId;
    coverageCanvas.setPointerCapture(event.pointerId);
    pendingMapPosition = { clientX: event.clientX, clientY: event.clientY };
    moveFromMinimap(event);
    mapDragFrame = requestAnimationFrame(advanceMapDrag);
});
coverageCanvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== mapPointer) return;
    pendingMapPosition = { clientX: event.clientX, clientY: event.clientY };
});
coverageCanvas.addEventListener('pointerup', finishMapDrag);
coverageCanvas.addEventListener('pointercancel', finishMapDrag);
coverageCanvas.addEventListener('lostpointercapture', finishMapDrag);
window.addEventListener('blur', () => {
    if (mapPointer !== null) finishMapDrag({ pointerId: mapPointer, type: 'pointercancel' });
});
coverageCanvas.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        document.getElementById('nearest-measurement').click();
    }
});
document.getElementById('nearest-measurement').addEventListener('click', () => {
    if (!model) return;
    const nearest = nearestMeasuredPosition(model.position.x, -model.position.z);
    if (nearest) setRobotPosition(nearest.x, nearest.y);
});
window.addEventListener('robot-position', drawCoverageMap);
function loadCoverage() {
    return csiLoader
        .loadIndex()
        .then((index) => {
            if (
                index.version !== 1 ||
                index.depth !== RadioCore.config.depth ||
                index.sourceBytes !== RadioCore.binCount * RadioCore.bytesPerBin ||
                JSON.stringify(index.bounds) !==
                    JSON.stringify([
                        RadioCore.config.minX,
                        RadioCore.config.maxX,
                        RadioCore.config.minY,
                        RadioCore.config.maxY,
                    ])
            )
                throw new Error('Coverage index does not match the channel grid');
            const cells = Uint8Array.from(atob(index.occupancy), (char) => char.charCodeAt(0));
            if (cells.length !== Math.ceil(RadioCore.binCount / 8))
                throw new Error('Invalid coverage index');
            coverageCells = cells;
            coverageBaseDirty = true;
            document.getElementById('nearest-measurement').disabled = false;
            document.getElementById('coverage-status').textContent = '';
            document.getElementById('coverage-status').hidden = true;
            drawCoverageMap();
        })
        .catch((error) => {
            document.getElementById('coverage-status').textContent = error.message;
            document.getElementById('coverage-status').hidden = false;
            document.getElementById('nearest-measurement').disabled = true;
        });
}
loadCoverage();
window.addEventListener('csi-loaded', () => {
    if (!coverageCells) loadCoverage();
});
drawCoverageMap();

fetch(`${RadioCore.dataPrefix}data/floorplan.json`)
    .then((response) => {
        if (!response.ok) throw new Error('Floorplan unavailable');
        return response.json();
    })
    .then((data) => {
        if (
            !Array.isArray(data.segments) ||
            data.segments.some(
                (line) =>
                    !Array.isArray(line) ||
                    line.length !== 2 ||
                    line.some(
                        (point) =>
                            !Array.isArray(point) ||
                            point.length !== 2 ||
                            !point.every(Number.isFinite),
                    ),
            )
        )
            throw new Error('Invalid floorplan');
        floorplanSegments = data.segments;
        coverageBaseDirty = true;
        drawCoverageMap();
    })
    .catch(() => {
        /* The measured coverage map remains usable without outlines. */
    });

new ResizeObserver(() => {
    coverageBaseDirty = true;
    drawCoverageMap();
}).observe(coverageCanvas);
