import '../../styles/theme.css';
import '../../styles/play.css';

import { PHASES, TIMING } from '@shared/constants.js';
import { EVENTS } from '@shared/events.js';
import { normaliseCode } from '@shared/util.js';
import { cancelGetReady, getReadyBlocking, newLastBoats, runGetReady, showLastBoat } from '../shared/notices.js';
import { api } from '../shared/api.js';
import { sfx, unlockAudio } from '../shared/audio.js';
import {
  RESULT_DELAY,
  playBattle,
  playShotResult,
  preloadBattleSounds,
  setBattleSoundsEnabled,
} from '../shared/battleSounds.js';
import { runCaptainDraw } from '../shared/captainDraw.js';
import { formatCountdown, msRemaining, serverNow, syncClock } from '../shared/clock.js';
import { $, escapeHtml, toast } from '../shared/dom.js';
import { coordLabel, renderGrid } from '../shared/grid.js';
import { createSocket, request } from '../shared/socket.js';

const app = $('#app');
const LETTERS = 'ABC';
const BEEP_SECONDS = 10;

let code = normaliseCode(new URLSearchParams(window.location.search).get('code') || '');
let sessionInfo = null;
let socket = null;
let connected = false;
let joined = false;
let resuming = false;
let playerState = null;
let closedMessage = '';

// The name is never remembered between games: every new join asks for it.
localStorage.removeItem('cb.play.name');
let joinDraft = { name: '', teamId: null };
// Joining takes two screens: the name first, then the side.
let joinStep = 'name';
let joinError = '';
let joining = false;
let gateError = '';

let feedback = null;
// Set while a run of wrong answers is holding the player back: { until, ms, wrong }.
let penalty = null;
let penaltyTimer = null;
let feedbackTimer = null;
let answering = false;
let firing = false;
let shotMsg = null;
let lastSig = '';
let lastBeep = null;
let passOpen = false;
let voting = false;

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

function shell(inner, { side = null, compact = false } = {}) {
  app.classList.toggle('is-battle', compact);
  app.innerHTML = `
    <div class="p-bar">
      <span class="p-brand"><img class="p-brand__mark" src="/brand/mark-128.png" alt="" />CYBER BATTLESHIPS</span>
      <span class="p-fs-tip"><kbd>F</kbd> FULL SCREEN</span>
      <span id="p-link" class="p-link"></span>
    </div>
    <main class="p-main" ${side ? `style="--side:${escapeHtml(side)}"` : ''}>${inner}</main>`;
  renderLink();
  updateCountdowns();
}

/**
 * Spectators do not fire, so they learn about the captain's shots from state
 * updates: show the result and play the same sounds the captain hears.
 */
function watchShots(before, after) {
  if (after.session?.phase !== PHASES.BATTLE || before?.session?.phase !== PHASES.BATTLE) return;
  const me = after.round?.me;
  if (!me || me.isCaptain || !before.round?.me || before.round.number !== after.round.number) return;
  const oldBoards = new Map((before.round.me.targetBoards || []).map((board) => [board.id, board]));
  let hit = false;
  let sunk = false;
  let last = null;
  let lastBoard = null;
  for (const board of me.targetBoards || []) {
    const old = oldBoards.get(board.id);
    if (!old) continue;
    const added = board.shots.slice(old.shots.length);
    if (added.length === 0) continue;
    hit ||= added.some((shot) => shot.hit);
    sunk ||= board.shipsSunk > old.shipsSunk;
    last = added[added.length - 1];
    lastBoard = board;
  }
  if (!last) return;
  const who = me.captainName || 'Your captain';
  const where = `${(me.targetBoards || []).length > 1 ? `${lastBoard.name} ` : ''}${coordLabel(last.x, last.y)}`;
  const text = sunk
    ? `${who} fired at ${where}: HIT! A ship was sunk!`
    : hit
      ? `${who} fired at ${where}: DIRECT HIT!`
      : `${who} fired at ${where}: miss`;
  shotMsg = { id: Date.now(), kind: sunk ? 'sunk' : hit ? 'hit' : 'miss', text };
  playBattle('fire');
  playShotResult({ hit, sunk });
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
      <img class="boot-screen__mark" src="/brand/mark-256.png" alt="" />
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
      <p class="p-copy">Enter the three-digit code shown on the big screen.</p>
      <form id="gate-form" class="p-form" novalidate>
        <input class="input input--code" name="code" maxlength="3" placeholder="123" inputmode="numeric" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(code)}" />
        ${gateError ? `<p class="form-error">${escapeHtml(gateError)}</p>` : ''}
        <button class="btn btn--primary btn--wide" type="submit">CONTINUE</button>
      </form>
    </section>`);
}

function renderJoin() {
  const session = sessionInfo.session;
  const teams = sessionInfo.teams || [];
  if (session.phase !== PHASES.LOBBY && session.phase !== PHASES.QUIZ) {
    renderMessage(
      'JOINING IS CLOSED',
      'The battle is under way. You can join during the next question round, or ask the facilitator to return to the lobby.',
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

  const picking = teams.length > 1;
  if (picking && joinStep === 'team') {
    renderJoinTeam(session, teams);
    return;
  }

  shell(`
    <section class="p-card panel hud">
      <h1 class="p-title p-title--accent">JOIN THE GAME</h1>
      <form id="name-form" class="p-form" novalidate>
        <label class="field">
          <span class="field__label">Your name</span>
          <input class="input" name="name" value="${escapeHtml(joinDraft.name)}" maxlength="16" autocomplete="off" placeholder="Type a name" required />
        </label>
        ${picking ? '' : '<p class="p-copy">You are on the crew. Everyone plays together against the CPU.</p>'}
        ${joinError ? `<p class="form-error">${escapeHtml(joinError)}</p>` : ''}
        <button class="btn btn--go btn--wide" type="submit" ${joining ? 'disabled' : ''}>${picking ? 'NEXT' : joining ? 'JOINING…' : 'JOIN GAME'}</button>
      </form>
    </section>
    <p class="p-hint">Game code <b>${escapeHtml(session.joinCode)}</b></p>`);
}

function renderJoinTeam(session, teams) {
  const options = teams
    .map((team) => {
      const isFull = team.playerCount >= team.maxPlayers;
      const checked = joinDraft.teamId === team.id && !isFull ? 'checked' : '';
      return `
        <label class="side-opt" style="--side:${team.color}">
          <input type="radio" name="team" value="${escapeHtml(team.id)}" ${checked} ${isFull ? 'disabled' : ''} />
          <span class="side-opt__name">${escapeHtml(team.name)}</span>
          <span class="side-opt__count">${isFull ? 'FULL' : `${team.playerCount} / ${team.maxPlayers}`}</span>
        </label>`;
    })
    .join('');

  shell(`
    <section class="p-card panel hud">
      <h1 class="p-title p-title--accent">PICK YOUR TEAM</h1>
      <p class="p-copy">Playing as <b>${escapeHtml(joinDraft.name)}</b>. You can swap teams until the game starts.</p>
      <form id="join-form" class="p-form" novalidate>
        <div class="side-pick">${options}</div>
        ${joinError ? `<p class="form-error">${escapeHtml(joinError)}</p>` : ''}
        <button class="btn btn--go btn--wide" type="submit" ${joining ? 'disabled' : ''}>${joining ? 'JOINING…' : 'JOIN GAME'}</button>
        <button class="btn btn--ghost btn--wide" type="button" data-action="change-name" ${joining ? 'disabled' : ''}>CHANGE NAME</button>
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
    <section class="team-banner hud" style="--side:${color};--bracket:${color}">
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
      <img class="waiting__pulse" src="/brand/mark-128.png" alt="" />
      <p>Waiting for the facilitator to start the game.<br />Keep this page open.</p>
    </div>`,
    { side: color },
  );
}

function topBar(endsAt, missiles, me = null, opensAt = null) {
  const per = me?.perMissile || 1;
  const frac = per > 1 ? `<small class="q-frac">+${me.ammoProgress || 0}/${per}</small>` : '';
  return `
    <div class="q-top">
      <div class="q-timer"><span>TIME</span><strong data-countdown="${escapeHtml(endsAt || '')}" data-opens="${escapeHtml(opensAt || '')}">${formatCountdown(endsAt, opensAt)}</strong></div>
      <div class="q-missiles"><span>MISSILES</span><strong>${missiles}${frac}</strong></div>
    </div>`;
}

function rewardMarkup() {
  if (feedback.perMissile > 1) {
    return feedback.reward > 0
      ? `<p class="feedback__reward">+${feedback.reward} MISSILE${feedback.reward === 1 ? '' : 'S'}!</p>`
      : `<p class="feedback__reward">+1/${feedback.perMissile} missile<br /><small>${feedback.progress}/${feedback.perMissile} to the next one</small></p>`;
  }
  return `<p class="feedback__reward">+${feedback.reward} missile${feedback.reward === 1 ? '' : 's'}</p>`;
}

function renderQuiz() {
  const round = playerState.round;
  const me = round.me;
  const color = playerState.me.teamColor || '#19e3ff';
  const question = me.question;

  let body;
  if (feedback && Date.now() < feedback.until) {
    const right = feedback.correct;
    const mark = right
      ? '<path d="M14 54 L40 80 L86 20" />'
      : '<path d="M20 20 L80 80 M80 20 L20 80" />';
    const bonus =
      right && feedback.bonus > 0
        ? `<div class="feedback__bonus"><strong>BONUS AMMUNITION!</strong><span>+${feedback.bonus} extra missile${feedback.bonus === 1 ? '' : 's'} · ${feedback.streak} in a row</span></div>`
        : '';
    body = `
      <section class="feedback ${right ? '' : 'feedback--wrong'}" ${feedback.penaltyMs ? '' : 'data-action="skip-feedback"'} aria-live="assertive">
        ${!right && feedback.correctText ? `<div class="feedback__answer"><span>CORRECT ANSWER</span><strong>${escapeHtml(feedback.correctKey)}. ${escapeHtml(feedback.correctText)}</strong></div>` : ''}
        <svg class="feedback__mark" viewBox="0 0 100 100" role="img" aria-label="${right ? 'Correct' : 'Incorrect'}">${mark}</svg>
        ${right ? rewardMarkup() : ''}
        ${bonus}
      </section>`;
  } else if (me.eliminated) {
    body = `<section class="p-card panel hud" style="--bracket:var(--red)">
      <h1 class="p-title" style="color:var(--red)">YOUR FLEET HAS BEEN SUNK</h1>
      <p class="p-copy">${escapeHtml(playerState.me.teamName || 'Your side')} is out of the battle, so there are no more questions for you. Keep watching to see who wins!</p>
    </section>`;
  } else if (!question) {
    body = `<div class="waiting"><img class="waiting__pulse" src="/brand/mark-128.png" alt="" /><p>Loading your next question…</p></div>`;
  } else {
    const locked = Boolean(penalty && Date.now() < penalty.until);
    // A negative delay keeps the bar in the right place if the screen redraws.
    const penaltyBar = locked
      ? `<div class="penalty" role="alert">
          <strong>${penalty.wrong} WRONG IN A ROW</strong>
          <span>Take a breath. You can answer in a moment.</span>
          <div class="penalty__track"><div class="penalty__fill" style="animation-duration:${penalty.ms}ms;animation-delay:-${Math.max(0, penalty.ms - (penalty.until - Date.now()))}ms"></div></div>
        </div>`
      : '';
    body = `
      ${penaltyBar}
      <div class="q-meta">${(round.cycle || 1) > 1 ? `Round ${round.cycle} · ` : ''}Question ${question.number} · ${escapeHtml(question.category)}</div>
      <h1 class="q-text">${escapeHtml(question.prompt)}</h1>
      <p class="key-hint">Click an answer, or press <b>1</b> <b>2</b> <b>3</b> or <b>A</b> <b>B</b> <b>C</b>.</p>
      <div class="answers ${locked ? 'is-locked' : ''}">
        ${question.options
          .map(
            (option, index) => `
          <button class="answer" type="button" data-answer="${index}" ${answering || locked ? 'disabled' : ''}>
            <span class="answer__key">${LETTERS[index]}</span>
            <span class="answer__text">${escapeHtml(option)}</span>
          </button>`,
          )
          .join('')}
      </div>`;
  }

  shell(
    `
    ${topBar(round.quizEndsAt, me.missiles, me, round.quizOpensAt)}
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
      <img class="waiting__pulse" src="/brand/mark-128.png" alt="" />
      <p>A captain is chosen at random when the battle starts, and fires the missiles.<br />The battle starts when the facilitator is ready.</p>
    </div>`,
    { side: color },
  );
}

function swapNote(round) {
  if (!round.captainSwapAt) return '';
  return `<p class="swap-note">Controls swap to a random teammate in <b data-countdown="${escapeHtml(round.captainSwapAt)}" data-opens="${escapeHtml(round.battleOpensAt || '')}">${formatCountdown(round.captainSwapAt, round.battleOpensAt)}</b></p>`;
}

function passControlsMarkup() {
  const mates = (myTeam()?.players || []).filter((player) => player.id !== playerState.me.id);
  if (mates.length === 0) return '';
  if (!passOpen) {
    return '<button class="btn btn--ghost btn--wide pass-btn" type="button" data-action="pass-open">PASS CONTROLS TO A TEAMMATE</button>';
  }
  return `
    <div class="pass-list">
      <div class="field__label">Who takes the controls?</div>
      ${mates
        .map(
          (player) =>
            `<button class="btn btn--ghost btn--wide" type="button" data-pass="${escapeHtml(player.id)}" ${player.connected ? '' : 'disabled'}>${escapeHtml(player.name)}${player.connected ? '' : ' (offline)'}</button>`,
        )
        .join('')}
      <button class="btn btn--small btn--ghost" type="button" data-action="pass-cancel">CANCEL</button>
    </div>`;
}

/** The fleets this player's side can attack, and the one currently on screen. */
function targetChoices() {
  const me = playerState.round.me;
  const boards = me.targetBoards?.length ? me.targetBoards : me.targetBoard ? [me.targetBoard] : [];
  const live = boards.filter((entry) => entry.shipsSunk < entry.shipsTotal);
  const chosen =
    boards.find((entry) => entry.id === me.targetId && live.includes(entry)) || live[0] || boards[0] || null;
  return { boards, board: chosen };
}

/**
 * Three-team games: the captain does not choose who to attack. Everyone else on
 * the side votes, and the captain fires at whichever fleet has the most votes.
 */
function voteMarkup(me, boards, board) {
  if (boards.length < 2) return '';
  const live = boards.filter((entry) => entry.shipsSunk < entry.shipsTotal);
  if (live.length < 2) return '';
  const votes = me.targetVotes || {};
  if (!me.canVote) {
    const tally = live.map((entry) => `${escapeHtml(entry.name)} ${votes[entry.id] || 0}`).join(' · ');
    return `
    <div class="vote-note">
      <strong>YOUR TEAM IS TARGETING <span style="color:${escapeHtml(board?.color || '#fff')}">${escapeHtml(board?.name || '')}</span></strong>
      <small>Teammates vote for the target · ${tally}</small>
    </div>`;
  }
  return `
    <div class="vote-box">
      <div class="field__label">VOTE: WHO DOES YOUR TEAM ATTACK?</div>
      <div class="target-tabs" role="group" aria-label="Vote for a fleet">
        ${live
          .map(
            (entry) => `
          <button class="target-tab ${entry.id === me.myVote ? 'is-active' : ''} ${entry.id === board?.id ? 'is-leading' : ''}" type="button" style="--side:${escapeHtml(entry.color)}" data-vote="${escapeHtml(entry.id)}" ${voting ? 'disabled' : ''}>
            <strong>${escapeHtml(entry.name)}</strong>
            <small>${votes[entry.id] || 0} vote${(votes[entry.id] || 0) === 1 ? '' : 's'}${entry.id === me.myVote ? ' · YOURS' : ''}</small>
          </button>`,
          )
          .join('')}
      </div>
      <p class="vote-hint">${board ? `Leading: <b>${escapeHtml(board.name)}</b>. ` : ''}The captain fires at the fleet with the most votes.</p>
    </div>`;
}

/** Shown on every phone while a video plays on the big screen: who the captain is. */
function renderCaptainCard({ heading, until }) {
  const me = playerState.round.me;
  const { boards, board } = targetChoices();
  const vote = me.isCaptain ? '' : voteMarkup(me, boards, board);
  const color = playerState.me.teamColor || '#19e3ff';
  const who = me.isCaptain
    ? '<div class="captain-card__you">YOU ARE THE CAPTAIN</div>'
    : `<div class="captain-card__label">YOUR CAPTAIN</div><div class="captain-card__name">${escapeHtml(me.captainName || '...')}</div>`;
  shell(
    `
    <section class="captain-card hud" style="--bracket:${escapeHtml(color)}">
      <div class="captain-card__heading">${escapeHtml(heading)}</div>
      ${who}
      ${until ? `<p class="captain-card__note">${escapeHtml(me.isCaptain ? 'Get ready to fire.' : vote ? 'Vote now, then watch the big screen.' : 'Watch the big screen.')} <b data-countdown="${escapeHtml(until)}">${formatCountdown(until)}</b></p>` : ''}
    </section>
    ${vote}`,
    { side: color },
  );
}

/** True while a video is playing on the big screen and the board should stay hidden. */
function sceneUntil() {
  const round = playerState?.round;
  if (!round) return null;
  const phase = playerState.session.phase;
  const key = phase === PHASES.BATTLE ? round.battleOpensAt : phase === PHASES.RESUPPLY || phase === PHASES.RESULT ? round.sceneEndsAt : null;
  if (!key) return null;
  return Date.parse(key) > serverNow() ? key : null;
}

function renderBattle() {
  const round = playerState.round;
  const me = round.me;
  const color = playerState.me.teamColor || '#19e3ff';
  const { boards, board } = targetChoices();
  const targetColor = board?.color || '#ff3d9a';

  if (!board) {
    renderMessage('STAND BY', 'No target has been assigned to you.');
    return;
  }

  const pre = sceneUntil();
  if (pre) {
    window.setTimeout(() => render(true), Date.parse(pre) - serverNow() + 80);
    renderCaptainCard({ heading: 'BATTLE STARTING', until: pre });
    return;
  }

  const captain = me.isCaptain;
  const out = Boolean(me.eliminated);
  const opensIn = round.battleOpensAt ? Date.parse(round.battleOpensAt) - serverNow() : 0;
  const notOpen = opensIn > 0;
  if (notOpen) window.setTimeout(() => render(true), opensIn + 80);
  const canFire = captain && !notOpen && me.missiles > 0 && !out && board.shipsSunk < board.shipsTotal;
  let message = '';
  if (notOpen) {
    message = `<div class="shot-msg">GET READY. Firing opens in <b data-countdown="${escapeHtml(round.battleOpensAt)}">${formatCountdown(round.battleOpensAt)}</b></div>`;
  } else if (out) {
    message = '<div class="shot-msg shot-msg--out">Your fleet has been sunk. You are out of the battle. Keep watching!</div>';
  } else if (shotMsg) {
    message = `<div class="shot-msg shot-msg--${shotMsg.kind}">${escapeHtml(shotMsg.text)}</div>`;
  } else if (canFire) {
    message = `<div class="shot-msg">${boards.length > 1 ? `Firing at ${escapeHtml(board.name)}, chosen by your team. Tap a square.` : 'Tap a square to fire.'}</div>`;
  }
  if (me.missiles === 0 && !out) {
    message = `<div class="shot-msg shot-msg--out">Out of missiles. Another round of questions is coming so you can earn more.</div>`;
  }
  const role = captain
    ? `<div class="captain-tag">YOU ARE THE CAPTAIN · TAP TO FIRE</div>${swapNote(round)}${passControlsMarkup()}`
    : `<div class="captain-tag captain-tag--watch">${escapeHtml(me.captainName || 'Your captain')} is captain · you are watching</div>${swapNote(round)}`;
  const shotColors = Object.fromEntries(round.combatants.map((entry) => [entry.id, entry.color]));
  const handover = me.becomingCaptain
    ? `<div class="handover handover--in" role="alert">GET READY: YOU BECOME CAPTAIN IN <b data-countdown="${escapeHtml(round.captainSwapAt || '')}">${formatCountdown(round.captainSwapAt)}</b></div>`
    : me.isCaptain && me.nextCaptainName
      ? `<div class="handover handover--out" role="alert">${escapeHtml(me.nextCaptainName)} TAKES THE CONTROLS IN <b data-countdown="${escapeHtml(round.captainSwapAt || '')}">${formatCountdown(round.captainSwapAt)}</b></div>`
      : '';

  shell(
    `
    ${topBar(round.battleEndsAt, me.missiles, me, round.battleOpensAt)}
    ${handover}
    ${role}
    ${voteMarkup(me, boards, board)}
    <div class="target" style="--side:${targetColor}">
      <span class="target__label">${boards.length > 1 ? (captain ? 'FIRE AT' : 'WATCHING') : 'FIRE AT'}</span>
      <span class="target__name">${escapeHtml(boards.length > 1 ? board.name : me.targetName || board.name)}</span>
    </div>
    <div class="fire-grid ${captain ? '' : 'fire-grid--watch'}">
      ${renderGrid({ size: board.gridSize, shots: board.shots, interactive: captain, disabled: !canFire || firing, axes: false, label: 'Target grid', color: targetColor, shotColor: color, shotColors, sunkCells: board.sunkCells })}
    </div>
    ${message}
    <p class="p-foot">Ships sunk <b>${board.shipsSunk} / ${board.shipsTotal}</b> · ${escapeHtml(playerState.me.teamName || '')}</p>`,
    { side: color, compact: true },
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
  shell(
    `
    <section class="p-card panel hud" style="--bracket:var(--amber)">
      <h1 class="p-title" style="color:var(--amber)">${title}</h1>
      <p class="p-copy">${lead} The facilitator will start another round of questions so you can earn more.</p>
      <div class="stat-grid">
        <div class="stat-box stat-box--missiles"><strong>${me.missiles}</strong><span>MISSILES LEFT</span></div>
        <div class="stat-box"><strong>${board ? `${board.shipsSunk}/${board.shipsTotal}` : '-'}</strong><span>SHIPS SUNK</span></div>
      </div>
    </section>
    <div class="waiting">
      <img class="waiting__pulse" src="/brand/mark-128.png" alt="" />
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
      <img class="waiting__pulse" src="/brand/mark-128.png" alt="" />
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
      joinStep,
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
        me?.eliminated,
        Boolean(feedback && Date.now() < feedback.until),
        feedback?.number,
        penalty?.until,
        answering,
      ]);
    case PHASES.REVIEW:
      return JSON.stringify([phase, me?.isCaptain, me?.captainName, me?.missiles, me?.correct, round?.teams]);
    case PHASES.BATTLE:
      return JSON.stringify([
        phase,
        me?.isCaptain,
        me?.captainName,
        me?.missiles,
        me?.targetBoard?.shots?.length,
        me?.targetBoard?.shipsSunk,
        me?.targetBoards?.map((entry) => [entry.id, entry.shots.length, entry.shipsSunk]),
        me?.targetId,
        me?.myVote,
        me?.canVote,
        me?.targetVotes,
        voting,
        me?.eliminated,
        me?.ammoProgress,
        shotMsg?.id,
        firing,
        passOpen,
        round?.captainSwapAt,
        round?.battleOpensAt,
        me?.becomingCaptain,
        me?.nextCaptainName,
        JSON.stringify(me?.isCaptain ? myTeam()?.players?.map((player) => [player.id, player.connected]) : null),
        round?.scores?.map((score) => score.points),
      ]);
    case PHASES.RESUPPLY:
      return JSON.stringify([
        phase,
        round?.battleEndReason,
        round?.sceneEndsAt,
        me?.captainName,
        me?.missiles,
        me?.targetBoard?.shipsSunk,
        round?.scores?.map((score) => score.points),
      ]);
    case PHASES.RESULT:
      return JSON.stringify([phase, round?.outcome, round?.sceneEndsAt, me?.captainName, round?.scores?.map((score) => score.points)]);
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

  const scene = sceneUntil();
  if (scene && (playerState.session.phase === PHASES.RESUPPLY || playerState.session.phase === PHASES.RESULT)) {
    window.setTimeout(() => render(true), Date.parse(scene) - serverNow() + 80);
    renderCaptainCard({ heading: playerState.session.phase === PHASES.RESULT ? 'GAME OVER' : 'REGROUP', until: scene });
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
    const before = playerState;
    watchShots(before, next);
    playerState = next;
    maybeDrawCaptain(before, next);
    announceMoments(before, next);
    announceControlChange(before, next);
    setBattleSoundsEnabled(next.session?.config?.soundEnabled !== false);
    if ([PHASES.REVIEW, PHASES.BATTLE, PHASES.RESUPPLY].includes(next.session.phase)) {
      preloadBattleSounds();
    }
    if (previous && previous !== next.session.phase) {
      feedback = null;
      penalty = null;
      shotMsg = null;
      passOpen = false;
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
  socket.on(EVENTS.PLAYER_REMOVED, (info) => {
    clearToken();
    if (info?.reason === 'reset') {
      startOver('The facilitator reset the players. Enter your name to join again.');
      return;
    }
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
      await startOver('Enter your name to join.');
    } else {
      toast(error.message, 'error', '#toast-root');
    }
  } finally {
    resuming = false;
  }
}

/** Forget this player and go back to the name screen of the same game. */
async function startOver(message) {
  joined = false;
  playerState = null;
  joinDraft = { name: '', teamId: null };
  joinStep = 'name';
  joinError = message;
  clearTimeout(feedbackTimer);
  clearTimeout(penaltyTimer);
  feedback = null;
  penalty = null;
  shotMsg = null;
  cancelGetReady();
  await refreshSession();
  render(true);
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
    joined = true;
    sfx.join();
  } catch (error) {
    joinError = error.message;
    if (error.code === 'NAME_TAKEN' || error.code === 'INVALID_NAME') joinStep = 'name';
    sfx.error();
    await refreshSession();
  } finally {
    joining = false;
    render(true);
  }
}

// ----------------------------------------------------------------- actions

function startPenalty(ms, wrong) {
  penalty = { ms, wrong, until: Date.now() + ms };
  clearTimeout(penaltyTimer);
  penaltyTimer = setTimeout(() => {
    penalty = null;
    render(true);
  }, ms);
}

async function submitAnswer(optionIndex) {
  const question = playerState?.round?.me?.question;
  if (!question || answering || getReadyBlocking() || (penalty && Date.now() < penalty.until)) return;
  answering = true;
  for (const node of app.querySelectorAll('[data-answer]')) node.disabled = true;
  const snapshot = { prompt: question.prompt, options: [...question.options], number: question.number };
  sfx.click();
  try {
    const result = await request(socket, EVENTS.PLAYER_ANSWER, {
      questionNumber: question.number,
      optionIndex,
    });
    const feedbackMs = !result.correct
      ? TIMING.feedbackMs
      : result.bonus > 0
        ? TIMING.bonusFeedbackMs
        : TIMING.correctFeedbackMs;
    feedback = {
      ...snapshot,
      correct: result.correct,
      correctText: snapshot.options[result.correctIndex] ?? '',
      correctKey: LETTERS[result.correctIndex] ?? '',
      reward: result.reward,
      perMissile: result.perMissile || 1,
      progress: result.progress || 0,
      bonus: result.bonus || 0,
      streak: result.streak || 0,
      penaltyMs: result.penaltyMs || 0,
      wrongStreak: result.wrongStreak || 0,
      until: Date.now() + feedbackMs,
    };
    if (result.correct) sfx.success();
    else sfx.error();
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      const held = feedback;
      feedback = null;
      if (held?.penaltyMs) startPenalty(held.penaltyMs, held.wrongStreak);
      render(true);
    }, feedbackMs);
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
    sfx.error();
  } finally {
    answering = false;
    render(true);
  }
}

/** Briefly flash the whole screen, and pop up a banner when a ship goes down. */
function flashHit({ hit, sunk, shipName }, elapsed = 0) {
  if (!hit && !sunk) return;
  window.setTimeout(
    () => {
      const flash = document.createElement('div');
      flash.className = `hit-flash ${sunk ? 'hit-flash--sunk' : ''}`;
      flash.setAttribute('aria-hidden', 'true');
      document.body.append(flash);
      window.setTimeout(() => flash.remove(), sunk ? 900 : 450);
      if (sunk) {
        const popup = document.createElement('div');
        popup.className = 'sunk-popup';
        popup.setAttribute('role', 'alert');
        popup.innerHTML = `<span>SHIP SUNK!</span><strong>You sank the ${escapeHtml(shipName || 'ship')}!</strong>`;
        document.body.append(popup);
        window.setTimeout(() => popup.remove(), 2600);
      }
    },
    Math.max(0, (RESULT_DELAY - elapsed) * 1000),
  );
}

// The question round the countdown has already been shown for.
let readyShownFor = null;

/** The countdown into questions and the last boat warning. */
function announceMoments(before, after) {
  const phase = after?.session?.phase;
  const sound = after?.session?.config?.soundEnabled !== false;

  const opensAt = phase === PHASES.QUIZ ? after.round?.quizOpensAt : null;
  if (opensAt && opensAt !== readyShownFor) {
    readyShownFor = opensAt;
    runGetReady({ opensIn: Date.parse(opensAt) - serverNow(), sound });
  } else if (phase !== PHASES.QUIZ) {
    cancelGetReady();
  }

  if (phase !== PHASES.BATTLE) return;
  const myTeamId = after.me?.teamId;
  for (const board of newLastBoats(before, after)) {
    const mine = board.id === myTeamId;
    // After the "ship sunk" pop-up has had a moment.
    window.setTimeout(() => {
      if (playerState?.session?.phase !== PHASES.BATTLE) return;
      showLastBoat({
        detail: mine ? 'Your fleet has one ship left!' : `${board.name} has one ship left`,
        color: board.color,
        sound,
      });
    }, 3000);
  }
}

/** Pop-ups when the attack controls arrive or leave, e.g. the captain swap. */
function announceControlChange(before, after) {
  const was = before?.round?.me?.isCaptain;
  const now = after?.round?.me?.isCaptain;
  const phase = after?.session?.phase;
  if (was === undefined || now === undefined || was === now) return;
  if (before.session.phase !== phase || before.round?.number !== after.round?.number) return;
  if (phase !== PHASES.BATTLE && phase !== PHASES.RESUPPLY) return;
  const popup = document.createElement('div');
  popup.className = `control-popup ${now ? 'control-popup--gain' : 'control-popup--lose'}`;
  popup.setAttribute('role', 'alert');
  popup.innerHTML = now
    ? '<span>YOU ARE NOW THE CAPTAIN</span><strong>You have the controls. Fire!</strong>'
    : `<span>CONTROLS PASSED</span><strong>${escapeHtml(after.round.me.captainName || 'A teammate')} is now the captain.</strong>`;
  document.body.append(popup);
  window.setTimeout(() => popup.remove(), 3600);
  const flash = document.createElement('div');
  flash.className = `hit-flash control-flash control-flash--pulse ${now ? 'control-flash--gain' : 'control-flash--lose'}`;
  flash.setAttribute('aria-hidden', 'true');
  document.body.append(flash);
  window.setTimeout(() => flash.remove(), 1500);
  if (now) sfx.alert();
}

/** The draw reveal when a battle starts: who is captain, before the board appears. */
function maybeDrawCaptain(before, after) {
  if (!before || !after?.round || !after.me) return;
  if (!(before.session.phase === PHASES.REVIEW && after.session.phase === PHASES.BATTLE)) return;
  const introAt = Date.parse(after.round.battleIntroAt || '');
  const drawMs = Number.isFinite(introAt) ? introAt - serverNow() : 0;
  if (drawMs <= 1000) return;
  const team = after.teams?.find((entry) => entry.id === after.me.teamId);
  if (!team) return;
  runCaptainDraw(
    [
      {
        name: team.name,
        color: team.color,
        players: team.players.map((player) => player.name),
        captain: team.players.find((player) => player.captain)?.name || '',
      },
    ],
    { compact: true, duration: drawMs, sound: after.session?.config?.soundEnabled !== false },
  );
}

async function castVote(targetId) {
  if (voting) return;
  voting = true;
  sfx.click();
  try {
    await request(socket, EVENTS.PLAYER_VOTE_TARGET, { targetId });
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
    sfx.error();
  } finally {
    voting = false;
    render(true);
  }
}

async function passControls(playerId) {
  try {
    await request(socket, EVENTS.PLAYER_PASS_CAPTAIN, { playerId });
    sfx.success();
  } catch (error) {
    toast(error.message, 'error', '#toast-root');
    sfx.error();
  } finally {
    passOpen = false;
    render(true);
  }
}

async function fire(x, y) {
  if (firing) return;
  firing = true;
  const cells = app.querySelectorAll('[data-fire-x]');
  for (const node of cells) node.disabled = true;
  // Start the launch sound straight away, inside the tap, so phones allow it.
  playBattle('fire');
  const firedAt = performance.now();
  try {
    const result = await request(socket, EVENTS.PLAYER_ATTACK, { x, y });
    const elapsed = (performance.now() - firedAt) / 1000;
    playShotResult(result, { delay: RESULT_DELAY - elapsed });
    const where = coordLabel(x, y);
    flashHit(result, elapsed);
    if (result.sunk) {
      shotMsg = { id: Date.now(), kind: 'sunk', text: `${where}: HIT! You sank the ${result.shipName}!` };
    } else if (result.hit) {
      shotMsg = { id: Date.now(), kind: 'hit', text: `${where}: DIRECT HIT!` };
    } else {
      shotMsg = { id: Date.now(), kind: 'miss', text: `${where}: miss` };
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

  const vote = event.target.closest('[data-vote]');
  if (vote) {
    castVote(vote.dataset.vote);
    return;
  }

  const pass = event.target.closest('[data-pass]');
  if (pass) {
    passControls(pass.dataset.pass);
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
  } else if (action === 'pass-open' || action === 'pass-cancel') {
    passOpen = action === 'pass-open';
    render(true);
  } else if (action === 'change-name') {
    joinStep = 'name';
    joinError = '';
    render(true);
  } else if (action === 'reload') {
    window.location.reload();
  } else if (action === 'home') {
    window.location.href = '/';
  }
});

// Laptops and Chromebooks: F switches full screen on and off.
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (event.key.toLowerCase() !== 'f') return;
  // Not while typing: names can have an F in them. Team radio buttons are fine.
  const focused = document.activeElement;
  if (focused?.tagName === 'TEXTAREA' || (focused?.tagName === 'INPUT' && focused.type !== 'radio')) return;
  event.preventDefault();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

// Laptops and Chromebooks: answer with 1, 2, 3 or A, B, C.
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (!joined || playerState?.session?.phase !== PHASES.QUIZ || answering) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const question = playerState?.round?.me?.question;
  if (!question || getReadyBlocking() || (feedback && Date.now() < feedback.until) || (penalty && Date.now() < penalty.until)) return;
  const key = event.key.toLowerCase();
  const index = '123'.includes(key) && key ? Number(key) - 1 : 'abc'.indexOf(key);
  if (key.length !== 1 || index < 0 || index >= question.options.length) return;
  event.preventDefault();
  unlockAudio();
  submitAnswer(index);
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target.closest('form');
  if (!form) return;

  if (form.id === 'gate-form') {
    const next = normaliseCode(new FormData(form).get('code') || '');
    if (next.length !== 3) {
      gateError = 'Enter the three-digit code.';
      renderGate();
      return;
    }
    code = next;
    gateError = '';
    window.history.replaceState({}, '', `/play?code=${encodeURIComponent(code)}`);
    boot();
    return;
  }

  if (form.id === 'name-form') {
    joinDraft.name = String(new FormData(form).get('name') || '').trim();
    if (joinDraft.name.length < 2) {
      joinError = 'Type a name with at least two letters.';
      render(true);
      return;
    }
    joinError = '';
    if ((sessionInfo?.teams?.length || 0) > 1) {
      joinStep = 'team';
      render(true);
      return;
    }
    joinDraft.teamId = null;
    join();
    return;
  }

  if (form.id === 'join-form') {
    const teamId = new FormData(form).get('team');
    joinDraft.teamId = teamId ? String(teamId) : null;
    if (!joinDraft.teamId) {
      joinError = 'Pick a team to join.';
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
    const value = formatCountdown(node.dataset.countdown, node.dataset.opens || null);
    if (node.textContent !== value) node.textContent = value;
    const [minutes, seconds] = value.split(':').map(Number);
    node.classList.toggle('is-low', minutes === 0 && seconds <= 10 && node.dataset.countdown !== '');
  }
  beepCountdown();
}

/** One beep per second for the last ten seconds of the question round. */
function beepCountdown() {
  if (playerState?.session?.phase !== PHASES.QUIZ || playerState.session.config?.soundEnabled === false) {
    lastBeep = null;
    return;
  }
  const endsAt = playerState.round?.quizEndsAt;
  if (!endsAt) return;
  const left = Math.ceil(msRemaining(endsAt) / 1000);
  if (left < 1 || left > BEEP_SECONDS) return;
  if (lastBeep === left) return;
  lastBeep = left;
  sfx.tick();
}

setInterval(updateCountdowns, 250);

// Keep the join screen's side counts fresh while a player is choosing.
setInterval(async () => {
  if (!code || joined || joining || closedMessage || !sessionInfo || document.hidden) return;
  const input = document.activeElement;
  if (input && input.tagName === 'INPUT' && input.type !== 'radio') return;
  await refreshSession();
  render();
}, 5000);

boot();
