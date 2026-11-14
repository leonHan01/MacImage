const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const MacImageWaterfallSession = require('../waterfall-session');

function fullscreenRenderer({ request, exit } = {}) {
    const classes = new Set();
    const alerts = [];
    const toolbar = { innerHTML: '', hidden: true };
    const label = {};
    const button = {
        setAttribute(name, value) { this[name] = value; },
        querySelector: () => label
    };
    const document = {
        fullscreenElement: null,
        documentElement: {},
        body: { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } },
        getElementById: id => id === 'waterfallToolbar' ? toolbar : null,
        querySelectorAll: () => [button]
    };
    const context = vm.createContext({
        document, alert: message => alerts.push(message), currentViewMode: 'waterfall',
        localStorage: { setItem() {} },
        MacImageWaterfallSession, initialWaterfallPageSize: 3, WATERFALL_PAGE_SIZES: [2, 3, 10],
        WATERFALL_WHEEL_PAGE_THRESHOLD: 80, WATERFALL_WHEEL_RESET_MS: 240,
        window: { electronAPI: {} }, sortedImages: [], currentFolder: '/photos',
        migrateTargetFolder: '/rated', trashFolder: '/trash', imageGrid: {},
        renderEmptyState: (_icon, message) => message, formatFileSize: String,
        escapeHtml: String, escapeAttribute: String,
        renderOriginalImageAttributes: image => `src="${image.path}"`
    });
    document.documentElement.requestFullscreen = async () => {
        if (request) await request();
        document.fullscreenElement = document.documentElement;
        context.syncWaterfallFullscreen();
    };
    document.exitFullscreen = async () => {
        if (exit) await exit();
        document.fullscreenElement = null;
        context.syncWaterfallFullscreen();
    };
    for (const file of ['renderer-waterfall-fullscreen.js', 'renderer-waterfall.js']) {
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
    return { context, document, classes, alerts, button, label, toolbar };
}

test('two-grid layout shows two adjacent cards from the first image', () => {
    const { context, toolbar } = fullscreenRenderer();
    context.sortedImages = [
        { path: '/photos/a.jpg', name: 'a.jpg', size: 10 },
        { path: '/photos/b.jpg', name: 'b.jpg', size: 10 },
        { path: '/photos/c.jpg', name: 'c.jpg', size: 10 }
    ];

    context.setWaterfallPageSize(2);

    assert.equal(context.getWaterfallView().pageImages.length, 2);
    assert.match(context.imageGrid.innerHTML, /waterfall-cards--2/);
    assert.match(toolbar.innerHTML, /data-layout-size="2"\s+aria-pressed="true"/);
    assert.doesNotMatch(context.imageGrid.innerHTML, /data-waterfall-path="\/photos\/c.jpg"/);
});

test('two-grid widths follow image proportions and leave spare space on the right', () => {
    const { context } = fullscreenRenderer();
    const portraits = [
        { naturalWidth: 656, naturalHeight: 984 },
        { naturalWidth: 736, naturalHeight: 984 }
    ];
    const widths = context.calculateWaterfallTwoCardWidths(portraits, 984, 2000, 2);
    assert.deepEqual([...widths], [658, 738]);
    assert.equal(widths[0] + widths[1] + 2 < 2000, true);

    const fitted = context.calculateWaterfallTwoCardWidths(portraits, 984, 1000, 2);
    assert.equal(Math.round(fitted[0] + fitted[1] + 2), 1000);
    assert.equal(Math.round(fitted[0] / fitted[1] * 100), Math.round(658 / 738 * 100));
});

test('two-grid applies widths when cached images finish decoding', async () => {
    const { context } = fullscreenRenderer();
    const images = [656, 736].map(naturalWidth => ({
        naturalWidth: 0,
        naturalHeight: 0,
        addEventListener() {},
        async decode() {
            this.naturalWidth = naturalWidth;
            this.naturalHeight = 984;
        }
    }));
    const cards = images.map(image => ({
        style: {},
        querySelector: selector => selector === '.waterfall-image' ? image : { clientHeight: 984 }
    }));
    const container = {
        isConnected: true,
        clientWidth: 2000,
        querySelectorAll: () => cards
    };
    context.imageGrid.querySelector = () => container;
    context.getComputedStyle = () => ({ columnGap: '2px' });
    context.ResizeObserver = class { observe() {} disconnect() {} };
    context.requestAnimationFrame = callback => callback();

    context.setupWaterfallTwoCardLayout();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(cards[0].style.flex, '0 0 658px');
    assert.equal(cards[1].style.flex, '0 0 738px');
});

test('fullscreen keeps ratings and page layout, including after a system exit', async () => {
    const { context, document, classes, button, label } = fullscreenRenderer();
    context.sortedImages = [{ path: '/photos/a.jpg', name: 'a.jpg', size: 10 }];
    context.handleWaterfallGridClick({ target: { closest: () => ({
        dataset: { waterfallAction: 'score', path: '/photos/a.jpg', score: '3' }
    }) } });
    const before = context.getWaterfallView();
    await context.toggleWaterfallFullscreen();
    assert.equal(classes.has('waterfall-fullscreen'), true);
    assert.equal(document.fullscreenElement, document.documentElement);
    assert.equal(button['aria-pressed'], 'true');
    assert.equal(label.textContent, '退出全屏');
    document.fullscreenElement = null;
    context.syncWaterfallFullscreen();
    assert.equal(classes.has('waterfall-fullscreen'), false);
    assert.equal(button['aria-pressed'], 'false');
    const after = context.getWaterfallView();
    assert.equal(after.scores.get('/photos/a.jpg'), 3);
    assert.equal(after.batchNumber, before.batchNumber);
    assert.equal(after.pageSize, before.pageSize);
});

test('failed fullscreen requests recover controls and can be retried', async () => {
    let fail = true;
    const { context, classes, button, alerts } = fullscreenRenderer({
        request: () => { if (fail) throw new Error('Fullscreen unavailable'); }
    });
    await context.toggleWaterfallFullscreen();
    assert.equal(classes.has('waterfall-fullscreen'), false);
    assert.equal(button.disabled, false);
    assert.match(alerts[0], /Fullscreen unavailable/);
    fail = false;
    await context.toggleWaterfallFullscreen();
    assert.equal(classes.has('waterfall-fullscreen'), true);
    await context.exitWaterfallFullscreen();
    assert.equal(classes.has('waterfall-fullscreen'), false);
});

test('switching views during fullscreen entry cancels the pending request', async () => {
    let resolveRequest;
    const pending = new Promise(resolve => { resolveRequest = resolve; });
    let requestCount = 0;
    const { context, document, classes } = fullscreenRenderer({
        request: () => { requestCount++; return pending; }
    });
    const entering = context.toggleWaterfallFullscreen();
    await context.toggleWaterfallFullscreen();
    await context.exitWaterfallFullscreen();
    context.currentViewMode = 'grid';
    resolveRequest();
    await entering;
    assert.equal(requestCount, 1);
    assert.equal(document.fullscreenElement, null);
    assert.equal(classes.has('waterfall-fullscreen'), false);
});

test('empty and finished pages retain the fullscreen exit control', async () => {
    const { context, toolbar } = fullscreenRenderer();
    await context.toggleWaterfallFullscreen();
    context.renderWaterfallPage();
    assert.match(context.imageGrid.innerHTML, /没有待评分的图片/);
    assert.match(toolbar.innerHTML, /退出全屏/);
    context.renderFinishedWaterfallPage(context.getWaterfallView());
    assert.match(toolbar.innerHTML, /退出全屏/);
    assert.equal(toolbar.hidden, false);
    context.renderFinishedWaterfallPage({ ...context.getWaterfallView(), canRestore: true, restorablePageCount: 5 });
    assert.match(context.imageGrid.innerHTML, /本轮浏览完成/);
    assert.match(toolbar.innerHTML, /可返回 5 轮/);
    assert.doesNotMatch(context.renderWaterfallPreviousButton({ canRestore: true, restorablePageCount: 5 }), /disabled/);
    vm.runInContext(fs.readFileSync('renderer-gallery.js', 'utf8'), context);
    context.cancelGalleryWork = () => {};
    context.updateImageGridViewClass = () => {};
    context.renderEmptyImageGrid();
    assert.match(toolbar.innerHTML, /退出全屏/);
});
