const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const registerIpcHandlers = require('../main-ipc-handlers');

function registerTestHandlers(store, overrides = {}) {
    const handlers = {};
    const ipcMain = { handle: (name, handler) => { handlers[name] = handler; } };
    registerIpcHandlers({
        ipcMain,
        dialog: overrides.dialog || {},
        shell: {},
        path,
        fsp: fs.promises,
        getMainWindow: () => null,
        store,
        imageLibrary: {
            readDirectory: overrides.readDirectory || (async () => []),
            getHash: async imagePath => `hash:${path.basename(imagePath)}`,
            getThumbnail: async () => ({ dataUrl: 'thumbnail', cached: true }),
            findDuplicates: async () => ({ groups: [], failures: [] }),
            listEntries: async () => []
        },
        imageFileOperations: {
            moveMany: async () => ({ moved: [], failures: [] }),
            moveOne: async () => ({ success: true, moved: false }),
            trashOne: async () => ({ success: true }),
            trashMany: async () => ({ deleted: [], failures: [] }),
            restore: async () => ({ success: false }),
            inspectTrash: async () => ({ count: 0, size: 0, path: null }),
            emptyTrash: async () => ({ success: true, deletedCount: 0 })
        },
        fileOperations: {
            getAvailablePath: async filePath => filePath,
            reserveAvailablePath: async filePath => filePath,
            getTimestampedPath: async filePath => filePath,
            getNumberedPath: async filePath => filePath,
            moveFileSafely: async () => {},
            pathExists: async () => false
        },
        moveHashMapping: () => {},
        moveHashMappings: () => {},
        getServerDownloadDirectory: () => '/tmp'
    });
    return handlers;
}

test('directory IPC delegates scanning and forwards metadata batches', async () => {
    const sent = [];
    const handlers = registerTestHandlers({}, {
        readDirectory: async (directory, { onMetadata }) => {
            onMetadata([{ path: `${directory}/one.jpg`, hash: 'hash-one' }]);
            return [{ path: `${directory}/one.jpg`, hash: 'hash-one' }];
        }
    });

    const result = await handlers['read-directory']({
        sender: {
            isDestroyed: () => false,
            send: (channel, payload) => sent.push({ channel, payload })
        }
    }, '/photos');

    assert.deepEqual(result, [{ path: '/photos/one.jpg', hash: 'hash-one' }]);
    assert.deepEqual(sent, [{
        channel: 'directory-image-metadata',
        payload: {
            dirPath: '/photos',
            updates: [{ path: '/photos/one.jpg', hash: 'hash-one' }]
        }
    }]);
});

test('does not expose a persistent large-preview cache IPC', () => {
    const handlers = registerTestHandlers({});

    assert.equal(handlers['get-preview'], undefined);
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

test('configuration IPC preserves folder and recent-file setting defaults', () => {
    const settings = new Map();
    const handlers = registerTestHandlers({
        get: key => settings.get(key),
        set: (key, value) => settings.set(key, value)
    });

    assert.equal(handlers['get-categories'](), null);
    assert.equal(handlers['get-quick-open-folders'](), null);
    assert.deepEqual(handlers['get-recent-open-files'](), []);

    const categories = [{ name: 'Favorites', path: '/favorites' }];
    const folders = ['/photos'];
    const recentFiles = ['/photos/one.jpg'];
    assert.equal(handlers['save-categories']({}, categories), true);
    assert.equal(handlers['save-quick-open-folders']({}, folders), true);
    assert.equal(handlers['save-recent-open-files']({}, recentFiles), true);
    assert.deepEqual(handlers['get-categories'](), categories);
    assert.deepEqual(handlers['get-quick-open-folders'](), folders);
    assert.deepEqual(handlers['get-recent-open-files'](), recentFiles);

    assert.equal(handlers['save-recent-open-files']({}, null), true);
    assert.deepEqual(handlers['get-recent-open-files'](), []);
});

test('configuration IPC round-trips settings and image scores through an exported file', async () => {
    const tempDir = await fs.promises.mkdtemp('/private/tmp/macimage-config-');
    try {
        const filePath = path.join(tempDir, 'config.json');
        const originalTags = ['favorite'];
        const originalCategories = [{ name: 'Favorites', path: '/favorites' }];
        const originalScores = { 'hash:one.jpg': { rating: 1600, wins: 1, matches: 1 } };
        const settings = { tags: originalTags, categories: originalCategories };
        let imageScores = originalScores;
        const handlers = registerTestHandlers({
            get: key => settings[key],
            setMany: updates => Object.assign(settings, updates),
            getAllImageScores: () => imageScores,
            replaceImageScores: scores => { imageScores = scores; }
        }, {
            dialog: {
                showSaveDialog: async () => ({ filePath }),
                showOpenDialog: async () => ({ filePaths: [filePath] })
            }
        });

        const exported = await handlers['export-config']();
        assert.equal(exported.success, true);
        assert.equal(exported.config.version, '1.0');
        assert.equal(Number.isNaN(Date.parse(exported.config.exportTime)), false);
        assert.deepEqual(await handlers['save-export-file']({}, exported.config), {
            success: true,
            filePath
        });

        settings.tags = [];
        settings.categories = null;
        imageScores = {};

        const opened = await handlers['open-import-file']();
        assert.equal(opened.success, true);
        assert.deepEqual(await handlers['import-config']({}, opened.config), {
            success: true,
            imageScoresByHash: originalScores
        });
        assert.deepEqual(settings.tags, originalTags);
        assert.deepEqual(settings.categories, originalCategories);
        assert.deepEqual(imageScores, originalScores);
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});

test('configuration IPC preserves cancelled dialog and invalid import responses', async () => {
    const handlers = registerTestHandlers({}, {
        dialog: {
            showSaveDialog: async () => ({}),
            showOpenDialog: async () => ({ filePaths: [] })
        }
    });

    assert.deepEqual(await handlers['save-export-file']({}, {}), { success: false, cancelled: true });
    assert.deepEqual(await handlers['open-import-file'](), { success: false, cancelled: true });
    assert.deepEqual(await handlers['import-config']({}, null), {
        success: false,
        error: '无效的配置数据'
    });
});
