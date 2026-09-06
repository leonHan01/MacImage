const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createImageLibrary } = require('../image-library');

function createLibrary(store, overrides = {}) {
    return createImageLibrary({
        store,
        nativeImage: { createThumbnailFromPath: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png') }) },
        thumbnailCacheDir: '/tmp/macimage-library-test-cache',
        hashFile: async imagePath => `hash:${path.basename(imagePath)}`,
        hashFullFile: async imagePath => `full:${path.basename(imagePath)}`,
        logger: { error: () => {} },
        ...overrides
    });
}

test('reads cached directory metadata through one interface', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macimage-library-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const imagePath = path.join(directory, 'one.jpg');
    fs.writeFileSync(imagePath, 'image');
    const stats = fs.statSync(imagePath);
    const hash = 'a'.repeat(64);
    const queriedHashes = [];
    const store = {
        getPathHashesForDirectory: () => ({
            [imagePath]: { hash, size: stats.size, mtimeMs: stats.mtimeMs }
        }),
        getImageMetadataForHashes: (hashes) => {
            queriedHashes.push(...hashes);
            return {
                [hash]: {
                    tags: ['favorite'],
                    score: { rating: 1520, wins: 1, matches: 2 }
                }
            };
        }
    };
    const library = createLibrary(store, { thumbnailCacheDir: path.join(directory, 'cache') });

    const records = await library.readDirectory(directory);

    assert.deepEqual(queriedHashes, [hash]);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tags, ['favorite']);
    assert.deepEqual(records[0].score, { rating: 1520, wins: 1, matches: 2 });
});

test('hydrates missing hashes in the background and publishes one metadata change', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macimage-library-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const imagePath = path.join(directory, 'new.jpg');
    fs.writeFileSync(imagePath, 'new-image');
    let storedPathHashes;
    let publishMetadata;
    const metadataPublished = new Promise(resolve => { publishMetadata = resolve; });
    const library = createLibrary({
        getPathHashesForDirectory: () => ({}),
        getImageMetadataForHashes: () => ({}),
        getImageMetadata: () => ({
            tags: ['后台标签'],
            score: { rating: 1530, wins: 2, matches: 3 }
        }),
        setPathHashes: values => { storedPathHashes = values; }
    }, { thumbnailCacheDir: path.join(directory, 'cache') });

    const records = await library.readDirectory(directory, {
        onMetadata: updates => publishMetadata(updates)
    });
    const updates = await metadataPublished;

    assert.equal(records[0].hash, null);
    assert.deepEqual(updates, [{
        path: imagePath,
        hash: 'hash:new.jpg',
        tags: ['后台标签'],
        score: { rating: 1530, wins: 2, matches: 3 }
    }]);
    assert.equal(storedPathHashes[imagePath].hash, 'hash:new.jpg');
});

test('full hashes only candidates that share a file size', async () => {
    const hashedPaths = [];
    const library = createLibrary({
        getPathHash: () => null
    }, {
        hashFullFile: async imagePath => {
            hashedPaths.push(imagePath);
            return 'same-full-hash';
        }
    });

    const result = await library.findDuplicates([
        { path: '/photos/original.jpg', size: 10, hash: 'fast-a' },
        { path: '/photos/copy.jpg', size: 10, hash: 'fast-a' },
        { path: '/photos/unique.jpg', size: 11, hash: 'fast-b' }
    ]);

    assert.deepEqual(hashedPaths.sort(), ['/photos/copy.jpg', '/photos/original.jpg']);
    assert.deepEqual(result.groups, [{
        hash: 'same-full-hash',
        paths: ['/photos/original.jpg', '/photos/copy.jpg']
    }]);
});
