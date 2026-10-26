-- Expand the configuration kind constraint without changing existing identities or revisions.
PRAGMA foreign_keys = OFF;
CREATE TABLE configuration_entities_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('repository','environment','ai','workflow','githubAccess','toolPack','profile','packageFeed')),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, name)
);
INSERT INTO configuration_entities_new SELECT * FROM configuration_entities;
DROP TABLE configuration_entities;
ALTER TABLE configuration_entities_new RENAME TO configuration_entities;
PRAGMA foreign_keys = ON;
