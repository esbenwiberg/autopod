-- @execute-whole
-- Forward-only coverage marker. Existing executions must never be enrolled by inspection.
CREATE TABLE retained_allocation_births (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL
);
CREATE INDEX retained_allocation_birth_task ON retained_allocation_births(task_id);
CREATE TRIGGER retained_allocation_birth AFTER INSERT ON task_executions BEGIN
  INSERT INTO retained_allocation_births
    SELECT NEW.execution_id, NEW.task_id, NEW.pod_id, lifecycle_generation FROM pods WHERE id = NEW.pod_id;
END;

CREATE TABLE retained_allocation_attempts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK (version = 1),
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  role TEXT NOT NULL CHECK (role IN ('bridge','container','original-worktree','prepared-source','unsupported')),
  locator TEXT NOT NULL,
  recovery_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX retained_allocation_task ON retained_allocation_attempts(task_id, sequence);
CREATE TABLE retained_allocation_facts (
  attempt_id TEXT NOT NULL REFERENCES retained_allocation_attempts(id),
  kind TEXT NOT NULL CHECK (kind IN ('create-reply','owned','reused-or-foreign','unverified')),
  evidence TEXT NOT NULL CHECK (json_valid(evidence)),
  PRIMARY KEY (attempt_id, kind)
);
CREATE UNIQUE INDEX retained_allocation_one_outcome ON retained_allocation_facts(attempt_id)
  WHERE kind <> 'create-reply';
CREATE TRIGGER retained_allocation_birth_no_update BEFORE UPDATE ON retained_allocation_births
BEGIN SELECT RAISE(ABORT, 'Allocation birth is immutable'); END;
CREATE TRIGGER retained_allocation_birth_no_delete BEFORE DELETE ON retained_allocation_births
BEGIN SELECT RAISE(ABORT, 'Allocation birth is immutable'); END;
CREATE TRIGGER retained_allocation_attempt_no_update BEFORE UPDATE ON retained_allocation_attempts
BEGIN SELECT RAISE(ABORT, 'Allocation intent is immutable'); END;
CREATE TRIGGER retained_allocation_attempt_no_delete BEFORE DELETE ON retained_allocation_attempts
BEGIN SELECT RAISE(ABORT, 'Allocation intent is immutable'); END;
CREATE TRIGGER retained_allocation_fact_no_update BEFORE UPDATE ON retained_allocation_facts
BEGIN SELECT RAISE(ABORT, 'Allocation fact is immutable'); END;
CREATE TRIGGER retained_allocation_fact_no_delete BEFORE DELETE ON retained_allocation_facts
BEGIN SELECT RAISE(ABORT, 'Allocation fact is immutable'); END;
