(function exposeTagCatalog(root, factory) {
    const tagCatalog = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = tagCatalog;
        return;
    }

    root.MacImageTagCatalog = tagCatalog;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    function create(options = {}) {
        const defaultTags = cloneList(options.defaultTags);
        const defaultCategories = cloneList(options.defaultCategories);
        const reservedShortcuts = { ...(options.reservedShortcuts || {}) };
        const colorFactory = options.colorFactory || (() => '#666666');
        const idFactory = options.idFactory || (() => `cat_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`);
        const fallbackCategoryId = options.fallbackCategoryId || 'other';
        const tags = [];
        const categories = [];

        function load(values = {}) {
            const sourceCategories = Array.isArray(values.categories) && values.categories.length > 0
                ? values.categories
                : defaultCategories;
            const nextCategories = normalizeCategories(sourceCategories);
            const sourceTags = Array.isArray(values.tags) ? values.tags : [];
            const nextTags = normalizeTags(sourceTags, nextCategories);
            const categoriesChanged = !areEqualLists(sourceCategories, nextCategories);
            const tagsChanged = !areEqualLists(sourceTags, nextTags);

            replaceList(categories, nextCategories);
            replaceList(tags, nextTags);
            return { tagsChanged, categoriesChanged };
        }

        function ensureDefaults() {
            return load({ tags, categories });
        }

        function saveTag(values = {}) {
            const currentName = normalizeName(values.currentName);
            const name = normalizeName(values.name);
            if (!name) return { success: false, reason: 'invalid-name' };

            const duplicate = tags.find(tag => tag.name === name && tag.name !== currentName);
            if (duplicate) return { success: false, reason: 'duplicate-name', tag: duplicate };

            const existing = currentName ? tags.find(tag => tag.name === currentName) : null;
            if (currentName && !existing) return { success: false, reason: 'not-found' };

            const category = getCategory(values.category)?.id || getFallbackCategory()?.id || fallbackCategoryId;
            if (existing) {
                const previousName = existing.name;
                existing.name = name;
                existing.category = category;
                if (typeof values.color === 'string' && values.color) existing.color = values.color;
                return { success: true, tag: existing, previousName, renamed: previousName !== name };
            }

            const tag = {
                name,
                color: typeof values.color === 'string' && values.color ? values.color : colorFactory(),
                category,
                shortcut: ''
            };
            tags.push(tag);
            return { success: true, tag, previousName: null, renamed: false };
        }

        function removeTag(nameValue) {
            const name = normalizeName(nameValue);
            const index = tags.findIndex(tag => tag.name === name);
            if (index < 0) return { success: false, reason: 'not-found' };
            const [tag] = tags.splice(index, 1);
            return { success: true, tag };
        }

        function setShortcut(nameValue, shortcutValue) {
            const tag = tags.find(item => item.name === normalizeName(nameValue));
            if (!tag) return { success: false, reason: 'not-found' };

            const rawShortcut = String(shortcutValue ?? '').trim();
            const shortcut = normalizeShortcut(rawShortcut);
            if (rawShortcut && !shortcut) return { success: false, reason: 'invalid-shortcut' };

            const reservedLabel = shortcut ? reservedShortcuts[shortcut] : '';
            if (reservedLabel) {
                return { success: false, reason: 'reserved-shortcut', reservedLabel };
            }

            const duplicate = shortcut
                ? tags.find(item => item !== tag && normalizeShortcut(item.shortcut) === shortcut)
                : null;
            if (duplicate) {
                return { success: false, reason: 'duplicate-shortcut', tag: duplicate };
            }

            tag.shortcut = shortcut;
            return { success: true, tag };
        }

        function saveCategory(values = {}) {
            const id = normalizeName(values.id);
            const name = normalizeName(values.name);
            if (!name) return { success: false, reason: 'invalid-name' };

            const duplicate = categories.find(category => category.name === name && category.id !== id);
            if (duplicate) return { success: false, reason: 'duplicate-name', category: duplicate };

            const existing = id ? categories.find(category => category.id === id) : null;
            if (id && !existing) return { success: false, reason: 'not-found' };

            if (existing) {
                existing.name = name;
                existing.icon = normalizeIcon(values.icon, existing.icon);
                return { success: true, category: existing, created: false };
            }

            const category = {
                id: idFactory(),
                name,
                icon: normalizeIcon(values.icon, '📌')
            };
            categories.push(category);
            return { success: true, category, created: true };
        }

        function removeCategory(idValue) {
            const id = normalizeName(idValue);
            if (!id || id === fallbackCategoryId) {
                return { success: false, reason: 'protected-category' };
            }

            const index = categories.findIndex(category => category.id === id);
            if (index < 0) return { success: false, reason: 'not-found' };
            const [category] = categories.splice(index, 1);
            const fallbackId = getFallbackCategory()?.id || fallbackCategoryId;
            let reassignedTagCount = 0;
            tags.forEach((tag) => {
                if (tag.category !== id) return;
                tag.category = fallbackId;
                reassignedTagCount++;
            });
            return { success: true, category, reassignedTagCount };
        }

        function getCategory(idValue) {
            const id = normalizeName(idValue);
            return categories.find(category => category.id === id) || getFallbackCategory();
        }

        function groupTags() {
            const grouped = Object.fromEntries(categories.map(category => [category.id, []]));
            const fallbackId = getFallbackCategory()?.id;
            tags.forEach((tag) => {
                const categoryId = Object.prototype.hasOwnProperty.call(grouped, tag.category)
                    ? tag.category
                    : fallbackId;
                if (categoryId) grouped[categoryId].push(tag);
            });
            return grouped;
        }

        function getTagByShortcut(shortcutValue) {
            const shortcut = normalizeShortcut(shortcutValue);
            return shortcut
                ? tags.find(tag => normalizeShortcut(tag.shortcut) === shortcut) || null
                : null;
        }

        function getFallbackCategory() {
            return categories.find(category => category.id === fallbackCategoryId)
                || categories[categories.length - 1]
                || null;
        }

        load();

        return Object.freeze({
            tags,
            categories,
            load,
            ensureDefaults,
            saveTag,
            removeTag,
            setShortcut,
            saveCategory,
            removeCategory,
            getCategory,
            groupTags,
            getTagByShortcut
        });

        function normalizeCategories(values) {
            const seenIds = new Set();
            const seenNames = new Set();
            const normalized = cloneList(values).filter((category) => {
                const id = normalizeName(category.id);
                const name = normalizeName(category.name);
                if (!id || !name || seenIds.has(id) || seenNames.has(name)) return false;
                seenIds.add(id);
                seenNames.add(name);
                category.id = id;
                category.name = name;
                category.icon = normalizeIcon(category.icon, '📌');
                return true;
            });

            if (!normalized.some(category => category.id === fallbackCategoryId)) {
                const fallback = defaultCategories.find(category => category.id === fallbackCategoryId)
                    || { id: fallbackCategoryId, name: '其他', icon: '📌' };
                normalized.push({ ...fallback });
            }
            return normalized;
        }

        function normalizeTags(values, normalizedCategories) {
            const validCategoryIds = new Set(normalizedCategories.map(category => category.id));
            const fallbackId = validCategoryIds.has(fallbackCategoryId)
                ? fallbackCategoryId
                : normalizedCategories[normalizedCategories.length - 1]?.id;
            const seenNames = new Set();
            const normalized = cloneList(values).filter((tag) => {
                const name = normalizeName(tag.name);
                if (!name || seenNames.has(name)) return false;
                seenNames.add(name);
                tag.name = name;
                return true;
            });

            defaultTags.forEach((defaultTag) => {
                const existing = normalized.find(tag => tag.name === defaultTag.name);
                if (existing) {
                    if (!existing.color) existing.color = defaultTag.color;
                    if (!existing.category) existing.category = defaultTag.category;
                    return;
                }
                normalized.push({ ...defaultTag });
            });

            const usedShortcuts = new Set();
            normalized.forEach((tag) => {
                if (!tag.color) tag.color = colorFactory();
                if (!validCategoryIds.has(tag.category)) tag.category = fallbackId;
                const shortcut = normalizeShortcut(tag.shortcut);
                tag.shortcut = shortcut && !reservedShortcuts[shortcut] && !usedShortcuts.has(shortcut)
                    ? shortcut
                    : '';
                if (tag.shortcut) usedShortcuts.add(tag.shortcut);
            });
            return normalized;
        }
    }

    function normalizeName(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function normalizeIcon(value, fallback) {
        return typeof value === 'string' && value ? value : fallback;
    }

    function normalizeShortcut(value) {
        const shortcut = String(value ?? '').trim().toLowerCase();
        return /^[a-z]$/.test(shortcut) ? shortcut : '';
    }

    function cloneList(values) {
        return (Array.isArray(values) ? values : [])
            .filter(value => value && typeof value === 'object')
            .map(value => ({ ...value }));
    }

    function replaceList(target, values) {
        target.splice(0, target.length, ...values);
    }

    function areEqualLists(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    return Object.freeze({ create });
}));
