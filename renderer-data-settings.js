function updateTrashFolderDisplay() {
    const trashFolderDisplay = document.getElementById('trashFolderDisplay');
    if (trashFolderDisplay) {
        if (trashFolder) {
            trashFolderDisplay.innerHTML = `
                <span class="trash-path">${escapeHtml(trashFolder)}</span>
                <button id="changeTrashBtn" class="small-btn">更改</button>
            `;
            document.getElementById('changeTrashBtn').addEventListener('click', selectTrashFolder);
        } else {
            trashFolderDisplay.innerHTML = `
                <span class="no-trash">未设置</span>
                <button id="setTrashBtn" class="small-btn">设置</button>
            `;
            document.getElementById('setTrashBtn').addEventListener('click', selectTrashFolder);
        }
    }
    updateTrashInfo();
}

async function updateTrashInfo() {
    const trashInfoEl = document.getElementById('trashInfo');
    const emptyTrashBtn = document.getElementById('emptyTrashBtn');
    
    if (!trashInfoEl) return;
    
    const info = await window.electronAPI.getTrashInfo();
    
    if (info.path) {
        const sizeStr = formatFileSize(info.size);
        trashInfoEl.innerHTML = `
            <span class="trash-stats">共 ${info.count} 张图片，占用 ${sizeStr}</span>
        `;
        if (emptyTrashBtn) {
            emptyTrashBtn.disabled = info.count === 0;
        }
    } else {
        trashInfoEl.innerHTML = '<span class="trash-stats">未设置回收站</span>';
        if (emptyTrashBtn) {
            emptyTrashBtn.disabled = true;
        }
    }
}

async function emptyTrash() {
    const info = await window.electronAPI.getTrashInfo();
    
    if (info.count === 0) {
        alert('回收站中没有图片');
        return;
    }
    
    if (!confirm(`确定要清空回收站吗？\n\n将永久删除 ${info.count} 张图片，此操作不可撤销。`)) {
        return;
    }
    
    const result = await window.electronAPI.emptyTrash();
    
    if (result.success) {
        alert(`已清空回收站，共删除 ${result.deletedCount} 张图片`);
        updateTrashInfo();
    } else {
        alert('清空回收站失败: ' + result.error);
    }
}

async function exportConfig() {
    const result = await window.electronAPI.exportConfig();
    
    if (!result.success) {
        alert('导出配置失败: ' + result.error);
        return;
    }
    
    const saveResult = await window.electronAPI.saveExportFile(result.config);
    
    if (saveResult.success) {
        alert('配置已成功导出');
    } else if (!saveResult.cancelled) {
        alert('保存文件失败: ' + saveResult.error);
    }
}

async function importConfig() {
    const result = await window.electronAPI.openImportFile();
    
    if (!result.success) {
        if (!result.cancelled) {
            alert('打开文件失败: ' + result.error);
        }
        return;
    }
    
    const config = result.config;
    
    if (!isValidImportConfig(config)) {
        alert('无效的配置文件');
        return;
    }
    
    if (!confirm(buildImportConfigMessage(config))) {
        return;
    }
    
    const importResult = await window.electronAPI.importConfig(config);
    
    if (importResult.success) {
        applyImportedConfig(config);
        alert('配置已成功导入');
    } else {
        alert('导入配置失败: ' + importResult.error);
    }
}

function isValidImportConfig(config) {
    return Boolean(config && (
        Array.isArray(config.tags) ||
        Array.isArray(config.categories) ||
        (config.imageScoresByHash && typeof config.imageScoresByHash === 'object')
    ));
}

function buildImportConfigMessage(config) {
    const lines = ['确定要导入配置吗？', ''];

    if (config.tags) {
        lines.push(`将导入 ${config.tags.length} 个标签`);
    }
    if (config.categories) {
        lines.push(`将导入 ${config.categories.length} 个分类`);
    }
    if (config.imageScoresByHash) {
        lines.push(`将导入 ${Object.keys(config.imageScoresByHash).length} 条竞赛分数`);
    }

    lines.push('', '注意：这将覆盖当前配置中对应的数据！');
    return lines.join('\n');
}

function applyImportedConfig(config) {
    if (config.categories) {
        TAG_CATEGORIES = config.categories;
    }
    if (config.tags) {
        allTags = config.tags;
    }
    if (config.imageScoresByHash) {
        imageScoresByHash = config.imageScoresByHash;
        images.forEach(img => {
            img.score = getImageScore(img);
        });
    }

    renderTagList();
    renderCategoryList();
    renderTagFilter();
    renderImages();
    updateCategorySelects();
}

const DEFAULT_MIGRATE_TARGET_FOLDER = '/Volumes/T7Shield/backup/base';
let migrateTargetFolder = DEFAULT_MIGRATE_TARGET_FOLDER;
let serverDownloadFolder = '';
let serverDownloadConcurrency = 5;

function updateServerDownloadFolderDisplay() {
    const display = document.getElementById('serverDownloadFolderDisplay');
    if (!display) return;

    display.textContent = serverDownloadFolder || '未设置';
    display.title = serverDownloadFolder || '';
}

async function selectServerDownloadFolder() {
    const result = await window.electronAPI.selectServerDownloadFolder();
    if (!result.success) return;

    serverDownloadFolder = result.path;
    updateServerDownloadFolderDisplay();
}

function updateServerDownloadConcurrencyDisplay() {
    const input = document.getElementById('serverDownloadConcurrencyInput');
    if (input) input.value = serverDownloadConcurrency;
}

async function saveServerDownloadConcurrency() {
    const input = document.getElementById('serverDownloadConcurrencyInput');
    const value = Number(input?.value);
    const result = await window.electronAPI.setServerDownloadConcurrency(value);
    if (!result.success) {
        alert(result.error);
        updateServerDownloadConcurrencyDisplay();
        return;
    }

    serverDownloadConcurrency = result.value;
    updateServerDownloadConcurrencyDisplay();
}

function updateMigrateTargetDisplay() {
    const display = document.getElementById('migrateFolderDisplay');
    if (display) {
        display.textContent = migrateTargetFolder || '未选择';
        display.title = migrateTargetFolder || '';
    }

    const migrateBtn = document.getElementById('migrateImagesBtn');
    if (migrateBtn) {
        migrateBtn.disabled = !currentFolder || !migrateTargetFolder;
    }
}

async function selectMigrateFolder() {
    const result = await window.electronAPI.selectMigrateFolder();
    
    if (result.success) {
        migrateTargetFolder = result.path;
        updateMigrateTargetDisplay();
    }
}

updateMigrateTargetDisplay();

async function migrateImages() {
    const validationError = getMigrationValidationError();
    if (validationError) {
        alert(validationError);
        return;
    }
    
    const taggedOnly = isMigrateTaggedOnly();
    const imagesToMigrate = getImagesToMigrate(taggedOnly);

    if (!confirmMigration(imagesToMigrate, taggedOnly)) {
        return;
    }
    
    setMigrationBusy(true);
    const filePaths = imagesToMigrate.map(img => img.path);
    const result = await window.electronAPI.migrateImages(filePaths, migrateTargetFolder);
    setMigrationBusy(false);
    handleMigrationResult(result);
}

async function moveNewlyTaggedImageToTarget(imagePath) {
    if (!migrateTargetFolder) {
        return false;
    }

    const result = await window.electronAPI.moveTaggedImageToTarget(imagePath, migrateTargetFolder);
    if (!result.success) {
        alert(`图片已打标签，但移动到目标文件夹失败：${result.error}`);
        return false;
    }
    if (!result.moved) {
        return false;
    }

    const nextImageIndex = currentImageIndex;
    images = images.filter(image => image.path !== imagePath);
    renderImages();
    updateImageCount();
    updateMigrateSourceFolder();

    if (sortedImages.length === 0) {
        closeModal();
        return true;
    }

    currentImageIndex = Math.min(Math.max(nextImageIndex, 0), sortedImages.length - 1);
    resetImageTransform();
    updateModalImage();
    updateZoomDisplay();
    updateImageCursor();
    recordCurrentImageOpen();
    imageModal.classList.add('show');
    return true;
}

function getMigrationValidationError() {
    if (!currentFolder) return '请先打开一个图片文件夹';
    if (!migrateTargetFolder) return '请先选择目标文件夹';
    if (currentFolder === migrateTargetFolder) return '源文件夹和目标文件夹不能相同';
    return null;
}

function isMigrateTaggedOnly() {
    const taggedOnlyCheckbox = document.getElementById('migrateTaggedOnly');
    return taggedOnlyCheckbox ? taggedOnlyCheckbox.checked : false;
}

function getImagesToMigrate(taggedOnly) {
    if (!taggedOnly) return images;
    return images.filter(img => getImageTags(img).length > 0);
}

function confirmMigration(imagesToMigrate, taggedOnly) {
    const imageCount = imagesToMigrate.length;
    if (imageCount === 0) {
        alert(taggedOnly ? '当前文件夹中没有已打标签的图片' : '当前文件夹中没有图片');
        return false;
    }

    const subject = taggedOnly ? `${imageCount} 张已打标签的图片` : `${imageCount} 张图片`;
    return confirm(`确定要将 ${subject} 迁移到以下目录吗？\n\n${migrateTargetFolder}\n\n此操作将移动原始文件，不可撤销。`);
}

function setMigrationBusy(isBusy) {
    const migrateBtn = document.getElementById('migrateImagesBtn');
    if (!migrateBtn) return;

    migrateBtn.disabled = isBusy;
    migrateBtn.textContent = isBusy ? '迁移中...' : '开始迁移';
}

function handleMigrationResult(result) {
    if (!result.success) {
        alert('迁移失败: ' + result.error);
        return;
    }

    let message = `迁移完成！\n\n成功迁移: ${result.movedCount} 张图片`;
    if (result.skippedCount > 0) {
        message += `\n跳过: ${result.skippedCount} 张图片`;
    }
    alert(message);

    const movedPaths = Array.isArray(result.moved)
        ? result.moved
            .map(item => item?.originalPath)
            .filter(Boolean)
        : [];
    images = images.filter(img => !movedPaths.includes(img.path));
    renderImages();
    updateImageCount();
    updateMigrateSourceFolder();
}

async function selectTrashFolder() {
    const folderPath = await window.electronAPI.openTrashFolderDialog();
    if (folderPath) {
        trashFolder = folderPath;
        updateTrashFolderDisplay();
    }
}
