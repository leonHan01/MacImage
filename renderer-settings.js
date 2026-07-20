function openSettings() {
    renderTagList();
    renderCategoryList();
    renderQuickOpenList();
    renderRecentOpenFileList();
    renderCompetitionSettings();
    renderDuplicateResults();
    updateTrashFolderDisplay();
    initSettingsNav();
    settingsModal.classList.add('show');
}

function closeSettings() {
    settingsModal.classList.remove('show');
}

function initSettingsNav() {
    if (settingsNavInitialized) return;

    const settingsSidebar = settingsModal.querySelector('.settings-sidebar');
    settingsSidebar.addEventListener('click', (event) => {
        const item = event.target.closest('.settings-nav-item');
        if (!item) return;

        switchSettingsSection(item.dataset.section);
    });

    settingsNavInitialized = true;
}

function switchSettingsSection(section) {
    document.querySelectorAll('.settings-nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.section === section) {
            item.classList.add('active');
        }
    });
    
    document.querySelectorAll('.settings-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    
    const targetPanel = document.getElementById('settings' + section.charAt(0).toUpperCase() + section.slice(1));
    if (targetPanel) {
        targetPanel.classList.add('active');
    }

    if (section === 'duplicates') {
        renderDuplicateResults();
    } else if (section === 'competition') {
        renderCompetitionSettings();
    }
}

function renderCompetitionSettings() {
    const groupSizeSelect = document.getElementById('competitionGroupSizeSelect');
    if (groupSizeSelect) {
        groupSizeSelect.value = String(competitionGroupSize);
    }
}

function setCompetitionGroupSize(value) {
    competitionGroupSize = normalizeCompetitionGroupSize(value);
    localStorage.setItem('macimage:competitionGroupSize', String(competitionGroupSize));
    renderCompetitionSettings();
    updateCompetitionLauncherState();
}

function renderCategoryList() {
    const categoryList = document.getElementById('categoryList');
    if (!categoryList) return;
    
    categoryList.innerHTML = TAG_CATEGORIES.map(renderCategoryItem).join('');
    bindCategoryListActions(categoryList);
}

function renderCategoryItem(category) {
    return `
        <div class="category-item" data-id="${escapeAttribute(category.id)}">
            <div class="category-item-info">
                <span class="category-icon">${escapeHtml(category.icon)}</span>
                <span class="category-name">${escapeHtml(category.name)}</span>
            </div>
            <div class="category-item-actions">
                <button class="edit-category-btn" data-id="${escapeAttribute(category.id)}">编辑</button>
                <button class="delete-category-btn" data-id="${escapeAttribute(category.id)}" ${category.id === 'other' ? 'disabled' : ''}>删除</button>
            </div>
        </div>
    `;
}

function bindCategoryListActions(categoryList) {
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

function renderQuickOpenList() {
    const list = document.getElementById('quickOpenList');
    if (!list) return;

    if (quickOpenFolders.length === 0) {
        list.innerHTML = '<div class="empty-state">暂无快捷目录</div>';
        return;
    }

    list.innerHTML = quickOpenFolders.map((folder, index) => `
        <div class="quick-open-item">
            <div class="quick-open-item-info">
                <span class="quick-open-item-name">${escapeHtml(folder.name)}</span>
                <span class="quick-open-item-path">${escapeHtml(folder.path)}</span>
            </div>
            <button class="delete-quick-open-btn" data-index="${index}">删除</button>
        </div>
    `).join('');

    list.querySelectorAll('.delete-quick-open-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            await deleteQuickOpenFolder(parseInt(btn.dataset.index, 10));
        });
    });
}

function renderRecentOpenFileList() {
    const list = document.getElementById('recentOpenFileList');
    const clearBtn = document.getElementById('clearRecentOpenFilesBtn');
    if (!list) return;

    if (clearBtn) {
        clearBtn.disabled = recentOpenFiles.length === 0;
    }

    if (recentOpenFiles.length === 0) {
        list.innerHTML = '<div class="empty-state">暂无最近打开的文件</div>';
        return;
    }

    list.innerHTML = recentOpenFiles.map((file) => `
        <div class="quick-open-item">
            <div class="quick-open-item-info">
                <span class="quick-open-item-name">${escapeHtml(file.name)}</span>
                <span class="quick-open-item-path">${escapeHtml(file.path)}</span>
            </div>
        </div>
    `).join('');
}

async function chooseQuickOpenFolder() {
    const result = await window.electronAPI.selectQuickOpenFolder();
    if (!result.success) {
        if (!result.cancelled) {
            alert('选择目录失败: ' + result.error);
        }
        return;
    }

    quickOpenPathInput.value = result.path;
    if (!quickOpenNameInput.value.trim()) {
        quickOpenNameInput.value = getFolderDisplayName(result.path);
    }
}

async function addQuickOpenFolder() {
    const folderPath = quickOpenPathInput.value.trim();
    const folderName = quickOpenNameInput.value.trim() || getFolderDisplayName(folderPath);

    if (!folderPath) {
        alert('请先选择或输入目录路径');
        return;
    }

    const exists = await window.electronAPI.directoryExists(folderPath);
    if (!exists) {
        alert(`目录不存在或未挂载：\n${folderPath}`);
        return;
    }

    if (quickOpenFolders.some(folder => folder.path === folderPath)) {
        alert('该目录已在快速打开列表中');
        return;
    }

    quickOpenFolders.push({ name: folderName, path: folderPath });
    await saveQuickOpenFolders();
    quickOpenNameInput.value = '';
    quickOpenPathInput.value = '';
}

async function deleteQuickOpenFolder(index) {
    if (index < 0 || index >= quickOpenFolders.length) return;

    quickOpenFolders.splice(index, 1);
    await saveQuickOpenFolders();
}

async function saveQuickOpenFolders() {
    await window.electronAPI.saveQuickOpenFolders(quickOpenFolders);
    initQuickOpenFolders();
    renderQuickOpenList();
}

function getFolderDisplayName(folderPath) {
    const normalized = folderPath.replace(/\/+$/, '');
    const name = normalized.split('/').filter(Boolean).pop();
    return name || folderPath;
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
    updateCategoryIconSelect();

    const selects = document.querySelectorAll('.tag-category-select');
    selects.forEach(select => {
        const currentValue = select.value;
        select.innerHTML = TAG_CATEGORIES.map(cat => 
            `<option value="${escapeAttribute(cat.id)}">${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</option>`
        ).join('');
        
        if (TAG_CATEGORIES.find(c => c.id === currentValue)) {
            select.value = currentValue;
        } else {
            select.value = 'other';
        }
    });
}

function updateCategoryIconSelect() {
    const iconSelect = document.getElementById('newCategoryIcon');
    if (!iconSelect) return;

    const currentValue = iconSelect.value || '📌';
    iconSelect.innerHTML = CATEGORY_ICON_OPTIONS
        .map(([icon, label]) => `<option value="${escapeAttribute(icon)}">${escapeHtml(icon)} ${escapeHtml(label)}</option>`)
        .join('');
    iconSelect.value = CATEGORY_ICON_OPTIONS.some(([icon]) => icon === currentValue)
        ? currentValue
        : '📌';
}
