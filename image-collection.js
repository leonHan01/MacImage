(function exposeImageCollection(root, factory) {
    const imageCollection = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = imageCollection;
        return;
    }

    root.MacImageCollection = imageCollection;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    function create(initialImages = []) {
        const items = [];
        const tagsByHash = Object.create(null);
        const scoresByHash = Object.create(null);

        function replace(nextImages) {
            items.splice(0, items.length, ...normalizeImages(nextImages));
            rebuildMetadataIndexes();
            return items;
        }

        function remove(paths) {
            const pathsToRemove = new Set(normalizePaths(paths));
            if (pathsToRemove.size === 0) return [];

            const removed = [];
            for (let index = items.length - 1; index >= 0; index--) {
                if (!pathsToRemove.has(items[index].path)) continue;
                removed.unshift(...items.splice(index, 1));
            }
            rebuildMetadataIndexes();
            return removed;
        }

        function prepend(nextImages) {
            const existingPaths = new Set(items.map(image => image.path));
            const additions = normalizeImages(nextImages).filter((image) => {
                if (existingPaths.has(image.path)) return false;
                existingPaths.add(image.path);
                return true;
            });
            if (additions.length === 0) return [];

            items.unshift(...additions);
            rebuildMetadataIndexes();
            return additions;
        }

        function applyMetadata(updates) {
            const imagesByPath = new Map(items.map(image => [image.path, image]));
            let changedCount = 0;

            (Array.isArray(updates) ? updates : [updates]).forEach((update) => {
                if (!update || typeof update.path !== 'string') return;
                const image = imagesByPath.get(update.path);
                if (!image) return;

                if (Object.prototype.hasOwnProperty.call(update, 'hash')) {
                    image.hash = update.hash || null;
                }
                const matchingImages = image.hash
                    ? items.filter(candidate => candidate.hash === image.hash)
                    : [image];
                if (Object.prototype.hasOwnProperty.call(update, 'tags')) {
                    const tags = Array.isArray(update.tags) ? [...update.tags] : [];
                    matchingImages.forEach(candidate => { candidate.tags = tags; });
                }
                if (Object.prototype.hasOwnProperty.call(update, 'score')) {
                    const score = update.score ?? null;
                    matchingImages.forEach(candidate => { candidate.score = score; });
                }
                changedCount += matchingImages.length;
            });

            if (changedCount > 0) rebuildMetadataIndexes();
            return changedCount;
        }

        function replaceScores(nextScores) {
            clearObject(scoresByHash);
            if (nextScores && typeof nextScores === 'object' && !Array.isArray(nextScores)) {
                Object.entries(nextScores).forEach(([hash, score]) => {
                    if (hash) scoresByHash[hash] = score;
                });
            }
            items.forEach((image) => {
                image.score = image.hash && Object.prototype.hasOwnProperty.call(scoresByHash, image.hash)
                    ? scoresByHash[image.hash]
                    : null;
            });
        }

        function removeTag(tagName) {
            if (typeof tagName !== 'string' || !tagName) return 0;
            let changedCount = 0;
            items.forEach((image) => {
                const currentTags = getTags(image);
                const nextTags = currentTags.filter(tag => tag !== tagName);
                if (nextTags.length === currentTags.length) return;
                image.tags = nextTags;
                changedCount++;
            });
            if (changedCount > 0) rebuildMetadataIndexes();
            return changedCount;
        }

        function renameTag(currentName, nextName) {
            if (typeof currentName !== 'string' || !currentName || typeof nextName !== 'string' || !nextName) {
                return 0;
            }
            let changedCount = 0;
            items.forEach((image) => {
                const currentTags = getTags(image);
                if (!currentTags.includes(currentName)) return;
                image.tags = [...new Set(currentTags.map(tag => tag === currentName ? nextName : tag))];
                changedCount++;
            });
            if (changedCount > 0) rebuildMetadataIndexes();
            return changedCount;
        }

        function getTags(image) {
            if (!image) return [];
            if (image.hash && Object.prototype.hasOwnProperty.call(tagsByHash, image.hash)) {
                return tagsByHash[image.hash];
            }
            return Array.isArray(image.tags) ? image.tags : [];
        }

        function getScore(image) {
            if (!image) return null;
            if (image.hash && Object.prototype.hasOwnProperty.call(scoresByHash, image.hash)) {
                return scoresByHash[image.hash];
            }
            return image.score ?? null;
        }

        function rebuildMetadataIndexes() {
            clearObject(tagsByHash);
            clearObject(scoresByHash);
            items.forEach((image) => {
                if (!image.hash) return;
                if (Array.isArray(image.tags) && image.tags.length > 0) {
                    tagsByHash[image.hash] = image.tags;
                }
                if (image.score !== null && image.score !== undefined) {
                    scoresByHash[image.hash] = image.score;
                }
            });
        }

        replace(initialImages);

        return Object.freeze({
            items,
            replace,
            remove,
            prepend,
            applyMetadata,
            replaceScores,
            removeTag,
            renameTag,
            getTags,
            getScore
        });
    }

    function normalizeImages(images) {
        return (Array.isArray(images) ? images : [])
            .filter(image => image && typeof image.path === 'string');
    }

    function normalizePaths(paths) {
        return (Array.isArray(paths) ? paths : [paths])
            .filter(path => typeof path === 'string' && path);
    }

    function clearObject(value) {
        Object.keys(value).forEach(key => delete value[key]);
    }

    return Object.freeze({ create });
}));
