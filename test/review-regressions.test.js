const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const Store = require('../store');
const { createImageLibrary } = require('../image-library');
const { createFileOperationUtils } = require('../file-operation-utils');
const { createImageFileOperations } = require('../image-file-operations');
const { mapWithConcurrency } = require('../async-utils');
const registerServerHandlers = require('../main-ipc-server-images');
const registerFileHandlers = require('../main-ipc-file-operations');
const collectionModule = require('../image-collection');
const sessionModule = require('../waterfall-session');
const noop = () => {};

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macimage-regression-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function loadScript(context, file) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
}

function folderRenderer(api, session = sessionModule.create()) {
    const collection = collectionModule.create();
    const context = vm.createContext({
        console, setTimeout, clearTimeout, Map, Set,
        imageCollection: collection, images: collection.items, sortedImages: [],
        currentFolder: '', currentFolderEl: {}, deleteHistory: [],
        window: { electronAPI: { onDirectoryImageMetadata: noop, ...api } },
        closeModal: noop, renderEmptyImageGrid: noop,
        waitForWaterfallOperations: async () => {},
        resetWaterfallReviewSession: (images, pages) => session.reset({ images, pendingPages: pages })
    });
    loadScript(context, 'renderer-folders.js');
    for (const name of ['resetRandomSortOrder', 'updateOpenCurrentFolderButton', 'refreshAfterImageMembershipChange', 'updateImageCount']) {
        context[name] = noop;
    }
    return context;
}

test('server downloads keep both colliding files and delete each remote record individually', async (t) => {
    const directory = temporaryDirectory(t);
    const handlers = {};
    const secondImageReady = deferred();
    const firstDeleteStarted = deferred();
    let secondImageDownloaded = false;
    const remoteDeleteIds = [];
    const pictures = [1, 2].map(id => ({ id, fileName: 'same.jpg', imageUrl: `https://example.test/${id}` }));
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (options?.method === 'DELETE') {
            const pictureIds = JSON.parse(options.body).pictureIds;
            remoteDeleteIds.push(pictureIds);
            if (pictureIds[0] === 1) firstDeleteStarted.resolve();
            return { ok: true };
        }
        if (String(url).includes('/api/leon/pictures')) return { ok: true, json: async () => pictures };
        return { ok: true, arrayBuffer: async () => {
            if (String(url).endsWith('/1')) return Buffer.from('first-image');
            await secondImageReady.promise;
            secondImageDownloaded = true;
            return Buffer.from('other-image');
        } };
    });
    registerServerHandlers({
        ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
        path, fsp: fs.promises,
        store: { get: key => key === 'serverDownloadFolder' ? directory : 2 },
        ...createFileOperationUtils(), getServerDownloadDirectory: () => directory
    });

    const resultPromise = handlers['download-server-images']({ sender: { send: noop } }, 2);
    await firstDeleteStarted.promise;
    assert.equal(secondImageDownloaded, false);
    secondImageReady.resolve();
    const result = await resultPromise;
    const files = fs.readdirSync(directory);
    assert.equal(result.downloadedCount, 2);
    assert.equal(files.length, 2);
    assert.deepEqual(files.map(file => fs.readFileSync(path.join(directory, file), 'utf8')).sort(), ['first-image', 'other-image']);
    assert.deepEqual(remoteDeleteIds.sort((first, second) => first[0] - second[0]), [[1], [2]]);
});

test('a failed download removes only its reserved file and keeps the remote record', async (t) => {
    const directory = temporaryDirectory(t);
    fs.writeFileSync(path.join(directory, 'same.jpg'), 'existing-image');
    const handlers = {};
    let deleteRequests = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (options?.method === 'DELETE') { deleteRequests++; return { ok: true }; }
        if (String(url).includes('/api/leon/pictures')) return {
            ok: true, json: async () => [{ id: 1, fileName: 'same.jpg', imageUrl: 'https://example.test/image' }]
        };
        return { ok: true, arrayBuffer: async () => Buffer.from('new-image') };
    });
    registerServerHandlers({
        ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, path,
        fsp: { ...fs.promises, writeFile: async destination => {
            await fs.promises.writeFile(destination, 'partial');
            throw new Error('ENOSPC');
        } },
        store: { get: key => key === 'serverDownloadFolder' ? directory : 1 },
        ...createFileOperationUtils(), getServerDownloadDirectory: () => directory
    });
    const result = await handlers['download-server-images']({ sender: { send: noop } }, 1);
    assert.equal(result.downloadedCount, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(deleteRequests, 0);
    assert.deepEqual(fs.readdirSync(directory), ['same.jpg']);
    assert.equal(fs.readFileSync(path.join(directory, 'same.jpg'), 'utf8'), 'existing-image');
});

function bmpPair(directory) {
    const pixels = 256 * 256 * 3;
    const first = Buffer.alloc(54 + pixels);
    first.write('BM');
    first.writeUInt32LE(first.length, 2);
    first.writeUInt32LE(54, 10);
    first.writeUInt32LE(40, 14);
    first.writeInt32LE(256, 18);
    first.writeInt32LE(256, 22);
    first.writeUInt16LE(1, 26);
    first.writeUInt16LE(24, 28);
    first.writeUInt32LE(pixels, 34);
    const second = Buffer.from(first);
    second.fill(255, 54 + pixels / 2);
    const paths = ['black.bmp', 'half-white.bmp'].map(name => path.join(directory, name));
    paths.forEach((file, index) => fs.writeFileSync(file, [first, second][index]));
    return { paths, legacyHash: crypto.createHash('md5').update(first.subarray(0, 64 * 1024)).digest('hex') };
}

function realLibrary(store, directory) {
    return createImageLibrary({
        store, thumbnailCacheDir: path.join(directory, 'thumbnails'),
        nativeImage: { createThumbnailFromPath: async imagePath => ({
            isEmpty: () => false, toPNG: () => Buffer.from(path.basename(imagePath))
        }) }
    });
}

test('different BMPs with identical first 64KB have independent metadata and thumbnails', async (t) => {
    const directory = temporaryDirectory(t);
    const { paths } = bmpPair(directory);
    const store = new Store(path.join(directory, 'store.db'));
    try {
        const library = realLibrary(store, directory);
        const hashes = await Promise.all(paths.map(file => library.getHash(file)));
        assert.notEqual(hashes[0], hashes[1]);
        store.addImageTag(hashes[0], 'black-only');
        store.setImageScores({ [hashes[0]]: { rating: 1600, wins: 1, matches: 1 } });
        assert.deepEqual(store.getImageTags(hashes[1]), []);
        assert.equal(store.getImageScore(hashes[1]), null);
        const thumbnails = await Promise.all(paths.map(file => library.getThumbnail(file)));
        assert.notEqual(thumbnails[0].dataUrl, thumbnails[1].dataUrl);
    } finally {
        store.close();
    }
});

test('legacy metadata survives full-hash migration without resurrecting removed tags', async (t) => {
    const directory = temporaryDirectory(t);
    const { paths, legacyHash } = bmpPair(directory);
    const database = path.join(directory, 'store.db');
    let store = new Store(database);
    try {
        const stats = fs.statSync(paths[0]);
        store.setPathHash(paths[0], { hash: legacyHash, size: stats.size, mtimeMs: stats.mtimeMs });
        store.addImageTag(legacyHash, 'legacy-tag');
        store.setImageScores({ [legacyHash]: { rating: 1620, wins: 4, matches: 6 } });
        const library = realLibrary(store, directory);
        const fullHash = await library.getHash(paths[0]);
        assert.match(fullHash, /^[a-f0-9]{64}$/);
        assert.deepEqual(store.getImageTags(fullHash), ['legacy-tag']);
        assert.equal(store.getImageScore(fullHash).rating, 1620);
        store.removeImageTag(fullHash, 'legacy-tag');
        store.close();
        store = new Store(database);
        const copyPath = path.join(directory, 'external-copy.bmp');
        fs.copyFileSync(paths[0], copyPath);
        assert.equal(await realLibrary(store, directory).getHash(copyPath), fullHash);
        assert.deepEqual(store.getImageTags(fullHash), []);
        const otherHash = await realLibrary(store, directory).getHash(paths[1]);
        assert.notEqual(otherHash, fullHash);
        assert.deepEqual(store.getImageTags(otherHash), ['legacy-tag']);
    } finally {
        store.close();
    }
});

test('filtering out the previewed image keeps the display and delete target consistent', async () => {
    const collection = collectionModule.create([
        { path: '/photos/A.jpg', name: 'A.jpg', hash: 'a', tags: ['keep'] },
        { path: '/photos/B.jpg', name: 'B.jpg', hash: 'b', tags: ['keep'] }
    ]);
    const dom = { modalImage: { style: {} }, modalFilename: {}, modalScore: {}, modalImageIndex: {}, zoomLevel: {} };
    let deleteTarget;
    const context = vm.createContext({
        console, imageCollection: collection, images: collection.items,
        imageQuery: require('../image-query').create({
            collection,
            getRating: image => require('../rating-model').normalize(collection.getScore(image)).rating
        }),
        currentSort: 'name-asc',
        sortedImages: [...collection.items], currentViewMode: 'list',
        selectedFilterTags: ['keep'], filterNoTag: false,
        imageModal: { classList: { contains: () => true, add: noop, remove: noop } },
        document: { getElementById: id => dom[id] },
        MacImageRating: require('../rating-model'),
        MacImagePreviewState: require('../image-preview-state'),
        toFileUrl: file => `file://${file}`, getImageTags: collection.getTags,
        removeTagFromImage: async file => { collection.applyMetadata({ path: file, tags: [] }); return []; },
        window: { electronAPI: { deleteImage: async file => { deleteTarget = file; return { success: false }; } } },
        alert: noop
    });
    loadScript(context, 'renderer-gallery.js');
    loadScript(context, 'renderer-modal.js');
    for (const name of ['setModalTagsExpanded', 'renderModalTagList', 'cancelGalleryWork', 'updateImageGridViewClass', 'renderVirtualList', 'renderEmptyImageGrid', 'renderTagFilter', 'updateImageCount', 'recordCurrentImageOpen']) {
        context[name] = noop;
    }
    context.openImageModal(0);
    await context.toggleModalImageTag('/photos/A.jpg', 'keep', { autoAdvance: true });
    assert.equal(dom.modalImage.src, 'file:///photos/B.jpg');
    await context.deleteCurrentImage();
    assert.equal(dom.modalImage.src, `file://${deleteTarget}`);
    collection.applyMetadata({ path: '/photos/A.jpg', tags: ['keep'] });
    context.renderImages();
    assert.equal(dom.modalImageIndex.textContent, '2 / 2');
    assert.equal(dom.modalImage.src, 'file:///photos/B.jpg');
    collection.applyMetadata(collection.items.map(image => ({ path: image.path, tags: [] })));
    context.renderImages();
    assert.equal(context.getCurrentModalImage(), null);
});

test('a late directory response cannot overwrite the latest selected folder', async () => {
    const first = deferred();
    const second = deferred();
    const context = folderRenderer({
        readDirectory: dir => dir === '/A' ? first.promise : second.promise,
        getWaterfallPendingPaths: async () => [], getWaterfallPendingPages: async () => []
    });
    const openingA = context.loadFolder('/A');
    await Promise.resolve();
    const openingB = context.loadFolder('/B');
    second.resolve([{ path: '/B/b.jpg' }]);
    await openingB;
    first.resolve([{ path: '/A/a.jpg' }]);
    await openingA;
    assert.equal(context.currentFolder, '/B');
    assert.equal(context.currentFolderEl.textContent, '/B');
    assert.equal(context.imageCollection.items[0].path, '/B/b.jpg');
});

test('reloading and switching folders preserves recovery of pending waterfall pages', async (t) => {
    const directory = temporaryDirectory(t);
    const source = path.join(directory, 'source');
    const trash = path.join(directory, 'trash');
    fs.mkdirSync(source);
    const image = { path: path.join(source, 'pending.jpg'), name: 'pending.jpg', size: 5 };
    fs.writeFileSync(image.path, 'image');
    const handlers = {};
    const services = registerFileHandlers({
        ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
        path, store: { get: () => trash },
        imageFileOperations: createImageFileOperations({
            fsp: fs.promises, path, fileOperations: createFileOperationUtils(), mapWithConcurrency
        })
    });
    const session = sessionModule.create({
        processPage: page => handlers['process-waterfall-page']({}, page),
        restorePendingPage: id => handlers['restore-waterfall-pending-page']({}, id)
    });
    await session.advance([image], { currentFolder: source, trashFolder: trash });
    const context = folderRenderer({
        readDirectory: async dir => dir === source ? [image] : [],
        getWaterfallPendingPaths: () => handlers['get-waterfall-pending-paths'](),
        getWaterfallPendingPages: () => handlers['get-waterfall-pending-pages']()
    }, session);
    await context.loadFolder('/another-folder');
    assert.equal(session.snapshot().canRestore, false);
    await context.loadFolder(source, { preserveDeleteHistory: true });
    assert.equal(session.snapshot().canRestore, true);
    const restored = await session.restore(context.images);
    assert.deepEqual(restored.restoredImages, [image]);
    assert.deepEqual(await handlers['get-waterfall-pending-paths'](), []);
    const flushed = await services.flushPendingWaterfallCleanup();
    assert.equal(flushed.deleted.length, 0);
    assert.equal(fs.existsSync(image.path), true);
});

test('one failed hash does not drop healthy metadata or stop later files', async () => {
    const updates = [];
    const writes = [];
    const names = ['unreadable.jpg', 'readable.jpg', 'later.jpg'];
    const library = createImageLibrary({
        nativeImage: {}, thumbnailCacheDir: '/unused', scanConcurrency: 1,
        store: {
            getPathHashesForDirectory: () => ({}), getImageMetadataForHashes: () => ({}),
            getImageMetadata: () => ({ tags: ['saved-tag'], score: null }),
            setPathHashes: values => writes.push(values)
        },
        fsp: {
            readdir: async () => names.map(name => ({ name, isFile: () => true })),
            stat: async () => ({ size: 10, mtimeMs: 1, mtime: new Date(1) })
        },
        hashFile: async file => {
            if (file.endsWith('/unreadable.jpg')) throw new Error('EACCES');
            return `hash:${file}`;
        }, logger: { error: noop }
    });
    await library.readDirectory('/photos', { onMetadata: batch => updates.push(...batch) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(updates.map(update => update.path), ['/photos/readable.jpg', '/photos/later.jpg']);
    assert.deepEqual(updates[0].tags, ['saved-tag']);
    assert.equal(Object.keys(writes[0]).length, 2);
});

test('duplicate detection includes identical files with mixed hash cache states', async () => {
    const library = createImageLibrary({
        nativeImage: {}, store: {}, thumbnailCacheDir: '/unused',
        hashFullFile: async () => 'identical-content'
    });
    const result = await library.findDuplicates([
        { path: '/photos/original.jpg', size: 100, hash: 'cached' },
        { path: '/photos/copy.jpg', size: 100, hash: null }
    ]);
    assert.deepEqual(result.groups, [{ hash: 'identical-content', paths: ['/photos/original.jpg', '/photos/copy.jpg'] }]);
});

test('importing legacy score backups updates images that already have full hashes', async (t) => {
    const directory = temporaryDirectory(t);
    const { paths, legacyHash } = bmpPair(directory);
    const store = new Store(path.join(directory, 'store.db'));
    try {
        const hash = await realLibrary(store, directory).getHash(paths[0]);
        const handlers = {};
        require('../main-ipc-handlers')({
            ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
            path, fsp: fs.promises, store, fileOperations: {}, imageLibrary: {}, imageFileOperations: {}
        });
        const score = { rating: 1720, wins: 7, matches: 10 };
        const imported = await handlers['import-config']({}, { imageScoresByHash: { [legacyHash]: score } });
        assert.equal(imported.success, true);
        assert.deepEqual(store.getImageScore(hash), score);
        assert.deepEqual(imported.imageScoresByHash[hash], score);
        const newerScore = { ...score, rating: 1800 };
        store.replaceImageScores({ [legacyHash]: score, [hash]: newerScore });
        assert.deepEqual(store.getImageScore(hash), newerScore);
    } finally {
        store.close();
    }
});

test('older metadata events cannot change a reopened directory', async () => {
    const requests = [];
    const image = { path: '/A/a.jpg', tags: [], hash: 'a'.repeat(64) };
    const context = folderRenderer({
        readDirectory: async (dir, requestId) => { requests.push(requestId); return dir === '/A' ? [image] : []; },
        getWaterfallPendingPages: async () => []
    });
    context.renderImages = noop;
    context.renderTagFilter = noop;
    context.updateMigrateSourceFolder = noop;
    await context.loadFolder('/A');
    await context.loadFolder('/B');
    await context.loadFolder('/A');
    context.queueDirectoryMetadataUpdates({
        dirPath: '/A', requestId: requests[0],
        updates: [{ path: image.path, hash: image.hash, tags: ['obsolete'] }]
    });
    context.applyDirectoryMetadataUpdates();
    assert.deepEqual(image.tags, []);
    context.queueDirectoryMetadataUpdates({
        dirPath: '/A', requestId: requests[2],
        updates: [{ path: image.path, hash: image.hash, tags: ['current'] }]
    });
    context.applyDirectoryMetadataUpdates();
    assert.deepEqual([...image.tags], ['current']);
    context.resetPendingDirectoryMetadataUpdates();
});

test('switching folders waits for an active waterfall page without mixing its results', async () => {
    const pageGate = deferred();
    const imageA = { path: '/A/a.jpg', name: 'a.jpg', size: 1 };
    const imageB = { path: '/B/b.jpg', name: 'b.jpg', size: 1 };
    let pendingPages = [];
    const reads = [];
    const api = {
        readDirectory: async folder => { reads.push(folder); return folder === '/A' ? [imageA] : [imageB]; },
        getWaterfallPendingPages: async () => pendingPages,
        processWaterfallPage: async () => {
            await pageGate.promise;
            pendingPages = [{ id: 'page-A', paths: [imageA.path] }];
            return { success: true, pendingBatchId: 'page-A', pending: [{ originalPath: imageA.path }] };
        }
    };
    const context = folderRenderer(api);
    Object.assign(context, {
        MacImageWaterfallSession: sessionModule,
        initialWaterfallPageSize: 3, WATERFALL_PAGE_SIZES: [3, 10],
        WATERFALL_WHEEL_PAGE_THRESHOLD: 80, WATERFALL_WHEEL_RESET_MS: 240,
        migrateTargetFolder: '', trashFolder: '/trash', currentViewMode: 'waterfall',
        imageGrid: {}, recordFileOperation: noop
    });
    loadScript(context, 'renderer-waterfall.js');
    context.renderWaterfallPage = noop;
    await context.loadFolder('/A');
    context.sortedImages = [imageA];
    const advancing = context.advanceWaterfallPage();
    const switching = context.loadFolder('/B');
    await Promise.resolve();
    assert.deepEqual(reads, ['/A']);
    pageGate.resolve();
    await Promise.all([advancing, switching]);
    assert.equal(context.currentFolder, '/B');
    assert.deepEqual(context.images, [imageB]);
    assert.equal(context.getWaterfallView().canRestore, false);
    await context.loadFolder('/A');
    assert.equal(context.getWaterfallView().canRestore, true);
});

test('partially failed deferred cleanup keeps its remaining images recoverable', async () => {
    const handlers = {};
    const lostPermissionPath = '/photos/blocked.jpg';
    registerFileHandlers({
        ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
        path, store: { get: () => '/trash' },
        imageFileOperations: {
            moveMany: async () => ({ moved: [], failures: [] }),
            trashMany: async paths => ({
                deleted: paths.filter(file => file !== lostPermissionPath).map(file => ({ originalPath: file, trashPath: '/trash/' + path.basename(file) })),
                failures: paths.filter(file => file === lostPermissionPath).map(file => ({ path: file, error: 'EACCES' }))
            })
        }
    });
    const session = sessionModule.create({ processPage: page => handlers['process-waterfall-page']({}, page) });
    await session.advance([{ path: '/photos/ok.jpg' }, { path: lostPermissionPath }], { trashFolder: '/trash' });
    for (let index = 0; index < 5; index++) {
        await session.advance([{ path: `/photos/${index}.jpg` }], { trashFolder: '/trash' });
    }
    const pages = await handlers['get-waterfall-pending-pages']();
    assert.deepEqual(pages[0].paths, [lostPermissionPath]);
    assert.equal(session.snapshot().pendingImages.some(image => image.path === lostPermissionPath), true);
    assert.equal(session.snapshot().pendingImages.some(image => image.path === '/photos/ok.jpg'), false);
});
