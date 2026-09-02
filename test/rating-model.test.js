const assert = require('node:assert/strict');
const { test } = require('node:test');

const ratingModel = require('../rating-model');

test('normalizes legacy wins into a complete rating record', () => {
    assert.deepEqual(ratingModel.normalize(4), {
        rating: 1504,
        wins: 4,
        matches: 4
    });
});

test('records one group win without changing the total rating delta contract', () => {
    const result = ratingModel.recordWin(
        { rating: 1500, wins: 0, matches: 0 },
        [
            { rating: 1500, wins: 1, matches: 2 },
            { rating: 1500, wins: 2, matches: 3 }
        ]
    );

    assert.deepEqual(result.winner, { rating: 1516, wins: 1, matches: 1 });
    assert.deepEqual(result.losers, [
        { rating: 1484, wins: 1, matches: 3 },
        { rating: 1484, wins: 2, matches: 4 }
    ]);
});

test('formats normalized rating records for the renderer', () => {
    assert.equal(
        ratingModel.format({ rating: 1518, wins: 2, matches: 3 }),
        '1518 分 · 2胜/3场'
    );
});
