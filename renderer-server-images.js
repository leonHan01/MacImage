async function loadServerImages() {
    const countInput = document.getElementById('serverImageCountInput');
    const button = document.getElementById('loadServerImagesBtn');
    const status = document.getElementById('serverImageLoadStatus');
    const count = Number(countInput?.value);

    if (!Number.isInteger(count) || count < 1 || count > 1000) {
        status.textContent = '请输入 1 到 1000 的整数';
        return;
    }

    button.disabled = true;
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
