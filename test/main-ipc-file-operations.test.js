const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtemp, readdir, rm, writeFile } = fs.promises;
const { test } = require('node:test');

const registerFileOperationHandlers = require('../main-ipc-file-operations');
const { createFileOperationUtils } = require('../file-operation-utils');
const { createImageFileOperations } = require('../image-file-operations');

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

function registerTestHandlers(overrides = {}) {
    const handlers = {};
    const ipcMain = { handle: (name, handler) => { handlers[name] = handler; } };
    const imageFileOperations = createTestImageFileOperations(overrides);
    const services = registerFileOperationHandlers({
        ipcMain,
        path,
        store: { get: () => { throw new Error('Waterfall must not read a fixed trash folder'); } },
        imageFileOperations
    });
    return { handlers, services };
}

function createTestImageFileOperations(overrides = {}) {
    const utils = createFileOperationUtils({ fsp: fs.promises, path });
    return createImageFileOperations({
        fsp: fs.promises,
        path,
        fileOperations: {
            ...utils,
            moveFileSafely: overrides.moveFileSafely || utils.moveFileSafely
        },
        mapWithConcurrency,
        trashItem: overrides.trashItem,
        moveHashMappings: () => {},
        listImageEntries: async () => []
    });
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
        registerFileOperationHandlers({
            ipcMain,
            path,
            store: { get: () => null },
            imageFileOperations: createTestImageFileOperations()
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

test('waterfall immediately uses system trash without reading a configured folder', async (t) => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const sourceDir = path.join(tempDir, 'source');
    const targetDir = path.join(tempDir, 'target');
    const nativeTrashDir = path.join(tempDir, 'native-trash-fixture');
    await Promise.all([sourceDir, nativeTrashDir].map(dir => fs.promises.mkdir(dir)));
    const ratedPath = path.join(sourceDir, 'rated.jpg');
    const unratedPath = path.join(sourceDir, 'unrated.jpg');
    await Promise.all([ratedPath, unratedPath].map(file => writeFile(file, 'image')));
    const trashedPaths = [];
    const { handlers, services } = registerTestHandlers({
        trashItem: async file => {
            trashedPaths.push(file);
            await fs.promises.rename(file, path.join(nativeTrashDir, path.basename(file)));
        }
    });

    const result = await handlers['process-waterfall-page']({}, {
        ratedImages: [{ path: ratedPath, score: 2 }],
        unratedPaths: [ratedPath, unratedPath, unratedPath],
        targetFolder: targetDir,
        deferUnrated: true
    });

    assert.equal(result.success, true);
    assert.equal(result.moved[0].score, 2);
    assert.deepEqual(trashedPaths, [unratedPath]);
    assert.equal(result.deleted[0].systemTrash, true);
    assert.equal(result.deleted[0].trashPath, undefined);
    assert.equal(result.pending, undefined);
    assert.equal(result.failures.length, 0);
    assert.deepEqual(await readdir(sourceDir), []);
    assert.deepEqual(await readdir(targetDir), ['rated.jpg']);
    assert.deepEqual(await readdir(nativeTrashDir), ['unrated.jpg']);
    assert.deepEqual(await handlers['get-waterfall-pending-pages'](), []);
    await services.waitForWaterfallOperations();
    assert.deepEqual(trashedPaths, [unratedPath]);
});

test('failed native trash keeps the source file and returns its exact error without a folder fallback', async (t) => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const imagePath = path.join(tempDir, 'blocked.jpg');
    await writeFile(imagePath, 'keep');
    const { handlers } = registerTestHandlers({
        trashItem: async () => {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', syscall: 'trash' });
        }
    });

    const result = await handlers['process-waterfall-page']({}, { unratedPaths: [imagePath] });

    assert.equal(result.success, true);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.failures[0].path, imagePath);
    assert.match(result.failures[0].error, /EACCES/);
    assert.equal(result.failures[0].code, 'EACCES');
    assert.equal(result.failures[0].syscall, 'trash');
    assert.equal(await fs.promises.readFile(imagePath, 'utf8'), 'keep');
    assert.deepEqual(await readdir(tempDir), ['blocked.jpg']);
});

test('missing rated files retain their system error code and source and destination paths', async (t) => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const sourcePath = path.join(tempDir, 'missing.jpg');
    const targetFolder = path.join(tempDir, 'target');
    const { handlers } = registerTestHandlers();
    const result = await handlers['process-waterfall-page']({}, {
        ratedImages: [{ path: sourcePath, score: 1 }], targetFolder
    });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].code, 'ENOENT');
    assert.equal(result.failures[0].path, sourcePath);
    assert.equal(result.failures[0].targetPath, path.join(targetFolder, 'missing.jpg'));
    assert.equal(result.failures[0].syscall, 'access');
});

test('folder creation errors include each affected file and the target folder', async (t) => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    t.mock.method(console, 'error', () => {});
    const blockedParent = path.join(tempDir, 'file-instead-of-directory');
    await writeFile(blockedParent, 'file');
    const targetFolder = path.join(blockedParent, 'target');
    const { handlers } = registerTestHandlers();
    const result = await handlers['process-waterfall-page']({}, {
        ratedImages: [{ path: '/photos/a.jpg', score: 1 }, { path: '/photos/b.jpg', score: 2 }],
        targetFolder
    });
    assert.equal(result.success, false);
    assert.deepEqual(result.failures.map(item => item.path), ['/photos/a.jpg', '/photos/b.jpg']);
    assert.equal(result.failures[0].targetPath, targetFolder);
    assert.equal(result.failures[0].code, 'ENOTDIR');
    assert.equal(result.failures[0].syscall, 'mkdir');
});

test('quit waits for the active native trash operation and rejects new pages', async () => {
    let finishTrash;
    const gate = new Promise(resolve => { finishTrash = resolve; });
    const calls = [];
    const { handlers, services } = registerTestHandlers({
        trashItem: async file => { calls.push(file); await gate; }
    });
    const processing = handlers['process-waterfall-page']({}, { unratedPaths: ['/photos/current.jpg'] });
    let quitReady = false;
    const quitting = services.waitForWaterfallOperations().then(() => { quitReady = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quitReady, false);
    assert.deepEqual(calls, ['/photos/current.jpg']);
    const rejected = await handlers['process-waterfall-page']({}, { unratedPaths: ['/photos/later.jpg'] });
    assert.equal(rejected.success, false);
    finishTrash();
    const result = await processing;
    await quitting;
    assert.equal(quitReady, true);
    assert.equal(result.deleted.length, 1);
    assert.deepEqual(calls, ['/photos/current.jpg']);
});
