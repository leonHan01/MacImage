const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const collectionModule = require('../image-collection');
const queryModule = require('../image-query');
const previewModule = require('../image-preview-state');
const ratingModel = require('../rating-model');

const noop = () => {};
const photos = ['A', 'B', 'C', 'D'].map(name => ({
    name: `${name}.jpg`, path: `/photos/${name}.jpg`, size: 100, tags: []
}));

function createElement() {
    const classes = new Set();
    const listeners = new Map();
    return {
        style: {},
        classList: {
            contains: name => classes.has(name),
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
        },
        setAttribute: noop,
        addEventListener: (type, listener) => listeners.set(type, listener),
        dispatch: (type, event = {}) => listeners.get(type)?.(event)
    };
}

function createRenderer(api = {}) {
    const collection = collectionModule.create(photos.map(photo => ({ ...photo })));
    const elements = Object.fromEntries([
        'imageModal', 'modalImage', 'modalFilename', 'modalScore', 'modalImageIndex',
        'zoomLevel', 'modalTagList', 'deleteDuplicateImagesBtn'
    ].map(id => [id, createElement()]));
    const openedPaths = [];
    const context = vm.createContext({
        console, setTimeout, clearTimeout,
        imageCollection: collection, images: collection.items,
        imageQuery: queryModule.create({ collection, getRating: () => 1500 }),
        MacImagePreviewState: previewModule, MacImageRating: ratingModel,
        sortedImages: [...collection.items], currentSort: 'name-asc', currentViewMode: 'list',
        selectedFilterTags: [], filterNoTag: false, currentFolder: '/photos',
        duplicateGroups: [], duplicateScanCompleted: false,
        smallImageCandidates: [], smallImageScanCompleted: false, smallImageThresholdKb: 100,
        allTags: [], deleteHistory: [],
        imageModal: elements.imageModal,
        settingsModal: createElement(),
        document: { getElementById: id => elements[id], querySelector: () => null },
        toFileUrl: file => `file://${file}`,
        window: { electronAPI: { onDirectoryImageMetadata: noop, ...api } },
        confirm: () => true, alert: noop
    });
    for (const file of [
        'renderer-folders.js', 'renderer-gallery.js', 'renderer-modal.js',
        'renderer-duplicates.js', 'renderer-small-images.js', 'renderer-data-settings.js'
    ]) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    }
    // Keep the actual collection, sorting, modal rendering and membership-refresh
    // path; only unrelated gallery/settings DOM work is replaced.
    for (const name of [
        'cancelGalleryWork', 'updateImageGridViewClass', 'renderVirtualList', 'renderEmptyImageGrid',
        'renderTagFilter', 'updateImageCount', 'updateMigrateSourceFolder',
        'renderDuplicateResults', 'renderSmallImageResults', 'updateCompetitionLauncherState'
    ]) context[name] = noop;
    context.addRecentOpenFile = async imagePath => { openedPaths.push(imagePath); };
    return { context, collection, elements, openedPaths };
}

test('preview navigation and dragging share state without rebuilding the tag panel on zoom', () => {
    const { context, elements } = createRenderer();
    const image = elements.modalImage;
    let tagRenderCount = 0;
    context.renderModalTagList = () => { tagRenderCount++; };
    context.bindModalImageGestures();
    context.openImageModal(0, { closeOnImageClick: true });
    context.zoomIn();
    assert.equal(elements.zoomLevel.textContent, '125%');
    assert.equal(tagRenderCount, 1);

    image.dispatch('mousedown', { button: 0, clientX: 100, clientY: 100 });
    image.dispatch('mousemove', { clientX: 125, clientY: 150 });
    assert.equal(image.style.transform, 'scale(1.25) translate(20px, 40px)');
    image.dispatch('mouseup');
    image.dispatch('click');
    assert.equal(elements.imageModal.classList.contains('show'), true);

    context.showNextImage();
    assert.equal(image.src, 'file:///photos/B.jpg');
    assert.equal(image.style.transform, 'scale(1) translate(0px, 0px)');
    assert.equal(elements.zoomLevel.textContent, '100%');
    assert.equal(image.style.cursor, 'pointer');
    image.dispatch('click');
    assert.equal(context.getCurrentModalImage(), null);
    assert.equal(elements.imageModal.classList.contains('show'), false);
});

test('sorting preserves the previewed path and zoom while deleting the current image selects its neighbor', async () => {
    const deletedPaths = [];
    const { context, elements } = createRenderer({
        deleteImage: async originalPath => {
            deletedPaths.push(originalPath);
            return { success: true, originalPath, trashPath: `/trash/${path.basename(originalPath)}` };
        }
    });
    context.openImageModal(1);
    context.zoomIn();
    context.currentSort = 'name-desc';
    context.renderImages();
    assert.equal(elements.modalImage.src, 'file:///photos/B.jpg');
    assert.equal(elements.modalImageIndex.textContent, '3 / 4');
    assert.equal(elements.zoomLevel.textContent, '125%');

    await context.deleteCurrentImage();
    assert.deepEqual(deletedPaths, ['/photos/B.jpg']);
    assert.equal(elements.modalImage.src, 'file:///photos/A.jpg');
    assert.equal(elements.modalImageIndex.textContent, '3 / 3');
    assert.equal(elements.zoomLevel.textContent, '100%');
    assert.equal(context.deleteHistory[0].items[0].originalPath, '/photos/B.jpg');
});

for (const kind of ['duplicates', 'small images']) {
    test(`${kind} batch deletion retains the active preview when the user navigates during the request`, async () => {
        let finishDeletion;
        const { context, collection, elements } = createRenderer({
            deleteImages: () => new Promise(resolve => { finishDeletion = resolve; })
        });
        context.duplicateScanCompleted = true;
        context.duplicateGroups = [{ hash: 'same', images: collection.items.slice(0, 3) }];
        context.smallImageScanCompleted = true;
        context.smallImageCandidates = collection.items.slice(1, 3);
        context.openImageModal(1);

        const deleting = kind === 'duplicates'
            ? context.deleteDuplicateImagesDistinct()
            : context.deleteSmallImages();
        context.showNextImage();
        context.showNextImage();
        context.zoomIn();
        finishDeletion({
            success: true,
            deleted: [{ originalPath: '/photos/B.jpg', trashPath: '/trash/B.jpg' }],
            failures: [{ originalPath: '/photos/C.jpg', error: 'permission denied' }]
        });
        await deleting;

        assert.deepEqual(collection.items.map(image => image.path), ['/photos/A.jpg', '/photos/C.jpg', '/photos/D.jpg']);
        assert.equal(elements.modalImage.src, 'file:///photos/D.jpg');
        assert.equal(elements.modalImageIndex.textContent, '3 / 3');
        assert.equal(elements.zoomLevel.textContent, '125%');
    });
}

test('migration uses the same preview reconciliation and never reopens a closed preview', async () => {
    let finishMove;
    const { context, collection, elements, openedPaths } = createRenderer({
        moveTaggedImageToTarget: () => new Promise(resolve => { finishMove = resolve; })
    });
    context.openImageModal(1);
    const moving = context.moveNewlyTaggedImageToTarget('/photos/B.jpg');
    finishMove({ success: true, moved: true });
    await moving;
    assert.equal(elements.modalImage.src, 'file:///photos/C.jpg');
    assert.equal(openedPaths.at(-1), '/photos/C.jpg');

    const secondMove = context.moveNewlyTaggedImageToTarget('/photos/C.jpg');
    context.closeModal();
    finishMove({ success: true, moved: true });
    await secondMove;
    assert.equal(elements.imageModal.classList.contains('show'), false);
    assert.equal(context.getCurrentModalImage(), null);
    assert.deepEqual(collection.items.map(image => image.path), ['/photos/A.jpg', '/photos/D.jpg']);
});

test('removing the last visible image closes the preview even if filtered-out images remain', () => {
    const { context, collection, elements } = createRenderer();
    collection.applyMetadata({ path: '/photos/B.jpg', tags: ['keep'] });
    context.selectedFilterTags = ['keep'];
    context.renderImages();
    context.openImageModal(0);

    collection.remove('/photos/B.jpg');
    context.refreshAfterImageMembershipChange();

    assert.equal(collection.items.length, 3);
    assert.equal(elements.imageModal.classList.contains('show'), false);
    assert.equal(context.getCurrentModalImage(), null);
});
