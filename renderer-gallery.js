let virtualGalleryDom = null;

function renderImages() {
    let filteredImages = getFilteredImages();
    filteredImages = sortImages(filteredImages);
    sortedImages = filteredImages;
    cancelGalleryWork();
    updateImageGridViewClass();
    
    if (filteredImages.length === 0) {
        renderEmptyImageGrid();
        return;
    }

    if (currentViewMode === 'waterfall') {
        renderWaterfallPage();
    } else if (currentViewMode === 'grid') {
        renderVirtualGrid();
    } else {
        renderVirtualList();
    }
}

function cancelGalleryWork() {
    galleryRenderVersion++;
    gridVirtualState = null;
    listVirtualState = null;
    virtualGalleryDom = null;
    thumbnailQueue = [];
    thumbnailQueuedIndexes.clear();

    if (gridRenderFrame) {
        cancelAnimationFrame(gridRenderFrame);
        gridRenderFrame = null;
    }
}

function renderEmptyImageGrid() {
    cancelGalleryWork();
    updateImageGridViewClass();
    const isFolderEmpty = images.length === 0;
    const emptyMessage = currentViewMode === 'waterfall'
        ? (waterfallLastStatus || '没有待评分的图片')
        : (isFolderEmpty ? '此文件夹中没有图片' : '没有匹配所选标签的图片');
    imageGrid.innerHTML = isFolderEmpty
        ? renderEmptyState('image', emptyMessage)
        : renderEmptyState(currentViewMode === 'waterfall' ? 'image' : 'search', emptyMessage);
}

function renderEmptyState(type, message) {
    const icon = type === 'search'
        ? '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
        : '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>';

    return `
        <div class="empty-state">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                ${icon}
            </svg>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

function renderImageItem(img, index) {
    if (currentViewMode === 'grid') {
        return renderImageCard(img, index);
    }
    return renderImageRow(img, index);
}

function renderImageRow(img, index) {
    return `
        <div class="file-item" data-index="${index}" data-path="${escapeAttribute(img.path)}">
            ${renderImageRowContent(img)}
        </div>
    `;
}

function renderImageRowContent(img) {
    return `
        <span class="file-name">${escapeHtml(img.name)}</span>
        <span class="file-size">${formatFileSize(img.size)}</span>
        ${renderImageScoreBadge(img)}
        <div class="file-tags">${renderImageTagBadges(img)}</div>
    `;
}

function renderImageCard(img, index) {
    return `
        <div class="file-item file-card" data-index="${index}" data-path="${escapeAttribute(img.path)}">
            ${renderImageCardContent(img, index)}
        </div>
    `;
}

function renderImageCardContent(img, index) {
    return `
        <div class="thumbnail-frame">
            <div class="thumbnail-placeholder">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
            </div>
            <img class="thumbnail-image" data-thumb-index="${index}" data-path="${escapeAttribute(img.path)}" alt="${escapeAttribute(img.name)}">
        </div>
        <div class="file-card-info">
            <span class="file-name">${escapeHtml(img.name)}</span>
            <span class="file-size">${formatFileSize(img.size)}</span>
            ${renderImageScoreBadge(img)}
            <div class="file-tags">${renderImageTagBadges(img)}</div>
        </div>
    `;
}

function updateImageGridViewClass() {
    imageGrid.classList.toggle('grid-view', currentViewMode === 'grid');
    imageGrid.classList.toggle('list-view', currentViewMode === 'list');
    imageGrid.classList.toggle('waterfall-view', currentViewMode === 'waterfall');
}

function setViewMode(mode) {
    const nextMode = ['list', 'grid', 'waterfall'].includes(mode) ? mode : 'list';
    if (currentViewMode === nextMode) return;

    currentViewMode = nextMode;
    if (currentViewMode === 'waterfall') {
        imageGrid.scrollTop = 0;
        waterfallLastStatus = '';
    }
    localStorage.setItem('macimage:viewMode', currentViewMode);
    updateViewModeControls();
    renderImages();
}

function updateViewModeControls() {
    document.querySelectorAll('.view-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === currentViewMode);
    });
}

function renderVirtualGrid() {
    const version = galleryRenderVersion;
    gridVirtualState = calculateGridVirtualState(sortedImages.length);
    renderVisibleGridItems(version);
}

function renderVirtualList() {
    const version = galleryRenderVersion;
    listVirtualState = calculateListVirtualState(sortedImages.length);
    renderVisibleListItems(version);
}

function calculateGridVirtualState(itemCount) {
    const containerWidth = Math.max(imageGrid.clientWidth, GRID_MIN_CARD_WIDTH);
    const usableWidth = Math.max(containerWidth - GRID_PADDING * 2, GRID_MIN_CARD_WIDTH);
    const columns = Math.max(1, Math.floor((usableWidth + GRID_GAP) / (GRID_MIN_CARD_WIDTH + GRID_GAP)));
    const cardWidth = (usableWidth - GRID_GAP * (columns - 1)) / columns;
    const rowHeight = Math.ceil(cardWidth + 102);
    const rowCount = Math.ceil(itemCount / columns);

    return { columns, rowHeight, rowCount, itemCount };
}

function calculateListVirtualState(itemCount) {
    return {
        rowHeight: LIST_ROW_HEIGHT,
        rowCount: itemCount,
        itemCount
    };
}

function renderVisibleGridItems(version) {
    if (version !== galleryRenderVersion || currentViewMode !== 'grid' || !gridVirtualState) return;

    const { columns, rowHeight, rowCount, itemCount } = gridVirtualState;
    const scrollTop = imageGrid.scrollTop;
    const viewportHeight = imageGrid.clientHeight || rowHeight;
    const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - GRID_OVERSCAN_ROWS);
    const lastRow = Math.min(
        rowCount - 1,
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + GRID_OVERSCAN_ROWS
    );
    const startIndex = firstRow * columns;
    const endIndex = Math.min(itemCount, (lastRow + 1) * columns);
    renderVirtualWindow({
        mode: 'grid',
        startIndex,
        endIndex,
        topSpacer: firstRow * rowHeight,
        bottomSpacer: Math.max(0, (rowCount - lastRow - 1) * rowHeight)
    });
    queueRenderedGridThumbnails(version);
}

function renderVisibleListItems(version) {
    if (version !== galleryRenderVersion || currentViewMode !== 'list' || !listVirtualState) return;

    const { rowHeight, rowCount, itemCount } = listVirtualState;
    const scrollTop = imageGrid.scrollTop;
    const viewportHeight = imageGrid.clientHeight || rowHeight;
    const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - LIST_OVERSCAN_ROWS);
    const lastRow = Math.min(
        rowCount - 1,
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + LIST_OVERSCAN_ROWS
    );

    renderVirtualWindow({
        mode: 'list',
        startIndex: firstRow,
        endIndex: Math.min(itemCount, lastRow + 1),
        topSpacer: firstRow * rowHeight,
        bottomSpacer: Math.max(0, (rowCount - lastRow - 1) * rowHeight)
    });
}

function renderVirtualWindow({ mode, startIndex, endIndex, topSpacer, bottomSpacer }) {
    const dom = getVirtualGalleryDom(mode);
    const hasSameWindow = dom.startIndex === startIndex && dom.endIndex === endIndex;

    dom.topSpacer.style.height = `${Math.max(0, Math.round(topSpacer))}px`;
    dom.bottomSpacer.style.height = `${Math.max(0, Math.round(bottomSpacer))}px`;

    if (hasSameWindow) return;

    if (dom.topSpacer.parentNode !== imageGrid || dom.bottomSpacer.parentNode !== imageGrid) {
        imageGrid.replaceChildren(dom.topSpacer, dom.bottomSpacer);
    }

    for (const [index, node] of dom.itemNodes) {
        if (index < startIndex || index >= endIndex) {
            dom.itemNodes.delete(index);
            dom.recycledNodes.push(node);
            node.remove();
        }
    }

    const visibleNodes = [];
    for (let index = startIndex; index < endIndex; index++) {
        let node = dom.itemNodes.get(index);
        if (!node) {
            node = dom.recycledNodes.pop() || document.createElement('div');
            updateVirtualItemNode(node, sortedImages[index], index, mode);
            dom.itemNodes.set(index, node);
        }
        visibleNodes.push(node);
    }

    dom.startIndex = startIndex;
    dom.endIndex = endIndex;
    let previousNode = dom.topSpacer;
    visibleNodes.forEach(node => {
        if (node.previousSibling !== previousNode) {
            imageGrid.insertBefore(node, previousNode.nextSibling || dom.bottomSpacer);
        }
        previousNode = node;
    });
}

function getVirtualGalleryDom(mode) {
    if (virtualGalleryDom && virtualGalleryDom.mode === mode) {
        return virtualGalleryDom;
    }

    virtualGalleryDom = {
        mode,
        topSpacer: createVirtualSpacer(mode),
        bottomSpacer: createVirtualSpacer(mode),
        itemNodes: new Map(),
        recycledNodes: [],
        startIndex: -1,
        endIndex: -1
    };
    return virtualGalleryDom;
}

function createVirtualSpacer(mode) {
    const spacer = document.createElement('div');
    spacer.className = mode === 'grid' ? 'grid-virtual-spacer' : 'list-virtual-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    return spacer;
}

function updateVirtualItemNode(node, img, index, mode) {
    node.className = mode === 'grid' ? 'file-item file-card' : 'file-item';
    node.dataset.index = String(index);
    node.dataset.path = img.path;
    node.innerHTML = mode === 'grid'
        ? renderImageCardContent(img, index)
        : renderImageRowContent(img);
}

function scheduleVirtualGridRender() {
    const virtualState = currentViewMode === 'grid' ? gridVirtualState : listVirtualState;
    if (!virtualState || gridRenderFrame) return;

    const version = galleryRenderVersion;
    gridRenderFrame = requestAnimationFrame(() => {
        gridRenderFrame = null;
        if (version !== galleryRenderVersion) return;
        if (currentViewMode === 'grid') {
            renderVisibleGridItems(version);
        } else {
            renderVisibleListItems(version);
        }
    });
}

function refreshVirtualGridLayout() {
    if (sortedImages.length === 0) return;

    if (currentViewMode === 'waterfall') {
        renderWaterfallPage();
    } else if (currentViewMode === 'grid') {
        gridVirtualState = calculateGridVirtualState(sortedImages.length);
        renderVisibleGridItems(galleryRenderVersion);
    } else {
        listVirtualState = calculateListVirtualState(sortedImages.length);
        renderVisibleListItems(galleryRenderVersion);
    }
}

function queueRenderedGridThumbnails(version) {
    imageGrid.querySelectorAll('.thumbnail-image[data-thumb-index]').forEach(thumbnail => {
        const index = Number(thumbnail.dataset.thumbIndex);
        const img = sortedImages[index];
        if (!img || thumbnail.classList.contains('loaded') || thumbnailQueuedIndexes.has(index)) return;

        const cacheKey = getThumbnailCacheKey(img);
        if (thumbnailMemoryCache.has(cacheKey)) {
            applyThumbnailResult(index, thumbnailMemoryCache.get(cacheKey), version);
            return;
        }

        thumbnailQueuedIndexes.add(index);
        thumbnailQueue.push({ img, index, version });
    });

    pumpThumbnailQueue();
}

function pumpThumbnailQueue() {
    while (
        thumbnailActiveCount < THUMBNAIL_LOAD_CONCURRENCY &&
        thumbnailQueue.length > 0 &&
        currentViewMode === 'grid'
    ) {
        const task = thumbnailQueue.shift();
        if (task.version !== galleryRenderVersion) {
            thumbnailQueuedIndexes.delete(task.index);
            continue;
        }

        thumbnailActiveCount++;
        loadGridThumbnail(task.img, task.index, task.version).finally(() => {
            thumbnailActiveCount--;
            thumbnailQueuedIndexes.delete(task.index);
            pumpThumbnailQueue();
        });
    }
}

function getThumbnailCacheKey(img) {
    return `${img.path}:${img.size}:${img.modifiedTime}:${THUMBNAIL_SIZE}`;
}

async function loadGridThumbnail(img, index, version) {
    let result;
    try {
        result = await window.electronAPI.getThumbnail(img.path, THUMBNAIL_SIZE);
    } catch (error) {
        result = { success: false, error: error.message };
    }

    if (version !== galleryRenderVersion || currentViewMode !== 'grid') return;

    if (result && result.success) {
        rememberThumbnail(getThumbnailCacheKey(img), result.dataUrl);
    }
    applyThumbnailResult(index, result && result.success ? result.dataUrl : null, version);
}

function rememberThumbnail(cacheKey, dataUrl) {
    if (thumbnailMemoryCache.has(cacheKey)) {
        thumbnailMemoryCache.delete(cacheKey);
    }
    thumbnailMemoryCache.set(cacheKey, dataUrl);

    while (thumbnailMemoryCache.size > THUMBNAIL_MEMORY_CACHE_LIMIT) {
        const oldestKey = thumbnailMemoryCache.keys().next().value;
        thumbnailMemoryCache.delete(oldestKey);
    }
}

function applyThumbnailResult(index, dataUrl, version) {
    if (version !== galleryRenderVersion || currentViewMode !== 'grid') return;
    const thumbnail = imageGrid.querySelector(`.thumbnail-image[data-thumb-index="${index}"]`);
    if (!thumbnail) return;

    const card = thumbnail.closest('.file-card');
    if (dataUrl) {
        thumbnail.src = dataUrl;
        thumbnail.classList.add('loaded');
        if (card) card.classList.remove('thumbnail-error');
    } else if (card) {
        card.classList.add('thumbnail-error');
    }
}

function renderImageTagBadges(img) {
    return getImageTags(img).map(tag => {
        const tagInfo = allTags.find(t => t.name === tag);
        const color = safeColor(tagInfo ? tagInfo.color : '#666');
        return `<span class="file-tag" style="background: ${color}">${escapeHtml(tag)}</span>`;
    }).join('');
}

function getImageScore(img) {
    return getImageRatingRecord(img).rating;
}

function getImageRatingRecord(img) {
    const value = img.hash && imageScoresByHash[img.hash] !== undefined
        ? imageScoresByHash[img.hash]
        : img.score;

    if (value && typeof value === 'object') {
        return {
            rating: normalizeRatingNumber(value.rating, 1500),
            wins: normalizeRatingNumber(value.wins, 0),
            matches: normalizeRatingNumber(value.matches, 0)
        };
    }

    const legacyWins = normalizeRatingNumber(value, 0);
    return {
        rating: 1500 + legacyWins,
        wins: legacyWins,
        matches: legacyWins
    };
}

function setImageRatingRecord(img, record) {
    const nextRecord = {
        rating: normalizeRatingNumber(record && record.rating, 1500),
        wins: normalizeRatingNumber(record && record.wins, 0),
        matches: normalizeRatingNumber(record && record.matches, 0)
    };
    img.score = nextRecord;
    if (img.hash) {
        imageScoresByHash[img.hash] = nextRecord;
    }
}

function formatImageRating(img) {
    const record = getImageRatingRecord(img);
    return `${record.rating} 分 · ${record.wins}胜/${record.matches}场`;
}

function getImageMatchCount(img) {
    return getImageRatingRecord(img).matches;
}

function normalizeRatingNumber(value, fallback) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, Math.round(numericValue)) : fallback;
}

function renderImageScoreBadge(img) {
    return `<span class="file-score" title="Elo 评分与胜场">${formatImageRating(img)}</span>`;
}

function getFilteredImages() {
    if (selectedFilterTags.length === 0 && !filterNoTag) {
        return images;
    }
    
    return images.filter(img => {
        const tags = getImageTags(img);
        
        if (filterNoTag && tags.length > 0) {
            return false;
        }
        
        return selectedFilterTags.every(tag => tags.includes(tag));
    });
}

function updateImageCount() {
    const filteredImages = getFilteredImages();
    if (selectedFilterTags.length > 0 || filterNoTag) {
        imageCountEl.textContent = `${filteredImages.length} / ${images.length} 张图片`;
    } else {
        imageCountEl.textContent = `${images.length} 张图片`;
    }
    updateCompetitionLauncherState();
}

function renderTagFilter() {
    const html = [
        renderNoTagFilter(),
        ...renderTagFilterCategories()
    ].join('');

    tagFilter.innerHTML = html;
}

function renderNoTagFilter() {
    return `
        <div class="filter-tag no-tag-filter ${filterNoTag ? 'active' : ''}" 
             style="background: rgba(102, 102, 102, 0.125); color: #666"
             data-tag="__no_tag__">
            <span class="tag-color" style="background: #666"></span>
            无标签
            <span class="filter-tag-count">${getNoTagCount()}</span>
        </div>
    `;
}

function renderTagFilterCategories() {
    if (allTags.length === 0) {
        return [];
    }

    const groupedTags = getTagsByCategory();
    return TAG_CATEGORIES
        .map(category => renderTagFilterCategory(category, groupedTags[category.id]))
        .filter(Boolean);
}

function renderTagFilterCategory(category, tags) {
    if (!tags || tags.length === 0) return '';

    return `
        <div class="tag-category">
            <div class="tag-category-header">
                <span class="tag-category-icon">${escapeHtml(category.icon)}</span>
                <span class="tag-category-name">${escapeHtml(category.name)}</span>
            </div>
            <div class="tag-category-tags">
                ${tags.map(renderFilterTag).join('')}
            </div>
        </div>
    `;
}

function renderFilterTag(tag) {
    const tagColor = safeColor(tag.color);
    return `
        <div class="filter-tag ${selectedFilterTags.includes(tag.name) ? 'active' : ''}" 
             style="background: ${tagColor}20;"
             data-tag="${escapeAttribute(tag.name)}">
            <span class="tag-color" style="background: ${tagColor}"></span>
            ${escapeHtml(tag.name)}
            <span class="filter-tag-count">${getTagCount(tag.name)}</span>
        </div>
    `;
}

function getNoTagCount() {
    return images.filter(img => getImageTags(img).length === 0).length;
}

function toggleFilterTag(tagName) {
    if (tagName === '__no_tag__') {
        filterNoTag = !filterNoTag;
        if (filterNoTag) {
            selectedFilterTags = [];
        }
    } else {
        if (filterNoTag) {
            filterNoTag = false;
        }
        const index = selectedFilterTags.indexOf(tagName);
        if (index === -1) {
            selectedFilterTags.push(tagName);
        } else {
            selectedFilterTags.splice(index, 1);
        }
    }
    renderTagFilter();
    renderImages();
    updateImageCount();
}
