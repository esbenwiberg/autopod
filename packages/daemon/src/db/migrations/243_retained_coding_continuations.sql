-- @execute-whole
-- Companion facts do not reinterpret checks-only custody or original settlement.
CREATE TABLE retained_coding_continuations (
  recovery_id TEXT PRIMARY KEY REFERENCES retained_checkpoint_recoveries(id),
  pod_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request TEXT NOT NULL,
  original_context TEXT NOT NULL,
  binding TEXT NOT NULL CHECK (json_valid(binding) AND json_extract(binding,'$.version') IS 1 AND json_extract(binding,'$.mode') IS 'qualify_then_code_once'),
  created_at TEXT NOT NULL
);
CREATE TABLE retained_coding_facts (
  recovery_id TEXT NOT NULL REFERENCES retained_coding_continuations(recovery_id),
  kind TEXT NOT NULL CHECK(kind IN ('entered','candidate','probing','qualified','worker','final_source','blocked')),
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(recovery_id,kind)
);
CREATE TRIGGER retained_coding_no_update BEFORE UPDATE ON retained_coding_continuations
BEGIN SELECT RAISE(ABORT, 'Retained coding identity is immutable'); END;
CREATE TRIGGER retained_coding_no_delete BEFORE DELETE ON retained_coding_continuations
BEGIN SELECT RAISE(ABORT, 'Retained coding custody cannot be deleted'); END;
CREATE TRIGGER retained_coding_facts_no_update BEFORE UPDATE ON retained_coding_facts
BEGIN SELECT RAISE(ABORT, 'Retained coding evidence is immutable'); END;
CREATE TRIGGER retained_coding_facts_no_delete BEFORE DELETE ON retained_coding_facts
BEGIN SELECT RAISE(ABORT, 'Retained coding evidence cannot be deleted'); END;
