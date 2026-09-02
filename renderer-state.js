const imageCollection = MacImageCollection.create();
const images = imageCollection.items;
let currentImageIndex = -1;
let selectedFilterTags = [];
let filterNoTag = false;
let trashFolder = null;
let deleteHistory = [];
let currentFolder = '';
let currentSort = 'name-asc';
let randomSortRanks = new Map();
let sortedImages = [];
let currentZoom = 1;
let minZoom = 0.25;
let maxZoom = 5;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let imageTranslateX = 0;
let imageTranslateY = 0;
let settingsNavInitialized = false;
let lastWheelNavigationTime = 0;
let duplicateGroups = [];
let duplicateScanCompleted = false;
let competitionState = null;
let competitionGroupSize = getSavedCompetitionGroupSize();
const savedViewMode = localStorage.getItem('macimage:viewMode');
let currentViewMode = ['list', 'grid', 'waterfall'].includes(savedViewMode) ? savedViewMode : 'list';
let isSidebarCollapsed = localStorage.getItem('macimage:sidebarCollapsed') === 'true';
let galleryRenderVersion = 0;
let gridVirtualState = null;
let listVirtualState = null;
let gridRenderFrame = null;
let isDeletingCurrentImage = false;
let thumbnailQueue = [];
let thumbnailQueuedIndexes = new Set();
let thumbnailActiveCount = 0;
let thumbnailMemoryCache = new Map();
let closeModalOnImageClick = false;
const savedWaterfallPageSize = Number(localStorage.getItem('macimage:waterfallPageSize'));
const initialWaterfallPageSize = [3, 10].includes(savedWaterfallPageSize) ? savedWaterfallPageSize : 3;

const WHEEL_NAVIGATION_COOLDOWN_MS = 220;
const FAVORITE_IMAGE_SHORTCUT = 'f';
const DELETE_IMAGE_SHORTCUT = 'd';
const RESERVED_TAG_SHORTCUTS = {
    [FAVORITE_IMAGE_SHORTCUT]: '喜欢图片',
    [DELETE_IMAGE_SHORTCUT]: '删除图片'
};
const THUMBNAIL_SIZE = 220;
const THUMBNAIL_LOAD_CONCURRENCY = 6;
const THUMBNAIL_MEMORY_CACHE_LIMIT = 350;
const GRID_MIN_CARD_WIDTH = 168;
const GRID_GAP = 14;
const GRID_PADDING = 14;
const GRID_OVERSCAN_ROWS = 2;
const LIST_ROW_HEIGHT = 60;
const LIST_OVERSCAN_ROWS = 8;
const WATERFALL_PAGE_SIZES = [3, 10];
const WATERFALL_WHEEL_PAGE_THRESHOLD = 80;
const WATERFALL_WHEEL_RESET_MS = 240;
const HEART_TAG_NAME = '红心';
const RECENT_OPEN_FILE_LIMIT = 12;

const DEFAULT_TAGS = [
    { name: HEART_TAG_NAME, color: '#ff2d55', category: 'emotion' }
];

const DEFAULT_CATEGORIES = [
    { id: 'person', name: '人物', icon: '👤' },
    { id: 'landscape', name: '风景', icon: '🏞️' },
    { id: 'object', name: '物品', icon: '📦' },
    { id: 'event', name: '事件', icon: '📅' },
    { id: 'emotion', name: '情感', icon: '❤️' },
    { id: 'style', name: '风格', icon: '🎨' },
    { id: 'other', name: '其他', icon: '📌' }
];

const DEFAULT_QUICK_OPEN_FOLDERS = [
    { name: 'T7Shield 图片', path: '/Volumes/T7Shield/av/pic' },
    { name: '图片', path: '/Users/leon/Pictures' },
    { name: '下载', path: '/Users/leon/Downloads' },
    { name: '桌面', path: '/Users/leon/Desktop' }
];

const CATEGORY_ICON_OPTIONS = [
    ['📌', '图钉'], ['👤', '人物'], ['👥', '群组'], ['🏞️', '风景'],
    ['🏔️', '山峰'], ['🌊', '海浪'], ['🌳', '树木'], ['📦', '包裹'],
    ['📱', '手机'], ['💻', '电脑'], ['📷', '相机'], ['🚗', '汽车'],
    ['🏠', '房屋'], ['📅', '日历'], ['🎉', '庆祝'], ['🎂', '生日'],
    ['🎄', '圣诞'], ['❤️', '红心'], ['💖', '爱心'], ['⭐', '星星'],
    ['🔥', '火焰'], ['🎨', '调色板'], ['🖼️', '画框'], ['🎬', '电影'],
    ['🎵', '音乐'], ['📚', '书籍'], ['💼', '公文包'], ['🎮', '游戏'],
    ['🏀', '篮球'], ['⚽', '足球'], ['🍳', '烹饪'], ['☕', '咖啡'],
    ['🍕', '披萨'], ['✈️', '飞机'], ['🌍', '地球'], ['☀️', '太阳'],
    ['🌙', '月亮'], ['💎', '钻石'], ['🔑', '钥匙'], ['💡', '灯泡']
];

let quickOpenFolders = [...DEFAULT_QUICK_OPEN_FOLDERS];
let recentOpenFiles = [];

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

const tagCatalog = MacImageTagCatalog.create({
    defaultTags: DEFAULT_TAGS,
    defaultCategories: DEFAULT_CATEGORIES,
    reservedShortcuts: RESERVED_TAG_SHORTCUTS,
    colorFactory: generateRandomColor,
    idFactory: generateCategoryId
});
const allTags = tagCatalog.tags;
const TAG_CATEGORIES = tagCatalog.categories;

function getCategoryById(categoryId) {
    return tagCatalog.getCategory(categoryId);
}

function getTagsByCategory() {
    return tagCatalog.groupTags();
}

function generateCategoryId() {
    return 'cat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function escapeAttribute(value) {
    return escapeHtml(value);
}

function safeColor(color, fallback = '#666') {
    return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color) ? color : fallback;
}

function toFileUrl(filePath) {
    return 'file://' + filePath.split('/').map(encodeURIComponent).join('/');
}

function normalizeShortcut(value) {
    const shortcut = String(value ?? '').trim().toLowerCase();
    return /^[a-z]$/.test(shortcut) ? shortcut : '';
}

function getTagByShortcut(shortcut) {
    return tagCatalog.getTagByShortcut(shortcut);
}

function getReservedShortcutLabel(shortcut) {
    return RESERVED_TAG_SHORTCUTS[normalizeShortcut(shortcut)] || '';
}

function isEditableTarget(target) {
    if (!target) return false;
    const tagName = target.tagName;
    return target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function normalizeCompetitionGroupSize(value) {
    const numericValue = Math.floor(Number(value));
    return Math.min(Math.max(numericValue || 2, 2), 8);
}

function getSavedCompetitionGroupSize() {
    return normalizeCompetitionGroupSize(localStorage.getItem('macimage:competitionGroupSize'));
}

const imageGrid = document.getElementById('imageGrid');
const tagFilter = document.getElementById('tagFilter');
const imageModal = document.getElementById('imageModal');
const competitionModal = document.getElementById('competitionModal');
const settingsModal = document.getElementById('settingsModal');
const currentFolderEl = document.getElementById('currentFolder');
const imageCountEl = document.getElementById('imageCount');
const quickFolderSelect = document.getElementById('quickFolderSelect');
const quickOpenNameInput = document.getElementById('quickOpenNameInput');
const quickOpenPathInput = document.getElementById('quickOpenPathInput');
