-- @execute-whole
-- Recovery is a new execution of the same logical task, never a PR-fix edge.
-- Deliberately independent of deletable pod/history rows: custody and lineage survive retention.
CREATE TABLE recovery_forks (
  id TEXT PRIMARY KEY,
  parent_pod_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request TEXT NOT NULL CHECK(json_valid(request)),
  binding TEXT NOT NULL CHECK(json_valid(binding)),
  process_epoch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(parent_pod_id, request_id)
);
CREATE TABLE recovery_fork_facts (
  operation_id TEXT NOT NULL REFERENCES recovery_forks(id),
  kind TEXT NOT NULL CHECK(kind IN ('prepared','admitted','entered','candidate','probing','qualified','worker','failed','unknown')),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,kind)
);
CREATE UNIQUE INDEX recovery_fork_child ON recovery_fork_facts(json_extract(evidence,'$.childPodId')) WHERE kind='admitted';
CREATE TRIGGER recovery_forks_immutable_update BEFORE UPDATE ON recovery_forks
BEGIN
  SELECT RAISE(ABORT,'recovery fork requests are immutable');
END;
CREATE TRIGGER recovery_forks_immutable_delete BEFORE DELETE ON recovery_forks
BEGIN
  SELECT RAISE(ABORT,'recovery fork custody is permanent');
END;
CREATE TRIGGER recovery_fork_facts_immutable_update BEFORE UPDATE ON recovery_fork_facts
BEGIN
  SELECT RAISE(ABORT,'recovery fork facts are append-only');
END;
CREATE TRIGGER recovery_fork_facts_immutable_delete BEFORE DELETE ON recovery_fork_facts
BEGIN
  SELECT RAISE(ABORT,'recovery fork facts are append-only');
END;
