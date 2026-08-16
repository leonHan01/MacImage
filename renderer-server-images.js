async function loadServerImages() {
    const countInput = document.getElementById('serverImageCountInput');
    const button = document.getElementById('loadServerImagesBtn');
    const status = document.getElementById('serverImageLoadStatus');
    const progress = document.getElementById('serverImageDownloadProgress');
    const count = Number(countInput?.value);

    if (!Number.isInteger(count) || count < 1 || count > 1000) {
        status.textContent = '请输入 1 到 1000 的整数';
        return;
    }

    button.disabled = true;
    progress.hidden = false;
    progress.max = count;
    progress.value = 0;
    status.textContent = `正在下载 ${count} 张图片…`;

    try {
        const result = await window.electronAPI.downloadServerImages(count);
        if (!result.success) {
            throw new Error(result.error || '没有图片下载成功');
        }

        await loadFolder(result.downloadDirectory);
        const deletionMessage = result.deletionError
            ? `，但服务端删除失败：${result.deletionError}`
            : `，服务端已删除 ${result.deletedCount} 张`;
        const failureMessage = result.failures?.length
            ? `，${result.failures.length} 张下载失败`
            : '';
        status.textContent = `已下载 ${result.downloadedCount} 张${deletionMessage}${failureMessage}`;
    } catch (error) {
        status.textContent = `加载失败：${error.message}`;
    } finally {
        button.disabled = false;
    }
}

window.electronAPI.onServerImageDownloadProgress((progressInfo) => {
    const progress = document.getElementById('serverImageDownloadProgress');
    const status = document.getElementById('serverImageLoadStatus');
    if (progress.hidden) return;

    progress.max = progressInfo.total || 1;
    progress.value = progressInfo.completed || 0;

    if (progressInfo.stage === 'deleting') {
        status.textContent = `下载完成，正在删除服务端 ${progressInfo.succeeded} 张图片…`;
        return;
    }
    if (progressInfo.stage === 'delete-failed') {
        status.textContent = `下载完成，但服务端删除失败`;
        return;
    }
    if (progressInfo.stage === 'completed') {
        return;
    }
    status.textContent = `正在下载：${progressInfo.completed}/${progressInfo.total}（成功 ${progressInfo.succeeded}，失败 ${progressInfo.failed}）`;
});
