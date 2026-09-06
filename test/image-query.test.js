const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create: createCollection } = require('../image-collection');
const { create: createQuery } = require('../image-query');
const ratingModel = require('../rating-model');

function setup(images, random) {
    const collection = createCollection(images);
    const query = createQuery({
        collection,
        getRating: image => ratingModel.normalize(collection.getScore(image)).rating,
        random
    });
    return { collection, query };
}

function names(images) {
    return images.map(image => image.name);
}

test('filters by every selected tag and supports untagged images', () => {
    const { collection, query } = setup([
        { path: '/a.jpg', name: 'a', tags: ['红心', '风景'] },
        { path: '/b.jpg', name: 'b', tags: ['红心'] },
        { path: '/c.jpg', name: 'c' }
    ]);

    assert.equal(query.filter(), collection.items);
    assert.deepEqual(names(query.filter({ tags: ['红心'] })), ['a', 'b']);
    assert.deepEqual(names(query.filter({ tags: ['红心', '风景'] })), ['a']);
    assert.deepEqual(names(query.filter({ untaggedOnly: true })), ['c']);
    assert.deepEqual(query.filter({ tags: ['红心'], untaggedOnly: true }), []);
    assert.deepEqual(names(collection.items), ['a', 'b', 'c']);
});

test('sorts every supported field in both directions without changing the collection', () => {
    const { collection, query } = setup([
        { path: '/b.jpg', name: 'b', size: 10, modifiedTime: '2026-01-03', score: 20 },
        { path: '/a.jpg', name: 'a', size: 30, modifiedTime: '2026-01-01', score: null },
        { path: '/c.jpg', name: 'c', size: 20, modifiedTime: '2026-01-02', score: { rating: 1600 } }
    ]);

    const ascending = {
        name: ['a', 'b', 'c'],
        size: ['b', 'c', 'a'],
        date: ['a', 'c', 'b'],
        score: ['a', 'b', 'c']
    };
    for (const [field, expected] of Object.entries(ascending)) {
        assert.deepEqual(names(query.sort(collection.items, `${field}-asc`)), expected);
        assert.deepEqual(names(query.sort(collection.items, `${field}-desc`)), [...expected].reverse());
    }
    assert.deepEqual(names(collection.items), ['b', 'a', 'c']);
    assert.deepEqual(query.sort([], 'name-asc'), []);
});

test('queries use current shared metadata after tags and scores change', () => {
    const { collection, query } = setup([
        { path: '/a.jpg', name: 'a', hash: 'same' },
        { path: '/b.jpg', name: 'b', hash: 'same' },
        { path: '/c.jpg', name: 'c', hash: 'other', score: { rating: 1600 } }
    ]);

    assert.deepEqual(query.filter({ tags: ['红心'] }), []);
    collection.applyMetadata({ path: '/a.jpg', tags: ['红心'], score: { rating: 1700 } });
    assert.deepEqual(names(query.filter({ tags: ['红心'] })), ['a', 'b']);
    assert.deepEqual(names(query.sort(collection.items, 'score-desc')), ['a', 'b', 'c']);

    collection.replace([{ path: '/new.jpg', name: 'new', tags: ['红心'] }]);
    assert.deepEqual(names(query.filter({ tags: ['红心'] })), ['new']);
});

test('random order stays stable across filtering and metadata refreshes', () => {
    const ranks = [0.8, 0.2, 0.5];
    const { collection, query } = setup([
        { path: '/a.jpg', name: 'a', tags: ['红心'] },
        { path: '/b.jpg', name: 'b' },
        { path: '/c.jpg', name: 'c', tags: ['红心'] }
    ], () => ranks.shift());

    assert.deepEqual(names(query.sort(query.filter(), 'random')), ['b', 'c', 'a']);
    assert.deepEqual(names(query.sort(query.filter({ tags: ['红心'] }), 'random')), ['c', 'a']);
    collection.applyMetadata({ path: '/b.jpg', tags: ['红心'], score: 10 });
    assert.deepEqual(names(query.sort(query.filter({ tags: ['红心'] }), 'random')), ['b', 'c', 'a']);
    assert.deepEqual(names(query.sort(query.filter(), 'random')), ['b', 'c', 'a']);
});

test('random order drops removed paths and can be explicitly reset', () => {
    const ranks = [0.8, 0.2, 0.1, 0.9, 0.3];
    const first = { path: '/a.jpg', name: 'a' };
    const { collection, query } = setup([first, { path: '/b.jpg', name: 'b' }], () => ranks.shift());

    assert.deepEqual(names(query.sort(query.filter(), 'random')), ['b', 'a']);
    collection.remove(first.path);
    assert.deepEqual(names(query.sort(query.filter(), 'random')), ['b']);
    collection.prepend([first]);
    assert.deepEqual(names(query.sort(query.filter(), 'random')), ['a', 'b']);
    query.resetRandomOrder();
    assert.deepEqual(names(query.sort(query.filter(), 'random')), ['b', 'a']);
});

test('equal random ranks use the same Chinese filename ordering as name sort', () => {
    const { collection, query } = setup([
        { path: '/c.jpg', name: '中' },
        { path: '/a.jpg', name: '阿' },
        { path: '/b.jpg', name: '波' }
    ], () => 0.5);

    assert.deepEqual(names(query.sort(collection.items, 'random')), ['阿', '波', '中']);
});
