/* Precomputed geometric paths, rendered as solid screen-space ribbons in one draw. */
const delayReferencePoint = new THREE.Vector3(
    ...transformCoordinates(RadioCore.arrayGeometry[0].location),
);
const desiredDelayTaps = 8;
const pathGroup = new THREE.Group();
pathGroup.name = 'propagation-paths';
scene.add(pathGroup);
const pathLoader = new RadioCore.PackedPathLoader();
let pathRequest = null;
let pathRevision = 0;
let activePathKey = null;
let currentPathData = null;
let pathCount = 0;
let pathsVisible = true;
const MAX_DISPLAY_REFLECTIONS = 1;
const rayLineMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    uniforms: {
        time_start: { value: 0 },
        time_stop: { value: 1 },
        delay: { value: 0 },
        reveal: { value: 1 },
        resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        line_width: { value: 2.5 },
    },
    vertexShader: `
        attribute vec3 segment_start;
        attribute vec3 segment_end;
        uniform vec2 resolution;
        uniform float line_width;
        varying float side_distance;
        attribute float start_time;
        attribute float end_time;
        varying float propagation_time;
        attribute float amplitude;
        attribute vec3 color;
        uniform float time_start;
        uniform float time_stop;
        uniform float delay;
        uniform int reveal;
        varying float path_opacity;
        varying vec3 path_color;
        void main() {
            path_opacity = 0.95 * sqrt(amplitude);
            path_color = color;
            // Trim against the near plane before expanding in screen space.
            vec4 start = modelViewMatrix * vec4(segment_start, 1.0);
            vec4 end = modelViewMatrix * vec4(segment_end, 1.0);
            float near_z = -0.101;
            float t_start = start_time;
            float t_end = end_time;
            if (start.z > near_z && end.z > near_z) {
                path_opacity = 0.0;
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                side_distance = position.y;
                return;
            }
            if (start.z > near_z) {
                float portion = (near_z - start.z) / (end.z - start.z);
                start = mix(start, end, portion); t_start = mix(t_start, t_end, portion);
            }
            if (end.z > near_z) {
                float portion = (near_z - end.z) / (start.z - end.z);
                end = mix(end, start, portion); t_end = mix(t_end, t_start, portion);
            }
            propagation_time = mix(t_start, t_end, position.x);
            vec4 a = projectionMatrix * start;
            vec4 b = projectionMatrix * end;
            vec2 delta = (b.xy / b.w - a.xy / a.w) * resolution;
            vec2 normal = vec2(-delta.y, delta.x) / max(length(delta), 0.0001);
            gl_Position = mix(a, b, position.x);
            gl_Position.xy += normal * position.y * line_width / resolution * gl_Position.w;
            side_distance = position.y;
        }
    `,
    fragmentShader: `
        uniform float time_start;
        uniform float time_stop;
        uniform float delay;
        uniform int reveal;
        varying float propagation_time;
        varying float side_distance;
        varying float path_opacity;
        varying vec3 path_color;
        void main() {
            if (path_opacity < 0.005) discard;
            float edge = abs(side_distance);
            float reached = reveal == 0 ? 1.0 : clamp((time_stop - propagation_time - delay) / max(time_stop - time_start, 0.001), 0.0, 1.0);
            float alpha = path_opacity * reached * (1.0 - smoothstep(0.8, 1.0, edge));
            if (alpha < 0.005) discard;
            gl_FragColor = vec4(path_color, alpha);
        }
    `,
});
const pathColors = [
    new THREE.Color('#00649b'),
    new THREE.Color('#a34800'),
    new THREE.Color('#683699'),
    new THREE.Color('#00704c'),
];

function createRayGeometry(starts, ends, startTimes, endTimes, amplitudes, colors) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
            [0, -1, 0, 1, -1, 0, 0, 1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0],
            3,
        ),
    );
    for (const [name, values, size] of [
        ['segment_start', starts, 3],
        ['segment_end', ends, 3],
        ['start_time', startTimes, 1],
        ['end_time', endTimes, 1],
        ['amplitude', amplitudes, 1],
        ['color', colors, 3],
    ]) {
        geometry.setAttribute(
            name,
            new THREE.InstancedBufferAttribute(new Float32Array(values), size),
        );
    }
    geometry.instanceCount = startTimes.length;
    return geometry;
}
window.addEventListener('resize', () =>
    rayLineMaterial.uniforms.resolution.value.set(window.innerWidth, window.innerHeight),
);

function clearPathObjectsFromScene() {
    while (pathGroup.children.length) {
        const child = pathGroup.children[0];
        pathGroup.remove(child);
        child.geometry.dispose();
    }
    pathCount = 0;
}

function renderPathData(robotPos, coordinateData) {
    clearPathObjectsFromScene();
    const starts = [],
        ends = [],
        startTimes = [],
        endTimes = [],
        amplitudes = [],
        colors = [];
    const displayedPaths = coordinateData.paths.filter(
        (path) => path.vertices.length <= MAX_DISPLAY_REFLECTIONS,
    );
    for (const path of displayedPaths) {
        const points = [path.source, ...path.vertices, path.target].map(
            (p) => new THREE.Vector3(...transformCoordinates(p)),
        );
        const color = pathColors[path.tx_index] || pathColors[0];
        let length = 0;
        // Exported dB is predicted power relative to this array link's peak.
        // Amplitude weighting preserves weak paths without drawing them as strong ones.
        const amplitude = Number.isFinite(path.relative_power_db)
            ? Math.pow(10, Math.min(0, path.relative_power_db) / 20)
            : 1;
        for (let i = points.length - 1; i > 0; i--) {
            starts.push(...points[i].toArray());
            ends.push(...points[i - 1].toArray());
            startTimes.push((length / RadioCore.config.speedOfLight) * BANDWIDTH);
            length += points[i].distanceTo(points[i - 1]);
            endTimes.push((length / RadioCore.config.speedOfLight) * BANDWIDTH);
            amplitudes.push(amplitude);
            colors.push(color.r, color.g, color.b);
        }
    }
    if (starts.length) {
        const geometry = createRayGeometry(starts, ends, startTimes, endTimes, amplitudes, colors);
        const lines = new THREE.Mesh(geometry, rayLineMaterial);
        lines.frustumCulled = false;
        lines.renderOrder = 4;
        pathGroup.add(lines);
    }
    const transmitterPosition = new THREE.Vector3(
        ...transformCoordinates(coordinateData.coordinates),
    );
    const referenceDelay =
        Number.isFinite(coordinateData.delay_reference_seconds) &&
        coordinateData.delay_reference_seconds >= 0
            ? coordinateData.delay_reference_seconds
            : delayReferencePoint.distanceTo(transmitterPosition) / RadioCore.config.speedOfLight;
    rayLineMaterial.uniforms.delay.value = desiredDelayTaps - referenceDelay * BANDWIDTH;
    rayLineMaterial.uniforms.time_start.value = rad_time_start;
    rayLineMaterial.uniforms.time_stop.value = rad_time_stop;
    updatePathVisibility();
    pathCount = displayedPaths.length;
    setViewerStatus(
        'paths',
        pathCount ? `${pathCount} simulated paths` : 'No direct or single-reflection path here',
        pathCount ? 'ready' : 'empty',
    );
}

async function visualizePaths(robotPos) {
    const bin = RadioCore.positionToBin(robotPos.x, -robotPos.z);
    const indices = RadioCore.pathIndices(robotPos.x, -robotPos.z, bin);
    const key = indices ? `${indices.column}:${indices.row}` : null;
    if (key === activePathKey && (key !== null || viewerStatus.paths?.state === 'empty')) return;
    activePathKey = key;
    const revision = ++pathRevision;
    // Keep the last nearby geometry while its replacement is in flight.
    updatePathVisibility();
    if (!indices) {
        if (pathRequest) pathRequest.controller.abort();
        setViewerStatus('paths', 'Outside simulated path coverage', 'empty');
        return;
    }
    const position = robotPos.clone();
    setViewerStatus('paths', 'Loading propagation paths…', 'loading');
    try {
        const coverage = bin === null ? null : await csiLoader.loadIndex();
        if (revision !== pathRevision) return;
        if (bin === null || !(coverage.cells[bin >> 3] & (1 << (bin & 7)))) {
            if (pathRequest) pathRequest.controller.abort();
            setViewerStatus('paths', 'No measured channel at this position', 'empty');
            return;
        }
        const pathIndex = await pathLoader.prepare();
        if (revision !== pathRevision) return;
        if (indices.row >= (pathIndex?.rows || 201)) {
            setViewerStatus('paths', 'Outside simulated path coverage', 'empty');
            return;
        }
        if (
            pathIndex?.measurementSourceSha256 &&
            pathIndex.measurementSourceSha256 !== coverage.sourceSha256
        )
            throw new Error('Paths and measurements belong to different data builds');
        const requestKey = `${indices.column}:${Math.floor(indices.row / pathLoader.blockRows)}`;
        let data = pathLoader.cache.get(requestKey);
        if (!data) {
            // Finish one useful block on slow links, then skip directly to the
            // newest position instead of repeatedly aborting every movement step.
            if (
                pathRequest &&
                !pathRequest.controller.signal.aborted &&
                pathRequest.key !== requestKey
            ) {
                try {
                    await pathRequest.promise;
                } catch (_) {
                    /* The newest selection retries below. */
                }
                if (revision !== pathRevision) return;
            }
            if (
                !pathRequest ||
                pathRequest.controller.signal.aborted ||
                pathRequest.key !== requestKey
            ) {
                if (pathRequest) pathRequest.controller.abort();
                const controller = new AbortController();
                const request = { key: requestKey, controller };
                request.promise = pathLoader
                    .loadBlock(indices.column, indices.row, controller.signal)
                    .finally(() => {
                        if (pathRequest === request) pathRequest = null;
                    });
                pathRequest = request;
            }
            data = await pathRequest.promise;
        }
        if (revision !== pathRevision) return;
        const coordinateData = data.records[indices.row - data.firstRow];
        if (!coordinateData || !Array.isArray(coordinateData.paths))
            throw new Error('Invalid path data at this position');
        if (
            !Array.isArray(coordinateData.coordinates) ||
            Math.abs(
                coordinateData.coordinates[0] -
                    (RadioCore.config.pathMinX + indices.row * RadioCore.config.pathStep),
            ) > 1e-4 ||
            Math.abs(
                coordinateData.coordinates[1] -
                    (RadioCore.config.pathMinY + indices.column * RadioCore.config.pathStep),
            ) > 1e-4
        )
            throw new Error('Path index is stale; rebuild it for these JSON files');
        currentPathData = coordinateData;
        renderPathData(position, coordinateData);
    } catch (error) {
        if (revision !== pathRevision || error.name === 'AbortError') return;
        activePathKey = null;
        setViewerStatus('paths', error.message, 'error');
    }
}

// Only compare simulated paths with a valid measured channel at this position.
function updatePathVisibility() {
    const measured =
        currentCsi &&
        model &&
        currentCsiBin === RadioCore.positionToBin(model.position.x, -model.position.z);
    const bin = model && RadioCore.positionToBin(model.position.x, -model.position.z);
    const indices = model && RadioCore.pathIndices(model.position.x, -model.position.z, bin);
    // Motion is continuous; match the selected grid record, without requiring
    // the robot to land exactly on its sampled position.
    const samePosition =
        currentPathData &&
        indices &&
        Math.abs(
            currentPathData.coordinates[0] -
                (RadioCore.config.pathMinX + indices.row * RadioCore.config.pathStep),
        ) < 1e-4 &&
        Math.abs(
            currentPathData.coordinates[1] -
                (RadioCore.config.pathMinY + indices.column * RadioCore.config.pathStep),
        ) < 1e-4;
    const covered = bin !== null && csiLoader.index?.cells[bin >> 3] & (1 << (bin & 7));
    const nearby =
        currentPathData &&
        model &&
        Math.hypot(
            currentPathData.coordinates[0] - model.position.x,
            currentPathData.coordinates[1] + model.position.z,
        ) <= 1;
    const loading =
        viewerStatus.paths?.state === 'loading' || viewerStatus.csi?.state === 'loading';
    pathGroup.visible = Boolean(
        pathsVisible && covered && ((measured && samePosition) || (nearby && loading)),
    );
    invalidateScene();
}
window.addEventListener('viewer-status', (event) => {
    if (event.detail.key === 'csi' || event.detail.key === 'paths') updatePathVisibility();
});
