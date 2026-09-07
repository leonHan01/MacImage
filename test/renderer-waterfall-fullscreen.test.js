const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const MacImageWaterfallSession = require('../waterfall-session');

function fullscreenRenderer({ request, exit } = {}) {
    const classes = new Set();
    const alerts = [];
    const label = {};
    const button = {
        setAttribute(name, value) { this[name] = value; },
        querySelector: () => label
    };
    const document = {
        fullscreenElement: null,
        documentElement: {},
        body: { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } },
        querySelectorAll: () => [button]
    };
    const context = vm.createContext({
        document, alert: message => alerts.push(message), currentViewMode: 'waterfall',
        MacImageWaterfallSession, initialWaterfallPageSize: 3, WATERFALL_PAGE_SIZES: [3, 10],
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
    return { context, document, classes, alerts, button, label };
}

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
    const { context } = fullscreenRenderer();
    await context.toggleWaterfallFullscreen();
    context.renderWaterfallPage();
    assert.match(context.imageGrid.innerHTML, /没有待评分的图片/);
    assert.match(context.imageGrid.innerHTML, /退出全屏/);
    context.renderFinishedWaterfallPage({ ...context.getWaterfallView(), canRestore: true });
    assert.match(context.imageGrid.innerHTML, /本轮浏览完成/);
    assert.match(context.imageGrid.innerHTML, /退出全屏/);
    vm.runInContext(fs.readFileSync('renderer-gallery.js', 'utf8'), context);
    context.cancelGalleryWork = () => {};
    context.updateImageGridViewClass = () => {};
    context.renderEmptyImageGrid();
    assert.match(context.imageGrid.innerHTML, /退出全屏/);
});
