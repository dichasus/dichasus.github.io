function updateStatusDisplay(key, status) {
    const element = document.getElementById(`status-${key}`);
    if (element) {
        element.textContent = status.message;
        element.dataset.state = status.state;
    }
    document.getElementById('retry-data').hidden = !['csi', 'paths'].some(
        (name) => viewerStatus[name]?.state === 'error',
    );
    const startup = ['environment', 'robot']
        .map((name) => viewerStatus[name])
        .filter((item) => item && item.state !== 'ready');
    document.getElementById('startup-status').textContent = startup
        .map((item) => item.message)
        .join(' · ');
}
window.addEventListener('viewer-status', (event) =>
    updateStatusDisplay(event.detail.key, event.detail),
);
Object.entries(viewerStatus).forEach(([key, status]) => updateStatusDisplay(key, status));
// Position/status rows can grow on small screens, especially during a retry.
new ResizeObserver(() => {
    const rect = document.getElementById('coverage-panel').getBoundingClientRect();
    const bottom = rect.bottom;
    document.documentElement.style.setProperty(
        '--minimap-center',
        `${rect.top + rect.height / 2}px`,
    );
    document.documentElement.style.setProperty('--minimap-width', `${rect.width}px`);
    document.documentElement.style.setProperty('--minimap-bottom', `${bottom}px`);
}).observe(document.getElementById('coverage-panel'));
new ResizeObserver((entries) => {
    document.documentElement.style.setProperty(
        '--timeline-height',
        `${entries[0].target.getBoundingClientRect().height}px`,
    );
}).observe(document.querySelector('.timeline'));
window.addEventListener('robot-position', (event) => {
    document.getElementById('position-x').value = event.detail.x.toFixed(1);
    document.getElementById('position-y').value = event.detail.y.toFixed(1);
});
document.getElementById('position-form').addEventListener('submit', (event) => {
    event.preventDefault();
    setRobotPosition(
        Number(document.getElementById('position-x').value),
        Number(document.getElementById('position-y').value),
    );
});
document
    .getElementById('reset-robot')
    .addEventListener('click', () => setRobotPosition(robotStart.x, -robotStart.z));
document.getElementById('toggle-panel').addEventListener('click', () => {
    const panel = document.getElementById('explorer-panel');
    const collapsed = document.body.classList.toggle('panel-hidden');
    panel.inert = collapsed;
    panel.setAttribute('aria-hidden', String(collapsed));
    const button = document.getElementById('toggle-panel');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? 'Show measurements' : 'Hide measurements');
    button.title = collapsed ? 'Show measurements' : 'Hide measurements';
});
document.getElementById('toggle-minimap').addEventListener('click', () => {
    const panel = document.getElementById('coverage-panel');
    const collapsed = document.body.classList.toggle('minimap-hidden');
    panel.inert = collapsed;
    panel.setAttribute('aria-hidden', String(collapsed));
    const button = document.getElementById('toggle-minimap');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? 'Show minimap' : 'Hide minimap');
    button.title = collapsed ? 'Show minimap' : 'Hide minimap';
    if (!collapsed) drawCoverageMap();
});
function setCameraView(name) {
    invalidateScene();
    controls.unlock();
    const grid = RadioCore.config;
    const centerX = (grid.minX + grid.maxX) / 2;
    const centerZ = -(grid.minY + grid.maxY) / 2;
    const halfHeight = Math.max(
        (grid.maxY - grid.minY) / 2,
        (grid.maxX - grid.minX) / (2 * camera.aspect),
    );
    const distance = (1.15 * halfHeight) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    if (name === 'overview') {
        orbitControls.target.set(centerX, 0, centerZ);
        camera.position.set(centerX + distance * 0.25, distance * 0.8, centerZ + distance * 0.7);
        camera.lookAt(orbitControls.target);
    } else if (name === 'top') {
        camera.position.set(centerX, distance, centerZ + 0.001);
        orbitControls.target.set(centerX, 0, centerZ);
        camera.lookAt(orbitControls.target);
    } else if (name === 'robot' && model) {
        camera.position.copy(model.position).add(new THREE.Vector3(1.5, 1.5, 2));
        orbitControls.target.copy(model.position).add(new THREE.Vector3(0, 0.65, 0));
        camera.lookAt(orbitControls.target);
    }
}
document.getElementById('view-overview').addEventListener('click', () => setCameraView('overview'));
document.getElementById('view-top').addEventListener('click', () => setCameraView('top'));
document.getElementById('view-robot').addEventListener('click', () => setCameraView('robot'));
document.getElementById('show-roof').addEventListener('change', (event) => {
    if (environmentModel)
        environmentModel.traverse((object) => {
            if (/roof|crane/i.test(object.name)) object.visible = event.target.checked;
        });
});
document.getElementById('show-patterns').addEventListener('change', (event) => {
    patternsVisible = event.target.checked;
    radSpheres.forEach((sphere) => (sphere.visible = patternsVisible && !!currentCsi));
});
document.getElementById('show-paths').addEventListener('change', (event) => {
    pathsVisible = event.target.checked;
    updatePathVisibility();
});
document
    .getElementById('reveal-paths')
    .addEventListener(
        'change',
        (event) => (rayLineMaterial.uniforms.reveal.value = Number(event.target.checked)),
    );
document.getElementById('pattern-scale').addEventListener('input', (event) => {
    const scale = Number(event.target.value);
    radSpheres.forEach((sphere) => sphere.scale.setScalar(scale));
    document.getElementById('pattern-scale-value').textContent = `${scale}×`;
});
document
    .getElementById('playback-speed')
    .addEventListener('change', (event) => (playbackSpeed = Number(event.target.value)));
document.getElementById('delay-window').addEventListener('change', (event) => {
    setIntegrationWindow(event.target.value === 'full' ? TAP_COUNT : Number(event.target.value));
});
if (window.innerWidth < 600) document.getElementById('toggle-panel').click();

// These controls modify scene appearance even when playback is paused.
for (const id of ['show-roof', 'show-patterns', 'show-paths', 'reveal-paths', 'pattern-scale']) {
    document.getElementById(id).addEventListener('input', invalidateScene);
    document.getElementById(id).addEventListener('change', invalidateScene);
}

document.getElementById('camera-mode').addEventListener('click', () => {
    freeLook = !freeLook;
    controls.unlock();
    orbitControls.enabled = !freeLook;
    const button = document.getElementById('camera-mode');
    button.textContent = freeLook ? 'Orbit' : 'Free look';
    button.setAttribute('aria-pressed', String(freeLook));
    if (!freeLook) {
        camera.getWorldDirection(cameraDirection);
        orbitControls.target.copy(camera.position).addScaledVector(cameraDirection, 12);
        orbitControls.update();
    }
    document.getElementById('camera-hint').innerHTML = freeLook
        ? 'Click the scene to look around <span>WASD move · Space / Shift rise / lower · Esc release</span>'
        : 'Drag to orbit · Scroll to zoom <span>Right-drag to pan · Select Free look for WASD navigation</span>';
    invalidateScene();
});

document.getElementById('retry-data').addEventListener('click', () => {
    currentCsiBin = null;
    activePathKey = null;
    refreshRobotData();
});

document.getElementById('pattern-method').addEventListener('change', () => {
    radiationDirty = true;
    updateRadTime();
});

document.getElementById('toggle-timeline').addEventListener('click', () => {
    const timeline = document.getElementById('propagation-controls');
    const collapsed = document.body.classList.toggle('timeline-hidden');
    timeline.inert = collapsed;
    timeline.setAttribute('aria-hidden', String(collapsed));
    const button = document.getElementById('toggle-timeline');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute(
        'aria-label',
        collapsed ? 'Show propagation delay' : 'Hide propagation delay',
    );
    button.title = collapsed ? 'Show propagation delay' : 'Hide propagation delay';
});
