-- Drop NOT NULL constraints from every overridable scalar column so derived
-- profiles can store null (inherit from parent) for the full catalog of
-- fields the desktop override editor exposes. Mirrors 050_profile_commands_nullable.sql.
-- SQLite cannot ALTER COLUMN, so we rebuild the table.
-- This CREATE TABLE must list ALL columns that exist on profiles at this point
-- (001–050: 041 repo_url nullable + 050 build_command/start_command nullable + 049 merge_strategy).

PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

ALTER TABLE profiles RENAME TO profiles_old;

CREATE TABLE profiles (
  name                       TEXT PRIMARY KEY,
  repo_url                   TEXT,
  default_branch             TEXT,                                  -- was NOT NULL DEFAULT 'main'
  template                   TEXT,                                  -- was NOT NULL DEFAULT 'node22'
  build_command              TEXT,
  start_command              TEXT,
  health_path                TEXT,                                  -- was NOT NULL DEFAULT '/'
  health_timeout             INTEGER,                               -- was NOT NULL DEFAULT 120
  validation_pages           TEXT NOT NULL DEFAULT '[]',
  max_validation_attempts    INTEGER,                               -- was NOT NULL DEFAULT 3
  default_model              TEXT,                                  -- was NOT NULL DEFAULT 'opus'
  default_runtime            TEXT,                                  -- was NOT NULL DEFAULT 'claude'
  custom_instructions        TEXT,
  escalation_config          TEXT,                                  -- was NOT NULL DEFAULT '{}'
  extends                    TEXT REFERENCES profiles(name),
  warm_image_tag             TEXT,
  warm_image_built_at        TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  mcp_servers                TEXT NOT NULL DEFAULT '[]',
  claude_md_sections         TEXT NOT NULL DEFAULT '[]',
  execution_target           TEXT,                                  -- was NOT NULL DEFAULT 'local'
  network_policy             TEXT DEFAULT NULL,
  action_policy              TEXT DEFAULT NULL,
  output_mode                TEXT,                                  -- was NOT NULL DEFAULT 'pr'
  model_provider             TEXT,                                  -- was NOT NULL DEFAULT 'anthropic'
  provider_credentials       TEXT DEFAULT NULL,
  test_command               TEXT,
  pr_provider                TEXT,                                  -- was NOT NULL DEFAULT 'github'
  ado_pat                    TEXT,
  private_registries         TEXT NOT NULL DEFAULT '[]',
  registry_pat               TEXT,
  skills                     TEXT NOT NULL DEFAULT '[]',
  github_pat                 TEXT,
  container_memory_gb        REAL,
  build_timeout              INTEGER,
  test_timeout               INTEGER,
  worker_profile             TEXT,
  branch_prefix              TEXT,                                  -- was NOT NULL DEFAULT 'autopod/'
  version                    INTEGER NOT NULL DEFAULT 1,
  token_budget               INTEGER DEFAULT NULL,
  token_budget_warn_at       REAL,                                  -- was NOT NULL DEFAULT 0.8
  token_budget_policy        TEXT,                                  -- was NOT NULL DEFAULT 'soft'
  max_budget_extensions      INTEGER DEFAULT NULL,
  has_web_ui                 INTEGER,                               -- was NOT NULL DEFAULT 1
  issue_watcher_enabled      INTEGER,                               -- was NOT NULL DEFAULT 0
  issue_watcher_label_prefix TEXT,                                  -- was NOT NULL DEFAULT 'autopod'
  pim_activations            TEXT,
  agent_mode                 TEXT,
  output_target              TEXT,
  validate                   INTEGER,
  promotable                 INTEGER,
  merge_strategy             TEXT
);

INSERT INTO profiles SELECT * FROM profiles_old;

DROP TABLE profiles_old;

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
