-- @execute-whole
-- Preserve every original intent; only a recorded 429 proves rate-limit rejection.
ALTER TABLE sandbox_wakeup_intents RENAME TO sandbox_wakeup_intents_before_evidence;
DROP INDEX sandbox_wakeup_one_pending;
DROP TRIGGER sandbox_wakeup_no_delete;
DROP TRIGGER sandbox_wakeup_guard;

CREATE TABLE sandbox_wakeup_intents (
  id TEXT PRIMARY KEY,
  resource_key TEXT NOT NULL REFERENCES sandbox_wakeup_baselines(resource_key),
  sandbox_id TEXT NOT NULL CHECK(length(sandbox_id) BETWEEN 1 AND 256),
  pod_id TEXT,
  started_at TEXT NOT NULL,
  dispatch_started_at TEXT,
  ended_at TEXT,
  settled_by TEXT CHECK(settled_by IN ('observed-running','resource-locked','dispatch-revoked','rate-limited')),
  CHECK((ended_at IS NULL) = (settled_by IS NULL)),
  CHECK(settled_by != 'dispatch-revoked' OR dispatch_started_at IS NULL),
  CHECK(settled_by NOT IN ('resource-locked','rate-limited') OR dispatch_started_at IS NOT NULL)
);
INSERT INTO sandbox_wakeup_intents SELECT * FROM sandbox_wakeup_intents_before_evidence;
DROP TABLE sandbox_wakeup_intents_before_evidence;
CREATE UNIQUE INDEX sandbox_wakeup_one_pending ON sandbox_wakeup_intents(resource_key)
  WHERE ended_at IS NULL;
CREATE INDEX sandbox_wakeup_by_pod ON sandbox_wakeup_intents(pod_id,started_at DESC,id DESC);

CREATE TABLE sandbox_wakeup_evidence (
  sequence INTEGER PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES sandbox_wakeup_intents(id),
  recorded_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('response','transport-error')),
  status INTEGER CHECK(status BETWEEN 100 AND 599),
  error_code TEXT CHECK(length(error_code) BETWEEN 1 AND 128),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json) AND length(diagnostics_json) <= 4096),
  CHECK((kind='response' AND status IS NOT NULL AND error_code IS NULL)
     OR (kind='transport-error' AND status IS NULL AND error_code IS NOT NULL))
);
CREATE INDEX sandbox_wakeup_evidence_by_intent ON sandbox_wakeup_evidence(intent_id,sequence);
CREATE TRIGGER sandbox_wakeup_evidence_no_update BEFORE UPDATE ON sandbox_wakeup_evidence
BEGIN SELECT RAISE(ABORT,'Sandbox wakeup evidence is immutable'); END;
CREATE TRIGGER sandbox_wakeup_evidence_no_delete BEFORE DELETE ON sandbox_wakeup_evidence
BEGIN SELECT RAISE(ABORT,'Sandbox wakeup evidence is immutable'); END;
CREATE TRIGGER sandbox_wakeup_evidence_guard BEFORE INSERT ON sandbox_wakeup_evidence
WHEN NOT EXISTS (SELECT 1 FROM sandbox_wakeup_intents
  WHERE id=NEW.intent_id AND dispatch_started_at IS NOT NULL AND ended_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Wakeup evidence requires a pending dispatched intent'); END;

CREATE TRIGGER sandbox_wakeup_no_delete BEFORE DELETE ON sandbox_wakeup_intents
BEGIN SELECT RAISE(ABORT,'Sandbox wakeup intent is immutable'); END;
CREATE TRIGGER sandbox_wakeup_guard BEFORE UPDATE ON sandbox_wakeup_intents
WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id
 OR NEW.resource_key IS NOT OLD.resource_key OR NEW.sandbox_id IS NOT OLD.sandbox_id
 OR NEW.pod_id IS NOT OLD.pod_id
 OR NEW.started_at IS NOT OLD.started_at
 OR (OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS NOT OLD.dispatch_started_at)
 OR (NEW.ended_at IS NULL AND (NEW.dispatch_started_at IS NULL OR OLD.dispatch_started_at IS NOT NULL))
 OR (NEW.ended_at IS NOT NULL AND NEW.dispatch_started_at IS NOT OLD.dispatch_started_at)
 OR (NEW.settled_by='rate-limited' AND NOT EXISTS (
   SELECT 1 FROM sandbox_wakeup_evidence WHERE intent_id=OLD.id AND kind='response' AND status=429))
BEGIN SELECT RAISE(ABORT,'Sandbox wakeup evidence is immutable'); END;
