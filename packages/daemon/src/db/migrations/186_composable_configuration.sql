-- Additive only. Legacy conversion and admission cutover are explicit operations.
CREATE TABLE configuration_entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('repository','environment','ai','workflow','githubAccess','toolPack','profile')),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, name)
);
CREATE TABLE configuration_revisions (
  entity_id TEXT NOT NULL REFERENCES configuration_entities(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, revision)
);
CREATE TABLE configuration_references (
  source_id TEXT NOT NULL REFERENCES configuration_entities(id),
  target_id TEXT NOT NULL REFERENCES configuration_entities(id),
  PRIMARY KEY (source_id, target_id)
);
CREATE INDEX configuration_references_target ON configuration_references(target_id);
CREATE TABLE pod_launch_snapshots (
  pod_id TEXT PRIMARY KEY REFERENCES pods(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  request_id TEXT UNIQUE,
  request_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE configuration_conversions (
  id TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL UNIQUE,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  created_at TEXT NOT NULL
);
