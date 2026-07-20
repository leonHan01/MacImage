function getTagCount(tagName) {
    let count = 0;
    images.forEach(img => {
        const tags = getImageTags(img);
        if (tags.includes(tagName)) {
            count++;
        }
    });
    return count;
}

function renderTagList() {
    const tagList = document.getElementById('tagList');
    
    if (allTags.length === 0) {
        tagList.innerHTML = '<div class="empty-state">暂无标签</div>';
        return;
    }

    const groupedTags = getTagsByCategory();
    tagList.innerHTML = TAG_CATEGORIES
        .map(category => renderTagListCategory(category, groupedTags[category.id]))
        .filter(Boolean)
        .join('');

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

    tagList.querySelectorAll('.tag-shortcut-input').forEach(input => {
        input.addEventListener('keydown', async (event) => {
            await handleShortcutInputKeydown(event, input.dataset.tag);
        });
    });
}

function renderTagListCategory(category, tags) {
    if (!tags || tags.length === 0) return '';

    return `
        <div class="tag-list-category">
            <div class="tag-list-category-header">
                <span>${escapeHtml(category.icon)}</span>
                <span>${escapeHtml(category.name)}</span>
            </div>
            ${tags.map(renderTagListItem).join('')}
        </div>
    `;
}

function renderTagListItem(tag) {
    const tagColor = safeColor(tag.color);
    const shortcut = normalizeShortcut(tag.shortcut);

    return `
        <div class="tag-item" data-tag="${escapeAttribute(tag.name)}">
            <div class="tag-item-info">
                <span class="tag-color" style="background: ${tagColor}"></span>
                <span class="tag-name">${escapeHtml(tag.name)}</span>
                <span class="tag-count">${getTagCount(tag.name)}</span>
            </div>
            <label class="tag-shortcut-field" title="预览图片时按该键切换此标签">
                <span>快捷键</span>
                <input class="tag-shortcut-input" data-tag="${escapeAttribute(tag.name)}" value="${escapeAttribute(shortcut.toUpperCase())}" maxlength="1" placeholder="-">
            </label>
            <div class="tag-item-actions">
                <button class="edit-tag-btn" data-tag="${escapeAttribute(tag.name)}">编辑</button>
                <button class="delete-tag-btn" data-tag="${escapeAttribute(tag.name)}">删除</button>
            </div>
        </div>
    `;
}

async function handleShortcutInputKeydown(event, tagName) {
    if (event.key === 'Tab') return;

    event.preventDefault();

    if (event.key === 'Backspace' || event.key === 'Delete') {
        await updateTagShortcut(tagName, '');
        return;
    }

    if (event.key === 'Escape') {
        event.currentTarget.blur();
        return;
    }

    if (event.key.length !== 1) {
        return;
    }

    const shortcut = normalizeShortcut(event.key);
    if (!shortcut) {
        alert('快捷键只支持单个英文字母，例如 q、w、e、r');
        return;
    }

    await updateTagShortcut(tagName, shortcut);
}

async function updateTagShortcut(tagName, shortcutValue) {
    const shortcut = normalizeShortcut(shortcutValue);
    const tag = allTags.find(item => item.name === tagName);
    if (!tag) return;

    const reservedLabel = getReservedShortcutLabel(shortcut);
    if (reservedLabel) {
        alert(`快捷键 ${shortcut.toUpperCase()} 已用于${reservedLabel}`);
        renderTagList();
        return;
    }

    const duplicate = shortcut
        ? allTags.find(item => item.name !== tagName && normalizeShortcut(item.shortcut) === shortcut)
        : null;

    if (duplicate) {
        alert(`快捷键 ${shortcut.toUpperCase()} 已被标签 "${duplicate.name}" 使用`);
        renderTagList();
        return;
    }

    tag.shortcut = shortcut;
    await window.electronAPI.saveTags(allTags);
    renderTagList();

    if (currentImageIndex >= 0 && currentImageIndex < sortedImages.length) {
        renderModalTagList(sortedImages[currentImageIndex]);
    }
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
    allTags.push({ name, color, category, shortcut: '' });
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
    allTags.push({ name, color, category, shortcut: '' });
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

    await ensureTagExists(name, categorySelect ? categorySelect.value : 'other');
    await addTagToCurrentModalImage(name);
    
    nameInput.value = '';
    if (categorySelect) categorySelect.value = 'other';
}

async function ensureTagExists(name, category = 'other') {
    if (allTags.find(t => t.name === name)) return false;

    allTags.push({ name, color: generateRandomColor(), category, shortcut: '' });
    await window.electronAPI.saveTags(allTags);
    renderTagFilter();
    return true;
}

async function addTagToCurrentModalImage(tagName) {
    if (currentImageIndex < 0 || currentImageIndex >= sortedImages.length) return;

    const img = sortedImages[currentImageIndex];
    if (!getImageTags(img).includes(tagName)) {
        await addTagToImage(img.path, tagName);
    }

    if (img.hash) {
        img.tags = imageTagsByHash[img.hash] || [];
    }

    renderModalTagList(img);
    renderImages();
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
