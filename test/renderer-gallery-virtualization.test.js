const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function loadGallery(globals = {}) {
    const context = vm.createContext({
        galleryRenderVersion: 1,
        currentViewMode: 'grid',
        gridVirtualState: null,
        listVirtualState: null,
        GRID_MIN_CARD_WIDTH: 168,
        GRID_GAP: 14,
        GRID_PADDING: 14,
        GRID_OVERSCAN_ROWS: 2,
        LIST_ROW_HEIGHT: 60,
        LIST_OVERSCAN_ROWS: 8,
        sortedImages: Array.from({ length: 100 }, (_, index) => ({ path: `/photos/${index}.jpg` })),
        imageGrid: { clientWidth: 560, clientHeight: 540, scrollTop: 0 },
        ...globals
    });
    vm.runInContext(fs.readFileSync('renderer-gallery.js', 'utf8'), context);
    return context;
}

const windowCases = [
    { mode: 'grid', scrollTop: 0, height: 540, expected: [0, 15, 0, 7830] },
    { mode: 'grid', scrollTop: 2700, height: 540, expected: [24, 45, 2160, 5130] },
    { mode: 'grid', scrollTop: 8640, height: 540, expected: [90, 100, 8100, 0] },
    { mode: 'grid', scrollTop: 0, height: 0, expected: [0, 12, 0, 8100] },
    { mode: 'list', scrollTop: 0, height: 120, expected: [0, 11, 0, 5340] },
    { mode: 'list', scrollTop: 1200, height: 120, expected: [12, 31, 720, 4140] },
    { mode: 'list', scrollTop: 5880, height: 120, expected: [90, 100, 5400, 0] },
    { mode: 'list', scrollTop: 0, height: 0, expected: [0, 10, 0, 5400] }
];

for (const { mode, scrollTop, height, expected } of windowCases) {
    test(`${mode} renders the buffered window at scroll ${scrollTop} with height ${height}`, () => {
        const context = loadGallery({
            currentViewMode: mode,
            imageGrid: { clientWidth: 560, clientHeight: height, scrollTop }
        });
        let renderedWindow;
        const thumbnailVersions = [];
        context.renderVirtualWindow = window => { renderedWindow = window; };
        context.queueRenderedGridThumbnails = version => { thumbnailVersions.push(version); };

        context.refreshVirtualGridLayout();

        assert.deepEqual({ ...renderedWindow }, {
            mode,
            startIndex: expected[0],
            endIndex: expected[1],
            topSpacer: expected[2],
            bottomSpacer: expected[3]
        });
        assert.deepEqual(thumbnailVersions, mode === 'grid' ? [1] : []);
    });
}

test('outdated render callbacks and inactive views leave the virtual window untouched', () => {
    const context = loadGallery();
    context.gridVirtualState = context.calculateGridVirtualState(100);
    context.listVirtualState = context.calculateListVirtualState(100);
    context.renderVirtualWindow = () => assert.fail('an inactive render updated the window');
    context.queueRenderedGridThumbnails = () => assert.fail('an inactive render queued thumbnails');

    context.renderVisibleGridItems(0);
    context.renderVisibleListItems(1);
    context.currentViewMode = 'list';
    context.renderVisibleGridItems(1);
    context.renderVisibleListItems(0);
});

class FakeElement {
    constructor() {
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
    }

    get previousSibling() {
        const siblings = this.parentNode?.children || [];
        return siblings[siblings.indexOf(this) - 1] || null;
    }

    get nextSibling() {
        const siblings = this.parentNode?.children || [];
        return siblings[siblings.indexOf(this) + 1] || null;
    }

    setAttribute() {}

    remove() {
        if (!this.parentNode) return;
        this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }

    replaceChildren(...nodes) {
        this.children.forEach(node => { node.parentNode = null; });
        this.children = [];
        nodes.forEach(node => this.insertBefore(node, null));
    }

    insertBefore(node, reference) {
        node.remove();
        const index = reference ? this.children.indexOf(reference) : this.children.length;
        assert.notEqual(index, -1, 'the insertion reference must belong to the container');
        this.children.splice(index, 0, node);
        node.parentNode = this;
    }
}

test('scrolling reuses item nodes, preserves overlaps and keeps items between the spacers', () => {
    const imageGrid = new FakeElement();
    let createdNodes = 0;
    const context = loadGallery({
        imageGrid,
        document: {
            createElement: () => { createdNodes++; return new FakeElement(); }
        }
    });
    context.renderImageRowContent = img => img.path;
    const render = (startIndex, endIndex, topSpacer = 0) => {
        context.renderVirtualWindow({ mode: 'list', startIndex, endIndex, topSpacer, bottomSpacer: 100 });
    };
    const itemNodes = () => imageGrid.children.slice(1, -1);
    const assertVisibleItems = indexes => {
        assert.deepEqual(itemNodes().map(node => Number(node.dataset.index)), indexes);
        itemNodes().forEach(node => {
            assert.equal(node.innerHTML, `/photos/${node.dataset.index}.jpg`);
            assert.equal(node.dataset.path, node.innerHTML);
        });
    };

    render(0, 4);
    const originalItems = itemNodes();
    const topSpacer = imageGrid.children[0];
    const bottomSpacer = imageGrid.children.at(-1);

    render(2, 6, 120);
    assertVisibleItems([2, 3, 4, 5]);
    assert.equal(itemNodes()[0], originalItems[2]);
    assert.equal(itemNodes()[1], originalItems[3]);
    assert.equal(createdNodes, 6);
    assert.equal(imageGrid.children[0], topSpacer);
    assert.equal(imageGrid.children.at(-1), bottomSpacer);

    render(0, 4);
    assertVisibleItems([0, 1, 2, 3]);
    render(1, 3);
    assertVisibleItems([1, 2]);
    render(6, 10);
    assertVisibleItems([6, 7, 8, 9]);
    assert.equal(createdNodes, 6);

    const unchangedItems = itemNodes();
    render(6, 10, 360);
    assert.deepEqual(itemNodes(), unchangedItems);
    assert.equal(topSpacer.style.height, '360px');
    assert.equal(bottomSpacer.style.height, '100px');
});
