let images = [];
let currentImageIndex = -1;
let allTags = [];
let imageTagsByHash = {};
let pathToHash = {};
let selectedFilterTags = [];
let filterNoTag = false;
let trashFolder = null;
let deleteHistory = [];
let currentFolder = '';

let isLocked = true;
let lockTimeout = 5;
let idleTimer = null;

const DEFAULT_CATEGORIES = [
    { id: 'person', name: '人物', icon: '👤' },
    { id: 'landscape', name: '风景', icon: '🏞️' },
    { id: 'object', name: '物品', icon: '📦' },
    { id: 'event', name: '事件', icon: '📅' },
    { id: 'emotion', name: '情感', icon: '❤️' },
    { id: 'style', name: '风格', icon: '🎨' },
    { id: 'other', name: '其他', icon: '📌' }
];

let TAG_CATEGORIES = [...DEFAULT_CATEGORIES];

function generateRandomColor() {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
        '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
        '#F8B500', '#FF8C00', '#00CED1', '#9370DB', '#20B2AA',
        '#FF69B4', '#00BFFF', '#32CD32', '#FFD700', '#FF6347',
        '#7B68EE', '#6495ED', '#DC143C', '#00FA9A', '#FF1493'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
}

function getCategoryById(categoryId) {
    return TAG_CATEGORIES.find(c => c.id === categoryId) || TAG_CATEGORIES.find(c => c.id === 'other') || TAG_CATEGORIES[TAG_CATEGORIES.length - 1];
}

function getTagsByCategory() {
    const grouped = {};
    TAG_CATEGORIES.forEach(cat => {
        grouped[cat.id] = [];
    });
    allTags.forEach(tag => {
        const catId = tag.category || 'other';
        if (grouped[catId]) {
            grouped[catId].push(tag);
        } else {
            if (grouped['other']) {
                grouped['other'].push(tag);
            }
        }
    });
    return grouped;
}

function generateCategoryId() {
    return 'cat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

const imageGrid = document.getElementById('imageGrid');
const tagFilter = document.getElementById('tagFilter');
const imageModal = document.getElementById('imageModal');
const settingsModal = document.getElementById('settingsModal');
const lockScreen = document.getElementById('lockScreen');
const currentFolderEl = document.getElementById('currentFolder');
const imageCountEl = document.getElementById('imageCount');

document.getElementById('openFolderBtn').addEventListener('click', openFolder);
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsClose').addEventListener('click', closeSettings);
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalPrev').addEventListener('click', showPrevImage);
document.getElementById('modalNext').addEventListener('click', showNextImage);
document.getElementById('addTagBtn').addEventListener('click', addNewTag);
document.getElementById('deleteBtn').addEventListener('click', deleteCurrentImage);
document.getElementById('quickAddTagBtn').addEventListener('click', quickAddTag);
document.getElementById('modalQuickAddTagBtn').addEventListener('click', modalQuickAddTag);
document.getElementById('showInFolderBtn').addEventListener('click', showCurrentImageInFolder);
document.getElementById('unlockBtn').addEventListener('click', handleUnlock);
document.getElementById('changePasswordBtn').addEventListener('click', handleChangePassword);

const addCategoryBtn = document.getElementById('addCategoryBtn');
if (addCategoryBtn) {
    addCategoryBtn.addEventListener('click', addNewCategory);
}

const newCategoryName = document.getElementById('newCategoryName');
if (newCategoryName) {
    newCategoryName.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addNewCategory();
    });
}

const emptyTrashBtn = document.getElementById('emptyTrashBtn');
if (emptyTrashBtn) {
    emptyTrashBtn.addEventListener('click', emptyTrash);
}

document.getElementById('passwordInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleUnlock();
});

document.getElementById('newTagInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addNewTag();
});

document.getElementById('quickTagInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') quickAddTag();
});

document.getElementById('modalQuickTagInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') modalQuickAddTag();
});

imageModal.querySelector('.modal-backdrop').addEventListener('click', closeModal);
settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettings);

document.addEventListener('keydown', handleKeyboard);
document.addEventListener('mousemove', resetIdleTimer);
document.addEventListener('click', resetIdleTimer);
document.addEventListener('scroll', resetIdleTimer);

window.electronAPI.onOpenFolder(async (folderPath) => {
    await loadFolder(folderPath);
});

window.electronAPI.onTrashFolderChanged((folderPath) => {
    trashFolder = folderPath;
    updateTrashFolderDisplay();
});

window.electronAPI.onUndoDelete(() => {
    undoLastDelete();
});

async function init() {
    lockTimeout = await window.electronAPI.getTimeout();
    
    const savedCategories = await window.electronAPI.getCategories();
    if (savedCategories && savedCategories.length > 0) {
        TAG_CATEGORIES = savedCategories;
    }
    
    allTags = await window.electronAPI.getTags() || [];
    
    let needsSave = false;
    allTags.forEach(tag => {
        if (!tag.color) {
            tag.color = generateRandomColor();
            needsSave = true;
        }
        if (!tag.category) {
            tag.category = 'other';
            needsSave = true;
        }
    });
    if (needsSave) {
        await window.electronAPI.saveTags(allTags);
    }
    
    const tagData = await window.electronAPI.getImageTags();
    imageTagsByHash = tagData.imageTagsByHash || {};
    pathToHash = tagData.pathToHash || {};
    trashFolder = await window.electronAPI.getTrashFolder();
    renderTagFilter();
    updateTrashFolderDisplay();
    updateCategorySelects();
    showLockScreen();
}

function showLockScreen() {
    isLocked = true;
    lockScreen.classList.add('show');
    document.getElementById('passwordInput').value = '';
    document.getElementById('passwordInput').focus();
}

function hideLockScreen() {
    isLocked = false;
    lockScreen.classList.remove('show');
    resetIdleTimer();
}

async function handleUnlock() {
    const passwordInput = document.getElementById('passwordInput');
    const password = passwordInput.value;
    const errorEl = document.getElementById('passwordError');
    
    const isValid = await window.electronAPI.verifyPassword(password);
    
    if (isValid) {
        errorEl.style.display = 'none';
        passwordInput.value = '';
        hideLockScreen();
    } else {
        errorEl.style.display = 'block';
        passwordInput.value = '';
        passwordInput.focus();
    }
}

function resetIdleTimer() {
    if (isLocked) return;
    
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
    
    idleTimer = setTimeout(() => {
        showLockScreen();
    }, lockTimeout * 60 * 1000);
}

async function handleChangePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const errorEl = document.getElementById('passwordChangeError');
    
    if (!currentPassword || !newPassword || !confirmPassword) {
        errorEl.textContent = '请填写所有字段';
        errorEl.style.display = 'block';
        return;
    }
    
    const isValid = await window.electronAPI.verifyPassword(currentPassword);
    
    if (!isValid) {
        errorEl.textContent = '当前密码错误';
        errorEl.style.display = 'block';
        return;
    }
    
    if (newPassword !== confirmPassword) {
        errorEl.textContent = '两次输入的新密码不一致';
        errorEl.style.display = 'block';
        return;
    }
    
    if (newPassword.length < 6) {
        errorEl.textContent = '新密码长度至少6位';
        errorEl.style.display = 'block';
        return;
    }
    
    await window.electronAPI.setPassword(newPassword);
    
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    errorEl.style.display = 'none';
    
    alert('密码修改成功');
}

async function openFolder() {
    const folderPath = await window.electronAPI.openFolderDialog();
    if (folderPath) {
        await loadFolder(folderPath);
    }
}

async function loadFolder(folderPath) {
    currentFolder = folderPath;
    images = await window.electronAPI.readDirectory(folderPath);
    currentFolderEl.textContent = folderPath;
    deleteHistory = [];
    renderImages();
    updateImageCount();
}

function getImageTags(img) {
    if (img.hash && imageTagsByHash[img.hash]) {
        return imageTagsByHash[img.hash];
    }
    return [];
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderImages() {
    const filteredImages = getFilteredImages();
    
    if (filteredImages.length === 0) {
        if (images.length === 0) {
            imageGrid.innerHTML = `
                <div class="empty-state">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <circle cx="8.5" cy="8.5" r="1.5"></circle>
                        <polyline points="21 15 16 10 5 21"></polyline>
                    </svg>
                    <p>此文件夹中没有图片</p>
                </div>
            `;
        } else {
            imageGrid.innerHTML = `
                <div class="empty-state">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <p>没有匹配所选标签的图片</p>
                </div>
            `;
        }
        return;
    }

    imageGrid.innerHTML = filteredImages.map((img) => {
        const tags = getImageTags(img);
        const tagsHtml = tags.map(tag => {
            const tagInfo = allTags.find(t => t.name === tag);
            const color = tagInfo ? tagInfo.color : '#666';
            return `<span class="file-tag" style="background: ${color}">${tag}</span>`;
        }).join('');

        return `
            <div class="file-item" data-index="${images.indexOf(img)}" data-path="${img.path}">
                <span class="file-name">${img.name}</span>
                <span class="file-size">${formatFileSize(img.size)}</span>
                <div class="file-tags">${tagsHtml}</div>
            </div>
        `;
    }).join('');

    document.querySelectorAll('.file-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            openImageModal(index);
        });
    });
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
}

function renderTagFilter() {
    let html = '';
    
    html += `
        <div class="filter-tag no-tag-filter ${filterNoTag ? 'active' : ''}" 
             style="background: rgba(102, 102, 102, 0.125); color: #666"
             data-tag="__no_tag__">
            <span class="tag-color" style="background: #666"></span>
            无标签
        </div>
    `;
    
    if (allTags.length === 0) {
        tagFilter.innerHTML = html;
    } else {
        const groupedTags = getTagsByCategory();
        
        TAG_CATEGORIES.forEach(category => {
            const tags = groupedTags[category.id];
            if (tags.length > 0) {
                html += `
                    <div class="tag-category">
                        <div class="tag-category-header">
                            <span class="tag-category-icon">${category.icon}</span>
                            <span class="tag-category-name">${category.name}</span>
                        </div>
                        <div class="tag-category-tags">
                            ${tags.map(tag => `
                                <div class="filter-tag ${selectedFilterTags.includes(tag.name) ? 'active' : ''}" 
                                     style="background: ${tag.color}20; color: ${tag.color}"
                                     data-tag="${tag.name}">
                                    <span class="tag-color" style="background: ${tag.color}"></span>
                                    ${tag.name}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            }
        });
        
        tagFilter.innerHTML = html;
    }

    document.querySelectorAll('.filter-tag').forEach(tagEl => {
        tagEl.addEventListener('click', () => {
            const tagName = tagEl.dataset.tag;
            toggleFilterTag(tagName);
        });
    });
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

function openImageModal(index) {
    currentImageIndex = index;
    updateModalImage();
    imageModal.classList.add('show');
}

function closeModal() {
    imageModal.classList.remove('show');
    currentImageIndex = -1;
}

function updateModalImage() {
    if (currentImageIndex < 0 || currentImageIndex >= images.length) return;
    
    const img = images[currentImageIndex];
    document.getElementById('modalImage').src = `file://${img.path}`;
    document.getElementById('modalFilename').textContent = img.name;
    document.getElementById('modalImageIndex').textContent = `${currentImageIndex + 1} / ${images.length}`;
    
    renderModalTagList(img);
}

function renderModalTagList(img) {
    const tagList = document.getElementById('modalTagList');
    const currentTags = getImageTags(img);
    
    if (allTags.length === 0) {
        tagList.innerHTML = '<div class="empty-state">请先添加标签</div>';
        return;
    }

    const groupedTags = getTagsByCategory();
    let html = '';
    
    TAG_CATEGORIES.forEach(category => {
        const tags = groupedTags[category.id];
        if (tags.length > 0) {
            html += `
                <div class="modal-tag-category">
                    <div class="modal-tag-category-header">
                        <span>${category.icon}</span>
                        <span>${category.name}</span>
                    </div>
                    ${tags.map(tag => {
                        const isSelected = currentTags.includes(tag.name);
                        return `
                            <div class="modal-tag-item ${isSelected ? 'selected' : ''}" data-tag="${tag.name}" data-path="${img.path}">
                                <div class="modal-tag-checkbox">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                        <polyline points="20 6 9 17 4 12"></polyline>
                                    </svg>
                                </div>
                                <span class="modal-tag-color" style="background: ${tag.color}"></span>
                                <span class="modal-tag-name">${tag.name}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }
    });
    
    tagList.innerHTML = html;

    tagList.querySelectorAll('.modal-tag-item').forEach(item => {
        item.addEventListener('click', async () => {
            const tagName = item.dataset.tag;
            const path = item.dataset.path;
            const currentTags = getImageTags(images.find(i => i.path === path));
            
            if (currentTags.includes(tagName)) {
                await removeTagFromImage(path, tagName);
            } else {
                await addTagToImage(path, tagName);
            }
            
            const updatedImg = images.find(i => i.path === path);
            if (updatedImg && updatedImg.hash) {
                updatedImg.tags = imageTagsByHash[updatedImg.hash] || [];
            }
            
            renderModalTagList(updatedImg);
            renderImages();
        });
    });
}

function showPrevImage() {
    if (currentImageIndex > 0) {
        currentImageIndex--;
        updateModalImage();
    }
}

function showNextImage() {
    if (currentImageIndex < images.length - 1) {
        currentImageIndex++;
        updateModalImage();
    }
}

function showCurrentImageInFolder() {
    if (currentImageIndex < 0 || currentImageIndex >= images.length) return;
    const img = images[currentImageIndex];
    window.electronAPI.showInFolder(img.path);
}

async function deleteCurrentImage() {
    if (currentImageIndex < 0 || currentImageIndex >= images.length) return;
    
    if (!trashFolder) {
        alert('请先设置回收站文件夹\n\n菜单: 文件 > 设置回收站文件夹');
        return;
    }

    const img = images[currentImageIndex];
    
    const result = await window.electronAPI.deleteImage(img.path);
    
    if (result.success) {
        deleteHistory.push({
            originalPath: result.originalPath,
            trashPath: result.trashPath,
            fileName: result.fileName,
            index: currentImageIndex,
            hash: img.hash
        });

        images = images.filter(i => i.path !== img.path);
        
        if (images.length === 0) {
            closeModal();
        } else {
            if (currentImageIndex >= images.length) {
                currentImageIndex = images.length - 1;
            }
            updateModalImage();
        }
        
        renderImages();
        updateImageCount();
    } else {
        alert('删除失败: ' + result.error);
    }
}

async function undoLastDelete() {
    if (deleteHistory.length === 0) {
        return;
    }

    const lastDelete = deleteHistory.pop();
    
    const result = await window.electronAPI.undoDeleteImage(lastDelete.trashPath, lastDelete.originalPath);
    
    if (result.success) {
        const stats = {
            name: lastDelete.fileName,
            path: result.restoredPath,
            size: 0,
            modifiedTime: new Date(),
            hash: lastDelete.hash,
            tags: lastDelete.hash ? (imageTagsByHash[lastDelete.hash] || []) : []
        };
        
        images.splice(lastDelete.index, 0, stats);
        
        renderImages();
        updateImageCount();
    } else {
        alert('撤销失败: ' + result.error);
        deleteHistory.push(lastDelete);
    }
}

function handleKeyboard(e) {
    if (isLocked) {
        if (e.key === 'Enter') handleUnlock();
        return;
    }
    
    if (imageModal.classList.contains('show')) {
        if (e.key === 'ArrowLeft') showPrevImage();
        else if (e.key === 'ArrowRight') showNextImage();
        else if (e.key === 'Escape') closeModal();
        else if (e.key === 'Delete') {
            e.preventDefault();
            deleteCurrentImage();
        }
    } else if (settingsModal.classList.contains('show')) {
        if (e.key === 'Escape') closeSettings();
    }
}

function openSettings() {
    renderTagList();
    renderCategoryList();
    updateTrashFolderDisplay();
    updateTimeoutDisplay();
    settingsModal.classList.add('show');
}

function closeSettings() {
    settingsModal.classList.remove('show');
}

function renderCategoryList() {
    const categoryList = document.getElementById('categoryList');
    if (!categoryList) return;
    
    categoryList.innerHTML = TAG_CATEGORIES.map(category => `
        <div class="category-item" data-id="${category.id}">
            <div class="category-item-info">
                <span class="category-icon">${category.icon}</span>
                <span class="category-name">${category.name}</span>
            </div>
            <div class="category-item-actions">
                <button class="edit-category-btn" data-id="${category.id}">编辑</button>
                <button class="delete-category-btn" data-id="${category.id}" ${category.id === 'other' ? 'disabled' : ''}>删除</button>
            </div>
        </div>
    `).join('');
    
    categoryList.querySelectorAll('.edit-category-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const categoryId = btn.dataset.id;
            editCategory(categoryId);
        });
    });
    
    categoryList.querySelectorAll('.delete-category-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const categoryId = btn.dataset.id;
            await deleteCategory(categoryId);
        });
    });
}

async function addNewCategory() {
    const nameInput = document.getElementById('newCategoryName');
    const iconSelect = document.getElementById('newCategoryIcon');
    
    const name = nameInput.value.trim();
    const icon = iconSelect ? iconSelect.value : '📌';
    
    if (!name) return;
    
    if (TAG_CATEGORIES.find(c => c.name === name)) {
        alert('分类名称已存在');
        return;
    }
    
    const newCategory = {
        id: generateCategoryId(),
        name: name,
        icon: icon
    };
    
    TAG_CATEGORIES.push(newCategory);
    await window.electronAPI.saveCategories(TAG_CATEGORIES);
    
    nameInput.value = '';
    if (iconSelect) iconSelect.value = '📌';
    
    renderCategoryList();
    updateCategorySelects();
}

function editCategory(categoryId) {
    const category = TAG_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return;
    
    const nameInput = document.getElementById('newCategoryName');
    const iconSelect = document.getElementById('newCategoryIcon');
    
    nameInput.value = category.name;
    if (iconSelect) iconSelect.value = category.icon;
    
    TAG_CATEGORIES = TAG_CATEGORIES.filter(c => c.id !== categoryId);
    window.electronAPI.saveCategories(TAG_CATEGORIES);
    
    renderCategoryList();
    updateCategorySelects();
    nameInput.focus();
}

async function deleteCategory(categoryId) {
    if (categoryId === 'other') return;
    
    const category = TAG_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return;
    
    if (!confirm(`确定要删除分类 "${category.name}" 吗？该分类下的标签将移至"其他"分类。`)) return;
    
    allTags.forEach(tag => {
        if (tag.category === categoryId) {
            tag.category = 'other';
        }
    });
    await window.electronAPI.saveTags(allTags);
    
    TAG_CATEGORIES = TAG_CATEGORIES.filter(c => c.id !== categoryId);
    await window.electronAPI.saveCategories(TAG_CATEGORIES);
    
    renderCategoryList();
    updateCategorySelects();
    renderTagList();
    renderTagFilter();
}

function updateCategorySelects() {
    const selects = document.querySelectorAll('.tag-category-select');
    selects.forEach(select => {
        const currentValue = select.value;
        select.innerHTML = TAG_CATEGORIES.map(cat => 
            `<option value="${cat.id}">${cat.icon} ${cat.name}</option>`
        ).join('');
        
        if (TAG_CATEGORIES.find(c => c.id === currentValue)) {
            select.value = currentValue;
        } else {
            select.value = 'other';
        }
    });
}

function updateTrashFolderDisplay() {
    const trashFolderDisplay = document.getElementById('trashFolderDisplay');
    if (trashFolderDisplay) {
        if (trashFolder) {
            trashFolderDisplay.innerHTML = `
                <span class="trash-path">${trashFolder}</span>
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

function updateTimeoutDisplay() {
    const timeoutSelect = document.getElementById('lockTimeoutSelect');
    if (timeoutSelect) {
        timeoutSelect.value = lockTimeout.toString();
        timeoutSelect.addEventListener('change', async () => {
            lockTimeout = parseInt(timeoutSelect.value);
            await window.electronAPI.setTimeout(lockTimeout);
            resetIdleTimer();
        });
    }
}

async function selectTrashFolder() {
    const folderPath = await window.electronAPI.openTrashFolderDialog();
    if (folderPath) {
        trashFolder = folderPath;
        updateTrashFolderDisplay();
    }
}

function renderTagList() {
    const tagList = document.getElementById('tagList');
    
    if (allTags.length === 0) {
        tagList.innerHTML = '<div class="empty-state">暂无标签</div>';
        return;
    }

    const groupedTags = getTagsByCategory();
    let html = '';
    
    TAG_CATEGORIES.forEach(category => {
        const tags = groupedTags[category.id];
        if (tags.length > 0) {
            html += `
                <div class="tag-list-category">
                    <div class="tag-list-category-header">
                        <span>${category.icon}</span>
                        <span>${category.name}</span>
                    </div>
                    ${tags.map(tag => `
                        <div class="tag-item" data-tag="${tag.name}">
                            <div class="tag-item-info">
                                <span class="tag-color" style="background: ${tag.color}"></span>
                                <span class="tag-name">${tag.name}</span>
                            </div>
                            <div class="tag-item-actions">
                                <button class="edit-tag-btn" data-tag="${tag.name}">编辑</button>
                                <button class="delete-tag-btn" data-tag="${tag.name}">删除</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
    });
    
    tagList.innerHTML = html;

    tagList.querySelectorAll('.delete-tag-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tagName = btn.dataset.tag;
            await deleteTag(tagName);
        });
    });

    tagList.querySelectorAll('.edit-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tagName = btn.dataset.tag;
            editTag(tagName);
        });
    });
}

async function addNewTag() {
    const nameInput = document.getElementById('newTagInput');
    const categorySelect = document.getElementById('newTagCategory');
    
    const name = nameInput.value.trim();
    
    if (!name) return;
    
    if (allTags.find(t => t.name === name)) {
        alert('标签名称已存在');
        return;
    }

    const color = generateRandomColor();
    const category = categorySelect ? categorySelect.value : 'other';
    allTags.push({ name, color, category });
    await window.electronAPI.saveTags(allTags);
    
    nameInput.value = '';
    if (categorySelect) categorySelect.value = 'other';
    renderTagList();
    renderTagFilter();
}

async function quickAddTag() {
    const nameInput = document.getElementById('quickTagInput');
    const categorySelect = document.getElementById('quickTagCategory');
    
    const name = nameInput.value.trim();
    
    if (!name) return;
    
    if (allTags.find(t => t.name === name)) {
        nameInput.value = '';
        return;
    }

    const color = generateRandomColor();
    const category = categorySelect ? categorySelect.value : 'other';
    allTags.push({ name, color, category });
    await window.electronAPI.saveTags(allTags);
    
    nameInput.value = '';
    if (categorySelect) categorySelect.value = 'other';
    renderTagFilter();
    
    if (settingsModal.classList.contains('show')) {
        renderTagList();
    }
}

async function modalQuickAddTag() {
    const nameInput = document.getElementById('modalQuickTagInput');
    const categorySelect = document.getElementById('modalQuickTagCategory');
    
    const name = nameInput.value.trim();
    
    if (!name) return;
    
    let isNewTag = !allTags.find(t => t.name === name);
    
    if (isNewTag) {
        const color = generateRandomColor();
        const category = categorySelect ? categorySelect.value : 'other';
        allTags.push({ name, color, category });
        await window.electronAPI.saveTags(allTags);
        renderTagFilter();
    }
    
    if (currentImageIndex >= 0 && currentImageIndex < images.length) {
        const img = images[currentImageIndex];
        const currentTags = getImageTags(img);
        
        if (!currentTags.includes(name)) {
            await addTagToImage(img.path, name);
        }
        
        if (img.hash) {
            img.tags = imageTagsByHash[img.hash] || [];
        }
        
        renderModalTagList(img);
        renderImages();
    }
    
    nameInput.value = '';
    if (categorySelect) categorySelect.value = 'other';
}

async function deleteTag(tagName) {
    if (!confirm(`确定要删除标签 "${tagName}" 吗？`)) return;
    
    allTags = allTags.filter(t => t.name !== tagName);
    await window.electronAPI.saveTags(allTags);
    
    for (const hash in imageTagsByHash) {
        imageTagsByHash[hash] = imageTagsByHash[hash].filter(t => t !== tagName);
        if (imageTagsByHash[hash].length === 0) {
            delete imageTagsByHash[hash];
        }
    }
    await window.electronAPI.saveImageTags({ imageTagsByHash, pathToHash });
    
    selectedFilterTags = selectedFilterTags.filter(t => t !== tagName);
    
    renderTagList();
    renderTagFilter();
    renderImages();
}

function editTag(tagName) {
    const tag = allTags.find(t => t.name === tagName);
    if (!tag) return;
    
    const nameInput = document.getElementById('newTagInput');
    const categorySelect = document.getElementById('newTagCategory');
    
    nameInput.value = tag.name;
    if (categorySelect) {
        categorySelect.value = tag.category || 'other';
    }
    
    allTags = allTags.filter(t => t.name !== tagName);
    window.electronAPI.saveTags(allTags);
    
    renderTagList();
    nameInput.focus();
}

async function addTagToImage(imagePath, tagName) {
    const tags = await window.electronAPI.addTagToImage(imagePath, tagName);
    const img = images.find(i => i.path === imagePath);
    if (img && img.hash) {
        imageTagsByHash[img.hash] = tags;
    }
    return tags;
}

async function removeTagFromImage(imagePath, tagName) {
    const tags = await window.electronAPI.removeTagFromImage(imagePath, tagName);
    const img = images.find(i => i.path === imagePath);
    if (img && img.hash) {
        if (tags.length === 0) {
            delete imageTagsByHash[img.hash];
        } else {
            imageTagsByHash[img.hash] = tags;
        }
    }
    return tags;
}

init();
