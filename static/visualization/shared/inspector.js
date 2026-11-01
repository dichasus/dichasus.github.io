const profileCanvas = document.getElementById('delay-profile');
const profileContext = profileCanvas.getContext('2d');
const arrayColorCss = RadioCore.arrayColors;
let currentProfiles = null;
let referenceProfiles = null;
let referencePosition = null;

function profileLayout() {
    return {
        width: profileCanvas.clientWidth,
        height: profileCanvas.clientHeight,
        left: 40,
        right: 20,
        top: 12,
        bottom: 28,
    };
}

function updateProfileWindow() {
    const { width, height, left, right, top, bottom } = profileLayout();
    const plotWidth = width - left - right;
    const window = document.getElementById('profile-window');
    window.style.left = `${((left + (plotWidth * rad_time_start) / TAP_COUNT) / width) * 100}%`;
    window.style.width = `${((plotWidth * rad_time_duration) / TAP_COUNT / width) * 100}%`;
    window.style.top = `${(top / height) * 100}%`;
    window.style.bottom = `${(bottom / height) * 100}%`;
}

function drawDelayProfile() {
    const ctx = profileContext;
    const { width, height, left, right, top, bottom } = profileLayout();
    if (!width || !height) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const bufferWidth = Math.round(width * pixelRatio);
    const bufferHeight = Math.round(height * pixelRatio);
    if (profileCanvas.width !== bufferWidth || profileCanvas.height !== bufferHeight) {
        profileCanvas.width = bufferWidth;
        profileCanvas.height = bufferHeight;
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    ctx.clearRect(0, 0, width, height);
    ctx.font = `16px ${getComputedStyle(profileCanvas).fontFamily}`;
    ctx.lineWidth = 1;
    for (const amplitude of [0, 0.5, 1]) {
        const y = top + (1 - amplitude) * plotHeight;
        ctx.strokeStyle = '#dee2e6';
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - right, y);
        ctx.stroke();
        ctx.fillStyle = '#62676c';
        ctx.textAlign = 'right';
        ctx.fillText(String(amplitude), left - 10, y + 6);
    }
    ctx.textAlign = 'center';
    for (const ns of [0, 200, 400, 600])
        ctx.fillText(String(ns), left + (ns / 600) * plotWidth, height - 10);
    if (!currentProfiles && !referenceProfiles) {
        ctx.fillStyle = '#62676c';
        ctx.fillText('No channel at this position', left + plotWidth / 2, top + plotHeight / 2);
        return;
    }
    const allProfiles = [...(currentProfiles || []), ...(referenceProfiles || [])];
    const peak = Math.max(...allProfiles.flatMap((profile) => [...profile.power]));
    function plot(profiles, reference) {
        if (!profiles) return;
        ctx.globalAlpha = reference ? 0.6 : 1;
        ctx.setLineDash(reference ? [7, 5] : []);
        profiles.forEach((profile, array) => {
            ctx.strokeStyle = arrayColorCss[array];
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            profile.power.forEach((power, tap) => {
                const amplitude = Math.sqrt(Math.max(0, power) / Math.max(peak, 1e-30));
                const x = left + (tap / TAP_COUNT) * plotWidth;
                const y = top + (1 - amplitude) * plotHeight;
                if (tap === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
        });
    }
    plot(referenceProfiles, true);
    plot(currentProfiles, false);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}
function updateProfiles(data) {
    currentProfiles = data ? RadioCore.computeDelayProfiles(data) : null;
    drawDelayProfile();
    document.getElementById('pin-reference').disabled = !currentProfiles;
    const metrics = document.getElementById('array-metrics');
    if (!currentProfiles) {
        metrics.replaceChildren();
        document.getElementById('profile-summary').textContent = 'No CSI';
        return;
    }
    document.getElementById('profile-summary').textContent = referenceProfiles
        ? 'Relative amplitude · dashed: reference'
        : 'Relative amplitude · delay [ns]';
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr><th>Array</th><th title="Total received power over the 30 retained delay bins, averaged over antennas. Relative to the strongest array at this position; not calibrated dBm.">RX power [dB rel.]</th><th>RMS spread</th>${referenceProfiles ? '<th>Δ RMS</th>' : ''}</tr></thead>`;
    const strongestTotal = Math.max(...currentProfiles.map((profile) => profile.total));
    const body = document.createElement('tbody');
    currentProfiles.forEach((profile, index) => {
        const row = body.insertRow();
        for (const text of [
            `A${index}`,
            profile.total > 0 ? (10 * Math.log10(profile.total / strongestTotal)).toFixed(1) : '—',
            profile.total ? `${profile.rmsNs.toFixed(1)} ns` : '—',
        ])
            row.insertCell().textContent = text;
        const swatch = document.createElement('i');
        swatch.className = `array-swatch array-${index}`;
        swatch.setAttribute('aria-hidden', 'true');
        row.cells[0].prepend(swatch);
    });
    if (referenceProfiles) {
        [...body.rows].forEach((row, index) => {
            const difference = currentProfiles[index].rmsNs - referenceProfiles[index].rmsNs;
            row.insertCell().textContent =
                currentProfiles[index].total && referenceProfiles[index].total
                    ? `${difference >= 0 ? '+' : ''}${difference.toFixed(1)}`
                    : '—';
        });
    }
    table.append(body);
    metrics.replaceChildren(table);
}
window.addEventListener('csi-loaded', (event) => updateProfiles(event.detail.data));
window.addEventListener('viewer-status', (event) => {
    if (event.detail.key === 'csi' && event.detail.state !== 'ready') updateProfiles(null);
});
function scrubProfile(event) {
    const rect = profileCanvas.getBoundingClientRect();
    const { width, left, right } = profileLayout();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    setPlaying(false);
    setDelay(((x - left) / (width - left - right)) * TAP_COUNT);
}
let profilePointer = null;
profileCanvas.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || profilePointer !== null) return;
    event.preventDefault();
    profilePointer = event.pointerId;
    profileCanvas.setPointerCapture(event.pointerId);
    profileCanvas.focus({ preventScroll: true });
    scrubProfile(event);
});
profileCanvas.addEventListener('pointermove', (event) => {
    if (event.pointerId === profilePointer) scrubProfile(event);
});
profileCanvas.addEventListener('pointerup', (event) => {
    if (event.pointerId !== profilePointer) return;
    scrubProfile(event);
    profilePointer = null;
    profileCanvas.releasePointerCapture(event.pointerId);
});
profileCanvas.addEventListener('pointercancel', () => {
    profilePointer = null;
});
profileCanvas.addEventListener('lostpointercapture', () => {
    profilePointer = null;
});
updateProfiles(currentCsi);

document.getElementById('pin-reference').addEventListener('click', () => {
    if (!currentProfiles || !model) return;
    referenceProfiles = currentProfiles.map((profile) => ({
        ...profile,
        power: profile.power.slice(),
    }));
    referencePosition = { x: model.position.x, y: -model.position.z };
    const status = document.getElementById('reference-status');
    status.hidden = false;
    status.querySelector('span').textContent =
        `Dashed: (${referencePosition.x.toFixed(1)}, ${referencePosition.y.toFixed(1)}) m`;
    updateProfiles(currentCsi);
});
document.getElementById('clear-reference').addEventListener('click', () => {
    referenceProfiles = null;
    referencePosition = null;
    document.getElementById('reference-status').hidden = true;
    updateProfiles(currentCsi);
});
profileCanvas.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    setPlaying(false);
    setDelay(
        event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TAP_COUNT
              : rad_time_start + (event.key === 'ArrowRight' ? 0.25 : -0.25),
    );
});

new ResizeObserver(() => {
    drawDelayProfile();
    updateProfileWindow();
}).observe(profileCanvas);

// A monitor change can alter pixel density without resizing the CSS canvas.
function watchProfilePixelRatio() {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
        'change',
        () => {
            drawDelayProfile();
            watchProfilePixelRatio();
        },
        { once: true },
    );
}
watchProfilePixelRatio();
