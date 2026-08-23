let duplicateScanInProgress = false;

async function scanDuplicateImages() {
    if (images.length === 0) {
        duplicateGroups = [];
        duplicateScanCompleted = false;
        renderDuplicateResults();
        alert('请先打开一个图片文件夹');
        return;
    }

    if (duplicateScanInProgress) return;

    duplicateScanInProgress = true;
    const scannedFolder = currentFolder;
    const scanButton = document.getElementById('scanDuplicatesBtn');
    if (scanButton) {
        scanButton.disabled = true;
        scanButton.textContent = '正在检测...';
    }

    try {
        const result = await window.electronAPI.findDuplicateImages(images.map(img => ({
            path: img.path,
            size: img.size,
            hash: img.hash
        })));
        if (currentFolder !== scannedFolder) return;
        if (!result.success) {
            alert('检测重复图片失败: ' + (result.error || '未知错误'));
            return;
        }

        duplicateGroups = buildDuplicateGroupsFromFullHash(result.groups);
        duplicateScanCompleted = true;
        renderDuplicateResults();

        if (result.failures?.length > 0) {
            console.warn('部分图片未能完成重复检测:', result.failures);
        }
    } finally {
        duplicateScanInProgress = false;
        if (scanButton) {
            scanButton.disabled = false;
            scanButton.textContent = '检测当前文件夹';
        }
    }
}

function buildDuplicateGroupsFromFullHash(groups) {
    const imagesByPath = new Map(images.map(img => [img.path, img]));

    return (Array.isArray(groups) ? groups : [])
        .map(({ hash, paths }) => ({
            hash,
            images: (Array.isArray(paths) ? paths : [])
                .map(imagePath => imagesByPath.get(imagePath))
                .filter(Boolean)
                .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        }))
        .filter(group => group.images.length > 1)
        .sort((a, b) => b.images.length - a.images.length);
}

function removePathsFromDuplicateGroups(paths) {
    const deletedPaths = new Set(paths);
    return duplicateGroups
        .map(group => ({
            ...group,
            images: group.images.filter(img => !deletedPaths.has(img.path))
        }))
        .filter(group => group.images.length > 1);
}

function renderDuplicateResults() {
    const summaryEl = document.getElementById('duplicateSummary');
    const resultsEl = document.getElementById('duplicateResults');
    const deleteAllBtn = document.getElementById('deleteDuplicateImagesBtn');
    if (!summaryEl || !resultsEl) return;

    if (images.length === 0) {
        summaryEl.textContent = '请先打开一个图片文件夹';
        resultsEl.innerHTML = '<div class="empty-state">暂无检测结果</div>';
        setDeleteDuplicatesButtonState(deleteAllBtn, 0);
        return;
    }

    if (!duplicateScanCompleted) {
        summaryEl.textContent = `当前文件夹 ${images.length} 张图片，尚未检测`;
        resultsEl.innerHTML = '<div class="empty-state">点击“检测当前文件夹”开始扫描重复图片</div>';
        setDeleteDuplicatesButtonState(deleteAllBtn, 0);
        return;
    }

    if (duplicateGroups.length === 0) {
        summaryEl.textContent = `当前文件夹 ${images.length} 张图片，未发现重复组`;
        resultsEl.innerHTML = '<div class="empty-state">未发现 hash 相同的重复图片</div>';
        setDeleteDuplicatesButtonState(deleteAllBtn, 0);
        return;
    }

    const duplicateCount = duplicateGroups.reduce((total, group) => total + group.images.length - 1, 0);
    summaryEl.textContent = `发现 ${duplicateGroups.length} 组重复，建议清理 ${duplicateCount} 张`;
    setDeleteDuplicatesButtonState(deleteAllBtn, duplicateCount);
    resultsEl.innerHTML = duplicateGroups.map(renderDuplicateGroup).join('');
    bindDuplicateActions(resultsEl);
}

function setDeleteDuplicatesButtonState(button, duplicateCount) {
    if (!button) return;

    button.disabled = duplicateCount === 0;
    button.textContent = duplicateCount > 0
        ? `一键删除 ${duplicateCount} 张重复图片`
        : '一键删除重复图片';
}

function renderDuplicateGroup(group, groupIndex) {
    const shortHash = group.hash.slice(0, 12);

    return `
        <div class="duplicate-group">
            <div class="duplicate-group-header">
                <span>重复组 ${groupIndex + 1}</span>
                <span>${group.images.length} 张</span>
                <code>${escapeHtml(shortHash)}</code>
            </div>
            <div class="duplicate-files">
                ${group.images.map((img, index) => renderDuplicateItem(img, index)).join('')}
            </div>
        </div>
    `;
}

function renderDuplicateItem(img, index) {
    return `
        <div class="duplicate-item" data-path="${escapeAttribute(img.path)}">
            <div class="duplicate-item-main">
                <span class="duplicate-keep-badge">${index === 0 ? '参考' : '重复'}</span>
                <div class="duplicate-file-info">
                    <span class="duplicate-file-name">${escapeHtml(img.name)}</span>
                    <span class="duplicate-file-meta">${formatFileSize(img.size)} · ${escapeHtml(img.path)}</span>
                </div>
            </div>
            <div class="duplicate-item-actions">
                <button class="show-duplicate-btn" data-path="${escapeAttribute(img.path)}">定位</button>
                <button class="delete-duplicate-btn" data-path="${escapeAttribute(img.path)}">移入回收站</button>
            </div>
        </div>
    `;
}

function bindDuplicateActions(container) {
    container.querySelectorAll('.show-duplicate-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            window.electronAPI.showInFolder(btn.dataset.path);
        });
    });

    container.querySelectorAll('.delete-duplicate-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            await deleteDuplicateImage(btn.dataset.path);
        });
    });
}

async function deleteDuplicateImage(imagePath) {
    const img = images.find(item => item.path === imagePath);
    if (!img) return;

    if (!confirm(`确定要将这张重复图片移入回收站吗？\n\n${img.name}`)) {
        return;
    }

    const result = await window.electronAPI.deleteImage(imagePath);
    if (!result.success) {
        alert('删除失败: ' + result.error);
        return;
    }

    recordFileOperation([createDeleteHistoryItem(result, img)]);
    images = images.filter(item => item.path !== imagePath);
    duplicateGroups = removePathsFromDuplicateGroups([imagePath]);
    duplicateScanCompleted = true;
    renderImages();
    renderTagFilter();
    renderDuplicateResults();
    updateImageCount();
    updateMigrateSourceFolder();

    if (imageModal.classList.contains('show')) {
        if (sortedImages.length === 0) {
            closeModal();
        } else {
            currentImageIndex = Math.min(currentImageIndex, sortedImages.length - 1);
            updateModalImage();
        }
    }
}

async function deleteDuplicateImagesDistinct() {
    if (images.length === 0) {
        alert('请先打开一个图片文件夹');
        return;
    }

    if (!duplicateScanCompleted) {
        await scanDuplicateImages();
        if (!duplicateScanCompleted) return;
    }

    const duplicateImages = duplicateGroups.flatMap(group => group.images.slice(1));
    if (duplicateImages.length === 0) {
        renderDuplicateResults();
        alert('当前文件夹没有可删除的重复图片');
        return;
    }

    const confirmed = confirm(
        `确定要按 distinct 方式清理重复图片吗？\n\n` +
        `将保留每组第一张参考图片，移入回收站 ${duplicateImages.length} 张重复图片。`
    );
    if (!confirmed) return;

    const deleteAllBtn = document.getElementById('deleteDuplicateImagesBtn');
    if (deleteAllBtn) {
        deleteAllBtn.disabled = true;
        deleteAllBtn.textContent = '正在删除...';
    }

    const modalWasOpen = imageModal.classList.contains('show');
    const modalImagePath = modalWasOpen && currentImageIndex >= 0 && currentImageIndex < sortedImages.length
        ? sortedImages[currentImageIndex].path
        : null;
    const previousImageIndex = currentImageIndex;
    const result = await window.electronAPI.deleteImages(duplicateImages.map(img => img.path));
    if (!result.success) {
        alert('批量删除失败: ' + (result.error || '未知错误'));
        refreshAfterDuplicateBatchRemoval([], { modalWasOpen, modalImagePath, previousImageIndex });
        return;
    }

    const imageByPath = new Map(duplicateImages.map(img => [img.path, img]));
    const deletedPaths = result.deleted.map(item => item.originalPath);
    const failures = result.failures.map(item => ({
        name: imageByPath.get(item.originalPath)?.name || item.fileName || item.originalPath,
        error: item.error || '未知错误'
    }));
    recordFileOperation(result.deleted.map(item => createDeleteHistoryItem(
        item,
        imageByPath.get(item.originalPath),
        -1
    )));

    refreshAfterDuplicateBatchRemoval(deletedPaths, {
        modalWasOpen,
        modalImagePath,
        previousImageIndex
    });

    if (failures.length > 0) {
        const failedNames = failures.slice(0, 5).map(item => `- ${item.name}: ${item.error}`).join('\n');
        const moreText = failures.length > 5 ? `\n还有 ${failures.length - 5} 张失败` : '';
        alert(`已删除 ${deletedPaths.length} 张，${failures.length} 张删除失败：\n\n${failedNames}${moreText}`);
    }
}

function refreshAfterDuplicateBatchRemoval(deletedPaths, modalState) {
    if (deletedPaths.length > 0) {
        const deletedPathSet = new Set(deletedPaths);
        images = images.filter(item => !deletedPathSet.has(item.path));
    }

    duplicateGroups = removePathsFromDuplicateGroups(deletedPaths);
    duplicateScanCompleted = true;
    renderImages();
    renderTagFilter();
    renderDuplicateResults();
    updateImageCount();
    updateMigrateSourceFolder();

    if (!modalState.modalWasOpen) return;

    if (sortedImages.length === 0) {
        closeModal();
        return;
    }

    const retainedIndex = sortedImages.findIndex(img => img.path === modalState.modalImagePath);
    currentImageIndex = retainedIndex >= 0
        ? retainedIndex
        : Math.min(modalState.previousImageIndex, sortedImages.length - 1);
    updateModalImage();
}
