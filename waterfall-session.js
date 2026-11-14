(function exposeWaterfallSession(root, factory) {
    const waterfallSession = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = waterfallSession;
        return;
    }

    root.MacImageWaterfallSession = waterfallSession;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    function create(options = {}) {
        const allowedPageSizes = Array.isArray(options.allowedPageSizes) && options.allowedPageSizes.length > 0
            ? [...options.allowedPageSizes]
            : [2, 3, 10];
        const processPage = options.processPage || (async () => ({ success: false, error: '评分整理不可用' }));
        const restorePendingPage = options.restorePendingPage || (async () => ({ success: false, error: '恢复上一页不可用' }));
        const wheelThreshold = Number(options.wheelThreshold) || 80;
        const wheelResetMs = Number(options.wheelResetMs) || 240;
        const scores = new Map();
        let pageSize = allowedPageSizes.includes(Number(options.pageSize))
            ? Number(options.pageSize)
            : allowedPageSizes[0];
        let batchNumber = 1;
        let processedCount = 0;
        let movedCount = 0;
        let movedSize = 0;
        let deletedCount = 0;
        let deletedSize = 0;
        let status = '';
        let failureDetails = [];
        let isProcessing = false;
        let wheelDelta = 0;
        let lastWheelTime = 0;
        let pendingPages = [];
        let restoredPagePaths = null;

        function snapshot(images = [], config = {}) {
            const imageList = Array.isArray(images) ? images : [];
            const pageImages = getPageImages(imageList);
            return {
                pageImages,
                scores: new Map(scores),
                pageSize,
                batchNumber,
                processedCount,
                movedCount,
                movedSize,
                deletedCount,
                deletedSize,
                status,
                failureDetails: failureDetails.map(item => ({ ...item })),
                pendingImages: pendingPages.flatMap(page => page.images),
                restorablePageCount: pendingPages.length,
                canRestore: pendingPages.length > 0,
                isProcessing,
                configurationMessage: getConfigurationMessage(pageImages, config)
            };
        }

        function reset({ images = [], pendingPages: savedPages = [] } = {}) {
            scores.clear();
            movedCount = 0;
            movedSize = 0;
            deletedCount = 0;
            deletedSize = 0;
            status = '';
            failureDetails = [];
            isProcessing = false;
            const imagesByPath = new Map(images.map(image => [image.path, image]));
            pendingPages = savedPages.map(page => ({
                id: page.id,
                images: page.paths.map(imagePath => imagesByPath.get(imagePath)).filter(Boolean),
                ratedImages: (page.ratedImages || []).map(item => ({ ...item })),
                pageSize: allowedPageSizes.includes(page.pageSize) ? page.pageSize : pageSize
            })).filter(page => page.images.length > 0);
            processedCount = pendingPages.reduce((count, page) => count + page.images.length, 0);
            batchNumber = pendingPages.length + 1;
            restoredPagePaths = null;
            wheelDelta = 0;
            lastWheelTime = 0;
        }

        function clearStatus() {
            status = '';
            failureDetails = [];
        }

        function setPageSize(value) {
            const nextPageSize = Number(value);
            if (isProcessing || !allowedPageSizes.includes(nextPageSize) || nextPageSize === pageSize) return false;
            pageSize = nextPageSize;
            clearStatus();
            return true;
        }

        function score(imagePath, value, { toggle = true } = {}) {
            const nextScore = Number(value);
            if (typeof imagePath !== 'string' || !imagePath || ![1, 2, 3].includes(nextScore) || isProcessing) {
                return false;
            }

            if (toggle && scores.get(imagePath) === nextScore) {
                scores.delete(imagePath);
            } else {
                scores.set(imagePath, nextScore);
            }
            clearStatus();
            return true;
        }

        function consumeDownScroll(delta, now = Date.now()) {
            const normalizedDelta = Number(delta);
            if (isProcessing || !Number.isFinite(normalizedDelta) || normalizedDelta <= 0) {
                return { handled: false, advance: false };
            }

            if (now - lastWheelTime > wheelResetMs) wheelDelta = 0;
            lastWheelTime = now;
            wheelDelta += normalizedDelta;
            if (wheelDelta < wheelThreshold) return { handled: true, advance: false };

            wheelDelta = 0;
            return { handled: true, advance: true };
        }

        async function advance(images, config = {}) {
            if (isProcessing) return emptyOutcome(false);
            const pageImages = getPageImages(Array.isArray(images) ? images : []);
            if (pageImages.length === 0) return emptyOutcome(false);
            clearStatus();

            const configurationMessage = getConfigurationMessage(pageImages, config);
            if (configurationMessage) {
                status = configurationMessage;
                return emptyOutcome(false);
            }

            const ratedImages = pageImages
                .filter(image => scores.has(image.path))
                .map(image => ({ path: image.path, score: scores.get(image.path) }));
            const unratedPaths = pageImages
                .filter(image => !scores.has(image.path))
                .map(image => image.path);
            isProcessing = true;

            try {
                let result = await processPage({
                    ratedImages,
                    unratedPaths,
                    targetFolder: config.targetFolder || '',
                    retainPage: true,
                    imagePaths: pageImages.map(image => image.path),
                    pageSize
                });
                if (!result?.success && !result?.failures?.length) {
                    result = {
                        ...result,
                        failures: [{
                            action: 'process', path: config.currentFolder || '',
                            targetPath: config.targetFolder || '',
                            error: result?.error || '未知错误', code: result?.code || ''
                        }]
                    };
                }
                return applyProcessResult(result, pageImages);
            } catch (error) {
                status = `整理失败：${error.message || error}`;
                failureDetails = [{
                    action: 'process', path: config.currentFolder || '',
                    targetPath: config.targetFolder || '',
                    error: error.message || String(error), code: error.code || '', syscall: error.syscall || ''
                }];
                return emptyOutcome(false);
            } finally {
                isProcessing = false;
            }
        }

        async function restore(images = []) {
            if (isProcessing || pendingPages.length === 0) return { success: false, restoredImages: [] };
            const page = pendingPages[pendingPages.length - 1];
            isProcessing = true;
            clearStatus();
            try {
                const result = await restorePendingPage(page.id);
                if (!result?.success) throw new Error(result?.error || '未知错误');
                const restoredPaths = new Set(result.paths || []);
                const existingPaths = new Set(images.map(image => image.path));
                const restoredImages = page.images.filter(image => restoredPaths.has(image.path) && !existingPaths.has(image.path));
                pendingPages.pop();
                for (const item of result.ratedImages || page.ratedImages) {
                    if (restoredPaths.has(item.path)) scores.set(item.path, item.score);
                }
                if (allowedPageSizes.includes(page.pageSize)) pageSize = page.pageSize;
                restoredPagePaths = restoredImages.length > 0 ? restoredImages.map(image => image.path) : null;
                processedCount = Math.max(0, processedCount - restoredImages.length);
                batchNumber = Math.max(1, batchNumber - 1);
                status = `已返回上一轮 ${restoredImages.length} 张图片，还可返回 ${pendingPages.length} 轮。`;
                return { success: true, restoredImages };
            } catch (error) {
                status = '返回上一页失败，详细原因如下。';
                failureDetails = [{ action: 'restore', error: error.message || String(error), code: error.code || '' }];
                return { success: false, restoredImages: [] };
            } finally {
                isProcessing = false;
            }
        }

        function applyProcessResult(result, pageImages) {
            const moved = Array.isArray(result.moved) ? result.moved : [];
            const deleted = Array.isArray(result.deleted) ? result.deleted : [];
            const pending = Array.isArray(result.pending) ? result.pending : [];
            const pageImagesByPath = new Map([
                ...pendingPages.flatMap(page => page.images), ...pageImages
            ].map(image => [image.path, image]));
            const committedPaths = new Set([...moved, ...deleted].map(item => item.originalPath));
            const releasedIds = new Set(result.releasedBatchIds || []);
            pendingPages = pendingPages.filter(page => !releasedIds.has(page.id)).map(page => ({
                ...page,
                images: page.images.filter(image => !committedPaths.has(image.path)),
                ratedImages: page.ratedImages.filter(item => !committedPaths.has(item.path))
            })).filter(page => page.images.length > 0);
            if (result.pendingBatchId && pending.length > 0) {
                const pendingPaths = new Set(pending.map(item => item.originalPath));
                pendingPages.push({
                    id: result.pendingBatchId,
                    images: pageImages.filter(image => pendingPaths.has(image.path)),
                    ratedImages: pageImages.filter(image => pendingPaths.has(image.path) && scores.has(image.path))
                        .map(image => ({ path: image.path, score: scores.get(image.path) })),
                    pageSize
                });
            }

            const processedPaths = new Set([
                ...moved.map(item => item.originalPath),
                ...deleted.map(item => item.originalPath),
                ...pending.map(item => item.originalPath)
            ]);
            const currentPagePaths = new Set(pageImages.map(image => image.path));
            const currentProcessedCount = [...processedPaths]
                .filter(imagePath => currentPagePaths.has(imagePath)).length;
            if (restoredPagePaths) {
                const remaining = restoredPagePaths.filter(imagePath => !processedPaths.has(imagePath));
                restoredPagePaths = remaining.length > 0 ? remaining : null;
            }

            const operations = [
                ...moved.map(item => ({
                    kind: 'move',
                    originalPath: item.originalPath,
                    targetPath: item.targetPath
                })),
                ...deleted.map(item => ({
                    kind: 'system-trash',
                    originalPath: item.originalPath,
                    fileName: item.fileName,
                    index: -1,
                    hash: pageImagesByPath.get(item.originalPath)?.hash || null
                }))
            ];

            if (processedPaths.size > 0) {
                movedCount += moved.length;
                movedSize += sumImageSizes(moved.map(item => pageImagesByPath.get(item.originalPath)));
                deletedCount += deleted.length;
                deletedSize += sumImageSizes(deleted.map(item => pageImagesByPath.get(item.originalPath)));
                processedPaths.forEach(imagePath => scores.delete(imagePath));
                processedCount += currentProcessedCount;
                if (currentProcessedCount > 0) batchNumber++;
            }

            failureDetails = Array.isArray(result.failures) ? result.failures.map(item => ({ ...item })) : [];
            status = failureDetails.length > 0
                ? `${failureDetails.length} 项操作失败，详细原因如下。`
                : '';
            return {
                success: result.success === true,
                processedPaths: [...processedPaths],
                operations,
                failureCount: failureDetails.length
            };
        }

        function getPageImages(images) {
            if (restoredPagePaths) {
                const imagesByPath = new Map(images.map(image => [image.path, image]));
                return restoredPagePaths.map(imagePath => imagesByPath.get(imagePath)).filter(Boolean);
            }
            return images.slice(0, pageSize);
        }

        function getConfigurationMessage(pageImages, config) {
            const hasRatedImages = pageImages.some(image => scores.has(image.path));
            if (hasRatedImages && !config.targetFolder) return '请先选择用于汇集已评分图片的目标文件夹。';
            if (hasRatedImages && config.currentFolder === config.targetFolder) return '目标文件夹不能与当前评分文件夹相同。';
            return '';
        }

        return Object.freeze({
            snapshot,
            reset,
            clearStatus,
            setPageSize,
            score,
            consumeDownScroll,
            advance,
            restore
        });
    }

    function sumImageSizes(images) {
        return images
            .filter(Boolean)
            .reduce((total, image) => total + Math.max(0, Number(image.size) || 0), 0);
    }

    function emptyOutcome(success) {
        return { success, processedPaths: [], operations: [], failureCount: 0 };
    }

    return Object.freeze({ create });
}));
