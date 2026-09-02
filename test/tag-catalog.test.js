const assert = require('node:assert/strict');
const { test } = require('node:test');

const { create } = require('../tag-catalog');

function createCatalog() {
    return create({
        defaultTags: [{ name: '红心', color: '#ff0000', category: 'emotion' }],
        defaultCategories: [
            { id: 'emotion', name: '情感', icon: '❤️' },
            { id: 'other', name: '其他', icon: '📌' }
        ],
        reservedShortcuts: { f: '喜欢图片' },
        colorFactory: () => '#123456',
        idFactory: () => 'category-new'
    });
}

test('loads and normalizes tags without replacing the public lists', () => {
    const catalog = createCatalog();
    const tagList = catalog.tags;
    const categoryList = catalog.categories;

    const result = catalog.load({
        categories: [{ id: 'other', name: '其他', icon: '📌' }],
        tags: [{ name: '旅行', shortcut: 'F' }]
    });

    assert.equal(catalog.tags, tagList);
    assert.equal(catalog.categories, categoryList);
    assert.equal(result.tagsChanged, true);
    assert.deepEqual(catalog.tags, [
        { name: '旅行', shortcut: '', color: '#123456', category: 'other' },
        { name: '红心', color: '#ff0000', category: 'other', shortcut: '' }
    ]);
});

test('edits tags in place while preserving color and shortcut', () => {
    const catalog = createCatalog();
    catalog.load({
        categories: [
            { id: 'emotion', name: '情感', icon: '❤️' },
            { id: 'other', name: '其他', icon: '📌' }
        ],
        tags: [{ name: '旧名称', color: '#abcdef', category: 'other', shortcut: 'q' }]
    });

    const result = catalog.saveTag({
        currentName: '旧名称',
        name: '新名称',
        category: 'emotion'
    });

    assert.equal(result.success, true);
    assert.equal(result.renamed, true);
    assert.deepEqual(catalog.tags.find(tag => tag.name === '新名称'), {
        name: '新名称',
        color: '#abcdef',
        category: 'emotion',
        shortcut: 'q'
    });
});

test('edits categories without changing ids and reassigns tags only on delete', () => {
    const catalog = createCatalog();
    catalog.saveCategory({ name: '人物', icon: '👤' });
    catalog.saveTag({ name: '肖像', category: 'category-new' });

    const editResult = catalog.saveCategory({ id: 'category-new', name: '人像', icon: '🧑' });
    assert.equal(editResult.category.id, 'category-new');
    assert.equal(catalog.tags.find(tag => tag.name === '肖像').category, 'category-new');

    const removeResult = catalog.removeCategory('category-new');
    assert.equal(removeResult.reassignedTagCount, 1);
    assert.equal(catalog.tags.find(tag => tag.name === '肖像').category, 'other');
});

test('rejects reserved and duplicate shortcuts through the catalog interface', () => {
    const catalog = createCatalog();
    catalog.saveTag({ name: '标签一', category: 'other' });
    catalog.saveTag({ name: '标签二', category: 'other' });

    assert.equal(catalog.setShortcut('标签一', 'f').reason, 'reserved-shortcut');
    assert.equal(catalog.setShortcut('标签一', 'q').success, true);
    assert.equal(catalog.setShortcut('标签二', 'q').reason, 'duplicate-shortcut');
});
