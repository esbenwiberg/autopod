-- Drop NOT NULL constraint on profiles.repo_url to support artifact-mode profiles.
-- SQLite does not support ALTER COLUMN, so we do a table rebuild.

ALTER TABLE profiles RENAME TO profiles_old;

CREATE TABLE profiles (
  name            TEXT PRIMARY KEY,
  repo_url        TEXT,
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

INSERT INTO profiles SELECT * FROM profiles_old;

DROP TABLE profiles_old;
