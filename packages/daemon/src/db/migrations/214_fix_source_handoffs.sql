-- @execute-whole
-- A fix publishes on behalf of the parent's delivery lifecycle. Keep the
-- originating fix and superseded merge intent alongside the parent's receipt.
CREATE TABLE fix_source_handoffs (
  publication_id TEXT PRIMARY KEY REFERENCES source_publication_intents(id),
  prior_merge_intent_id TEXT NOT NULL REFERENCES merge_intents(id),
  parent_id TEXT NOT NULL,
  parent_generation INTEGER NOT NULL,
  fix_id TEXT NOT NULL,
  fix_generation INTEGER NOT NULL,
  worktree_path TEXT NOT NULL,
  recovery TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX fix_source_handoffs_parent ON fix_source_handoffs(parent_id, parent_generation);
CREATE TRIGGER fix_source_handoffs_immutable BEFORE UPDATE ON fix_source_handoffs
BEGIN SELECT RAISE(ABORT, 'Fix source handoffs are immutable'); END;
