const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./store');
const { calculateLegacyFileHashSync } = require('./hashUtils');
const { createImageLibrary, isSupportedImageFile } = require('./image-library');
const { createFileOperationUtils } = require('./file-operation-utils');
const { createImageFileOperations } = require('./image-file-operations');
const { mapWithConcurrency } = require('./async-utils');
const registerIpcHandlers = require('./main-ipc-handlers');

const fsp = fs.promises;
const fileOperations = createFileOperationUtils({ fsp, path });

let mainWindow;
let store;
let pendingOpenImages = [];
let rendererReady = false;
let ipcServices = null;
let isQuittingAfterFileOperations = false;
let fileOperationQuitStarted = false;

const userDataPath = app.getPath('userData');
const storePath = path.join(userDataPath, 'macimage.db');
const legacyStorePath = path.join(userDataPath, 'config.json');
const thumbnailCacheDir = path.join(app.getPath('userData'), 'thumbnails');

function moveHashMappings(moves) {
    if (!Array.isArray(moves) || moves.length === 0) return;
    store.movePathHashes(moves);
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
                label: '撤销最近操作',
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
    
    if (oldImageTags && Object.keys(oldImageTags).length > 0) {
        console.log('Migrating old image tags to hash-based storage...');
        const newPathToHash = {};
        
        for (const imagePath in oldImageTags) {
            try {
                if (fs.existsSync(imagePath)) {
                    // Consolidate old path-based data first; ImageLibrary
                    // then upgrades both tags and scores to the full hash.
                    const hash = calculateLegacyFileHashSync(imagePath);
                    const stats = fs.statSync(imagePath);
                    newPathToHash[imagePath] = {
                        hash,
                        size: stats.size,
                        mtimeMs: stats.mtimeMs
                    };
                    (Array.isArray(oldImageTags[imagePath]) ? oldImageTags[imagePath] : [])
                        .forEach(tag => store.addImageTag(hash, tag));
                }
            } catch (err) {
                console.error('Failed to migrate tags for:', imagePath, err.message);
            }
        }
        
        store.setPathHashes(newPathToHash);
        store.delete('imageTags');
        console.log('Migration completed.');
    }
}

app.whenReady().then(() => {
    if (!gotSingleInstanceLock) {
        return;
    }

    store = new Store(storePath, { legacyFilePath: legacyStorePath });
    migrateOldData();
    const imageLibrary = createImageLibrary({
        store,
        nativeImage,
        thumbnailCacheDir,
        fsp,
        path
    });
    const imageFileOperations = createImageFileOperations({
        fsp,
        path,
        fileOperations,
        mapWithConcurrency,
        trashItem: filePath => shell.trashItem(filePath),
        moveHashMappings,
        listImageEntries: directory => imageLibrary.listEntries(directory)
    });
    ipcServices = registerIpcHandlers({
        ipcMain,
        dialog,
        shell,
        nativeImage,
        clipboard,
        path,
        fsp,
        getMainWindow: () => mainWindow,
        store,
        imageLibrary,
        imageFileOperations,
        fileOperations,
        getServerDownloadDirectory: () => path.join(app.getPath('userData'), 'server-downloads')
    });
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

app.on('before-quit', (event) => {
    if (isQuittingAfterFileOperations) return;

    event.preventDefault();
    if (fileOperationQuitStarted) return;
    fileOperationQuitStarted = true;

    Promise.resolve(ipcServices?.flushPendingWaterfallCleanup?.())
        .then(result => {
            if (result?.failures?.length > 0) console.error('Failed to commit retained waterfall pages:', result.failures);
        })
        .catch(error => console.error('Error waiting for waterfall file operations:', error))
        .finally(() => {
            isQuittingAfterFileOperations = true;
            app.quit();
        });
});

app.on('will-quit', () => {
    if (store) {
        store.close();
    }
});

ipcMain.handle('renderer-ready', () => {
    rendererReady = true;
    flushPendingOpenImages();
    return true;
});
