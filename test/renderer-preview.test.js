const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

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

test('waterfall cards defer original image loading to the preview pipeline', () => {
    const context = loadRendererScript('renderer-waterfall.js', {
        waterfallScores: new Map(),
        waterfallPageSize: 10,
        renderDisplayPreviewAttributes: img => `data-preview-path="${img.path}"`,
        escapeAttribute,
        escapeHtml
    });

    const html = context.renderWaterfallCard({
        path: '/photos/large.jpg',
        name: 'large.jpg',
        size: 10,
        mtimeMs: 100
    }, 0);

    assert.match(html, /data-preview-path="\/photos\/large\.jpg"/);
    assert.doesNotMatch(html, /src="file:/);
});

test('competition choices defer original image loading to the preview pipeline', () => {
    const body = {};
    const context = loadRendererScript('renderer-competition.js', {
        document: { getElementById: () => body },
        escapeAttribute,
        escapeHtml,
        formatImageRating: () => '1500 分',
        renderDisplayPreviewAttributes: img => `data-preview-path="${img.path}"`,
        hydrateDisplayPreviews: () => {}
    });

    context.renderCompetitionChoices([{
        path: '/photos/large.jpg',
        name: 'large.jpg',
        size: 10,
        mtimeMs: 100
    }]);

    assert.match(body.innerHTML, /data-preview-path="\/photos\/large\.jpg"/);
    assert.doesNotMatch(body.innerHTML, /src="file:/);
});
