import '../../styles/tokens.css';
import '../../styles/display.css';

import { MODES, PHASES, modeLabel, phaseLabel } from '@shared/constants.js';
import { EVENTS } from '@shared/events.js';
import { isMuted, muteLabel, sfx, toggleMute, unlockAudio } from '../shared/audio.js';
import { formatClock, syncClock } from '../shared/clock.js';
import { $, escapeHtml, initials, on, toast } from '../shared/dom.js';
import { createSocket, request } from '../shared/socket.js';
import { normaliseCode } from '@shared/util.js';

const app = $('#app');
const params = new URLSearchParams(window.location.search);
let code = normaliseCode(params.get('code') || '');
let state = null;
let socket = null;
let connected = false;
let subscribing = false;
let lastError = '';

function playerJoinUrl(current) {
  if (!current) return '';
  const base = current.join?.url || location.origin;
  try {
    return new URL(`/play?code=${encodeURIComponent(current.session.joinCode)}`, base).href;
  } catch {
    return `${location.origin}/play?code=${encodeURIComponent(current.session.joinCode)}`;
  }
}

function topbar(current) {
  return `
    <header class="display-top">
      <div class="display-brand">
        <div class="display-brand__mark">CB</div>
        <div class="display-brand__text">
          <div class="display-brand__name">CYBER BATTLESHIPS</div>
          <div class="display-brand__sub">Battle command centre</div>
        </div>
      </div>
      <div class="display-top__spacer"></div>
      <div class="display-top__status ${connected ? '' : 'display-top__status--off'}">
        <span class="status-dot"></span><span>${connected ? 'LIVE LINK' : 'RECONNECTING'}</span>
      </div>
      ${
        current
          ? `<div class="display-top__code"><span>JOIN CODE</span><strong>${escapeHtml(current.session.joinCode)}</strong></div>`
          : ''
      }
    </header>
  `;
}

function renderCodeEntry(message = '') {
  state = null;
  app.innerHTML = `
    <div class="display-shell">
      ${topbar(null)}
      <main class="display-main">
        <section class="display-mission">
          <div class="display-mission__inner">
            <p class="display-mission__eyebrow">// COMMAND LINK STANDBY //</p>
            <h1>ENTER<br />OPERATION</h1>
            <p>Type the join code shown in the facilitator console, or open this display from the console.</p>
            <form id="display-form" style="width:min(420px,100%);display:grid;gap:0.8rem">
              <input class="input input--code" name="code" value="${escapeHtml(code)}" maxlength="6" placeholder="ABC123" autocomplete="off" autocapitalize="characters" spellcheck="false" />
              <button class="btn btn--primary btn--wide" type="submit">CONNECT DISPLAY</button>
              ${message ? `<p class="form-error">${escapeHtml(message)}</p>` : ''}
            </form>
          </div>
        </section>
      </main>
      <footer class="display-foot">
        <span>CB // PROJECTOR TERMINAL</span>
        <span>Awaiting command link</span>
      </footer>
    </div>
  `;
  const input = $('#display-form input');
  setTimeout(() => input?.focus(), 50);
}

function renderLobby() {
  const current = state;
  const session = current.session;
  const join = playerJoinUrl(current);
  const teams = current.teams || [];
  const individual = session.mode === MODES.INDIVIDUAL;
  const gridClass = `display-team-grid--${Math.min(6, Math.max(1, teams.length))}`;
  const title = individual ? 'INDIVIDUAL COMPETITORS' : 'TEAM ROSTERS';

  app.innerHTML = `
    <div class="display-shell">
      ${topbar(current)}
      <main class="display-main">
        <section class="display-lobby">
          <aside class="display-join panel">
            <p class="display-join__eyebrow">SCAN TO ENLIST</p>
            <div class="display-qr"><img src="${current.join.qrUrl}" alt="QR code to join" /></div>
            <div>
              <p class="display-join__eyebrow">JOIN CODE</p>
              <div class="display-code-big">${escapeHtml(session.joinCode)}</div>
            </div>
            <div class="display-join-url">${escapeHtml(join)}</div>
            <div class="display-count">
              <strong>${current.counts.players}</strong>
              <span>Operatives enlisted</span>
            </div>
            ${current.counts.spectators > 0 ? `<div class="display-top__status" style="color:var(--muted)"><span class="status-dot status-dot--amber"></span>${current.counts.spectators} SPECTATOR${current.counts.spectators === 1 ? '' : 'S'}</div>` : ''}
          </aside>

          <div class="display-teams">
            <div class="display-section-head">
              <strong>${title}</strong>
              <span>${escapeHtml(modeLabel(session.mode))} // ${escapeHtml(session.config.ageGroup.toUpperCase())} // ${escapeHtml(session.config.difficulty.toUpperCase())}</span>
            </div>
            ${
              individual
                ? renderIndividuals(current)
                : `<div class="display-team-grid ${gridClass}">
                     ${teams.map((team) => renderTeam(team)).join('') || renderWaitingTeam()}
                   </div>`
            }
            <div class="display-ticker">
              <span class="display-ticker__dot"></span>
              <span><strong>${escapeHtml(session.name)}</strong> // ${current.counts.connected} of ${current.counts.players} devices online // ${current.counts.teams} ${current.counts.teams === 1 ? 'team' : 'teams'} configured // ${session.config.lobbyLocked ? 'LOBBY LOCKED' : 'AWAITING OPERATIVES'}</span>
            </div>
          </div>
        </section>
      </main>
      ${footer()}
    </div>
  `;
}

function renderTeam(team) {
  const roster = team.players || [];
  return `
    <article class="display-team" style="--team:${team.color}">
      <div class="display-team__head">
        <div class="display-team__name">${escapeHtml(team.name)}</div>
        <div class="display-team__count">${team.playerCount}<small>/${team.maxPlayers}</small></div>
      </div>
      ${
        roster.length
          ? `<div class="display-team__roster">
               ${roster
                 .map(
                   (player) =>
                     `<span class="display-chip ${player.connected ? '' : 'display-chip--off'}"><span class="display-chip__dot"></span>${escapeHtml(player.name)}</span>`,
                 )
                 .join('')}
             </div>`
          : '<div class="display-team__empty">Awaiting operatives</div>'
      }
      <div class="display-team__footer">
        <span>${team.playerCount > 0 ? '<strong>READY</strong>' : '<strong class="waiting">WAITING</strong>'}</span>
        <span>${team.connectedCount}/${team.playerCount} ONLINE</span>
      </div>
    </article>
  `;
}

function renderWaitingTeam() {
  return `
    <article class="display-team" style="--team:var(--cyan)">
      <div class="display-team__head"><div class="display-team__name">STANDBY</div></div>
      <div class="display-team__empty">Teams appear here when the operation is configured</div>
    </article>
  `;
}

function renderIndividuals(current) {
  const players = current.players || [];
  if (!players.length) {
    return `<div class="display-individuals"><div class="display-team__empty">Awaiting individual competitors</div></div>`;
  }
  return `
    <div class="display-individuals">
      ${players
        .map(
          (player, index) => `
          <div class="display-individual" style="--team:${index % 2 ? 'var(--amber)' : 'var(--cyan)'}">
            <strong>${escapeHtml(player.name)}</strong>
            <span>${player.connected ? 'ONLINE' : 'OFFLINE'} // COMPETITOR ${String(index + 1).padStart(2, '0')}</span>
          </div>`,
        )
        .join('')}
    </div>
  `;
}

function footer() {
  return `
    <footer class="display-foot">
      <span>CB // BATTLE COMMAND CENTRE</span>
      <span id="display-clock">${formatClock(Date.now())}</span>
      <div class="display-foot__actions">
        <button class="icon-btn" type="button" data-action="sound" title="Toggle audio">${isMuted() ? 'OFF' : 'SND'}</button>
        <button class="icon-btn" type="button" data-action="fullscreen" title="Toggle fullscreen">⛶</button>
      </div>
    </footer>
  `;
}

function renderMission() {
  const current = state;
  app.innerHTML = `
    <div class="display-shell">
      ${topbar(current)}
      <main class="display-main">
        <section class="display-mission">
          <div class="display-mission__inner">
            <p class="display-mission__eyebrow">// ALL HANDS // ALL STATIONS //</p>
            <h1>MISSION<br />READY</h1>
            <p>${escapeHtml(current.session.name)} // ${current.counts.players} operatives across ${current.counts.teams || 1} ${current.counts.teams === 1 ? 'team' : 'teams'}</p>
            <div class="display-mission__lineup">
              ${
                current.teams
                  .map(
                    (team) => `
                    <div class="display-mission__team" style="--team:${team.color}">
                      <strong>${escapeHtml(team.name)}</strong>
                      ${team.players.map((player) => `<span>${escapeHtml(player.name)}</span>`).join('') || '<span>No operatives</span>'}
                    </div>`,
                  )
                  .join('') ||
                (current.players || [])
                  .map(
                    (player) =>
                      `<div class="display-mission__team" style="--team:var(--cyan)"><strong>${escapeHtml(player.name)}</strong><span>INDIVIDUAL COMPETITOR</span></div>`,
                  )
                  .join('')
              }
            </div>
            <p class="tiny muted">AWAITING PHASE CONTROL // ${phaseLabel(current.session.phase)}</p>
          </div>
        </section>
      </main>
      ${footer()}
    </div>
  `;
}

function render() {
  if (!state) {
    if (code) renderBoot();
    else renderCodeEntry(lastError);
    return;
  }
  if (state.session.phase === PHASES.MISSION_READY) renderMission();
  else renderLobby();
}

function renderBoot() {
  app.innerHTML = `
    <div class="display-shell">
      ${topbar(null)}
      <main class="display-main">
        <div class="boot-screen" style="min-height:60vh">
          <div class="boot-screen__logo">OPERATION ${escapeHtml(code || 'STANDBY')}</div>
          <div class="boot-screen__bar"><span></span></div>
          <p>${lastError ? escapeHtml(lastError) : 'Synchronising battle command…'}</p>
        </div>
      </main>
      ${footer()}
    </div>
  `;
}

async function subscribe() {
  if (!code || subscribing) return;
  if (!socket) ensureSocket();
  if (!socket.connected) {
    socket.connect();
    return;
  }
  subscribing = true;
  lastError = '';
  renderBoot();
  try {
    await request(socket, EVENTS.DISPLAY_SUBSCRIBE, { code });
  } catch (error) {
    lastError = error.message || 'That operation could not be found.';
    state = null;
    renderCodeEntry(lastError);
  } finally {
    subscribing = false;
  }
}

function ensureSocket() {
  if (socket) return;
  socket = createSocket();
  socket.on('connect', () => {
    connected = true;
    if (code) subscribe();
    else renderCodeEntry(lastError);
  });
  socket.on('disconnect', () => {
    connected = false;
    const status = document.querySelector('.display-top__status');
    if (status) {
      status.classList.add('display-top__status--off');
      status.innerHTML = '<span class="status-dot"></span><span>RECONNECTING</span>';
    }
  });
  socket.on(EVENTS.STATE, (next) => {
    if (!next?.session || next.session.joinCode !== code) return;
    state = next;
    syncClock(next.meta?.serverNow);
    render();
  });
  socket.on(EVENTS.TOAST, (payload) => {
    toast(payload.message, payload.level || 'info', '#toast-root');
    if (payload.level === 'join') sfx.join();
    else if (payload.level === 'alert') sfx.alert();
  });
  socket.on(EVENTS.SESSION_CLOSED, () => {
    toast('Operation closed.', 'error', '#toast-root');
    state = null;
    lastError = 'This operation has closed.';
    renderCodeEntry(lastError);
  });
  socket.connect();
}

on(app, 'click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  unlockAudio();
  sfx.click();
  if (button.dataset.action === 'sound') {
    toggleMute();
    button.textContent = isMuted() ? 'OFF' : 'SND';
  }
  if (button.dataset.action === 'fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
});

app.addEventListener('submit', (event) => {
  const form = event.target.closest('#display-form');
  if (!form) return;
  event.preventDefault();
  const next = normaliseCode(new FormData(form).get('code') || '');
  if (next.length !== 6) {
    lastError = 'Enter the six-character join code.';
    renderCodeEntry(lastError);
    return;
  }
  code = next;
  lastError = '';
  window.history.replaceState({}, '', `/display?code=${encodeURIComponent(code)}`);
  subscribe();
});

setInterval(() => {
  const clock = document.querySelector('#display-clock');
  if (clock) clock.textContent = formatClock(Date.now());
}, 15_000);

if (code) {
  ensureSocket();
} else {
  renderCodeEntry();
}
