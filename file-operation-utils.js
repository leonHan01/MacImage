const fs = require('node:fs');
const pathModule = require('node:path');
const { randomUUID } = require('node:crypto');

function createFileOperationUtils({
    fsp = fs.promises,
    path = pathModule,
    rename = fsp.rename.bind(fsp),
    copyFile = fsp.copyFile.bind(fsp),
    unlink = fsp.unlink.bind(fsp),
    createId = randomUUID
} = {}) {
    async function removeFileIfExists(filePath) {
        try {
            await unlink(filePath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    async function pathExists(filePath) {
        try {
            await fsp.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async function getAvailablePath(filePath, buildCandidate) {
        if (!(await pathExists(filePath))) return filePath;

        let counter = 1;
        let candidate = buildCandidate(counter);
        while (await pathExists(candidate)) {
            candidate = buildCandidate(++counter);
        }
        return candidate;
    }

    async function reserveAvailablePath(filePath, buildCandidate) {
        let counter = 1;
        let candidate = filePath;

        while (true) {
            try {
                const handle = await fsp.open(candidate, 'wx');
                await handle.close();
                return candidate;
            } catch (error) {
                if (!['EEXIST', 'EISDIR'].includes(error.code)) throw error;
                candidate = buildCandidate(counter++);
            }
        }
    }

    async function moveFileSafely(sourcePath, targetPath) {
        try {
            await rename(sourcePath, targetPath);
            return targetPath;
        } catch (error) {
            if (error.code !== 'EXDEV') {
                await removeFileIfExists(targetPath);
                throw error;
            }
        }

        const temporaryPath = path.join(
            path.dirname(targetPath),
            `.${path.basename(targetPath)}.${createId()}.partial`
        );

        try {
            await copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
            await rename(temporaryPath, targetPath);
            await unlink(sourcePath);
            return targetPath;
        } catch (error) {
            await removeFileIfExists(temporaryPath);
            await removeFileIfExists(targetPath);
            throw error;
        }
    }

    async function getTimestampedPath(filePath) {
        const timestamp = Date.now();
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        return reserveAvailablePath(filePath, (counter) => (
            path.join(path.dirname(filePath), `${baseName}_${timestamp}_${counter}${ext}`)
        ));
    }

    async function getNumberedPath(filePath) {
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        return reserveAvailablePath(filePath, (counter) => (
            path.join(path.dirname(filePath), `${baseName}_${counter}${ext}`)
        ));
    }

    return {
        reserveAvailablePath,
        moveFileSafely,
        getTimestampedPath,
        getNumberedPath,
        getAvailablePath,
        pathExists
    };
}

module.exports = { createFileOperationUtils };
