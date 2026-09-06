(function exposeSmallImageUtils(root, factory) {
    const smallImageUtils = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = smallImageUtils;
        return;
    }

    root.MacImageSmallImageUtils = smallImageUtils;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    const MAX_THRESHOLD_KB = 300;
    const DEFAULT_THRESHOLD_KB = 100;

    function parseThresholdKb(value) {
        const thresholdKb = Number(value);
        if (!Number.isFinite(thresholdKb) || thresholdKb <= 0 || thresholdKb > MAX_THRESHOLD_KB) {
            return null;
        }
        return thresholdKb;
    }

    function normalizeThresholdKb(value, fallback = DEFAULT_THRESHOLD_KB) {
        return parseThresholdKb(value) ?? fallback;
    }

    function findImagesBelowSize(images, thresholdKb) {
        const validThresholdKb = parseThresholdKb(thresholdKb);
        if (validThresholdKb === null) return [];

        const limitBytes = validThresholdKb * 1024;
        return (Array.isArray(images) ? images : [])
            .filter(image => image && Number.isFinite(image.size) && image.size < limitBytes)
            .sort((first, second) => first.size - second.size || String(first.name).localeCompare(String(second.name), 'zh-Hans-CN'));
    }

    return Object.freeze({
        MAX_THRESHOLD_KB,
        DEFAULT_THRESHOLD_KB,
        parseThresholdKb,
        normalizeThresholdKb,
        findImagesBelowSize
    });
}));
