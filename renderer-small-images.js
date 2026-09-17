let smallImageDeleteInProgress = false;

function getSmallImageThresholdKb() {
    const input = document.getElementById('smallImageThresholdInput');
    return MacImageSmallImageUtils.parseThresholdKb(input?.value);
}

function syncSmallImageThresholdInput() {
    const input = document.getElementById('smallImageThresholdInput');
    if (input) input.value = String(smallImageThresholdKb);
}

function updateSmallImageThreshold() {
    const input = document.getElementById('smallImageThresholdInput');
    const thresholdKb = getSmallImageThresholdKb();
    if (input) {
        input.setCustomValidity(thresholdKb === null ? '请输入大于 0 且不超过 300 的数值' : '');
    }
    if (thresholdKb === null) return;

    smallImageThresholdKb = thresholdKb;
    localStorage.setItem('macimage:smallImageThresholdKb', String(thresholdKb));
    smallImageCandidates = [];
    smallImageScanCompleted = false;
    renderSmallImageResults();
}

function scanSmallImages() {
    if (images.length === 0) {
        smallImageCandidates = [];
        smallImageScanCompleted = false;
        renderSmallImageResults();
        alert('请先打开一个图片文件夹');
        return;
    }

    const thresholdKb = getSmallImageThresholdKb();
    if (thresholdKb === null) {
        document.getElementById('smallImageThresholdInput')?.reportValidity();
        alert('请输入大于 0 且不超过 300 KB 的大小阈值');
        return;
    }

    smallImageThresholdKb = thresholdKb;
    localStorage.setItem('macimage:smallImageThresholdKb', String(thresholdKb));
    smallImageCandidates = MacImageSmallImageUtils.findImagesBelowSize(images, thresholdKb);
    smallImageScanCompleted = true;
    renderSmallImageResults();
}

function renderSmallImageResults() {
    const summaryEl = document.getElementById('smallImageSummary');
    const resultsEl = document.getElementById('smallImageResults');
    const deleteAllBtn = document.getElementById('deleteSmallImagesBtn');
    if (!summaryEl || !resultsEl) return;

    syncSmallImageThresholdInput();

    if (images.length === 0) {
        summaryEl.textContent = '请先打开一个图片文件夹';
        resultsEl.innerHTML = '<div class="empty-state">暂无扫描结果</div>';
        setDeleteSmallImagesButtonState(deleteAllBtn, 0);
        return;
    }

    if (!smallImageScanCompleted) {
        summaryEl.textContent = `当前文件夹 ${images.length} 张图片，尚未扫描`;
        resultsEl.innerHTML = '<div class="empty-state">填写阈值后，点击“扫描当前文件夹”</div>';
        setDeleteSmallImagesButtonState(deleteAllBtn, 0);
        return;
    }

    if (smallImageCandidates.length === 0) {
        summaryEl.textContent = `未发现小于 ${formatSmallImageThreshold(smallImageThresholdKb)} 的图片`;
        resultsEl.innerHTML = '<div class="empty-state">没有符合当前大小条件的图片</div>';
        setDeleteSmallImagesButtonState(deleteAllBtn, 0);
        return;
    }

    const totalSize = smallImageCandidates.reduce((total, image) => total + image.size, 0);
    summaryEl.textContent = `发现 ${smallImageCandidates.length} 张小于 ${formatSmallImageThreshold(smallImageThresholdKb)} 的图片，共 ${formatFileSize(totalSize)}`;
    setDeleteSmallImagesButtonState(deleteAllBtn, smallImageCandidates.length);
    resultsEl.innerHTML = smallImageCandidates.map(renderSmallImageItem).join('');
    bindSmallImageActions(resultsEl);
}

function formatSmallImageThreshold(thresholdKb) {
    return `${thresholdKb} KB`;
}

function setDeleteSmallImagesButtonState(button, count) {
    if (!button) return;

    button.disabled = count === 0 || smallImageDeleteInProgress;
    if (smallImageDeleteInProgress) {
        button.textContent = '正在删除...';
        return;
    }
    button.textContent = count > 0
        ? `一键删除 ${count} 张小图片`
        : '一键删除小图片';
}

function renderSmallImageItem(image) {
    return `
        <div class="small-image-item" data-path="${escapeAttribute(image.path)}">
            <div class="small-image-item-main">
                <span class="small-image-size-badge">${formatFileSize(image.size)}</span>
                <div class="small-image-file-info">
                    <span class="small-image-file-name">${escapeHtml(image.name)}</span>
                    <span class="small-image-file-meta">${escapeHtml(image.path)}</span>
                </div>
            </div>
            <div class="small-image-item-actions">
                <button class="show-small-image-btn" data-path="${escapeAttribute(image.path)}">定位</button>
                <button class="delete-small-image-btn" data-path="${escapeAttribute(image.path)}">移入回收站</button>
            </div>
        </div>
    `;
}

function bindSmallImageActions(container) {
    container.querySelectorAll('.show-small-image-btn').forEach(button => {
        button.addEventListener('click', () => {
            window.electronAPI.showInFolder(button.dataset.path);
        });
    });

    container.querySelectorAll('.delete-small-image-btn').forEach(button => {
        button.addEventListener('click', () => {
            void deleteSmallImage(button.dataset.path);
        });
    });
}

async function deleteSmallImage(imagePath) {
    if (smallImageDeleteInProgress) return;

    const image = images.find(item => item.path === imagePath);
    if (!image) return;

    if (!confirm(`确定要将这张小图片移入回收站吗？\n\n${image.name}`)) return;

    smallImageDeleteInProgress = true;
    try {
        const result = await window.electronAPI.deleteImage(imagePath);
        if (!result.success) {
            alert('删除失败: ' + result.error);
            return;
        }

        recordFileOperation([createDeleteHistoryItem(result, image)]);
        imageCollection.remove(imagePath);
        smallImageCandidates = smallImageCandidates.filter(candidate => candidate.path !== imagePath);
        refreshAfterImageMembershipChange();
    } finally {
        smallImageDeleteInProgress = false;
        renderSmallImageResults();
    }
}

async function deleteSmallImages() {
    if (smallImageDeleteInProgress) return;

    if (!smallImageScanCompleted) {
        scanSmallImages();
        if (!smallImageScanCompleted) return;
    }

    const candidates = [...smallImageCandidates];
    if (candidates.length === 0) {
        renderSmallImageResults();
        alert('当前文件夹没有可删除的小图片');
        return;
    }

    const totalSize = candidates.reduce((total, image) => total + image.size, 0);
    if (!confirm(
        `确定要将 ${candidates.length} 张小于 ${formatSmallImageThreshold(smallImageThresholdKb)} 的图片移入回收站吗？\n\n` +
        `本次将移动 ${formatFileSize(totalSize)}，可通过 Cmd + Z 撤销最近一次操作。`
    )) return;

    smallImageDeleteInProgress = true;
    renderSmallImageResults();

    try {
        const result = await window.electronAPI.deleteImages(candidates.map(image => image.path));
        if (!result.success) {
            alert('批量删除失败: ' + (result.error || '未知错误'));
            return;
        }

        const imageByPath = new Map(candidates.map(image => [image.path, image]));
        const deleted = Array.isArray(result.deleted) ? result.deleted : [];
        const failures = Array.isArray(result.failures) ? result.failures : [];
        const deletedPaths = deleted.map(item => item.originalPath);
        recordFileOperation(deleted.map(item => createDeleteHistoryItem(
            item,
            imageByPath.get(item.originalPath),
            -1
        )));

        smallImageCandidates = smallImageCandidates.filter(image => !deletedPaths.includes(image.path));
        imageCollection.remove(deletedPaths);
        refreshAfterImageMembershipChange();

        if (failures.length > 0) {
            const failedNames = failures.slice(0, 5)
                .map(item => imageByPath.get(item.originalPath)?.name || item.fileName || item.originalPath)
                .join('、');
            const moreText = failures.length > 5 ? `，另有 ${failures.length - 5} 张` : '';
            alert(`已移入回收站 ${deletedPaths.length} 张；${failures.length} 张失败：${failedNames}${moreText}`);
        }
    } finally {
        smallImageDeleteInProgress = false;
        renderSmallImageResults();
    }
}
