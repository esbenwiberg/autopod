-- @execute-whole
-- Empty bridges of superseded retained identities are releasable execution
-- resources, not custody evidence (#565). The observed network specification is
-- recorded durably BEFORE Docker removal; containers, mounts, source and reports
-- are never touched. Both tables are append-only.
CREATE TABLE retained_network_releases (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  owner_pod_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('retained_checkpoint', 'artifact_checks')),
  network_id TEXT NOT NULL,
  network_name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('subnet_pressure', 'operator')),
  actor TEXT CHECK (actor IS NULL OR json_valid(actor)),
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  containers TEXT NOT NULL CHECK (json_valid(containers)),
  created_at TEXT NOT NULL
);
CREATE INDEX retained_network_releases_identity ON retained_network_releases(identity);
CREATE INDEX retained_network_releases_network ON retained_network_releases(network_id);

CREATE TABLE retained_network_release_outcomes (
  release_id TEXT PRIMARY KEY REFERENCES retained_network_releases(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('removed', 'already_absent', 'failed')),
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER retained_network_releases_no_update
BEFORE UPDATE ON retained_network_releases
BEGIN SELECT RAISE(ABORT, 'Retained network release records are immutable'); END;
CREATE TRIGGER retained_network_releases_no_delete
BEFORE DELETE ON retained_network_releases
BEGIN SELECT RAISE(ABORT, 'Retained network release records cannot be deleted'); END;
CREATE TRIGGER retained_network_release_outcomes_no_update
BEFORE UPDATE ON retained_network_release_outcomes
BEGIN SELECT RAISE(ABORT, 'Retained network release outcomes are immutable'); END;
CREATE TRIGGER retained_network_release_outcomes_no_delete
BEFORE DELETE ON retained_network_release_outcomes
BEGIN SELECT RAISE(ABORT, 'Retained network release outcomes cannot be deleted'); END;
