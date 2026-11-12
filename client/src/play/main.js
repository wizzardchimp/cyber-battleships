import '../../styles/theme.css';
import '../../styles/play.css';

import { PHASES, TIMING } from '@shared/constants.js';
import { EVENTS } from '@shared/events.js';
import { normaliseCode } from '@shared/util.js';
import { api } from '../shared/api.js';
import { sfx, unlockAudio } from '../shared/audio.js';
import { formatCountdown, syncClock } from '../shared/clock.js';
import { $, escapeHtml, toast } from '../shared/dom.js';
import { coordLabel, renderGrid } from '../shared/grid.js';
import { createSocket, request } from '../shared/socket.js';

const app = $('#app');
const LETTERS = 'ABC';

let code = normaliseCode(new URLSearchParams(window.location.search).get('code') || '');
let sessionInfo = null;
let socket = null;
let connected = false;
let joined = false;
let resuming = false;
let playerState = null;
let closedMessage = '';

let joinDraft = { name: localStorage.getItem('cb.play.name') || '', teamId: null };
let joinError = '';
let joining = false;
let gateError = '';

let feedback = null;
let feedbackTimer = null;
let answering = false;
let firing = false;
let shotMsg = null;
let lastSig = '';

// ------------------------------------------------------------------ storage

const tokenKey = () => `cb.player.${code}`;

function readToken() {
  try {
    return JSON.parse(localStorage.getItem(tokenKey()) || 'null');
  } catch {
    return null;
  }
}

function saveToken(token, playerId, name) {
  localStorage.setItem(tokenKey(), JSON.stringify({ token, playerId, name }));
}

function clearToken() {
  localStorage.removeItem(tokenKey());
}

// ------------------------------------------------------------------ shell

function shell(inner, { side = null } = {}) {
  app.innerHTML = `
    <div class="p-bar">
      <span class="p-brand">CYBER BATTLESHIPS</span>
      <span id="p-link" class="p-link"></span>
    </div>
    <main class="p-main" ${side ? `style="--side:${escapeHtml(side)}"` : ''}>${inner}</main>`;
  renderLink();
  updateCountdowns();
}

function renderLink() {
  const node = $('#p-link');
  if (!node) return;
  node.classList.toggle('is-off', !connected);
  node.innerHTML = `<span class="status-dot ${connected ? '' : 'status-dot--off'}"></span>${connected ? 'LIVE' : 'RECONNECTING'}`;
}

function renderLoading(message = 'Loading…') {
  lastSig = '';
  app.innerHTML = `
    <div class="boot-screen">
      <div class="boot-screen__logo">CYBER BATTLESHIPS</div>
      <div class="boot-screen__bar"><span></span></div>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

function renderMessage(title, message, { button = null } = {}) {
  shell(`
    <section class="p-card panel hud">
      <h1 class="p-title p-title--accent">${escapeHtml(title)}</h1>
      <p class="p-copy">${escapeHtml(message)}</p>
      ${button ? `<button class="btn btn--primary btn--wide" type="button" data-action="${button.action}">${escapeHtml(button.label)}</button>` : ''}
    </section>`);
}

// ------------------------------------------------------------------- screens

function renderGate() {
  shell(`
    <section class="p-card panel hud">
      <h1 class="p-title p-title--accent">JOIN THE GAME</h1>
      <p class="p-copy">Enter the six-character code shown on the big screen.</p>
      <form id="gate-form" class="p-form" novalidate>
        <input class="input input--code" name="code" maxlength="6" placeholder="ABC123" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${escapeHtml(code)}" />
        ${gateError ? `<p class="form-error">${escapeHtml(gateError)}</p>` : ''}
        <button class="btn btn--primary btn--wide" type="submit">CONTINUE</button>
      </form>
    </section>`);
}

function renderJoin() {
  const session = sessionInfo.session;
  const teams = sessionInfo.teams || [];
  if (session.phase !== PHASES.LOBBY) {
    renderMessage(
      'GAME ALREADY STARTED',
      'This game is under way. Ask the facilitator to return to the lobby, or wait for the next game.',
      { button: { action: 'reload', label: 'CHECK AGAIN' } },
    );
    return;
  }

  const full = teams.every((team) => team.playerCount >= team.maxPlayers);
  if (full) {
    renderMessage('GAME FULL', 'Every place in this game is taken. Ask the facilitator for a spot.', {
      button: { action: 'reload', label: 'CHECK AGAIN' },
    });
    return;
  }

  const options =
    teams.length > 1
      ? teams
          .map((team) => {
            const isFull = team.playerCount >= team.maxPlayers;
            const checked =
              joinDraft.teamId === team.id && !isFull ? 'checked' : '';
            return `
            <label class="side-opt" style="--side:${team.color}">
              <input type="radio" name="team" value="${escapeHtml(team.id)}" ${checked} ${isFull ? 'disabled' : ''} />
              <span class="side-opt__name">${escapeHtml(team.name)}</span>
              <span class="side-opt__count">${isFull ? 'FULL' : `${team.playerCount} / ${team.maxPlayers}`}</span>
            </label>`;
          })
          .join('')
      : '';

  shell(`
    <section class="p-card panel hud">
      <h1 class="p-title p-title--accent">JOIN THE GAME</h1>
      <form id="join-form" class="p-form" novalidate>
        <label class="field">
          <span class="field__label">Your name</span>
          <input class="input" name="name" value="${escapeHtml(joinDraft.name)}" maxlength="16" autocomplete="nickname" placeholder="Type a name" required />
        </label>
        ${
          options
            ? `<div class="field"><span class="field__label">Pick your side</span><div class="side-pick">${options}</div></div>`
            : '<p class="p-copy">You are on the crew. Everyone plays together against the CPU.</p>'
        }
        ${joinError ? `<p class="form-error">${escapeHtml(joinError)}</p>` : ''}
        <button class="btn btn--go btn--wide" type="submit" ${joining ? 'disabled' : ''}>${joining ? 'JOINING…' : 'JOIN GAME'}</button>
      </form>
    </section>
    <p class="p-hint">Game code <b>${escapeHtml(session.joinCode)}</b></p>`);
}

function myTeam() {
  return playerState?.teams?.find((team) => team.id === playerState.me?.teamId) || null;
}

function renderLobby() {
  const me = playerState.me;
  const team = myTeam();
  const color = me.teamColor || '#19e3ff';
  const others = playerState.teams.filter((entry) => entry.id !== me.teamId);
  const canSwitch = others.filter((entry) => entry.playerCount < entry.maxPlayers);

  shell(
    `
    <section class="team-banner hud" style="--bracket:${color}">
      <span class="team-banner__label">YOU ARE IN</span>
      <span class="team-banner__name">${escapeHtml(me.teamName || 'THE GAME')}</span>
      <span class="team-banner__you">${escapeHtml(me.name)}</span>
    </section>
    ${
      team
        ? `<section class="p-card panel">
             <div class="field__label">${escapeHtml(team.name)} crew · ${team.playerCount} / ${team.maxPlayers}</div>
             <div class="roster">
               ${team.players
                 .map(
                   (player) => `
                 <div class="roster__row ${player.id === me.id ? 'is-me' : ''}">
                   <span>${escapeHtml(player.name)}${player.id === me.id ? ' (you)' : ''}</span>
                   <small>${player.connected ? 'ONLINE' : 'OFFLINE'}</small>
                 </div>`,
                 )
                 .join('')}
             </div>
           </section>`
        : ''
    }
    ${others
      .map(
        (other) =>
          `<p class="p-hint"><b style="color:${other.color}">${escapeHtml(other.name)}</b> has ${other.playerCount} / ${other.maxPlayers} players</p>`,
      )
      .join('')}
    ${canSwitch
      .map(
        (other) =>
          `<button class="btn btn--ghost btn--wide" type="button" data-switch="${escapeHtml(other.id)}">SWITCH TO ${escapeHtml(other.name)}</button>`,
      )
      .join('')}
    <div class="waiting">
      <div class="waiting__pulse">CB</div>
      <p>Waiting for the facilitator to start the game.<br />Keep this page open.</p>
    </div>`,
    { side: color },
  );
}

function topBar(endsAt, missiles) {
  return `
    <div class="q-top">
      <div class="q-timer"><span>TIME</span><strong data-countdown="${escapeHtml(endsAt || '')}">${formatCountdown(endsAt)}</strong></div>
      <div class="q-missiles"><span>MISSILES</span><strong>${missiles}</strong></div>
    </div>`;
}

function renderQuiz() {
  const round = playerState.round;
  const me = round.me;
  const color = playerState.me.teamColor || '#19e3ff';
  const question = me.question;

  let body;
  if (feedback && Date.now() < feedback.until) {
    const right = feedback.correct;
    const rightText = feedback.options?.[feedback.correctIndex] ?? '';
    body = `
      <section class="feedback ${right ? '' : 'feedback--wrong'}" style="--feedback-ms:${TIMING.feedbackMs}ms">
        <h2 class="feedback__title">${right ? 'CORRECT!' : 'NOT QUITE'}</h2>
        ${right ? `<p class="feedback__reward">+${feedback.reward} missile${feedback.reward === 1 ? '' : 's'}</p>` : ''}
        <p class="feedback__answer">${right ? 'Right answer' : 'The answer was'}: <b>${LETTERS[feedback.correctIndex]}</b> ${escapeHtml(rightText)}</p>
        ${feedback.explanation ? `<p class="feedback__why">${escapeHtml(feedback.explanation)}</p>` : ''}
        <div class="feedback__bar"><span></span></div>
        <button class="btn btn--primary btn--wide" type="button" data-action="skip-feedback">NEXT QUESTION</button>
      </section>`;
  } else if (!question) {
    body = `<div class="waiting"><div class="waiting__pulse">CB</div><p>Loading your next question…</p></div>`;
  } else {
    body = `
      <div class="q-meta">${(round.cycle || 1) > 1 ? `Round ${round.cycle} · ` : ''}Question ${question.number} · ${escapeHtml(question.category)}</div>
      <h1 class="q-text">${escapeHtml(question.prompt)}</h1>
      <div class="answers">
        ${question.options
          .map(
            (option, index) => `
          <button class="answer" type="button" data-answer="${index}" ${answering ? 'disabled' : ''}>
            <span class="answer__key">${LETTERS[index]}</span>
            <span class="answer__text">${escapeHtml(option)}</span>
          </button>`,
          )
          .join('')}
      </div>`;
  }

  shell(
    `
    ${topBar(round.quizEndsAt, me.missiles)}
    ${body}
    <p class="p-foot"><b>${escapeHtml(playerState.me.teamName || '')}</b> · you answered ${me.answered}, ${me.correct} correct</p>`,
    { side: color },
  );
}

function renderBriefing() {
  const round = playerState.round;
  const me = round.me;
  const color = playerState.me.teamColor || '#19e3ff';
  const progress = round.teams.find((team) => team.id === playerState.me.teamId);
  shell(
    `
    <section class="p-card panel hud" style="--bracket:${color}">
      <h1 class="p-title p-title--accent">TIME'S UP!</h1>
      <p class="p-copy">Here is what <b style="color:${color}">${escapeHtml(playerState.me.teamName || 'your side')}</b> won.</p>
      <div class="stat-grid">
        <div class="stat-box stat-box--missiles"><strong>${me.missiles}</strong><span>MISSILES READY TO FIRE</span></div>
        <div class="stat-box"><strong>${progress?.won ?? 0}</strong><span>WON THIS ROUND</span></div>
        <div class="stat-box"><strong>${progress?.accuracy ?? 0}%</strong><span>ACCURACY</span></div>
        <div class="stat-box"><strong>${me.correct}</strong><span>YOUR CORRECT</span></div>
        <div class="stat-box"><strong>${me.answered}</strong><span>YOUR ANSWERS</span></div>
      </div>
    </section>
    <div class="waiting">
      <div class="waiting__pulse">CB</div>
      <p>Get ready.<br />The battle starts when the facilitator is ready.</p>
    </div>`,
    { side: color },
  );
}

function renderBattle() {
  const round = playerState.round;
  const me = round.me;
  const color = playerState.me.teamColor || '#19e3ff';
  const board = me.targetBoard;
  const targetColor = board?.color || '#ff3d9a';

  if (!board) {
    renderMessage('STAND BY', 'No target has been assigned to you.');
    return;
  }

  const canFire = me.missiles > 0;
  let message = '';
  if (shotMsg) {
    message = `<div class="shot-msg shot-msg--${shotMsg.kind}">${escapeHtml(shotMsg.text)}</div>`;
  } else if (canFire) {
    message = '<div class="shot-msg">Tap a square to fire.</div>';
  }
  if (!canFire) {
    message = `<div class="shot-msg shot-msg--out">Out of missiles. Another round of questions is coming so you can earn more.</div>`;
  }

  shell(
    `
    ${topBar(round.battleEndsAt, me.missiles)}
    <div class="target" style="--side:${targetColor}">
      <span class="target__label">FIRE AT</span>
      <span class="target__name">${escapeHtml(me.targetName || board.name)}</span>
    </div>
    <div class="fire-grid">
      ${renderGrid({ size: board.gridSize, shots: board.shots, interactive: true, disabled: !canFire || firing, axes: false, label: 'Target grid' })}
    </div>
    ${message}
    <p class="p-foot">Ships sunk <b>${board.shipsSunk} / ${board.shipsTotal}</b> · ${escapeHtml(playerState.me.teamName || '')} <b>${round.scores.find((score) => score.id === playerState.me.teamId)?.points ?? 0} pts</b></p>`,
    { side: color },
  );
}

function renderResupply() {
  const round = playerState.round;
  const me = round.me;
  const color = playerState.me.teamColor || '#19e3ff';
  const board = me.targetBoard;
  const reason = round.battleEndReason;
  const title = me.missiles === 0 ? 'OUT OF MISSILES' : 'BATTLE PAUSED';
  const lead =
    me.missiles === 0
      ? 'Your side has no missiles left.'
      : reason === 'time'
        ? 'The battle timer ran out.'
        : 'The battle round was ended.';
  const points = round.scores.find((score) => score.id === playerState.me.teamId)?.points ?? 0;
  shell(
    `
    <section class="p-card panel hud" style="--bracket:var(--amber)">
      <h1 class="p-title" style="color:var(--amber)">${title}</h1>
      <p class="p-copy">${lead} The facilitator will start another round of questions so you can earn more.</p>
      <div class="stat-grid">
        <div class="stat-box stat-box--missiles"><strong>${me.missiles}</strong><span>MISSILES LEFT</span></div>
        <div class="stat-box"><strong>${board ? `${board.shipsSunk}/${board.shipsTotal}` : '-'}</strong><span>SHIPS SUNK</span></div>
        <div class="stat-box"><strong>${points}</strong><span>YOUR POINTS</span></div>
      </div>
    </section>
    <div class="waiting">
      <div class="waiting__pulse">CB</div>
      <p>The game ends when every ship on a fleet is sunk.<br />Keep this page open.</p>
    </div>`,
    { side: color },
  );
}

function renderResult() {
  const round = playerState.round;
  const outcome = round.outcome || {};
  const myId = playerState.me.teamId;
  const cpuGame = round.combatants.some((combatant) => combatant.kind === 'cpu');
  let big = 'DRAW';
  let color = 'var(--cyan)';
  let line = 'Scores were level.';
  if (cpuGame) {
    big = outcome.humanWin ? 'VICTORY' : 'DEFEAT';
    color = outcome.humanWin ? 'var(--green)' : 'var(--red)';
    line = outcome.humanWin ? 'You breached the firewall!' : 'The firewall held.';
  } else if (!outcome.draw) {
    const won = outcome.winnerId === myId;
    big = won ? 'VICTORY' : 'DEFEAT';
    color = won ? 'var(--green)' : 'var(--red)';
    line = won ? 'Your side wins!' : `${outcome.winnerName} wins.`;
  }

  const scores = round.scores.filter((score) => score.kind === 'team');
  shell(
    `
    <section class="verdict" style="--win:${color}">
      <span class="verdict__big">${big}</span>
      <span class="verdict__line">${escapeHtml(line)}</span>
      <span class="verdict__reason">${escapeHtml(outcome.reason || '')}</span>
    </section>
    <section class="score-list">
      ${scores
        .map(
          (score) => `
        <div class="score-row" style="--side:${score.color}">
          <span class="score-row__name">${escapeHtml(score.name)}${score.id === myId ? ' (you)' : ''}</span>
          <span class="score-row__pts">${score.points}<small>PTS</small></span>
        </div>`,
        )
        .join('')}
    </section>
    <div class="waiting">
      <div class="waiting__pulse">CB</div>
      <p>Waiting for the facilitator to start the next game.</p>
    </div>`,
    { side: playerState.me.teamColor || '#19e3ff' },
  );
}

// ------------------------------------------------------------------ render

function signature() {
  if (closedMessage) return `closed:${closedMessage}`;
  if (!sessionInfo) return `gate:${gateError}`;
  if (!joined || !playerState?.me) {
    return [
      'join',
      sessionInfo.session.phase,
      JSON.stringify((sessionInfo.teams || []).map((team) => [team.id, team.playerCount])),
      joining,
      joinError,
    ].join('|');
  }
  const state = playerState;
  const phase = state.session.phase;
  const round = state.round;
  const me = round?.me;
  switch (phase) {
    case PHASES.LOBBY:
      return JSON.stringify([
        phase,
        state.me.teamId,
        state.teams.map((team) => [team.id, team.playerCount, team.players.map((player) => [player.id, player.connected])]),
      ]);
    case PHASES.QUIZ:
      return JSON.stringify([
        phase,
        round?.cycle,
        me?.question?.number,
        me?.missiles,
        me?.answered,
        Boolean(feedback && Date.now() < feedback.until),
        feedback?.number,
        answering,
      ]);
    case PHASES.REVIEW:
      return JSON.stringify([phase, me?.missiles, me?.correct, round?.teams]);
    case PHASES.BATTLE:
      return JSON.stringify([
        phase,
        me?.missiles,
        me?.targetBoard?.shots?.length,
        me?.targetBoard?.shipsSunk,
        shotMsg?.id,
        firing,
        round?.scores?.map((score) => score.points),
      ]);
    case PHASES.RESUPPLY:
      return JSON.stringify([
        phase,
        round?.battleEndReason,
        me?.missiles,
        me?.targetBoard?.shipsSunk,
        round?.scores?.map((score) => score.points),
      ]);
    case PHASES.RESULT:
      return JSON.stringify([phase, round?.outcome, round?.scores?.map((score) => score.points)]);
    default:
      return phase;
  }
}

function render(force = false) {
  if ((answering || firing) && !force) return;

  if (closedMessage) {
    const sig = signature();
    if (sig === lastSig && !force) return;
    lastSig = sig;
    renderMessage('GAME ENDED', closedMessage, { button: { action: 'home', label: 'ENTER A NEW CODE' } });
    return;
  }
  if (!sessionInfo) {
    const sig = signature();
    if (sig === lastSig && !force) return;
    lastSig = sig;
    renderGate();
    return;
  }

  const sig = signature();
  if (sig === lastSig && !force) return;
  lastSig = sig;

  if (!joined || !playerState?.me) {
    if (joined) renderLoading('Loading your game…');
    else renderJoin();
    return;
  }

  switch (playerState.session.phase) {
    case PHASES.QUIZ:
      renderQuiz();
      break;
    case PHASES.REVIEW:
      renderBriefing();
      break;
    case PHASES.BATTLE:
      renderBattle();
      break;
    case PHASES.RESUPPLY:
      renderResupply();
      break;
    case PHASES.RESULT:
      renderResult();
      break;
    default:
      renderLobby();
  }
}

// -------------------------------------------------------------- connection

function ensureSocket() {
  if (socket) return;
  socket = createSocket();
  socket.on('hello', ({ serverNow }) => syncClock(serverNow));
  socket.on('connect', async () => {
    connected = true;
    renderLink();
    if (readToken()?.token) await resume();
  });
  socket.on('disconnect', () => {
    connected = false;
    renderLink();
  });
  socket.on('connect_error', () => {
    connected = false;
    renderLink();
  });
  socket.on(EVENTS.STATE, (next) => {
    syncClock(next.meta?.serverNow);
    const previous = playerState?.session?.phase;
    playerState = next;
    if (previous && previous !== next.session.phase) {
      feedback = null;
      shotMsg = null;
      if ([PHASES.QUIZ, PHASES.BATTLE, PHASES.RESUPPLY].includes(next.session.phase)) sfx.alert();
      if (next.session.phase === PHASES.RESULT) sfx.success();
    }
    if (joined) render();
  });
  socket.on(EVENTS.SESSION_CLOSED, () => {
    clearToken();
    closedMessage = 'The facilitator started a new game. Scan the new QR code to join it.';
    render(true);
  });
  socket.on(EVENTS.PLAYER_REMOVED, () => {
    clearToken();
    closedMessage = 'The facilitator removed you from the game.';
    render(true);
  });
  socket.on(EVENTS.PLAYER_SUPERSEDED, () => {
    closedMessage = 'This game was opened on another device. Close this page and use the other one.';
    render(true);
  });
  socket.on(EVENTS.GAME_ERROR, (error) => toast(error.message, 'error', '#toast-root'));
  socket.connect();
}

async function resume() {
  const saved = readToken();
  if (!saved?.token || resuming) return;
  resuming = true;
  if (!playerState) renderLoading('Reconnecting…');
  try {
    await request(socket, EVENTS.PLAYER_RESUME, { code, token: saved.token });
    joined = true;
  } catch (error) {
    if (error.code === 'RESUME_FAILED' || error.code === 'SESSION_NOT_FOUND') {
      clearToken();
      joined = false;
      playerState = null;
      joinError = 'Your saved place is no longer valid. Join again.';
      await refreshSession();
      render(true);
    } else {
      toast(error.message, 'error', '#toast-root');
    }
  } finally {
    resuming = false;
  }
}

async function refreshSession() {
  try {
    sessionInfo = await api(`/api/sessions/${encodeURIComponent(code)}`);
  } catch (error) {
    if (error.status === 404) {
      sessionInfo = null;
      closedMessage = 'That game is no longer running. Scan the new QR code.';
    }
  }
}

async function boot() {
  if (!code) {
    renderGate();
    return;
  }
  renderLoading('Finding your game…');
  try {
    sessionInfo = await api(`/api/sessions/${encodeURIComponent(code)}`);
    ensureSocket();
    if (!readToken()?.token) render(true);
  } catch (error) {
    sessionInfo = null;
    gateError = error.status === 404 ? 'That code is not a running game.' : error.message;
    code = '';
    renderGate();
  }
}

async function join() {
  joining = true;
  joinError = '';
  render(true);
  try {
    if (!socket.connected) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Could not reach the game server.')), 10_000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.connect();
      });
    }
    const result = await request(socket, EVENTS.PLAYER_JOIN, {
      code,
      name: joinDraft.name,
      teamId: joinDraft.teamId || null,
    });
    saveToken(result.token, result.playerId, joinDraft.name);
    localStorage.setItem('cb.play.name', joinDraft.name);
    joined = true;
    sfx.join();
  } catch (error) {
    joinError = error.message;
    sfx.error();
    await refreshSession();
  } finally {
    joining = false;
    render(true);
  }
}

// ----------------------------------------------------------------- actions

async function submitAnswer(optionIndex) {
  const question = playerState?.round?.me?.question;
  if (!question || answering) return;
  answering = true;
  for (const node of app.querySelectorAll('[data-answer]')) node.disabled = true;
  const snapshot = { prompt: question.prompt, options: [...question.options], number: question.number };
  sfx.click();
  try {
    const result = await request(socket, EVENTS.PLAYER_ANSWER, {
      questionNumber: question.number,
      optionIndex,
    });
    feedback = {
      ...snapshot,
      correct: result.correct,
      reward: result.reward,
      correctIndex: result.correctIndex,
      explanation: result.explanation,
      until: Date.now() + TIMING.feedbackMs,
    };
    if (result.correct) sfx.success();
    else sfx.error();
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedback = null;
      render(true);
    }, TIMING.feedbackMs);
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
    sfx.error();
  } finally {
    answering = false;
    render(true);
  }
}

async function fire(x, y) {
  if (firing) return;
  firing = true;
  const cells = app.querySelectorAll('[data-fire-x]');
  for (const node of cells) node.disabled = true;
  try {
    const result = await request(socket, EVENTS.PLAYER_ATTACK, { x, y });
    const where = coordLabel(x, y);
    if (result.sunk) {
      shotMsg = { id: Date.now(), kind: 'sunk', text: `${where}: HIT! You sank the ${result.shipName}!` };
      sfx.alert();
    } else if (result.hit) {
      shotMsg = { id: Date.now(), kind: 'hit', text: `${where}: DIRECT HIT!` };
      sfx.success();
    } else {
      shotMsg = { id: Date.now(), kind: 'miss', text: `${where}: miss` };
      sfx.click();
    }
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
    sfx.error();
  } finally {
    firing = false;
    render(true);
  }
}

async function switchTeam(teamId) {
  try {
    await request(socket, EVENTS.PLAYER_CHOOSE_TEAM, { teamId });
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
    sfx.error();
  }
}

app.addEventListener('click', (event) => {
  unlockAudio();

  const answer = event.target.closest('[data-answer]');
  if (answer) {
    submitAnswer(Number(answer.dataset.answer));
    return;
  }

  const cell = event.target.closest('[data-fire-x]');
  if (cell) {
    fire(Number(cell.dataset.fireX), Number(cell.dataset.fireY));
    return;
  }

  const switcher = event.target.closest('[data-switch]');
  if (switcher) {
    switchTeam(switcher.dataset.switch);
    return;
  }

  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'skip-feedback') {
    clearTimeout(feedbackTimer);
    feedback = null;
    render(true);
  } else if (action === 'reload') {
    window.location.reload();
  } else if (action === 'home') {
    window.location.href = '/';
  }
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target.closest('form');
  if (!form) return;

  if (form.id === 'gate-form') {
    const next = normaliseCode(new FormData(form).get('code') || '');
    if (next.length !== 6) {
      gateError = 'Enter the six-character code.';
      renderGate();
      return;
    }
    code = next;
    gateError = '';
    window.history.replaceState({}, '', `/play?code=${encodeURIComponent(code)}`);
    boot();
    return;
  }

  if (form.id === 'join-form') {
    const data = new FormData(form);
    joinDraft = {
      name: String(data.get('name') || '').trim(),
      teamId: data.get('team') ? String(data.get('team')) : null,
    };
    if (joinDraft.name.length < 2) {
      joinError = 'Type a name with at least two letters.';
      render(true);
      return;
    }
    if ((sessionInfo?.teams?.length || 0) > 1 && !joinDraft.teamId) {
      joinError = 'Pick a side to join.';
      render(true);
      return;
    }
    join();
  }
});

app.addEventListener('change', (event) => {
  if (event.target.name === 'team') joinDraft.teamId = event.target.value;
});

app.addEventListener('input', (event) => {
  if (event.target.name === 'name') joinDraft.name = event.target.value;
});

// --------------------------------------------------------------- countdown

function updateCountdowns() {
  for (const node of document.querySelectorAll('[data-countdown]')) {
    const value = formatCountdown(node.dataset.countdown);
    if (node.textContent !== value) node.textContent = value;
    const [minutes, seconds] = value.split(':').map(Number);
    node.classList.toggle('is-low', minutes === 0 && seconds <= 10 && node.dataset.countdown !== '');
  }
}

setInterval(updateCountdowns, 250);

// Keep the join screen's side counts fresh while a player is choosing.
setInterval(async () => {
  if (!code || joined || joining || closedMessage || !sessionInfo || document.hidden) return;
  const input = document.activeElement;
  if (input && input.tagName === 'INPUT') return;
  await refreshSession();
  render();
}, 5000);

boot();
