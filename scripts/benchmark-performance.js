// Offline benchmark: no Electron window or image decoding is started.
// Pass a source directory to compare another snapshot with the same workload.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { create: createCollection } = require(path.join(sourceRoot, 'image-collection'));
const { create: createQuery } = require(path.join(sourceRoot, 'image-query'));
const ratingModel = require(path.join(sourceRoot, 'rating-model'));
const imageCount = 20000;

function makeImages() {
    return Array.from({ length: imageCount }, (_, index) => ({
        path: `/photos/${index}.jpg`,
        name: `图片-${(index * 7919) % imageCount}.jpg`,
        hash: `hash-${Math.floor(index / 2)}`,
        size: index * 100,
        modifiedTime: new Date(1700000000000 + ((index * 7919) % imageCount) * 1000).toISOString(),
        tags: index % 5 === 0 ? [] : [`tag-${Math.floor(index / 2) % 100}`],
        score: { rating: 1000 + (index * 7919) % 1000, wins: 0, matches: 0 }
    }));
}

function measure(label, setup) {
    const samples = [];
    for (let run = 0; run < 6; run++) {
        const operation = setup();
        const start = performance.now();
        operation();
        if (run > 0) samples.push(performance.now() - start);
    }
    samples.sort((first, second) => first - second);
    console.log(`${label}: ${samples[2].toFixed(2)} ms (median of 5)`);
}

console.log(`Offline workload: ${imageCount} images`);
measure('Apply 2000 metadata updates', () => {
    const collection = createCollection(makeImages());
    const updates = collection.items.slice(0, 2000).map(image => ({ path: image.path, tags: ['updated'] }));
    return () => collection.applyMetadata(updates);
});
measure('Remove 10000 images', () => {
    const collection = createCollection(makeImages());
    const paths = collection.items.filter((_, index) => index % 2 === 0).map(image => image.path);
    return () => collection.remove(paths);
});
for (const field of ['name', 'date', 'score']) {
    measure(`Sort by ${field}`, () => {
        const collection = createCollection(makeImages());
        const query = createQuery({ collection, getRating: image => ratingModel.normalize(collection.getScore(image)).rating });
        return () => query.sort(collection.items, `${field}-asc`);
    });
}
measure('Count 100 tags and untagged images', () => {
    const collection = createCollection(makeImages());
    const context = vm.createContext({
        imageCollection: collection,
        images: collection.items,
        getImageTags: image => collection.getTags(image)
    });
    for (const file of ['renderer-gallery.js', 'renderer-tag-settings.js']) {
        vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), context);
    }
    return () => {
        for (let index = 0; index < 100; index++) context.getTagCount(`tag-${index}`);
        context.getNoTagCount();
    };
});
