/* Shared numerical/data helpers. Also loadable by Node for regression tests. */
(function (root) {
    'use strict';
    const config = Object.freeze({
        bandwidth: 50e6,
        speedOfLight: 299792458,
        depth: 6,
        minX: -13,
        maxX: 10,
        minY: -35,
        maxY: 0,
        arrays: 4,
        rows: 2,
        columns: 8,
        taps: 30,
        pathMinX: -15,
        pathMaxX: 10,
        pathMinY: -35,
        pathMaxY: 0,
        pathStep: 0.1,
        ...root.DichasusGrid,
    });
    // Published adxx geometry; regression-checked against data/dataset-spec.json.
    const arrayGeometry = [
        {
            location: [7.9555, -18.2345, 2.5025],
            rightvector: [-0.2685, -0.9633, 0.0],
            upvector: [-0.2318, 0.0713, 0.9701],
            spacingX: 0.04364,
            spacingY: 0.04364,
        },
        {
            location: [-4.71, 0.0488, 6.0385],
            rightvector: [0.9986, -0.0458, -0.0246],
            upvector: [-0.0133, -0.4893, 0.872],
            spacingX: 0.04364,
            spacingY: 0.04364,
        },
        {
            location: [-18.51, 0.116, 6.1785],
            rightvector: [0.8532, 0.5186, 0.0561],
            upvector: [0.1041, -0.2945, 0.95],
            spacingX: 0.04364,
            spacingY: 0.04364,
        },
        {
            location: [-10.93, -25.2055, 5.297],
            rightvector: [-0.9347, 0.3549, -0.0212],
            upvector: [0.1359, 0.4113, 0.9013],
            spacingX: 0.04364,
            spacingY: 0.04364,
        },
    ];
    const arrayColors = Object.freeze(['#0076b2', '#b65300', '#7952b3', '#00845a']);
    const floatsPerBin = config.arrays * config.rows * config.columns * config.taps * 2;
    const bytesPerBin = floatsPerBin * 4;
    const binCount = 4 ** config.depth;
    const pathRows = Math.round((config.pathMaxX - config.pathMinX) / config.pathStep) + 1;

    function positionToBin(x, y, options = config) {
        let { minX, maxX, minY, maxY, depth } = options;
        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < minX ||
            x > maxX ||
            y < minY ||
            y > maxY
        )
            return null;
        let bin = 0;
        for (let level = 0; level < depth; level++) {
            const midX = (minX + maxX) / 2;
            const midY = (minY + maxY) / 2;
            const right = x > midX;
            const upper = y > midY;
            bin = bin * 4 + Number(right) + 2 * Number(upper);
            if (right) minX = midX;
            else maxX = midX;
            if (upper) minY = midY;
            else maxY = midY;
        }
        return bin;
    }

    function binBounds(bin, options = config) {
        if (!Number.isInteger(bin) || bin < 0 || bin >= 4 ** options.depth) return null;
        let { minX, maxX, minY, maxY, depth } = options;
        for (let level = depth - 1; level >= 0; level--) {
            const digit = Math.floor(bin / 4 ** level) % 4;
            const midX = (minX + maxX) / 2;
            const midY = (minY + maxY) / 2;
            if (digit & 1) minX = midX;
            else maxX = midX;
            if (digit & 2) minY = midY;
            else maxY = midY;
        }
        return { minX, maxX, minY, maxY, x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }

    function pathIndices(x, y) {
        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < config.pathMinX ||
            x > config.pathMaxX ||
            y < config.pathMinY ||
            y > config.pathMaxY
        )
            return null;
        return {
            row: Math.round((x - config.pathMinX) / config.pathStep),
            column: Math.round((y - config.pathMinY) / config.pathStep),
        };
    }

    class LRUCache {
        constructor(limit) {
            if (!Number.isInteger(limit) || limit < 1)
                throw new RangeError('Cache limit must be a positive integer');
            this.limit = limit;
            this.entries = new Map();
        }
        get(key) {
            if (!this.entries.has(key)) return undefined;
            const value = this.entries.get(key);
            this.entries.delete(key);
            this.entries.set(key, value);
            return value;
        }
        set(key, value) {
            this.entries.delete(key);
            this.entries.set(key, value);
            while (this.entries.size > this.limit)
                this.entries.delete(this.entries.keys().next().value);
            return value;
        }
        get size() {
            return this.entries.size;
        }
        clear() {
            this.entries.clear();
        }
    }

    class QuadtreeLoader {
        constructor(
            url,
            { fetcher = (...args) => fetch(...args), blockDepth = 2, cacheBlocks = 32 } = {},
        ) {
            if (!Number.isInteger(blockDepth) || blockDepth < 0 || blockDepth > config.depth)
                throw new RangeError('Invalid quadtree block depth');
            this.url = url;
            this.fetcher = fetcher;
            this.blockBins = 4 ** blockDepth;
            this.cache = new LRUCache(cacheBlocks);
            this.pending = new Map();
            this.fullData = null;
            this.initialRequest = null;
            this.rangeSupportKnown = false;
            this.requests = 0;
            this.loadedBytes = 0;
        }
        async get(bin) {
            if (!Number.isInteger(bin) || bin < 0 || bin >= binCount)
                throw new RangeError('Invalid CSI bin');
            if (this.fullData)
                return this.fullData.subarray(bin * floatsPerBin, (bin + 1) * floatsPerBin);
            // Probe range support once. Otherwise concurrent first requests to
            // a plain static server could each download the entire 60 MiB file.
            if (!this.rangeSupportKnown && this.initialRequest) {
                await this.initialRequest;
                return this.get(bin);
            }
            const block = Math.floor(bin / this.blockBins);
            let data = this.cache.get(block);
            if (!data) {
                if (!this.pending.has(block)) {
                    const request = this.loadBlock(block).finally(() => this.pending.delete(block));
                    this.pending.set(block, request);
                    if (!this.rangeSupportKnown) {
                        this.initialRequest = request;
                        request
                            .then(
                                () => {
                                    this.rangeSupportKnown = true;
                                },
                                () => {},
                            )
                            .finally(() => {
                                if (this.initialRequest === request) this.initialRequest = null;
                            });
                    }
                }
                data = await this.pending.get(block);
            }
            if (this.fullData)
                return this.fullData.subarray(bin * floatsPerBin, (bin + 1) * floatsPerBin);
            const offset = (bin % this.blockBins) * floatsPerBin;
            return data.subarray(offset, offset + floatsPerBin);
        }
        async loadBlock(block) {
            const start = block * this.blockBins * bytesPerBin;
            const end = Math.min(start + this.blockBins * bytesPerBin, binCount * bytesPerBin) - 1;
            this.requests++;
            const response = await this.fetcher(this.url, {
                headers: { Range: `bytes=${start}-${end}` },
            });
            if (!response.ok) throw new Error(`CSI download failed (${response.status})`);
            const buffer = await response.arrayBuffer();
            this.loadedBytes += buffer.byteLength;
            if (response.status === 200) {
                if (buffer.byteLength !== binCount * bytesPerBin)
                    throw new Error('CSI file has an unexpected size');
                this.fullData = new Float32Array(buffer);
                this.cache.clear();
                return this.fullData;
            }
            if (response.status !== 206 || buffer.byteLength !== end - start + 1)
                throw new Error('Incomplete CSI byte range');
            const contentRange = response.headers.get('Content-Range');
            if (contentRange !== `bytes ${start}-${end}/${binCount * bytesPerBin}`)
                throw new Error('Unexpected CSI byte range');
            return this.cache.set(block, new Float32Array(buffer));
        }
    }

    async function decodeGzip(buffer) {
        const bytes = new Uint8Array(buffer);
        if (bytes[0] !== 31 || bytes[1] !== 139) return buffer;
        return new Response(
            new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')),
        ).arrayBuffer();
    }

    class ChunkedCsiLoader {
        constructor(
            indexUrl = `data/coverage.json${config.channelVersion ? '?v=' + config.channelVersion : ''}`,
            { fetcher = (...args) => fetch(...args) } = {},
        ) {
            this.indexUrl = indexUrl;
            this.fetcher = fetcher;
            this.indexPromise = null;
            this.index = null;
            this.cache = new LRUCache(32);
            this.pending = new Map();
            this.requests = 0;
            this.loadedBytes = 0;
            this.empty = new Float32Array(floatsPerBin);
            this.prefetching = new Set();
        }
        async loadIndex() {
            if (!this.indexPromise) {
                this.indexPromise = this.fetcher(this.indexUrl, { cache: 'no-cache' })
                    .then(async (response) => {
                        if (!response.ok)
                            throw new Error(`Channel index unavailable (${response.status})`);
                        const index = await response.json();
                        if (
                            index.version !== 1 ||
                            index.chunkFormat !== 1 ||
                            index.depth !== config.depth ||
                            ![1, 4, 16].includes(index.blockBins) ||
                            index.sourceBytes !== binCount * bytesPerBin ||
                            JSON.stringify(index.bounds) !==
                                JSON.stringify([
                                    config.minX,
                                    config.maxX,
                                    config.minY,
                                    config.maxY,
                                ]) ||
                            !Array.isArray(index.chunks) ||
                            index.chunks.length !== binCount / index.blockBins ||
                            index.chunks.some(
                                (name) => name !== null && !/^[0-9a-f]{24}\.bin\.gz$/.test(name),
                            )
                        )
                            throw new Error('Invalid channel chunk index');
                        index.cells = Uint8Array.from(atob(index.occupancy), (char) =>
                            char.charCodeAt(0),
                        );
                        if (index.cells.length !== Math.ceil(binCount / 8))
                            throw new Error('Invalid channel coverage mask');
                        this.blockBins = index.blockBins;
                        this.index = index;
                        return index;
                    })
                    .catch((error) => {
                        this.indexPromise = null;
                        throw error;
                    });
            }
            return this.indexPromise;
        }
        async get(bin) {
            if (!Number.isInteger(bin) || bin < 0 || bin >= binCount)
                throw new RangeError('Invalid CSI bin');
            const index = await this.loadIndex();
            if (!(index.cells[bin >> 3] & (1 << (bin & 7)))) return this.empty;
            const block = Math.floor(bin / this.blockBins);
            if (!index.chunks[block]) throw new Error('Missing measured channel chunk');
            let data = this.cache.get(block);
            if (!data) {
                if (!this.pending.has(block))
                    this.pending.set(
                        block,
                        this.loadChunk(index.chunks[block])
                            .then((value) => this.cache.set(block, value))
                            .finally(() => this.pending.delete(block)),
                    );
                data = await this.pending.get(block);
            }
            const offset = (bin % this.blockBins) * floatsPerBin;
            return data.subarray(offset, offset + floatsPerBin);
        }
        prefetch(bin) {
            if (
                !this.index ||
                !Number.isInteger(bin) ||
                bin < 0 ||
                bin >= binCount ||
                !(this.index.cells[bin >> 3] & (1 << (bin & 7)))
            )
                return;
            const block = Math.floor(bin / this.blockBins);
            if (
                this.cache.entries.has(block) ||
                this.pending.has(block) ||
                this.prefetching.has(block)
            )
                return;
            if (new Set([...this.pending.keys(), ...this.prefetching]).size >= 2) return;
            this.prefetching.add(block);
            this.get(bin)
                .catch(() => {})
                .finally(() => this.prefetching.delete(block));
        }
        async loadChunk(name) {
            this.requests++;
            const prefix = this.indexUrl.slice(0, this.indexUrl.lastIndexOf('/') + 1);
            const response = await this.fetcher(`${prefix}channels/${name}`);
            if (!response.ok) throw new Error(`Channel chunk unavailable (${response.status})`);
            let buffer = await response.arrayBuffer();
            this.loadedBytes += buffer.byteLength;
            // Some hosts transparently decompress .gz files; accept both forms.
            buffer = await decodeGzip(buffer);
            if (buffer.byteLength !== this.blockBins * bytesPerBin)
                throw new Error('Incomplete channel chunk');
            const data = new Float32Array(buffer);
            if (!data.every(Number.isFinite)) throw new Error('Invalid channel values');
            return data;
        }
    }

    const pathColumnBytes = 16 + 201 * 8;
    function parsePathColumn(buffer, column) {
        if (buffer.byteLength !== pathColumnBytes)
            throw new Error('Unexpected path column index size');
        const view = new DataView(buffer);
        if (
            new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'DICHIDX2' ||
            view.getUint16(8, true) !== column ||
            view.getUint16(10, true) !== 201
        )
            throw new Error('Path index grid mismatch');
        const total = view.getUint32(12, true);
        return {
            total,
            range(requestedColumn, firstRow, lastRow = firstRow) {
                if (
                    requestedColumn !== column ||
                    ![firstRow, lastRow].every(Number.isInteger) ||
                    firstRow < 0 ||
                    lastRow < firstRow ||
                    lastRow >= 201
                )
                    throw new RangeError('Invalid path index coordinates');
                const first = 16 + firstRow * 8,
                    last = 16 + lastRow * 8;
                const start = view.getUint32(first, true);
                const end = view.getUint32(last, true) + view.getUint32(last + 4, true) - 1;
                if (start < 1 || end < start || end >= total)
                    throw new Error('Invalid path index offsets');
                return { start, end, total };
            },
        };
    }
    function parsePathIndex(buffer) {
        if (buffer.byteLength !== 351 * pathColumnBytes)
            throw new Error('Unexpected path index size');
        const entries = Array.from({ length: 351 }, (_, column) =>
            parsePathColumn(
                buffer.slice(column * pathColumnBytes, (column + 1) * pathColumnBytes),
                column,
            ),
        );
        return {
            columns: 351,
            rows: 201,
            sizes: Uint32Array.from(entries, (entry) => entry.total),
            range(column, first, last = first) {
                if (!Number.isInteger(column) || column < 0 || column >= 351)
                    throw new RangeError('Invalid path index coordinates');
                return entries[column].range(column, first, last);
            },
        };
    }

    class PathDataLoader {
        constructor({
            fetcher = (...args) => fetch(...args),
            indexUrl = 'data/path-index.bin',
            baseUrl = 'Paths',
            blockRows = 8,
        } = {}) {
            this.fetcher = fetcher;
            if (!Number.isInteger(blockRows) || blockRows < 1 || blockRows > 201)
                throw new RangeError('Invalid path block size');
            this.indexUrl = indexUrl;
            this.baseUrl = baseUrl;
            this.blockRows = blockRows;
            this.indexPromise = null;
            this.index = null;
            this.indexColumns = new LRUCache(32);
            this.indexPending = new Map();
            this.indexRangeKnown = false;
            this.indexUnavailable = false;
            this.indexBytes = 0;
            this.cache = new LRUCache(64);
            this.columns = new LRUCache(4);
            this.requests = 0;
            this.loadedBytes = 0;
        }
        async loadIndex(column) {
            if (this.index || this.indexUnavailable) return this.index;
            const cached = this.indexColumns.get(column);
            if (cached) return cached;
            if (!this.indexRangeKnown && this.indexPromise) {
                await this.indexPromise;
                return this.loadIndex(column);
            }
            if (this.indexPending.has(column)) return this.indexPending.get(column);
            const request = this.fetchIndexColumn(column).finally(() => {
                this.indexPending.delete(column);
                if (this.indexPromise === request) this.indexPromise = null;
            });
            this.indexPending.set(column, request);
            if (!this.indexRangeKnown) this.indexPromise = request;
            return request;
        }
        async fetchIndexColumn(column) {
            const start = column * pathColumnBytes,
                end = start + pathColumnBytes - 1;
            const response = await this.fetcher(this.indexUrl, {
                headers: { Range: `bytes=${start}-${end}` },
            });
            if (response.status === 404) {
                this.indexUnavailable = true;
                return null;
            }
            if (!response.ok) throw new Error(`Path index unavailable (${response.status})`);
            const buffer = await response.arrayBuffer();
            this.indexBytes += buffer.byteLength;
            if (response.status === 200) {
                this.index = parsePathIndex(buffer);
                this.indexRangeKnown = true;
                return this.index;
            }
            if (
                response.status !== 206 ||
                response.headers.get('Content-Range') !==
                    `bytes ${start}-${end}/${351 * pathColumnBytes}`
            )
                throw new Error('Unexpected path index byte range');
            const index = parsePathColumn(buffer, column);
            this.indexRangeKnown = true;
            return this.indexColumns.set(column, index);
        }
        async loadBlock(column, row, signal) {
            const index = await this.loadIndex(column);
            if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
            const full = this.columns.get(column);
            if (full) return { firstRow: 0, records: full };
            const firstRow = Math.floor(row / this.blockRows) * this.blockRows;
            const lastRow = Math.min(200, firstRow + this.blockRows - 1);
            const key = `${column}:${firstRow}`;
            const cached = this.cache.get(key);
            if (cached) return cached;
            const range = index?.range(column, firstRow, lastRow);
            this.requests++;
            const response = await this.fetcher(`${this.baseUrl}/paths_${column}.json`, {
                signal,
                headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
            });
            if (!response.ok) throw new Error(`Path file unavailable (${response.status})`);
            const text = await response.text();
            this.loadedBytes += new TextEncoder().encode(text).byteLength;
            if (response.status === 200) {
                const records = JSON.parse(text);
                if (!Array.isArray(records) || records.length !== 201)
                    throw new Error('Unexpected path column size');
                this.columns.set(column, records);
                return { firstRow: 0, records };
            }
            if (
                !range ||
                response.status !== 206 ||
                response.headers.get('Content-Range') !==
                    `bytes ${range.start}-${range.end}/${range.total}`
            )
                throw new Error('Unexpected path byte range');
            const records = JSON.parse(`[${text}]`);
            if (records.length !== lastRow - firstRow + 1) throw new Error('Incomplete path block');
            return this.cache.set(key, { firstRow, records });
        }
    }

    function parseBinaryPaths(buffer) {
        const view = new DataView(buffer);
        let offset = 0;
        const need = (bytes) => {
            if (offset + bytes > view.byteLength) throw new Error('Truncated binary path block');
        };
        const u8 = () => {
            need(1);
            return view.getUint8(offset++);
        };
        const u16 = () => {
            need(2);
            const value = view.getUint16(offset, true);
            offset += 2;
            return value;
        };
        const u32 = () => {
            need(4);
            const value = view.getUint32(offset, true);
            offset += 4;
            return value;
        };
        const number = (size) => {
            need(size);
            const value =
                size === 8 ? view.getFloat64(offset, true) : view.getFloat32(offset, true);
            offset += size;
            if (!Number.isFinite(value)) throw new Error('Non-finite binary path value');
            return value;
        };
        const vector = (size) => [number(size), number(size), number(size)];
        need(12);
        if (new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'DICHPTH1')
            throw new Error('Invalid binary path header');
        offset = 8;
        const count = u16(),
            sourceCount = u8(),
            reserved = u8();
        if (count > Math.max(251, pathRows) || sourceCount !== 4 || reserved !== 0)
            throw new Error('Unsupported binary path counts');
        const sources = Array.from({ length: sourceCount }, () => vector(8));
        const records = [];
        for (let row = 0; row < count; row++) {
            const coordinates = vector(8),
                flags = u8(),
                pathCount = u32();
            if (flags & ~1 || pathCount > (view.byteLength - offset) / 8)
                throw new Error('Invalid binary path record');
            const record = { coordinates, paths: [] };
            if (flags & 1) {
                record.delay_reference_seconds = number(8);
                if (record.delay_reference_seconds < 0)
                    throw new Error('Invalid binary delay reference');
            }
            for (let i = 0; i < pathCount; i++) {
                const path_index = u32(),
                    tx_index = u8(),
                    rx_index = u8(),
                    verticesCount = u8(),
                    pathFlags = u8();
                if (tx_index >= sourceCount || rx_index !== 0 || pathFlags & ~3)
                    throw new Error('Invalid binary path fields');
                const path = {
                    path_index,
                    tx_index,
                    rx_index,
                    source: sources[tx_index],
                    target: coordinates,
                    vertices: [],
                    objects: [],
                };
                if (pathFlags & 1) {
                    path.delay_seconds = number(8);
                    if (path.delay_seconds < 0) throw new Error('Invalid binary path delay');
                }
                if (pathFlags & 2) {
                    path.relative_power_db = number(8);
                    if (path.relative_power_db > 1e-4) throw new Error('Invalid binary path power');
                }
                need(verticesCount * 16);
                for (let vertex = 0; vertex < verticesCount; vertex++) {
                    path.vertices.push(vector(4));
                    path.objects.push(u32());
                }
                record.paths.push(path);
            }
            records.push(record);
        }
        if (offset !== view.byteLength) throw new Error('Trailing bytes in binary path block');
        return records;
    }

    class PackedPathLoader {
        constructor({
            fetcher = (...args) => fetch(...args),
            indexUrl = `data/path-chunks.json.gz${config.pathVersion ? '?v=' + config.pathVersion : ''}`,
            baseUrl = 'Paths/packed',
        } = {}) {
            this.fetcher = fetcher;
            this.indexUrl = indexUrl;
            this.baseUrl = baseUrl;
            this.indexPromise = null;
            this.blockRows = 8;
            this.cache = new LRUCache(64);
            this.pending = new Map();
            this.columns = new LRUCache(4);
            this.requests = 0;
            this.loadedBytes = 0;
            this.indexBytes = 0;
            this.unavailable = false;
            this.fallback = new PathDataLoader({ fetcher });
        }
        async prepare() {
            if (this.unavailable) return;
            if (!this.indexPromise)
                this.indexPromise = this.fetcher(this.indexUrl, { cache: 'no-cache' })
                    .then(async (response) => {
                        if (response.status === 404) {
                            if (config.pathMinX !== -15)
                                throw new Error('Extended path index unavailable');
                            this.unavailable = true;
                            return null;
                        }
                        if (!response.ok)
                            throw new Error(`Packed path index unavailable (${response.status})`);
                        const bytes = await response.arrayBuffer();
                        this.indexBytes += bytes.byteLength;
                        const index = JSON.parse(new TextDecoder().decode(await decodeGzip(bytes)));
                        if (
                            ![1, 2].includes(index.version) ||
                            index.columns !== 351 ||
                            !(
                                index.rows === pathRows ||
                                (config.pathMinX === -15 && index.rows === 201)
                            ) ||
                            index.minX !== config.pathMinX ||
                            index.minY !== config.pathMinY ||
                            index.step !== config.pathStep ||
                            !Number.isInteger(index.blockRows) ||
                            index.blockRows < 1 ||
                            index.blockRows > 201 ||
                            !Array.isArray(index.files) ||
                            index.files.length !== 351
                        )
                            throw new Error('Invalid packed path grid');
                        if (
                            index.blockFormat !== undefined &&
                            !['json', 'binary-v1'].includes(index.blockFormat)
                        )
                            throw new Error('Unsupported packed path format');
                        const offsetsCount = Math.ceil(index.rows / index.blockRows) + 1;
                        for (const entry of index.files) {
                            if (index.version === 2) {
                                if (
                                    !Array.isArray(entry.lengths) ||
                                    entry.lengths.length !== offsetsCount - 1 ||
                                    entry.lengths.some(
                                        (length) => !Number.isSafeInteger(length) || length <= 0,
                                    )
                                )
                                    throw new Error('Invalid packed path lengths');
                                entry.offsets = [0];
                                for (const length of entry.lengths)
                                    entry.offsets.push(
                                        entry.offsets[entry.offsets.length - 1] + length,
                                    );
                                delete entry.lengths;
                            }
                            if (
                                !/^[0-9a-f]{24}\.bin$/.test(entry.file) ||
                                !Array.isArray(entry.offsets) ||
                                entry.offsets.length !== offsetsCount ||
                                entry.offsets[0] !== 0 ||
                                entry.offsets.some(
                                    (offset, i) =>
                                        !Number.isSafeInteger(offset) ||
                                        offset < 0 ||
                                        (i && offset <= entry.offsets[i - 1]),
                                )
                            )
                                throw new Error('Invalid packed path offsets');
                        }
                        this.blockRows = index.blockRows;
                        this.fallback.blockRows = index.blockRows;
                        return index;
                    })
                    .catch((error) => {
                        this.indexPromise = null;
                        throw error;
                    });
            return this.indexPromise;
        }
        async loadBlock(column, row, signal) {
            await this.prepare();
            const key = `${column}:${Math.floor(row / this.blockRows)}`;
            if (!this.pending.has(key)) {
                const request = this.readBlock(column, row, signal).finally(() =>
                    this.pending.delete(key),
                );
                this.pending.set(key, request);
            }
            return this.pending.get(key);
        }
        async readBlock(column, row, signal) {
            if (
                !Number.isInteger(column) ||
                column < 0 ||
                column >= 351 ||
                !Number.isInteger(row) ||
                row < 0 ||
                row >= pathRows
            )
                throw new RangeError('Invalid path position');
            const index = await this.prepare();
            if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
            if (row >= (index?.rows || 201)) throw new RangeError('Outside this path grid');
            if (this.unavailable) return this.fallback.loadBlock(column, row, signal);
            const block = Math.floor(row / this.blockRows),
                key = `${column}:${block}`;
            const cached = this.cache.get(key);
            if (cached) return cached;
            const entry = index.files[column],
                firstRow = block * this.blockRows;
            const start = entry.offsets[block],
                end = entry.offsets[block + 1] - 1;
            const total = entry.offsets[entry.offsets.length - 1];
            let columnBytes = this.columns.get(column),
                compressed;
            if (columnBytes) compressed = columnBytes.slice(start, end + 1);
            else {
                this.requests++;
                const response = await this.fetcher(`${this.baseUrl}/${entry.file}`, {
                    signal,
                    headers: { Range: `bytes=${start}-${end}` },
                });
                // Once a packed manifest selects a generation, never substitute
                // legacy rays from a different simulation when one asset is missing.
                if (!response.ok) throw new Error(`Packed paths unavailable (${response.status})`);
                const bytes = await response.arrayBuffer();
                this.loadedBytes += bytes.byteLength;
                if (response.status === 200) {
                    if (bytes.byteLength !== total)
                        throw new Error('Incomplete packed path column');
                    this.columns.set(column, bytes);
                    compressed = bytes.slice(start, end + 1);
                } else {
                    if (
                        response.status !== 206 ||
                        bytes.byteLength !== end - start + 1 ||
                        response.headers.get('Content-Range') !== `bytes ${start}-${end}/${total}`
                    )
                        throw new Error('Unexpected packed path byte range');
                    compressed = bytes;
                }
            }
            try {
                const decoded = await decodeGzip(compressed);
                const records =
                    index.blockFormat === 'binary-v1'
                        ? parseBinaryPaths(decoded)
                        : JSON.parse(new TextDecoder().decode(decoded));
                if (
                    !Array.isArray(records) ||
                    records.length !== Math.min(this.blockRows, index.rows - firstRow)
                )
                    throw new Error('Incomplete packed path records');
                return this.cache.set(key, { firstRow, records });
            } catch (error) {
                // A full-column response must not poison later retries when
                // one compressed member is corrupt or contains invalid JSON.
                this.columns.entries.delete(column);
                throw error;
            }
        }
    }

    function hasSignal(csi) {
        return !!csi && csi.some((value) => Number.isFinite(value) && value !== 0);
    }

    // Reconstruct each antenna's complex signal once per delay window, rather
    // than repeating an inverse DFT at every vertex of the radiation mesh.
    function reconstructWindow(
        csi,
        start,
        stop,
        steps = 10,
        output = new Float32Array(config.rows * config.columns * steps * 2),
    ) {
        const antennas = config.rows * config.columns;
        const taps = config.taps;
        output.fill(0);
        for (let t = 0; t < steps; t++) {
            const time = start + ((stop - start) * t) / steps;
            const phase = (2 * Math.PI * (time - taps / 2)) / taps;
            for (let s = 0; s < taps; s++) {
                const real = Math.cos(phase * s) / taps;
                const imag = Math.sin(phase * s) / taps;
                for (let a = 0; a < antennas; a++) {
                    const source = 2 * (a * taps + s);
                    const target = 2 * (t * antennas + a);
                    output[target] += real * csi[source] - imag * csi[source + 1];
                    output[target + 1] += real * csi[source + 1] + imag * csi[source];
                }
            }
        }
        return output;
    }

    // Hermitian spatial correlation reduces a 16-element, multi-time-sample
    // angular scan to 23 unique array lags. This is exactly the shader's power.
    const beamLags = [
        [0, 0],
        ...Array.from({ length: 7 }, (_, i) => [0, i + 1]),
        ...Array.from({ length: 15 }, (_, i) => [1, i - 7]),
    ];
    function beamCorrelations(samples) {
        const steps = samples.length / 32;
        if (!Number.isInteger(steps) || steps < 1) throw new RangeError('Invalid beam samples');
        const coefficients = new Float64Array(beamLags.length * 2);
        beamLags.forEach(([dr, dc], lag) => {
            for (let row = 0; row < 2; row++)
                for (let col = 0; col < 8; col++) {
                    const otherRow = row - dr,
                        otherCol = col - dc;
                    if (otherRow < 0 || otherRow >= 2 || otherCol < 0 || otherCol >= 8) continue;
                    for (let t = 0; t < steps; t++) {
                        const a = (t * 16 + row * 8 + col) * 2;
                        const b = (t * 16 + otherRow * 8 + otherCol) * 2;
                        coefficients[2 * lag] +=
                            (samples[a] * samples[b] + samples[a + 1] * samples[b + 1]) / steps;
                        coefficients[2 * lag + 1] +=
                            (samples[a + 1] * samples[b] - samples[a] * samples[b + 1]) / steps;
                    }
                }
        });
        return coefficients;
    }
    function prepareBeamforming(samples, correlations, sampleSums) {
        correlations.set(beamCorrelations(samples));
        sampleSums.fill(0);
        for (let i = 0; i < samples.length; i++) sampleSums[i % 32] += samples[i];
    }
    function fullRangeCorrelations(csi, output = new Float32Array(46)) {
        if (csi.length !== config.rows * config.columns * config.taps * 2 || output.length !== 46)
            throw new RangeError('Invalid full-range beam data');
        // Parseval: summing h_a(t) conj(h_b(t)) over every delay tap is
        // exactly (1/N) sum H_a(f) conj(H_b(f)). No coarse time sampling,
        // no coherent cancellation between arrivals at different delays.
        output.fill(0);
        beamLags.forEach(([dr, dc], lag) => {
            let real = 0,
                imag = 0;
            for (let row = 0; row < 2; row++)
                for (let col = 0; col < 8; col++) {
                    const otherRow = row - dr,
                        otherCol = col - dc;
                    if (otherRow < 0 || otherRow >= 2 || otherCol < 0 || otherCol >= 8) continue;
                    for (let frequency = 0; frequency < config.taps; frequency++) {
                        const a = ((row * 8 + col) * config.taps + frequency) * 2;
                        const b = ((otherRow * 8 + otherCol) * config.taps + frequency) * 2;
                        real += csi[a] * csi[b] + csi[a + 1] * csi[b + 1];
                        imag += csi[a + 1] * csi[b] - csi[a] * csi[b + 1];
                    }
                }
            output[2 * lag] = real / config.taps;
            output[2 * lag + 1] = imag / config.taps;
        });
        return output;
    }
    function createBeamScan(positions) {
        const count = positions.length / 3;
        const steering = new Float32Array(count * beamLags.length * 2);
        for (let i = 0; i < count; i++) {
            const x = positions[3 * i],
                y = positions[3 * i + 1],
                z = positions[3 * i + 2];
            const azimuth = Math.atan2(z, x) - Math.PI / 2;
            const elevation = Math.atan2(y, Math.hypot(x, z));
            const weighting =
                Math.max(0, Math.cos(elevation)) ** 0.8 * Math.max(0, Math.cos(azimuth)) ** 0.8;
            beamLags.forEach(([dr, dc], lag) => {
                const phase = Math.PI * (dc * Math.sin(azimuth) + dr * Math.sin(elevation));
                const factor = weighting * (lag ? 2 : 1);
                const index = (i * beamLags.length + lag) * 2;
                steering[index] = factor * Math.cos(phase);
                steering[index + 1] = -factor * Math.sin(phase);
            });
        }
        return steering;
    }
    function scanBeamPowers(samples, steering, output) {
        const coefficients = beamCorrelations(samples),
            stride = coefficients.length;
        const count = steering.length / stride;
        output = output || new Float64Array(count);
        if (output.length !== count) throw new RangeError('Incorrect beam scan output size');
        for (let direction = 0; direction < count; direction++) {
            let power = 0;
            for (let term = 0; term < stride; term++)
                power += coefficients[term] * steering[direction * stride + term];
            output[direction] = Math.max(0, power);
        }
        return output;
    }

    function computeDelayProfiles(csi) {
        const perArray = config.rows * config.columns * config.taps * 2;
        const profiles = [];
        for (let array = 0; array < config.arrays; array++) {
            const samples = reconstructWindow(
                csi.subarray(array * perArray, (array + 1) * perArray),
                0,
                config.taps,
                config.taps,
            );
            const power = new Float64Array(config.taps);
            for (let t = 0; t < config.taps; t++) {
                for (let antenna = 0; antenna < config.rows * config.columns; antenna++) {
                    const offset = (t * config.rows * config.columns + antenna) * 2;
                    power[t] +=
                        (samples[offset] ** 2 + samples[offset + 1] ** 2) /
                        (config.rows * config.columns);
                }
            }
            const total = power.reduce((a, b) => a + b, 0);
            const mean = total ? power.reduce((sum, p, i) => sum + p * i, 0) / total : 0;
            const variance = total
                ? power.reduce((sum, p, i) => sum + p * (i - mean) ** 2, 0) / total
                : 0;
            const peak = power.indexOf(Math.max(...power));
            profiles.push({
                power,
                total,
                peakNs: (peak / config.bandwidth) * 1e9,
                rmsNs: (Math.sqrt(variance) / config.bandwidth) * 1e9,
            });
        }
        return profiles;
    }

    const api = {
        config,
        arrayGeometry,
        arrayColors,
        floatsPerBin,
        bytesPerBin,
        binCount,
        positionToBin,
        binBounds,
        pathIndices,
        LRUCache,
        QuadtreeLoader,
        ChunkedCsiLoader,
        decodeGzip,
        parsePathIndex,
        parseBinaryPaths,
        PathDataLoader,
        PackedPathLoader,
        hasSignal,
        reconstructWindow,
        computeDelayProfiles,
        beamCorrelations,
        prepareBeamforming,
        fullRangeCorrelations,
        createBeamScan,
        scanBeamPowers,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.RadioCore = api;
})(globalThis);
