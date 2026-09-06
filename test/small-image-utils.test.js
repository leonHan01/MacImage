const assert = require('node:assert/strict');
const { test } = require('node:test');
const smallImageUtils = require('../small-image-utils');

test('accepts only positive thresholds up to 300 KB', () => {
    assert.equal(smallImageUtils.parseThresholdKb('0.5'), 0.5);
    assert.equal(smallImageUtils.parseThresholdKb('300'), 300);
    assert.equal(smallImageUtils.parseThresholdKb(0), null);
    assert.equal(smallImageUtils.parseThresholdKb(300.1), null);
    assert.equal(smallImageUtils.parseThresholdKb('not-a-size'), null);
});

test('finds only images strictly below the requested KB threshold', () => {
    const matches = smallImageUtils.findImagesBelowSize([
        { name: 'at-limit.jpg', size: 100 * 1024 },
        { name: 'later.jpg', size: 20 * 1024 },
        { name: 'first.jpg', size: 10 * 1024 },
        { name: 'no-size.jpg', size: null }
    ], 100);

    assert.deepEqual(matches.map(image => image.name), ['first.jpg', 'later.jpg']);
});
