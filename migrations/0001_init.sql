-- Players sign in with Microsoft Entra ID; id is the account's object id (oid claim).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- id is the SHA-256 of the session cookie, so a leaked table does not leak sessions.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

-- In-flight sign-ins: the OAuth state, PKCE verifier and nonce, for ten minutes.
CREATE TABLE login_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  next TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- status: open (being played) -> ok | review | rejected, or abandoned; admins can void.
-- inputs is the change-point log of src/sim/replay.ts, beats the [server ms, steps] heartbeats.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  seed INTEGER NOT NULL,
  mobile INTEGER NOT NULL,
  after_crash INTEGER NOT NULL,
  sim_version INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  steps INTEGER NOT NULL DEFAULT 0,
  inputs TEXT NOT NULL DEFAULT '[]',
  beats TEXT NOT NULL,
  score INTEGER,
  status TEXT NOT NULL,
  flags TEXT
);

CREATE INDEX runs_by_status ON runs (status, score DESC);
CREATE INDEX runs_by_user ON runs (user_id, started_at DESC);
