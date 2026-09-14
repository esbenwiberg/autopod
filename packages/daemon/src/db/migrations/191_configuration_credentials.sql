CREATE TABLE configuration_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  purposes TEXT NOT NULL CHECK(json_valid(purposes)),
  origins TEXT NOT NULL CHECK(json_valid(origins)),
  encrypted_value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
