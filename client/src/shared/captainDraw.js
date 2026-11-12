import { sfx } from './audio.js';
import { escapeHtml } from './dom.js';

export const DRAW_MS = 5000;

/**
 * A short slot-machine style reveal of each side's randomly chosen captain.
 * Names flicker past, slowing down, and settle on the captain at the end.
 * The captain is already chosen by the server; this is only the show.
 *
 * teams: [{ name, color, players: [name], captain: name }]
 */
export function runCaptainDraw(teams, { duration = DRAW_MS, sound = true, compact = false } = {}) {
  const draws = teams.filter((team) => team.captain && team.players.length > 0);
  if (draws.length === 0) return;
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
        <div class="captain-draw__team" style="--side:${escapeHtml(team.color)}">
          <span class="captain-draw__side">${escapeHtml(team.name)}</span>
          <strong class="captain-draw__name">&nbsp;</strong>
          <span class="captain-draw__tag">CAPTAIN</span>
        </div>`,
        )
        .join('')}
    </div>`;
  document.body.append(root);

  const nodes = [...root.querySelectorAll('.captain-draw__name')];
  const started = performance.now();
  const lockAt = duration - 900;
  let done = false;
  let step = 0;

  const tick = () => {
    if (done) return;
    const elapsed = performance.now() - started;
    if (elapsed >= lockAt) {
      draws.forEach((team, index) => {
        nodes[index].textContent = team.captain;
        nodes[index].parentElement.classList.add('is-locked');
      });
      if (sound) sfx.success();
      return;
    }
    draws.forEach((team, index) => {
      const names = team.players;
      step += 1;
      nodes[index].textContent = names[(step + index) % names.length];
    });
    if (sound) sfx.hover();
    // Start fast, slow down as the reveal nears.
    const progress = elapsed / lockAt;
    window.setTimeout(tick, 70 + progress * progress * 360);
  };
  tick();

  window.setTimeout(() => {
    done = true;
    root.classList.add('is-leaving');
    window.setTimeout(() => root.remove(), 350);
  }, duration);
}
