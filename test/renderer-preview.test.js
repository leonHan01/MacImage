const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const MacImageWaterfallSession = require('../waterfall-session');

function loadRendererScript(fileName, globals = {}) {
    const context = vm.createContext({
        console,
        Map,
        Set,
        ...globals
    });
    vm.runInContext(fs.readFileSync(fileName, 'utf8'), context, { filename: fileName });
    return context;
}

const escapeAttribute = value => String(value);
const escapeHtml = value => String(value);

function waterfallGlobals(overrides = {}) {
    return {
        MacImageWaterfallSession,
        initialWaterfallPageSize: 3,
        WATERFALL_PAGE_SIZES: [3, 10],
        WATERFALL_WHEEL_PAGE_THRESHOLD: 80,
        WATERFALL_WHEEL_RESET_MS: 240,
        window: { electronAPI: {} },
        sortedImages: [],
        migrateTargetFolder: '',
        currentFolder: '',
        trashFolder: null,
        ...overrides
    };
}

test('large display attributes load the original file directly', () => {
    const context = loadRendererScript('renderer-gallery.js', {
        escapeAttribute,
        toFileUrl: imagePath => `file://${imagePath}`
    });

    const attributes = context.renderOriginalImageAttributes({
        path: '/photos/large image.jpg'
    });

    assert.match(attributes, /src="file:\/\/\/photos\/large image\.jpg"/);
    assert.doesNotMatch(attributes, /data-preview-path/);
});

test('waterfall cards load the original image without a preview cache', () => {
    const context = loadRendererScript('renderer-waterfall.js', waterfallGlobals({
        renderOriginalImageAttributes: img => `src="file://${img.path}"`,
        escapeAttribute,
        escapeHtml
    }));

    const html = context.renderWaterfallCard({
        path: '/photos/large.jpg',
        name: 'large.jpg',
        size: 10,
        mtimeMs: 100
    }, 0, new Map());

    assert.match(html, /src="file:\/\/\/photos\/large\.jpg"/);
    assert.doesNotMatch(html, /data-preview-path/);
    assert.match(html, /title="右键标记为 1 分"/);
});

test('waterfall renders all failure paths and system errors as escaped text', () => {
    const encodeHtml = value => String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
    const context = loadRendererScript('renderer-waterfall.js', waterfallGlobals({ escapeHtml: encodeHtml }));
    const html = context.renderWaterfallFeedback({
        status: '2 项操作失败',
        failureDetails: [
            { path: '/photos/<blocked>.jpg', action: 'delete', code: 'EPERM', error: 'denied <img src=x onerror=alert(1)>' },
            { path: '/photos/missing.jpg', action: 'move', targetPath: '/target/a&b.jpg', code: 'ENOENT', syscall: 'access', error: 'no such file' }
        ]
    });
    assert.match(html, /role="alert"/);
    assert.match(html, /系统废纸篓/);
    assert.match(html, /\/photos\/&lt;blocked&gt;\.jpg/);
    assert.match(html, /\/photos\/missing\.jpg/);
    assert.match(html, /\/target\/a&amp;b\.jpg/);
    assert.match(html, /EPERM/);
    assert.match(html, /ENOENT/);
    assert.match(html, /access/);
    assert.match(html, /no such file/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.equal(context.renderWaterfallFeedback({ status: '', failureDetails: [] }), '');
});

test('ten-card waterfall supports right-click scoring', () => {
    let renderCount = 0;
    let scoredImage;
    const fakeSession = {
        score: (imagePath, score) => { scoredImage = { imagePath, score }; }
    };
    const context = loadRendererScript('renderer-waterfall.js', waterfallGlobals({
        MacImageWaterfallSession: { create: () => fakeSession },
        currentViewMode: 'waterfall',
    }));
    context.renderWaterfallPage = () => { renderCount++; };

    const handled = context.handleWaterfallContextMenu({
        target: {
            closest: selector => selector === '.waterfall-card'
                ? { dataset: { waterfallPath: '/photos/ten-card.jpg' } }
                : null
        }
    });

    assert.equal(handled, true);
    assert.deepEqual(scoredImage, { imagePath: '/photos/ten-card.jpg', score: 1 });
    assert.equal(renderCount, 1);
});

test('competition choices load originals without hydrating cached previews', () => {
    const body = {};
    const context = loadRendererScript('renderer-competition.js', {
        document: { getElementById: () => body },
        escapeAttribute,
        escapeHtml,
        formatImageRating: () => '1500 分',
        renderOriginalImageAttributes: img => `src="file://${img.path}"`
    });

    context.renderCompetitionChoices([{
        path: '/photos/large.jpg',
        name: 'large.jpg',
        size: 10,
        mtimeMs: 100
    }]);

    assert.match(body.innerHTML, /src="file:\/\/\/photos\/large\.jpg"/);
    assert.doesNotMatch(body.innerHTML, /data-preview-path/);
});
