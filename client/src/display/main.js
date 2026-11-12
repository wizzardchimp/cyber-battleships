import '../../styles/theme.css';
import '../../styles/display.css';

import { LIMITS, MODE_LIST, MODE_PRESETS, PHASES, phaseLabel, setLabel } from '@shared/constants.js';
import { EVENTS } from '@shared/events.js';
import { api } from '../shared/api.js';
import { isMuted, sfx, toggleMute, unlockAudio } from '../shared/audio.js';
import { formatCountdown, syncClock } from '../shared/clock.js';
import { $, escapeHtml, toast } from '../shared/dom.js';
import { renderGrid } from '../shared/grid.js';
import { createSocket, request } from '../shared/socket.js';

const KEY_STORAGE = 'cb.display.key';
const app = $('#app');
const modalRoot = $('#modal-root');

let socket = null;
let state = null;
let connected = false;
let creating = false;
let fatal = '';

let settingsOpen = false;
let menuOpen = false;
let importUi = null;
let armed = null; // { action, timer } for two-step confirmations
let lastPhase = null;
let stageSig = '';
let chromeSig = '';
let controlsSig = '';
let modalSig = '';

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.csv,text/csv';
fileInput.hidden = true;
document.body.append(fileInput);
let importTarget = null;

// ------------------------------------------------------------------ helpers

const controlKey = () => localStorage.getItem(KEY_STORAGE) || '';
const hasControl = () => Boolean(state?.viewer?.control);
const configOf = () => state?.session?.config || {};

function play(name) {
  if (configOf().soundEnabled === false) return;
  sfx[name]?.();
}

function countdown(endsAt) {
  return `<strong class="timer__value" data-countdown="${escapeHtml(endsAt || '')}">${formatCountdown(endsAt)}</strong>`;
}

function timerBlock(label, endsAt) {
  return `<div class="timer"><span class="timer__label">${label}</span>${countdown(endsAt)}</div>`;
}

// -------------------------------------------------------------- connection

function ensureSocket() {
  if (socket) return;
  socket = createSocket();
  socket.on('hello', ({ serverNow }) => syncClock(serverNow));
  socket.on('connect', () => {
    connected = true;
    renderChromeStatus();
    subscribe();
  });
  socket.on('disconnect', () => {
    connected = false;
    renderChromeStatus();
  });
  socket.on('connect_error', () => {
    connected = false;
    renderChromeStatus();
  });
  socket.on(EVENTS.STATE, (next) => {
    syncClock(next.meta?.serverNow);
    applyState(next);
  });
  socket.on(EVENTS.TOAST, (message) => {
    toast(message.message, message.level, '#toast-root');
    if (message.level === 'join') play('join');
  });
  socket.on(EVENTS.SESSION_CLOSED, () => {
    if (creating) return;
    state = null;
    subscribe();
  });
  socket.on(EVENTS.GAME_ERROR, (error) => toast(error.message, 'error', '#toast-root'));
  socket.connect();
}

async function subscribe() {
  try {
    const wantsNew = new URLSearchParams(window.location.search).has('new');
    const result = await request(socket, EVENTS.DISPLAY_SUBSCRIBE, { key: controlKey() || null });
    if (!result.game || wantsNew) {
      await createGame({ force: wantsNew });
      if (wantsNew) window.history.replaceState({}, '', '/display');
    }
  } catch (error) {
    fatal = error.message || 'Could not reach the game server.';
    renderFatal();
  }
}

async function createGame({ force = false } = {}) {
  creating = true;
  try {
    const result = await request(socket, EVENTS.DISPLAY_CREATE, {
      key: controlKey() || null,
      force,
    });
    localStorage.setItem(KEY_STORAGE, result.key);
    settingsOpen = false;
    menuOpen = false;
    importUi = null;
    fatal = '';
  } finally {
    creating = false;
  }
}

function renderFatal() {
  if (state) return;
  app.innerHTML = `
    <div class="boot-screen">
      <div class="boot-screen__logo">CYBER BATTLESHIPS</div>
      <p class="form-error">${escapeHtml(fatal)}</p>
      <button class="btn btn--primary" type="button" data-action="reload">TRY AGAIN</button>
    </div>`;
}

function applyState(next) {
  const previous = state?.session?.phase ?? null;
  state = next;
  const phase = next.session.phase;
  if (previous !== null && previous !== phase) {
    if (phase !== PHASES.LOBBY) settingsOpen = false;
    if (phase === PHASES.QUIZ || phase === PHASES.BATTLE) play('alert');
    if (phase === PHASES.REVIEW || phase === PHASES.RESULT) play('success');
  }
  render();
}

// ------------------------------------------------------------------- shell

function ensureShell() {
  if ($('#stage')) return;
  app.innerHTML = `
    <header id="chrome" class="chrome"></header>
    <main id="stage" class="stage"></main>
    <footer id="controls" class="controls"></footer>`;
  chromeSig = '';
  stageSig = '';
  controlsSig = '';
}

function render() {
  if (!state) return;
  ensureShell();
  renderChrome();
  renderStage();
  renderControls();
  renderModal();
}

function renderChrome() {
  const phase = state.session.phase;
  const control = hasControl();
  const sig = [phase, control, isMuted(), settingsOpen, menuOpen].join('|');
  if (sig === chromeSig) return;
  chromeSig = sig;
  const gear = control
    ? `<button class="btn btn--small btn--ghost" type="button" data-action="${phase === PHASES.LOBBY ? 'settings' : 'menu'}">${phase === PHASES.LOBBY ? 'SETTINGS' : 'MENU'}</button>`
    : '';
  $('#chrome').innerHTML = `
    <div class="brand">
      <div class="brand__mark">CB</div>
      <div>
        <div class="brand__name">CYBER BATTLESHIPS</div>
        <div class="brand__tag">LIVE CYBER DEFENCE</div>
      </div>
    </div>
    <span class="badge badge--live chrome__phase">${escapeHtml(phaseLabel(phase))}</span>
    ${control ? '' : '<span class="badge badge--warn">VIEW ONLY</span>'}
    <div class="chrome__spacer"></div>
    <div id="link" class="chrome__link"></div>
    <div class="chrome__tools">
      ${gear}
      <button class="icon-btn" type="button" data-action="audio" title="Sound">${isMuted() ? 'OFF' : 'SND'}</button>
      <button class="icon-btn" type="button" data-action="fullscreen" title="Full screen">FS</button>
    </div>`;
  renderChromeStatus();
}

function renderChromeStatus() {
  const node = $('#link');
  if (!node) return;
  node.classList.toggle('is-off', !connected);
  node.innerHTML = `<span class="status-dot ${connected ? '' : 'status-dot--off'}"></span>${connected ? 'LINKED' : 'RECONNECTING'}`;
}

// ------------------------------------------------------------------- stage

function renderStage() {
  const phase = state.session.phase;
  const sig = [state.meta.version, hasControl(), armed?.action, connected].join('|');
  if (sig === stageSig) return;
  const isNew = phase !== lastPhase;
  stageSig = sig;
  lastPhase = phase;

  let html;
  switch (phase) {
    case PHASES.QUIZ:
      html = quizScreen();
      break;
    case PHASES.REVIEW:
      html = briefingScreen();
      break;
    case PHASES.BATTLE:
      html = battleScreen();
      break;
    case PHASES.RESUPPLY:
      html = resupplyScreen();
      break;
    case PHASES.RESULT:
      html = resultScreen();
      break;
    default:
      html = lobbyScreen();
  }
  const stage = $('#stage');
  stage.innerHTML = html;
  if (isNew) stage.firstElementChild?.classList.add('is-new');
  updateCountdowns();
}

function slotMarkup(player, { wrap }) {
  const control = hasControl();
  const confirming = armed?.action === `remove:${player.id}`;
  return `
    <div class="slot ${wrap ? 'slot--wrap' : ''}">
      <span class="slot__name">${escapeHtml(player.name)}</span>
      <span class="slot__state">
        <span class="slot__dot ${player.connected ? '' : 'is-off'}" title="${player.connected ? 'Online' : 'Offline'}"></span>
        ${
          control
            ? `<button class="slot__remove" type="button" data-remove="${escapeHtml(player.id)}" aria-label="Remove ${escapeHtml(player.name)}">${confirming ? '?' : '✕'}</button>`
            : ''
        }
      </span>
    </div>`;
}

function sideCard(team, { wrap }) {
  const slots = wrap
    ? team.players.map((player) => slotMarkup(player, { wrap })).join('')
    : Array.from({ length: team.maxPlayers }, (_, index) =>
        team.players[index]
          ? slotMarkup(team.players[index], { wrap })
          : '<div class="slot slot--empty">WAITING FOR PLAYER</div>',
      ).join('');
  return `
    <article class="side" style="--side:${team.color}">
      <header class="side__head">
        <h2 class="side__name">${escapeHtml(team.name)}</h2>
        <span class="side__count">${team.playerCount} / ${team.maxPlayers}</span>
      </header>
      <div class="slots ${wrap ? 'slots--wrap' : ''}">
        ${slots || '<div class="slot slot--empty">SCAN THE QR CODE TO JOIN</div>'}
      </div>
    </article>`;
}

function lobbyScreen() {
  const { session, teams, join, counts } = state;
  const config = session.config;
  const preset = MODE_PRESETS[session.mode];
  const versusCpu = Boolean(preset?.versusCpu);
  const grid = config.gridSize;

  const sides = versusCpu
    ? `<div class="sides sides--cpu">
         ${teams.map((team) => sideCard(team, { wrap: true })).join('')}
         <div class="vs">VS</div>
         <aside class="cpu-card hud" style="--bracket:var(--violet)">
           <div class="cpu-card__name">CPU<br />FIREWALL</div>
           <p class="cpu-card__note">5 hidden ships on a ${grid} × ${grid} grid. Sink them all to win.</p>
         </aside>
       </div>`
    : `<div class="sides sides--versus">
         ${sideCard(teams[0], { wrap: false })}
         <div class="vs">VS</div>
         ${sideCard(teams[1], { wrap: false })}
       </div>`;

  const tip = hasControl()
    ? counts.players === 0
      ? 'Waiting for players to scan the QR code. You can start at any time.'
      : 'Press START GAME when everyone has joined.'
    : 'Waiting for the facilitator to start the game.';

  return `
    <section class="screen lobby">
      <aside class="join-card panel hud">
        <p class="eyebrow">Scan to join</p>
        <div class="join-card__qr"><img src="${escapeHtml(join.qrUrl)}" alt="QR code to join the game" /></div>
        <div>
          <div class="join-card__label">JOIN CODE</div>
          <div class="join-card__code">${escapeHtml(join.code)}</div>
        </div>
        <div class="join-card__url">${escapeHtml(join.url.replace(/^https?:\/\//, ''))}</div>
      </aside>
      <div class="lobby__main">
        <div class="mode-strip">
          <span class="badge badge--mode">${escapeHtml(preset?.label || session.mode)}</span>
          <span class="badge">Quiz ${config.quizMinutes} min</span>
          <span class="badge">Battle ${config.battleSeconds} sec</span>
          <span class="badge">${escapeHtml(setLabel(config.questionSet))} questions</span>
          <span class="badge">Grid ${grid} × ${grid}</span>
        </div>
        ${sides}
        <p class="lobby__tip">${escapeHtml(tip)}</p>
      </div>
    </section>`;
}

function maxCorrect(teams) {
  return Math.max(1, ...teams.flatMap((team) => team.players.map((player) => player.correct)));
}

function progressCard(team, scale, many) {
  const rows = team.players
    .map(
      (player) => `
      <div class="row ${player.connected ? '' : 'is-offline'}">
        <span class="row__name">${escapeHtml(player.name)}</span>
        <span class="row__bar"><span style="width:${Math.round((player.correct / scale) * 100)}%"></span></span>
        <span class="row__nums">${player.correct} / ${player.answered}</span>
      </div>`,
    )
    .join('');
  return `
    <article class="progress" style="--side:${team.color}">
      <header class="progress__head"><h2 class="progress__name">${escapeHtml(team.name)}</h2></header>
      <div class="stats">
        <div class="stat stat--missiles"><span class="stat__value">${team.missiles}</span><span class="stat__label">Missiles</span></div>
        <div class="stat"><span class="stat__value">${team.correct}</span><span class="stat__label">Correct</span></div>
        <div class="stat"><span class="stat__value">${team.answered}</span><span class="stat__label">Answered</span></div>
        <div class="stat"><span class="stat__value">${team.accuracy}%</span><span class="stat__label">Accuracy</span></div>
      </div>
      <div class="roster-rows ${many ? 'roster-rows--two' : ''}">${rows || '<p class="muted">No players on this side.</p>'}</div>
    </article>`;
}

function quizScreen() {
  const round = state.round;
  const teams = round.teams;
  const scale = maxCorrect(teams);
  const many = teams.some((team) => team.players.length > 8);
  const later = (round.cycle || 1) > 1;
  return `
    <section class="screen quiz" style="grid-template-rows:auto minmax(0,1fr)">
      <header class="screen-head">
        <div>
          <h1 class="screen-title">${later ? `QUESTION ROUND ${round.cycle}` : 'QUIZ UNDERWAY'}</h1>
          <p class="screen-sub">${later ? 'Earn more missiles. The battle goes on until every ship on a fleet is sunk.' : 'Answer on your phone. Every correct answer earns a missile.'}</p>
        </div>
        ${timerBlock('TIME LEFT', round.quizEndsAt)}
      </header>
      <div class="progress-grid" style="--teams:${teams.length}">
        ${teams.map((team) => progressCard(team, scale, many)).join('')}
      </div>
    </section>`;
}

function topPlayer(team) {
  const best = [...team.players].sort((a, b) => b.correct - a.correct)[0];
  return best && best.correct > 0 ? best : null;
}

function briefingScreen() {
  const round = state.round;
  const teams = round.teams;
  const cpu = round.boards.find((board) => board.kind === 'cpu');
  const cards = teams
    .map((team) => {
      const best = topPlayer(team);
      return `
      <article class="brief hud" style="--side:${team.color};--bracket:${team.color}">
        <h2 class="brief__name">${escapeHtml(team.name)}</h2>
        <div>
          <div class="brief__missiles">${team.won}</div>
          <div class="brief__missiles-label">MISSILES WON</div>
        </div>
        <div class="brief__facts">
          <div class="brief__fact"><strong>${team.correct}</strong><span>CORRECT</span></div>
          <div class="brief__fact"><strong>${team.accuracy}%</strong><span>ACCURACY</span></div>
          <div class="brief__fact"><strong>${team.answered}</strong><span>ANSWERED</span></div>
        </div>
        <p class="brief__top">${best ? `Top operative: <b>${escapeHtml(best.name)}</b> (${best.correct} correct)` : 'No correct answers'}</p>
        <p class="brief__top">Ready to fire: <b>${team.missiles}</b> missile${team.missiles === 1 ? '' : 's'}</p>
      </article>`;
    })
    .join('');

  const cpuCard = cpu
    ? `<article class="brief hud" style="--side:var(--violet);--bracket:var(--violet)">
         <h2 class="brief__name">CPU FIREWALL</h2>
         <div>
           <div class="brief__missiles" style="color:var(--violet);text-shadow:0 0 40px rgba(182,109,255,0.55)">${cpu.shipsTotal}</div>
           <div class="brief__missiles-label">SHIPS TO SINK</div>
         </div>
         <p class="brief__top">Hidden on a ${cpu.gridSize} × ${cpu.gridSize} grid</p>
       </article>`
    : '';

  const columns = teams.length + (cpu ? 1 : 0);
  return `
    <section class="screen" style="grid-template-rows:auto minmax(0,1fr) auto">
      <header class="screen-head">
        <div>
          <h1 class="screen-title">BATTLE BRIEFING</h1>
          <p class="screen-sub">The quiz is over. This is what each side has won.</p>
        </div>
      </header>
      <div class="briefing-grid" style="--teams:${columns}">${cards}${cpuCard}</div>
      <p class="briefing-note">${hasControl() ? 'Press START BATTLE when everyone is ready.' : 'Waiting for the facilitator to start the battle.'}</p>
    </section>`;
}

function targetBoards(round) {
  const targeted = new Set(round.combatants.map((combatant) => combatant.targetId));
  return round.boards.filter((board) => targeted.has(board.id));
}

function attackersOf(round, boardId) {
  return round.combatants
    .filter((combatant) => combatant.targetId === boardId)
    .map((combatant) => combatant.name)
    .join(' + ');
}

function boardMarkup(round, board, { revealed }) {
  const title = board.kind === 'cpu' ? board.name : `${board.name} FLEET`;
  return `
    <article class="board" style="--side:${board.color};--board-size:${revealed ? '36vh' : '50vh'}">
      <h2 class="board__title">${escapeHtml(title)}<small>ATTACKED BY ${escapeHtml(attackersOf(round, board.id))}</small></h2>
      <div class="board__grid">${renderGrid({ size: board.gridSize, shots: board.shots, ships: board.ships || [], label: title })}</div>
      <div class="board__foot"><span>SUNK <b>${board.shipsSunk}/${board.shipsTotal}</b></span><span>SHOTS <b>${board.shots.length}</b></span></div>
    </article>`;
}

function rosterPanel(round, { detailed }) {
  const scores = new Map(round.scores.map((score) => [score.id, score]));
  const dense = round.teams.some((team) => team.players.length > 6);
  return `
    <aside class="roster-panel ${dense ? 'is-dense' : ''}">
      ${round.teams
        .map((team) => {
          const score = scores.get(team.id) || {};
          const rows = team.players
            .map(
              (player) => `
            <div class="roster-row ${player.connected ? '' : 'is-offline'}">
              <span class="roster-row__name">${escapeHtml(player.name)}</span>
              <span class="roster-row__nums">${player.hits}<small>/${player.shots}</small></span>
            </div>`,
            )
            .join('');
          return `
          <article class="roster-team" style="--side:${team.color}">
            <header class="roster-team__head">
              <h2 class="roster-team__name">${escapeHtml(team.name)}</h2>
              <div class="roster-team__nums">
                <span class="roster-team__pts">${team.points}<small>PTS</small></span>
                <span class="roster-team__ammo">${team.missiles}<small>MISSILES</small></span>
              </div>
            </header>
            ${detailed ? `<p class="roster-team__detail">${score.correct ?? 0} correct · ${score.hits ?? 0} hits · ${score.sunk ?? 0} sunk</p>` : ''}
            <div class="roster-team__rows">${rows || '<p class="muted">No players</p>'}</div>
          </article>`;
        })
        .join('')}
      <p class="roster-panel__key">PLAYER HITS / SHOTS</p>
    </aside>`;
}

function afloatBlock(round) {
  return `
    <div class="afloat">
      ${targetBoards(round)
        .map(
          (board) => `
        <div class="afloat__item" style="--side:${board.color}">
          <span class="afloat__name">${escapeHtml(board.name)}</span>
          <strong>${board.shipsTotal - board.shipsSunk}<small>/${board.shipsTotal} AFLOAT</small></strong>
        </div>`,
        )
        .join('')}
    </div>`;
}

function battleScreen() {
  const round = state.round;
  return `
    <section class="screen battle">
      <header class="screen-head">
        <div>
          <h1 class="screen-title">BATTLE</h1>
          <p class="screen-sub">Fire from your phone. One missile per shot. Sink every ship to win.</p>
        </div>
        ${timerBlock('TIME LEFT', round.battleEndsAt)}
      </header>
      <div class="battle-body">
        ${rosterPanel(round, { detailed: false })}
        <div class="boards">${targetBoards(round).map((board) => boardMarkup(round, board, { revealed: false })).join('')}</div>
      </div>
    </section>`;
}

function resupplyScreen() {
  const round = state.round;
  const reason = round.battleEndReason;
  const anyAmmo = round.teams.some((team) => team.missiles > 0);
  const title = reason === 'ammo' ? 'OUT OF MISSILES' : 'BATTLE PAUSED';
  const lead =
    reason === 'ammo'
      ? 'Nobody has any missiles left.'
      : reason === 'time'
        ? 'The battle timer ran out.'
        : 'The battle round was ended.';
  const next = hasControl()
    ? `Start another round of questions to earn more missiles${anyAmmo ? ', or resume with the missiles you have left' : ''}.`
    : 'Waiting for the facilitator to start more questions.';
  return `
    <section class="screen battle resupply">
      <header class="screen-head">
        <div>
          <h1 class="screen-title" style="color:var(--amber)">${title}</h1>
          <p class="screen-sub">${lead} ${next}</p>
          <p class="screen-sub">The game ends only when every ship on a fleet is sunk.</p>
        </div>
        ${afloatBlock(round)}
      </header>
      <div class="battle-body">
        ${rosterPanel(round, { detailed: false })}
        <div class="boards">${targetBoards(round).map((board) => boardMarkup(round, board, { revealed: false })).join('')}</div>
      </div>
    </section>`;
}

function resultScreen() {
  const round = state.round;
  const outcome = round.outcome || {};
  const preset = MODE_PRESETS[state.session.mode];
  const eyebrow = preset?.versusCpu
    ? outcome.humanWin
      ? 'MISSION COMPLETE'
      : 'MISSION FAILED'
    : outcome.draw
      ? 'NO WINNER'
      : 'WINNER';
  return `
    <section class="screen battle result">
      <div class="winner" style="--win:${escapeHtml(outcome.winnerColor || '#19e3ff')}">
        <span class="winner__eyebrow">${eyebrow}</span>
        <h1 class="winner__name">${escapeHtml(outcome.winnerName || 'GAME OVER')}</h1>
        <span class="winner__reason">${escapeHtml(outcome.reason || '')}</span>
      </div>
      <div class="battle-body">
        ${rosterPanel(round, { detailed: true })}
        <div class="boards">${targetBoards(round).map((board) => boardMarkup(round, board, { revealed: true })).join('')}</div>
      </div>
    </section>`;
}

// ---------------------------------------------------------------- controls

function button(label, { action, kind = '', main = false, confirm = false }) {
  const isArmed = armed?.action === action;
  const text = confirm && isArmed ? 'TAP AGAIN TO CONFIRM' : label;
  return `<button class="btn ${kind} ${main ? 'btn--main' : ''} ${isArmed ? 'is-confirm' : ''}" type="button" data-action="${action}" ${confirm ? 'data-confirm' : ''}>${text}</button>`;
}

function renderControls() {
  const phase = state.session.phase;
  const control = hasControl();
  const players = state.counts.players;
  const anyAmmo = Boolean(state.round?.teams?.some((team) => team.missiles > 0));
  const sig = [
    phase,
    control,
    phase === PHASES.LOBBY ? players : '',
    phase === PHASES.RESUPPLY ? anyAmmo : '',
    armed?.action,
    connected,
  ].join('|');
  if (sig === controlsSig) return;
  controlsSig = sig;

  let hint = '';
  let buttons = '';

  if (!control) {
    hint = 'View only. This screen cannot change the game.';
    buttons = button('TAKE CONTROL', { action: 'take-control', kind: 'btn--ghost', confirm: true });
  } else {
    switch (phase) {
      case PHASES.LOBBY:
        hint = `${players} of ${state.counts.capacity} players joined`;
        buttons = button('START GAME', { action: 'advance', kind: 'btn--go', main: true });
        break;
      case PHASES.QUIZ:
        hint = 'The quiz timer is running.';
        buttons =
          button('BACK TO LOBBY', { action: 'lobby', kind: 'btn--ghost', confirm: true }) +
          button('SKIP TIMER', { action: 'advance', kind: 'btn--primary', main: true });
        break;
      case PHASES.REVIEW:
        hint = 'Share the results, then launch the battle.';
        buttons =
          button('BACK TO LOBBY', { action: 'lobby', kind: 'btn--ghost', confirm: true }) +
          button('END GAME', { action: 'finish', kind: 'btn--ghost', confirm: true }) +
          button('START BATTLE', { action: 'advance', kind: 'btn--go', main: true });
        break;
      case PHASES.BATTLE:
        hint = 'The game ends when every ship on a fleet is sunk.';
        buttons =
          button('BACK TO LOBBY', { action: 'lobby', kind: 'btn--ghost', confirm: true }) +
          button('END GAME', { action: 'finish', kind: 'btn--ghost', confirm: true }) +
          button('END BATTLE ROUND', { action: 'advance', kind: 'btn--primary', main: true });
        break;
      case PHASES.RESUPPLY:
        hint = 'Start more questions to earn missiles. Boards and scores carry over.';
        buttons =
          button('BACK TO LOBBY', { action: 'lobby', kind: 'btn--ghost', confirm: true }) +
          button('END GAME', { action: 'finish', kind: 'btn--ghost', confirm: true }) +
          (anyAmmo ? button('RESUME BATTLE', { action: 'resume', kind: 'btn--primary' }) : '') +
          button('MORE QUESTIONS', { action: 'advance', kind: 'btn--go', main: true });
        break;
      case PHASES.RESULT:
        hint = 'Same players, fresh fleets. Or reset the room.';
        buttons =
          button('NEW GAME', { action: 'new-game', kind: 'btn--ghost', confirm: true }) +
          button('BACK TO LOBBY', { action: 'lobby', kind: 'btn--ghost' }) +
          button('PLAY AGAIN', { action: 'advance', kind: 'btn--go', main: true });
        break;
      default:
        break;
    }
  }

  $('#controls').innerHTML = `<span class="controls__hint">${escapeHtml(hint)}</span>${buttons}`;
}

// ------------------------------------------------------------------- modal

function setCardMarkup(set, selected) {
  const edited = set.custom;
  return `
    <div class="set-card ${selected ? 'is-selected' : ''}">
      <div class="set-card__head">
        <span class="set-card__name">${escapeHtml(setLabel(set.id))}</span>
        <button class="btn btn--small ${selected ? 'btn--primary' : ''}" type="button" data-key="questionSet" data-value="${escapeHtml(set.id)}">${selected ? 'IN USE' : 'USE THIS SET'}</button>
      </div>
      <p class="set-card__meta">${set.count} questions · ${edited ? 'your edited version' : 'built-in'}</p>
      <div class="set-card__actions">
        <button class="btn btn--small btn--ghost" type="button" data-export="${escapeHtml(set.id)}">EXPORT CSV</button>
        <button class="btn btn--small btn--ghost" type="button" data-import="${escapeHtml(set.id)}">IMPORT CSV</button>
        ${edited ? `<button class="btn btn--small btn--ghost ${armed?.action === `reset:${set.id}` ? 'is-confirm' : ''}" type="button" data-reset="${escapeHtml(set.id)}">${armed?.action === `reset:${set.id}` ? 'TAP AGAIN' : 'RESET'}</button>` : ''}
      </div>
    </div>`;
}

function importPanelMarkup() {
  if (!importUi) return '';
  const name = escapeHtml(importUi.fileName || 'file');
  const label = escapeHtml(setLabel(importUi.setId));
  if (importUi.status === 'checking') {
    return `<div class="import-panel"><p class="import-panel__title">Checking ${name}…</p></div>`;
  }
  if (importUi.status === 'saving') {
    return `<div class="import-panel"><p class="import-panel__title">Saving to the ${label} set…</p></div>`;
  }
  if (importUi.status === 'error') {
    return `
      <div class="import-panel import-panel--error">
        <p class="import-panel__title" style="color:var(--red)">NOTHING WAS CHANGED</p>
        <p class="muted">${name} has problems. Fix them in your spreadsheet and try again.</p>
        <ul>${importUi.errors.map((entry) => `<li>${entry.row ? `<b>Row ${entry.row}:</b> ` : ''}${escapeHtml(entry.message)}</li>`).join('')}</ul>
        <div class="import-panel__actions"><button class="btn btn--small" type="button" data-import-cancel>CLOSE</button></div>
      </div>`;
  }
  const current = state.questionSets.find((set) => set.id === importUi.setId);
  return `
    <div class="import-panel">
      <p class="import-panel__title" style="color:var(--green)">READY TO IMPORT INTO ${label}</p>
      <p><b>${importUi.count}</b> valid questions found in ${name}. This replaces all <b>${current?.count ?? 0}</b> questions currently in the ${label} set.</p>
      <ul>${importUi.preview.map((entry) => `<li>${escapeHtml(entry.prompt)}</li>`).join('')}</ul>
      ${importUi.warnings.length ? `<ul>${importUi.warnings.map((entry) => `<li><b>${entry.row ? `Row ${entry.row}` : 'Note'}:</b> ${escapeHtml(entry.message)}</li>`).join('')}</ul>` : ''}
      <div class="import-panel__actions">
        <button class="btn btn--small btn--go" type="button" data-import-confirm>CONFIRM IMPORT</button>
        <button class="btn btn--small btn--ghost" type="button" data-import-cancel>CANCEL</button>
      </div>
    </div>`;
}

function segMarkup(key, values, current, { suffix = '', labels = null } = {}) {
  return `<div class="seg">${values
    .map(
      (value) =>
        `<button class="seg__opt ${String(current) === String(value) ? 'is-active' : ''}" type="button" data-key="${key}" data-value="${value}">${labels ? labels[value] : value}${suffix}</button>`,
    )
    .join('')}</div>`;
}

function settingsModal() {
  const config = configOf();
  const players = state.counts.players;
  const modeCards = MODE_LIST.map(
    (preset) => `
      <button class="mode-card ${config.mode === preset.id ? 'is-active' : ''}" type="button" data-key="mode" data-value="${preset.id}">
        <strong>${escapeHtml(preset.label)}</strong>
        <span>${escapeHtml(preset.blurb)}</span>
      </button>`,
  ).join('');

  return `
    <div class="modal-backdrop" data-backdrop>
      <section class="modal hud" role="dialog" aria-modal="true" aria-label="Game settings">
        <header class="modal__head">
          <h2 class="modal__title">GAME SETTINGS</h2>
          <span class="badge badge--warn">${players} joined</span>
        </header>
        <div class="modal__body">
          <div class="setting">
            <span class="setting__label">GAME MODE</span>
            <div class="mode-cards">${modeCards}</div>
          </div>
          <div class="setting-grid">
            <div class="setting">
              <span class="setting__label">QUIZ TIME</span>
              ${segMarkup('quizMinutes', range(LIMITS.minQuizMinutes, LIMITS.maxQuizMinutes), config.quizMinutes, { suffix: ' MIN' })}
            </div>
            <div class="setting">
              <span class="setting__label">BATTLE TIME</span>
              ${segMarkup('battleSeconds', [30, 60, 90, 120, 180], config.battleSeconds, { suffix: 's' })}
            </div>
            <div class="setting">
              <span class="setting__label">GRID SIZE</span>
              ${segMarkup('gridSize', [8, 10, 12], config.gridSize)}
            </div>
          </div>
          <div class="setting">
            <span class="setting__label">QUESTION SET</span>
            <div class="setting-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
              ${state.questionSets.map((set) => setCardMarkup(set, set.id === config.questionSet)).join('')}
            </div>
            ${importPanelMarkup()}
            <p class="setting__help">Export a set to get a CSV file, edit it in Excel or Google Sheets, then import it back. Each row is one question with three answers and the columns below. Import replaces only the set you choose.</p>
            <div class="code-block">category, question, option_a, option_b, option_c, correct (A, B or C), explanation</div>
          </div>
          <div class="setting">
            <span class="setting__label">SOUND EFFECTS</span>
            ${segMarkup('soundEnabled', ['true', 'false'], String(config.soundEnabled), { labels: { true: 'ON', false: 'OFF' } })}
          </div>
        </div>
        <footer class="modal__foot">
          <button class="btn btn--primary" type="button" data-modal="close">DONE</button>
        </footer>
      </section>
    </div>`;
}

function menuModal() {
  return `
    <div class="modal-backdrop" data-backdrop>
      <section class="modal hud" role="dialog" aria-modal="true" aria-label="Game menu" style="max-width:36rem">
        <header class="modal__head"><h2 class="modal__title">GAME MENU</h2></header>
        <div class="modal__body">
          <p class="setting__help" style="font-size:1.15rem">Settings can only be changed in the lobby. Go back to the lobby to adjust them, or start a new game with a fresh join code.</p>
          ${button('BACK TO LOBBY', { action: 'lobby', kind: 'btn--wide', confirm: true })}
          ${button('NEW GAME (NEW CODE)', { action: 'new-game', kind: 'btn--wide btn--danger', confirm: true })}
        </div>
        <footer class="modal__foot"><button class="btn btn--primary" type="button" data-modal="close">CLOSE</button></footer>
      </section>
    </div>`;
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function renderModal() {
  const open = (settingsOpen || menuOpen) && hasControl();
  if (!open) {
    if (modalSig !== '') {
      modalRoot.innerHTML = '';
      modalSig = '';
    }
    return;
  }
  const sig = JSON.stringify([
    settingsOpen,
    menuOpen,
    configOf(),
    state.questionSets,
    state.counts.players,
    importUi,
    armed?.action,
  ]);
  if (sig === modalSig) return;
  const body = $('.modal__body', modalRoot);
  const scroll = body ? body.scrollTop : 0;
  modalSig = sig;
  modalRoot.innerHTML = settingsOpen ? settingsModal() : menuModal();
  const next = $('.modal__body', modalRoot);
  if (next) next.scrollTop = scroll;
}

// ----------------------------------------------------------------- actions

async function send(event, payload = {}) {
  try {
    await request(socket, event, payload);
    return true;
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
    play('error');
    return false;
  }
}

function disarm() {
  if (armed?.timer) clearTimeout(armed.timer);
  armed = null;
}

function arm(action) {
  disarm();
  armed = {
    action,
    timer: setTimeout(() => {
      armed = null;
      stageSig = '';
      controlsSig = '';
      modalSig = '';
      render();
    }, 3500),
  };
  stageSig = '';
  controlsSig = '';
  modalSig = '';
  render();
}

async function runAction(action, node) {
  if (node) node.disabled = true;
  let ok = true;
  switch (action) {
    case 'advance':
      ok = await send(EVENTS.DISPLAY_ADVANCE);
      break;
    case 'resume':
      ok = await send(EVENTS.DISPLAY_RESUME);
      break;
    case 'finish':
      ok = await send(EVENTS.DISPLAY_FINISH);
      break;
    case 'lobby':
      ok = await send(EVENTS.DISPLAY_LOBBY);
      if (ok) menuOpen = false;
      break;
    case 'new-game':
    case 'take-control':
      try {
        await createGame({ force: action === 'take-control' });
      } catch (error) {
        ok = false;
        toast(error.message, 'error', '#toast-root');
      }
      break;
    default:
      break;
  }
  if (!ok && node) node.disabled = false;
  if (ok) play('click');
  chromeSig = '';
  render();
}

async function patchSettings(patch) {
  const ok = await send(EVENTS.DISPLAY_SETTINGS, { patch });
  if (ok) play('click');
}

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

async function exportSet(id) {
  try {
    const response = await fetch(`/api/questions/${encodeURIComponent(id)}/export.csv`, {
      headers: { 'x-control-key': controlKey() },
    });
    if (!response.ok) throw new Error('Only the game screen that started this game can export questions.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cyber-battleships-${id}-questions.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`${setLabel(id)} questions exported.`, 'success', '#toast-root');
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
  }
}

async function importRequest(setId, body) {
  return api(`/api/questions/${encodeURIComponent(setId)}/import`, {
    method: 'POST',
    headers: { 'x-control-key': controlKey() },
    body,
  });
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  const setId = importTarget;
  fileInput.value = '';
  if (!file || !setId) return;
  if (file.size > 1_000_000) {
    toast('That file is larger than 1 MB.', 'error', '#toast-root');
    return;
  }
  const csv = await file.text();
  importUi = { status: 'checking', setId, fileName: file.name };
  modalSig = '';
  render();
  try {
    const result = await importRequest(setId, { csv, dryRun: true });
    importUi = {
      status: 'preview',
      setId,
      fileName: file.name,
      csv,
      count: result.count,
      preview: result.preview || [],
      warnings: result.warnings || [],
    };
  } catch (error) {
    if (error.status === 422 && error.payload?.errors) {
      importUi = {
        status: 'error',
        setId,
        fileName: file.name,
        errors: error.payload.errors,
        warnings: error.payload.warnings || [],
      };
    } else {
      importUi = null;
      toast(error.message, 'error', '#toast-root');
    }
  }
  modalSig = '';
  render();
});

async function confirmImport() {
  if (!importUi || importUi.status !== 'preview') return;
  const { setId, csv, count } = importUi;
  importUi = { ...importUi, status: 'saving' };
  modalSig = '';
  render();
  try {
    await importRequest(setId, { csv });
    toast(`${setLabel(setId)} set replaced with ${count} questions.`, 'success', '#toast-root');
    play('success');
    importUi = null;
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
    importUi = null;
  }
  modalSig = '';
  render();
}

async function resetSet(id) {
  try {
    await api(`/api/questions/${encodeURIComponent(id)}/reset`, {
      method: 'POST',
      headers: { 'x-control-key': controlKey() },
    });
    toast(`${setLabel(id)} set restored to the built-in questions.`, 'success', '#toast-root');
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
  }
}

document.addEventListener('click', (event) => {
  unlockAudio();
  const target = event.target;

  if (target.closest('[data-backdrop]') && target === target.closest('[data-backdrop]')) {
    settingsOpen = false;
    menuOpen = false;
    importUi = null;
    chromeSig = '';
    render();
    return;
  }

  const modalClose = target.closest('[data-modal="close"]');
  if (modalClose) {
    settingsOpen = false;
    menuOpen = false;
    importUi = null;
    chromeSig = '';
    render();
    return;
  }

  const setting = target.closest('[data-key]');
  if (setting) {
    patchSettings({ [setting.dataset.key]: parseValue(setting.dataset.value) });
    return;
  }

  const exportButton = target.closest('[data-export]');
  if (exportButton) {
    exportSet(exportButton.dataset.export);
    return;
  }

  const importButton = target.closest('[data-import]');
  if (importButton) {
    importTarget = importButton.dataset.import;
    fileInput.click();
    return;
  }

  if (target.closest('[data-import-confirm]')) {
    confirmImport();
    return;
  }
  if (target.closest('[data-import-cancel]')) {
    importUi = null;
    modalSig = '';
    render();
    return;
  }

  const reset = target.closest('[data-reset]');
  if (reset) {
    const key = `reset:${reset.dataset.reset}`;
    if (armed?.action === key) {
      disarm();
      resetSet(reset.dataset.reset);
    } else {
      arm(key);
    }
    return;
  }

  const remove = target.closest('[data-remove]');
  if (remove) {
    const key = `remove:${remove.dataset.remove}`;
    if (armed?.action === key) {
      disarm();
      send(EVENTS.DISPLAY_REMOVE, { playerId: remove.dataset.remove });
    } else {
      arm(key);
    }
    return;
  }

  const actionNode = target.closest('[data-action]');
  if (!actionNode) return;
  const action = actionNode.dataset.action;

  switch (action) {
    case 'audio':
      toggleMute();
      chromeSig = '';
      render();
      return;
    case 'fullscreen':
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen?.().catch(() => {});
      return;
    case 'settings':
      settingsOpen = true;
      modalSig = '';
      chromeSig = '';
      render();
      return;
    case 'menu':
      menuOpen = true;
      modalSig = '';
      chromeSig = '';
      render();
      return;
    case 'reload':
      window.location.reload();
      return;
    default:
      break;
  }

  if (actionNode.hasAttribute('data-confirm') && armed?.action !== action) {
    arm(action);
    return;
  }
  disarm();
  runAction(action, actionNode);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (settingsOpen || menuOpen)) {
    settingsOpen = false;
    menuOpen = false;
    importUi = null;
    chromeSig = '';
    render();
  }
});

// ---------------------------------------------------------------- countdown

function updateCountdowns() {
  for (const node of document.querySelectorAll('[data-countdown]')) {
    const value = formatCountdown(node.dataset.countdown);
    if (node.textContent !== value) node.textContent = value;
    const [minutes, seconds] = value.split(':').map(Number);
    node.classList.toggle('is-low', minutes === 0 && seconds <= 10 && node.dataset.countdown !== '');
  }
}

setInterval(updateCountdowns, 250);

ensureSocket();
