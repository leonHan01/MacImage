const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const registerIpcHandlers = require('../main-ipc-handlers');

async function mapWithConcurrency(items, concurrency, mapper) {
    return Promise.all(items.map(mapper));
}

function registerTestHandlers(store, overrides = {}) {
    const handlers = {};
    const ipcMain = { handle: (name, handler) => { handlers[name] = handler; } };
    registerIpcHandlers({
        ipcMain,
        dialog: {},
        shell: {},
        path,
        fsp: fs.promises,
        getMainWindow: () => null,
        getStore: () => store,
        getImageEntries: overrides.getImageEntries || (async () => []),
        getImageRecord: overrides.getImageRecord || (async () => null),
        hydrateImageRecord: overrides.hydrateImageRecord || (async () => null),
        mapWithConcurrency,
        getOrCreateImageHash: async imagePath => `hash:${path.basename(imagePath)}`,
        getCachedThumbnail: async () => ({ success: true, dataUrl: 'thumbnail' }),
        getCachedPreview: overrides.getCachedPreview,
        calculateFullFileHash: async () => 'full-hash',
        getAvailablePath: async filePath => filePath,
        reserveAvailablePath: async filePath => filePath,
        getTimestampedPath: async filePath => filePath,
        getNumberedPath: async filePath => filePath,
        moveFileSafely: async () => {},
        pathExists: async () => false,
        moveHashMapping: () => {},
        moveHashMappings: () => {},
        imageScanConcurrency: 2,
        getServerDownloadDirectory: () => '/tmp'
    });
    return handlers;
}

test('directory IPC queries and returns metadata for the current folder only', async () => {
    const queriedDirectories = [];
    const queriedHashes = [];
    const store = {
        getPathHashesForDirectory: (directory) => {
            queriedDirectories.push(directory);
            return {
                '/photos/one.jpg': { hash: 'hash-one', size: 10, mtimeMs: 100 }
            };
        },
        getImageMetadataForHashes: (hashes) => {
            queriedHashes.push(...hashes);
            return {
                'hash-one': {
                    tags: ['favorite'],
                    score: { rating: 1520, wins: 1, matches: 2 }
                }
            };
        }
    };
    const handlers = registerTestHandlers(store, {
        getImageEntries: async () => [{ name: 'one.jpg' }],
        getImageRecord: async (directory, name, pathHashes) => ({
            name,
            path: path.join(directory, name),
            hash: pathHashes[path.join(directory, name)].hash,
            tags: [],
            score: null
        })
    });

    const result = await handlers['read-directory']({ sender: { isDestroyed: () => false } }, '/photos');

    assert.deepEqual(queriedDirectories, ['/photos']);
    assert.deepEqual(queriedHashes, ['hash-one']);
    assert.deepEqual(result[0].tags, ['favorite']);
    assert.deepEqual(result[0].score, { rating: 1520, wins: 1, matches: 2 });
});

test('preview IPC returns a cache file path without embedding image bytes', async () => {
    let request = null;
    const handlers = registerTestHandlers({}, {
        getCachedPreview: async (imagePath, size) => {
            request = { imagePath, size };
            return { success: true, filePath: '/cache/hash-preview-1600.png', cached: true };
        }
    });

    const result = await handlers['get-preview']({}, '/photos/one.jpg', 1600);

    assert.deepEqual(request, { imagePath: '/photos/one.jpg', size: 1600 });
    assert.deepEqual(result, {
        success: true,
        filePath: '/cache/hash-preview-1600.png',
        cached: true
    });
    assert.equal('dataUrl' in result, false);
});

test('competition IPC writes and returns only changed score records', async () => {
    const scores = new Map([
        ['hash:winner.jpg', { rating: 1500, wins: 0, matches: 0 }],
        ['hash:loser.jpg', { rating: 1500, wins: 0, matches: 0 }]
    ]);
    const written = [];
    const store = {
        getImageScore: hash => scores.get(hash) || null,
        setImageScores: updates => {
            written.push(updates);
            Object.entries(updates).forEach(([hash, score]) => scores.set(hash, score));
        }
    };
    const handlers = registerTestHandlers(store);

    const result = await handlers['record-competition-group-result'](
        {},
        '/photos/winner.jpg',
        ['/photos/loser.jpg']
    );

    assert.equal(result.success, true);
    assert.equal('scores' in result, false);
    assert.deepEqual(Object.keys(written[0]).sort(), ['hash:loser.jpg', 'hash:winner.jpg']);
    assert.equal(result.winner.record.wins, 1);
    assert.equal(result.losers[0].record.matches, 1);
});

test('does not register global image metadata snapshot IPC handlers', () => {
    const handlers = registerTestHandlers({});

    assert.equal(handlers['get-image-tags'], undefined);
    assert.equal(handlers['get-image-scores'], undefined);
});
