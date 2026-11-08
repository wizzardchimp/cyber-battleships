let context = null;
let muted = localStorage.getItem('cb.muted') === '1';

function ensureContext() {
  if (context) return context;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

export function unlockAudio() {
  const ctx = ensureContext();
  if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
}

function tone(frequency, duration = 0.08, type = 'sine', gain = 0.035, delay = 0) {
  if (muted) return;
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
  if (!muted) tone(700, 0.05, 'sine', 0.02);
  return muted;
}

export function toggleMute() {
  return setMuted(!muted);
}

export function muteLabel() {
  return muted ? 'AUDIO OFF' : 'AUDIO ON';
}
