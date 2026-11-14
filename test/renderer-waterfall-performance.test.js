const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const MacImageWaterfallSession = require('../waterfall-session');

function element(innerHTML = '', classNames = '') {
    const classes = new Set(classNames.split(/\s+/).filter(Boolean));
    return {
        innerHTML, dataset: {},
        classList: {
            contains: name => classes.has(name),
            toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }
        },
        setAttribute(name, value) { this[name] = String(value); }
    };
}

// Track the expensive boundary: replacing the grid discards loaded images.
// The small DOM fixture keeps real card identities across subsequent updates.
function renderer() {
    const toolbar = element();
    let gridWrites = 0;
    let imageRenders = 0;
    let markup = '';
    let nodes = new Map();
    let cards = [];
    const grid = {
        get innerHTML() { return markup; },
        set innerHTML(value) {
            markup = value;
            gridWrites++;
            nodes = new Map();
            const messages = value.match(/<div class="waterfall-messages">([\s\S]*?)<\/div>/);
            if (messages) nodes.set('.waterfall-messages', element(messages[1]));
            cards = [...value.matchAll(/<article class="(waterfall-card[^"]*)" data-waterfall-path="([^"]+)">([\s\S]*?)<\/article>/g)]
                .map(([, classNames, imagePath, content]) => {
                    const card = element(content, classNames);
                    card.dataset.waterfallPath = imagePath;
                    const image = { src: imagePath };
                    const copy = element();
                    copy.dataset = { waterfallAction: 'copy', path: imagePath };
                    const buttons = [1, 2, 3].map(score => {
                        const button = element();
                        button.dataset = { waterfallAction: 'score', path: imagePath, score: String(score) };
                        return button;
                    });
                    card.querySelectorAll = selector => {
                        assert.equal(selector, '[data-score]');
                        return buttons;
                    };
                    card.querySelector = selector => ({
                        '.waterfall-image': image,
                        '[data-waterfall-action="copy"]': copy
                    })[selector] || null;
                    return card;
                });
            const layout = value.match(/class="waterfall-cards waterfall-cards--(\d+)"/);
            if (layout) {
                const container = element();
                container.classList.toggle(`waterfall-cards--${layout[1]}`, true);
                container.querySelectorAll = selector => {
                    assert.equal(selector, '.waterfall-card');
                    return cards;
                };
                nodes.set('.waterfall-cards', container);
            }
        },
        querySelector: selector => nodes.get(selector) || null
    };
    const context = vm.createContext({
        MacImageWaterfallSession, initialWaterfallPageSize: 10, WATERFALL_PAGE_SIZES: [2, 3, 10],
        WATERFALL_WHEEL_PAGE_THRESHOLD: 80, WATERFALL_WHEEL_RESET_MS: 240,
        currentViewMode: 'waterfall', currentFolder: '/photos', migrateTargetFolder: '/rated',
        isFolderLoading: false, imageGrid: grid,
        document: { getElementById: id => id === 'waterfallToolbar' ? toolbar : null },
        sortedImages: Array.from({ length: 20 }, (_, index) => ({
            path: `/photos/${index}.jpg`, name: `${index}.jpg`, size: 100
        })),
        window: { electronAPI: {} },
        escapeHtml: String, escapeAttribute: String, formatFileSize: String,
        renderWaterfallFullscreenButton: () => '',
        renderOriginalImageAttributes: image => { imageRenders++; return `src="${image.path}"`; },
        renderEmptyState: () => '', recordFileOperation() {},
        imageCollection: { remove(paths) {
            context.sortedImages = context.sortedImages.filter(image => !paths.includes(image.path));
        } },
        refreshAfterImageMembershipChange: () => context.renderWaterfallPage()
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer-waterfall.js'), 'utf8'), context);
    context.renderWaterfallPage();
    return { context, grid, toolbar, cards: () => cards, writes: () => gridWrites, imageRenders: () => imageRenders };
}

test('rating and right-click scoring preserve all loaded images and copy controls', () => {
    const app = renderer();
    const originalCards = app.cards();
    const card = originalCards[0];
    const copy = card.querySelector('[data-waterfall-action="copy"]');
    copy.textContent = '✓';
    const button = card.querySelectorAll('[data-score]')[2];
    const event = { target: { closest: () => button } };
    app.context.handleWaterfallGridClick(event);

    assert.equal(app.writes(), 1, 'a score change must not rebuild the image grid');
    assert.equal(app.imageRenders(), 10);
    assert.equal(app.cards()[0], card);
    assert.equal(copy.textContent, '✓');
    assert.equal(button['aria-pressed'], 'true');
    assert.equal(card.classList.contains('is-rated'), true);
    assert.equal(app.context.getWaterfallView().scores.get('/photos/0.jpg'), 3);
    assert.match(app.toolbar.innerHTML, /已选 1\/10/);

    app.context.handleWaterfallGridClick(event);
    assert.equal(button['aria-pressed'], 'false');
    assert.equal(card.classList.contains('is-rated'), false);
    assert.equal(app.context.getWaterfallView().scores.has('/photos/0.jpg'), false);
    app.context.handleWaterfallContextMenu({ target: { closest: () => card } });
    assert.equal(card.querySelectorAll('[data-score]')[0]['aria-pressed'], 'true');
    assert.equal(card.classList.contains('is-rated'), true);
    assert.equal(app.writes(), 1);
    assert.deepEqual(app.cards(), originalCards);
});

test('same-page refreshes retain images while a different order replaces them', () => {
    const app = renderer();
    const firstCard = app.cards()[0];
    app.context.renderWaterfallPage();
    app.context.renderWaterfallPage();
    assert.equal(app.writes(), 1);
    assert.equal(app.cards()[0], firstCard);

    [app.context.sortedImages[0], app.context.sortedImages[1]] =
        [app.context.sortedImages[1], app.context.sortedImages[0]];
    app.context.renderWaterfallPage();
    assert.equal(app.writes(), 2);
    assert.equal(app.cards()[0].dataset.waterfallPath, '/photos/1.jpg');
    assert.notEqual(app.cards()[0], firstCard);

    const card = app.cards()[0];
    const button = card.querySelectorAll('[data-score]')[1];
    app.context.handleWaterfallGridClick({ target: { closest: () => button } });
    app.context.sortedImages.reverse();
    app.context.renderWaterfallPage();
    app.context.sortedImages.reverse();
    app.context.renderWaterfallPage();
    assert.equal(app.cards()[0].dataset.waterfallPath, '/photos/1.jpg');
    assert.equal(app.cards()[0].classList.contains('is-rated'), true);
});

test('page processing retains the current images until the next page is ready', async () => {
    const app = renderer();
    let finish;
    app.context.window.electronAPI.processWaterfallPage = () => new Promise(resolve => { finish = resolve; });
    const pending = app.context.advanceWaterfallPage();
    assert.equal(app.writes(), 1);
    assert.match(app.toolbar.innerHTML, /整理中/);
    finish({ success: true, pendingBatchId: 'round-1',
        pending: app.context.sortedImages.slice(0, 10).map(image => ({ originalPath: image.path })) });
    await pending;
    assert.equal(app.writes(), 2);
    assert.equal(app.cards()[0].dataset.waterfallPath, '/photos/10.jpg');
});

test('copy completion still updates its visible button after scoring another image', async () => {
    const app = renderer();
    let finish;
    app.context.window.electronAPI.copyImage = () => new Promise(resolve => { finish = resolve; });
    const copy = app.cards()[0].querySelector('[data-waterfall-action="copy"]');
    const pending = app.context.copyWaterfallImage(copy);
    const score = app.cards()[1].querySelectorAll('[data-score]')[0];
    app.context.handleWaterfallGridClick({ target: { closest: () => score } });
    finish({ success: true });
    await pending;
    assert.equal(app.cards()[0].querySelector('[data-waterfall-action="copy"]'), copy);
    assert.equal(copy.textContent, '✓');
    assert.equal(copy.disabled, false);
});
