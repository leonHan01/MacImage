let editingTagName = null;

function getTagCount(tagName) {
    return imageCollection.getTagCount(tagName);
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
    const result = tagCatalog.setShortcut(tagName, shortcut);
    if (!result.success && result.reason === 'reserved-shortcut') {
        alert(`快捷键 ${shortcut.toUpperCase()} 已用于${result.reservedLabel}`);
        renderTagList();
        return;
    }
    if (!result.success && result.reason === 'duplicate-shortcut') {
        alert(`快捷键 ${shortcut.toUpperCase()} 已被标签 "${result.tag.name}" 使用`);
        renderTagList();
        return;
    }
    if (!result.success) return;

    await window.electronAPI.saveTags(allTags);
    renderTagList();

    const image = getCurrentModalImage();
    if (image) renderModalTagList(image);
}

async function saveTagFromForm() {
    const nameInput = document.getElementById('newTagInput');
    const categorySelect = document.getElementById('newTagCategory');
    
    const name = nameInput.value.trim();
    
    if (!name) return;
    
    const previousTag = editingTagName
        ? { ...allTags.find(tag => tag.name === editingTagName) }
        : null;
    const result = tagCatalog.saveTag({
        currentName: editingTagName,
        name,
        category: categorySelect ? categorySelect.value : 'other'
    });
    if (!result.success && result.reason === 'duplicate-name') {
        alert('标签名称已存在');
        return;
    }
    if (!result.success) return;

    if (result.renamed) {
        const renameResult = await window.electronAPI.renameTagAcrossAllImages(result.previousName, result.tag.name);
        if (!renameResult.success) {
            tagCatalog.saveTag({
                currentName: result.tag.name,
                name: previousTag.name,
                category: previousTag.category,
                color: previousTag.color
            });
            tagCatalog.setShortcut(previousTag.name, previousTag.shortcut);
            alert('重命名图片标签失败: ' + renameResult.error);
            return;
        }
        imageCollection.renameTag(result.previousName, result.tag.name);
        selectedFilterTags = selectedFilterTags.map(tag => (
            tag === result.previousName ? result.tag.name : tag
        ));
    }

    await window.electronAPI.saveTags(allTags);
    cancelTagEdit();
    renderTagList();
    renderTagFilter();
    renderImages();
}

async function quickAddTag() {
    const nameInput = document.getElementById('quickTagInput');
    const categorySelect = document.getElementById('quickTagCategory');
    
    const name = nameInput.value.trim();
    
    if (!name) return;
    
    const result = tagCatalog.saveTag({
        name,
        category: categorySelect ? categorySelect.value : 'other'
    });
    if (!result.success) {
        nameInput.value = '';
        return;
    }
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
    const result = tagCatalog.saveTag({ name, category });
    if (!result.success) return false;

    await window.electronAPI.saveTags(allTags);
    renderTagFilter();
    return true;
}

async function addTagToCurrentModalImage(tagName) {
    const img = getCurrentModalImage();
    if (!img) return;
    if (!getImageTags(img).includes(tagName)) {
        await addTagToImage(img.path, tagName);
        if (await moveNewlyTaggedImageToTarget(img.path)) {
            return;
        }
    }

    renderModalTagList(img);
    renderImages();
}

async function deleteTag(tagName) {
    if (!confirm(`确定要删除标签 "${tagName}" 吗？`)) return;

    const result = await window.electronAPI.removeTagFromAllImages(tagName);
    if (!result.success) {
        alert('删除图片标签失败: ' + result.error);
        return;
    }
    if (editingTagName === tagName) cancelTagEdit();
    tagCatalog.removeTag(tagName);
    await window.electronAPI.saveTags(allTags);
    imageCollection.removeTag(tagName);
    
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
    editingTagName = tagName;
    const saveButton = document.getElementById('addTagBtn');
    if (saveButton) saveButton.textContent = '保存';
    nameInput.focus();
}

function cancelTagEdit() {
    editingTagName = null;
    const nameInput = document.getElementById('newTagInput');
    const categorySelect = document.getElementById('newTagCategory');
    const saveButton = document.getElementById('addTagBtn');
    if (nameInput) nameInput.value = '';
    if (categorySelect) categorySelect.value = 'other';
    if (saveButton) saveButton.textContent = '添加';
}

async function addTagToImage(imagePath, tagName) {
    const tags = await window.electronAPI.addTagToImage(imagePath, tagName);
    const img = images.find(i => i.path === imagePath);
    if (img) imageCollection.applyMetadata({ path: imagePath, tags });
    return tags;
}

async function removeTagFromImage(imagePath, tagName) {
    const tags = await window.electronAPI.removeTagFromImage(imagePath, tagName);
    const img = images.find(i => i.path === imagePath);
    if (img) imageCollection.applyMetadata({ path: imagePath, tags });
    return tags;
}
