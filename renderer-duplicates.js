function scanDuplicateImages() {
    if (images.length === 0) {
        duplicateGroups = [];
        duplicateScanCompleted = false;
        renderDuplicateResults();
        alert('请先打开一个图片文件夹');
        return;
    }

    duplicateGroups = buildDuplicateGroups(images);
    duplicateScanCompleted = true;
    renderDuplicateResults();
}

function buildDuplicateGroups(sourceImages) {
    const groups = new Map();

    sourceImages.forEach(img => {
        if (!img.hash) return;
        if (!groups.has(img.hash)) {
            groups.set(img.hash, []);
        }
        groups.get(img.hash).push(img);
    });

    return Array.from(groups.entries())
        .map(([hash, groupImages]) => ({
            hash,
            images: groupImages.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        }))
        .filter(group => group.images.length > 1)
        .sort((a, b) => b.images.length - a.images.length);
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

    images = images.filter(item => item.path !== imagePath);
    duplicateGroups = buildDuplicateGroups(images);
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
        duplicateGroups = buildDuplicateGroups(images);
        duplicateScanCompleted = true;
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
    const deletedPaths = [];
    const failures = [];

    for (const img of duplicateImages) {
        const result = await window.electronAPI.deleteImage(img.path);
        if (result.success) {
            deletedPaths.push(img.path);
            deleteHistory.push({
                originalPath: result.originalPath,
                trashPath: result.trashPath,
                fileName: result.fileName,
                index: -1,
                hash: img.hash
            });
        } else {
            failures.push({ name: img.name, error: result.error || '未知错误' });
        }
    }

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

    duplicateGroups = buildDuplicateGroups(images);
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
