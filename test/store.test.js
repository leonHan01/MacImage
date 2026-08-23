const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtemp, rm } = fs.promises;
const { test } = require('node:test');

const Store = require('../store');

const TEMP_ROOT = path.join('/private/tmp', 'macimage-store-');

test('update applies changes to the latest stored map', async () => {
    const tempDir = await mkdtemp(TEMP_ROOT);
    const store = new Store(path.join(tempDir, 'store.sqlite'));
    try {
        store.set('pathToHash', { first: 'hash-1' });
        const staleSnapshot = { ...store.get('pathToHash') };
        store.set('pathToHash', { ...staleSnapshot, hydration: 'hash-2' });

        store.update('pathToHash', (current) => ({
            ...current,
            calculated: 'hash-3'
        }));

        assert.deepEqual(store.get('pathToHash'), {
            first: 'hash-1',
            hydration: 'hash-2',
            calculated: 'hash-3'
        });
    } finally {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
    }
});
