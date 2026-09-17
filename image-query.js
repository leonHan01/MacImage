(function exposeImageQuery(root, factory) {
    const imageQuery = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = imageQuery;
        return;
    }

    root.MacImageQuery = imageQuery;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    const nameCollator = new Intl.Collator('zh-CN');

    function create({ collection, getRating, random = Math.random }) {
        const randomRanks = new Map();

        function filter({ tags = [], untaggedOnly = false } = {}) {
            if (tags.length === 0 && !untaggedOnly) return collection.items;

            return collection.items.filter(image => {
                const imageTags = collection.getTags(image);
                if (untaggedOnly && imageTags.length > 0) return false;
                return tags.every(tag => imageTags.includes(tag));
            });
        }

        function sort(images, order) {
            const sorted = [...images];
            if (order === 'random') {
                updateRandomRanks(sorted);
                return sorted.sort((first, second) => (
                    randomRanks.get(first.path) - randomRanks.get(second.path)
                    || compareNames(first, second)
                ));
            }

            const [field, direction] = order.split('-');
            const multiplier = direction === 'desc' ? -1 : 1;
            if (field === 'date' || field === 'score') {
                // Parse dates and normalize ratings once per image, not on
                // every comparison. Recompute on each sort to reflect edits.
                return sorted.map(image => ({
                    image,
                    value: field === 'date' ? new Date(image.modifiedTime).getTime() : getRating(image)
                })).sort((first, second) => multiplier * (first.value - second.value))
                    .map(entry => entry.image);
            }
            return sorted.sort((first, second) => (
                multiplier * compareField(first, second, field)
            ));
        }

        function compareField(first, second, field) {
            switch (field) {
                case 'name':
                    return compareNames(first, second);
                case 'size':
                    return first.size - second.size;
                default:
                    return 0;
            }
        }

        function updateRandomRanks(images) {
            const existingPaths = new Set(collection.items.map(image => image.path));
            for (const imagePath of randomRanks.keys()) {
                if (!existingPaths.has(imagePath)) randomRanks.delete(imagePath);
            }

            // Filtering and metadata refreshes must keep the current random order.
            for (const image of images) {
                if (!randomRanks.has(image.path)) randomRanks.set(image.path, random());
            }
        }

        function resetRandomOrder() {
            randomRanks.clear();
        }

        return Object.freeze({ filter, sort, resetRandomOrder });
    }

    function compareNames(first, second) {
        return nameCollator.compare(first.name, second.name);
    }

    return Object.freeze({ create });
}));
