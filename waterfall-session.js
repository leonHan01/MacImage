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
            : [3, 10];
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
        let isProcessing = false;
        let pendingPages = [];
        let restoredPagePaths = null;
        let wheelDelta = 0;
        let lastWheelTime = 0;

        function snapshot(images = [], config = {}) {
            const imageList = Array.isArray(images) ? images : [];
            const pageImages = getPageImages(imageList);
            return {
                pageImages,
                pendingImages: pendingPages.flatMap(page => page.images),
                scores: new Map(scores),
                pageSize,
                batchNumber,
                processedCount,
                movedCount,
                movedSize,
                deletedCount,
                deletedSize,
                status,
                isProcessing,
                canRestore: pendingPages.length > 0,
                configurationMessage: getConfigurationMessage(pageImages, config)
            };
        }

        function reset() {
            scores.clear();
            batchNumber = 1;
            processedCount = 0;
            movedCount = 0;
            movedSize = 0;
            deletedCount = 0;
            deletedSize = 0;
            status = '';
            isProcessing = false;
            pendingPages = [];
            restoredPagePaths = null;
            wheelDelta = 0;
            lastWheelTime = 0;
        }

        function clearStatus() {
            status = '';
        }

        function setPageSize(value) {
            const nextPageSize = Number(value);
            if (!allowedPageSizes.includes(nextPageSize) || nextPageSize === pageSize) return false;
            pageSize = nextPageSize;
            status = '';
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
            status = '';
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
                const result = await processPage({
                    ratedImages,
                    unratedPaths,
                    targetFolder: config.targetFolder || '',
                    deferUnrated: true
                });
                if (!result?.success) {
                    status = `整理失败：${result?.error || '未知错误'}`;
                    return emptyOutcome(false);
                }
                return applyProcessResult(result, pageImages);
            } catch (error) {
                status = `整理失败：${error.message || error}`;
                return emptyOutcome(false);
            } finally {
                isProcessing = false;
            }
        }

        async function restore(images) {
            if (isProcessing || pendingPages.length === 0) {
                return { success: false, restoredImages: [] };
            }

            const pendingPage = pendingPages[pendingPages.length - 1];
            isProcessing = true;
            try {
                const result = await restorePendingPage(pendingPage.id);
                if (!result?.success) {
                    status = `返回上一页失败：${result?.error || '未知错误'}`;
                    return { success: false, restoredImages: [] };
                }

                const restoredPaths = new Set(Array.isArray(result.paths) ? result.paths : []);
                const existingPaths = new Set((Array.isArray(images) ? images : []).map(image => image.path));
                const restoredImages = pendingPage.images.filter(image => (
                    restoredPaths.has(image.path) && !existingPaths.has(image.path)
                ));
                pendingPages.pop();
                restoredPagePaths = restoredImages.map(image => image.path);
                processedCount = Math.max(0, processedCount - restoredImages.length);
                batchNumber = Math.max(1, batchNumber - 1);
                status = `已捞回 ${restoredImages.length} 张待清理图片。`;
                return { success: true, restoredImages };
            } catch (error) {
                status = `返回上一页失败：${error.message || error}`;
                return { success: false, restoredImages: [] };
            } finally {
                isProcessing = false;
            }
        }

        function applyProcessResult(result, pageImages) {
            const moved = Array.isArray(result.moved) ? result.moved : [];
            const deleted = Array.isArray(result.deleted) ? result.deleted : [];
            const pending = Array.isArray(result.pending) ? result.pending : [];
            const releasedBatchIds = new Set(Array.isArray(result.releasedBatchIds) ? result.releasedBatchIds : []);
            const releasedPages = pendingPages.filter(page => releasedBatchIds.has(page.id));
            const pageImagesByPath = new Map([
                ...releasedPages.flatMap(page => page.images),
                ...pageImages
            ].map(image => [image.path, image]));
            pendingPages = pendingPages.filter(page => !releasedBatchIds.has(page.id));

            if (result.pendingBatchId && pending.length > 0) {
                const pendingPaths = new Set(pending.map(item => item.originalPath));
                pendingPages.push({
                    id: result.pendingBatchId,
                    images: pageImages.filter(image => pendingPaths.has(image.path))
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
            if (Array.isArray(restoredPagePaths)) {
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
                    kind: 'delete',
                    originalPath: item.originalPath,
                    trashPath: item.trashPath,
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

            const failures = Array.isArray(result.failures) ? result.failures : [];
            status = failures.length > 0
                ? `${failures.length} 张图片处理失败，请重试。`
                : '';
            return {
                success: true,
                processedPaths: [...processedPaths],
                operations,
                failureCount: failures.length
            };
        }

        function getPageImages(images) {
            if (Array.isArray(restoredPagePaths) && restoredPagePaths.length > 0) {
                const imagesByPath = new Map(images.map(image => [image.path, image]));
                return restoredPagePaths.map(imagePath => imagesByPath.get(imagePath)).filter(Boolean);
            }
            return images.slice(0, pageSize);
        }

        function getConfigurationMessage(pageImages, config) {
            const hasRatedImages = pageImages.some(image => scores.has(image.path));
            const hasUnratedImages = pageImages.some(image => !scores.has(image.path));
            if (hasRatedImages && !config.targetFolder) return '请先选择用于汇集已评分图片的目标文件夹。';
            if (hasRatedImages && config.currentFolder === config.targetFolder) return '目标文件夹不能与当前评分文件夹相同。';
            if (hasUnratedImages && !config.trashFolder) return '请先设置回收站，未评分图片会在翻页时进入待清理队列。';
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
