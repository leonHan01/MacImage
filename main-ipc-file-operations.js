const FILE_OPERATION_CONCURRENCY = 6;
const WATERFALL_DEFERRED_PAGE_LIMIT = 5;

function registerFileOperationHandlers(deps) {
    const {
        ipcMain,
        path,
        fsp,
        getStore,
        mapWithConcurrency,
        reserveAvailablePath,
        getNumberedPath,
        pathExists,
        moveFileSafely,
        moveHashMapping,
        moveHashMappings
    } = deps;
    const deferredWaterfallPages = [];
    let nextDeferredWaterfallPageId = 1;
    let deferredCleanupWork = Promise.resolve();
    let isFlushingDeferredWaterfallCleanup = false;
    const activeWaterfallPageProcesses = new Set();

    function runDeferredCleanupTask(task) {
        const result = deferredCleanupWork.then(task, task);
        deferredCleanupWork = result.catch(() => {});
        return result;
    }

    ipcMain.handle('migrate-images', async (event, filePaths, targetFolder) => {
        try {
            const result = { movedCount: 0, skippedCount: 0, errors: [], moved: [] };
            const hashMoves = [];
            const migrationGroups = groupPathsByFileName(filePaths, path);
            await mapWithConcurrency(migrationGroups, FILE_OPERATION_CONCURRENCY, async (pathsWithSameName) => {
                for (const sourcePath of pathsWithSameName) {
                    const moveResult = await migrateOneImage({
                        sourcePath,
                        targetFolder,
                        result,
                        path,
                        fsp,
                        pathExists,
                        getNumberedPath,
                        moveFileSafely,
                        moveHashMapping,
                        hashMoves
                    });
                    if (moveResult.success) {
                        result.moved.push({
                            originalPath: sourcePath,
                            targetPath: moveResult.targetPath
                        });
                    }
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
            moveFileSafely,
            moveHashMapping
        });
        if (!moveResult.success) {
            return { success: false, error: moveResult.error };
        }
        return { success: true, moved: true, path: moveResult.targetPath };
    });

    ipcMain.handle('process-waterfall-page', (event, page) => {
        if (isFlushingDeferredWaterfallCleanup) {
            return { success: false, error: '应用正在退出，无法继续翻页' };
        }

        const operation = processWaterfallPage(page);
        activeWaterfallPageProcesses.add(operation);
        void operation.then(
            () => activeWaterfallPageProcesses.delete(operation),
            () => activeWaterfallPageProcesses.delete(operation)
        );
        return operation;
    });

    async function processWaterfallPage(page) {
        const ratedByPath = getRatedImages(page?.ratedImages);
        const unratedPaths = getUnratedPaths(page?.unratedPaths, ratedByPath);
        const ratedPaths = [...ratedByPath.keys()];
        const targetFolder = typeof page?.targetFolder === 'string' ? page.targetFolder : '';
        const deferUnrated = page?.deferUnrated === true;
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
                moveFileSafely,
                moveHashMapping
            });
            if (deferUnrated) {
                const deferredResult = await runDeferredCleanupTask(async () => {
                    const pendingPage = stageWaterfallPage({
                        deferredWaterfallPages,
                        pageId: `waterfall-pending-${nextDeferredWaterfallPageId++}`,
                        unratedPaths,
                        trashFolder
                    });
                    const releasedBatchIds = [];

                    while (deferredWaterfallPages.length > WATERFALL_DEFERRED_PAGE_LIMIT) {
                        const oldestPage = deferredWaterfallPages.shift();
                        releasedBatchIds.push(oldestPage.id);
                        const failedPaths = await commitDeferredWaterfallPage({
                            pendingPage: oldestPage,
                            result,
                            path,
                            fsp,
                            reserveAvailablePath,
                            moveFileSafely,
                            moveHashMapping
                        });
                        if (failedPaths.length > 0) {
                            deferredWaterfallPages.unshift({ ...oldestPage, paths: failedPaths });
                            break;
                        }
                    }

                    return { pendingPage, releasedBatchIds };
                });
                result.pending = deferredResult.pendingPage.paths.map(originalPath => ({ originalPath }));
                result.pendingBatchId = deferredResult.pendingPage.paths.length > 0
                    ? deferredResult.pendingPage.id
                    : null;
                result.releasedBatchIds = deferredResult.releasedBatchIds;
            } else {
                await moveUnratedImagesToTrash({
                    unratedPaths,
                    trashFolder,
                    result,
                    path,
                    fsp,
                    reserveAvailablePath,
                    moveFileSafely,
                    moveHashMapping
                });
            }
            return { success: true, ...result };
        } catch (error) {
            console.error('Error processing waterfall page:', error);
            return { success: false, error: error.message, ...result };
        }
    }

    ipcMain.handle('restore-waterfall-pending-page', async (event, pageId) => {
        if (isFlushingDeferredWaterfallCleanup) {
            return { success: false, error: '应用正在退出，无法返回上一页' };
        }
        return runDeferredCleanupTask(async () => {
            const pageIndex = deferredWaterfallPages.findIndex(page => page.id === pageId);
            if (pageIndex < 0) {
                return { success: false, error: '这页待清理图片已提交，无法返回' };
            }

            const [pendingPage] = deferredWaterfallPages.splice(pageIndex, 1);
            return { success: true, paths: [...pendingPage.paths] };
        });
    });

    ipcMain.handle('get-waterfall-pending-paths', () => {
        return runDeferredCleanupTask(async () => (
            deferredWaterfallPages.flatMap(pendingPage => pendingPage.paths)
        ));
    });

    async function flushPendingWaterfallCleanup() {
        isFlushingDeferredWaterfallCleanup = true;
        await Promise.allSettled([...activeWaterfallPageProcesses]);
        return runDeferredCleanupTask(async () => {
            const result = { deleted: [], failures: [] };
            while (deferredWaterfallPages.length > 0) {
                const pendingPage = deferredWaterfallPages.shift();
                await commitDeferredWaterfallPage({
                    pendingPage,
                    result,
                    path,
                    fsp,
                    reserveAvailablePath,
                    moveFileSafely,
                    moveHashMapping
                });
            }
            return result;
        });
    }

    return { flushPendingWaterfallCleanup };
}

function stageWaterfallPage({ deferredWaterfallPages, pageId, unratedPaths, trashFolder }) {
    const pendingPage = {
        id: pageId,
        paths: [...unratedPaths],
        trashFolder
    };
    if (pendingPage.paths.length > 0) {
        deferredWaterfallPages.push(pendingPage);
    }
    return pendingPage;
}

async function commitDeferredWaterfallPage({
    pendingPage,
    result,
    path,
    fsp,
    reserveAvailablePath,
    moveFileSafely,
    moveHashMapping
}) {
    const pageResult = { deleted: [], failures: [] };
    try {
        await moveUnratedImagesToTrash({
            unratedPaths: pendingPage.paths,
            trashFolder: pendingPage.trashFolder,
            result: pageResult,
            path,
            fsp,
            reserveAvailablePath,
            moveFileSafely,
            moveHashMapping
        });
    } catch (error) {
        const completedPaths = new Set([
            ...pageResult.deleted.map(item => item.originalPath),
            ...pageResult.failures.map(item => item.path)
        ]);
        pendingPage.paths
            .filter(sourcePath => !completedPaths.has(sourcePath))
            .forEach(sourcePath => pageResult.failures.push({
                path: sourcePath,
                action: 'delete',
                error: error.message
            }));
    }
    result.deleted.push(...pageResult.deleted);
    result.failures.push(...pageResult.failures);
    return pageResult.failures.map(failure => failure.path);
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

async function moveRatedImages({ ratedByPath, targetFolder, result, path, fsp, pathExists, getNumberedPath, moveFileSafely, moveHashMapping }) {
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
            moveFileSafely,
            moveHashMapping
        });
        if (moveResult.success) {
            result.moved.push({ originalPath: sourcePath, targetPath: moveResult.targetPath, score: ratedByPath.get(sourcePath) });
        } else {
            result.failures.push({ path: sourcePath, action: 'move', error: moveResult.error });
        }
    }
}

async function moveUnratedImagesToTrash({ unratedPaths, trashFolder, result, path, fsp, reserveAvailablePath, moveFileSafely, moveHashMapping }) {
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
            const trashPath = await reserveAvailablePath(
                preferredPath,
                (counter) => path.join(trashFolder, `${baseName}_${batchTimestamp}_${index}_${counter}${ext}`)
            );
            await moveFileSafely(sourcePath, trashPath);
            moveHashMapping(sourcePath, trashPath);
            result.deleted.push({ originalPath: sourcePath, trashPath, fileName });
        } catch (error) {
            result.failures.push({ path: sourcePath, action: 'delete', error: error.message });
        }
    }
}

async function migrateOneImage({ sourcePath, targetFolder, result, path, fsp, pathExists, getNumberedPath, moveFileSafely, moveHashMapping, hashMoves = null }) {
    const file = path.basename(sourcePath);
    try {
        if (!(await pathExists(sourcePath))) throw new Error('源文件不存在');

        const targetPath = await getNumberedPath(path.join(targetFolder, file));
        await moveFileSafely(sourcePath, targetPath);
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
