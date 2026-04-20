-- Drop NOT NULL constraints on profiles.build_command and profiles.start_command
-- so derived profiles can store null (inherit from parent).
-- SQLite does not support ALTER COLUMN, so we rebuild the table.
-- This CREATE TABLE must list ALL columns that exist on profiles at this point
-- (001–041 + 043 pim_activations + 045 pod-config cols + 049 merge_strategy).

PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

ALTER TABLE profiles RENAME TO profiles_old;

CREATE TABLE profiles (
  -- 001_initial + 041 (repo_url nullable)
  name                       TEXT PRIMARY KEY,
  repo_url                   TEXT,
  default_branch             TEXT NOT NULL DEFAULT 'main',
  template                   TEXT NOT NULL DEFAULT 'node22',
  build_command              TEXT,                                  -- was NOT NULL, now nullable
  start_command              TEXT,                                  -- was NOT NULL, now nullable
  health_path                TEXT NOT NULL DEFAULT '/',
  health_timeout             INTEGER NOT NULL DEFAULT 120,
  validation_pages           TEXT NOT NULL DEFAULT '[]',
  max_validation_attempts    INTEGER NOT NULL DEFAULT 3,
  default_model              TEXT NOT NULL DEFAULT 'opus',
  default_runtime            TEXT NOT NULL DEFAULT 'claude',
  custom_instructions        TEXT,
  escalation_config          TEXT NOT NULL DEFAULT '{}',
  extends                    TEXT REFERENCES profiles(name),
  warm_image_tag             TEXT,
  warm_image_built_at        TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  -- 002_session_injection
  mcp_servers                TEXT NOT NULL DEFAULT '[]',
  claude_md_sections         TEXT NOT NULL DEFAULT '[]',
  -- 003_execution_target
  execution_target           TEXT NOT NULL DEFAULT 'local',
  -- 004_network_policy
  network_policy             TEXT DEFAULT NULL,
  -- 007_actions
  action_policy              TEXT DEFAULT NULL,
  output_mode                TEXT NOT NULL DEFAULT 'pr',
  -- 008_model_provider
  model_provider             TEXT NOT NULL DEFAULT 'anthropic',
  provider_credentials       TEXT DEFAULT NULL,
  -- 009_test_command
  test_command               TEXT,
  -- 010_ado_pr
  pr_provider                TEXT NOT NULL DEFAULT 'github',
  ado_pat                    TEXT,
  -- 012_private_registries
  private_registries         TEXT NOT NULL DEFAULT '[]',
  registry_pat               TEXT,
  -- 014_profile_skills
  skills                     TEXT NOT NULL DEFAULT '[]',
  -- 017_github_pat
  github_pat                 TEXT,
  -- 018_container_memory
  container_memory_gb        REAL,
  -- 021_build_test_timeout
  build_timeout              INTEGER,
  test_timeout               INTEGER,
  -- 029_worker_profile
  worker_profile             TEXT,
  -- 031_branch_prefix
  branch_prefix              TEXT NOT NULL DEFAULT 'autopod/',
  -- 034_profile_version
  version                    INTEGER NOT NULL DEFAULT 1,
  -- 037_token_budget
  token_budget               INTEGER DEFAULT NULL,
  token_budget_warn_at       REAL NOT NULL DEFAULT 0.8,
  token_budget_policy        TEXT NOT NULL DEFAULT 'soft',
  max_budget_extensions      INTEGER DEFAULT NULL,
  -- 038_has_web_ui
  has_web_ui                 INTEGER NOT NULL DEFAULT 1,
  -- 039_issue_watcher
  issue_watcher_enabled      INTEGER NOT NULL DEFAULT 0,
  issue_watcher_label_prefix TEXT NOT NULL DEFAULT 'autopod',
  -- 043_pim_activations
  pim_activations            TEXT,
  -- 045_pod_config
  agent_mode                 TEXT,
  output_target              TEXT,
  validate                   INTEGER,
  promotable                 INTEGER,
  -- 049_profile_merge_strategy
  merge_strategy             TEXT
);

INSERT INTO profiles SELECT * FROM profiles_old;

DROP TABLE profiles_old;

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
