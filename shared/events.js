/** Canonical socket event names shared by server and clients. */
export const EVENTS = Object.freeze({
  // Host -> server
  HOST_SUBSCRIBE: 'host:subscribe',
  HOST_UPDATE_CONFIG: 'host:updateConfig',
  HOST_RENAME_TEAM: 'host:renameTeam',
  HOST_MOVE_PLAYER: 'host:movePlayer',
  HOST_REMOVE_PLAYER: 'host:removePlayer',
  HOST_LOCK_LOBBY: 'host:lockLobby',
  HOST_START: 'host:start',
  HOST_RETURN_TO_LOBBY: 'host:returnToLobby',

  // Player -> server
  PLAYER_JOIN: 'player:join',
  PLAYER_RESUME: 'player:resume',
  PLAYER_CHOOSE_TEAM: 'player:chooseTeam',

  // Display -> server
  DISPLAY_SUBSCRIBE: 'display:subscribe',

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
  HOST_DENIED: 'host:denied',
});
