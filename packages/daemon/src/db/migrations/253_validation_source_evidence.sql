-- @execute-whole
CREATE TABLE validation_source_intents (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  binding TEXT NOT NULL CHECK(json_valid(binding)),
  created_at TEXT NOT NULL
);
CREATE TABLE validation_source_results (
  intent_id TEXT PRIMARY KEY REFERENCES validation_source_intents(id),
  result_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER validation_source_intents_no_update BEFORE UPDATE ON validation_source_intents
BEGIN SELECT RAISE(ABORT,'Validation source admission is immutable'); END;
CREATE TRIGGER validation_source_intents_no_delete BEFORE DELETE ON validation_source_intents
BEGIN SELECT RAISE(ABORT,'Validation source admission is permanent'); END;
CREATE TRIGGER validation_source_results_no_update BEFORE UPDATE ON validation_source_results
BEGIN SELECT RAISE(ABORT,'Validation source result is immutable'); END;
CREATE TRIGGER validation_source_results_no_delete BEFORE DELETE ON validation_source_results
BEGIN SELECT RAISE(ABORT,'Validation source result is permanent'); END;
CREATE TABLE validation_source_publications (
  publication_id TEXT NOT NULL REFERENCES source_publication_intents(id),
  validation_id TEXT NOT NULL REFERENCES validation_source_intents(id),
  checkpoints TEXT NOT NULL CHECK(json_valid(checkpoints)),
  PRIMARY KEY(publication_id,validation_id)
);
CREATE TRIGGER validation_source_publications_no_update BEFORE UPDATE ON validation_source_publications
BEGIN SELECT RAISE(ABORT,'Checked publication binding is immutable'); END;
CREATE TRIGGER validation_source_publications_no_delete BEFORE DELETE ON validation_source_publications
BEGIN SELECT RAISE(ABORT,'Checked publication binding is permanent'); END;
CREATE TABLE source_publication_resources (
  intent_id TEXT PRIMARY KEY REFERENCES source_publication_intents(id),
  container_id TEXT,
  worktree_path TEXT NOT NULL,
  context_hash TEXT NOT NULL
);
CREATE TRIGGER source_publication_resources_no_update BEFORE UPDATE ON source_publication_resources
BEGIN SELECT RAISE(ABORT,'Publication resource binding is immutable'); END;
CREATE TRIGGER source_publication_resources_no_delete BEFORE DELETE ON source_publication_resources
BEGIN SELECT RAISE(ABORT,'Publication resource binding is permanent'); END;
CREATE TABLE approval_rewrite_predecessor_deliveries (
  rewrite_id TEXT PRIMARY KEY REFERENCES approval_source_rewrites(id),
  merge_intent_id TEXT NOT NULL REFERENCES merge_intents(id),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER rewrite_predecessor_delivery_no_update BEFORE UPDATE ON approval_rewrite_predecessor_deliveries
BEGIN SELECT RAISE(ABORT,'Predecessor delivery is immutable'); END;
CREATE TRIGGER rewrite_predecessor_delivery_no_delete BEFORE DELETE ON approval_rewrite_predecessor_deliveries
BEGIN SELECT RAISE(ABORT,'Predecessor delivery is permanent'); END;
CREATE TABLE external_delivery_source_evidence (
  observation_id TEXT PRIMARY KEY REFERENCES external_delivery_observations(id),
  publication_id TEXT REFERENCES source_publication_intents(id),
  validation_id TEXT REFERENCES validation_source_intents(id),
  CHECK((publication_id IS NULL) != (validation_id IS NULL))
);
CREATE TRIGGER external_delivery_source_no_update BEFORE UPDATE ON external_delivery_source_evidence
BEGIN SELECT RAISE(ABORT,'External delivery source proof is immutable'); END;
CREATE TRIGGER external_delivery_source_no_delete BEFORE DELETE ON external_delivery_source_evidence
BEGIN SELECT RAISE(ABORT,'External delivery source proof is permanent'); END;
