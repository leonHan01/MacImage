let modalTagsExpanded = false;

function openImageModal(index, { closeOnImageClick = false } = {}) {
    currentImageIndex = index;
    closeModalOnImageClick = closeOnImageClick;
    setModalTagsExpanded(false);
    resetImageTransform();
    updateModalImage();
    updateZoomDisplay();
    imageModal.classList.add('show');
    recordCurrentImageOpen();
}

function setModalTagsExpanded(expanded) {
    modalTagsExpanded = Boolean(expanded);
    const modalBody = document.querySelector('#imageModal .modal-body');
    const modal = document.getElementById('imageModal');
    const panel = document.getElementById('modalTagsPanel');
    const collapseButton = document.getElementById('toggleModalTagsBtn');
    const revealButton = document.getElementById('showModalTagsBtn');

    modalBody?.classList.toggle('modal-sidebar-collapsed', !modalTagsExpanded);
    modal?.classList.toggle('modal-sidebar-collapsed', !modalTagsExpanded);
    if (panel) panel.hidden = !modalTagsExpanded;
    if (collapseButton) {
        collapseButton.setAttribute('aria-expanded', String(modalTagsExpanded));
    }
    if (revealButton) {
        revealButton.setAttribute('aria-expanded', String(modalTagsExpanded));
    }
}

function toggleModalTags() {
    setModalTagsExpanded(!modalTagsExpanded);
}


function closeModal() {
    imageModal.classList.remove('show');
    currentImageIndex = -1;
    closeModalOnImageClick = false;
    resetImageTransform();
}

function resetImageTransform() {
    currentZoom = 1;
    imageTranslateX = 0;
    imageTranslateY = 0;
}

function updateModalImage() {
    if (currentImageIndex < 0 || currentImageIndex >= sortedImages.length) return;
    
    const img = sortedImages[currentImageIndex];
    const modalImage = document.getElementById('modalImage');
    modalImage.src = toFileUrl(img.path);
    modalImage.title = '双击或按 F 添加或取消红心标签';
    modalImage.style.transform = `scale(${currentZoom}) translate(${imageTranslateX}px, ${imageTranslateY}px)`;
    document.getElementById('modalFilename').textContent = img.name;
    document.getElementById('modalScore').textContent = formatImageRating(img);
    document.getElementById('modalImageIndex').textContent = `${currentImageIndex + 1} / ${sortedImages.length}`;
    
    renderModalTagList(img);
}

function renderModalTagList(img) {
    const tagList = document.getElementById('modalTagList');
    
    if (allTags.length === 0) {
        tagList.innerHTML = '<div class="empty-state">请先添加标签</div>';
        return;
    }

    const groupedTags = getTagsByCategory();
    tagList.innerHTML = TAG_CATEGORIES
        .map(category => renderModalTagCategory(category, groupedTags[category.id], img))
        .filter(Boolean)
        .join('');

    tagList.querySelectorAll('.modal-tag-item').forEach(item => {
        item.addEventListener('click', async () => {
            await toggleModalImageTag(item.dataset.path, item.dataset.tag, { autoAdvance: true });
        });
    });
}

function renderModalTagCategory(category, tags, img) {
    if (!tags || tags.length === 0) return '';

    return `
        <div class="modal-tag-category">
            <div class="modal-tag-category-header">
                <span>${escapeHtml(category.icon)}</span>
                <span>${escapeHtml(category.name)}</span>
            </div>
            <div class="modal-tag-category-tags">
                ${tags.map(tag => renderModalTagItem(tag, img)).join('')}
            </div>
        </div>
    `;
}

function renderModalTagItem(tag, img) {
    const isSelected = getImageTags(img).includes(tag.name);
    const tagColor = safeColor(tag.color);
    const shortcut = normalizeShortcut(tag.shortcut);

    return `
        <div class="modal-tag-item ${isSelected ? 'selected' : ''}" data-tag="${escapeAttribute(tag.name)}" data-path="${escapeAttribute(img.path)}">
            <div class="modal-tag-checkbox">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            </div>
            <span class="modal-tag-color" style="background: ${tagColor}"></span>
            <span class="modal-tag-name">${escapeHtml(tag.name)}</span>
            ${shortcut ? `<span class="modal-tag-shortcut">${escapeHtml(shortcut.toUpperCase())}</span>` : ''}
        </div>
    `;
}

async function toggleModalImageTag(imagePath, tagName, options = {}) {
    const image = images.find(i => i.path === imagePath);
    if (!image) return false;
    const originalPath = sortedImages[currentImageIndex]?.path;
    const currentTags = getImageTags(image);
    const willAdd = !currentTags.includes(tagName);

    if (willAdd) {
        await addTagToImage(imagePath, tagName);
        if (await moveNewlyTaggedImageToTarget(imagePath)) {
            return true;
        }
    } else {
        await removeTagFromImage(imagePath, tagName);
    }

    const updatedImg = images.find(i => i.path === imagePath);
    renderModalTagList(updatedImg);
    renderImages();
    renderTagFilter();
    updateImageCount();

    if (options.autoAdvance) {
        advanceIfStillViewing(originalPath);
    }

    return willAdd;
}

async function toggleCurrentImageTag(tagName, options = {}) {
    if (currentImageIndex < 0 || currentImageIndex >= sortedImages.length) return;

    const img = sortedImages[currentImageIndex];
    const originalPath = img.path;
    const willAdd = await toggleModalImageTag(img.path, tagName);

    if (options.showFeedback) {
        showTagFeedback(tagName, willAdd);
    }

    if (settingsModal.classList.contains('show')) {
        renderTagList();
    }

    if (options.autoAdvance) {
        advanceIfStillViewing(originalPath);
    }
}

async function toggleHeartTagForCurrentImage(e, options = {}) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }

    if (currentImageIndex < 0 || currentImageIndex >= sortedImages.length) return;

    await ensureDefaultTags();

    const img = sortedImages[currentImageIndex];
    const originalPath = img.path;
    const hasHeart = getImageTags(img).includes(HEART_TAG_NAME);
    const nextTags = hasHeart
        ? await removeTagFromImage(img.path, HEART_TAG_NAME)
        : await addTagToImage(img.path, HEART_TAG_NAME);

    if (!hasHeart && await moveNewlyTaggedImageToTarget(img.path)) {
        return;
    }

    imageCollection.applyMetadata({ path: img.path, tags: nextTags });

    showHeartFeedback(!hasHeart);
    renderModalTagList(img);
    renderImages();
    renderTagFilter();
    updateImageCount();

    if (settingsModal.classList.contains('show')) {
        renderTagList();
    }

    if (options.autoAdvance) {
        advanceIfStillViewing(originalPath);
    }
}

async function handleModalFavoriteDblClick(e) {
    if (e.target.closest('button, input, select, textarea, a')) return;

    await toggleHeartTagForCurrentImage(e, { autoAdvance: true });
}

function handleModalDeleteContextMenu(e) {
    if (e.target.closest('button, input, select, textarea, a')) return;

    e.preventDefault();
    e.stopPropagation();
    void deleteCurrentImage();
}

function showHeartFeedback(isActive) {
    showTagFeedback(isActive ? '❤️' : '♡', isActive);
}

function showTagFeedback(label, isActive) {
    const wrapper = document.querySelector('.modal-image-wrapper');
    if (!wrapper) return;

    const feedback = document.createElement('div');
    feedback.className = `tag-feedback ${isActive ? 'active' : 'inactive'}`;
    feedback.textContent = label;
    wrapper.appendChild(feedback);
    feedback.addEventListener('animationend', () => feedback.remove(), { once: true });
}

function zoomIn() {
    currentZoom = Math.min(currentZoom * 1.25, maxZoom);
    updateModalImage();
    updateZoomDisplay();
    updateImageCursor();
}

function zoomOut() {
    currentZoom = Math.max(currentZoom * 0.8, minZoom);
    if (currentZoom <= 1) {
        imageTranslateX = 0;
        imageTranslateY = 0;
    }
    updateModalImage();
    updateZoomDisplay();
    updateImageCursor();
}

function zoomReset() {
    currentZoom = 1;
    imageTranslateX = 0;
    imageTranslateY = 0;
    updateModalImage();
    updateZoomDisplay();
    updateImageCursor();
}

function updateZoomDisplay() {
    document.getElementById('zoomLevel').textContent = Math.round(currentZoom * 100) + '%';
}

function updateImageCursor() {
    const modalImageEl = document.getElementById('modalImage');
    if (modalImageEl) {
        modalImageEl.style.cursor = currentZoom > 1 ? 'grab' : 'pointer';
    }
}

function handleModalWheel(e) {
    e.preventDefault();

    if (e.metaKey) {
        zoomWithWheel(e.deltaY);
        return;
    }

    navigateWithWheel(e.deltaY);
}

function zoomWithWheel(deltaY) {
    if (deltaY < 0) {
        zoomIn();
    } else if (deltaY > 0) {
        zoomOut();
    }
}

function navigateWithWheel(deltaY) {
    if (Math.abs(deltaY) < 1) return;

    const now = Date.now();
    if (now - lastWheelNavigationTime < WHEEL_NAVIGATION_COOLDOWN_MS) {
        return;
    }

    lastWheelNavigationTime = now;
    if (deltaY > 0) {
        showNextImage();
    } else {
        showPrevImage();
    }
}

function showPrevImage() {
    if (currentImageIndex > 0) {
        currentImageIndex--;
        resetImageTransform();
        updateModalImage();
        updateZoomDisplay();
        updateImageCursor();
        recordCurrentImageOpen();
    }
}

function showNextImage() {
    if (currentImageIndex < sortedImages.length - 1) {
        currentImageIndex++;
        resetImageTransform();
        updateModalImage();
        updateZoomDisplay();
        updateImageCursor();
        recordCurrentImageOpen();
    }
}

function advanceIfStillViewing(imagePath) {
    if (
        imagePath &&
        imageModal.classList.contains('show') &&
        sortedImages[currentImageIndex]?.path === imagePath
    ) {
        showNextImage();
    }
}

function recordCurrentImageOpen() {
    if (currentImageIndex < 0 || currentImageIndex >= sortedImages.length) return;

    const img = sortedImages[currentImageIndex];
    if (img && img.path) {
        void addRecentOpenFile(img.path, currentFolder || getParentFolder(img.path));
    }
}

function showCurrentImageInFolder() {
    if (currentImageIndex < 0 || currentImageIndex >= sortedImages.length) return;
    const img = sortedImages[currentImageIndex];
    window.electronAPI.showInFolder(img.path);
}

async function deleteCurrentImage() {
    if (currentImageIndex < 0 || currentImageIndex >= sortedImages.length) return;
    if (isDeletingCurrentImage) return;
    
    const img = sortedImages[currentImageIndex];
    isDeletingCurrentImage = true;

    try {
        const result = await window.electronAPI.deleteImage(img.path);
        
        if (result.success) {
            handleDeletedImage(result, img);
        } else {
            alert('删除失败: ' + result.error);
        }
    } finally {
        isDeletingCurrentImage = false;
    }
}

function handleDeletedImage(result, img) {
    recordFileOperation([createDeleteHistoryItem(result, img, currentImageIndex)]);

    imageCollection.remove(img.path);
    refreshAfterImageRemoval();
}

function createDeleteHistoryItem(result, img = null, index = -1) {
    return {
        kind: 'delete',
        originalPath: result.originalPath,
        trashPath: result.trashPath,
        fileName: result.fileName,
        index,
        hash: img?.hash || null
    };
}

function recordFileOperation(items) {
    const normalizedItems = (Array.isArray(items) ? items : [])
        .filter(item => item && ['delete', 'move'].includes(item.kind))
        .map(item => ({ ...item }));
    if (normalizedItems.length > 0) {
        deleteHistory.push({ type: 'batch', items: normalizedItems });
    }
}

function refreshAfterImageRemoval() {
    refreshAfterImageMembershipChange();

    if (images.length === 0) {
        closeModal();
    } else {
        if (currentImageIndex >= sortedImages.length) {
            currentImageIndex = sortedImages.length - 1;
        }
        updateModalImage();
    }
}

async function undoLastDelete() {
    if (deleteHistory.length === 0) {
        return;
    }

    const lastOperation = deleteHistory.pop();
    const operationItems = Array.isArray(lastOperation.items)
        ? lastOperation.items
        : [lastOperation];
    const failedItems = [];
    let restoredCount = 0;

    for (const item of [...operationItems].reverse()) {
        const normalizedItem = item.kind ? item : { ...item, kind: 'delete' };
        let restored = false;
        try {
            const result = await window.electronAPI.undoFileOperation(normalizedItem);
            restored = result.success;
        } catch {
            // Keep the item in history so a later retry can recover it.
        }
        if (restored) {
            restoredCount++;
        } else {
            failedItems.push(normalizedItem);
        }
    }

    if (failedItems.length > 0) {
        recordFileOperation(failedItems.reverse());
    }
    if (restoredCount > 0) {
        await loadFolder(currentFolder, { preserveDeleteHistory: true });
    }
    if (failedItems.length > 0) {
        alert(`撤销完成 ${restoredCount} 项，${failedItems.length} 项失败：${failedItems[0].originalPath}`);
    }
}

function handleKeyboard(e) {
    if (imageModal.classList.contains('show')) {
        if (isEditableTarget(e.target)) {
            if (e.key === 'Escape') closeModal();
            return;
        }
        if (handleImageModalShortcut(e)) {
            return;
        }
        if (handleTagShortcut(e)) {
            return;
        }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            showPrevImage();
        }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            showNextImage();
        }
        else if (e.key === 'Escape') closeModal();
        else if (e.key === 'Delete') {
            e.preventDefault();
            void deleteCurrentImage();
        }
        else if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            zoomIn();
        }
        else if (e.key === '-') {
            e.preventDefault();
            zoomOut();
        }
        else if (e.key === '0') {
            e.preventDefault();
            zoomReset();
        }
    } else if (competitionModal.classList.contains('show')) {
        if (e.key === 'Escape') {
            closeCompetition();
        } else if (/^[1-8]$/.test(e.key)) {
            e.preventDefault();
            chooseCompetitionWinner(Number(e.key) - 1);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            chooseCompetitionWinner(0);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            chooseCompetitionWinner(1);
        }
    } else if (settingsModal.classList.contains('show')) {
        if (e.key === 'Escape') closeSettings();
    } else if (currentViewMode === 'waterfall' && !isEditableTarget(e.target)) {
        const isUnmodifiedSpace = (e.key === ' ' || e.code === 'Space') &&
            !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
        if (e.key === 'ArrowDown' || isUnmodifiedSpace) {
            e.preventDefault();
            if (!e.repeat) void advanceWaterfallPage();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!e.repeat) void restorePreviousWaterfallPage();
        }
    }
}

function handleImageModalShortcut(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isEditableTarget(e.target)) {
        return false;
    }

    const shortcut = normalizeShortcut(e.key);
    if (shortcut === FAVORITE_IMAGE_SHORTCUT) {
        e.preventDefault();
        if (!e.repeat) {
            void toggleHeartTagForCurrentImage(e, { autoAdvance: true });
        }
        return true;
    }

    if (shortcut === DELETE_IMAGE_SHORTCUT) {
        e.preventDefault();
        if (!e.repeat) {
            void deleteCurrentImage();
        }
        return true;
    }

    return false;
}

function handleTagShortcut(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isEditableTarget(e.target)) {
        return false;
    }

    const tag = getTagByShortcut(e.key);
    if (!tag) {
        return false;
    }

    e.preventDefault();
    toggleCurrentImageTag(tag.name, { showFeedback: true, autoAdvance: true });
    return true;
}
