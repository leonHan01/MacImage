const waterfallSession = MacImageWaterfallSession.create({
    pageSize: initialWaterfallPageSize,
    allowedPageSizes: WATERFALL_PAGE_SIZES,
    wheelThreshold: WATERFALL_WHEEL_PAGE_THRESHOLD,
    wheelResetMs: WATERFALL_WHEEL_RESET_MS,
    processPage: page => window.electronAPI.processWaterfallPage(page),
    restorePendingPage: pageId => window.electronAPI.restoreWaterfallPendingPage(pageId)
});
const activeWaterfallOperations = new Set();

async function waitForWaterfallOperations() {
    await Promise.allSettled([...activeWaterfallOperations]);
}

function getWaterfallView() {
    return waterfallSession.snapshot(sortedImages, {
        targetFolder: migrateTargetFolder,
        currentFolder,
        trashFolder
    });
}

function renderWaterfallPage() {
    const view = getWaterfallView();
    if (view.pageImages.length === 0) {
        renderFinishedWaterfallPage(view);
        return;
    }

    const ratedImages = view.pageImages.filter(image => view.scores.has(image.path));
    const readyCount = ratedImages.length;
    const pendingCount = view.pageImages.length - readyCount;
    const readySize = sumImageSizes(ratedImages);
    const pendingSize = sumImageSizes(view.pageImages.filter(image => !view.scores.has(image.path)));
    const nextButtonLabel = sortedImages.length > view.pageSize
        ? '下一页并暂存清理'
        : '完成并暂存清理';

    imageGrid.innerHTML = `
        <section class="waterfall-page" aria-label="大图瀑布流评分">
            <header class="waterfall-toolbar">
                <div class="waterfall-toolbar-copy">
                    <strong>大图评分 · 第 ${view.batchNumber} 组</strong>
                    <span>每页 ${view.pageSize} 张，累计处理 ${view.processedCount} 张</span>
                    <span class="waterfall-target" title="${escapeAttribute(migrateTargetFolder || '')}">
                        评分图片将移至：${escapeHtml(migrateTargetFolder || '请先选择目标文件夹')}
                    </span>
                </div>
                <span class="waterfall-fullscreen-hint">右键 1 分 · ↓ / 空格 下一页 · ↑ 上一页 · Esc 退出</span>
                <section class="waterfall-summary" aria-label="评分整理统计">
                    ${renderWaterfallStat('本页已评分', readyCount, readySize)}
                    ${renderWaterfallStat('本页待删除', pendingCount, pendingSize, 'danger')}
                    ${renderWaterfallStat('待清理（可上翻）', view.pendingImages.length, sumImageSizes(view.pendingImages), 'danger')}
                    ${renderWaterfallStat('累计已汇集', view.movedCount, view.movedSize, 'success')}
                    ${renderWaterfallStat('已提交清理（回收站）', view.deletedCount, view.deletedSize, 'danger')}
                </section>
                <div class="waterfall-toolbar-actions">
                    ${renderWaterfallLayoutSwitch(view.pageSize)}
                    <button type="button" class="waterfall-config-btn" data-waterfall-action="select-target">选择目标文件夹</button>
                    ${view.configurationMessage.includes('回收站') ? '<button type="button" class="waterfall-config-btn" data-waterfall-action="select-trash">设置回收站</button>' : ''}
                    <button type="button" class="waterfall-config-btn" data-waterfall-action="previous" title="返回上一页待清理图片（方向键上）" ${!view.canRestore || view.isProcessing ? 'disabled' : ''}>
                        上一页
                    </button>
                    <button type="button" class="waterfall-next-btn" data-waterfall-action="next" title="点击或向下滚动以整理后进入下一页" ${view.isProcessing ? 'disabled' : ''}>
                        ${view.isProcessing ? '整理中…' : nextButtonLabel}
                    </button>
                    ${renderWaterfallFullscreenButton()}
                </div>
            </header>
            ${view.configurationMessage ? `<p class="waterfall-notice">${escapeHtml(view.configurationMessage)}</p>` : ''}
            ${view.status ? `<p class="waterfall-status">${escapeHtml(view.status)}</p>` : ''}
            <div class="waterfall-cards waterfall-cards--${view.pageSize}">
                ${view.pageImages.map((image, index) => renderWaterfallCard(image, index, view.scores)).join('')}
            </div>
        </section>
    `;
}

function renderFinishedWaterfallPage(view = getWaterfallView()) {
    imageGrid.innerHTML = `
        <section class="waterfall-page" aria-label="大图瀑布流评分">
            <header class="waterfall-toolbar">
                <div class="waterfall-toolbar-copy">
                    <strong>${view.canRestore ? '本轮浏览完成' : '没有待评分的图片'}</strong>
                    ${view.canRestore ? '<span>剩余待清理图片会在退出应用时提交</span>' : ''}
                </div>
                <section class="waterfall-summary" aria-label="评分整理统计">
                    ${renderWaterfallStat('待清理（可上翻）', view.pendingImages.length, sumImageSizes(view.pendingImages), 'danger')}
                    ${renderWaterfallStat('累计已汇集', view.movedCount, view.movedSize, 'success')}
                    ${renderWaterfallStat('已提交清理（回收站）', view.deletedCount, view.deletedSize, 'danger')}
                </section>
                <div class="waterfall-toolbar-actions">
                    <button type="button" class="waterfall-config-btn" data-waterfall-action="previous" title="返回上一页待清理图片（方向键上）" ${!view.canRestore || view.isProcessing ? 'disabled' : ''}>
                        上一页
                    </button>
                    ${renderWaterfallFullscreenButton()}
                </div>
            </header>
            ${view.status ? `<p class="waterfall-status">${escapeHtml(view.status)}</p>` : ''}
            ${renderEmptyState('image', view.canRestore ? '没有更多待评分图片，可按 ↑ 返回上一页' : '没有待评分的图片')}
        </section>
    `;
}

function renderWaterfallLayoutSwitch(pageSize) {
    return `
        <div class="waterfall-layout-switch" role="group" aria-label="评分页面布局">
            ${WATERFALL_PAGE_SIZES.map(size => `
                <button
                    type="button"
                    class="waterfall-layout-btn ${pageSize === size ? 'active' : ''}"
                    data-waterfall-action="set-layout"
                    data-layout-size="${size}"
                    aria-pressed="${pageSize === size}">
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

function sumImageSizes(imageList) {
    return imageList.reduce((total, image) => total + Math.max(0, Number(image.size) || 0), 0);
}

function resetWaterfallReviewSession(images = [], pendingPages = []) {
    waterfallSession.reset({ images, pendingPages });
}

function renderWaterfallCard(image, index, scores = getWaterfallView().scores) {
    const selectedScore = scores.get(image.path);
    return `
        <article class="waterfall-card" data-waterfall-path="${escapeAttribute(image.path)}">
            <div class="waterfall-card-header">
                <span class="waterfall-card-number">${index + 1}</span>
                <div class="waterfall-score-controls" role="group" aria-label="${escapeAttribute(image.name)} 的评分">
                    ${[1, 2, 3].map(score => `
                        <button
                            type="button"
                            class="waterfall-score-btn ${selectedScore === score ? 'selected' : ''}"
                            data-waterfall-action="score"
                            data-path="${escapeAttribute(image.path)}"
                            data-score="${score}"
                            aria-pressed="${selectedScore === score}">
                            ${score} 分
                        </button>
                    `).join('')}
                </div>
            </div>
            <div class="waterfall-image-frame" title="右键标记为 1 分">
                <img class="waterfall-image" ${renderOriginalImageAttributes(image)} alt="${escapeAttribute(image.name)}">
            </div>
            <footer class="waterfall-card-footer" title="${escapeAttribute(image.name)}">
                <span>${escapeHtml(image.name)}</span>
                ${selectedScore ? `<strong>${selectedScore} 分</strong>` : '<em>未评分</em>'}
            </footer>
        </article>
    `;
}

function handleWaterfallGridClick(event) {
    if (currentViewMode !== 'waterfall') return false;

    const actionButton = event.target.closest('[data-waterfall-action]');
    if (!actionButton) return openWaterfallImageFromEvent(event);

    const action = actionButton.dataset.waterfallAction;
    if (action === 'fullscreen') {
        void toggleWaterfallFullscreen();
        return true;
    }
    if (action === 'score') {
        waterfallSession.score(actionButton.dataset.path, actionButton.dataset.score);
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

function handleWaterfallContextMenu(event) {
    if (currentViewMode !== 'waterfall') return false;
    const imagePath = event.target.closest('.waterfall-card')?.dataset.waterfallPath;
    if (!imagePath) return false;

    waterfallSession.score(imagePath, 1, { toggle: false });
    renderWaterfallPage();
    return true;
}

function openWaterfallImageFromEvent(event) {
    const image = event.target.closest('.waterfall-image');
    if (!image) return false;

    const imagePath = image.closest('.waterfall-card')?.dataset.waterfallPath;
    const index = sortedImages.findIndex(item => item.path === imagePath);
    if (index < 0) return false;

    openImageModal(index, { closeOnImageClick: true });
    return true;
}

function setWaterfallPageSize(value) {
    if (!waterfallSession.setPageSize(value)) return;
    const { pageSize } = getWaterfallView();
    localStorage.setItem('macimage:waterfallPageSize', String(pageSize));
    imageGrid.scrollTop = 0;
    renderWaterfallPage();
}

function handleWaterfallWheel(event) {
    if (currentViewMode !== 'waterfall') return false;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;

    const normalizedDelta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
    const result = waterfallSession.consumeDownScroll(normalizedDelta);
    if (result.advance) void advanceWaterfallPage();
    return result.handled;
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
    if (isFolderLoading) return;
    const sourceFolder = currentFolder;
    const operation = waterfallSession.advance(sortedImages, {
        targetFolder: migrateTargetFolder,
        currentFolder,
        trashFolder
    });
    activeWaterfallOperations.add(operation);
    try {
        renderWaterfallPage();
        const outcome = await operation;
        if (sourceFolder !== currentFolder || isFolderLoading) return;
        if (outcome.operations.length > 0) recordFileOperation(outcome.operations);
        if (outcome.processedPaths.length > 0) imageCollection.remove(outcome.processedPaths);
        refreshAfterImageMembershipChange();
    } finally {
        activeWaterfallOperations.delete(operation);
    }
}

async function restorePreviousWaterfallPage() {
    if (isFolderLoading) return;
    const sourceFolder = currentFolder;
    const operation = waterfallSession.restore(images);
    activeWaterfallOperations.add(operation);
    try {
        renderWaterfallPage();
        const outcome = await operation;
        if (sourceFolder !== currentFolder || isFolderLoading) return;
        if (outcome.success) {
            imageCollection.prepend(outcome.restoredImages);
            duplicateGroups = [];
            duplicateScanCompleted = false;
        }
        imageGrid.scrollTop = 0;
        refreshAfterImageMembershipChange();
    } finally {
        activeWaterfallOperations.delete(operation);
    }
}
