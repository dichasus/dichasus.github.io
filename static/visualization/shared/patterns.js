// These dimensions must match the binary produced by channel preprocessing.
const ROWS_PER_ARRAY = RadioCore.config.rows;
const ANTENNAS_PER_ROW = RadioCore.config.columns;
const TAP_COUNT = RadioCore.config.taps;
const ARRAY_ELEMENTS = ROWS_PER_ARRAY * ANTENNAS_PER_ROW;
const adaptiveFullSamples = new Float32Array(ARRAY_ELEMENTS * TAP_COUNT * 2);

/* Prepare radiation pattern spheres */
function initializeRadiationPatterns() {
    const arrayPositions = RadioCore.arrayGeometry.map(
        (array) => new THREE.Vector3(...transformCoordinates(array.location)),
    );
    const vectorRights = RadioCore.arrayGeometry.map((array) =>
        new THREE.Vector3(...transformCoordinates(array.rightvector)).normalize(),
    );
    const vectorUps = RadioCore.arrayGeometry.map((array, index) => {
        const up = new THREE.Vector3(...transformCoordinates(array.upvector));
        return up.addScaledVector(vectorRights[index], -up.dot(vectorRights[index])).normalize();
    });
    const vectorNormals = vectorRights.map((right, index) =>
        new THREE.Vector3().crossVectors(right, vectorUps[index]).normalize(),
    );

    const emptySamples = new Float32Array(ROWS_PER_ARRAY * ANTENNAS_PER_ROW * 10 * 2);
    const shaderSphereGeometry = new THREE.SphereGeometry(1, 64, 64, 0, Math.PI, 0, Math.PI);
    const shaderSphereMaterial = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        extensions: { derivatives: true },
        defines: {
            ROWS_PER_ARRAY: ROWS_PER_ARRAY,
            ANTENNAS_PER_ROW: ANTENNAS_PER_ROW,
            TAP_COUNT: TAP_COUNT,
            TIME_STEPS: 10,
            ARRAY_ELEMENTS,
            BEAM_LAGS: RadioCore.beamLags.length,
        },
        uniforms: {
            time_start: { value: 1.0 },
            time_stop: { value: 1.0 },
            samples: { value: emptySamples }, // CPU reconstruction storage, not a GPU uniform.
            correlations: { value: new Float32Array(RadioCore.beamLags.length * 2) },
            adaptive: { value: false },
            adaptive_scale: { value: 0 },
            adaptive_floor: { value: 0 },
            sample_sums: { value: new Float32Array(ARRAY_ELEMENTS * 2) },
            color_is_phase: { value: 0 },
            contour_strength: { value: 1 },
        },
        vertexShader: `
            #define PI 3.141592653589793
            uniform float time_start;
            uniform float time_stop;
            uniform int color_is_phase;
            uniform vec2 correlations[BEAM_LAGS];
            uniform bool adaptive;
            uniform float adaptive_scale;
            uniform float adaptive_floor;
            uniform vec2 sample_sums[ARRAY_ELEMENTS];

            varying vec3 pos;
            varying vec3 view_position;
            varying vec2 received;

            void main() {
                pos = position.xyz;
                float azimuth = atan(position.z, position.x) - PI / 2.0;
                float elevation = atan(position.y, length(position.xz));

                float phase_azimuth = PI * sin(azimuth);
                float phase_elevation = PI * sin(elevation);
                float received_power = correlations[0].x;
                // The lag layout matches RadioCore.beamLags.
                for (int lag = 1; lag < BEAM_LAGS; ++lag) {
                    float dr = lag < ANTENNAS_PER_ROW ? 0.0 : floor(float(lag - ANTENNAS_PER_ROW) / float(2 * ANTENNAS_PER_ROW - 1)) + 1.0;
                    float dc = lag < ANTENNAS_PER_ROW ? float(lag) : mod(float(lag - ANTENNAS_PER_ROW), float(2 * ANTENNAS_PER_ROW - 1)) - float(ANTENNAS_PER_ROW - 1);
                    float phase = dc * phase_azimuth + dr * phase_elevation;
                    received_power += 2.0 * (correlations[lag].x * cos(phase) - correlations[lag].y * sin(phase));
                }
                if (adaptive) received_power = adaptive_scale * max(0.0, 1.0 / max(received_power, 1e-6) - adaptive_floor);
                received_power = max(received_power, 0.0);
                received = vec2(0.0);
                if (color_is_phase == 1) {
                    for (int antenna = 0; antenna < ARRAY_ELEMENTS; ++antenna) {
                        float phase = mod(float(antenna), float(ANTENNAS_PER_ROW)) * phase_azimuth + floor(float(antenna) / float(ANTENNAS_PER_ROW)) * phase_elevation;
                        vec2 steering = vec2(cos(phase), sin(phase));
                        vec2 sample_sum = sample_sums[antenna];
                        received += vec2(steering.x * sample_sum.x - steering.y * sample_sum.y,
                                         steering.x * sample_sum.y + steering.y * sample_sum.x);
                    }
                }
                float beamforming_pattern = sqrt(received_power) / 10.0;

                float pattern_patch_antenna = pow(max(0.0, cos(elevation)), 0.4) * pow(max(0.0, cos(azimuth)), 0.4);
                float radius = beamforming_pattern * pattern_patch_antenna;
                pos = pos * radius;

                vec4 modelViewPosition = modelViewMatrix * vec4(pos.x, pos.y, pos.z, 1.0);
                view_position = modelViewPosition.xyz;
                gl_Position = projectionMatrix * modelViewPosition;
            }
        `,
        fragmentShader: `
            #define PI 3.141592653589793
            #define MAX_LENGTH 1.5
            varying vec3 pos;
            varying vec3 view_position;
            varying vec2 received;
            uniform int color_is_phase;
            uniform float contour_strength;
            void main() {
                vec3 green = vec3(0.0, 1.0, 0.0);
                vec3 yellow = vec3(1.0, 1.0, 0.0);
                vec3 red = vec3(1.0, 0.0, 0.0);

                if (color_is_phase == 1) {
                    float phase = mod(atan(received.y, received.x) + 3.0 * PI / 2.0, 2.0 * PI) - PI;
                    if (phase < 0.0) {
                        gl_FragColor = vec4(mix(green, red, -phase / PI), 1.0);
                    } else {
                        gl_FragColor = vec4(mix(green, red, phase / PI), 1.0);
                    }
                } else {
                    float powerValue = length(pos); // Verwende die Länge von pos als Wert für die Farbgebung
                    if (powerValue < MAX_LENGTH / 2.0) {
                        gl_FragColor = vec4(mix(green, yellow, powerValue / (MAX_LENGTH / 2.0)), 1.0);
                    } else {
                        gl_FragColor = vec4(mix(yellow, red, (powerValue - (MAX_LENGTH / 2.0)) / MAX_LENGTH), 1.0);
                    }
                }
                // Surface shading and amplitude contours reveal lobe shape
                // without altering the measured radius or its direction.
                vec3 normal = normalize(cross(dFdx(view_position), dFdy(view_position)));
                float light = 0.68 + 0.32 * abs(dot(normal, normalize(vec3(0.3, 0.5, 1.0))));
                float level = length(pos) * 4.0;
                float width = max(fwidth(level), 0.002);
                float contour = 1.0 - smoothstep(width * 0.35, width, abs(fract(level + 0.5) - 0.5));
                vec3 shaded = mix(gl_FragColor.rgb * light, vec3(0.03, 0.10, 0.15), contour * 0.4);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, shaded, contour_strength);
            }
        `,
    });

    // Füge eine Kugel für jedes Radiation Pattern zur Szene hinzu
    console.assert(arrayPositions.length == vectorNormals.length);
    console.assert(arrayPositions.length == vectorUps.length);
    console.assert(arrayPositions.length == vectorRights.length);

    const spheres = [];

    for (let arrayidx = 0; arrayidx < arrayPositions.length; ++arrayidx) {
        const material = shaderSphereMaterial.clone();
        // Three.js r128 clones ordinary arrays but retains typed-array uniform
        // references. Each array must own its reconstructed channel buffer.
        material.uniforms.samples.value = new Float32Array(emptySamples.length);
        material.uniforms.correlations.value = new Float32Array(RadioCore.beamLags.length * 2);
        material.uniforms.sample_sums.value = new Float32Array(ARRAY_ELEMENTS * 2);
        const shaderSphere = new THREE.Mesh(shaderSphereGeometry, material);
        shaderSphere.position.copy(arrayPositions[arrayidx]);

        const right = vectorRights[arrayidx].clone().normalize();
        const up = vectorUps[arrayidx].clone().normalize();
        const normal = vectorNormals[arrayidx].clone().normalize();

        const rotationMatrix = new THREE.Matrix4();
        rotationMatrix.set(
            right.x,
            up.x,
            normal.x,
            0,
            right.y,
            up.y,
            normal.y,
            0,
            right.z,
            up.z,
            normal.z,
            0,
            0,
            0,
            0,
            1,
        );

        shaderSphere.setRotationFromMatrix(rotationMatrix);
        shaderSphere.scale.setScalar(RadioCore.dataset.patternScale || 1);
        shaderSphere.frustumCulled = false;
        shaderSphere.visible = false;
        scene.add(shaderSphere);

        spheres.push(shaderSphere);
    }

    return spheres;
}

const radSpheres = initializeRadiationPatterns();
const csiLoader = new RadioCore.ChunkedCsiLoader();
let csiRevision = 0;
let currentCsiBin = null;
let currentCsi = null;
let displayedCsiPosition = null;
let activeCsiLoad = null;
let patternsVisible = true;
let radiationDirty = true;
let isPlaying = true;
let playbackSpeed = 5;
let delayBeforeFullRange = 0;
let playingBeforeFullRange = false;

async function visualizeRadiationPattern(pos) {
    pos = pos.clone();
    const bin = RadioCore.positionToBin(pos.x, -pos.z);
    if (bin === currentCsiBin && (bin !== null || viewerStatus.csi?.state === 'empty')) return;
    currentCsiBin = bin;
    const revision = ++csiRevision;
    currentCsi = null;
    const retain = displayedCsiPosition && displayedCsiPosition.distanceTo(pos) <= 1;
    radSpheres.forEach((sphere) => (sphere.visible = patternsVisible && retain));
    const warning = document.getElementById('no-csi-warning');
    if (bin === null) {
        radSpheres.forEach((sphere) => (sphere.visible = false));
        warning.hidden = false;
        setViewerStatus('csi', 'Outside measured CSI coverage', 'empty');
        return;
    }
    warning.hidden = true;
    setViewerStatus('csi', 'Loading measured channel…', 'loading');
    try {
        const index = await csiLoader.loadIndex();
        if (revision !== csiRevision) return;
        if (!(index.cells[bin >> 3] & (1 << (bin & 7)))) {
            radSpheres.forEach((sphere) => (sphere.visible = false));
            warning.hidden = false;
            setViewerStatus('csi', 'No measurement in this spatial cell', 'empty');
            return;
        }
        // Keep at most one foreground load in flight; while it completes,
        // intermediate movement updates are discarded in favor of the latest.
        if (activeCsiLoad) {
            try {
                await activeCsiLoad;
            } catch (_) {
                /* Latest request retries below. */
            }
            if (revision !== csiRevision) return;
        }
        const request = csiLoader.get(bin);
        activeCsiLoad = request;
        let data;
        try {
            data = await request;
        } finally {
            if (activeCsiLoad === request) activeCsiLoad = null;
        }
        if (revision !== csiRevision) return;
        if (!RadioCore.hasSignal(data)) {
            radSpheres.forEach((sphere) => (sphere.visible = false));
            warning.hidden = false;
            setViewerStatus('csi', 'No measurement in this spatial cell', 'empty');
            return;
        }
        currentCsi = data;
        displayedCsiPosition = pos.clone();
        radiationDirty = true;
        radSpheres.forEach((sphere) => (sphere.visible = patternsVisible));
        setViewerStatus('csi', 'Measured channel ready');
        window.dispatchEvent(new CustomEvent('csi-loaded', { detail: { bin, data } }));
    } catch (error) {
        if (revision !== csiRevision) return;
        currentCsiBin = null;
        radSpheres.forEach((sphere) => (sphere.visible = false));
        setViewerStatus('csi', error.message, 'error');
    }
}

function updateRadTime() {
    invalidateScene();
    txBeaconMaterial.uniforms.phase.value = rad_time_start / TAP_COUNT;
    arrayPanelMaterial.uniforms.phase.value = rad_time_start / TAP_COUNT;
    drawCoverageMap();
    if (currentCsi && radiationDirty) {
        const perArray = ROWS_PER_ARRAY * ANTENNAS_PER_ROW * TAP_COUNT * 2;
        for (let i = 0; i < radSpheres.length; i++) {
            const uniforms = radSpheres[i].material.uniforms;
            const channel = currentCsi.subarray(i * perArray, (i + 1) * perArray);
            if (rad_time_duration === TAP_COUNT) {
                RadioCore.fullRangeCorrelations(channel, uniforms.correlations.value);
                uniforms.sample_sums.value.fill(0);
            } else {
                RadioCore.reconstructWindow(
                    channel,
                    rad_time_start,
                    rad_time_stop,
                    10,
                    uniforms.samples.value,
                );
                RadioCore.prepareBeamforming(
                    uniforms.samples.value,
                    uniforms.correlations.value,
                    uniforms.sample_sums.value,
                );
            }
            uniforms.adaptive.value =
                ROWS_PER_ARRAY === 2 &&
                ANTENNAS_PER_ROW === 8 &&
                document.getElementById('pattern-method').value === 'capon';
            if (uniforms.adaptive.value) {
                let samples = uniforms.samples.value;
                if (rad_time_duration === TAP_COUNT) {
                    // Parseval gives the full-delay covariance directly from frequency samples.
                    for (let frequency = 0; frequency < TAP_COUNT; frequency++) {
                        for (let antenna = 0; antenna < ARRAY_ELEMENTS; antenna++) {
                            const source = 2 * (antenna * TAP_COUNT + frequency);
                            const destination = 2 * (frequency * ARRAY_ELEMENTS + antenna);
                            adaptiveFullSamples[destination] = channel[source];
                            adaptiveFullSamples[destination + 1] = channel[source + 1];
                        }
                    }
                    samples = adaptiveFullSamples;
                }
                const estimate = AdaptiveBeamforming.capon(samples);
                uniforms.correlations.value.set(estimate.coefficients);
                uniforms.adaptive_scale.value = estimate.scale;
                uniforms.adaptive_floor.value = estimate.floor;
            }
        }
    }
    radiationDirty = false;
    document
        .getElementById('time-axis')
        .setAttribute('aria-valuenow', String(Math.round((rad_time_start / BANDWIDTH) * 1e9)));
    rayLineMaterial.uniforms.time_start.value = rad_time_start;
    rayLineMaterial.uniforms.time_stop.value = rad_time_stop;
    const marker = document.getElementById('time-marker');
    marker.style.left = (rad_time_start / TAP_COUNT) * 100 + '%';
    marker.style.width = (rad_time_duration / TAP_COUNT) * 100 + '%';
    updateProfileWindow();
    const startNs = Math.round((rad_time_start / BANDWIDTH) * 1e10) / 10;
    const stopNs = Math.round((rad_time_stop / BANDWIDTH) * 1e10) / 10;
    document.getElementById('time-text').textContent = `${startNs}–${stopNs} ns`;
}
function advanceRadiationTime(delta) {
    if (isPlaying && delta && currentCsi) {
        const maximum = TAP_COUNT - rad_time_duration;
        rad_time_start = maximum > 0 ? (rad_time_start + playbackSpeed * delta) % maximum : 0;
        rad_time_stop = rad_time_start + rad_time_duration;
        radiationDirty = true;
    }
    if (radiationDirty) updateRadTime();
}
function setPlaying(playing) {
    isPlaying = playing = playing && rad_time_duration < TAP_COUNT;
    const button = document.getElementById('play-pause-button');
    const label = playing ? 'Pause playback' : 'Play playback';
    const symbol = playing
        ? '<path d="M4 2h3v12H4zM10 2h3v12h-3z"/>'
        : '<path d="M4 2l10 6-10 6z"/>';
    button.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${symbol}</svg>`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(playing));
}
function setIntegrationWindow(duration) {
    if (!Number.isFinite(duration) || duration <= 0 || duration > TAP_COUNT) return;
    const wasFullRange = rad_time_duration === TAP_COUNT;
    const fullRange = duration === TAP_COUNT;
    if (fullRange && !wasFullRange) {
        delayBeforeFullRange = rad_time_start;
        playingBeforeFullRange = isPlaying;
    }
    rad_time_duration = duration;
    setDelay(wasFullRange && !fullRange ? delayBeforeFullRange : rad_time_start);
    if (fullRange) setPlaying(false);
    else if (wasFullRange) setPlaying(playingBeforeFullRange);
    document.getElementById('play-pause-button').disabled = fullRange;
    document.getElementById('playback-speed').disabled = fullRange;
    const axis = document.getElementById('time-axis');
    axis.setAttribute('aria-valuemax', String(((TAP_COUNT - duration) / BANDWIDTH) * 1e9));
    axis.setAttribute('aria-disabled', String(fullRange));
    axis.tabIndex = fullRange ? -1 : 0;
}
function setDelay(taps) {
    rad_time_start = THREE.MathUtils.clamp(taps, 0, TAP_COUNT - rad_time_duration);
    rad_time_stop = rad_time_start + rad_time_duration;
    radiationDirty = true;
}
document.addEventListener('DOMContentLoaded', () => {
    const axis = document.getElementById('time-axis');
    axis.setAttribute('role', 'slider');
    axis.setAttribute('tabindex', '0');
    axis.setAttribute('aria-label', 'Propagation delay');
    axis.setAttribute('aria-valuemin', '0');
    axis.setAttribute('aria-valuemax', String(((TAP_COUNT - rad_time_duration) / BANDWIDTH) * 1e9));
    function drag(event) {
        const rect = axis.getBoundingClientRect();
        setDelay(((event.clientX - rect.left) / rect.width) * TAP_COUNT);
    }
    axis.addEventListener('pointerdown', (event) => {
        setPlaying(false);
        axis.setPointerCapture(event.pointerId);
        drag(event);
    });
    axis.addEventListener('pointermove', (event) => {
        if (axis.hasPointerCapture(event.pointerId)) drag(event);
    });
    axis.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight') next = rad_time_start + 0.25;
        if (event.key === 'ArrowLeft') next = rad_time_start - 0.25;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = TAP_COUNT;
        if (next !== undefined) {
            event.preventDefault();
            setPlaying(false);
            setDelay(next);
        }
    });
    document
        .getElementById('play-pause-button')
        .addEventListener('click', () => setPlaying(!isPlaying));
    setPlaying(true);
});
