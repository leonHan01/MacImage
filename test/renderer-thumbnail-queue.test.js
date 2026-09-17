const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function setup() {
    let thumbnails = [];
    const requests = [];
    const context = vm.createContext({
        galleryRenderVersion: 1,
        currentViewMode: 'grid',
        gridVirtualState: null,
        listVirtualState: null,
        gridRenderFrame: null,
        thumbnailQueue: [],
        thumbnailQueuedIndexes: new Set(),
        thumbnailMemoryCache: new Map(),
        thumbnailActiveCount: 0,
        THUMBNAIL_LOAD_CONCURRENCY: 2,
        THUMBNAIL_MEMORY_CACHE_LIMIT: 350,
        THUMBNAIL_SIZE: 220,
        sortedImages: Array.from({ length: 120 }, (_, index) => ({ path: `/photos/${index}.jpg`, size: 10, modifiedTime: '2026-01-01' })),
        imageGrid: {
            querySelectorAll: () => thumbnails,
            querySelector: selector => thumbnails.find(item => selector.includes(`="${item.dataset.thumbIndex}"`))
        },
        window: { electronAPI: { getThumbnail: path => new Promise(resolve => { requests.push({ path, resolve }); }) } }
    });
    vm.runInContext(fs.readFileSync('renderer-gallery.js', 'utf8'), context);

    function render(indexes) {
        thumbnails = indexes.map(index => {
            const classes = new Set();
            return {
                dataset: { thumbIndex: String(index) },
                classList: { contains: name => classes.has(name), add: name => classes.add(name) },
                closest: () => null
            };
        });
        context.queueRenderedGridThumbnails(context.galleryRenderVersion);
    }
    async function finish(requestIndex, dataUrl = 'data:image/png;base64,cG5n') {
        requests[requestIndex].resolve({ success: true, dataUrl });
        await new Promise(resolve => setImmediate(resolve));
    }
    return { context, requests, render, finish };
}

test('rapid scrolling drops offscreen work and spends available slots on the current window', async () => {
    const { context, requests, render, finish } = setup();
    render(Array.from({ length: 30 }, (_, index) => index));
    assert.deepEqual(requests.map(request => request.path), ['/photos/0.jpg', '/photos/1.jpg']);
    render([90, 91, 92]);
    assert.equal(context.thumbnailQueue.length, 3);
    assert.equal(context.thumbnailQueuedIndexes.has(2), false);
    await finish(0);
    assert.equal(requests[2].path, '/photos/90.jpg');
    assert.equal(context.thumbnailActiveCount, 2);

    render([91, 92]);
    await finish(1);
    assert.equal(requests[3].path, '/photos/91.jpg');
    await finish(2);
    assert.equal(requests[4].path, '/photos/92.jpg');
    await finish(3);
    await finish(4);
    assert.equal(context.thumbnailActiveCount, 0);
    assert.equal(context.thumbnailQueuedIndexes.size, 0);
});

test('completion from an older render cannot clear a newer request at the same index', async () => {
    const { context, requests, render, finish } = setup();
    render([0]);
    context.cancelGalleryWork();
    render([0]);
    await finish(0);
    assert.equal(context.thumbnailQueuedIndexes.has(0), true);
    render([0]);
    assert.equal(requests.length, 2);
    await finish(1);
    assert.equal(context.thumbnailQueuedIndexes.size, 0);
});

test('completed thumbnails from an older render can satisfy queued work without another IPC call', async () => {
    const { context, requests, render, finish } = setup();
    context.THUMBNAIL_LOAD_CONCURRENCY = 1;
    render([0]);
    context.cancelGalleryWork();
    render([0]);
    await finish(0);
    assert.equal(requests.length, 1);
    assert.equal(context.thumbnailQueue.length, 0);
    assert.equal(context.thumbnailQueuedIndexes.size, 0);
});
