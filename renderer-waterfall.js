function renderWaterfallPage() {
    const pageImages = getWaterfallPageImages();
    if (pageImages.length === 0) {
        if (waterfallPageSize === 3 && waterfallPendingPages.length > 0) {
            renderFinishedWaterfallPage();
            return;
        }
        renderEmptyImageGrid();
        return;
    }

    const ratedImages = pageImages.filter(img => waterfallScores.has(img.path));
    const readyCount = ratedImages.length;
    const pendingCount = pageImages.length - readyCount;
    const readySize = sumImageSizes(ratedImages);
    const pendingSize = sumImageSizes(pageImages.filter(img => !waterfallScores.has(img.path)));
    const configMessage = getWaterfallConfigurationMessage(pageImages);
    const usesDeferredCleanup = waterfallPageSize === 3;
    const nextButtonLabel = sortedImages.length > waterfallPageSize
        ? (usesDeferredCleanup ? '下一页并暂存清理' : '下一页并整理')
        : (usesDeferredCleanup ? '完成并暂存清理' : '完成并整理');
    const pendingCleanupImages = getPendingWaterfallImages();

    imageGrid.innerHTML = `
        <section class="waterfall-page" aria-label="大图瀑布流评分">
            <header class="waterfall-toolbar">
                <div class="waterfall-toolbar-copy">
                    <strong>大图评分 · 第 ${waterfallBatchNumber} 组</strong>
                    <span>每页 ${waterfallPageSize} 张，累计处理 ${waterfallProcessedCount} 张</span>
                    <span class="waterfall-target" title="${escapeAttribute(migrateTargetFolder || '')}">
                        评分图片将移至：${escapeHtml(migrateTargetFolder || '请先选择目标文件夹')}
                    </span>
                </div>
                <div class="waterfall-toolbar-actions">
                    ${renderWaterfallLayoutSwitch()}
                    <button type="button" class="waterfall-config-btn" data-waterfall-action="select-target">选择目标文件夹</button>
                    ${configMessage.includes('回收站') ? '<button type="button" class="waterfall-config-btn" data-waterfall-action="select-trash">设置回收站</button>' : ''}
                    ${usesDeferredCleanup ? `
                        <button type="button" class="waterfall-config-btn" data-waterfall-action="previous" title="返回上一页待清理图片（方向键上）" ${waterfallPendingPages.length === 0 || waterfallIsProcessing ? 'disabled' : ''}>
                            上一页
                        </button>
                    ` : ''}
                    <button type="button" class="waterfall-next-btn" data-waterfall-action="next" title="点击或向下滚动以整理后进入下一页" ${waterfallIsProcessing ? 'disabled' : ''}>
                        ${waterfallIsProcessing ? '整理中…' : nextButtonLabel}
                    </button>
                </div>
            </header>
            <section class="waterfall-summary" aria-label="评分整理统计">
                ${renderWaterfallStat('本页已评分', readyCount, readySize)}
                ${renderWaterfallStat('本页待删除', pendingCount, pendingSize, 'danger')}
                ${usesDeferredCleanup ? renderWaterfallStat('待清理（可上翻）', pendingCleanupImages.length, sumImageSizes(pendingCleanupImages), 'danger') : ''}
                ${renderWaterfallStat('累计已汇集', waterfallMovedCount, waterfallMovedSize, 'success')}
                ${renderWaterfallStat('已提交清理（回收站）', waterfallDeletedCount, waterfallDeletedSize, 'danger')}
            </section>
            ${configMessage ? `<p class="waterfall-notice">${escapeHtml(configMessage)}</p>` : ''}
            ${waterfallLastStatus ? `<p class="waterfall-status">${escapeHtml(waterfallLastStatus)}</p>` : ''}
            <div class="waterfall-cards waterfall-cards--${waterfallPageSize}">
                ${pageImages.map(renderWaterfallCard).join('')}
            </div>
        </section>
    `;
}

function renderFinishedWaterfallPage() {
    const pendingCleanupImages = getPendingWaterfallImages();
    imageGrid.innerHTML = `
        <section class="waterfall-page" aria-label="大图瀑布流评分已完成">
            <header class="waterfall-toolbar">
                <div class="waterfall-toolbar-copy">
                    <strong>本轮浏览完成</strong>
                    <span>剩余待清理图片会在退出应用时提交</span>
                </div>
                <div class="waterfall-toolbar-actions">
                    <button type="button" class="waterfall-config-btn" data-waterfall-action="previous" title="返回上一页待清理图片（方向键上）" ${waterfallIsProcessing ? 'disabled' : ''}>
                        上一页
                    </button>
                </div>
            </header>
            <section class="waterfall-summary" aria-label="评分整理统计">
                ${renderWaterfallStat('待清理（可上翻）', pendingCleanupImages.length, sumImageSizes(pendingCleanupImages), 'danger')}
                ${renderWaterfallStat('累计已汇集', waterfallMovedCount, waterfallMovedSize, 'success')}
                ${renderWaterfallStat('已提交清理（回收站）', waterfallDeletedCount, waterfallDeletedSize, 'danger')}
            </section>
            ${waterfallLastStatus ? `<p class="waterfall-status">${escapeHtml(waterfallLastStatus)}</p>` : ''}
            ${renderEmptyState('image', '没有更多待评分图片，可按 ↑ 返回上一页')}
        </section>
    `;
}

function renderWaterfallLayoutSwitch() {
    return `
        <div class="waterfall-layout-switch" role="group" aria-label="评分页面布局">
            ${WATERFALL_PAGE_SIZES.map(size => `
                <button
                    type="button"
                    class="waterfall-layout-btn ${waterfallPageSize === size ? 'active' : ''}"
                    data-waterfall-action="set-layout"
                    data-layout-size="${size}"
                    aria-pressed="${waterfallPageSize === size}">
                    ${size} 宫格
                </button>
            `).join('')}
        </div>
    `;
}

function renderWaterfallStat(label, count, totalSize, tone = '') {
    return `
        <div class="waterfall-stat ${tone ? `waterfall-stat-${tone}` : ''}">
            <span>${label}</span>
            <strong>${count} 张 · ${formatFileSize(totalSize)}</strong>
        </div>
    `;
}

function getWaterfallPageImages() {
    if (Array.isArray(waterfallRestoredPagePaths) && waterfallRestoredPagePaths.length > 0) {
        const imagesByPath = new Map(sortedImages.map(img => [img.path, img]));
        return waterfallRestoredPagePaths.map(imagePath => imagesByPath.get(imagePath)).filter(Boolean);
    }
    return sortedImages.slice(0, waterfallPageSize);
}

function sumImageSizes(imageList) {
    return imageList.reduce((total, img) => total + Math.max(0, Number(img.size) || 0), 0);
}

function getPendingWaterfallImages() {
    return waterfallPendingPages.flatMap(page => page.images);
}

function resetWaterfallReviewSession() {
    waterfallScores.clear();
    waterfallBatchNumber = 1;
    waterfallProcessedCount = 0;
    waterfallMovedCount = 0;
    waterfallMovedSize = 0;
    waterfallDeletedCount = 0;
    waterfallDeletedSize = 0;
    waterfallLastStatus = '';
    waterfallIsProcessing = false;
    waterfallPendingPages = [];
    waterfallRestoredPagePaths = null;
    waterfallWheelDelta = 0;
    lastWaterfallWheelTime = 0;
}

function renderWaterfallCard(img, index) {
    const selectedScore = waterfallScores.get(img.path);
    return `
        <article class="waterfall-card" data-waterfall-path="${escapeAttribute(img.path)}">
            <div class="waterfall-card-header">
                <span class="waterfall-card-number">${index + 1}</span>
                <div class="waterfall-score-controls" role="group" aria-label="${escapeAttribute(img.name)} 的评分">
                    ${[1, 2, 3].map(score => `
                        <button
                            type="button"
                            class="waterfall-score-btn ${selectedScore === score ? 'selected' : ''}"
                            data-waterfall-action="score"
                            data-path="${escapeAttribute(img.path)}"
                            data-score="${score}"
                            aria-pressed="${selectedScore === score}">
                            ${score} 分
                        </button>
                    `).join('')}
                </div>
            </div>
            <div class="waterfall-image-frame">
                <img class="waterfall-image" src="${escapeAttribute(toFileUrl(img.path))}" alt="${escapeAttribute(img.name)}">
            </div>
            <footer class="waterfall-card-footer" title="${escapeAttribute(img.name)}">
                <span>${escapeHtml(img.name)}</span>
                ${selectedScore ? `<strong>${selectedScore} 分</strong>` : '<em>未评分</em>'}
            </footer>
        </article>
    `;
}

function getWaterfallConfigurationMessage(pageImages) {
    const hasRatedImages = pageImages.some(img => waterfallScores.has(img.path));
    const hasUnratedImages = pageImages.some(img => !waterfallScores.has(img.path));

    if (hasRatedImages && !migrateTargetFolder) return '请先选择用于汇集已评分图片的目标文件夹。';
    if (hasRatedImages && currentFolder === migrateTargetFolder) return '目标文件夹不能与当前评分文件夹相同。';
    if (hasUnratedImages && !trashFolder) return '请先设置回收站，未评分图片会在翻页时进入待清理队列。';
    return '';
}

function handleWaterfallGridClick(event) {
    if (currentViewMode !== 'waterfall') return false;

    const actionButton = event.target.closest('[data-waterfall-action]');
    if (!actionButton) {
        return openWaterfallImageFromEvent(event);
    }

    const action = actionButton.dataset.waterfallAction;
    if (action === 'score') {
        const score = Number(actionButton.dataset.score);
        const imagePath = actionButton.dataset.path;
        if (!imagePath || ![1, 2, 3].includes(score) || waterfallIsProcessing) return true;

        waterfallScores.get(imagePath) === score
            ? waterfallScores.delete(imagePath)
            : waterfallScores.set(imagePath, score);
        waterfallLastStatus = '';
        renderWaterfallPage();
        return true;
    }

    if (action === 'set-layout') {
        setWaterfallPageSize(actionButton.dataset.layoutSize);
        return true;
    }

    if (action === 'select-target') {
        void selectWaterfallTargetFolder();
        return true;
    }
    if (action === 'select-trash') {
        void selectWaterfallTrashFolder();
        return true;
    }
    if (action === 'next') {
        void advanceWaterfallPage();
        return true;
    }
    if (action === 'previous') {
        void restorePreviousWaterfallPage();
        return true;
    }
    return false;
}

function openWaterfallImageFromEvent(event) {
    const image = event.target.closest('.waterfall-image');
    if (!image) return false;

    const card = image.closest('.waterfall-card');
    const imagePath = card?.dataset.waterfallPath;
    const index = sortedImages.findIndex(item => item.path === imagePath);
    if (index < 0) return false;

    openImageModal(index, { closeOnImageClick: true });
    return true;
}

function setWaterfallPageSize(value) {
    const nextPageSize = Number(value);
    if (!WATERFALL_PAGE_SIZES.includes(nextPageSize) || nextPageSize === waterfallPageSize) return;

    waterfallPageSize = nextPageSize;
    waterfallLastStatus = '';
    localStorage.setItem('macimage:waterfallPageSize', String(waterfallPageSize));
    imageGrid.scrollTop = 0;
    renderWaterfallPage();
}

function handleWaterfallWheel(event) {
    if (currentViewMode !== 'waterfall' || waterfallIsProcessing) return false;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;

    const normalizedDelta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
    if (normalizedDelta <= 0) return false;

    const now = Date.now();
    if (now - lastWaterfallWheelTime > WATERFALL_WHEEL_RESET_MS) waterfallWheelDelta = 0;
    lastWaterfallWheelTime = now;
    waterfallWheelDelta += normalizedDelta;
    if (waterfallWheelDelta < WATERFALL_WHEEL_PAGE_THRESHOLD) return true;

    waterfallWheelDelta = 0;
    void advanceWaterfallPage();
    return true;
}

async function selectWaterfallTargetFolder() {
    await selectMigrateFolder();
    if (currentViewMode === 'waterfall') renderWaterfallPage();
}

async function selectWaterfallTrashFolder() {
    await selectTrashFolder();
    if (currentViewMode === 'waterfall') renderWaterfallPage();
}

async function advanceWaterfallPage() {
    if (waterfallIsProcessing) return;

    const pageImages = getWaterfallPageImages();
    if (pageImages.length === 0) return;

    const configurationMessage = getWaterfallConfigurationMessage(pageImages);
    if (configurationMessage) {
        waterfallLastStatus = configurationMessage;
        renderWaterfallPage();
        return;
    }

    const ratedImages = pageImages
        .filter(img => waterfallScores.has(img.path))
        .map(img => ({ path: img.path, score: waterfallScores.get(img.path) }));
    const unratedPaths = pageImages
        .filter(img => !waterfallScores.has(img.path))
        .map(img => img.path);

    waterfallIsProcessing = true;
    renderWaterfallPage();

    try {
        const result = await window.electronAPI.processWaterfallPage({
            ratedImages,
            unratedPaths,
            targetFolder: migrateTargetFolder,
            deferUnrated: waterfallPageSize === 3
        });
        if (!result.success) {
            waterfallLastStatus = `整理失败：${result.error || '未知错误'}`;
            return;
        }

        const moved = Array.isArray(result.moved) ? result.moved : [];
        const deleted = Array.isArray(result.deleted) ? result.deleted : [];
        const pending = Array.isArray(result.pending) ? result.pending : [];
        const releasedBatchIds = new Set(Array.isArray(result.releasedBatchIds) ? result.releasedBatchIds : []);
        const releasedPages = waterfallPendingPages.filter(page => releasedBatchIds.has(page.id));
        const pageImagesByPath = new Map([
            ...releasedPages.flatMap(page => page.images),
            ...pageImages
        ].map(img => [img.path, img]));
        waterfallPendingPages = waterfallPendingPages.filter(page => !releasedBatchIds.has(page.id));

        if (result.pendingBatchId && pending.length > 0) {
            const pendingPaths = new Set(pending.map(item => item.originalPath));
            waterfallPendingPages.push({
                id: result.pendingBatchId,
                images: pageImages.filter(img => pendingPaths.has(img.path))
            });
        }

        const processedPaths = new Set([
            ...moved.map(item => item.originalPath),
            ...deleted.map(item => item.originalPath),
            ...pending.map(item => item.originalPath)
        ]);
        const currentPagePaths = new Set(pageImages.map(img => img.path));
        const currentProcessedCount = [...processedPaths].filter(imagePath => currentPagePaths.has(imagePath)).length;
        if (Array.isArray(waterfallRestoredPagePaths)) {
            const remainingRestoredPaths = waterfallRestoredPagePaths.filter(imagePath => !processedPaths.has(imagePath));
            waterfallRestoredPagePaths = remainingRestoredPaths.length > 0 ? remainingRestoredPaths : null;
        }

        if (processedPaths.size > 0) {
            recordFileOperation([
                ...moved.map(item => ({
                    kind: 'move',
                    originalPath: item.originalPath,
                    targetPath: item.targetPath
                })),
                ...deleted.map(item => createDeleteHistoryItem(
                    item,
                    pageImagesByPath.get(item.originalPath),
                    -1
                ))
            ]);
            updateWaterfallStatistics({ moved, deleted, pageImagesByPath });
            images = images.filter(img => !processedPaths.has(img.path));
            processedPaths.forEach(imagePath => waterfallScores.delete(imagePath));
            waterfallProcessedCount += currentProcessedCount;
            if (currentProcessedCount > 0) waterfallBatchNumber++;
            if (duplicateScanCompleted) {
                duplicateGroups = removePathsFromDuplicateGroups([...processedPaths]);
            }
            updateImageCount();
            updateMigrateSourceFolder();
            renderTagFilter();
            renderDuplicateResults();
        }

        const failures = Array.isArray(result.failures) ? result.failures : [];
        if (failures.length > 0) {
            waterfallLastStatus = `${failures.length} 张图片处理失败，请重试。`;
        } else if (pending.length > 0) {
            waterfallLastStatus = `已暂存 ${pending.length} 张待清理图片；可按 ↑ 返回上一页。`;
        } else {
            waterfallLastStatus = '';
        }
    } catch (error) {
        waterfallLastStatus = `整理失败：${error.message || error}`;
    } finally {
        waterfallIsProcessing = false;
        renderImages();
    }
}

async function restorePreviousWaterfallPage() {
    if (waterfallIsProcessing || waterfallPageSize !== 3 || waterfallPendingPages.length === 0) return;

    const pendingPage = waterfallPendingPages[waterfallPendingPages.length - 1];
    waterfallIsProcessing = true;
    renderWaterfallPage();

    try {
        const result = await window.electronAPI.restoreWaterfallPendingPage(pendingPage.id);
        if (!result.success) {
            waterfallLastStatus = `返回上一页失败：${result.error || '未知错误'}`;
            return;
        }

        const restoredPaths = new Set(Array.isArray(result.paths) ? result.paths : []);
        const existingPaths = new Set(images.map(img => img.path));
        const restoredImages = pendingPage.images.filter(img => restoredPaths.has(img.path) && !existingPaths.has(img.path));
        waterfallPendingPages.pop();
        images = [...restoredImages, ...images];
        waterfallRestoredPagePaths = restoredImages.map(img => img.path);
        waterfallProcessedCount = Math.max(0, waterfallProcessedCount - restoredImages.length);
        waterfallBatchNumber = Math.max(1, waterfallBatchNumber - 1);
        waterfallLastStatus = `已捞回 ${restoredImages.length} 张待清理图片。`;
        duplicateGroups = [];
        duplicateScanCompleted = false;
        updateImageCount();
        updateMigrateSourceFolder();
        renderTagFilter();
        renderDuplicateResults();
    } catch (error) {
        waterfallLastStatus = `返回上一页失败：${error.message || error}`;
    } finally {
        waterfallIsProcessing = false;
        imageGrid.scrollTop = 0;
        renderImages();
    }
}

function updateWaterfallStatistics({ moved, deleted, pageImagesByPath }) {
    const movedSize = sumImageSizes(moved.map(item => pageImagesByPath.get(item.originalPath)).filter(Boolean));
    const deletedSize = sumImageSizes(deleted.map(item => pageImagesByPath.get(item.originalPath)).filter(Boolean));
    waterfallMovedCount += moved.length;
    waterfallMovedSize += movedSize;
    waterfallDeletedCount += deleted.length;
    waterfallDeletedSize += deletedSize;
}
