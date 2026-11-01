/* Spatially smoothed, diagonally loaded Capon spectrum for the 2×8 arrays. */
(function (root) {
    'use strict';
    const columns = 6;
    const elements = 2 * columns;
    const loading = 0.05;

    function invert(matrix, size) {
        const width = size * 2;
        const rows = Array.from({ length: size }, (_, row) => {
            const values = new Float64Array(width);
            values.set(matrix.subarray(row * size, (row + 1) * size));
            values[size + row] = 1;
            return values;
        });
        for (let column = 0; column < size; column++) {
            let pivot = column;
            for (let row = column + 1; row < size; row++)
                if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
            [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
            const diagonal = rows[column][column];
            if (!Number.isFinite(diagonal) || Math.abs(diagonal) < 1e-12)
                throw new Error('Singular loaded covariance');
            for (let k = 0; k < width; k++) rows[column][k] /= diagonal;
            for (let row = 0; row < size; row++) {
                if (row === column) continue;
                const factor = rows[row][column];
                for (let k = 0; k < width; k++) rows[row][k] -= factor * rows[column][k];
            }
        }
        return rows.map((row) => row.slice(size));
    }

    function capon(samples) {
        const steps = samples.length / 32;
        if (!Number.isInteger(steps) || steps < 1)
            throw new RangeError('Expected complex samples from sixteen antennas');
        const real = new Float64Array(elements * elements);
        const imag = new Float64Array(elements * elements);
        // Three overlapping 2×6 subarrays retain both rows while decorrelating
        // coherent multipath. Time samples use the same window as the beamformer.
        for (let t = 0; t < steps; t++) {
            for (let shift = 0; shift < 3; shift++) {
                for (let a = 0; a < elements; a++) {
                    const ia = 2 * (t * 16 + Math.floor(a / columns) * 8 + (a % columns) + shift);
                    for (let b = 0; b < elements; b++) {
                        const ib =
                            2 * (t * 16 + Math.floor(b / columns) * 8 + (b % columns) + shift);
                        const index = a * elements + b;
                        real[index] +=
                            samples[ia] * samples[ib] + samples[ia + 1] * samples[ib + 1];
                        imag[index] +=
                            samples[ia + 1] * samples[ib] - samples[ia] * samples[ib + 1];
                    }
                }
            }
        }
        let power = 0;
        for (let a = 0; a < elements; a++) power += real[a * elements + a];
        power /= elements * steps * 3;
        const coefficients = new Float32Array(46);
        if (!(power > 0) || !Number.isFinite(power)) return { coefficients, scale: 0, floor: 0 };
        // Forward/backward averaging and trace normalization keep the inverse
        // well-conditioned. Five-percent diagonal loading limits sharp false peaks.
        const size = 2 * elements;
        const matrix = new Float64Array(size * size);
        for (let a = 0; a < elements; a++) {
            for (let b = 0; b < elements; b++) {
                const index = a * elements + b;
                const reversed = (elements - 1 - a) * elements + elements - 1 - b;
                const re =
                    (real[index] + real[reversed]) / (6 * steps * power) + (a === b ? loading : 0);
                const im = (imag[index] - imag[reversed]) / (6 * steps * power);
                matrix[a * size + b] = matrix[(a + elements) * size + b + elements] = re;
                matrix[a * size + b + elements] = -im;
                matrix[(a + elements) * size + b] = im;
            }
        }
        const inverse = invert(matrix, size);
        // The inverse's quadratic form has the same lag layout as the existing
        // shader, so adaptive scanning requires no extra vertices or textures.
        for (let lag = 0; lag < 23; lag++) {
            const dr = lag < 8 ? 0 : 1;
            const dc = lag < 8 ? lag : lag - 15;
            for (let row = dr; row < 2; row++) {
                for (let col = 0; col < columns; col++) {
                    const other = col - dc;
                    if (other < 0 || other >= columns) continue;
                    const a = row * columns + col;
                    const b = (row - dr) * columns + other;
                    coefficients[2 * lag] += inverse[a][b];
                    coefficients[2 * lag + 1] += inverse[a + elements][b];
                }
            }
        }
        // Match the conventional 16-element response for an ideal single wave;
        // subtract the artificial loading floor, not a measured noise estimate.
        return { coefficients, scale: 256 * power, floor: loading / elements };
    }

    const api = { capon };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AdaptiveBeamforming = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
