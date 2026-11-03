/**
 * Mobile operator console.
 *
 * The phone holds no secrets: the server only sends this player's own fleet
 * (fully visible), opponents as shots already fired, and the answer key once
 * the presenter reveals it.
 */

import { $, $$, esc, fmt, showToast, COLUMN_LABELS } from './lib/dom.js';
import { AudioEngine } from './lib/audio.js';
import { connect } from './lib/socket.js';

const PHASE_LABELS = {
  lobby: 'STANDBY',
  question: 'BRIEFING',
  reveal: 'SOLUTION',
  battle: 'COMBAT',
  ended: 'DEBRIEF',
};

const audio = new AudioEngine();
const socket = connect();

const ui = {
  joinView: $('#joinView'),
  controller: $('#controller'),
  joinForm: $('#joinForm'),
  joinName: $('#joinName'),
  joinCode: $('#joinCode'),
  joinButton: $('#joinButton'),
  joinError: $('#joinError'),
  joinNote: $('#joinNote'),
  teamField: $('#teamField'),
  teamChoices: $('#teamChoices'),
  hudTeam: $('#hudTeam'),
  hudPlayer: $('#hudPlayer'),
  hudScore: $('#hudScore'),
  hudMissiles: $('#hudMissiles'),
  hudPhase: $('#hudPhase'),
  navMissiles: $('#navMissiles'),
  quizPanel: $('#quizPanel'),
  firePanel: $('#firePanel'),
  fleetPanel: $('#fleetPanel'),
  resultOverlay: $('#resultOverlay'),
};

let state = null;
let joined = false;
let token = localStorage.getItem('cb.playerToken') || '';
let selectedTeamId = null;
let activeTab = 'quiz';
let pendingJoin = false;
let pendingAnswer = false;
let pendingFire = false;
let selectedTargetId = null;
let selectedCell = null;
let resumeAttempted = false;
let serverOffset = 0;

let joinChoicesSignature = '';
let lastQuizKey = '';
let lastFireKey = '';
let lastFleetKey = '';
let lastFeedbackKey = '';
let dismissedFinalFor = null;
let joinNoteTimer = null;

/* --------------------------------------------------------------- bootstrap */

const params = new URLSearchParams(window.location.search);
const urlCode = (params.get('code') || '').toUpperCase();
if (urlCode) {
  ui.joinCode.value = urlCode;
  ui.joinCode.dataset.autofilled = 'true';
}
ui.joinName.value = localStorage.getItem('cb.playerName') || '';

document.addEventListener('pointerdown', () => {
  audio.init();
}, { once: true });

/* ------------------------------------------------------------------ socket */

let resumeInFlight = false;

function attemptResume() {
  if (!token || resumeInFlight) return;
  resumeInFlight = true;
  resumeAttempted = true;
  socket.emit('player:resume', { token });
}

socket.on('connect', () => {
  socket.emit('player:hello');
  attemptResume();
});

socket.on('state', (next) => {
  if (!next) return;
  const previous = state;
  state = next;
  serverOffset = next.serverNow - Date.now();

  if (!joined) {
    renderJoin();
    return;
  }

  if (!state.me) {
    // During a reconnect the first broadcast may arrive before player:resume
    // has reattached us. Keep the controller visible and retry instead of
    // dumping the operator back on the join screen.
    if (token) {
      if (!resumeInFlight) attemptResume();
      return;
    }
    resetToJoin('Your session has ended. Rejoin when the presenter reopens the lobby.');
    return;
  }

  resumeInFlight = false;

  if (pendingFire && state.revision !== previous?.revision) {
    pendingFire = false;
    selectedCell = null;
    lastFireKey = '';
  }
  pendingAnswer = false;

  applyTeamTheme();
  updateHud();
  updateJoinCodeFromState();
  renderActivePanel();
  updateResultOverlay();

  if (previous?.phase !== state.phase) {
    if (state.phase === 'question') audio.play('brief');
    if (state.phase === 'reveal') audio.play('reveal');
    if (state.phase === 'ended') audio.play('victory');
    if (state.phase === 'lobby') dismissedFinalFor = null;
    lastQuizKey = '';
    lastFireKey = '';
  }

  handleAnswerFeedback(previous);
});

socket.on('player:ok', (payload) => {
  joined = true;
  pendingJoin = false;
  resumeAttempted = true;
  resumeInFlight = false;
  token = payload.token;
  localStorage.setItem('cb.playerToken', token);
  localStorage.setItem('cb.playerName', ui.joinName.value.trim());
  ui.joinView.classList.add('hidden');
  ui.controller.classList.remove('hidden');
  setTab('quiz');
  hideJoinError();
  ui.joinButton.disabled = false;
  ui.joinButton.textContent = 'ESTABLISH UPLINK';
  audio.init();
  socket.emit('player:state');
});

socket.on('player:gone', () => {
  token = '';
  resumeInFlight = false;
  localStorage.removeItem('cb.playerToken');
  if (joined) resetToJoin('Your previous session is no longer active.');
  else {
    resumeAttempted = true;
    renderJoin();
  }
});

socket.on('session:ended', (payload) => {
  resetToJoin(payload?.reason === 'new-game'
    ? 'The presenter started a new game. Rejoin with the new code.'
    : 'The presenter closed your session.');
});

socket.on('session:superseded', () => {
  resetToJoin('This operator session was opened on another device.');
});

socket.on('toast', (toast) => {
  if (!toast?.message) return;
  const type = toast.level === 'award' ? 'warn' : (toast.level === 'leave' ? 'bad' : 'good');
  showToast(toast.message, type);
});

socket.on('game:error', (error) => {
  pendingJoin = false;
  pendingAnswer = false;
  pendingFire = false;
  ui.joinButton.disabled = false;
  ui.joinButton.textContent = 'ESTABLISH UPLINK';
  if (!joined) {
    showJoinError(error?.message || 'Unable to join.');
  } else {
    showToast(error?.message || 'Action rejected.', 'bad');
    lastQuizKey = '';
    lastFireKey = '';
    renderActivePanel();
  }
});

socket.on('fx', (event) => {
  if (!event || !state?.me) return;
  const myTeam = state.me.teamId;

  if (event.type === 'fire') {
    const mine = event.teamId === myTeam;
    const incoming = !mine && state.grids.some((grid) => grid.id === event.targetGridId && grid.ownerTeamId === myTeam);
    if (mine || incoming) {
      const outcome = event.sunk ? `SUNK ${event.sunkShipName}` : (event.hit ? 'HIT CONFIRMED' : 'MISS');
      const prefix = mine ? 'Your missile' : `Incoming from ${event.teamName}`;
      showToast(`${prefix}: ${event.coord} — ${outcome}`, event.hit ? (mine ? 'good' : 'bad') : 'warn', 3200);
      navigator.vibrate?.(event.hit ? [30, 40, 60] : 25);
      audio.play(event.hit ? 'explosion' : 'splash');
    }
    if (mine) pendingFire = false;
  }

  if (event.type === 'award' && event.teamId === myTeam) {
    audio.play('award');
    showToast(`${event.playerName} earned a missile`, 'warn');
  }

  if (event.type === 'eliminate' && event.teamId === myTeam) {
    audio.play('eliminate');
    navigator.vibrate?.([60, 50, 60, 50, 120]);
    showToast('Your fleet has been destroyed. You are spectating.', 'bad', 6000);
  }

  if (event.type === 'gameover') {
    dismissedFinalFor = null;
    updateResultOverlay();
  }

  if (event.type === 'start') {
    audio.play('alarm');
  }
});

socket.on('connect_error', () => {
  if (!joined) showJoinError('Cannot reach the game server. Check you are on the same network.');
});

/* ------------------------------------------------------------------- join */

ui.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pendingJoin) return;

  const name = ui.joinName.value.trim();
  const code = ui.joinCode.value.trim().toUpperCase();

  if (name.length < 2) {
    showJoinError('Enter a call sign of at least 2 characters.');
    ui.joinName.focus();
    return;
  }
  if (!code) {
    showJoinError('Enter the game code shown on the main screen.');
    ui.joinCode.focus();
    return;
  }

  if (state && state.settings.mode === 'teams' || (state && state.settings.gridCount > 1)) {
    if (!selectedTeamId) {
      showJoinError('Select a strike team first.');
      return;
    }
  }

  hideJoinError();
  pendingJoin = true;
  ui.joinButton.disabled = true;
  ui.joinButton.textContent = 'CONNECTING…';
  await audio.init();
  audio.play('ui');
  socket.emit('player:join', { code, name, teamId: selectedTeamId });
});

ui.teamChoices.addEventListener('click', (event) => {
  const button = event.target.closest('[data-team]');
  if (!button || button.disabled) return;
  selectedTeamId = button.dataset.team || null;
  joinChoicesSignature = '';
  renderJoin();
  audio.play('ui');
});

function showJoinError(message) {
  ui.joinError.textContent = message;
  ui.joinError.classList.remove('hidden');
}

function hideJoinError() {
  ui.joinError.classList.add('hidden');
}

function renderJoin() {
  if (!state) return;
  updateJoinCodeFromState();

  const solo = state.settings.gridCount === 1 && state.settings.mode === 'individual';
  const capacity = state.settings.mode === 'individual' ? 1 : (state.settings.maxPerTeam || Infinity);
  const signature = JSON.stringify({
    code: state.code,
    phase: state.phase,
    allowLateJoin: state.settings.allowLateJoin,
    mode: state.settings.mode,
    solo,
    teams: state.teams.map((team) => [team.id, team.name, team.members.length, team.eliminated]),
  });

  if (signature !== joinChoicesSignature) {
    joinChoicesSignature = signature;
    if (solo) {
      ui.teamChoices.innerHTML = `
        <button type="button" class="team-choice solo selected" disabled>
          <b>SOLO OPERATOR</b>
          <span>Individual score · unlimited places</span>
        </button>`;
      selectedTeamId = null;
    } else {
      const available = state.teams.filter((team) => team.members.length < capacity && !team.eliminated);
      if (!selectedTeamId || !available.some((team) => team.id === selectedTeamId)) {
        selectedTeamId = available[0]?.id || null;
      }
      ui.teamChoices.innerHTML = state.teams.map((team) => {
        const full = team.members.length >= capacity;
        const claimed = state.settings.mode === 'individual' && team.members.length > 0;
        const label = full
          ? (claimed ? 'Claimed' : 'Team full')
          : `${team.members.length}/${capacity === Infinity ? '∞' : capacity} joined`;
        return `
          <button type="button" class="team-choice ${selectedTeamId === team.id ? 'selected' : ''}"
            data-team="${esc(team.id)}" style="--team:${esc(team.color)}" ${full ? 'disabled' : ''}>
            <b>${esc(team.name)}</b>
            <span>${esc(label)}</span>
          </button>`;
      }).join('') || '<p class="join-note">Waiting for the presenter to open teams…</p>';
    }
  }

  let note = 'No download. No account. Keep this page open during the session.';
  let canJoin = true;
  if (state.phase === 'ended') {
    note = 'This operation has finished. Wait for the presenter to start a new game.';
    canJoin = false;
  } else if (state.phase !== 'lobby') {
    if (state.settings.allowLateJoin) {
      note = 'Game in progress — late operators may still join.';
    } else {
      note = 'Joins are closed while the game is running.';
      canJoin = false;
    }
  } else {
    note = resumableNote();
  }
  ui.joinNote.textContent = note;
  if (!pendingJoin) {
    ui.joinButton.disabled = !canJoin;
  }
}

function resumableNote() {
  if (resumeAttempted && !joined) {
    return 'No active session found. Enter your call sign to join.';
  }
  return 'No download. No account. Keep this page open during the session.';
}

function updateJoinCodeFromState() {
  if (!state) return;
  if (!ui.joinCode.value.trim()) {
    ui.joinCode.value = state.code;
    ui.joinCode.dataset.autofilled = 'true';
    return;
  }
  if (ui.joinCode.value.trim().toUpperCase() !== state.code && state.phase === 'lobby') {
    // Keep a manually typed code unless it still holds the previous game's
    // code; only replace values we prefilled ourselves.
    if (ui.joinCode.dataset.autofilled === 'true') {
      ui.joinCode.value = state.code;
      ui.joinCode.dataset.autofilled = 'true';
    }
  }
}

/* -------------------------------------------------------------- controller */

function applyTeamTheme() {
  if (!state?.me) return;
  ui.controller.style.setProperty('--team', state.me.teamColor || '#2ee6ff');
}

function updateHud() {
  if (!state?.me) return;
  const me = state.me;
  ui.hudTeam.textContent = me.teamName;
  ui.hudPlayer.textContent = me.name;
  ui.hudScore.textContent = fmt(me.score);
  ui.hudMissiles.textContent = String(me.missiles);
  ui.hudPhase.textContent = state.paused ? 'PAUSED' : (PHASE_LABELS[state.phase] || 'STANDBY');
  ui.navMissiles.textContent = String(me.missiles);
  ui.navMissiles.classList.toggle('zero', me.missiles === 0);
}

function setTab(tab) {
  activeTab = tab;
  for (const button of $$('.p-nav-btn')) button.classList.toggle('active', button.dataset.tab === tab);
  ui.quizPanel.classList.toggle('hidden', tab !== 'quiz');
  ui.firePanel.classList.toggle('hidden', tab !== 'fire');
  ui.fleetPanel.classList.toggle('hidden', tab !== 'fleet');
  lastQuizKey = '';
  lastFireKey = '';
  lastFleetKey = '';
  renderActivePanel();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('.p-nav-btn').forEach((button) => {
  button.addEventListener('click', () => {
    audio.init();
    audio.play('ui');
    setTab(button.dataset.tab);
  });
});

function renderActivePanel() {
  if (!state?.me) return;
  if (activeTab === 'quiz') renderQuiz();
  else if (activeTab === 'fire') renderFire();
  else renderFleet();
}

/* -------------------------------------------------------------------- quiz */

function optionLetters() {
  return ['A', 'B', 'C', 'D'];
}

function renderQuiz() {
  if (!state?.me) return;
  const me = state.me;
  const question = state.question;
  const answer = me.answer;

  const key = JSON.stringify({
    phase: state.phase,
    q: question?.id,
    attempts: answer?.attempts,
    locked: answer?.locked,
    correct: answer?.correct,
    answerIndex: answer?.answerIndex,
    awarded: answer?.awarded,
    eliminated: me.eliminated,
    paused: state.paused,
    final: state.final?.endedAt,
    canAnswer: me.canAnswer,
    missiles: me.missiles,
  });
  if (key === lastQuizKey) return;
  lastQuizKey = key;

  if (state.phase === 'lobby') {
    ui.quizPanel.innerHTML = `
      <div class="wait-card">
        <div class="pulse-dot"></div>
        <h3>Uplink established</h3>
        <p>You are on <b>${esc(me.teamName)}</b>. Stand by for the presenter to launch the first briefing.</p>
      </div>
      <div class="p-card flat">
        <div class="section-title"><span>Your callsign</span><b>${esc(me.name)}</b></div>
        <div class="stats-grid" style="margin-top:10px">
          <div class="stat-box"><span>Team</span><b>${esc(me.teamName)}</b></div>
          <div class="stat-box"><span>Players</span><b>${me.teammates.length}</b></div>
        </div>
      </div>`;
    return;
  }

  if (state.phase === 'ended') {
    ui.quizPanel.innerHTML = renderQuizEnded();
    return;
  }

  if (state.phase === 'question' || state.phase === 'reveal') {
    if (!question) {
      ui.quizPanel.innerHTML = `<div class="wait-card"><div class="pulse-dot"></div><h3>Awaiting briefing</h3><p>The presenter is preparing the next question.</p></div>`;
      return;
    }

    if (me.eliminated) {
      ui.quizPanel.innerHTML = `
        <div class="p-card" style="border-color:rgba(255,59,92,.35)">
          <div class="card-kicker"><span class="chip bad">Fleet lost</span></div>
          <h2 class="big-question">Your fleet has been destroyed</h2>
          <p class="join-lede">You are spectating this operation. Keep watching the main screen for the final debrief.</p>
        </div>`;
      return;
    }

    const revealed = state.phase === 'reveal';
    const letters = optionLetters();
    const canAnswer = me.canAnswer && !pendingAnswer && !revealed;
    const showCorrect = revealed;

    const options = question.options.map((option, index) => {
      const classes = ['answer-btn'];
      let disabled = !canAnswer;
      if (showCorrect && index === question.correctIndex) classes.push('correct');
      if (answer && answer.answerIndex === index) {
        if (answer.correct) classes.push('correct');
        else classes.push(revealed || answer.locked ? 'wrong' : 'wrong');
      }
      if (showCorrect && index !== question.correctIndex && answer?.answerIndex !== index) classes.push('dim');
      if (answer?.locked || revealed) disabled = true;

      return `
        <button type="button" class="${classes.join(' ')}" data-option="${index}" ${disabled ? 'disabled' : ''}>
          <span class="a-letter">${letters[index]}</span>
          <span class="a-copy">${esc(option)}</span>
        </button>`;
    }).join('');

    let feedback = '';
    if (answer) {
      if (answer.correct) {
        feedback = `<div class="feedback good"><strong>Correct</strong>${answer.awarded
          ? 'Missile secured — open the Fire tab when the combat phase begins.'
          : 'Points banked. This round’s missile went to the first correct answer.'}</div>`;
      } else if (answer.locked) {
        feedback = `<div class="feedback bad"><strong>Incorrect — locked</strong>No attempts left for this briefing. Watch for the correct answer.</div>`;
      } else {
        const left = Math.max(0, (state.settings.maxAttempts || 1) - answer.attempts);
        feedback = `<div class="feedback warn"><strong>Not quite</strong>${left} attempt${left === 1 ? '' : 's'} remaining. Try again.</div>`;
      }
    } else if (revealed) {
      feedback = `<div class="feedback"><strong>No answer submitted</strong>The briefing closed before you locked in an answer.</div>`;
    } else {
      feedback = `<div class="feedback"><strong>Your call</strong>Select the answer you believe is correct. ${state.settings.maxAttempts > 1 ? `You have ${state.settings.maxAttempts} attempts.` : 'One attempt only.'}</div>`;
    }

    const explanation = revealed ? `
      <div class="explanation-card">
        <b>Debrief</b>
        ${esc(question.explanation || '')}
      </div>` : '';

    const timer = state.phase === 'question' ? `
      <div class="p-timer">
        <div class="bar"><div class="fill" id="pTimerFill"></div></div>
        <span class="secs" id="pTimerText">${state.settings.questionSeconds || '∞'}</span>
      </div>` : '';

    ui.quizPanel.innerHTML = `
      <div class="p-card">
        <div class="card-kicker">
          <span class="chip live">Briefing ${String(question.number).padStart(2, '0')}</span>
          <span class="chip">${esc(question.topic || 'Cyber security')}</span>
          <span class="chip ${revealed ? 'good' : 'warn'}">${revealed ? 'Solution' : (state.settings.awardMode === 'first' ? 'First correct earns a missile' : 'Correct earns a missile')}</span>
        </div>
        <h2 class="big-question">${esc(question.question)}</h2>
        <div class="answers">${options}</div>
        ${feedback}
        ${timer}
      </div>
      ${revealed ? `
        <div class="p-card flat">
          <div class="section-title"><span>Correct answer</span><b>${letters[question.correctIndex]}</b></div>
          <p style="margin-top:8px;font-size:.95rem;line-height:1.4">${esc(question.options[question.correctIndex] || '')}</p>
        </div>
        ${explanation}` : ''}
      <p class="p-footer-hint">${revealed ? 'Combat phase opens when the presenter advances' : 'Answers lock immediately'}</p>`;
    return;
  }

  if (state.phase === 'battle') {
    const last = state.question;
    const lastResult = last?.revealed
      ? `<div class="p-card flat">
           <div class="section-title"><span>Last briefing</span><b>${esc(last.topic || '')}</b></div>
           <p style="margin-top:6px;font-size:.82rem;color:var(--muted);line-height:1.45">
             Correct answer: ${esc(last.options?.[last.correctIndex] || '—')}
           </p>
         </div>`
      : '';
    const armed = me.missiles > 0;
    ui.quizPanel.innerHTML = `
      <div class="p-card">
        <div class="card-kicker">
          <span class="chip live">Combat phase</span>
          <span class="chip ${armed ? 'warn' : ''}">${me.missiles} missile${me.missiles === 1 ? '' : 's'}</span>
        </div>
        <h2 class="big-question">${armed ? 'Missiles armed. Choose a target.' : 'Combat phase — awaiting the next briefing.'}</h2>
        <p class="join-lede" style="text-align:left;margin-bottom:14px">${armed
          ? 'Spend a missile on any unknown coordinate. First strike wins the initiative.'
          : 'Answer the next question correctly to earn a missile.'}</p>
        <button class="btn ${armed ? 'btn-primary' : ''} btn-block" type="button" data-goto-tab="fire">
          ${armed ? `OPEN FIRE CONTROL (${me.missiles})` : 'VIEW FIRE CONTROL'}
        </button>
      </div>
      ${lastResult}
      <div class="wait-card">
        <div class="pulse-dot"></div>
        <h3>${state.paused ? 'Operation paused' : 'Standing by'}</h3>
        <p>${state.paused ? 'The presenter has paused the exercise.' : 'The next briefing will appear here automatically.'}</p>
      </div>`;
    return;
  }

  ui.quizPanel.innerHTML = `<div class="wait-card"><div class="pulse-dot"></div><h3>Standing by</h3><p>The operation is being prepared.</p></div>`;
}

function renderQuizEnded() {
  const me = state.me;
  const final = state.final;
  if (!final) {
    return `<div class="wait-card"><div class="pulse-dot"></div><h3>Operation complete</h3><p>Final results are being compiled.</p></div>`;
  }
  const myRow = final.ranking.find((row) => row.teamId === me.teamId);
  const rank = final.ranking.findIndex((row) => row.teamId === me.teamId) + 1;
  const won = final.winnerTeamId === me.teamId;
  return `
    <div class="p-card" style="border-color:${won ? 'rgba(61,255,158,.45)' : 'var(--line)'}">
      <div class="card-kicker">
        <span class="chip ${won ? 'good' : ''}">${won ? 'Victory' : 'Debrief'}</span>
        <span class="chip">Rank ${rank} of ${final.ranking.length}</span>
      </div>
      <h2 class="big-question">${won ? 'Your fleet controls the sector.' : `${esc(final.winnerName || 'No winner')} takes the sector.`}</h2>
      <div class="stats-grid">
        <div class="stat-box"><span>Team score</span><b>${fmt(myRow?.score || 0)}</b></div>
        <div class="stat-box"><span>Accuracy</span><b>${myRow?.accuracy || 0}%</b></div>
        <div class="stat-box"><span>Hits</span><b>${myRow?.stats.hits || 0}</b></div>
        <div class="stat-box"><span>Correct</span><b>${me.totals.correct} / ${me.totals.answers}</b></div>
      </div>
    </div>
    <p class="p-footer-hint">Wait for the presenter to start a new operation</p>`;
}

function handleAnswerFeedback(previous) {
  if (!state?.me || !state.question) return;
  const answer = state.me.answer;
  if (!answer) return;
  const key = `${state.question.id}:${answer.attempts}:${answer.correct}:${answer.locked}`;
  if (key === lastFeedbackKey) return;
  lastFeedbackKey = key;
  if (state.phase !== 'question') return;
  if (answer.correct) {
    audio.play('correct');
    navigator.vibrate?.([20, 40, 20]);
  } else if (answer.locked) {
    audio.play('wrong');
    navigator.vibrate?.(60);
  } else {
    audio.play('wrong');
    navigator.vibrate?.(30);
  }
}

ui.quizPanel.addEventListener('click', (event) => {
  const option = event.target.closest('[data-option]');
  if (option && !option.disabled) {
    submitAnswer(Number(option.dataset.option));
    return;
  }
  const goto = event.target.closest('[data-goto-tab]');
  if (goto) {
    audio.play('ui');
    setTab(goto.dataset.gotoTab);
  }
});

function submitAnswer(index) {
  if (pendingAnswer || !state?.question || !state.me?.canAnswer) return;
  pendingAnswer = true;
  audio.init();
  audio.play('ui');
  for (const button of $$('[data-option]', ui.quizPanel)) button.disabled = true;
  socket.emit('player:answer', { questionId: state.question.id, optionIndex: index });
}

/* -------------------------------------------------------------------- fire */

function makeNonce() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderFire() {
  if (!state?.me) return;
  const me = state.me;
  const targets = me.targets.map((id) => state.grids.find((grid) => grid.id === id)).filter(Boolean);

  if (!selectedTargetId || !targets.some((grid) => grid.id === selectedTargetId)) {
    selectedTargetId = targets[0]?.id || null;
  }
  const target = targets.find((grid) => grid.id === selectedTargetId) || null;

  const cellsSignature = target ? target.cells.map((row) => row.join('')).join('|') : '';
  const key = JSON.stringify({
    phase: state.phase,
    paused: state.paused,
    missiles: me.missiles,
    eliminated: me.eliminated,
    target: selectedTargetId,
    cell: selectedCell,
    cells: cellsSignature,
    canFire: me.canFire,
    pending: pendingFire,
  });
  if (key === lastFireKey) return;
  lastFireKey = key;

  if (me.eliminated) {
    ui.firePanel.innerHTML = emptyState('✕', 'Fleet destroyed', 'You are spectating. Keep an eye on the main display for the final result.');
    return;
  }

  if (state.paused) {
    ui.firePanel.innerHTML = emptyState('Ⅱ', 'Operation paused', 'The presenter has paused the exercise. Fire control is locked.');
    return;
  }

  if (state.phase === 'question') {
    ui.firePanel.innerHTML = emptyState('◈', 'Briefing in progress', 'Answer the current question. Fire control opens during the combat phase.');
    return;
  }

  if (state.phase === 'reveal') {
    ui.firePanel.innerHTML = emptyState('◈', 'Solution revealed', 'Stand by — the combat phase opens shortly and missiles can be fired.');
    return;
  }

  if (state.phase === 'lobby' || state.phase === 'ended' || state.phase === 'battle' === false) {
    if (state.phase === 'ended') {
      ui.firePanel.innerHTML = emptyState('◈', 'Operation complete', 'Fire control is offline. The debrief is on the main display.');
    } else {
      ui.firePanel.innerHTML = emptyState('◈', 'Standing by', 'Fire control unlocks when the operation begins.');
    }
    return;
  }

  if (!target) {
    ui.firePanel.innerHTML = emptyState('▦', 'No target available', 'There is no opposing fleet to attack right now.');
    return;
  }

  if (me.missiles === 0) {
    ui.firePanel.innerHTML = `
      ${emptyState('▲', 'No missiles', 'Answer a cyber security briefing correctly to earn a missile.')}
      <button class="btn btn-primary btn-block" type="button" data-goto-tab="quiz">GO TO BRIEFING</button>`;
    return;
  }

  const letters = COLUMN_LABELS;
  const rows = [];
  for (let row = 0; row < target.rows; row += 1) {
    rows.push(`<div class="tg-label">${row + 1}</div>`);
    for (let col = 0; col < target.cols; col += 1) {
      const status = target.cells?.[row]?.[col] || 'unknown';
      const isSelected = selectedCell && selectedCell.col === col && selectedCell.row === row;
      const disabled = status !== 'unknown';
      rows.push(`<button type="button" class="t-cell ${status} ${isSelected ? 'selected' : ''}" data-cell="${col},${row}" ${disabled ? 'disabled' : ''} aria-label="${letters[col]}${row + 1}"></button>`);
    }
  }
  const headerLabels = `<div class="tg-label"></div>${letters.map((letter) => `<div class="tg-label">${letter}</div>`).join('')}`;

  const tabs = targets.length > 1
    ? `<div class="target-tabs">${targets.map((grid) => {
      const team = state.teams.find((entry) => entry.id === grid.ownerTeamId);
      return `<button type="button" class="target-tab ${grid.id === selectedTargetId ? 'selected' : ''}" data-target="${esc(grid.id)}">
        <b>${esc(team?.name || grid.label)}</b>
        <span>${grid.health.remaining}/${grid.health.total} hull · ${grid.ships.filter((ship) => !ship.sunk).length} afloat</span>
      </button>`;
    }).join('')}</div>`
    : '';

  const confirm = selectedCell ? `
    <div class="fire-confirm">
      <div class="coord">${letters[selectedCell.col]}${selectedCell.row + 1}<span>target coordinate</span></div>
      <button type="button" class="btn btn-primary" data-fire ${pendingFire ? 'disabled' : ''}>
        ${pendingFire ? 'LAUNCHING…' : 'FIRE MISSILE'}
      </button>
    </div>` : `<p class="p-footer-hint">Tap an unknown coordinate to aim</p>`;

  ui.firePanel.innerHTML = `
    <div class="p-card">
      <div class="card-kicker">
        <span class="chip live">Fire control</span>
        <span class="chip warn">${me.missiles} missile${me.missiles === 1 ? '' : 's'}</span>
      </div>
      ${tabs}
      <div class="target-head">
        <span class="th-name">${esc(target.label)}</span>
        <span class="th-health">${target.health.remaining}/${target.health.total} hull · ${target.ships.filter((ship) => !ship.sunk).length} ships afloat</span>
      </div>
      <div class="target-grid">
        ${headerLabels}
        ${rows.join('')}
      </div>
      ${confirm}
    </div>`;
}

function emptyState(icon, title, copy) {
  return `<div class="empty-state"><span class="icon">${icon}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>`;
}

ui.firePanel.addEventListener('click', (event) => {
  const targetButton = event.target.closest('[data-target]');
  if (targetButton) {
    selectedTargetId = targetButton.dataset.target;
    selectedCell = null;
    lastFireKey = '';
    renderFire();
    audio.play('ui');
    return;
  }

  const cellButton = event.target.closest('[data-cell]');
  if (cellButton && !cellButton.disabled) {
    const [col, row] = cellButton.dataset.cell.split(',').map(Number);
    selectedCell = { col, row };
    lastFireKey = '';
    renderFire();
    audio.play('ui');
    return;
  }

  const fireButton = event.target.closest('[data-fire]');
  if (fireButton && !fireButton.disabled && selectedCell) {
    fireMissile();
    return;
  }

  const goto = event.target.closest('[data-goto-tab]');
  if (goto) setTab(goto.dataset.gotoTab);
});

function fireMissile() {
  if (pendingFire || !selectedCell || !state?.me?.canFire) return;
  pendingFire = true;
  audio.init();
  audio.play('launch');
  navigator.vibrate?.(20);
  socket.emit('player:fire', {
    targetGridId: selectedTargetId,
    col: selectedCell.col,
    row: selectedCell.row,
    nonce: makeNonce(),
  });
  lastFireKey = '';
  renderFire();
}

/* ------------------------------------------------------------------- fleet */

function renderFleet() {
  if (!state?.me) return;
  const me = state.me;
  const ownGrid = state.grids.find((grid) => grid.id === me.ownGridId) || null;
  const team = state.teams.find((entry) => entry.id === me.teamId);
  const cellsSignature = ownGrid ? ownGrid.cells.map((row) => row.join('')).join('|') : '';
  const key = JSON.stringify({
    phase: state.phase,
    own: cellsSignature,
    score: me.score,
    missiles: me.missiles,
    stats: team?.stats,
    totals: me.totals,
    teammates: me.teammates,
  });
  if (key === lastFleetKey) return;
  lastFleetKey = key;

  const gridHtml = ownGrid ? `
    <div class="p-card">
      <div class="card-kicker">
        <span class="chip live">Your fleet</span>
        <span class="chip ${ownGrid.health.remaining < ownGrid.health.total ? 'warn' : 'good'}">${ownGrid.health.remaining}/${ownGrid.health.total} hull</span>
      </div>
      <div class="target-grid" style="margin-top:6px">
        <div class="tg-label"></div>${COLUMN_LABELS.map((letter) => `<div class="tg-label">${letter}</div>`).join('')}
        ${ownGrid.cells.map((row, rowIndex) => `
          <div class="tg-label">${rowIndex + 1}</div>
          ${row.map((status, colIndex) => `<span class="t-cell ${status}" aria-label="${COLUMN_LABELS[colIndex]}${rowIndex + 1}"></span>`).join('')}
        `).join('')}
      </div>
      <div class="ship-health-list" style="margin-top:12px">
        ${ownGrid.ships.map((ship) => `
          <div class="ship-health ${ship.sunk ? 'destroyed' : ''}">
            <span class="sh-name">${esc(ship.name)}</span>
            <span class="sh-count">${ship.remaining}/${ship.length}</span>
            <span class="ship-pips">${Array.from({ length: ship.length }, (_, index) => `<i class="${index >= ship.remaining ? 'lost' : ''}"></i>`).join('')}</span>
          </div>`).join('')}
      </div>
    </div>` : `
    <div class="p-card flat">
      <div class="section-title"><span>Shared target operation</span><b>No fleet assigned</b></div>
      <p style="margin-top:8px;font-size:.82rem;line-height:1.5;color:var(--muted)">
        In this mode every operator attacks the same hostile fleet. Check the main display for target damage, and use Fire Control to spend missiles.
      </p>
    </div>`;

  ui.fleetPanel.innerHTML = `
    ${gridHtml}
    <div class="p-card flat">
      <div class="section-title"><span>Team performance</span><b>${esc(me.teamName)}</b></div>
      <div class="stats-grid" style="margin-top:10px">
        <div class="stat-box"><span>Score</span><b>${fmt(me.score)}</b></div>
        <div class="stat-box"><span>Accuracy</span><b>${team?.accuracy || 0}%</b></div>
        <div class="stat-box"><span>Hits</span><b>${team?.stats.hits || 0}</b></div>
        <div class="stat-box"><span>Missiles fired</span><b>${team?.stats.missilesFired || 0}</b></div>
      </div>
      <div class="team-members" style="margin-top:10px">
        ${me.teammates.map((member) => `<span class="member-tag ${member.id === me.id ? 'me' : ''}">${esc(member.name)}</span>`).join('')}
      </div>
    </div>
    <div class="p-card flat">
      <div class="section-title"><span>Your briefing record</span><b>${me.totals.correct}/${me.totals.answers}</b></div>
      <p style="margin-top:6px;font-size:.72rem;color:var(--muted-2);font-family:var(--font-mono);letter-spacing:.06em">
        CORRECT ANSWERS / TOTAL SUBMITTED
      </p>
    </div>`;
}

/* ----------------------------------------------------------------- results */

function updateResultOverlay() {
  if (!state?.me) {
    ui.resultOverlay.classList.add('hidden');
    return;
  }
  if (state.phase !== 'ended' || !state.final || dismissedFinalFor === state.final.endedAt) {
    ui.resultOverlay.classList.add('hidden');
    return;
  }

  const me = state.me;
  const final = state.final;
  const myRow = final.ranking.find((row) => row.teamId === me.teamId);
  const rank = final.ranking.findIndex((row) => row.teamId === me.teamId) + 1;
  const won = final.winnerTeamId === me.teamId;

  $('#resultTitle').textContent = won ? 'SECTOR SECURED' : 'OPERATION COMPLETE';
  $('#resultWinner').textContent = final.winnerName ? `${final.winnerName} WINS` : 'NO WINNER';
  $('#resultStats').innerHTML = `
    <div class="stat-box"><span>Your rank</span><b>${rank} / ${final.ranking.length}</b></div>
    <div class="stat-box"><span>Team score</span><b>${fmt(myRow?.score || 0)}</b></div>
    <div class="stat-box"><span>Accuracy</span><b>${myRow?.accuracy || 0}%</b></div>
    <div class="stat-box"><span>Your correct</span><b>${me.totals.correct} / ${me.totals.answers}</b></div>`;
  ui.resultOverlay.classList.remove('hidden');
  if (!won) audio.play('reveal');
}

$('#resultClose').addEventListener('click', () => {
  dismissedFinalFor = state?.final?.endedAt ?? null;
  ui.resultOverlay.classList.add('hidden');
});

/* --------------------------------------------------------------- lifecycle */

function resetToJoin(message) {
  joined = false;
  token = '';
  resumeInFlight = false;
  localStorage.removeItem('cb.playerToken');
  state = null;
  selectedTeamId = null;
  selectedTargetId = null;
  selectedCell = null;
  pendingJoin = false;
  pendingAnswer = false;
  pendingFire = false;
  joinChoicesSignature = '';
  lastQuizKey = '';
  lastFireKey = '';
  lastFleetKey = '';
  lastFeedbackKey = '';
  ui.controller.classList.add('hidden');
  ui.joinView.classList.remove('hidden');
  ui.resultOverlay.classList.add('hidden');
  ui.joinButton.disabled = false;
  ui.joinButton.textContent = 'ESTABLISH UPLINK';
  if (message) showJoinError(message);
  socket.emit('player:hello');
}

$('#soundButton').addEventListener('click', async () => {
  await audio.init();
  const enabled = audio.toggle();
  syncSoundButton();
  if (enabled) showToast('Sound on', 'good', 1400);
});

function syncSoundButton() {
  const button = $('#soundButton');
  button.textContent = audio.enabled ? 'SND' : 'MUTE';
  button.classList.toggle('off', !audio.enabled);
}
syncSoundButton();

/* -------------------------------------------------------------- timers etc */

setInterval(() => {
  if (!state || state.phase !== 'question') return;
  const fill = $('#pTimerFill');
  const text = $('#pTimerText');
  if (!fill || !text) return;
  if (state.paused || !state.phaseEndsAt || !state.settings.questionSeconds) {
    fill.style.width = state.paused ? '0%' : '100%';
    text.textContent = state.paused ? 'Ⅱ' : '∞';
    return;
  }
  const remaining = Math.max(0, (state.phaseEndsAt - (Date.now() + serverOffset)) / 1000);
  fill.style.width = `${Math.max(0, Math.min(1, remaining / state.settings.questionSeconds)) * 100}%`;
  fill.classList.toggle('low', remaining <= 8);
  text.textContent = String(Math.ceil(remaining));
}, 200);

ui.joinCode.addEventListener('input', () => {
  ui.joinCode.dataset.autofilled = 'false';
  ui.joinCode.value = ui.joinCode.value.toUpperCase();
});
