const LEON_API_BASE_URL = 'http://192.168.3.35:8080';
const SERVER_IMAGE_LOAD_LIMIT = 1_000;
const DEFAULT_SERVER_DOWNLOAD_CONCURRENCY = 5;
const MAX_SERVER_DOWNLOAD_CONCURRENCY = 10;

function registerServerImageHandlers(deps) {
    const {
        ipcMain,
        dialog,
        path,
        fsp,
        getMainWindow,
        getStore,
        mapWithConcurrency,
        getAvailablePath,
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
            const response = await fetch(`${LEON_API_BASE_URL}/api/leon/pictures?limit=${count}&shuffle=true`);
            if (!response.ok) {
                throw new Error(`服务端图片列表请求失败（HTTP ${response.status}）`);
            }
            pictures = await response.json();
            if (!Array.isArray(pictures)) {
                throw new Error('服务端返回的图片列表格式无效');
            }
        } catch (error) {
            return { success: false, error: `无法读取服务端图片：${error.message}` };
        }

        if (pictures.length === 0) {
            return { success: false, error: '服务端没有可下载的图片' };
        }

        const downloadDirectory = getStore().get('serverDownloadFolder') || getServerDownloadDirectory();
        const downloadConcurrency = normalizeServerDownloadConcurrency(
            getStore().get('serverDownloadConcurrency'),
            DEFAULT_SERVER_DOWNLOAD_CONCURRENCY,
            MAX_SERVER_DOWNLOAD_CONCURRENCY
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
            try {
                if (!picture || !Number.isInteger(picture.id) || typeof picture.imageUrl !== 'string') {
                    throw new Error('图片数据缺少 id 或 imageUrl');
                }

                const imageUrl = new URL(picture.imageUrl);
                if (!['http:', 'https:'].includes(imageUrl.protocol)) {
                    throw new Error('图片地址必须使用 HTTP 或 HTTPS');
                }

                const imageResponse = await fetch(imageUrl);
                if (!imageResponse.ok) {
                    throw new Error(`图片下载失败（HTTP ${imageResponse.status}）`);
                }

                const sourceName = picture.fileName || path.basename(imageUrl.pathname) || `${picture.id}.jpg`;
                const safeName = path.basename(sourceName).replace(/[^a-zA-Z0-9._-]/g, '_') || `${picture.id}.jpg`;
                const destination = await getAvailablePath(
                    path.join(downloadDirectory, safeName),
                    (index) => path.join(downloadDirectory, `${picture.id}-${index}-${safeName}`)
                );
                await fsp.writeFile(destination, Buffer.from(await imageResponse.arrayBuffer()));

                successfulCount++;
                return { success: true, id: picture.id, path: destination };
            } catch (error) {
                failedCount++;
                return { success: false, id: picture?.id, error: error.message };
            } finally {
                completedCount++;
                reportProgress('downloading');
            }
        });

        const downloaded = downloadResults.filter(result => result.success);
        const failures = downloadResults
            .filter(result => !result.success)
            .map(result => ({ id: result.id ?? null, error: result.error }));

        let deletionError = null;
        if (downloaded.length > 0) {
            reportProgress('deleting');
            try {
                const deleteResponse = await fetch(`${LEON_API_BASE_URL}/api/leon/pictures`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pictureIds: downloaded.map(result => result.id) })
                });
                if (!deleteResponse.ok) {
                    throw new Error(`服务端删除请求失败（HTTP ${deleteResponse.status}）`);
                }
            } catch (error) {
                deletionError = error.message;
            }
        }

        reportProgress(deletionError ? 'delete-failed' : 'completed');
        return {
            success: downloaded.length > 0,
            downloadDirectory,
            downloadedCount: downloaded.length,
            deletedCount: deletionError ? 0 : downloaded.length,
            deletionError,
            failures
        };
    });

    ipcMain.handle('get-server-download-folder', () => {
        return getStore().get('serverDownloadFolder') || getServerDownloadDirectory();
    });

    ipcMain.handle('select-server-download-folder', async () => {
        const result = await selectDirectory(dialog, getMainWindow(), '选择图片下载默认位置', 'Error selecting server download folder:');
        if (result.success) {
            getStore().set('serverDownloadFolder', result.path);
        }
        return result;
    });

    ipcMain.handle('get-server-download-concurrency', () => normalizeServerDownloadConcurrency(
        getStore().get('serverDownloadConcurrency'),
        DEFAULT_SERVER_DOWNLOAD_CONCURRENCY,
        MAX_SERVER_DOWNLOAD_CONCURRENCY
    ));

    ipcMain.handle('set-server-download-concurrency', (event, concurrency) => {
        const value = Number(concurrency);
        if (!Number.isInteger(value) || value < 1 || value > MAX_SERVER_DOWNLOAD_CONCURRENCY) {
            return { success: false, error: `并发下载线程数必须是 1 到 ${MAX_SERVER_DOWNLOAD_CONCURRENCY} 的整数` };
        }
        getStore().set('serverDownloadConcurrency', value);
        return { success: true, value };
    });
}

function normalizeServerDownloadConcurrency(value, fallback, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= maximum ? number : fallback;
}

module.exports = registerServerImageHandlers;
