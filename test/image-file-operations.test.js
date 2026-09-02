const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { mapWithConcurrency } = require('../async-utils');
const { createFileOperationUtils } = require('../file-operation-utils');
const { createImageFileOperations } = require('../image-file-operations');

const TEMP_ROOT = path.join('/private/tmp', 'macimage-image-file-ops-');

function createOperations(hashMoves, listImageEntries = async () => []) {
    return createImageFileOperations({
        fsp: fs.promises,
        path,
        fileOperations: createFileOperationUtils({ fsp: fs.promises, path }),
        mapWithConcurrency,
        moveHashMappings: moves => hashMoves.push(...moves),
        listImageEntries,
        now: () => 1234
    });
}

test('moves colliding file names through one interface and updates hash paths', async () => {
    const tempDir = await fs.promises.mkdtemp(TEMP_ROOT);
    try {
        const sourceA = path.join(tempDir, 'source-a');
        const sourceB = path.join(tempDir, 'source-b');
        const target = path.join(tempDir, 'target');
        await Promise.all([sourceA, sourceB, target].map(directory => fs.promises.mkdir(directory)));
        const paths = [path.join(sourceA, 'photo.jpg'), path.join(sourceB, 'photo.jpg')];
        await Promise.all(paths.map((filePath, index) => fs.promises.writeFile(filePath, `photo-${index}`)));
        const hashMoves = [];

        const result = await createOperations(hashMoves).moveMany(paths, target);

        assert.equal(result.moved.length, 2);
        assert.equal(result.failures.length, 0);
        assert.equal(new Set(result.moved.map(item => item.targetPath)).size, 2);
        assert.deepEqual(hashMoves.map(move => move.fromPath).sort(), [...paths].sort());
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});

test('moves files to trash and restores them through the same module', async () => {
    const tempDir = await fs.promises.mkdtemp(TEMP_ROOT);
    try {
        const sourceDir = path.join(tempDir, 'source');
        const trashDir = path.join(tempDir, 'trash');
        await Promise.all([sourceDir, trashDir].map(directory => fs.promises.mkdir(directory)));
        const originalPath = path.join(sourceDir, 'photo.jpg');
        await fs.promises.writeFile(originalPath, 'photo');
        const hashMoves = [];
        const operations = createOperations(hashMoves);

        const trashResult = await operations.trashMany([originalPath], trashDir);
        const restoreResult = await operations.restore({
            sourcePath: trashResult.deleted[0].trashPath,
            originalPath
        });

        assert.equal(trashResult.failures.length, 0);
        assert.equal(restoreResult.success, true);
        assert.equal(restoreResult.restoredPath, originalPath);
        assert.equal(await operations.moveOne(originalPath, sourceDir).then(result => result.moved), false);
        assert.equal(hashMoves.length, 2);
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});

test('keeps the original file name for a single interactive delete', async () => {
    const tempDir = await fs.promises.mkdtemp(TEMP_ROOT);
    try {
        const sourceDir = path.join(tempDir, 'source');
        const trashDir = path.join(tempDir, 'trash');
        await Promise.all([sourceDir, trashDir].map(directory => fs.promises.mkdir(directory)));
        const originalPath = path.join(sourceDir, 'photo.jpg');
        await fs.promises.writeFile(originalPath, 'photo');

        const result = await createOperations([]).trashOne(originalPath, trashDir);

        assert.equal(result.success, true);
        assert.equal(path.basename(result.trashPath), 'photo.jpg');
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});

test('inspects and empties only image entries supplied by the library', async () => {
    const tempDir = await fs.promises.mkdtemp(TEMP_ROOT);
    try {
        const trashDir = path.join(tempDir, 'trash');
        await fs.promises.mkdir(trashDir);
        await fs.promises.writeFile(path.join(trashDir, 'photo.jpg'), '12345');
        await fs.promises.writeFile(path.join(trashDir, 'notes.txt'), 'keep');
        const operations = createOperations([], async () => [{ name: 'photo.jpg' }]);

        assert.deepEqual(await operations.inspectTrash(trashDir), {
            count: 1,
            size: 5,
            path: trashDir
        });
        assert.deepEqual(await operations.emptyTrash(trashDir), {
            success: true,
            deletedCount: 1
        });
        assert.equal(await fs.promises.readFile(path.join(trashDir, 'notes.txt'), 'utf8'), 'keep');
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});
