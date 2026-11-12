import { isMuted, onMuteChange } from './audio.js';

/**
 * Looping background music for the facilitator screens. Tracks stream through
 * an <audio> element (they are minutes long), and switching tracks cross-fades.
 */
const TRACKS = Object.freeze({
  menu: '/music/welcome-menu.mp3',
  quiz: '/music/questionround.mp3',
  battle: '/music/battle.mp3',
});

const VOLUME = Object.freeze({ menu: 0.4, quiz: 0.35, battle: 0.4 });
const FADE_MS = 1200;

let wanted = null; // track name the current screen asks for
let enabled = true; // the game's sound setting
let current = null; // { name, audio }
let gestureHooked = false;

function fade(audio, to, ms, done) {
  const from = audio.volume;
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / ms);
    audio.volume = Math.max(0, Math.min(1, from + (to - from) * t));
    if (t < 1) requestAnimationFrame(step);
    else done?.();
  };
  requestAnimationFrame(step);
}

function stopCurrent() {
  if (!current) return;
  const { audio } = current;
  current = null;
  fade(audio, 0, FADE_MS, () => {
    audio.pause();
    audio.src = '';
  });
}

// Browsers block audio until the person has interacted with the page.
function retryOnGesture() {
  if (gestureHooked) return;
  gestureHooked = true;
  const retry = () => {
    gestureHooked = false;
    sync();
  };
  window.addEventListener('pointerdown', retry, { once: true });
  window.addEventListener('keydown', retry, { once: true });
}

function sync() {
  const name = enabled && !isMuted() ? wanted : null;
  if (!name) {
    stopCurrent();
    return;
  }
  if (current?.name === name) {
    if (current.audio.paused) current.audio.play().catch(retryOnGesture);
    return;
  }
  stopCurrent();
  const audio = new Audio(TRACKS[name]);
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = 0;
  current = { name, audio };
  audio
    .play()
    .then(() => {
      if (current?.audio === audio) fade(audio, VOLUME[name], FADE_MS);
    })
    .catch(() => {
      // Blocked until a gesture: wait, then start this track from the top.
      if (current?.audio === audio) current = null;
      retryOnGesture();
    });
}

/** Ask for a track ('menu' | 'quiz' | 'battle'), or null for silence. */
export function setMusic(name) {
  wanted = TRACKS[name] ? name : null;
  sync();
}

/** The game's sound setting turns music on or off. */
export function setMusicEnabled(value) {
  const next = Boolean(value);
  if (next === enabled) return;
  enabled = next;
  sync();
}

onMuteChange(sync);
