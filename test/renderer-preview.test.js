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

test('up arrow restores the previous page in the ten-card waterfall', () => {
    let restoreCount = 0;
    let prevented = false;
    const hiddenModal = { classList: { contains: () => false } };
    const context = loadRendererScript('renderer-modal.js', {
        imageModal: hiddenModal,
        competitionModal: hiddenModal,
        settingsModal: hiddenModal,
        currentViewMode: 'waterfall',
        waterfallPageSize: 10,
        isEditableTarget: () => false,
        restorePreviousWaterfallPage: () => { restoreCount++; }
    });

    context.handleKeyboard({
        key: 'ArrowUp',
        code: 'ArrowUp',
        target: null,
        repeat: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: () => { prevented = true; }
    });

    assert.equal(prevented, true);
    assert.equal(restoreCount, 1);
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
