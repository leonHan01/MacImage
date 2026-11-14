const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { create } = require('../waterfall-session');
const registerHandlers = require('../main-ipc-file-operations');
const { createImageFileOperations } = require('../image-file-operations');
const { createFileOperationUtils } = require('../file-operation-utils');
const { mapWithConcurrency } = require('../async-utils');

async function reviewFixture(t, pageSize) {
    const root = await fs.promises.mkdtemp('/private/tmp/macimage-retained-rounds-');
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    const trash = path.join(root, 'native-trash-fixture');
    await Promise.all([source, target, trash].map(dir => fs.promises.mkdir(dir)));
    const handlers = {};
    const trashCalls = [];
    const blocked = new Set();
    const services = registerHandlers({
        ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, path,
        store: { get: () => { throw new Error('Fixed trash folder must not be used'); } },
        imageFileOperations: createImageFileOperations({
            fsp: fs.promises, path, fileOperations: createFileOperationUtils(), mapWithConcurrency,
            trashItem: async file => {
                trashCalls.push(file);
                if (blocked.has(file)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
                await fs.promises.rename(file, path.join(trash, path.basename(file)));
            }
        })
    });
    const newSession = size => create({
        pageSize: size,
        processPage: page => handlers['process-waterfall-page']({}, page),
        restorePendingPage: id => handlers['restore-waterfall-pending-page']({}, id)
    });
    const makePage = async (round, size = pageSize) => {
        const images = Array.from({ length: size }, (_, index) => ({
            path: path.join(source, `round-${round}-${index}.jpg`), name: `round-${round}-${index}.jpg`, size: 5
        }));
        await Promise.all(images.map(image => fs.promises.writeFile(image.path, 'image')));
        return images;
    };
    return { source, target, trash, handlers, services, trashCalls, blocked, makePage, newSession, session: newSession(pageSize) };
}

for (const pageSize of [2, 3, 10]) {
    test(`${pageSize}-card review restores five complete rounds including rated images`, async t => {
        const review = await reviewFixture(t, pageSize);
        const pages = [];
        const ratings = new Map();
        for (let round = 0; round < 7; round++) {
            const images = await review.makePage(round);
            pages.push(images);
            images.forEach((image, index) => {
                if (round === 3 || index % 2 === 0) {
                    ratings.set(image.path, 2);
                    review.session.score(image.path, 2);
                }
            });
            await review.session.advance(images, { currentFolder: review.source, targetFolder: review.target });
            if (round < 5) {
                assert.deepEqual(review.trashCalls, []);
                assert.deepEqual(await fs.promises.readdir(review.target), []);
                assert.equal(images.every(image => fs.existsSync(image.path)), true);
            }
        }
        assert.equal(review.session.snapshot().restorablePageCount, 5);
        assert.equal(review.session.snapshot().processedCount, pageSize * 7);
        assert.equal((await review.handlers['get-waterfall-pending-pages']()).length, 5);
        const trashCount = review.trashCalls.length;
        let visible = [];
        for (let round = 6; round >= 2; round--) {
            const result = await review.session.restore(visible);
            assert.equal(result.success, true);
            assert.deepEqual(result.restoredImages.map(image => image.path), pages[round].map(image => image.path));
            visible = [...result.restoredImages, ...visible];
            const view = review.session.snapshot(visible);
            assert.deepEqual(view.pageImages.map(image => image.path), pages[round].map(image => image.path));
            for (const image of view.pageImages) {
                assert.equal(fs.existsSync(image.path), true);
                assert.equal(view.scores.get(image.path), ratings.get(image.path));
            }
        }
        assert.equal(review.session.snapshot().restorablePageCount, 0);
        assert.equal(review.session.snapshot().processedCount, pageSize * 2);
        assert.equal((await review.session.restore(visible)).success, false);
        assert.deepEqual(await review.handlers['get-waterfall-pending-pages'](), []);
        await review.services.flushPendingWaterfallCleanup();
        assert.equal(review.trashCalls.length, trashCount);
        assert.equal(visible.every(image => fs.existsSync(image.path)), true);
    });
}

test('reloading restores retained ratings and each round uses its original layout', async t => {
    const review = await reviewFixture(t, 2);
    const first = await review.makePage(0, 2);
    const second = await review.makePage(1, 3);
    review.session.score(first[1].path, 3);
    await review.session.advance(first, { targetFolder: review.target });
    review.session.setPageSize(3);
    second.forEach(image => review.session.score(image.path, 1));
    await review.session.advance(second, { targetFolder: review.target });
    const reopened = review.newSession(10);
    reopened.reset({ images: [...first, ...second], pendingPages: await review.handlers['get-waterfall-pending-pages']() });
    assert.equal(reopened.snapshot().restorablePageCount, 2);
    await reopened.restore([]);
    assert.equal(reopened.snapshot(second).pageSize, 3);
    assert.equal(reopened.snapshot(second).scores.get(second[1].path), 1);
    await reopened.restore(second);
    assert.equal(reopened.snapshot([...first, ...second]).pageSize, 2);
    assert.deepEqual(reopened.snapshot([...first, ...second]).pageImages.map(image => image.path), first.map(image => image.path));
    assert.equal(reopened.snapshot(first).scores.get(first[1].path), 3);
    assert.deepEqual(review.trashCalls, []);
});

test('returning and changing ratings replaces the retained round before committing each file once', async t => {
    const review = await reviewFixture(t, 2);
    const images = await review.makePage(0);
    review.session.score(images[0].path, 1);
    await review.session.advance(images, { targetFolder: review.target });
    await review.session.restore([]);
    review.session.score(images[0].path, 1);
    review.session.score(images[1].path, 3);
    await review.session.advance(images, { targetFolder: review.target });
    const retained = await review.handlers['get-waterfall-pending-pages']();
    assert.equal(retained.length, 1);
    assert.deepEqual(retained[0].ratedImages, [{ path: images[1].path, score: 3 }]);
    const committed = await review.services.flushPendingWaterfallCleanup();
    assert.equal(committed.moved.length, 1);
    assert.equal(committed.moved[0].originalPath, images[1].path);
    assert.equal(committed.moved[0].score, 3);
    assert.deepEqual(review.trashCalls, [images[0].path]);
    assert.deepEqual(await fs.promises.readdir(review.source), []);
});

test('failed older cleanup keeps its remaining image and all five latest rounds recoverable', async t => {
    const review = await reviewFixture(t, 2);
    const oldest = await review.makePage(0);
    review.blocked.add(oldest[1].path);
    await review.session.advance(oldest);
    for (let round = 1; round <= 5; round++) await review.session.advance(await review.makePage(round));
    const saved = await review.handlers['get-waterfall-pending-pages']();
    assert.equal(saved.length, 6);
    assert.deepEqual(saved[0].paths, [oldest[1].path]);
    assert.equal(review.session.snapshot().pendingImages.length, 11);
    assert.equal(review.session.snapshot().failureDetails[0].code, 'EACCES');
    let visible = [];
    for (let index = 0; index < 5; index++) {
        const result = await review.session.restore(visible);
        assert.equal(result.restoredImages.length, 2);
        visible = [...result.restoredImages, ...visible];
    }
    const blockedPage = await review.session.restore(visible);
    assert.deepEqual(blockedPage.restoredImages.map(image => image.path), [oldest[1].path]);
    assert.equal(fs.existsSync(oldest[1].path), true);
    assert.equal(fs.existsSync(oldest[0].path), false);
});

test('quit waits for the active retained round and commits its rated and unrated files once', async t => {
    let releaseMove;
    const gate = new Promise(resolve => { releaseMove = resolve; });
    t.after(() => releaseMove());
    const handlers = {};
    const trashCalls = [];
    const services = registerHandlers({
        ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, path,
        imageFileOperations: {
            moveMany: async paths => {
                await gate;
                return { moved: paths.map(originalPath => ({ originalPath, targetPath: '/target/rated.jpg' })), failures: [] };
            },
            trashSystemMany: async paths => {
                trashCalls.push(...paths);
                return { deleted: paths.map(originalPath => ({ originalPath, systemTrash: true })), failures: [] };
            }
        }
    });
    const processing = handlers['process-waterfall-page']({}, {
        ratedImages: [{ path: '/photos/rated.jpg', score: 1 }], unratedPaths: ['/photos/unrated.jpg'],
        targetFolder: '/target', retainPage: true, pageSize: 2
    });
    let quitReady = false;
    const quitting = services.flushPendingWaterfallCleanup().then(result => { quitReady = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quitReady, false);
    assert.deepEqual(trashCalls, []);
    releaseMove();
    assert.equal((await processing).pending.length, 2);
    const committed = await quitting;
    assert.equal(committed.moved.length, 1);
    assert.equal(committed.deleted.length, 1);
    assert.deepEqual(trashCalls, ['/photos/unrated.jpg']);
    assert.deepEqual(await handlers['get-waterfall-pending-pages'](), []);
});
