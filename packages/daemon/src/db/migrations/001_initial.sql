-- Profiles
CREATE TABLE IF NOT EXISTS profiles (
  name            TEXT PRIMARY KEY,
  repo_url        TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  template        TEXT NOT NULL DEFAULT 'node22',
  build_command   TEXT NOT NULL,
  start_command   TEXT NOT NULL,
  health_path     TEXT NOT NULL DEFAULT '/',
  health_timeout  INTEGER NOT NULL DEFAULT 120,
  validation_pages TEXT NOT NULL DEFAULT '[]',
  max_validation_attempts INTEGER NOT NULL DEFAULT 3,
  default_model   TEXT NOT NULL DEFAULT 'opus',
  default_runtime TEXT NOT NULL DEFAULT 'claude',
  custom_instructions TEXT,
  escalation_config TEXT NOT NULL DEFAULT '{}',
  extends         TEXT REFERENCES profiles(name),
  warm_image_tag  TEXT,
  warm_image_built_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  profile_name    TEXT NOT NULL REFERENCES profiles(name),
  task            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  model           TEXT NOT NULL,
  runtime         TEXT NOT NULL DEFAULT 'claude',
  branch          TEXT NOT NULL,
  container_id    TEXT,
  worktree_path   TEXT,
  validation_attempts INTEGER NOT NULL DEFAULT 0,
  max_validation_attempts INTEGER NOT NULL DEFAULT 3,
  last_validation_result TEXT,
  pending_escalation TEXT,
  escalation_count INTEGER NOT NULL DEFAULT 0,
  skip_validation BOOLEAN NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  completed_at    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  user_id         TEXT NOT NULL,
  files_changed   INTEGER NOT NULL DEFAULT 0,
  lines_added     INTEGER NOT NULL DEFAULT 0,
  lines_removed   INTEGER NOT NULL DEFAULT 0,
  preview_url     TEXT,
  acceptance_criteria TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_name);

-- Escalation history
CREATE TABLE IF NOT EXISTS escalations (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  response        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations(session_id);

-- Validation history
CREATE TABLE IF NOT EXISTS validations (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  attempt         INTEGER NOT NULL,
  result          TEXT NOT NULL,
  screenshots     TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_validations_session ON validations(session_id);

-- Event log (append-only)
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

-- Schema version
CREATE TABLE IF NOT EXISTS schema_version (
  version         INTEGER PRIMARY KEY,
  applied_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
