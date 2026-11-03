/**
 * Offline WebAudio synthesis.
 *
 * No audio files: everything is generated from oscillators and noise so the
 * game works from a USB stick or a locked-down training laptop.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.enabled = localStorage.getItem('cb.sound') !== 'off';
  }

  async init() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // Browser policy may still block; effects become no-ops.
      }
    }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    localStorage.setItem('cb.sound', this.enabled ? 'on' : 'off');
  }

  toggle() {
    this.setEnabled(!this.enabled);
    if (this.enabled) this.play('ui');
    return this.enabled;
  }

  _noise(duration = 0.6) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  _tone({ freq = 440, to = null, dur = 0.2, type = 'sine', gain = 0.12, delay = 0, attack = 0.008 }) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), now + dur);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(amp).connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  }

  _noiseBurst({ dur = 0.4, gain = 0.12, type = 'lowpass', freq = 800, q = 0.8, delay = 0, sweepTo = null }) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this._noise(dur);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, now);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), now + dur);
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    source.connect(filter).connect(amp).connect(this.master);
    source.start(now);
    source.stop(now + dur + 0.05);
  }

  play(name) {
    if (!this.ctx || !this.enabled) return;
    switch (name) {
      case 'ui':
        this._tone({ freq: 740, to: 880, dur: 0.07, type: 'triangle', gain: 0.05 });
        break;
      case 'launch':
        this._noiseBurst({ dur: 0.35, gain: 0.08, type: 'bandpass', freq: 1600, sweepTo: 300, q: 1.4 });
        this._tone({ freq: 900, to: 140, dur: 0.34, type: 'sawtooth', gain: 0.05 });
        break;
      case 'explosion':
        this._noiseBurst({ dur: 0.8, gain: 0.22, type: 'lowpass', freq: 1400, sweepTo: 120 });
        this._tone({ freq: 120, to: 28, dur: 0.55, type: 'sine', gain: 0.22 });
        break;
      case 'splash':
        this._noiseBurst({ dur: 0.45, gain: 0.1, type: 'highpass', freq: 900, sweepTo: 2400 });
        this._tone({ freq: 420, to: 180, dur: 0.2, type: 'sine', gain: 0.04 });
        break;
      case 'award':
        this._tone({ freq: 880, dur: 0.1, type: 'triangle', gain: 0.07 });
        this._tone({ freq: 1174, dur: 0.12, type: 'triangle', gain: 0.08, delay: 0.08 });
        this._tone({ freq: 1568, dur: 0.2, type: 'triangle', gain: 0.08, delay: 0.16 });
        break;
      case 'correct':
        this._tone({ freq: 620, to: 980, dur: 0.25, type: 'sine', gain: 0.09 });
        break;
      case 'wrong':
        this._tone({ freq: 240, to: 120, dur: 0.3, type: 'square', gain: 0.05 });
        break;
      case 'brief':
        this._tone({ freq: 320, dur: 0.15, type: 'sawtooth', gain: 0.04 });
        this._tone({ freq: 480, dur: 0.2, type: 'sawtooth', gain: 0.04, delay: 0.14 });
        break;
      case 'battle':
        this._tone({ freq: 180, to: 360, dur: 0.25, type: 'triangle', gain: 0.06 });
        break;
      case 'reveal':
        this._tone({ freq: 520, dur: 0.12, type: 'sine', gain: 0.06 });
        this._tone({ freq: 780, dur: 0.18, type: 'sine', gain: 0.06, delay: 0.1 });
        break;
      case 'alarm':
        this._tone({ freq: 440, dur: 0.18, type: 'square', gain: 0.035 });
        this._tone({ freq: 660, dur: 0.18, type: 'square', gain: 0.035, delay: 0.22 });
        break;
      case 'eliminate':
        this._tone({ freq: 160, to: 40, dur: 1.1, type: 'sawtooth', gain: 0.08 });
        this._noiseBurst({ dur: 0.9, gain: 0.12, type: 'lowpass', freq: 500, sweepTo: 80 });
        break;
      case 'victory': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, index) => {
          this._tone({ freq, dur: 0.5, type: 'triangle', gain: 0.08, delay: index * 0.13 });
        });
        break;
      }
      case 'join':
        this._tone({ freq: 660, dur: 0.08, type: 'sine', gain: 0.05 });
        break;
      default:
        break;
    }
  }
}
