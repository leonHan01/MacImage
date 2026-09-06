const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const Store = require('../store');

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync('/private/tmp/macimage-store-transactions-');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function executeSql(filePath, sql) {
    const database = new DatabaseSync(filePath);
    try {
        database.exec(sql);
    } finally {
        database.close();
    }
}

test('legacy JSON is backed up and migrated once, including normalized image metadata', t => {
    const directory = temporaryDirectory(t);
    const databasePath = path.join(directory, 'store.sqlite');
    const legacyFilePath = path.join(directory, 'config.json');
    const backupFilePath = path.join(directory, 'original-config.bak');
    const imagePath = '/photos/one.jpg';
    const legacyContent = JSON.stringify({
        trashFolder: '/trash',
        pathToHash: { [imagePath]: 'legacy-hash', '/photos/invalid.jpg': { hash: '' } },
        imageTagsByHash: { 'legacy-hash': ['favorite', 'favorite', '', null] },
        imageScoresByHash: { 'legacy-hash': 7 }
    }, null, 2);
    fs.writeFileSync(legacyFilePath, legacyContent);

    let store = new Store(databasePath, { legacyFilePath, backupFilePath });
    try {
        assert.equal(fs.readFileSync(backupFilePath, 'utf8'), legacyContent);
        assert.equal(store.get('trashFolder'), '/trash');
        assert.deepEqual(store.getPathHash(imagePath), { hash: 'legacy-hash', size: null, mtimeMs: null });
        assert.equal(store.getPathHash('/photos/invalid.jpg'), null);
        assert.deepEqual(store.getImageMetadata('legacy-hash'), {
            tags: ['favorite'], score: { rating: 1507, wins: 7, matches: 7 }
        });
        assert.equal(store.get('pathToHash'), undefined);

        store.set('trashFolder', '/new-trash');
        store.removeImageTag('legacy-hash', 'favorite');
        store.close();
        store = new Store(databasePath, { legacyFilePath, backupFilePath });
        assert.equal(store.get('trashFolder'), '/new-trash');
        assert.deepEqual(store.getImageTags('legacy-hash'), []);
        assert.equal(fs.readFileSync(backupFilePath, 'utf8'), legacyContent);
    } finally {
        store.close();
    }
});

test('existing SQLite settings survive an absent JSON migration marker', t => {
    const directory = temporaryDirectory(t);
    const databasePath = path.join(directory, 'store.sqlite');
    const legacyFilePath = path.join(directory, 'config.json');
    let store = new Store(databasePath, { legacyFilePath });
    try {
        store.set('trashFolder', '/current-trash');
        store.close();
        executeSql(databasePath, "DELETE FROM store_meta WHERE key = 'json_config_migrated'");
        fs.writeFileSync(legacyFilePath, JSON.stringify({ trashFolder: '/outdated-trash' }));

        store = new Store(databasePath, { legacyFilePath });
        assert.equal(store.get('trashFolder'), '/current-trash');
        assert.equal(fs.existsSync(`${legacyFilePath}.pre-sqlite.bak`), false);
    } finally {
        store.close();
    }
});

test('failed settings batches and replacements preserve both stored and in-memory values', t => {
    const directory = temporaryDirectory(t);
    const databasePath = path.join(directory, 'store.sqlite');
    const store = new Store(databasePath);
    try {
        store.setMany({ folder: '/original', view: 'grid' });
        executeSql(databasePath, `
            CREATE TRIGGER reject_blocked_setting BEFORE INSERT ON store_values
            WHEN NEW.key = 'blocked'
            BEGIN SELECT RAISE(ABORT, 'blocked write'); END;
        `);

        for (const write of [
            () => store.set('blocked', true),
            () => store.setMany({ folder: '/changed', blocked: true }),
            () => store.replaceAll({ folder: '/changed', blocked: true })
        ]) {
            assert.throws(write, /blocked write/);
            assert.equal(store.get('folder'), '/original');
            assert.equal(store.get('view'), 'grid');
            assert.equal(store.get('blocked'), undefined);
            store.load();
            assert.equal(store.get('folder'), '/original');
            assert.equal(store.get('view'), 'grid');
            assert.equal(store.get('blocked'), undefined);
        }
        store.setMany({ folder: '/valid' });
        assert.equal(store.get('folder'), '/valid');
    } finally {
        store.close();
    }
});

test('failed hash batches and moves roll back every path and directory change', t => {
    const directory = temporaryDirectory(t);
    const databasePath = path.join(directory, 'store.sqlite');
    const store = new Store(databasePath);
    const originalHashes = {
        '/photos/one.jpg': { hash: 'one', size: 10, mtimeMs: 100 },
        '/photos/two.jpg': { hash: 'two', size: 20, mtimeMs: 200 }
    };
    try {
        store.setPathHashes(originalHashes);
        executeSql(databasePath, `
            CREATE TRIGGER reject_blocked_path BEFORE INSERT ON image_hashes
            WHEN NEW.path LIKE '%/blocked.jpg'
            BEGIN SELECT RAISE(ABORT, 'blocked write'); END;
        `);

        assert.throws(() => store.setPathHashes({
            '/photos/one.jpg': 'changed', '/photos/blocked.jpg': 'blocked'
        }), /blocked write/);
        assert.deepEqual(store.getPathHashesForDirectory('/photos'), originalHashes);

        assert.throws(() => store.movePathHashes([
            { fromPath: '/photos/one.jpg', toPath: '/archive/one.jpg' },
            { fromPath: '/photos/two.jpg', toPath: '/archive/blocked.jpg' }
        ]), /blocked write/);
        assert.deepEqual(store.getPathHashesForDirectory('/photos'), originalHashes);
        assert.deepEqual(store.getPathHashesForDirectory('/archive'), {});
    } finally {
        store.close();
    }
});

test('failed score updates and replacements keep the previous ratings intact', t => {
    const directory = temporaryDirectory(t);
    const databasePath = path.join(directory, 'store.sqlite');
    const store = new Store(databasePath);
    const originalScores = { existing: { rating: 1600, wins: 3, matches: 5 } };
    try {
        store.setImageScores(originalScores);
        executeSql(databasePath, `
            CREATE TRIGGER reject_blocked_score BEFORE INSERT ON image_scores
            WHEN NEW.hash = 'blocked'
            BEGIN SELECT RAISE(ABORT, 'blocked write'); END;
        `);

        assert.throws(() => store.setImageScores({ existing: 10, blocked: 20 }), /blocked write/);
        assert.deepEqual(store.getAllImageScores(), originalScores);
        assert.throws(() => store.replaceImageScores({ replacement: 30, blocked: 20 }), /blocked write/);
        assert.deepEqual(store.getAllImageScores(), originalScores);

        store.replaceImageScores({ replacement: 30 });
        assert.deepEqual(store.getAllImageScores(), {
            replacement: { rating: 1530, wins: 30, matches: 30 }
        });
    } finally {
        store.close();
    }
});
