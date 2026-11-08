-- Stage 1: sessions, lobby teams, players and the authoritative event log.
-- PostgreSQL dialect; also runs on embedded PGlite for local development/tests.

CREATE TABLE IF NOT EXISTS sessions (
  id              text PRIMARY KEY,
  join_code       text NOT NULL UNIQUE,
  name            text NOT NULL,
  status          text NOT NULL,
  mode            text NOT NULL,
  config          jsonb NOT NULL,
  state           jsonb NOT NULL,
  state_version   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  started_at      timestamptz,
  ended_at        timestamptz,
  expires_at      timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_status_expires_idx
  ON sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS teams (
  id                text PRIMARY KEY,
  session_id        text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name              text NOT NULL,
  color             text NOT NULL,
  sort_order        integer NOT NULL,
  max_players       integer NOT NULL,
  captain_player_id text,
  target_team_id    text,
  missiles          integer NOT NULL DEFAULT 0,
  weapons           jsonb NOT NULL DEFAULT '{}'::jsonb,
  eliminated        boolean NOT NULL DEFAULT false,
  stats             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS teams_session_idx ON teams (session_id, sort_order);

CREATE TABLE IF NOT EXISTS players (
  id              text PRIMARY KEY,
  session_id      text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_id         text,
  display_name    text NOT NULL,
  name_key        text NOT NULL,
  role            text NOT NULL,
  token_hash      text NOT NULL,
  connected       boolean NOT NULL DEFAULT true,
  joined_at       timestamptz NOT NULL,
  last_seen_at    timestamptz,
  cooldown_until  timestamptz,
  streak          integer NOT NULL DEFAULT 0,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL,
  UNIQUE (session_id, name_key)
);

CREATE INDEX IF NOT EXISTS players_session_team_idx ON players (session_id, team_id);
CREATE INDEX IF NOT EXISTS players_token_hash_idx ON players (token_hash);

CREATE TABLE IF NOT EXISTS session_events (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS session_events_session_seq_idx
  ON session_events (session_id, seq);
