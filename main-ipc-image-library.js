const ratingModel = require('./rating-model');

function registerImageLibraryHandlers({ ipcMain, store, imageLibrary, logger = console }) {
    ipcMain.handle('read-directory', async (event, directory, requestId) => {
        try {
            return await imageLibrary.readDirectory(directory, {
                onMetadata: (updates) => {
                    if (event.sender.isDestroyed()) return;
                    event.sender.send('directory-image-metadata', {
                        dirPath: directory,
                        updates,
                        ...(requestId === undefined ? {} : { requestId })
                    });
                }
            });
        } catch (error) {
            logger.error('Error reading directory:', error);
            return [];
        }
    });

    ipcMain.handle('get-tags', () => store.get('tags') || []);
    ipcMain.handle('save-tags', (event, tags) => {
        store.set('tags', tags);
        return true;
    });
    ipcMain.handle('remove-tag-from-all-images', (event, tagName) => {
        if (typeof tagName !== 'string' || !tagName) {
            return { success: false, error: '标签名无效' };
        }
        return { success: true, removedCount: store.removeTagFromAllImages(tagName) };
    });
    ipcMain.handle('rename-tag-across-all-images', (event, currentName, nextName) => {
        if (typeof currentName !== 'string' || !currentName || typeof nextName !== 'string' || !nextName) {
            return { success: false, error: '标签名无效' };
        }
        return { success: true, renamedCount: store.renameTagAcrossAllImages(currentName, nextName) };
    });

    ipcMain.handle('get-image-hash', async (event, imagePath) => {
        try {
            return await imageLibrary.getHash(imagePath);
        } catch (error) {
            logger.error('Failed to calculate hash:', error.message);
            return null;
        }
    });

    ipcMain.handle('record-competition-result', async (event, winnerPath, loserPath) => {
        try {
            const winnerHash = await imageLibrary.getHash(winnerPath);
            const loserHash = await imageLibrary.getHash(loserPath);
            const nextRecords = ratingModel.recordWin(
                store.getImageScore(winnerHash),
                [store.getImageScore(loserHash)]
            );
            const loserRecord = nextRecords.losers[0];
            store.setImageScores({
                [winnerHash]: nextRecords.winner,
                [loserHash]: loserRecord
            });
            return {
                success: true,
                winner: { hash: winnerHash, record: nextRecords.winner },
                loser: { hash: loserHash, record: loserRecord }
            };
        } catch (error) {
            logger.error('Failed to record competition result:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('record-competition-group-result', async (event, winnerPath, loserPaths) => {
        try {
            const winnerHash = await imageLibrary.getHash(winnerPath);
            const uniqueLoserPaths = [...new Set(Array.isArray(loserPaths) ? loserPaths : [])]
                .filter(candidatePath => candidatePath && candidatePath !== winnerPath);
            const loserEntries = [];

            for (const loserPath of uniqueLoserPaths) {
                const loserHash = await imageLibrary.getHash(loserPath);
                if (loserHash !== winnerHash) loserEntries.push({ path: loserPath, hash: loserHash });
            }

            const nextRecords = ratingModel.recordWin(
                store.getImageScore(winnerHash),
                loserEntries.map(entry => store.getImageScore(entry.hash))
            );
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
        } catch (error) {
            logger.error('Failed to record competition group result:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-thumbnail', async (event, imagePath, size) => {
        try {
            return { success: true, ...await imageLibrary.getThumbnail(imagePath, size) };
        } catch (error) {
            logger.error('Failed to get thumbnail:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('find-duplicate-images', async (event, candidates) => {
        try {
            return { success: true, ...await imageLibrary.findDuplicates(candidates) };
        } catch (error) {
            logger.error('Error finding duplicate images:', error);
            return { success: false, error: error.message, groups: [], failures: [] };
        }
    });

    ipcMain.handle('add-tag-to-image', async (event, imagePath, tag) => {
        const hash = await getImageHashOrNull(imageLibrary, imagePath, logger);
        return hash ? store.addImageTag(hash, tag) : [];
    });

    ipcMain.handle('remove-tag-from-image', async (event, imagePath, tag) => {
        const hash = await getImageHashOrNull(imageLibrary, imagePath, logger);
        return hash ? store.removeImageTag(hash, tag) : [];
    });
}

async function getImageHashOrNull(imageLibrary, imagePath, logger) {
    try {
        return await imageLibrary.getHash(imagePath);
    } catch (error) {
        logger.error('Failed to calculate hash:', error.message);
        return null;
    }
}

module.exports = registerImageLibraryHandlers;
