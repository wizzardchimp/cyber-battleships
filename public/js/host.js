/**
 * Presenter console.
 *
 * Everything here is a view over the authoritative host projection. The
 * console never decides rules: it sends intents over Socket.IO and re-renders
 * from `state` broadcasts. The only local state is transient UI state -
 * authentication, the current tab, a confirmation prompt and the ship
 * placement draft.
 */

import { $, $$, esc, fmt, showToast, downloadFile, COLUMN_LABELS } from './lib/dom.js';
import { AudioEngine } from './lib/audio.js';
import { connect } from './lib/socket.js';

const FLEET = [
  { key: 'carrier', name: 'Aircraft Carrier', length: 5 },
  { key: 'battleship', name: 'Battleship', length: 4 },
  { key: 'cruiser', name: 'Cruiser', length: 3 },
  { key: 'submarine', name: 'Submarine', length: 3 },
  { key: 'destroyer', name: 'Destroyer', length: 2 },
];

const SHIP_SHORT = {
  carrier: 'CV',
  battleship: 'BB',
  cruiser: 'CA',
  submarine: 'SS',
  destroyer: 'DD',
};

const PHASE_LABELS = {
  lobby: 'LOBBY',
  question: 'QUESTION',
  reveal: 'SOLUTION',
  battle: 'COMBAT',
  ended: 'DEBRIEF',
};

const REASON_LABELS = {
  'last-fleet': 'Last fleet standing',
  'target-destroyed': 'Target fleet destroyed',
  'host-ended': 'Session closed by presenter',
  interrupted: 'Session interrupted',
};

const audio = new AudioEngine();
const socket = connect();

const ui = {
  headerCode: $('#headerCode'),
  headerPhase: $('#headerPhase'),
  headerPlayers: $('#headerPlayers'),
  linkState: $('#linkState'),
  linkLabel: $('#linkLabel'),
  soundToggle: $('#soundToggle'),
  soundLabel: $('#soundLabel'),

  setupPanel: $('#setupPanel'),
  structureChip: $('#structureChip'),
  structureNote: $('#structureNote'),
  gridSeg: $('#gridSeg'),
  modeSeg: $('#modeSeg'),
  setMaxPerTeam: $('#setMaxPerTeam'),
  setMaxPlayers: $('#setMaxPlayers'),
  setAwardMode: $('#setAwardMode'),
  setMaxAttempts: $('#setMaxAttempts'),
  setMissileCap: $('#setMissileCap'),
  setMissilesRetained: $('#setMissilesRetained'),
  setAllowLateJoin: $('#setAllowLateJoin'),
  setRevealShips: $('#setRevealShips'),
  setQuestionMode: $('#setQuestionMode'),
  setQuestionSeconds: $('#setQuestionSeconds'),
  setRevealSeconds: $('#setRevealSeconds'),
  setAutoInterval: $('#setAutoInterval'),
  pacingNote: $('#pacingNote'),

  startBtn: $('#startBtn'),
  startIssues: $('#startIssues'),
  openDisplayBtn: $('#openDisplayBtn'),
  joinQr: $('#joinQr'),
  joinCode: $('#joinCode'),
  joinUrl: $('#joinUrl'),
  joinMeta: $('#joinMeta'),
  teamCards: $('#teamCards'),
  teamActions: $('#teamActions'),
  teamCountChip: $('#teamCountChip'),
  playerRoster: $('#playerRoster'),
  rosterCountChip: $('#rosterCountChip'),
  fleetCards: $('#fleetCards'),

  controlTitle: $('#controlTitle'),
  phaseChip: $('#phaseChip'),
  phaseLabel: $('#phaseLabel'),
  pauseChip: $('#pauseChip'),
  timerChip: $('#timerChip'),
  controlBanner: $('#controlBanner'),
  controlActions: $('#controlActions'),
  questionPanel: $('#questionPanel'),
  answerMonitor: $('#answerMonitor'),
  teamControl: $('#teamControl'),
  gridControl: $('#gridControl'),
  feedPanel: $('#feedPanel'),
  finalPanel: $('#finalPanel'),

  questionCountChip: $('#questionCountChip'),
  newQuestionBtn: $('#newQuestionBtn'),
  questionSearch: $('#questionSearch'),
  questionTopic: $('#questionTopic'),
  questionList: $('#questionList'),
  exportQuestions: $('#exportQuestions'),
  importQuestions: $('#importQuestions'),
  importFile: $('#importFile'),
  questionForm: $('#questionForm'),
  qId: $('#qId'),
  questionFormTitle: $('#questionFormTitle'),
  qModeChip: $('#qModeChip'),
  qTopic: $('#qTopic'),
  qDifficulty: $('#qDifficulty'),
  qText: $('#qText'),
  qOpt0: $('#qOpt0'),
  qOpt1: $('#qOpt1'),
  qOpt2: $('#qOpt2'),
  qOpt3: $('#qOpt3'),
  qExplanation: $('#qExplanation'),
  qSave: $('#qSave'),
  qReset: $('#qReset'),
  qDelete: $('#qDelete'),
  questionFormError: $('#questionFormError'),

  placementModal: $('#placementModal'),
  placementTitle: $('#placementTitle'),
  placementClose: $('#placementClose'),
  placementGridTabs: $('#placementGridTabs'),
  placementRotate: $('#placementRotate'),
  placementClear: $('#placementClear'),
  placementRandom: $('#placementRandom'),
  placementGrid: $('#placementGrid'),
  placementFleet: $('#placementFleet'),
  placementCount: $('#placementCount'),
  placementHint: $('#placementHint'),
  placementApply: $('#placementApply'),

  authGate: $('#authGate'),
  authForm: $('#authForm'),
  pinInput: $('#pinInput'),
  authButton: $('#authButton'),
  authError: $('#authError'),
};

let state = null;
let hostToken = localStorage.getItem('cb.hostToken') || '';
let authed = false;
let authAttempt = '';
let serverOffset = 0;
let activeTab = 'lobby';

let pendingConfirm = null;
const signatures = new Map();

let joinLoadedCode = '';
let sessionInfo = null;
let topicSignature = '';

let questionInitialised = false;
let editorQuestionId = null;
let savingQuestion = false;
let saveMatch = null;

let teamsPending = false;

const placement = {
  open: false,
  gridId: null,
  ships: {},
  selected: null,
  orientation: 'h',
  dirty: false,
  awaiting: false,
  request: null,
  hint: '',
  preview: [],
};

/* ------------------------------------------------------------------ helpers */

function setText(element, value) {
  if (!element) return;
  const next = String(value ?? '');
  if (element.textContent !== next) element.textContent = next;
}

function setHTML(element, value) {
  if (!element) return;
  const next = String(value ?? '');
  if (element.innerHTML !== next) element.innerHTML = next;
}

function paint(key, signature, element, html) {
  if (!element) return;
  if (signatures.get(key) === signature) return;
  signatures.set(key, signature);
  element.innerHTML = html;
}

function syncInput(element, value) {
  if (!element || document.activeElement === element) return;
  if (element.type === 'checkbox') {
    element.checked = Boolean(value);
    return;
  }
  const next = String(value ?? '');
  if (element.value !== next) element.value = next;
}

function setDisabled(element, disabled) {
  if (!element) return;
  if (element.disabled !== Boolean(disabled)) element.disabled = Boolean(disabled);
}

function clock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function padQuestion(number) {
  return String(number).padStart(2, '0');
}

function connectedCount() {
  if (!state) return 0;
  return state.teams
    .flatMap((team) => team.members)
    .filter((member) => member.connected).length;
}

function teamById(teamId) {
  return state?.teams.find((team) => team.id === teamId) ?? null;
}

function gridForTeam(team) {
  if (!state || !team?.gridId) return null;
  return state.grids.find((grid) => grid.id === team.gridId) ?? null;
}

function shipName(key) {
  return FLEET.find((ship) => ship.key === key)?.name || key;
}

function shipCellsKey(cells) {
  return cells.map((cell) => `${cell.col},${cell.row}`).sort().join('|');
}

function truncate(text, length = 70) {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function toastType(level) {
  if (level === 'join') return 'good';
  if (level === 'leave') return 'warn';
  if (level === 'reset') return 'warn';
  if (level === 'award') return '';
  return '';
}

/* --------------------------------------------------------------------- auth */

function showAuthGate() {
  ui.authGate.classList.remove('hidden');
}

function hideAuthGate() {
  ui.authGate.classList.add('hidden');
}

function showAuthError(message) {
  setText(ui.authError, message);
  ui.authError.classList.remove('hidden');
}

function hideAuthError() {
  ui.authError.classList.add('hidden');
}

function resetAuthButton() {
  setDisabled(ui.authButton, false);
  setText(ui.authButton, 'UNLOCK CONSOLE');
}

function setLink(mode) {
  ui.linkState.classList.remove('down', 'warn');
  if (mode === 'down') {
    ui.linkState.classList.add('down');
    setText(ui.linkLabel, 'LINK LOST');
  } else if (mode === 'warn') {
    ui.linkState.classList.add('warn');
    setText(ui.linkLabel, 'RECONNECTING');
  } else {
    setText(ui.linkLabel, 'LINK STABLE');
  }
}

ui.authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const pin = ui.pinInput.value.trim();
  if (!pin) {
    showAuthError('Enter the presenter PIN printed in the server terminal.');
    ui.pinInput.focus();
    return;
  }
  authAttempt = 'pin';
  hideAuthError();
  setDisabled(ui.authButton, true);
  setText(ui.authButton, 'UNLOCKING…');
  socket.emit('host:auth', { pin });
  window.setTimeout(resetAuthButton, 4000);
});

ui.soundToggle.addEventListener('click', async () => {
  await audio.init();
  audio.toggle();
  syncSoundButton();
});

function syncSoundButton() {
  const on = Boolean(audio.enabled);
  ui.soundToggle.setAttribute('aria-pressed', String(on));
  setText(ui.soundLabel, on ? 'SOUND ON' : 'SOUND OFF');
}

/* ------------------------------------------------------------------- socket */

socket.on('connect', () => {
  setLink('stable');
  if (hostToken) {
    authAttempt = 'token';
    socket.emit('host:auth', { token: hostToken });
  }
});

socket.on('disconnect', () => setLink('down'));

socket.io.on('reconnect_attempt', () => setLink('warn'));
socket.io.on('reconnect_error', () => setLink('warn'));

socket.on('host:ok', ({ token } = {}) => {
  const gateWasOpen = !ui.authGate.classList.contains('hidden');
  hostToken = String(token || '');
  if (hostToken) localStorage.setItem('cb.hostToken', hostToken);
  authed = true;
  authAttempt = '';
  hideAuthError();
  hideAuthGate();
  resetAuthButton();
  setLink('stable');
  if (gateWasOpen) showToast('Presenter console unlocked.', 'good');
});

socket.on('host:denied', ({ message } = {}) => {
  authed = false;
  resetAuthButton();
  showAuthGate();
  if (authAttempt === 'token') {
    hostToken = '';
    localStorage.removeItem('cb.hostToken');
    authAttempt = '';
    showAuthError('Your presenter session expired. Enter the PIN to unlock the console.');
  } else {
    showAuthError(message || 'Incorrect presenter PIN.');
  }
});

socket.on('state', (next) => {
  if (!next || next.role !== 'host') return;
  const previous = state;
  state = next;
  serverOffset = next.serverNow - Date.now();
  if (!authed) {
    authed = true;
    hideAuthGate();
  }
  render(previous);
});

socket.on('fx', (fx) => handleFx(fx));

socket.on('toast', (toast) => {
  if (!toast?.message) return;
  showToast(toast.message, toastType(toast.level));
});

socket.on('game:error', (error) => {
  showToast(error?.message || 'Action rejected.', 'bad');
  if (placement.awaiting) {
    placement.awaiting = false;
    placement.request = null;
    placement.hint = error?.message || 'The server rejected that placement.';
    renderPlacement();
  }
  if (savingQuestion) {
    savingQuestion = false;
    saveMatch = null;
    setDisabled(ui.qSave, false);
    setText(ui.qModeChip, editorQuestionId ? 'EDITING' : 'UNSAVED');
  }
});

socket.on('session:ended', () => {
  showToast('The game session was closed.', 'bad');
});

function handleFx(fx) {
  if (!fx) return;
  switch (fx.type) {
    case 'fire':
      audio.play(fx.hit ? 'explosion' : 'splash');
      break;
    case 'award':
      audio.play('award');
      break;
    case 'eliminate':
      audio.play('eliminate');
      showToast(`${fx.teamName} has been eliminated.`, 'bad');
      break;
    case 'start':
      audio.play('battle');
      break;
    case 'gameover':
      audio.play(fx.reason === 'host-ended' ? 'ui' : 'victory');
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------- render */

function render(previous) {
  if (!state) return;
  const codeChanged = !previous || previous.code !== state.code;
  const phaseChanged = Boolean(previous) && previous.phase !== state.phase;

  if (codeChanged) {
    sessionInfo = null;
    joinLoadedCode = '';
    pendingConfirm = null;
  } else if (phaseChanged) {
    pendingConfirm = null;
  }

  setText(ui.headerCode, state.code);
  document.title = `${state.code} — Cyber Battleships Presenter`;

  renderHeader();
  syncSettings();
  renderStartPanel();
  renderJoinInfo();
  renderTeams();
  renderRoster();
  renderFleets();
  renderControl();
  renderQuestions();

  if (codeChanged) refreshJoin();

  if (phaseChanged) {
    if (previous.phase === 'lobby' && state.phase !== 'lobby') activateTab('control');
    else if (previous.phase !== 'lobby' && state.phase === 'lobby') activateTab('lobby');
  } else if (!previous && state.phase !== 'lobby') {
    activateTab('control');
  }

  if (placement.open) syncPlacementWithState();

  updateTimer();
}

function renderHeader() {
  const label = PHASE_LABELS[state.phase] || String(state.phase).toUpperCase();
  setText(ui.headerPhase, label);
  ui.headerPhase.className = `chip ${state.phase === 'lobby' ? '' : 'live'}`.trim();
  setText(ui.headerPlayers, `${connectedCount()} ONLINE`);

  ui.phaseChip.dataset.phase = state.phase;
  setText(ui.phaseLabel, label);
  ui.pauseChip.classList.toggle('hidden', !state.paused);
  setText(ui.controlTitle, state.phase === 'lobby' ? 'Control' : 'Live Control');
}

function updateTimer() {
  if (!state) return;
  if (state.paused) {
    setText(ui.timerChip, 'PAUSED');
    return;
  }
  if (!state.phaseEndsAt) {
    if (state.phase === 'question') {
      setText(ui.timerChip, state.settings.questionSeconds > 0 ? '—' : 'NO TIMER');
    } else if (state.phase === 'reveal' || state.phase === 'battle') {
      setText(ui.timerChip, state.settings.questionMode === 'auto' ? '—' : 'MANUAL');
    } else {
      setText(ui.timerChip, '—');
    }
    return;
  }
  const remaining = state.phaseEndsAt - (Date.now() + serverOffset);
  setText(ui.timerChip, `NEXT ${clock(remaining)}`);
}

/* ------------------------------------------------------------------ settings */

function structuralLocked() {
  return !state || state.phase !== 'lobby' || state.playerCount > 0;
}

function syncSettings() {
  const settings = state.settings;
  const locked = structuralLocked();

  setText(ui.structureChip, locked ? 'LOCKED' : 'LOBBY EDITABLE');
  ui.structureChip.className = `chip ${locked ? 'warn' : ''}`.trim();
  setText(
    ui.structureNote,
    locked
      ? 'Structure is locked because the operation is running or operators have joined. Rules on the right stay live editable.'
      : 'Structure can only change with an empty lobby. Rules on the right can be adjusted live.',
  );

  $$('button', ui.gridSeg).forEach((button) => {
    const active = Number(button.dataset.grid) === settings.gridCount;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    setDisabled(button, locked);
  });

  $$('button', ui.modeSeg).forEach((button) => {
    const active = button.dataset.mode === settings.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    setDisabled(button, locked);
  });

  syncInput(ui.setMaxPerTeam, settings.maxPerTeam);
  syncInput(ui.setMaxPlayers, settings.maxPlayers);
  setDisabled(ui.setMaxPerTeam, locked);
  setDisabled(ui.setMaxPlayers, locked);

  syncInput(ui.setAwardMode, settings.awardMode);
  syncInput(ui.setMaxAttempts, settings.maxAttempts);
  syncInput(ui.setMissileCap, settings.missileCap);
  syncInput(ui.setMissilesRetained, settings.missilesRetained);
  syncInput(ui.setAllowLateJoin, settings.allowLateJoin);
  syncInput(ui.setRevealShips, settings.revealShips);
  syncInput(ui.setQuestionMode, settings.questionMode);
  syncInput(ui.setQuestionSeconds, settings.questionSeconds);
  syncInput(ui.setRevealSeconds, settings.revealSeconds);
  syncInput(ui.setAutoInterval, settings.autoIntervalSeconds);

  setText(
    ui.pacingNote,
    settings.questionMode === 'auto'
      ? 'Auto mode runs everything: question timer, solution pause, then a timed combat window before the next briefing.'
      : 'In manual mode, the question timer still auto-reveals the answer. You then open the combat phase and advance to the next briefing.',
  );
}

function sendSettings(patch) {
  audio.play('ui');
  socket.emit('host:settings', { patch });
}

$$('button', ui.gridSeg).forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    sendSettings({ gridCount: Number(button.dataset.grid) });
  });
});

$$('button', ui.modeSeg).forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    sendSettings({ mode: button.dataset.mode });
  });
});

function bindNumber(element, key) {
  element.addEventListener('change', () => {
    const value = Number.parseInt(element.value, 10);
    if (!Number.isFinite(value)) {
      syncSettings();
      return;
    }
    sendSettings({ [key]: value });
  });
}

bindNumber(ui.setMaxPerTeam, 'maxPerTeam');
bindNumber(ui.setMaxPlayers, 'maxPlayers');
bindNumber(ui.setMaxAttempts, 'maxAttempts');
bindNumber(ui.setMissileCap, 'missileCap');
bindNumber(ui.setQuestionSeconds, 'questionSeconds');
bindNumber(ui.setRevealSeconds, 'revealSeconds');
bindNumber(ui.setAutoInterval, 'autoIntervalSeconds');

ui.setAwardMode.addEventListener('change', () => sendSettings({ awardMode: ui.setAwardMode.value }));
ui.setQuestionMode.addEventListener('change', () => sendSettings({ questionMode: ui.setQuestionMode.value }));

for (const [element, key] of [
  [ui.setMissilesRetained, 'missilesRetained'],
  [ui.setAllowLateJoin, 'allowLateJoin'],
  [ui.setRevealShips, 'revealShips'],
]) {
  element.addEventListener('change', () => sendSettings({ [key]: element.checked }));
}

/* --------------------------------------------------------------------- tabs */

function activateTab(tab) {
  if (!tab) return;
  activeTab = tab;
  $$('.h-nav-btn').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('.h-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
  if (tab === 'questions') renderQuestionList();
  if (tab === 'control') updateTimer();
}

$$('.h-nav-btn').forEach((button) => {
  button.addEventListener('click', () => {
    audio.play('ui');
    activateTab(button.dataset.tab);
  });
});

/* -------------------------------------------------------------------- lobby */

async function refreshJoin() {
  if (!state) return;
  const code = state.code;
  if (joinLoadedCode === code && sessionInfo) {
    renderJoinInfo();
    return;
  }
  joinLoadedCode = code;
  sessionInfo = null;
  setHTML(ui.joinQr, '<div class="qr-placeholder">Generating<br />uplink code…</div>');
  ui.joinQr.dataset.code = '';
  try {
    const response = await fetch('/api/join', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!state || state.code !== data.code) return;
    sessionInfo = data;
    renderJoinInfo();
  } catch {
    if (!state || state.code !== code) return;
    setHTML(ui.joinQr, '<div class="qr-placeholder">QR unavailable<br />use the join link</div>');
    renderJoinInfo();
  }
}

function renderJoinInfo() {
  if (!state) return;
  setText(ui.joinCode, state.code);
  const url = sessionInfo?.url || state.meta?.joinUrl || '—';
  setText(ui.joinUrl, url);

  if (sessionInfo?.qr && ui.joinQr.dataset.code !== state.code) {
    setHTML(
      ui.joinQr,
      `<img src="${esc(sessionInfo.qr)}" alt="QR code to join game ${esc(state.code)}" />`,
    );
    ui.joinQr.dataset.code = state.code;
  }

  setHTML(
    ui.joinMeta,
    `<span>${state.playerCount} JOINED</span><span>${state.settings.allowLateJoin ? 'LATE JOIN OPEN' : 'LATE JOIN CLOSED'}</span>`,
  );
}

$$('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!state) return;
    const what = button.dataset.copy;
    const text = what === 'code'
      ? state.code
      : (sessionInfo?.url || state.meta?.joinUrl || '');
    if (!text) {
      showToast('No join link available yet.', 'warn');
      return;
    }
    const copied = await copyText(text);
    showToast(copied ? `${what === 'code' ? 'Code' : 'Join link'} copied.` : 'Copy failed - select the text manually.', copied ? 'good' : 'bad');
  });
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

ui.openDisplayBtn.addEventListener('click', () => {
  window.open('/display', '_blank', 'noopener');
});

ui.startBtn.addEventListener('click', () => {
  if (ui.startBtn.disabled) return;
  audio.play('battle');
  socket.emit('host:start');
});

function renderStartPanel() {
  if (state.phase !== 'lobby') {
    setHTML(ui.startIssues, '');
    setDisabled(ui.startBtn, true);
    return;
  }

  const issues = state.startIssues || [];
  const canStart = Boolean(state.canStart) && issues.length === 0;
  setDisabled(ui.startBtn, !canStart);

  if (canStart) {
    paint('start-issues', 'ok', ui.startIssues, '<div class="issues-ok">All checks passed — ready to launch.</div>');
    return;
  }

  paint(
    'start-issues',
    issues.join('|'),
    ui.startIssues,
    `<div class="issues-list"><strong>Before you can start</strong>${issues.map((issue) => `<span>${esc(issue)}</span>`).join('')}</div>`,
  );
}

function renderTeams() {
  setText(ui.teamCountChip, `${state.teams.length} TEAM${state.teams.length === 1 ? '' : 'S'}`);

  const signature = JSON.stringify({
    phase: state.phase,
    mode: state.settings.mode,
    maxPerTeam: state.settings.maxPerTeam,
    teams: state.teams.map((team) => ({
      id: team.id,
      name: team.name,
      color: team.color,
      players: team.members.map((member) => [member.id, member.name, member.connected]),
      gridId: team.gridId,
      eliminated: team.eliminated,
    })),
    grids: state.grids.map((grid) => [grid.id, grid.destroyed, grid.health.remaining, grid.ships.length]),
  });

  if (ui.teamCards.contains(document.activeElement)) {
    teamsPending = true;
    return;
  }
  teamsPending = false;

  paint('team-cards', signature, ui.teamCards, state.teams.map(teamCard).join('') || emptyHint('No teams', 'Add teams or switch the mode in Setup.'));

  const actions = [];
  if (state.phase === 'lobby') {
    if (state.isOneGrid && state.settings.mode === 'teams') {
      actions.push('<button class="btn btn-sm" type="button" data-team-action="add">ADD TEAM</button>');
    }
    if (state.grids.length) {
      actions.push('<button class="btn btn-sm" type="button" data-team-action="randomise">RANDOMISE ALL FLEETS</button>');
    }
  }
  paint('team-actions', actions.join('|') || 'none', ui.teamActions, actions.join(''));
}

function teamCard(team) {
  const grid = gridForTeam(team);
  const nickname = state.settings.mode === 'individual';
  const canRename = !nickname && state.phase === 'lobby';
  const capacity = state.settings.mode === 'individual' ? 1 : (state.settings.maxPerTeam || Infinity);

  let fleetTag = 'SHARED TARGET';
  let fleetClass = '';
  if (grid) {
    if (grid.destroyed) {
      fleetTag = 'FLEET LOST';
      fleetClass = 'lost';
    } else if (team.eliminated) {
      fleetTag = 'ELIMINATED';
      fleetClass = 'lost';
    } else if (state.phase === 'lobby') {
      fleetTag = grid.ships.length ? 'FLEET READY' : 'NO FLEET YET';
      fleetClass = grid.ships.length ? 'ready' : 'random';
    } else {
      fleetTag = `${grid.health.remaining} HULL`;
      fleetClass = grid.health.hits ? 'warn' : 'ready';
    }
  }

  const members = team.members.length
    ? team.members.map((member) => `<span class="member-chip ${member.connected ? '' : 'offline'}">${esc(member.name)}</span>`).join('')
    : '<span class="team-empty">No operators yet</span>';

  const nameField = canRename
    ? `<input class="team-name-input" type="text" maxlength="16" value="${esc(team.name)}" data-team-name="${esc(team.id)}" aria-label="Rename ${esc(team.name)}" />`
    : `<span class="team-name-static" title="${esc(team.name)}">${esc(team.name)}</span>`;

  const actions = [];
  if (grid && (state.phase === 'lobby' || state.phase === 'ended')) {
    actions.push(`<button class="mini-btn" type="button" data-place-grid="${esc(grid.id)}">PLACE</button>`);
  }
  if (state.phase === 'lobby' && state.isOneGrid && state.settings.mode === 'teams' && team.playerCount === 0) {
    actions.push(`<button class="mini-btn danger" type="button" data-remove-team="${esc(team.id)}">REMOVE</button>`);
  }

  return `
    <div class="team-card" style="--team:${esc(team.color)}">
      <div class="team-card-head">
        <span class="team-dot"></span>
        ${nameField}
        <span class="team-count">${team.playerCount}${Number.isFinite(capacity) ? `/${capacity}` : ''}</span>
      </div>
      <div class="team-members">${members}</div>
      <div class="team-card-foot">
        <span class="team-fleet-tag ${fleetClass}">${esc(fleetTag)}</span>
        <div>${actions.join('')}</div>
      </div>
    </div>`;
}

ui.teamCards.addEventListener('change', (event) => {
  const input = event.target.closest('[data-team-name]');
  if (!input || !state) return;
  const id = input.dataset.teamName;
  const name = input.value.trim();
  if (name.length < 2) {
    showToast('Team names need at least two characters.', 'warn');
    renderTeams();
    return;
  }
  socket.emit('host:teamName', { teamId: id, name });
});

ui.teamCards.addEventListener('focusout', () => {
  window.setTimeout(() => {
    if (!teamsPending) return;
    if (ui.teamCards.contains(document.activeElement)) return;
    teamsPending = false;
    renderTeams();
  }, 0);
});

ui.teamCards.addEventListener('click', (event) => {
  const place = event.target.closest('[data-place-grid]');
  if (place) {
    openPlacement(place.dataset.placeGrid);
    return;
  }
  const remove = event.target.closest('[data-remove-team]');
  if (remove) {
    const team = teamById(remove.dataset.removeTeam);
    if (!team) return;
    if (!window.confirm(`Remove ${team.name}?`)) return;
    socket.emit('host:removeTeam', { teamId: team.id });
  }
});

ui.teamActions.addEventListener('click', (event) => {
  const button = event.target.closest('[data-team-action]');
  if (!button) return;
  const action = button.dataset.teamAction;
  if (action === 'add') {
    const name = window.prompt('New team name', `TEAM ${state.teams.length + 1}`);
    if (name === null) return;
    socket.emit('host:addTeam', { name: name.trim() });
  } else if (action === 'randomise') {
    audio.play('ui');
    socket.emit('host:randomiseShips', {});
  }
});

function renderRoster() {
  setText(ui.rosterCountChip, `${state.playerCount} PLAYER${state.playerCount === 1 ? '' : 'S'}`);

  const players = state.teams.flatMap((team) => team.members.map((member) => ({ ...member, team })));
  const signature = JSON.stringify({
    phase: state.phase,
    mode: state.settings.mode,
    isOneGrid: state.isOneGrid,
    maxPerTeam: state.settings.maxPerTeam,
    teams: state.teams.map((team) => [team.id, team.name, team.color, team.playerCount]),
    players: players.map((player) => [player.id, player.name, player.connected, player.team.id]),
  });

  if (!players.length) {
    paint('roster', signature, ui.playerRoster, '<div class="roster-empty">No operators yet.<br />Show the QR code so phones can join.</div>');
    return;
  }

  const rows = players.map((player) => {
    const team = player.team;
    const teamCell = state.isOneGrid && state.settings.mode === 'individual'
      ? `<span class="roster-team"><span class="team-dot" style="--team:${esc(team.color)}"></span>${esc(team.name)}</span>`
      : `<div class="roster-team"><span class="team-dot" style="--team:${esc(team.color)}"></span>${teamSelect(player, team)}</div>`;

    return `
      <tr>
        <td>
          <span class="roster-name ${player.connected ? '' : 'offline'}">
            <i></i>${esc(player.name)}
            <small>${player.connected ? 'ONLINE' : 'OFFLINE'}</small>
          </span>
        </td>
        <td>${teamCell}</td>
        <td class="roster-total">${fmt(team.score)}</td>
        <td class="roster-actions">
          <button class="mini-btn danger" type="button" data-remove-player="${esc(player.id)}">REMOVE</button>
        </td>
      </tr>`;
  }).join('');

  paint(
    'roster',
    signature,
    ui.playerRoster,
    `<table class="roster">
      <thead><tr><th>Operator</th><th>Team</th><th>Score</th><th aria-label="Actions"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

function teamSelect(player, currentTeam) {
  const capacity = state.settings.mode === 'individual' ? 1 : (state.settings.maxPerTeam || Infinity);
  const disabled = state.phase !== 'lobby';
  const options = state.teams.map((team) => {
    const full = team.playerCount >= capacity && team.id !== currentTeam.id;
    return `<option value="${esc(team.id)}" ${team.id === currentTeam.id ? 'selected' : ''} ${full ? 'disabled' : ''}>${esc(team.name)}${full ? ' (full)' : ''}</option>`;
  }).join('');

  return `<select data-move-player="${esc(player.id)}" ${disabled ? 'disabled' : ''} aria-label="Team for ${esc(player.name)}">${options}</select>`;
}

ui.playerRoster.addEventListener('change', (event) => {
  const select = event.target.closest('[data-move-player]');
  if (!select) return;
  socket.emit('host:movePlayer', { playerId: select.dataset.movePlayer, teamId: select.value });
});

ui.playerRoster.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-player]');
  if (!button) return;
  const player = state.teams.flatMap((team) => team.members).find((member) => member.id === button.dataset.removePlayer);
  if (!player) return;
  if (!window.confirm(`Remove ${player.name} from the game?`)) return;
  socket.emit('host:removePlayer', { playerId: player.id });
});

function renderFleets() {
  const signature = JSON.stringify(state.grids.map((grid) => [
    grid.id,
    grid.label,
    grid.color,
    grid.health,
    grid.destroyed,
    grid.eliminated,
    grid.ships.map((ship) => [ship.key, ship.hits, ship.sunk]),
  ]));

  if (!state.grids.length) {
    paint('fleets', signature, ui.fleetCards, emptyHint('No fleets', 'Set the grid count in Setup.'));
    return;
  }

  paint('fleets', signature, ui.fleetCards, state.grids.map(fleetCard).join(''));
}

function fleetCard(grid) {
  const percent = grid.health.total ? Math.round((grid.health.remaining / grid.health.total) * 100) : 0;
  const status = grid.destroyed
    ? 'DESTROYED'
    : (grid.ships.length === 0 ? 'NOT PLACED' : (grid.health.hits ? `${grid.health.hits} HITS` : 'READY'));
  const statusClass = grid.destroyed ? 'lost' : (grid.ships.length === 0 ? 'warn' : (grid.health.hits ? 'warn' : 'ready'));

  const ships = grid.ships.length
    ? grid.ships.map((ship) => {
      const lost = ship.length - ship.remaining;
      const pips = Array.from({ length: ship.length }, (_, index) => `<i class="pip ${index < lost ? 'lost' : ''}"></i>`).join('');
      return `<span class="host-ship ${ship.sunk ? 'sunk' : ''}" title="${esc(ship.name)}">${esc(SHIP_SHORT[ship.key] || ship.name)}<span class="pips">${pips}</span></span>`;
    }).join('')
    : '<span class="team-empty">Randomised at launch</span>';

  const actions = [];
  if (state.phase === 'lobby' || state.phase === 'ended') {
    actions.push(`<button class="mini-btn" type="button" data-place-grid="${esc(grid.id)}">PLACE</button>`);
    actions.push(`<button class="mini-btn" type="button" data-random-grid="${esc(grid.id)}">RANDOMISE</button>`);
  }

  return `
    <div class="fleet-card" style="--team:${esc(grid.color)}">
      <div class="fleet-card-head">
        <b title="${esc(grid.label)}">${esc(grid.label)}</b>
        <span>${grid.health.remaining}/${grid.health.total} HULL</span>
      </div>
      <div class="fleet-health">
        <div class="bar"><div class="fill" style="width:${percent}%"></div></div>
        <span>${percent}%</span>
      </div>
      <div class="host-ship-list">${ships}</div>
      <div class="fleet-card-foot">
        <span class="fleet-status ${statusClass}">${esc(status)}</span>
        <div>${actions.join('')}</div>
      </div>
    </div>`;
}

ui.fleetCards.addEventListener('click', (event) => {
  const place = event.target.closest('[data-place-grid]');
  if (place) {
    openPlacement(place.dataset.placeGrid);
    return;
  }
  const random = event.target.closest('[data-random-grid]');
  if (random) {
    audio.play('ui');
    socket.emit('host:randomiseShips', { gridId: random.dataset.randomGrid });
  }
});

/* ------------------------------------------------------------------ control */

const CONTROL_OUTCOME = {
  hit: 'HIT',
  miss: 'MISS',
  sunk: 'SUNK',
};

function renderControl() {
  renderBanner();
  renderControlActions();
  renderQuestionPanel();
  renderAnswerMonitor();
  renderTeamControl();
  renderGridControl();
  renderFeed();
  renderFinal();
}

function renderBanner() {
  if (!state) return;
  let html = '';
  if (state.ending) {
    html = 'FLEET DESTROYED — the debrief is loading. Controls are locked for a moment.';
  } else if (state.paused) {
    html = 'OPERATION PAUSED — answering and firing are locked on every phone.';
  } else if (state.phase === 'question' && state.settings.questionSeconds === 0) {
    html = 'No question timer is set. Reveal the solution when the room is ready.';
  } else if (state.phase === 'battle' && state.settings.questionMode === 'manual') {
    html = 'Combat is open. Teams can fire missiles until you advance to the next briefing.';
  } else if (state.phase === 'ended') {
    html = 'Debrief complete. Restart with the same operators, or create a brand new game.';
  }

  ui.controlBanner.classList.toggle('hidden', !html);
  if (html) setText(ui.controlBanner, html);
}

function button(action, label, options = {}) {
  const classes = ['btn'];
  if (options.primary) classes.push('btn-primary');
  if (options.danger) classes.push('btn-danger');
  if (options.ghost) classes.push('btn-ghost');
  if (options.small) classes.push('btn-sm');
  return `<button class="${classes.join(' ')}" type="button" data-action="${action}" ${options.disabled ? 'disabled' : ''}>${label}</button>`;
}

function renderControlActions() {
  if (!state) return;

  if (pendingConfirm) {
    const html = `<div class="action-confirm"><span>${esc(pendingConfirm.message)}</span><button class="btn btn-sm btn-danger" type="button" data-confirm="yes">CONFIRM</button><button class="btn btn-sm" type="button" data-confirm="no">CANCEL</button></div>`;
    paint('control-actions', `confirm:${pendingConfirm.message}`, ui.controlActions, html);
    return;
  }

  const disableAll = state.ending;
  const parts = [];

  if (state.phase === 'lobby') {
    parts.push(button('start', 'START OPERATION', { primary: true, disabled: disableAll || !state.canStart }));
  } else if (state.phase === 'question') {
    parts.push(button('reveal', 'REVEAL SOLUTION', { primary: true, disabled: disableAll }));
    parts.push(button('battle', 'OPEN COMBAT', { disabled: disableAll }));
    parts.push(button('pause', state.paused ? 'RESUME' : 'PAUSE', { disabled: disableAll }));
    parts.push('<span class="spacer"></span>');
    parts.push(button('end', 'END GAME', { danger: true, disabled: disableAll }));
  } else if (state.phase === 'reveal') {
    parts.push(button('battle', 'OPEN COMBAT', { primary: true, disabled: disableAll }));
    parts.push(button('next', 'NEXT BRIEFING', { disabled: disableAll }));
    parts.push(button('pause', state.paused ? 'RESUME' : 'PAUSE', { disabled: disableAll }));
    parts.push('<span class="spacer"></span>');
    parts.push(button('end', 'END GAME', { danger: true, disabled: disableAll }));
  } else if (state.phase === 'battle') {
    parts.push(button('next', 'NEXT BRIEFING', { primary: true, disabled: disableAll }));
    parts.push(button('pause', state.paused ? 'RESUME' : 'PAUSE', { disabled: disableAll }));
    parts.push('<span class="spacer"></span>');
    parts.push(button('end', 'END GAME', { danger: true, disabled: disableAll }));
  } else if (state.phase === 'ended') {
    parts.push(button('restart', 'REMATCH', { primary: true, disabled: disableAll }));
    parts.push('<span class="spacer"></span>');
    parts.push(button('newgame', 'NEW GAME', { danger: true, disabled: disableAll }));
  }

  const signature = `${state.phase}:${state.paused}:${state.ending}:${state.canStart}:${parts.join('')}`;
  paint('control-actions', signature, ui.controlActions, parts.join(''));
}

function askConfirm(message, run) {
  pendingConfirm = { message, run };
  renderControlActions();
}

ui.controlActions.addEventListener('click', (event) => {
  const confirm = event.target.closest('[data-confirm]');
  if (confirm) {
    const approved = confirm.dataset.confirm === 'yes';
    const run = pendingConfirm?.run;
    pendingConfirm = null;
    renderControlActions();
    if (approved && run) run();
    return;
  }

  const selected = event.target.closest('[data-action]');
  if (!selected || selected.disabled) return;
  handleControlAction(selected.dataset.action);
});

function handleControlAction(action) {
  audio.play('ui');
  switch (action) {
    case 'start':
      audio.play('battle');
      socket.emit('host:start');
      break;
    case 'reveal':
      socket.emit('host:reveal');
      break;
    case 'battle':
      socket.emit('host:battle');
      break;
    case 'next':
      socket.emit('host:next');
      break;
    case 'pause':
      socket.emit('host:pause', { paused: !state.paused });
      break;
    case 'end':
      askConfirm('End the operation now and show the final ranking?', () => socket.emit('host:end'));
      break;
    case 'restart':
      askConfirm('Rematch with the same operators and fresh fleets?', () => socket.emit('host:restart'));
      break;
    case 'newgame':
      askConfirm('Create a brand new game? Every operator is disconnected and the join code changes.', () => socket.emit('host:newGame'));
      break;
    default:
      break;
  }
}

function renderQuestionPanel() {
  const question = state.question;
  if (!question) {
    const copy = state.phase === 'lobby'
      ? 'No briefing yet. Start the operation from the lobby.'
      : (state.phase === 'ended' ? 'The debrief is complete.' : 'No active briefing.');
    paint('question-panel', `${state.phase}:empty`, ui.questionPanel, emptyHint('Question monitor', copy));
    return;
  }

  const firstTeam = question.firstCorrectTeamId ? teamById(question.firstCorrectTeamId) : null;
  const awardCopy = state.settings.awardMode === 'first' ? 'First correct earns 1 missile' : 'Every correct answer earns 1 missile';
  const awards = question.awards || [];
  const signature = JSON.stringify({
    id: question.id,
    number: question.number,
    phase: state.phase,
    awards: awards.length,
    first: question.firstCorrectTeamId,
    settings: [state.settings.awardMode, state.settings.questionMode],
  });

  const options = question.options.map((option, index) => {
    const correct = index === question.correctIndex;
    return `
      <div class="q-option ${correct ? 'correct' : ''}">
        <span class="letter">${COLUMN_LABELS[index]}</span>
        <span>${esc(option)}</span>
        ${correct ? '<span class="correct-tag">Correct</span>' : ''}
      </div>`;
  }).join('');

  const html = `
    <div class="q-meta-row">
      <span class="chip live">BRIEFING ${padQuestion(question.number)}</span>
      <span class="chip">${esc(question.topic || 'Cyber security')}</span>
      <span class="chip warn">LEVEL ${question.difficulty ?? 1}</span>
      ${firstTeam ? `<span class="chip good">FIRST IN: ${esc(firstTeam.name)}</span>` : ''}
      <span class="chip">${esc(awardCopy)}</span>
    </div>
    <div class="q-text">${esc(question.question)}</div>
    <div class="q-options">${options}</div>
    ${question.explanation ? `<div class="q-explanation"><b>Presenter note</b>${esc(question.explanation)}</div>` : ''}
    ${awards.length ? `<div class="award-strip">${awards.map((award) => `<span class="award-pill">+1 ${esc(award.teamName)} · ${esc(award.playerName)}</span>`).join('')}</div>` : ''}`;

  paint('question-panel', signature, ui.questionPanel, html);
}

function renderAnswerMonitor() {
  const stats = state.answerStats;
  const details = stats?.details || [];
  if (!state.question || !details.length) {
    paint('answer-monitor', 'empty', ui.answerMonitor, emptyHint('Answer monitor', 'Operator answers appear here during a briefing.'));
    return;
  }

  const total = stats.total || details.length;
  const percent = total ? Math.round((stats.answered / total) * 100) : 0;
  const signature = JSON.stringify({
    id: state.question.id,
    answered: stats.answered,
    total,
    rows: details.map((row) => [row.playerId, row.attempts, row.answerIndex, row.correct, row.locked, row.awarded]),
  });

  const rows = details.map((row) => {
    const team = teamById(row.teamId);
    let stateLabel = 'NO ANSWER';
    let stateClass = 'pending';
    if (row.attempts > 0) {
      if (row.correct === true) {
        stateLabel = 'CORRECT';
        stateClass = 'correct';
      } else if (row.locked) {
        stateLabel = 'INCORRECT';
        stateClass = 'wrong';
      } else {
        stateLabel = 'RETRY';
        stateClass = 'pending';
      }
    }
    if (!row.connected) stateLabel = 'OFFLINE';

    return `
      <div class="answer-row">
        <span class="name">
          <span class="team-dot" style="--team:${esc(team?.color || '#25e6ff')}"></span>
          <b>${esc(row.name)}</b>
          <small>${esc(row.teamName)} · x${row.attempts}</small>
        </span>
        <span class="state ${stateClass}">${stateLabel}</span>
        <span class="award ${row.awarded ? '' : 'dim'}">${row.awarded ? '+1 MISSILE' : '—'}</span>
      </div>`;
  }).join('');

  const html = `
    <div class="answer-summary">
      <span class="big">${stats.answered}/${total}</span>
      <span class="label">OPERATORS<br />LOCKED IN</span>
      <div class="progress"><i style="width:${percent}%"></i></div>
    </div>
    <div class="answer-rows">${rows}</div>`;

  paint('answer-monitor', signature, ui.answerMonitor, html);
}

function renderTeamControl() {
  if (!state.teams.length) {
    paint('team-control', 'empty', ui.teamControl, emptyHint('Team telemetry', 'Teams appear once the game is configured.'));
    return;
  }

  const signature = JSON.stringify(state.teams.map((team) => [team.id, team.name, team.color, team.score, team.missiles, team.eliminated, team.playerCount]));
  const rows = state.teams.map((team) => `
    <div class="team-control-row ${team.eliminated ? 'eliminated' : ''}" style="--team:${esc(team.color)}">
      <span class="team-dot"></span>
      <span class="team-control-name">
        <b title="${esc(team.name)}">${esc(team.name)}</b>
        <span>${team.eliminated ? 'ELIMINATED' : `${team.playerCount} OPERATOR${team.playerCount === 1 ? '' : 'S'}`}</span>
      </span>
      <span class="team-score">${fmt(team.score)}</span>
      <span class="missile-control" title="Manually adjust missiles">
        <button type="button" data-missiles="${esc(team.id)}" data-delta="-1" aria-label="Remove a missile from ${esc(team.name)}">−</button>
        <b>${team.missiles}</b>
        <button type="button" data-missiles="${esc(team.id)}" data-delta="1" aria-label="Give a missile to ${esc(team.name)}">+</button>
      </span>
    </div>`).join('');

  paint('team-control', signature, ui.teamControl, `<div class="team-control-list">${rows}</div>`);
}

ui.teamControl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-missiles]');
  if (!button) return;
  socket.emit('host:missiles', {
    teamId: button.dataset.missiles,
    delta: Number(button.dataset.delta),
  });
});

function renderGridControl() {
  if (!state.grids.length) {
    paint('grid-control', 'empty', ui.gridControl, emptyHint('Fleet grids', 'No grids configured.'));
    return;
  }

  const signature = JSON.stringify(state.grids.map((grid) => [
    grid.id,
    grid.label,
    grid.color,
    grid.destroyed,
    grid.eliminated,
    grid.cells.map((row) => row.join('')).join('|'),
    grid.ships.map((ship) => [ship.key, ship.hits, ship.sunk]),
  ]));

  paint('grid-control', signature, ui.gridControl, `<div class="host-grids">${state.grids.map(hostGrid).join('')}</div>`);
}

function hostGrid(grid) {
  const cells = [];
  cells.push('<span class="host-grid-label"></span>');
  for (const label of COLUMN_LABELS) cells.push(`<span class="host-grid-label">${label}</span>`);

  grid.cells.forEach((row, rowIndex) => {
    cells.push(`<span class="host-grid-label">${rowIndex + 1}</span>`);
    row.forEach((status, colIndex) => {
      const extra = status === 'unknown' ? '' : ` ${status}`;
      cells.push(`<span class="host-cell${extra}" title="${COLUMN_LABELS[colIndex]}${rowIndex + 1}"></span>`);
    });
  });

  const ships = grid.ships.map((ship) => {
    const lost = ship.length - ship.remaining;
    const pips = Array.from({ length: ship.length }, (_, index) => `<i class="pip ${index < lost ? 'lost' : ''}"></i>`).join('');
    return `<span class="host-ship ${ship.sunk ? 'sunk' : ''}" title="${esc(ship.name)}">${esc(SHIP_SHORT[ship.key] || ship.name)}<span class="pips">${pips}</span></span>`;
  }).join('');

  return `
    <div class="host-grid ${grid.eliminated ? 'eliminated' : ''}" style="--team:${esc(grid.color)}">
      <div class="host-grid-head">
        <b title="${esc(grid.label)}">${esc(grid.label)}</b>
        <span>${grid.health.remaining}/${grid.health.total} HULL</span>
      </div>
      <div class="host-grid-box">${cells.join('')}</div>
      <div class="host-ship-list">${ships}</div>
    </div>`;
}

function renderFeed() {
  if (!state.shots.length) {
    paint('feed', 'empty', ui.feedPanel, emptyHint('Attack feed', 'Shots appear here as teams open fire.'));
    return;
  }

  const signature = JSON.stringify(state.shots.map((shot) => [shot.seq, shot.hit, shot.sunk]));
  const rows = state.shots.map((shot) => {
    const outcome = shot.sunk ? CONTROL_OUTCOME.sunk : (shot.hit ? CONTROL_OUTCOME.hit : CONTROL_OUTCOME.miss);
    const time = new Date(shot.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `
      <div class="feed-row">
        <span class="feed-time">${time}</span>
        <span class="feed-copy"><b>${esc(shot.playerName)}</b> <span>${esc(shot.teamName)} → ${esc(shot.targetName)} · ${esc(shot.coord)}</span></span>
        <span class="feed-outcome ${outcome.toLowerCase()}">${outcome}</span>
      </div>`;
  }).join('');

  paint('feed', signature, ui.feedPanel, `<div class="feed-list">${rows}</div>`);
}

function renderFinal() {
  if (!state.final) {
    const copy = state.phase === 'ended'
      ? 'Waiting for the final ranking.'
      : 'The final ranking appears after the operation ends.';
    paint('final', 'empty', ui.finalPanel, emptyHint('Final results', copy));
    return;
  }

  const final = state.final;
  const signature = JSON.stringify({
    endedAt: final.endedAt,
    winner: final.winnerTeamId,
    ranking: final.ranking.map((row) => [row.teamId, row.score, row.stats]),
  });
  const reason = REASON_LABELS[final.reason] || 'Operation complete';

  const rows = final.ranking.map((row, index) => `
    <div class="final-row ${row.teamId === final.winnerTeamId ? 'winner' : ''}" style="--team:${esc(row.color)}">
      <span class="dot"></span>
      <span class="name">${index + 1}. ${esc(row.name)}</span>
      <span class="score">${fmt(row.score)}</span>
      <span class="acc">${row.accuracy}% acc</span>
    </div>`).join('');

  const html = `
    <div class="final-winner">
      <span class="eyebrow">${esc(reason)}</span>
      <h2>${esc(final.winnerName || 'No winner')}</h2>
      <p>${final.askedQuestions} briefings · ${final.shotsFired} missiles fired</p>
    </div>
    <div class="final-list">${rows}</div>`;

  paint('final', signature, ui.finalPanel, html);
}

function emptyHint(title, copy) {
  return `<div class="empty-hint"><b>${esc(title)}</b>${esc(copy)}</div>`;
}

/* ---------------------------------------------------------------- questions */

function renderQuestions() {
  if (!state) return;
  setText(ui.questionCountChip, `${state.questions.length} QUESTION${state.questions.length === 1 ? '' : 'S'}`);

  if (savingQuestion && saveMatch) {
    const found = state.questions.find((question) => (
      question.question === saveMatch.question
      && question.correctIndex === saveMatch.correctIndex
    ));
    if (found) {
      savingQuestion = false;
      saveMatch = null;
      editorQuestionId = found.id;
      ui.qId.value = found.id;
      ui.questionFormTitle.textContent = 'Edit question';
      setText(ui.qModeChip, 'SAVED');
      setDisabled(ui.qDelete, false);
      setDisabled(ui.qSave, false);
      questionInitialised = true;
    }
  }

  if (editorQuestionId && !savingQuestion && !state.questions.some((question) => question.id === editorQuestionId)) {
    resetQuestionForm();
  }

  renderTopicOptions();
  renderQuestionList();

  if (!questionInitialised && state.questions.length) {
    questionInitialised = true;
    if (!editorQuestionId && !ui.qText.value.trim()) {
      loadQuestionIntoEditor(state.questions[0].id);
    }
  }
}

function renderTopicOptions() {
  const topics = [...new Set(state.questions.map((question) => question.topic))].sort((a, b) => a.localeCompare(b));
  const signature = topics.join('|');
  if (signature === topicSignature) return;
  topicSignature = signature;

  const current = ui.questionTopic.value;
  ui.questionTopic.innerHTML = `<option value="all">All topics</option>${topics.map((topic) => `<option value="${esc(topic)}">${esc(topic)}</option>`).join('')}`;
  ui.questionTopic.value = topics.includes(current) ? current : 'all';
}

function renderQuestionList() {
  if (!state) return;
  const search = ui.questionSearch.value.trim().toLowerCase();
  const topic = ui.questionTopic.value;
  const filtered = state.questions.filter((question) => {
    if (topic !== 'all' && question.topic !== topic) return false;
    if (!search) return true;
    return `${question.question} ${question.topic} ${question.options.join(' ')}`.toLowerCase().includes(search);
  });

  const signature = JSON.stringify({
    search,
    topic,
    selected: editorQuestionId,
    rows: filtered.map((question) => [question.id, question.topic, question.difficulty, question.question, question.correctIndex]),
  });

  if (!filtered.length) {
    paint('question-list', signature, ui.questionList, '<div class="q-list-empty">No questions match this filter.<br />Try another search or topic.</div>');
    return;
  }

  const rows = filtered.map((question) => `
    <button type="button" class="question-item ${question.id === editorQuestionId ? 'selected' : ''}" data-question-id="${esc(question.id)}">
      <span class="q-diff">L${question.difficulty}</span>
      <span class="q-copy">
        <b>${esc(question.question)}</b>
        <span>${esc(question.topic)} · ${esc(COLUMN_LABELS[question.correctIndex])}</span>
      </span>
      <span class="q-correct">${esc(COLUMN_LABELS[question.correctIndex])}</span>
    </button>`).join('');

  paint('question-list', signature, ui.questionList, rows);
}

ui.questionList.addEventListener('click', (event) => {
  const item = event.target.closest('[data-question-id]');
  if (!item) return;
  audio.play('ui');
  loadQuestionIntoEditor(item.dataset.questionId);
});

ui.questionSearch.addEventListener('input', renderQuestionList);
ui.questionTopic.addEventListener('change', () => {
  renderQuestionList();
});

function loadQuestionIntoEditor(id) {
  if (!state) return;
  const question = state.questions.find((entry) => entry.id === id);
  if (!question) return;

  savingQuestion = false;
  editorQuestionId = question.id;
  ui.qId.value = question.id;
  ui.qTopic.value = question.topic;
  ui.qDifficulty.value = String(question.difficulty ?? 1);
  ui.qText.value = question.question;
  ui.qOpt0.value = question.options[0] || '';
  ui.qOpt1.value = question.options[1] || '';
  ui.qOpt2.value = question.options[2] || '';
  ui.qOpt3.value = question.options[3] || '';
  ui.qExplanation.value = question.explanation || '';

  $$('input[name="qCorrect"]').forEach((radio) => {
    radio.checked = Number(radio.value) === question.correctIndex;
  });

  ui.questionFormTitle.textContent = 'Edit question';
  setText(ui.qModeChip, 'EDITING');
  setDisabled(ui.qDelete, false);
  setDisabled(ui.qSave, false);
  ui.questionFormError.classList.add('hidden');
  saveMatch = null;
  renderQuestionList();
}

function resetQuestionForm() {
  editorQuestionId = null;
  savingQuestion = false;
  saveMatch = null;
  ui.qId.value = '';
  ui.qTopic.value = '';
  ui.qDifficulty.value = '2';
  ui.qText.value = '';
  ui.qOpt0.value = '';
  ui.qOpt1.value = '';
  ui.qOpt2.value = '';
  ui.qOpt3.value = '';
  ui.qExplanation.value = '';
  $$('input[name="qCorrect"]').forEach((radio) => {
    radio.checked = false;
  });
  ui.questionFormTitle.textContent = 'New question';
  setText(ui.qModeChip, 'UNSAVED');
  setDisabled(ui.qDelete, true);
  setDisabled(ui.qSave, false);
  ui.questionFormError.classList.add('hidden');
  renderQuestionList();
}

ui.newQuestionBtn.addEventListener('click', () => {
  audio.play('ui');
  resetQuestionForm();
  ui.qText.focus();
  ui.questionForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

ui.qReset.addEventListener('click', () => {
  resetQuestionForm();
  audio.play('ui');
});

function showQuestionError(message) {
  setText(ui.questionFormError, message);
  ui.questionFormError.classList.remove('hidden');
  ui.questionFormError.scrollIntoView({ block: 'nearest' });
}

ui.questionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state) return;

  const question = ui.qText.value.trim();
  const options = [ui.qOpt0, ui.qOpt1, ui.qOpt2, ui.qOpt3].map((input) => input.value.trim());
  const correctRadio = document.querySelector('input[name="qCorrect"]:checked');
  const explanation = ui.qExplanation.value.trim();
  const topic = ui.qTopic.value.trim() || 'Cyber security';
  const difficulty = Number.parseInt(ui.qDifficulty.value, 10) || 1;

  if (question.length < 8) return showQuestionError('Write a question of at least 8 characters.');
  if (options.some((option) => option.length === 0)) return showQuestionError('All four answers are required.');
  if (!correctRadio) return showQuestionError('Select which answer is correct.');
  if (explanation.length < 8) return showQuestionError('Add an explanation of at least 8 characters.');

  const correctIndex = Number.parseInt(correctRadio.value, 10);
  const payload = { topic, difficulty, question, options, correctIndex, explanation };
  if (editorQuestionId) payload.id = editorQuestionId;

  savingQuestion = true;
  saveMatch = { question, correctIndex };
  ui.questionFormError.classList.add('hidden');
  setText(ui.qModeChip, 'SAVING…');
  setDisabled(ui.qSave, true);
  socket.emit('host:questionSave', { question: payload });
  window.setTimeout(() => {
    if (!savingQuestion) return;
    savingQuestion = false;
    saveMatch = null;
    setDisabled(ui.qSave, false);
    setText(ui.qModeChip, editorQuestionId ? 'EDITING' : 'UNSAVED');
  }, 6000);
});

ui.qDelete.addEventListener('click', () => {
  if (!state || !editorQuestionId) return;
  const question = state.questions.find((entry) => entry.id === editorQuestionId);
  if (!question) return;
  if (!window.confirm(`Delete "${truncate(question.question)}"?`)) return;
  socket.emit('host:questionDelete', { id: editorQuestionId });
  resetQuestionForm();
  showToast('Question deleted.', 'warn');
});

ui.exportQuestions.addEventListener('click', () => {
  if (!state) return;
  const payload = {
    version: 1,
    updated: new Date().toISOString(),
    questions: state.questions,
  };
  downloadFile('cyber-battleships-questions.json', JSON.stringify(payload, null, 2));
  showToast('Question bank exported.', 'good');
});

ui.importQuestions.addEventListener('click', () => {
  ui.importFile.value = '';
  ui.importFile.click();
});

ui.importFile.addEventListener('change', async () => {
  const file = ui.importFile.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.questions;
    if (!Array.isArray(list) || list.length === 0) throw new Error('The file contains no questions.');
    if (!window.confirm(`Replace the entire question bank with ${list.length} question${list.length === 1 ? '' : 's'}?`)) return;
    socket.emit('host:questionReplace', { questions: list });
    showToast(`Importing ${list.length} questions…`, 'good');
  } catch (error) {
    showToast(error?.message || 'That file is not valid question JSON.', 'bad', 6000);
  }
});

/* ------------------------------------------------------- ship placement modal */

function openPlacement(gridId) {
  if (!state) return;
  if (state.phase !== 'lobby' && state.phase !== 'ended') {
    showToast('Ships can only be moved in the lobby or between games.', 'warn');
    return;
  }
  const grid = state.grids.find((entry) => entry.id === gridId);
  if (!grid) return;

  placement.open = true;
  placement.gridId = grid.id;
  placement.orientation = 'h';
  placement.dirty = false;
  placement.awaiting = false;
  placement.request = null;
  placement.hint = 'Select a ship, choose an orientation, then click a starting cell.';
  loadPlacementFromGrid(grid);

  ui.placementModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderPlacementTabs();
  renderPlacement();
}

function requestClosePlacement() {
  if (placement.awaiting) return;
  if (placement.dirty && !window.confirm('Discard these placement changes?')) return;
  closePlacement();
}

function closePlacement() {
  placement.open = false;
  placement.gridId = null;
  placement.preview = [];
  placement.awaiting = false;
  placement.request = null;
  placement.dirty = false;
  ui.placementModal.classList.add('hidden');
  document.body.style.overflow = '';
}

function loadPlacementFromGrid(grid) {
  placement.ships = {};
  for (const ship of FLEET) placement.ships[ship.key] = [];
  for (const ship of grid.ships) {
    placement.ships[ship.key] = ship.cells.map((cell) => ({ col: cell.col, row: cell.row }));
  }
  placement.selected = FLEET.find((ship) => !placement.ships[ship.key]?.length)?.key || FLEET[0].key;
  placement.dirty = false;
}

function renderPlacementTabs() {
  const html = state.grids.map((grid) => `
    <button type="button" data-placement-grid="${esc(grid.id)}" class="${grid.id === placement.gridId ? 'active' : ''}">${esc(grid.label)}</button>`).join('');
  setHTML(ui.placementGridTabs, html);
}

function renderPlacement() {
  if (!placement.open || !state) return;
  const grid = state.grids.find((entry) => entry.id === placement.gridId);
  if (!grid) {
    closePlacement();
    return;
  }

  setText(ui.placementTitle, grid.label);
  const placed = FLEET.filter((ship) => placement.ships[ship.key]?.length).length;
  setText(ui.placementCount, `${placed}/5 PLACED`);
  setDisabled(ui.placementApply, placed < 5 || placement.awaiting);
  setText(ui.placementApply, placement.awaiting ? 'APPLYING…' : 'APPLY PLACEMENT');
  setText(ui.placementHint, placement.hint || 'Select a ship, choose an orientation, then click a starting cell.');
  setText(ui.placementRotate, `ORIENTATION: ${placement.orientation === 'h' ? 'HORIZONTAL' : 'VERTICAL'}`);

  renderPlacementTabs();
  renderPlacementGrid();
  renderPlacementFleet();
}

function renderPlacementGrid() {
  placement.preview = [];
  const parts = ['<span class="place-label"></span>'];
  for (const label of COLUMN_LABELS) parts.push(`<span class="place-label">${label}</span>`);

  for (let row = 0; row < 10; row += 1) {
    parts.push(`<span class="place-label">${row + 1}</span>`);
    for (let col = 0; col < 10; col += 1) {
      const occupied = Object.values(placement.ships).some((cells) => cells.some((cell) => cell.col === col && cell.row === row));
      parts.push(`<button class="place-cell ${occupied ? 'ship' : ''}" type="button" data-col="${col}" data-row="${row}" aria-label="${COLUMN_LABELS[col]}${row + 1}"></button>`);
    }
  }

  setHTML(ui.placementGrid, parts.join(''));
}

function renderPlacementFleet() {
  const rows = FLEET.map((ship) => {
    const cells = placement.ships[ship.key] || [];
    const pips = Array.from({ length: ship.length }, () => '<i></i>').join('');
    return `
      <button type="button" class="palette-ship ${placement.selected === ship.key ? 'selected' : ''} ${cells.length ? 'placed' : ''}" data-ship="${ship.key}">
        <span class="ps-pips">${pips}</span>
        <span class="ps-name">${esc(ship.name)}</span>
        <span class="ps-state">${cells.length ? 'PLACED' : '—'}</span>
      </button>`;
  }).join('');

  setHTML(ui.placementFleet, rows);
}

function shipAt(col, row) {
  return Object.entries(placement.ships)
    .find(([, cells]) => cells.some((cell) => cell.col === col && cell.row === row))?.[0] || null;
}

function buildShipCells(length, col, row, orientation) {
  if (orientation === 'h' && col + length > 10) return null;
  if (orientation === 'v' && row + length > 10) return null;
  const cells = [];
  for (let index = 0; index < length; index += 1) {
    cells.push(orientation === 'h' ? { col: col + index, row } : { col, row: row + index });
  }
  return cells;
}

function collides(cells, ignoreKey) {
  return Object.entries(placement.ships).some(([key, occupied]) => {
    if (key === ignoreKey) return false;
    return cells.some((cell) => occupied.some((other) => other.col === cell.col && other.row === cell.row));
  });
}

function clearPlacementPreview() {
  for (const element of placement.preview) element.classList.remove('preview', 'invalid');
  placement.preview = [];
}

ui.placementGrid.addEventListener('pointerover', (event) => {
  if (!placement.open) return;
  clearPlacementPreview();
  const cellElement = event.target.closest('.place-cell');
  if (!cellElement) return;
  const col = Number(cellElement.dataset.col);
  const row = Number(cellElement.dataset.row);

  const cells = placement.ships[placement.selected] || [];
  if (cells.some((cell) => cell.col === col && cell.row === row)) return;

  const ship = FLEET.find((entry) => entry.key === placement.selected) || FLEET[0];
  const preview = buildShipCells(ship.length, col, row, placement.orientation);
  if (!preview) return;

  const valid = !collides(preview, placement.selected);
  for (const cell of preview) {
    const element = ui.placementGrid.querySelector(`.place-cell[data-col="${cell.col}"][data-row="${cell.row}"]`);
    if (!element) continue;
    element.classList.add(valid ? 'preview' : 'invalid');
    placement.preview.push(element);
  }
});

ui.placementGrid.addEventListener('pointerleave', clearPlacementPreview);

ui.placementGrid.addEventListener('click', (event) => {
  const cellElement = event.target.closest('.place-cell');
  if (!cellElement) return;
  const col = Number(cellElement.dataset.col);
  const row = Number(cellElement.dataset.row);
  const owner = shipAt(col, row);

  if (owner && owner !== placement.selected) {
    placement.selected = owner;
    placement.hint = `${shipName(owner)} selected. Click its cells again to remove it.`;
    placement.dirty = true;
    renderPlacement();
    return;
  }

  const current = placement.ships[placement.selected] || [];
  if (current.some((cell) => cell.col === col && cell.row === row)) {
    placement.ships[placement.selected] = [];
    placement.hint = `${shipName(placement.selected)} removed.`;
    placement.dirty = true;
    renderPlacement();
    return;
  }

  const ship = FLEET.find((entry) => entry.key === placement.selected);
  if (!ship) return;
  const cells = buildShipCells(ship.length, col, row, placement.orientation);
  if (!cells) {
    placement.hint = `${ship.name} does not fit there. Try another cell or rotate.`;
    renderPlacement();
    return;
  }
  if (collides(cells, placement.selected)) {
    placement.hint = `${ship.name} would overlap another ship.`;
    renderPlacement();
    return;
  }

  placement.ships[ship.key] = cells;
  placement.dirty = true;
  const next = FLEET.find((entry) => !placement.ships[entry.key]?.length);
  placement.selected = next?.key || ship.key;
  placement.hint = next
    ? `${ship.name} placed. Now place the ${next.name.toLowerCase()}.`
    : 'All five ships placed. Apply when ready.';
  renderPlacement();
});

ui.placementFleet.addEventListener('click', (event) => {
  const button = event.target.closest('[data-ship]');
  if (!button) return;
  placement.selected = button.dataset.ship;
  placement.hint = `${shipName(placement.selected)} selected.`;
  renderPlacement();
});

ui.placementRotate.addEventListener('click', () => {
  placement.orientation = placement.orientation === 'h' ? 'v' : 'h';
  placement.hint = `Orientation is now ${placement.orientation === 'h' ? 'horizontal' : 'vertical'}.`;
  audio.play('ui');
  renderPlacement();
});

ui.placementClear.addEventListener('click', () => {
  const selected = placement.selected;
  if (!selected) return;
  if (!placement.ships[selected]?.length) {
    placement.hint = `${shipName(selected)} is already empty.`;
    renderPlacement();
    return;
  }
  placement.ships[selected] = [];
  placement.dirty = true;
  placement.hint = `${shipName(selected)} cleared.`;
  renderPlacement();
});

ui.placementRandom.addEventListener('click', () => {
  if (!placement.gridId) return;
  placement.dirty = false;
  placement.awaiting = true;
  placement.request = { type: 'randomise' };
  placement.hint = 'Randomising the fleet…';
  audio.play('ui');
  socket.emit('host:randomiseShips', { gridId: placement.gridId });
  renderPlacement();
});

ui.placementApply.addEventListener('click', () => {
  if (!placement.gridId || placement.awaiting) return;
  if (FLEET.some((ship) => !placement.ships[ship.key]?.length)) {
    placement.hint = 'Place all five ships first.';
    renderPlacement();
    return;
  }

  const ships = FLEET.map((ship) => ({
    key: ship.key,
    cells: placement.ships[ship.key].map((cell) => ({ col: cell.col, row: cell.row })),
  }));

  placement.awaiting = true;
  placement.request = { type: 'apply', ships };
  placement.hint = 'Validating placement on the server…';
  socket.emit('host:setShips', { gridId: placement.gridId, ships }, (response) => {
    if (!response?.ok) return;
    if (!placement.open || placement.gridId !== response.gridId) return;
    placement.awaiting = false;
    placement.request = null;
    closePlacement();
    showToast('Fleet placement saved.', 'good');
  });
  renderPlacement();

  window.setTimeout(() => {
    if (!placement.awaiting) return;
    placement.awaiting = false;
    placement.request = null;
    placement.hint = 'The server did not respond. Check the fleet and try again.';
    renderPlacement();
  }, 5000);
});

ui.placementGridTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-placement-grid]');
  if (!button) return;
  const nextId = button.dataset.placementGrid;
  if (nextId === placement.gridId) return;
  if (placement.dirty && !window.confirm('Discard these placement changes?')) return;
  const grid = state.grids.find((entry) => entry.id === nextId);
  if (!grid) return;
  placement.gridId = grid.id;
  placement.dirty = false;
  placement.awaiting = false;
  placement.request = null;
  placement.hint = 'Select a ship, choose an orientation, then click a starting cell.';
  loadPlacementFromGrid(grid);
  renderPlacement();
});

ui.placementClose.addEventListener('click', requestClosePlacement);

ui.placementModal.addEventListener('click', (event) => {
  if (event.target === ui.placementModal) requestClosePlacement();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && placement.open) requestClosePlacement();
});

function syncPlacementWithState() {
  if (!placement.open || !state) return;
  if (state.phase !== 'lobby' && state.phase !== 'ended') {
    closePlacement();
    return;
  }

  const grid = state.grids.find((entry) => entry.id === placement.gridId);
  if (!grid) {
    closePlacement();
    return;
  }

  if (placement.awaiting) {
    const request = placement.request;

    if (request?.type === 'apply') {
      if (fleetMatches(request.ships, grid.ships)) {
        placement.awaiting = false;
        placement.request = null;
        closePlacement();
        showToast('Fleet placement saved.', 'good');
      }
      return;
    }

    placement.awaiting = false;
    placement.request = null;
    loadPlacementFromGrid(grid);
    placement.hint = 'Fleet randomised. Adjust it or apply as is.';
    renderPlacement();
    return;
  }

  if (!placement.dirty) {
    loadPlacementFromGrid(grid);
    renderPlacement();
  }
}

function fleetMatches(payload, ships) {
  if (!Array.isArray(payload) || payload.length !== FLEET.length) return false;
  return FLEET.every((ship) => {
    const wanted = payload.find((entry) => entry.key === ship.key);
    const actual = ships.find((entry) => entry.key === ship.key);
    if (!wanted || !actual) return false;
    return shipCellsKey(wanted.cells) === shipCellsKey(actual.cells);
  });
}

/* ---------------------------------------------------------------- keyboard shortcuts */
document.addEventListener('keydown', (event) => {
  const tag = (event.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === ' ' || event.key === 'ArrowRight' || event.key === 'n' || event.key === 'N') {
    if (!state || state.phase === 'lobby' || state.phase === 'ended') return;
    event.preventDefault();
    socket.emit('host:next');
  } else if (event.key === 'r' || event.key === 'R') {
    if (!state || state.phase !== 'question') return;
    event.preventDefault();
    socket.emit('host:reveal');
  } else if (event.key === 'b' || event.key === 'B') {
    if (!state || (state.phase !== 'question' && state.phase !== 'reveal')) return;
    event.preventDefault();
    socket.emit('host:battle');
  } else if (event.key === 'p' || event.key === 'P') {
    if (!state || state.phase === 'lobby' || state.phase === 'ended') return;
    event.preventDefault();
    socket.emit('host:pause', { paused: !state.paused });
  } else if (event.key === 'f' || event.key === 'F' || event.key === 'F11') {
    event.preventDefault();
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
});

/* --------------------------------------------------------------------- init */

document.addEventListener('pointerdown', () => {
  audio.init();
}, { once: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && authed) {
    socket.emit('host:state');
  }
});

syncSoundButton();
setLink('warn');
updateTimer();
window.setInterval(updateTimer, 250);
