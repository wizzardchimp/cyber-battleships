import '../../styles/tokens.css';
import '../../styles/host.css';

import {
  AGE_GROUPS,
  DEFAULT_CONFIG,
  DEFAULT_TEAM_NAMES,
  DIFFICULTIES,
  LIMITS,
  MODES,
  PHASES,
  TEAM_COLORS,
  modeLabel,
  phaseLabel,
} from '@shared/constants.js';
import { EVENTS } from '@shared/events.js';
import { api, ApiError } from '../shared/api.js';
import { isMuted, muteLabel, sfx, toggleMute, unlockAudio } from '../shared/audio.js';
import { syncClock } from '../shared/clock.js';
import { $, escapeHtml, initials, on, toast } from '../shared/dom.js';
import { createSocket, request } from '../shared/socket.js';

const app = $('#app');
const params = new URLSearchParams(window.location.search);

let socket = null;
let connected = false;
let hostState = null;
let sessions = [];
let currentSessionId = params.get('session');
let view = 'loading';
let subscribing = false;
let setupDraft = {
  ...DEFAULT_CONFIG,
  teamNames: [...DEFAULT_CONFIG.teamNames],
  mode: MODES.TEAM,
  teamCount: 2,
};
let activeSummary = null;

const COLORS = TEAM_COLORS;
const modeOptions = [
  { value: MODES.TEAM, label: 'Team vs Team' },
  { value: MODES.INDIVIDUAL, label: 'Free-for-all' },
  { value: MODES.COOPERATIVE, label: 'Co-op vs CPU' },
];

function activeCode() {
  return hostState?.session?.joinCode || activeSummary?.joinCode || '';
}

function displayUrl() {
  const code = activeCode();
  if (!code) return '#';
  const base = hostState?.join?.url || activeSummary?.joinUrl || location.origin;
  try {
    return new URL(`/display?code=${encodeURIComponent(code)}`, base).href;
  } catch {
    return `${location.origin}/display?code=${encodeURIComponent(code)}`;
  }
}

function joinUrl() {
  const code = activeCode();
  if (!code) return '';
  const base = hostState?.join?.url || activeSummary?.joinUrl || location.origin;
  try {
    return new URL(`/${encodeURIComponent(code)}`, base).href;
  } catch {
    return `${location.origin}/${encodeURIComponent(code)}`;
  }
}

function renderTopbar() {
  const session = hostState?.session;
  const code = activeCode();
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand__mark">CB</div>
        <div class="brand__text">
          <span class="brand__name">CYBER BATTLESHIPS</span>
          <span class="brand__sub">Facilitator command</span>
        </div>
      </div>
      <div class="topbar__spacer"></div>
      <div class="topbar__meta">
        <span class="conn ${connected ? '' : 'conn--off'}" id="conn-status">
          <span class="status-dot"></span><span>${connected ? 'LINK ACTIVE' : 'RECONNECTING'}</span>
        </span>
        ${
          code
            ? `<span class="session-pill"><span>OP</span><strong>${escapeHtml(code)}</strong></span>`
            : session
              ? '<span class="session-pill"><span>NO SESSION</span></span>'
              : ''
        }
      </div>
      <div class="topbar__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-action="sound">${muteLabel()}</button>
        <button class="btn btn--ghost btn--sm" type="button" data-action="logout">LOGOUT</button>
      </div>
    </header>
  `;
}

function shell(main) {
  app.innerHTML = `<div class="host-shell">${renderTopbar()}<main class="host-main">${main}</main></div>`;
}

function renderLogin() {
  view = 'login';
  hostState = null;
  shell(`
    <section class="login-screen">
      <div class="login-card panel">
        <div class="login-card__icon">PIN</div>
        <div>
          <h1 class="login-card__title">FACILITATOR<br />AUTHORISATION</h1>
          <p class="login-card__copy">Enter the administrator PIN printed in the server console.</p>
        </div>
        <form id="login-form" class="stack" novalidate>
          <label class="field">
            <span class="field__label">Access PIN</span>
            <input id="login-pin" class="input input--code" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="••••••" required autofocus />
          </label>
          <button class="btn btn--primary btn--wide" type="submit">UNLOCK CONSOLE</button>
          <p id="login-error" class="form-error" role="alert"></p>
        </form>
        <p class="form-hint">This console controls live operations. Keep the PIN private.</p>
      </div>
    </section>
  `);
  setTimeout(() => $('#login-pin')?.focus(), 30);
}

function renderDashboard() {
  view = 'dashboard';
  hostState = null;
  const totalPlayers = sessions.reduce((sum, session) => sum + (session.playerCount || 0), 0);
  const totalConnected = sessions.reduce((sum, session) => sum + (session.connectedCount || 0), 0);
  const active = sessions.filter((session) => session.phase !== PHASES.ENDED);

  const cards = active.length
    ? active
        .map(
          (session) => `
          <article class="session-card" style="--team:${COLORS[(session.teamCount || 1) % COLORS.length]}">
            <div class="session-card__head">
              <div>
                <div class="session-card__name">${escapeHtml(session.name)}</div>
                <div class="tiny muted">${modeLabel(session.mode)}</div>
              </div>
              <div class="session-card__code">${escapeHtml(session.joinCode)}</div>
            </div>
            <div class="session-card__stats">
              <span><strong>${session.playerCount}</strong>players</span>
              <span><strong>${session.connectedCount}</strong>online</span>
              <span><strong>${session.teamCount || 1}</strong>${session.teamCount === 1 ? 'team' : 'teams'}</span>
              <span class="badge ${session.phase === PHASES.MISSION_READY ? 'badge--locked' : 'badge--live'}">${phaseLabel(session.phase)}</span>
            </div>
            <div class="session-card__actions">
              <button class="btn btn--primary btn--sm" type="button" data-action="open-session" data-id="${session.id}">OPEN LOBBY</button>
              <button class="btn btn--ghost btn--sm" type="button" data-action="open-display" data-code="${session.joinCode}">DISPLAY</button>
              <button class="btn btn--danger btn--sm" type="button" data-action="delete-session" data-id="${session.id}" data-name="${escapeHtml(session.name)}">DELETE</button>
            </div>
          </article>`,
        )
        .join('')
    : `<div class="empty-state">
         <div style="font-family:var(--font-pixel);font-size:0.7rem;color:var(--cyan)">NO ACTIVE OPERATIONS</div>
         <p>Create an operation to generate a join code and QR entry point for players.</p>
       </div>`;

  shell(`
    <section class="dashboard-hero">
      <div class="dashboard-intro panel">
        <p class="eyebrow"><span class="status-dot"></span> Command console online</p>
        <h1>RUN A LIVE<br /><em>CYBER DEFENCE</em> DRILL</h1>
        <p>Configure teams, project the joining code and watch every participant synchronise in real time. Stage 1 covers the live lobby and mission-ready transition.</p>
        <div class="view-actions">
          <button class="btn btn--primary" type="button" data-action="new-session">NEW OPERATION</button>
          <button class="btn btn--ghost" type="button" data-action="refresh-sessions">REFRESH</button>
        </div>
      </div>
      <div class="dashboard-stats">
        <div class="dashboard-stat"><strong>${active.length}</strong><span>Active operations</span></div>
        <div class="dashboard-stat"><strong>${totalPlayers}</strong><span>Enlisted players</span></div>
        <div class="dashboard-stat"><strong>${totalConnected}</strong><span>Devices online</span></div>
        <div class="dashboard-stat"><strong>${sessions.reduce((sum, session) => sum + (session.teamCount || 0), 0)}</strong><span>Teams configured</span></div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Operation archive</h2>
      <div class="session-grid">${cards}</div>
    </section>
  `);
}

function teamNameInputs() {
  const count = setupDraft.mode === MODES.INDIVIDUAL ? 0 : setupDraft.mode === MODES.COOPERATIVE ? 1 : setupDraft.teamCount;
  const names = setupDraft.teamNames || [];
  return Array.from({ length: count }, (_, index) => {
    const value = names[index] || DEFAULT_TEAM_NAMES[index] || `TEAM ${index + 1}`;
    return `
      <div class="team-name-row">
        <span class="team-swatch" style="--swatch:${COLORS[index % COLORS.length]}"></span>
        <input class="input" name="teamName" value="${escapeHtml(value)}" maxlength="${LIMITS.maxTeamNameLength}" aria-label="Team ${index + 1} name" />
      </div>`;
  }).join('');
}

function renderSetup() {
  view = 'setup';
  const mode = setupDraft.mode;
  const showTeams = mode !== MODES.INDIVIDUAL;
  const teamCountOptions =
    mode === MODES.TEAM
      ? Array.from({ length: LIMITS.maxTeams - 1 }, (_, index) => index + 2)
          .map(
            (count) =>
              `<option value="${count}" ${Number(setupDraft.teamCount) === count ? 'selected' : ''}>${count} teams</option>`,
          )
          .join('')
      : mode === MODES.COOPERATIVE
        ? '<option value="1" selected>1 human team</option>'
        : '<option value="0" selected>Individual competitors</option>';

  shell(`
    <div class="view-head">
      <div class="view-head__title">
        <p class="eyebrow"><span class="status-dot"></span> Operation setup</p>
        <h1 class="view-title">CONFIGURE NEW OPERATION</h1>
        <p class="view-sub">These settings become the authoritative rules for every connected device. Structure can be changed while the lobby is empty.</p>
      </div>
      <div class="view-actions">
        <button class="btn btn--ghost" type="button" data-action="back-dashboard">CANCEL</button>
      </div>
    </div>

    <div class="setup-grid">
      <form id="setup-form" class="setup-panel panel" novalidate>
        <h2 class="panel__title" style="margin-bottom:1.2rem">01 // OPERATION IDENTITY</h2>
        <div class="form-grid">
          <label class="field span-2">
            <span class="field__label">Operation name</span>
            <input class="input" name="name" value="${escapeHtml(setupDraft.name)}" maxlength="${LIMITS.maxSessionNameLength}" required />
          </label>
          <label class="field">
            <span class="field__label">Game mode</span>
            <select class="select" name="mode" id="setup-mode">
              ${modeOptions.map((option) => `<option value="${option.value}" ${mode === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span class="field__label">Teams</span>
            <select class="select" name="teamCount" id="setup-team-count" ${mode === MODES.INDIVIDUAL ? 'disabled' : ''}>
              ${teamCountOptions}
            </select>
          </label>
          <label class="field">
            <span class="field__label">Players per team</span>
            <input class="input" name="maxPlayersPerTeam" type="number" min="1" max="${LIMITS.maxPlayersPerTeam}" value="${setupDraft.maxPlayersPerTeam}" />
          </label>
          <label class="field">
            <span class="field__label">Total player limit</span>
            <input class="input" name="maxPlayersTotal" type="number" min="1" max="${LIMITS.maxPlayersTotal}" value="${setupDraft.maxPlayersTotal}" />
          </label>
        </div>

        ${
          showTeams
            ? `<div class="section" style="margin-top:1.4rem">
                 <h3 class="label" style="margin-bottom:0.6rem">Team callsigns</h3>
                 <div class="team-name-list" id="team-name-list">${teamNameInputs()}</div>
               </div>`
            : ''
        }

        <div class="section" style="margin-top:1.6rem">
          <h2 class="panel__title" style="margin-bottom:0.9rem">02 // ROUND PROTOCOL</h2>
          <div class="form-grid form-grid--three">
            <label class="field">
              <span class="field__label">Answer timer (s)</span>
              <input class="input" name="questionTimer" type="number" min="${LIMITS.minQuestionTimer}" max="${LIMITS.maxQuestionTimer}" value="${setupDraft.questionTimer}" />
            </label>
            <label class="field">
              <span class="field__label">Quiz round (min)</span>
              <input class="input" name="roundMinutes" type="number" min="${LIMITS.minRoundMinutes}" max="${LIMITS.maxRoundMinutes}" value="${setupDraft.roundMinutes}" />
            </label>
            <label class="field">
              <span class="field__label">Tactical phase (s)</span>
              <input class="input" name="tacticalSeconds" type="number" min="0" max="${LIMITS.maxTacticalSeconds}" value="${setupDraft.tacticalSeconds}" />
            </label>
            <label class="field">
              <span class="field__label">Grid size</span>
              <select class="select" name="gridSize">
                ${[8, 9, 10, 11, 12].map((size) => `<option value="${size}" ${Number(setupDraft.gridSize) === size ? 'selected' : ''}>${size} × ${size}</option>`).join('')}
              </select>
            </label>
            <label class="field">
              <span class="field__label">Simultaneous attacks</span>
              <input class="input" name="maxAttacksPerTeam" type="number" min="1" max="${LIMITS.maxAttacksPerTeam}" value="${setupDraft.maxAttacksPerTeam}" />
            </label>
            <label class="field">
              <span class="field__label">Age category</span>
              <select class="select" name="ageGroup">
                ${AGE_GROUPS.map((entry) => `<option value="${entry.value}" ${setupDraft.ageGroup === entry.value ? 'selected' : ''}>${entry.label}</option>`).join('')}
              </select>
            </label>
            <label class="field">
              <span class="field__label">Difficulty</span>
              <select class="select" name="difficulty">
                ${DIFFICULTIES.map((entry) => `<option value="${entry.value}" ${setupDraft.difficulty === entry.value ? 'selected' : ''}>${entry.label}</option>`).join('')}
              </select>
            </label>
          </div>
        </div>

        <div class="section" style="margin-top:1.6rem">
          <h2 class="panel__title" style="margin-bottom:0.4rem">03 // RULES OF ENGAGEMENT</h2>
          <div class="toggle-row">
            <div class="toggle-row__text"><strong>Allow spectators</strong><span>Read-only devices can watch the operation.</span></div>
            <label class="switch"><input type="checkbox" name="allowSpectators" ${setupDraft.allowSpectators ? 'checked' : ''} /></label>
          </div>
          <div class="toggle-row">
            <div class="toggle-row__text"><strong>Allow late joining</strong><span>Players may join after the operation starts.</span></div>
            <label class="switch"><input type="checkbox" name="allowLateJoin" ${setupDraft.allowLateJoin ? 'checked' : ''} /></label>
          </div>
          <div class="toggle-row">
            <div class="toggle-row__text"><strong>Carry ammunition between rounds</strong><span>Unused missiles remain in the team arsenal.</span></div>
            <label class="switch"><input type="checkbox" name="ammoCarryOver" ${setupDraft.ammoCarryOver ? 'checked' : ''} /></label>
          </div>
          <div class="toggle-row">
            <div class="toggle-row__text"><strong>Special weapons</strong><span>Enable advanced weapons when the battle engine arrives.</span></div>
            <label class="switch"><input type="checkbox" name="specialWeapons" ${setupDraft.specialWeapons ? 'checked' : ''} /></label>
          </div>
          <div class="toggle-row">
            <div class="toggle-row__text"><strong>Audio cues</strong><span>Allow the console and display to play arcade sound effects.</span></div>
            <label class="switch"><input type="checkbox" name="soundEnabled" ${setupDraft.soundEnabled ? 'checked' : ''} /></label>
          </div>
        </div>

        <div class="section" style="margin-top:1.6rem; display:flex; justify-content:flex-end; gap:0.6rem">
          <button class="btn btn--primary" type="submit">CREATE OPERATION</button>
        </div>
      </form>

      <aside class="setup-aside">
        <div class="panel">
          <div class="panel__head"><h2 class="panel__title">Briefing summary</h2></div>
          <div class="briefing-list">
            <div><span>Mode</span><span>${escapeHtml(modeLabel(setupDraft.mode))}</span></div>
            <div><span>Teams</span><span>${setupDraft.mode === MODES.INDIVIDUAL ? 'Individual' : setupDraft.mode === MODES.COOPERATIVE ? '1 human crew' : setupDraft.teamCount}</span></div>
            <div><span>Answer timer</span><span>${setupDraft.questionTimer} seconds</span></div>
            <div><span>Quiz round</span><span>${setupDraft.roundMinutes} minutes</span></div>
            <div><span>Grid</span><span>${setupDraft.gridSize} × ${setupDraft.gridSize}</span></div>
            <div><span>Max in flight</span><span>${setupDraft.maxAttacksPerTeam} per team</span></div>
            <div><span>Age band</span><span>${escapeHtml(AGE_GROUPS.find((entry) => entry.value === setupDraft.ageGroup)?.label || setupDraft.ageGroup)}</span></div>
            <div><span>Difficulty</span><span>${escapeHtml(setupDraft.difficulty)}</span></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel__head"><h2 class="panel__title">Stage 1 scope</h2></div>
          <div class="briefing-list">
            <div><span>Lobby &amp; teams</span><span>ONLINE</span></div>
            <div><span>QR + join code</span><span>ONLINE</span></div>
            <div><span>Reconnection</span><span>ONLINE</span></div>
            <div><span>Questions</span><span>STAGE 2</span></div>
            <div><span>Battle grid</span><span>STAGE 3</span></div>
            <div><span>Missiles</span><span>STAGE 4</span></div>
          </div>
        </div>
      </aside>
    </div>
  `);
}

function renderLoading() {
  view = 'loading';
  shell(`
    <div class="boot-screen" style="min-height:60vh">
      <div class="boot-screen__logo">${activeCode() ? `OPERATION ${escapeHtml(activeCode())}` : 'CYBER BATTLESHIPS'}</div>
      <div class="boot-screen__bar"><span></span></div>
      <p>Synchronising command link…</p>
    </div>
  `);
}

function teamCard(team, state) {
  const roster = team.players || [];
  const players = state.players || [];
  const rows = roster.length
    ? roster
        .map((player) => {
          const full = players.find((entry) => entry.id === player.id);
          const moveOptions = state.teams
            .filter((candidate) => candidate.id !== team.id)
            .map((candidate) => `<option value="${candidate.id}">${escapeHtml(candidate.name)}</option>`)
            .join('');
          return `
            <div class="roster-row">
              <span class="roster-row__avatar">${initials(player.name)}</span>
              <span class="roster-row__name">${escapeHtml(player.name)}</span>
              <span class="roster-row__dot ${player.connected ? '' : 'roster-row__dot--off'}" title="${player.connected ? 'Connected' : 'Offline'}"></span>
              ${
                moveOptions
                  ? `<select class="select tiny" data-move-player="${player.id}" title="Move to another team" style="width:88px;min-height:26px;padding:0.15rem 1.3rem 0.15rem 0.3rem;font-size:0.62rem">
                       <option value="">MOVE</option>${moveOptions}
                     </select>`
                  : ''
              }
              <span class="roster-row__actions">
                <button class="icon-btn" style="width:26px;height:26px;font-size:0.6rem" type="button" data-action="remove-player" data-player-id="${player.id}" data-name="${escapeHtml(player.name)}" title="Remove ${escapeHtml(player.name)}">×</button>
              </span>
            </div>`;
        })
        .join('')
    : `<div class="roster-empty">Awaiting operatives</div>`;

  return `
    <article class="team-card" style="--team:${team.color}">
      <div class="team-card__head">
        <div>
          <div class="team-card__name">${escapeHtml(team.name)}</div>
          <div class="team-card__sub">${team.connectedCount} connected // ${team.playerCount} enlisted</div>
        </div>
        <div class="row" style="gap:0.4rem">
          <span class="team-card__count">${team.playerCount}<small>/${team.maxPlayers}</small></span>
          <button class="icon-btn" style="width:26px;height:26px;font-size:0.62rem" type="button" data-action="rename-team" data-team-id="${team.id}" data-name="${escapeHtml(team.name)}" title="Rename team">✎</button>
        </div>
      </div>
      <div class="roster">${rows}</div>
      <div class="team-card__footer">
        <span>${team.playerCount > 0 ? '<span class="ready">READY</span>' : '<span class="waiting">WAITING</span>'}</span>
        <span>${team.playerCount > 0 ? 'TEAM LOCKED IN' : 'NO OPERATIVES'}</span>
      </div>
    </article>
  `;
}

function renderLobby() {
  view = 'lobby';
  const state = hostState;
  const session = state.session;
  const isIndividual = session.mode === MODES.INDIVIDUAL;
  const teamsHtml = isIndividual
    ? renderIndividualRoster(state)
    : `<div class="team-grid">${state.teams.map((team) => teamCard(team, state)).join('')}</div>`;
  const spectators = (state.players || []).filter((player) => player.role === 'spectator');
  const canStart = state.admin?.canStart;
  const reason = state.admin?.startReason;
  const join = joinUrl();
  const qrUrl = state.join?.qrUrl || `/api/sessions/${encodeURIComponent(session.joinCode)}/qr.svg`;

  shell(`
    <div class="view-head">
      <div class="view-head__title">
        <p class="eyebrow"><span class="status-dot ${session.config.lobbyLocked ? '' : ''}"></span> ${phaseLabel(session.phase)} // ${escapeHtml(modeLabel(session.mode))}</p>
        <h1 class="view-title">${escapeHtml(session.name)}</h1>
        <p class="view-sub">${session.config.lobbyLocked ? 'Lobby locked. Existing players can reconnect, but new enlistment is closed.' : 'Lobby open. Project the display and invite players to scan the QR code.'}</p>
      </div>
      <div class="view-actions">
        <button class="btn btn--ghost" type="button" data-action="back-dashboard">OPERATIONS</button>
        <button class="btn btn--ghost" type="button" data-action="open-display">OPEN DISPLAY</button>
        <button class="btn ${session.config.lobbyLocked ? 'btn--danger' : 'btn--ghost'}" type="button" data-action="lock-lobby" data-locked="${session.config.lobbyLocked ? 'false' : 'true'}">
          ${session.config.lobbyLocked ? 'UNLOCK LOBBY' : 'LOCK LOBBY'}
        </button>
      </div>
    </div>

    <div class="lobby-grid">
      <div class="teams-column">
        ${
          session.config.lobbyLocked
            ? `<div class="lock-banner"><span class="status-dot status-dot--amber"></span> LOBBY LOCKED // NEW PLAYERS CANNOT JOIN</div>`
            : ''
        }
        ${teamsHtml}
        <div class="panel">
          <div class="panel__head">
            <h2 class="panel__title">Live roster</h2>
            <span class="badge">${state.counts.players} PLAYERS // ${state.counts.spectators} SPECTATORS</span>
          </div>
          <div style="padding:0.8rem 1rem;display:flex;gap:0.5rem;flex-wrap:wrap">
            ${(state.players || [])
              .map(
                (player) =>
                  `<span class="badge ${player.connected ? 'badge--live' : 'badge--danger'}"><span class="status-dot ${player.connected ? '' : 'status-dot--red'}"></span>${escapeHtml(player.name)}</span>`,
              )
              .join('') || '<span class="muted tiny">No players connected yet.</span>'}
          </div>
          ${
            spectators.length
              ? `<div style="padding:0 1rem 1rem"><div class="label" style="margin-bottom:0.4rem">Spectators</div><div style="display:flex;gap:0.4rem;flex-wrap:wrap">${spectators
                  .map(
                    (player) =>
                      `<span class="badge">${escapeHtml(player.name)} <button class="icon-btn" style="width:20px;height:20px;font-size:0.55rem" type="button" data-action="remove-player" data-player-id="${player.id}" data-name="${escapeHtml(player.name)}">×</button></span>`,
                  )
                  .join('')}</div></div>`
              : ''
          }
        </div>
      </div>

      <aside class="lobby-aside">
        <div class="qr-panel panel">
          <p class="qr-panel__label">Scan to enlist</p>
          <div class="qr-box"><img src="${qrUrl}" alt="QR code to join operation ${escapeHtml(session.joinCode)}" /></div>
          <div class="join-url">${escapeHtml(join)}</div>
          <div>
            <p class="qr-panel__label">Join code</p>
            <div class="join-code">${escapeHtml(session.joinCode)}</div>
          </div>
          <button class="btn btn--ghost btn--sm btn--wide" type="button" data-action="copy-join">COPY JOIN LINK</button>
        </div>

        <div class="control-panel panel">
          <h2 class="panel__title">Operation control</h2>
          <div class="control-stat"><span>Players</span><strong>${state.counts.players}</strong></div>
          <div class="control-stat"><span>Devices online</span><strong>${state.counts.connected}</strong></div>
          <div class="control-stat"><span>Teams ready</span><strong>${state.teams.filter((team) => team.playerCount > 0).length}/${state.teams.length || 1}</strong></div>
          <div class="control-stat"><span>Lobby</span><strong class="${session.config.lobbyLocked ? 'warn' : 'ok'}">${session.config.lobbyLocked ? 'LOCKED' : 'OPEN'}</strong></div>
          ${
            reason
              ? `<div class="tiny" style="color:var(--amber);line-height:1.5">${escapeHtml(reason)}</div>`
              : ''
          }
          <button class="btn btn--green" type="button" data-action="start-game" ${canStart ? '' : 'disabled'}>START OPERATION</button>
          <button class="btn btn--ghost" type="button" data-action="open-display">PROJECT DISPLAY</button>
        </div>
      </aside>
    </div>
  `);
}

function renderIndividualRoster(state) {
  return `
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">Free-for-all operatives</h2>
        <span class="badge">${state.counts.players} ENLISTED</span>
      </div>
      <div class="roster" style="margin:0.8rem">
        ${
          (state.players || [])
            .map(
              (player) => `
                <div class="roster-row">
                  <span class="roster-row__avatar">${initials(player.name)}</span>
                  <span class="roster-row__name">${escapeHtml(player.name)}</span>
                  <span class="roster-row__dot ${player.connected ? '' : 'roster-row__dot--off'}"></span>
                  <button class="icon-btn" style="width:26px;height:26px;font-size:0.6rem" type="button" data-action="remove-player" data-player-id="${player.id}" data-name="${escapeHtml(player.name)}">×</button>
                </div>`,
            )
            .join('') || '<div class="roster-empty">Awaiting operatives</div>'
        }
      </div>
    </div>
  `;
}

function renderMission() {
  view = 'mission';
  const state = hostState;
  const session = state.session;
  shell(`
    <section class="mission-view">
      <div class="mission-card panel">
        <p class="mission-card__eyebrow">// ALL HANDS //</p>
        <h1>MISSION<br />READY</h1>
        <p><strong>${escapeHtml(session.name)}</strong> is locked in with ${state.counts.players} operatives across ${state.teams.length || 1} ${state.teams.length === 1 ? 'team' : 'teams'}. The lobby is sealed.</p>
        <div class="mission-lineup">
          ${state.teams
            .map(
              (team) => `
              <div class="mission-team" style="--team:${team.color}">
                <strong>${escapeHtml(team.name)}</strong>
                ${team.players.map((player) => `<span>${escapeHtml(player.name)}</span>`).join('') || '<span class="muted">No operatives</span>'}
              </div>`,
            )
            .join('')}
        </div>
        <p class="tiny muted">The question and battle phases arrive in Stage 2. Use the controls below to return to the lobby for roster changes.</p>
        <div class="mission-actions">
          <button class="btn btn--ghost" type="button" data-action="open-display">OPEN DISPLAY</button>
          <button class="btn btn--ghost" type="button" data-action="return-lobby">RETURN TO LOBBY</button>
          <button class="btn btn--ghost" type="button" data-action="back-dashboard">OPERATIONS</button>
        </div>
      </div>
    </section>
  `);
}

function render() {
  if (view === 'login') return;
  if (view === 'setup') return renderSetup();
  if (view === 'loading') return renderLoading();
  if (!hostState) return renderDashboard();
  if (hostState.session.phase === PHASES.MISSION_READY) return renderMission();
  return renderLobby();
}

function updateConnection() {
  const node = $('#conn-status');
  if (!node) return;
  node.classList.toggle('conn--off', !connected);
  node.innerHTML = `<span class="status-dot"></span><span>${connected ? 'LINK ACTIVE' : 'RECONNECTING'}</span>`;
}

async function loadSessions() {
  const result = await api('/api/host/sessions');
  sessions = result.sessions || [];
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
    if (currentSessionId) subscribe();
  });
  socket.on('disconnect', () => {
    connected = false;
    updateConnection();
  });
  socket.on(EVENTS.STATE, (state) => {
    if (!currentSessionId || state?.session?.id !== currentSessionId) return;
    hostState = state;
    activeSummary = null;
    syncClock(state.meta?.serverNow);
    if (view === 'loading') view = 'lobby';
    if (['lobby', 'mission'].includes(view)) render();
  });
  socket.on(EVENTS.TOAST, (payload) => {
    toast(payload.message, payload.level || 'info');
    if (payload.level === 'alert' || payload.level === 'join') sfx.alert();
  });
  socket.on(EVENTS.GAME_ERROR, (payload) => {
    toast(payload.message || 'Command rejected.', 'error');
    sfx.error();
  });
  socket.on(EVENTS.SESSION_CLOSED, () => {
    toast('That operation has closed.', 'error');
    currentSessionId = null;
    activeSummary = null;
    hostState = null;
    window.history.replaceState({}, '', '/host');
    loadSessions().then(renderDashboard).catch(() => renderDashboard());
  });
  socket.connect();
}

async function subscribe() {
  if (!currentSessionId || subscribing) return;
  if (!socket) ensureSocket();
  if (!socket.connected) {
    view = 'loading';
    renderLoading();
    socket.connect();
    return;
  }
  subscribing = true;
  view = 'loading';
  renderLoading();
  try {
    await request(socket, EVENTS.HOST_SUBSCRIBE, { sessionId: currentSessionId });
  } catch (error) {
    toast(error.message, 'error');
    currentSessionId = null;
    activeSummary = null;
    hostState = null;
    window.history.replaceState({}, '', '/host');
    await loadSessions().catch(() => {});
    renderDashboard();
  } finally {
    subscribing = false;
  }
}

async function openSession(id) {
  currentSessionId = id;
  activeSummary = sessions.find((session) => session.id === id) || null;
  hostState = null;
  window.history.replaceState({}, '', `/host?session=${encodeURIComponent(id)}`);
  await subscribe();
}

function readSetupForm() {
  const form = $('#setup-form');
  if (!form) return;
  const data = new FormData(form);
  const mode = String(data.get('mode') || MODES.TEAM);
  const countRaw = Number(data.get('teamCount') || 2);
  const teamNames = data.getAll('teamName').map((name) => String(name).trim()).filter(Boolean);
  setupDraft = {
    ...setupDraft,
    name: String(data.get('name') || setupDraft.name).trim(),
    mode,
    teamCount:
      mode === MODES.INDIVIDUAL ? 0 : mode === MODES.COOPERATIVE ? 1 : Math.max(2, countRaw || 2),
    teamNames:
      mode === MODES.INDIVIDUAL
        ? []
        : mode === MODES.COOPERATIVE
          ? [teamNames[0] || 'CREW']
          : teamNames,
    maxPlayersPerTeam: Number(data.get('maxPlayersPerTeam') || setupDraft.maxPlayersPerTeam),
    maxPlayersTotal: Number(data.get('maxPlayersTotal') || setupDraft.maxPlayersTotal),
    questionTimer: Number(data.get('questionTimer') || setupDraft.questionTimer),
    roundMinutes: Number(data.get('roundMinutes') || setupDraft.roundMinutes),
    tacticalSeconds: Number(data.get('tacticalSeconds') || setupDraft.tacticalSeconds),
    gridSize: Number(data.get('gridSize') || setupDraft.gridSize),
    maxAttacksPerTeam: Number(data.get('maxAttacksPerTeam') || setupDraft.maxAttacksPerTeam),
    ageGroup: String(data.get('ageGroup') || setupDraft.ageGroup),
    difficulty: String(data.get('difficulty') || setupDraft.difficulty),
    allowSpectators: data.get('allowSpectators') === 'on',
    allowLateJoin: data.get('allowLateJoin') === 'on',
    ammoCarryOver: data.get('ammoCarryOver') === 'on',
    specialWeapons: data.get('specialWeapons') === 'on',
    soundEnabled: data.get('soundEnabled') === 'on',
  };
}

function buildConfig() {
  return { ...setupDraft, fleet: 'standard', lobbyLocked: false };
}

async function createSession() {
  try {
    const response = await api('/api/host/sessions', {
      method: 'POST',
      body: buildConfig(),
    });
    const summary = response.session;
    await loadSessions().catch(() => {});
    currentSessionId = summary.id;
    activeSummary = summary;
    hostState = null;
    window.history.replaceState({}, '', `/host?session=${encodeURIComponent(summary.id)}`);
    if (!socket) ensureSocket();
    await subscribe();
    toast(`Operation ${summary.joinCode} created.`, 'join');
    sfx.success();
  } catch (error) {
    toast(error.message || 'Could not create the operation.', 'error');
    sfx.error();
  }
}

function promptModal({ title, label, value = '', confirmLabel = 'CONFIRM', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <form class="modal panel">
        <h2 class="modal__title">${escapeHtml(title)}</h2>
        <label class="field">
          <span class="field__label">${escapeHtml(label)}</span>
          <input class="input" name="value" value="${escapeHtml(value)}" maxlength="40" autocomplete="off" />
        </label>
        <div class="modal__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-modal="cancel">CANCEL</button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'} btn--sm" type="submit">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>`;
    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
    backdrop.querySelector('[data-modal="cancel"]').addEventListener('click', () => close(null));
    backdrop.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const entry = backdrop.querySelector('input').value.trim();
      if (entry) close(entry);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    const input = backdrop.querySelector('input');
    input.focus();
    input.select();
  });
}

function confirmModal({ title, message, confirmLabel = 'REMOVE', danger = true }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal panel">
        <h2 class="modal__title">${escapeHtml(title)}</h2>
        <p class="tiny muted" style="line-height:1.7">${escapeHtml(message)}</p>
        <div class="modal__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-modal="cancel">CANCEL</button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'} btn--sm" type="button" data-modal="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });
    backdrop.querySelector('[data-modal="cancel"]').addEventListener('click', () => close(false));
    backdrop.querySelector('[data-modal="confirm"]').addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    backdrop.querySelector('[data-modal="confirm"]').focus();
  });
}

async function command(event, payload = {}, successMessage = null) {
  try {
    await request(socket, event, payload);
    if (successMessage) toast(successMessage, 'info');
    return true;
  } catch (error) {
    toast(error.message, 'error');
    sfx.error();
    return false;
  }
}

on(app, 'click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  sfx.click();
  unlockAudio();

  if (action === 'sound') {
    toggleMute();
    button.textContent = muteLabel();
    return;
  }

  if (action === 'logout') {
    await api('/api/host/logout', { method: 'POST' }).catch(() => {});
    socket?.disconnect();
    window.location.href = '/host';
    return;
  }

  if (action === 'new-session') {
    setupDraft = {
      ...DEFAULT_CONFIG,
      teamNames: [...DEFAULT_CONFIG.teamNames],
      mode: MODES.TEAM,
      teamCount: 2,
    };
    currentSessionId = null;
    hostState = null;
    window.history.replaceState({}, '', '/host?setup=1');
    renderSetup();
    return;
  }

  if (action === 'refresh-sessions') {
    try {
      await loadSessions();
      renderDashboard();
      toast('Session list refreshed.', 'info');
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  if (action === 'back-dashboard') {
    currentSessionId = null;
    activeSummary = null;
    hostState = null;
    window.history.replaceState({}, '', '/host');
    await loadSessions().catch(() => {});
    renderDashboard();
    return;
  }

  if (action === 'open-session') {
    await openSession(button.dataset.id);
    return;
  }

  if (action === 'delete-session') {
    const ok = await confirmModal({
      title: 'DELETE OPERATION',
      message: `Delete "${button.dataset.name}" and disconnect every participant? This cannot be undone.`,
      confirmLabel: 'DELETE',
    });
    if (!ok) return;
    try {
      await api(`/api/host/sessions/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
      toast('Operation deleted.', 'info');
      if (currentSessionId === button.dataset.id) {
        currentSessionId = null;
        hostState = null;
        window.history.replaceState({}, '', '/host');
      }
      await loadSessions();
      renderDashboard();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  if (action === 'open-display') {
    window.open(displayUrl(), '_blank', 'noopener');
    return;
  }

  if (action === 'copy-join') {
    try {
      await navigator.clipboard.writeText(joinUrl());
      toast('Join link copied.', 'info');
    } catch {
      toast(joinUrl(), 'info');
    }
    return;
  }

  if (action === 'rename-team') {
    const name = await promptModal({
      title: 'RENAME TEAM',
      label: 'Team callsign',
      value: button.dataset.name,
      confirmLabel: 'RENAME',
    });
    if (!name) return;
    await command(
      EVENTS.HOST_RENAME_TEAM,
      { sessionId: currentSessionId, teamId: button.dataset.teamId, name },
      'Team renamed.',
    );
    return;
  }

  if (action === 'remove-player') {
    const ok = await confirmModal({
      title: 'REMOVE OPERATIVE',
      message: `Remove ${button.dataset.name} from this operation? Their session will end.`,
      confirmLabel: 'REMOVE',
    });
    if (!ok) return;
    await command(
      EVENTS.HOST_REMOVE_PLAYER,
      { sessionId: currentSessionId, playerId: button.dataset.playerId },
      `${button.dataset.name} removed.`,
    );
    return;
  }

  if (action === 'lock-lobby') {
    await command(
      EVENTS.HOST_LOCK_LOBBY,
      { sessionId: currentSessionId, locked: button.dataset.locked === 'true' },
      button.dataset.locked === 'true' ? 'Lobby locked.' : 'Lobby unlocked.',
    );
    return;
  }

  if (action === 'start-game') {
    const ok = await command(EVENTS.HOST_START, { sessionId: currentSessionId });
    if (ok) sfx.success();
    return;
  }

  if (action === 'return-lobby') {
    await command(EVENTS.HOST_RETURN_TO_LOBBY, { sessionId: currentSessionId }, 'Returned to lobby.');
  }
});

app.addEventListener('change', async (event) => {
  const move = event.target.closest('[data-move-player]');
  if (move) {
    const teamId = move.value;
    if (!teamId) return;
    move.disabled = true;
    await command(EVENTS.HOST_MOVE_PLAYER, {
      sessionId: currentSessionId,
      playerId: move.dataset.movePlayer,
      teamId,
    });
    return;
  }

  if (event.target.id === 'setup-mode' || event.target.id === 'setup-team-count') {
    readSetupForm();
    if (event.target.id === 'setup-mode') {
      if (setupDraft.mode === MODES.COOPERATIVE) {
        setupDraft.teamCount = 1;
        setupDraft.teamNames = [setupDraft.teamNames[0] || 'CREW'];
      } else if (setupDraft.mode === MODES.INDIVIDUAL) {
        setupDraft.teamCount = 0;
        setupDraft.teamNames = [];
      } else {
        setupDraft.teamCount = Math.max(2, setupDraft.teamCount);
        setupDraft.teamNames = Array.from(
          { length: setupDraft.teamCount },
          (_, index) => setupDraft.teamNames[index] || DEFAULT_TEAM_NAMES[index] || `TEAM ${index + 1}`,
        );
      }
    }
    if (event.target.id === 'setup-team-count') {
      setupDraft.teamNames = Array.from(
        { length: setupDraft.teamCount },
        (_, index) => setupDraft.teamNames[index] || DEFAULT_TEAM_NAMES[index] || `TEAM ${index + 1}`,
      );
    }
    renderSetup();
  }
});

app.addEventListener('submit', async (event) => {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();

  if (form.id === 'login-form') {
    const pin = String(new FormData(form).get('pin') || '').trim();
    const errorNode = $('#login-error');
    if (errorNode) errorNode.textContent = '';
    try {
      await api('/api/host/login', { method: 'POST', body: { pin } });
      sfx.success();
      await loadSessions();
      ensureSocket();
      if (currentSessionId) await subscribe();
      else renderDashboard();
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
      sfx.error();
    }
    return;
  }

  if (form.id === 'setup-form') {
    readSetupForm();
    const submit = form.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'CREATING…';
    }
    await createSession();
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'CREATE OPERATION';
    }
  }
});

async function boot() {
  if (params.get('setup') === '1') {
    view = 'setup';
    renderSetup();
    return;
  }
  try {
    await api('/api/host/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      renderLogin();
      return;
    }
    renderLogin();
    toast(error.message, 'error');
    return;
  }

  try {
    await loadSessions();
  } catch (error) {
    toast(error.message, 'error');
  }
  ensureSocket();

  if (currentSessionId) {
    await subscribe();
    return;
  }
  renderDashboard();
}

boot();
