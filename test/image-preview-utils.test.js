const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
    createResizedImageWithSips,
    detectImageFormat,
    getPreviewDecoder,
    getImageCacheFileName
} = require('../image-preview-utils');

const { mkdtemp, readFile, rm, writeFile } = fs.promises;
const TEMP_ROOT = '/private/tmp/macimage-preview-utils-';

test('detects WebP content even when the file is named as JPEG', () => {
    const webpHeader = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
    ]);

    assert.equal(detectImageFormat(webpHeader), 'webp');
    assert.equal(getPreviewDecoder('/photos/misnamed.jpg', 'webp'), 'sips');
    assert.equal(getPreviewDecoder('/photos/correct.webp', 'webp'), 'native');
});

test('recognizes common image signatures used by the app', () => {
    assert.equal(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
    assert.equal(detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
    assert.equal(detectImageFormat(Buffer.from('GIF89a')), 'gif');
    assert.equal(detectImageFormat(Buffer.from([0x42, 0x4d, 0x00, 0x00])), 'bmp');
});

test('uses a versioned thumbnail cache name so stale entries are ignored', () => {
    assert.equal(
        getImageCacheFileName('abc123', 220),
        'abc123-thumbnail-v2-220.png'
    );
});

test('sips converts valid WebP content whose file name ends in jpg', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    const sourcePath = path.join(tempDir, 'misnamed.jpg');
    const outputPath = path.join(tempDir, 'preview.png');
    const onePixelWebp = Buffer.from(
        'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==',
        'base64'
    );
    try {
        await writeFile(sourcePath, onePixelWebp);
        await createResizedImageWithSips(sourcePath, outputPath, 220);

        const output = await readFile(outputPath);
        assert.equal(detectImageFormat(output), 'png');
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
