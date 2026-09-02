const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtemp, mkdir, readFile, writeFile, access, rm } = fs.promises;
const { test } = require('node:test');

const { createFileOperationUtils } = require('../file-operation-utils');

const TEMP_ROOT = path.join('/private/tmp', 'macimage-file-ops-');

async function pathExists(filePath) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

test('reserves different numbered destinations when candidate names race', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    try {
        await writeFile(path.join(tempDir, 'photo.jpg'), 'existing');
        const { reserveAvailablePath } = createFileOperationUtils({ fsp: fs.promises, path });

        const [firstPath, secondPath] = await Promise.all([
            reserveAvailablePath(
                path.join(tempDir, 'photo.jpg'),
                (counter) => path.join(tempDir, `photo_${counter}.jpg`)
            ),
            reserveAvailablePath(
                path.join(tempDir, 'photo_1.jpg'),
                (counter) => path.join(tempDir, `photo_1_${counter}.jpg`)
            )
        ]);

        assert.notEqual(firstPath, secondPath);
        assert.equal(await pathExists(firstPath), true);
        assert.equal(await pathExists(secondPath), true);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('falls back from EXDEV without losing or overwriting the source', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    try {
        const sourcePath = path.join(tempDir, 'source.jpg');
        const targetPath = path.join(tempDir, 'target.jpg');
        await writeFile(sourcePath, 'image-data');

        const realRename = fs.promises.rename.bind(fs.promises);
        let shouldRaiseExdev = true;
        const { reserveAvailablePath, moveFileSafely } = createFileOperationUtils({
            fsp: fs.promises,
            path,
            rename: async (...args) => {
                if (shouldRaiseExdev) {
                    shouldRaiseExdev = false;
                    const error = new Error('cross-device link not permitted');
                    error.code = 'EXDEV';
                    throw error;
                }
                return realRename(...args);
            }
        });

        const reservedTargetPath = await reserveAvailablePath(targetPath, (counter) => (
            path.join(tempDir, `target_${counter}.jpg`)
        ));
        await moveFileSafely(sourcePath, reservedTargetPath);

        assert.equal(await readFile(reservedTargetPath, 'utf8'), 'image-data');
        assert.equal(await pathExists(sourcePath), false);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('finds the next available path without reserving a file', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    try {
        await writeFile(path.join(tempDir, 'photo.jpg'), 'existing');
        await writeFile(path.join(tempDir, 'photo_1.jpg'), 'existing');
        const { getAvailablePath } = createFileOperationUtils({ fsp: fs.promises, path });

        const availablePath = await getAvailablePath(
            path.join(tempDir, 'photo.jpg'),
            counter => path.join(tempDir, `photo_${counter}.jpg`)
        );

        assert.equal(availablePath, path.join(tempDir, 'photo_2.jpg'));
        assert.equal(await pathExists(availablePath), false);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
