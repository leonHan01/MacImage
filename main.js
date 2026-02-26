const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./store');
const { calculateFileHashSync } = require('./hashUtils');

let mainWindow;
let store;

const storePath = path.join(app.getPath('userData'), 'config.json');

function createWindow() {
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

    createMenu();
}

function createMenu() {
    const template = [
        {
            label: '文件',
            submenu: [
                {
                    label: '打开文件夹',
                    accelerator: 'Cmd+O',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openDirectory']
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send('open-folder', result.filePaths[0]);
                        }
                    }
                },
                {
                    label: '设置回收站文件夹',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openDirectory', 'createDirectory']
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            store.set('trashFolder', result.filePaths[0]);
                            mainWindow.webContents.send('trash-folder-changed', result.filePaths[0]);
                        }
                    }
                },
                { type: 'separator' },
                { role: 'quit', label: '退出' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                {
                    label: '撤销删除',
                    accelerator: 'Cmd+Z',
                    click: () => {
                        mainWindow.webContents.send('undo-delete');
                    }
                }
            ]
        },
        {
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
        },
        {
            label: '窗口',
            submenu: [
                { role: 'minimize', label: '最小化' },
                { role: 'close', label: '关闭' }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

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

app.whenReady().then(() => {
    store = new Store(storePath);
    migrateOldData();
    createWindow();

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

ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

ipcMain.handle('open-trash-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        store.set('trashFolder', result.filePaths[0]);
        return result.filePaths[0];
    }
    return null;
});

ipcMain.handle('get-trash-folder', () => {
    return store.get('trashFolder') || null;
});

ipcMain.handle('set-trash-folder', (event, folderPath) => {
    store.set('trashFolder', folderPath);
    return true;
});

ipcMain.handle('read-directory', async (event, dirPath) => {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.heic', '.heif'];
    const images = [];
    const pathToHash = store.get('pathToHash') || {};
    const imageTagsByHash = store.get('imageTagsByHash') || {};
    const updatedPathToHash = {};
    
    try {
        const files = fs.readdirSync(dirPath);
        
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (imageExtensions.includes(ext)) {
                const fullPath = path.join(dirPath, file);
                const stats = fs.statSync(fullPath);
                
                let hash = pathToHash[fullPath];
                let needsHashCalc = !hash;
                
                if (needsHashCalc) {
                    try {
                        hash = calculateFileHashSync(fullPath);
                    } catch (err) {
                        console.error('Failed to calculate hash for:', fullPath, err.message);
                        hash = null;
                    }
                }
                
                if (hash) {
                    updatedPathToHash[fullPath] = hash;
                }
                
                const tags = hash ? (imageTagsByHash[hash] || []) : [];
                
                images.push({
                    name: file,
                    path: fullPath,
                    size: stats.size,
                    modifiedTime: stats.mtime,
                    hash: hash,
                    tags: tags
                });
            }
        }
        
        store.set('pathToHash', { ...pathToHash, ...updatedPathToHash });
        
        return images;
    } catch (error) {
        console.error('Error reading directory:', error);
        return [];
    }
});

ipcMain.handle('get-tags', () => {
    return store.get('tags') || [];
});

ipcMain.handle('save-tags', (event, tags) => {
    store.set('tags', tags);
    return true;
});

ipcMain.handle('get-image-tags', () => {
    return {
        imageTagsByHash: store.get('imageTagsByHash') || {},
        pathToHash: store.get('pathToHash') || {}
    };
});

ipcMain.handle('save-image-tags', (event, data) => {
    if (data.imageTagsByHash) {
        store.set('imageTagsByHash', data.imageTagsByHash);
    }
    if (data.pathToHash) {
        store.set('pathToHash', data.pathToHash);
    }
    return true;
});

ipcMain.handle('get-image-hash', (event, imagePath) => {
    try {
        const hash = calculateFileHashSync(imagePath);
        const pathToHash = store.get('pathToHash') || {};
        pathToHash[imagePath] = hash;
        store.set('pathToHash', pathToHash);
        return hash;
    } catch (err) {
        console.error('Failed to calculate hash:', err.message);
        return null;
    }
});

ipcMain.handle('add-tag-to-image', async (event, imagePath, tag) => {
    const pathToHash = store.get('pathToHash') || {};
    const imageTagsByHash = store.get('imageTagsByHash') || {};
    
    let hash = pathToHash[imagePath];
    if (!hash) {
        try {
            hash = calculateFileHashSync(imagePath);
            pathToHash[imagePath] = hash;
            store.set('pathToHash', pathToHash);
        } catch (err) {
            console.error('Failed to calculate hash:', err.message);
            return [];
        }
    }
    
    if (!imageTagsByHash[hash]) {
        imageTagsByHash[hash] = [];
    }
    if (!imageTagsByHash[hash].includes(tag)) {
        imageTagsByHash[hash].push(tag);
    }
    store.set('imageTagsByHash', imageTagsByHash);
    
    return imageTagsByHash[hash];
});

ipcMain.handle('remove-tag-from-image', (event, imagePath, tag) => {
    const pathToHash = store.get('pathToHash') || {};
    const imageTagsByHash = store.get('imageTagsByHash') || {};
    
    const hash = pathToHash[imagePath];
    if (!hash) {
        return [];
    }
    
    if (imageTagsByHash[hash]) {
        imageTagsByHash[hash] = imageTagsByHash[hash].filter(t => t !== tag);
        if (imageTagsByHash[hash].length === 0) {
            delete imageTagsByHash[hash];
        }
        store.set('imageTagsByHash', imageTagsByHash);
    }
    
    return imageTagsByHash[hash] || [];
});

ipcMain.handle('delete-image', async (event, imagePath) => {
    const trashFolder = store.get('trashFolder');
    
    if (!trashFolder) {
        return { success: false, error: '未设置回收站文件夹' };
    }

    try {
        if (!fs.existsSync(trashFolder)) {
            fs.mkdirSync(trashFolder, { recursive: true });
        }

        const fileName = path.basename(imagePath);
        let destPath = path.join(trashFolder, fileName);
        
        if (fs.existsSync(destPath)) {
            const ext = path.extname(fileName);
            const baseName = path.basename(fileName, ext);
            const timestamp = Date.now();
            destPath = path.join(trashFolder, `${baseName}_${timestamp}${ext}`);
        }

        fs.renameSync(imagePath, destPath);

        const pathToHash = store.get('pathToHash') || {};
        const hash = pathToHash[imagePath];
        if (hash) {
            delete pathToHash[imagePath];
            pathToHash[destPath] = hash;
            store.set('pathToHash', pathToHash);
        }

        return { 
            success: true, 
            originalPath: imagePath, 
            trashPath: destPath,
            fileName: fileName
        };
    } catch (error) {
        console.error('Error deleting image:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('undo-delete', async (event, trashPath, originalPath) => {
    try {
        if (!fs.existsSync(trashPath)) {
            return { success: false, error: '回收站中找不到该文件' };
        }

        const originalDir = path.dirname(originalPath);
        if (!fs.existsSync(originalDir)) {
            return { success: false, error: '原始目录不存在' };
        }

        let restorePath = originalPath;
        if (fs.existsSync(originalPath)) {
            const ext = path.extname(originalPath);
            const baseName = path.basename(originalPath, ext);
            const timestamp = Date.now();
            restorePath = path.join(originalDir, `${baseName}_restored_${timestamp}${ext}`);
        }

        fs.renameSync(trashPath, restorePath);

        const pathToHash = store.get('pathToHash') || {};
        const hash = pathToHash[trashPath];
        if (hash) {
            delete pathToHash[trashPath];
            pathToHash[restorePath] = hash;
            store.set('pathToHash', pathToHash);
        }

        return { 
            success: true, 
            restoredPath: restorePath,
            originalPath: originalPath
        };
    } catch (error) {
        console.error('Error undoing delete:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('show-in-folder', (event, filePath) => {
    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
    return true;
});

ipcMain.handle('get-password', () => {
    return store.get('password') || 'hanqi452+1s';
});

ipcMain.handle('set-password', (event, newPassword) => {
    store.set('password', newPassword);
    return true;
});

ipcMain.handle('verify-password', (event, inputPassword) => {
    const savedPassword = store.get('password') || 'hanqi452+1s';
    return inputPassword === savedPassword;
});

ipcMain.handle('get-timeout', () => {
    return store.get('lockTimeout') || 5;
});

ipcMain.handle('set-timeout', (event, timeout) => {
    store.set('lockTimeout', timeout);
    return true;
});

ipcMain.handle('get-categories', () => {
    return store.get('categories') || null;
});

ipcMain.handle('save-categories', (event, categories) => {
    store.set('categories', categories);
    return true;
});

ipcMain.handle('get-trash-info', async () => {
    const trashFolder = store.get('trashFolder');
    
    if (!trashFolder || !fs.existsSync(trashFolder)) {
        return { count: 0, size: 0, path: trashFolder };
    }
    
    try {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.heic', '.heif'];
        let count = 0;
        let totalSize = 0;
        
        const files = fs.readdirSync(trashFolder);
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (imageExtensions.includes(ext)) {
                const filePath = path.join(trashFolder, file);
                const stats = fs.statSync(filePath);
                count++;
                totalSize += stats.size;
            }
        }
        
        return { count, size: totalSize, path: trashFolder };
    } catch (error) {
        console.error('Error getting trash info:', error);
        return { count: 0, size: 0, path: trashFolder };
    }
});

ipcMain.handle('empty-trash', async () => {
    const trashFolder = store.get('trashFolder');
    
    if (!trashFolder || !fs.existsSync(trashFolder)) {
        return { success: false, error: '回收站文件夹不存在' };
    }
    
    try {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.heic', '.heif'];
        const files = fs.readdirSync(trashFolder);
        let deletedCount = 0;
        
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (imageExtensions.includes(ext)) {
                const filePath = path.join(trashFolder, file);
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        }
        
        return { success: true, deletedCount };
    } catch (error) {
        console.error('Error emptying trash:', error);
        return { success: false, error: error.message };
    }
});
