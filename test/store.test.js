const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { mkdtemp, rm } = fs.promises;
const { test } = require('node:test');

const Store = require('../store');

const TEMP_ROOT = path.join('/private/tmp', 'macimage-store-');

test('update applies changes to the latest stored map', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    const store = new Store(path.join(tempDir, 'store.sqlite'));
    try {
        store.set('preferencesByName', { first: 'value-1' });
        const staleSnapshot = { ...store.get('preferencesByName') };
        store.set('preferencesByName', { ...staleSnapshot, hydration: 'value-2' });

        store.update('preferencesByName', (current) => ({
            ...current,
            calculated: 'value-3'
        }));

        assert.deepEqual(store.get('preferencesByName'), {
            first: 'value-1',
            hydration: 'value-2',
            calculated: 'value-3'
        });
    } finally {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('migrates aggregate image metadata into normalized SQLite tables', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    const databasePath = path.join(tempDir, 'store.sqlite');
    const imagePath = path.join(tempDir, 'photos', 'one.jpg');
    const hash = 'hash-one';
    const legacyDatabase = new DatabaseSync(databasePath);
    try {
        legacyDatabase.exec(`
            CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE store_values (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
        const insert = legacyDatabase.prepare('INSERT INTO store_values (key, value, updated_at) VALUES (?, ?, ?)');
        insert.run('pathToHash', JSON.stringify({
            [imagePath]: { hash, size: 42, mtimeMs: 1234 }
        }), Date.now());
        insert.run('imageTagsByHash', JSON.stringify({
            [hash]: ['favorite', 'landscape']
        }), Date.now());
        insert.run('imageScoresByHash', JSON.stringify({
            [hash]: { rating: 1612, wins: 4, matches: 7 }
        }), Date.now());
    } finally {
        legacyDatabase.close();
    }

    const store = new Store(databasePath);
    try {
        assert.deepEqual(store.getPathHash(imagePath), {
            hash,
            size: 42,
            mtimeMs: 1234
        });
        assert.deepEqual(store.getImageMetadata(hash), {
            tags: ['favorite', 'landscape'],
            score: { rating: 1612, wins: 4, matches: 7 }
        });
        assert.equal(store.get('pathToHash'), undefined);
        assert.equal(store.get('imageTagsByHash'), undefined);
        assert.equal(store.get('imageScoresByHash'), undefined);
    } finally {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('updates individual image metadata without recreating aggregate maps', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    const store = new Store(path.join(tempDir, 'store.sqlite'));
    const firstPath = path.join(tempDir, 'photos', 'first.jpg');
    const movedPath = path.join(tempDir, 'archive', 'first.jpg');
    try {
        store.setPathHashes({
            [firstPath]: { hash: 'hash-first', size: 10, mtimeMs: 100 },
            [path.join(tempDir, 'photos', 'second.jpg')]: { hash: 'hash-second', size: 20, mtimeMs: 200 }
        });
        store.addImageTag('hash-first', 'favorite');
        store.addImageTag('hash-first', 'portrait');
        store.removeImageTag('hash-first', 'portrait');
        store.setImageScores({
            'hash-first': { rating: 1520, wins: 1, matches: 2 }
        });
        store.movePathHashes([{ fromPath: firstPath, toPath: movedPath }]);

        assert.equal(store.getPathHash(firstPath), null);
        assert.deepEqual(store.getPathHash(movedPath), {
            hash: 'hash-first',
            size: 10,
            mtimeMs: 100
        });
        assert.deepEqual(store.getImageTags('hash-first'), ['favorite']);
        assert.deepEqual(store.getImageScore('hash-first'), { rating: 1520, wins: 1, matches: 2 });
        assert.throws(
            () => store.set('pathToHash', {}),
            /must use the normalized metadata APIs/
        );
        assert.equal(store.get('pathToHash'), undefined);
        assert.equal(store.get('imageTagsByHash'), undefined);
        assert.equal(store.get('imageScoresByHash'), undefined);
    } finally {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
    }
});
