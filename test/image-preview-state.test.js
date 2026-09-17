const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { create } = require('../image-preview-state');

const images = [
    { path: '/photos/a.jpg' },
    { path: '/photos/b.jpg' },
    { path: '/photos/c.jpg' }
];
const initialState = {
    index: -1,
    imagePath: null,
    zoom: 1,
    translateX: 0,
    translateY: 0,
    isDragging: false
};

function assertSnapshot(preview, expected = {}) {
    assert.deepEqual(preview.snapshot(), { ...initialState, ...expected });
}

function zoomAndDrag(preview) {
    preview.zoomBy(2);
    preview.startDrag(10, 20);
    preview.dragTo(50, 80);
}

test('preview instances start closed and snapshots cannot mutate their state', () => {
    const preview = create();
    assert.equal(Object.isFrozen(preview), true);
    assertSnapshot(preview);
    const snapshot = preview.snapshot();
    snapshot.index = 2;
    snapshot.zoom = 5;
    assertSnapshot(preview);
    assert.notEqual(preview.snapshot(), preview.snapshot());

    preview.select(images, 0);
    assertSnapshot(create());
});

test('the browser export exposes the same independent preview factory', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync('image-preview-state.js', 'utf8'), context);
    const preview = context.MacImagePreviewState.create();
    assert.deepEqual({ ...preview.snapshot() }, initialState);
    assert.equal(preview.select(images, 1), true);
    assert.equal(preview.snapshot().imagePath, images[1].path);
});

test('selecting an image resets zoom, translation and an active drag', () => {
    const preview = create();
    preview.select(images, 0);
    zoomAndDrag(preview);

    assert.equal(preview.select(images, 1), true);
    assertSnapshot(preview, { index: 1, imagePath: images[1].path });
    assert.equal(preview.dragTo(100, 100), false);
});

test('invalid selections leave the selected image and its transform untouched', () => {
    const preview = create();
    preview.select(images, 1);
    zoomAndDrag(preview);
    const before = preview.snapshot();

    for (const index of [-1, images.length, 1.5, '1', NaN]) {
        assert.equal(preview.select(images, index), false);
        assert.deepEqual(preview.snapshot(), before);
    }
    assert.equal(preview.select([], 0), false);
    assert.deepEqual(preview.snapshot(), before);
});

test('reconciling a reordered list retains the selected path and transform', () => {
    const preview = create();
    preview.select(images, 1);
    zoomAndDrag(preview);
    const before = preview.snapshot();

    assert.equal(preview.reconcile([{ ...images[1] }, images[2]]), true);
    assert.deepEqual(preview.snapshot(), { ...before, index: 0 });
});

test('removing the current image selects its successor at the old index', () => {
    const preview = create();
    preview.select(images, 1);
    zoomAndDrag(preview);

    assert.equal(preview.reconcile([images[0], images[2]]), true);
    assertSnapshot(preview, { index: 1, imagePath: images[2].path });
});

test('removing the last image clamps the selection to the new final image', () => {
    const preview = create();
    preview.select(images, 2);
    zoomAndDrag(preview);

    assert.equal(preview.reconcile([images[0]]), true);
    assertSnapshot(preview, { index: 0, imagePath: images[0].path });
});

test('filtering to an empty list closes the preview and does not reopen it later', () => {
    const preview = create();
    assert.equal(preview.reconcile(images), false);
    preview.select(images, 1);
    zoomAndDrag(preview);

    assert.equal(preview.reconcile([]), false);
    assertSnapshot(preview);
    assert.equal(preview.reconcile(images), false);
    assertSnapshot(preview);
});

test('navigation resets the transform only when the destination exists', () => {
    const preview = create();
    preview.select(images, 0);
    zoomAndDrag(preview);
    const atStart = preview.snapshot();

    assert.equal(preview.move(images, -1), false);
    assert.deepEqual(preview.snapshot(), atStart);
    assert.equal(preview.move(images, 1), true);
    assertSnapshot(preview, { index: 1, imagePath: images[1].path });
    assert.equal(preview.move(images, 1), true);
    zoomAndDrag(preview);
    const atEnd = preview.snapshot();
    assert.equal(preview.move(images, 1), false);
    assert.deepEqual(preview.snapshot(), atEnd);
    assert.equal(preview.move(images, -1), true);
    assertSnapshot(preview, { index: 1, imagePath: images[1].path });
});

test('zoom stays between a quarter and five times the original size', () => {
    const preview = create();
    preview.zoomBy(1.25);
    assert.equal(preview.snapshot().zoom, 1.25);
    preview.zoomBy(100);
    assert.equal(preview.snapshot().zoom, 5);
    preview.zoomBy(100);
    assert.equal(preview.snapshot().zoom, 5);
    preview.zoomBy(0.001);
    assert.equal(preview.snapshot().zoom, 0.25);
    preview.zoomBy(0.5);
    assert.equal(preview.snapshot().zoom, 0.25);
});

test('dragging accounts for zoom and resumes from the existing translation', () => {
    const preview = create();
    assert.equal(preview.startDrag(10, 20), false);
    preview.zoomBy(2);
    assert.equal(preview.dragTo(50, 80), false);
    assert.equal(preview.startDrag(10, 20), true);
    assert.equal(preview.dragTo(50, 80), true);
    assertSnapshot(preview, { zoom: 2, translateX: 20, translateY: 30, isDragging: true });

    preview.endDrag();
    assert.equal(preview.dragTo(100, 100), false);
    preview.zoomBy(2);
    assert.equal(preview.startDrag(100, 120), true);
    assert.equal(preview.dragTo(80, 160), true);
    assertSnapshot(preview, { zoom: 4, translateX: 15, translateY: 40, isDragging: true });
});

test('zooming back to original size or below clears translation and blocks dragging', () => {
    for (const factor of [0.5, 0.25]) {
        const preview = create();
        zoomAndDrag(preview);
        preview.zoomBy(factor);
        assert.equal(preview.snapshot().zoom, 2 * factor);
        assert.equal(preview.snapshot().translateX, 0);
        assert.equal(preview.snapshot().translateY, 0);
        assert.equal(preview.dragTo(100, 100), false);
        assert.equal(preview.startDrag(100, 100), false);
    }
});

test('resetting the transform and closing both cancel an active drag', () => {
    const preview = create();
    preview.select(images, 1);
    zoomAndDrag(preview);
    preview.resetTransform();
    assertSnapshot(preview, { index: 1, imagePath: images[1].path });
    preview.zoomBy(2);
    assert.equal(preview.dragTo(100, 100), false);

    zoomAndDrag(preview);
    preview.close();
    assertSnapshot(preview);
    preview.zoomBy(2);
    assert.equal(preview.dragTo(100, 100), false);
});
