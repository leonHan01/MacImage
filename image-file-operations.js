const DEFAULT_CONCURRENCY = 6;

function createImageFileOperations(deps) {
    const {
        fsp,
        path,
        fileOperations,
        mapWithConcurrency,
        moveHashMappings = () => {},
        listImageEntries = async () => [],
        now = Date.now,
        concurrency = DEFAULT_CONCURRENCY
    } = deps;
    const {
        reserveAvailablePath,
        getTimestampedPath,
        getNumberedPath,
        pathExists,
        moveFileSafely
    } = fileOperations;

    async function moveMany(sourcePaths, targetFolder) {
        const paths = normalizePaths(sourcePaths);
        const result = { moved: [], failures: [] };
        if (paths.length === 0) return result;
        if (typeof targetFolder !== 'string' || !targetFolder) {
            return {
                moved: [],
                failures: paths.map(sourcePath => ({
                    path: sourcePath,
                    file: path.basename(sourcePath),
                    error: '目标文件夹无效'
                }))
            };
        }

        await fsp.mkdir(targetFolder, { recursive: true });
        const hashMoves = [];
        const groups = groupPathsByFileName(paths);
        await mapWithConcurrency(groups, concurrency, async (pathsWithSameName) => {
            for (const sourcePath of pathsWithSameName) {
                const moveResult = await moveOneToFolder(sourcePath, targetFolder);
                if (moveResult.success) {
                    result.moved.push(moveResult.item);
                    hashMoves.push({ fromPath: sourcePath, toPath: moveResult.item.targetPath });
                } else {
                    result.failures.push(moveResult.failure);
                }
            }
        });
        moveHashMappings(hashMoves);
        return result;
    }

    async function moveOne(sourcePath, targetFolder) {
        if (typeof sourcePath !== 'string' || !sourcePath || typeof targetFolder !== 'string' || !targetFolder) {
            return { success: false, error: '图片路径或目标文件夹无效' };
        }
        if (path.resolve(path.dirname(sourcePath)) === path.resolve(targetFolder)) {
            return { success: true, moved: false, path: sourcePath };
        }

        const result = await moveMany([sourcePath], targetFolder);
        if (result.moved.length === 0) {
            return { success: false, error: result.failures[0]?.error || '移动图片失败' };
        }
        return { success: true, moved: true, path: result.moved[0].targetPath };
    }

    async function trashMany(sourcePaths, trashFolder) {
        const paths = normalizePaths(sourcePaths);
        const result = { deleted: [], failures: [] };
        if (paths.length === 0) return result;
        if (typeof trashFolder !== 'string' || !trashFolder) {
            return {
                deleted: [],
                failures: paths.map(sourcePath => ({
                    path: sourcePath,
                    action: 'delete',
                    error: '未设置回收站文件夹'
                }))
            };
        }

        await fsp.mkdir(trashFolder, { recursive: true });
        const batchTimestamp = now();
        const results = await mapWithConcurrency(paths, concurrency, async (sourcePath, index) => {
            const fileName = path.basename(sourcePath);
            const ext = path.extname(fileName);
            const baseName = path.basename(fileName, ext);
            const preferredPath = path.join(trashFolder, `${baseName}_${batchTimestamp}_${index}${ext}`);
            try {
                const trashPath = await reserveAvailablePath(
                    preferredPath,
                    counter => path.join(trashFolder, `${baseName}_${batchTimestamp}_${index}_${counter}${ext}`)
                );
                await moveFileSafely(sourcePath, trashPath);
                return {
                    success: true,
                    originalPath: sourcePath,
                    trashPath,
                    fileName
                };
            } catch (error) {
                return {
                    success: false,
                    path: sourcePath,
                    originalPath: sourcePath,
                    fileName,
                    action: 'delete',
                    error: error.message
                };
            }
        });

        result.deleted = results.filter(item => item.success).map(({ success, ...item }) => item);
        result.failures = results.filter(item => !item.success).map(({ success, ...item }) => item);
        moveHashMappings(result.deleted.map(item => ({
            fromPath: item.originalPath,
            toPath: item.trashPath
        })));
        return result;
    }

    async function trashOne(sourcePath, trashFolder) {
        if (typeof sourcePath !== 'string' || !sourcePath || typeof trashFolder !== 'string' || !trashFolder) {
            return { success: false, error: '图片路径或回收站文件夹无效' };
        }

        await fsp.mkdir(trashFolder, { recursive: true });
        const fileName = path.basename(sourcePath);
        try {
            const trashPath = await getTimestampedPath(path.join(trashFolder, fileName));
            await moveFileSafely(sourcePath, trashPath);
            moveHashMappings([{ fromPath: sourcePath, toPath: trashPath }]);
            return { success: true, originalPath: sourcePath, trashPath, fileName };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async function restore({ sourcePath, originalPath, missingSourceError = '找不到待撤销的文件' }) {
        if (typeof sourcePath !== 'string' || typeof originalPath !== 'string') {
            return { success: false, error: '撤销操作的文件路径无效' };
        }
        if (!(await pathExists(sourcePath))) {
            return { success: false, error: missingSourceError };
        }

        const originalDir = path.dirname(originalPath);
        if (!(await pathExists(originalDir))) {
            return { success: false, error: '原始目录不存在' };
        }

        const restoreTimestamp = now();
        const restorePath = await reserveAvailablePath(originalPath, (counter) => {
            const ext = path.extname(originalPath);
            const baseName = path.basename(originalPath, ext);
            return path.join(originalDir, `${baseName}_restored_${restoreTimestamp}_${counter}${ext}`);
        });
        await moveFileSafely(sourcePath, restorePath);
        moveHashMappings([{ fromPath: sourcePath, toPath: restorePath }]);
        return { success: true, restoredPath: restorePath, originalPath };
    }

    async function inspectTrash(trashFolder) {
        if (!trashFolder || !(await pathExists(trashFolder))) {
            return { count: 0, size: 0, path: trashFolder || null };
        }

        const imageEntries = await listImageEntries(trashFolder);
        const stats = await mapWithConcurrency(imageEntries, concurrency, entry => (
            fsp.stat(path.join(trashFolder, entry.name))
        ));
        return {
            count: stats.length,
            size: stats.reduce((total, entryStats) => total + entryStats.size, 0),
            path: trashFolder
        };
    }

    async function emptyTrash(trashFolder) {
        if (!trashFolder || !(await pathExists(trashFolder))) {
            return { success: false, error: '回收站文件夹不存在' };
        }

        const imageEntries = await listImageEntries(trashFolder);
        await mapWithConcurrency(imageEntries, concurrency, entry => (
            fsp.unlink(path.join(trashFolder, entry.name))
        ));
        return { success: true, deletedCount: imageEntries.length };
    }

    async function moveOneToFolder(sourcePath, targetFolder) {
        const file = path.basename(sourcePath);
        try {
            if (!(await pathExists(sourcePath))) throw new Error('源文件不存在');
            const targetPath = await getNumberedPath(path.join(targetFolder, file));
            await moveFileSafely(sourcePath, targetPath);
            return {
                success: true,
                item: { originalPath: sourcePath, targetPath }
            };
        } catch (error) {
            return {
                success: false,
                failure: { path: sourcePath, file, error: error.message }
            };
        }
    }

    function groupPathsByFileName(sourcePaths) {
        const groups = new Map();
        sourcePaths.forEach((sourcePath) => {
            const fileName = path.basename(sourcePath);
            if (!groups.has(fileName)) groups.set(fileName, []);
            groups.get(fileName).push(sourcePath);
        });
        return [...groups.values()];
    }

    return Object.freeze({
        moveMany,
        moveOne,
        trashOne,
        trashMany,
        restore,
        inspectTrash,
        emptyTrash
    });
}

function normalizePaths(paths) {
    return [...new Set((Array.isArray(paths) ? paths : [paths])
        .filter(filePath => typeof filePath === 'string' && filePath))];
}

module.exports = { createImageFileOperations };
