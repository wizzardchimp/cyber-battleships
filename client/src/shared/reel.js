/** The sums behind the fruit machine captain reveal. No browser needed. */

// How far past the captain the reel runs before it drops back, in names.
const OVERSHOOT = 0.22;
// The share of the spin spent dropping back.
const SETTLE_FROM = 0.93;
// How long the finished result stays up before the reveal closes.
const HOLD_MS = 1400;
// The gap between one reel stopping and the next.
const STAGGER_MS = 650;

/**
 * The names on one reel, top to bottom. The captain is at index 2, with enough
 * names after it to roll `travel` of them past before landing.
 */
export function buildStrip(players, captain, travel) {
  const names = players.includes(captain) ? [...players] : [captain, ...players];
  const home = names.indexOf(captain);
  const length = travel + 4;
  return Array.from({ length }, (_, index) => {
    const offset = (index - 2 + home) % names.length;
    return names[(offset + names.length) % names.length];
  });
}

/**
 * How many names have rolled past at `progress` (0 to 1): quick at first, then
 * slower and slower, a touch past the captain and back into place.
 */
export function reelPosition(progress, travel) {
  const t = Math.min(1, Math.max(0, progress));
  if (t < SETTLE_FROM) {
    return (travel + OVERSHOOT) * (1 - (1 - t / SETTLE_FROM) ** 3);
  }
  const back = (t - SETTLE_FROM) / (1 - SETTLE_FROM);
  return travel + OVERSHOOT * (1 - back * back * (3 - 2 * back));
}

/** When each reel stops, left to right, the last one leaving time to read it. */
export function reelStops(count, duration) {
  const last = Math.max(duration * 0.5, duration - HOLD_MS);
  const gap = count > 1 ? Math.min(STAGGER_MS, (last * 0.4) / (count - 1)) : 0;
  return Array.from({ length: count }, (_, index) => last - gap * (count - 1 - index));
}
