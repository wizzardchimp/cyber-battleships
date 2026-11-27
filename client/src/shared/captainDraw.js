import { sfx } from './audio.js';
import { escapeHtml } from './dom.js';
import { buildStrip, reelPosition, reelStops } from './reel.js';

export const DRAW_MS = 6000;

// Names that roll past before a reel lands on the captain.
const REEL_TRAVEL = 34;
// The fastest the ticking is allowed to repeat, so a fast reel does not buzz.
const TICK_GAP_MS = 55;

let drawing = false;

export function captainDrawActive() {
  return drawing;
}

/**
 * A fruit machine reveal of each side's randomly chosen captain. Every side has
 * a reel of its players' names that spins, slows down and stops on the captain,
 * one reel after another. The captain is already chosen by the server; this is
 * only the show.
 *
 * teams: [{ name, color, players: [name], captain: name }]
 */
export function runCaptainDraw(teams, { duration = DRAW_MS, sound = true, compact = false, onDone = null } = {}) {
  const draws = teams.filter((team) => team.captain && team.players.length > 0);
  if (draws.length === 0) {
    onDone?.();
    return;
  }
  drawing = true;
  document.getElementById('captain-draw')?.remove();

  const root = document.createElement('div');
  root.id = 'captain-draw';
  root.className = `captain-draw ${compact ? 'captain-draw--compact' : ''}`;
  root.setAttribute('role', 'status');
  root.innerHTML = `
    <div class="captain-draw__title">CHOOSING CAPTAINS</div>
    <div class="captain-draw__teams">
      ${draws
        .map(
          (team) => `
        <div class="captain-draw__team" style="--side:${escapeHtml(team.color)}" aria-label="${escapeHtml(team.name)} captain">
          <span class="captain-draw__side">${escapeHtml(team.name)}</span>
          <div class="reel" aria-hidden="true">
            <div class="reel__strip">
              ${buildStrip(team.players, team.captain, REEL_TRAVEL)
                .map((name) => `<span class="reel__name">${escapeHtml(name)}</span>`)
                .join('')}
            </div>
          </div>
          <span class="captain-draw__tag">CAPTAIN</span>
        </div>`,
        )
        .join('')}
    </div>`;
  document.body.append(root);

  const stops = reelStops(draws.length, duration);
  const reels = [...root.querySelectorAll('.reel')].map((node, index) => ({
    node,
    strip: node.firstElementChild,
    card: node.parentElement,
    stopAt: stops[index],
    position: 0,
    locked: false,
  }));

  const place = (reel, position) => {
    const row = reel.strip.firstElementChild.offsetHeight;
    // The captain is the third name on the strip; the window shows three rows.
    reel.strip.style.transform = `translateY(${-(REEL_TRAVEL + 1 - position) * row}px)`;
  };

  const lock = (reel) => {
    if (reel.locked || !root.isConnected) return;
    reel.locked = true;
    place(reel, REEL_TRAVEL);
    reel.node.classList.remove('is-fast');
    reel.card.classList.add('is-locked');
    reel.card.setAttribute('aria-label', `${reel.card.querySelector('.captain-draw__side').textContent} captain: ${draws[reels.indexOf(reel)].captain}`);
    if (!sound) return;
    if (reels.every((entry) => entry.locked)) sfx.success();
    else sfx.reelStop();
  };

  const started = performance.now();
  let lastTickAt = 0;
  const frame = () => {
    if (!root.isConnected) return;
    const now = performance.now();
    const elapsed = now - started;
    // Only the reel that stops last ticks, so several reels do not clatter.
    const leader = reels.filter((reel) => !reel.locked).at(-1);
    for (const reel of reels) {
      if (reel.locked) continue;
      if (elapsed >= reel.stopAt) {
        lock(reel);
        continue;
      }
      const position = reelPosition(elapsed / reel.stopAt, REEL_TRAVEL);
      reel.node.classList.toggle('is-fast', Math.abs(position - reel.position) > 0.3);
      if (reel === leader && sound && Math.floor(position) > Math.floor(reel.position) && now - lastTickAt >= TICK_GAP_MS) {
        lastTickAt = now;
        sfx.reelTick();
      }
      reel.position = position;
      place(reel, position);
    }
    if (reels.some((reel) => !reel.locked)) window.requestAnimationFrame(frame);
  };
  for (const reel of reels) {
    place(reel, 0);
    // Animation frames pause in a hidden tab, so a timer also stops each reel.
    window.setTimeout(() => lock(reel), reel.stopAt + 60);
  }
  window.requestAnimationFrame(frame);

  window.setTimeout(() => {
    root.classList.add('is-leaving');
    window.setTimeout(() => {
      root.remove();
      drawing = false;
      onDone?.();
    }, 350);
  }, duration);
}
