async function mapWithConcurrency(items, concurrency, mapper) {
    const sourceItems = Array.isArray(items) ? items : [];
    const results = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < sourceItems.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await mapper(sourceItems[currentIndex], currentIndex);
        }
    }

    const normalizedConcurrency = Number.isFinite(concurrency)
        ? Math.max(1, Math.floor(concurrency))
        : 1;
    const workerCount = Math.min(normalizedConcurrency, sourceItems.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

module.exports = { mapWithConcurrency };
