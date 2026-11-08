import '../../styles/tokens.css';
import '../../styles/play.css';

import { MODES, PHASES, modeLabel } from '@shared/constants.js';
import { EVENTS } from '@shared/events.js';
import { normaliseCode } from '@shared/util.js';
import { api } from '../shared/api.js';
import { isMuted, muteLabel, sfx, toggleMute, unlockAudio } from '../shared/audio.js';
import { syncClock } from '../shared/clock.js';
import { $, escapeHtml, initials, on, toast } from '../shared/dom.js';
import { createSocket, request } from '../shared/socket.js';

const app = $('#app');
const params = new URLSearchParams(window.location.search);
let code = normaliseCode(params.get('code') || '');
let sessionInfo = null;
let playerState = null;
let socket = null;
let connected = false;
let joined = false;
let myName = '';
let myRole = '';
let joining = false;
let resuming = false;
let view = 'loading';
let joinError = '';
let closedMessage = '';
let joinDraft = {
  name: localStorage.getItem('cb.play.name') || '',
  teamId: null,
  asSpectator: false,
};

function tokenKey() {
  return `cb.player.${code}`;
}

function readSavedToken() {
  try {
    const raw = localStorage.getItem(tokenKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.token) return parsed;
  } catch {
    // Ignore corrupt local storage.
  }
  return null;
}

function saveToken(token, playerId, name) {
  try {
    localStorage.setItem(tokenKey(), JSON.stringify({ token, playerId, name }));
  } catch {
    // Private browsing can disable storage; the live session still works.
  }
}

function clearToken() {
  try {
    localStorage.removeItem(tokenKey());
  } catch {
    // Ignore.
  }
}

function currentSession() {
  return playerState?.session || sessionInfo?.session || null;
}

function currentTeams() {
  return playerState?.teams || sessionInfo?.teams || [];
}

function myTeam() {
  const me = playerState?.me;
  if (!me?.teamId) return null;
  return currentTeams().find((team) => team.id === me.teamId) || null;
}

function topbar() {
  const session = currentSession();
  return `
    <header class="play-top">
      <div class="play-brand">
        <div class="play-brand__mark">CB</div>
        <div class="play-brand__text">
          <div class="play-brand__name">CYBER BATTLESHIPS</div>
          <div class="play-brand__sub">Player console</div>
        </div>
      </div>
      <div class="play-top__spacer"></div>
      <span class="play-status ${connected ? '' : 'play-status--off'}" id="play-conn">
        <span class="status-dot"></span><span>${connected ? 'LINKED' : 'RECONNECTING'}</span>
      </span>
      <button class="icon-btn" type="button" data-action="sound" title="Toggle audio" style="width:32px;height:32px;font-size:0.55rem">${isMuted() ? 'OFF' : 'SND'}</button>
    </header>
    ${
      session
        ? `<div class="play-code"><span>Operation ${escapeHtml(session.name)}</span><strong>${escapeHtml(session.joinCode)}</strong></div>`
        : ''
    }
  `;
}

function shell(main, { footer = true } = {}) {
  app.innerHTML = `
    <div class="play-shell">
      ${topbar()}
      <main class="play-main">${main}</main>
      ${footer ? `<footer class="play-footer">CB // PLAYER TERMINAL // ${escapeHtml(code || 'STANDBY')}</footer>` : ''}
    </div>
  `;
}

function renderCodeGate(message = '') {
  view = 'gate';
  app.innerHTML = `
    <div class="play-shell">
      ${topbar()}
      <main class="play-main">
        <section class="play-card panel">
          <p class="play-card__eyebrow">// ENLISTMENT TERMINAL //</p>
          <h1 class="play-title">ENTER JOIN CODE</h1>
          <p class="play-copy">Type the six-character code shown on the projector, or scan the QR code again.</p>
          <form id="gate-form" class="stack">
            <input class="input input--code" name="code" value="${escapeHtml(code)}" maxlength="6" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123" />
            <button class="btn btn--primary btn--wide" type="submit">CONTINUE</button>
            ${message ? `<p class="form-error">${escapeHtml(message)}</p>` : ''}
          </form>
        </section>
        <footer class="play-footer">CB // PLAYER TERMINAL // STANDBY</footer>
      </main>
    </div>
  `;
  setTimeout(() => $('#gate-form input')?.focus(), 50);
}

function renderLoading(message = 'Synchronising player link…') {
  view = 'loading';
  shell(`
    <div class="boot-screen" style="min-height:60vh">
      <div class="boot-screen__logo">${escapeHtml(code || 'CYBER BATTLESHIPS')}</div>
      <div class="boot-screen__bar"><span></span></div>
      <p>${escapeHtml(message)}</p>
    </div>
  `);
}

function renderUnavailable(message, title = 'LINK UNAVAILABLE') {
  view = 'unavailable';
  shell(`
    <section class="play-card panel">
      <p class="play-card__eyebrow">// OPERATION CONTROL //</p>
      <h1 class="play-title">${escapeHtml(title)}</h1>
      <p class="play-copy">${escapeHtml(message)}</p>
      <button class="btn btn--ghost" type="button" data-action="reload">TRY AGAIN</button>
    </section>
  `);
}

function renderJoin() {
  view = 'join';
  const session = sessionInfo?.session;
  if (!session) {
    renderCodeGate();
    return;
  }
  if (session.phase !== PHASES.LOBBY) {
    renderUnavailable('This operation has already started. Ask the facilitator for a new session.', 'OPERATION IN PROGRESS');
    return;
  }
  if (session.config.lobbyLocked) {
    renderUnavailable('The facilitator has locked this lobby. New enlistment is closed.', 'LOBBY LOCKED');
    return;
  }
  const teams = sessionInfo.teams || [];
  const isIndividual = session.mode === MODES.INDIVIDUAL;
  const selectedTeam =
    joinDraft.teamId ||
    teams.find((team) => team.playerCount < team.maxPlayers)?.id ||
    teams[0]?.id ||
    '';
  const teamCards = teams
    .map((team) => {
      const full = team.playerCount >= team.maxPlayers;
      const percent = Math.min(100, Math.round((team.playerCount / Math.max(1, team.maxPlayers)) * 100));
      return `
        <label class="pick-card ${full ? 'pick-card--full' : ''}" style="--team:${team.color}">
          <input type="radio" name="team" value="${team.id}" ${team.id === selectedTeam && !full ? 'checked' : ''} ${full ? 'disabled' : ''} />
          <span class="pick-card__name">${escapeHtml(team.name)}</span>
          <span class="pick-card__meta">${team.playerCount}/${team.maxPlayers} OPERATIVES</span>
          <span class="pick-card__bar"><span style="width:${percent}%"></span></span>
        </label>`;
    })
    .join('');

  shell(`
    <section class="play-card panel">
      <p class="play-card__eyebrow">// ${escapeHtml(session.name)} //</p>
      <h1 class="play-title">ENLIST IN<br />OPERATION</h1>
      <p class="play-copy">${escapeHtml(modeLabel(session.mode))} // ${session.config.ageGroup.toUpperCase()} // ${session.config.difficulty.toUpperCase()}</p>
      <form id="join-form" class="stack" novalidate>
        <label class="field">
          <span class="field__label">Display name</span>
          <input class="input" name="name" value="${escapeHtml(joinDraft.name)}" maxlength="20" autocomplete="nickname" placeholder="Your callsign" required />
        </label>
        ${
          !isIndividual
            ? `<div class="field">
                 <span class="field__label">Choose your team</span>
                 <div class="pick-grid">${teamCards || '<p class="form-hint">No teams are available.</p>'}</div>
               </div>`
            : '<p class="form-hint">Free-for-all: every operative competes independently.</p>'
        }
        ${
          session.config.allowSpectators
            ? `<label class="play-toggle">
                 <span class="play-toggle__text"><strong>Join as spectator</strong><span>Watch the operation without answering or firing.</span></span>
                 <span class="switch"><input type="checkbox" name="spectator" ${joinDraft.asSpectator ? 'checked' : ''} /></span>
               </label>`
            : ''
        }
        ${joinError ? `<p class="form-error">${escapeHtml(joinError)}</p>` : ''}
        <button class="btn btn--primary btn--wide" type="submit" ${joining ? 'disabled' : ''}>${joining ? 'ENLISTING…' : 'CONFIRM ENLISTMENT'}</button>
      </form>
    </section>
    <section class="play-card panel">
      <p class="play-card__eyebrow">// OPERATION BRIEF //</p>
      <p class="play-copy">One device per player. Questions will arrive on this screen once the facilitator starts the question phase. Keep this page open.</p>
      <div class="play-code"><span>Join code</span><strong>${escapeHtml(session.joinCode)}</strong></div>
    </section>
  `);
}

function renderLobby() {
  view = 'lobby';
  const session = currentSession();
  const me = playerState?.me;
  const team = myTeam();
  const teams = currentTeams();
  const spectator = me?.role === 'spectator';
  const isIndividual = session.mode === MODES.INDIVIDUAL;
  const roster = spectator
    ? []
    : team?.players || (isIndividual ? playerState?.players || [] : []);
  const canSwitch = !spectator && !isIndividual && session.phase === PHASES.LOBBY && !session.config.lobbyLocked && teams.length > 1;
  const teamOptions = canSwitch
    ? teams
        .filter((entry) => entry.id !== me?.teamId)
        .map((entry) => `<option value="${entry.id}">${escapeHtml(entry.name)} (${entry.playerCount}/${entry.maxPlayers})</option>`)
        .join('')
    : '';

  shell(`
    <section class="play-card panel">
      <div class="row row--between">
        <p class="play-card__eyebrow">// ${escapeHtml(session.name)} //</p>
        <span class="badge ${session.config.lobbyLocked ? 'badge--locked' : 'badge--live'}">${session.config.lobbyLocked ? 'LOCKED' : 'LOBBY OPEN'}</span>
      </div>
      ${
        spectator
          ? `<div class="play-team-banner" style="--team:var(--violet)">
               <div><div class="play-team-banner__label">Access level</div><div class="play-team-banner__name">SPECTATOR</div></div>
               <div class="play-team-banner__count"><strong>RO</strong><span>Read only</span></div>
             </div>`
          : `<div class="play-team-banner" style="--team:${team?.color || 'var(--cyan)'}">
               <div>
                 <div class="play-team-banner__label">Your team</div>
                 <div class="play-team-banner__name">${escapeHtml(team?.name || 'UNASSIGNED')}</div>
               </div>
               <div class="play-team-banner__count">
                 <strong>${team?.playerCount || 0}/${team?.maxPlayers || 0}</strong>
                 <span>Operatives</span>
               </div>
             </div>`
      }
      <div class="play-me" style="--team:${team?.color || 'var(--cyan)'}">
        <span class="play-avatar">${initials(me?.name || myName || '?')}</span>
        <div class="play-me__text">
          <strong>${escapeHtml(me?.name || myName || 'Operative')}</strong>
          <span>${spectator ? 'SPECTATOR // NO COMBAT ACCESS' : `${escapeHtml(team?.name || 'UNASSIGNED')} // ${me?.connected ? 'CONNECTED' : 'OFFLINE'}`}</span>
        </div>
      </div>
    </section>

    ${
      spectator
        ? `<section class="play-card panel">
             <p class="play-card__eyebrow">// LIVE TEAM FEED //</p>
             <h2 class="play-title" style="font-size:0.85rem">SPECTATOR MODE</h2>
             <div class="play-roster">
               ${teams
                 .map(
                   (entry) => `
                   <div class="play-roster__row">
                     <span class="play-roster__dot"></span>
                     <span>${escapeHtml(entry.name)}</span>
                     <span>${entry.playerCount}/${entry.maxPlayers} OPERATIVES</span>
                   </div>`,
                 )
                 .join('') || '<div class="play-roster__row"><span class="muted">No teams configured</span></div>'}
             </div>
             <p class="play-copy">You can watch the roster and live counts. Answering, earning ammunition and firing are disabled for spectators.</p>
           </section>`
        : `<section class="play-card panel">
             <div class="row row--between">
               <p class="play-card__eyebrow">// TEAM ROSTER //</p>
               <span class="badge">${roster.length} OPERATIVE${roster.length === 1 ? '' : 'S'}</span>
             </div>
             <div class="play-roster">
               ${
                 roster
                   .map(
                     (player) => `
                     <div class="play-roster__row ${player.id === me?.id ? 'is-me' : ''}">
                       <span class="play-roster__dot ${player.connected ? '' : 'play-roster__dot--off'}"></span>
                       <span>${escapeHtml(player.name)}${player.id === me?.id ? ' // YOU' : ''}</span>
                       <span>${player.connected ? 'ONLINE' : 'OFFLINE'}</span>
                     </div>`,
                   )
                   .join('') || '<div class="play-roster__row"><span class="muted">Awaiting operatives</span></div>'
               }
             </div>
           </section>`
    }

    ${
      canSwitch
        ? `<section class="play-card panel">
             <p class="play-card__eyebrow">// TEAM CHANGE //</p>
             <div class="play-switch-team">
               <label class="field">
                 <span class="field__label">Move to</span>
                 <select class="select" id="switch-team">${teamOptions || '<option value="">No other team</option>'}</select>
               </label>
               <button class="btn btn--ghost" type="button" data-action="switch-team">SWITCH</button>
             </div>
           </section>`
        : ''
    }

    <div class="play-waiting">
      <div class="play-waiting__pulse">CB</div>
      <p>${session.config.lobbyLocked ? 'LOBBY LOCKED<br />AWAITING FACILITATOR START' : 'AWAITING COMMAND<br />THE FACILITATOR WILL START THE OPERATION'}</p>
    </div>
  `);
}

function renderMission() {
  view = 'mission';
  const session = currentSession();
  const me = playerState?.me;
  const team = myTeam();
  shell(`
    <section class="play-mission">
      <div class="play-mission__inner">
        <p class="play-mission__eyebrow">// ALL HANDS //</p>
        <h1>MISSION<br />READY</h1>
        <p>${escapeHtml(session.name)}<br />${team ? `${escapeHtml(team.name)} // ` : ''}${escapeHtml(me?.name || myName || 'Operative')}</p>
        <div class="play-team-banner" style="--team:${team?.color || 'var(--green)'};width:100%;max-width:420px">
          <div>
            <div class="play-team-banner__label">${me?.role === 'spectator' ? 'Access level' : 'Your team'}</div>
            <div class="play-team-banner__name">${escapeHtml(me?.role === 'spectator' ? 'SPECTATOR' : team?.name || 'UNASSIGNED')}</div>
          </div>
          <div class="play-team-banner__count"><strong>${team?.playerCount || 0}</strong><span>Operatives</span></div>
        </div>
        <p class="tiny muted">Stand by for the next phase. Keep this page open.</p>
      </div>
    </section>
  `);
}

function render() {
  if (closedMessage) {
    renderUnavailable(closedMessage, 'LINK CLOSED');
    return;
  }
  if (view === 'gate' && !sessionInfo) {
    renderCodeGate();
    return;
  }
  if (!sessionInfo) {
    renderCodeGate();
    return;
  }
  if (joined && playerState) {
    if (playerState.session.phase === PHASES.MISSION_READY) renderMission();
    else renderLobby();
    return;
  }
  if (joined && !playerState) {
    renderLoading('Loading player state…');
    return;
  }
  renderJoin();
}

function updateConnection() {
  const node = $('#play-conn');
  if (!node) return;
  node.classList.toggle('play-status--off', !connected);
  node.innerHTML = `<span class="status-dot"></span><span>${connected ? 'LINKED' : 'RECONNECTING'}</span>`;
}

function ensureSocket() {
  if (socket) {
    if (!socket.connected) socket.connect();
    return;
  }
  socket = createSocket();
  socket.on('connect', () => {
    connected = true;
    updateConnection();
    const saved = readSavedToken();
    if (saved?.token && !joining) resume();
  });
  socket.on('disconnect', () => {
    connected = false;
    updateConnection();
  });
  socket.on(EVENTS.STATE, (next) => {
    if (!next?.session || next.session.joinCode !== code) return;
    playerState = next;
    sessionInfo = { ...(sessionInfo || {}), session: next.session, teams: next.teams, players: next.players, counts: next.counts, join: next.join };
    syncClock(next.meta?.serverNow);
    if (next.me) {
      joined = true;
      myName = next.me.name;
      myRole = next.me.role;
    }
    if (view !== 'join' || joined) render();
  });
  socket.on(EVENTS.TOAST, (payload) => {
    if (payload.level === 'join' || payload.level === 'alert') {
      toast(payload.message, payload.level, '#toast-root');
      if (payload.level === 'alert') sfx.alert();
    }
  });
  socket.on(EVENTS.GAME_ERROR, (payload) => {
    toast(payload.message || 'Command rejected.', 'error', '#toast-root');
    sfx.error();
  });
  socket.on(EVENTS.PLAYER_REMOVED, () => {
    clearToken();
    joined = false;
    playerState = null;
    myName = '';
    closedMessage = 'You have been removed from this operation by the facilitator.';
    renderUnavailable(closedMessage, 'SESSION ENDED');
  });
  socket.on(EVENTS.PLAYER_SUPERSEDED, () => {
    clearToken();
    joined = false;
    playerState = null;
    closedMessage = 'This player session was opened on another device. Use that device to continue.';
    renderUnavailable(closedMessage, 'DEVICE SUPERSEDED');
  });
  socket.on(EVENTS.SESSION_CLOSED, () => {
    clearToken();
    joined = false;
    playerState = null;
    closedMessage = 'The facilitator has closed this operation.';
    renderUnavailable(closedMessage, 'OPERATION CLOSED');
  });
  socket.connect();
}

async function resume() {
  const saved = readSavedToken();
  if (!saved?.token || resuming) return;
  resuming = true;
  if (!playerState) renderLoading('Restoring player session…');
  try {
    const result = await request(socket, EVENTS.PLAYER_RESUME, { code, token: saved.token });
    joined = true;
    myName = result.name || saved.name || '';
    myRole = result.role || '';
    view = playerState ? 'lobby' : 'loading';
    if (!playerState) renderLoading('Loading player state…');
  } catch (error) {
    if (error.code === 'RESUME_FAILED' || error.code === 'SESSION_NOT_FOUND') {
      clearToken();
      joined = false;
      playerState = null;
      joinError = 'That saved session is no longer valid. Enlist again.';
      renderJoin();
    } else {
      toast(error.message, 'error', '#toast-root');
    }
  } finally {
    resuming = false;
  }
}

async function waitForConnection() {
  if (socket?.connected) return;
  if (!socket) ensureSocket();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not reach the game server.')), 12_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(new Error(error?.message || 'Could not reach the game server.'));
    });
    socket.connect();
  });
}

async function join() {
  joining = true;
  joinError = '';
  renderJoin();
  try {
    await waitForConnection();
    const result = await request(socket, EVENTS.PLAYER_JOIN, {
      code,
      name: joinDraft.name,
      teamId: joinDraft.asSpectator ? null : joinDraft.teamId,
      asSpectator: joinDraft.asSpectator,
    });
    saveToken(result.token, result.playerId, joinDraft.name);
    joined = true;
    myName = joinDraft.name;
    myRole = joinDraft.asSpectator ? 'spectator' : 'player';
    localStorage.setItem('cb.play.name', joinDraft.name);
    sfx.join();
    joining = false;
    if (playerState) render();
    else renderLoading('Enlisting operative…');
    return;
  } catch (error) {
    joinError = error.message;
    joining = false;
    renderJoin();
    sfx.error();
    return;
  }
}

function updateSound(button) {
  if (button) button.textContent = isMuted() ? 'OFF' : 'SND';
}

on(app, 'click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  unlockAudio();
  sfx.click();
  if (button.dataset.action === 'sound') {
    toggleMute();
    updateSound(button);
  }
  if (button.dataset.action === 'reload') {
    window.location.reload();
  }
  if (button.dataset.action === 'switch-team') {
    const select = $('#switch-team');
    const teamId = select?.value;
    if (!teamId) return;
    button.disabled = true;
    request(socket, EVENTS.PLAYER_CHOOSE_TEAM, { teamId })
      .then(() => toast('Team changed.', 'info', '#toast-root'))
      .catch((error) => {
        toast(error.message, 'error', '#toast-root');
        sfx.error();
      })
      .finally(() => {
        button.disabled = false;
      });
  }
});

app.addEventListener('submit', async (event) => {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();

  if (form.id === 'gate-form') {
    const next = normaliseCode(new FormData(form).get('code') || '');
    if (next.length !== 6) {
      renderCodeGate('Enter the six-character join code.');
      return;
    }
    code = next;
    window.history.replaceState({}, '', `/play?code=${encodeURIComponent(code)}`);
    await boot();
    return;
  }

  if (form.id === 'join-form') {
    const data = new FormData(form);
    joinDraft = {
      name: String(data.get('name') || '').trim(),
      teamId: data.get('team') ? String(data.get('team')) : joinDraft.teamId,
      asSpectator: data.get('spectator') === 'on',
    };
    if (joinDraft.name.length < 2) {
      joinError = 'Use at least two characters for your display name.';
      renderJoin();
      return;
    }
    if (!joinDraft.asSpectator && sessionInfo?.session.mode !== MODES.INDIVIDUAL && !joinDraft.teamId) {
      joinError = 'Choose a team before enlisting.';
      renderJoin();
      return;
    }
    if (joinDraft.asSpectator) joinDraft.teamId = null;
    await join();
  }
});

async function boot() {
  if (!code) {
    renderCodeGate();
    return;
  }
  view = 'loading';
  renderLoading('Locating operation…');
  try {
    const summary = await api(`/api/sessions/${encodeURIComponent(code)}`);
    sessionInfo = summary;
    const saved = readSavedToken();
    ensureSocket();
    if (saved?.token) {
      renderLoading('Restoring player session…');
      if (socket.connected) await resume();
      return;
    }
    renderJoin();
  } catch (error) {
    sessionInfo = null;
    renderCodeGate(error.message || 'That join code is not valid.');
  }
}

renderLoading();
boot();
