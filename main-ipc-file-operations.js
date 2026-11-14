function registerFileOperationHandlers({ ipcMain, path, imageFileOperations }) {
    const retainedPageLimit = 5;
    const retainedPages = [];
    let nextPageId = 1;
    let pageQueue = Promise.resolve();
    let isQuitting = false;
    const activeWaterfallPageProcesses = new Set();

    function runPageTask(task) {
        const operation = pageQueue.then(task, task);
        pageQueue = operation.catch(() => {});
        return operation;
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
        if (isQuitting) {
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
        const validationError = validateWaterfallFolders({
            ratedPaths,
            targetFolder,
            path
        });
        if (validationError) return { success: false, error: validationError };

        if (page?.retainPage === true) {
            return runPageTask(async () => {
                const sourcePaths = new Set([...ratedPaths, ...unratedPaths]);
                const retainedPage = {
                    id: `waterfall-page-${nextPageId++}`,
                    paths: [...new Set([
                        ...(Array.isArray(page.imagePaths) ? page.imagePaths : []), ...sourcePaths
                    ])].filter(imagePath => sourcePaths.has(imagePath)),
                    ratedImages: [...ratedByPath].map(([imagePath, score]) => ({ path: imagePath, score })),
                    unratedPaths,
                    targetFolder,
                    pageSize: page.pageSize
                };
                if (retainedPage.paths.length > 0) retainedPages.push(retainedPage);
                const result = {
                    success: true, moved: [], deleted: [], failures: [],
                    pending: retainedPage.paths.map(originalPath => ({ originalPath })),
                    pendingBatchId: retainedPage.paths.length > 0 ? retainedPage.id : null,
                    releasedBatchIds: []
                };
                while (retainedPages.length > retainedPageLimit) {
                    const oldestPage = retainedPages.shift();
                    const committed = await commitPage(oldestPage);
                    result.moved.push(...committed.moved);
                    result.deleted.push(...committed.deleted);
                    result.failures.push(...committed.failures);
                    result.success = result.success && committed.success;
                    const completed = new Set([
                        ...committed.moved.map(item => item.originalPath),
                        ...committed.deleted.map(item => item.originalPath)
                    ]);
                    const remaining = oldestPage.paths.filter(imagePath => !completed.has(imagePath));
                    if (remaining.length > 0) {
                        const remainingSet = new Set(remaining);
                        retainedPages.unshift({
                            ...oldestPage, paths: remaining,
                            ratedImages: oldestPage.ratedImages.filter(item => remainingSet.has(item.path)),
                            unratedPaths: oldestPage.unratedPaths.filter(imagePath => remainingSet.has(imagePath))
                        });
                        break;
                    }
                    result.releasedBatchIds.push(oldestPage.id);
                }
                return result;
            });
        }

        return performPageOperations(ratedByPath, unratedPaths, targetFolder);
    }

    async function performPageOperations(ratedByPath, unratedPaths, targetFolder) {
        const ratedPaths = [...ratedByPath.keys()];
        const result = { moved: [], deleted: [], failures: [] };
        let action = 'move';
        try {
            const moveResult = await imageFileOperations.moveMany(ratedPaths, targetFolder);
            result.moved.push(...moveResult.moved.map(item => ({
                ...item,
                score: ratedByPath.get(item.originalPath)
            })));
            result.failures.push(...moveResult.failures.map(failure => ({
                ...failure,
                action: 'move'
            })));

            action = 'delete';
            const trashResult = await imageFileOperations.trashSystemMany(unratedPaths);
            result.deleted.push(...trashResult.deleted);
            result.failures.push(...trashResult.failures);
            return { success: true, ...result };
        } catch (error) {
            console.error('Error processing waterfall page:', error);
            const failedPaths = action === 'move' ? ratedPaths : unratedPaths;
            result.failures.push(...failedPaths.map(sourcePath => ({
                path: sourcePath,
                fileName: path.basename(sourcePath),
                action,
                targetPath: action === 'move' ? targetFolder : '',
                error: error.message || String(error),
                code: error.code || '',
                syscall: error.syscall || ''
            })));
            return { success: false, error: error.message, ...result };
        }
    }

    function commitPage(page) {
        return performPageOperations(getRatedImages(page.ratedImages), page.unratedPaths, page.targetFolder);
    }

    ipcMain.handle('restore-waterfall-pending-page', (event, pageId) => {
        if (isQuitting) return { success: false, error: '应用正在退出，无法返回上一页' };
        return runPageTask(async () => {
            const index = retainedPages.findIndex(page => page.id === pageId);
            if (index < 0) return { success: false, error: '这一轮已提交整理，无法返回' };
            const [page] = retainedPages.splice(index, 1);
            return {
                success: true, paths: [...page.paths],
                ratedImages: page.ratedImages.map(item => ({ ...item })), pageSize: page.pageSize
            };
        });
    });

    ipcMain.handle('get-waterfall-pending-pages', async () => {
        await Promise.allSettled([...activeWaterfallPageProcesses]);
        return runPageTask(async () => retainedPages.map(page => ({
            id: page.id, paths: [...page.paths],
            ratedImages: page.ratedImages.map(item => ({ ...item })), pageSize: page.pageSize
        })));
    });

    async function waitForWaterfallOperations() {
        isQuitting = true;
        await Promise.allSettled([...activeWaterfallPageProcesses]);
    }

    async function flushPendingWaterfallCleanup() {
        await waitForWaterfallOperations();
        return runPageTask(async () => {
            const result = { moved: [], deleted: [], failures: [] };
            while (retainedPages.length > 0) {
                const committed = await commitPage(retainedPages.shift());
                result.moved.push(...committed.moved);
                result.deleted.push(...committed.deleted);
                result.failures.push(...committed.failures);
            }
            return result;
        });
    }

    return { waitForWaterfallOperations, flushPendingWaterfallCleanup };
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

function validateWaterfallFolders({ ratedPaths, targetFolder, path }) {
    if (ratedPaths.length > 0 && !targetFolder) return '请先选择目标文件夹';

    if (ratedPaths.some(sourcePath => path.resolve(path.dirname(sourcePath)) === path.resolve(targetFolder))) {
        return '目标文件夹不能与当前评分文件夹相同';
    }
    return '';
}

module.exports = registerFileOperationHandlers;
