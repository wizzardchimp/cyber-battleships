import { getAudioContext, isMuted } from './audio.js';

/**
 * Recorded battle effects. Each group plays in a shuffled order so the same
 * sound is not heard twice in a row until every sound in the group has played.
 */
const BANKS = Object.freeze({
  fire: ['fire1', 'fire2', 'fire3', 'fire4', 'fire5'],
  hit: ['hit1', 'hit2', 'hit3'],
  miss: ['miss1', 'miss2', 'miss3'],
  sink: ['sink1', 'sink2', 'sink3'],
});

// Long clips are faded out so a busy battle does not turn into a wall of noise.
const MAX_SECONDS = Object.freeze({ fire: 3.5, hit: 4, miss: 3, sink: 7 });
const FADE_SECONDS = 0.4;
const MAX_VOICES = 6;
const RESULT_DELAY = 0.7;

const buffers = new Map();
const bags = {};
const lastPlayed = {};
let loading = null;
let enabled = true;
let voices = 0;

export function setBattleSoundsEnabled(value) {
  enabled = Boolean(value);
}

function decode(ctx, data) {
  return new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject));
}

export function preloadBattleSounds() {
  if (loading) return loading;
  const ctx = getAudioContext();
  if (!ctx) return Promise.resolve();
  const names = Object.values(BANKS).flat();
  loading = Promise.all(
    names.map(async (name) => {
      try {
        const response = await fetch(`/sounds/${name}.mp3`);
        if (!response.ok) return;
        buffers.set(name, await decode(ctx, await response.arrayBuffer()));
      } catch {
        // A missing or undecodable clip is simply skipped.
      }
    }),
  );
  return loading;
}

function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function nextName(kind) {
  if (!bags[kind] || bags[kind].length === 0) {
    const bag = shuffled(BANKS[kind]);
    // The bag is drawn from the end; avoid repeating the last sound heard.
    if (bag.length > 1 && bag[bag.length - 1] === lastPlayed[kind]) {
      [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
    bags[kind] = bag;
  }
  const name = bags[kind].pop();
  lastPlayed[kind] = name;
  return name;
}

export function playBattle(kind, { delay = 0, volume = 0.85 } = {}) {
  if (!enabled || isMuted() || !BANKS[kind]) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (!loading) preloadBattleSounds();
  if (voices >= MAX_VOICES) return;

  const buffer = buffers.get(nextName(kind));
  if (!buffer) return;

  const start = ctx.currentTime + Math.max(0, delay);
  const cap = MAX_SECONDS[kind];
  const length = Math.min(buffer.duration, cap);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, start);
  if (buffer.duration > cap) {
    gain.gain.setValueAtTime(volume, start + length - FADE_SECONDS);
    gain.gain.linearRampToValueAtTime(0.0001, start + length);
  }
  source.connect(gain).connect(ctx.destination);
  voices += 1;
  source.onended = () => {
    voices = Math.max(0, voices - 1);
  };
  source.start(start);
  source.stop(start + length + 0.05);
}

/** The outcome of a shot: a sunk ship, a hit or a miss. */
export function playShotResult({ hit, sunk }, { delay = RESULT_DELAY } = {}) {
  playBattle(sunk ? 'sink' : hit ? 'hit' : 'miss', { delay });
}

export { RESULT_DELAY };
