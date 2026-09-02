(function exposeRatingModel(root, factory) {
    const ratingModel = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = ratingModel;
        return;
    }

    root.MacImageRating = ratingModel;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    const DEFAULT_RATING = 1500;
    const K_FACTOR = 32;

    function normalize(value) {
        if (value && typeof value === 'object') {
            return {
                rating: normalizeNumber(value.rating, DEFAULT_RATING),
                wins: normalizeNumber(value.wins, 0),
                matches: normalizeNumber(value.matches, 0)
            };
        }

        const legacyWins = normalizeNumber(value, 0);
        return {
            rating: DEFAULT_RATING + legacyWins,
            wins: legacyWins,
            matches: legacyWins
        };
    }

    function recordWin(winnerValue, loserValues) {
        const winner = normalize(winnerValue);
        const losers = (Array.isArray(loserValues) ? loserValues : []).map(normalize);
        if (losers.length === 0) {
            return { winner, losers: [] };
        }

        const winnerExpectedAverage = losers.reduce((total, loser) => (
            total + getExpectedScore(winner.rating, loser.rating)
        ), 0) / losers.length;

        return {
            winner: {
                rating: Math.round(winner.rating + K_FACTOR * (1 - winnerExpectedAverage)),
                wins: winner.wins + 1,
                matches: winner.matches + 1
            },
            losers: losers.map(loser => ({
                rating: Math.round(loser.rating + K_FACTOR * (0 - getExpectedScore(loser.rating, winner.rating))),
                wins: loser.wins,
                matches: loser.matches + 1
            }))
        };
    }

    function format(value) {
        const record = normalize(value);
        return `${record.rating} 分 · ${record.wins}胜/${record.matches}场`;
    }

    function getExpectedScore(rating, opponentRating) {
        return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
    }

    function normalizeNumber(value, fallback) {
        const numericValue = Number(value);
        return Number.isFinite(numericValue)
            ? Math.max(0, Math.round(numericValue))
            : fallback;
    }

    return Object.freeze({
        DEFAULT_RATING,
        normalize,
        recordWin,
        format
    });
}));
