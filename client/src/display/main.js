import '../../styles/tokens.css';
import '../../styles/display.css';
import '../../styles/battle.css';

import { MODES, PHASES, modeLabel, phaseLabel } from '@shared/constants.js';
import { EVENTS } from '@shared/events.js';
import { isMuted, muteLabel, sfx, toggleMute, unlockAudio } from '../shared/audio.js';
import { formatClock, formatCountdown, syncClock } from '../shared/clock.js';
import { $, escapeHtml, initials, on, toast } from '../shared/dom.js';
import { renderGrid } from '../shared/grid.js';
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
    return new URL(`/${encodeURIComponent(current.session.joinCode)}`, base).href;
  } catch {
    return `${location.origin}/${encodeURIComponent(current.session.joinCode)}`;
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
            <div class="display-join-url">${escapeHtml(join)}</div>
            <div>
              <p class="display-join__eyebrow">JOIN CODE</p>
              <div class="display-code-big">${escapeHtml(session.joinCode)}</div>
            </div>
            <div class="display-count">
              <strong>${current.counts.players}</strong>
              <span>Operatives enlisted</span>
            </div>
            ${current.counts.spectators > 0 ? `<div class="display-top__status" style="color:var(--muted)"><span class="status-dot status-dot--amber"></span>${current.counts.spectators} SPECTATOR${current.counts.spectators === 1 ? '' : 'S'}</div>` : ''}
            <button class="btn btn--green btn--wide display-start" type="button" data-action="start-round">START ROUND</button>
            <p class="display-start__hint">Launches with any number of operatives</p>
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
            <p class="tiny muted">LAUNCH THE FIRST QUESTION ROUND WHEN EVERY OPERATIVE IS READY</p>
            <button class="btn btn--green display-start" type="button" data-action="start-round">START ROUND</button>
          </div>
        </section>
      </main>
      ${footer()}
    </div>
  `;
}

const OPTION_KEYS = 'ABCDEF';

function optionKey(index) {
  return OPTION_KEYS[index] || String(index + 1);
}

function displayScores(round) {
  return [...(round?.scores || [])].sort(
    (a, b) => b.points - a.points || b.hits - a.hits || a.name.localeCompare(b.name),
  );
}

function displayScoreboard(round) {
  const rows = displayScores(round);
  return `
    <section class="display-round-score panel">
      <div class="display-round-score__head">
        <strong>BATTLE SCORE</strong>
        <span>ROUND ${round?.number || 1}</span>
      </div>
      <div class="display-round-score__rows">
        ${rows
          .map(
            (row, index) => `
            <div class="display-score-row" style="--row:${row.color}">
              <span class="display-score-row__rank">${index + 1}</span>
              <span class="display-score-row__name">${escapeHtml(row.name)}</span>
              <span class="display-score-row__points">${row.points}</span>
              <span class="display-score-row__meta">${row.hits} HIT // ${row.missiles} MSL</span>
            </div>`,
          )
          .join('') || '<p class="tiny muted">Awaiting combatants</p>'}
      </div>
    </section>
  `;
}

function displayRoundHead(round, { title, label, endsAt }) {
  const current = state;
  return `
    <header class="display-round-head">
      <div>
        <p class="display-round-head__eyebrow">// ROUND ${round.number} // ${escapeHtml(label)} //</p>
        <h1 class="display-round-head__title">${escapeHtml(title)}</h1>
      </div>
      <div class="display-round-head__meta">
        <span>${escapeHtml(current.session.name)}</span>
        <strong data-countdown="${escapeHtml(endsAt || '')}">${formatCountdown(endsAt)}</strong>
      </div>
    </header>
  `;
}

function renderDisplayBoard(board, round) {
  const combatant = round.combatants.find((entry) => entry.id === board.id);
  return `
    <article class="board-panel" style="--board-color:${board.color}">
      <div class="board-panel__head">
        <div>
          <div class="board-panel__name">${escapeHtml(board.name)}</div>
          <div class="board-panel__meta">
            ${combatant?.targetId ? 'ON THE ATTACK' : 'HOLDING POSITION'}
          </div>
        </div>
        <div class="board-panel__meta">${board.shipsSunk}/${board.shipsTotal} SUNK</div>
      </div>
      ${renderGrid({
        size: board.gridSize,
        shots: board.shots,
        ships: board.ships || [],
        revealShips: Boolean(board.ships?.length),
        label: `${board.name} grid`,
      })}
    </article>
  `;
}

function renderQuestion() {
  const round = state.round;
  const question = round?.question;
  if (!round) return renderMission();
  if (!question) {
    app.innerHTML = `
      <div class="display-shell">
        ${topbar(state)}
        ${displayRoundHead(round, { title: 'NEXT QUESTION', label: 'QUESTION PHASE', endsAt: round.quizEndsAt })}
        <main class="display-round display-round--waiting">
          <p>Next question incoming…</p>
        </main>
        ${footer()}
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="display-shell">
      ${topbar(state)}
      ${displayRoundHead(round, {
        title: 'LIVE QUESTION',
        label: `${round.answered}/${round.totalPlayers} ANSWERED`,
        endsAt: question.revealed ? question.revealUntil : question.endsAt,
      })}
      <main class="display-round display-round--question">
        <section class="display-question panel">
          <div class="display-question__meta">
            <span>Q${question.number}</span>
            <span>${escapeHtml(question.category)}</span>
            <span>${escapeHtml(question.difficulty)}</span>
          </div>
          <h2 class="display-question__prompt">${escapeHtml(question.prompt)}</h2>
          <div class="display-options">
            ${question.options
              .map(
                (option, index) => `
                <div class="display-option ${question.revealed && index === question.answerIndex ? 'is-correct' : ''} ${question.revealed && index !== question.answerIndex ? 'is-dim' : ''}">
                  <span class="display-option__key">${optionKey(index)}</span>
                  <span class="display-option__text">${escapeHtml(option)}</span>
                  ${round.answerTally ? `<span class="display-option__count">${round.answerTally[index] || 0}</span>` : ''}
                </div>`,
              )
              .join('')}
          </div>
          ${
            question.revealed
              ? `<div class="display-answer">
                   <strong>ANSWER ${optionKey(question.answerIndex)}</strong>
                   <span>${escapeHtml(question.explanation || '')}</span>
                 </div>`
              : '<div class="display-answer display-answer--hidden">CORRECT ANSWER HIDDEN UNTIL REVEAL</div>'
          }
        </section>
        ${displayScoreboard(round)}
      </main>
      ${footer()}
    </div>
  `;
}

function renderAttack() {
  const round = state.round;
  if (!round) return renderMission();
  app.innerHTML = `
    <div class="display-shell">
      ${topbar(state)}
      ${displayRoundHead(round, {
        title: 'ATTACK PHASE',
        label: `${round.attacks.length} MISSILES FIRED`,
        endsAt: round.attackEndsAt,
      })}
      <main class="display-round display-round--attack">
        <div class="display-board-grid">
          ${round.boards.map((board) => renderDisplayBoard(board, round)).join('')}
        </div>
        ${displayScoreboard(round)}
      </main>
      ${footer()}
    </div>
  `;
}

function renderRoundOver() {
  const round = state.round;
  if (!round) return renderMission();
  const outcome = round.outcome || {};
  app.innerHTML = `
    <div class="display-shell">
      ${topbar(state)}
      ${displayRoundHead(round, {
        title: 'ROUND COMPLETE',
        label: `${round.attacks.length} MISSILES // ${round.answered} ANSWERS`,
      })}
      <main class="display-round display-round--over">
        <section class="display-outcome" style="--winner:${outcome.winnerColor || 'var(--cyan)'}">
          <p class="display-outcome__eyebrow">// WINNING SIGNAL //</p>
          <h2 class="display-outcome__name">${escapeHtml(outcome.winnerName || 'ROUND COMPLETE')}</h2>
          <p class="display-outcome__reason">${escapeHtml(outcome.reason || '')}</p>
        </section>
        <div class="display-board-grid display-board-grid--compact">
          ${round.boards.map((board) => renderDisplayBoard(board, round)).join('')}
        </div>
        ${displayScoreboard(round)}
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
  switch (state.session.phase) {
    case PHASES.MISSION_READY:
      renderMission();
      break;
    case PHASES.QUESTION:
      renderQuestion();
      break;
    case PHASES.ATTACK:
      renderAttack();
      break;
    case PHASES.ROUND_OVER:
      renderRoundOver();
      break;
    default:
      renderLobby();
  }
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

on(app, 'click', async (event) => {
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
  if (button.dataset.action === 'start-round') {
    if (!socket?.connected || !code) {
      toast('Display is not connected.', 'error', '#toast-root');
      return;
    }
    button.disabled = true;
    button.textContent = 'STARTING…';
    try {
      await request(socket, EVENTS.DISPLAY_START, { code });
      sfx.success();
    } catch (error) {
      toast(error.message, 'error', '#toast-root');
      sfx.error();
      button.disabled = false;
      button.textContent = 'START ROUND';
    }
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

function updateCountdowns() {
  for (const node of document.querySelectorAll('[data-countdown]')) {
    const value = formatCountdown(node.dataset.countdown);
    if (node.textContent !== value) node.textContent = value;
    node.classList.toggle('is-low', value !== '0:00' && /^0:0?[0-9]$/.test(value));
  }
}

setInterval(updateCountdowns, 250);

setInterval(() => {
  const clock = document.querySelector('#display-clock');
  if (clock) clock.textContent = formatClock(Date.now());
}, 15_000);

if (code) {
  ensureSocket();
} else {
  renderCodeEntry();
}
