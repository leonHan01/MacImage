const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer-keyboard.js'), 'utf8');

function keyboard({ preview = false, competition = false, settings = false, view = 'list' } = {}) {
    const calls = [];
    const modal = visible => ({ classList: { contains: () => visible } });
    const actions = Object.fromEntries([
        'showPrevImage', 'showNextImage', 'closeModal', 'deleteCurrentImage',
        'zoomIn', 'zoomOut', 'zoomReset', 'closeCompetition', 'chooseCompetitionWinner',
        'closeSettings', 'advanceWaterfallPage', 'restorePreviousWaterfallPage',
        'toggleWaterfallFullscreen', 'exitWaterfallFullscreen'
    ].map(name => [name, (...args) => calls.push([name, ...args])]));
    const context = vm.createContext({
        ...actions,
        imageModal: modal(preview), competitionModal: modal(competition), settingsModal: modal(settings),
        currentViewMode: view,
        isEditableTarget: target => Boolean(target?.editable),
        normalizeShortcut: key => key.toLowerCase(),
        FAVORITE_IMAGE_SHORTCUT: 'f', DELETE_IMAGE_SHORTCUT: 'd',
        getTagByShortcut: key => ['f', 'd', 'x'].includes(key.toLowerCase()) ? { name: '标签' } : null,
        toggleHeartTagForCurrentImage: (event, options) => calls.push(['favorite', options.autoAdvance]),
        toggleCurrentImageTag: (tag, options) => calls.push(['tag', tag, options.showFeedback, options.autoAdvance])
    });
    vm.runInContext(source, context, { filename: 'renderer-keyboard.js' });

    return (key, overrides = {}) => {
        calls.length = 0;
        let prevented = false;
        context.handleKeyboard({
            key, code: '', target: null, repeat: false,
            metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
            preventDefault: () => { prevented = true; },
            ...overrides
        });
        return { calls: [...calls], prevented };
    };
}

test('keyboard events reach only the highest-priority active view', () => {
    const preview = keyboard({ preview: true, competition: true, settings: true, view: 'waterfall' });
    assert.deepEqual(preview('ArrowDown'), { calls: [['showNextImage']], prevented: true });
    assert.deepEqual(preview('Escape'), { calls: [['closeModal']], prevented: false });

    const competition = keyboard({ competition: true, settings: true, view: 'waterfall' });
    assert.deepEqual(competition('ArrowRight'), { calls: [['chooseCompetitionWinner', 1]], prevented: true });
    assert.deepEqual(competition('ArrowDown'), { calls: [], prevented: false });
    assert.deepEqual(competition('Escape'), { calls: [['closeCompetition']], prevented: false });

    const settings = keyboard({ settings: true, view: 'waterfall' });
    assert.deepEqual(settings('ArrowDown'), { calls: [], prevented: false });
    assert.deepEqual(settings('Escape'), { calls: [['closeSettings']], prevented: false });
});

test('typing in preview or waterfall controls suppresses shortcuts but Escape closes preview', () => {
    const typing = { target: { editable: true } };
    const preview = keyboard({ preview: true });
    for (const key of ['f', 'd', 'x', 'Delete', 'ArrowLeft', '+']) {
        assert.deepEqual(preview(key, typing), { calls: [], prevented: false });
    }
    assert.deepEqual(preview('Escape', typing), { calls: [['closeModal']], prevented: false });

    const waterfall = keyboard({ view: 'waterfall' });
    for (const key of ['ArrowDown', 'ArrowUp', ' ']) {
        assert.deepEqual(waterfall(key, typing), { calls: [], prevented: false });
    }
});

test('favorite and delete shortcuts take precedence over tags and suppress held keys', () => {
    const preview = keyboard({ preview: true });
    assert.deepEqual(preview('F'), { calls: [['favorite', true]], prevented: true });
    assert.deepEqual(preview('d'), { calls: [['deleteCurrentImage']], prevented: true });
    for (const key of ['f', 'd']) {
        assert.deepEqual(preview(key, { repeat: true }), { calls: [], prevented: true });
    }
    assert.deepEqual(preview('x'), { calls: [['tag', '标签', true, true]], prevented: true });
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
        for (const key of ['f', 'd', 'x']) {
            assert.deepEqual(preview(key, { [modifier]: true }), { calls: [], prevented: false });
        }
    }
});

test('waterfall paging suppresses repeated actions and modified spaces', () => {
    const waterfall = keyboard({ view: 'waterfall' });
    for (const key of ['ArrowDown', ' ']) {
        assert.deepEqual(waterfall(key), { calls: [['advanceWaterfallPage']], prevented: true });
        assert.deepEqual(waterfall(key, { repeat: true }), { calls: [], prevented: true });
    }
    assert.deepEqual(waterfall('ArrowUp'), { calls: [['restorePreviousWaterfallPage']], prevented: true });
    assert.deepEqual(waterfall('ArrowUp', { repeat: true }), { calls: [], prevented: true });
    assert.deepEqual(waterfall('Unidentified', { code: 'Space' }), { calls: [['advanceWaterfallPage']], prevented: true });
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
        assert.deepEqual(waterfall(' ', { [modifier]: true }), { calls: [], prevented: false });
    }
    assert.deepEqual(keyboard()('ArrowDown'), { calls: [], prevented: false });
});

test('fullscreen shortcuts stay in waterfall and respect typing, modifiers and modal priority', () => {
    const waterfall = keyboard({ view: 'waterfall' });
    assert.deepEqual(waterfall('f'), { calls: [['toggleWaterfallFullscreen']], prevented: true });
    assert.deepEqual(waterfall('F'), { calls: [['toggleWaterfallFullscreen']], prevented: true });
    assert.deepEqual(waterfall('f', { repeat: true }), { calls: [], prevented: true });
    assert.deepEqual(waterfall('Escape'), { calls: [['exitWaterfallFullscreen']], prevented: true });
    assert.deepEqual(waterfall('f', { target: { editable: true } }), { calls: [], prevented: false });
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
        assert.deepEqual(waterfall('f', { [modifier]: true }), { calls: [], prevented: false });
    }
    assert.deepEqual(keyboard()('f'), { calls: [], prevented: false });
    assert.deepEqual(keyboard({ preview: true, view: 'waterfall' })('f'), {
        calls: [['favorite', true]], prevented: true
    });
});
