-- @execute-whole
CREATE TABLE validation_phase_evidence (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('lint', 'test')),
  identity_hash TEXT NOT NULL,
  identity TEXT NOT NULL,
  result TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  executed_at TEXT NOT NULL
);
CREATE INDEX validation_evidence_lookup ON validation_phase_evidence(stage, identity_hash, executed_at);
CREATE TRIGGER validation_phase_evidence_immutable
BEFORE UPDATE ON validation_phase_evidence
BEGIN
  SELECT RAISE(ABORT, 'validation evidence is immutable');
END;
