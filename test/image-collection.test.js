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

test('metadata batches handle hash changes in order without repeatedly scanning every image', () => {
    let hashReads = 0;
    const collection = create(Array.from({ length: 1000 }, (_, index) => {
        let hash = `hash-${index}`;
        return {
            path: `/photos/${index}.jpg`,
            get hash() { hashReads++; return hash; },
            set hash(value) { hash = value; }
        };
    }));
    hashReads = 0;
    collection.applyMetadata(Array.from({ length: 100 }, (_, index) => ({
        path: `/photos/${index}.jpg`, hash: 'shared', tags: [`tag-${index}`]
    })));

    assert.deepEqual(collection.getTags(collection.items[0]), ['tag-99']);
    assert.deepEqual(collection.getTags(collection.items[99]), ['tag-99']);
    assert.ok(hashReads < 20000, `read hashes ${hashReads} times for 1000 images`);

    collection.applyMetadata([
        { path: '/photos/0.jpg', hash: null, tags: ['detached'] },
        { path: '/photos/1.jpg', tags: [] }
    ]);
    assert.deepEqual(collection.getTags(collection.items[0]), ['detached']);
    assert.deepEqual(collection.getTags(collection.items[2]), []);
});

test('large replacements and prepends keep the shared array and batch removal preserves order', () => {
    const collection = create();
    const items = collection.items;
    const largeBatch = Array.from({ length: 150000 }, (_, index) => ({ path: `/photos/${index}.jpg` }));
    collection.replace(largeBatch);
    assert.equal(collection.items, items);
    assert.equal(items.length, 150000);
    collection.replace([items[0]]);
    collection.prepend(largeBatch);
    assert.equal(items.length, 150000);
    assert.equal(items.at(-1).path, '/photos/0.jpg');
    const removed = collection.remove(['/photos/1.jpg', '/photos/3.jpg', '/photos/0.jpg']);
    assert.deepEqual(removed.map(image => image.path), ['/photos/1.jpg', '/photos/3.jpg', '/photos/0.jpg']);
    assert.equal(items[0].path, '/photos/2.jpg');
    assert.equal(items.length, 149997);
});

test('tag counts share one scan and stay current across collection changes', () => {
    let reads = 0;
    const collection = create([
        { path: '/a', hash: 'same', get tags() { reads++; return ['red', 'red']; }, set tags(value) {
            Object.defineProperty(this, 'tags', { value, writable: true, configurable: true });
        } },
        { path: '/b', hash: 'same' },
        { path: '/c' }
    ]);
    assert.equal(collection.getTagCount('red'), 2);
    const readsAfterCount = reads;
    assert.equal(collection.getTagCount('missing'), 0);
    assert.equal(collection.getUntaggedCount(), 1);
    assert.equal(reads, readsAfterCount);

    collection.applyMetadata({ path: '/a', tags: ['blue'] });
    assert.equal(collection.getTagCount('red'), 0);
    assert.equal(collection.getTagCount('blue'), 2);
    collection.renameTag('blue', 'green');
    assert.equal(collection.getTagCount('blue'), 0);
    assert.equal(collection.getTagCount('green'), 2);
    collection.removeTag('green');
    assert.equal(collection.getUntaggedCount(), 3);
    collection.prepend([{ path: '/d', tags: ['new'] }]);
    assert.equal(collection.getTagCount('new'), 1);
    collection.remove('/d');
    assert.equal(collection.getTagCount('new'), 0);
    collection.replace([]);
    assert.equal(collection.getUntaggedCount(), 0);
});
