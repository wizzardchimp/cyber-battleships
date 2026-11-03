/**
 * Presentation dashboard controller.
 *
 * Renders the projector view from role-scoped state snapshots and layers
 * canvas FX on top. Ship positions are never present in this state - only
 * hits, misses and already-sunk ships.
 */

import { $, esc, fmt, showToast, COLUMN_LABELS } from './lib/dom.js';
import { AudioEngine } from './lib/audio.js';
import { FxLayer } from './lib/fx.js';
import { connect } from './lib/socket.js';

const PHASE_LABELS = {
  lobby: 'STANDBY',
  question: 'BRIEFING LIVE',
  reveal: 'SOLUTION',
  battle: 'COMBAT',
  ended: 'DEBRIEF',
};

const VIEW_FOR_PHASE = {
  lobby: 'lobby',
  question: 'question',
  reveal: 'reveal',
  battle: 'battle',
  ended: 'ended',
};

const SHIP_SHORT = {
  carrier: 'CARRIER',
  battleship: 'BATTLESHIP',
  cruiser: 'CRUISER',
  submarine: 'SUBMARINE',
  destroyer: 'DESTROYER',
};

const audio = new AudioEngine();
const fx = new FxLayer($('#fxCanvas'));

let state = null;
let lastPhase = null;
let lastQuestionId = null;
let serverOffset = 0;
let lastShotSeq = 0;
let lobbySignature = '';
let questionSignature = '';
let revealSignature = '';
let battleKey = '';
let finalSignature = '';
let currentView = null;
let qrCache = { code: null, url: null, joinUrl: null };
let qrFetching = null;

const pendingCells = new Map(); // "gridId:col,row" -> previous cell state
const pendingGrids = new Map(); // gridId -> { count, snapshot }
const battleCells = new Map(); // gridId -> Map<"col,row", element>
const battlePanels = new Map(); // gridId -> { panel, refs }

const views = {
  lobby: $('#lobbyView'),
  question: $('#questionView'),
  reveal: $('#revealView'),
  battle: $('#battleView'),
  ended: $('#endedView'),
};

/* --------------------------------------------------------------- bootstrap */

const gate = $('#gate');
$('#gateButton').addEventListener('click', async () => {
  await audio.init();
  audio.play('alarm');
  gate.classList.add('closing');
  setTimeout(() => gate.classList.add('hidden'), 550);
});

const soundToggle = $('#soundToggle');
const syncSoundLabel = () => {
  $('#soundLabel').textContent = audio.enabled ? 'SOUND ON' : 'MUTED';
  soundToggle.setAttribute('aria-pressed', String(audio.enabled));
};
soundToggle.addEventListener('click', () => {
  audio.toggle();
  syncSoundLabel();
});
syncSoundLabel();

const socket = connect();
let hostToken = localStorage.getItem('cb.hostToken') || '';
let pendingNext = false;

socket.on('host:ok', ({ token } = {}) => {
  if (token) {
    hostToken = String(token);
    localStorage.setItem('cb.hostToken', hostToken);
  }
  if (pendingNext) {
    pendingNext = false;
    socket.emit('host:next');
  }
});

socket.on('host:denied', () => {
  hostToken = '';
  localStorage.removeItem('cb.hostToken');
  pendingNext = false;
  showToast('Presenter PIN rejected.', 'bad');
});

function requestNextQuestion() {
  if (pendingNext) return;
  if (hostToken) {
    socket.emit('host:next');
    return;
  }
  const pin = window.prompt('Enter the presenter PIN to advance the question');
  if (!pin) return;
  pendingNext = true;
  socket.emit('host:auth', { pin: pin.trim() });
  window.setTimeout(() => {
    if (pendingNext) {
      pendingNext = false;
      showToast('No response from the server.', 'warn');
    }
  }, 5000);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {
      showToast('Fullscreen is not available in this browser.', 'warn');
    });
  } else {
    document.exitFullscreen?.();
  }
}

// Floating controls for the projector operator.
const controlBar = document.createElement('div');
controlBar.className = 'display-controls';
controlBar.innerHTML = `
  <button type="button" class="display-control" data-action="next" title="Next question (N / Space / →)">NEXT ▶</button>
  <button type="button" class="display-control" data-action="fullscreen" title="Toggle fullscreen (F)">⛶</button>`;
document.body.appendChild(controlBar);

controlBar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'next') requestNextQuestion();
  else if (button.dataset.action === 'fullscreen') toggleFullscreen();
});

document.addEventListener('keydown', (event) => {
  const tag = (event.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (event.key === ' ' || event.key === 'ArrowRight' || event.key === 'n' || event.key === 'N') {
    event.preventDefault();
    requestNextQuestion();
  } else if (event.key === 'f' || event.key === 'F' || event.key === 'F11') {
    event.preventDefault();
    toggleFullscreen();
  }
});

socket.on('connect', () => {
  connected = true;
  $('#linkState').classList.remove('down');
  $('#linkLabel').textContent = 'LINK STABLE';
  socket.emit('display:hello');
});

socket.on('disconnect', () => {
  connected = false;
  $('#linkState').classList.add('down');
  $('#linkLabel').textContent = 'LINK LOST';
});

socket.on('connect_error', () => {
  $('#linkState').classList.add('down');
  $('#linkLabel').textContent = 'RECONNECTING';
});

socket.on('state', (nextState) => {
  if (!nextState) return;
  const previous = state;
  state = nextState;
  serverOffset = nextState.serverNow - Date.now();
  applyHeader();
  renderScoreRail();
  setView(nextState.phase);
  renderActiveView();
  updatePause();
  updateTicker(previous);
  ensureQr();

  if (previous?.phase !== nextState.phase) {
    onPhaseChange(previous?.phase, nextState.phase);
    lastPhase = nextState.phase;
  }
});

socket.on('toast', (toast) => {
  if (!toast?.message) return;
  const type = toast.level === 'award' ? 'warn' : (toast.level === 'leave' ? 'bad' : 'good');
  showToast(toast.message, type);
  if (toast.level === 'join') audio.play('join');
});

socket.on('game:error', (error) => {
  if (error?.message) showToast(error.message, 'bad');
});

socket.on('fx', (event) => {
  if (!event) return;
  switch (event.type) {
    case 'fire':
      handleFireFx(event);
      break;
    case 'award':
      audio.play('award');
      showToast(`${event.playerName} secured a missile for ${event.teamName}`, 'warn', 2800);
      break;
    case 'eliminate':
      audio.play('eliminate');
      showToast(`${event.teamName} — FLEET DESTROYED`, 'bad', 5200);
      document.body.classList.add('shake');
      setTimeout(() => document.body.classList.remove('shake'), 550);
      break;
    case 'gameover':
      audio.play('victory');
      break;
    case 'start':
      audio.play('alarm');
      showToast('Operation live. First briefing inbound.', 'good', 3500);
      break;
    default:
      break;
  }
});

setInterval(tickTimer, 100);

/* ----------------------------------------------------------------- helpers */

function applyHeader() {
  if (!state) return;
  $('#headerCode').textContent = state.code;
  const chip = $('#phaseChip');
  chip.dataset.phase = state.phase;
  $('#phaseLabel').textContent = PHASE_LABELS[state.phase] || 'STANDBY';
  $('#pauseChip').classList.toggle('hidden', !state.paused);
  document.body.dataset.phase = state.phase;
}

function setView(phase) {
  const key = VIEW_FOR_PHASE[phase] || 'lobby';
  if (currentView === key) return;
  for (const [name, element] of Object.entries(views)) {
    element.classList.toggle('active', name === key);
  }
  currentView = key;
}

function renderActiveView() {
  if (!state) return;
  switch (state.phase) {
    case 'lobby':
      renderLobby();
      break;
    case 'question':
      renderQuestion();
      updateQuestionLive();
      break;
    case 'reveal':
      renderReveal();
      break;
    case 'battle':
      renderBattle();
      break;
    case 'ended':
      renderEnded();
      break;
    default:
      break;
  }
}

function onPhaseChange(previous, next) {
  if (next === 'question') audio.play('brief');
  if (next === 'reveal') audio.play('reveal');
  if (next === 'battle') audio.play('battle');
  if (next === 'ended') audio.play('victory');
  if (next === 'lobby' && previous) audio.play('ui');
  if (next !== 'battle') {
    pendingCells.clear();
    pendingGrids.clear();
  }
}

function updatePause() {
  $('#pauseOverlay').classList.toggle('hidden', !state?.paused);
}

function tickTimer() {
  if (!state) return;
  const fill = $('#timerFill');
  const number = $('#timerNumber');
  if (!fill || !number) return;
  if (state.phase !== 'question') return;
  if (state.paused || !state.phaseEndsAt || !state.settings.questionSeconds) {
    fill.style.width = state.paused ? '100%' : '100%';
    number.textContent = state.paused ? '--' : '∞';
    fill.style.background = '';
    return;
  }
  const remaining = Math.max(0, (state.phaseEndsAt - (Date.now() + serverOffset)) / 1000);
  const total = Math.max(1, state.settings.questionSeconds);
  const ratio = Math.max(0, Math.min(1, remaining / total));
  fill.style.width = `${ratio * 100}%`;
  fill.classList.toggle('low', remaining <= 8);
  number.textContent = String(Math.ceil(remaining));
}

/* -------------------------------------------------------------- score rail */

function renderScoreRail() {
  if (!state) return;
  const rail = $('#scoreRail');
  if (state.phase === 'lobby' || state.phase === 'ended') {
    rail.classList.add('hidden');
    return;
  }
  rail.classList.remove('hidden');
  rail.innerHTML = state.teams.map((team) => {
    const armed = team.missiles > 0 && !team.eliminated && state.phase === 'battle';
    return `
      <div class="team-pill ${team.eliminated ? 'eliminated' : ''} ${armed ? 'armed' : ''}" style="--team:${esc(team.color)}">
        <div class="tp-name">
          <b>${esc(team.name)}</b>
          <span>${team.playerCount} ${team.playerCount === 1 ? 'operator' : 'operators'}</span>
        </div>
        <div class="tp-missiles" title="Missiles available">${team.missiles}</div>
        <div class="tp-score"><b>${fmt(team.score)}</b><span>points</span></div>
      </div>`;
  }).join('');
}

/* ------------------------------------------------------------------- lobby */

function renderLobby() {
  if (!state) return;
  const teamsSignature = JSON.stringify({
    code: state.code,
    phase: state.phase,
    mode: state.settings.mode,
    gridCount: state.settings.gridCount,
    teams: state.teams.map((team) => [team.id, team.name, team.members, team.gridId, team.eliminated]),
    players: state.playerCount,
  });
  if (teamsSignature === lobbySignature) {
    applyQr();
    return;
  }
  lobbySignature = teamsSignature;

  const soloShared = state.settings.gridCount === 1 && state.settings.mode === 'individual';
  const title = state.settings.gridCount === 1
    ? 'SINK THE <span>TARGET FLEET</span>'
    : 'DEPLOY YOUR <span>FLEET</span>';
  const sub = state.settings.gridCount === 1
    ? 'Every operator or team attacks the same hostile fleet. Correct answers earn missiles. Most damage wins.'
    : 'Scan the code, pick a team and prepare for cyber combat. Correct answers earn missiles; missiles sink fleets.';
  const teamCards = soloShared && state.teams.length === 0
    ? `<article class="lobby-team" style="--team:#2ee6ff">
         <div class="lt-head"><h3>SOLO OPERATORS</h3><span class="lt-count">OPEN</span></div>
         <div class="lt-empty">Waiting for first registration</div>
         <div class="lt-slot">Individual scoring</div>
       </article>`
    : state.teams.map((team, index) => {
      const capacity = state.settings.mode === 'individual' ? 1 : (state.settings.maxPerTeam || '∞');
      const members = team.members.map((member) => `
        <span class="player-tag ${member.connected ? '' : 'offline'}">${esc(member.name)}</span>`).join('');
      const empty = team.members.length === 0
        ? `<div class="lt-empty">${state.settings.mode === 'individual' ? 'Open slot' : 'Awaiting operators'}</div>`
        : '';
      return `
        <article class="lobby-team" style="--team:${esc(team.color)}">
          <div class="lt-head">
            <h3>${esc(team.name)}</h3>
            <span class="lt-count">${team.members.length}/${capacity}</span>
          </div>
          <div class="lt-players">${members}</div>
          ${empty}
          <div class="lt-slot">${team.gridId ? `Fleet grid ${team.gridId.replace('g', '')}` : (state.settings.gridCount === 1 ? 'Strike group' : `Slot ${index + 1}`)}</div>
        </article>`;
    }).join('');

  views.lobby.innerHTML = `
    <div class="lobby">
      <div class="lobby-main">
        <div class="lobby-kicker">
          <span class="eyebrow">Incoming transmission</span>
          <span class="line"></span>
          <span class="chip live">Lobby open</span>
        </div>
        <h1 class="lobby-title">${title}</h1>
        <p class="lobby-sub">${esc(sub)}</p>
        <div class="lobby-steps">
          <div class="step"><b>1</b> Scan the QR code</div>
          <div class="step"><b>2</b> ${state.settings.mode === 'individual' ? 'Claim an operator slot' : 'Join a strike team'}</div>
          <div class="step"><b>3</b> Answer, earn missiles, fire</div>
        </div>
        <div class="lobby-teams">${teamCards}</div>
      </div>
      <aside class="join-panel">
        <div class="join-head">
          <h2>Secure Uplink</h2>
          <span class="chip live">${state.playerCount} connected</span>
        </div>
        <div class="qr-frame">
          <img id="qrImage" alt="QR code to join Cyber Battleships" class="${qrCache.url && qrCache.code === state.code ? '' : 'hidden'}" src="${qrCache.code === state.code && qrCache.url ? esc(qrCache.url) : ''}" />
          <div id="qrPlaceholder" class="qr-placeholder ${qrCache.url && qrCache.code === state.code ? 'hidden' : ''}">Generating<br/>uplink code…</div>
        </div>
        <div class="join-code-row">
          <span>Join code</span>
          <b>${esc(state.code)}</b>
        </div>
        <div class="join-url" id="joinUrl">${esc(state.meta?.joinUrl || '')}</div>
        <div class="join-foot">
          <span class="live-count">${state.playerCount} operator${state.playerCount === 1 ? '' : 's'} online</span>
          <span>${state.settings.gridCount} ${state.settings.gridCount === 1 ? 'target grid' : 'fleet grids'}</span>
        </div>
      </aside>
    </div>`;
  applyQr();
}

/* ---------------------------------------------------------------- question */

function renderQuestion() {
  if (!state?.round?.questions?.length) return;
  const questions = state.round.questions;
  const nextSignature = questions.map((q) => q.id).join(':');
  if (questionSignature === nextSignature) return;
  questionSignature = nextSignature;
  const letters = ['A', 'B', 'C', 'D'];
  const awardCopy = state.settings.awardMode === 'first' ? 'First correct earns missiles' : 'Correct earns missiles';

  const cards = questions.map((question) => {
    const difficulty = Math.max(1, Math.min(3, Number(question.difficulty) || 1));
    return `
      <div class="question-card">
        <div class="q-meta">
          <span class="chip live">Briefing ${String(question.number).padStart(2, '0')}</span>
          <span class="chip">${esc(question.topic || 'Cyber security')}</span>
          <span class="difficulty" title="Difficulty ${difficulty} of 3">${[1, 2, 3].map((level) => `<i class="${level <= difficulty ? 'on' : ''}"></i>`).join('')}</span>
        </div>
        <div class="q-body">
          <h1 class="q-text">${esc(question.question)}</h1>
          <div class="q-options">
            ${question.options.map((option, index) => `
              <div class="q-option">
                <span class="q-letter">${letters[index]}</span>
                <span class="q-copy">${esc(option)}</span>
              </div>`).join('')}
          </div>
        </div>
      </div>`;
  }).join('');

  views.question.innerHTML = `
    <div class="question-stage">
      <div class="round-head">
        <span class="chip live">Round ${state.round.number}</span>
        <span class="chip">${questions.length} briefings</span>
        <span class="chip warn">${esc(awardCopy)}</span>
      </div>
      <div class="question-stack">${cards}</div>
      <div class="q-foot">
        <div class="q-live">
          <span class="count" id="qCount">0/${state.answerStats.total}</span>
          <div class="label">operators<br/>locked in</div>
          <div class="names" id="qNames"></div>
        </div>
        <div class="timer-wrap">
          <div class="timer-bar"><div class="timer-fill" id="timerFill"></div></div>
          <span class="timer-number" id="timerNumber">${state.settings.questionSeconds || '∞'}</span>
        </div>
      </div>
    </div>`;
}

function updateQuestionLive() {
  if (!state?.round?.questions?.length || state.phase !== 'question') return;
  const count = $('#qCount');
  if (count) count.textContent = `${state.answerStats.answered}/${state.answerStats.total}`;
  const names = $('#qNames');
  if (names) names.textContent = state.answerStats.names.slice(0, 6).join(' · ');
}

/* ------------------------------------------------------------------ reveal */

function renderReveal() {
  if (!state?.round?.questions?.length) return;
  const questions = state.round.questions;
  const nextSignature = questions.map((q) => q.id).join(':');
  if (revealSignature === nextSignature) return;
  revealSignature = nextSignature;
  const letters = ['A', 'B', 'C', 'D'];
  const hint = state.settings.questionMode === 'auto'
    ? 'Auto-mode will open the battle phase shortly'
    : 'Presenter will open the battle phase';

  const cards = questions.map((question) => {
    const correct = question.correctIndex ?? 0;
    const awards = question.awards || [];
    return `
      <div class="reveal-card">
        <div class="reveal-banner"><span>Correct solution</span><span class="line"></span><span class="chip good">Briefing ${String(question.number).padStart(2, '0')}</span></div>
        <div class="correct-answer">
          <span class="q-letter">${letters[correct]}</span>
          <div>
            <p class="reveal-question">${esc(question.question)}</p>
            <div class="ca-copy">${esc(question.options[correct])}</div>
          </div>
        </div>
        <div class="explanation">
          <h3>Why this is the answer</h3>
          <p>${esc(question.explanation || '')}</p>
        </div>
        ${awards.length ? `<div class="award-list inline">${awards.map((award) => `
          <div class="award-item"><span class="missile">▲</span><span>${esc(award.playerName)}</span><span class="team">${esc(award.teamName)}</span></div>`).join('')}</div>` : ''}
      </div>`;
  }).join('');

  views.reveal.innerHTML = `
    <div class="reveal-stage">
      <div class="round-head">
        <span class="chip live">Round ${state.round.number}</span>
        <span class="chip">${questions.length} briefings revealed</span>
      </div>
      <div class="reveal-grid">${cards}</div>
      <aside class="reveal-side">
        <div class="mini-scores">
          <h3>Fleet standings</h3>
          ${state.teams.map((team) => `
            <div class="mini-score" style="--team:${esc(team.color)}">
              <span class="ms-dot"></span>
              <span class="ms-name">${esc(team.name)}</span>
              <span class="ms-missiles">▲ ${team.missiles}</span>
              <span class="ms-score">${fmt(team.score)}</span>
            </div>`).join('')}
        </div>
        <div class="reveal-hint">${esc(hint)}</div>
      </aside>
    </div>`;
}

/* ------------------------------------------------------------------ battle */

function renderBattle() {
  if (!state) return;
  const key = state.grids.map((grid) => `${grid.id}:${grid.ownerTeamId || 'target'}`).join('|');
  if (key !== battleKey) {
    battleKey = key;
    buildBattle();
  }
  updateBattle();
}

function buildBattle() {
  battleCells.clear();
  battlePanels.clear();

  views.battle.innerHTML = `
    <div class="battle-stage">
      <div class="battle-grids count-${Math.min(3, state.grids.length)}" id="battleGrids"></div>
      <div class="attack-feed">
        <span class="feed-label">Attack log</span>
        <div class="feed-items" id="feedItems"></div>
      </div>
    </div>`;

  const container = $('#battleGrids');

  for (const grid of state.grids) {
    const team = state.teams.find((entry) => entry.id === grid.ownerTeamId) || null;
    const color = team?.color || '#2ee6ff';
    const panel = document.createElement('article');
    panel.className = 'grid-panel';
    panel.dataset.gridId = grid.id;
    panel.style.setProperty('--team', color);
    panel.innerHTML = `
      <div class="gp-head">
        <span class="gp-color"></span>
        <div class="gp-title">
          <h2>${esc(team?.name || grid.label || 'TARGET FLEET')}</h2>
          <span class="gp-tag">${team ? (grid.id === 'target' ? 'Hostile fleet' : 'Fleet grid') : 'Hostile fleet'}</span>
        </div>
        <div class="gp-status"><span class="gp-status-copy"><span class="dot"></span><b>IN BATTLE</b></span><span class="gp-health">17/17 hull</span></div>
      </div>
      <div class="gp-metrics">
        <div class="gp-metric score"><span>${team ? 'Score' : 'Hits'}</span><b class="metric-primary">0</b></div>
        <div class="gp-metric missiles"><span>${team ? 'Missiles' : 'Sunk'}</span><b class="metric-secondary">0</b></div>
      </div>
      <div class="health-line">
        <div class="health-bar"></div>
        <span class="health-num">17/17</span>
      </div>
      <div class="grid-box"></div>
      <div class="ship-list"></div>`;

    const box = panel.querySelector('.grid-box');
    const cells = new Map();

    const corner = document.createElement('div');
    corner.className = 'grid-label';
    box.appendChild(corner);
    for (let col = 0; col < 10; col += 1) {
      const label = document.createElement('div');
      label.className = 'grid-label';
      label.textContent = COLUMN_LABELS[col];
      box.appendChild(label);
    }
    for (let row = 0; row < 10; row += 1) {
      const label = document.createElement('div');
      label.className = 'grid-label';
      label.textContent = String(row + 1);
      box.appendChild(label);
      for (let col = 0; col < 10; col += 1) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.cell = `${col},${row}`;
        box.appendChild(cell);
        cells.set(`${col},${row}`, cell);
      }
    }

    const healthBar = panel.querySelector('.health-bar');
    for (let i = 0; i < 17; i += 1) {
      const segment = document.createElement('span');
      segment.className = 'health-seg';
      healthBar.appendChild(segment);
    }

    battleCells.set(grid.id, cells);
    battlePanels.set(grid.id, {
      panel,
      statusCopy: panel.querySelector('.gp-status-copy b'),
      status: panel.querySelector('.gp-status'),
      healthText: panel.querySelector('.gp-health'),
      healthNum: panel.querySelector('.health-num'),
      healthBar,
      ships: panel.querySelector('.ship-list'),
      metricPrimary: panel.querySelector('.metric-primary'),
      metricSecondary: panel.querySelector('.metric-secondary'),
    });

    container.appendChild(panel);
  }
}

function updateBattle() {
  if (!state) return;
  for (const grid of state.grids) {
    const refs = battlePanels.get(grid.id);
    const cells = battleCells.get(grid.id);
    if (!refs || !cells) continue;

    const team = state.teams.find((entry) => entry.id === grid.ownerTeamId) || null;
    let pending = pendingGrids.get(grid.id);
    // A throttled or backgrounded browser can pause the canvas animation that
    // normally clears the pending snapshot. Never let the projector lag behind
    // the authoritative state for longer than the missile flight.
    if (pending && pending.until && Date.now() > pending.until) {
      pendingGrids.delete(grid.id);
      for (const key of [...pendingCells.keys()]) {
        if (key.startsWith(`${grid.id}:`)) pendingCells.delete(key);
      }
      pending = null;
    }
    const shown = pending ? pending.snapshot : grid;
    const health = shown.health;
    const armed = Boolean(team && team.missiles > 0 && !team.eliminated && state.phase === 'battle');
    const lost = Boolean((pending ? pending.snapshot.eliminated : grid.eliminated) || shown.destroyed);

    refs.panel.classList.toggle('armed', armed);
    refs.panel.classList.toggle('eliminated', lost);

    if (lost) {
      refs.status.classList.add('lost');
      refs.statusCopy.textContent = grid.id === 'target' ? 'TARGET NEUTRALISED' : 'FLEET LOST';
    } else if (armed) {
      refs.status.classList.remove('lost');
      refs.statusCopy.textContent = 'ARMED';
    } else {
      refs.status.classList.remove('lost');
      refs.statusCopy.textContent = state.phase === 'battle' ? 'IN BATTLE' : 'STANDBY';
    }

    refs.healthText.textContent = `${health.remaining}/${health.total} hull`;
    refs.healthNum.textContent = `${health.remaining}/${health.total}`;
    [...refs.healthBar.children].forEach((segment, index) => {
      segment.classList.toggle('lost', index >= health.remaining);
    });

    if (team) {
      refs.metricPrimary.textContent = fmt(team.score);
      refs.metricSecondary.textContent = String(team.missiles);
    } else {
      const hits = grid.shots.filter((shot) => shot.hit).length;
      const sunk = grid.ships.filter((ship) => ship.sunk).length;
      refs.metricPrimary.textContent = String(hits);
      refs.metricSecondary.textContent = `${sunk}/${grid.ships.length}`;
    }

    refs.ships.innerHTML = shown.ships.map((ship) => {
      const pips = Array.from({ length: ship.length }, (_, index) => (
        `<span class="pip ${index >= ship.remaining ? 'lost' : ''}"></span>`
      )).join('');
      return `<span class="ship-chip ${ship.sunk ? 'sunk' : ''}">${esc(SHIP_SHORT[ship.key] || ship.name)}<span class="pips">${pips}</span></span>`;
    }).join('');

    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 10; col += 1) {
        const element = cells.get(`${col},${row}`);
        const pendingState = pendingCells.get(`${grid.id}:${col},${row}`);
        const status = pendingState || grid.cells?.[row]?.[col] || 'unknown';
        setCell(element, status);
      }
    }
  }

  const feed = $('#feedItems');
  if (feed) {
    const shots = state.shots.slice(0, 5);
    feed.innerHTML = shots.length ? shots.map((shot) => `
      <span class="feed-item ${shot.sunk ? 'sunk' : (shot.hit ? 'hit' : 'miss')}">
        <b>${esc(shot.teamName)}</b> → ${esc(shot.targetName)} ${esc(shot.coord)}
        ${shot.sunk ? `SUNK ${esc(shot.sunkShipName || '')}` : (shot.hit ? 'HIT' : 'MISS')}
      </span>`).join('') : '<span class="feed-item">Awaiting first strike</span>';
  }
}

function setCell(element, status) {
  if (!element) return;
  if (element.dataset.state === status) return;
  element.dataset.state = status;
  element.classList.remove('unknown', 'miss', 'hit', 'sunk', 'ship');
  element.classList.add(status);
}

/* ------------------------------------------------------------------- ended */

function renderEnded() {
  if (!state?.final) return;
  const signature = JSON.stringify({
    endedAt: state.final.endedAt,
    ranking: state.final.ranking.map((row) => [row.teamId, row.score, row.stats]),
  });
  if (signature === finalSignature) return;
  finalSignature = signature;
  const final = state.final;
  const reason = {
    'last-fleet': 'Last fleet standing',
    'target-destroyed': 'Target fleet destroyed',
    'host-ended': 'Session closed by presenter',
    interrupted: 'Session interrupted',
  }[final.reason] || 'Operation complete';

  views.ended.innerHTML = `
    <div class="ended-stage">
      <div class="winner-block">
        <span class="eyebrow">${esc(reason)}</span>
        <h1>${esc(final.winnerName || 'NO WINNER')}</h1>
        <div class="winner-sub">${final.winnerName ? `${fmt(final.ranking[0]?.score)} points · ${final.askedQuestions} briefings · ${final.shotsFired} missiles fired` : 'No fleet survived'}</div>
      </div>
      <div class="results-table-wrap">
        <table class="results">
          <thead>
            <tr>
              <th>Team</th><th>Score</th><th>Accuracy</th><th>Missiles</th><th>Hits</th><th>Misses</th><th>Correct</th><th>Sunk</th>
            </tr>
          </thead>
          <tbody>
            ${final.ranking.map((row) => `
              <tr class="${row.teamId === final.winnerTeamId ? 'winner-row' : ''}">
                <td class="team-cell" style="--team:${esc(row.color)}">
                  <span class="dot"></span>${esc(row.name)}
                  ${row.teamId === final.winnerTeamId ? '<span class="winner-tag">WINNER</span>' : ''}
                </td>
                <td>${fmt(row.score)}</td>
                <td>${row.accuracy}%</td>
                <td>${row.stats.missilesFired}</td>
                <td>${row.stats.hits}</td>
                <td>${row.stats.misses}</td>
                <td>${row.stats.correctAnswers}</td>
                <td>${row.stats.shipsSunk}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ ticker */

function updateTicker(previous) {
  if (!state) return;
  let text = '';
  if (state.phase === 'lobby') {
    text = `Scan to join — code ${state.code} — ${state.playerCount} operator${state.playerCount === 1 ? '' : 's'} connected`;
  } else if (state.phase === 'question') {
    text = `Briefing ${String(state.round?.questions?.[0]?.number || 0).padStart(2, '0')} live — ${state.answerStats.answered} of ${state.answerStats.total} operators locked in`;
  } else if (state.phase === 'reveal') {
    text = `Solution revealed — ${state.round?.questions?.length || 0} briefings — ${state.answerStats.answered} of ${state.answerStats.total} operators locked in`;
  } else if (state.phase === 'battle') {
    const shot = state.shots[0];
    text = shot
      ? `${shot.teamName} fired at ${shot.targetName} ${shot.coord} — ${shot.sunk ? `SUNK ${shot.sunkShipName}` : (shot.hit ? 'HIT CONFIRMED' : 'MISS')}`
      : 'Battle phase — armed teams may fire at any coordinate';
  } else if (state.phase === 'ended') {
    text = `Operation complete — ${state.final?.winnerName || 'no winner'} — debrief on screen`;
  }

  const ticker = $('#tickerText');
  if (ticker) ticker.textContent = text;

  const latest = state.shots[0];
  if (latest && latest.seq !== lastShotSeq) {
    lastShotSeq = latest.seq;
    const track = $('.ticker-track');
    if (track) {
      track.classList.remove('flash');
      void track.offsetWidth;
      track.classList.add('flash');
    }
  }
}

/* ---------------------------------------------------------------------- QR */

function ensureQr() {
  if (!state) return;
  if (qrCache.code === state.code && qrCache.url) {
    applyQr();
    return;
  }
  if (qrFetching === state.code) return;
  qrFetching = state.code;
  fetch('/api/join', { cache: 'no-store' })
    .then((response) => response.json())
    .then((data) => {
      if (data?.code) {
        qrCache = { code: data.code, url: data.qr, joinUrl: data.url };
        if (state?.code === data.code) applyQr();
      }
    })
    .catch(() => {
      // Keep the placeholder; the join code is still shown.
    })
    .finally(() => {
      qrFetching = null;
    });
}

function applyQr() {
  if (!state) return;
  const image = $('#qrImage');
  const placeholder = $('#qrPlaceholder');
  if (image && qrCache.code === state.code && qrCache.url) {
    if (image.src !== qrCache.url) image.src = qrCache.url;
    image.classList.remove('hidden');
    placeholder?.classList.add('hidden');
  }
  const url = $('#joinUrl');
  if (url) url.textContent = state.meta?.joinUrl || qrCache.joinUrl || '';
}

/* --------------------------------------------------------------------- FX */

function centerOf(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function handleFireFx(event) {
  if (!state) return;
  const grid = state.grids.find((entry) => entry.id === event.targetGridId);
  const cell = battleCells.get(event.targetGridId)?.get(`${event.col},${event.row}`);
  const target = centerOf(cell);
  const key = `${event.targetGridId}:${event.col},${event.row}`;
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    pendingCells.delete(key);
    const pending = pendingGrids.get(event.targetGridId);
    if (pending) {
      pending.count -= 1;
      if (pending.count <= 0) pendingGrids.delete(event.targetGridId);
    }
    updateBattle();
  };

  // Freeze the target panel at its pre-impact state only while the projector
  // is visible and the animated missile can actually run. On a hidden tab
  // requestAnimationFrame is paused, so staging the snapshot would leave the
  // grid stuck one frame behind.
  if (grid && cell && !document.hidden) {
    if (!pendingCells.has(key)) {
      pendingCells.set(key, grid.cells?.[event.row]?.[event.col] || 'unknown');
    }
    const existing = pendingGrids.get(event.targetGridId);
    if (existing) {
      existing.count += 1;
      existing.until = Math.max(existing.until || 0, Date.now() + 1400);
    } else {
      pendingGrids.set(event.targetGridId, {
        count: 1,
        until: Date.now() + 1400,
        snapshot: {
          health: { ...grid.health },
          ships: grid.ships.map((ship) => ({ ...ship })),
          destroyed: grid.destroyed,
          eliminated: grid.eliminated,
        },
      });
    }
    updateBattle();
  }

  const team = state.teams.find((entry) => entry.id === event.teamId);
  const color = team?.color || '#2ee6ff';
  const shooterGrid = state.grids.find((entry) => entry.ownerTeamId === event.teamId);
  const shooterPanel = shooterGrid ? battlePanels.get(shooterGrid.id)?.panel : null;
  const from = shooterPanel ? centerOf(shooterPanel) : { x: window.innerWidth / 2, y: window.innerHeight - 30 };
  const to = target || { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  audio.play('launch');
  fx.muzzle(from.x, from.y, color);
  fx.launch({
    from,
    to,
    color,
    duration: 620,
    onImpact: () => {
      settle();

      if (event.hit) {
        fx.explosion(to.x, to.y, event.sunk ? '#ff3b5c' : '#ff7a45');
        audio.play(event.sunk ? 'eliminate' : 'explosion');
        document.body.classList.add('shake');
        setTimeout(() => document.body.classList.remove('shake'), 460);
      } else {
        fx.splash(to.x, to.y);
        audio.play('splash');
      }

      if (cell) {
        cell.classList.add('recent');
        setTimeout(() => cell.classList.remove('recent'), 700);
      }
      updateBattle();
    },
  });

  // Safety net for throttled frames: never leave a pending snapshot forever.
  window.setTimeout(settle, 1600);
}

/* Keep display in sync after fonts/images settle. */
window.addEventListener('resize', () => {
  if (state?.phase === 'battle') updateBattle();
});
