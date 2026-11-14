const assert = require('node:assert/strict');
const { test } = require('node:test');

const { create } = require('../waterfall-session');

test('owns scoring and page-size state behind one interface', () => {
    const session = create({ pageSize: 3, allowedPageSizes: [2, 3, 10] });

    assert.equal(session.score('/photos/a.jpg', 2), true);
    assert.equal(session.snapshot().scores.get('/photos/a.jpg'), 2);
    assert.equal(session.score('/photos/a.jpg', 2), true);
    assert.equal(session.snapshot().scores.has('/photos/a.jpg'), false);
    assert.equal(session.setPageSize(10), true);
    assert.equal(session.snapshot().pageSize, 10);
    assert.equal(session.setPageSize(2), true);
    assert.equal(session.snapshot([
        { path: '/photos/a.jpg' },
        { path: '/photos/b.jpg' },
        { path: '/photos/c.jpg' }
    ]).pageImages.length, 2);
});

test('reconciles completed file operations with history and statistics', async () => {
    let payload;
    const images = [
        { path: '/photos/rated.jpg', name: 'rated.jpg', size: 12, hash: 'rated-hash' },
        { path: '/photos/unrated.jpg', name: 'unrated.jpg', size: 8, hash: 'unrated-hash' }
    ];
    const session = create({
        pageSize: 3,
        processPage: async nextPayload => {
            payload = nextPayload;
            return {
                success: true,
                moved: [{ originalPath: images[0].path, targetPath: '/target/rated.jpg' }],
                deleted: [{ originalPath: images[1].path, fileName: 'unrated.jpg', systemTrash: true }],
                failures: []
            };
        }
    });
    session.score(images[0].path, 3);
    const outcome = await session.advance(images, { targetFolder: '/target', currentFolder: '/photos' });
    const view = session.snapshot([]);

    assert.deepEqual(payload, {
        ratedImages: [{ path: images[0].path, score: 3 }],
        unratedPaths: [images[1].path],
        targetFolder: '/target',
        retainPage: true,
        imagePaths: images.map(image => image.path),
        pageSize: 3
    });
    assert.deepEqual(outcome.processedPaths.sort(), images.map(image => image.path).sort());
    assert.deepEqual(outcome.operations.map(item => item.kind), ['move', 'system-trash']);
    assert.equal(outcome.operations[1].trashPath, undefined);
    assert.equal(view.movedCount, 1);
    assert.equal(view.movedSize, 12);
    assert.equal(view.deletedCount, 1);
    assert.equal(view.deletedSize, 8);
    assert.equal(view.processedCount, 2);
    assert.equal(view.batchNumber, 2);
});

test('native trash failure stays unprocessed and shows the underlying error', async () => {
    const images = [{ path: '/photos/ok.jpg', size: 5 }, { path: '/photos/blocked.jpg', size: 8 }];
    const session = create({ processPage: async () => ({
        success: true,
        deleted: [{ originalPath: images[0].path, systemTrash: true }],
        failures: [{ path: images[1].path, error: 'EACCES: permission denied' }]
    }) });
    const outcome = await session.advance(images);
    assert.deepEqual(outcome.processedPaths, [images[0].path]);
    assert.equal(outcome.failureCount, 1);
    const view = session.snapshot(images.filter(image => !outcome.processedPaths.includes(image.path)));
    assert.deepEqual(view.pageImages, [images[1]]);
    assert.equal(view.deletedCount, 1);
    assert.equal(view.deletedSize, 5);
    assert.match(view.failureDetails[0].error, /EACCES/);
    session.reset();
    assert.equal(session.snapshot().deletedCount, 0);
    assert.equal(session.snapshot().processedCount, 0);
    assert.equal(session.snapshot().failureDetails.length, 0);
});

test('retains every failure detail and reconciles successes even when the batch reports failure', async () => {
    const images = [{ path: '/photos/moved.jpg' }, { path: '/photos/blocked.jpg' }, { path: '/photos/missing.jpg' }];
    const failures = [
        { path: images[1].path, action: 'delete', code: 'EPERM', error: 'operation not permitted' },
        { path: images[2].path, action: 'move', targetPath: '/target/missing.jpg', code: 'ENOENT', syscall: 'access', error: 'no such file' }
    ];
    const session = create({ pageSize: 3, processPage: async () => ({
        success: false,
        moved: [{ originalPath: images[0].path, targetPath: '/target/moved.jpg' }],
        failures
    }) });
    const result = await session.advance(images);
    assert.equal(result.success, false);
    assert.deepEqual(result.processedPaths, [images[0].path]);
    assert.equal(session.snapshot().movedCount, 1);
    assert.deepEqual(session.snapshot().failureDetails, failures);
    session.snapshot().failureDetails[0].error = 'changed';
    assert.equal(session.snapshot().failureDetails[0].error, 'operation not permitted');
    session.clearStatus();
    assert.equal(session.snapshot().failureDetails.length, 0);
});

test('exposes IPC exceptions with directory context and clears details on a successful retry', async () => {
    let shouldFail = true;
    const image = { path: '/photos/a.jpg' };
    const session = create({ processPage: async () => {
        if (shouldFail) throw Object.assign(new Error('IPC unavailable'), { code: 'ERR_IPC' });
        return { success: true, deleted: [{ originalPath: image.path }] };
    } });
    await session.advance([image], { currentFolder: '/photos' });
    assert.equal(session.snapshot().failureDetails[0].path, '/photos');
    assert.equal(session.snapshot().failureDetails[0].code, 'ERR_IPC');
    assert.equal(session.snapshot().failureDetails[0].action, 'process');
    shouldFail = false;
    await session.advance([image]);
    assert.equal(session.snapshot().failureDetails.length, 0);
    assert.equal(session.snapshot().status, '');
});

test('reports missing configuration without crossing the process port', async () => {
    let processCount = 0;
    const image = { path: '/photos/rated.jpg' };
    const session = create({ processPage: async () => { processCount++; } });
    session.score(image.path, 1);

    const result = await session.advance([image], {
        currentFolder: '/photos',
        targetFolder: '',
        trashFolder: '/trash'
    });

    assert.equal(result.success, false);
    assert.equal(processCount, 0);
    assert.match(session.snapshot().status, /目标文件夹/);
});
