const waterfallSession = MacImageWaterfallSession.create({
    pageSize: initialWaterfallPageSize,
    allowedPageSizes: WATERFALL_PAGE_SIZES,
    wheelThreshold: WATERFALL_WHEEL_PAGE_THRESHOLD,
    wheelResetMs: WATERFALL_WHEEL_RESET_MS,
    processPage: page => window.electronAPI.processWaterfallPage(page),
    restorePendingPage: pageId => window.electronAPI.restoreWaterfallPendingPage(pageId)
});
const activeWaterfallOperations = new Set();
let waterfallTwoCardObserver = null;

async function waitForWaterfallOperations() {
    await Promise.allSettled([...activeWaterfallOperations]);
}

function getWaterfallView() {
    return waterfallSession.snapshot(sortedImages, {
        targetFolder: migrateTargetFolder,
        currentFolder
    });
}

function renderWaterfallPage() {
    const view = getWaterfallView();
    updateWaterfallToolbar(view);
    if (view.pageImages.length === 0) {
        renderFinishedWaterfallPage(view);
        return;
    }
    if (updateWaterfallPageInPlace(view)) return;

    disconnectWaterfallTwoCardObserver();
    imageGrid.innerHTML = `
        <section class="waterfall-page" aria-label="大图瀑布流评分">
            <div class="waterfall-messages">${renderWaterfallMessages(view)}</div>
            <div class="waterfall-cards waterfall-cards--${view.pageSize}">
                ${view.pageImages.map((image, index) => renderWaterfallCard(image, index, view.scores)).join('')}
            </div>
        </section>
    `;
    if (view.pageSize === 2) setupWaterfallTwoCardLayout();
}

function updateWaterfallPageInPlace(view) {
    const container = imageGrid.querySelector?.('.waterfall-cards');
    if (!container?.classList.contains(`waterfall-cards--${view.pageSize}`)) return false;
    const cards = [...container.querySelectorAll('.waterfall-card')];
    if (cards.length !== view.pageImages.length || cards.some((card, index) => (
        card.dataset.waterfallPath !== view.pageImages[index].path
    ))) return false;

    const messages = imageGrid.querySelector('.waterfall-messages');
    if (!messages) return false;

    updateWaterfallMarkup(messages, renderWaterfallMessages(view));
    cards.forEach((card, index) => {
        const image = view.pageImages[index];
        const selectedScore = view.scores.get(image.path);
        card.querySelectorAll('[data-score]').forEach(button => {
            const selected = Number(button.dataset.score) === selectedScore;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        card.querySelector('.waterfall-image').alt = image.name;
    });
    return true;
}

function updateWaterfallMarkup(element, markup) {
    if (element.innerHTML !== markup) element.innerHTML = markup;
}

function renderWaterfallMessages(view) {
    return `
        ${view.configurationMessage ? `<p class="waterfall-notice">${escapeHtml(view.configurationMessage)}</p>` : ''}
        ${view.failureDetails?.length ? renderWaterfallFeedback(view) : ''}
    `.trim();
}

function updateWaterfallToolbar(view) {
    const toolbar = document.getElementById('waterfallToolbar');
    toolbar.hidden = false;
    updateWaterfallMarkup(toolbar, renderWaterfallToolbarContent(view));
}

function renderWaterfallToolbarContent(view) {
    const ratedImages = view.pageImages.filter(image => view.scores.has(image.path));
    const summary = [
        `第 ${view.batchNumber} 组，累计处理 ${view.processedCount} 张`,
        `本页已选 ${ratedImages.length} 张 · ${formatFileSize(sumImageSizes(ratedImages))}`,
        `待提交 ${view.pendingImages.length} 张 · ${formatFileSize(sumImageSizes(view.pendingImages))}`,
        `累计汇集 ${view.movedCount} 张 · ${formatFileSize(view.movedSize)}`,
        `已移入废纸篓 ${view.deletedCount} 张 · ${formatFileSize(view.deletedSize)}`,
        view.status || ''
    ].filter(Boolean).join('\n');
    const nextButtonLabel = sortedImages.length > view.pageSize ? '下一页' : '完成整理';

    return `
        ${renderWaterfallLayoutSwitch(view.pageSize)}
        <button type="button" class="waterfall-config-btn" data-waterfall-action="select-target"
            title="${escapeAttribute(migrateTargetFolder || '选择已评分图片的目标文件夹')}">${migrateTargetFolder ? '目标目录' : '选择目录'}</button>
        ${renderWaterfallPreviousButton(view)}
        <button type="button" class="waterfall-next-btn" data-waterfall-action="next"
            title="整理并进入下一页（↓ / 空格）。保留最近 5 轮；更早轮次或退出时提交整理，未评分图片进入系统废纸篓。"
            ${view.isProcessing || view.pageImages.length === 0 ? 'disabled' : ''}>
            ${view.isProcessing ? '整理中…' : nextButtonLabel}
        </button>
        ${renderWaterfallFullscreenButton()}
        <span class="waterfall-selection-count" title="${escapeAttribute(summary)}">已选 ${ratedImages.length}/${view.pageImages.length}</span>
    `;
}

function renderFinishedWaterfallPage(view = getWaterfallView()) {
    disconnectWaterfallTwoCardObserver();
    updateWaterfallToolbar(view);
    imageGrid.innerHTML = `
        <section class="waterfall-page" aria-label="大图瀑布流评分">
            ${renderWaterfallMessages(view)}
            ${renderEmptyState('image', view.canRestore ? '本轮浏览完成，可按 ↑ 返回' : '没有待评分的图片')}
        </section>
    `;
}

function renderWaterfallPreviousButton(view) {
    return `<button type="button" class="waterfall-config-btn" data-waterfall-action="previous"
        title="返回上一轮并恢复评分（↑），可返回 ${view.restorablePageCount} 轮" ${!view.canRestore || view.isProcessing ? 'disabled' : ''}>
        上一页
    </button>`;
}

function disconnectWaterfallTwoCardObserver() {
    waterfallTwoCardObserver?.disconnect();
    waterfallTwoCardObserver = null;
}

function renderWaterfallFeedback(view) {
    const failures = Array.isArray(view.failureDetails) ? view.failureDetails : [];
    if (failures.length === 0) {
        return view.status ? `<p class="waterfall-status" role="status">${escapeHtml(view.status)}</p>` : '';
    }
    const actionLabels = { move: '移入评分目标文件夹', delete: '移入系统废纸篓', process: '翻页整理', restore: '返回上一页' };
    return `
        <section class="waterfall-errors" role="alert" aria-label="文件处理错误详情">
            <strong>${escapeHtml(view.status || '图片处理失败')}</strong>
            <ol class="waterfall-error-list">
                ${failures.map(failure => {
                    const sourcePath = failure.path || failure.originalPath || '';
                    const fileName = failure.fileName || failure.file || sourcePath.split(/[\\/]/).pop() || '本页整理';
                    const targetPath = failure.action === 'delete' ? '系统废纸篓' : failure.targetPath;
                    return `
                        <li>
                            <strong>${escapeHtml(fileName)}</strong>
                            <dl>
                                ${renderWaterfallErrorField('操作', actionLabels[failure.action] || '文件整理')}
                                ${renderWaterfallErrorField(failure.action === 'process' ? '操作目录' : '源路径', sourcePath)}
                                ${renderWaterfallErrorField('目标位置', targetPath)}
                                ${renderWaterfallErrorField('错误码', failure.code)}
                                ${renderWaterfallErrorField('系统操作', failure.syscall)}
                            </dl>
                            <pre>${escapeHtml(failure.error || '未返回具体错误信息')}</pre>
                        </li>
                    `;
                }).join('')}
            </ol>
        </section>
    `;
}

function renderWaterfallErrorField(label, value) {
    if (value === undefined || value === null || value === '') return '';
    return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function calculateWaterfallTwoCardWidths(images, frameHeight, availableWidth, gap) {
    if (!frameHeight || !availableWidth || images.some(image => !image.naturalWidth || !image.naturalHeight)) return [];
    const desiredWidths = images.map(image => frameHeight * image.naturalWidth / image.naturalHeight + 2);
    const totalWidth = desiredWidths.reduce((sum, width) => sum + width, 0);
    const scale = Math.min(1, Math.max(0, availableWidth - gap) / totalWidth);
    return desiredWidths.map(width => width * scale);
}

function setupWaterfallTwoCardLayout() {
    const cards = imageGrid.querySelector?.('.waterfall-cards--2');
    if (!cards) return;
    const cardElements = [...cards.querySelectorAll('.waterfall-card')];
    const imageElements = cardElements.map(card => card.querySelector('.waterfall-image'));
    const fitImages = () => {
        if (!cards.isConnected) return;
        const frameHeight = cardElements[0]?.querySelector('.waterfall-image-frame').clientHeight || 0;
        const gap = parseFloat(getComputedStyle(cards).columnGap) || 0;
        const widths = calculateWaterfallTwoCardWidths(imageElements, frameHeight, cards.clientWidth, gap * (cardElements.length - 1));
        cardElements.forEach((card, index) => {
            card.style.flex = widths[index] ? `0 0 ${widths[index]}px` : '';
        });
    };
    imageElements.forEach(image => image.addEventListener('load', fitImages, { once: true }));
    Promise.allSettled(imageElements.map(image => image.decode())).then(fitImages);
    waterfallTwoCardObserver = new ResizeObserver(fitImages);
    waterfallTwoCardObserver.observe(cards);
    fitImages();
    requestAnimationFrame(fitImages);
}

function renderWaterfallLayoutSwitch(pageSize) {
    return `
        <div class="waterfall-layout-switch" role="group" aria-label="评分页面布局">
            ${WATERFALL_PAGE_SIZES.map(size => `
                <button
                    type="button"
                    class="waterfall-layout-btn ${pageSize === size ? 'active' : ''}"
                    title="${size} 宫格"
                    data-waterfall-action="set-layout"
                    data-layout-size="${size}"
                    aria-pressed="${pageSize === size}">
                    ${size}
                </button>
            `).join('')}
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
                <div class="waterfall-score-controls" role="group" aria-label="${escapeAttribute(image.name)} 的操作与评分">
                    <button
                        type="button"
                        class="waterfall-score-btn waterfall-copy-btn"
                        data-waterfall-action="copy"
                        data-path="${escapeAttribute(image.path)}"
                        title="复制当前图片"
                        aria-label="复制当前图片">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <rect x="9" y="9" width="12" height="12" rx="2"></rect>
                            <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path>
                        </svg>
                    </button>
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
    if (action === 'copy') {
        void copyWaterfallImage(actionButton);
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

async function copyWaterfallImage(button) {
    if (button.disabled || !button.dataset.path) return;
    button.disabled = true;
    button.textContent = '…';
    button.title = '正在复制图片…';

    try {
        const result = await window.electronAPI.copyImage(button.dataset.path);
        if (!result?.success) throw new Error(result?.error || '无法复制当前图片');
        button.textContent = '✓';
        button.title = '图片已复制到剪贴板';
    } catch (error) {
        button.textContent = '!';
        button.title = `复制失败：${error.message || '无法复制当前图片'}，点击重试`;
    } finally {
        button.disabled = false;
        button.setAttribute('aria-label', button.title);
    }
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

async function advanceWaterfallPage() {
    if (isFolderLoading) return;
    const sourceFolder = currentFolder;
    const operation = waterfallSession.advance(sortedImages, {
        targetFolder: migrateTargetFolder,
        currentFolder
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
            localStorage.setItem('macimage:waterfallPageSize', String(getWaterfallView().pageSize));
            duplicateGroups = [];
            duplicateScanCompleted = false;
        }
        imageGrid.scrollTop = 0;
        refreshAfterImageMembershipChange();
    } finally {
        activeWaterfallOperations.delete(operation);
    }
}
