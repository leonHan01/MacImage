const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const registerServerImageHandlers = require('../main-ipc-server-images');
const { createFileOperationUtils } = require('../file-operation-utils');

function createDownloadHandler(directory) {
    const handlers = {};
    registerServerImageHandlers({
        ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
        path,
        fsp: fs.promises,
        store: { get: key => key === 'serverDownloadFolder' ? directory : 2 },
        ...createFileOperationUtils(),
        getServerDownloadDirectory: () => directory
    });
    return handlers['download-server-images'];
}

test('mixed server results preserve saved files and distinguish download and deletion failures', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macimage-server-download-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pictures = [1, 2, 3].map(id => ({
        id, fileName: `${id}.jpg`, imageUrl: `https://example.test/${id}`
    }));
    pictures.push({ id: 4, imageUrl: 'file:///photos/local.jpg' });
    const deletedIds = [];

    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (options?.method === 'DELETE') {
            const [id] = JSON.parse(options.body).pictureIds;
            // Remote deletion can only begin after the local contents are saved.
            assert.equal(fs.readFileSync(path.join(directory, `${id}.jpg`), 'utf8'), `image-${id}`);
            deletedIds.push(id);
            return { ok: id === 1, status: id === 1 ? 200 : 503 };
        }
        if (String(url).includes('/api/leon/pictures')) {
            return { ok: true, json: async () => pictures };
        }
        assert.equal(url.protocol, 'https:');
        const id = Number(url.pathname.slice(1));
        return { ok: id !== 3, status: 404, arrayBuffer: async () => Buffer.from(`image-${id}`) };
    });

    const progress = [];
    const result = await createDownloadHandler(directory)({
        sender: { send: (channel, payload) => {
            assert.equal(channel, 'server-image-download-progress');
            progress.push(payload);
        } }
    }, 4);

    assert.deepEqual(fs.readdirSync(directory).sort(), ['1.jpg', '2.jpg']);
    assert.deepEqual(deletedIds.sort(), [1, 2]);
    assert.deepEqual(result, {
        success: true,
        downloadDirectory: directory,
        downloadedCount: 2,
        deletedCount: 1,
        deletionError: '1 张图片删除失败：服务端删除请求失败（HTTP 503）',
        deletionFailures: [{ id: 2, error: '服务端删除请求失败（HTTP 503）' }],
        failures: [
            { id: 3, error: '图片下载失败（HTTP 404）' },
            { id: 4, error: '图片地址必须使用 HTTP 或 HTTPS' }
        ]
    });
    assert.deepEqual(progress[0], {
        stage: 'downloading', completed: 0, total: 4, succeeded: 0, failed: 0,
        downloadDirectory: directory
    });
    assert.deepEqual(progress.at(-1), {
        stage: 'delete-failed', completed: 4, total: 4, succeeded: 2, failed: 2,
        downloadDirectory: directory
    });
});

test('server list errors return a failure before creating files or reporting download progress', async t => {
    const download = createDownloadHandler('/unused-server-download-directory');
    const event = { sender: { send: () => assert.fail('Downloads must not start') } };
    const scenarios = [
        {
            response: { ok: false, status: 503 },
            error: '无法读取服务端图片：服务端图片列表请求失败（HTTP 503）'
        },
        {
            response: { ok: true, json: async () => ({ pictures: [] }) },
            error: '无法读取服务端图片：服务端返回的图片列表格式无效'
        },
        {
            response: { ok: true, json: async () => [] },
            error: '服务端没有可下载的图片'
        }
    ];

    for (const { response, error } of scenarios) {
        const fetchMock = t.mock.method(globalThis, 'fetch', async () => response);
        try {
            assert.deepEqual(await download(event, 1), { success: false, error });
            assert.equal(fetchMock.mock.callCount(), 1);
        } finally {
            fetchMock.mock.restore();
        }
    }
});
