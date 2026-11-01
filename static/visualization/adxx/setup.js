const BANDWIDTH = RadioCore.config.bandwidth;
let rad_time_start = 0;
let rad_time_stop = 1;
let rad_time_duration = 1;
let sceneDirty = true;
let viewerReady = false;
function invalidateScene() {
    sceneDirty = true;
}
const viewerStatus = {};
function setViewerStatus(key, message, state = 'ready') {
    viewerStatus[key] = { message, state };
    invalidateScene();
    window.dispatchEvent(new CustomEvent('viewer-status', { detail: { key, message, state } }));
}

const scene = new THREE.Scene();
scene.background = new THREE.Color('#152132');
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.domElement.id = 'scene-canvas';
renderer.domElement.setAttribute('aria-label', 'Interactive 3D radio propagation scene');
document.body.appendChild(renderer.domElement);
scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.65);
directionalLight.position.set(10, 20, 10);
scene.add(directionalLight);
const controls = new THREE.PointerLockControls(camera, document.body);
scene.add(controls.getObject());
controls.addEventListener('change', invalidateScene);
camera.position.set(8, 12, 27);
camera.lookAt(-6, 1, 13);
const orbitControls = new THREE.OrbitControls(camera, renderer.domElement);
orbitControls.target.set(-6, 1, 13);
orbitControls.update();
orbitControls.minDistance = 1;
orbitControls.maxDistance = 150;
orbitControls.maxPolarAngle = Math.PI * 0.49;
orbitControls.addEventListener('change', invalidateScene);
let freeLook = false;
renderer.domElement.addEventListener('click', () => {
    if (freeLook) controls.lock();
});
controls.addEventListener('lock', () => (document.getElementById('camera-hint').hidden = true));
controls.addEventListener('unlock', () => (document.getElementById('camera-hint').hidden = false));
const loader = new THREE.GLTFLoader();
async function loadPackedModel(url) {
    const versionName =
        url === 'assets/factory-scan.glb'
            ? 'factory-texture-version'
            : url === 'assets/factory.glb'
              ? 'factory-model-version'
              : url === 'assets/robot.glb'
                ? 'robot-model-version'
                : '';
    const revision = versionName
        ? document.querySelector(`meta[name="${versionName}"]`)?.content
        : '';
    const response = await fetch(
        `${url}.gz${revision ? `?v=${encodeURIComponent(revision)}` : ''}`,
    );
    if (!response.ok) throw new Error(`Model unavailable (${response.status})`);
    let buffer = await response.arrayBuffer();
    buffer = await RadioCore.decodeGzip(buffer);
    return new Promise((resolve, reject) =>
        loader.parse(buffer, url.slice(0, url.lastIndexOf('/') + 1), resolve, reject),
    );
}
let environmentModel;
const environmentModels = new Map();
const environmentRequests = new Map();
const arrayPanelMaterial = new THREE.ShaderMaterial({
    uniforms: {
        phase: { value: 0 },
        panelColor: { value: new THREE.Color(RadioCore.arrayColors[0]) },
    },
    side: THREE.DoubleSide,
    extensions: { derivatives: true },
    vertexShader: `
        attribute vec2 arrayUv;
        varying vec2 panelUv;
        varying vec3 panelNormal;
        varying vec3 panelView;
        void main() {
            panelUv = arrayUv;
            panelNormal = normalize(normalMatrix * normal);
            vec4 p = modelViewMatrix * vec4(position, 1.0);
            panelView = -p.xyz;
            gl_Position = projectionMatrix * p;
        }
    `,
    fragmentShader: `
        uniform float phase;
        uniform vec3 panelColor;
        varying vec2 panelUv;
        varying vec3 panelNormal;
        varying vec3 panelView;
        void main() {
            vec2 cell = fract(panelUv * vec2(8.0, 2.0)) - 0.5;
            vec2 q = abs(cell) - vec2(0.30);
            float elementDistance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.07;
            float aa = max(fwidth(elementDistance), 0.015);
            float element = 1.0 - smoothstep(-aa, aa, elementDistance);
            // Fade the element grid at a distance instead of allowing it to shimmer.
            float detail = 1.0 - smoothstep(0.12, 0.45, max(fwidth(panelUv.x) * 8.0, fwidth(panelUv.y) * 2.0));
            vec2 edgeDistance = min(panelUv, 1.0 - panelUv) * vec2(8.0, 2.0);
            float edge = 1.0 - smoothstep(0.025, 0.12, min(edgeDistance.x, edgeDistance.y));
            float facing = abs(dot(normalize(panelNormal), normalize(panelView)));
            float rim = pow(1.0 - facing, 2.0);
            vec3 highlight = mix(panelColor, vec3(1.0), 0.30);
            vec3 face = mix(panelColor * 0.34, panelColor, element);
            face = mix(panelColor * 0.85, face, detail);
            // A narrow travelling highlight picks out the individual receive elements.
            float sweepDistance = abs(abs(panelUv.x - 0.5) - 0.5 * (1.0 - fract(phase * 3.0)));
            float sweep = exp(-sweepDistance * sweepDistance * 180.0);
            float bevel = smoothstep(-0.10, -0.025, elementDistance) * element;
            vec3 normal = normalize(panelNormal);
            vec3 light = normalize(vec3(-0.4, 0.7, 1.0));
            float specular = pow(abs(dot(normal, normalize(light + normalize(panelView)))), 28.0);
            face *= 0.72 + 0.28 * abs(dot(normal, light));
            face += highlight * 0.25 * bevel * detail;
            face += highlight * 0.35 * specular * element;
            face += highlight * 0.40 * sweep * element * detail;
            face += panelColor * 0.25 * rim;
            gl_FragColor = vec4(mix(face, highlight, edge * 0.8), 1.0);
        }
    `,
});
const receiverPositions = RadioCore.arrayGeometry.map(
    (array) => new THREE.Vector3(array.location[0], array.location[2], -array.location[1]),
);
const receiverPanelMaterials = RadioCore.arrayColors.map((color) => {
    const material = arrayPanelMaterial.clone();
    material.uniforms.phase = arrayPanelMaterial.uniforms.phase;
    material.uniforms.panelColor = { value: new THREE.Color(color) };
    return material;
});
const receiverHaloMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
        phase: arrayPanelMaterial.uniforms.phase,
        pixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: `
        attribute vec3 receiverColor;
        uniform float pixelRatio;
        varying vec3 haloColor;
        void main() {
            haloColor = receiverColor;
            vec4 p = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(420.0 / max(-p.z, 1.0), 30.0, 88.0) * pixelRatio;
            gl_Position = projectionMatrix * p;
        }
    `,
    fragmentShader: `
        uniform float phase;
        varying vec3 haloColor;
        void main() {
            float radius = length(gl_PointCoord - 0.5) * 2.0;
            float glow = exp(-radius * radius * 18.0) * 0.08;
            for (int i = 0; i < 2; ++i) {
                float ring = 1.0 - fract(phase * 3.0 + float(i) * 0.5);
                glow += exp(-pow((radius - ring) / 0.045, 2.0)) * (1.0 - ring) * 0.65;
            }
            float alpha = glow * (1.0 - smoothstep(0.85, 1.0, radius));
            if (alpha < 0.01) discard;
            gl_FragColor = vec4(mix(haloColor, vec3(1.0), 0.12), alpha);
        }
    `,
});
const receiverHalos = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(receiverPositions).setAttribute(
        'receiverColor',
        new THREE.Float32BufferAttribute(
            RadioCore.arrayColors.flatMap((color) => new THREE.Color(color).toArray()),
            3,
        ),
    ),
    receiverHaloMaterial,
);
receiverHalos.name = 'RX locator halos';
receiverHalos.frustumCulled = false;
receiverHalos.renderOrder = 5;
scene.add(receiverHalos);

function styleArrayPanel(object) {
    const geometry = object.geometry;
    const positions = geometry.getAttribute('position');
    geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new THREE.Vector3()).toArray();
    const scale = object.getWorldScale(new THREE.Vector3()).toArray();
    const axes = [0, 1, 2].sort(
        (a, b) => size[b] * Math.abs(scale[b]) - size[a] * Math.abs(scale[a]),
    );
    const minimum = geometry.boundingBox.min.toArray();
    const uv = new Float32Array(positions.count * 2);
    for (let i = 0; i < positions.count; i++) {
        for (let j = 0; j < 2; j++)
            uv[i * 2 + j] =
                (positions.array[i * positions.itemSize + axes[j]] - minimum[axes[j]]) /
                Math.max(size[axes[j]], 1e-6);
    }
    geometry.setAttribute('arrayUv', new THREE.BufferAttribute(uv, 2));
    const center = object.localToWorld(geometry.boundingBox.getCenter(new THREE.Vector3()));
    let nearest = 0;
    for (let index = 1; index < receiverPositions.length; index++)
        if (
            center.distanceToSquared(receiverPositions[index]) <
            center.distanceToSquared(receiverPositions[nearest])
        )
            nearest = index;
    object.userData.receiverIndex = nearest;
    object.material = receiverPanelMaterials[nearest];
}
function showEnvironmentModel() {
    const useScan = document.getElementById('scan-textures').checked;
    const next = environmentModels.get(useScan ? 'scan' : 'base') || environmentModels.get('base');
    if (!next) return;
    if (environmentModel && environmentModel !== next) scene.remove(environmentModel);
    environmentModel = next;
    scene.add(next);
    next.traverse((object) => {
        if (/roof|crane/i.test(object.name))
            object.visible = document.getElementById('show-roof').checked;
    });
    invalidateScene();
}
async function selectEnvironmentModel() {
    const checkbox = document.getElementById('scan-textures');
    const key = checkbox.checked ? 'scan' : 'base';
    const status = document.getElementById('scan-texture-status');
    showEnvironmentModel();
    if (environmentModels.has(key)) {
        status.hidden = true;
        return;
    }
    status.hidden = false;
    status.textContent = 'Loading factory model…';
    try {
        if (!environmentRequests.has(key))
            environmentRequests.set(
                key,
                loadPackedModel(key === 'scan' ? 'assets/factory-scan.glb' : 'assets/factory.glb'),
            );
        const gltf = await environmentRequests.get(key);
        const anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        gltf.scene.traverse((object) => {
            if (Array.isArray(object.userData.hiddenDuplicateOf)) object.visible = false;
            if (object.isMesh && object.name.startsWith('Fläche')) styleArrayPanel(object);
            else if (object.isMesh) {
                for (const material of Array.isArray(object.material)
                    ? object.material
                    : [object.material]) {
                    if (material.map && material.map.anisotropy !== anisotropy) {
                        material.map.anisotropy = anisotropy;
                        material.map.needsUpdate = true;
                    }
                }
            }
        });
        environmentModels.set(key, gltf.scene);
        showEnvironmentModel();
        if (checkbox.checked === (key === 'scan')) status.hidden = true;
        if (environmentModel) setViewerStatus('environment', 'ARENA2036 loaded');
    } catch (_) {
        environmentRequests.delete(key);
        if (checkbox.checked !== (key === 'scan')) return;
        if (key === 'scan') {
            checkbox.checked = false;
            await selectEnvironmentModel();
            status.hidden = false;
            status.textContent = 'Textures unavailable. Select again to retry.';
        } else {
            status.textContent = 'Factory model unavailable. Toggle textures to retry.';
            if (!environmentModel)
                setViewerStatus('environment', 'Unable to load the factory model', 'error');
        }
    }
}
setViewerStatus('environment', 'Loading factory model…', 'loading');
selectEnvironmentModel();
document.getElementById('scan-textures').addEventListener('change', selectEnvironmentModel);

let previousFrame = null;
function render(timestamp) {
    requestAnimationFrame(render);
    if (document.hidden) {
        previousFrame = null;
        return;
    }
    const delta = previousFrame === null ? 0 : Math.max((timestamp - previousFrame) / 1000, 0);
    previousFrame = timestamp;
    updateMovement(Math.min(delta, 0.1));
    advanceRadiationTime(delta);
    if (sceneDirty || (isPlaying && currentCsi)) {
        renderer.render(scene, camera);
        sceneDirty = false;
    }
}
function transformCoordinates(coords) {
    return [coords[0], coords[2], -coords[1]];
}
