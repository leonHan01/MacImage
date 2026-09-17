function registerConfigHandlers({ ipcMain, store, dialog, getMainWindow, fsp }) {
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
                return { success: true, imageScoresByHash: store.getAllImageScores() };
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
}

module.exports = registerConfigHandlers;
