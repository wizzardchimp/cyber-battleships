import { escapeHtml } from '../shared/dom.js';

/**
 * Full-screen cut scenes for the big screen: a video that fades up from black
 * under an analogue-interference overlay (static, scan lines, a rolling band)
 * with bold text on top. The video is muted; the room's battle music plays.
 */

const FADE_IN_MS = 1400;
const FADE_OUT_MS = 800;

let active = null;

export function cutsceneActive() {
  return Boolean(active);
}

export function skipCutscene() {
  active?.finish();
}

/**
 * Play a cut scene. Options: src, title, subtitle, color (subtitle colour),
 * onTick(elapsedMs) called a few times a second, onEnd().
 */
export function playCutscene({ src, title, subtitle = '', color = '', teams = [], onTick = null, onEnd = null }) {
  active?.finish(true);

  const root = document.createElement('div');
  root.className = 'cutscene';
  root.setAttribute('role', 'presentation');
  root.innerHTML = `
    <video class="cutscene__video" muted playsinline preload="auto" src="${escapeHtml(src)}"></video>
    <canvas class="cutscene__noise" width="320" height="180"></canvas>
    <div class="cutscene__lines"></div>
    <div class="cutscene__band"></div>
    <div class="cutscene__vignette"></div>
    <div class="cutscene__text">
      <h1 class="cutscene__title" data-text="${escapeHtml(title)}">${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="cutscene__subtitle" ${color ? `style="--accent:${escapeHtml(color)}"` : ''}>${escapeHtml(subtitle)}</p>` : ''}
    </div>
    ${
      teams.length
        ? `<div class="cutscene__teams">${teams
            .map(
              (team) => `
          <div class="cutscene__team" style="--side:${escapeHtml(team.color || '#fff')}">
            <span class="cutscene__team-name">${escapeHtml(team.name)}</span>
            <span class="cutscene__team-captain">CAPTAIN <b>${escapeHtml(team.captain || '-')}</b></span>
          </div>`,
            )
            .join('')}</div>`
        : ''
    }
    <div class="cutscene__fade"></div>
    <div class="cutscene__skip">PRESS SPACE TO SKIP</div>`;
  document.body.append(root);

  const video = root.querySelector('video');
  const fade = root.querySelector('.cutscene__fade');
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const startedAt = performance.now();
  let done = false;
  let raf = 0;
  let tickTimer = 0;
  let safety = 0;

  // Fade up from black.
  fade.style.transition = `opacity ${FADE_IN_MS}ms ease-out`;
  requestAnimationFrame(() => requestAnimationFrame(() => (fade.style.opacity = '0')));

  // Static: a small canvas of noise plus a few torn horizontal lines, redrawn ~20 times a second.
  const image = ctx.createImageData(canvas.width, canvas.height);
  let lastNoise = 0;
  const drawNoise = (now) => {
    raf = requestAnimationFrame(drawNoise);
    if (now - lastNoise < 50) return;
    lastNoise = now;
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    // Torn horizontal streaks.
    const streaks = 1 + Math.floor(Math.random() * 4);
    for (let n = 0; n < streaks; n += 1) {
      const y = Math.floor(Math.random() * canvas.height);
      const h = 1 + Math.floor(Math.random() * 3);
      ctx.fillStyle = `rgba(255,255,255,${0.5 + Math.random() * 0.5})`;
      ctx.fillRect(0, y, canvas.width, h);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, y + h + 1, canvas.width, 1);
    }
  };
  raf = requestAnimationFrame(drawNoise);

  function finish(immediate = false) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearInterval(tickTimer);
    clearTimeout(safety);
    if (active === handle) active = null;
    const remove = () => {
      video.pause();
      root.remove();
      onEnd?.();
    };
    if (immediate) {
      remove();
      return;
    }
    fade.style.transition = `opacity ${FADE_OUT_MS}ms ease-in`;
    fade.style.opacity = '1';
    setTimeout(remove, FADE_OUT_MS);
  }

  const handle = { finish };
  active = handle;

  video.addEventListener('ended', () => finish());
  video.addEventListener('error', () => finish(true));
  video.addEventListener('loadedmetadata', () => {
    // Fade out just before the clip ends, in case 'ended' is late.
    clearTimeout(safety);
    safety = setTimeout(() => finish(), Math.max(1000, video.duration * 1000 + 600));
  });
  safety = setTimeout(() => finish(), 20_000);
  video.play().catch(() => finish(true));

  if (onTick) tickTimer = setInterval(() => onTick(performance.now() - startedAt), 250);
  root.addEventListener('click', () => finish());

  return handle;
}
