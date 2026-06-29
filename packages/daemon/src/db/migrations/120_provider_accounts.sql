CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  credentials TEXT,
  last_authenticated_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_name_ci
  ON provider_accounts (lower(name));

CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider
  ON provider_accounts (provider);

ALTER TABLE profiles ADD COLUMN provider_account_id TEXT
  REFERENCES provider_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_provider_account_id
  ON profiles (provider_account_id);
