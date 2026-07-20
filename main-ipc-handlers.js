function registerIpcHandlers(deps) {
    const {
        ipcMain,
        dialog,
        shell,
        path,
        fsp,
        getMainWindow,
        getStore,
        getImageEntries,
        getImageRecord,
        mapWithConcurrency,
        getOrCreateImageHash,
        getCachedThumbnail,
        getAvailablePath,
        getTimestampedPath,
        getNumberedPath,
        pathExists,
        moveHashMapping,
        imageScanConcurrency,
        getServerDownloadDirectory
    } = deps;

    const LEON_API_BASE_URL = 'http://192.168.3.35:8080';
    const SERVER_IMAGE_LOAD_LIMIT = 1_000;

    ipcMain.handle('open-folder-dialog', async () => {
        const result = await dialog.showOpenDialog(getMainWindow(), {
            properties: ['openDirectory']
        });
        return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null;
    });

    ipcMain.handle('open-trash-folder-dialog', async () => {
        const result = await dialog.showOpenDialog(getMainWindow(), {
            properties: ['openDirectory', 'createDirectory']
        });
        if (!result.canceled && result.filePaths.length > 0) {
            getStore().set('trashFolder', result.filePaths[0]);
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('get-trash-folder', () => getStore().get('trashFolder') || null);

    ipcMain.handle('set-trash-folder', (event, folderPath) => {
        getStore().set('trashFolder', folderPath);
        return true;
    });

    ipcMain.handle('directory-exists', async (event, folderPath) => {
        try {
            const stats = await fsp.stat(folderPath);
            return stats.isDirectory();
        } catch {
            return false;
        }
    });

    ipcMain.handle('file-exists', async (event, filePath) => {
        try {
            const stats = await fsp.stat(filePath);
            return stats.isFile();
        } catch {
            return false;
        }
    });

    ipcMain.handle('read-directory', async (event, dirPath) => {
        const store = getStore();
        const pathToHash = store.get('pathToHash') || {};
        const imageTagsByHash = store.get('imageTagsByHash') || {};
        const imageScoresByHash = store.get('imageScoresByHash') || {};
        const updatedPathToHash = {};

        try {
            const imageEntries = await getImageEntries(dirPath);
            const images = await mapWithConcurrency(
                imageEntries,
                imageScanConcurrency,
                entry => getImageRecord(dirPath, entry.name, pathToHash, imageTagsByHash, imageScoresByHash, updatedPathToHash)
            );

            if (Object.keys(updatedPathToHash).length > 0) {
                store.set('pathToHash', { ...pathToHash, ...updatedPathToHash });
            }

            return images.filter(Boolean);
        } catch (error) {
            console.error('Error reading directory:', error);
            return [];
        }
    });

    ipcMain.handle('download-server-images', async (event, requestedCount) => {
        const count = Number(requestedCount);
        if (!Number.isInteger(count) || count < 1 || count > SERVER_IMAGE_LOAD_LIMIT) {
            return { success: false, error: `下载数量必须是 1 到 ${SERVER_IMAGE_LOAD_LIMIT} 之间的整数` };
        }

        let pictures;
        try {
            const response = await fetch(
                `${LEON_API_BASE_URL}/api/leon/pictures?limit=${count}&shuffle=true`
            );
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

        const batchDirectory = path.join(
            getServerDownloadDirectory(),
            `batch-${new Date().toISOString().replace(/[:.]/g, '-')}`
        );
        await fsp.mkdir(batchDirectory, { recursive: true });

        const downloadResults = await mapWithConcurrency(pictures, 4, async (picture) => {
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
                    path.join(batchDirectory, safeName),
                    (index) => path.join(batchDirectory, `${picture.id}-${index}-${safeName}`)
                );
                await fsp.writeFile(destination, Buffer.from(await imageResponse.arrayBuffer()));

                return { success: true, id: picture.id, path: destination };
            } catch (error) {
                return { success: false, id: picture?.id, error: error.message };
            }
        });

        const downloaded = downloadResults.filter(result => result.success);
        const failures = downloadResults
            .filter(result => !result.success)
            .map(result => ({ id: result.id ?? null, error: result.error }));

        let deletionError = null;
        if (downloaded.length > 0) {
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

        return {
            success: downloaded.length > 0,
            downloadDirectory: batchDirectory,
            downloadedCount: downloaded.length,
            deletedCount: deletionError ? 0 : downloaded.length,
            deletionError,
            failures
        };
    });

    ipcMain.handle('get-tags', () => getStore().get('tags') || []);

    ipcMain.handle('save-tags', (event, tags) => {
        getStore().set('tags', tags);
        return true;
    });

    ipcMain.handle('get-image-tags', () => {
        const store = getStore();
        return {
            imageTagsByHash: store.get('imageTagsByHash') || {},
            pathToHash: store.get('pathToHash') || {}
        };
    });

    ipcMain.handle('save-image-tags', (event, data) => {
        const updates = {};
        if (data.imageTagsByHash) updates.imageTagsByHash = data.imageTagsByHash;
        if (data.pathToHash) updates.pathToHash = data.pathToHash;
        if (Object.keys(updates).length > 0) getStore().setMany(updates);
        return true;
    });

    ipcMain.handle('get-image-scores', () => getStore().get('imageScoresByHash') || {});

    ipcMain.handle('save-image-scores', (event, scores) => {
        getStore().set('imageScoresByHash', scores && typeof scores === 'object' ? scores : {});
        return true;
    });

    ipcMain.handle('get-image-hash', async (event, imagePath) => {
        try {
            return await getOrCreateImageHash(imagePath);
        } catch (err) {
            console.error('Failed to calculate hash:', err.message);
            return null;
        }
    });

    ipcMain.handle('record-competition-result', async (event, winnerPath, loserPath) => {
        const store = getStore();
        const imageScoresByHash = store.get('imageScoresByHash') || {};

        try {
            const winnerHash = await getOrCreateImageHash(winnerPath);
            const loserHash = await getOrCreateImageHash(loserPath);
            const winnerRecord = normalizeRatingRecord(imageScoresByHash[winnerHash]);
            const loserRecord = normalizeRatingRecord(imageScoresByHash[loserHash]);
            const nextRecords = calculateEloResult(winnerRecord, loserRecord);

            imageScoresByHash[winnerHash] = nextRecords.winner;
            imageScoresByHash[loserHash] = nextRecords.loser;
            store.set('imageScoresByHash', imageScoresByHash);

            return {
                success: true,
                scores: imageScoresByHash,
                winner: { hash: winnerHash, record: nextRecords.winner },
                loser: { hash: loserHash, record: nextRecords.loser }
            };
        } catch (err) {
            console.error('Failed to record competition result:', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('record-competition-group-result', async (event, winnerPath, loserPaths) => {
        const store = getStore();
        const imageScoresByHash = store.get('imageScoresByHash') || {};

        try {
            const winnerHash = await getOrCreateImageHash(winnerPath);
            const uniqueLoserPaths = [...new Set(Array.isArray(loserPaths) ? loserPaths : [])]
                .filter(candidatePath => candidatePath && candidatePath !== winnerPath);
            const loserEntries = [];

            for (const loserPath of uniqueLoserPaths) {
                const loserHash = await getOrCreateImageHash(loserPath);
                if (loserHash !== winnerHash) {
                    loserEntries.push({ path: loserPath, hash: loserHash });
                }
            }

            const winnerRecord = normalizeRatingRecord(imageScoresByHash[winnerHash]);
            const loserRecords = loserEntries.map(entry => normalizeRatingRecord(imageScoresByHash[entry.hash]));
            const nextRecords = calculateEloGroupResult(winnerRecord, loserRecords);

            imageScoresByHash[winnerHash] = nextRecords.winner;
            loserEntries.forEach((entry, index) => {
                imageScoresByHash[entry.hash] = nextRecords.losers[index];
            });
            store.set('imageScoresByHash', imageScoresByHash);

            return {
                success: true,
                scores: imageScoresByHash,
                winner: { hash: winnerHash, record: nextRecords.winner },
                losers: loserEntries.map((entry, index) => ({
                    hash: entry.hash,
                    path: entry.path,
                    record: nextRecords.losers[index]
                }))
            };
        } catch (err) {
            console.error('Failed to record competition group result:', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('get-thumbnail', async (event, imagePath, size) => {
        try {
            return await getCachedThumbnail(imagePath, size);
        } catch (err) {
            console.error('Failed to get thumbnail:', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('add-tag-to-image', async (event, imagePath, tag) => {
        const store = getStore();
        const pathToHash = store.get('pathToHash') || {};
        const imageTagsByHash = store.get('imageTagsByHash') || {};

        let hash;
        try {
            hash = pathToHash[imagePath] || await getOrCreateImageHash(imagePath);
        } catch (err) {
            console.error('Failed to calculate hash:', err.message);
            return [];
        }

        if (!imageTagsByHash[hash]) imageTagsByHash[hash] = [];
        if (!imageTagsByHash[hash].includes(tag)) imageTagsByHash[hash].push(tag);
        store.set('imageTagsByHash', imageTagsByHash);
        return imageTagsByHash[hash];
    });

    ipcMain.handle('remove-tag-from-image', (event, imagePath, tag) => {
        const store = getStore();
        const pathToHash = store.get('pathToHash') || {};
        const imageTagsByHash = store.get('imageTagsByHash') || {};
        const hash = pathToHash[imagePath];
        if (!hash) return [];

        if (imageTagsByHash[hash]) {
            imageTagsByHash[hash] = imageTagsByHash[hash].filter(t => t !== tag);
            if (imageTagsByHash[hash].length === 0) delete imageTagsByHash[hash];
            store.set('imageTagsByHash', imageTagsByHash);
        }

        return imageTagsByHash[hash] || [];
    });

    ipcMain.handle('delete-image', async (event, imagePath) => {
        const trashFolder = getStore().get('trashFolder');
        if (!trashFolder) return { success: false, error: '未设置回收站文件夹' };

        try {
            await fsp.mkdir(trashFolder, { recursive: true });
            const fileName = path.basename(imagePath);
            const destPath = await getTimestampedPath(path.join(trashFolder, fileName));

            await fsp.rename(imagePath, destPath);
            moveHashMapping(imagePath, destPath);

            return {
                success: true,
                originalPath: imagePath,
                trashPath: destPath,
                fileName
            };
        } catch (error) {
            console.error('Error deleting image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('undo-delete', async (event, trashPath, originalPath) => {
        try {
            if (!(await pathExists(trashPath))) {
                return { success: false, error: '回收站中找不到该文件' };
            }

            const originalDir = path.dirname(originalPath);
            if (!(await pathExists(originalDir))) {
                return { success: false, error: '原始目录不存在' };
            }

            const restorePath = await getAvailablePath(originalPath, () => {
                const ext = path.extname(originalPath);
                const baseName = path.basename(originalPath, ext);
                return path.join(originalDir, `${baseName}_restored_${Date.now()}${ext}`);
            });

            await fsp.rename(trashPath, restorePath);
            moveHashMapping(trashPath, restorePath);

            return { success: true, restoredPath: restorePath, originalPath };
        } catch (error) {
            console.error('Error undoing delete:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('show-in-folder', (event, filePath) => {
        shell.showItemInFolder(filePath);
        return true;
    });

    ipcMain.handle('open-folder-path', async (event, folderPath) => {
        try {
            const stats = await fsp.stat(folderPath);
            if (!stats.isDirectory()) {
                return { success: false, error: '路径不是文件夹' };
            }

            const errorMessage = await shell.openPath(folderPath);
            return errorMessage
                ? { success: false, error: errorMessage }
                : { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-categories', () => getStore().get('categories') || null);

    ipcMain.handle('save-categories', (event, categories) => {
        getStore().set('categories', categories);
        return true;
    });

    ipcMain.handle('get-quick-open-folders', () => getStore().get('quickOpenFolders') || null);

    ipcMain.handle('save-quick-open-folders', (event, folders) => {
        getStore().set('quickOpenFolders', folders);
        return true;
    });

    ipcMain.handle('get-recent-open-files', () => getStore().get('recentOpenFiles') || []);

    ipcMain.handle('save-recent-open-files', (event, files) => {
        getStore().set('recentOpenFiles', Array.isArray(files) ? files : []);
        return true;
    });

    ipcMain.handle('get-trash-info', async () => {
        const trashFolder = getStore().get('trashFolder');
        if (!trashFolder || !(await pathExists(trashFolder))) {
            return { count: 0, size: 0, path: trashFolder };
        }

        try {
            let count = 0;
            let totalSize = 0;
            const imageEntries = await getImageEntries(trashFolder);

            for (const entry of imageEntries) {
                const stats = await fsp.stat(path.join(trashFolder, entry.name));
                count++;
                totalSize += stats.size;
            }

            return { count, size: totalSize, path: trashFolder };
        } catch (error) {
            console.error('Error getting trash info:', error);
            return { count: 0, size: 0, path: trashFolder };
        }
    });

    ipcMain.handle('empty-trash', async () => {
        const trashFolder = getStore().get('trashFolder');
        if (!trashFolder || !(await pathExists(trashFolder))) {
            return { success: false, error: '回收站文件夹不存在' };
        }

        try {
            const imageEntries = await getImageEntries(trashFolder);
            let deletedCount = 0;

            for (const entry of imageEntries) {
                await fsp.unlink(path.join(trashFolder, entry.name));
                deletedCount++;
            }

            return { success: true, deletedCount };
        } catch (error) {
            console.error('Error emptying trash:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('export-config', async () => {
        try {
            const store = getStore();
            return {
                success: true,
                config: {
                    tags: store.get('tags') || [],
                    categories: store.get('categories') || null,
                    imageScoresByHash: store.get('imageScoresByHash') || {},
                    exportTime: new Date().toISOString(),
                    version: '1.0'
                }
            };
        } catch (error) {
            console.error('Error exporting config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('import-config', async (event, config) => {
        try {
            if (!config || typeof config !== 'object') {
                return { success: false, error: '无效的配置数据' };
            }

            const updates = {};
            if (config.tags && Array.isArray(config.tags)) updates.tags = config.tags;
            if (config.categories && Array.isArray(config.categories)) updates.categories = config.categories;
            if (config.imageScoresByHash && typeof config.imageScoresByHash === 'object') {
                updates.imageScoresByHash = config.imageScoresByHash;
            }
            if (Object.keys(updates).length > 0) getStore().setMany(updates);
            return { success: true };
        } catch (error) {
            console.error('Error importing config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('save-export-file', async (event, config) => {
        try {
            const { filePath } = await dialog.showSaveDialog(getMainWindow(), {
                title: '导出配置',
                defaultPath: `macimage-config-${Date.now()}.json`,
                filters: [{ name: 'JSON', extensions: ['json'] }]
            });

            if (!filePath) return { success: false, cancelled: true };
            await fsp.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
            return { success: true, filePath };
        } catch (error) {
            console.error('Error saving export file:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('open-import-file', async () => {
        try {
            const { filePaths } = await dialog.showOpenDialog(getMainWindow(), {
                title: '导入配置',
                filters: [{ name: 'JSON', extensions: ['json'] }],
                properties: ['openFile']
            });

            if (!filePaths || filePaths.length === 0) return { success: false, cancelled: true };
            const content = await fsp.readFile(filePaths[0], 'utf-8');
            return { success: true, config: JSON.parse(content) };
        } catch (error) {
            console.error('Error opening import file:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('select-migrate-folder', async () => {
        return selectDirectory(dialog, getMainWindow(), '选择目标文件夹', 'Error selecting migrate folder:');
    });

    ipcMain.handle('select-quick-open-folder', async () => {
        return selectDirectory(dialog, getMainWindow(), '选择快捷打开目录', 'Error selecting quick open folder:');
    });

    ipcMain.handle('migrate-images', async (event, filePaths, targetFolder) => {
        try {
            const result = { movedCount: 0, skippedCount: 0, errors: [] };
            for (const sourcePath of filePaths) {
                await migrateOneImage({ sourcePath, targetFolder, result, path, fsp, pathExists, getNumberedPath, moveHashMapping });
            }
            return {
                success: true,
                ...result,
                totalFound: result.movedCount + result.skippedCount
            };
        } catch (error) {
            console.error('Error migrating images:', error);
            return { success: false, error: error.message };
        }
    });
}

async function selectDirectory(dialog, mainWindow, title, logPrefix) {
    try {
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title,
            properties: ['openDirectory', 'createDirectory']
        });
        return !filePaths || filePaths.length === 0
            ? { success: false, cancelled: true }
            : { success: true, path: filePaths[0] };
    } catch (error) {
        console.error(logPrefix, error);
        return { success: false, error: error.message };
    }
}

async function migrateOneImage({ sourcePath, targetFolder, result, path, fsp, pathExists, getNumberedPath, moveHashMapping }) {
    const file = path.basename(sourcePath);

    try {
        if (!(await pathExists(sourcePath))) {
            throw new Error('源文件不存在');
        }

        const targetPath = await getNumberedPath(path.join(targetFolder, file));
        await fsp.rename(sourcePath, targetPath);
        moveHashMapping(sourcePath, targetPath);
        result.movedCount++;
    } catch (err) {
        result.errors.push({ file, error: err.message });
        result.skippedCount++;
    }
}

const DEFAULT_ELO_RATING = 1500;
const ELO_K_FACTOR = 32;

function normalizeRatingRecord(value) {
    if (value && typeof value === 'object') {
        return {
            rating: normalizeNumber(value.rating, DEFAULT_ELO_RATING),
            wins: normalizeNumber(value.wins, 0),
            matches: normalizeNumber(value.matches, 0)
        };
    }

    const legacyWins = normalizeNumber(value, 0);
    return {
        rating: DEFAULT_ELO_RATING + legacyWins,
        wins: legacyWins,
        matches: legacyWins
    };
}

function calculateEloResult(winnerRecord, loserRecord) {
    const winnerExpected = getExpectedScore(winnerRecord.rating, loserRecord.rating);
    const loserExpected = getExpectedScore(loserRecord.rating, winnerRecord.rating);

    return {
        winner: {
            rating: Math.round(winnerRecord.rating + ELO_K_FACTOR * (1 - winnerExpected)),
            wins: winnerRecord.wins + 1,
            matches: winnerRecord.matches + 1
        },
        loser: {
            rating: Math.round(loserRecord.rating + ELO_K_FACTOR * (0 - loserExpected)),
            wins: loserRecord.wins,
            matches: loserRecord.matches + 1
        }
    };
}

function calculateEloGroupResult(winnerRecord, loserRecords) {
    if (loserRecords.length === 0) {
        return {
            winner: winnerRecord,
            losers: []
        };
    }

    const winnerExpectedAverage = loserRecords.reduce((total, loserRecord) => {
        return total + getExpectedScore(winnerRecord.rating, loserRecord.rating);
    }, 0) / loserRecords.length;

    return {
        winner: {
            rating: Math.round(winnerRecord.rating + ELO_K_FACTOR * (1 - winnerExpectedAverage)),
            wins: winnerRecord.wins + 1,
            matches: winnerRecord.matches + 1
        },
        losers: loserRecords.map(loserRecord => ({
            rating: Math.round(loserRecord.rating + ELO_K_FACTOR * (0 - getExpectedScore(loserRecord.rating, winnerRecord.rating))),
            wins: loserRecord.wins,
            matches: loserRecord.matches + 1
        }))
    };
}

function getExpectedScore(rating, opponentRating) {
    return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
}

function normalizeNumber(value, fallback) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, Math.round(numericValue)) : fallback;
}

module.exports = registerIpcHandlers;
