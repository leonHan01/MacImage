let isFolderLoading = false;
let pendingDirectoryMetadataUpdates = new Map();
let directoryMetadataRenderTimer = null;

function queueDirectoryMetadataUpdates(data) {
    if (!data || data.dirPath !== currentFolder || !Array.isArray(data.updates)) return;

    data.updates.forEach((update) => {
        if (update && typeof update.path === 'string') {
            pendingDirectoryMetadataUpdates.set(update.path, update);
        }
    });

    scheduleDirectoryMetadataRender();
}

function scheduleDirectoryMetadataRender() {
    if (isFolderLoading || pendingDirectoryMetadataUpdates.size === 0 || directoryMetadataRenderTimer) return;

    directoryMetadataRenderTimer = setTimeout(() => {
        directoryMetadataRenderTimer = null;
        applyDirectoryMetadataUpdates();
    }, 120);
}

function applyDirectoryMetadataUpdates() {
    if (isFolderLoading || pendingDirectoryMetadataUpdates.size === 0) return;

    const imagesByPath = new Map(images.map(img => [img.path, img]));
    let hasChanges = false;

    pendingDirectoryMetadataUpdates.forEach((update, imagePath) => {
        const image = imagesByPath.get(imagePath);
        if (!image || !update.hash) return;

        image.hash = update.hash;
        image.tags = Array.isArray(update.tags) ? update.tags : [];
        image.score = update.score ?? null;
        if (image.tags.length > 0) {
            imageTagsByHash[update.hash] = image.tags;
        } else {
            delete imageTagsByHash[update.hash];
        }
        if (update.score !== null && update.score !== undefined) {
            imageScoresByHash[update.hash] = update.score;
        } else {
            delete imageScoresByHash[update.hash];
        }
        hasChanges = true;
    });
    pendingDirectoryMetadataUpdates.clear();

    if (hasChanges) {
        renderImages();
        renderTagFilter();
        updateImageCount();
        updateMigrateSourceFolder();
    }
}

function resetPendingDirectoryMetadataUpdates() {
    pendingDirectoryMetadataUpdates.clear();
    if (directoryMetadataRenderTimer) {
        clearTimeout(directoryMetadataRenderTimer);
        directoryMetadataRenderTimer = null;
    }
}

window.electronAPI.onDirectoryImageMetadata(queueDirectoryMetadataUpdates);

async function init() {
    await loadSavedSettings();
    renderInitialState();
}

async function loadSavedSettings() {
    const savedCategories = await window.electronAPI.getCategories();
    if (savedCategories && savedCategories.length > 0) {
        TAG_CATEGORIES = savedCategories;
    }
    
    allTags = await window.electronAPI.getTags() || [];
    await normalizeTags();

    const tagData = await window.electronAPI.getImageTags();
    imageTagsByHash = tagData.imageTagsByHash || {};
    pathToHash = tagData.pathToHash || {};
    imageScoresByHash = await window.electronAPI.getImageScores() || {};
    trashFolder = await window.electronAPI.getTrashFolder();
    serverDownloadFolder = await window.electronAPI.getServerDownloadFolder();
    serverDownloadConcurrency = await window.electronAPI.getServerDownloadConcurrency();
    quickOpenFolders = await loadQuickOpenFolders();
    recentOpenFiles = await loadRecentOpenFiles();
}

async function loadQuickOpenFolders() {
    const savedFolders = await window.electronAPI.getQuickOpenFolders();
    return Array.isArray(savedFolders)
        ? savedFolders
        : [...DEFAULT_QUICK_OPEN_FOLDERS];
}

async function loadRecentOpenFiles() {
    const savedFiles = await window.electronAPI.getRecentOpenFiles();
    return normalizeRecentOpenFiles(savedFiles);
}

async function normalizeTags() {
    let needsSave = ensureDefaultTagsInMemory();
    const usedShortcuts = new Set();

    allTags.forEach(tag => {
        if (!tag.color) {
            tag.color = generateRandomColor();
            needsSave = true;
        }
        if (!tag.category) {
            tag.category = 'other';
            needsSave = true;
        }
        const normalizedShortcut = normalizeShortcut(tag.shortcut);
        if ((tag.shortcut || '') !== normalizedShortcut) {
            tag.shortcut = normalizedShortcut;
            needsSave = true;
        }
        if (tag.shortcut) {
            if (getReservedShortcutLabel(tag.shortcut) || usedShortcuts.has(tag.shortcut)) {
                tag.shortcut = '';
                needsSave = true;
            } else {
                usedShortcuts.add(tag.shortcut);
            }
        }
    });
    if (needsSave) {
        await window.electronAPI.saveTags(allTags);
    }
}

function ensureDefaultTagsInMemory() {
    let needsSave = false;

    DEFAULT_TAGS.forEach(defaultTag => {
        const existingTag = allTags.find(tag => tag.name === defaultTag.name);
        if (!existingTag) {
            allTags.push({ ...defaultTag });
            needsSave = true;
            return;
        }

        if (!existingTag.color) {
            existingTag.color = defaultTag.color;
            needsSave = true;
        }
        if (!existingTag.category) {
            existingTag.category = defaultTag.category;
            needsSave = true;
        }
    });

    return needsSave;
}

async function ensureDefaultTags() {
    const needsSave = ensureDefaultTagsInMemory();
    if (needsSave) {
        await window.electronAPI.saveTags(allTags);
        renderTagFilter();
        updateCategorySelects();
    }
    return needsSave;
}

function renderInitialState() {
    initQuickOpenFolders();
    updateViewModeControls();
    updateOpenCurrentFolderButton();
    renderTagFilter();
    updateTrashFolderDisplay();
    updateServerDownloadFolderDisplay();
    updateServerDownloadConcurrencyDisplay();
    updateCategorySelects();
    updateCompetitionLauncherState();
}

function initQuickOpenFolders() {
    const groups = [];

    if (quickOpenFolders.length > 0) {
        groups.push(`
            <optgroup label="快捷目录">
                ${quickOpenFolders.map((folder) => (
                    `<option value="${escapeAttribute(folder.path)}" data-kind="folder" title="${escapeAttribute(folder.path)}">${escapeHtml(folder.name)}</option>`
                )).join('')}
            </optgroup>
        `);
    }

    if (recentOpenFiles.length > 0) {
        groups.push(`
            <optgroup label="最近文件">
                ${recentOpenFiles.map((file) => (
                    `<option value="${escapeAttribute(file.path)}" data-kind="file" data-folder-path="${escapeAttribute(file.folderPath)}" title="${escapeAttribute(file.path)}">${escapeHtml(getRecentOpenFileOptionLabel(file))}</option>`
                )).join('')}
            </optgroup>
        `);
    }

    quickFolderSelect.innerHTML = groups.join('');
}

async function openFolder() {
    const folderPath = await window.electronAPI.openFolderDialog();
    if (folderPath) {
        await loadFolder(folderPath);
    }
}

async function openQuickFolder() {
    const selectedOption = quickFolderSelect.selectedOptions[0];
    if (!selectedOption) return;

    if (selectedOption.dataset.kind === 'file') {
        await openRecentFile(selectedOption.value, selectedOption.dataset.folderPath);
        return;
    }

    const folderPath = selectedOption.value;
    if (!folderPath) return;
    const exists = await window.electronAPI.directoryExists(folderPath);
    if (!exists) {
        alert(`快捷路径不存在或未挂载：\n${folderPath}`);
        return;
    }

    await loadFolder(folderPath);
}

async function loadFolder(folderPath) {
    currentFolder = folderPath;
    resetWaterfallReviewSession();
    resetPendingDirectoryMetadataUpdates();
    isFolderLoading = true;
    try {
        images = await window.electronAPI.readDirectory(folderPath);
    } finally {
        isFolderLoading = false;
    }
    resetRandomSortOrder();
    duplicateGroups = [];
    duplicateScanCompleted = false;
    currentFolderEl.textContent = folderPath;
    currentFolderEl.title = folderPath;
    deleteHistory = [];
    updateOpenCurrentFolderButton();
    renderImages();
    updateImageCount();
    updateMigrateSourceFolder();
    renderTagFilter();
    renderDuplicateResults();
    updateCompetitionLauncherState();
    scheduleDirectoryMetadataRender();
}

async function openCurrentFolderInFinder() {
    if (!currentFolder) {
        alert('请先打开一个图片文件夹');
        return;
    }

    const result = await window.electronAPI.openFolderPath(currentFolder);
    if (!result.success) {
        alert('无法打开当前文件夹: ' + result.error);
    }
}

function updateOpenCurrentFolderButton() {
    const button = document.getElementById('openCurrentFolderBtn');
    if (button) {
        button.disabled = !currentFolder;
    }
}

async function loadImageFile(imageInfo) {
    if (!imageInfo || !imageInfo.filePath || !imageInfo.folderPath) return;

    selectedFilterTags = [];
    filterNoTag = false;
    closeModal();
    await loadFolder(imageInfo.folderPath);
    revealImageInList(imageInfo.filePath);
    await addRecentOpenFile(imageInfo.filePath, imageInfo.folderPath);
}

async function openRecentFile(filePath, folderPath) {
    if (!filePath) return;

    const exists = await window.electronAPI.fileExists(filePath);
    if (!exists) {
        alert(`最近打开的文件不存在或已移动：\n${filePath}`);
        await removeRecentOpenFile(filePath);
        return;
    }

    await loadImageFile({
        filePath,
        folderPath: folderPath || getParentFolder(filePath)
    });
}

async function addRecentOpenFile(filePath, folderPath = null) {
    if (!filePath) return;

    const normalizedFilePath = String(filePath);
    const record = {
        name: getFileDisplayName(normalizedFilePath),
        path: normalizedFilePath,
        folderPath: folderPath || getParentFolder(normalizedFilePath),
        openedAt: Date.now()
    };

    recentOpenFiles = [
        record,
        ...recentOpenFiles.filter(file => file.path !== normalizedFilePath)
    ].slice(0, RECENT_OPEN_FILE_LIMIT);

    await saveRecentOpenFiles();
}

async function removeRecentOpenFile(filePath) {
    const originalLength = recentOpenFiles.length;
    recentOpenFiles = recentOpenFiles.filter(file => file.path !== filePath);
    if (recentOpenFiles.length !== originalLength) {
        await saveRecentOpenFiles();
    }
}

async function clearRecentOpenFiles() {
    recentOpenFiles = [];
    await saveRecentOpenFiles();
}

async function saveRecentOpenFiles() {
    recentOpenFiles = normalizeRecentOpenFiles(recentOpenFiles);
    await window.electronAPI.saveRecentOpenFiles(recentOpenFiles);
    initQuickOpenFolders();
    renderRecentOpenFileList();
}

function normalizeRecentOpenFiles(files) {
    if (!Array.isArray(files)) return [];

    const seenPaths = new Set();
    return files
        .filter(file => file && typeof file.path === 'string' && file.path.trim())
        .map(file => {
            const filePath = file.path.trim();
            return {
                name: String(file.name || getFileDisplayName(filePath)),
                path: filePath,
                folderPath: String(file.folderPath || getParentFolder(filePath)),
                openedAt: Number(file.openedAt) || 0
            };
        })
        .filter(file => {
            if (seenPaths.has(file.path)) return false;
            seenPaths.add(file.path);
            return true;
        })
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, RECENT_OPEN_FILE_LIMIT);
}

function getRecentOpenFileOptionLabel(file) {
    const folderName = getFolderDisplayName(file.folderPath);
    return folderName ? `${file.name} - ${folderName}` : file.name;
}

function getFileDisplayName(filePath) {
    return String(filePath).split('/').filter(Boolean).pop() || filePath;
}

function getParentFolder(filePath) {
    const parts = String(filePath).split('/');
    parts.pop();
    return parts.join('/') || '/';
}

function revealImageInList(filePath) {
    const imageIndex = sortedImages.findIndex(img => img.path === filePath);
    if (imageIndex >= 0 && currentViewMode === 'grid') {
        if (!gridVirtualState) {
            gridVirtualState = calculateGridVirtualState(sortedImages.length);
        }
        const row = Math.floor(imageIndex / gridVirtualState.columns);
        imageGrid.scrollTop = Math.max(0, row * gridVirtualState.rowHeight - gridVirtualState.rowHeight);
        renderVisibleGridItems(galleryRenderVersion);
    }

    if (imageIndex >= 0 && currentViewMode === 'list') {
        if (!listVirtualState) {
            listVirtualState = calculateListVirtualState(sortedImages.length);
        }
        imageGrid.scrollTop = Math.max(0, imageIndex * listVirtualState.rowHeight - listVirtualState.rowHeight);
        renderVisibleListItems(galleryRenderVersion);
    }

    const imageItem = Array.from(imageGrid.querySelectorAll('.file-item'))
        .find(item => item.dataset.path === filePath);

    if (imageItem) {
        imageItem.classList.add('file-item-highlighted');
        imageItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function updateMigrateSourceFolder() {
    updateMigrateSourceDisplay();
    updateMigrateCounts();
    updateMigrateButtonState();
}

function updateMigrateSourceDisplay() {
    const sourceFolderEl = document.getElementById('migrateSourceFolder');
    if (!sourceFolderEl) return;

    sourceFolderEl.textContent = currentFolder || '未打开文件夹';
    sourceFolderEl.title = currentFolder || '';
}

function updateMigrateCounts() {
    const imageCountEl = document.getElementById('migrateImageCount');
    const taggedCountEl = document.getElementById('migrateTaggedCount');
    const taggedInfoEl = document.getElementById('migrateTaggedInfo');
    const taggedCount = images.filter(img => getImageTags(img).length > 0).length;

    if (imageCountEl) {
        imageCountEl.textContent = images.length + ' 张';
    }
    if (taggedCountEl) {
        taggedCountEl.textContent = taggedCount;
    }
    if (taggedInfoEl) {
        taggedInfoEl.style.display = taggedCount > 0 ? 'block' : 'none';
    }
}

function updateMigrateButtonState() {
    const migrateBtn = document.getElementById('migrateImagesBtn');
    if (migrateBtn) {
        migrateBtn.disabled = !currentFolder || !migrateTargetFolder;
    }
}

function getImageTags(img) {
    if (img.hash && imageTagsByHash[img.hash]) {
        return imageTagsByHash[img.hash];
    }
    return img.tags || [];
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function sortImages(imagesToSort) {
    const sorted = [...imagesToSort];
    if (currentSort === 'random') {
        ensureRandomSortRanks(sorted);
        sorted.sort((a, b) => {
            const comparison = randomSortRanks.get(a.path) - randomSortRanks.get(b.path);
            return comparison || a.name.localeCompare(b.name, 'zh-CN');
        });
        return sorted;
    }

    const [field, direction] = currentSort.split('-');
    
    sorted.sort((a, b) => {
        let comparison = 0;
        
        if (field === 'name') {
            comparison = a.name.localeCompare(b.name, 'zh-CN');
        } else if (field === 'size') {
            comparison = a.size - b.size;
        } else if (field === 'date') {
            comparison = new Date(a.modifiedTime) - new Date(b.modifiedTime);
        } else if (field === 'score') {
            comparison = getImageScore(a) - getImageScore(b);
        }
        
        return direction === 'desc' ? -comparison : comparison;
    });
    
    return sorted;
}

function resetRandomSortOrder() {
    randomSortRanks = new Map();
}

function ensureRandomSortRanks(imagesToSort) {
    const allImagePaths = new Set(images.map(img => img.path));
    randomSortRanks.forEach((rank, path) => {
        if (!allImagePaths.has(path)) {
            randomSortRanks.delete(path);
        }
    });

    imagesToSort.forEach(img => {
        if (!randomSortRanks.has(img.path)) {
            randomSortRanks.set(img.path, Math.random());
        }
    });
}
