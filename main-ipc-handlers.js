const registerFileOperationHandlers = require('./main-ipc-file-operations');
const registerImageLibraryHandlers = require('./main-ipc-image-library');
const registerServerImageHandlers = require('./main-ipc-server-images');

function registerIpcHandlers(deps) {
    const {
        ipcMain,
        dialog,
        shell,
        path,
        fsp,
        getMainWindow,
        store,
        imageLibrary,
        imageFileOperations,
        fileOperations,
        getServerDownloadDirectory
    } = deps;

    const {
        getAvailablePath
    } = fileOperations;

    registerServerImageHandlers({
        ipcMain,
        dialog,
        path,
        fsp,
        getMainWindow,
        store,
        getAvailablePath,
        getServerDownloadDirectory,
        selectDirectory
    });
    const fileOperationServices = registerFileOperationHandlers({
        ipcMain,
        path,
        store,
        imageFileOperations
    });
    registerImageLibraryHandlers({
        ipcMain,
        store,
        imageLibrary
    });

    ipcMain.handle('open-folder-dialog', async () => {
        const result = await dialog.showOpenDialog(getMainWindow(), {
            properties: ['openDirectory']
        });
        return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null;
    });

    ipcMain.handle('open-trash-folder-dialog', async () => {
        const result = await dialog.showOpenDialog(getMainWindow(), {
            properties: ['openDirectory', 'createDirectory']
        });
        if (!result.canceled && result.filePaths.length > 0) {
            store.set('trashFolder', result.filePaths[0]);
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('get-trash-folder', () => store.get('trashFolder') || null);

    ipcMain.handle('set-trash-folder', (event, folderPath) => {
        store.set('trashFolder', folderPath);
        return true;
    });

    ipcMain.handle('directory-exists', async (event, folderPath) => {
        try {
            const stats = await fsp.stat(folderPath);
            return stats.isDirectory();
        } catch {
            return false;
        }
    });

    ipcMain.handle('file-exists', async (event, filePath) => {
        try {
            const stats = await fsp.stat(filePath);
            return stats.isFile();
        } catch {
            return false;
        }
    });

    ipcMain.handle('delete-image', async (event, imagePath) => {
        const trashFolder = store.get('trashFolder');
        if (!trashFolder) return { success: false, error: '未设置回收站文件夹' };

        try {
            return await imageFileOperations.trashOne(imagePath, trashFolder);
        } catch (error) {
            console.error('Error deleting image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('delete-images', async (event, imagePaths) => {
        const trashFolder = store.get('trashFolder');
        if (!trashFolder) return { success: false, error: '未设置回收站文件夹', deleted: [], failures: [] };

        try {
            return { success: true, ...await imageFileOperations.trashMany(imagePaths, trashFolder) };
        } catch (error) {
            console.error('Error deleting images:', error);
            return { success: false, error: error.message, deleted: [], failures: [] };
        }
    });

    ipcMain.handle('undo-delete', async (event, trashPath, originalPath) => {
        try {
            return await imageFileOperations.restore({
                sourcePath: trashPath,
                originalPath,
                missingSourceError: '回收站中找不到该文件'
            });
        } catch (error) {
            console.error('Error undoing delete:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('undo-file-operation', async (event, operation) => {
        const kind = operation?.kind;
        const sourcePath = kind === 'move' ? operation.targetPath : operation?.trashPath;
        if (!['delete', 'move'].includes(kind)) {
            return { success: false, error: '无法识别的撤销操作' };
        }

        try {
            return await imageFileOperations.restore({
                sourcePath,
                originalPath: operation.originalPath,
                missingSourceError: '找不到待撤销的文件'
            });
        } catch (error) {
            console.error('Error undoing file operation:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('show-in-folder', (event, filePath) => {
        shell.showItemInFolder(filePath);
        return true;
    });

    ipcMain.handle('open-folder-path', async (event, folderPath) => {
        try {
            const stats = await fsp.stat(folderPath);
            if (!stats.isDirectory()) {
                return { success: false, error: '路径不是文件夹' };
            }

            const errorMessage = await shell.openPath(folderPath);
            return errorMessage
                ? { success: false, error: errorMessage }
                : { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-categories', () => store.get('categories') || null);

    ipcMain.handle('save-categories', (event, categories) => {
        store.set('categories', categories);
        return true;
    });

    ipcMain.handle('get-quick-open-folders', () => store.get('quickOpenFolders') || null);

    ipcMain.handle('save-quick-open-folders', (event, folders) => {
        store.set('quickOpenFolders', folders);
        return true;
    });

    ipcMain.handle('get-recent-open-files', () => store.get('recentOpenFiles') || []);

    ipcMain.handle('save-recent-open-files', (event, files) => {
        store.set('recentOpenFiles', Array.isArray(files) ? files : []);
        return true;
    });

    ipcMain.handle('get-trash-info', async () => {
        const trashFolder = store.get('trashFolder');
        try {
            return await imageFileOperations.inspectTrash(trashFolder);
        } catch (error) {
            console.error('Error getting trash info:', error);
            return { count: 0, size: 0, path: trashFolder };
        }
    });

    ipcMain.handle('empty-trash', async () => {
        const trashFolder = store.get('trashFolder');
        try {
            return await imageFileOperations.emptyTrash(trashFolder);
        } catch (error) {
            console.error('Error emptying trash:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('export-config', async () => {
        try {
            return {
                success: true,
                config: {
                    tags: store.get('tags') || [],
                    categories: store.get('categories') || null,
                    imageScoresByHash: store.getAllImageScores(),
                    exportTime: new Date().toISOString(),
                    version: '1.0'
                }
            };
        } catch (error) {
            console.error('Error exporting config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('import-config', async (event, config) => {
        try {
            if (!config || typeof config !== 'object') {
                return { success: false, error: '无效的配置数据' };
            }

            const updates = {};
            if (config.tags && Array.isArray(config.tags)) updates.tags = config.tags;
            if (config.categories && Array.isArray(config.categories)) updates.categories = config.categories;
            if (Object.keys(updates).length > 0) store.setMany(updates);
            if (config.imageScoresByHash && typeof config.imageScoresByHash === 'object') {
                store.replaceImageScores(config.imageScoresByHash);
            }
            return { success: true };
        } catch (error) {
            console.error('Error importing config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('save-export-file', async (event, config) => {
        try {
            const { filePath } = await dialog.showSaveDialog(getMainWindow(), {
                title: '导出配置',
                defaultPath: `macimage-config-${Date.now()}.json`,
                filters: [{ name: 'JSON', extensions: ['json'] }]
            });

            if (!filePath) return { success: false, cancelled: true };
            await fsp.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
            return { success: true, filePath };
        } catch (error) {
            console.error('Error saving export file:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('open-import-file', async () => {
        try {
            const { filePaths } = await dialog.showOpenDialog(getMainWindow(), {
                title: '导入配置',
                filters: [{ name: 'JSON', extensions: ['json'] }],
                properties: ['openFile']
            });

            if (!filePaths || filePaths.length === 0) return { success: false, cancelled: true };
            const content = await fsp.readFile(filePaths[0], 'utf-8');
            return { success: true, config: JSON.parse(content) };
        } catch (error) {
            console.error('Error opening import file:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('select-migrate-folder', async () => {
        return selectDirectory(dialog, getMainWindow(), '选择目标文件夹', 'Error selecting migrate folder:');
    });

    ipcMain.handle('select-quick-open-folder', async () => {
        return selectDirectory(dialog, getMainWindow(), '选择快捷打开目录', 'Error selecting quick open folder:');
    });

    return fileOperationServices;
}

async function selectDirectory(dialog, mainWindow, title, logPrefix) {
    try {
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title,
            properties: ['openDirectory', 'createDirectory']
        });
        return !filePaths || filePaths.length === 0
            ? { success: false, cancelled: true }
            : { success: true, path: filePaths[0] };
    } catch (error) {
        console.error(logPrefix, error);
        return { success: false, error: error.message };
    }
}

module.exports = registerIpcHandlers;
