const { mapWithConcurrency } = require('./async-utils');

const LEON_API_BASE_URL = 'http://192.168.3.35:8080';
const SERVER_IMAGE_LOAD_LIMIT = 9_999;
const DEFAULT_SERVER_DOWNLOAD_CONCURRENCY = 5;
const MAX_SERVER_DOWNLOAD_CONCURRENCY = 10;

function registerServerImageHandlers(deps) {
    const {
        ipcMain,
        dialog,
        path,
        fsp,
        getMainWindow,
        store,
        reserveAvailablePath,
        getServerDownloadDirectory,
        selectDirectory
    } = deps;

    ipcMain.handle('download-server-images', async (event, requestedCount) => {
        const count = Number(requestedCount);
        if (!Number.isInteger(count) || count < 1 || count > SERVER_IMAGE_LOAD_LIMIT) {
            return { success: false, error: `下载数量必须是 1 到 ${SERVER_IMAGE_LOAD_LIMIT} 之间的整数` };
        }

        let pictures;
        try {
            pictures = await fetchServerPictures(count);
        } catch (error) {
            return { success: false, error: `无法读取服务端图片：${error.message}` };
        }

        if (pictures.length === 0) {
            return { success: false, error: '服务端没有可下载的图片' };
        }

        const downloadDirectory = store.get('serverDownloadFolder') || getServerDownloadDirectory();
        const downloadConcurrency = normalizeServerDownloadConcurrency(
            store.get('serverDownloadConcurrency')
        );
        await fsp.mkdir(downloadDirectory, { recursive: true });

        let completedCount = 0;
        let successfulCount = 0;
        let failedCount = 0;
        const reportProgress = (stage) => {
            event.sender.send('server-image-download-progress', {
                stage,
                completed: completedCount,
                total: pictures.length,
                succeeded: successfulCount,
                failed: failedCount,
                downloadDirectory
            });
        };

        reportProgress('downloading');
        const downloadResults = await mapWithConcurrency(pictures, downloadConcurrency, async (picture) => {
            let destination;
            try {
                const { fileName, contents } = await fetchServerImage(picture, path);
                destination = await reserveAvailablePath(
                    path.join(downloadDirectory, fileName),
                    (index) => path.join(downloadDirectory, `${picture.id}-${index}-${fileName}`)
                );
                await fsp.writeFile(destination, contents);

                successfulCount++;
                reportProgress('deleting');
                // A remote deletion failure must keep the successfully saved file.
                const deletion = await deleteServerPicture(picture.id);
                return { success: true, id: picture.id, path: destination, ...deletion };
            } catch (error) {
                if (destination) {
                    await fsp.unlink(destination).catch(() => {});
                }
                failedCount++;
                return { success: false, id: picture?.id, error: error.message };
            } finally {
                completedCount++;
                reportProgress('downloading');
            }
        });

        const summary = summarizeServerDownloads(downloadResults, downloadDirectory);
        reportProgress(summary.deletionError ? 'delete-failed' : 'completed');
        return summary;
    });

    ipcMain.handle('get-server-download-folder', () => {
        return store.get('serverDownloadFolder') || getServerDownloadDirectory();
    });

    ipcMain.handle('select-server-download-folder', async () => {
        const result = await selectDirectory(dialog, getMainWindow(), '选择图片下载默认位置', 'Error selecting server download folder:');
        if (result.success) {
            store.set('serverDownloadFolder', result.path);
        }
        return result;
    });

    ipcMain.handle('get-server-download-concurrency', () => normalizeServerDownloadConcurrency(
        store.get('serverDownloadConcurrency')
    ));

    ipcMain.handle('set-server-download-concurrency', (event, concurrency) => {
        const value = Number(concurrency);
        if (!Number.isInteger(value) || value < 1 || value > MAX_SERVER_DOWNLOAD_CONCURRENCY) {
            return { success: false, error: `并发下载线程数必须是 1 到 ${MAX_SERVER_DOWNLOAD_CONCURRENCY} 的整数` };
        }
        store.set('serverDownloadConcurrency', value);
        return { success: true, value };
    });
}

async function fetchServerPictures(count) {
    const response = await fetch(`${LEON_API_BASE_URL}/api/leon/pictures?limit=${count}&shuffle=true`);
    if (!response.ok) {
        throw new Error(`服务端图片列表请求失败（HTTP ${response.status}）`);
    }
    const pictures = await response.json();
    if (!Array.isArray(pictures)) {
        throw new Error('服务端返回的图片列表格式无效');
    }
    return pictures;
}

async function fetchServerImage(picture, path) {
    if (!picture || !Number.isInteger(picture.id) || typeof picture.imageUrl !== 'string') {
        throw new Error('图片数据缺少 id 或 imageUrl');
    }

    const imageUrl = new URL(picture.imageUrl);
    if (!['http:', 'https:'].includes(imageUrl.protocol)) {
        throw new Error('图片地址必须使用 HTTP 或 HTTPS');
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
        throw new Error(`图片下载失败（HTTP ${response.status}）`);
    }

    const sourceName = picture.fileName || path.basename(imageUrl.pathname) || `${picture.id}.jpg`;
    const fileName = path.basename(sourceName).replace(/[^a-zA-Z0-9._-]/g, '_') || `${picture.id}.jpg`;
    return { fileName, contents: Buffer.from(await response.arrayBuffer()) };
}

async function deleteServerPicture(pictureId) {
    try {
        const response = await fetch(`${LEON_API_BASE_URL}/api/leon/pictures`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pictureIds: [pictureId] })
        });
        if (!response.ok) {
            throw new Error(`服务端删除请求失败（HTTP ${response.status}）`);
        }
        return { deleted: true };
    } catch (error) {
        return { deleted: false, deletionError: error.message };
    }
}

function summarizeServerDownloads(results, downloadDirectory) {
    const downloaded = results.filter(result => result.success);
    const failures = results
        .filter(result => !result.success)
        .map(result => ({ id: result.id ?? null, error: result.error }));
    const deletionFailures = downloaded
        .filter(result => !result.deleted)
        .map(result => ({ id: result.id, error: result.deletionError }));
    const deletionError = deletionFailures.length > 0
        ? `${deletionFailures.length} 张图片删除失败：${deletionFailures.map(failure => failure.error).join('；')}`
        : null;

    return {
        success: downloaded.length > 0,
        downloadDirectory,
        downloadedCount: downloaded.length,
        deletedCount: downloaded.length - deletionFailures.length,
        deletionError,
        deletionFailures,
        failures
    };
}

function normalizeServerDownloadConcurrency(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= MAX_SERVER_DOWNLOAD_CONCURRENCY
        ? number
        : DEFAULT_SERVER_DOWNLOAD_CONCURRENCY;
}

module.exports = registerServerImageHandlers;
