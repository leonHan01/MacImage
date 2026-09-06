const fs = require('node:fs');
const pathModule = require('node:path');

const { mapWithConcurrency } = require('./async-utils');
const { calculateFileHash, calculateFullFileHash, calculateLegacyFileHash } = require('./hashUtils');
const {
    createResizedImageWithSips,
    getImageCacheFileName,
    getPreviewDecoder,
    readImageFormat
} = require('./image-preview-utils');

const DEFAULT_IMAGE_EXTENSIONS = [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.bmp',
    '.webp',
    '.tiff',
    '.tif',
    '.heic',
    '.heif'
];
const DEFAULT_SCAN_CONCURRENCY = 8;
const DEFAULT_METADATA_BATCH_SIZE = 48;
const DEFAULT_THUMBNAIL_SIZE = 220;

function createImageLibrary({
    store,
    nativeImage,
    thumbnailCacheDir,
    fsp = fs.promises,
    path = pathModule,
    hashFile = calculateFileHash,
    hashFullFile = calculateFullFileHash,
    hashLegacyFile = calculateLegacyFileHash,
    resizeWithSips = createResizedImageWithSips,
    detectPreviewDecoder = getPreviewDecoder,
    readFormat = readImageFormat,
    getCacheFileName = getImageCacheFileName,
    imageExtensions = DEFAULT_IMAGE_EXTENSIONS,
    scanConcurrency = DEFAULT_SCAN_CONCURRENCY,
    metadataBatchSize = DEFAULT_METADATA_BATCH_SIZE,
    logger = console
}) {
    if (!store) throw new TypeError('ImageLibrary requires a store');
    if (!nativeImage) throw new TypeError('ImageLibrary requires Electron nativeImage');
    if (typeof thumbnailCacheDir !== 'string' || !thumbnailCacheDir) {
        throw new TypeError('ImageLibrary requires a thumbnail cache directory');
    }

    const supportedExtensions = new Set(imageExtensions.map(extension => extension.toLowerCase()));
    const pendingHashCalculations = new Map();
    const pendingThumbnailGenerations = new Map();

    async function listEntries(directory) {
        const entries = await fsp.readdir(directory, { withFileTypes: true });
        return entries.filter(entry => (
            entry.isFile() &&
            !entry.name.startsWith('.') &&
            supportedExtensions.has(path.extname(entry.name).toLowerCase())
        ));
    }

    async function readDirectory(directory, { onMetadata } = {}) {
        const entries = await listEntries(directory);
        const pathToHash = store.getPathHashesForDirectory(directory);
        const records = (await mapWithConcurrency(
            entries,
            scanConcurrency,
            entry => getImageRecord(directory, entry.name, pathToHash)
        )).filter(Boolean);
        const metadataByHash = store.getImageMetadataForHashes(
            records.map(image => image.hash).filter(Boolean)
        );

        records.forEach((image) => {
            if (!image.hash || !metadataByHash[image.hash]) return;
            image.tags = metadataByHash[image.hash].tags;
            image.score = metadataByHash[image.hash].score;
        });

        const recordsMissingHash = records.filter(image => !image.hash);
        if (recordsMissingHash.length > 0) {
            void hydrateMetadata(recordsMissingHash, onMetadata);
        }
        return records;
    }

    async function getHash(imagePath) {
        const stats = await fsp.stat(imagePath);
        const cachedEntry = store.getPathHash(imagePath);
        let hash = getCachedHashForStats(cachedEntry, stats);

        if (!hash) {
            hash = await calculateHashForStats(imagePath, stats);
            store.setPathHash(imagePath, createHashCacheEntry(hash, stats));
        }
        return hash;
    }

    async function getThumbnail(imagePath, requestedSize = DEFAULT_THUMBNAIL_SIZE) {
        const size = normalizeThumbnailSize(requestedSize);
        const hash = await getHash(imagePath);
        if (!hash) throw new Error('无法计算图片 hash');

        const cachePath = path.join(thumbnailCacheDir, getCacheFileName(hash, size));
        const cached = await ensureThumbnail(imagePath, cachePath, size);
        const buffer = await fsp.readFile(cachePath);
        return {
            dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
            cached
        };
    }

    async function findDuplicates(candidates) {
        const candidateGroups = new Map();
        (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
            if (!candidate || typeof candidate.path !== 'string' || !Number.isFinite(candidate.size)) return;

            // A missing or stale renderer hash must not exclude a same-size
            // file from verification. Confirm candidates from their contents.
            const key = candidate.size;
            if (!candidateGroups.has(key)) candidateGroups.set(key, []);
            candidateGroups.get(key).push(candidate);
        });

        const duplicateCandidates = [...candidateGroups.values()]
            .filter(group => group.length > 1)
            .flat();
        const results = await mapWithConcurrency(
            duplicateCandidates,
            4,
            async (candidate) => {
                try {
                    return { path: candidate.path, hash: await hashFullFile(candidate.path) };
                } catch (error) {
                    return { path: candidate.path, error: error.message };
                }
            }
        );
        const groupsByFullHash = new Map();
        const failures = [];

        results.forEach((result) => {
            if (!result?.hash) {
                if (result) failures.push({ path: result.path, error: result.error || '无法计算完整哈希' });
                return;
            }
            if (!groupsByFullHash.has(result.hash)) groupsByFullHash.set(result.hash, []);
            groupsByFullHash.get(result.hash).push(result.path);
        });

        return {
            groups: [...groupsByFullHash.entries()]
                .filter(([, paths]) => paths.length > 1)
                .map(([hash, paths]) => ({ hash, paths })),
            failures
        };
    }

    async function getImageRecord(directory, fileName, pathToHash) {
        const fullPath = path.join(directory, fileName);
        try {
            const stats = await fsp.stat(fullPath);
            return {
                name: fileName,
                path: fullPath,
                size: stats.size,
                modifiedTime: stats.mtime,
                mtimeMs: stats.mtimeMs,
                hash: getCachedHashForStats(pathToHash[fullPath], stats),
                tags: [],
                score: null
            };
        } catch (error) {
            logger.error('Failed to read image:', fullPath, error.message);
            return null;
        }
    }

    async function hydrateMetadata(records, onMetadata) {
        const updatedPathToHash = {};
        let updateBatch = [];

        function sendBatch() {
            if (updateBatch.length === 0) return;
            const batch = updateBatch;
            updateBatch = [];
            if (typeof onMetadata === 'function') onMetadata(batch);
        }

        try {
            await mapWithConcurrency(records, scanConcurrency, async (record) => {
                try {
                    const stats = { size: record.size, mtimeMs: record.mtimeMs };
                    const hash = await calculateHashForStats(record.path, stats);
                    updatedPathToHash[record.path] = createHashCacheEntry(hash, stats);
                    const metadata = store.getImageMetadata(hash);
                    updateBatch.push({
                        path: record.path,
                        hash,
                        tags: metadata.tags,
                        score: metadata.score
                    });
                    if (updateBatch.length >= metadataBatchSize) sendBatch();
                } catch (error) {
                    logger.error('Failed to hydrate image metadata:', record.path, error);
                }
            });
            sendBatch();
            if (Object.keys(updatedPathToHash).length > 0) {
                store.setPathHashes(updatedPathToHash);
            }
        } catch (error) {
            logger.error('Error hydrating directory metadata:', error);
        }
    }

    function getCachedHashForStats(value, stats) {
        const entry = normalizeHashEntry(value);
        if (!entry || entry.size !== stats.size || entry.mtimeMs !== stats.mtimeMs) return null;
        if (!/^[a-f0-9]{64}$/.test(entry.hash)) return null;
        return entry.hash;
    }

    async function calculateHashForStats(imagePath, stats) {
        const key = `${imagePath}\u0000${stats.size}\u0000${stats.mtimeMs}`;
        if (!pendingHashCalculations.has(key)) {
            pendingHashCalculations.set(
                key,
                (async () => {
                    const hash = await hashFile(imagePath);
                    if (typeof store.migrateImageMetadata === 'function') {
                        const legacyHash = await hashLegacyFile(imagePath);
                        store.migrateImageMetadata(legacyHash, hash);
                    }
                    return hash;
                })().finally(() => pendingHashCalculations.delete(key))
            );
        }
        return pendingHashCalculations.get(key);
    }

    async function ensureThumbnail(imagePath, cachePath, size) {
        if (await exists(cachePath)) return true;
        if (!pendingThumbnailGenerations.has(cachePath)) {
            pendingThumbnailGenerations.set(
                cachePath,
                generateThumbnail(imagePath, cachePath, size)
                    .finally(() => pendingThumbnailGenerations.delete(cachePath))
            );
        }
        await pendingThumbnailGenerations.get(cachePath);
        return false;
    }

    async function generateThumbnail(imagePath, cachePath, size) {
        await fsp.mkdir(thumbnailCacheDir, { recursive: true });
        const detectedFormat = await readFormat(imagePath);
        if (detectPreviewDecoder(imagePath, detectedFormat) === 'sips') {
            await resizeWithSips(imagePath, cachePath, size);
            return;
        }

        const image = await nativeImage.createThumbnailFromPath(imagePath, {
            width: size,
            height: size
        });
        if (!image || image.isEmpty()) throw new Error('无法生成缩略图');
        await fsp.writeFile(cachePath, image.toPNG());
    }

    async function exists(filePath) {
        try {
            await fsp.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    return Object.freeze({
        listEntries,
        readDirectory,
        getHash,
        getThumbnail,
        findDuplicates
    });
}

function normalizeHashEntry(value) {
    if (typeof value === 'string' && value) {
        return { hash: value, size: null, mtimeMs: null };
    }
    if (!value || typeof value !== 'object' || typeof value.hash !== 'string' || !value.hash) {
        return null;
    }
    return {
        hash: value.hash,
        size: Number.isFinite(value.size) ? value.size : null,
        mtimeMs: Number.isFinite(value.mtimeMs) ? value.mtimeMs : null
    };
}

function createHashCacheEntry(hash, stats) {
    return { hash, size: stats.size, mtimeMs: stats.mtimeMs };
}

function normalizeThumbnailSize(size) {
    const parsed = Number(size);
    if (!Number.isFinite(parsed)) return DEFAULT_THUMBNAIL_SIZE;
    return Math.min(Math.max(Math.round(parsed), 80), 512);
}

function isSupportedImageFile(filePath, path = pathModule, extensions = DEFAULT_IMAGE_EXTENSIONS) {
    return new Set(extensions.map(extension => extension.toLowerCase()))
        .has(path.extname(filePath).toLowerCase());
}

module.exports = {
    createImageLibrary,
    isSupportedImageFile
};
