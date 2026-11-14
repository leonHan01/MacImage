let waterfallFullscreenRequested = false;
let waterfallFullscreenTransition = false;
let isWaterfallFullscreen = false;

function renderWaterfallFullscreenButton() {
    return `
        <button type="button" class="waterfall-config-btn waterfall-fullscreen-btn"
            data-waterfall-action="fullscreen" aria-pressed="${isWaterfallFullscreen}"
            title="${isWaterfallFullscreen ? '退出全屏（Esc / F）' : '沉浸式全屏评分（F）'}"
            ${waterfallFullscreenTransition ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"></path>
            </svg>
            <span>${isWaterfallFullscreen ? '退出全屏' : '全屏'}</span>
        </button>
    `;
}

function syncWaterfallFullscreen() {
    const hasFullscreen = document.fullscreenElement === document.documentElement;
    if (!hasFullscreen && !waterfallFullscreenTransition) waterfallFullscreenRequested = false;
    isWaterfallFullscreen = hasFullscreen && waterfallFullscreenRequested && currentViewMode === 'waterfall';
    document.body.classList.toggle('waterfall-fullscreen', isWaterfallFullscreen);
    document.querySelectorAll('[data-waterfall-action="fullscreen"]').forEach(button => {
        button.setAttribute('aria-pressed', String(isWaterfallFullscreen));
        button.title = isWaterfallFullscreen ? '退出全屏（Esc / F）' : '沉浸式全屏评分（F）';
        button.querySelector('span').textContent = isWaterfallFullscreen ? '退出全屏' : '全屏';
        button.disabled = waterfallFullscreenTransition;
    });
}

function toggleWaterfallFullscreen() {
    if (currentViewMode !== 'waterfall' || waterfallFullscreenTransition) return;
    return setWaterfallFullscreen(!isWaterfallFullscreen);
}

function exitWaterfallFullscreen() {
    if (!waterfallFullscreenRequested && !isWaterfallFullscreen) return;
    return setWaterfallFullscreen(false);
}

async function setWaterfallFullscreen(enabled) {
    waterfallFullscreenRequested = enabled;
    // A view change can cancel entry while the native fullscreen animation is pending.
    if (waterfallFullscreenTransition) return;
    waterfallFullscreenTransition = true;
    syncWaterfallFullscreen();
    try {
        if (enabled) {
            // Fullscreen the document so image previews and settings stay accessible.
            await document.documentElement.requestFullscreen();
            if (!waterfallFullscreenRequested || currentViewMode !== 'waterfall') {
                if (document.fullscreenElement === document.documentElement) await document.exitFullscreen();
            }
        } else if (document.fullscreenElement === document.documentElement) {
            await document.exitFullscreen();
        }
    } catch (error) {
        waterfallFullscreenRequested = document.fullscreenElement === document.documentElement;
        alert(`无法${enabled ? '进入' : '退出'}全屏：${error.message || error}`);
    } finally {
        waterfallFullscreenTransition = false;
        syncWaterfallFullscreen();
    }
}
