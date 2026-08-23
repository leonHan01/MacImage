const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtemp, readdir, rm, writeFile } = fs.promises;
const { test } = require('node:test');

const registerFileOperationHandlers = require('../main-ipc-file-operations');
const { createFileOperationUtils } = require('../file-operation-utils');

const TEMP_ROOT = path.join('/private/tmp', 'macimage-file-ops-');

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}

function registerTestHandlers(trashFolder) {
    const handlers = {};
    const ipcMain = { handle: (name, handler) => { handlers[name] = handler; } };
    const utils = createFileOperationUtils({ fsp: fs.promises, path });
    const services = registerFileOperationHandlers({
        ipcMain,
        path,
        fsp: fs.promises,
        getStore: () => ({ get: key => key === 'trashFolder' ? trashFolder : null }),
        mapWithConcurrency,
        reserveAvailablePath: utils.reserveAvailablePath,
        getNumberedPath: utils.getNumberedPath,
        pathExists: async (filePath) => {
            try {
                await fs.promises.access(filePath);
                return true;
            } catch {
                return false;
            }
        },
        moveFileSafely: utils.moveFileSafely,
        moveHashMapping: () => {},
        moveHashMappings: () => {}
    });
    return { handlers, services };
}

test('migration reserves distinct targets for colliding names running concurrently', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    try {
        const sourceDirA = path.join(tempDir, 'source-a');
        const sourceDirB = path.join(tempDir, 'source-b');
        const targetDir = path.join(tempDir, 'target');
        await fs.promises.mkdir(sourceDirA);
        await fs.promises.mkdir(sourceDirB);
        await fs.promises.mkdir(targetDir);
        await writeFile(path.join(targetDir, 'photo.jpg'), 'existing');
        const photoPath = path.join(sourceDirA, 'photo.jpg');
        const numberedPhotoPath = path.join(sourceDirB, 'photo_1.jpg');
        await writeFile(photoPath, 'photo');
        await writeFile(numberedPhotoPath, 'photo-1');

        const handlers = {};
        const ipcMain = { handle: (name, handler) => { handlers[name] = handler; } };
        const utils = createFileOperationUtils({ fsp: fs.promises, path });
        registerFileOperationHandlers({
            ipcMain,
            path,
            fsp: fs.promises,
            getStore: () => ({ get: () => null }),
            mapWithConcurrency,
            reserveAvailablePath: utils.reserveAvailablePath,
            getNumberedPath: utils.getNumberedPath,
            pathExists: async (filePath) => {
                try {
                    await fs.promises.access(filePath);
                    return true;
                } catch {
                    return false;
                }
            },
            moveFileSafely: utils.moveFileSafely,
            moveHashMapping: () => {},
            moveHashMappings: () => {}
        });

        const result = await handlers['migrate-images']({}, [photoPath, numberedPhotoPath], targetDir);
        const targetFiles = await readdir(targetDir);

        assert.equal(result.success, true);
        assert.equal(result.movedCount, 2);
        assert.equal(result.skippedCount, 0);
        assert.equal(result.moved.length, 2);
        assert.equal(new Set(result.moved.map(item => item.targetPath)).size, 2);
        assert.equal(targetFiles.length, 3);
        assert.equal(targetFiles.includes('photo.jpg'), true);
        assert.equal((await readdir(sourceDirA)).length, 0);
        assert.equal((await readdir(sourceDirB)).length, 0);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('three-grid waterfall keeps five pending pages before committing the oldest cleanup', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    try {
        const sourceDir = path.join(tempDir, 'source');
        const trashDir = path.join(tempDir, 'trash');
        await fs.promises.mkdir(sourceDir);
        await fs.promises.mkdir(trashDir);
        const imagePaths = [];
        for (let index = 0; index < 6; index++) {
            const imagePath = path.join(sourceDir, `photo-${index}.jpg`);
            imagePaths.push(imagePath);
            await writeFile(imagePath, `photo-${index}`);
        }

        const { handlers } = registerTestHandlers(trashDir);
        const pendingBatchIds = [];
        for (let index = 0; index < 5; index++) {
            const result = await handlers['process-waterfall-page']({}, {
                ratedImages: [],
                unratedPaths: [imagePaths[index]],
                targetFolder: '',
                deferUnrated: true
            });
            pendingBatchIds.push(result.pendingBatchId);
            assert.equal(result.success, true);
            assert.equal(result.deleted.length, 0);
        }

        assert.equal((await readdir(sourceDir)).length, 6);
        assert.equal((await readdir(trashDir)).length, 0);

        const sixthResult = await handlers['process-waterfall-page']({}, {
            ratedImages: [],
            unratedPaths: [imagePaths[5]],
            targetFolder: '',
            deferUnrated: true
        });

        assert.equal(sixthResult.success, true);
        assert.equal(sixthResult.deleted.length, 1);
        assert.deepEqual(sixthResult.releasedBatchIds, [pendingBatchIds[0]]);
        assert.equal((await readdir(sourceDir)).length, 5);
        assert.equal((await readdir(trashDir)).length, 1);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('restoring a pending waterfall page keeps its files out of cleanup', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    try {
        const sourceDir = path.join(tempDir, 'source');
        const trashDir = path.join(tempDir, 'trash');
        await fs.promises.mkdir(sourceDir);
        await fs.promises.mkdir(trashDir);
        const imagePath = path.join(sourceDir, 'restore-me.jpg');
        await writeFile(imagePath, 'restore-me');

        const { handlers, services } = registerTestHandlers(trashDir);
        const stageResult = await handlers['process-waterfall-page']({}, {
            ratedImages: [],
            unratedPaths: [imagePath],
            targetFolder: '',
            deferUnrated: true
        });
        const restoreResult = await handlers['restore-waterfall-pending-page']({}, stageResult.pendingBatchId);
        const flushResult = await services.flushPendingWaterfallCleanup();

        assert.equal(restoreResult.success, true);
        assert.deepEqual(restoreResult.paths, [imagePath]);
        assert.equal(flushResult.deleted.length, 0);
        assert.equal((await readdir(sourceDir)).length, 1);
        assert.equal((await readdir(trashDir)).length, 0);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('flushing pending waterfall cleanup moves all remaining files to trash', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    try {
        const sourceDir = path.join(tempDir, 'source');
        const trashDir = path.join(tempDir, 'trash');
        await fs.promises.mkdir(sourceDir);
        await fs.promises.mkdir(trashDir);
        const imagePaths = [
            path.join(sourceDir, 'one.jpg'),
            path.join(sourceDir, 'two.jpg')
        ];
        await Promise.all(imagePaths.map((imagePath, index) => writeFile(imagePath, `image-${index}`)));

        const { handlers, services } = registerTestHandlers(trashDir);
        for (const imagePath of imagePaths) {
            await handlers['process-waterfall-page']({}, {
                ratedImages: [],
                unratedPaths: [imagePath],
                targetFolder: '',
                deferUnrated: true
            });
        }

        const flushResult = await services.flushPendingWaterfallCleanup();

        assert.equal(flushResult.deleted.length, 2);
        assert.equal(flushResult.failures.length, 0);
        assert.equal((await readdir(sourceDir)).length, 0);
        assert.equal((await readdir(trashDir)).length, 2);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
