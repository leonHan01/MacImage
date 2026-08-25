const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const IMAGE_CACHE_VERSION = 2;
const FORMAT_EXTENSIONS = {
    jpeg: new Set(['.jpg', '.jpeg']),
    png: new Set(['.png']),
    gif: new Set(['.gif']),
    bmp: new Set(['.bmp']),
    webp: new Set(['.webp']),
    tiff: new Set(['.tif', '.tiff']),
    heif: new Set(['.heic', '.heif'])
};

function detectImageFormat(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    if (hasBytes(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (hasBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (startsWithAscii(buffer, 'GIF87a') || startsWithAscii(buffer, 'GIF89a')) return 'gif';
    if (startsWithAscii(buffer, 'BM')) return 'bmp';
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) return 'webp';
    if (
        hasBytes(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
        hasBytes(buffer, [0x4d, 0x4d, 0x00, 0x2a])
    ) return 'tiff';
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = buffer.subarray(8, 12).toString('ascii');
        if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heif';
    }
    return null;
}

function getPreviewDecoder(filePath, detectedFormat) {
    const allowedExtensions = FORMAT_EXTENSIONS[detectedFormat];
    if (!allowedExtensions) return 'native';
    const extension = path.extname(String(filePath || '')).toLowerCase();
    return allowedExtensions.has(extension) ? 'native' : 'sips';
}

function getImageCacheFileName(hash, size, kind) {
    const cacheKind = kind === 'thumbnail' ? 'thumbnail' : 'preview';
    return `${hash}-${cacheKind}-v${IMAGE_CACHE_VERSION}-${size}.png`;
}

async function readImageFormat(filePath) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(32);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return detectImageFormat(buffer.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
}

async function createResizedImageWithSips(imagePath, outputPath, size) {
    const temporaryPath = `${outputPath}.${process.pid}-${crypto.randomUUID()}.tmp.png`;
    try {
        await execFileAsync('/usr/bin/sips', [
            '-s', 'format', 'png',
            '-Z', String(size),
            imagePath,
            '--out', temporaryPath
        ]);
        await fs.promises.rename(temporaryPath, outputPath);
    } finally {
        await fs.promises.unlink(temporaryPath).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
}

function hasBytes(buffer, bytes) {
    if (buffer.length < bytes.length) return false;
    return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer, value) {
    return buffer.length >= value.length && buffer.subarray(0, value.length).toString('ascii') === value;
}

module.exports = {
    createResizedImageWithSips,
    detectImageFormat,
    getImageCacheFileName,
    getPreviewDecoder,
    readImageFormat
};
