const modalPreviewState = MacImagePreviewState.create();
const WHEEL_NAVIGATION_COOLDOWN_MS = 220;
let modalTagsExpanded = false;
let closeModalOnImageClick = false;
let isDeletingCurrentImage = false;
let isCopyingCurrentImage = false;
let lastWheelNavigationTime = 0;

function openImageModal(index, { closeOnImageClick = false } = {}) {
    if (!modalPreviewState.select(sortedImages, index)) return;
    closeModalOnImageClick = closeOnImageClick;
    setModalTagsExpanded(false);
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
    modalPreviewState.close();
    closeModalOnImageClick = false;
}

function getCurrentModalImage() {
    const { index, imagePath } = modalPreviewState.snapshot();
    const image = sortedImages[index];
    return image?.path === imagePath ? image : null;
}

function setModalCopyStatus(message = '') {
    const status = document.getElementById('modalCopyStatus');
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
}

async function copyCurrentImage() {
    const img = getCurrentModalImage();
    if (!img || isCopyingCurrentImage) return;

    const button = document.getElementById('copyImageBtn');
    isCopyingCurrentImage = true;
    if (button) button.disabled = true;
    setModalCopyStatus('正在复制图片…');

    try {
        const result = await window.electronAPI.copyImage(img.path);
        if (getCurrentModalImage()?.path !== img.path) return;
        setModalCopyStatus(result?.success
            ? '图片已复制到剪贴板'
            : `复制失败：${result?.error || '无法复制当前图片'}`);
    } catch (error) {
        if (getCurrentModalImage()?.path === img.path) {
            setModalCopyStatus(`复制失败：${error.message || '无法复制当前图片'}`);
        }
    } finally {
        isCopyingCurrentImage = false;
        if (button) button.disabled = false;
    }
}

function updateModalImage() {
    const img = getCurrentModalImage();
    if (!img) return;
    setModalCopyStatus();
    
    const modalImage = document.getElementById('modalImage');
    modalImage.src = toFileUrl(img.path);
    modalImage.title = '双击或按 F 添加或取消红心标签';
    updateModalImageTransform();
    document.getElementById('modalFilename').textContent = img.name;
    document.getElementById('modalScore').textContent = formatImageRating(img);
    document.getElementById('modalImageIndex').textContent = `${modalPreviewState.snapshot().index + 1} / ${sortedImages.length}`;
    
    renderModalTagList(img);
}

function syncModalWithImages() {
    if (!imageModal.classList.contains('show')) return;
    if (!modalPreviewState.reconcile(sortedImages)) {
        closeModal();
        return;
    }

    updateModalImage();
    updateZoomDisplay();
    updateImageCursor();
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
    const originalPath = getCurrentModalImage()?.path;
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
    const img = getCurrentModalImage();
    if (!img) return;
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

    if (!getCurrentModalImage()) return;

    await ensureDefaultTags();

    const img = getCurrentModalImage();
    if (!img) return;
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
    modalPreviewState.zoomBy(1.25);
    refreshModalTransform();
}

function zoomOut() {
    modalPreviewState.zoomBy(0.8);
    refreshModalTransform();
}

function zoomReset() {
    modalPreviewState.resetTransform();
    refreshModalTransform();
}

function refreshModalTransform() {
    updateModalImageTransform();
    updateZoomDisplay();
    updateImageCursor();
}

function updateModalImageTransform() {
    const { zoom, translateX, translateY } = modalPreviewState.snapshot();
    document.getElementById('modalImage').style.transform = `scale(${zoom}) translate(${translateX}px, ${translateY}px)`;
}

function updateZoomDisplay() {
    document.getElementById('zoomLevel').textContent = Math.round(modalPreviewState.snapshot().zoom * 100) + '%';
}

function updateImageCursor() {
    const modalImageEl = document.getElementById('modalImage');
    if (modalImageEl) {
        modalImageEl.style.cursor = modalPreviewState.snapshot().zoom > 1 ? 'grab' : 'pointer';
    }
}

function bindModalImageGestures() {
    const modalImage = document.getElementById('modalImage');
    if (!modalImage) return;

    let wasDragged = false;
    modalImage.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        wasDragged = false;
        if (modalPreviewState.startDrag(event.clientX, event.clientY)) {
            modalImage.style.cursor = 'grabbing';
        }
    });
    modalImage.addEventListener('mousemove', (event) => {
        if (modalPreviewState.dragTo(event.clientX, event.clientY)) {
            wasDragged = true;
            updateModalImageTransform();
        }
    });

    const endDrag = () => {
        modalPreviewState.endDrag();
        updateImageCursor();
    };
    modalImage.addEventListener('mouseup', endDrag);
    modalImage.addEventListener('mouseleave', endDrag);
    modalImage.addEventListener('click', () => {
        if (wasDragged) {
            wasDragged = false;
            return;
        }
        if (closeModalOnImageClick) closeModal();
    });
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
    navigateModalImage(-1);
}

function showNextImage() {
    navigateModalImage(1);
}

function navigateModalImage(offset) {
    if (!modalPreviewState.move(sortedImages, offset)) return;
    updateModalImage();
    updateZoomDisplay();
    updateImageCursor();
    recordCurrentImageOpen();
}

function advanceIfStillViewing(imagePath) {
    if (
        imagePath &&
        imageModal.classList.contains('show') &&
        getCurrentModalImage()?.path === imagePath
    ) {
        showNextImage();
    }
}

function recordCurrentImageOpen() {
    const img = getCurrentModalImage();
    if (img && img.path) {
        void addRecentOpenFile(img.path, currentFolder || getParentFolder(img.path));
    }
}

function showCurrentImageInFolder() {
    const img = getCurrentModalImage();
    if (!img) return;
    window.electronAPI.showInFolder(img.path);
}

async function deleteCurrentImage() {
    const img = getCurrentModalImage();
    if (!img) return;
    if (isDeletingCurrentImage) return;
    
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
    recordFileOperation([createDeleteHistoryItem(result, img, modalPreviewState.snapshot().index)]);

    imageCollection.remove(img.path);
    refreshAfterImageMembershipChange();
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
        .filter(item => item && ['delete', 'move', 'system-trash'].includes(item.kind))
        .map(item => ({ ...item }));
    if (normalizedItems.length > 0) {
        deleteHistory.push({ type: 'batch', items: normalizedItems });
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
    const systemTrashCount = operationItems.filter(item => item.kind === 'system-trash').length;
    let restoredCount = 0;

    for (const item of [...operationItems].reverse()) {
        if (item.kind === 'system-trash') continue;
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
    if (systemTrashCount > 0) {
        alert(`${systemTrashCount} 张图片已移入系统废纸篓，请在 Finder 废纸篓中使用“放回原处”恢复。`);
    }
}
