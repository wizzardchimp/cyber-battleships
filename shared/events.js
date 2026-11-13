/** Canonical socket event names shared by server and clients. */
export const EVENTS = Object.freeze({
  // Player -> server
  PLAYER_JOIN: 'player:join',
  PLAYER_RESUME: 'player:resume',
  PLAYER_CHOOSE_TEAM: 'player:chooseTeam',
  PLAYER_ANSWER: 'player:answer',
  PLAYER_ATTACK: 'player:attack',
  PLAYER_PASS_CAPTAIN: 'player:passCaptain',

  // Game screen -> server
  DISPLAY_SUBSCRIBE: 'display:subscribe',
  DISPLAY_CREATE: 'display:create',
  DISPLAY_ADVANCE: 'display:advance',
  DISPLAY_RESUME: 'display:resume',
  DISPLAY_FINISH: 'display:finish',
  DISPLAY_LOBBY: 'display:lobby',
  DISPLAY_SETTINGS: 'display:settings',
  DISPLAY_REMOVE: 'display:remove',
  DISPLAY_RESET_PLAYERS: 'display:resetPlayers',

  // Shared
  TIME_SYNC: 'time:sync',

  // Server -> clients
  STATE: 'state',
  PLAYER_OK: 'player:ok',
  PLAYER_REMOVED: 'player:removed',
  PLAYER_SUPERSEDED: 'player:superseded',
  SESSION_CLOSED: 'session:closed',
  GAME_ERROR: 'game:error',
  TOAST: 'toast',
});
