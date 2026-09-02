const WATERFALL_DEFERRED_PAGE_LIMIT = 5;

function registerFileOperationHandlers({ ipcMain, path, store, imageFileOperations }) {
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
            const result = await imageFileOperations.moveMany(filePaths, targetFolder);
            return {
                success: true,
                movedCount: result.moved.length,
                skippedCount: result.failures.length,
                errors: result.failures.map(({ file, error }) => ({ file, error })),
                moved: result.moved,
                totalFound: result.moved.length + result.failures.length
            };
        } catch (error) {
            console.error('Error migrating images:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('move-tagged-image-to-target', async (event, sourcePath, targetFolder) => {
        try {
            return await imageFileOperations.moveOne(sourcePath, targetFolder);
        } catch (error) {
            return { success: false, error: error.message };
        }
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
        const trashFolder = store.get('trashFolder');
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
            const moveResult = await imageFileOperations.moveMany(ratedPaths, targetFolder);
            result.moved.push(...moveResult.moved.map(item => ({
                ...item,
                score: ratedByPath.get(item.originalPath)
            })));
            result.failures.push(...moveResult.failures.map(failure => ({
                path: failure.path,
                action: 'move',
                error: failure.error
            })));

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
                        const failedPaths = await commitDeferredWaterfallPage(
                            oldestPage,
                            result,
                            imageFileOperations
                        );
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
                const trashResult = await imageFileOperations.trashMany(unratedPaths, trashFolder);
                result.deleted.push(...trashResult.deleted);
                result.failures.push(...trashResult.failures);
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
                await commitDeferredWaterfallPage(pendingPage, result, imageFileOperations);
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

async function commitDeferredWaterfallPage(pendingPage, result, imageFileOperations) {
    try {
        const pageResult = await imageFileOperations.trashMany(pendingPage.paths, pendingPage.trashFolder);
        result.deleted.push(...pageResult.deleted);
        result.failures.push(...pageResult.failures);
        return pageResult.failures.map(failure => failure.path);
    } catch (error) {
        const failures = pendingPage.paths.map(sourcePath => ({
            path: sourcePath,
            action: 'delete',
            error: error.message
        }));
        result.failures.push(...failures);
        return pendingPage.paths;
    }
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

module.exports = registerFileOperationHandlers;
