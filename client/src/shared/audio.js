let context = null;
let muted = localStorage.getItem('cb.muted') === '1';
const muteListeners = new Set();

// Master volume in ten steps (0 to 10), kept per browser, plus a temporary "dip"
// that drops everything to a low level so the host can talk over the sound.
export const VOLUME_STEPS = 10;
const DIP_LEVEL = 0.25;
const DEFAULT_VOLUME = 5;
const levelListeners = new Set();
let volumeStep = (() => {
  try {
    const raw = localStorage.getItem('cb.volume');
    const saved = Number(raw);
    return raw !== null && Number.isInteger(saved) && saved >= 0 && saved <= VOLUME_STEPS ? saved : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
})();
let dipped = false;

/** Be told when the volume or dip changes. */
export function onLevelChange(listener) {
  levelListeners.add(listener);
}

function levelChanged() {
  levelListeners.forEach((listener) => listener(volumeStep, dipped));
}

/** 0 to 1 multiplier every sound goes through (volume step, then dip). */
export function outputLevel() {
  return (volumeStep / VOLUME_STEPS) * (dipped ? DIP_LEVEL : 1);
}

export function getVolume() {
  return volumeStep;
}

export function setVolume(step) {
  const next = Math.max(0, Math.min(VOLUME_STEPS, Math.round(Number(step) || 0)));
  volumeStep = next;
  try {
    localStorage.setItem('cb.volume', String(next));
  } catch {}
  levelChanged();
  if (next > 0 && !muted) tone(700, 0.05, 'sine', 0.02);
  return next;
}

export function stepVolume(delta) {
  return setVolume(volumeStep + delta);
}

export function isDipped() {
  return dipped;
}

export function setDip(value) {
  const next = Boolean(value);
  if (next === dipped) return dipped;
  dipped = next;
  levelChanged();
  return dipped;
}

/** Be told when the mute switch changes. */
export function onMuteChange(listener) {
  muteListeners.add(listener);
}

function ensureContext() {
  if (context) return context;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

/** The shared AudioContext, created on first use. */
export function getAudioContext() {
  return ensureContext();
}

export function unlockAudio() {
  const ctx = ensureContext();
  if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
}

function tone(frequency, duration = 0.08, type = 'sine', gain = 0.035, delay = 0) {
  if (muted) return;
  gain *= outputLevel();
  if (gain < 0.0002) return;
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const volume = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(volume).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export const sfx = {
  click() {
    tone(620, 0.05, 'square', 0.022);
  },
  hover() {
    tone(880, 0.03, 'sine', 0.012);
  },
  join() {
    tone(440, 0.08, 'square', 0.025);
    tone(660, 0.1, 'square', 0.025, 0.08);
    tone(880, 0.16, 'sine', 0.03, 0.17);
  },
  alert() {
    tone(220, 0.14, 'sawtooth', 0.025);
    tone(330, 0.14, 'sawtooth', 0.02, 0.15);
  },
  success() {
    tone(523, 0.08, 'triangle', 0.03);
    tone(659, 0.08, 'triangle', 0.03, 0.08);
    tone(784, 0.18, 'triangle', 0.035, 0.16);
  },
  tick() {
    tone(1000, 0.12, 'square', 0.16);
  },
  reelTick() {
    tone(520, 0.025, 'square', 0.05);
  },
  reelStop() {
    tone(180, 0.09, 'square', 0.1);
    tone(660, 0.12, 'sine', 0.05, 0.03);
  },
  error() {
    tone(160, 0.14, 'square', 0.025);
    tone(120, 0.2, 'square', 0.02, 0.12);
  },
};

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = Boolean(value);
  localStorage.setItem('cb.muted', muted ? '1' : '0');
  muteListeners.forEach((listener) => listener(muted));
  if (!muted) tone(700, 0.05, 'sine', 0.02);
  return muted;
}

export function toggleMute() {
  return setMuted(!muted);
}

export function muteLabel() {
  return muted ? 'AUDIO OFF' : 'AUDIO ON';
}
