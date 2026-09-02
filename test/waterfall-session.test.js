const assert = require('node:assert/strict');
const { test } = require('node:test');

const { create } = require('../waterfall-session');

test('owns scoring and page-size state behind one interface', () => {
    const session = create({ pageSize: 3, allowedPageSizes: [3, 10] });

    assert.equal(session.score('/photos/a.jpg', 2), true);
    assert.equal(session.snapshot().scores.get('/photos/a.jpg'), 2);
    assert.equal(session.score('/photos/a.jpg', 2), true);
    assert.equal(session.snapshot().scores.has('/photos/a.jpg'), false);
    assert.equal(session.setPageSize(10), true);
    assert.equal(session.snapshot().pageSize, 10);
});

test('advances a page and reconciles pending cleanup, history, and statistics', async () => {
    let payload;
    const images = [
        { path: '/photos/rated.jpg', name: 'rated.jpg', size: 12, hash: 'rated-hash' },
        { path: '/photos/pending.jpg', name: 'pending.jpg', size: 8, hash: 'pending-hash' }
    ];
    const session = create({
        pageSize: 3,
        processPage: async (nextPayload) => {
            payload = nextPayload;
            return {
                success: true,
                moved: [{ originalPath: images[0].path, targetPath: '/target/rated.jpg' }],
                deleted: [],
                pending: [{ originalPath: images[1].path }],
                pendingBatchId: 'pending-1',
                releasedBatchIds: [],
                failures: []
            };
        }
    });
    session.score(images[0].path, 3);

    const outcome = await session.advance(images, {
        targetFolder: '/target',
        currentFolder: '/photos',
        trashFolder: '/trash'
    });
    const view = session.snapshot([]);

    assert.deepEqual(payload, {
        ratedImages: [{ path: images[0].path, score: 3 }],
        unratedPaths: [images[1].path],
        targetFolder: '/target',
        deferUnrated: true
    });
    assert.deepEqual(outcome.processedPaths.sort(), images.map(image => image.path).sort());
    assert.deepEqual(outcome.operations, [{
        kind: 'move',
        originalPath: images[0].path,
        targetPath: '/target/rated.jpg'
    }]);
    assert.equal(view.pendingImages.length, 1);
    assert.equal(view.movedCount, 1);
    assert.equal(view.movedSize, 12);
    assert.equal(view.processedCount, 2);
});

test('restores the latest pending page through the injected adapter', async () => {
    const image = { path: '/photos/pending.jpg', name: 'pending.jpg', size: 8 };
    let restoredPageId;
    const session = create({
        processPage: async () => ({
            success: true,
            moved: [],
            deleted: [],
            pending: [{ originalPath: image.path }],
            pendingBatchId: 'pending-1',
            releasedBatchIds: [],
            failures: []
        }),
        restorePendingPage: async (pageId) => {
            restoredPageId = pageId;
            return { success: true, paths: [image.path] };
        }
    });
    await session.advance([image], { trashFolder: '/trash' });

    const result = await session.restore([]);

    assert.equal(restoredPageId, 'pending-1');
    assert.deepEqual(result.restoredImages, [image]);
    assert.deepEqual(session.snapshot([image]).pageImages, [image]);
    assert.equal(session.snapshot().processedCount, 0);
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
