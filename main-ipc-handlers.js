const registerFileOperationHandlers = require('./main-ipc-file-operations');
const registerServerImageHandlers = require('./main-ipc-server-images');

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
        hydrateImageRecord,
        mapWithConcurrency,
        getOrCreateImageHash,
        getCachedThumbnail,
        getCachedPreview,
        calculateFullFileHash,
        getAvailablePath,
        reserveAvailablePath,
        getTimestampedPath,
        getNumberedPath,
        moveFileSafely,
        pathExists,
        moveHashMapping,
        moveHashMappings,
        imageScanConcurrency,
        getServerDownloadDirectory
    } = deps;

    const FILE_OPERATION_CONCURRENCY = 6;
    const DIRECTORY_METADATA_BATCH_SIZE = 48;
    const FULL_HASH_CONCURRENCY = 4;

    registerServerImageHandlers({
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
    });
    const fileOperationServices = registerFileOperationHandlers({
        ipcMain,
        path,
        fsp,
        getStore,
        mapWithConcurrency,
        getAvailablePath,
        reserveAvailablePath,
        getNumberedPath,
        pathExists,
        moveFileSafely,
        moveHashMapping,
        moveHashMappings
    });

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
        try {
            const imageEntries = await getImageEntries(dirPath);
            const pathToHash = store.getPathHashesForDirectory(dirPath);
            const images = await mapWithConcurrency(
                imageEntries,
                imageScanConcurrency,
                entry => getImageRecord(dirPath, entry.name, pathToHash)
            );
            const imageRecords = images.filter(Boolean);
            const metadataByHash = store.getImageMetadataForHashes(
                imageRecords.map(image => image.hash).filter(Boolean)
            );
            imageRecords.forEach((image) => {
                if (!image.hash || !metadataByHash[image.hash]) return;
                image.tags = metadataByHash[image.hash].tags;
                image.score = metadataByHash[image.hash].score;
            });
            const recordsMissingHash = imageRecords.filter(image => !image.hash);

            if (recordsMissingHash.length > 0) {
                void hydrateDirectoryMetadata({
                    sender: event.sender,
                    dirPath,
                    records: recordsMissingHash,
                    store
                });
            }

            return imageRecords;
        } catch (error) {
            console.error('Error reading directory:', error);
            return [];
        }
    });

    async function hydrateDirectoryMetadata({ sender, dirPath, records, store }) {
        const updatedPathToHash = {};
        let updateBatch = [];

        const sendBatch = () => {
            if (updateBatch.length === 0 || sender.isDestroyed()) return;
            sender.send('directory-image-metadata', {
                dirPath,
                updates: updateBatch
            });
            updateBatch = [];
        };

        try {
            await mapWithConcurrency(records, imageScanConcurrency, async (record) => {
                const update = await hydrateImageRecord(
                    record,
                    store,
                    updatedPathToHash
                );
                if (update) {
                    updateBatch.push(update);
                    if (updateBatch.length >= DIRECTORY_METADATA_BATCH_SIZE) {
                        sendBatch();
                    }
                }
                return update;
            });
            sendBatch();

            if (Object.keys(updatedPathToHash).length > 0) {
                store.setPathHashes(updatedPathToHash);
            }
        } catch (error) {
            console.error('Error hydrating directory metadata:', error);
        }
    }

    ipcMain.handle('get-tags', () => getStore().get('tags') || []);

    ipcMain.handle('save-tags', (event, tags) => {
        getStore().set('tags', tags);
        return true;
    });

    ipcMain.handle('remove-tag-from-all-images', (event, tagName) => {
        if (typeof tagName !== 'string' || !tagName) {
            return { success: false, error: '标签名无效' };
        }

        const store = getStore();
        const removedCount = store.removeTagFromAllImages(tagName);
        return { success: true, removedCount };
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

        try {
            const winnerHash = await getOrCreateImageHash(winnerPath);
            const loserHash = await getOrCreateImageHash(loserPath);
            let nextRecords;
            const winnerRecord = normalizeRatingRecord(store.getImageScore(winnerHash));
            const loserRecord = normalizeRatingRecord(store.getImageScore(loserHash));
            nextRecords = calculateEloResult(winnerRecord, loserRecord);
            store.setImageScores({
                [winnerHash]: nextRecords.winner,
                [loserHash]: nextRecords.loser
            });

            return {
                success: true,
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

            let nextRecords;
            const winnerRecord = normalizeRatingRecord(store.getImageScore(winnerHash));
            const loserRecords = loserEntries.map(entry => normalizeRatingRecord(store.getImageScore(entry.hash)));
            nextRecords = calculateEloGroupResult(winnerRecord, loserRecords);
            const scoreUpdates = { [winnerHash]: nextRecords.winner };
            loserEntries.forEach((entry, index) => {
                scoreUpdates[entry.hash] = nextRecords.losers[index];
            });
            store.setImageScores(scoreUpdates);

            return {
                success: true,
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

    ipcMain.handle('get-preview', async (event, imagePath, size) => {
        try {
            return await getCachedPreview(imagePath, size);
        } catch (err) {
            console.error('Failed to get preview:', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('find-duplicate-images', async (event, candidates) => {
        try {
            const candidateGroups = new Map();
            (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
                if (!candidate || typeof candidate.path !== 'string' || !Number.isFinite(candidate.size)) return;

                const fastHash = typeof candidate.hash === 'string' && candidate.hash
                    ? candidate.hash
                    : '__missing_fast_hash__';
                const key = `${candidate.size}:${fastHash}`;
                if (!candidateGroups.has(key)) candidateGroups.set(key, []);
                candidateGroups.get(key).push(candidate);
            });

            const duplicateCandidates = Array.from(candidateGroups.values())
                .filter(group => group.length > 1)
                .flat();
            const results = await mapWithConcurrency(
                duplicateCandidates,
                FULL_HASH_CONCURRENCY,
                async (candidate) => {
                    try {
                        return {
                            path: candidate.path,
                            hash: await calculateFullFileHash(candidate.path)
                        };
                    } catch (error) {
                        return { path: candidate.path, error: error.message };
                    }
                }
            );
            const groupsByFullHash = new Map();
            const failures = [];

            results.forEach((result) => {
                if (!result || !result.hash) {
                    if (result) failures.push({ path: result.path, error: result.error || '无法计算完整哈希' });
                    return;
                }
                if (!groupsByFullHash.has(result.hash)) groupsByFullHash.set(result.hash, []);
                groupsByFullHash.get(result.hash).push(result.path);
            });

            return {
                success: true,
                groups: Array.from(groupsByFullHash.entries())
                    .filter(([, paths]) => paths.length > 1)
                    .map(([hash, paths]) => ({ hash, paths })),
                failures
            };
        } catch (error) {
            console.error('Error finding duplicate images:', error);
            return { success: false, error: error.message, groups: [], failures: [] };
        }
    });

    ipcMain.handle('add-tag-to-image', async (event, imagePath, tag) => {
        let hash;
        try {
            hash = await getOrCreateImageHash(imagePath);
        } catch (err) {
            console.error('Failed to calculate hash:', err.message);
            return [];
        }
        if (!hash) return [];

        const store = getStore();
        return store.addImageTag(hash, tag);
    });

    ipcMain.handle('remove-tag-from-image', async (event, imagePath, tag) => {
        let hash;
        try {
            hash = await getOrCreateImageHash(imagePath);
        } catch (err) {
            console.error('Failed to calculate hash:', err.message);
            return [];
        }
        if (!hash) return [];

        const store = getStore();
        return store.removeImageTag(hash, tag);
    });

    ipcMain.handle('delete-image', async (event, imagePath) => {
        const trashFolder = getStore().get('trashFolder');
        if (!trashFolder) return { success: false, error: '未设置回收站文件夹' };

        try {
            await fsp.mkdir(trashFolder, { recursive: true });
            const fileName = path.basename(imagePath);
            const destPath = await getTimestampedPath(path.join(trashFolder, fileName));

            await moveFileSafely(imagePath, destPath);
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

    ipcMain.handle('delete-images', async (event, imagePaths) => {
        const trashFolder = getStore().get('trashFolder');
        if (!trashFolder) return { success: false, error: '未设置回收站文件夹', deleted: [], failures: [] };

        try {
            await fsp.mkdir(trashFolder, { recursive: true });
            const uniquePaths = [...new Set(Array.isArray(imagePaths) ? imagePaths.filter(pathValue => typeof pathValue === 'string') : [])];
            const batchTimestamp = Date.now();
            const results = await mapWithConcurrency(uniquePaths, FILE_OPERATION_CONCURRENCY, async (imagePath, index) => {
                const fileName = path.basename(imagePath);
                const ext = path.extname(fileName);
                const baseName = path.basename(fileName, ext);
                const preferredPath = path.join(trashFolder, `${baseName}_${batchTimestamp}_${index}${ext}`);

                try {
                    const trashPath = await reserveAvailablePath(
                        preferredPath,
                        (counter) => path.join(trashFolder, `${baseName}_${batchTimestamp}_${index}_${counter}${ext}`)
                    );
                    await moveFileSafely(imagePath, trashPath);
                    return { success: true, originalPath: imagePath, trashPath, fileName };
                } catch (error) {
                    return { success: false, originalPath: imagePath, fileName, error: error.message };
                }
            });
            const deleted = results.filter(result => result.success);
            moveHashMappings(deleted.map(result => ({
                fromPath: result.originalPath,
                toPath: result.trashPath
            })));

            return {
                success: true,
                deleted,
                failures: results.filter(result => !result.success)
            };
        } catch (error) {
            console.error('Error deleting images:', error);
            return { success: false, error: error.message, deleted: [], failures: [] };
        }
    });

    ipcMain.handle('undo-delete', async (event, trashPath, originalPath) => {
        try {
            return await restoreFileOperation({
                sourcePath: trashPath,
                originalPath,
                path,
                pathExists,
                reserveAvailablePath,
                moveFileSafely,
                moveHashMapping,
                missingSourceError: '回收站中找不到该文件'
            });
        } catch (error) {
            console.error('Error undoing delete:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('undo-file-operation', async (event, operation) => {
        const kind = operation?.kind;
        const sourcePath = kind === 'move' ? operation.targetPath : operation?.trashPath;
        if (!['delete', 'move'].includes(kind)) {
            return { success: false, error: '无法识别的撤销操作' };
        }

        try {
            return await restoreFileOperation({
                sourcePath,
                originalPath: operation.originalPath,
                path,
                pathExists,
                reserveAvailablePath,
                moveFileSafely,
                moveHashMapping,
                missingSourceError: '找不到待撤销的文件'
            });
        } catch (error) {
            console.error('Error undoing file operation:', error);
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
            const imageEntries = await getImageEntries(trashFolder);
            const stats = await mapWithConcurrency(imageEntries, FILE_OPERATION_CONCURRENCY, async (entry) => {
                return fsp.stat(path.join(trashFolder, entry.name));
            });
            const totalSize = stats.reduce((total, entryStats) => total + entryStats.size, 0);

            return { count: stats.length, size: totalSize, path: trashFolder };
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
            await mapWithConcurrency(imageEntries, FILE_OPERATION_CONCURRENCY, (entry) => {
                return fsp.unlink(path.join(trashFolder, entry.name));
            });

            return { success: true, deletedCount: imageEntries.length };
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
                    imageScoresByHash: store.getAllImageScores(),
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
            if (Object.keys(updates).length > 0) getStore().setMany(updates);
            if (config.imageScoresByHash && typeof config.imageScoresByHash === 'object') {
                getStore().replaceImageScores(config.imageScoresByHash);
            }
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

    return fileOperationServices;
}

async function restoreFileOperation({
    sourcePath,
    originalPath,
    path,
    pathExists,
    reserveAvailablePath,
    moveFileSafely,
    moveHashMapping,
    missingSourceError
}) {
    if (typeof sourcePath !== 'string' || typeof originalPath !== 'string') {
        return { success: false, error: '撤销操作的文件路径无效' };
    }
    if (!(await pathExists(sourcePath))) {
        return { success: false, error: missingSourceError };
    }

    const originalDir = path.dirname(originalPath);
    if (!(await pathExists(originalDir))) {
        return { success: false, error: '原始目录不存在' };
    }

    const restoreTimestamp = Date.now();
    const restorePath = await reserveAvailablePath(originalPath, (counter) => {
        const ext = path.extname(originalPath);
        const baseName = path.basename(originalPath, ext);
        return path.join(originalDir, `${baseName}_restored_${restoreTimestamp}_${counter}${ext}`);
    });

    await moveFileSafely(sourcePath, restorePath);
    moveHashMapping(sourcePath, restorePath);

    return { success: true, restoredPath: restorePath, originalPath };
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
