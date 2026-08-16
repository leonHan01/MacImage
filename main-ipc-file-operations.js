const FILE_OPERATION_CONCURRENCY = 6;

function registerFileOperationHandlers(deps) {
    const {
        ipcMain,
        path,
        fsp,
        getStore,
        mapWithConcurrency,
        getAvailablePath,
        getNumberedPath,
        pathExists,
        moveHashMapping,
        moveHashMappings
    } = deps;

    ipcMain.handle('migrate-images', async (event, filePaths, targetFolder) => {
        try {
            const result = { movedCount: 0, skippedCount: 0, errors: [] };
            const hashMoves = [];
            const migrationGroups = groupPathsByFileName(filePaths, path);
            await mapWithConcurrency(migrationGroups, FILE_OPERATION_CONCURRENCY, async (pathsWithSameName) => {
                for (const sourcePath of pathsWithSameName) {
                    await migrateOneImage({
                        sourcePath,
                        targetFolder,
                        result,
                        path,
                        fsp,
                        pathExists,
                        getNumberedPath,
                        moveHashMapping,
                        hashMoves
                    });
                }
            });
            moveHashMappings(hashMoves);
            return { success: true, ...result, totalFound: result.movedCount + result.skippedCount };
        } catch (error) {
            console.error('Error migrating images:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('move-tagged-image-to-target', async (event, sourcePath, targetFolder) => {
        if (typeof sourcePath !== 'string' || typeof targetFolder !== 'string') {
            return { success: false, error: '图片路径或目标文件夹无效' };
        }
        if (path.resolve(path.dirname(sourcePath)) === path.resolve(targetFolder)) {
            return { success: true, moved: false, path: sourcePath };
        }

        const result = { movedCount: 0, skippedCount: 0, errors: [] };
        const moveResult = await migrateOneImage({
            sourcePath,
            targetFolder,
            result,
            path,
            fsp,
            pathExists,
            getNumberedPath,
            moveHashMapping
        });
        if (!moveResult.success) {
            return { success: false, error: moveResult.error };
        }
        return { success: true, moved: true, path: moveResult.targetPath };
    });

    ipcMain.handle('process-waterfall-page', async (event, page) => {
        const ratedByPath = getRatedImages(page?.ratedImages);
        const unratedPaths = getUnratedPaths(page?.unratedPaths, ratedByPath);
        const ratedPaths = [...ratedByPath.keys()];
        const targetFolder = typeof page?.targetFolder === 'string' ? page.targetFolder : '';
        const trashFolder = getStore().get('trashFolder');
        const validationError = validateWaterfallFolders({
            ratedPaths,
            unratedPaths,
            targetFolder,
            trashFolder,
            path
        });
        if (validationError) return { success: false, error: validationError };

        const result = { moved: [], deleted: [], failures: [] };
        try {
            await moveRatedImages({
                ratedByPath,
                targetFolder,
                result,
                path,
                fsp,
                pathExists,
                getNumberedPath,
                moveHashMapping
            });
            await moveUnratedImagesToTrash({
                unratedPaths,
                trashFolder,
                result,
                path,
                fsp,
                getAvailablePath,
                moveHashMapping
            });
            return { success: true, ...result };
        } catch (error) {
            console.error('Error processing waterfall page:', error);
            return { success: false, error: error.message, ...result };
        }
    });
}

function getRatedImages(ratedImages) {
    const ratedByPath = new Map();
    (Array.isArray(ratedImages) ? ratedImages : []).forEach((item) => {
        if (!item || typeof item.path !== 'string') return;
        const score = Number(item.score);
        if ([1, 2, 3].includes(score)) ratedByPath.set(item.path, score);
    });
    return ratedByPath;
}

function getUnratedPaths(unratedPaths, ratedByPath) {
    return [...new Set((Array.isArray(unratedPaths) ? unratedPaths : [])
        .filter(imagePath => typeof imagePath === 'string' && !ratedByPath.has(imagePath)))];
}

function validateWaterfallFolders({ ratedPaths, unratedPaths, targetFolder, trashFolder, path }) {
    if (ratedPaths.length > 0 && !targetFolder) return '请先选择目标文件夹';
    if (unratedPaths.length > 0 && !trashFolder) return '请先设置回收站文件夹';

    const sourcePaths = [...ratedPaths, ...unratedPaths];
    if (ratedPaths.length > 0 && sourcePaths.some(sourcePath => path.resolve(path.dirname(sourcePath)) === path.resolve(targetFolder))) {
        return '目标文件夹不能与当前评分文件夹相同';
    }
    if (unratedPaths.length > 0 && sourcePaths.some(sourcePath => path.resolve(path.dirname(sourcePath)) === path.resolve(trashFolder))) {
        return '回收站文件夹不能与当前评分文件夹相同';
    }
    if (ratedPaths.length > 0 && unratedPaths.length > 0 && path.resolve(targetFolder) === path.resolve(trashFolder)) {
        return '目标文件夹和回收站文件夹不能相同';
    }
    return '';
}

async function moveRatedImages({ ratedByPath, targetFolder, result, path, fsp, pathExists, getNumberedPath, moveHashMapping }) {
    const ratedPaths = [...ratedByPath.keys()];
    if (ratedPaths.length === 0) return;

    await fsp.mkdir(targetFolder, { recursive: true });
    for (const sourcePath of ratedPaths) {
        const moveResult = await migrateOneImage({
            sourcePath,
            targetFolder,
            result: { movedCount: 0, skippedCount: 0, errors: [] },
            path,
            fsp,
            pathExists,
            getNumberedPath,
            moveHashMapping
        });
        if (moveResult.success) {
            result.moved.push({ originalPath: sourcePath, targetPath: moveResult.targetPath, score: ratedByPath.get(sourcePath) });
        } else {
            result.failures.push({ path: sourcePath, action: 'move', error: moveResult.error });
        }
    }
}

async function moveUnratedImagesToTrash({ unratedPaths, trashFolder, result, path, fsp, getAvailablePath, moveHashMapping }) {
    if (unratedPaths.length === 0) return;

    await fsp.mkdir(trashFolder, { recursive: true });
    const batchTimestamp = Date.now();
    for (let index = 0; index < unratedPaths.length; index++) {
        const sourcePath = unratedPaths[index];
        const fileName = path.basename(sourcePath);
        const ext = path.extname(fileName);
        const baseName = path.basename(fileName, ext);
        const preferredPath = path.join(trashFolder, `${baseName}_${batchTimestamp}_${index}${ext}`);
        try {
            const trashPath = await getAvailablePath(
                preferredPath,
                (counter) => path.join(trashFolder, `${baseName}_${batchTimestamp}_${index}_${counter}${ext}`)
            );
            await fsp.rename(sourcePath, trashPath);
            moveHashMapping(sourcePath, trashPath);
            result.deleted.push({ originalPath: sourcePath, trashPath, fileName });
        } catch (error) {
            result.failures.push({ path: sourcePath, action: 'delete', error: error.message });
        }
    }
}

async function migrateOneImage({ sourcePath, targetFolder, result, path, fsp, pathExists, getNumberedPath, moveHashMapping, hashMoves = null }) {
    const file = path.basename(sourcePath);
    try {
        if (!(await pathExists(sourcePath))) throw new Error('源文件不存在');

        const targetPath = await getNumberedPath(path.join(targetFolder, file));
        await fsp.rename(sourcePath, targetPath);
        if (hashMoves) {
            hashMoves.push({ fromPath: sourcePath, toPath: targetPath });
        } else {
            moveHashMapping(sourcePath, targetPath);
        }
        result.movedCount++;
        return { success: true, targetPath };
    } catch (error) {
        result.errors.push({ file, error: error.message });
        result.skippedCount++;
        return { success: false, error: error.message };
    }
}

function groupPathsByFileName(filePaths, path) {
    const groups = new Map();
    (Array.isArray(filePaths) ? filePaths : []).forEach((filePath) => {
        if (typeof filePath !== 'string') return;
        const fileName = path.basename(filePath);
        if (!groups.has(fileName)) groups.set(fileName, []);
        groups.get(fileName).push(filePath);
    });
    return [...groups.values()];
}

module.exports = registerFileOperationHandlers;
