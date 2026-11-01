const pressedKeys = new Set();
const movementKeys = new Set([
    'w',
    'a',
    's',
    'd',
    ' ',
    'Shift',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
]);
let model;
const cameraDirection = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const robotStart = new THREE.Vector3(...(RadioCore.dataset.robotStart || [-5, 0, 7.5]));
const txBeaconMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { phase: { value: 0 }, pixel_ratio: { value: renderer.getPixelRatio() } },
    vertexShader: `
        uniform float pixel_ratio;
        void main() {
            vec4 p = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(520.0 / max(-p.z, 1.0), 40.0, 140.0) * pixel_ratio;
            gl_Position = projectionMatrix * p;
        }
    `,
    fragmentShader: `
        uniform float phase;
        void main() {
            float radius = length(gl_PointCoord - 0.5) * 2.0;
            float glow = exp(-radius * radius * 24.0) * 0.65;
            for (int i = 0; i < 2; ++i) {
                float ring = fract(phase * 3.0 + float(i) * 0.5);
                glow += exp(-pow((radius - ring) / 0.035, 2.0)) * (1.0 - ring) * 0.42;
            }
            float alpha = glow * (1.0 - smoothstep(0.8, 1.0, radius));
            if (alpha < 0.01) discard;
            gl_FragColor = vec4(mix(vec3(0.0, 0.65, 1.0), vec3(0.85, 0.96, 1.0), exp(-radius * radius * 80.0)), alpha);
        }
    `,
});
// Visual locator, 5 cm above the antenna; the robot follows the dataset floor height.
const txBeacon = new THREE.Points(
    new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute([0, 1.12, 0], 3),
    ),
    txBeaconMaterial,
);
txBeacon.name = 'TX locator glow';
txBeacon.frustumCulled = false;
txBeacon.renderOrder = 6;

function isEditingControl(target) {
    return (
        target instanceof HTMLElement &&
        (target.matches('input, select, textarea, [role=slider]') || target.isContentEditable)
    );
}
document.addEventListener('keydown', (event) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const sliderMovement =
        ['w', 'a', 's', 'd'].includes(key) &&
        event.target instanceof HTMLElement &&
        event.target.matches('[role=slider], input[type=range]') &&
        !event.target.isContentEditable;
    if (
        event.defaultPrevented ||
        (isEditingControl(event.target) && !sliderMovement) ||
        document.getElementById('help-modal').open
    )
        return;
    if (!movementKeys.has(key)) return;
    if (key.startsWith('Arrow') || 'wasd'.includes(key) || controls.isLocked) {
        event.preventDefault();
        pressedKeys.add(key);
    }
});
document.addEventListener('keyup', (event) =>
    pressedKeys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key),
);
window.addEventListener('blur', () => pressedKeys.clear());
document.addEventListener('visibilitychange', () => pressedKeys.clear());
controls.addEventListener('unlock', () => pressedKeys.clear());

setViewerStatus('robot', 'Loading mobile transmitter…', 'loading');
loadPackedModel(RadioCore.dataset.robotModel || 'assets/robot.glb')
    .then((gltf) => {
        model = gltf.scene;
        model.add(txBeacon);
        model.position.copy(robotStart);
        scene.add(model);
        setViewerStatus('robot', 'Mobile transmitter ready');
        if (viewerReady) refreshRobotData();
    })
    .catch(() => setViewerStatus('robot', 'Unable to load the robot model', 'error'));

function refreshRobotData() {
    if (!model) return;
    invalidateScene();
    scheduleNearbyData();
    visualizeRadiationPattern(model.position);
    visualizePaths(model.position);
    updatePathVisibility();
    window.dispatchEvent(
        new CustomEvent('robot-position', {
            detail: { x: model.position.x, y: -model.position.z },
        }),
    );
}

function setRobotPosition(x, y) {
    if (!model || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // Union of measured CSI and simulated-path footprints.
    const newX = THREE.MathUtils.clamp(x, RadioCore.config.pathMinX, RadioCore.config.pathMaxX);
    const newY = THREE.MathUtils.clamp(y, RadioCore.config.pathMinY, RadioCore.config.pathMaxY);
    if (model.position.x === newX && model.position.z === -newY) return;
    model.position.set(newX, RadioCore.dataset.groundHeight || 0, -newY);
    refreshRobotData();
}

let nearbyTimer = null;
let nearbyRevision = 0;
let previousDataPosition = null;
let travelDirection = { x: 0, y: 0 };

function scheduleNearbyData() {
    const x = model.position.x,
        y = -model.position.z;
    if (previousDataPosition) {
        const dx = x - previousDataPosition.x,
            dy = y - previousDataPosition.y;
        const length = Math.hypot(dx, dy);
        if (length) travelDirection = { x: dx / length, y: dy / length };
    }
    previousDataPosition = { x, y };
    nearbyRevision++;
    if (nearbyTimer === null) nearbyTimer = setTimeout(preloadNearbyData, 150);
}

async function preloadNearbyData() {
    const revision = nearbyRevision;
    try {
        if (
            !model ||
            !csiLoader.index ||
            viewerStatus.environment?.state !== 'ready' ||
            navigator.connection?.saveData ||
            document.hidden
        )
            return;
        // One speculative request at a time, with forward positions first.
        // The same small neighborhood also helps when dragging the minimap.
        const x = model.position.x,
            y = -model.position.z;
        const offsets = [1, 0.5, 0.2].map((distance) => [
            travelDirection.x * distance,
            travelDirection.y * distance,
        ]);
        offsets.push([0.5, 0], [-0.5, 0], [0, 0.2], [0, -0.2]);
        for (const [dx, dy] of offsets) {
            if (revision !== nearbyRevision) return;
            const bin = RadioCore.positionToBin(x + dx, y + dy);
            if (bin === null || !(csiLoader.index.cells[bin >> 3] & (1 << (bin & 7)))) continue;
            await csiLoader.get(bin);
            const indices = RadioCore.pathIndices(x + dx, y + dy, bin);
            if (indices) await pathLoader.loadBlock(indices.column, indices.row);
        }
    } catch (_) {
        // Foreground loads report errors and retry when the position is selected.
    } finally {
        nearbyTimer = null;
        if (revision !== nearbyRevision) nearbyTimer = setTimeout(preloadNearbyData, 150);
    }
}

function updateMovement(delta) {
    if (model) {
        const dx =
            Number(pressedKeys.has('ArrowRight') || (!controls.isLocked && pressedKeys.has('d'))) -
            Number(pressedKeys.has('ArrowLeft') || (!controls.isLocked && pressedKeys.has('a')));
        const dy =
            Number(pressedKeys.has('ArrowUp') || (!controls.isLocked && pressedKeys.has('w'))) -
            Number(pressedKeys.has('ArrowDown') || (!controls.isLocked && pressedKeys.has('s')));
        if (dx || dy) {
            const length = Math.hypot(dx, dy);
            const distance = 2 * delta;
            setRobotPosition(
                model.position.x + (dx / length) * distance,
                -model.position.z + (dy / length) * distance,
            );
        }
    }
    if (!controls.isLocked) return;
    controls.getDirection(cameraDirection);
    cameraRight.crossVectors(cameraDirection, worldUp).normalize();
    const forward = Number(pressedKeys.has('w')) - Number(pressedKeys.has('s'));
    const right = Number(pressedKeys.has('d')) - Number(pressedKeys.has('a'));
    const up = Number(pressedKeys.has(' ')) - Number(pressedKeys.has('Shift'));
    if (forward || right || up) invalidateScene();
    const length = Math.hypot(forward, right, up) || 1;
    const distance = (6 * delta) / length;
    camera.position.addScaledVector(cameraDirection, forward * distance);
    camera.position.addScaledVector(cameraRight, right * distance);
    camera.position.y += up * distance;
}

window.addEventListener('viewer-status', (event) => {
    if (
        event.detail.state === 'ready' &&
        ['csi', 'paths', 'environment'].includes(event.detail.key) &&
        nearbyTimer === null
    ) {
        nearbyTimer = setTimeout(preloadNearbyData, 150);
    }
});
