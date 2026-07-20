const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./store');
const { calculateFileHash, calculateFileHashSync } = require('./hashUtils');
const registerIpcHandlers = require('./main-ipc-handlers');

const fsp = fs.promises;

let mainWindow;
let store;
let pendingOpenImages = [];
let rendererReady = false;

const storePath = path.join(app.getPath('userData'), 'config.json');
const thumbnailCacheDir = path.join(app.getPath('userData'), 'thumbnails');
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.heic', '.heif'];
const IMAGE_SCAN_CONCURRENCY = 8;
const DEFAULT_THUMBNAIL_SIZE = 220;

function isSupportedImageFile(filePath) {
    return IMAGE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

async function pathExists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function getImageEntries(dirPath) {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries.filter(entry => (
        entry.isFile() &&
        !entry.name.startsWith('.') &&
        isSupportedImageFile(entry.name)
    ));
}

async function getImageRecord(dirPath, fileName, pathToHash, imageTagsByHash, imageScoresByHash, updatedPathToHash) {
    const fullPath = path.join(dirPath, fileName);

    try {
        const stats = await fsp.stat(fullPath);
        let hash = pathToHash[fullPath];

        if (!hash) {
            hash = await calculateFileHash(fullPath);
        }

        if (hash) {
            updatedPathToHash[fullPath] = hash;
        }

        return {
            name: fileName,
            path: fullPath,
            size: stats.size,
            modifiedTime: stats.mtime,
            hash,
            tags: hash ? (imageTagsByHash[hash] || []) : [],
            score: hash ? (imageScoresByHash[hash] ?? null) : null
        };
    } catch (err) {
        console.error('Failed to read image:', fullPath, err.message);
        return null;
    }
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

async function getOrCreateImageHash(imagePath) {
    const pathToHash = store.get('pathToHash') || {};
    let hash = pathToHash[imagePath];

    if (!hash) {
        hash = await calculateFileHash(imagePath);
        pathToHash[imagePath] = hash;
        store.set('pathToHash', pathToHash);
    }

    return hash;
}

function normalizeThumbnailSize(size) {
    const parsed = Number(size);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_THUMBNAIL_SIZE;
    }
    return Math.min(Math.max(Math.round(parsed), 80), 512);
}

function getThumbnailCachePath(hash, size) {
    return path.join(thumbnailCacheDir, `${hash}-${size}.png`);
}

async function readThumbnailDataUrl(cachePath) {
    const buffer = await fsp.readFile(cachePath);
    return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function getCachedThumbnail(imagePath, requestedSize = DEFAULT_THUMBNAIL_SIZE) {
    const size = normalizeThumbnailSize(requestedSize);
    const hash = await getOrCreateImageHash(imagePath);
    if (!hash) {
        return { success: false, error: '无法计算图片 hash' };
    }

    const cachePath = getThumbnailCachePath(hash, size);
    if (await pathExists(cachePath)) {
        return { success: true, dataUrl: await readThumbnailDataUrl(cachePath), cached: true };
    }

    await fsp.mkdir(thumbnailCacheDir, { recursive: true });
    const thumbnail = await nativeImage.createThumbnailFromPath(imagePath, {
        width: size,
        height: size
    });

    if (!thumbnail || thumbnail.isEmpty()) {
        return { success: false, error: '无法生成缩略图' };
    }

    const png = thumbnail.toPNG();
    await fsp.writeFile(cachePath, png);
    return { success: true, dataUrl: `data:image/png;base64,${png.toString('base64')}`, cached: false };
}

async function getAvailablePath(filePath, buildCandidate) {
    if (!(await pathExists(filePath))) {
        return filePath;
    }

    let counter = 1;
    let candidate = buildCandidate(counter);
    while (await pathExists(candidate)) {
        counter++;
        candidate = buildCandidate(counter);
    }
    return candidate;
}

async function getTimestampedPath(filePath) {
    return getAvailablePath(filePath, () => {
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        return path.join(path.dirname(filePath), `${baseName}_${Date.now()}${ext}`);
    });
}

async function getNumberedPath(filePath) {
    return getAvailablePath(filePath, (counter) => {
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        return path.join(path.dirname(filePath), `${baseName}_${counter}${ext}`);
    });
}

function moveHashMapping(fromPath, toPath) {
    const pathToHash = store.get('pathToHash') || {};
    const hash = pathToHash[fromPath];
    if (!hash) return;

    delete pathToHash[fromPath];
    pathToHash[toPath] = hash;
    store.set('pathToHash', pathToHash);
}

function flushPendingOpenImages() {
    if (!rendererReady || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) {
        return;
    }

    const imagesToOpen = pendingOpenImages;
    pendingOpenImages = [];

    imagesToOpen.forEach((filePath) => {
        mainWindow.webContents.send('open-image-file', {
            filePath,
            folderPath: path.dirname(filePath)
        });
    });

    if (imagesToOpen.length > 0) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.focus();
    }
}

function openImageFromSystem(filePath) {
    if (!isSupportedImageFile(filePath) || !fs.existsSync(filePath)) {
        return;
    }

    pendingOpenImages.push(filePath);

    if (app.isReady() && (!mainWindow || mainWindow.isDestroyed())) {
        createWindow();
    }

    flushPendingOpenImages();
}

function getImageFilesFromArgv(argv) {
    return argv.filter((arg) => {
        const filePath = path.resolve(arg);
        return isSupportedImageFile(filePath) && fs.existsSync(filePath);
    });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', (event, argv) => {
        getImageFilesFromArgv(argv).forEach(openImageFromSystem);

        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });
}

function createWindow() {
    rendererReady = false;

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 15, y: 15 },
        vibrancy: 'under-window',
        visualEffectState: 'active'
    });

    mainWindow.loadFile('index.html');
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    createMenu();
}

function createMenu() {
    const menu = Menu.buildFromTemplate([
        createFileMenu(),
        createEditMenu(),
        createViewMenu(),
        createWindowMenu()
    ]);
    Menu.setApplicationMenu(menu);
}

function createFileMenu() {
    return {
        label: '文件',
        submenu: [
            { label: '打开文件夹', accelerator: 'Cmd+O', click: openFolderFromMenu },
            { label: '设置回收站文件夹', click: setTrashFolderFromMenu },
            { type: 'separator' },
            { role: 'quit', label: '退出' }
        ]
    };
}

function createEditMenu() {
    return {
        label: '编辑',
        submenu: [
            {
                label: '撤销删除',
                accelerator: 'Cmd+Z',
                click: () => mainWindow.webContents.send('undo-delete')
            }
        ]
    };
}

function createViewMenu() {
    return {
        label: '视图',
        submenu: [
            { role: 'reload', label: '重新加载' },
            { role: 'toggleDevTools', label: '开发者工具' },
            { type: 'separator' },
            { role: 'resetZoom', label: '重置缩放' },
            { role: 'zoomIn', label: '放大' },
            { role: 'zoomOut', label: '缩小' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: '全屏' }
        ]
    };
}

function createWindowMenu() {
    return {
        label: '窗口',
        submenu: [
            { role: 'minimize', label: '最小化' },
            { role: 'close', label: '关闭' }
        ]
    };
}

async function openFolderFromMenu() {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        mainWindow.webContents.send('open-folder', result.filePaths[0]);
    }
}

async function setTrashFolderFromMenu() {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        store.set('trashFolder', result.filePaths[0]);
        mainWindow.webContents.send('trash-folder-changed', result.filePaths[0]);
    }
}

app.on('open-file', (event, filePath) => {
    event.preventDefault();
    openImageFromSystem(filePath);
});

function migrateOldData() {
    const oldImageTags = store.get('imageTags');
    const imageTagsByHash = store.get('imageTagsByHash');
    
    if (oldImageTags && Object.keys(oldImageTags).length > 0 && !imageTagsByHash) {
        console.log('Migrating old image tags to hash-based storage...');
        const newImageTagsByHash = {};
        const newPathToHash = {};
        
        for (const imagePath in oldImageTags) {
            try {
                if (fs.existsSync(imagePath)) {
                    const hash = calculateFileHashSync(imagePath);
                    newImageTagsByHash[hash] = oldImageTags[imagePath];
                    newPathToHash[imagePath] = hash;
                }
            } catch (err) {
                console.error('Failed to migrate tags for:', imagePath, err.message);
            }
        }
        
        store.set('imageTagsByHash', newImageTagsByHash);
        store.set('pathToHash', newPathToHash);
        store.delete('imageTags');
        console.log('Migration completed.');
    }
}

registerIpcHandlers({
    ipcMain,
    dialog,
    shell,
    path,
    fsp,
    getMainWindow: () => mainWindow,
    getStore: () => store,
    getImageEntries,
    getImageRecord,
    mapWithConcurrency,
    getOrCreateImageHash,
    getCachedThumbnail,
    getAvailablePath,
    getTimestampedPath,
    getNumberedPath,
    pathExists,
    moveHashMapping,
    imageScanConcurrency: IMAGE_SCAN_CONCURRENCY,
    getServerDownloadDirectory: () => path.join(app.getPath('userData'), 'server-downloads')
});

app.whenReady().then(() => {
    if (!gotSingleInstanceLock) {
        return;
    }

    store = new Store(storePath);
    migrateOldData();
    createWindow();
    getImageFilesFromArgv(process.argv).forEach(openImageFromSystem);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

ipcMain.handle('renderer-ready', () => {
    rendererReady = true;
    flushPendingOpenImages();
    return true;
});
