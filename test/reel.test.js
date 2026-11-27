import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStrip, reelPosition, reelStops } from '../client/src/shared/reel.js';

test('the captain sits on the landing spot of the reel, whatever the team size', () => {
  for (const players of [['Ann'], ['Ann', 'Bo'], ['Ann', 'Bo', 'Cy', 'Di', 'Ed']]) {
    for (const captain of players) {
      const strip = buildStrip(players, captain, 34);
      assert.equal(strip.length, 38);
      assert.equal(strip[2], captain);
      assert.ok(strip.every((name) => players.includes(name)));
    }
  }
});

test('the reel slows down, runs a little past the captain and settles on them', () => {
  assert.equal(reelPosition(0, 34), 0);
  assert.equal(reelPosition(1, 34), 34);
  const early = reelPosition(0.2, 34) - reelPosition(0.1, 34);
  const late = reelPosition(0.8, 34) - reelPosition(0.7, 34);
  assert.ok(early > late * 4);
  assert.ok(reelPosition(0.93, 34) > 34);
  assert.ok(Math.abs(reelPosition(0.93, 34) - reelPosition(0.9299, 34)) < 0.01);
});

test('reels stop one after another and all before the reveal closes', () => {
  assert.deepEqual(reelStops(1, 6000), [4600]);
  assert.deepEqual(reelStops(3, 6000), [3300, 3950, 4600]);
  const short = reelStops(3, 2000);
  assert.ok(short[0] > 0 && short[0] < short[1] && short[1] < short[2] && short[2] < 2000);
});
