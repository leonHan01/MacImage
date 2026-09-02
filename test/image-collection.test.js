const assert = require('node:assert/strict');
const { test } = require('node:test');

const { create } = require('../image-collection');

test('replaces images while rebuilding metadata indexes', () => {
    const collection = create();

    collection.replace([
        { path: '/photos/a.jpg', hash: 'same', tags: ['红心'], score: { rating: 1510 } },
        { path: '/photos/b.jpg', hash: 'same', tags: ['红心'], score: { rating: 1510 } }
    ]);

    assert.equal(collection.items.length, 2);
    assert.deepEqual(collection.getTags(collection.items[0]), ['红心']);
    assert.deepEqual(collection.getScore(collection.items[1]), { rating: 1510 });
});

test('removing one duplicate keeps metadata indexed by the remaining image', () => {
    const collection = create([
        { path: '/photos/a.jpg', hash: 'same', tags: ['保留'] },
        { path: '/photos/b.jpg', hash: 'same', tags: ['保留'] }
    ]);

    const removed = collection.remove('/photos/a.jpg');

    assert.deepEqual(removed.map(image => image.path), ['/photos/a.jpg']);
    assert.deepEqual(collection.items.map(image => image.path), ['/photos/b.jpg']);
    assert.deepEqual(collection.getTags(collection.items[0]), ['保留']);
});

test('metadata changes apply to every image with the same content hash', () => {
    const collection = create([
        { path: '/photos/a.jpg', hash: 'same', tags: [] },
        { path: '/photos/b.jpg', hash: 'same', tags: [] }
    ]);

    assert.equal(collection.applyMetadata({
        path: '/photos/a.jpg',
        tags: ['共享标签']
    }), 2);

    assert.deepEqual(collection.getTags(collection.items[1]), ['共享标签']);
});

test('applies metadata batches and restores unique images at the front', () => {
    const collection = create([{ path: '/photos/a.jpg', tags: [] }]);

    assert.equal(collection.applyMetadata({
        path: '/photos/a.jpg',
        hash: 'hash-a',
        tags: ['新标签'],
        score: { rating: 1520, wins: 1, matches: 1 }
    }), 1);
    assert.deepEqual(collection.getTags(collection.items[0]), ['新标签']);

    collection.prepend([
        { path: '/photos/b.jpg', hash: 'hash-b' },
        { path: '/photos/b.jpg', hash: 'duplicate-addition' },
        { path: '/photos/a.jpg', hash: 'duplicate-path' }
    ]);
    assert.deepEqual(collection.items.map(image => image.path), [
        '/photos/b.jpg',
        '/photos/a.jpg'
    ]);
});

test('renames a tag across duplicate images without creating duplicates', () => {
    const collection = create([
        { path: '/photos/a.jpg', hash: 'same', tags: ['旧名称', '新名称'] },
        { path: '/photos/b.jpg', hash: 'same', tags: ['旧名称', '新名称'] }
    ]);

    assert.equal(collection.renameTag('旧名称', '新名称'), 2);
    assert.deepEqual(collection.getTags(collection.items[0]), ['新名称']);
    assert.deepEqual(collection.getTags(collection.items[1]), ['新名称']);
});
