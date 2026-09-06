let isFolderLoading = false;
let directoryLoadVersion = 0;
let pendingDirectoryMetadataUpdates = new Map();
let directoryMetadataRenderTimer = null;

function queueDirectoryMetadataUpdates(data) {
    if (!data || data.dirPath !== currentFolder || !Array.isArray(data.updates)) return;
    if (data.requestId !== undefined && data.requestId !== directoryLoadVersion) return;

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

    const hasChanges = imageCollection.applyMetadata(
        [...pendingDirectoryMetadataUpdates.values()].filter(update => update?.hash)
    ) > 0;
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
    const [savedCategories, savedTags] = await Promise.all([
        window.electronAPI.getCategories(),
        window.electronAPI.getTags()
    ]);
    const normalized = tagCatalog.load({
        categories: savedCategories,
        tags: savedTags
    });
    if (normalized.categoriesChanged) {
        await window.electronAPI.saveCategories(TAG_CATEGORIES);
    }
    if (normalized.tagsChanged) {
        await window.electronAPI.saveTags(allTags);
    }

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

async function ensureDefaultTags() {
    const normalized = tagCatalog.ensureDefaults();
    if (normalized.tagsChanged) {
        await window.electronAPI.saveTags(allTags);
        renderTagFilter();
        updateCategorySelects();
    }
    if (normalized.categoriesChanged) {
        await window.electronAPI.saveCategories(TAG_CATEGORIES);
        updateCategorySelects();
    }
    return normalized.tagsChanged || normalized.categoriesChanged;
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

async function loadFolder(folderPath, options = {}) {
    const version = ++directoryLoadVersion;
    currentFolder = folderPath;
    closeModal();
    resetPendingDirectoryMetadataUpdates();
    isFolderLoading = true;
    imageCollection.replace([]);
    sortedImages = [];
    currentFolderEl.textContent = folderPath;
    currentFolderEl.title = folderPath;
    renderEmptyImageGrid();
    try {
        await waitForWaterfallOperations();
        if (version !== directoryLoadVersion) return false;
        const [folderImages, pendingPages] = await Promise.all([
            window.electronAPI.readDirectory(folderPath, version),
            window.electronAPI.getWaterfallPendingPages()
        ]);
        if (version !== directoryLoadVersion) return false;
        const pendingPathSet = new Set(pendingPages.flatMap(page => page.paths));
        resetWaterfallReviewSession(folderImages, pendingPages);
        imageCollection.replace(folderImages.filter(img => !pendingPathSet.has(img.path)));
    } catch (error) {
        if (version !== directoryLoadVersion) return false;
        throw error;
    } finally {
        if (version === directoryLoadVersion) isFolderLoading = false;
    }
    resetRandomSortOrder();
    duplicateGroups = [];
    duplicateScanCompleted = false;
    smallImageCandidates = [];
    smallImageScanCompleted = false;
    currentFolderEl.textContent = folderPath;
    currentFolderEl.title = folderPath;
    if (!options.preserveDeleteHistory) {
        deleteHistory = [];
    }
    updateOpenCurrentFolderButton();
    refreshAfterImageMembershipChange();
    scheduleDirectoryMetadataRender();
    return true;
}

function refreshAfterImageMembershipChange() {
    if (duplicateScanCompleted) {
        const activePaths = new Set(images.map(image => image.path));
        const removedPaths = duplicateGroups
            .flatMap(group => group.images)
            .map(image => image.path)
            .filter(imagePath => !activePaths.has(imagePath));
        duplicateGroups = removePathsFromDuplicateGroups(removedPaths);
    }
    renderImages();
    updateImageCount();
    updateMigrateSourceFolder();
    renderTagFilter();
    renderDuplicateResults();
    if (typeof renderSmallImageResults === 'function') {
        renderSmallImageResults();
    }
    updateCompetitionLauncherState();
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
    if (!await loadFolder(imageInfo.folderPath)) return;
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
    return imageCollection.getTags(img);
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
